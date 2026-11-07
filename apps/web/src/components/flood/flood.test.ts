import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { IDBFactory } from "fake-indexeddb";
import {
  calculateImpact,
  createProject,
  resolveFloodExposure,
} from "@urban/models";
import {
  baselineIdentity,
  floodDatasetHash,
  materializeBuildings,
  FLOOD_METHOD_VERSION,
  FLOOD_LEGACY_METHOD_VERSION,
  floodMethodVersion,
  type Scenario,
  type FloodReference,
} from "@urban/core";
import {
  floodFixture,
  floodRectangle,
} from "../../../../../tests/fixtures/flood";
import { useWorkspace } from "../../lib/workspace";
import {
  flushWorkspaceWrites,
  readWorkspace,
} from "../../lib/workspace-storage";
import { TestFloodValidationWorker } from "../../lib/flood-validation.test-helper";
import { floodCSV, floodHTML } from "../../lib/flood-export";
import { floodMapParts } from "../map/flood-layer";
import { FloodEvidence } from "./FloodEvidence";
import { FloodMethod } from "./FloodMethod";
import { floodComparisonScenarios, floodComparisonMetrics } from "./comparison";
import { floodCount, floodDates, floodZoneKind } from "./presentation";
beforeEach(async () => {
  await flushWorkspaceWrites();
  vi.stubGlobal("Worker", TestFloodValidationWorker);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  useWorkspace.getState().setReadOnly(false);
});
afterEach(async () => {
  await flushWorkspaceWrites();
  vi.unstubAllGlobals();
});
describe("retained flood frontend", () => {
  it("attaches catalog and a reference-only history atomically, keeps evidence on undo/remove and downgrades restored copies", async () => {
    const f = await floodFixture();
    await useWorkspace.getState().initialize(f.place);
    const original = structuredClone(useWorkspace.getState().project!);
    await useWorkspace.getState().attachFlood(f.dataset, f.datasetHash);
    let p = useWorkspace.getState().project!;
    expect(p.schemaVersion).toBe(11);
    expect(p.history).toHaveLength(1);
    expect(
      p.scenarios.find((s) => s.id === p.activeScenarioId)?.flood
        ?.methodVersion,
    ).toBe(FLOOD_METHOD_VERSION);
    expect(JSON.stringify(p.history)).not.toContain("layerReceipts");
    expect(p.floodDatasets?.[f.datasetHash]).toEqual(f.dataset);
    const catalogIdentity = p.floodDatasets;
    useWorkspace.getState().undo();
    p = useWorkspace.getState().project!;
    expect(p.floodDatasets).toBe(catalogIdentity);
    expect(
      p.scenarios.find((s) => s.id === p.activeScenarioId)?.flood,
    ).toBeUndefined();
    expect(p.floodDatasets?.[f.datasetHash]).toEqual(f.dataset);
    useWorkspace.getState().redo();
    useWorkspace
      .getState()
      .dispatch({ type: "scenario.flood", flood: null }, "Remove flood map");
    useWorkspace.getState().undo();
    await flushWorkspaceWrites();
    const saved = await readWorkspace();
    expect(saved?.project.floodDatasets).toEqual(p.floodDatasets);
    p = useWorkspace.getState().project!;
    expect(p.scenarios[0]).toEqual(original.scenarios[0]);
    await useWorkspace.getState().restoreCopy({
      project: p,
      place: f.place,
      baselineIdentity: await baselineIdentity(f.place),
    });
    const restored = useWorkspace.getState().project!;
    expect(restored.scenarios.find((s) => s.flood)?.flood?.origin).toBe(
      "imported",
    );
    expect(restored.floodDatasets).toEqual(p.floodDatasets);
    expect(restored.scenarios.find((s) => s.flood)?.flood?.methodVersion).toBe(
      FLOOD_METHOD_VERSION,
    );
  });
  it("updates legacy calculations only by explicit reversible command and retains source bytes and prior history", async () => {
    const f = await floodFixture();
    await useWorkspace.getState().replace(f.project, f.place);
    const before = useWorkspace.getState().project!;
    const scenario = before.scenarios.find(
      (s) => s.id === before.activeScenarioId,
    )!;
    const reference = JSON.stringify(scenario.flood);
    const sourceBytes = JSON.stringify(before.floodDatasets);
    expect(scenario.flood).not.toHaveProperty("methodVersion");
    expect(floodMethodVersion(scenario.flood)).toBe(
      FLOOD_LEGACY_METHOD_VERSION,
    );
    useWorkspace.getState().updateFloodMethod(before, scenario);
    let current = useWorkspace.getState().project!;
    expect(current.floodDatasets).toBe(before.floodDatasets);
    expect(JSON.stringify(current.floodDatasets)).toBe(sourceBytes);
    expect(current.history.at(-1)?.before.flood).toEqual(scenario.flood);
    expect(current.history.at(-1)?.command).toEqual({
      type: "scenario.flood",
      flood: { ...scenario.flood, methodVersion: FLOOD_METHOD_VERSION },
    });
    expect(current.scenarios.find((s) => s.id === scenario.id)?.flood).toEqual({
      ...scenario.flood,
      methodVersion: FLOOD_METHOD_VERSION,
    });
    expect(JSON.stringify(scenario.flood)).toBe(reference);
    useWorkspace.getState().undo();
    current = useWorkspace.getState().project!;
    expect(
      JSON.stringify(
        current.scenarios.find((s) => s.id === scenario.id)?.flood,
      ),
    ).toBe(reference);
    useWorkspace.getState().redo();
    current = useWorkspace.getState().project!;
    expect(
      current.scenarios.find((s) => s.id === scenario.id)?.flood?.methodVersion,
    ).toBe(FLOOD_METHOD_VERSION);
    await flushWorkspaceWrites();
    const saved = await readWorkspace();
    expect(saved?.project.history.at(-1)?.before.flood).not.toHaveProperty(
      "methodVersion",
    );
    expect(
      saved?.project.scenarios.find((s) => s.id === scenario.id)?.flood
        ?.methodVersion,
    ).toBe(FLOOD_METHOD_VERSION);
  });
  it("rejects method updates from stale scenario scope or after permission loss", async () => {
    const f = await floodFixture();
    await useWorkspace.getState().replace(f.project, f.place);
    const before = useWorkspace.getState().project!;
    const scenario = before.scenarios.find(
      (s) => s.id === before.activeScenarioId,
    )!;
    useWorkspace
      .getState()
      .dispatch({ type: "scenario.rename", name: "Newer choice" }, "Rename");
    expect(() =>
      useWorkspace.getState().updateFloodMethod(before, scenario),
    ).toThrow(/changed/);
    const current = useWorkspace.getState().project!;
    const currentScenario = current.scenarios.find(
      (s) => s.id === current.activeScenarioId,
    )!;
    useWorkspace.getState().setReadOnly(true);
    expect(() =>
      useWorkspace.getState().updateFloodMethod(current, currentScenario),
    ).toThrow(/changed/);
    expect(useWorkspace.getState().project).toBe(current);
    expect(currentScenario.flood).not.toHaveProperty("methodVersion");
  });
  it("shows exact legacy/current methods in read-only evidence and offers an explicit editable legacy update only", async () => {
    const f = await floodFixture();
    const references: FloodReference[] = [
      f.scenario.flood!,
      { ...f.scenario.flood!, methodVersion: FLOOD_METHOD_VERSION },
    ];
    for (const reference of references) {
      const scenario = { ...f.scenario, flood: reference };
      const html = renderToStaticMarkup(
        createElement(FloodEvidence, {
          place: f.place,
          scenario,
          dataset: f.dataset,
          context: f.context,
          resolution: null,
        }),
      );
      expect(html).toContain(floodMethodVersion(reference));
      expect(html).not.toContain("Update calculation method");
    }
    const editable = renderToStaticMarkup(
      createElement(FloodMethod, {
        reference: f.scenario.flood!,
        onUpdate: () => {},
      }),
    );
    expect(editable).toContain("Update calculation method");
    expect(editable).toContain("source map is unchanged");
    expect(editable).toContain(
      "prior reports and published snapshots retain their original method",
    );
    expect(
      renderToStaticMarkup(
        createElement(FloodMethod, {
          reference: {
            ...f.scenario.flood!,
            methodVersion: FLOOD_METHOD_VERSION,
          },
          onUpdate: () => {},
        }),
      ),
    ).not.toContain("Update calculation method");
  });
  it("uses the full common method for comparison and does not assign a single baseline method to mixed-method alternatives", async () => {
    const f = await floodFixture();
    const baseline = f.project.scenarios.find((s) => s.id === "baseline")!;
    const legacy = f.scenario;
    const current: Scenario = {
      ...legacy,
      id: "current",
      flood: { ...legacy.flood!, methodVersion: FLOOD_METHOD_VERSION },
    };
    const latestPair = floodComparisonScenarios([baseline, current]);
    expect(latestPair[0].flood).toEqual(current.flood);
    expect(baseline.flood).toBeUndefined();
    expect(floodComparisonScenarios([baseline, legacy, current])[0]).toBe(
      baseline,
    );
    const explicitLegacy: Scenario = {
      ...legacy,
      id: "explicit-legacy",
      flood: { ...legacy.flood!, methodVersion: FLOOD_LEGACY_METHOD_VERSION },
    };
    expect(
      floodComparisonScenarios([baseline, legacy, explicitLegacy])[0].flood,
    ).toEqual(legacy.flood);
  });
  it("labels mixed-method flood rows from a selected footprint-screen result without changing baseline values or other metrics", async () => {
    const f = await floodFixture();
    const baseline = f.project.scenarios.find(
      (scenario) => scenario.id === "baseline",
    )!;
    const current: Scenario = {
      ...f.scenario,
      id: "current",
      flood: { ...f.scenario.flood!, methodVersion: FLOOD_METHOD_VERSION },
    };
    const scenarios = floodComparisonScenarios([baseline, f.scenario, current]);
    const results = scenarios.map((scenario) =>
      calculateImpact(f.place, scenario, undefined, f.context),
    );
    const oldMetric = results[0].metrics.find(
      (metric) => metric.id === "environment.flood",
    )!;
    expect(oldMetric.label).toBe("Homes in mapped flood hazard");
    expect(oldMetric.unit).toBe("units");
    expect(scenarios[0].flood).toBeUndefined();
    const metrics = floodComparisonMetrics(scenarios, results);
    expect(metrics.find((metric) => metric.id === "environment.flood")).toEqual(
      {
        ...oldMetric,
        label: "Homes in SFHA-intersecting buildings",
        unit: results[1].metrics.find(
          (metric) => metric.id === "environment.flood",
        )!.unit,
      },
    );
    for (const metric of metrics.filter(
      (metric) => metric.id !== "environment.flood",
    ))
      expect(metric).toBe(
        results[0].metrics.find((candidate) => candidate.id === metric.id),
      );
    expect(
      results[0].metrics.find((metric) => metric.id === "environment.flood"),
    ).toBe(oldMetric);
    expect(oldMetric.label).toBe("Homes in mapped flood hazard");
    // Results from a deselected flood proposal cannot relabel a baseline-only view.
    expect(floodComparisonMetrics([baseline], results)).toBe(
      results[0].metrics,
    );
  });
  it("rejects a late attachment after another scenario edit without installing any catalog", async () => {
    const f = await floodFixture();
    await useWorkspace.getState().initialize(f.place);
    const pending = useWorkspace
      .getState()
      .attachFlood(f.dataset, f.datasetHash);
    useWorkspace
      .getState()
      .dispatch(
        { type: "scenario.rename", name: "Changed during load" },
        "Rename",
      );
    await expect(pending).rejects.toThrow(/changed/);
    expect(useWorkspace.getState().project!.floodDatasets).toBeUndefined();
  });
  it.each(["cancel", "permission loss"] as const)(
    "keeps the project unchanged after attachment %s",
    async (reason) => {
      const f = await floodFixture();
      await useWorkspace.getState().initialize(f.place);
      const original = useWorkspace.getState().project;
      const controller = new AbortController();
      const pending = useWorkspace
        .getState()
        .attachFlood(f.dataset, f.datasetHash, controller.signal);
      if (reason === "cancel") controller.abort();
      else useWorkspace.getState().setReadOnly(true);
      await expect(pending).rejects.toThrow(
        reason === "cancel" ? /cancelled/ : /changed/,
      );
      expect(useWorkspace.getState().project).toBe(original);
      expect(original!.floodDatasets).toBeUndefined();
    },
  );
  it("keeps unknown homes and partial classification visible rather than rendering a reassuring zero", async () => {
    const f = await floodFixture();
    const dataset = { ...f.dataset, zones: [f.dataset.zones[0]] };
    const hash = await floodDatasetHash(dataset);
    const place = structuredClone(f.place);
    place.buildings[0].units = null;
    place.buildings[0].attributeProvenance = {
      version: 1,
      fields: { units: { status: "missing", sourceId: "flood-fixture" } },
    };
    const scenario = {
        ...f.scenario,
        flood: { ...f.scenario.flood!, datasetHash: hash },
      },
      context = { floodDatasets: { [hash]: dataset } },
      resolution = resolveFloodExposure(place, scenario, context);
    expect(resolution.scenario.value).toBeNull();
    expect(resolution.scenario.missingUnitBuildingIds).toContain("wet");
    expect(resolution.scenario.unclassifiedBuildingIds).toContain("clear");
    const html = renderToStaticMarkup(
      createElement(FloodEvidence, {
        place,
        scenario,
        dataset,
        context,
        resolution,
      }),
    );
    expect(html).toContain("Unknown");
    expect(html).toContain("undetermined");
    expect(html).not.toContain(">Safe<");
    expect(floodCount({ ...resolution.scenario, value: 0 })).toBe("0");
  });
  it("exports all baseline and proposed rows with unknowns, exact source identity, formula-safe names and exposure contributions", async () => {
    const f = await floodFixture();
    const scenario = {
      ...f.scenario,
      buildingEdits: {
        ...f.scenario.buildingEdits,
        wet: { ...f.place.buildings[0], name: '=HYPERLINK("bad")', units: 20 },
      },
    };
    const output = floodCSV(
      f.place,
      scenario,
      f.context,
      resolveFloodExposure(f.place, scenario, f.context),
    );
    expect(output).toContain(f.datasetHash);
    expect(output).toContain("'=HYPERLINK");
    expect(output.split("\r\n")).toHaveLength(5);
    expect(output).toContain("counted_exposed_homes");
    expect(output).toContain('"20"');
    expect(materializeBuildings(f.place, scenario)[0].units).toBe(20);
  });
  it("requires the current worker result for CSV and HTML and preserves its explicit unknowns", async () => {
    const f = await floodFixture();
    const resolution = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(() => floodHTML(f.place, f.scenario, f.context)).toThrow(/Wait for/);
    expect(() =>
      floodCSV(f.place, f.scenario, f.context, {
        ...resolution,
        datasetHash: "0".repeat(64),
      }),
    ).toThrow(/Wait for/);
    const incomplete = {
      ...resolution,
      baseline: { ...resolution.baseline, value: null, knownSubtotal: null },
    };
    expect(floodHTML(f.place, f.scenario, f.context, incomplete)).toContain(
      "baseline Unavailable",
    );
  });
  it("exports the selected method and rejects a stale result from another method under the same source hash", async () => {
    const f = await floodFixture();
    const legacyResult = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(legacyResult.methodVersion).toBe(FLOOD_LEGACY_METHOD_VERSION);
    const current: Scenario = {
      ...f.scenario,
      flood: { ...f.scenario.flood!, methodVersion: FLOOD_METHOD_VERSION },
    };
    const currentResult = resolveFloodExposure(f.place, current, f.context);
    expect(currentResult.methodVersion).toBe(FLOOD_METHOD_VERSION);
    expect(() => floodCSV(f.place, current, f.context, legacyResult)).toThrow(
      /current flood/,
    );
    expect(() => floodHTML(f.place, current, f.context, legacyResult)).toThrow(
      /current flood/,
    );
    expect(floodCSV(f.place, current, f.context, currentResult)).toContain(
      FLOOD_METHOD_VERSION,
    );
    expect(floodHTML(f.place, current, f.context, currentResult)).toContain(
      `Calculation method: ${FLOOD_METHOD_VERSION}`,
    );
    expect(floodHTML(f.place, f.scenario, f.context, legacyResult)).toContain(
      `Calculation method: ${FLOOD_LEGACY_METHOD_VERSION}`,
    );
  });
  it("labels panel, revision, database and preliminary dates separately and preserves placeholders as unknown", async () => {
    const f = await floodFixture();
    f.dataset.capture.studyInfo = [
      { DFIRM_ID: "04013C", DBREV_DT: Date.parse("2025-02-04T00:00:00Z") },
    ];
    f.dataset.panels[0].attributes = {
      FIRM_PAN: "04013C0001L",
      EFF_DATE: Date.parse("2013-10-16T00:00:00Z"),
      PRE_DATE: Date.parse("9999-09-09T00:00:00Z"),
    };
    f.dataset.revisions = [
      {
        ...f.dataset.panels[0],
        id: "case-1",
        attributes: { CASE_NO: "case-1", EFF_DATE: "9999-09-09" },
      },
    ];
    const before = JSON.stringify(f.dataset),
      dates = floodDates(f.dataset);
    expect(dates).toContain("Panel 04013C0001L · effective: 2013-10-16");
    expect(dates).toContain("Study 04013C · database revision: 2025-02-04");
    expect(dates).toContain(
      "Panel 04013C0001L · preliminary source date (not effective): Not supplied / source placeholder (9999-09-09)",
    );
    expect(dates).toContain(
      "Map revision case-1 · effective: Not supplied / source placeholder (9999-09-09)",
    );
    expect(JSON.stringify(f.dataset)).toBe(before);
  });
  it("uses the retained FEMA study index date ahead of generic effective-date aliases", async () => {
    const f = await floodFixture();
    f.dataset.capture.studyInfo = [
      {
        DFIRM_ID: "04013C",
        INDX_EFFDT: 1707350400000,
        EFF_DATE: Date.parse("2013-10-16T00:00:00Z"),
        DBREV_DT: 0,
      },
    ];
    const before = JSON.stringify(f.dataset);
    expect(floodDates(f.dataset)).toContain(
      "Study 04013C · index effective: 2024-02-08",
    );
    expect(floodDates(f.dataset)).toContain(
      "Study 04013C · database revision: 1970-01-01",
    );
    expect(JSON.stringify(f.dataset)).toBe(before);
  });
  it("retains all multipart rings and holes while elevating only rendered coordinates", async () => {
    const f = await floodFixture(),
      source = structuredClone(f.dataset);
    const a = floodRectangle(-112.078, 33.442, -112.074, 33.448),
      h = floodRectangle(-112.077, 33.443, -112.076, 33.444);
    if (a.type !== "Polygon" || h.type !== "Polygon") throw Error("fixture");
    source.zones[0].geometry = {
      type: "MultiPolygon",
      coordinates: [[a.coordinates[0], h.coordinates[0]], [a.coordinates[0]]],
    };
    const before = JSON.stringify(source);
    const parts = floodMapParts(source);
    expect(parts[0].rings).toHaveLength(2);
    expect(parts[1].zone.id).toBe(parts[0].zone.id);
    expect(parts[0].rings[0][0][2]).toBe(0.045);
    expect(JSON.stringify(source)).toBe(before);
    expect(
      floodZoneKind({
        ...source.zones[0],
        attributes: { ...source.zones[0].attributes, ZONE_SUBTY: "FLOODWAY" },
      }),
    ).toBe("floodway");
  });
});
