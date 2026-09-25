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
    clearanceToleranceM?: number;
    drawShellFloor?: boolean;
    drawFootprint?: boolean;    // new ground polygon (on by default)
    footprintOpacity?: number;
    drawShell?: boolean;        // old 3D shape (off by default)
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

// One entry per ZONE now (not per ring). The rings live inside it as
// ringEdgesDeg: N rings -> N + 1 edge angles, bottom to top.
interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    ringEdgesDeg: number[];
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
// CesiumRadarCoverage (one connected shell per zone, stepped by terrain)
// =============================================================================

const TERRAIN_SAMPLE_SPACING_M = 2;
const EFFECTIVE_EARTH_RADIUS_M = 6371000 * (4 / 3);
function curvatureDrop(d: number): number {
    return (d * d) / (2 * EFFECTIVE_EARTH_RADIUS_M);
}



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
            mastHeight = 2,
            clearanceToleranceM = 1,
            drawShell = false,
            drawShellFloor = false,
            drawFootprint = true,
            footprintOpacity = 0.25,
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

        // Resolve zones. Each zone keeps its rings as a list of edge angles
        // instead of becoming N separate sub-zones.
        const zones: ResolvedZone[] = [];
        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
            const override = zoneOverrides[zoneConfig.name] ?? {};
            if (!(override.visible ?? true)) continue;

            const minEl = override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg;
            const maxEl = override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg;
            const rings = Math.max(1, elevationRingsPerZone);
            const ringSpan = (maxEl - minEl) / rings;

            const ringEdgesDeg: number[] = [];
            for (let k = 0; k <= rings; k++) {
                ringEdgesDeg.push(minEl + k * ringSpan);
            }

            zones.push({
                name: zoneConfig.name,
                color: override.color
                    ? Cesium.Color.fromCssColorString(override.color)
                    : zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                minElevationDeg: minEl,
                maxElevationDeg: maxEl,
                ringEdgesDeg,
                beamOpacity: override.beamOpacity ?? (options.beamOpacity ?? 0.35),
                interiorOpacity: override.interiorOpacity ?? (options.interiorOpacity ?? 0.15),
                showInterior: override.showInterior ?? (options.showInterior ?? true),
                visible: true,
                azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
            });
        }

        if (zones.length === 0) return handles;

        // Sample each distinct azimuth fan once, out to the largest range and at
        // the finest spacing any zone on that fan needs. Rings never need their
        // own sampling: the elevation check reuses the same ground heights.
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

        // Build ONE connected shell per zone
                // Build ONE connected shell per zone
        for (const zone of zones) {
            const profiles = profilesByFan.get(fanKey(zone))!;
            const azimuthsDeg = profiles.map(p => p.azimuthDeg);
            const closeLoop = zone.azimuthWidthDeg >= 360;

            // NEW: rays stop at the first ridge, stop points -> polygon on the ground
            if (drawFootprint) {
                const stopDistances = profiles.map(p =>
                    CesiumRadarCoverage.getRayStopDistance(p, radarHeight, zone.range, clearanceToleranceM)
                );
                const footprint = CesiumRadarCoverage.buildFootprint(
                    viewer, radarPosition, enuMatrix, zone, azimuthsDeg,
                    stopDistances, closeLoop, entityId, footprintOpacity
                );
                handles.push({ dispose: () => footprint.forEach(e => viewer.entities.remove(e)) });
            }

            if (!drawShell) continue;   // skip the old 3D shape

            // ranges[azimuthIndex][ringIndex] = how far that ring reaches in that direction
            const ringBottomsDeg = zone.ringEdgesDeg.slice(0, -1);
            const ranges: number[][] = profiles.map(profile =>
                ringBottomsDeg.map(bottomDeg =>
                    CesiumRadarCoverage.getTerrainBlockedRange(profile, radarHeight, zone.range, bottomDeg, clearanceToleranceM)
                )
            );

            

            const shell = CesiumRadarCoverage.buildZoneShellPrimitive(
                viewer,
                radarPosition,
                enuMatrix,
                zone,
                azimuthsDeg,
                ranges,
                closeLoop,
                entityId,
                drawShellFloor
            );

            if (shell) {
                handles.push({ dispose: () => viewer.scene.primitives.remove(shell) });
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
    //
    // Walks out along the ground profile and finds the EXACT distance where a
    // beam tilted at elevationDeg first touches the ground.
    //   beam height at distance d = radarHeight + d * tan(elevation)
    //   "clearance" = ground height - beam height   (> 0 means ground is above the beam)
    // When clearance changes from <= 0 to > 0 between two samples, the beam hit the
    // ground somewhere between them; linear interpolation finds that point.
    // No margin, no minimum, no skipped ground: the pin lands on the terrain itself.
    // -------------------------------------------------------------------
        private static getTerrainBlockedRange(
        profile: TerrainProfile,
        radarHeight: number,
        maxRange: number,
        elevationDeg: number,
        toleranceM: number                     // NEW
    ): number {
        const { horizontalDistances, groundHeights } = profile;
        const tanEl = Math.tan(Cesium.Math.toRadians(elevationDeg));

        let prevDist = 0;
        let prevClearance = -toleranceM;       // CHANGED: start "clear", not "touching"

        for (let i = 1; i < horizontalDistances.length; i++) {
            const dist = horizontalDistances[i];
            if (dist > maxRange) break;

            const beamHeight = radarHeight + dist * tanEl;
            // CHANGED: ground must be MORE than toleranceM above the beam to block
            const clearance = groundHeights[i] - beamHeight - toleranceM;

            if (clearance > 0) {
                const t = prevClearance >= 0 ? 0 : -prevClearance / (clearance - prevClearance);
                return prevDist + t * (dist - prevDist);
            }
            prevDist = dist;
            prevClearance = clearance;
        }
        return maxRange;
    }

        // -------------------------------------------------------------------
    // How far does the ray go along this direction before a ridge blocks it?
    // Walk outward. "slope" = how steeply the radar looks at each ground point.
    // If a point is lower than the line to an earlier, steeper point,
    // that earlier point (a ridge) is hiding it -> the ray stopped at the ridge.
    // -------------------------------------------------------------------
    private static getRayStopDistance(
        profile: TerrainProfile,
        radarHeight: number,
        maxRange: number,
        toleranceM: number
    ): number {
        const { horizontalDistances, groundHeights } = profile;
        let maxSlope = -Infinity;
        let lastVisible = 0;

        for (let i = 1; i < horizontalDistances.length; i++) {
            const d = horizontalDistances[i];
            if (d > maxRange) break;

            const relHeight = groundHeights[i] - curvatureDrop(d) - radarHeight;
            const slope = relHeight / d;

            if (slope < maxSlope - toleranceM / d) {
                return lastVisible;          // hidden behind a ridge -> ray stops at the ridge
            }
            lastVisible = d;
            if (slope > maxSlope) maxSlope = slope;
        }
        return maxRange;
    }

    // -------------------------------------------------------------------
    // Join the stop points into ONE polygon lying on the ground + bold outline.
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
        const tips: Cesium.Cartesian3[] = azimuthsDeg.map((azDeg, i) => {
            const az = Cesium.Math.toRadians(azDeg);
            const d = Math.max(1, stopDistances[i]);
            const local = new Cesium.Cartesian3(Math.sin(az) * d, Math.cos(az) * d, 0);
            return Cesium.Matrix4.multiplyByPoint(enuMatrix, local, new Cesium.Cartesian3());
        });

        // Full circle: just the tips. Partial sector: start and end at the radar.
        const ring = closeLoop ? tips : [radarPosition, ...tips];

        const fill = viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(ring),
                material: zone.color.withAlpha(opacity),
                classificationType: Cesium.ClassificationType.TERRAIN   // lies ON the ground
            }
        });

        const outline = viewer.entities.add({
            polyline: {
                positions: [...ring, ring[0]],
                width: 3,
                material: zone.color,
                clampToGround: true                                        // follows the ridges
            }
        });

        (fill as any).radarParentId = entityId;
        (outline as any).radarParentId = entityId;
        return [fill, outline];
    }
    // -------------------------------------------------------------------
    // 6. Connected Shell Builder: buildZoneShellPrimitive
    //
    // Draws only the OUTSIDE of the zone:
    //   - floor   : bottom of the lowest ring
    //   - roof    : top of the highest ring
    //   - walls   : outer wall of every ring
    //   - steps   : joins ring r to ring r+1, ONLY where their ranges differ
    //   - sides   : two end walls, only when the sector is not a full circle
    // No inner floors/roofs between rings -> no stacked-layer lines.
    // -------------------------------------------------------------------
    private static buildZoneShellPrimitive(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        ranges: number[][],
        closeLoop: boolean,
        entityId: string,
        drawFloor: boolean
    ): Cesium.Primitive | null {
        const nAz = azimuthsDeg.length;
        const edges = zone.ringEdgesDeg;
        const nRings = edges.length - 1;
        if (nAz < 2 || nRings < 1) return null;

        const positions: number[] = [];
        const indices: number[] = [];

        // Pre-compute trig once
        const sinAz = azimuthsDeg.map(a => Math.sin(Cesium.Math.toRadians(a)));
        const cosAz = azimuthsDeg.map(a => Math.cos(Cesium.Math.toRadians(a)));
        const sinEl = edges.map(e => Math.sin(Cesium.Math.toRadians(e)));
        const cosEl = edges.map(e => Math.cos(Cesium.Math.toRadians(e)));

        const scratchLocal = new Cesium.Cartesian3();
        const scratchWorld = new Cesium.Cartesian3();

        // Adds one pin at (direction azIdx, edge angle edgeIdx, distance range)
        // and returns its index.
        const addPin = (azIdx: number, edgeIdx: number, range: number): number => {
            const horiz = range * cosEl[edgeIdx];
            scratchLocal.x = sinAz[azIdx] * horiz;
            scratchLocal.y = cosAz[azIdx] * horiz;
            scratchLocal.z = range * sinEl[edgeIdx];
            Cesium.Matrix4.multiplyByPoint(enuMatrix, scratchLocal, scratchWorld);
            positions.push(scratchWorld.x, scratchWorld.y, scratchWorld.z);
            return positions.length / 3 - 1;
        };

        const addQuad = (a: number, b: number, c: number, d: number) => {
            indices.push(a, b, c, a, c, d);
        };

        // Pin 0 = radar
        positions.push(radarPosition.x, radarPosition.y, radarPosition.z);
        const apex = 0;

        // Full circle: also join the last direction back to the first (no gap)
        const pairCount = closeLoop ? nAz : nAz - 1;

        for (let i = 0; i < pairCount; i++) {
            const j = (i + 1) % nAz;

                       // Floor - off by default, it floats and the ground pokes through it
            if (drawFloor) {
                const f0 = addPin(i, 0, ranges[i][0]);
                const f1 = addPin(j, 0, ranges[j][0]);
                indices.push(apex, f0, f1);
            }

            // Roof (top of the last ring)
            const last = nRings - 1;
            const r0 = addPin(i, nRings, ranges[i][last]);
            const r1 = addPin(j, nRings, ranges[j][last]);
            indices.push(apex, r1, r0);

            for (let r = 0; r < nRings; r++) {
                // Outer wall of ring r
                const wb0 = addPin(i, r, ranges[i][r]);
                const wt0 = addPin(i, r + 1, ranges[i][r]);
                const wb1 = addPin(j, r, ranges[j][r]);
                const wt1 = addPin(j, r + 1, ranges[j][r]);
                addQuad(wb0, wt0, wt1, wb1);

                // Step from ring r up to ring r+1 - only where the hill made them differ
                if (r < last) {
                    const changedHere = ranges[i][r] !== ranges[i][r + 1];
                    const changedNext = ranges[j][r] !== ranges[j][r + 1];
                    if (changedHere || changedNext) {
                        const s0 = addPin(i, r + 1, ranges[i][r + 1]);
                        const s1 = addPin(j, r + 1, ranges[j][r + 1]);
                        addQuad(wt0, s0, s1, wt1);
                    }
                }
            }
        }

        // End walls for a partial sector (e.g. 90° to 135°)
        if (!closeLoop) {
            for (const i of [0, nAz - 1]) {
                let prev = addPin(i, 0, ranges[i][0]);
                for (let r = 0; r < nRings; r++) {
                    const up = addPin(i, r + 1, ranges[i][r]);
                    indices.push(apex, prev, up);
                    prev = up;
                    if (r < nRings - 1 && ranges[i][r + 1] !== ranges[i][r]) {
                        // Step pin lies on the same line from the radar, so no triangle needed
                        prev = addPin(i, r + 1, ranges[i][r + 1]);
                    }
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
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positions)
        });

        // flat: true -> same colour everywhere, no lighting bands, no normals needed
        // closed: false -> draw both sides (the shell is open at the radar)
        const primitive = new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
                geometry,
                id: entityId,
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                        zone.color.withAlpha(zone.beamOpacity)
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
               

        viewer.scene.primitives.add(primitive);
        return primitive;
    }
}