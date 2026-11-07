import { describe, expect, it } from "vitest";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture";
import { trafficCountReviewBounds } from "./traffic-count-map";

describe("count review map framing", () => {
  it("includes every selected lane and the supplied distant point without moving either", () => {
    const network = trafficNetworkFixture();
    network.edges[0].lanes.push({
      ...structuredClone(network.edges[0].lanes[0]),
      id: "in_1",
      shape: [
        [-112.006, 33.002],
        [-112.003, 33.003],
      ],
    });
    const counts = [{ position: [-112.01, 32.99] as [number, number] }];
    const before = structuredClone({ network, counts });
    expect(trafficCountReviewBounds(network, counts, "in")).toEqual([
      -112.01, 32.99, -112.003, 33.003,
    ]);
    expect({ network, counts }).toEqual(before);
  });
  it("includes both reviewed turn edges without extending to unrelated ports or the full graph", () => {
    const network = trafficNetworkFixture();
    expect(trafficCountReviewBounds(network, [], "in", ["in", "top"])).toEqual([
      -112.005, 33, -112.003, 33.001,
    ]);
  });
  it("frames an unmapped source point locally and never invents a point for missing geometry", () => {
    const network = trafficNetworkFixture();
    expect(
      trafficCountReviewBounds(network, [{ position: [-112, 33] }], null),
    ).toEqual([-112, 33, -112, 33]);
    expect(
      trafficCountReviewBounds(network, [{ position: null }], null),
    ).toBeNull();
    expect(
      trafficCountReviewBounds(network, [{ position: null }], "absent"),
    ).toBeNull();
    expect(
      trafficCountReviewBounds(network, [{ position: null }], "in"),
    ).toEqual([-112.005, 33, -112.004, 33]);
  });
});
