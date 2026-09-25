import * as Cesium from "cesium";
import { Entity } from "../../core/models/Entity";
import { EntityIconFactory } from "../../core/factories/EntityIconFactory";
import { EditorState } from "../../core/state/EditorState";
import { TeamFilterService } from "../../core/services/TeamFilterService";
import { Team } from "../../core/types/Team";
import { TeamFilter } from "../../core/models/TeamFilter";
import { CesiumRadarCoverage, RadarCoverageHandle, RadarZoneOverride } from "./CesiumRadarCoverage";


export class CesiumEntityRenderer {

    // Live radar coverage handles, keyed by source entity.id
    private readonly radarEntities = new Map<string, RadarCoverageHandle[]>();

    // Signature of the inputs the current coverage was built from.
    // If nothing in it changed, we skip rebuilding.
    private readonly lastBuiltSignature = new Map<string, string>();

    // Guards against overlapping async rebuilds for the same entity
    private readonly buildInFlight = new Set<string>();

    // Newest entity state that arrived while a build was running
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

    /** Drops the cached signature so the next render() call rebuilds this radar from scratch. */
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

    // ONE place for all radar settings + their defaults.
    // Used both for the signature and for the actual build, so they can never disagree.
    private readRadarSettings(entity: Entity) {
        const props = (entity.definition.properties as any) ?? {};
        return {
            mastHeight: props.antennaMastHeight ?? 2,
            sectorStartDeg: props.sectorStartDeg ?? 0,
            sectorSweepDeg: props.sectorSweepDeg ?? 360,
            azimuthStepDeg: props.azimuthStepDeg ?? 2,
            rangeSampleSteps: props.rangeSampleSteps,
            clearanceToleranceM: props.clearanceToleranceM ?? 1,

            drawFootprint: props.drawFootprint ?? true,
            footprintOpacity: props.footprintOpacity ?? 0.25,

            drawVolume: props.drawVolume ?? true,
            beamOpacity: props.beamOpacity ?? 0.18,
            volumeCellSizeM: props.volumeCellSizeM ?? 50,

            zoneVisibility: props.zoneVisibility ?? {},
            zoneRanges: props.zoneRanges ?? {},
            zoneElevations: props.zoneElevations ?? {}
        };
    }

    private buildSignature(entity: Entity): string {
        return JSON.stringify({
            lon: entity.position.longitude,
            lat: entity.position.latitude,
            alt: entity.position.altitude,
            ...this.readRadarSettings(entity)
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
            const s = this.readRadarSettings(entity);

            const zoneOverrides: Record<string, RadarZoneOverride> = {};
            for (const zone of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
                zoneOverrides[zone.name] = {
                    visible: s.zoneVisibility?.[zone.name] ?? true,
                    range: s.zoneRanges?.[zone.name],
                    minElevationDeg: s.zoneElevations?.[zone.name]?.min,
                    maxElevationDeg: s.zoneElevations?.[zone.name]?.max
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

                    mastHeight: s.mastHeight,
                    sectorStartDeg: s.sectorStartDeg,
                    sectorSweepDeg: s.sectorSweepDeg,
                    azimuthStepDeg: s.azimuthStepDeg,
                    rangeSampleSteps: s.rangeSampleSteps,
                    clearanceToleranceM: s.clearanceToleranceM,

                    drawFootprint: s.drawFootprint,
                    footprintOpacity: s.footprintOpacity,

                    drawVolume: s.drawVolume,
                    beamOpacity: s.beamOpacity,
                    volumeCellSizeM: s.volumeCellSizeM,

                    zoneOverrides
                }
            );

            // Swap old -> new only after the new build succeeds
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
        const selected =
            this.editorState.selectedEntity()?.id === entity.id;

        this.viewer.entities.add({
            id: entity.id,

            position: Cesium.Cartesian3.fromDegrees(
                entity.position.longitude,
                entity.position.latitude,
                entity.position.altitude
            ),

            billboard: {
                image: EntityIconFactory.get(
                    entity.definition.entityType
                ),

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
                image:
                    entity.team === "Blue"
                        ? "assets/blue.png"
                        : "assets/red.png",

                color:
                    entity.team === "Blue"
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