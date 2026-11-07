import { describe, expect, it } from "vitest";
import {
  applyCommand,
  housingIncomeLimitPackHash,
  projectWithImportedHousing,
} from "@urban/core";
import { resolveHousingAffordability } from "@urban/models";
import { housingFixture } from "../../../../../packages/models/src/housing-fixture";
import { executeHousingTask } from "../../lib/housing-task-executor";
import {
  housingCents,
  housingGroupDraft,
  readHousingGroup,
  housingSourceDraft,
  readHousingSources,
} from "./draft";

describe("housing review drafts and atomic preparation", () => {
  it("keeps blank, malformed and fractional-cent payments distinct from a reviewed zero", () => {
    for (const raw of ["", " ", "-1", "1.001", "1e3", "Infinity", "1,000"])
      expect(() => housingCents(raw, "Rent")).toThrow();
    expect(housingCents("0", "Rent")).toBe(0);
    expect(housingCents("1.01", "Rent")).toBe(101);
    const f = housingFixture(),
      d = housingGroupDraft(f.group("g"));
    d.costs[0] = { ...d.costs[0], dollars: "" };
    expect(() => readHousingGroup(d)).toThrow();
    d.costs[0].state = "unknown";
    const parsed = readHousingGroup(d);
    expect(parsed.costs[0]).not.toHaveProperty("monthlyCents");
  });
  it("requires explicit household size and area, preserving imported identity and zero amounts", () => {
    const f = housingFixture(),
      d = housingGroupDraft(f.group("g"));
    expect(readHousingGroup(d)).toEqual(f.group("g"));
    d.householdSize = "";
    expect(() => readHousingGroup(d)).toThrow();
    const fresh = housingGroupDraft(undefined, "home");
    expect(fresh.units).toBe("");
    expect(fresh.householdSize).toBe("");
    expect(fresh.areaHash).toBe("");
    expect(fresh.costs.every((c) => c.state === "unknown")).toBe(true);
  });
  it("allows escrow once, rejects included chains and keeps unknown components unresolved", () => {
    const f = housingFixture(),
      d = housingGroupDraft(f.group("owner", 10, "own"));
    const loan = d.costs.find((c) => c.kind === "loan-payment")!;
    const tax = d.costs.find((c) => c.kind === "property-tax")!;
    tax.state = "included";
    tax.includedIn = loan.id;
    expect(
      readHousingGroup(d).costs.find((c) => c.kind === "property-tax"),
    ).toMatchObject({ state: "included", includedIn: loan.id });
    loan.state = "included";
    loan.includedIn = tax.id;
    expect(() => readHousingGroup(d)).toThrow(/Included costs/);
  });
  it("does not infer download or public rights from private processing", () => {
    const f = housingFixture(),
      d = housingSourceDraft(f.source);
    d.exportAllowed = false;
    d.publicRedistribution = false;
    expect(
      readHousingSources([d], "Reviewer", f.review.reviewedAt)[0].rights,
    ).toMatchObject({
      privateUse: true,
      export: false,
      publicRedistribution: false,
    });
    d.privateUse = false;
    expect(() =>
      readHousingSources([d], "Reviewer", f.review.reviewedAt),
    ).toThrow(/Review private/);
  });
  it("prepares all referenced packs and a bound review without changing the original project; undo is a small reference history", () => {
    const f = housingFixture();
    const original = structuredClone(f.project);
    const preview = executeHousingTask({
      kind: "preview",
      place: f.place,
      scenario: f.scenario,
      input: {
        baselineGroups: f.scenario.affordability!.baselineGroups,
        proposalGroups: f.scenario.affordability!.proposalGroups,
        sources: [f.source],
      },
      review: f.review,
      catalog: { [f.areaHash]: f.pack },
    });
    if (!("affordability" in preview)) throw new Error("Expected preview");
    const prepared = executeHousingTask({
      kind: "apply",
      place: f.place,
      project: f.project,
      affordability: preview.affordability,
      catalog: { [f.areaHash]: f.pack },
    });
    if (!("scenarios" in prepared)) throw new Error("Expected project");
    expect(f.project).toEqual(original);
    expect(prepared.housingIncomeLimits?.[f.areaHash]).toEqual(f.pack);
    const after = applyCommand(f.scenario, {
      type: "scenario.affordability",
      affordability: preview.affordability,
    });
    expect(after.revision).toBe(f.scenario.revision + 1);
    expect(after.affordability).toEqual(preview.affordability);
    expect(
      JSON.stringify({
        type: "scenario.affordability",
        affordability: preview.affordability,
      }),
    ).not.toContain("sourceRows");
    const restored = applyCommand(after, {
      type: "scenario.affordability",
      affordability: f.scenario.affordability!,
    });
    expect(restored.affordability).toEqual(f.scenario.affordability);
    expect(
      resolveHousingAffordability(f.place, after, {
        housingIncomeLimits: prepared.housingIncomeLimits,
      }).proposal.evaluatedUnits,
    ).toBe(10);
  });
  it("rejects changed capacity or pack identity between preview and atomic apply", () => {
    const f = housingFixture();
    const changed = structuredClone(f.project);
    changed.scenarios[1].buildingEdits.home = {
      ...f.place.buildings[0],
      units: 20,
    };
    expect(() =>
      executeHousingTask({
        kind: "apply",
        place: f.place,
        project: changed,
        affordability: f.scenario.affordability!,
        catalog: { [f.areaHash]: f.pack },
      }),
    ).toThrow(/changed/);
    const wrong = { ...f.pack, notes: ["changed source"] };
    expect(housingIncomeLimitPackHash(wrong)).not.toBe(f.areaHash);
    expect(() =>
      executeHousingTask({
        kind: "apply",
        place: f.place,
        project: { ...f.project, housingIncomeLimits: undefined },
        affordability: f.scenario.affordability!,
        catalog: { [f.areaHash]: wrong },
      }),
    ).toThrow(/identity/);
  });
  it("restored copies downgrade area authority while retaining group costs and pack bytes", () => {
    const f = housingFixture();
    f.scenario.affordability!.proposalGroups[0].areaOrigin = "server-catalog";
    const restored = projectWithImportedHousing(f.project);
    expect(
      restored.scenarios[1].affordability!.proposalGroups[0].areaOrigin,
    ).toBe("imported");
    expect(restored.housingIncomeLimits).toEqual(f.project.housingIncomeLimits);
    expect(
      restored.scenarios[1].affordability!.proposalGroups[0].costs,
    ).toEqual(f.scenario.affordability!.proposalGroups[0].costs);
  });
});
