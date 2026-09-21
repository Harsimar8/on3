import * as Cesium from "cesium";
import { CesiumObjectDetector } from "./CesiumObjectDetector";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;             // source Entity.id - tagged onto every pickable piece so a
    // click anywhere on the radar resolves back to it
    longitude: number;
    latitude: number;
    altitude?: number;
    mastHeight?: number;          // antenna mast height above terrain (m)
    sectorStartDeg?: number;      // azimuth sector start, 0 = north, clockwise
    sectorSweepDeg?: number;      // 360 = full circle
    drawRays?: boolean;           // overlay the raw sampling rays (debug view)
    azimuthStepDeg?: number;      // wall vertex density (default 10deg -> 36 pts/360)
    rangeSampleSteps?: number;    // distance samples per ray. Leave unset to derive it from
    // the zone's range at a fixed ground spacing, which keeps
    // every zone equally accurate; set it only to pin a count.
    elevationRingsPerZone?: number; // how many elevation rings sampled per zone (default 4, min 2)
    useObjectPicking?: boolean;   // also test rays against loaded 3D Tiles/models (default false - this
    // is the expensive part; terrain-only is already accurate and much faster)
    zoneOverrides?: Record<string, RadarZoneOverride>;
    beamOpacity: number;
    interiorOpacity: number;
    showInterior: boolean;
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
}

/** Ground heights down one azimuth, shared by every elevation ring and zone. */
interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
}
interface ClippedRadarGeometry {
    positionValues: number[];
    indices: number[];
}

/** Everything create3DRadarZones() built for one radar, so callers can clean up later. */
export interface RadarCoverageHandle {
    dispose(): void;
}

// =============================================================================
// CesiumRadarCoverage
// =============================================================================

// Ray-march spacing along a ray, in metres. Sampling by ground distance rather
// than by a fixed step count keeps every zone equally accurate: a fixed count
// would sample a 20km zone four times coarser than a 5km one, which is what let
// rays step straight over narrow ridges and carry on through the mountain.
const TERRAIN_SAMPLE_SPACING_M = 10;

// Mean earth radius, used to drop the beam by the curvature of the earth over
// distance instead of treating the local tangent plane as flat.
const EARTH_RADIUS_M = 6371000;

// Adjacent grid points whose ranges differ by more than this ratio sit on
// opposite sides of a terrain blockage. Joining them would stretch one triangle
// from the blocked ray out to the unblocked one - the long blades that appear to
// slice through the mountain - so the quad is dropped and the wall just ends.
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
        // 1. Radar base position (terrain sampling - authoritative)
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
        // Tag every pickable piece with the source entity id so a click/drag
        // anywhere on the radar (marker, wall, footprint) resolves back to it -
        // see CesiumSelection.selectEntity's radarParentId lookup.
        (marker as any).radarParentId = entityId;
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // ---------------------------------------------------------------
        // 3. Azimuth list (respects sector start/sweep)
        // ---------------------------------------------------------------

        const isFullCircle = sectorSweepDeg >= 360;
        const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
            sectorStartDeg,
            sectorSweepDeg,
            azimuthStepDeg
        );

        // Object blocking (glTF/GLB models) is opt-in and costs one triangle
        // intersection pass per ray. Terrain blocking is always handled by the
        // authoritative terrain sampler below regardless of this flag.

        // ---------------------------------------------------------------
        // 4. Shared terrain profiles
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

                interiorOpacity:
                    override.interiorOpacity ??
                    options.interiorOpacity,

                showInterior:
                    override.showInterior ??
                    options.showInterior,

                visible: override.visible ?? true
            });
        }

        if (visibleZones.length === 0) {
            return handles;
        }

        // The ground under an azimuth is the same ground whatever elevation ring
        // or zone is looking along it, so the terrain is sampled once per azimuth
        // out to the furthest zone and then reused by every ring of every zone.
        // Sampling per ring per zone (as this used to) cost rings x zones times
        // more for identical data, which is what made fine spacing unaffordable.
        const maxZoneRange = Math.max(...visibleZones.map(zone => zone.range));

        const profileSpacing = rangeSampleSteps
            ? maxZoneRange / Math.max(2, rangeSampleSteps)
            : TERRAIN_SAMPLE_SPACING_M;

        const profiles = await CesiumRadarCoverage.buildTerrainProfiles(
            terrainProvider,
            radarPosition,
            enuMatrix,
            azimuthsDeg,
            maxZoneRange,
            profileSpacing
        );

        const radarHeight = terrainHeight + mastHeight;

        // ---------------------------------------------------------------
        // 5. Build each zone
        // ---------------------------------------------------------------

        for (const zone of visibleZones) {

            const elevationRingsDeg = CesiumRadarCoverage.buildElevationRings(
                zone.minElevationDeg,
                zone.maxElevationDeg,
                elevationRingsPerZone
            );

            // One grid of real ray-hit points (ring x azimuth). Everything below -
            // the fill mesh, the wireframe, the ground footprint, and the optional
            // debug ray overlay - is built from this SAME grid, so they can never
            // disagree with each other again.
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

            const clippedGeometry =
                CesiumRadarCoverage.buildClippedRadarGeometry(
                    grid.points,
                    grid.blocked,
                    azimuthsDeg,
                    isFullCircle
                );

            if (!clippedGeometry) {
                continue;
            }

            const meshPrimitive =
                CesiumRadarCoverage.buildMeshPrimitive(
                    zone,
                    clippedGeometry,
                    entityId
                );

            viewer.scene.primitives.add(meshPrimitive);


            const interiorPrimitive =
                CesiumRadarCoverage.buildInteriorPrimitive(
                    zone,
                    clippedGeometry,
                    entityId
                );

            if (interiorPrimitive) {
                viewer.scene.primitives.add(interiorPrimitive);
            }

            // const wireframePrimitive = CesiumRadarCoverage.buildWireframePrimitive(zone, grid.points, azimuthsDeg, isFullCircle, entityId, radarPosition);
            // if (wireframePrimitive) {
            //     viewer.scene.primitives.add(wireframePrimitive);
            // }





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

                    if (meshPrimitive) {
                        viewer.scene.primitives.remove(meshPrimitive);
                    }

                    if (interiorPrimitive) {
                        viewer.scene.primitives.remove(interiorPrimitive);
                    }

                    if (rayCollection) {
                        viewer.scene.primitives.remove(rayCollection);
                    }
                }
            });
            viewer.scene.requestRender();
        }

        return handles;
    }

    // -------------------------------------------------------------------
    // Terrain profiles: one ground-height profile per azimuth, sampled once
    // and shared by every elevation ring of every zone. All rays down a given
    // azimuth cross the same ground, so this is the whole terrain cost of a
    // rebuild - one batched sampleTerrainMostDetailed call.
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

            // Elevation 0, so distance along this ray IS horizontal distance.
            const groundRay = CesiumRadarCoverage.makeRay(
                radarPosition,
                enuMatrix,
                azimuthDeg,
                0
            );

            for (const distance of horizontalDistances) {
                const point = Cesium.Ray.getPoint(groundRay, distance, scratchPoint);
                flatCartographics.push(Cesium.Cartographic.fromCartesian(point));
            }
        }

        const sampled = await Cesium.sampleTerrainMostDetailed(
            terrainProvider,
            flatCartographics
        );

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
    // Grid sampling: one elevation ring per row, one azimuth per column.
    // Terrain blocking is pure arithmetic against the shared profiles, so
    // the sampling density can be far finer than a per-ray sampler allowed.
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
    ): { points: Cesium.Cartesian3[][]; blocked: boolean[][] } {

        const objectDetector = useObjectPicking
            ? new CesiumObjectDetector(viewer)
            : null;

        const points: Cesium.Cartesian3[][] = [];
        const blocked: boolean[][] = [];

        for (const elevationDeg of elevationRingsDeg) {

            const ringPoints: Cesium.Cartesian3[] = [];
            const ringBlocked: boolean[] = [];

            for (let a = 0; a < azimuthsDeg.length; a++) {

                const ray = CesiumRadarCoverage.makeRay(
                    radarPosition,
                    enuMatrix,
                    azimuthsDeg[a],
                    elevationDeg
                );

                const terrainDistance = CesiumRadarCoverage.terrainBlockDistance(
                    profiles[a],
                    radarHeight,
                    elevationDeg,
                    zone.range
                );

                const objectDistance = objectDetector
                    ? objectDetector.getFirstObjectHit(ray, zone.range)
                    : Number.POSITIVE_INFINITY;

                const distance = Math.min(terrainDistance, objectDistance, zone.range);

                ringPoints.push(
                    Cesium.Ray.getPoint(ray, distance, new Cesium.Cartesian3())
                );

                ringBlocked.push(distance < zone.range - 1e-6);
            }

            points.push(ringPoints);
            blocked.push(ringBlocked);
        }

        return { points, blocked };
    }

    /**
     * Walks one azimuth's ground profile and returns the slant distance at which
     * terrain first cuts the beam, or the zone range if it never does.
     *
     * Ray height is computed analytically rather than by converting a sampled
     * 3D point: height = radar height + horizontal x tan(elevation), minus the
     * earth-curvature drop. That keeps the whole scan to plain arithmetic, which
     * is what makes metre-scale sampling affordable.
     */
    private static terrainBlockDistance(
        profile: TerrainProfile,
        radarHeight: number,
        elevationDeg: number,
        maxRange: number
    ): number {

        const elevation = Cesium.Math.toRadians(elevationDeg);
        const cosElevation = Math.cos(elevation);

        // Pointing (near enough) straight up - nothing can block it.
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

            // Terrain crossed between the last clear sample and this one.
            const drop = previousClearance - clearance;

            const fraction = drop > 0
                ? Cesium.Math.clamp(previousClearance / drop, 0, 1)
                : 0;

            const blockHorizontal =
                previousHorizontal + fraction * (horizontal - previousHorizontal);

            return blockHorizontal / cosElevation;
        }

        return maxRange;
    }

    // -------------------------------------------------------------------
    // Filled coverage mesh: a real triangle mesh through the ring x azimuth
    // grid of ray-hit points, so obstacles at any sampled elevation (not
    // just the top/bottom of the zone) show up as an inward dip exactly
    // where they occur.
    // -------------------------------------------------------------------

    private static buildClippedRadarGeometry(
        points: Cesium.Cartesian3[][],
        blocked: boolean[][],
        azimuthsDeg: number[],
        isFullCircle: boolean
    ): ClippedRadarGeometry | null {

        const ringCount = points.length;
        const azCount = azimuthsDeg.length;

        if (ringCount < 2 || azCount < 2) {
            return null;
        }

        const indexOf = (ring: number, az: number) =>
            ring * azCount + az;

        const positionValues: number[] = [];

        // ---------------------------------------------------------------
        // Original grid vertices
        // ---------------------------------------------------------------

        for (let r = 0; r < ringCount; r++) {
            for (let a = 0; a < azCount; a++) {

                const p = points[r][a];

                positionValues.push(
                    p.x,
                    p.y,
                    p.z
                );
            }
        }

        // ---------------------------------------------------------------
        // Shared terrain-cut vertices
        // ---------------------------------------------------------------

        const edgeVertexCache = new Map<string, number>();

        const addBoundaryVertex = (
            indexA: number,
            indexB: number
        ): number => {

            const minIndex = Math.min(indexA, indexB);
            const maxIndex = Math.max(indexA, indexB);

            const key = `${minIndex}:${maxIndex}`;

            const existing = edgeVertexCache.get(key);

            if (existing !== undefined) {
                return existing;
            }

            const pointA = new Cesium.Cartesian3(
                positionValues[indexA * 3],
                positionValues[indexA * 3 + 1],
                positionValues[indexA * 3 + 2]
            );

            const pointB = new Cesium.Cartesian3(
                positionValues[indexB * 3],
                positionValues[indexB * 3 + 1],
                positionValues[indexB * 3 + 2]
            );

            // Phase 1 terrain boundary approximation.
            const boundaryPoint = Cesium.Cartesian3.lerp(
                pointA,
                pointB,
                0.5,
                new Cesium.Cartesian3()
            );

            const newIndex = positionValues.length / 3;

            positionValues.push(
                boundaryPoint.x,
                boundaryPoint.y,
                boundaryPoint.z
            );

            edgeVertexCache.set(key, newIndex);

            return newIndex;
        };

        const indices: number[] = [];

        const azStepCount =
            isFullCircle
                ? azCount
                : azCount - 1;

        // ---------------------------------------------------------------
        // Terrain-clipped cells
        // ---------------------------------------------------------------

        for (let r = 0; r < ringCount - 1; r++) {

            for (let a = 0; a < azStepCount; a++) {

                const aNext = (a + 1) % azCount;

                const cellIndices = [
                    indexOf(r, a),
                    indexOf(r + 1, a),
                    indexOf(r + 1, aNext),
                    indexOf(r, aNext)
                ];

                const cellBlocked = [
                    blocked[r][a],
                    blocked[r + 1][a],
                    blocked[r + 1][aNext],
                    blocked[r][aNext]
                ];

                // -------------------------------------------------------
                // Entirely blocked
                // -------------------------------------------------------

                if (
                    cellBlocked[0] &&
                    cellBlocked[1] &&
                    cellBlocked[2] &&
                    cellBlocked[3]
                ) {
                    continue;
                }

                // -------------------------------------------------------
                // Entirely visible
                // -------------------------------------------------------

                if (
                    !cellBlocked[0] &&
                    !cellBlocked[1] &&
                    !cellBlocked[2] &&
                    !cellBlocked[3]
                ) {

                    indices.push(
                        cellIndices[0],
                        cellIndices[1],
                        cellIndices[2],

                        cellIndices[0],
                        cellIndices[2],
                        cellIndices[3]
                    );

                    continue;
                }

                // -------------------------------------------------------
                // Mixed cell
                // -------------------------------------------------------

                const polygon: number[] = [];

                for (let edge = 0; edge < 4; edge++) {

                    const nextEdge = (edge + 1) % 4;

                    const currentIndex = cellIndices[edge];
                    const nextIndex = cellIndices[nextEdge];

                    const currentBlocked = cellBlocked[edge];
                    const nextBlocked = cellBlocked[nextEdge];

                    // Keep visible corner.
                    if (!currentBlocked) {
                        polygon.push(currentIndex);
                    }

                    // Terrain boundary.
                    if (currentBlocked !== nextBlocked) {

                        const boundaryIndex =
                            addBoundaryVertex(
                                currentIndex,
                                nextIndex
                            );

                        polygon.push(boundaryIndex);
                    }
                }

                // Remove consecutive duplicates.
                const cleanPolygon: number[] = [];

                for (const index of polygon) {

                    if (
                        cleanPolygon.length === 0 ||
                        cleanPolygon[cleanPolygon.length - 1] !== index
                    ) {
                        cleanPolygon.push(index);
                    }
                }

                if (
                    cleanPolygon.length > 1 &&
                    cleanPolygon[0] ===
                    cleanPolygon[cleanPolygon.length - 1]
                ) {
                    cleanPolygon.pop();
                }

                if (cleanPolygon.length < 3) {
                    continue;
                }

                // Triangulate the clipped polygon.
                for (
                    let i = 1;
                    i < cleanPolygon.length - 1;
                    i++
                ) {

                    indices.push(
                        cleanPolygon[0],
                        cleanPolygon[i],
                        cleanPolygon[i + 1]
                    );
                }
            }
        }

        if (indices.length === 0) {
            return null;
        }

        return {
            positionValues,
            indices
        };
    }
    private static buildMeshPrimitive(
        zone: ResolvedZone,
        geometryData: ClippedRadarGeometry,
        entityId: string
    ): Cesium.Primitive {

        const attributes =
            new Cesium.GeometryAttributes();

        attributes.position =
            new Cesium.GeometryAttribute({

                componentDatatype:
                    Cesium.ComponentDatatype.DOUBLE,

                componentsPerAttribute: 3,

                values:
                    new Float64Array(
                        geometryData.positionValues
                    )
            });

        const geometry =
            new Cesium.Geometry({

                attributes,

                indices:
                    new Uint32Array(
                        geometryData.indices
                    ),

                primitiveType:
                    Cesium.PrimitiveType.TRIANGLES,

                boundingSphere:
                    Cesium.BoundingSphere.fromVertices(
                        geometryData.positionValues
                    )
            });

        const instance =
            new Cesium.GeometryInstance({

                geometry,

                id: entityId,

                attributes: {

                    color:
                        Cesium.ColorGeometryInstanceAttribute.fromColor(
                            zone.color.withAlpha(
                                Cesium.Math.clamp(
                                    zone.beamOpacity ?? 0.28,
                                    0.0,
                                    1.0
                                )
                            )
                        )
                }
            });

        return new Cesium.Primitive({

            geometryInstances:
                instance,

            appearance:
                new Cesium.PerInstanceColorAppearance({

                    flat: true,

                    translucent: true,

                    closed: false
                }),

            asynchronous: false
        });
    }

    private static buildInteriorPrimitive(
        zone: ResolvedZone,
        geometryData: ClippedRadarGeometry,
        entityId: string
    ): Cesium.Primitive | null {

        if (!zone.showInterior) {
            return null;
        }

        const attributes =
            new Cesium.GeometryAttributes();

        attributes.position =
            new Cesium.GeometryAttribute({

                componentDatatype:
                    Cesium.ComponentDatatype.DOUBLE,

                componentsPerAttribute: 3,

                values:
                    new Float64Array(
                        geometryData.positionValues
                    )
            });

        const geometry =
            new Cesium.Geometry({

                attributes,

                indices:
                    new Uint32Array(
                        geometryData.indices
                    ),

                primitiveType:
                    Cesium.PrimitiveType.TRIANGLES,

                boundingSphere:
                    Cesium.BoundingSphere.fromVertices(
                        geometryData.positionValues
                    )
            });

        const instance =
            new Cesium.GeometryInstance({

                geometry,

                id: entityId,

                attributes: {

                    color:
                        Cesium.ColorGeometryInstanceAttribute.fromColor(
                            zone.color.withAlpha(
                                Cesium.Math.clamp(
                                    zone.interiorOpacity,
                                    0.0,
                                    1.0
                                )
                            )
                        )
                }
            });

        return new Cesium.Primitive({

            geometryInstances:
                instance,

            appearance:
                new Cesium.PerInstanceColorAppearance({

                    flat: true,

                    translucent: true,

                    closed: false
                }),

            asynchronous: false
        });
    }
    // -------------------------------------------------------------------
    // Wireframe overlay: circumferential ring lines + radial ribs through
    // the same grid, drawn in an opaque, slightly stronger version of the
    // zone color. This is what makes the terracing (the actual precision
    // you asked for) visually readable even when "Draw 3D Rays" is off.
    // -------------------------------------------------------------------

    private static buildWireframePrimitive(
        zone: ResolvedZone,
        points: Cesium.Cartesian3[][],
        azimuthsDeg: number[],
        isFullCircle: boolean,
        entityId: string,
        radarPosition: Cesium.Cartesian3
    ): Cesium.Primitive | null {

        const ringCount = points.length;
        const azCount = azimuthsDeg.length;

        if (ringCount < 1 || azCount < 2) {
            return null;
        }

        const indexOf = (ring: number, az: number) => ring * azCount + az;

        const positionValues: number[] = [];
        for (let r = 0; r < ringCount; r++) {
            for (let a = 0; a < azCount; a++) {
                const p = points[r][a];
                positionValues.push(p.x, p.y, p.z);
            }
        }

        const indices: number[] = [];
        const azStepCount = isFullCircle ? azCount : azCount - 1;

        // Same rule as the fill mesh: never draw a line across a blockage, so
        // the wireframe ends where the rays end instead of spanning the gap.
        const spansBlockage = (a: Cesium.Cartesian3, b: Cesium.Cartesian3) => {
            const da = Cesium.Cartesian3.distance(radarPosition, a);
            const db = Cesium.Cartesian3.distance(radarPosition, b);
            return Math.max(da, db) > Math.min(da, db) * MAX_NEIGHBOUR_RANGE_RATIO;
        };

        // circumferential ring lines
        for (let r = 0; r < ringCount; r++) {
            for (let a = 0; a < azStepCount; a++) {
                const aNext = (a + 1) % azCount;

                if (spansBlockage(points[r][a], points[r][aNext])) {
                    continue;
                }

                indices.push(indexOf(r, a), indexOf(r, aNext));
            }
        }

        // radial ribs (ring-to-ring, per azimuth)
        for (let a = 0; a < azCount; a++) {
            for (let r = 0; r < ringCount - 1; r++) {

                if (spansBlockage(points[r][a], points[r + 1][a])) {
                    continue;
                }

                indices.push(indexOf(r, a), indexOf(r + 1, a));
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const wireAttributes = new Cesium.GeometryAttributes();
        wireAttributes.position = new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(positionValues)
        });

        const geometry = new Cesium.Geometry({
            attributes: wireAttributes,
            indices: new Uint32Array(indices),
            primitiveType: Cesium.PrimitiveType.LINES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positionValues)
        });

        const instance = new Cesium.GeometryInstance({
            geometry,
            id: { radarParentId: entityId },
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(zone.color.withAlpha(0.85))
            }
        });

        return new Cesium.Primitive({
            geometryInstances: instance,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                renderState: {
                    lineWidth: 1,
                    depthTest: { enabled: true }
                }
            }),
            asynchronous: false
        });
    }

    // -------------------------------------------------------------------
    // Ground footprint: a shaded fill on the ground (same color as the
    // wall, lower alpha) so the coverage area reads clearly from a
    // top-down / low-zoom view too.
    // -------------------------------------------------------------------


    // -------------------------------------------------------------------
    // Optional debug ray overlay (toggle: "Draw 3D Rays"). Reuses the same
    // grid as the wall/mesh so the rays land exactly on the wall surface
    // instead of a separately-sampled (and therefore misaligned) fan.
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

        for (let r = 0; r < elevationRingsDeg.length; r++) {

            for (let a = 0; a < azimuthsDeg.length; a++) {

                collection.add({
                    positions: [
                        radarPosition,
                        points[r][a]
                    ],
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