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
    minElevationDeg: number;
    maxElevationDeg: number;
    beamOpacity: number;
    interiorOpacity: number;
    showInterior: boolean;
    visible: boolean;
    azimuthStartDeg: number;
    azimuthWidthDeg: number;
}

interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
}

export interface RadarCoverageHandle {
    dispose(): void;
}

// =============================================================================
// CesiumRadarCoverage (Multi-Ring Elevation Wedges with Terrain Masking)
// =============================================================================

const TERRAIN_SAMPLE_SPACING_M = 5;

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

        // Resolve Zones & Sub-divide into Elevation Rings
        const subZones: ResolvedZone[] = [];
        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
            const override = zoneOverrides[zoneConfig.name] ?? {};
            if (!(override.visible ?? true)) continue;

            const baseRange = override.range ?? zoneConfig.defaultRange;
            const minEl = override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg;
            const maxEl = override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg;
            const totalSpan = maxEl - minEl;
            const rings = Math.max(1, elevationRingsPerZone);
            const ringSpan = totalSpan / rings;

            // Create sub-rings vertically stacked for this zone
            for (let r = 0; r < rings; r++) {
                const ringMin = minEl + r * ringSpan;
                const ringMax = minEl + (r + 1) * ringSpan;
                // Every ring of a zone shares one colour and one opacity, so the
                // stack reads as a single translucent volume rather than fading
                // out with height. Alpha comes from beamOpacity at draw time.
                const ringColor = zoneConfig.color;

                subZones.push({
                    name: `${zoneConfig.name} (Ring ${r + 1})`,
                    color: ringColor,
                    range: baseRange,
                    minElevationDeg: ringMin,
                    maxElevationDeg: ringMax,
                    beamOpacity: override.beamOpacity ?? (options.beamOpacity ?? 0.35),
                    interiorOpacity: override.interiorOpacity ?? (options.interiorOpacity ?? 0.15),
                    showInterior: override.showInterior ?? (options.showInterior ?? true),
                    visible: true,
                    azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                    azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
                });
            }
        }

        if (subZones.length === 0) return handles;

        // A terrain profile depends only on the azimuth fan and how far out we walk it -
        // not on the ring's elevation bounds. Every ring of every zone was therefore
        // re-sampling the same ground. Sample each distinct fan once here, out to the
        // largest range any of its rings needs and at the finest spacing any of them
        // asked for, then let the rings below read from the result.
        const profileGroups = new Map<string, { maxRange: number; spacing: number }>();
        for (const zone of subZones) {
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

        // Build Cylindrical Elevation Rings with Terrain Line-of-Sight Clipping
        for (const zone of subZones) {
            const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
                zone.azimuthStartDeg,
                zone.azimuthWidthDeg,
                azimuthStepDeg
            );

            // Shared profile may run past this ring's range; getTerrainBlockedRange
            // stops at zone.range, so the ring sees exactly what it saw before.
            const profiles = profilesByFan.get(`${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`)!;

            // Compute true line-of-sight range per azimuth tailored to this ring's elevation bounds
            const effectiveRanges = profiles.map(profile =>
                CesiumRadarCoverage.getTerrainBlockedRange(profile, radarHeight, zone.range, zone.minElevationDeg)
            );

            // Build custom primitive volume matching directional terrain constraints
            const radarPrimitive = CesiumRadarCoverage.buildRadarVolumePrimitive(
                viewer,
                radarPosition,
                enuMatrix,
                zone,
                azimuthsDeg,
                effectiveRanges,
                entityId
            );

            if (radarPrimitive) {
                handles.push({ dispose: () => viewer.scene.primitives.remove(radarPrimitive) });
            }
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
            return { azimuthDeg, horizontalDistances, groundHeights };
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
    // 5. Terrain Line-of-Sight Check: getTerrainBlockedRange
    // -------------------------------------------------------------------
    private static getTerrainBlockedRange(
        profile: TerrainProfile,
        radarHeight: number,
        maxRange: number,
        minElevationDeg: number
    ): number {
        const { horizontalDistances, groundHeights } = profile;
        let maxElevationAngle = -Infinity;
        let blockedRange = maxRange;
        const minElevationRad = Cesium.Math.toRadians(minElevationDeg);

        for (let i = 1; i < horizontalDistances.length; i++) {
            const dist = horizontalDistances[i];
            if (dist > maxRange) break;
            

            const groundH = groundHeights[i];
            const heightDiff = groundH - radarHeight;
            const elevationAngle = Math.atan2(heightDiff, dist);

            // If the terrain rises higher than the ring's minimum elevation angle, it blocks the beam
            if (elevationAngle > minElevationRad && elevationAngle > maxElevationAngle) {
                maxElevationAngle = elevationAngle;
                if (heightDiff > 0) {
                    blockedRange = Math.max(100, dist - 50);
                    break;
                }
            }
        }
        return blockedRange;
    }

    // -------------------------------------------------------------------
    // 6. Volumetric Mesh Primitive Builder: buildRadarVolumePrimitive
    // -------------------------------------------------------------------
    private static buildRadarVolumePrimitive(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        effectiveRanges: number[],
        entityId: string
    ): Cesium.Primitive | null {
        const numAzimuths = azimuthsDeg.length;
        if (numAzimuths < 2) return null;

        const positions: number[] = [];
        const indices: number[] = [];

        const maxRad = Cesium.Math.toRadians(zone.maxElevationDeg);
        const minRad = Cesium.Math.toRadians(zone.minElevationDeg);

        const apexIdx = 0;
        positions.push(radarPosition.x, radarPosition.y, radarPosition.z);

        for (let i = 0; i < numAzimuths; i++) {
            const azDeg = azimuthsDeg[i];
            const range = effectiveRanges[i];
            const azRad = Cesium.Math.toRadians(azDeg);

            const cosAz = Math.cos(azRad);
            const sinAz = Math.sin(azRad);

            const botDistHoriz = range * Math.cos(minRad);
            const botHeight = range * Math.sin(minRad);
            const localBot = new Cesium.Cartesian3(sinAz * botDistHoriz, cosAz * botDistHoriz, botHeight);
            
            const topDistHoriz = range * Math.cos(maxRad);
            const topHeight = range * Math.sin(maxRad);
            const localTop = new Cesium.Cartesian3(sinAz * topDistHoriz, cosAz * topDistHoriz, topHeight);

            const worldBot = Cesium.Matrix4.multiplyByPoint(enuMatrix, localBot, new Cesium.Cartesian3());
            const worldTop = Cesium.Matrix4.multiplyByPoint(enuMatrix, localTop, new Cesium.Cartesian3());

            positions.push(worldBot.x, worldBot.y, worldBot.z);
            positions.push(worldTop.x, worldTop.y, worldTop.z);
        }

        for (let i = 0; i < numAzimuths - 1; i++) {
            const b0 = 1 + i * 2;
            const t0 = 2 + i * 2;
            const b1 = 1 + (i + 1) * 2;
            const t1 = 2 + (i + 1) * 2;

            indices.push(b0, t0, t1);
            indices.push(b0, t1, b1);
            indices.push(apexIdx, t1, t0);
            indices.push(apexIdx, b0, b1);
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
            boundingSphere: Cesium.BoundingSphere.fromPoints(
                positions.reduce((acc: Cesium.Cartesian3[], _, idx, arr) => {
                    if (idx % 3 === 0) {
                        acc.push(new Cesium.Cartesian3(arr[idx], arr[idx+1], arr[idx+2]));
                    }
                    return acc;
                }, [])
            )
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
            appearance: new Cesium.PerInstanceColorAppearance({
                translucent: true,
                closed: true
            }),
            asynchronous: false
        });

        viewer.scene.primitives.add(primitive);
        return primitive;
    }
}