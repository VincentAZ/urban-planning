import type { TrafficOverlay, TrafficSignalTiming } from "@urban/core";
import { SUMO_IMAGE } from "./types.js";
/** Deterministic preimage shared by runtime and immutable archive verification. */
export function trafficNativeSettings(input: {
  workerSha256: string;
  overlays: TrafficOverlay[];
  signalTimings?: TrafficSignalTiming[];
  submittedVehiclesHash: string;
  mappedCountsHash: string;
  explicitEndpoints?: boolean;
}) {
  return {
    version: 1,
    image: SUMO_IMAGE,
    workerSha256: input.workerSha256,
    stepSeconds: 1,
    precision: 6,
    teleportSeconds: -1,
    maximumDepartureDelay: -1,
    collisionAction: "warn",
    departureLane: "best",
    departureSpeed: "max",
    ...(input.explicitEndpoints
      ? { endpointPolicy: "explicit-native-lanes-and-front-positions" }
      : {}),
    routePolicy: "fixed-paths-with-closed-path-OD-repair",
    detectorPolicy: "e1-completed-passages-exact-interval-gcd",
    overlays: input.overlays,
    ...(input.signalTimings !== undefined
      ? { signalTimings: input.signalTimings }
      : {}),
    submittedVehiclesHash: input.submittedVehiclesHash,
    mappedCountsHash: input.mappedCountsHash,
  };
}
