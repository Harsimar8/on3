import * as Cesium from "cesium";
import { CesiumObjectDetector } from "./CesiumObjectDetector";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;
    longitude: number;
    latitude: number;
    altitude?: number;
    mastHeight?: number;
    sectorStartDeg?: number;
    sectorSweepDeg?: number;
    drawRays?: boolean;
    azimuthStepDeg?: number;
    rangeSampleSteps?: number;
    elevationRingsPerZone?: number;
    useObjectPicking?: boolean;
    zoneOverrides?: Record<string, RadarZoneOverride>;
    beamOpacity?: number;
    interiorOpacity?: number;
    showInterior?: boolean;
    interiorLayers?: number;
    showBlockedPoints?: boolean;
}

export interface RadarZoneOverride {
    visible?: boolean;
    range?: number;
    minElevationDeg?: number;
    maxElevationDeg?: number;
    azimuthStartDeg?: number;
    azimuthWidthDeg?: number;
    color?: string;
    beamOpacity?: number;
    interiorOpacity?: number;
    showInterior?: boolean;
}

export interface RadarZoneConfig {
    name: string;
    cssColor: string;
    color: Cesium.Color;
    defaultRange: number;
    defaultMinElevationDeg: number;
    defaultMaxElevationDeg: number;
}

interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    // Elevation of every ray in this zone, e.g. 0,1,2,...,10 for a 0-10 deg zone.
    rayElevationsDeg: number[];
    beamOpacity: number;
    azimuthStartDeg: number;
    azimuthWidthDeg: number;
}

interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
    groundPoints: Cesium.Cartographic[];
}

interface RayStop {
    // Horizontal distance from the radar at which this ray ends.
    horizontalDistance: number;
    // Index into the profile of the terrain sample that stopped the ray, or -1 if unblocked.
    blockIndex: number;
}

export interface RadarCoverageHandle {
    dispose(): void;
}

// =============================================================================
// CesiumRadarCoverage (Multi-Ring Elevation Wedges with Terrain Masking)
// =============================================================================

const TERRAIN_SAMPLE_SPACING_M = 5;
const EARTH_RADIUS_M = 6371000;
const BLOCKED_POINT_ALWAYS_VISIBLE_M = 3000;

export class CesiumRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [
        {
            name: "Zone 1 (Low)",
            cssColor: "#22c55e",
            color: Cesium.Color.fromCssColorString("#22c55e"),
            defaultRange: 5000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 10
        },
        {
            name: "Zone 2 (Mid)",
            cssColor: "#f59e0b",
            color: Cesium.Color.fromCssColorString("#f59e0b"),
            defaultRange: 12000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 20
        },
        {
            name: "Zone 3 (High / Wide)",
            cssColor: "#ef4444",
            color: Cesium.Color.fromCssColorString("#ef4444"),
            defaultRange: 20000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 30
        }
    ];

    // -------------------------------------------------------------------
    // 1. Main Entry Point: create3DRadarZones
    // -------------------------------------------------------------------
    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions
    ): Promise<RadarCoverageHandle[]> {

        const {
            entityId,
            longitude,
            latitude,
            mastHeight = 0,
            sectorStartDeg = 0,
            sectorSweepDeg = 360,
            azimuthStepDeg = 2,
            rangeSampleSteps,
            elevationRingsPerZone = 8,
            showBlockedPoints = false,
            zoneOverrides = {}
        } = options;

        const handles: RadarCoverageHandle[] = [];

        // Position & Terrain Sampling
        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider, [cartographic]);
        const terrainHeight = sampled.height ?? 0;

        const radarPosition = Cesium.Cartesian3.fromDegrees(
            longitude,
            latitude,
            terrainHeight + mastHeight
        );

        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);
        const radarHeight = terrainHeight + mastHeight;

        // Emitter Marker
        const marker = viewer.entities.add({
            position: radarPosition,
            point: {
                pixelSize: 16,
                color: Cesium.Color.BLACK,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        (marker as any).radarParentId = entityId;
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // Resolve Zones. Each zone is a fan of individual rays: one ray per
        // azimuth step and per elevation step, e.g. 0,1,2,...,10 deg for a
        // 0-10 deg zone split into 10 steps.
        const zones: ResolvedZone[] = [];
        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
            const override = zoneOverrides[zoneConfig.name] ?? {};
            if (!(override.visible ?? true)) continue;

            const minEl = override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg;
            const maxEl = override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg;
            const steps = Math.max(1, elevationRingsPerZone);
            const rayElevationsDeg: number[] = [];
            for (let k = 0; k <= steps; k++) {
                rayElevationsDeg.push(minEl + ((maxEl - minEl) * k) / steps);
            }

            zones.push({
                name: zoneConfig.name,
                color: zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                rayElevationsDeg,
                beamOpacity: override.beamOpacity ?? (options.beamOpacity ?? 0.35),
                azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
            });
        }

        if (zones.length === 0) return handles;

        // A terrain profile depends only on the azimuth fan and how far out we walk it -
        // not on a ray's elevation. Sample each distinct fan once, out to the largest
        // range any zone on it needs and at the finest spacing any of them asked for.
        const profileGroups = new Map<string, { maxRange: number; spacing: number }>();
        for (const zone of zones) {
            const key = `${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`;
            const spacing = rangeSampleSteps
                ? zone.range / Math.max(2, rangeSampleSteps)
                : TERRAIN_SAMPLE_SPACING_M;

            const group = profileGroups.get(key);
            if (group) {
                group.maxRange = Math.max(group.maxRange, zone.range);
                group.spacing = Math.min(group.spacing, spacing);
            } else {
                profileGroups.set(key, { maxRange: zone.range, spacing });
            }
        }

        const profilesByFan = new Map<string, TerrainProfile[]>();
        for (const [key, group] of profileGroups) {
            const [fanStartDeg, fanWidthDeg] = key.split("|").map(Number);
            const fanAzimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
                fanStartDeg,
                fanWidthDeg,
                azimuthStepDeg
            );

            profilesByFan.set(key, await CesiumRadarCoverage.buildTerrainProfiles(
                terrainProvider,
                radarPosition,
                enuMatrix,
                fanAzimuthsDeg,
                group.maxRange,
                group.spacing
            ));
        }

        // Terrain points that stopped a ray, keyed by fan|azimuth|sample so rays
        // stopped by the same ground only draw one marker (first zone's colour wins).
        const blockedPoints = new Map<string, { position: Cesium.Cartesian3; color: Cesium.Color }>();

        for (const zone of zones) {
            const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
                zone.azimuthStartDeg,
                zone.azimuthWidthDeg,
                azimuthStepDeg
            );

            const fanKey = `${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`;
            const profiles = profilesByFan.get(fanKey)!;

            // stops[a][k] = where the ray at azimuth a and elevation k ends. Every
            // ray is traced on its own, so a hill that stops the low rays leaves
            // the higher rays free to pass over it.
            const stops = profiles.map(profile =>
                zone.rayElevationsDeg.map(elevationDeg =>
                    CesiumRadarCoverage.traceRay(profile, radarHeight, zone.range, elevationDeg)
                )
            );

            if (showBlockedPoints) {
                stops.forEach((rayStops, a) => {
                    for (const stop of rayStops) {
                        if (stop.blockIndex < 0) continue;
                        const key = `${fanKey}|${a}|${stop.blockIndex}`;
                        if (blockedPoints.has(key)) continue;
                        const ground = profiles[a].groundPoints[stop.blockIndex];
                        blockedPoints.set(key, {
                            position: Cesium.Cartesian3.fromRadians(ground.longitude, ground.latitude, 10),
                            color: zone.color
                        });
                    }
                });
            }

            const radarPrimitive = CesiumRadarCoverage.buildRadarVolumePrimitive(
                viewer,
                radarPosition,
                enuMatrix,
                zone,
                azimuthsDeg,
                stops,
                entityId
            );

            if (radarPrimitive) {
                handles.push({ dispose: () => viewer.scene.primitives.remove(radarPrimitive) });
            }
        }

        if (blockedPoints.size > 0) {
            // Depth-tested and placed relative to the rendered terrain: a marker behind
            // a ridge is hidden by it instead of being painted onto the ridge's near
            // face, and it follows the drawn ground at every LOD. The 10 m lift keeps
            // it from sinking half into the slope it sits on.
            const pointEntities: Cesium.Entity[] = [];
            viewer.entities.suspendEvents();
            for (const { position, color } of blockedPoints.values()) {
                const pointEntity = viewer.entities.add({
                    position,
                    point: {
                        pixelSize: 8,
                        color,
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 2,
                        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                        // Up close the marker's own slope would hide it, so skip the
                        // depth test within this camera distance. Further out it stays
                        // depth-tested and ridges in front still hide it.
                        disableDepthTestDistance: BLOCKED_POINT_ALWAYS_VISIBLE_M
                    }
                });
                (pointEntity as any).radarParentId = entityId;
                pointEntities.push(pointEntity);
            }
            viewer.entities.resumeEvents();
            handles.push({
                dispose: () => {
                    viewer.entities.suspendEvents();
                    for (const e of pointEntities) viewer.entities.remove(e);
                    viewer.entities.resumeEvents();
                }
            });
        }

        viewer.scene.requestRender();
        return handles;
    }

    // -------------------------------------------------------------------
    // 2. Helper Azimuth List Generator: buildAzimuthList
    // -------------------------------------------------------------------
    private static buildAzimuthList(
        sectorStartDeg: number,
        sectorSweepDeg: number,
        stepDeg: number
    ): number[] {
        const sweep = Cesium.Math.clamp(sectorSweepDeg, 1, 360);
        const step = Math.max(1, stepDeg);
        const count = Math.max(2, Math.round(sweep / step) + (sweep >= 360 ? 0 : 1));
        const azimuths: number[] = [];

        for (let i = 0; i < count; i++) {
            const raw = sectorStartDeg + (sweep * i) / (sweep >= 360 ? count : count - 1);
            azimuths.push(((raw % 360) + 360) % 360);
        }
        return azimuths;
    }

    // -------------------------------------------------------------------
    // 3. Terrain Profiles Builder: buildTerrainProfiles
    // -------------------------------------------------------------------
    private static async buildTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number,
        spacing: number
    ): Promise<TerrainProfile[]> {
        const sampleCount = Math.max(2, Math.ceil(maxRange / spacing)) + 1;
        const horizontalDistances: number[] = [];
        for (let i = 0; i < sampleCount; i++) {
            horizontalDistances.push(Math.min(i * spacing, maxRange));
        }

        const flatCartographics: Cesium.Cartographic[] = [];
        const scratchPoint = new Cesium.Cartesian3();

        for (const azimuthDeg of azimuthsDeg) {
            const groundRay = CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, azimuthDeg, 0);
            for (const distance of horizontalDistances) {
                const point = Cesium.Ray.getPoint(groundRay, distance, scratchPoint);
                flatCartographics.push(Cesium.Cartographic.fromCartesian(point));
            }
        }

        const sampledTerrain = await Cesium.sampleTerrainMostDetailed(terrainProvider, flatCartographics);

        return azimuthsDeg.map((azimuthDeg, a) => {
            const groundHeights: number[] = [];
            const base = a * sampleCount;
            for (let i = 0; i < sampleCount; i++) {
                groundHeights.push(sampledTerrain[base + i].height ?? 0);
            }
            const groundPoints = sampledTerrain.slice(base, base + sampleCount);
            return { azimuthDeg, horizontalDistances, groundHeights, groundPoints };
        });
    }

    // -------------------------------------------------------------------
    // 4. Helper Ray Generator: makeRay (used by buildTerrainProfiles)
    // -------------------------------------------------------------------
    private static makeRay(
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthDeg: number,
        elevationDeg: number
    ): Cesium.Ray {
        const azimuth = Cesium.Math.toRadians(azimuthDeg);
        const elevation = Cesium.Math.toRadians(elevationDeg);

        const localDirection = new Cesium.Cartesian3(
            Math.sin(azimuth) * Math.cos(elevation),
            Math.cos(azimuth) * Math.cos(elevation),
            Math.sin(elevation)
        );

        const worldDirection = Cesium.Matrix4.multiplyByPointAsVector(
            enuMatrix,
            localDirection,
            new Cesium.Cartesian3()
        );

        Cesium.Cartesian3.normalize(worldDirection, worldDirection);
        return new Cesium.Ray(radarPosition, worldDirection);
    }

    // -------------------------------------------------------------------
    // 5. Single-Ray Line-of-Sight Trace: traceRay
    // -------------------------------------------------------------------
    // Walks one straight ray outward and returns where it first goes below the
    // ground, or where it reaches the zone's slant range if nothing is in the way.
    private static traceRay(
        profile: TerrainProfile,
        radarHeight: number,
        slantRange: number,
        elevationDeg: number
    ): RayStop {
        const { horizontalDistances, groundHeights } = profile;
        const elevationRad = Cesium.Math.toRadians(elevationDeg);
        const tanEl = Math.tan(elevationRad);
        const maxHorizontal = slantRange * Math.cos(elevationRad);

        for (let i = 1; i < horizontalDistances.length; i++) {
            const dist = horizontalDistances[i];
            if (dist > maxHorizontal) break;

            // The ray is a straight line in the radar's local tangent frame, while
            // the Earth curves away beneath it by ~d^2/2R. Compare the ground against
            // that straight line so the check agrees with the drawn volume.
            const curvatureDrop = (dist * dist) / (2 * EARTH_RADIUS_M);
            const groundH = groundHeights[i] - curvatureDrop;
            const rayH = radarHeight + dist * tanEl;

            if (groundH > rayH) {
                return { horizontalDistance: dist, blockIndex: i };
            }
        }
        return { horizontalDistance: maxHorizontal, blockIndex: -1 };
    }

    // -------------------------------------------------------------------
    // 6. Volumetric Mesh Primitive Builder: buildRadarVolumePrimitive
    // -------------------------------------------------------------------
    // The outer surface joins every ray's end point to its neighbours (next
    // azimuth, next elevation). The lowest and highest rays are closed back to
    // the radar with fans, and so are the two sector edges when the sweep is < 360.
    private static buildRadarVolumePrimitive(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        stops: RayStop[][],
        entityId: string
    ): Cesium.Primitive | null {
        const numAzimuths = azimuthsDeg.length;
        const numRays = zone.rayElevationsDeg.length;
        if (numAzimuths < 2 || numRays < 1) return null;

        const fullCircle = zone.azimuthWidthDeg >= 360;
        const positions: number[] = [];
        const indices: number[] = [];
        const boundingPoints: Cesium.Cartesian3[] = [radarPosition];

        const apexIdx = 0;
        positions.push(radarPosition.x, radarPosition.y, radarPosition.z);

        const tanEls = zone.rayElevationsDeg.map(el => Math.tan(Cesium.Math.toRadians(el)));
        const scratchLocal = new Cesium.Cartesian3();

        for (let a = 0; a < numAzimuths; a++) {
            const azRad = Cesium.Math.toRadians(azimuthsDeg[a]);
            const sinAz = Math.sin(azRad);
            const cosAz = Math.cos(azRad);

            for (let k = 0; k < numRays; k++) {
                const d = stops[a][k].horizontalDistance;
                scratchLocal.x = sinAz * d;
                scratchLocal.y = cosAz * d;
                scratchLocal.z = d * tanEls[k];
                const world = Cesium.Matrix4.multiplyByPoint(enuMatrix, scratchLocal, new Cesium.Cartesian3());
                positions.push(world.x, world.y, world.z);
                boundingPoints.push(world);
            }
        }

        const v = (a: number, k: number) => 1 + a * numRays + k;
        // A full circle also joins the last azimuth back to the first.
        const columnPairs = fullCircle ? numAzimuths : numAzimuths - 1;

        for (let a = 0; a < columnPairs; a++) {
            const a2 = (a + 1) % numAzimuths;

            // Outer surface between neighbouring ray end points
            for (let k = 0; k < numRays - 1; k++) {
                indices.push(v(a, k), v(a2, k), v(a2, k + 1));
                indices.push(v(a, k), v(a2, k + 1), v(a, k + 1));
            }

            // Lowest and highest rays back to the radar
            indices.push(apexIdx, v(a, 0), v(a2, 0));
            indices.push(apexIdx, v(a2, numRays - 1), v(a, numRays - 1));
        }

        if (!fullCircle) {
            for (const a of [0, numAzimuths - 1]) {
                for (let k = 0; k < numRays - 1; k++) {
                    indices.push(apexIdx, v(a, k), v(a, k + 1));
                }
            }
        }

        const geometry = new Cesium.Geometry({
            attributes: ({
                position: new Cesium.GeometryAttribute({
                    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                    componentsPerAttribute: 3,
                    values: new Float64Array(positions)
                })
            } as unknown) as Cesium.GeometryAttributes,
            indices: new Uint32Array(indices),
            boundingSphere: Cesium.BoundingSphere.fromPoints(boundingPoints)
        });

        Cesium.GeometryPipeline.computeNormal(geometry);

        const primitive = new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
                geometry: geometry,
                id: entityId,
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(zone.color.withAlpha(zone.beamOpacity))
                }
            }),
            // closed: false disables back-face culling. With it on, faces vanished
            // whenever the camera zoomed close to or inside the volume.
            // Depth test off: the surface between two ray end points is a flat panel,
            // and rendered terrain poking through it looked like the radar was blocked
            // there. Real blocking is already in each ray's end point, so the beam is
            // drawn whole, on top of the terrain.
            appearance: new Cesium.PerInstanceColorAppearance({
                translucent: true,
                closed: false,
                renderState: {
                    depthTest: { enabled: false },
                    depthMask: false
                }
            }),
            asynchronous: false
        });

        viewer.scene.primitives.add(primitive);
        return primitive;
    }
}
