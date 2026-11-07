import { describe, expect, it } from "vitest";
import {
  applyCommand,
  buildingGeometryAreaSqm,
  canonicalJSON,
  floodDatasetHash,
  floodStudyAreaHash,
  FLOOD_METHOD_VERSION,
  FLOOD_LEGACY_METHOD_VERSION,
  type FloodMethodVersion,
  type FloodDataset,
  type Scenario,
} from "@urban/core";
import {
  floodBuilding,
  floodFixture,
  floodRectangle,
  floodZone,
} from "../../../tests/fixtures/flood";
import { resolveFloodExposure } from "./flood";
import { calculateImpact } from "./engine";
async function selected(
  f: Awaited<ReturnType<typeof floodFixture>>,
  dataset: FloodDataset = f.dataset,
  methodVersion?: FloodMethodVersion,
) {
  const hash = await floodDatasetHash(dataset);
  f.scenario = {
    ...f.scenario,
    flood: {
      version: 1,
      datasetHash: hash,
      origin: "imported",
      ...(methodVersion ? { methodVersion } : {}),
    },
  };
  f.context = { floodDatasets: { [hash]: dataset } };
  return f;
}
describe("effective flood footprint screening", () => {
  it("counts full homes once through overlapping zones and responds to building quantities without growth or area prorating", async () => {
    const f = await floodFixture();
    f.dataset.zones.push(
      floodZone("duplicate-hazard", f.dataset.zones[0].geometry, "sfha"),
    );
    await selected(f);
    const wet = { ...f.place.buildings[0], units: 20 };
    f.scenario = applyCommand(f.scenario, {
      type: "building.upsert",
      building: wet,
    });
    f.scenario.horizon = 20;
    f.scenario.assumptions.annualGrowthRate = 0.1;
    const r = resolveFloodExposure(f.place, f.scenario, f.context);
    expect([r.baseline.value, r.scenario.value, r.delta]).toEqual([10, 20, 10]);
    expect(r.scenario.buildings[0].zoneIds).toEqual([
      "duplicate-hazard",
      "sfha",
    ]);
    expect(r.scenario.buildings[0].intersectionAreaSqm).toBeCloseTo(
      wet.areaSqm,
      5,
    );
    const metric = calculateImpact(
      f.place,
      f.scenario,
      {},
      f.context,
    ).metrics.find((m) => m.id === "environment.flood")!;
    expect([metric.baseline, metric.value, metric.delta]).toEqual([10, 20, 10]);
    expect(metric.coverage?.scenario.missingBuildingIds).toEqual([]);
  });
  it("preserves courtyard holes, detached wings, boundary touches and genuine tiny positive intersections", async () => {
    const f = await floodFixture(),
      outer = floodRectangle(-112.08, 33.44, -112.07, 33.46),
      hole = floodRectangle(-112.0795, 33.4405, -112.0765, 33.4435);
    if (outer.type !== "Polygon" || hole.type !== "Polygon") throw Error();
    f.dataset.zones[0].geometry = {
      type: "Polygon",
      coordinates: [outer.coordinates[0], hole.coordinates[0]],
    };
    f.dataset.zones.push(floodZone("courtyard", hole, "other-mapped"));
    f.place.buildings = [
      f.place.buildings[0],
      floodBuilding(
        "touch",
        floodRectangle(-112.07, 33.444, -112.068, 33.446),
        4,
      ),
      floodBuilding(
        "tiny",
        floodRectangle(-112.070000001, 33.448, -112.068, 33.45),
        3,
      ),
      floodBuilding(
        "wings",
        {
          type: "MultiPolygon",
          coordinates: [
            (floodRectangle(-112.075, 33.45, -112.073, 33.452) as typeof outer)
              .coordinates,
            (floodRectangle(-112.067, 33.45, -112.065, 33.452) as typeof outer)
              .coordinates,
          ],
        },
        9,
      ),
    ];
    await selected(f);
    const r = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(
      r.scenario.buildings.map((b) => [b.buildingId, b.exposedUnits]),
    ).toEqual([
      ["wet", 0],
      ["touch", 0],
      ["tiny", 3],
      ["wings", 9],
    ]);
    expect(r.scenario.value).toBe(12);
  });
  it("withholds full totals for unclassified footprints and unknown exposed units, while retaining proven zeros", async () => {
    const f = await floodFixture();
    f.dataset.zones[1] = floodZone(
      "unknown",
      f.dataset.zones[1].geometry,
      "undetermined",
    );
    f.place.buildings = [
      floodBuilding("known", f.place.buildings[0].geometry!, 10),
      floodBuilding("missing-units", f.place.buildings[0].geometry!, null),
      floodBuilding("unclassified", f.place.buildings[1].geometry!, 5),
      floodBuilding("true-zero", f.place.buildings[1].geometry!, 0),
    ];
    await selected(f);
    const r = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(r.scenario).toMatchObject({
      value: null,
      knownSubtotal: 10,
      missingUnitBuildingIds: ["missing-units"],
      unclassifiedBuildingIds: ["unclassified"],
    });
    expect(r.scenario.buildings.map((b) => b.exposedUnits)).toEqual([
      10,
      null,
      null,
      0,
    ]);
    const m = calculateImpact(f.place, f.scenario, {}, f.context).metrics.find(
      (m) => m.id === "environment.flood",
    )!;
    expect(m).toMatchObject({
      value: null,
      delta: null,
      coverage: {
        scenario: {
          knownSubtotal: 10,
          missingBuildingIds: ["missing-units", "unclassified"],
        },
      },
    });
  });
  it("keeps unknown homes in proven clear buildings zero and an entirely unclassified set unavailable rather than zero", async () => {
    const f = await floodFixture();
    f.place.buildings = [
      floodBuilding("clear-unknown", f.place.buildings[1].geometry!, null),
    ];
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario,
    ).toMatchObject({ value: 0, knownSubtotal: 0, missingUnitBuildingIds: [] });
    f.dataset.zones = [];
    await selected(f);
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario,
    ).toMatchObject({
      value: null,
      knownSubtotal: null,
      missingUnitBuildingIds: ["clear-unknown"],
      unclassifiedBuildingIds: ["clear-unknown"],
    });
  });
  it("requires full classified coverage for clear status, but one known SFHA intersection is enough to screen an entire building", async () => {
    const f = await floodFixture();
    f.dataset.zones = f.dataset.zones.filter(
      (z) => z.classification === "sfha",
    );
    await selected(f);
    const r = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(r.scenario).toMatchObject({
      value: null,
      knownSubtotal: 10,
      unclassifiedBuildingIds: ["clear"],
    });
    f.place.buildings = [
      floodBuilding(
        "straddler",
        floodRectangle(-112.071, 33.441, -112.069, 33.443),
        20,
      ),
    ];
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario.value,
    ).toBe(20);
  });
  it("detects dataset/key/study mutations and never falls back to legacy scalar evidence", async () => {
    const f = await floodFixture();
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario.value,
    ).toBe(10);
    f.context.floodDatasets[f.datasetHash].zones[0].attributes.SOURCE_CIT =
      "tampered";
    const legacy = {
      environment: {
        sourceId: "x",
        vintage: "x",
        geography: "x",
        scenarioRevision: f.scenario.revision,
        baselineFloodExposedUnits: 99,
        scenarioFloodExposedUnits: 88,
      },
    };
    expect(
      calculateImpact(f.place, f.scenario, legacy, f.context).metrics.find(
        (m) => m.id === "environment.flood",
      ),
    ).toMatchObject({ value: null, baseline: null, status: "unavailable" });
    expect(resolveFloodExposure(f.place, f.scenario, {}).status).toBe(
      "unavailable",
    );
    f.context = { floodDatasets: { [f.datasetHash]: f.dataset } };
    f.place.studyArea = floodRectangle(-112.08, 33.44, -112.06, 33.459);
    expect(resolveFloodExposure(f.place, f.scenario, f.context).status).toBe(
      "unavailable",
    );
  });
  it("reuses geometry safely across edits, removals, clones and in-place caller mutations without changing inputs", async () => {
    const f = await floodFixture(),
      before = canonicalJSON(f);
    const first = resolveFloodExposure(f.place, f.scenario, f.context);
    first.scenario.buildings[0].notes.push("caller mutation");
    expect(canonicalJSON(f)).toBe(before);
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario.buildings[0]
        .notes,
    ).not.toContain("caller mutation");
    const moved = structuredClone(f.place.buildings[0]);
    moved.geometry = floodRectangle(-112.069, 33.445, -112.067, 33.447);
    moved.areaSqm = buildingGeometryAreaSqm(moved);
    const scenario = applyCommand(f.scenario, {
      type: "building.upsert",
      building: moved,
    });
    expect(resolveFloodExposure(f.place, scenario, f.context).delta).toBe(-10);
    expect(
      resolveFloodExposure(
        f.place,
        applyCommand(f.scenario, { type: "building.remove", id: "wet" }),
        f.context,
      ).scenario.value,
    ).toBe(0);
    f.place.buildings[0].geometry!.coordinates = structuredClone(
      moved.geometry.coordinates,
    );
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).baseline.value,
    ).toBe(0);
  });
  it("preserves unrelated and legacy calculations byte-for-byte when no flood reference exists", async () => {
    const f = await floodFixture(),
      legacy = { ...f.scenario } as Scenario;
    delete legacy.flood;
    const a = calculateImpact(f.place, legacy),
      b = calculateImpact(f.place, legacy, {}, f.context);
    a.computedAt = b.computedAt;
    expect(b).toEqual(a);
    const selectedResults = calculateImpact(f.place, f.scenario, {}, f.context);
    expect(
      selectedResults.metrics.filter((m) => m.id !== "environment.flood"),
    ).toEqual(b.metrics.filter((m) => m.id !== "environment.flood"));
  });
  it("treats invalid building topology as unresolved and does not erase seclusion hazard context", async () => {
    const f = await floodFixture();
    f.dataset.seclusions = [
      {
        id: "historic-seclusion",
        geometry: f.dataset.zones[0].geometry,
        attributes: { TYPE: "Historical study retained" },
      },
    ];
    await selected(f);
    const r = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(r.scenario.value).toBe(10);
    expect(r.scenario.buildings[0].notes.join(" ")).toContain("does not erase");
    f.place.buildings[0].geometry = {
      type: "Polygon",
      coordinates: [
        [
          [-112.079, 33.441],
          [-112.077, 33.443],
          [-112.079, 33.443],
          [-112.077, 33.441],
          [-112.079, 33.441],
        ],
      ],
    };
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario
        .unclassifiedBuildingIds,
    ).toEqual(["wet"]);
  });
  it("withholds all results for a rehashed source pack with invalid topology after structural parsing", async () => {
    const f = await floodFixture();
    // A caller can compute a fresh content hash; that does not establish topology.
    f.dataset.zones[0].geometry = {
      type: "Polygon",
      coordinates: [
        [
          [-112.079, 33.441],
          [-112.077, 33.443],
          [-112.079, 33.443],
          [-112.077, 33.441],
          [-112.079, 33.441],
        ],
      ],
    };
    await selected(f);
    const result = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("topology");
    expect([
      result.baseline.value,
      result.scenario.value,
      result.delta,
    ]).toEqual([null, null, null]);
    const metric = calculateImpact(
      f.place,
      f.scenario,
      {},
      f.context,
    ).metrics.find((m) => m.id === "environment.flood")!;
    expect([metric.baseline, metric.value, metric.delta]).toEqual([
      null,
      null,
      null,
    ]);
    expect(metric.status).toBe("unavailable");
  });
});

describe("versioned union-first flood coverage", () => {
  it("removes an artificial internal-seam gap without changing legacy replay, source bytes, or count units", async () => {
    const f = await floodFixture();
    // Reduced from a retained Chicago seam. Coordinates are test evidence, not a new source pack.
    const a: [number, number] = [-87.62500573131939, 41.88449991614579],
      b: [number, number] = [-87.62500573171056, 41.8884286639589];
    const study = floodRectangle(-87.626, a[1], -87.624, b[1]);
    f.place.studyArea = study;
    f.dataset.studyArea = study;
    f.dataset.studyAreaHash = await floodStudyAreaHash(study);
    f.dataset.zones = [
      floodZone(
        "west",
        {
          type: "Polygon",
          coordinates: [
            [[-87.626, a[1]], a, b, [-87.626, b[1]], [-87.626, a[1]]],
          ],
        },
        "other-mapped",
      ),
      floodZone(
        "east",
        {
          type: "Polygon",
          coordinates: [[a, [-87.624, a[1]], [-87.624, b[1]], b, a]],
        },
        "other-mapped",
      ),
    ];
    f.dataset.availability = [{ id: "all", geometry: study, attributes: {} }];
    f.dataset.panels = [];
    f.dataset.revisions = [];
    f.dataset.seclusions = [];
    const footprint = {
      type: "Polygon" as const,
      coordinates: [
        [
          [-87.6252434, 41.8863273],
          [-87.6252371, 41.8861162],
          [-87.6252368, 41.8861005],
          [-87.6252344, 41.8859784],
          [-87.6252328, 41.8858947],
          [-87.6247557, 41.8859006],
          [-87.6247569, 41.885954],
          [-87.6247584, 41.8860244],
          [-87.6247597, 41.8860872],
          [-87.6247618, 41.8861818],
          [-87.6247628, 41.8862295],
          [-87.6247639, 41.8862798],
          [-87.6247663, 41.8863314],
          [-87.6252434, 41.8863273],
        ] as [number, number][],
      ],
    };
    f.place.buildings = [floodBuilding("seam", footprint, 7)];
    await selected(f);
    const before = canonicalJSON(f),
      legacy = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(legacy.methodVersion).toBe(FLOOD_LEGACY_METHOD_VERSION);
    expect(legacy.scenario.value).toBeNull();
    const modern = applyCommand(f.scenario, {
      type: "scenario.flood",
      flood: { ...f.scenario.flood!, methodVersion: FLOOD_METHOD_VERSION },
    });
    const result = resolveFloodExposure(f.place, modern, f.context);
    expect(result).toMatchObject({
      methodVersion: FLOOD_METHOD_VERSION,
      status: "ready",
      delta: 0,
      scenario: { value: 0, unclassifiedBuildingIds: [] },
    });
    expect(result.scenario.buildings[0]).toMatchObject({
      units: 7,
      exposedUnits: 0,
      zoneIds: ["east", "west"],
    });
    expect(resolveFloodExposure(f.place, f.scenario, f.context)).toEqual(
      legacy,
    );
    expect(
      resolveFloodExposure(
        f.place,
        {
          ...f.scenario,
          flood: {
            ...f.scenario.flood!,
            methodVersion: FLOOD_LEGACY_METHOD_VERSION,
          },
        },
        f.context,
      ),
    ).toEqual(legacy);
    expect(canonicalJSON(f)).toBe(before);
  });
  it("retains tiny real coverage gaps and availability holes, including a hole entirely enclosed by the footprint", async () => {
    const f = await floodFixture(),
      footprint = floodRectangle(-112.075, 33.445, -112.073, 33.447);
    f.place.buildings = [floodBuilding("gap", footprint, 4)];
    const gap = floodRectangle(-112.074, 33.4455, -112.0739999999, 33.4465);
    const full = structuredClone(f.dataset.studyArea);
    if (full.type !== "Polygon" || gap.type !== "Polygon") throw Error();
    f.dataset.zones = [
      floodZone(
        "known-with-hole",
        {
          type: "Polygon",
          coordinates: [full.coordinates[0], gap.coordinates[0]],
        },
        "other-mapped",
      ),
    ];
    await selected(f, f.dataset, FLOOD_METHOD_VERSION);
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario,
    ).toMatchObject({ value: null, unclassifiedBuildingIds: ["gap"] });
    f.dataset.zones = [floodZone("all-known", full, "other-mapped")];
    f.dataset.availability[0].geometry = {
      type: "Polygon",
      coordinates: [full.coordinates[0], gap.coordinates[0]],
    };
    await selected(f, f.dataset, FLOOD_METHOD_VERSION);
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario.value,
    ).toBeNull();
    f.dataset.availability[0].geometry = full;
    f.dataset.zones.push(floodZone("unknown-sliver", gap, "undetermined"));
    await selected(f, f.dataset, FLOOD_METHOD_VERSION);
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario.value,
    ).toBeNull();
  });
  it("counts genuine tiny SFHA intersection once, preserves touching zeros, and keeps unknown physical homes distinct", async () => {
    const f = await floodFixture();
    f.dataset.zones.push(
      floodZone("overlap", f.dataset.zones[0].geometry, "sfha"),
    );
    f.place.buildings = [
      floodBuilding(
        "touch",
        floodRectangle(-112.07, 33.444, -112.068, 33.446),
        null,
      ),
      floodBuilding(
        "tiny",
        floodRectangle(-112.0700000001, 33.448, -112.068, 33.45),
        3,
      ),
      floodBuilding("unknown", f.place.buildings[0].geometry!, null),
      floodBuilding("zero", f.place.buildings[0].geometry!, 0),
    ];
    await selected(f, f.dataset, FLOOD_METHOD_VERSION);
    const result = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(result.scenario).toMatchObject({
      value: null,
      knownSubtotal: 3,
      missingUnitBuildingIds: ["unknown"],
      unclassifiedBuildingIds: [],
    });
    expect(
      result.scenario.buildings.map((b) => [b.buildingId, b.exposedUnits]),
    ).toEqual([
      ["touch", 0],
      ["tiny", 3],
      ["unknown", null],
      ["zero", 0],
    ]);
    expect(result.scenario.buildings[1].zoneIds).toEqual([
      "overlap",
      "sfha",
      "x",
    ]);
  });
  it("keeps detached wings, enclosed SFHA islands, courtyard holes and caller mutations honest", async () => {
    const f = await floodFixture(),
      outer = floodRectangle(-112.0795, 33.4405, -112.0765, 33.4435),
      hole = floodRectangle(-112.079, 33.441, -112.077, 33.443);
    if (outer.type !== "Polygon" || hole.type !== "Polygon") throw Error();
    f.dataset.zones = [
      floodZone("base", f.dataset.studyArea, "other-mapped"),
      floodZone(
        "ring",
        {
          type: "Polygon",
          coordinates: [outer.coordinates[0], hole.coordinates[0]],
        },
        "sfha",
      ),
    ];
    f.place.buildings = [
      floodBuilding("courtyard", hole, 5),
      floodBuilding(
        "encloses-island",
        floodRectangle(-112.0798, 33.4402, -112.0762, 33.4438),
        9,
      ),
      floodBuilding(
        "wings",
        {
          type: "MultiPolygon",
          coordinates: [
            hole.coordinates,
            (
              floodRectangle(
                -112.0794,
                33.4406,
                -112.0792,
                33.4408,
              ) as typeof hole
            ).coordinates,
          ],
        },
        4,
      ),
    ];
    await selected(f, f.dataset, FLOOD_METHOD_VERSION);
    const result = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(result.scenario.buildings.map((b) => b.exposedUnits)).toEqual([
      0, 9, 4,
    ]);
    expect(result.scenario.value).toBe(13);
    result.scenario.buildings[0].notes.push("caller change");
    expect(
      resolveFloodExposure(f.place, f.scenario, f.context).scenario.buildings[0]
        .notes,
    ).not.toContain("caller change");
    f.dataset.zones[0].attributes.SOURCE_CIT = "changed under same reference";
    expect(resolveFloodExposure(f.place, f.scenario, f.context)).toMatchObject({
      status: "unavailable",
      scenario: { value: null },
    });
  });
});
