import * as Cesium from "cesium";

import { EditorState } from "../../core/state/EditorState";
import { EntityRepository } from "../../core/services/EntityRepository";

export class CesiumSelection {

    constructor(
        private viewer: Cesium.Viewer,
        private editorState: EditorState,
        private entityRepository: EntityRepository
    ) {}

    selectEntity(
        click: Cesium.ScreenSpaceEventHandler.PositionedEvent
    ): void {

        const picked = this.viewer.scene.pick(click.position);

        if (!Cesium.defined(picked)) {
            this.editorState.selectedEntity.set(null);
            return;
        }

        const pickedEntity = (picked as any).id;

        if (!pickedEntity) {
            return;
        }

        // If a 3D radar wall, cap, or ray was clicked, select its parent radar entity
        // Radar beam primitives carry the radar's id directly as a string
        // Coverage drawings (shading, rings, markers on ridges) carry their
        // radar's id but are not the radar: clicking them changes nothing.
        // Only the radar symbol itself selects the radar.
        if (typeof pickedEntity !== "string" && pickedEntity.radarParentId && !pickedEntity.isRadarMarker) {
            return;
        }

        const targetId = typeof pickedEntity === "string"
            ? pickedEntity
            : pickedEntity.radarParentId || pickedEntity.id;

        const entity = this.entityRepository
            .all()
            .find(e => e.id === targetId);

        if (!entity) {
            return;
        }

        this.editorState.selectedEntity.set(entity);
    }
}