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
    cylinderOpacity?: number;
    showCylinders?: boolean;
    interiorLayers?: number;
    showBlockedPoints?: boolean;
    shadowOpacity?: number;
    showShadow?: boolean;
    bandOpacity?: number;
    showBand?: boolean;
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

export interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    maxElevationDeg: number;
    azimuthStartDeg: number;
    azimuthWidthDeg: number;
}

interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
    groundPoints: Cesium.Cartographic[];
}

// Line-of-sight result along one azimuth, one entry per terrain sample.
interface Viewshed {
    // 1 if the ground at this sample can be seen from the antenna, 0 if it is in radar shadow.
    visible: Uint8Array;
    // Elevation angle (radians) from the antenna up/down to the ground at this sample.
    angle: Float32Array;
}

interface Fan {
    azimuthsDeg: number[];
    startDeg: number;
    widthDeg: number;
    spacing: number;
    maxRange: number;
    profiles: TerrainProfile[];
    viewsheds: Viewshed[];
    // Lowest height (above the ellipsoid) the radar can see over each sample.
    floors: Float64Array[];
}

// Settings that only change how the coverage looks. Applied in place through
// RadarCoverageHandle.setStyle, without re-sampling terrain or rebuilding.
export interface RadarStyle {
    beamOpacity: number;
    interiorOpacity: number;
    showInterior: boolean;
    cylinderOpacity: number;
    showCylinders: boolean;
    shadowOpacity: number;
    showShadow: boolean;
    bandOpacity: number;
    showBand: boolean;
}

export interface RadarCoverageHandle {
    dispose(): void;
    setStyle?(style: RadarStyle): void;
}

// What a built radar needs to answer "can it see this point, and if not, why?".
// Kept per radar entity for the click-to-explain probe (see CesiumLosProbe).
export interface RadarGeometry {
    radarPosition: Cesium.Cartesian3;
    radarHeight: number;
    enuMatrix: Cesium.Matrix4;
    zones: ResolvedZone[];
}


// =============================================================================
// CesiumRadarCoverage (Terrain Line-of-Sight Coverage / Radar Shadow Map)
// =============================================================================

// World terrain is ~30 m detail in most mountain areas; sampling finer than
// this costs time without adding real accuracy.
const TERRAIN_SAMPLE_SPACING_M = 10;
// Terrain profiles kept from earlier builds (most recent last).
const PROFILE_CACHE_SIZE = 8;
const EARTH_RADIUS_M = 6371000;
// Standard radar "4/3 Earth" model: the atmosphere bends the beam slightly
// downward, so it reaches as if the Earth were 4/3 larger (flatter).
const EFFECTIVE_EARTH_RADIUS_M = EARTH_RADIUS_M * 4 / 3;
const BLOCKED_POINT_ALWAYS_VISIBLE_M = 3000;
// A ridge only gets a marker if the shadow behind it is at least this long,
// so small bumps in the terrain do not litter the map with dots.
const MIN_SHADOW_LENGTH_M = 100;
// Ground closer than this to the antenna never blocks it (the antenna's own footing).
const NEAR_FIELD_IGNORE_M = 10;
// Terrain only blocks a point if it rises more than this above the straight
// line from the antenna to that point. A smaller rise is terrain-data noise
// (e.g. a 1 m bump right next to a radar standing on the ground) and the beam
// is taken to reach the point.
const RIDGE_TOLERANCE_M = 2;
// Largest side of the shading texture, in pixels.
const COVERAGE_TEXTURE_MAX_PX = 2048;
// Colour of ground in range that the radar does not cover (hidden behind
// terrain, or above every zone's top angle). Faded by the Shadow Opacity setting.
const SHADOW_FILL_RGBA = [0, 0, 0, 255];
// The panel's "Interior Beam" slider runs 0 - 0.30; that span maps to the
// range rings' full 0 - 1 opacity.
const INTERIOR_SLIDER_MAX = 0.3;
// Air layer over dark ground: at most this many vertices along each ray.
const AIR_LAYER_MAX_COLUMNS = 300;
// The air layer never sits lower than this above the highest ground around
// each of its points (including the ground between neighbouring rays), so it
// drapes over the terrain's shape without hills poking through it.
const AIR_LAYER_MIN_LIFT_M = 20;

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

    // Geometry of every built radar, keyed by entity id.
    private static readonly geometries = new Map<string, RadarGeometry>();

    static getGeometry(entityId: string): RadarGeometry | undefined {
        return CesiumRadarCoverage.geometries.get(entityId);
    }

    static radarIds(): string[] {
        return Array.from(CesiumRadarCoverage.geometries.keys());
    }

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
            showBlockedPoints = false,
            interiorOpacity = 0.08,
            showInterior = true,
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
        // Clicking the radar itself always selects it, even with the LOS probe on.
        (marker as any).isRadarMarker = true;
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // Resolve Zones, nearest first so an inner zone's colour wins where zones overlap.
        const zones: ResolvedZone[] = [];
        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
            const override = zoneOverrides[zoneConfig.name] ?? {};
            if (!(override.visible ?? true)) continue;

            zones.push({
                name: zoneConfig.name,
                color: zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                maxElevationDeg: override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg,
                azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
            });
        }
        zones.sort((z1, z2) => z1.range - z2.range);

        if (zones.length === 0) return handles;

        const geometry: RadarGeometry = { radarPosition, radarHeight, enuMatrix, zones };
        CesiumRadarCoverage.geometries.set(entityId, geometry);
        handles.push({
            dispose: () => {
                // A newer build of the same radar may already have replaced it.
                if (CesiumRadarCoverage.geometries.get(entityId) === geometry) {
                    CesiumRadarCoverage.geometries.delete(entityId);
                }
            }
        });

        // A terrain profile depends only on the azimuth fan and how far out we walk it.
        // Sample each distinct fan once, out to the largest range any zone on it needs.
        const fanGroups = new Map<string, { maxRange: number; spacing: number }>();
        for (const zone of zones) {
            const key = `${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`;
            const spacing = rangeSampleSteps
                ? zone.range / Math.max(2, rangeSampleSteps)
                : TERRAIN_SAMPLE_SPACING_M;

            const group = fanGroups.get(key);
            if (group) {
                group.maxRange = Math.max(group.maxRange, zone.range);
                group.spacing = Math.min(group.spacing, spacing);
            } else {
                fanGroups.set(key, { maxRange: zone.range, spacing });
            }
        }

        const fans = new Map<string, Fan>();
        for (const [key, group] of fanGroups) {
            const [startDeg, widthDeg] = key.split("|").map(Number);
            const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(startDeg, widthDeg, azimuthStepDeg);
            const profiles = await CesiumRadarCoverage.getTerrainProfiles(
                terrainProvider,
                `${longitude}|${latitude}|${key}|${azimuthStepDeg}|${group.spacing}`,
                radarPosition,
                enuMatrix,
                azimuthsDeg,
                group.maxRange,
                group.spacing
            );
            fans.set(key, {
                azimuthsDeg,
                startDeg,
                widthDeg,
                spacing: group.spacing,
                maxRange: group.maxRange,
                profiles,
                viewsheds: profiles.map(profile => CesiumRadarCoverage.computeViewshed(profile, radarHeight)),
                floors: profiles.map(profile => CesiumRadarCoverage.computeFloor(profile, radarHeight))
            });
        }

        // Paint the coverage onto the terrain: zone colour where the antenna can
        // see the ground, dark everywhere else in range (hidden by a hill, or
        // above the zone's top angle).
        // The lit and shadow layers are baked fully opaque and faded by their
        // material colour, so the opacity sliders only change a uniform - no rebuild.
        const style: RadarStyle = {
            beamOpacity: options.beamOpacity ?? 0.35,
            interiorOpacity,
            showInterior,
            cylinderOpacity: options.cylinderOpacity ?? 0.15,
            showCylinders: options.showCylinders ?? true,
            shadowOpacity: options.shadowOpacity ?? 0.6,
            showShadow: options.showShadow ?? true,
            bandOpacity: options.bandOpacity ?? 0.3,
            showBand: options.showBand ?? true
        };
        let litColor = Cesium.Color.WHITE.withAlpha(style.beamOpacity);
        const shadowColorOf = (st: RadarStyle) => Cesium.Color.WHITE.withAlpha(st.showShadow ? st.shadowOpacity : 0);
        let shadowColor = shadowColorOf(style);

        const ringOpacityOf = (st: RadarStyle) => Cesium.Math.clamp(st.interiorOpacity / INTERIOR_SLIDER_MAX, 0, 1);
        let ringColors = zones.map(zone => zone.color.withAlpha(ringOpacityOf(style)));

        const maxRange = Math.max(...zones.map(z => z.range));
        const coverage = CesiumRadarCoverage.buildCoverageTexture(longitude, latitude, maxRange, zones, fans);

        const addGroundImage = (canvas: HTMLCanvasElement, color?: Cesium.Property) => {
            const e = viewer.entities.add({
                rectangle: {
                    coordinates: coverage.rectangle,
                    material: new Cesium.ImageMaterialProperty({ image: canvas, transparent: true, color }),
                    classificationType: Cesium.ClassificationType.TERRAIN
                }
            });
            (e as any).radarParentId = entityId;
            handles.push({ dispose: () => viewer.entities.remove(e) });
        };
        addGroundImage(coverage.shadowCanvas, new Cesium.CallbackProperty(() => shadowColor, false));
        addGroundImage(coverage.litCanvas, new Cesium.CallbackProperty(() => litColor, false));

        // Range ring of every zone, in its own colour, draped on the terrain.
        // Shown/hidden and faded by the panel's "Interior Beam" controls.
        const rings = zones.map((zone, z) => {
            const ring = viewer.entities.add({
                show: style.showInterior && ringOpacityOf(style) > 0,
                polyline: {
                    positions: CesiumRadarCoverage.buildRangeRing(enuMatrix, radarPosition, zone),
                    width: 3,
                    material: new Cesium.ColorMaterialProperty(
                        new Cesium.CallbackProperty(() => ringColors[z], false)
                    ),
                    clampToGround: true
                }
            });
            (ring as any).radarParentId = entityId;
            return ring;
        });

        // Coverage wall of every zone (one per zone): a plain surface around the
        // zone's range (closed back to the radar for a sector), standing on the
        // terrain and reaching up to the height the zone's top-angle beam has at
        // that distance. Drawn flat (unlit, no outline) so it is one even shade
        // all round. Faded by "Zone Cylinders".
        const wallRings = await Promise.all(zones.map(async zone => {
            const positions = CesiumRadarCoverage.buildRangeRing(enuMatrix, radarPosition, zone);
            const ground = await Cesium.sampleTerrainMostDetailed(
                terrainProvider,
                positions.map(p => Cesium.Cartographic.fromCartesian(p))
            );
            const topTan = Math.tan(Cesium.Math.toRadians(zone.maxElevationDeg));
            const minimumHeights = ground.map(g => g.height ?? terrainHeight);
            const maximumHeights = positions.map((p, k) => {
                const dist = Cesium.Cartesian3.equals(p, radarPosition) ? 0 : zone.range;
                const top = CesiumRadarCoverage.beamHeightAt(Math.atan(topTan), dist, radarHeight);
                return Math.max(top, minimumHeights[k] + 1);
            });
            return { positions, minimumHeights, maximumHeights };
        }));
        const cylinders = zones.map((zone, z) => {
            const { positions, minimumHeights, maximumHeights } = wallRings[z];
            const primitive = viewer.scene.primitives.add(new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                    id: `radar-wall-${entityId}-${z}`,
                    geometry: new Cesium.WallGeometry({ positions, minimumHeights, maximumHeights }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(zone.color.withAlpha(style.cylinderOpacity))
                    }
                }),
                appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
                asynchronous: false
            })) as Cesium.Primitive;
            primitive.show = style.showCylinders && style.cylinderOpacity > 0;
            return primitive;
        });
        const setInstanceColor = (primitive: Cesium.Primitive, id: string, cesiumColor: Cesium.Color) => {
            const color = Cesium.ColorGeometryInstanceAttribute.toValue(cesiumColor);
            try {
                primitive.getGeometryInstanceAttributes(id).color = color;
            } catch {
                // Not drawn yet: apply the colour after the next frame.
                const remove = viewer.scene.postRender.addEventListener(() => {
                    remove();
                    if (primitive.isDestroyed()) return;
                    primitive.getGeometryInstanceAttributes(id).color = color;
                    viewer.scene.requestRender();
                });
            }
        };
        const setCylinderStyle = (st: RadarStyle) => {
            cylinders.forEach((primitive, z) => {
                primitive.show = st.showCylinders && st.cylinderOpacity > 0;
                setInstanceColor(primitive, `radar-wall-${entityId}-${z}`, zones[z].color.withAlpha(st.cylinderOpacity));
            });
        };

        // Air layer: over ground the radar cannot see (dark), a see-through
        // surface in the zone's colour at the lowest height the radar does see.
        // Aircraft above it are detected. Geometry is worked out once; opacity
        // changes only rebuild the cheap primitive from it.
        const airLayers = Array.from(fans.entries())
            .map(([key, fan]) => CesiumRadarCoverage.buildAirLayer(
                fan,
                zones.filter(z => `${z.azimuthStartDeg}|${z.azimuthWidthDeg}` === key),
                radarHeight
            ))
            .filter(layer => layer !== null);
        let airPrimitives: Cesium.Primitive[] = [];
        let airKey = "";
        const drawAirLayer = (st: RadarStyle) => {
            const key = `${st.showBand}|${st.bandOpacity}`;
            if (key === airKey) return;
            airKey = key;
            for (const p of airPrimitives) viewer.scene.primitives.remove(p);
            airPrimitives = [];
            if (!st.showBand || st.bandOpacity <= 0) return;
            for (const layer of airLayers) {
                airPrimitives.push(viewer.scene.primitives.add(layer.toPrimitive(st.bandOpacity)));
            }
        };
        drawAirLayer(style);

        handles.push({
            dispose: () => {
                for (const p of airPrimitives) viewer.scene.primitives.remove(p);
                for (const ring of rings) viewer.entities.remove(ring);
                for (const cylinder of cylinders) viewer.scene.primitives.remove(cylinder);
            },
            setStyle: (st: RadarStyle) => {
                litColor = Cesium.Color.WHITE.withAlpha(st.beamOpacity);
                shadowColor = shadowColorOf(st);
                drawAirLayer(st);
                const ringOpacity = ringOpacityOf(st);
                ringColors = zones.map(zone => zone.color.withAlpha(ringOpacity));
                for (const ring of rings) ring.show = st.showInterior && ringOpacity > 0;
                setCylinderStyle(st);
                viewer.scene.requestRender();
            }
        });

        if (showBlockedPoints) {
            // One marker on each ridge that casts a radar shadow behind it.
            const pointEntities: Cesium.Entity[] = [];
            viewer.entities.suspendEvents();
            for (const fan of fans.values()) {
                fan.viewsheds.forEach((viewshed, a) => {
                    const profile = fan.profiles[a];
                    for (const i of CesiumRadarCoverage.findShadowCastingRidges(profile, viewshed)) {
                        const dist = profile.horizontalDistances[i];
                        if (dist > fan.maxRange) break;
                        const zone = zones.find(z => dist <= z.range) ?? zones[zones.length - 1];
                        const ground = profile.groundPoints[i];
                        const pointEntity = viewer.entities.add({
                            position: Cesium.Cartesian3.fromRadians(ground.longitude, ground.latitude, 10),
                            point: {
                                pixelSize: 8,
                                color: zone.color,
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
                });
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
    // 3a. Terrain Profile Cache: getTerrainProfiles
    // -------------------------------------------------------------------
    // Sampling terrain is by far the slowest step, and the ground does not change
    // when only the mast height, zone angles, zone visibility or a shorter range
    // change. Profiles are therefore kept per radar spot + fan, and reused when
    // they already reach far enough.
    private static readonly profileCache = new Map<string, { maxRange: number; profiles: TerrainProfile[] }>();

    private static async getTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        cacheKey: string,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number,
        spacing: number
    ): Promise<TerrainProfile[]> {
        const cache = CesiumRadarCoverage.profileCache;
        const hit = cache.get(cacheKey);
        if (hit && hit.maxRange >= maxRange) {
            cache.delete(cacheKey);
            cache.set(cacheKey, hit);
            return hit.profiles;
        }

        const profiles = await CesiumRadarCoverage.buildTerrainProfiles(
            terrainProvider, radarPosition, enuMatrix, azimuthsDeg, maxRange, spacing
        );
        cache.delete(cacheKey);
        cache.set(cacheKey, { maxRange, profiles });
        while (cache.size > PROFILE_CACHE_SIZE) {
            cache.delete(cache.keys().next().value!);
        }
        return profiles;
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
    // 4b. Range Ring Outline: buildRangeRing
    // -------------------------------------------------------------------
    // A circle at the zone's range. For a sector (< 360 deg) it is the arc plus
    // the two edge lines back to the radar, so the wedge outline is closed.
    private static buildRangeRing(
        enuMatrix: Cesium.Matrix4,
        radarPosition: Cesium.Cartesian3,
        zone: ResolvedZone
    ): Cesium.Cartesian3[] {
        const width = Cesium.Math.clamp(zone.azimuthWidthDeg, 1, 360);
        const fullCircle = width >= 360;
        const steps = Math.max(8, Math.ceil(width));
        const points: Cesium.Cartesian3[] = [];

        if (!fullCircle) points.push(radarPosition);
        for (let i = 0; i <= steps; i++) {
            const az = Cesium.Math.toRadians(zone.azimuthStartDeg + (width * i) / steps);
            const local = new Cesium.Cartesian3(Math.sin(az) * zone.range, Math.cos(az) * zone.range, 0);
            points.push(Cesium.Matrix4.multiplyByPoint(enuMatrix, local, new Cesium.Cartesian3()));
        }
        if (!fullCircle) points.push(radarPosition);
        return points;
    }

    // -------------------------------------------------------------------
    // 5. Line-of-Sight Along One Azimuth: computeViewshed
    // -------------------------------------------------------------------
    // Walking outward, a ground point is visible if the angle from the antenna
    // down/up to it is at least as high as the angle to every point before it.
    // Anything lower is hidden behind something nearer: radar shadow.
    private static computeViewshed(profile: TerrainProfile, radarHeight: number): Viewshed {
        const { horizontalDistances, groundHeights } = profile;
        const n = horizontalDistances.length;
        const visible = new Uint8Array(n);
        const angle = new Float32Array(n);

        visible[0] = 1;
        angle[0] = -Math.PI / 2;
        // Highest "effective horizon" so far: see horizonTan.
        let horizon = -Infinity;

        for (let i = 1; i < n; i++) {
            // The ground curves away below a straight beam (4/3 Earth model).
            const a = CesiumRadarCoverage.elevationAngle(groundHeights[i], horizontalDistances[i], radarHeight);

            angle[i] = a;
            if (horizontalDistances[i] < NEAR_FIELD_IGNORE_M) {
                visible[i] = 1;
                continue;
            }
            visible[i] = Math.tan(a) >= horizon ? 1 : 0;
            horizon = Math.max(horizon, CesiumRadarCoverage.horizonTan(a, horizontalDistances[i]));
        }
        return { visible, angle };
    }

    // -------------------------------------------------------------------
    // 5b. Lowest Visible Height Along One Azimuth: computeFloor
    // -------------------------------------------------------------------
    // Same walk as computeViewshed. Over each sample, the lowest height the
    // radar can see is the higher of the ground and the lowest line from the
    // antenna that clears all terrain before it. On visible ground that is the
    // ground itself; in radar shadow it is up in the air.
    private static computeFloor(profile: TerrainProfile, radarHeight: number): Float64Array {
        const { horizontalDistances, groundHeights } = profile;
        const n = horizontalDistances.length;
        const floor = new Float64Array(n);
        floor[0] = groundHeights[0];
        let horizon = -Infinity;

        for (let i = 1; i < n; i++) {
            const d = horizontalDistances[i];
            const line = horizon === -Infinity
                ? -Infinity
                : CesiumRadarCoverage.beamHeightAt(Math.atan(horizon), d, radarHeight);
            floor[i] = Math.max(groundHeights[i], line);

            if (d < NEAR_FIELD_IGNORE_M) continue;
            const a = CesiumRadarCoverage.elevationAngle(groundHeights[i], d, radarHeight);
            horizon = Math.max(horizon, CesiumRadarCoverage.horizonTan(a, d));
        }
        return floor;
    }

    // -------------------------------------------------------------------
    // 5c. Air Layer Over Dark Ground: buildAirLayer
    // -------------------------------------------------------------------
    // A mesh over the fan: one row of vertices per azimuth, one column per
    // (thinned) range sample. A vertex is "on" where the ground is dark (not
    // seen by any zone) but some zone's beam covers air above it: it sits at
    // the lowest seen height (computeFloor) and takes the colour of the first
    // zone, nearest first, whose top line is above that height. Each vertex's
    // opacity is the share of "on" vertices around it, so the layer fades out
    // softly at its edges instead of ending in steps.
    private static buildAirLayer(
        fan: Fan,
        zones: ResolvedZone[],
        radarHeight: number
    ): { toPrimitive(opacity: number): Cesium.Primitive } | null {
        if (zones.length === 0) return null;
        const rows = fan.profiles.length;
        const n = fan.profiles[0].horizontalDistances.length;
        const step = Math.max(1, Math.ceil(n / AIR_LAYER_MAX_COLUMNS));
        const columns: number[] = [];
        for (let i = 0; i < n; i += step) columns.push(i);
        if (columns[columns.length - 1] !== n - 1) columns.push(n - 1);
        const cols = columns.length;
        const vertexCount = rows * cols;
        const wrap = fan.widthDeg >= 360;

        const zoneTan = zones.map(z => Math.tan(Cesium.Math.toRadians(z.maxElevationDeg)));
        const zoneRgb = zones.map(z => [
            Math.round(z.color.red * 255),
            Math.round(z.color.green * 255),
            Math.round(z.color.blue * 255)
        ]);

        const on = new Uint8Array(vertexCount);
        const heights = new Float64Array(vertexCount);
        const rgb = new Uint8Array(vertexCount * 3);

        fan.profiles.forEach((profile, r) => {
            const floor = fan.floors[r];
            const viewshed = fan.viewsheds[r];
            columns.forEach((i, c) => {
                const v = r * cols + c;
                const d = profile.horizontalDistances[i];
                const ground = profile.groundHeights[i];
                heights[v] = floor[i];
                if (d <= 0) return;

                const lit = viewshed.visible[i] === 1 && zones.some(z =>
                    d <= z.range && viewshed.angle[i] <= Cesium.Math.toRadians(z.maxElevationDeg));
                if (lit) return;

                const z = zones.findIndex((zone, k) =>
                    d <= zone.range && floor[i] < CesiumRadarCoverage.beamHeightAt(Math.atan(zoneTan[k]), d, radarHeight));
                if (z < 0) return;
                on[v] = 1;
                rgb.set(zoneRgb[z], v * 3);
            });
        });

        // Lift every vertex clear of the highest ground in the cells around it:
        // the neighbouring rays, and every full-resolution sample between this
        // column and the next ones.
        fan.profiles.forEach((profile, r) => {
            columns.forEach((i, c) => {
                let highest = -Infinity;
                for (let dr = -1; dr <= 1; dr++) {
                    let rr = r + dr;
                    if (wrap) rr = (rr + rows) % rows;
                    if (rr < 0 || rr >= rows) continue;
                    const ground = fan.profiles[rr].groundHeights;
                    const from = Math.max(0, i - step);
                    const to = Math.min(n - 1, i + step);
                    for (let k = from; k <= to; k++) highest = Math.max(highest, ground[k]);
                }
                const v = r * cols + c;
                heights[v] = Math.max(heights[v], highest + AIR_LAYER_MIN_LIFT_M);
            });
        });

        // Soft edges: opacity = share of "on" vertices in the 3 x 3 block around.
        // Off vertices next to the layer borrow a neighbour's colour to fade in.
        const fade = new Float32Array(vertexCount);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let count = 0;
                let total = 0;
                let donor = -1;
                for (let dr = -1; dr <= 1; dr++) {
                    let rr = r + dr;
                    if (wrap) rr = (rr + rows) % rows;
                    if (rr < 0 || rr >= rows) continue;
                    for (let dc = -1; dc <= 1; dc++) {
                        const cc = c + dc;
                        if (cc < 0 || cc >= cols) continue;
                        total++;
                        if (on[rr * cols + cc]) {
                            count++;
                            donor = rr * cols + cc;
                        }
                    }
                }
                const v = r * cols + c;
                fade[v] = total ? count / total : 0;
                if (!on[v] && donor >= 0) rgb.copyWithin(v * 3, donor * 3, donor * 3 + 3);
            }
        }

        const positions = new Float64Array(vertexCount * 3);
        const scratch = new Cesium.Cartesian3();
        fan.profiles.forEach((profile, r) => {
            columns.forEach((i, c) => {
                const v = r * cols + c;
                const p = profile.groundPoints[i];
                Cesium.Cartesian3.fromRadians(p.longitude, p.latitude, heights[v], undefined, scratch);
                positions[v * 3] = scratch.x;
                positions[v * 3 + 1] = scratch.y;
                positions[v * 3 + 2] = scratch.z;
            });
        });

        // Two triangles per cell that has any "on" corner.
        const indexList: number[] = [];
        for (let r = 0; r < (wrap ? rows : rows - 1); r++) {
            const r2 = (r + 1) % rows;
            for (let c = 0; c < cols - 1; c++) {
                const a = r * cols + c, b = a + 1, e = r2 * cols + c, f = e + 1;
                if (!(on[a] || on[b] || on[e] || on[f])) continue;
                indexList.push(a, b, e, b, f, e);
            }
        }
        if (indexList.length === 0) return null;
        const indices = new Uint32Array(indexList);
        const boundingSphere = Cesium.BoundingSphere.fromVertices(positions as unknown as number[]);

        return {
            toPrimitive(opacity: number): Cesium.Primitive {
                const alpha = Cesium.Math.clamp(opacity, 0, 1) * 255;
                const colors = new Uint8Array(vertexCount * 4);
                for (let v = 0; v < vertexCount; v++) {
                    colors[v * 4] = rgb[v * 3];
                    colors[v * 4 + 1] = rgb[v * 3 + 1];
                    colors[v * 4 + 2] = rgb[v * 3 + 2];
                    colors[v * 4 + 3] = Math.round(alpha * fade[v]);
                }
                const geometry = new Cesium.Geometry({
                    attributes: {
                        position: new Cesium.GeometryAttribute({
                            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                            componentsPerAttribute: 3,
                            values: positions
                        }),
                        // Per-vertex colour, read by PerInstanceColorAppearance's "color" input.
                        color: new Cesium.GeometryAttribute({
                            componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
                            componentsPerAttribute: 4,
                            normalize: true,
                            values: colors
                        })
                    } as any,
                    indices,
                    primitiveType: Cesium.PrimitiveType.TRIANGLES,
                    boundingSphere
                });
                return new Cesium.Primitive({
                    geometryInstances: new Cesium.GeometryInstance({ geometry }),
                    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
                    asynchronous: false
                });
            }
        };
    }

    // -------------------------------------------------------------------
    // 6. Ridge Finder: findShadowCastingRidges
    // -------------------------------------------------------------------
    // Returns the sample index of the last visible point before each shadow that
    // is at least MIN_SHADOW_LENGTH_M long: the ridge top the beam grazes.
    private static findShadowCastingRidges(profile: TerrainProfile, viewshed: Viewshed): number[] {
        const { visible } = viewshed;
        const dists = profile.horizontalDistances;
        const ridges: number[] = [];

        for (let i = 0; i < visible.length - 1; i++) {
            if (!visible[i] || visible[i + 1]) continue;

            let j = i + 1;
            while (j < visible.length && !visible[j]) j++;
            const shadowEnd = dists[Math.min(j, visible.length - 1)];
            if (shadowEnd - dists[i] >= MIN_SHADOW_LENGTH_M) ridges.push(i);
            i = j - 1;
        }
        return ridges;
    }

    // -------------------------------------------------------------------
    // 7. Ground Shading Texture: buildCoverageTexture
    // -------------------------------------------------------------------
    // A top-down image centred on the radar, draped on the terrain. Each pixel
    // looks up its azimuth and distance in the viewsheds:
    //   - first zone (nearest) whose range reaches it, whose sector contains it,
    //     that can see it and for which it is not above the zone's top angle
    //     -> that zone's colour
    //   - in range but not covered (hidden behind terrain, or above the zone's
    //     top angle) -> dark
    //   - out of every zone's range -> left transparent
    // Each layer is its own image, faded at draw time by its opacity setting.
    // Pixels are blended from the four nearest samples (two azimuths x two
    // distances), so edges fade smoothly instead of stepping.
    private static buildCoverageTexture(
        longitude: number,
        latitude: number,
        maxRange: number,
        zones: ResolvedZone[],
        fans: Map<string, Fan>
    ): {
        litCanvas: HTMLCanvasElement;
        shadowCanvas: HTMLCanvasElement;
        rectangle: Cesium.Rectangle;
    } {
        // WGS84 metres per degree at this latitude. A flat 111320 m/deg would put
        // the shading up to ~0.5% of the range away from where the profiles and
        // range rings were measured.
        const phi = Cesium.Math.toRadians(latitude);
        const metersPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
        const metersPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
        const rectangle = Cesium.Rectangle.fromDegrees(
            longitude - maxRange / metersPerDegLon,
            latitude - maxRange / metersPerDegLat,
            longitude + maxRange / metersPerDegLon,
            latitude + maxRange / metersPerDegLat
        );

        const size = Math.min(COVERAGE_TEXTURE_MAX_PX, Math.ceil((2 * maxRange) / TERRAIN_SAMPLE_SPACING_M));
        const metersPerPixel = (2 * maxRange) / size;

        const makeLayer = () => {
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d")!;
            return { canvas, ctx, image: ctx.createImageData(size, size) };
        };
        const lit = makeLayer();
        const shadow = makeLayer();
        const litPx = lit.image.data;
        const shadowPx = shadow.image.data;


        const zoneStyles = zones.map(zone => ({
            zone,
            fan: fans.get(`${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`)!,
            maxAngle: Cesium.Math.toRadians(zone.maxElevationDeg),
            rgba: [
                Math.round(zone.color.red * 255),
                Math.round(zone.color.green * 255),
                Math.round(zone.color.blue * 255),
                255
            ]
        }));

        for (let y = 0; y < size; y++) {
            // Row 0 is the north edge of the rectangle.
            const north = maxRange - (y + 0.5) * metersPerPixel;
            for (let x = 0; x < size; x++) {
                const east = (x + 0.5) * metersPerPixel - maxRange;
                const dist = Math.hypot(east, north);
                if (dist > maxRange) continue;

                const azimuthDeg = (Cesium.Math.toDegrees(Math.atan2(east, north)) + 360) % 360;
                // How much of this pixel is lit ground, and by which zone.
                let litAmount = 0;
                let litRgba: number[] | null = null;
                let inRange = false;

                for (const style of zoneStyles) {
                    if (dist > style.zone.range) continue;
                    const lit = CesiumRadarCoverage.sampleLit(style.fan, azimuthDeg, dist, style.maxAngle);
                    if (lit === null) continue;
                    inRange = true;
                    // Nearest zone wins ties (zones are sorted nearest first).
                    if (lit > litAmount) {
                        litAmount = lit;
                        litRgba = style.rgba;
                    }
                }
                if (!inRange) continue;

                const o = (y * size + x) * 4;
                const put = (px: Uint8ClampedArray, rgba: number[], amount: number) => {
                    px[o] = rgba[0];
                    px[o + 1] = rgba[1];
                    px[o + 2] = rgba[2];
                    px[o + 3] = Math.round(amount * 255);
                };
                const unlit = 1 - litAmount;
                if (litRgba) put(litPx, litRgba, litAmount);
                put(shadowPx, SHADOW_FILL_RGBA, unlit);
            }
        }

        lit.ctx.putImageData(lit.image, 0, 0);
        shadow.ctx.putImageData(shadow.image, 0, 0);
        return { litCanvas: lit.canvas, shadowCanvas: shadow.canvas, rectangle };
    }

    // How much (0 - 1) the ground at this azimuth/distance is seen by one zone
    // (visible and not above its top angle). Blended from the two neighbouring
    // azimuths and two neighbouring range samples, so edges fade smoothly.
    // Returns null when outside the fan's sector.
    private static sampleLit(fan: Fan, azimuthDeg: number, dist: number, maxAngle: number): number | null {
        const count = fan.azimuthsDeg.length;
        const fullCircle = fan.widthDeg >= 360;
        const rel = (((azimuthDeg - fan.startDeg) % 360) + 360) % 360;
        if (!fullCircle && rel > fan.widthDeg) return null;

        const pos = fullCircle ? rel / (360 / count) : rel / (fan.widthDeg / (count - 1));
        const a0 = Math.floor(pos) % count;
        const a1 = fullCircle ? (a0 + 1) % count : Math.min(a0 + 1, count - 1);
        const w = pos - Math.floor(pos);

        const last = fan.profiles[0].horizontalDistances.length - 1;
        const fi = Math.min(dist / fan.spacing, last);
        const i0 = Math.floor(fi);
        const i1 = Math.min(i0 + 1, last);
        const u = fi - i0;
        const lit = (a: number, i: number) => {
            const v = fan.viewsheds[a];
            return v.visible[i] && v.angle[i] <= maxAngle ? 1 : 0;
        };
        return (1 - w) * ((1 - u) * lit(a0, i0) + u * lit(a0, i1)) +
            w * ((1 - u) * lit(a1, i0) + u * lit(a1, i1));
    }

    // -------------------------------------------------------------------
    // 8. Shared line-of-sight maths (also used by CesiumLosProbe)
    // -------------------------------------------------------------------
    static readonly NEAR_FIELD_IGNORE_M = NEAR_FIELD_IGNORE_M;

    // Slope (tan of the elevation angle) of the lowest line from the antenna
    // that passes no more than RIDGE_TOLERANCE_M below the terrain seen at
    // `angle`, `dist` away. A point further out is hidden by that terrain
    // exactly when its own tan(angle) is below this value.
    static horizonTan(angle: number, dist: number): number {
        return Math.tan(angle) - RIDGE_TOLERANCE_M / dist;
    }

    // Elevation angle from the antenna to ground at this height and distance,
    // with the 4/3-Earth curvature drop applied.
    static elevationAngle(groundHeight: number, dist: number, radarHeight: number): number {
        const curvatureDrop = (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
        return Math.atan2(groundHeight - curvatureDrop - radarHeight, dist);
    }

    // Height above the ellipsoid of a straight beam leaving the antenna at this
    // elevation angle, after this horizontal distance (inverse of elevationAngle).
    static beamHeightAt(angle: number, dist: number, radarHeight: number): number {
        return radarHeight + dist * Math.tan(angle) + (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
    }

    // Ground point at this azimuth and horizontal distance from the radar.
    static groundPointAt(geometry: RadarGeometry, azimuthDeg: number, dist: number): Cesium.Cartographic {
        const ray = CesiumRadarCoverage.makeRay(geometry.radarPosition, geometry.enuMatrix, azimuthDeg, 0);
        return Cesium.Cartographic.fromCartesian(Cesium.Ray.getPoint(ray, dist));
    }
}
