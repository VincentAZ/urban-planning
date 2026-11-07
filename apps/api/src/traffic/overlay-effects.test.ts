import { describe, expect, it } from "vitest";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture";
import { assertTrafficOverlayEffects } from "./overlay-effects.js";

describe("executed native control verification", () => {
  it("accepts unchanged networks and an explicitly requested fractional speed", () => {
    const baseline = trafficNetworkFixture();
    const proposal = structuredClone(baseline);
    assertTrafficOverlayEffects(baseline, proposal, []);
    proposal.edges[0].lanes[0].speedMps = 11.176;
    assertTrafficOverlayEffects(baseline, proposal, [
      { edgeId: "in", speedMps: 25 * 0.44704 },
    ]);
  });
  it("rejects a patch accepted without its requested speed or lanes", () => {
    const baseline = trafficNetworkFixture();
    expect(() =>
      assertTrafficOverlayEffects(baseline, baseline, [
        { edgeId: "in", speedMps: 11.176 },
      ]),
    ).toThrow("executed speed");
    expect(() =>
      assertTrafficOverlayEffects(baseline, baseline, [
        { edgeId: "in", lanes: 2 },
      ]),
    ).toThrow("executed lane count");
  });
  it("checks every lane and retains six-decimal speed precision", () => {
    const baseline = trafficNetworkFixture();
    const proposal = structuredClone(baseline);
    proposal.edges[0].lanes.push({
      ...proposal.edges[0].lanes[0],
      id: "in_1",
      index: 1,
    });
    const overlay = [{ edgeId: "in", lanes: 2, speedMps: 11.176 }];
    proposal.edges[0].lanes[0].speedMps = 11.176;
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, overlay),
    ).toThrow("executed speed");
    proposal.edges[0].lanes[1].speedMps = 11.18;
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, overlay),
    ).toThrow("executed speed");
    assertTrafficOverlayEffects(baseline, proposal, overlay, 2);
    proposal.edges[0].lanes[1].speedMps = 11.176;
    assertTrafficOverlayEffects(baseline, proposal, overlay);
  });
  it("requires actual closure and rejects unrelated disappearance", () => {
    const baseline = trafficNetworkFixture();
    const proposal = structuredClone(baseline);
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, [
        { edgeId: "top", closed: true },
      ]),
    ).toThrow("closure remained");
    proposal.edges = proposal.edges.filter((edge) => edge.id !== "top");
    assertTrafficOverlayEffects(baseline, proposal, [
      { edgeId: "top", closed: true },
    ]);
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, [
        { edgeId: "in", closed: false },
      ]),
    ).toThrow("removed an undeclared");
  });
  it("does not credit a removed edge with lane or speed settings", () => {
    const baseline = trafficNetworkFixture();
    for (const property of [{ lanes: 2 }, { speedMps: 4 }])
      expect(() =>
        assertTrafficOverlayEffects(baseline, baseline, [
          { edgeId: "top", closed: true, ...property },
        ]),
      ).toThrow("cannot also represent");
  });
  it("keeps existing and inherited speeds when only a lane count changes", () => {
    const baseline = trafficNetworkFixture();
    const proposal = structuredClone(baseline);
    proposal.edges[0].lanes.push({
      ...proposal.edges[0].lanes[0],
      id: "in_1",
      index: 1,
    });
    const controls = [{ edgeId: "in", lanes: 2 }];
    assertTrafficOverlayEffects(baseline, proposal, controls);
    proposal.edges[0].lanes[1].speedMps = 12;
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, controls),
    ).toThrow("speed without");
    proposal.edges[0].lanes[1].speedMps = 10;
    proposal.edges[0].lanes[0].speedMps = 12;
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, controls),
    ).toThrow("speed without");
  });
  it("rejects changed access permissions on surviving or newly added lanes", () => {
    const baseline = trafficNetworkFixture();
    const proposal = structuredClone(baseline);
    proposal.edges[0].lanes[0].allowedClasses = ["bus"];
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, [
        { edgeId: "in", speedMps: 10 },
      ]),
    ).toThrow("access permissions");
    proposal.edges[0].lanes[0].allowedClasses = ["truck", "passenger"];
    assertTrafficOverlayEffects(baseline, proposal, [
      { edgeId: "in", speedMps: 10 },
    ]);
    proposal.edges[0].lanes.push({
      ...proposal.edges[0].lanes[0],
      id: "in_1",
      index: 1,
      allowedClasses: ["bus"],
    });
    expect(() =>
      assertTrafficOverlayEffects(baseline, proposal, [
        { edgeId: "in", lanes: 2 },
      ]),
    ).toThrow("access permissions");
  });
  it("requires the identical topology and graph hash when no controls were requested", () => {
    const baseline = trafficNetworkFixture();
    for (const mutate of [
      (network: typeof baseline) => {
        network.manifest.networkFileSha256 = "f".repeat(64);
      },
      (network: typeof baseline) => {
        network.nodes[0].position[0] += 0.001;
      },
      (network: typeof baseline) => {
        network.edges[0].lanes[0].lengthMeters++;
      },
      (network: typeof baseline) => {
        network.edges[0].lanes[0].allowedClasses = ["bus"];
      },
      (network: typeof baseline) => {
        network.connections.pop();
      },
      (network: typeof baseline) => {
        network.signals[0].offsetSeconds++;
      },
    ]) {
      const proposal = structuredClone(baseline);
      mutate(proposal);
      expect(() => assertTrafficOverlayEffects(baseline, proposal, [])).toThrow(
        "exact baseline graph",
      );
    }
  });
  it("rejects undeclared speed, lane, direction and graph changes", () => {
    const baseline = trafficNetworkFixture();
    for (const mutate of [
      (value: typeof baseline) => {
        value.edges[0].lanes[0].speedMps++;
      },
      (value: typeof baseline) => {
        value.edges[0].lanes.push({ ...value.edges[0].lanes[0] });
      },
      (value: typeof baseline) => {
        value.edges[0].to = "f";
      },
      (value: typeof baseline) => {
        value.edges.push({ ...value.edges[0], id: "new" });
      },
    ]) {
      const proposal = structuredClone(baseline);
      mutate(proposal);
      expect(() =>
        assertTrafficOverlayEffects(baseline, proposal, []),
      ).toThrow();
    }
  });
  it("rejects duplicate and absent edge controls", () => {
    const baseline = trafficNetworkFixture();
    expect(() =>
      assertTrafficOverlayEffects(baseline, baseline, [
        { edgeId: "in", closed: false },
        { edgeId: "in", closed: false },
      ]),
    ).toThrow("repeat");
    expect(() =>
      assertTrafficOverlayEffects(baseline, baseline, [
        { edgeId: "absent", closed: true },
      ]),
    ).toThrow("absent baseline");
  });
});
