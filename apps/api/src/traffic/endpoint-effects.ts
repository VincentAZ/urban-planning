import {
  validateTrafficRouteEndpoints,
  type TrafficNetwork,
  type TrafficVehicle,
} from "@urban/core";
import { ApiError } from "../errors.js";

/** A proposal may not silently move a source-derived native attachment. */
export function assertTrafficEndpointEffects(
  baseline: TrafficNetwork,
  proposal: TrafficNetwork,
  vehicles: readonly TrafficVehicle[],
): void {
  const before = new Map(baseline.edges.map((edge) => [edge.id, edge]));
  const after = new Map(proposal.edges.map((edge) => [edge.id, edge]));
  const checked = new Set<string>();
  const fail = (detail = "") => {
    throw new ApiError(
      422,
      "TRAFFIC_ENDPOINT_CHANGED",
      `A native control removed or moved an explicit route attachment. Review the demand endpoints before running this proposal.${detail ? ` ${detail}` : ""}`,
    );
  };
  for (const vehicle of vehicles) {
    const endpoints = vehicle.endpoints;
    if (!endpoints) continue;
    try {
      validateTrafficRouteEndpoints(
        endpoints,
        before,
        vehicle.edges[0],
        vehicle.edges.at(-1)!,
        vehicle.vehicleClass,
        vehicle.edges.length === 1,
      );
      validateTrafficRouteEndpoints(
        endpoints,
        after,
        vehicle.edges[0],
        vehicle.edges.at(-1)!,
        vehicle.vehicleClass,
        vehicle.edges.length === 1,
      );
    } catch {
      fail();
    }
    for (const [edgeId, laneId] of [
      [vehicle.edges[0], endpoints.departLaneId],
      [vehicle.edges.at(-1)!, endpoints.arrivalLaneId],
    ]) {
      if (checked.has(laneId)) continue;
      checked.add(laneId);
      const original = before
        .get(edgeId)!
        .lanes.find((lane) => lane.id === laneId)!;
      const actual = after
        .get(edgeId)!
        .lanes.find((lane) => lane.id === laneId)!;
      // Native XML is serialized to six decimals; geographic inventory values
      // can differ at sub-centimetre scale after netconvert round trips.
      if (original.index !== actual.index) fail("The lane index changed.");
      if (Math.abs(original.lengthMeters - actual.lengthMeters) > 0.000001)
        fail(
          `The native lane length changed by ${Math.abs(original.lengthMeters - actual.lengthMeters)} m.`,
        );
      if (
        original.shape.length !== actual.shape.length ||
        original.shape.some((point, index) =>
          point.some(
            (value, axis) => Math.abs(value - actual.shape[index][axis]) > 1e-8,
          ),
        )
      )
        fail("The native lane geometry changed.");
    }
  }
}
