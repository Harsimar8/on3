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
// CesiumRadarCoverage (Clean Cylindrical Zones with Terrain Line-of-Sight Masking)
// =============================================================================

const TERRAIN_SAMPLE_SPACING_M = 20;
const EARTH_RADIUS_M = 6371000;

export class CesiumRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [
        {
            name: "Zone 1 (Low)",
            cssColor: "#22c55e",
            color: Cesium.Color.fromCssColorString("#22c55e"),
            defaultRange: 5000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 15
        },
        {
            name: "Zone 2 (Mid)",
            cssColor: "#f59e0b",
            color: Cesium.Color.fromCssColorString("#f59e0b"),
            defaultRange: 12000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 30
        },
        {
            name: "Zone 3 (High / Wide)",
            cssColor: "#ef4444",
            color: Cesium.Color.fromCssColorString("#ef4444"),
            defaultRange: 20000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 60
        }
    ];

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
            useObjectPicking = false,
            zoneOverrides = {}
        } = options;

        const handles: RadarCoverageHandle[] = [];

        // 1. Position & Terrain Sampling
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

        // 2. Emitter Marker
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

        // 3. Resolve Zones
        const visibleZones: ResolvedZone[] = [];
        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
            const override = zoneOverrides[zoneConfig.name] ?? {};
            if (!(override.visible ?? true)) continue;

            visibleZones.push({
                name: zoneConfig.name,
                color: zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                minElevationDeg: override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg,
                maxElevationDeg: override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg,
                beamOpacity: override.beamOpacity ?? (options.beamOpacity ?? 0.35),
                interiorOpacity: override.interiorOpacity ?? (options.interiorOpacity ?? 0.15),
                showInterior: override.showInterior ?? (options.showInterior ?? true),
                visible: true,
                azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
            });
        }

        if (visibleZones.length === 0) return handles;

        // 4. Build Cylindrical Zones with Terrain Line-of-Sight Clipping
        for (const zone of visibleZones) {
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

            // Compute max line-of-sight range per azimuth using terrain profile blocking
            const effectiveRanges = profiles.map(profile =>
                CesiumRadarCoverage.getTerrainBlockedRange(profile, radarHeight, zone.range)
            );

            // Build clean cylindrical volume geometry matching the user's reference style
            const cylinderEntity = CesiumRadarCoverage.buildCylinderVolumeEntity(
                viewer,
                radarPosition,
                enuMatrix,
                zone,
                azimuthsDeg,
                effectiveRanges,
                entityId
            );

            if (cylinderEntity) {
                handles.push({ dispose: () => viewer.entities.remove(cylinderEntity) });
            }
        }

        viewer.scene.requestRender();
        return handles;
    }

    // -------------------------------------------------------------------
    // Terrain Profiles & Line-of-Sight Calculation
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

    private static getTerrainBlockedRange(
        profile: TerrainProfile,
        radarHeight: number,
        maxRange: number
    ): number {
        const { horizontalDistances, groundHeights } = profile;
        // Simple line-of-sight horizon check: if terrain height exceeds line of sight from radar base
        for (let i = 2; i < horizontalDistances.length; i++) {
            const dist = horizontalDistances[i];
            if (dist > maxRange) break;

            const groundH = groundHeights[i];
            // Straight-line interpolation check from radar to current distance
            const expectedRayH = radarHeight + (groundH - radarHeight) * (dist / maxRange);

            // If terrain blocks the lower portion significantly
            if (groundH > radarHeight && (groundH - radarHeight) / dist > 0.15) {
                // Return distance where line of sight is obstructed
                return Math.max(500, dist - 200);
            }
        }
        return maxRange;
    }

    // -------------------------------------------------------------------
    // Clean Cylinder Volume Entity Builder (Reference Style)
    // -------------------------------------------------------------------

    private static buildCylinderVolumeEntity(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        effectiveRanges: number[],
        entityId: string
    ): Cesium.Entity | null {
        const avgRange = effectiveRanges.reduce((a, b) => a + b, 0) / effectiveRanges.length;
        const cart = Cesium.Cartographic.fromCartesian(radarPosition);
        
        const maxRad = Cesium.Math.toRadians(zone.maxElevationDeg);
        const topHeightOffset = Math.tan(maxRad) * avgRange;
        const totalHeight = Math.max(300, topHeightOffset);

        const cylinder = viewer.entities.add({
            name: zone.name,
            position: Cesium.Cartesian3.fromRadians(cart.longitude, cart.latitude, cart.height + (totalHeight / 2)),
            cylinder: {
                length: totalHeight,
                topRadius: avgRange,
                bottomRadius: avgRange,
                material: zone.color.withAlpha(zone.beamOpacity),
                outline: true,
                outlineColor: zone.color.withAlpha(0.9),
                outlineWidth: 1.5
            }
        });

        (cylinder as any).radarParentId = entityId;
        return cylinder;
    }

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
}