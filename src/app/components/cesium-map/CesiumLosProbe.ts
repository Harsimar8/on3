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
    // Short text for the label on the map.
    title: string;
    details: string[];
    // Full explanation for the radar panel.
    explanation: string[];
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

// A position worked out when drawn (see CesiumLosProbe.onGround).
type Point = (result?: Cesium.Cartesian3) => Cesium.Cartesian3;

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
            return this.finish(token, target, target.height, {
                status: "outOfSector",
                title: "OUTSIDE SECTOR",
                details: ["Radar does not point this way"],
                explanation: [
                    `This spot is at bearing ${azimuthDeg.toFixed(1)}° from the radar.`,
                    "No zone's sector points in that direction, so the radar never looks here."
                ]
            });
        }
        const inRange = inSector.filter(z => dist <= z.range);
        if (inRange.length === 0) {
            return this.finish(token, target, target.height, {
                status: "outOfRange",
                title: "OUT OF RANGE",
                details: [`${km(dist)} away, radar reaches ${km(maxRange)}`],
                explanation: [
                    `This spot is ${km(dist)} from the radar.`,
                    `The furthest zone only reaches ${km(maxRange)}, so the radar does not cover it at any height.`
                ]
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
        // The aircraft the coverage is worked out for, flying above the spot.
        const agl = geometry.targetHeightAgl;
        const targetHeight = heights[last] + agl;
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

        const targetDeg = Cesium.Math.toDegrees(targetAngle);
        const where = (zone: ResolvedZone) => `${km(dist)} away · ${zone.name}`;

        if (ridge > 0 && Math.tan(targetAngle) < horizon) {
            // Height above this spot's ground of the lowest beam that clears the hill.
            const lowestSeen = CesiumRadarCoverage.beamHeightAt(ridgeAngle, dist, geometry.radarHeight) - heights[last];
            const behind = dist - dists[ridge];
            const higherBy = heights[last] - heights[ridge];
            this.drawBlocked(geometry, azimuthDeg, dists[ridge], heights[ridge], ridgeAngle, dist, heights[last], agl);
            return this.finish(token, points[last], heights[last], {
                status: "blocked",
                title: `HIDDEN - higher ground ${km(dists[ridge])} away`,
                details: [`Seen here only above ${km(lowestSeen)}`],
                explanation: [
                    `Ground ${km(dists[ridge])} from the radar is in the way: it rises to ` +
                    `${Math.round(heights[ridge])} m, ${Math.round(heights[ridge] - geometry.radarHeight)} m ` +
                    `${heights[ridge] >= geometry.radarHeight ? "above" : "below"} the radar antenna (${Math.round(geometry.radarHeight)} m).`,
                    ...(geometry.radarHeight - heights[0] < 1
                        ? ["The antenna is at ground level (Mast Height 0), so even small rises near it hide what is behind them."]
                        : []),
                    // The spot can be higher than the hill top and still hidden:
                    // the beam climbs to get over the hill and keeps climbing.
                    `The ground here is ${Math.round(Math.abs(higherBy))} m ${higherBy > 0 ? "higher" : "lower"} ` +
                    `than that point and ${km(behind)} behind it.`,
                    `To get over it the beam must climb at least ${Cesium.Math.toDegrees(ridgeAngle).toFixed(1)}°, ` +
                    `so above this spot it only comes down to ${km(lowestSeen)} above the ground.`,
                    `An aircraft ${agl} m above the ground here is ${km(lowestSeen - agl)} too low to be seen. ` +
                    `Anything flying higher than ${km(lowestSeen)} would be detected.`,
                    `${km(dist)} from the radar, inside ${inRange[0].name}'s range.`
                ]
            }, false);
        }

        const litBy = inRange.find(z => targetDeg <= z.maxElevationDeg);
        if (!litBy) {
            this.drawRay(geometry, points[last], heights[last], agl, COLOR_GRAZING);
            return this.finish(token, points[last], heights[last], {
                status: "above",
                title: "TOO HIGH FOR THE BEAM",
                details: [`${targetDeg.toFixed(1)}° up, beam reaches ${Math.max(...inRange.map(z => z.maxElevationDeg))}°`],
                explanation: [
                    `No terrain blocks the line from the radar to an aircraft ${agl} m above this spot.`,
                    `But that aircraft is ${targetDeg.toFixed(1)}° up from the antenna (${km(dist)} away), ` +
                    `steeper than the beam goes. Zone by zone:`,
                    ...CesiumRadarCoverage.DEFAULT_3D_ZONES.map(config => {
                        const zone = geometry.zones.find(z => z.name === config.name);
                        if (!zone) return `${config.name}: turned off`;
                        if (!CesiumLosProbe.inSector(zone, azimuthDeg)) return `${zone.name}: not pointing this way`;
                        if (dist > zone.range) return `${zone.name}: reaches only ${km(zone.range)}`;
                        return `${zone.name}: beam only goes up to ${zone.maxElevationDeg}°`;
                    })
                ]
            }, false);
        }

        this.drawRay(geometry, points[last], heights[last], agl, COLOR_CLEAR);
        return this.finish(token, points[last], heights[last], {
            status: "visible",
            title: "VISIBLE",
            details: [where(litBy)],
            explanation: [
                `Nothing blocks the line from the radar to an aircraft ${agl} m above this spot.`,
                `It is ${targetDeg.toFixed(1)}° up from the antenna, inside ${litBy.name}'s beam ` +
                `(up to ${litBy.maxElevationDeg}°, ${km(litBy.range)} range).`,
                `${km(dist)} from the radar.`
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

    // Every point drawn on the terrain is re-read from the terrain Cesium is
    // showing right now (globe.getHeight), so at any zoom level the dots, the
    // hill marker and the line ends sit on the visible ground instead of
    // floating above it or sinking into it as coarser / finer tiles load.
    // The maths and the text always use the detailed sampled heights.
    private onGround(at: Cesium.Cartographic, sampledHeight: number, above = 0): Point {
        const globe = this.viewer.scene.globe;
        const c = new Cesium.Cartographic(at.longitude, at.latitude);
        return (result?: Cesium.Cartesian3) => {
            const shown = globe.getHeight(c);
            return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, (shown ?? sampledHeight) + above, undefined, result);
        };
    }

    private fixed(position: Cesium.Cartesian3): Point {
        return (result?: Cesium.Cartesian3) => Cesium.Cartesian3.clone(position, result);
    }

    private positionOf(point: Point): Cesium.PositionProperty {
        return new Cesium.CallbackPositionProperty((_time, result) => point(result), false);
    }

    // Clears the previous probe (unless the caller already drew this one's
    // lines) and puts the result label on the clicked spot, on the ground.
    private finish(
        token: number,
        target: Cesium.Cartographic,
        groundHeight: number,
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
            position: this.positionOf(this.onGround(target, groundHeight, GROUND_LIFT_M)),
            point: {
                pixelSize: 10,
                color,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
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
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        this.viewer.scene.requestRender();
        return result;
    }

    // The aircraft being checked: a small white dot `agl` metres above the
    // spot, joined to the ground by a thin vertical line.
    private drawAircraft(ground: Point, aircraft: Point, agl: number): void {
        if (agl <= 0) return;
        this.addLine([ground, aircraft], Cesium.Color.WHITE, true, 2);
        this.add({
            position: this.positionOf(aircraft),
            point: {
                pixelSize: 7,
                color: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 1,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }

    private drawBlocked(
        geometry: RadarGeometry,
        azimuthDeg: number,
        ridgeDist: number,
        ridgeHeight: number,
        ridgeAngle: number,
        targetDist: number,
        groundHeight: number,
        agl: number
    ): void {
        this.clearDrawn();

        const ridgeGround = CesiumRadarCoverage.groundPointAt(geometry, azimuthDeg, ridgeDist);
        const targetGround = CesiumRadarCoverage.groundPointAt(geometry, azimuthDeg, targetDist);
        const beamOverSpot = CesiumRadarCoverage.beamHeightAt(ridgeAngle, targetDist, geometry.radarHeight);

        const antenna = this.fixed(geometry.radarPosition);
        const ridgeTop = this.onGround(ridgeGround, ridgeHeight, GROUND_LIFT_M);
        // Where the lowest beam over the hill is, straight above the spot.
        const overSpot = this.fixed(Cesium.Cartesian3.fromRadians(targetGround.longitude, targetGround.latitude, beamOverSpot));
        const spotGround = this.onGround(targetGround, groundHeight, GROUND_LIFT_M);
        const aircraft = this.onGround(targetGround, groundHeight, agl);

        // Beam reaches the hill top...
        this.addLine([antenna, ridgeTop], COLOR_CLEAR, false);
        // ...grazes it and carries on over the spot...
        this.addLine([ridgeTop, overSpot], COLOR_GRAZING, true);
        // ...leaving everything below it (down to the aircraft / ground) hidden.
        this.addLine([overSpot, agl > 0 ? aircraft : spotGround], COLOR_BLOCKED, true);
        this.drawAircraft(spotGround, aircraft, agl);

        this.addTag(overSpot, `Beam ${km(beamOverSpot - groundHeight)} up`, COLOR_GRAZING, Cesium.VerticalOrigin.BOTTOM);

        this.add({
            position: this.positionOf(ridgeTop),
            point: {
                pixelSize: 11,
                color: COLOR_BLOCKED,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label: {
                text: "Blocking ground",
                font: "12px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: COLOR_BLOCKED.withAlpha(0.85),
                // Below the marker, so it never sits on the "lowest beam" tag above.
                verticalOrigin: Cesium.VerticalOrigin.TOP,
                pixelOffset: new Cesium.Cartesian2(0, 12),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    }

    // Straight ray from the antenna to the aircraft over the spot (or to the
    // ground when checking the ground itself).
    private drawRay(
        geometry: RadarGeometry,
        target: Cesium.Cartographic,
        groundHeight: number,
        agl: number,
        color: Cesium.Color
    ): void {
        this.clearDrawn();
        const spotGround = this.onGround(target, groundHeight, GROUND_LIFT_M);
        const aircraft = this.onGround(target, groundHeight, agl);
        this.addLine([this.fixed(geometry.radarPosition), agl > 0 ? aircraft : spotGround], color, false);
        this.drawAircraft(spotGround, aircraft, agl);
    }

    // Small coloured text tag, no marker.
    private addTag(
        position: Point,
        text: string,
        color: Cesium.Color,
        verticalOrigin = Cesium.VerticalOrigin.CENTER
    ): void {
        this.add({
            position: this.positionOf(position),
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

    private addLine(points: Point[], color: Cesium.Color, dashed: boolean, width?: number): void {
        const material = dashed
            ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 16 })
            : new Cesium.PolylineGlowMaterialProperty({ color, glowPower: 0.15 });
        this.add({
            polyline: {
                positions: new Cesium.CallbackProperty(() => points.map(p => p()), false),
                width: width ?? (dashed ? 3 : 6),
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
