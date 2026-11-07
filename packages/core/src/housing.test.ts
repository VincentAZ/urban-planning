import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  applyCommand,
  canonicalJSON,
  housingIncomeLimitPackHash,
  housingIncomeLimitPackSchema,
  housingCostGroupSchema,
  housingAffordabilityReferences,
  housingSourcePermissionIssues,
  projectWithHousingVersion,
  projectWithImportedHousing,
  validateHousingCatalogTransition,
  createMediaScene,
  assertMediaScene,
  assertMediaExportRights,
  type HistoryEntry,
} from "./index";
import { projectSchema, commandSchema } from "./validation";
import { housingFixture } from "../../models/src/housing-fixture";
import { calculateImpact } from "@urban/models";

describe("housing source/catalog and history integrity", () => {
  it("retains complete household rows and raw cell identity rather than regenerating AMI percentages", () => {
    const f = housingFixture();
    expect(housingIncomeLimitPackSchema.parse(f.pack)).toEqual(f.pack);
    for (const mutate of [
      (p: typeof f.pack) => {
        p.limits[1].householdSize = 1;
      },
      (p: typeof f.pack) => {
        p.limits.pop();
      },
      (p: typeof f.pack) => {
        p.limits[0].extremelyLow = p.limits[0].veryLow + 1;
      },
      (p: typeof f.pack) => {
        p.sourceRows[0].fileSha256 = "f".repeat(64);
      },
      (p: typeof f.pack) => {
        p.area.geographies[0].stateFips = "99";
      },
    ]) {
      const p = structuredClone(f.pack);
      mutate(p);
      expect(housingIncomeLimitPackSchema.safeParse(p).success).toBe(false);
    }
    const changed = structuredClone(f.pack);
    changed.sourceRows[0].cells.note = "Retained raw cell change";
    expect(housingIncomeLimitPackHash(changed)).not.toBe(f.areaHash);
  });
  it("rejects missing required cost kinds, included unknowns, double entries and cycles", () => {
    const f = housingFixture(),
      valid = f.group("test");
    expect(housingCostGroupSchema.safeParse(valid).success).toBe(true);
    const missing = structuredClone(valid);
    missing.costs.pop();
    expect(housingCostGroupSchema.safeParse(missing).success).toBe(false);
    const duplicate = structuredClone(valid);
    duplicate.costs[1] = structuredClone(duplicate.costs[0]);
    expect(housingCostGroupSchema.safeParse(duplicate).success).toBe(false);
    const cycle = structuredClone(valid);
    cycle.costs[0] = {
      ...cycle.costs[0],
      state: "included",
      includedIn: "utilities",
    } as never;
    delete (cycle.costs[0] as unknown as Record<string, unknown>).monthlyCents;
    cycle.costs[1] = {
      ...cycle.costs[1],
      state: "included",
      includedIn: "rent",
    } as never;
    delete (cycle.costs[1] as unknown as Record<string, unknown>).monthlyCents;
    expect(housingCostGroupSchema.safeParse(cycle).success).toBe(false);
    const unknown = structuredClone(valid);
    unknown.costs[0] = {
      id: "rent",
      kind: "rent",
      provenance: valid.costs[0].provenance,
      state: "unknown",
    };
    unknown.costs[1] = {
      id: "utilities",
      kind: "utilities",
      provenance: valid.costs[1].provenance,
      state: "included",
      includedIn: "rent",
    };
    expect(housingCostGroupSchema.safeParse(unknown).success).toBe(false);
  });
  it("persists a reversible command and every historical reference without duplicating packs", () => {
    const f = housingFixture(),
      original = structuredClone(f.scenario);
    delete original.affordability;
    const command = commandSchema.parse({
        type: "scenario.affordability",
        affordability: f.scenario.affordability,
      }),
      after = applyCommand(original, command);
    const entry: HistoryEntry = {
      id: "housing-history",
      at: after.updatedAt,
      actor: "fixture",
      label: "Housing",
      before: original,
      after,
      command,
    };
    f.project.scenarios[1] = after;
    f.project.history = [entry];
    f.project.undone = [entry];
    const parsed = projectSchema.parse(f.project);
    expect(parsed.scenarios[1].affordability).toEqual(after.affordability);
    expect(Object.keys(parsed.housingIncomeLimits!)).toEqual([f.areaHash]);
    const downgraded = { ...f.project, schemaVersion: 12 as const };
    expect(projectSchema.safeParse(downgraded).success).toBe(false);
    expect(projectWithHousingVersion(downgraded).schemaVersion).toBe(13);
    const removed = structuredClone(f.project);
    removed.scenarios[1] = applyCommand(after, {
      type: "scenario.affordability",
      affordability: null,
    });
    removed.housingIncomeLimits = {};
    expect(projectSchema.safeParse(removed).success).toBe(false);
    expect(() => applyCommand(f.project.scenarios[0], command)).toThrow(
      /baseline/i,
    );
  });
  it("does not lose references inside undo or commands and downgrades every copied authority label", () => {
    const f = housingFixture();
    f.scenario.affordability!.proposalGroups[0].areaOrigin = "server-catalog";
    const entry: HistoryEntry = {
      id: "undo",
      at: f.review.reviewedAt,
      actor: "fixture",
      label: "Housing",
      before: structuredClone(f.scenario),
      after: structuredClone(f.scenario),
      command: {
        type: "scenario.affordability",
        affordability: structuredClone(f.scenario.affordability!),
      },
    };
    f.project.undone = [entry];
    const original = canonicalJSON(f.project),
      imported = projectWithImportedHousing(f.project);
    expect(
      housingAffordabilityReferences(imported).every((a) =>
        [...a.baselineGroups, ...a.proposalGroups].every(
          (g) => g.areaOrigin === "imported",
        ),
      ),
    ).toBe(true);
    expect(canonicalJSON(f.project)).toBe(original);
    const missing = structuredClone(imported);
    missing.scenarios[1].affordability = undefined;
    missing.housingIncomeLimits = {};
    expect(projectSchema.safeParse(missing).success).toBe(false);
  });
  it("keeps existing catalog bytes immutable and leaves absent legacy projects unchanged", () => {
    const f = housingFixture(),
      old = structuredClone(f.project);
    delete old.housingIncomeLimits;
    delete old.scenarios[1].affordability;
    old.schemaVersion = 1;
    expect(projectWithHousingVersion(old)).toBe(old);
    expect(projectWithImportedHousing(old)).toBe(old);
    const altered = structuredClone(f.project);
    altered.housingIncomeLimits![f.areaHash].limits[0].low++;
    expect(() =>
      validateHousingCatalogTransition(f.project, altered),
    ).toThrow();
    expect(() =>
      validateHousingCatalogTransition(f.project, {
        ...f.project,
        housingIncomeLimits: {},
      }),
    ).toThrow(/immutable/);
    expect(() => z.toJSONSchema(projectSchema, { io: "input" })).not.toThrow();
    expect(() => z.toJSONSchema(commandSchema, { io: "input" })).not.toThrow();
  });
  it("keeps source permissions explicit and private/export/public independently bounded", () => {
    const f = housingFixture(),
      s = structuredClone(f.source);
    expect(housingSourcePermissionIssues([s], "publicRedistribution")).toEqual(
      [],
    );
    s.rights!.publicRedistribution = false;
    expect(housingSourcePermissionIssues([s], "private")).toEqual([]);
    expect(
      housingSourcePermissionIssues([s], "publicRedistribution"),
    ).toHaveLength(1);
    s.rights!.export = false;
    expect(housingSourcePermissionIssues([s], "export")).toHaveLength(1);
    delete s.rights;
    expect(housingSourcePermissionIssues([s], "private")).toHaveLength(1);
  });
  it("binds media to exact selected income packs, cost sources and frozen result identity", () => {
    const f = housingFixture(),
      results = calculateImpact(f.place, f.scenario, {}, f.project);
    const input = {
      projectId: f.project.id,
      projectVersion: 1,
      place: f.place,
      scenario: f.scenario,
      results,
      createdAt: f.review.reviewedAt,
      housingIncomeLimits: f.project.housingIncomeLimits,
    };
    const scene = createMediaScene(input);
    expect(scene.housingIncomeLimits).toEqual(f.project.housingIncomeLimits);
    expect(scene.sources.some((s) => s.namespace === "housing-costs")).toBe(
      true,
    );
    expect(() => assertMediaScene(scene)).not.toThrow();
    expect(() => assertMediaExportRights(scene)).not.toThrow();
    expect(() =>
      createMediaScene({ ...input, housingIncomeLimits: {} }),
    ).toThrow(/unavailable/);
    expect(() =>
      createMediaScene({
        ...input,
        results: {
          ...results,
          affordability: {
            ...results.affordability!,
            inputHash: "f".repeat(64),
          },
        },
      }),
    ).toThrow(/housing results/);
  });
});
