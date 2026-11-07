import { describe, expect, it } from "vitest";
import { createProject } from "@urban/models";
import { trafficPlaceFixture } from "../../../tests/fixtures/traffic";
import { trafficNetworkFixture } from "./traffic-fixture";
import {
  canonicalJSON,
  trafficContentHash,
  trafficRoadEditsHash,
  reviewTrafficPlanningRoads,
  verifyTrafficPlanningRoads,
  trafficPlanningRoadChanges,
  trafficPlanningOverlays,
  trafficPlanningSources,
  mergeTrafficPlanningOverlays,
  trafficPlanningRoadReviewInputSchema,
  trafficPlanningRoadMappingSchema,
  type TrafficPlanningRoadReviewInput,
} from "./index";

function fixture(twoWay = false) {
  const place = structuredClone(trafficPlaceFixture);
  place.roads[0].oneWay = !twoWay;
  place.roads[0].lanes = twoWay ? 2 : 1;
  const scenario = createProject(place).scenarios[1];
  scenario.roadEdits[place.roads[0].id] = {
    ...structuredClone(place.roads[0]),
    lanes: twoWay ? 5 : 3,
    speedMph: 30,
  };
  const network = trafficNetworkFixture();
  const reverse = ["topjoin", "top", "in"].map((id) => {
    const original = network.edges.find((e) => e.id === id)!;
    const edge = structuredClone(original);
    edge.id = `reverse-${id}`;
    edge.from = original.to;
    edge.to = original.from;
    edge.lanes = edge.lanes.map((l) => ({
      ...l,
      id: `${edge.id}_${l.index}`,
      shape: [...l.shape].reverse(),
    }));
    return edge;
  });
  network.edges.push(...reverse);
  for (let i = 1; i < reverse.length; i++)
    network.connections.push({
      ...structuredClone(network.connections[0]),
      id: `reverse-connection-${i}`,
      fromEdge: reverse[i - 1].id,
      toEdge: reverse[i].id,
      fromLane: reverse[i - 1].lanes[0].id,
      toLane: reverse[i].lanes[0].id,
    });
  const review: TrafficPlanningRoadReviewInput = {
    roadId: place.roads[0].id,
    properties: ["lanes", "speed"],
    directions: [
      { direction: "with-road", edgeIds: ["in", "top", "topjoin"], lanes: 3 },
      ...(twoWay
        ? [
            {
              direction: "against-road" as const,
              edgeIds: reverse.map((e) => e.id),
              lanes: 2,
            },
          ]
        : []),
    ],
    extent: "full-road",
    nativeExtensionAcknowledged: true,
    rationale:
      "Synthetic reviewed full native chains, including extent beyond the planning road.",
  };
  return { place, scenario, network, review };
}
const stamps = {
  reviewedBy: "fixture-editor",
  reviewedAt: "2026-01-12T10:00:00Z",
};
const translate = (f: ReturnType<typeof fixture>, reviews = [f.review]) =>
  reviewTrafficPlanningRoads({ ...f, reviews, ...stamps });

describe("reviewed planning-to-directed-network translation", () => {
  it("counts directional lanes once across serial edges, preserves exact speed conversion and immutable inputs", async () => {
    const f = fixture(true),
      before = canonicalJSON(f);
    const { overlays, planningRoads } = await translate(f);
    expect(overlays).toHaveLength(6);
    expect(overlays.slice(0, 3).map((o) => o.lanes)).toEqual([3, 3, 3]);
    expect(overlays.slice(3).map((o) => o.lanes)).toEqual([2, 2, 2]);
    expect(overlays.every((o) => o.speedMps === 30 * 0.44704)).toBe(true);
    expect(
      planningRoads.reviews[0].directions.reduce((n, d) => n + d.lanes!, 0),
    ).toBe(5);
    expect(planningRoads.roadEditsHash).toBe(
      await trafficRoadEditsHash(f.place, f.scenario),
    );
    expect(planningRoads.inventoryHash).toBe(
      await trafficContentHash(f.network),
    );
    expect(planningRoads.exclusions).toEqual([]);
    expect(canonicalJSON(f)).toBe(before);
    await expect(
      verifyTrafficPlanningRoads({ ...f, planningRoads }),
    ).resolves.toBeUndefined();
  });
  it("never halves lane totals, accepts missing directional targets, or changes one-way semantics", async () => {
    const f = fixture(true);
    f.review.directions[1].lanes = 3;
    await expect(translate(f)).rejects.toThrow(/sum once/);
    f.review.directions.pop();
    await expect(translate(f)).rejects.toThrow(/both directional/);
    const one = fixture();
    one.review.directions[0].direction = "against-road";
    await expect(translate(one)).rejects.toThrow(/with-road/);
    delete one.review.directions[0].lanes;
    expect(
      trafficPlanningRoadReviewInputSchema.safeParse(one.review).success,
    ).toBe(false);
  });
  it("requires explicit full-native-edge review and ordered connected chains", async () => {
    const f = fixture();
    f.review.nativeExtensionAcknowledged = false;
    await expect(translate(f)).rejects.toThrow(/whole native edge/);
    f.review.nativeExtensionAcknowledged = true;
    f.review.directions[0].edgeIds = ["in", "out"];
    await expect(translate(f)).rejects.toThrow(/connected serial/);
    f.review.directions[0].edgeIds = ["top", "in"];
    await expect(translate(f)).rejects.toThrow(/connected serial/);
    f.review.directions[0].edgeIds = ["absent"];
    await expect(translate(f)).rejects.toThrow(/absent/);
    f.review.directions[0].edgeIds = ["in", "in"];
    await expect(translate(f)).rejects.toThrow(/repeat/);
  });
  it("rejects special-use lane reinterpretation while allowing a separately reviewed whole-edge speed", async () => {
    const f = fixture();
    f.network.edges[0].lanes.push({
      ...f.network.edges[0].lanes[0],
      id: "in_1",
      index: 1,
      allowedClasses: ["bus"],
    });
    await expect(translate(f)).rejects.toThrow(/uniform reviewed motor lanes/);
    f.review.properties = ["speed"];
    delete f.review.directions[0].lanes;
    const { planningRoads } = await translate(f);
    expect(planningRoads.exclusions).toEqual([
      expect.objectContaining({ property: "lanes", reason: "not-reviewed" }),
    ]);
    expect(
      planningRoads.reviews[0].notes.some((n) =>
        n.includes("every native lane"),
      ),
    ).toBe(true);
  });
  it("retains exact per-property partial and unsupported coverage instead of calling a reviewed road complete", async () => {
    const f = fixture();
    Object.assign(f.scenario.roadEdits[f.review.roadId]!, {
      signal: true,
      cycleSeconds: 80,
      greenSplit: 0.5,
      bikeLane: true,
      busLane: true,
      aadt: 0,
      name: "Renamed",
      kind: "arterial",
    });
    f.review.extent = "partial-road";
    f.review.properties = ["speed"];
    delete f.review.directions[0].lanes;
    const { planningRoads } = await translate(f);
    const byProperty = new Map(
      planningRoads.exclusions.map((e) => [e.property, e.reason]),
    );
    expect(byProperty.get("speed")).toBe("partial-extent");
    expect(byProperty.get("lanes")).toBe("not-reviewed");
    for (const property of [
      "signal",
      "cycleSeconds",
      "greenSplit",
      "bikeLane",
      "busLane",
      "aadt",
      "kind",
    ] as const)
      expect(byProperty.get(property)).toBe("unsupported");
    expect(byProperty.get("name")).toBe("cosmetic");
    const empty = await translate(f, []);
    expect(empty.overlays).toEqual([]);
    expect(
      empty.planningRoads.exclusions.find((e) => e.property === "speed")
        ?.reason,
    ).toBe("not-reviewed");
  });
  it("retains new/reshaped/direction changes as exclusions and rejects claimed correspondence", async () => {
    for (const operation of ["new", "reshape", "direction"] as const) {
      const f = fixture();
      if (operation === "new") f.place.roads = [];
      if (operation === "reshape")
        f.scenario.roadEdits[f.review.roadId]!.coordinates[0][0] += 0.001;
      if (operation === "direction")
        f.scenario.roadEdits[f.review.roadId]!.oneWay = false;
      await expect(translate(f)).rejects.toThrow(/topology|rebuilt native/);
      const { planningRoads } = await translate(f, []);
      expect(
        planningRoads.exclusions.some((e) => e.reason === "unsupported"),
      ).toBe(true);
      expect(
        trafficPlanningRoadChanges(f.place, f.scenario)[0].mappingEligible,
      ).toBe(false);
    }
  });
  it("requires explicit deletion-as-closure and never claims reopening or discarded speed controls", async () => {
    const f = fixture();
    f.scenario.roadEdits[f.review.roadId] = null;
    f.review.properties = ["closure"];
    delete f.review.directions[0].lanes;
    await expect(translate(f)).rejects.toThrow(/deletion-as-closure/);
    f.review.deletionAsClosure = true;
    const result = await translate(f);
    expect(
      result.overlays.every(
        (o) => o.closed === true && Object.keys(o).length === 2,
      ),
    ).toBe(true);
    expect(result.planningRoads.exclusions).toEqual([
      expect.objectContaining({ property: "removal", reason: "unsupported" }),
    ]);
    const close = fixture();
    close.scenario.roadEdits[close.review.roadId]!.closed = true;
    close.review.properties.push("closure");
    await expect(translate(close)).rejects.toThrow(/simultaneously/);
    close.review.properties = ["closure"];
    delete close.review.directions[0].lanes;
    const closed = await translate(close);
    expect(
      closed.planningRoads.exclusions.filter(
        (e) => e.reason === "inactive-while-closed",
      ),
    ).toHaveLength(2);
    const reopen = fixture();
    reopen.place.roads[0].closed = true;
    reopen.review.properties = ["closure"];
    delete reopen.review.directions[0].lanes;
    await expect(translate(reopen)).rejects.toThrow(/reopen/);
  });
  it("rejects duplicate edge ownership and manual/generated conflicts while retaining independent disjoint properties", async () => {
    const f = fixture();
    f.review.properties = ["speed"];
    delete f.review.directions[0].lanes;
    const { planningRoads } = await translate(f);
    expect(
      mergeTrafficPlanningOverlays(
        [{ edgeId: "in", lanes: 2 }],
        planningRoads,
      ).find((o) => o.edgeId === "in"),
    ).toEqual({ edgeId: "in", lanes: 2, speedMps: 30 * 0.44704 });
    expect(() =>
      mergeTrafficPlanningOverlays(
        [{ edgeId: "in", speedMps: 30 * 0.44704 }],
        planningRoads,
      ),
    ).toThrow(/same native edge property/);
    expect(() =>
      mergeTrafficPlanningOverlays(
        [{ edgeId: "in", closed: true }],
        planningRoads,
      ),
    ).toThrow(/silently discard/);
    const second = { ...structuredClone(f.place.roads[0]), id: "second-road" };
    f.place.roads.push(second);
    f.scenario.roadEdits[second.id] = { ...second, speedMph: 40 };
    await expect(
      translate(f, [f.review, { ...f.review, roadId: second.id }]),
    ).rejects.toThrow(/multiple planning-road/);
  });
  it("binds all source and graph identities and detects tampering in outputs, stamps and exclusion ledger", async () => {
    const f = fixture();
    const { planningRoads } = await translate(f);
    for (const mutate of [
      (v: typeof planningRoads) => {
        v.reviews[0].overlays[0].speedMps = 99;
      },
      (v: typeof planningRoads) => {
        v.inventoryHash = "0".repeat(64);
      },
      (v: typeof planningRoads) => {
        v.baselineHash = "0".repeat(64);
      },
      (v: typeof planningRoads) => {
        v.reviews[0].roadEditHash = "0".repeat(64);
      },
      (v: typeof planningRoads) => {
        v.reviews[0].notes = [];
      },
    ]) {
      const modified = structuredClone(planningRoads);
      mutate(modified);
      await expect(
        verifyTrafficPlanningRoads({ ...f, planningRoads: modified }),
      ).rejects.toThrow();
    }
    f.scenario.roadEdits[f.review.roadId]!.bikeLane = true;
    const partial = (await translate(f)).planningRoads;
    partial.exclusions = [];
    await expect(
      verifyTrafficPlanningRoads({ ...f, planningRoads: partial }),
    ).rejects.toThrow(/exclusion ledger/);
    f.network.manifest.conversion.warnings.push("Changed inferred geometry");
    await expect(
      verifyTrafficPlanningRoads({ ...f, planningRoads }),
    ).rejects.toThrow();
    const bad = structuredClone(planningRoads);
    bad.reviews[0].reviewedAt = "not a date";
    expect(trafficPlanningRoadMappingSchema.safeParse(bad).success).toBe(false);
  });
  it("isolates exact planning citations and permission attestations without rewriting source evidence", async () => {
    const f = fixture();
    const original = structuredClone(f.place.sources[0]);
    const { planningRoads } = await reviewTrafficPlanningRoads({
      ...f,
      reviews: [f.review],
      ...stamps,
      sourceDeclarations: [
        {
          sourceId: original.id,
          privateUseConfirmed: true,
          publicRedistribution: false,
          declaredBy: "fixture-editor",
          declaredAt: stamps.reviewedAt,
        },
      ],
    });
    expect(planningRoads.sources).toEqual([original]);
    expect(trafficPlanningSources(f.place, f.scenario)).toEqual(
      planningRoads.sources,
    );
    const changedMetadata = structuredClone(f.place);
    changedMetadata.sources[0].vintage =
      "A later source revision under the same ID";
    expect(trafficPlanningSources(changedMetadata, f.scenario)).not.toEqual(
      planningRoads.sources,
    );
    const detached = trafficPlanningSources(f.place, f.scenario);
    detached[0].name = "Caller mutation";
    expect(f.place.sources[0]).toEqual(original);
    expect(f.place.sources[0]).toEqual(original);
    expect(planningRoads.sources[0]).not.toHaveProperty("rights");
    expect(trafficPlanningOverlays(planningRoads)).toEqual(
      planningRoads.reviews[0].overlays,
    );
    f.scenario.sources = [{ ...original, license: "Conflicting source claim" }];
    await expect(translate(f)).rejects.toThrow(/conflicting metadata/);
    f.scenario.sources = [];
    f.place.sources = [];
    await expect(translate(f)).rejects.toThrow(/absent source/);
  });
});
