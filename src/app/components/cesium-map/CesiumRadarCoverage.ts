import * as Cesium from "cesium";

// =============================================================================
// HOW THIS DRAWS THE RADAR
//
// For every direction around the radar (every azimuthStepDeg) we read the
// ground heights along that direction, then draw two things per zone:
//
//   1. FOOTPRINT (on the ground)
//      Walk out along the ground. Stop at the first ridge that hides the
//      ground behind it (or at the zone range). Join the stop points into one
//      polygon and PAINT it on the terrain. Nothing floats -> no patches.
//
//   2. VOLUME (in the air)
//      At every point along every direction:
//        roof  = top of the beam          = distance * tan(maxElevation)
//        floor = ground, or the "shadow line" over the last ridge
//                (whichever is higher -> the floor is NEVER below the ground)
//      Covered air = between floor and roof.
//      The floor is only drawn behind ridges (where it lifts off the ground);
//      over visible ground the painted footprint is the floor.
// =============================================================================

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;
    longitude: number;
    latitude: number;
    altitude?: number;

    /** Radar height above the ground, metres. Default 2. */
    mastHeight?: number;
    sectorStartDeg?: number;
    sectorSweepDeg?: number;
    /** Angle between rays. Smaller = smoother but slower. Default 2. */
    azimuthStepDeg?: number;
    rangeSampleSteps?: number;
    zoneOverrides?: Record<string, RadarZoneOverride>;

    /** Ground bumps smaller than this do not block. Default 1 m. */
    clearanceToleranceM?: number;

    /** Paint the covered ground. Default true. */
    drawFootprint?: boolean;
    footprintOpacity?: number;

    /** Draw the 3D volume in the air. Default true. */
    drawVolume?: boolean;
    /** Opacity of the 3D volume. Default 0.18. */
    beamOpacity?: number;
    /** Detail of the 3D volume in metres. Default 50. */
    volumeCellSizeM?: number;

    // Kept only so older callers still compile. Not used any more.
    drawRays?: boolean;
    elevationRingsPerZone?: number;
    useObjectPicking?: boolean;
    interiorOpacity?: number;
    showInterior?: boolean;
    interiorLayers?: number;
    drawShell?: boolean;
    drawShellFloor?: boolean;
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
    volumeOpacity: number;
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
// Constants
// =============================================================================

const TERRAIN_SAMPLE_SPACING_M = 5;

// Earth curves away from the radar's flat "east-north-up" plane.
// 4/3 earth radius = standard radar refraction.
const EFFECTIVE_EARTH_RADIUS_M = 6371000 * (4 / 3);
function curvatureDrop(d: number): number {
    return (d * d) / (2 * EFFECTIVE_EARTH_RADIUS_M);
}

// =============================================================================
// CesiumRadarCoverage
// =============================================================================

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
    // 1. Main entry point
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
            mastHeight = 2,
            sectorStartDeg = 0,
            sectorSweepDeg = 360,
            azimuthStepDeg = 2,
            rangeSampleSteps,
            zoneOverrides = {},
            clearanceToleranceM = 1,
            drawFootprint = true,
            footprintOpacity = 0.25,
            drawVolume = true,
            volumeCellSizeM = 50
        } = options;

        const handles: RadarCoverageHandle[] = [];

        // --- Radar position (ground height + mast) ---
        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider, [cartographic]);
        const terrainHeight = sampled.height ?? 0;
        const radarHeight = terrainHeight + mastHeight;

        const radarPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarHeight);
        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);

        // --- Radar marker ---
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

        // --- Zones ---
        const zones: ResolvedZone[] = [];
        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
            const override = zoneOverrides[zoneConfig.name] ?? {};
            if (!(override.visible ?? true)) continue;

            zones.push({
                name: zoneConfig.name,
                color: override.color ? Cesium.Color.fromCssColorString(override.color) : zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                minElevationDeg: override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg,
                maxElevationDeg: override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg,
                volumeOpacity: override.beamOpacity ?? (options.beamOpacity ?? 0.18),
                azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
            });
        }
        if (zones.length === 0) return handles;

        // Biggest zone first, so smaller zones are drawn on top of it
        zones.sort((a, b) => b.range - a.range);

        // --- Read ground heights once per fan of directions ---
        const fanKey = (z: ResolvedZone) => `${z.azimuthStartDeg}|${z.azimuthWidthDeg}`;
        const profileGroups = new Map<string, { maxRange: number; spacing: number }>();
        for (const zone of zones) {
            const spacing = rangeSampleSteps
                ? zone.range / Math.max(2, rangeSampleSteps)
                : TERRAIN_SAMPLE_SPACING_M;
            const group = profileGroups.get(fanKey(zone));
            if (group) {
                group.maxRange = Math.max(group.maxRange, zone.range);
                group.spacing = Math.min(group.spacing, spacing);
            } else {
                profileGroups.set(fanKey(zone), { maxRange: zone.range, spacing });
            }
        }

        const profilesByFan = new Map<string, TerrainProfile[]>();
        for (const [key, group] of profileGroups) {
            const [fanStartDeg, fanWidthDeg] = key.split("|").map(Number);
            const azimuths = CesiumRadarCoverage.buildAzimuthList(fanStartDeg, fanWidthDeg, azimuthStepDeg);
            profilesByFan.set(key, await CesiumRadarCoverage.buildTerrainProfiles(
                terrainProvider, enuMatrix, azimuths, group.maxRange, group.spacing
            ));
        }

        // --- Draw each zone ---
        for (const zone of zones) {
            const profiles = profilesByFan.get(fanKey(zone))!;
            const closeLoop = zone.azimuthWidthDeg >= 360;
            const tanMax = Math.tan(Cesium.Math.toRadians(zone.maxElevationDeg));

            // 1) Footprint on the ground
            if (drawFootprint) {
                const stopDistances = profiles.map(p =>
                    CesiumRadarCoverage.getRayStopDistance(p, radarHeight, zone.range, tanMax, clearanceToleranceM)
                );
                const footprint = CesiumRadarCoverage.buildFootprint(
                    viewer, radarPosition, enuMatrix, zone, profiles.map(p => p.azimuthDeg),
                    stopDistances, closeLoop, entityId, footprintOpacity
                );
                handles.push({ dispose: () => footprint.forEach(e => viewer.entities.remove(e)) });
            }

            // 2) Volume in the air
            if (drawVolume) {
                const volume = CesiumRadarCoverage.buildCoverageVolume(
                    radarPosition, enuMatrix, zone, profiles, radarHeight, closeLoop, entityId, volumeCellSizeM
                );
                if (volume) {
                    viewer.scene.primitives.add(volume);
                    handles.push({ dispose: () => viewer.scene.primitives.remove(volume) });
                }
            }
        }

        viewer.scene.requestRender();
        return handles;
    }

    // -------------------------------------------------------------------
    // 2. List of directions (degrees from north, clockwise)
    // -------------------------------------------------------------------
    private static buildAzimuthList(sectorStartDeg: number, sectorSweepDeg: number, stepDeg: number): number[] {
        const sweep = Cesium.Math.clamp(sectorSweepDeg, 1, 360);
        const step = Math.max(0.1, stepDeg);
        const full = sweep >= 360;
        const count = Math.max(2, Math.round(sweep / step) + (full ? 0 : 1));
        const azimuths: number[] = [];
        for (let i = 0; i < count; i++) {
            const raw = sectorStartDeg + (sweep * i) / (full ? count : count - 1);
            azimuths.push(((raw % 360) + 360) % 360);
        }
        return azimuths;
    }

    // -------------------------------------------------------------------
    // 3. Ground heights along every direction
    // -------------------------------------------------------------------
    private static async buildTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
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

        const cartographics: Cesium.Cartographic[] = [];
        const local = new Cesium.Cartesian3();
        const world = new Cesium.Cartesian3();

        for (const azimuthDeg of azimuthsDeg) {
            const az = Cesium.Math.toRadians(azimuthDeg);
            for (const d of horizontalDistances) {
                local.x = Math.sin(az) * d;   // east
                local.y = Math.cos(az) * d;   // north
                local.z = 0;
                Cesium.Matrix4.multiplyByPoint(enuMatrix, local, world);
                cartographics.push(Cesium.Cartographic.fromCartesian(world));
            }
        }

        const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, cartographics);

        return azimuthsDeg.map((azimuthDeg, a) => {
            const groundHeights: number[] = [];
            const base = a * sampleCount;
            for (let i = 0; i < sampleCount; i++) {
                groundHeights.push(sampled[base + i].height ?? 0);
            }
            return { azimuthDeg, horizontalDistances, groundHeights };
        });
    }

    // -------------------------------------------------------------------
    // 4. How far does this direction reach on the ground?
    //
    // slope = (ground height relative to radar) / distance
    //       = how steeply the radar looks at that ground point.
    // - If a point's slope is LOWER than an earlier point's, that earlier
    //   point (a ridge) hides it -> stop at the ridge.
    // - If the slope is HIGHER than the beam top (tanMax), the ground is
    //   above the beam -> stop there too.
    // -------------------------------------------------------------------
    private static getRayStopDistance(
        profile: TerrainProfile,
        radarHeight: number,
        maxRange: number,
        tanMax: number,
        toleranceM: number
    ): number {
        const { horizontalDistances, groundHeights } = profile;
        let maxSlope = -Infinity;
        let lastVisible = 0;

        for (let i = 1; i < horizontalDistances.length; i++) {
            const d = horizontalDistances[i];
            if (d <= 0) continue;
            if (d > maxRange) break;

            const relHeight = groundHeights[i] - curvatureDrop(d) - radarHeight;
            const slope = relHeight / d;

            const hiddenByRidge = slope < maxSlope - toleranceM / d;
            const aboveBeam = slope > tanMax + toleranceM / d;
            if (hiddenByRidge || aboveBeam) return lastVisible;

            lastVisible = d;
            if (slope > maxSlope) maxSlope = slope;
        }
        return maxRange;
    }

    // -------------------------------------------------------------------
    // 5. Footprint: stop points -> one polygon painted on the ground
    // -------------------------------------------------------------------
    private static buildFootprint(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        stopDistances: number[],
        closeLoop: boolean,
        entityId: string,
        opacity: number
    ): Cesium.Entity[] {
        const tips = azimuthsDeg.map((azDeg, i) => {
            const az = Cesium.Math.toRadians(azDeg);
            const d = Math.max(1, stopDistances[i]);
            const local = new Cesium.Cartesian3(Math.sin(az) * d, Math.cos(az) * d, 0);
            return Cesium.Matrix4.multiplyByPoint(enuMatrix, local, new Cesium.Cartesian3());
        });

        const ring = closeLoop ? tips : [radarPosition, ...tips];

        const fill = viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(ring),
                material: zone.color.withAlpha(opacity),
                classificationType: Cesium.ClassificationType.TERRAIN
            }
        });

        const outline = viewer.entities.add({
            polyline: {
                positions: [...ring, ring[0]],
                width: 3,
                material: zone.color,
                clampToGround: true
            }
        });

        (fill as any).radarParentId = entityId;
        (outline as any).radarParentId = entityId;
        return [fill, outline];
    }

    // -------------------------------------------------------------------
    // 6. Volume: roof = beam top, floor = max(ground, ridge shadow)
    // Heights are "z above the radar" in the radar's east-north-up frame.
    // -------------------------------------------------------------------
    private static buildCoverageVolume(
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        profiles: TerrainProfile[],
        radarHeight: number,
        closeLoop: boolean,
        entityId: string,
        cellSizeM: number
    ): Cesium.Primitive | null {
        const nAz = profiles.length;
        if (nAz < 2) return null;

        const dists = profiles[0].horizontalDistances;
        const spacing = dists[1] - dists[0];
        const stride = Math.max(1, Math.round(cellSizeM / spacing));
        const tanMax = Math.tan(Cesium.Math.toRadians(zone.maxElevationDeg));
        const LIFT_M = 2; // keep the floor just off the ground

        // Distances where we build cells (every ~cellSizeM, inside the range)
        const ks: number[] = [];
        for (let k = stride; k < dists.length && dists[k] <= zone.range; k += stride) ks.push(k);
        const nK = ks.length;
        if (nK < 2) return null;

        // --- floor / roof / shadow for every direction and distance ---
        const floorZ: number[][] = [];
        const roofZ: number[][] = [];
        const inShadow: boolean[][] = [];

        for (const p of profiles) {
            const f: number[] = [];
            const r: number[] = [];
            const s: boolean[] = [];
            let maxSlope = -Infinity;
            let n = 0;

            for (let k = 1; k < dists.length && n < nK; k++) {
                const d = dists[k];
                if (d <= 0) continue;
                const groundZ = p.groundHeights[k] - curvatureDrop(d) - radarHeight;

                if (k === ks[n]) {
                    const shadowZ = maxSlope * d;             // line from radar over highest ridge so far
                    f.push(Math.max(groundZ, shadowZ) + LIFT_M);
                    r.push(d * tanMax);
                    s.push(shadowZ > groundZ + 1);
                    n++;
                }

                const slope = groundZ / d;
                if (slope > maxSlope) maxSlope = slope;        // after, so a point can't shadow itself
            }
            floorZ.push(f);
            roofZ.push(r);
            inShadow.push(s);
        }

        // --- make each point once, reuse it in many triangles ---
        const positions: number[] = [radarPosition.x, radarPosition.y, radarPosition.z]; // 0 = radar
        const indices: number[] = [];
        const sinAz = profiles.map(p => Math.sin(Cesium.Math.toRadians(p.azimuthDeg)));
        const cosAz = profiles.map(p => Math.cos(Cesium.Math.toRadians(p.azimuthDeg)));
        const local = new Cesium.Cartesian3();
        const world = new Cesium.Cartesian3();

        const addPoint = (a: number, n: number, z: number): number => {
            const d = dists[ks[n]];
            local.x = sinAz[a] * d;
            local.y = cosAz[a] * d;
            local.z = z;
            Cesium.Matrix4.multiplyByPoint(enuMatrix, local, world);
            positions.push(world.x, world.y, world.z);
            return positions.length / 3 - 1;
        };

        const roofIdx = profiles.map((_, a) => ks.map((_, n) => addPoint(a, n, roofZ[a][n])));
        const floorIdx = profiles.map((_, a) => ks.map((_, n) => addPoint(a, n, floorZ[a][n])));

        const covered = (a: number, n: number) => roofZ[a][n] > floorZ[a][n];
        const quad = (p0: number, p1: number, p2: number, p3: number) =>
            indices.push(p0, p1, p2, p0, p2, p3);

        const pairCount = closeLoop ? nAz : nAz - 1;
        const L = nK - 1;

        for (let i = 0; i < pairCount; i++) {
            const j = (i + 1) % nAz;

            // roof near the radar
            if (covered(i, 0) && covered(j, 0)) {
                indices.push(0, roofIdx[i][0], roofIdx[j][0]);
            }

            for (let n = 0; n < L; n++) {
                const m = n + 1;
                if (!(covered(i, n) && covered(i, m) && covered(j, n) && covered(j, m))) continue;

                // roof
                quad(roofIdx[i][n], roofIdx[i][m], roofIdx[j][m], roofIdx[j][n]);

                // floor ONLY behind ridges (where it is above the ground)
                if (inShadow[i][n] && inShadow[i][m] && inShadow[j][n] && inShadow[j][m]) {
                    quad(floorIdx[i][n], floorIdx[i][m], floorIdx[j][m], floorIdx[j][n]);
                }
            }

            // outer wall at max range
            if (covered(i, L) && covered(j, L)) {
                quad(floorIdx[i][L], roofIdx[i][L], roofIdx[j][L], floorIdx[j][L]);
            }
        }

        // side walls for a partial sector (e.g. 90° to 135°)
        if (!closeLoop) {
            for (const a of [0, nAz - 1]) {
                for (let n = 0; n < L; n++) {
                    const m = n + 1;
                    if (covered(a, n) && covered(a, m)) {
                        quad(floorIdx[a][n], floorIdx[a][m], roofIdx[a][m], roofIdx[a][n]);
                    }
                }
            }
        }

        if (indices.length === 0) return null;

        const geometry = new Cesium.Geometry({
            attributes: ({
                position: new Cesium.GeometryAttribute({
                    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                    componentsPerAttribute: 3,
                    values: new Float64Array(positions)
                })
            } as unknown) as Cesium.GeometryAttributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positions)
        });

        return new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
                geometry,
                id: entityId,
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                        zone.color.withAlpha(zone.volumeOpacity)
                    )
                }
            }),
            appearance: new Cesium.PerInstanceColorAppearance({
                translucent: true,
                closed: false,
                flat: true
            }),
            asynchronous: false
        });
    }
}