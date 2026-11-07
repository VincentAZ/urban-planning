import { describe, it, expect } from "vitest";
import { createProject, createScenario } from "@urban/models";
import {
  createRetailScenario,
  createRetailCategory,
  validateRetailScenario,
  retailScenarioSchema,
  retailPubliclyRedistributable,
  USER_RETAIL_SOURCE,
  projectWithRetailVersion,
  projectWithActivityVersion,
  applyCommand,
  canonicalJSON,
  baselineIdentity,
  validateProjectSnapshot,
  type Place,
  type RetailMeasure,
  type HistoryEntry,
} from "./index";
import { projectSchema, commandSchema } from "./validation";
const place: Place = {
  id: "retail-fixture",
  name: "Fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [0, 0],
  bounds: [-0.01, -0.01, 0.01, 0.01],
  boundary: [
    [-0.01, -0.01],
    [0.01, -0.01],
    [0.01, 0.01],
    [-0.01, 0.01],
    [-0.01, -0.01],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Synthetic retail area",
};
function ready() {
  const r = createRetailScenario(place, 0);
  r.context.comparabilityConfirmed = true;
  r.context.disjointCategoriesConfirmed = true;
  return r;
}
const value = (n: number): RetailMeasure => ({
  status: "available",
  value: n,
  sourceId: USER_RETAIL_SOURCE.id,
});
describe("persisted retail analysis", () => {
  it("distinguishes zero, missing and suppression, and rejects invalid amounts and reserved IDs", () => {
    const r = ready();
    r.categories[0].baselineDemand = value(0);
    expect(retailScenarioSchema.safeParse(r).success).toBe(true);
    for (const bad of [
      { status: "suppressed", value: 0, sourceId: USER_RETAIL_SOURCE.id },
      { status: "available", value: null, sourceId: USER_RETAIL_SOURCE.id },
      { status: "available", value: 10 },
    ])
      expect(
        retailScenarioSchema.safeParse({
          ...r,
          categories: [{ ...r.categories[0], baselineDemand: bad }],
        }).success,
      ).toBe(false);
    for (const bad of [-1, Infinity, NaN])
      expect(
        retailScenarioSchema.safeParse({
          ...r,
          categories: [{ ...r.categories[0], annualSalesCapacity: bad }],
        }).success,
      ).toBe(false);
    for (const id of ["__proto__", "constructor", "toString"])
      expect(
        commandSchema.safeParse({
          type: "scenario.retail",
          retail: { ...r, categories: [{ ...r.categories[0], id }] },
        }).success,
      ).toBe(false);
    r.categories[0].salesPerEstablishment = value(0);
    expect(retailScenarioSchema.safeParse(r).success).toBe(false);
  });
  it("rejects duplicate and overlapping industry categories and requires matched-context declarations", () => {
    const r = ready();
    r.context.classification = { system: "NAICS", version: "2022" };
    r.categories = [
      { ...createRetailCategory("Parent"), code: "44" },
      { ...createRetailCategory("Child"), code: "445" },
    ];
    expect(() => validateRetailScenario(r, place)).toThrow(/overlap/);
    r.categories[0].code = "441";
    expect(() => validateRetailScenario(r, place)).not.toThrow();
    r.categories[1].code = "441";
    expect(() => validateRetailScenario(r, place)).toThrow(
      /duplicated|overlap/,
    );
    r.categories[1].code = "445";
    r.context.comparabilityConfirmed = false;
    expect(() => validateRetailScenario(r, place)).toThrow(/Confirm/);
    r.context.comparabilityConfirmed = true;
    r.context.disjointCategoriesConfirmed = false;
    expect(() => validateRetailScenario(r, place)).toThrow(
      /mutually exclusive/,
    );
  });
  it("requires private rights and retained unambiguous source identities, with separate explicit public permission", () => {
    const r = ready();
    expect(() => validateRetailScenario(r, place)).not.toThrow();
    expect(retailPubliclyRedistributable(r)).toBe(false);
    r.sourceRights[0].authorizedPrivateUse = false;
    expect(() => validateRetailScenario(r, place)).toThrow(/rights/);
    r.sourceRights[0].authorizedPrivateUse = true;
    r.sourceRights[0].publicRedistribution = true;
    expect(retailPubliclyRedistributable(r)).toBe(true);
    r.sourceRights.push({
      sourceId: "unused-private",
      authorizedPrivateUse: true,
      publicRedistribution: false,
      statement: "Private note retained in the pack",
    });
    expect(retailPubliclyRedistributable(r)).toBe(false);
    r.sourceRights.pop();
    r.categories[0].baselineSales = {
      status: "suppressed",
      value: null,
      sourceId: "vendor",
    };
    expect(() => validateRetailScenario(r, place)).toThrow(/source record/);
    const source = {
      ...USER_RETAIL_SOURCE,
      id: "vendor",
      name: "Uploaded report",
    };
    r.sourceRights.push({
      sourceId: "vendor",
      authorizedPrivateUse: true,
      publicRedistribution: false,
      statement: "Authorized internal analysis only",
    });
    expect(() => validateRetailScenario(r, place, [source])).not.toThrow();
    expect(retailPubliclyRedistributable(r)).toBe(false);
    expect(() =>
      validateRetailScenario(r, { ...place, sources: [source] }, [
        { ...source, name: "Conflicting report" },
      ]),
    ).toThrow(/Conflicting metadata/);
  });
  it("deep-clones one reversible command and preserves legacy baseline bytes while upgrading all retained states to format6", async () => {
    const original = createProject(place),
      before = original.scenarios[1],
      r = ready(),
      identity = await baselineIdentity(place),
      bytes = canonicalJSON(place);
    for (const schemaVersion of [1, 2, 3, 4, 5] as const) {
      const p = { ...original, schemaVersion };
      expect(canonicalJSON(projectWithRetailVersion(p, place))).toBe(
        canonicalJSON(p),
      );
    }
    const after = applyCommand(before, { type: "scenario.retail", retail: r });
    r.categories[0].name = "Changed caller";
    expect(after.retail!.categories[0].name).not.toBe(r.categories[0].name);
    expect(after.revision).toBe(before.revision + 1);
    const branch = createScenario("Branch", after);
    branch.retail!.categories[0].annualSalesCapacity = 20;
    expect(after.retail!.categories[0].annualSalesCapacity).toBe(0);
    const entry: HistoryEntry = {
      id: "retail-history",
      at: new Date().toISOString(),
      actor: "Fixture",
      label: "Retail",
      command: { type: "scenario.retail", retail: after.retail! },
      before,
      after,
    };
    const project = projectWithRetailVersion(
      {
        ...original,
        scenarios: [original.scenarios[0], after],
        history: [entry],
      },
      place,
    );
    expect(project.schemaVersion).toBe(6);
    expect(projectWithActivityVersion(project, place).schemaVersion).toBe(6);
    expect(
      projectSchema.safeParse({ ...project, schemaVersion: 5 }).success,
    ).toBe(false);
    const restored = {
      ...project,
      scenarios: original.scenarios,
      history: [],
      undone: [entry],
    };
    expect(projectWithRetailVersion(restored, place).schemaVersion).toBe(6);
    expect(
      projectSchema.safeParse({ ...restored, schemaVersion: 5 }).success,
    ).toBe(false);
    const roundtrip = await validateProjectSnapshot({
      project: restored,
      place,
      baselineIdentity: identity,
    });
    expect(canonicalJSON(roundtrip.place)).toBe(bytes);
    expect(roundtrip.baselineIdentity).toEqual(identity);
    const invalid = structuredClone(restored);
    if (invalid.undone[0].command.type === "scenario.retail")
      invalid.undone[0].command.retail!.sourceRights[0].authorizedPrivateUse = false;
    await expect(
      validateProjectSnapshot({ project: invalid, place }),
    ).rejects.toThrow(/rights/);
    expect(
      Object.hasOwn(
        applyCommand(after, { type: "scenario.retail", retail: null }),
        "retail",
      ),
    ).toBe(false);
    expect(() =>
      applyCommand(
        { ...before, id: "baseline" },
        { type: "scenario.retail", retail: ready() },
      ),
    ).toThrow(/baseline/);
  });
});
