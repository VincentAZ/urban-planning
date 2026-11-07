import { describe, expect, it } from "vitest";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture";
import type { TrafficVehicle } from "@urban/core";
import { assertTrafficEndpointEffects } from "./endpoint-effects.js";
const vehicle: TrafficVehicle = {
  id: "test",
  odId: "test",
  routeId: "test",
  vehicleClass: "passenger",
  departSeconds: 1,
  edges: ["in", "top", "topjoin", "out"],
  endpoints: {
    departLaneId: "in_0",
    departPositionMeters: 20,
    arrivalLaneId: "out_0",
    arrivalPositionMeters: 70,
  },
};
describe("paired native attachment effects", () => {
  it("accepts speed changes that retain exact lane attachments and leaves legacy vehicles unaffected", () => {
    const before = trafficNetworkFixture(),
      after = structuredClone(before);
    after.edges[0].lanes[0].speedMps = 5;
    expect(() =>
      assertTrafficEndpointEffects(before, after, [vehicle]),
    ).not.toThrow();
    after.edges = [];
    const { endpoints: _, ...legacy } = vehicle;
    expect(() =>
      assertTrafficEndpointEffects(before, after, [legacy]),
    ).not.toThrow();
  });
  it.each(["removal", "shape", "length", "class", "index"])(
    "rejects changed attachment %s",
    (kind) => {
      const before = trafficNetworkFixture(),
        after = structuredClone(before),
        lane = after.edges[0].lanes[0];
      if (kind === "removal") after.edges[0].lanes = [];
      if (kind === "shape") lane.shape[0][0] += 0.0001;
      if (kind === "length") lane.lengthMeters += 1;
      if (kind === "class") lane.allowedClasses = ["truck"];
      if (kind === "index") lane.index = 1;
      expect(() =>
        assertTrafficEndpointEffects(before, after, [vehicle]),
      ).toThrow(/removed or moved/);
    },
  );
});
