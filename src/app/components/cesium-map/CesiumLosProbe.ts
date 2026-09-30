import * as Cesium from "cesium";
import { CesiumRadarCoverage, RadarGeometry, ResolvedZone } from "./CesiumRadarCoverage";

// =============================================================================
// CesiumLosProbe (click a point -> "why is / isn't this covered?")
// =============================================================================
// Draws the line of sight from a radar's antenna to a clicked ground point and
// explains the result:
//   - visible:  one green ray straight to the point
//   - blocked:  green ray up to the ridge that hides the point, the grazing ray
//               continued over the point (dashed), and a red drop line showing
//               how far below that lowest clearing ray the point lies
//   - above:    the point is visible but steeper than every zone's top angle
//   - outside:  out of range or out of the radar's sector

export type LosProbeStatus = "visible" | "blocked" | "above" | "outOfRange" | "outOfSector";

export interface LosProbeResult {
    status: LosProbeStatus;
    title: string;
    details: string[];
}

// Finest spacing between terrain samples along the probe line; longer lines
// are capped at MAX_PROBE_SAMPLES samples.
const PROBE_SAMPLE_SPACING_M = 10;
const MAX_PROBE_SAMPLES = 1500;
// Lift lines/markers this far off the ground so they are not z-fighting the terrain.
const GROUND_LIFT_M = 2;

const COLOR_CLEAR = Cesium.Color.fromCssColorString("#22c55e");
const COLOR_BLOCKED = Cesium.Color.fromCssColorString("#ef4444");
const COLOR_GRAZING = Cesium.Color.fromCssColorString("#f59e0b");
const COLOR_MUTED = Cesium.Color.fromCssColorString("#94a3b8");

export class CesiumLosProbe {

    private readonly drawn: Cesium.Entity[] = [];
    // Bumped per probe so a slow terrain sample never draws over a newer click.
    private probeToken = 0;

    constructor(
        private viewer: Cesium.Viewer,
        private terrainProvider: Cesium.TerrainProvider
    ) { }

    /**
     * Radar to explain the point for: the preferred one (normally the selected
     * radar) if it has been built and the point is within its range, otherwise
     * the nearest radar whose range reaches the point.
     */
    findRadarFor(target: Cesium.Cartographic, preferredId?: string | null): string | null {
        const reaches = (id: string) => {
            const geometry = CesiumRadarCoverage.getGeometry(id);
            if (!geometry) return null;
            const { dist } = CesiumLosProbe.polarOf(geometry, target);
            return dist <= Math.max(...geometry.zones.map(z => z.range)) ? dist : null;
        };

        if (preferredId && reaches(preferredId) !== null) return preferredId;

        let best: string | null = null;
        let bestDist = Infinity;
        for (const id of CesiumRadarCoverage.radarIds()) {
            const dist = reaches(id);
            if (dist !== null && dist < bestDist) {
                best = id;
                bestDist = dist;
            }
        }
        return best;
    }

    async probe(radarId: string, target: Cesium.Cartographic): Promise<LosProbeResult | null> {
        const geometry = CesiumRadarCoverage.getGeometry(radarId);
        if (!geometry) return null;

        const token = ++this.probeToken;
        const { dist, azimuthDeg } = CesiumLosProbe.polarOf(geometry, target);
        const inSector = geometry.zones.filter(z => CesiumLosProbe.inSector(z, azimuthDeg));
        const maxRange = Math.max(...geometry.zones.map(z => z.range));

        if (inSector.length === 0) {
            return this.finish(token, geometry, target, target.height, {
                status: "outOfSector",
                title: "NOT COVERED - radar does not point this way",
                details: ["This spot is outside the radar's sector"]
            });
        }
        const inRange = inSector.filter(z => dist <= z.range);
        if (inRange.length === 0) {
            return this.finish(token, geometry, target, target.height, {
                status: "outOfRange",
                title: "NOT COVERED - too far from the radar",
                details: [`This spot is ${km(dist)} away, the radar reaches only ${km(maxRange)}`]
            });
        }

        // Terrain along the exact line from the antenna to the clicked point.
        const spacing = Math.max(PROBE_SAMPLE_SPACING_M, dist / MAX_PROBE_SAMPLES);
        const count = Math.max(2, Math.ceil(dist / spacing)) + 1;
        const dists: number[] = [];
        const points: Cesium.Cartographic[] = [];
        for (let i = 0; i < count; i++) {
            const d = Math.min(i * spacing, dist);
            dists.push(d);
            points.push(CesiumRadarCoverage.groundPointAt(geometry, azimuthDeg, d));
        }
        const sampled = await Cesium.sampleTerrainMostDetailed(this.terrainProvider, points);
        if (token !== this.probeToken) return null;

        const heights = sampled.map(p => p.height ?? 0);
        const last = count - 1;
        const targetHeight = heights[last];
        const targetAngle = CesiumRadarCoverage.elevationAngle(targetHeight, dist, geometry.radarHeight);

        // The terrain the beam has to clear before reaching the point (same
        // rule as the coverage shading, including the small-rise tolerance).
        let ridge = -1;
        let horizon = -Infinity;
        for (let i = 1; i < last; i++) {
            if (dists[i] < CesiumRadarCoverage.NEAR_FIELD_IGNORE_M) continue;
            const a = CesiumRadarCoverage.elevationAngle(heights[i], dists[i], geometry.radarHeight);
            const h = CesiumRadarCoverage.horizonTan(a, dists[i]);
            if (h > horizon) {
                horizon = h;
                ridge = i;
            }
        }
        // Lowest beam that gets over that terrain.
        const ridgeAngle = Math.atan(horizon);

        const spotLine = (zone: ResolvedZone) => `This spot: ${km(dist)} from the radar, in ${zone.name}`;
        const targetDeg = Cesium.Math.toDegrees(targetAngle);

        // One line per configured zone saying why it does or does not light the
        // spot, so a zone that is off, too short or too low is never a mystery.
        const zoneLines = () => CesiumRadarCoverage.DEFAULT_3D_ZONES.map(config => {
            const zone = geometry.zones.find(z => z.name === config.name);
            if (!zone) return `${config.name}: turned off`;
            if (!CesiumLosProbe.inSector(zone, azimuthDeg)) return `${zone.name}: not pointing this way`;
            if (dist > zone.range) return `${zone.name}: reaches only ${km(zone.range)}`;
            if (targetDeg > zone.maxElevationDeg) return `${zone.name}: beam only goes up to ${zone.maxElevationDeg}°`;
            return `${zone.name}: covers it`;
        });

        if (ridge > 0 && Math.tan(targetAngle) < horizon) {
            const hiddenBy = CesiumRadarCoverage.beamHeightAt(ridgeAngle, dist, geometry.radarHeight) - targetHeight;
            const behind = dist - dists[ridge];
            const higherBy = targetHeight - heights[ridge];
            this.drawBlocked(geometry, azimuthDeg, dists[ridge], heights[ridge], ridgeAngle, dist, targetHeight);
            return this.finish(token, geometry, points[last], targetHeight, {
                status: "blocked",
                title: "NOT VISIBLE - higher ground is in the way",
                details: [
                    `Hill/ridge ${km(dists[ridge])} from the radar hides this spot`,
                    `(hill top ${Math.round(heights[ridge])} m, radar antenna at ${Math.round(geometry.radarHeight)} m)`,
                    // The spot can be higher than the hill top and still hidden:
                    // the beam climbs to get over the hill and keeps climbing.
                    higherBy > 0
                        ? `This spot is ${Math.round(higherBy)} m higher than the hill top, but ${km(behind)} behind it.`
                        : `This spot is ${Math.round(-higherBy)} m lower than the hill top, ${km(behind)} behind it.`,
                    `To clear the hill the beam climbs at ${Cesium.Math.toDegrees(ridgeAngle).toFixed(1)}°,`,
                    `so it passes ${km(hiddenBy)} above this spot.`,
                    `Anything flying more than ${km(hiddenBy)} above here would be seen.`,
                    spotLine(inRange[0])
                ]
            }, false);
        }

        const litBy = inRange.find(z => targetDeg <= z.maxElevationDeg);
        if (!litBy) {
            this.drawRay(geometry.radarPosition, points[last], targetHeight, COLOR_GRAZING);
            return this.finish(token, geometry, points[last], targetHeight, {
                status: "above",
                title: "NOT COVERED - spot is too high for the beam",
                details: [
                    `Nothing blocks it, but the spot is ${targetDeg.toFixed(1)}° up from the radar`,
                    `(${km(dist)} away). Zone by zone:`,
                    ...zoneLines()
                ]
            }, false);
        }

        this.drawRay(geometry.radarPosition, points[last], targetHeight, COLOR_CLEAR);
        return this.finish(token, geometry, points[last], targetHeight, {
            status: "visible",
            title: "VISIBLE - the radar can see this spot",
            details: [
                "Nothing is in the way",
                spotLine(litBy)
            ]
        }, false);
    }

    clear(): void {
        this.probeToken++;
        for (const e of this.drawn) this.viewer.entities.remove(e);
        this.drawn.length = 0;
        this.viewer.scene.requestRender();
    }

    // -------------------------------------------------------------------
    // Drawing
    // -------------------------------------------------------------------

    // Clears the previous probe (unless the caller already drew this one's
    // lines) and puts the result label on the clicked point.
    private finish(
        token: number,
        geometry: RadarGeometry,
        target: Cesium.Cartographic,
        targetHeight: number,
        result: LosProbeResult,
        clearFirst = true
    ): LosProbeResult | null {
        if (token !== this.probeToken) return null;
        if (clearFirst) this.clearDrawn();

        const color = {
            visible: COLOR_CLEAR,
            blocked: COLOR_BLOCKED,
            above: COLOR_GRAZING,
            outOfRange: COLOR_MUTED,
            outOfSector: COLOR_MUTED
        }[result.status];

        this.add({
            position: Cesium.Cartesian3.fromRadians(target.longitude, target.latitude, targetHeight + GROUND_LIFT_M),
            point: {
                pixelSize: 10,
                color,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label: {
                text: [result.title, ...result.details].join("\n"),
                font: "13px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString("#0f172a").withAlpha(0.88),
                backgroundPadding: new Cesium.Cartesian2(10, 7),
                // Left of the spot, so the tags drawn right of the lines stay readable.
                horizontalOrigin: Cesium.HorizontalOrigin.RIGHT,
                verticalOrigin: Cesium.VerticalOrigin.TOP,
                pixelOffset: new Cesium.Cartesian2(-14, 6),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        this.viewer.scene.requestRender();
        return result;
    }

    private drawBlocked(
        geometry: RadarGeometry,
        azimuthDeg: number,
        ridgeDist: number,
        ridgeHeight: number,
        ridgeAngle: number,
        targetDist: number,
        targetHeight: number
    ): void {
        this.clearDrawn();

        const ridgeGround = CesiumRadarCoverage.groundPointAt(geometry, azimuthDeg, ridgeDist);
        const targetGround = CesiumRadarCoverage.groundPointAt(geometry, azimuthDeg, targetDist);
        const ridgeTop = Cesium.Cartesian3.fromRadians(ridgeGround.longitude, ridgeGround.latitude, ridgeHeight + GROUND_LIFT_M);
        const overTarget = Cesium.Cartesian3.fromRadians(
            targetGround.longitude,
            targetGround.latitude,
            CesiumRadarCoverage.beamHeightAt(ridgeAngle, targetDist, geometry.radarHeight)
        );
        const targetPoint = Cesium.Cartesian3.fromRadians(targetGround.longitude, targetGround.latitude, targetHeight + GROUND_LIFT_M);
        const gap = CesiumRadarCoverage.beamHeightAt(ridgeAngle, targetDist, geometry.radarHeight) - targetHeight;

        // Beam reaches the ridge...
        this.addLine([geometry.radarPosition, ridgeTop], COLOR_CLEAR, false);
        // ...grazes it and carries on over the point...
        this.addLine([ridgeTop, overTarget], COLOR_GRAZING, true);
        // ...leaving the point this far below it, in the ridge's shadow.
        this.addLine([overTarget, targetPoint], COLOR_BLOCKED, true);

        this.addTag(overTarget, `Beam passes ${km(gap)} overhead`, COLOR_GRAZING, Cesium.VerticalOrigin.BOTTOM);

        this.add({
            position: ridgeTop,
            point: {
                pixelSize: 11,
                color: COLOR_BLOCKED,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label: {
                text: "Terrain blocks the beam here",
                font: "12px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: COLOR_BLOCKED.withAlpha(0.85),
                // Below the marker, so it never sits on the "overhead" tag above.
                verticalOrigin: Cesium.VerticalOrigin.TOP,
                pixelOffset: new Cesium.Cartesian2(0, 12),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }

    private drawRay(from: Cesium.Cartesian3, target: Cesium.Cartographic, targetHeight: number, color: Cesium.Color): void {
        this.clearDrawn();
        this.addLine(
            [from, Cesium.Cartesian3.fromRadians(target.longitude, target.latitude, targetHeight + GROUND_LIFT_M)],
            color,
            false
        );
    }

    // Small coloured text tag, no marker.
    private addTag(
        position: Cesium.Cartesian3,
        text: string,
        color: Cesium.Color,
        verticalOrigin = Cesium.VerticalOrigin.CENTER
    ): void {
        this.add({
            position,
            label: {
                text,
                font: "12px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: color.withAlpha(0.85),
                horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                verticalOrigin,
                pixelOffset: new Cesium.Cartesian2(8, -4),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }

    private addLine(positions: Cesium.Cartesian3[], color: Cesium.Color, dashed: boolean): void {
        const material = dashed
            ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 16 })
            : new Cesium.PolylineGlowMaterialProperty({ color, glowPower: 0.15 });
        this.add({
            polyline: {
                positions,
                width: dashed ? 3 : 6,
                arcType: Cesium.ArcType.NONE,
                material,
                // Stay readable where a hill is between the camera and the line.
                depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: color.withAlpha(0.45), dashLength: 8 })
            }
        });
    }

    private add(options: Cesium.Entity.ConstructorOptions): void {
        this.drawn.push(this.viewer.entities.add(options));
    }

    private clearDrawn(): void {
        for (const e of this.drawn) this.viewer.entities.remove(e);
        this.drawn.length = 0;
    }

    // -------------------------------------------------------------------
    // Geometry helpers
    // -------------------------------------------------------------------

    // Horizontal distance and compass bearing from the radar to the point.
    private static polarOf(geometry: RadarGeometry, target: Cesium.Cartographic): { dist: number; azimuthDeg: number } {
        const world = Cesium.Cartesian3.fromRadians(target.longitude, target.latitude, target.height);
        const toLocal = Cesium.Matrix4.inverseTransformation(geometry.enuMatrix, new Cesium.Matrix4());
        const local = Cesium.Matrix4.multiplyByPoint(toLocal, world, new Cesium.Cartesian3());
        return {
            dist: Math.hypot(local.x, local.y),
            azimuthDeg: (Cesium.Math.toDegrees(Math.atan2(local.x, local.y)) + 360) % 360
        };
    }

    private static inSector(zone: ResolvedZone, azimuthDeg: number): boolean {
        if (zone.azimuthWidthDeg >= 360) return true;
        const rel = (((azimuthDeg - zone.azimuthStartDeg) % 360) + 360) % 360;
        return rel <= zone.azimuthWidthDeg;
    }
}

function km(meters: number): string {
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}
