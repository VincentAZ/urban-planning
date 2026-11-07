import type { Position, Road } from "@urban/core";

export const footways = new Set([
  "footway",
  "path",
  "pedestrian",
  "cycleway",
  "steps",
  "track",
]);
export type Agent = {
  road: Road;
  distances: number[];
  length: number;
  offset: number;
  reverse: boolean;
  color: [number, number, number, number];
};
export interface VehicleBuffers {
  count: number;
  startIndices: Uint32Array;
  positions: Float64Array;
  colors: Uint8Array;
}
const agentColors: [number, number, number, number][] = [
  [246, 242, 221, 255],
  [62, 103, 99, 255],
  [212, 136, 91, 255],
  [100, 116, 129, 255],
  [225, 184, 89, 255],
  [250, 249, 242, 255],
];
const metresPerLat = 110574;
export function distance(a: Position, b: Position): number {
  return Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos(((a[1] + b[1]) * Math.PI) / 360),
    (a[1] - b[1]) * metresPerLat,
  );
}
export function createAgents(
  roads: Road[],
  vehicleMultiplier: number,
): Agent[] {
  if (!Number.isFinite(vehicleMultiplier) || vehicleMultiplier <= 0) return [];
  const eligible = roads.filter(
    (r) => !r.closed && !footways.has(r.kind) && r.coordinates.length > 1,
  );
  const agents: Agent[] = [];
  for (let index = 0; index < eligible.length; index++) {
    const road = eligible[index];
    const distances = [0];
    for (let i = 1; i < road.coordinates.length; i++)
      distances.push(
        distances[i - 1] +
          distance(road.coordinates[i - 1], road.coordinates[i]),
      );
    const length = distances[distances.length - 1];
    if (length < 25) continue;
    const count = Math.min(
      12,
      Math.ceil((length / 90) * Math.min(3, vehicleMultiplier)),
    );
    for (let n = 0; n < count; n++) {
      if (agents.length >= 650) return agents;
      agents.push({
        road,
        distances,
        length,
        offset: ((index * 0.61803398875 + n / count) % 1) * length,
        reverse: !road.oneWay && n % 2 === 1,
        color: agentColors[(index + n) % agentColors.length],
      });
    }
  }
  return agents;
}
export function createVehicleBuffers(agents: Agent[]): VehicleBuffers {
  const count = agents.length;
  const startIndices = new Uint32Array(count + 1),
    positions = new Float64Array(count * 6),
    colors = new Uint8Array(count * 8);
  for (let i = 0; i < count; i++) {
    startIndices[i] = i * 2;
    colors.set(agents[i].color, i * 8);
    colors.set(agents[i].color, i * 8 + 4);
  }
  startIndices[count] = count * 2;
  return { count, startIndices, positions, colors };
}
function interpolateInto(
  agent: Agent,
  travelled: number,
  output: Float64Array,
  offset: number,
): void {
  const target = Math.max(0, Math.min(agent.length, travelled));
  let i = 1;
  while (i < agent.distances.length - 1 && agent.distances[i] < target) i++;
  const a = agent.road.coordinates[i - 1],
    b = agent.road.coordinates[i];
  const frac =
    (target - agent.distances[i - 1]) /
    (agent.distances[i] - agent.distances[i - 1] || 1);
  output[offset] = a[0] + (b[0] - a[0]) * frac;
  output[offset + 1] = a[1] + (b[1] - a[1]) * frac;
  output[offset + 2] = 0.22;
}
/** Mutate stable typed buffers: no path arrays or color arrays allocated on animation ticks. */
export function updateVehicleBuffers(
  buffers: VehicleBuffers,
  agents: Agent[],
  seconds: number,
): void {
  for (let index = 0; index < agents.length; index++) {
    const agent = agents[index],
      offset = index * 6;
    const travelled =
      (agent.offset +
        seconds * Math.min(11, Math.max(0, agent.road.speedMph) * 0.44704)) %
      agent.length;
    const start = agent.reverse ? agent.length - travelled : travelled;
    interpolateInto(agent, start, buffers.positions, offset);
    interpolateInto(
      agent,
      start + (agent.reverse ? -4 : 4),
      buffers.positions,
      offset + 3,
    );
    const dx = buffers.positions[offset + 3] - buffers.positions[offset],
      dy = buffers.positions[offset + 4] - buffers.positions[offset + 1],
      len = Math.hypot(dx, dy) || 1;
    const latOffset = ((dx / len) * 1.6) / metresPerLat;
    const lngOffset =
      ((-dy / len) * 1.6) /
      (111320 * Math.cos((buffers.positions[offset + 1] * Math.PI) / 180));
    buffers.positions[offset] += lngOffset;
    buffers.positions[offset + 3] += lngOffset;
    buffers.positions[offset + 1] += latOffset;
    buffers.positions[offset + 4] += latOffset;
  }
}
