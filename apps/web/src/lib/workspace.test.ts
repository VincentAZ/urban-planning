import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./workspace";
import { workforceScenarioFixture } from "../../../../tests/fixtures/workforce";
import {
  typedBuildingPreset,
  buildingPreset,
  createProject,
  calculateImpact,
  adoptActivityScenario,
} from "@urban/models";
import {
  baselineIdentity,
  materializeParcels,
  parcelPreset,
  splitParcel,
  USER_PARCEL_SOURCE,
  USER_ACTIVITY_SOURCE,
  USER_RETAIL_SOURCE,
  validateProjectSnapshot,
  type Place,
  type ScenarioPresentation,
  type RetailScenario,
} from "@urban/core";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { projectRevisionKey } from "./cloud-workspace";
import {
  flushWorkspaceWrites,
  listWorkspaceDrafts,
  readWorkspaceDraft,
  readWorkspace,
  writeWorkspace,
} from "./workspace-storage";

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
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05",
  extentLabel: "Synthetic test fixture",
};
beforeEach(async () => {
  await flushWorkspaceWrites();
  vi.restoreAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
  await useWorkspace.getState().initialize(place);
  await flushWorkspaceWrites();
});
const current = () => {
  const p = useWorkspace.getState().project!;
  return p.scenarios.find((s) => s.id === p.activeScenarioId)!;
};
const retailStudy = (): RetailScenario => ({
  version: 1,
  context: {
    geography: "Synthetic fixture trade area",
    relationshipToStudyArea: "same-area",
    referenceYear: 2024,
    dollarYear: 2024,
    currency: "USD",
    classification: { system: "NAICS", version: "2022" },
    horizon: 0,
    comparabilityConfirmed: true,
    disjointCategoriesConfirmed: true,
  },
  categories: [
    {
      id: "groceries",
      name: "Grocery stores",
      code: "4451",
      baselineDemand: {
        status: "available",
        value: 1000000,
        sourceId: USER_RETAIL_SOURCE.id,
      },
      baselineSales: {
        status: "available",
        value: 600000,
        sourceId: USER_RETAIL_SOURCE.id,
      },
      salesPerEstablishment: {
        status: "available",
        value: 200000,
        sourceId: USER_RETAIL_SOURCE.id,
      },
      scenarioDemand: null,
      annualSalesCapacity: 150000,
      captureShare: 0.5,
      displacementShare: 0.2,
      assumptionSourceId: USER_RETAIL_SOURCE.id,
    },
  ],
  sourceRights: [
    {
      sourceId: USER_RETAIL_SOURCE.id,
      authorizedPrivateUse: true,
      publicRedistribution: false,
      statement:
        "Synthetic QA figures; private project analysis and export permitted.",
    },
  ],
});
describe("workforce capture persistence", () => {
  it("adopts compact workforce evidence in one step, keeps format7 on undo/removal and restores it durably", async () => {
    const identity = useWorkspace.getState().baselineIdentity;
    const { workforce } = await workforceScenarioFixture({
      place,
      projectId: useWorkspace.getState().project!.id,
    });
    useWorkspace
      .getState()
      .dispatch({ type: "scenario.workforce", workforce }, "Adopt workforce");
    expect(current().workforce).toEqual(workforce);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(7);
    expect(useWorkspace.getState().project!.history).toHaveLength(1);
    useWorkspace.getState().undo();
    expect(current().workforce).toBeUndefined();
    expect(useWorkspace.getState().project!.schemaVersion).toBe(7);
    useWorkspace.getState().redo();
    expect(current().workforce).toEqual(workforce);
    useWorkspace.getState().branch("Workforce branch");
    expect(current().workforce).toEqual(workforce);
    useWorkspace
      .getState()
      .dispatch(
        { type: "scenario.workforce", workforce: null },
        "Remove workforce",
      );
    expect(current().workforce).toBeUndefined();
    expect(useWorkspace.getState().project!.schemaVersion).toBe(7);
    const saved = useWorkspace.getState().project;
    const other = structuredClone(workforce);
    other.binding.baselineHash = "f".repeat(64);
    expect(() =>
      useWorkspace
        .getState()
        .dispatch(
          { type: "scenario.workforce", workforce: other },
          "Wrong baseline",
        ),
    ).toThrow("immutable baseline");
    expect(useWorkspace.getState().project).toBe(saved);
    await flushWorkspaceWrites();
    const restored = await readWorkspace();
    expect(restored!.project.schemaVersion).toBe(7);
    expect(restored!.baselineIdentity).toEqual(identity);
    await expect(validateProjectSnapshot(restored)).resolves.toBeTruthy();
    await useWorkspace.getState().restoreCopy(restored!);
    const copy = useWorkspace.getState().project!;
    expect(copy.id).not.toBe(restored!.project.id);
    const retained = [
      ...copy.scenarios,
      ...[...copy.history, ...copy.undone].flatMap((entry) => [
        entry.before,
        entry.after,
      ]),
    ].flatMap((scenario) => (scenario.workforce ? [scenario.workforce] : []));
    expect(retained.length).toBeGreaterThan(0);
    for (const capture of retained) {
      expect(capture.origin).toBe("imported");
      expect(capture.captureHash).toBe(workforce.captureHash);
      expect(capture.receipt.projectId).toBe(workforce.receipt.projectId);
    }
    for (const entry of [...copy.history, ...copy.undone])
      if (
        entry.command.type === "scenario.workforce" &&
        entry.command.workforce
      )
        expect(entry.command.workforce.origin).toBe("imported");
    expect(
      restored!.project.scenarios.find((s) => s.workforce)?.workforce?.origin,
    ).toBe("server-run");
    await flushWorkspaceWrites();
    await expect(
      validateProjectSnapshot(await readWorkspace()),
    ).resolves.toBeTruthy();
  });
});
describe("retail study persistence", () => {
  it("retains exact evidence through atomic history, independent branching, reload and removal without changing the baseline", async () => {
    const store = useWorkspace.getState();
    const identity = store.baselineIdentity;
    const baseline = structuredClone(store.project!.scenarios[0]);
    const study = retailStudy();
    store.dispatch({ type: "scenario.retail", retail: study }, "Retail study");
    expect(current().retail).toEqual(study);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(6);
    expect(
      calculateImpact(place, current()).metrics.find(
        (m) => m.id === "economy.retailGap",
      )?.value,
    ).toBe(280000);
    store.undo();
    expect(current().retail).toBeUndefined();
    expect(useWorkspace.getState().project!.schemaVersion).toBe(6);
    store.redo();
    const originalId = current().id;
    store.branch("Another retail option");
    const changed = structuredClone(current().retail!);
    changed.categories[0].annualSalesCapacity = 0;
    store.dispatch(
      { type: "scenario.retail", retail: changed },
      "No added capacity",
    );
    store.activate(originalId);
    expect(current().retail).toEqual(study);
    await flushWorkspaceWrites();
    await store.initialize(place);
    expect(current().retail).toEqual(study);
    store.dispatch(
      { type: "scenario.retail", retail: null },
      "Remove retail study",
    );
    expect(current().retail).toBeUndefined();
    store.undo();
    expect(current().retail).toEqual(study);
    expect(useWorkspace.getState().baselineIdentity).toEqual(identity);
    expect(useWorkspace.getState().project!.scenarios[0]).toEqual(baseline);
    await validateProjectSnapshot({
      project: useWorkspace.getState().project,
      place,
      baselineIdentity: identity,
    });
  });
  it("rejects missing source rights and incompatible categories without writing history, and respects review-only access", () => {
    const store = useWorkspace.getState();
    const before = store.project;
    const invalid = retailStudy();
    invalid.sourceRights = [];
    expect(() =>
      store.dispatch(
        { type: "scenario.retail", retail: invalid },
        "Invalid rights",
      ),
    ).toThrow();
    expect(useWorkspace.getState().project).toBe(before);
    const overlapping = retailStudy();
    overlapping.categories.push({
      ...structuredClone(overlapping.categories[0]),
      id: "parent",
      code: "445",
    });
    expect(() =>
      store.dispatch(
        { type: "scenario.retail", retail: overlapping },
        "Overlapping categories",
      ),
    ).toThrow();
    expect(useWorkspace.getState().project).toBe(before);
    store.setReadOnly(true);
    store.dispatch(
      { type: "scenario.retail", retail: retailStudy() },
      "Forbidden retail edit",
    );
    expect(useWorkspace.getState().project).toBe(before);
    store.setReadOnly(false);
    store.activate("baseline");
    store.dispatch(
      { type: "scenario.retail", retail: retailStudy() },
      "Forbidden baseline edit",
    );
    expect(current().retail).toBeUndefined();
  });
});
describe("activity scenario persistence", () => {
  it("saves one reviewed activity edit with horizon, undo/redo, independent branch and immutable baseline", async () => {
    const store = useWorkspace.getState(),
      identity = store.baselineIdentity,
      baseline = structuredClone(store.project!.scenarios[0]);
    const activity = adoptActivityScenario(place, current());
    activity.global.population = { mode: "absolute", value: 125 };
    store.dispatch(
      {
        type: "scenario.activity",
        activity,
        horizon: 10,
        sources: [USER_ACTIVITY_SOURCE],
      },
      "Population scenario",
    );
    expect(current().activity?.global.population).toEqual({
      mode: "absolute",
      value: 125,
    });
    expect(current().horizon).toBe(10);
    expect(useWorkspace.getState().project!.history).toHaveLength(1);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(5);
    store.undo();
    expect(current().activity).toBeUndefined();
    expect(current().horizon).toBe(0);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(5);
    store.redo();
    const parent = current().id;
    store.branch("Another population");
    const edited = structuredClone(current().activity!);
    edited.global.population = { mode: "absolute", value: 500 };
    store.dispatch(
      { type: "scenario.activity", activity: edited },
      "Branch activity",
    );
    store.activate(parent);
    expect(current().activity?.global.population).toEqual({
      mode: "absolute",
      value: 125,
    });
    await flushWorkspaceWrites();
    await store.initialize(place);
    expect(current().activity?.global.population).toEqual({
      mode: "absolute",
      value: 125,
    });
    expect(useWorkspace.getState().baselineIdentity).toEqual(identity);
    expect(useWorkspace.getState().project!.scenarios[0]).toEqual(baseline);
  });
  it("rejects invalid or out-of-bound activity without history writes and respects read-only state", () => {
    const store = useWorkspace.getState(),
      original = store.project!,
      activity = adoptActivityScenario(place, current());
    activity.neighborhoods = [
      {
        id: "outside",
        name: "Outside",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
        sourceId: USER_ACTIVITY_SOURCE.id,
      },
    ];
    expect(() =>
      store.dispatch({ type: "scenario.activity", activity }, "Outside"),
    ).toThrow();
    expect(useWorkspace.getState().project).toBe(original);
    store.setReadOnly(true);
    store.dispatch(
      {
        type: "scenario.activity",
        activity: adoptActivityScenario(place, current()),
      },
      "Forbidden",
    );
    expect(useWorkspace.getState().project).toBe(original);
    store.setReadOnly(false);
    store.activate("baseline");
    store.dispatch(
      {
        type: "scenario.activity",
        activity: adoptActivityScenario(place, current()),
      },
      "Forbidden baseline",
    );
    expect(current().activity).toBeUndefined();
    expect(useWorkspace.getState().project!.history).toHaveLength(0);
  });
});
const tour = (): ScenarioPresentation => ({
  version: 1,
  title: "Council review",
  stops: [
    {
      id: "overview",
      title: "The proposal",
      callout: "Review the source and assumptions.",
      camera: { center: [...place.center], zoom: 15, pitch: 45, bearing: -27 },
      view: "3d",
      metricIds: ["housing.units"],
    },
    {
      id: "plan",
      title: "Street context",
      callout: "An authored viewpoint.",
      camera: { center: [...place.center], zoom: 17, pitch: 0, bearing: 0 },
      view: "2d",
      narration: "User-authored reading text.",
    },
  ],
});
describe("saved presentation history", () => {
  it("persists one ordered tour edit, undo/redo/remove and independent branches while retaining format4 and source identity", async () => {
    const store = useWorkspace.getState(),
      identity = store.baselineIdentity,
      baseline = structuredClone(store.project!.scenarios[0]);
    const authored = tour();
    store.dispatch(
      { type: "scenario.presentation", presentation: authored },
      "Save guided presentation",
    );
    expect(current().presentation).toEqual(authored);
    expect(current().revision).toBe(1);
    expect(useWorkspace.getState().project!.history).toHaveLength(1);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(4);
    store.undo();
    expect(current()).not.toHaveProperty("presentation");
    expect(current().revision).toBe(2);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(4);
    store.redo();
    expect(current().presentation).toEqual(authored);
    const parentId = current().id;
    store.branch("Another telling");
    expect(current().presentation).toEqual(authored);
    const changed = structuredClone(current().presentation!);
    changed.stops.reverse();
    changed.stops[0].callout = "A different order.";
    store.dispatch(
      { type: "scenario.presentation", presentation: changed },
      "Reorder branch tour",
    );
    expect(current().presentation!.stops[0].id).toBe("plan");
    store.activate(parentId);
    expect(current().presentation).toEqual(authored);
    store.dispatch(
      { type: "scenario.presentation", presentation: null },
      "Remove guided presentation",
    );
    expect(current()).not.toHaveProperty("presentation");
    store.undo();
    expect(current().presentation).toEqual(authored);
    await flushWorkspaceWrites();
    const saved = await readWorkspace();
    expect(saved!.project.schemaVersion).toBe(4);
    expect(saved!.baselineIdentity).toEqual(identity);
    await store.initialize(place);
    expect(current().presentation).toEqual(authored);
    expect(useWorkspace.getState().project!.scenarios[0]).toEqual(baseline);
    expect(useWorkspace.getState().baselineIdentity).toEqual(identity);
  });

  it("rejects invalid presentation edits atomically and blocks baseline/read-only authoring", async () => {
    const store = useWorkspace.getState(),
      original = store.project!,
      invalid = tour();
    invalid.stops[0].camera.zoom = Infinity;
    expect(() =>
      store.dispatch(
        { type: "scenario.presentation", presentation: invalid },
        "Invalid camera",
      ),
    ).toThrow();
    expect(useWorkspace.getState().project).toBe(original);
    store.setReadOnly(true);
    store.dispatch(
      { type: "scenario.presentation", presentation: tour() },
      "Forbidden viewer edit",
    );
    expect(useWorkspace.getState().project).toBe(original);
    store.setReadOnly(false);
    store.activate("baseline");
    store.dispatch(
      { type: "scenario.presentation", presentation: tour() },
      "Forbidden baseline edit",
    );
    expect(current()).not.toHaveProperty("presentation");
    expect(useWorkspace.getState().project!.history).toHaveLength(0);
    await flushWorkspaceWrites();
    expect(
      (await readWorkspace())!.project.scenarios.every(
        (scenario) => scenario.presentation === undefined,
      ),
    ).toBe(true);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(1);
  });
});
describe("scenario history", () => {
  it("validates parcel edits before history changes, retains schema 2 through undo, and restores source geometry", () => {
    const store = useWorkspace.getState(),
      original = structuredClone(store.place);
    const parcel = parcelPreset({
      type: "Polygon",
      coordinates: [
        [
          [-112.075, 33.445],
          [-112.065, 33.445],
          [-112.065, 33.455],
          [-112.075, 33.455],
          [-112.075, 33.445],
        ],
      ],
    });
    store.dispatch(
      { type: "parcel.upsert", parcel, source: USER_PARCEL_SOURCE },
      "Draw parcel",
    );
    expect(useWorkspace.getState().project!.schemaVersion).toBe(2);
    const before = structuredClone(useWorkspace.getState().project);
    expect(() =>
      store.dispatch(
        { type: "parcel.upsert", parcel: { ...parcel, name: "x".repeat(241) } },
        "Invalid name",
      ),
    ).toThrow();
    expect(useWorkspace.getState().project).toEqual(before);
    expect(() =>
      store.dispatch(
        { type: "parcel.upsert", parcel: { ...parcel, id: "overlapping" } },
        "Invalid overlap",
      ),
    ).toThrow(/overlaps/);
    expect(useWorkspace.getState().project).toEqual(before);
    const children = splitParcel(parcel, [
      [-112.07, 33.44],
      [-112.07, 33.46],
    ]);
    store.dispatch(
      {
        type: "parcels.replace",
        operation: "split",
        removeIds: [parcel.id],
        parcels: children,
        source: USER_PARCEL_SOURCE,
      },
      "Split parcel",
    );
    expect(materializeParcels(place, current())).toHaveLength(2);
    store.undo();
    expect(materializeParcels(place, current())).toEqual([parcel]);
    store.undo();
    expect(materializeParcels(place, current())).toEqual([]);
    expect(useWorkspace.getState().project!.schemaVersion).toBe(2);
    store.redo();
    store.redo();
    expect(materializeParcels(place, current())).toHaveLength(2);
    store.dispatch({ type: "scenario.restore" }, "Restore baseline");
    expect(materializeParcels(place, current())).toEqual([]);
    expect(useWorkspace.getState().place).toEqual(original);
  });
  it("keeps baseline immutable and undo revisions monotonic", () => {
    const store = useWorkspace.getState();
    const b = buildingPreset("multifamily", place.center);
    const original = structuredClone(
      store.project!.scenarios.find((s) => s.id === "baseline"),
    );
    store.dispatch({ type: "building.upsert", building: b }, "Add apartments");
    expect(current().buildingEdits[b.id]).toEqual(b);
    expect(current().revision).toBe(1);
    store.undo();
    expect(current().buildingEdits[b.id]).toBeUndefined();
    expect(current().revision).toBe(2);
    store.redo();
    expect(current().buildingEdits[b.id]).toEqual(b);
    expect(current().revision).toBe(3);
    expect(
      useWorkspace
        .getState()
        .project!.scenarios.find((s) => s.id === "baseline"),
    ).toEqual(original);
    store.activate("baseline");
    store.dispatch({ type: "building.upsert", building: b }, "Forbidden");
    expect(current().buildingEdits).toEqual({});
  });
  it("does not resurrect abandoned redo operations after a new edit", () => {
    const store = useWorkspace.getState();
    const a = buildingPreset("retail", place.center),
      b = buildingPreset("office", place.center),
      c = buildingPreset("park", place.center);
    store.dispatch({ type: "building.upsert", building: a }, "A");
    store.dispatch({ type: "building.upsert", building: b }, "B");
    store.undo();
    store.dispatch({ type: "building.upsert", building: c }, "C");
    store.undo();
    expect(Object.keys(current().buildingEdits)).toEqual([a.id]);
    store.undo();
    expect(current().buildingEdits).toEqual({});
    expect(
      useWorkspace.getState().project!.history.find((e) => e.label === "B")
        ?.superseded,
    ).toBe(true);
  });
  it("branches independently and preserves a separate undo stack", () => {
    const store = useWorkspace.getState();
    const a = buildingPreset("office", place.center);
    store.dispatch({ type: "building.upsert", building: a }, "A");
    const parent = current().id;
    store.branch("Option B");
    const child = current().id;
    store.dispatch({ type: "building.remove", id: a.id }, "Remove");
    expect(current().buildingEdits[a.id]).toBeNull();
    store.activate(parent);
    expect(current().buildingEdits[a.id]).toEqual(a);
    store.activate(child);
    store.undo();
    expect(current().buildingEdits[a.id]).toEqual(a);
  });
  it("retains human-authored proposal notes through undo, redo and captured draft reload", async () => {
    const store = useWorkspace.getState();
    const original = structuredClone(current());
    store.dispatch(
      {
        type: "scenario.details",
        name: "Courtyard housing",
        description:
          "Replace surface parking with homes and a public courtyard. Review access and service costs before a decision.",
      },
      "Update proposal notes",
    );
    expect(current().revision).toBe(original.revision + 1);
    expect(current().description).toContain("Review access");
    store.undo();
    expect(current().name).toBe(original.name);
    expect(current().description).toBe(original.description);
    store.redo();
    await flushWorkspaceWrites();
    const captured = await readWorkspaceDraft(
      useWorkspace.getState().project!.id,
    );
    const restored = captured.project.scenarios.find(
      (s) => s.id === original.id,
    )!;
    expect(restored.name).toBe("Courtyard housing");
    expect(restored.description).toBe(current().description);
    expect(captured.project.history.at(-1)!.command.type).toBe(
      "scenario.details",
    );
    store.activate("baseline");
    const baseline = structuredClone(current());
    store.dispatch(
      { type: "scenario.details", name: "Forbidden", description: "" },
      "Forbidden",
    );
    expect(current()).toEqual(baseline);
  });
  it("undoes an import as one operation while retaining attribution in history", () => {
    const store = useWorkspace.getState();
    const a = buildingPreset("retail", place.center),
      b = buildingPreset("office", place.center);
    const source = {
      id: "upload",
      name: "Imported GIS",
      url: "https://example.test",
      vintage: "2026",
      license: "Test",
      kind: "user-supplied" as const,
    };
    store.dispatch(
      { type: "buildings.import", buildings: [a, b], source },
      "Import buildings",
    );
    expect(Object.keys(current().buildingEdits)).toHaveLength(2);
    expect(current().sources).toEqual([source]);
    store.undo();
    expect(current().buildingEdits).toEqual({});
    expect(current().sources || []).toEqual([]);
    store.redo();
    expect(current().sources).toEqual([source]);
  });
});

describe("captured baseline persistence", () => {
  const revisedPlace = (): Place => ({
    ...structuredClone(place),
    buildings: [buildingPreset("multifamily", place.center)],
    loadedAt: "2030-01-01",
    sources: [
      {
        id: "new-vintage",
        name: "Changed catalog",
        url: "https://example.test/new",
        vintage: "2030",
        license: "Fixture",
        kind: "observed",
      },
    ],
  });
  it("keeps baseline A and edits after reload when the catalog changes to B, without fetching B", async () => {
    const a = structuredClone(useWorkspace.getState().place!);
    useWorkspace.getState().dispatch(
      {
        type: "building.upsert",
        building: buildingPreset("office", place.center),
      },
      "New office",
    );
    const expected = structuredClone(useWorkspace.getState().project!);
    const fetchB = vi.fn(async () => revisedPlace());
    await useWorkspace.getState().initialize(fetchB);
    expect(fetchB).not.toHaveBeenCalled();
    expect(useWorkspace.getState().place).toEqual(a);
    expect(useWorkspace.getState().project).toEqual(expected);
    expect((await readWorkspace())?.baselineIdentity).toEqual(
      await baselineIdentity(a),
    );
    await useWorkspace.getState().reset();
    expect(fetchB).toHaveBeenCalledOnce();
    expect(useWorkspace.getState().place?.sources[0].vintage).toBe("2030");
    expect(useWorkspace.getState().project?.id).not.toBe(expected.id);
  });
  it("restores a complete captured export even while a newer source is loaded", async () => {
    const captured = {
      project: structuredClone(useWorkspace.getState().project!),
      place: structuredClone(place),
      baselineIdentity: await baselineIdentity(place),
    };
    const b = revisedPlace();
    await useWorkspace.getState().replace(createProject(b), b);
    const parsed = await validateProjectSnapshot(
      JSON.parse(JSON.stringify(captured)),
    );
    await useWorkspace
      .getState()
      .replace(parsed.project, parsed.place, parsed.baselineIdentity);
    expect(useWorkspace.getState().place).toEqual(place);
    expect(
      calculateImpact(useWorkspace.getState().place!, current()).metrics.find(
        (m) => m.id === "housing.units",
      )?.baseline,
    ).toBe(0);
    await expect(
      validateProjectSnapshot({ project: captured.project }),
    ).rejects.toThrow("no captured baseline");
    await expect(
      validateProjectSnapshot({ ...captured, place: b }),
    ).rejects.toThrow("snapshot identity");
    await expect(
      validateProjectSnapshot({
        ...captured,
        project: { ...captured.project, activeScenarioId: "missing" },
      }),
    ).rejects.toThrow("Active scenario");
    const invalid = structuredClone(captured);
    invalid.project.scenarios[1].assumptions.driveShare = 2;
    await expect(validateProjectSnapshot(invalid)).rejects.toThrow(
      "project is invalid",
    );
    const outside = structuredClone(captured),
      building = buildingPreset("office", [-113, 34]);
    outside.project.scenarios[1].buildingEdits[building.id] = building;
    await expect(validateProjectSnapshot(outside)).rejects.toThrow(
      "outside the captured study area",
    );
    const malformed = structuredClone(captured);
    malformed.place.boundary = [
      place.center,
      place.center,
      place.center,
      place.center,
    ];
    await expect(validateProjectSnapshot(malformed)).rejects.toThrow(
      "boundary is invalid",
    );
  });
  it("requires explicit source adoption for legacy drafts, keeps the original, and records the limitation", async () => {
    const original = JSON.stringify(useWorkspace.getState().project!);
    vi.stubGlobal("indexedDB", new IDBFactory());
    localStorage.setItem("urban-planning:workspace:v1", original);
    await useWorkspace.getState().initialize(revisedPlace());
    expect(useWorkspace.getState().project).toBeNull();
    expect(useWorkspace.getState().legacyDraft?.reason).toContain(
      "cannot be reconstructed",
    );
    expect(await readWorkspace()).toBeNull();
    await useWorkspace.getState().resolveLegacy("adopt");
    expect(useWorkspace.getState().project?.baselineMigration?.kind).toBe(
      "legacy-source-adoption",
    );
    expect(localStorage.getItem("urban-planning:workspace:v1")).toBe(original);
    await useWorkspace.getState().initialize(place);
    expect(useWorkspace.getState().place?.loadedAt).toBe("2030-01-01");
    expect(
      useWorkspace.getState().project?.baselineMigration?.message,
    ).toContain("earlier results cannot be reconstructed");
  });
  it("aborts snapshot and project changes together if persistence fails", async () => {
    const original = await readWorkspace();
    const b = revisedPlace();
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof put>
      ) {
        if (this.name === "drafts")
          throw new DOMException("Quota reached", "QuotaExceededError");
        return put.apply(this, args);
      });
    await expect(
      writeWorkspace({
        project: createProject(b),
        place: b,
        baselineIdentity: await baselineIdentity(b),
      }),
    ).rejects.toThrow("Quota reached");
    spy.mockRestore();
    expect(await readWorkspace()).toEqual(original);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("urban-planning:workspace:v2");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const count = await new Promise<number>((resolve) => {
      const req = db.transaction("snapshots").objectStore("snapshots").count();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    expect(count).toBe(1);
  });
  it("uses a clearly unsaved temporary session when browser storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await useWorkspace.getState().initialize(revisedPlace());
    expect(useWorkspace.getState().project).not.toBeNull();
    expect(useWorkspace.getState().storageError).toContain(
      "temporary new session",
    );
    expect(useWorkspace.getState().storagePending).toBe(false);
    vi.stubGlobal("indexedDB", new IDBFactory());
    await useWorkspace.getState().replace(createProject(place), place);
    useWorkspace.getState().dispatch(
      {
        type: "building.upsert",
        building: buildingPreset("office", place.center),
      },
      "Recovered edit",
    );
    await flushWorkspaceWrites();
    expect(useWorkspace.getState().storageError).toBeNull();
    expect((await readWorkspace())?.project.history.at(-1)?.label).toBe(
      "Recovered edit",
    );
  });
  it("restores older exports as separate copies and keeps newer originals reopenable", async () => {
    const older = (await readWorkspace())!;
    useWorkspace.getState().dispatch(
      {
        type: "building.upsert",
        building: buildingPreset("office", place.center),
      },
      "Newer work",
    );
    await flushWorkspaceWrites();
    const newer = (await readWorkspace())!;
    const longName = "P".repeat(240);
    await useWorkspace
      .getState()
      .restoreCopy({ ...older, project: { ...older.project, name: longName } });
    const copy = (await readWorkspace())!;
    expect(copy.project.id).not.toBe(newer.project.id);
    expect(copy.project.name.length).toBeLessThanOrEqual(240);
    expect(copy.project.name).toContain("restored copy");
    expect(copy.project.history).toEqual(older.project.history);
    expect(copy.baselineIdentity).toEqual(older.baselineIdentity);
    expect(await readWorkspaceDraft(newer.project.id)).toEqual(newer);
    const drafts = await listWorkspaceDrafts();
    expect(drafts.map((draft) => draft.id).sort()).toEqual(
      [newer.project.id, copy.project.id].sort(),
    );
    expect(
      drafts.every((draft) => draft.baselineLoadedAt === place.loadedAt),
    ).toBe(true);
    const reopened = await readWorkspaceDraft(newer.project.id);
    await useWorkspace
      .getState()
      .replace(reopened.project, reopened.place, reopened.baselineIdentity);
    expect(useWorkspace.getState().project?.history.at(-1)?.label).toBe(
      "Newer work",
    );
    expect((await readWorkspaceDraft(copy.project.id)).project.history).toEqual(
      older.project.history,
    );
  });
});

describe("saved-project access and local recovery", () => {
  it("adopts the first cloud ID atomically while preserving pending edits, editing access, selection and render references", async () => {
    const store = useWorkspace.getState();
    const submitted = structuredClone(store.project!);
    const building = buildingPreset("retail", place.center);
    // The HTTP request captured submitted, but the user edited before its response arrived.
    store.dispatch(
      { type: "building.upsert", building },
      "Edit while first save was in flight",
    );
    store.select(building.id);
    const latest = useWorkspace.getState();
    const connection = {
      projectId: crypto.randomUUID(),
      organizationId: "org-review",
      version: 1,
      savedRevision: projectRevisionKey(submitted),
    };
    await store.adoptCloudSave(
      submitted.id,
      connection,
      latest.baselineIdentity!,
    );
    const adopted = useWorkspace.getState();
    expect(adopted.project?.id).toBe(connection.projectId);
    expect(adopted.project?.scenarios).toBe(latest.project!.scenarios);
    expect(adopted.place).toBe(latest.place);
    expect(adopted.baselineIdentity).toBe(latest.baselineIdentity);
    expect(adopted.selectedId).toBe(building.id);
    expect(adopted.readOnly).toBe(false);
    expect(adopted.cloudLink).toEqual(connection);
    expect(projectRevisionKey(adopted.project!)).not.toBe(
      connection.savedRevision,
    );
    expect((await listWorkspaceDrafts()).map((draft) => draft.id)).toEqual([
      connection.projectId,
    ]);
    await expect(readWorkspaceDraft(submitted.id)).rejects.toThrow(
      "could not be read",
    );
    expect((await readWorkspace())?.project.history.at(-1)?.label).toBe(
      "Edit while first save was in flight",
    );
    adopted.dispatch(
      { type: "scenario.details", name: "Still editable", description: "" },
      "Edit after first save",
    );
    expect(current().name).toBe("Still editable");
    await flushWorkspaceWrites();
    await store.initialize(place);
    expect(useWorkspace.getState().readOnly).toBe(true);
    expect(useWorkspace.getState().cloudLink).toEqual(connection);
  });

  it("rolls back the entire first-save rekey if deleting the old key fails, preserving the original and current edits", async () => {
    const store = useWorkspace.getState();
    store.dispatch(
      { type: "scenario.details", name: "Keep this work", description: "" },
      "Pending before rekey",
    );
    await flushWorkspaceWrites();
    const before = useWorkspace.getState();
    const persisted = await readWorkspace();
    const connection = {
      projectId: crypto.randomUUID(),
      organizationId: "org-review",
      version: 1,
      savedRevision: projectRevisionKey(before.project!),
    };
    const remove = IDBObjectStore.prototype.delete;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "delete")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof remove>
      ) {
        if (this.name === "drafts")
          throw new DOMException("Rekey rejected", "UnknownError");
        return remove.apply(this, args);
      });
    await expect(
      store.adoptCloudSave(
        before.project!.id,
        connection,
        before.baselineIdentity!,
      ),
    ).rejects.toThrow("Rekey rejected");
    spy.mockRestore();
    expect(useWorkspace.getState().project).toBe(before.project);
    expect(useWorkspace.getState().cloudLink).toBeNull();
    expect(useWorkspace.getState().readOnly).toBe(false);
    expect(await readWorkspace()).toEqual(persisted);
    expect((await listWorkspaceDrafts()).map((draft) => draft.id)).toEqual([
      before.project!.id,
    ]);
    // The transition guard is released after failure, so local recovery stays usable.
    store.dispatch(
      { type: "scenario.details", name: "Recovered", description: "" },
      "Recovery edit",
    );
    expect(current().name).toBe("Recovered");
  });

  it("does not grant editing permissions or adopt a mismatched first-save context", async () => {
    const store = useWorkspace.getState(),
      project = store.project!;
    const connection = {
      projectId: crypto.randomUUID(),
      organizationId: "org-review",
      version: 1,
      savedRevision: projectRevisionKey(project),
    };
    await expect(
      store.adoptCloudSave(
        "different-local-draft",
        connection,
        store.baselineIdentity!,
      ),
    ).rejects.toThrow("no longer matches");
    await expect(
      store.adoptCloudSave(project.id, connection, {
        ...store.baselineIdentity!,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("no longer matches");
    store.setReadOnly(true, "Access changed while saving");
    await store.adoptCloudSave(project.id, connection, store.baselineIdentity!);
    expect(useWorkspace.getState().readOnly).toBe(true);
    expect(useWorkspace.getState().readOnlyReason).toBe(
      "Access changed while saving",
    );
    await expect(
      store.adoptCloudSave(
        connection.projectId,
        { ...connection, projectId: crypto.randomUUID() },
        store.baselineIdentity!,
      ),
    ).rejects.toThrow("no longer matches");
  });

  it("keeps another tab's newer anonymous draft when the proposed rekey no longer matches it", async () => {
    const store = useWorkspace.getState(),
      original = (await readWorkspace())!;
    const newer = {
      ...original,
      project: { ...original.project, name: "Newer work in another tab" },
    };
    await writeWorkspace(newer);
    const connection = {
      projectId: crypto.randomUUID(),
      organizationId: "org-review",
      version: 1,
      savedRevision: projectRevisionKey(store.project!),
    };
    await expect(
      store.adoptCloudSave(
        store.project!.id,
        connection,
        store.baselineIdentity!,
      ),
    ).rejects.toThrow("changed in another tab");
    expect(await readWorkspace()).toEqual(newer);
    expect((await listWorkspaceDrafts()).map((draft) => draft.id)).toEqual([
      original.project.id,
    ]);
    expect(useWorkspace.getState().project).toBe(store.project);
  });

  it("reopens a saved connection read-only until access is checked and guards every editing command", async () => {
    const store = useWorkspace.getState();
    store.dispatch(
      {
        type: "building.upsert",
        building: buildingPreset("office", place.center),
      },
      "Before review",
    );
    const project = useWorkspace.getState().project!;
    const connection = {
      projectId: project.id,
      organizationId: "org-review",
      version: 2,
      savedRevision: projectRevisionKey(project),
    };
    await store.linkCloud(connection);
    await store.initialize(place);
    expect(useWorkspace.getState().cloudLink).toEqual(connection);
    expect(useWorkspace.getState().readOnly).toBe(true);
    const before = structuredClone(useWorkspace.getState().project!);
    store.dispatch(
      {
        type: "building.upsert",
        building: buildingPreset("retail", place.center),
      },
      "Forbidden edit",
    );
    store.undo();
    store.redo();
    store.branch("Forbidden branch");
    expect(useWorkspace.getState().project).toEqual(before);
    store.activate("baseline");
    expect(useWorkspace.getState().project?.activeScenarioId).toBe("baseline");
    expect(useWorkspace.getState().project?.history).toEqual(before.history);
    store.activate(before.activeScenarioId);
    store.setReadOnly(false);
    store.undo();
    expect(current().revision).toBeGreaterThan(
      before.scenarios.find((s) => s.id === before.activeScenarioId)!.revision,
    );
  });

  it("retains edits made while the server save acknowledgment is written without marking them saved", async () => {
    const store = useWorkspace.getState(),
      saved = structuredClone(store.project!);
    const connection = {
      projectId: saved.id,
      organizationId: "org-review",
      version: 3,
      savedRevision: projectRevisionKey(saved),
    };
    const acknowledgment = store.linkCloud(connection);
    const next = buildingPreset("retail", place.center);
    store.dispatch(
      { type: "building.upsert", building: next },
      "Edit during browser persistence",
    );
    await acknowledgment;
    await flushWorkspaceWrites();
    const captured = await readWorkspace();
    expect(captured?.cloudLink).toEqual(connection);
    expect(
      captured?.project.scenarios.find((s) => s.id === saved.activeScenarioId)
        ?.buildingEdits[next.id],
    ).toEqual(next);
    expect(projectRevisionKey(captured!.project)).not.toBe(
      connection.savedRevision,
    );
  });

  it("restores a separate editable copy without copying a saved-project connection or losing the original", async () => {
    const store = useWorkspace.getState(),
      original = structuredClone(store.project!);
    const connection = {
      projectId: original.id,
      organizationId: "org-review",
      version: 2,
      savedRevision: projectRevisionKey(original),
    };
    await store.linkCloud(connection);
    store.setReadOnly(true, "Viewer access");
    const snapshot = await readWorkspace();
    await store.restoreCopy(snapshot!);
    expect(useWorkspace.getState().project?.id).not.toBe(original.id);
    expect(useWorkspace.getState().readOnly).toBe(false);
    expect(useWorkspace.getState().cloudLink).toBeNull();
    expect((await readWorkspaceDraft(original.id)).cloudLink).toEqual(
      connection,
    );
    expect((await readWorkspace())?.cloudLink).toBeUndefined();
    expect(useWorkspace.getState().baselineIdentity).toEqual(
      snapshot?.baselineIdentity,
    );
  });

  it("rejects a mismatched saved connection before overwriting a captured draft", async () => {
    const snapshot = await readWorkspace();
    expect(() =>
      writeWorkspace({
        ...snapshot!,
        cloudLink: {
          projectId: "another-project",
          organizationId: "org-review",
          version: 1,
          savedRevision: "",
        },
      }),
    ).toThrow("connection is invalid");
    expect(await readWorkspace()).toEqual(snapshot);
  });
  it("commits an explicit building program once, retains format3 after undo, and rejects invalid program/geometry without durable changes", async () => {
    const before = useWorkspace.getState(),
      identity = before.baselineIdentity,
      building = typedBuildingPreset("townhome", place.center);
    before.dispatch({ type: "building.upsert", building }, "Townhomes");
    const saved = useWorkspace.getState().project!;
    expect(saved.schemaVersion).toBe(3);
    expect(saved.history).toHaveLength(1);
    useWorkspace.getState().undo();
    expect(useWorkspace.getState().project!.schemaVersion).toBe(3);
    useWorkspace.getState().redo();
    expect(
      useWorkspace.getState().project!.history.at(-1)!.after.buildingEdits[
        building.id
      ]!.program,
    ).toEqual(building.program);
    const valid = useWorkspace.getState().project!,
      bad = structuredClone(building);
    bad.program!.commonAreaSqm = 1;
    expect(() =>
      useWorkspace
        .getState()
        .dispatch(
          { type: "building.upsert", building: bad },
          "Invalid program",
        ),
    ).toThrow();
    expect(useWorkspace.getState().project).toBe(valid);
    expect(useWorkspace.getState().baselineIdentity).toEqual(identity);
    await flushWorkspaceWrites();
    const restored = await readWorkspace();
    expect(restored!.project.schemaVersion).toBe(3);
    expect(restored!.baselineIdentity).toEqual(identity);
  });
});
