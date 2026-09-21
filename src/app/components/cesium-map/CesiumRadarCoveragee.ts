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
    beamOpacity: number;
    interiorOpacity: number;
    showInterior: boolean;
    interiorLayers: number; // kept for backward compat, no longer used to stack layers
}

export interface RadarZoneOverride {
    visible?: boolean;
    range?: number;
    minElevationDeg?: number;
    maxElevationDeg?: number;

    // Per-zone heading/aperture. Defaults to the radar's global sector.
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

/** Ground heights down one azimuth, shared by every elevation ring for a zone. */
interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
}

export interface RadarCoverageHandle {
    dispose(): void;
}

// =============================================================================
// CesiumRadarCoverage
// =============================================================================

const TERRAIN_SAMPLE_SPACING_M = 10;
const EARTH_RADIUS_M = 6371000;

// When two neighbouring ray endpoints (same cell) sit at very different ranges
// from the radar, one of them is near a terrain edge and the other reaches
// much further. Rather than stretch a triangle across that whole gap (a
// "blade") or drop the cell entirely (a hole), the far vertex is clamped back
// toward the near vertex along ITS OWN ray direction, capped at this ratio.
// This keeps the cut continuous and bounded without inventing geometry that
// isn't actually where the ray sampled.
const MAX_NEIGHBOUR_RANGE_RATIO = 1.5;

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
            defaultRange: 16000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 20
        },
        {
            name: "Zone 3 (High / Wide)",
            cssColor: "#3b82f6",
            color: Cesium.Color.fromCssColorString("#3b82f6"),
            defaultRange: 20000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 30
        }
    ];

    // -------------------------------------------------------------------
    // Public entry point
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
            drawRays = false,
            azimuthStepDeg = 5,
            rangeSampleSteps,
            elevationRingsPerZone = 4,
            useObjectPicking = false,
            zoneOverrides = {}
        } = options;

        const handles: RadarCoverageHandle[] = [];

        // ---------------------------------------------------------------
        // 1. Radar base position
        // ---------------------------------------------------------------

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

        // ---------------------------------------------------------------
        // 2. Radar marker
        // ---------------------------------------------------------------

        const marker = viewer.entities.add({
            position: radarPosition,
            point: {
                pixelSize: 18,
                color: Cesium.Color.BLACK,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        (marker as any).radarParentId = entityId;
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // ---------------------------------------------------------------
        // 3. Resolve visible zones (each may have its own heading/width)
        // ---------------------------------------------------------------

        const visibleZones: ResolvedZone[] = [];

        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {

            const override = zoneOverrides[zoneConfig.name] ?? {};

            if (!(override.visible ?? true)) {
                continue;
            }

            visibleZones.push({
                name: zoneConfig.name,
                color: zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                minElevationDeg: override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg,
                maxElevationDeg: override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg,
                beamOpacity: override.beamOpacity ?? options.beamOpacity,
                interiorOpacity: override.interiorOpacity ?? options.interiorOpacity,
                showInterior: override.showInterior ?? options.showInterior,
                visible: true,
                // Heading = azimuthStartDeg, aperture = azimuthWidthDeg.
                // Both default to the radar's global sector so existing
                // radars with no per-zone override behave exactly as before.
                azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
            });
        }

        if (visibleZones.length === 0) {
            return handles;
        }

        // ---------------------------------------------------------------
        // 4. Build each zone (own azimuth list, own terrain profiles)
        // ---------------------------------------------------------------

        let previousRing0: Cesium.Cartesian3[] | null = null;

        for (const zone of visibleZones) {

            const isZoneFullCircle = zone.azimuthWidthDeg >= 360;
            const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
                zone.azimuthStartDeg,
                zone.azimuthWidthDeg,
                azimuthStepDeg
            );

            const profileSpacing = rangeSampleSteps
                ? zone.range / Math.max(2, rangeSampleSteps)
                : TERRAIN_SAMPLE_SPACING_M;

            const profiles = await CesiumRadarCoverage.buildTerrainProfiles(
                terrainProvider,
                radarPosition,
                enuMatrix,
                azimuthsDeg,
                zone.range,
                profileSpacing
            );

            const elevationRingsDeg = CesiumRadarCoverage.buildElevationRings(
                zone.minElevationDeg,
                zone.maxElevationDeg,
                elevationRingsPerZone
            );

            const grid = CesiumRadarCoverage.buildZoneGrid(
                viewer,
                radarPosition,
                radarHeight,
                enuMatrix,
                zone,
                azimuthsDeg,
                elevationRingsDeg,
                profiles,
                useObjectPicking
            );

            // Faint full-range disc so terrain-blocked ground still reads as
            // "within this zone's potential range" instead of bare basemap.
            const rangeDisc = CesiumRadarCoverage.buildRangePotentialDisc(
                viewer, radarPosition, enuMatrix, zone, azimuthsDeg, entityId
            );

            // Bright outer boundary wall - the actual terrain-clipped surface.
            const meshPrimitive = CesiumRadarCoverage.buildMeshPrimitive(
                zone,
                grid.points,
                grid.distances,
                azimuthsDeg,
                isZoneFullCircle,
                radarPosition,
                entityId,
                zone.beamOpacity
            );
            if (meshPrimitive) {
                viewer.scene.primitives.add(meshPrimitive);
            }

            // Single subtle interior - same clipped surface, lower opacity,
            // no stacking of multiple translucent layers.
            let interiorPrimitive: Cesium.Primitive | null = null;
            if (zone.showInterior) {
                interiorPrimitive = CesiumRadarCoverage.buildMeshPrimitive(
                    zone,
                    grid.points,
                    grid.distances,
                    azimuthsDeg,
                    isZoneFullCircle,
                    radarPosition,
                    entityId,
                    Math.min(zone.beamOpacity * 0.9, zone.interiorOpacity)
                );
                if (interiorPrimitive) {
                    viewer.scene.primitives.add(interiorPrimitive);
                }
            }

            // Ring-banded footprint: hole-punched by the previous (smaller)
            // zone so overlapping zones don't muddy into grey when stacked.
            const footprintEntity = CesiumRadarCoverage.buildGroundFootprint(
                viewer, zone, grid.points[0], entityId, previousRing0
            );
            previousRing0 = grid.points[0];

            let rayCollection: Cesium.PolylineCollection | null = null;
            if (drawRays) {
                rayCollection = CesiumRadarCoverage.buildDebugRayCollection(
                    viewer,
                    radarPosition,
                    zone,
                    grid.points,
                    azimuthsDeg,
                    elevationRingsDeg
                );
            }

            handles.push({
                dispose: () => {
                    if (rangeDisc) viewer.entities.remove(rangeDisc);
                    if (meshPrimitive) viewer.scene.primitives.remove(meshPrimitive);
                    if (interiorPrimitive) viewer.scene.primitives.remove(interiorPrimitive);
                    if (footprintEntity) viewer.entities.remove(footprintEntity);
                    if (rayCollection) viewer.scene.primitives.remove(rayCollection);
                }
            });

            viewer.scene.requestRender();
        }

        return handles;
    }

    // -------------------------------------------------------------------
    // Terrain profiles
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
    // Grid sampling: points + slant distance + blocked flag per (ring, az)
    // -------------------------------------------------------------------

    private static buildZoneGrid(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        radarHeight: number,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        elevationRingsDeg: number[],
        profiles: TerrainProfile[],
        useObjectPicking: boolean
    ): { points: Cesium.Cartesian3[][]; distances: number[][]; blocked: boolean[][] } {

        const objectDetector = useObjectPicking ? new CesiumObjectDetector(viewer) : null;

        const points: Cesium.Cartesian3[][] = [];
        const distances: number[][] = [];
        const blocked: boolean[][] = [];

        for (const elevationDeg of elevationRingsDeg) {

            const ringPoints: Cesium.Cartesian3[] = [];
            const ringDistances: number[] = [];
            const ringBlocked: boolean[] = [];

            for (let a = 0; a < azimuthsDeg.length; a++) {

                const ray = CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, azimuthsDeg[a], elevationDeg);

                const terrainDistance = CesiumRadarCoverage.terrainBlockDistance(
                    profiles[a], radarHeight, elevationDeg, zone.range
                );

                const objectDistance = objectDetector
                    ? objectDetector.getFirstObjectHit(ray, zone.range)
                    : Number.POSITIVE_INFINITY;

                const distance = Math.min(terrainDistance, objectDistance, zone.range);

                ringPoints.push(Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3()));
                ringDistances.push(distance);
                ringBlocked.push(distance < zone.range - 1e-6);
            }

            points.push(ringPoints);
            distances.push(ringDistances);
            blocked.push(ringBlocked);
        }

        return { points, distances, blocked };
    }

    private static terrainBlockDistance(
        profile: TerrainProfile,
        radarHeight: number,
        elevationDeg: number,
        maxRange: number
    ): number {

        const elevation = Cesium.Math.toRadians(elevationDeg);
        const cosElevation = Math.cos(elevation);

        if (cosElevation < 1e-6) {
            return maxRange;
        }

        const tanElevation = Math.tan(elevation);
        const maxHorizontal = maxRange * cosElevation;

        const { horizontalDistances, groundHeights } = profile;

        let previousHorizontal = horizontalDistances[0];
        let previousClearance = radarHeight - groundHeights[0];

        for (let i = 1; i < horizontalDistances.length; i++) {

            const horizontal = horizontalDistances[i];
            if (horizontal > maxHorizontal) {
                break;
            }

            const rayHeight =
                radarHeight +
                horizontal * tanElevation -
                (horizontal * horizontal) / (2 * EARTH_RADIUS_M);

            const clearance = rayHeight - groundHeights[i];

            if (clearance > 0) {
                previousHorizontal = horizontal;
                previousClearance = clearance;
                continue;
            }

            const drop = previousClearance - clearance;
            const fraction = drop > 0 ? Cesium.Math.clamp(previousClearance / drop, 0, 1) : 0;
            const blockHorizontal = previousHorizontal + fraction * (horizontal - previousHorizontal);

            return blockHorizontal / cosElevation;
        }

        return maxRange;
    }

    // -------------------------------------------------------------------
    // Faint full-range disc (flat on the ground at each zone's max range),
    // drawn underneath everything else so blocked terrain still reads as
    // "within potential range" instead of raw basemap.
    // -------------------------------------------------------------------

    private static buildRangePotentialDisc(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        entityId: string
    ): Cesium.Entity | null {

        if (azimuthsDeg.length < 3) {
            return null;
        }

        const positions = azimuthsDeg.map(az => {
            const ray = CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, az, 0);
            return Cesium.Ray.getPoint(ray, zone.range, new Cesium.Cartesian3());
        });

        const lifted = positions.map(p => {
            const c = Cesium.Cartographic.fromCartesian(p);
            return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + 0.25);
        });

        const disc = viewer.entities.add({
            name: `${zone.name} potential range`,
            polygon: {
                hierarchy: lifted,
                perPositionHeight: true,
                material: zone.color.withAlpha(0.06),
                outline: false
            }
        });

        (disc as any).radarParentId = entityId;
        return disc;
    }

    // -------------------------------------------------------------------
    // Coverage mesh. Used for both the bright outer boundary (high opacity)
    // and the single subtle interior (low opacity) - same geometry, called
    // twice with different alpha, never stacked in multiple layers.
    //
    // Terrain-cut handling: a cell is skipped only if ALL FOUR corners are
    // blocked (nothing visible there at all). Otherwise, for each triangle,
    // any corner whose distance is far beyond its nearest neighbour in that
    // triangle (ratio > MAX_NEIGHBOUR_RANGE_RATIO) gets a CLAMPED duplicate
    // vertex - pulled back along its own ray toward the near corner - so the
    // rendered cut stays continuous and bounded instead of stretching into a
    // blade or vanishing into a hole.
    // -------------------------------------------------------------------

    private static buildMeshPrimitive(
        zone: ResolvedZone,
        points: Cesium.Cartesian3[][],
        distances: number[][],
        azimuthsDeg: number[],
        isFullCircle: boolean,
        radarPosition: Cesium.Cartesian3,
        entityId: string,
        alpha: number
    ): Cesium.Primitive | null {

        const ringCount = points.length;
        const azCount = azimuthsDeg.length;

        if (ringCount < 2 || azCount < 2) {
            return null;
        }

        const indexOf = (ring: number, az: number) => ring * azCount + az;

        // Base vertices: the real, unclamped ray endpoints.
        const positionValues: number[] = [];
        for (let r = 0; r < ringCount; r++) {
            for (let a = 0; a < azCount; a++) {
                const p = points[r][a];
                positionValues.push(p.x, p.y, p.z);
            }
        }

        const indices: number[] = [];

        // Clamped duplicates are added on demand and cached by
        // "ring,az,relativeToRing,relativeToAz" so the same clamp is reused
        // across the two triangles of a cell instead of duplicating twice.
        const clampCache = new Map<string, number>();

        const getClampedIndex = (
            farRing: number, farAz: number,
            nearRing: number, nearAz: number
        ): number => {

            const key = `${farRing},${farAz}<-${nearRing},${nearAz}`;
            const cached = clampCache.get(key);
            if (cached !== undefined) {
                return cached;
            }

            const farPoint = points[farRing][farAz];
            const farDistance = distances[farRing][farAz];
            const nearDistance = distances[nearRing][nearAz];

            const maxAllowed = nearDistance * MAX_NEIGHBOUR_RANGE_RATIO;
            const t = Cesium.Math.clamp(maxAllowed / Math.max(farDistance, 1e-6), 0, 1);

            // Pull the far point back toward the radar along ITS OWN ray
            // direction - preserves that ray's actual azimuth/elevation,
            // just shortens it, so the clamp never invents a direction that
            // wasn't actually sampled.
            const clamped = new Cesium.Cartesian3();
            Cesium.Cartesian3.lerp(radarPosition, farPoint, t, clamped);

            const newIndex = positionValues.length / 3;
            positionValues.push(clamped.x, clamped.y, clamped.z);
            clampCache.set(key, newIndex);
            return newIndex;
        };

        // Returns the index to actually use for corner `far`, given it will
        // be connected to corner `near` in a triangle. Clamps only if the
        // ratio between them exceeds the threshold.
        const resolveCorner = (
            farRing: number, farAz: number,
            nearRing: number, nearAz: number
        ): number => {

            const farDistance = distances[farRing][farAz];
            const nearDistance = distances[nearRing][nearAz];

            if (farDistance > nearDistance * MAX_NEIGHBOUR_RANGE_RATIO) {
                return getClampedIndex(farRing, farAz, nearRing, nearAz);
            }

            return indexOf(farRing, farAz);
        };

        const azStepCount = isFullCircle ? azCount : azCount - 1;

        for (let r = 0; r < ringCount - 1; r++) {
            for (let a = 0; a < azStepCount; a++) {

                const aNext = (a + 1) % azCount;

                const blocked00 = distances[r][a] < zone.range - 1e-6;
                const blocked01 = distances[r][aNext] < zone.range - 1e-6;
                const blocked10 = distances[r + 1][a] < zone.range - 1e-6;
                const blocked11 = distances[r + 1][aNext] < zone.range - 1e-6;

                // Nothing visible anywhere in this cell.
                if (blocked00 && blocked01 && blocked10 && blocked11) {
                    continue;
                }

                // Triangle 1: (r,a) - (r+1,a) - (r+1,aNext)
                {
                    const dNear = Math.min(distances[r][a], distances[r + 1][a], distances[r + 1][aNext]);

                    const i00 = distances[r][a] > dNear * MAX_NEIGHBOUR_RANGE_RATIO
                        ? resolveCorner(r, a, r + 1, a) : indexOf(r, a);
                    const i10 = distances[r + 1][a] > dNear * MAX_NEIGHBOUR_RANGE_RATIO
                        ? resolveCorner(r + 1, a, r, a) : indexOf(r + 1, a);
                    const i11 = distances[r + 1][aNext] > dNear * MAX_NEIGHBOUR_RANGE_RATIO
                        ? resolveCorner(r + 1, aNext, r + 1, a) : indexOf(r + 1, aNext);

                    indices.push(i00, i10, i11);
                }

                // Triangle 2: (r,a) - (r+1,aNext) - (r,aNext)
                {
                    const dNear = Math.min(distances[r][a], distances[r + 1][aNext], distances[r][aNext]);

                    const i00 = distances[r][a] > dNear * MAX_NEIGHBOUR_RANGE_RATIO
                        ? resolveCorner(r, a, r, aNext) : indexOf(r, a);
                    const i11 = distances[r + 1][aNext] > dNear * MAX_NEIGHBOUR_RANGE_RATIO
                        ? resolveCorner(r + 1, aNext, r, aNext) : indexOf(r + 1, aNext);
                    const i01 = distances[r][aNext] > dNear * MAX_NEIGHBOUR_RANGE_RATIO
                        ? resolveCorner(r, aNext, r, a) : indexOf(r, aNext);

                    indices.push(i00, i11, i01);
                }
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const meshAttributes = new Cesium.GeometryAttributes();
        meshAttributes.position = new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positionValues)
        });

        const geometry = new Cesium.Geometry({
            attributes: meshAttributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positionValues)
        });

        const instance = new Cesium.GeometryInstance({
            geometry,
            id: entityId,
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    zone.color.withAlpha(Cesium.Math.clamp(alpha, 0.0, 1.0))
                )
            }
        });

        return new Cesium.Primitive({
            geometryInstances: instance,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                closed: false
            }),
            asynchronous: false
        });
    }

    // -------------------------------------------------------------------
    // Ring-banded ground footprint: outer ring of this zone, with the
    // previous (smaller) zone's ring-0 shape punched out as a hole, so
    // overlapping zones tint their own exclusive band instead of stacking
    // into grey/brown where they overlap.
    // -------------------------------------------------------------------

    private static buildGroundFootprint(
        viewer: Cesium.Viewer,
        zone: ResolvedZone,
        ring0Points: Cesium.Cartesian3[],
        entityId: string,
        innerHoleRing0Points: Cesium.Cartesian3[] | null
    ): Cesium.Entity | null {

        if (!ring0Points || ring0Points.length < 3) {
            return null;
        }

        const lift = (p: Cesium.Cartesian3) => {
            const c = Cesium.Cartographic.fromCartesian(p);
            return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + 0.5);
        };

        const outer = ring0Points.map(lift);
        const holes = innerHoleRing0Points && innerHoleRing0Points.length >= 3
            ? [new Cesium.PolygonHierarchy(innerHoleRing0Points.map(lift))]
            : undefined;

        const footprint = viewer.entities.add({
            name: `${zone.name} ground footprint`,
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(outer, holes),
                perPositionHeight: true,
                material: zone.color.withAlpha(0.18),
                outline: true,
                outlineColor: zone.color.withAlpha(0.7)
            }
        });

        (footprint as any).radarParentId = entityId;
        return footprint;
    }

    // -------------------------------------------------------------------
    // Debug ray overlay - sparsified, or it drowns the mesh in clutter.
    // -------------------------------------------------------------------

    private static buildDebugRayCollection(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        zone: ResolvedZone,
        points: Cesium.Cartesian3[][],
        azimuthsDeg: number[],
        elevationRingsDeg: number[]
    ): Cesium.PolylineCollection {

        const collection = new Cesium.PolylineCollection();

        const azStride = Math.max(1, Math.round(azimuthsDeg.length / 24));
        const ringStride = Math.max(1, Math.round(elevationRingsDeg.length / 3));

        for (let r = 0; r < elevationRingsDeg.length; r += ringStride) {
            for (let a = 0; a < azimuthsDeg.length; a += azStride) {
                collection.add({
                    positions: [radarPosition, points[r][a]],
                    width: 1,
                    material: Cesium.Material.fromType("Color", {
                        color: zone.color.withAlpha(0.55)
                    })
                });
            }
        }

        viewer.scene.primitives.add(collection);
        return collection;
    }

    // -------------------------------------------------------------------
    // Geometry helpers
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

    private static buildElevationRings(
        minDeg: number,
        maxDeg: number,
        ringCount: number
    ): number[] {

        const count = Math.max(2, Math.round(ringCount));

        if (maxDeg <= minDeg) {
            return [minDeg];
        }

        const rings: number[] = [];
        for (let i = 0; i < count; i++) {
            rings.push(minDeg + ((maxDeg - minDeg) * i) / (count - 1));
        }

        return rings;
    }
}