import * as Cesium from "cesium";
import { Entity } from "../../core/models/Entity";
import { EntityIconFactory } from "../../core/factories/EntityIconFactory";
import { EditorState } from "../../core/state/EditorState";
import { TeamFilterService } from "../../core/services/TeamFilterService";
import { Team } from "../../core/types/Team";
import { TeamFilter } from "../../core/models/TeamFilter";
import { CesiumRadarCoverage, RadarCoverageHandle, RadarZoneOverride } from "./CesiumRadarCoverage";

export class CesiumEntityRenderer {

    private readonly radarEntities = new Map<string, RadarCoverageHandle[]>();
    private readonly lastBuiltSignature = new Map<string, string>();
    private readonly buildInFlight = new Set<string>();
    private readonly pendingRebuild = new Map<string, Entity>();

    constructor(
        private viewer: Cesium.Viewer,
        private terrainProvider: Cesium.TerrainProvider,
        private teamFilterService: TeamFilterService,
        private editorState: EditorState
    ) { }

    render(entities: Entity[]): void {
        const filter = this.teamFilterService.cesiumFilter();
        const seenIds = new Set<string>();

        for (const entity of entities) {

            if (
                (filter === TeamFilter.Blue && entity.team !== Team.Blue) ||
                (filter === TeamFilter.Red && entity.team !== Team.Red)
            ) {
                continue;
            }

            if (entity.definition.entityType === "RadarSite") {
                seenIds.add(entity.id);
                this.syncRadarCoverage(entity);
            }
        }

        for (const existingId of Array.from(this.radarEntities.keys())) {
            if (!seenIds.has(existingId)) {
                this.removeRadarCoverage(existingId);
            }
        }

        this.viewer.scene.requestRender();
    }

    forceRebuild(entityId: string): void {
        this.lastBuiltSignature.delete(entityId);
    }

    private removeRadarCoverage(entityId: string): void {
        const existing = this.radarEntities.get(entityId);
        if (existing) {
            for (const handle of existing) {
                handle.dispose();
            }
        }
        this.radarEntities.delete(entityId);
        this.lastBuiltSignature.delete(entityId);
        this.pendingRebuild.delete(entityId);
    }

    private buildSignature(entity: Entity): string {
        const props = (entity.definition.properties as any) ?? {};

        return JSON.stringify({
            lon: entity.position.longitude,
            lat: entity.position.latitude,
            alt: entity.position.altitude,

            sectorStartDeg: props.sectorStartDeg ?? 0,
            sectorSweepDeg: props.sectorSweepDeg ?? 360,
            antennaMastHeight: props.antennaMastHeight ?? 0,

            drawRays: props.drawRays ?? false,

            // Opacity/color are appearance-only in principle, but they're
            // still included here deliberately: per-zone beam/interior
            // opacity overrides feed into which alpha value the mesh is
            // built with (Cesium bakes color into the geometry instance
            // attribute at construction), so a change does need a rebuild
            // with the current Primitive setup. If/when that becomes a
            // pure appearance update, drop these three lines to skip the
            // terrain recomputation on opacity-only changes.
            beamOpacity: props.beamOpacity ?? 0.28,
            interiorOpacity: props.interiorOpacity ?? 0.08,
            showInterior: props.showInterior ?? true,

            zoneVisibility: props.zoneVisibility ?? {},
            zoneRanges: props.zoneRanges ?? {},
            zoneElevations: props.zoneElevations ?? {},
            zoneHeadings: props.zoneHeadings ?? {},   // NEW - per-zone azimuthStartDeg
            zoneWidths: props.zoneWidths ?? {},       // NEW - per-zone azimuthWidthDeg

            azimuthStepDeg: props.azimuthStepDeg,
            elevationRingsPerZone: props.elevationRingsPerZone,
            rangeSampleSteps: props.rangeSampleSteps,
            useObjectPicking: props.useObjectPicking ?? false
        });
    }

    private async syncRadarCoverage(entity: Entity): Promise<void> {

        const signature = this.buildSignature(entity);

        if (this.lastBuiltSignature.get(entity.id) === signature) {
            return;
        }

        if (this.buildInFlight.has(entity.id)) {
            this.pendingRebuild.set(entity.id, entity);
            return;
        }

        this.buildInFlight.add(entity.id);

        try {

            const props = (entity.definition.properties as any) ?? {};

            const zoneOverrides: Record<string, RadarZoneOverride> = {};
            for (const zone of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
                zoneOverrides[zone.name] = {
                    visible: props.zoneVisibility?.[zone.name] ?? true,
                    range: props.zoneRanges?.[zone.name],
                    minElevationDeg: props.zoneElevations?.[zone.name]?.min,
                    maxElevationDeg: props.zoneElevations?.[zone.name]?.max,
                    azimuthStartDeg: props.zoneHeadings?.[zone.name],
                    azimuthWidthDeg: props.zoneWidths?.[zone.name]
                };
            }

            const newHandles = await CesiumRadarCoverage.create3DRadarZones(
                this.viewer,
                this.terrainProvider,
                {
                    entityId: entity.id,
                    longitude: entity.position.longitude,
                    latitude: entity.position.latitude,
                    altitude: entity.position.altitude,
                    mastHeight: props.antennaMastHeight ?? 0,
                    sectorStartDeg: props.sectorStartDeg ?? 0,
                    sectorSweepDeg: props.sectorSweepDeg ?? 360,
                    drawRays: props.drawRays ?? false,
                    azimuthStepDeg: props.azimuthStepDeg ?? 5,
                    elevationRingsPerZone: props.elevationRingsPerZone ?? 10,
                    rangeSampleSteps: props.rangeSampleSteps,
                    useObjectPicking: props.useObjectPicking ?? true,

                    beamOpacity: props.beamOpacity ?? 0.28,
                    interiorOpacity: props.interiorOpacity ?? 0.08,
                    showInterior: props.showInterior ?? true,
                    

                    zoneOverrides
                }
            );

            const old = this.radarEntities.get(entity.id);
            if (old) {
                for (const handle of old) {
                    handle.dispose();
                }
            }

            this.radarEntities.set(entity.id, newHandles);
            this.lastBuiltSignature.set(entity.id, signature);

            this.viewer.scene.requestRender();

        } catch (err) {
            console.error("Failed to render 3D radar coverage:", err);
        } finally {
            this.buildInFlight.delete(entity.id);

            const pending = this.pendingRebuild.get(entity.id);
            if (pending) {
                this.pendingRebuild.delete(entity.id);
                this.syncRadarCoverage(pending);
            }
        }
    }

    private drawRadar(entity: Entity): void {
        const selected = this.editorState.selectedEntity()?.id === entity.id;

        this.viewer.entities.add({
            id: entity.id,
            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                entity.position.altitude
            ),
            billboard: {
                image: EntityIconFactory.get(entity.definition.entityType),
                width: selected ? 36 : 32,
                height: selected ? 36 : 32,
                scale: selected ? 1.08 : 1.0,
                color: selected
                    ? Cesium.Color.fromCssColorString("#FFF8DC")
                    : Cesium.Color.WHITE,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER
            }
        });
    }

    private drawTeamDot(entity: Entity): void {
        this.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                entity.position.altitude
            ),
            billboard: {
                image: entity.team === "Blue" ? "assets/blue.png" : "assets/red.png",
                color: entity.team === "Blue"
                    ? Cesium.Color.fromCssColorString("#3B82F6")
                    : Cesium.Color.WHITE,
                width: 16,
                height: 16,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }
}