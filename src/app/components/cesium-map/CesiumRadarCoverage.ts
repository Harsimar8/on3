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
}

// Settings that only change how the coverage looks. Applied in place through
// RadarCoverageHandle.setStyle, without re-sampling terrain or rebuilding.
export interface RadarStyle {
    beamOpacity: number;
    interiorOpacity: number;
    showInterior: boolean;
    cylinderOpacity: number;
    showCylinders: boolean;
}

export interface RadarCoverageHandle {
    dispose(): void;
    setStyle?(style: RadarStyle): void;
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
// Largest side of the shading texture, in pixels.
const COVERAGE_TEXTURE_MAX_PX = 2048;
// Opacity of the light tint over the whole range area, including ground the beam cannot reach.
const RANGE_TINT_OPACITY = 0.1;
// The panel's "Interior Beam" slider runs 0 - 0.30; that span maps to the
// range rings' full 0 - 1 opacity.
const INTERIOR_SLIDER_MAX = 0.3;

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
                viewsheds: profiles.map(profile => CesiumRadarCoverage.computeViewshed(profile, radarHeight))
            });
        }

        // Paint the coverage onto the terrain: zone colour where the antenna can
        // see the ground, a light tint where it is in range but hidden by a hill.
        // The lit layer is baked fully opaque and faded by its material colour,
        // so the Beam Opacity slider only changes a uniform - no rebuild.
        const style: RadarStyle = {
            beamOpacity: options.beamOpacity ?? 0.35,
            interiorOpacity,
            showInterior,
            cylinderOpacity: options.cylinderOpacity ?? 0.15,
            showCylinders: options.showCylinders ?? true
        };
        let litColor = Cesium.Color.WHITE.withAlpha(style.beamOpacity);
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
        addGroundImage(coverage.tintCanvas);
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

        // Coverage wall of every zone: one plain surface around the zone's range
        // (closed back to the radar for a sector), from the radar's ground up to
        // the height the zone's top-angle beam reaches at that range. Drawn flat
        // (unlit, no outline) so it is one even shade all round. Faded by
        // "Zone Cylinders".
        const cylinders = zones.map((zone, z) => {
            const top = radarHeight + zone.range * Math.tan(Cesium.Math.toRadians(zone.maxElevationDeg));
            const positions = CesiumRadarCoverage.buildRangeRing(enuMatrix, radarPosition, zone);
            const primitive = viewer.scene.primitives.add(new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                    id: `radar-wall-${entityId}-${z}`,
                    geometry: new Cesium.WallGeometry({
                        positions,
                        minimumHeights: positions.map(() => terrainHeight),
                        maximumHeights: positions.map(() => Math.max(top, terrainHeight + 1))
                    }),
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
        const setCylinderStyle = (st: RadarStyle) => {
            cylinders.forEach((primitive, z) => {
                primitive.show = st.showCylinders && st.cylinderOpacity > 0;
                const color = Cesium.ColorGeometryInstanceAttribute.toValue(zones[z].color.withAlpha(st.cylinderOpacity));
                try {
                    primitive.getGeometryInstanceAttributes(`radar-wall-${entityId}-${z}`).color = color;
                } catch {
                    // Not drawn yet: apply the colour after the next frame.
                    const remove = viewer.scene.postRender.addEventListener(() => {
                        remove();
                        if (primitive.isDestroyed()) return;
                        primitive.getGeometryInstanceAttributes(`radar-wall-${entityId}-${z}`).color = color;
                        viewer.scene.requestRender();
                    });
                }
            });
        };

        handles.push({
            dispose: () => {
                for (const ring of rings) viewer.entities.remove(ring);
                for (const cylinder of cylinders) viewer.scene.primitives.remove(cylinder);
            },
            setStyle: (st: RadarStyle) => {
                litColor = Cesium.Color.WHITE.withAlpha(st.beamOpacity);
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
        let highestAngleSoFar = -Infinity;

        for (let i = 1; i < n; i++) {
            const dist = horizontalDistances[i];
            // The ground curves away below a straight beam (4/3 Earth model).
            const curvatureDrop = (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
            const a = Math.atan2(groundHeights[i] - curvatureDrop - radarHeight, dist);

            angle[i] = a;
            visible[i] = a >= highestAngleSoFar ? 1 : 0;
            if (a > highestAngleSoFar) highestAngleSoFar = a;
        }
        return { visible, angle };
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
    //   - in range but not reached (radar shadow) -> light tint of the nearest
    //     zone in range, so the whole range area stays visible
    //   - out of every zone's range -> left transparent
    // Lit and tinted pixels go into two separate images: the lit one is fully
    // opaque and faded at draw time by the Beam Opacity setting.
    private static buildCoverageTexture(
        longitude: number,
        latitude: number,
        maxRange: number,
        zones: ResolvedZone[],
        fans: Map<string, Fan>
    ): { litCanvas: HTMLCanvasElement; tintCanvas: HTMLCanvasElement; rectangle: Cesium.Rectangle } {
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
        const tinted = makeLayer();
        const litPx = lit.image.data;
        const tintPx = tinted.image.data;

        const zoneStyles = zones.map(zone => ({
            zone,
            fan: fans.get(`${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`)!,
            maxAngle: Cesium.Math.toRadians(zone.maxElevationDeg),
            rgba: [
                Math.round(zone.color.red * 255),
                Math.round(zone.color.green * 255),
                Math.round(zone.color.blue * 255),
                255
            ],
            tintRgba: [
                Math.round(zone.color.red * 255),
                Math.round(zone.color.green * 255),
                Math.round(zone.color.blue * 255),
                Math.round(RANGE_TINT_OPACITY * 255)
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
                let c: number[] | null = null;
                let tint: number[] | null = null;

                for (const style of zoneStyles) {
                    if (dist > style.zone.range) continue;
                    const seen = CesiumRadarCoverage.lookupVisibility(style.fan, azimuthDeg, dist, style.maxAngle);
                    if (seen === null) continue;
                    tint ??= style.tintRgba;
                    if (seen) {
                        c = style.rgba;
                        break;
                    }
                }

                const px = c ? litPx : tintPx;
                c ??= tint;

                if (!c) continue;
                const o = (y * size + x) * 4;
                px[o] = c[0];
                px[o + 1] = c[1];
                px[o + 2] = c[2];
                px[o + 3] = c[3];
            }
        }

        lit.ctx.putImageData(lit.image, 0, 0);
        tinted.ctx.putImageData(tinted.image, 0, 0);
        return { litCanvas: lit.canvas, tintCanvas: tinted.canvas, rectangle };
    }

    // Is the ground at this azimuth/distance lit by the radar? Blends the two
    // neighbouring sampled azimuths so edges follow the terrain instead of
    // stepping every azimuth. Returns null when outside the fan's sector.
    private static lookupVisibility(fan: Fan, azimuthDeg: number, dist: number, maxAngle: number): boolean | null {
        const count = fan.azimuthsDeg.length;
        const fullCircle = fan.widthDeg >= 360;
        const rel = (((azimuthDeg - fan.startDeg) % 360) + 360) % 360;
        if (!fullCircle && rel > fan.widthDeg) return null;

        const pos = fullCircle ? rel / (360 / count) : rel / (fan.widthDeg / (count - 1));
        const a0 = Math.floor(pos) % count;
        const a1 = fullCircle ? (a0 + 1) % count : Math.min(a0 + 1, count - 1);
        const w = pos - Math.floor(pos);

        const i = Math.min(Math.round(dist / fan.spacing), fan.profiles[0].horizontalDistances.length - 1);
        const lit = (a: number) => {
            const v = fan.viewsheds[a];
            return v.visible[i] && v.angle[i] <= maxAngle ? 1 : 0;
        };
        return (1 - w) * lit(a0) + w * lit(a1) >= 0.5;
    }
}
