export const footways = new Set([
  "footway", "path", "pedestrian", "cycleway", "steps", "track",
]);

/** Executed SUMO floating-car positions written by scripts/traffic-worker.py
 * as `{side}-tracks.json`. Each segment samples lon/lat and heading (degrees
 * clockwise from north) every `stepSeconds` from `t0`.
 */
export interface VehicleTracks {
  version: 1;
  side: "baseline" | "proposal";
  beginSeconds: number;
  endSeconds: number;
  stepSeconds: number;
  vehicles: { id: string; t0: number; lonlat: number[]; angle: number[] }[];
}
export interface VehicleBuffers {
  /** Vehicles on the road at the current simulated second. */
  count: number;
  positions: Float64Array;
  angles: Float32Array;
  icons: string[];
}

export function createTrackBuffers(tracks: VehicleTracks | null): VehicleBuffers {
  const capacity = tracks?.vehicles.length ?? 0;
  return {
    count: 0,
    positions: new Float64Array(capacity * 3),
    angles: new Float32Array(capacity),
    icons: new Array<string>(capacity).fill("0"),
  };
}

/** Simulated clock for playback: loops the study period at playback seconds. */
export function simulatedSecond(tracks: VehicleTracks, playbackSeconds: number): number {
  const span = Math.max(tracks.stepSeconds, tracks.endSeconds - tracks.beginSeconds);
  return tracks.beginSeconds + (((playbackSeconds % span) + span) % span);
}

/** Packs the vehicles present at `playbackSeconds` into the front of the
 * buffers, interpolating between the executed SUMO samples.
 */
export function updateTrackBuffers(
  buffers: VehicleBuffers,
  tracks: VehicleTracks | null,
  playbackSeconds: number,
): void {
  buffers.count = 0;
  if (!tracks) return;
  const t = simulatedSecond(tracks, playbackSeconds);
  for (let index = 0; index < tracks.vehicles.length; index++) {
    const vehicle = tracks.vehicles[index];
    const k = (t - vehicle.t0) / tracks.stepSeconds;
    const last = vehicle.angle.length - 1;
    if (k < 0 || k > last) continue;
    const i = Math.min(Math.floor(k), Math.max(0, last - 1));
    const f = last ? k - i : 0;
    const j = Math.min(i + 1, last);
    const slot = buffers.count++;
    const p = vehicle.lonlat;
    buffers.positions[slot * 3] = p[i * 2] + (p[j * 2] - p[i * 2]) * f;
    buffers.positions[slot * 3 + 1] = p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * f;
    buffers.positions[slot * 3 + 2] = 0.1;
    // Shortest-arc heading blend; deck.gl angles run counter-clockwise.
    const turn = ((vehicle.angle[j] - vehicle.angle[i] + 540) % 360) - 180;
    buffers.angles[slot] = -(vehicle.angle[i] + turn * f);
    buffers.icons[slot] = String(index % 6);
  }
}
