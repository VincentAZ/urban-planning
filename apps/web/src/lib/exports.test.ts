import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  workforcePlaceFixture,
  workforceScenarioFixture,
} from "../../../../tests/fixtures/workforce";
import { planningSources } from "./source-inventory";
import { WorkforceSources } from "../components/workforce/WorkforceOverview";
import {
  applyBuildingGeometry,
  verifyWorkforceScenario,
  USER_BUILDING_SOURCE,
  roadPreset,
  parcelPreset,
  USER_ROAD_SOURCE,
  USER_ACTIVITY_SOURCE,
  type Place,
  type Source,
  type Building,
  type ModelResults,
} from "@urban/core";
import {
  buildingPreset,
  calculateImpact,
  createProject,
  typedBuildingPreset,
} from "@urban/models";
import { download } from "./api";
import { exportCSV, exportGeoJSON, reportHTML } from "./exports";
import { fiscalReportFixture } from "../../../api/src/fiscal-report-fixture";

vi.mock("./api", () => ({ download: vi.fn() }));

describe("exported source evidence", () => {
  it("gates scorecard CSV on matching fiscal evidence and explicit export permission", () => {
    const snapshot = fiscalReportFixture();
    const { place, project, scenario, results } = snapshot;
    vi.mocked(download).mockClear();
    expect(() => exportCSV(results)).toThrow(/matching fiscal study/);
    expect(() =>
      exportCSV(results, {
        place,
        project,
        scenario: { ...scenario, revision: scenario.revision + 1 },
      }),
    ).toThrow(/matching frozen profile and results/);
    expect(download).not.toHaveBeenCalled();
    exportCSV(results, { place, project, scenario });
    expect(download).toHaveBeenCalledTimes(1);
    expect(vi.mocked(download).mock.calls[0][1]).toContain(
      "First-year net fiscal impact",
    );
    project.fiscalStudy!.profile.sources[0].rights!.export = false;
    vi.mocked(download).mockClear();
    expect(() => exportCSV(results, { place, project, scenario })).toThrow(
      /does not permit export/,
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("keeps a valid imported workforce citation separate when its ID matches the captured planning source", async () => {
    const baselineSource: Source = {
      id: "fixture",
      name: "Captured building survey",
      url: "https://example.org/buildings",
      vintage: "2025",
      license: "Fixture use",
      kind: "observed",
    };
    const { place, workforce } = await workforceScenarioFixture({
      place: { ...workforcePlaceFixture, sources: [baselineSource] },
    });
    workforce.origin = "imported";
    await verifyWorkforceScenario(workforce, place);
    const scenario = createProject(place).scenarios[1];
    scenario.workforce = workforce;
    const captured = JSON.stringify(workforce);
    // This is the same planning-only inventory used for SharedView feature lookup.
    expect(
      planningSources(place, scenario).find(
        (source) => source.id === "fixture",
      ),
    ).toEqual(baselineSource);
    const citations = renderToStaticMarkup(
      createElement(WorkforceSources, { capture: workforce.capture }),
    );
    expect(citations).toContain("Synthetic unit test");
    expect(citations).not.toContain("Captured building survey");
    exportGeoJSON(place, scenario);
    const payload = JSON.parse(
      vi.mocked(download).mock.calls.at(-1)![1] as string,
    );
    expect(payload.metadata.sources).toEqual([baselineSource]);
    expect(payload.metadata.workforce.capture.sources).toEqual(
      workforce.capture.sources,
    );
    const html = reportHTML(place, scenario, calculateImpact(place, scenario));
    expect(html).toContain("Captured building survey");
    expect(html).toContain("Workforce capture sources");
    expect(html).toContain("Synthetic unit test");
    expect(html).toContain("Imported evidence — not verified by this server");
    expect(JSON.stringify(workforce)).toBe(captured);
  });

  it("exports a complete multipart courtyard and explicit program without replacing source IDs or multiplying building counts", () => {
    const place: Place = {
      id: "program",
      name: "Program fixture",
      city: "Phoenix",
      state: "AZ",
      zip: "85004",
      center: [-112.07, 33.45],
      bounds: [-112.08, 33.44, -112.06, 33.46],
      boundary: [
        [-112.08, 33.44],
        [-112.06, 33.44],
        [-112.06, 33.46],
        [-112.08, 33.46],
        [-112.08, 33.44],
      ],
      buildings: [],
      roads: [],
      sources: [],
      coverage: [],
      loadedAt: "2026-11-05",
      extentLabel: "Synthetic building study",
    };
    const building = applyBuildingGeometry(
      buildingPreset("mixed-use", place.center),
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-112.075, 33.445],
              [-112.071, 33.445],
              [-112.071, 33.449],
              [-112.075, 33.449],
              [-112.075, 33.445],
            ],
            [
              [-112.074, 33.446],
              [-112.072, 33.446],
              [-112.072, 33.448],
              [-112.074, 33.448],
              [-112.074, 33.446],
            ],
          ],
          [
            [
              [-112.069, 33.445],
              [-112.067, 33.445],
              [-112.067, 33.447],
              [-112.069, 33.447],
              [-112.069, 33.445],
            ],
          ],
        ],
      },
    );
    building.name = "Homes & <shops>";
    building.sourceFeatureId = "__proto__";
    building.programSourceId = USER_BUILDING_SOURCE.id;
    building.units = 20;
    building.jobs = 8;
    building.parkingSpaces = 15;
    building.program = {
      version: 1,
      grossFloorAreaSqm: 2500,
      commonAreaSqm: 300,
      components: [
        {
          id: "homes",
          name: "<Residential>",
          use: "multifamily",
          grossFloorAreaSqm: 1800,
          units: 20,
          jobs: 0,
          residentialSubtype: "apartment",
          tripRate: {
            value: 6,
            basis: "occupied-dwelling",
            sourceId: USER_BUILDING_SOURCE.id,
          },
        },
        {
          id: "shops",
          use: "retail",
          grossFloorAreaSqm: 400,
          units: 0,
          jobs: 8,
        },
      ],
    };
    const scenario = createProject(place).scenarios[1];
    scenario.buildingEdits = { [building.id]: building };
    scenario.sources = [USER_BUILDING_SOURCE];
    scenario.revision = 1;
    exportGeoJSON(place, scenario);
    const payload = JSON.parse(
      vi.mocked(download).mock.calls.at(-1)![1] as string,
    );
    expect(payload.features).toHaveLength(1);
    expect(payload.features[0]).toMatchObject({
      geometry: building.geometry,
      properties: {
        program: building.program,
        geometrySourceId: building.geometrySourceId,
        programSourceId: USER_BUILDING_SOURCE.id,
        sourceFeatureId: "__proto__",
        scenarioRevision: 1,
      },
    });
    expect(payload.features[0].properties).not.toHaveProperty("geometry");
    expect(payload.features[0].properties).not.toHaveProperty("footprint");
    const html = reportHTML(place, scenario, calculateImpact(place, scenario));
    for (const text of [
      "Building geometry and programs",
      "Homes &amp; &lt;shops&gt;",
      "&lt;Residential&gt;",
      "MultiPolygon",
      "2500",
      "300",
      "6 per occupied-dwelling",
      "Parking supply: 15",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("<Residential>");
    expect(html).toContain("counted once");
  });
  it("exports the exact proposed street network with geometry lineage while retaining the source network", () => {
    const original: Source = {
      id: "observed-roads",
      name: "Source centerlines",
      url: "https://example.test/roads",
      vintage: "2025",
      license: "Attribution required",
      kind: "observed",
    };
    const originalRoad = {
      ...roadPreset([
        [-112.075, 33.45],
        [-112.07, 33.45],
      ]),
      id: "reshaped",
      sourceId: original.id,
      geometrySourceId: original.id,
      attributeSourceId: original.id,
      estimated: false,
      aadt: 1000,
    };
    const place: Place = {
      id: "streets",
      name: "Street fixture",
      city: "Phoenix",
      state: "AZ",
      zip: "85004",
      center: [-112.07, 33.45],
      bounds: [-112.08, 33.44, -112.06, 33.46],
      boundary: [
        [-112.08, 33.44],
        [-112.06, 33.44],
        [-112.06, 33.46],
        [-112.08, 33.46],
        [-112.08, 33.44],
      ],
      buildings: [
        {
          ...buildingPreset("office", [-112.07, 33.45]),
          sourceId: original.id,
        },
      ],
      roads: [
        originalRoad,
        { ...originalRoad, id: "removed" },
        { ...originalRoad, id: "unchanged" },
      ],
      sources: [original],
      coverage: [],
      loadedAt: "2026-11-05",
      extentLabel: "Fixture only",
    };
    const before = structuredClone(place);
    const project = createProject(place);
    const scenario = project.scenarios.find(
      (s) => s.id === project.activeScenarioId,
    )!;
    const added = roadPreset(
      [
        [-112.073, 33.453],
        [-112.07, 33.453],
      ],
      "New street",
    );
    scenario.roadEdits = {
      reshaped: {
        ...originalRoad,
        coordinates: [
          [-112.075, 33.45],
          [-112.072, 33.451],
          [-112.07, 33.45],
        ],
        geometrySourceId: USER_ROAD_SOURCE.id,
      },
      removed: null,
      [added.id]: added,
    };
    scenario.sources = [USER_ROAD_SOURCE];
    scenario.revision = 3;
    exportGeoJSON(place, scenario);
    const [name, content, mime] = vi.mocked(download).mock.calls.at(-1)!;
    expect(name).toBe("urban-planning-scenario.geojson");
    expect(mime).toBe("application/geo+json");
    const payload = JSON.parse(content as string);
    expect(payload.metadata).toMatchObject({
      placeId: place.id,
      scenarioId: scenario.id,
      revision: 3,
      sources: [original, USER_ROAD_SOURCE],
    });
    expect(payload.features).toHaveLength(4);
    expect(
      payload.features.some(
        (feature: { id: string }) => feature.id === "removed",
      ),
    ).toBe(false);
    expect(
      payload.features.find(
        (feature: { id: string }) => feature.id === "reshaped",
      ),
    ).toMatchObject({
      geometry: {
        type: "LineString",
        coordinates: scenario.roadEdits.reshaped!.coordinates,
      },
      properties: {
        featureType: "road",
        sourceId: original.id,
        attributeSourceId: original.id,
        geometrySourceId: USER_ROAD_SOURCE.id,
        scenarioId: scenario.id,
        scenarioRevision: 3,
        aadt: 1000,
      },
    });
    expect(
      payload.features.find(
        (feature: { id: string }) => feature.id === added.id,
      ).properties,
    ).toMatchObject({
      featureType: "road",
      estimated: true,
      sourceId: USER_ROAD_SOURCE.id,
    });
    expect(payload.features[0].properties.featureType).toBe("building");
    expect(place).toEqual(before);
  });
  it("retains imported source attribution in both GIS and browser reports", () => {
    const source: Source = {
      id: "uploaded-source",
      name: "City <GIS> inventory",
      url: "https://example.test/inventory",
      vintage: "2026",
      license: "City attribution required",
      kind: "user-supplied",
    };
    const original: Source = {
      ...source,
      id: "original",
      name: "Original source",
    };
    const place: Place = {
      id: "fixture",
      name: "Fixture",
      city: "Phoenix",
      state: "AZ",
      zip: "85004",
      center: [-112.07, 33.45],
      bounds: [-112.08, 33.44, -112.06, 33.46],
      boundary: [
        [-112.08, 33.44],
        [-112.06, 33.44],
        [-112.06, 33.46],
        [-112.08, 33.46],
        [-112.08, 33.44],
      ],
      buildings: [],
      roads: [],
      sources: [original],
      coverage: [],
      loadedAt: "2026-11-05",
      extentLabel: "Test fixture",
    };
    const project = createProject(place);
    const scenario = project.scenarios.find(
      (s) => s.id === project.activeScenarioId,
    )!;
    const building = {
      ...buildingPreset("office", place.center),
      sourceId: source.id,
    };
    scenario.buildingEdits[building.id] = building;
    const parcel = {
      ...parcelPreset({
        type: "Polygon",
        coordinates: [
          [
            [-112.075, 33.445],
            [-112.065, 33.445],
            [-112.065, 33.455],
            [-112.075, 33.455],
            [-112.075, 33.445],
          ],
          [
            [-112.074, 33.446],
            [-112.073, 33.446],
            [-112.073, 33.447],
            [-112.074, 33.447],
            [-112.074, 33.446],
          ],
        ],
      }),
      sourceId: source.id,
      geometrySourceId: source.id,
      sourceFeatureId: "County lot 001",
      lineage: {
        operation: "import" as const,
        parentIds: [],
        sourceIds: [source.id],
      },
    };
    scenario.parcelEdits = { [parcel.id]: parcel };
    scenario.sources = [source];
    exportGeoJSON(place, scenario);
    const payload = JSON.parse(
      vi.mocked(download).mock.calls.at(-1)![1] as string,
    );
    expect(payload.metadata.sources).toEqual([original, source]);
    expect(payload.features[0].properties.sourceId).toBe(source.id);
    expect(
      payload.features.find(
        (feature: { id: string }) => feature.id === parcel.id,
      ),
    ).toMatchObject({
      geometry: parcel.geometry,
      properties: {
        featureType: "parcel",
        sourceId: source.id,
        sourceFeatureId: "County lot 001",
        boundaryStatus: "user-supplied boundary; legal status unverified",
        lineage: parcel.lineage,
      },
    });
    const report = reportHTML(
      place,
      scenario,
      calculateImpact(place, scenario),
    );
    expect(report).toContain("City &lt;GIS&gt; inventory");
    expect(report).toContain(source.url);
    expect(report).toContain(source.license);
    expect(report).not.toContain("<GIS>");
    scenario.activity = {
      version: 1,
      reference: {
        population: {
          kind: "entered",
          value: 100,
          sourceId: source.id,
          asOfYear: 2024,
          universe: "Test residents",
        },
        employment: { kind: "building-derived" },
      },
      allocation: { population: "uniform-area", employment: "uniform-area" },
      global: {
        population: { mode: "baseline-percent", percent: 125 },
        householdVehicles: { mode: "absolute", value: 30 },
      },
      neighborhoods: [
        {
          id: "activity-area",
          name: "<Local allocation>",
          geometry: parcel.geometry,
          population: { mode: "absolute", value: 15 },
          employment: { mode: "absolute", value: 0 },
          sourceId: source.id,
        },
      ],
      demandResponse: {
        population: "none",
        employment: "none",
        vehicles: "none",
        reviewed: false,
        sourceId: USER_ACTIVITY_SOURCE.id,
      },
    };
    exportGeoJSON(place, scenario);
    const active = JSON.parse(
      vi.mocked(download).mock.calls.at(-1)![1] as string,
    );
    expect(active.metadata.activity).toEqual(scenario.activity);
    expect(
      active.features.find((f: { id: string }) => f.id === "activity-area"),
    ).toMatchObject({
      geometry: parcel.geometry,
      properties: {
        featureType: "activity-neighborhood",
        population: { mode: "absolute", value: 15 },
        employment: { mode: "absolute", value: 0 },
        scenarioRevision: scenario.revision,
        sourceId: source.id,
      },
    });
    expect(
      active.metadata.sources.some(
        (s: Source) => s.id === USER_ACTIVITY_SOURCE.id,
      ),
    ).toBe(true);
    const activeReport = reportHTML(
      place,
      scenario,
      calculateImpact(place, scenario),
    );
    expect(activeReport).toContain("not observed neighborhood counts");
    expect(activeReport).toContain("&lt;Local allocation&gt;");
    expect(activeReport).toContain("125% of captured year-zero reference");
    expect(activeReport).toContain("Household vehicles available");
  });
});

/** Every exported field is CSV-quoted, including JSON identifier lists. */
function scorecardRows(results: ModelResults) {
  exportCSV(results);
  const csv = vi.mocked(download).mock.calls.at(-1)![1] as string;
  const rows = csv
    .split("\r\n")
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) =>
        match[1].replaceAll('""', '"'),
      ),
    );
  return {
    headings: rows[0],
    rows: rows.slice(1),
    metric(id: string) {
      const metric = results.metrics.find((m) => m.id === id)!;
      return Object.fromEntries(
        rows[0].map((heading, i) => [
          heading,
          rows.find((r) => r[0] === metric.label)![i],
        ]),
      );
    },
  };
}
function nullableExportFixture() {
  const known: Building = {
    ...buildingPreset("office", workforcePlaceFixture.center),
    id: "known-quantities",
    units: 7,
    jobs: 3,
    parkingSpaces: 0,
  };
  const unknown: Building = {
    ...known,
    id: "unknown-quantities",
    floors: null,
    units: null,
    jobs: null,
    parkingSpaces: null,
    attributeProvenance: {
      version: 1,
      fields: Object.fromEntries(
        ["floors", "units", "jobs", "parkingSpaces"].map((field) => [
          field,
          { status: "missing", sourceId: USER_BUILDING_SOURCE.id },
        ]),
      ),
    },
  };
  const place = {
      ...structuredClone(workforcePlaceFixture),
      buildings: [known],
    },
    scenario = createProject(place).scenarios[1];
  scenario.buildingEdits[unknown.id] = unknown;
  return { place, scenario, known, unknown };
}

describe("browser export completeness", () => {
  it("preserves partial and unavailable totals, exact known subtotals and missing IDs without changing the legacy CSV columns", () => {
    const { place, scenario, known, unknown } = nullableExportFixture(),
      results = calculateImpact(place, scenario),
      exported = scorecardRows(results);
    expect(exported.headings.slice(0, 11)).toEqual([
      "Metric",
      "Domain",
      "Unit",
      "Baseline",
      "Scenario",
      "Delta",
      "Status",
      "Method",
      "Revision",
      "Formula",
      "Caveat",
    ]);
    expect(exported.headings.slice(11)).toEqual([
      "baseline_known_subtotal",
      "scenario_known_subtotal",
      "baseline_missing_building_ids",
      "scenario_missing_building_ids",
    ]);
    expect(exported.metric("economy.jobs")).toMatchObject({
      Baseline: "3",
      Scenario: "",
      Delta: "",
      Status: "unavailable",
      baseline_known_subtotal: "3",
      scenario_known_subtotal: "3",
      baseline_missing_building_ids: "[]",
      scenario_missing_building_ids: '["unknown-quantities"]',
    });
    expect(exported.metric("mobility.parkingSupply")).toMatchObject({
      Baseline: "0",
      Scenario: "",
      scenario_known_subtotal: "0",
      scenario_missing_building_ids: '["unknown-quantities"]',
    });
    const completeMetric = results.metrics.find(
      (m) => m.id === "land.footprint",
    )!;
    expect(exported.metric("land.footprint")).toMatchObject({
      Baseline: String(known.areaSqm),
      Scenario: String(known.areaSqm * 2),
      Delta: String(known.areaSqm),
      Status: completeMetric.status,
      baseline_known_subtotal: "",
      scenario_known_subtotal: "",
      baseline_missing_building_ids: "[]",
      scenario_missing_building_ids: "[]",
    });
    const entirelyUnknown = { ...place, buildings: [unknown] },
      emptyScenario = createProject(entirelyUnknown).scenarios[1];
    expect(
      scorecardRows(calculateImpact(entirelyUnknown, emptyScenario)).metric(
        "economy.jobs",
      ),
    ).toMatchObject({
      Baseline: "",
      Scenario: "",
      baseline_known_subtotal: "",
      scenario_known_subtotal: "",
    });
    const knownZero = { ...place, buildings: [{ ...known, jobs: 0 }] };
    expect(
      scorecardRows(
        calculateImpact(knownZero, createProject(knownZero).scenarios[1]),
      ).metric("economy.jobs"),
    ).toMatchObject({
      Baseline: "0",
      Scenario: "0",
      Delta: "0",
      scenario_known_subtotal: "",
      scenario_missing_building_ids: "[]",
    });
  });

  it("labels incomplete HTML values as known subtotals, retains zero and distinguishes an entirely unknown subtotal", () => {
    const { place, scenario, unknown } = nullableExportFixture(),
      results = calculateImpact(place, scenario),
      html = reportHTML(place, scenario, results);
    expect(html).toContain(
      "Baseline completeness: no required building attributes are missing for this measure.",
    );
    expect(html).toContain(
      "Proposal completeness: 1 building lacks required attributes. Known subtotal: 3 jobs; not a complete total.",
    );
    expect(html).toContain("Known subtotal: 0 spaces; not a complete total.");
    expect(html).toContain(
      "Complete missing-building identifier lists are retained in the CSV and project JSON exports.",
    );
    const whollyUnknown = { ...place, buildings: [unknown] },
      unknownScenario = createProject(whollyUnknown).scenarios[1],
      unknownResults = calculateImpact(whollyUnknown, unknownScenario),
      jobsOnly = {
        ...unknownResults,
        metrics: unknownResults.metrics.filter((m) => m.id === "economy.jobs"),
      };
    const unknownHTML = reportHTML(whollyUnknown, unknownScenario, jobsOnly);
    expect(unknownHTML).toContain(
      "Known subtotal: Unknown; not a complete total.",
    );
    expect(unknownHTML).not.toContain("Known subtotal: 0");
    // Rendering a report must not replace missing values in the saved result.
    expect(jobsOnly.metrics[0].value).toBeNull();
    expect(jobsOnly.metrics[0].coverage!.scenario.knownSubtotal).toBeNull();
  });

  it("shows Unknown rather than a blank for explicit-program parking while preserving known zero supply", () => {
    const place = {
      ...structuredClone(workforcePlaceFixture),
      buildings: [] as Building[],
    };
    for (const parkingSpaces of [null, 0] as const) {
      const scenario = createProject(place).scenarios[1],
        building: Building = typedBuildingPreset("office", place.center);
      building.parkingSpaces = parkingSpaces;
      building.attributeProvenance = {
        version: 1,
        fields: {
          parkingSpaces: {
            status: parkingSpaces === null ? "missing" : "supplied",
            sourceId: USER_BUILDING_SOURCE.id,
          },
        },
      };
      scenario.buildingEdits[building.id] = building;
      const html = reportHTML(
        place,
        scenario,
        calculateImpact(place, scenario),
      );
      expect(html).toContain(
        parkingSpaces === null
          ? "Parking supply: Unknown, separate from demand."
          : "Parking supply: 0 spaces, separate from demand.",
      );
      expect(html).not.toContain("Parking supply:  spaces");
      expect(building.parkingSpaces).toBe(parkingSpaces);
    }
  });
});
