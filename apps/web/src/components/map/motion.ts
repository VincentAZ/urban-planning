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
  /** Centre [lon, lat, z] per vehicle. */
  positions: Float64Array;
  /** Heading in degrees, counter-clockwise from north. */
  angles: Float32Array;
  /** Two-point tail→head path per vehicle, drawn as a rounded car body. */
  paths: Float64Array;
  startIndices: Uint32Array;
  colors: Uint8Array;
}
const carLengthMeters = 4.5;
// Saturated paint so cars stand out against the light street surfaces.
const paint: [number, number, number][] = [
  [200, 58, 50], [32, 92, 160], [30, 36, 42],
  [232, 160, 30], [40, 130, 90], [120, 70, 150],
];
/** Playback opens 20 minutes into the period, once the roads have filled. */
const playbackStartSeconds = 1200;

export function createTrackBuffers(tracks: VehicleTracks | null): VehicleBuffers {
  const capacity = tracks?.vehicles.length ?? 0;
  return {
    count: 0,
    positions: new Float64Array(capacity * 3),
    angles: new Float32Array(capacity),
    paths: new Float64Array(capacity * 6),
    startIndices: Uint32Array.from({ length: capacity }, (_, i) => i * 2),
    colors: new Uint8Array(capacity * 4),
  };
}

/** Simulated clock for playback: loops the study period at playback seconds. */
export function simulatedSecond(tracks: VehicleTracks, playbackSeconds: number): number {
  const span = Math.max(tracks.stepSeconds, tracks.endSeconds - tracks.beginSeconds);
  const offset = playbackSeconds + Math.min(playbackStartSeconds, span / 2);
  return tracks.beginSeconds + (((offset % span) + span) % span);
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
    const lon = p[i * 2] + (p[j * 2] - p[i * 2]) * f;
    const lat = p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * f;
    buffers.positions[slot * 3] = lon;
    buffers.positions[slot * 3 + 1] = lat;
    buffers.positions[slot * 3 + 2] = 0.1;
    // Shortest-arc heading blend; SUMO headings run clockwise from north.
    const turn = ((vehicle.angle[j] - vehicle.angle[i] + 540) % 360) - 180;
    const heading = vehicle.angle[i] + turn * f;
    buffers.angles[slot] = -heading;
    const radians = (heading * Math.PI) / 180;
    const half = carLengthMeters / 2;
    const dLon = (Math.sin(radians) * half) / (111320 * Math.cos((lat * Math.PI) / 180));
    const dLat = (Math.cos(radians) * half) / 110574;
    buffers.paths.set([lon - dLon, lat - dLat, 0.1, lon + dLon, lat + dLat, 0.1], slot * 6);
    const [r, g, b] = paint[index % paint.length];
    buffers.colors.set([r, g, b, 255], slot * 4);
  }
}
