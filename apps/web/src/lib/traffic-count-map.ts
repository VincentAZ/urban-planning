import type { TrafficCount, TrafficNetwork } from "@urban/core";

/** Display framing only: complete selected lane geometry plus supplied points. No snap or detector interpolation. */
export function trafficCountReviewBounds(
  network: TrafficNetwork,
  counts: readonly Pick<TrafficCount, "position">[],
  selectedEdgeId: string | null,
  reviewedEdgeIds: readonly string[] = [],
): [number, number, number, number] | null {
  const ids = new Set([
    ...reviewedEdgeIds,
    ...(selectedEdgeId ? [selectedEdgeId] : []),
  ]);
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  function add(position: readonly number[]) {
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  for (const edge of network.edges)
    if (ids.has(edge.id))
      for (const lane of edge.lanes)
        for (const position of lane.shape) add(position);
  for (const count of counts) if (count.position) add(count.position);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}
