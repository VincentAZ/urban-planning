import type {
  TrafficDemand,
  TrafficNetwork,
  TrafficPeriod,
  Source,
} from "@urban/core";

/** Demo shortcut: synthetic rush-hour demand for a one-click run.
 *
 * Picks random passenger-car origins in the network, routes each to several
 * random reachable destinations by fastest free-flow time over the native
 * connections, and spreads one vehicle per trip across the period. This is
 * an authored, disclosed assumption, not observed or calibrated demand.
 */
export function quickTrafficDemand(
  network: TrafficNetwork,
  period: TrafficPeriod,
  source: Source,
  options: {
    trips?: number;
    seed?: number;
    /** Edge pairs no car may use (from the API's native connection check). */
    prohibited?: [string, string][];
    /** [west, south, east, north]: trips start and end inside, so the
     * study area itself is busy rather than the external buffer. */
    bounds?: [number, number, number, number];
  } = {},
): TrafficDemand {
  const trips = options.trips ?? 2000;
  let seed = (options.seed ?? 42) >>> 0 || 1;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const car = network.edges.filter((edge) =>
    edge.lanes.some((lane) => lane.allowedClasses.includes("passenger")),
  );
  const index = new Map(car.map((edge, i) => [edge.id, i]));
  const cost = car.map((edge) => {
    const lane = edge.lanes[0];
    return lane.lengthMeters / Math.max(1, lane.speedMps);
  });
  const length = car.map((edge) => edge.lanes[0].lengthMeters);
  const laneClasses = new Map(
    network.edges.flatMap((e) => e.lanes.map((l) => [l.id, l.allowedClasses] as const)),
  );
  const prohibited = new Set(
    (options.prohibited ?? []).map(([from, to]) => `${from}\0${to}`),
  );
  const next: number[][] = car.map(() => []);
  for (const c of network.connections) {
    const from = index.get(c.fromEdge),
      to = index.get(c.toEdge);
    if (from === undefined || to === undefined || from === to) continue;
    if (prohibited.has(`${c.fromEdge}\0${c.toEdge}`)) continue;
    if (
      laneClasses.get(c.fromLane)?.includes("passenger") &&
      laneClasses.get(c.toLane)?.includes("passenger") &&
      !next[from].includes(to)
    )
      next[from].push(to);
  }
  const inside = (i: number) => {
    if (!options.bounds) return true;
    const shape = car[i].lanes[0].shape;
    const [x, y] = shape[Math.floor(shape.length / 2)];
    const [w, s, e, n] = options.bounds;
    return x >= w && x <= e && y >= s && y <= n;
  };
  const candidates = car
    .map((_, i) => i)
    .filter((i) => length[i] >= 30 && next[i].length && inside(i));

  const rows: TrafficDemand["rows"] = [];
  const candidateRoutes: TrafficDemand["candidateRoutes"] = [];
  const begin = period.beginSeconds - period.warmupSeconds;
  const span = period.endSeconds - begin;
  const perOrigin = 15;
  for (let attempt = 0; rows.length < trips && attempt < trips; attempt++) {
    const origin = candidates[Math.floor(random() * candidates.length)];
    // Each origin sees randomly perturbed (±50%) street times, so trips spread
    // across the grid instead of all piling onto the same fastest arterial.
    const perceived = cost.map((c) => c * (0.5 + random()));
    const { time, previous } = fastest(origin, next, perceived);
    const reachable = candidates.filter(
      (i) => i !== origin && time[i] >= 60 && time[i] <= 480,
    );
    for (let k = 0; k < perOrigin && reachable.length && rows.length < trips; k++) {
      const destination = reachable[Math.floor(random() * reachable.length)];
      const path: number[] = [];
      for (let at = destination; at !== -1; at = previous[at]) path.push(at);
      path.reverse();
      const id = `quick-${rows.length + 1}`;
      // A short departure window per trip spreads load over the whole period.
      const depart = begin + Math.floor(random() * (span - 60));
      rows.push({
        id,
        originEdge: car[origin].id,
        destinationEdge: car[destination].id,
        beginSeconds: depart,
        endSeconds: depart + 60,
        vehicleClass: "passenger",
        vehicles: 1,
        purpose: "unspecified",
        quality: "authored",
        sourceIds: [source.id],
      });
      candidateRoutes.push({
        id: `${id}-route`,
        odId: id,
        edges: path.map((i) => car[i].id),
        weight: 1,
        sourceIds: [source.id],
      });
    }
  }
  return {
    version: 1,
    rows,
    candidateRoutes,
    sources: [
      {
        ...source,
        description:
          `Quick-run demand: ${rows.length} synthetic car trips between random street segments in the study area, each on a fast route chosen with randomly varied street preferences, departing evenly across the period. An authored assumption, not observed or calibrated demand.`,
      },
    ],
    notes: [
      `Quick-run synthetic demand: ${rows.length} authored car trips (1–8 minute routes with randomly varied street preferences, between random street segments in the study area). Not an observed OD survey or calibrated forecast.`,
    ],
  };
}

function fastest(origin: number, next: number[][], cost: number[]) {
  const time = new Float64Array(next.length).fill(Infinity);
  const previous = new Int32Array(next.length).fill(-1);
  time[origin] = 0;
  // Binary heap of [time, edge].
  const heap: [number, number][] = [[0, origin]];
  const push = (item: [number, number]) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [t, at] = pop();
    if (t > time[at] || t > 480) continue;
    for (const to of next[at]) {
      const candidate = t + cost[to];
      if (candidate < time[to]) {
        time[to] = candidate;
        previous[to] = at;
        push([candidate, to]);
      }
    }
  }
  return { time, previous };
}
