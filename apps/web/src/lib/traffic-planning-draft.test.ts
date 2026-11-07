import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createProject } from "@urban/models";
import {
  canonicalJSON,
  mergeTrafficPlanningOverlays,
  reviewTrafficPlanningRoads,
  trafficPlanningRoadChanges,
  type TrafficPlanningRoadReviewInput,
} from "@urban/core";
import {
  trafficPlaceFixture,
  trafficScenarioFixture,
} from "../../../../tests/fixtures/traffic";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture";
import {
  manualTrafficOverlays,
  movePlanningEdge,
  newPlanningReview,
  planningReviewBinding,
  planningReviewDraft,
  planningRoadCandidateIds,
  readPlanningReviews,
  planningSourceDraft,
  currentPlanningSourceDeclaration,
  updatePlanningSourceDeclaration,
  readPlanningSourceDeclarations,
  planningSourcesCurrent,
} from "./traffic-planning-draft";
import {
  TrafficPlanningCoverage,
  TrafficPlanningSources,
} from "../components/traffic/TrafficPlanningRoadPanel";
import { PublishedTraffic } from "../components/traffic/TrafficOverview";

async function fixture() {
  const place = structuredClone(trafficPlaceFixture),
    network = trafficNetworkFixture(),
    scenario = createProject(place).scenarios[1];
  scenario.roadEdits[place.roads[0].id] = {
    ...place.roads[0],
    lanes: 3,
    speedMph: 30,
    signal: true,
  };
  const input: TrafficPlanningRoadReviewInput = {
    roadId: place.roads[0].id,
    properties: ["lanes", "speed"],
    directions: [{ direction: "with-road", edgeIds: ["in"], lanes: 3 }],
    extent: "full-road",
    nativeExtensionAcknowledged: true,
    rationale:
      "Synthetic explicit same-direction road and full native extent review.",
  };
  const result = await reviewTrafficPlanningRoads({
    place,
    scenario,
    network,
    reviews: [input],
    reviewedBy: "test-user",
    reviewedAt: "2026-01-12T00:00:00Z",
  });
  return { place, scenario, network, input, ...result };
}
describe("planning correspondence draft integrity", () => {
  it("offers lineage candidates without selecting properties, edges or a lane split", async () => {
    const f = await fixture(),
      change = trafficPlanningRoadChanges(f.place, f.scenario)[0];
    change.baseline!.id = "osm-way-123-part-0";
    f.network.edges[0].sourceWayIds = ["123"];
    expect(planningRoadCandidateIds(change, f.network)).toEqual([
      f.network.edges[0].id,
    ]);
    const draft = newPlanningReview(change);
    expect(draft.properties).toEqual([]);
    expect(draft.directions).toEqual([
      { direction: "with-road", edgeIds: [], lanes: "" },
    ]);
    expect(draft.confirmed).toBe(false);
    expect(draft.nativeExtensionAcknowledged).toBe(false);
    change.baseline!.oneWay = false;
    change.proposal!.oneWay = false;
    expect(newPlanningReview(change).directions.map((d) => d.lanes)).toEqual([
      "",
      "",
    ]);
  });
  it("roundtrips ordered reviewed chains and rejects blank, fractional or malformed lane buffers without coercing zero", async () => {
    const f = await fixture(),
      draft = planningReviewDraft(f.input, true, f.planningRoads);
    expect(readPlanningReviews([draft], true, f.planningRoads)).toEqual([
      f.input,
    ]);
    for (const lanes of ["", " ", "0", "2.5", "2e1", "-1", "21", "NaN"]) {
      const invalid = structuredClone(draft);
      invalid.directions[0].lanes = lanes;
      expect(() =>
        readPlanningReviews([invalid], true, f.planningRoads),
      ).toThrow("directional lane");
      expect(invalid.directions[0].lanes).toBe(lanes);
    }
    expect(movePlanningEdge(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
  });
  it("requires confirmation again after any captured road, baseline or graph binding changes", async () => {
    const f = await fixture(),
      draft = planningReviewDraft(f.input, true, f.planningRoads);
    for (const key of [
      "baselineHash",
      "roadEditsHash",
      "networkHash",
      "inventoryHash",
    ] as const) {
      const changed = { ...f.planningRoads, [key]: "f".repeat(64) };
      expect(() => readPlanningReviews([draft], true, changed)).toThrow(
        "Confirm or discard",
      );
      const accepted = {
        ...draft,
        confirmedFor: planningReviewBinding(changed),
      };
      expect(readPlanningReviews([accepted], true, changed)).toEqual([f.input]);
    }
    expect(() =>
      readPlanningReviews(
        [{ ...draft, confirmed: false }],
        true,
        f.planningRoads,
      ),
    ).toThrow("Confirm or discard");
  });
  it("invalidates road confirmation and current-config reuse when a same-ID citation changes without changing geometry hashes", async () => {
    const f = await fixture();
    const source = {
      ...f.planningRoads.sources[0],
      rights: {
        version: 1 as const,
        privateUse: true,
        cache: true,
        analyze: true,
        privateDisplay: true,
        export: true,
        historicalRetention: true,
        publicRedistribution: true,
        declaredBy: "test-user",
        declaredAt: "2026-01-12T00:00:00Z",
      },
    };
    const mapping = { ...f.planningRoads, sources: [source] };
    const draft = planningReviewDraft(f.input, true, mapping);
    expect(
      planningSourcesCurrent(mapping, structuredClone(mapping.sources)),
    ).toBe(true);
    expect(planningSourcesCurrent(mapping, null)).toBe(false);
    for (const changed of [
      { ...source, name: "Corrected source citation" },
      { ...source, license: "Private evaluation only" },
      { ...source, rights: { ...source.rights, publicRedistribution: false } },
    ]) {
      const current = { ...mapping, sources: [changed] };
      expect([
        current.baselineHash,
        current.roadEditsHash,
        current.networkHash,
        current.inventoryHash,
      ]).toEqual([
        mapping.baselineHash,
        mapping.roadEditsHash,
        mapping.networkHash,
        mapping.inventoryHash,
      ]);
      expect(planningSourcesCurrent(mapping, current.sources)).toBe(false);
      expect(() => readPlanningReviews([draft], true, current)).toThrow(
        "Confirm or discard",
      );
      expect(
        readPlanningReviews(
          [{ ...draft, confirmedFor: planningReviewBinding(current) }],
          true,
          current,
        ),
      ).toEqual([f.input]);
    }
  });
  it("requires fresh citation-bound private and public actions and never submits browser-only binding metadata", async () => {
    const f = await fixture(),
      source = f.planningRoads.sources[0];
    const prior = [
      planningSourceDraft(source, {
        privateUseConfirmed: true,
        publicRedistribution: true,
      }),
    ];
    expect(readPlanningSourceDeclarations([source], prior)).toEqual([
      {
        sourceId: source.id,
        privateUseConfirmed: true,
        publicRedistribution: true,
      },
    ]);
    for (const changed of [
      { ...source, name: "Corrected citation" },
      { ...source, license: "Different permitted uses" },
    ]) {
      expect(currentPlanningSourceDeclaration(changed, prior)).toBeUndefined();
      expect(() => readPlanningSourceDeclarations([changed], prior)).toThrow(
        "current planning source citation",
      );
      const privateAgain = updatePlanningSourceDeclaration(changed, prior, {
        privateUseConfirmed: true,
      });
      expect(readPlanningSourceDeclarations([changed], privateAgain)).toEqual([
        {
          sourceId: source.id,
          privateUseConfirmed: true,
          publicRedistribution: false,
        },
      ]);
      const publicAgain = updatePlanningSourceDeclaration(
        changed,
        privateAgain,
        { publicRedistribution: true },
      );
      expect(
        readPlanningSourceDeclarations([changed], publicAgain)[0]
          .publicRedistribution,
      ).toBe(true);
      const publicFirst = updatePlanningSourceDeclaration(changed, prior, {
        publicRedistribution: true,
      });
      expect(() =>
        readPlanningSourceDeclarations([changed], publicFirst),
      ).toThrow("current planning source citation");
      expect(publicFirst).toHaveLength(1);
    }
    expect(
      currentPlanningSourceDeclaration(source, prior)?.publicRedistribution,
    ).toBe(true);
  });
  it("separates generated properties from independent controls and refuses stale or conflicting ownership", async () => {
    const f = await fixture(),
      manual = [{ edgeId: "top", speedMps: 7 }],
      effective = mergeTrafficPlanningOverlays(manual, f.planningRoads),
      before = canonicalJSON(effective);
    expect(manualTrafficOverlays(effective, f.planningRoads)).toEqual(manual);
    expect(canonicalJSON(effective)).toBe(before);
    const changed = effective.map((o) =>
      o.edgeId === "in" ? { ...o, lanes: 5 } : o,
    );
    expect(() => manualTrafficOverlays(changed, f.planningRoads)).toThrow(
      "do not match",
    );
    expect(() =>
      mergeTrafficPlanningOverlays(
        [{ edgeId: "in", lanes: 3 }],
        f.planningRoads,
      ),
    ).toThrow("same native edge property");
    expect(
      mergeTrafficPlanningOverlays(
        manualTrafficOverlays(effective, f.planningRoads),
        { ...f.planningRoads, reviews: [] },
      ),
    ).toEqual(manual);
  });
  it("keeps unsupported signal coverage and original planning citations visible separately in read-only evidence", async () => {
    const f = await fixture();
    const coverage = renderToStaticMarkup(
      createElement(TrafficPlanningCoverage, { mapping: f.planningRoads }),
    );
    const sources = renderToStaticMarkup(
      createElement(TrafficPlanningSources, { mapping: f.planningRoads }),
    );
    expect(coverage).toContain("signal");
    expect(coverage).toContain("property-level correspondence");
    expect(coverage).toContain("Full native edge effects");
    expect(sources).toContain(f.place.sources[0].name);
    expect(sources).toContain(
      "not merged with native-network or count sources",
    );
    expect(sources).toContain("No public redistribution declaration retained");
  });
  it("distinguishes linked roads from omitted traffic properties in a public capture without counting cosmetic changes", async () => {
    const f = await fixture(),
      saved = await trafficScenarioFixture();
    const render = () =>
      renderToStaticMarkup(
        createElement(PublishedTraffic, {
          place: saved.place,
          scenario: { ...saved.scenario, traffic: saved.traffic },
        }),
      );
    expect(render()).toContain("0 planning roads are unrepresented.");
    saved.traffic.capture.proposal.planningRoadMapping.correspondence = {
      ...f.planningRoads,
      exclusions: [
        ...f.planningRoads.exclusions,
        {
          roadId: f.input.roadId,
          property: "name",
          reason: "cosmetic",
          detail: "A renamed road does not change vehicle movement.",
        },
      ],
    };
    const html = render();
    expect(html).toContain(
      "0 roads without a reviewed link; 1 omitted traffic properties.",
    );
    expect(html).not.toContain("planning roads are unrepresented.");
  });
});
