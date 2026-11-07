import type { Position, Road } from "@urban/core";

export const footways = new Set([
  "footway", "path", "pedestrian", "cycleway", "steps", "track",
]);
interface Junction {
  position: Position;
  exits: RoadEdge[];
  entrances: RoadEdge[];
}
export interface RoadEdge {
  road: Road;
  from: Junction;
  to: Junction;
  length: number;
  reverse: boolean;
  opposite?: RoadEdge;
}
export interface Agent {
  edge: RoadEdge;
  /** Metres from the start of the current directed edge. */
  offset: number;
  icon: string;
  turnSeed: number;
}
export interface VehicleBuffers {
  count: number;
  positions: Float64Array;
  angles: Float32Array;
  icons: string[];
  seconds?: number;
}
const metresPerLat = 110574;
export function distance(a: Position, b: Position): number {
  return Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos(((a[1] + b[1]) * Math.PI) / 360),
    (a[1] - b[1]) * metresPerLat,
  );
}

/** Shared source vertices are junctions, including vertices inside a road.
 * Geometric crossings without a shared vertex stay separate (e.g. overpasses).
 */
function roamingNetwork(roads: Road[]) {
  const junctions = new Map<string, Junction>();
  const junction = (position: Position): Junction => {
    const key = `${position[0].toFixed(7)},${position[1].toFixed(7)}`;
    let node = junctions.get(key);
    if (!node) {
      node = { position, exits: [], entrances: [] };
      junctions.set(key, node);
    }
    return node;
  };
  const network = roads
    .filter((road) => !road.closed && !footways.has(road.kind))
    .map((road) => {
      const edges: RoadEdge[] = [];
      for (let i = 1; i < road.coordinates.length; i++) {
        const from = junction(road.coordinates[i - 1]);
        const to = junction(road.coordinates[i]);
        const length = distance(from.position, to.position);
        if (length < 0.05) continue;
        const forward: RoadEdge = { road, from, to, length, reverse: false };
        from.exits.push(forward);
        to.entrances.push(forward);
        edges.push(forward);
        if (!road.oneWay) {
          const backward: RoadEdge = { road, from: to, to: from, length, reverse: true, opposite: forward };
          forward.opposite = backward;
          to.exits.push(backward);
          from.entrances.push(backward);
          edges.push(backward);
        }
      }
      return { road, edges };
    });

  // Remove directed routes that terminate without a legal continuation. Cars
  // can U-turn on two-way dead ends; they never teleport off a one-way outlet.
  const remaining = new Map([...junctions.values()].map((node) => [node, node.exits.length]));
  const queue = [...junctions.values()].filter((node) => !node.exits.length);
  for (let i = 0; i < queue.length; i++) {
    for (const edge of queue[i].entrances) {
      const count = remaining.get(edge.from)! - 1;
      remaining.set(edge.from, count);
      if (count === 0) queue.push(edge.from);
    }
  }
  for (const node of junctions.values())
    node.exits = node.exits.filter((edge) => remaining.get(edge.to)! > 0);
  return network.map(({ road, edges }) => {
    const open = edges.filter((edge) => remaining.get(edge.to)! > 0);
    const length = open.reduce((sum, edge) => sum + edge.length, 0);
    const physicalLength = length / (road.oneWay ? 1 : 2);
    return { edges: open, length, count: physicalLength < 25 ? 0 : Math.min(12, Math.ceil(physicalLength / 30)) };
  });
}

export function createAgents(roads: Road[], vehicleMultiplier: number): Agent[] {
  if (!Number.isFinite(vehicleMultiplier) || vehicleMultiplier <= 0) return [];
  const network = roamingNetwork(roads);
  // Sample the entire network, leaving headroom above the default density.
  const total = network.reduce((sum, segment) => sum + segment.count, 0);
  const budget = Math.min(650, total);
  if (!budget) return [];
  const agents: Agent[] = [];
  let ordinal = 0;
  for (let index = 0; index < network.length; index++) {
    const { edges, length, count } = network[index];
    for (let n = 0; n < count; n++, ordinal++) {
      if (ordinal !== Math.floor(agents.length * total / budget)) continue;
      let offset = ((index * 0.61803398875 + n / count) % 1) * length;
      let edgeIndex = 0;
      while (edgeIndex < edges.length - 1 && offset >= edges[edgeIndex].length)
        offset -= edges[edgeIndex++].length;
      agents.push({
        edge: edges[edgeIndex], offset,
        icon: String((index + n) % 6),
        turnSeed: (index * 7919 + n * 104729 + 1) >>> 0,
      });
      if (agents.length === budget) return sampleAgents(spreadAgents(agents), vehicleMultiplier);
    }
  }
  return sampleAgents(spreadAgents(agents), vehicleMultiplier);
}

// Bit-reversed ordering makes every prefix cover the network. Adding cars then
// retains the existing objects, positions and routes instead of respawning them.
function spreadAgents(agents: Agent[]): Agent[] {
  const rank = (index: number) => {
    let reversed = 0;
    for (let bit = 0; bit < 10; bit++) {
      reversed = (reversed << 1) | (index & 1);
      index >>>= 1;
    }
    return reversed;
  };
  return agents.map((agent, index) => ({ agent, rank: rank(index) }))
    .sort((a, b) => a.rank - b.rank).map(({ agent }) => agent);
}
export function sampleAgents(pool: Agent[], multiplier: number): Agent[] {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return [];
  return pool.slice(0, Math.ceil(pool.length * Math.min(3, multiplier) / 3));
}
export function createVehicleBuffers(agents: Agent[]): VehicleBuffers {
  return {
    count: agents.length,
    positions: new Float64Array(agents.length * 3),
    angles: new Float32Array(agents.length),
    icons: agents.map((agent) => agent.icon),
  };
}

function nextEdge(agent: Agent): RoadEdge {
  const exits = agent.edge.to.exits;
  // Prefer continuing through a junction; reverse only at a two-way dead end.
  const alternatives = exits.length - (exits.includes(agent.edge.opposite!) ? 1 : 0);
  if (!alternatives) return agent.edge.opposite!;
  let seed = agent.turnSeed;
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  agent.turnSeed = seed >>> 0;
  let choice = agent.turnSeed % alternatives;
  for (const edge of exits) {
    if (edge === agent.edge.opposite) continue;
    if (choice-- === 0) return edge;
  }
  return exits[0];
}

/** Persistent agents carry unused travel time through junctions. No wrapping,
 * respawning, or geometry allocation occurs on animation ticks.
 */
export function updateVehicleBuffers(buffers: VehicleBuffers, agents: Agent[], seconds: number): void {
  const elapsed = Math.max(0, seconds - (buffers.seconds ?? seconds));
  buffers.seconds = seconds;
  for (let index = 0; index < agents.length; index++) {
    const agent = agents[index];
    let remaining = elapsed;
    while (remaining > 0) {
      const speed = Math.min(11, Math.max(0, agent.edge.road.speedMph) * 0.44704);
      if (!speed) break;
      const timeToEnd = (agent.edge.length - agent.offset) / speed;
      if (remaining < timeToEnd) {
        agent.offset += remaining * speed;
        break;
      }
      remaining -= timeToEnd;
      agent.edge = nextEdge(agent);
      agent.offset = 0;
    }
    const { from, to, length } = agent.edge;
    const fraction = agent.offset / length;
    const offset = index * 3;
    // Use the exact rendered road centerline. Lane offsets and minimum pixel
    // sizes can push cars onto sidewalks on narrow streets or at wide zooms.
    buffers.positions[offset] = from.position[0] + (to.position[0] - from.position[0]) * fraction;
    buffers.positions[offset + 1] = from.position[1] + (to.position[1] - from.position[1]) * fraction;
    buffers.positions[offset + 2] = 0.1;
    const dx = (to.position[0] - from.position[0]) * 111320 * Math.cos((from.position[1] * Math.PI) / 180);
    const dy = (to.position[1] - from.position[1]) * metresPerLat;
    buffers.angles[index] = Math.atan2(-dx, dy) * 180 / Math.PI;
  }
}
