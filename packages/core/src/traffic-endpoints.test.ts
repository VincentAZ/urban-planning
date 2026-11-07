import { describe, expect, it } from "vitest";
import {
  trafficContentHash,
  trafficDemandSchema,
  validateTrafficDemand,
  type TrafficRouteEndpoints,
} from "./index";
import {
  trafficDemandFixture,
  trafficNetworkFixture,
  trafficFixturePeriod,
} from "./traffic-fixture";

const endpoints: TrafficRouteEndpoints = {
  departLaneId: "in_0",
  departPositionMeters: 35.125,
  arrivalLaneId: "out_0",
  arrivalPositionMeters: 62.75,
};
describe("exact native demand attachments", () => {
  it("retains optional positions and fractional local entry times in the immutable identity", async () => {
    const original = trafficDemandFixture(),
      demand = structuredClone(original);
    demand.rows[0].endpoints = endpoints;
    demand.rows[0].beginSeconds += 12.125;
    expect(() =>
      validateTrafficDemand(
        demand,
        trafficNetworkFixture(),
        trafficFixturePeriod,
      ),
    ).not.toThrow();
    expect(trafficDemandSchema.parse(demand)).toEqual(demand);
    expect(await trafficContentHash(demand)).not.toBe(
      await trafficContentHash(original),
    );
    expect(trafficDemandSchema.parse(original).rows[0]).not.toHaveProperty(
      "endpoints",
    );
  });
  it.each([
    { departLaneId: "out_0" },
    { arrivalLaneId: "in_0" },
    { departPositionMeters: -1 },
    { arrivalPositionMeters: NaN },
    { departPositionMeters: 100 },
    { arrivalPositionMeters: 100.001 },
  ])("rejects an invalid endpoint without clamping: %j", (change) => {
    const demand = trafficDemandFixture();
    demand.rows[0].endpoints = { ...endpoints, ...change };
    expect(() =>
      validateTrafficDemand(demand, trafficNetworkFixture()),
    ).toThrow();
  });
  it("checks the actual attachment lane's class permission", () => {
    const demand = trafficDemandFixture(),
      network = trafficNetworkFixture();
    demand.rows[0].endpoints = endpoints;
    network.edges[0].lanes.push({
      ...network.edges[0].lanes[0],
      id: "in_1",
      index: 1,
    });
    network.edges[0].lanes[0].allowedClasses = ["truck"];
    expect(() => validateTrafficDemand(demand, network)).toThrow(
      /permitted lanes/,
    );
  });
  it("allows positive single-edge travel and rejects same-edge backwards attachments", () => {
    const demand = trafficDemandFixture(),
      network = trafficNetworkFixture();
    demand.rows[0].destinationEdge = "in";
    demand.rows[0].endpoints = { ...endpoints, arrivalLaneId: "in_0" };
    demand.candidateRoutes = [{ ...demand.candidateRoutes[0], edges: ["in"] }];
    expect(() => validateTrafficDemand(demand, network)).not.toThrow();
    demand.rows[0].endpoints.arrivalPositionMeters = 35.125;
    expect(() => validateTrafficDemand(demand, network)).toThrow(
      /forward travel/,
    );
  });
});
