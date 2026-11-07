import { describe, expect, it } from "vitest";
import {
  applyCommand,
  canonicalJSON,
  createFiscalScenarioReview,
  fiscalContentHash,
  fiscalProfileHash,
  fiscalProfileSchema,
  fiscalProjectIssues,
  fiscalResolutionInputHash,
  projectWithFiscalVersion,
} from "@urban/core";
import {
  projectSchema,
  fiscalResolutionSchema,
  commandSchema,
} from "../../core/src/validation";
import { calculateImpact, fiscalCashFlows } from "./engine";
import { createFiscalStudy, resolveFiscalStudy } from "./fiscal";
import { fiscalFixture } from "./fiscal-fixture";
import { trafficScenarioFixture } from "../../../tests/fixtures/traffic";
import { workforceScenarioFixture } from "../../../tests/fixtures/workforce";
import { accessibilityFixture } from "../../../tests/fixtures/accessibility";
import { floodFixture } from "../../../tests/fixtures/flood";
import { createMediaScene } from "@urban/core";

describe("immutable fiscal study setup", () => {
  it("retains native numerical captures but downgrades all project-owned authority in the new study", async () => {
    const f = fiscalFixture(),
      t = await trafficScenarioFixture();
    const w = await workforceScenarioFixture({
      place: f.place,
      projectId: f.original.id,
    });
    const a = await accessibilityFixture({
      place: f.place,
      receipt: { projectId: f.original.id, jobId: "synthetic-job" },
    });
    Object.assign(f.original.scenarios[1], {
      workforce: w.workforce,
      accessibility: { version: 1, captures: { car: a.evidence } },
    });
    f.original.schemaVersion = 10;
    const original = canonicalJSON(f.original);
    const copied = createFiscalStudy({
      ...f,
      project: f.original,
      scenarioId: f.original.activeScenarioId,
    });
    const s = copied.scenarios[1];
    expect(s.workforce!.origin).toBe("imported");
    expect(s.accessibility!.captures.car!.origin).toBe("imported");
    expect(s.workforce!.capture).toEqual(w.workforce.capture);
    expect(s.accessibility!.captures.car!.capture).toEqual(a.evidence.capture);
    expect(canonicalJSON(f.original)).toBe(original);
    t.scenario.traffic = t.traffic;
    t.project.schemaVersion = 9;
    const trafficCopy = createFiscalStudy({
      ...f,
      place: t.place,
      project: t.project,
      scenarioId: t.scenario.id,
    });
    expect(trafficCopy.scenarios[1].traffic!.origin).toBe("imported");
    expect(trafficCopy.scenarios[1].traffic!.capture).toEqual(
      t.traffic.capture,
    );
    const flood = await floodFixture();
    const floodCopy = createFiscalStudy({
      ...f,
      place: flood.place,
      project: flood.project,
      scenarioId: flood.scenario.id,
    });
    expect(floodCopy.scenarios[1].flood!.origin).toBe("imported");
    expect(floodCopy.floodDatasets).toEqual(flood.project.floodDatasets);
  });
  it("creates a distinct current-proposal study without rewriting the source or retaining reinterpreted history", () => {
    const f = fiscalFixture();
    const selected = f.original.scenarios[1];
    selected.horizon = 5;
    selected.assumptions.householdSize = 3;
    selected.assumptions.incentiveGrant = 500;
    const edited = applyCommand(selected, {
      type: "building.upsert",
      building: { ...f.place.buildings[0], units: 60 },
    });
    f.original.scenarios[1] = edited;
    f.original.history.push({
      id: "history",
      at: f.review.reviewedAt,
      actor: "test",
      label: "Homes",
      command: {
        type: "building.upsert",
        building: edited.buildingEdits.home!,
      },
      before: selected,
      after: edited,
    });
    const before = canonicalJSON(f.original);
    const copied = createFiscalStudy({
      ...f,
      project: f.original,
      scenarioId: edited.id,
    });
    expect(canonicalJSON(f.original)).toBe(before);
    expect(copied.id).not.toBe(f.original.id);
    expect(copied.history).toEqual([]);
    expect(copied.undone).toEqual([]);
    const scenario = copied.scenarios[1];
    expect(scenario.buildingEdits).toEqual(edited.buildingEdits);
    expect(scenario.assumptions.householdSize).toBe(3);
    expect(scenario.baselineAssumptions.householdSize).toBe(2);
    expect(scenario.assumptions.incentiveGrant).toBe(500);
    expect(copied.fiscalStudy!.lineage.scenarioHash).toBe(
      fiscalContentHash(edited),
    );
    expect(copied.fiscalStudy!.lineage.projectHash).toBe(
      fiscalContentHash(f.original),
    );
    expect(copied.fiscalStudy!.lineage.historyHash).toBe(
      fiscalContentHash({ history: f.original.history, undone: [] }),
    );
    expect(fiscalProjectIssues(copied, f.place)).toEqual([]);
  });
  it("requires complete citations and tax-base compatibility without silently defaulting coefficients", () => {
    const { profile } = fiscalFixture();
    expect(
      fiscalProfileSchema.safeParse({
        ...profile,
        coefficients: { ...profile.coefficients, salesPerSqft: undefined },
      }).success,
    ).toBe(false);
    expect(
      fiscalProfileSchema.safeParse({ ...profile, sources: [] }).success,
    ).toBe(false);
    expect(
      fiscalProfileSchema.safeParse({
        ...profile,
        valuation: { ...profile.valuation, buildingValueBasis: "market-value" },
      }).success,
    ).toBe(false);
    profile.provenance.discountRate.kind = "derived";
    expect(fiscalProfileSchema.safeParse(profile).success).toBe(false);
    profile.provenance.discountRate.derivation =
      "Explicit synthetic derivation.";
    expect(fiscalProfileSchema.safeParse(profile).success).toBe(true);
  });
  it("binds format12 across current/history/commands and rejects forged profile/baseline changes", () => {
    const f = fiscalFixture();
    expect(
      projectSchema.safeParse({ ...f.project, schemaVersion: 11 }).success,
    ).toBe(false);
    expect(
      projectWithFiscalVersion({ ...f.project, schemaVersion: 1 })
        .schemaVersion,
    ).toBe(12);
    f.project.fiscalStudy!.profile.coefficients.discountRate = 0.2;
    expect(projectSchema.safeParse(f.project).success).toBe(false);
    f.project.fiscalStudy!.profileHash = fiscalProfileHash(
      f.project.fiscalStudy!.profile,
    );
    expect(projectSchema.safeParse(f.project).success).toBe(false);
  });
  it("preserves optional legacy absence and rejects a fiscal review without the source profile", () => {
    const f = fiscalFixture();
    expect(projectWithFiscalVersion(f.original)).toEqual(f.original);
    expect(
      calculateImpact(f.place, f.original.scenarios[1]),
    ).not.toHaveProperty("fiscal");
    const invalid = structuredClone(f.project);
    delete invalid.fiscalStudy;
    expect(projectSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("paired fiscal cash flows", () => {
  it("marks a reviewed bundle incomplete when a named case unmasks a missing quantity", () => {
    const f = fiscalFixture();
    const b = f.place.buildings[0];
    b.floors = null;
    b.attributeProvenance = {
      version: 1,
      fields: { floors: { status: "missing", sourceId: "synthetic-fiscal" } },
    };
    delete b.assessedValue;
    f.profile.coefficients.effectivePropertyTaxRate = 0;
    const project = createFiscalStudy({
      ...f,
      project: f.original,
      scenarioId: f.original.activeScenarioId,
    });
    const scenario = project.scenarios[1];
    scenario.fiscal!.cases = [
      {
        id: "positive-levy",
        name: "Positive levy",
        description: "A nonzero levy requires an assessed quantity.",
        baseline: { effectivePropertyTaxRate: 0.01 },
        proposal: { effectivePropertyTaxRate: 0.01 },
        sourceIds: ["synthetic-fiscal"],
      },
    ];
    const r = resolveFiscalStudy(f.place, project, scenario);
    expect(r.base!.status).toBe("ready");
    expect(r.cases[0].status).toBe("incomplete");
    expect(r.cases[0].withOffer.totals.propertyRevenue).toBeNull();
    expect(r.status).toBe("incomplete");
  });
  it("normalizes zero and distinguishes a zero-cost offer from unknown recovery", () => {
    const f = fiscalFixture();
    Object.assign(f.scenario.assumptions, {
      abatementPercent: 0.5,
      abatementYears: 2,
    });
    const r = resolveFiscalStudy(f.place, f.project, f.scenario).base!;
    expect(Object.is(r.withOffer.rows[0].netRevenue, -0)).toBe(false);
    expect(Object.is(r.withOffer.rows[0].discountedNet, -0)).toBe(false);
    expect(r.offerCost).toEqual({ total: 0, npv: 0 });
    expect(r.payback).toEqual({ status: "not-needed", year: 0 });
    expect(
      calculateImpact(
        f.place,
        f.scenario,
        {},
        { fiscalStudy: f.project.fiscalStudy },
      ).metrics.find((m) => m.id === "fiscal.incentivePayback")!.value,
    ).toBe(0);
  });
  it("isolates time-zero grant and year-end abatements, NPV and incremental payback", () => {
    const f = fiscalFixture();
    f.scenario.buildingEdits.home = {
      ...f.place.buildings[0],
      assessedValue: 2_000_000,
    };
    Object.assign(f.scenario.assumptions, {
      incentiveGrant: 15000,
      abatementPercent: 0.5,
      abatementYears: 2,
    });
    const r = resolveFiscalStudy(f.place, f.project, f.scenario);
    expect(r.status).toBe("ready");
    const b = r.base!;
    expect(b.baseline.rows[1].netRevenue).toBe(9200);
    expect(b.withOffer.rows[0]).toMatchObject({
      year: 0,
      fiscalYear: null,
      netRevenue: -15000,
      discountedNet: -15000,
      grantCost: 15000,
    });
    expect(b.withOffer.rows.slice(1, 4).map((r) => r.abatementCost)).toEqual([
      5000, 5000, 0,
    ]);
    expect(b.withOffer.rows.slice(1).every((r) => r.grantCost === 0)).toBe(
      true,
    );
    expect(b.withOffer.rows[1].discountedNet).toBeCloseTo(14200 / 1.1);
    expect(b.offerCost.total).toBe(25000);
    expect(b.offerCost.npv).toBeCloseTo(15000 + 5000 / 1.1 + 5000 / 1.1 ** 2);
    expect(b.payback).toEqual({ status: "reached", year: 3 });
    expect(b.withOffer.totals.npv).toBeCloseTo(
      fiscalCashFlows(f.place, f.scenario).reduce(
        (n, r) => n + r.discountedNet!,
        0,
      ),
    );
    const results = calculateImpact(
      f.place,
      f.scenario,
      {},
      { fiscalStudy: f.project.fiscalStudy },
    );
    const firstYear = results.metrics.find((m) => m.id === "fiscal.netAnnual")!;
    const perAcre = results.metrics.find((m) => m.id === "fiscal.netPerAcre")!;
    const grossAcres = perAcre.inputs.find(
      (i) => i.name === "Gross study acres",
    )!.value as number;
    expect(firstYear.value).toBe(-800);
    expect(firstYear.value).toBe(
      b.withOffer.rows[0].netRevenue! + b.withOffer.rows[1].netRevenue!,
    );
    expect(firstYear.baseline).toBe(
      b.baseline.rows[0].netRevenue! + b.baseline.rows[1].netRevenue!,
    );
    expect(perAcre.value).toBeCloseTo(firstYear.value! / grossAcres);
    expect(perAcre.baseline).toBeCloseTo(firstYear.baseline! / grossAcres);
    expect(firstYear.label).toBe("First-year net fiscal impact");
    expect(firstYear.explanation).toContain("time-zero upfront grant cost");
    expect(perAcre.explanation).toContain("combined time-zero grant cost");
    const legacyScenario = { ...f.scenario };
    delete legacyScenario.fiscal;
    const legacy = calculateImpact(f.place, legacyScenario).metrics.find(
      (m) => m.id === "fiscal.netAnnual",
    )!;
    expect(legacy.value).toBe(firstYear.value);
    expect(legacy.label).toBe("Net annual fiscal impact");
    expect(legacy.explanation).toContain(
      "First forecast-year operating balance",
    );
    expect(fiscalResolutionSchema.safeParse(r).success).toBe(true);
  });
  it("reports not-reached separately from unknown quantities and keeps known zero dependency behavior", () => {
    const f = fiscalFixture();
    f.scenario.assumptions.incentiveGrant = 1e6;
    expect(
      resolveFiscalStudy(f.place, f.project, f.scenario).base!.payback.status,
    ).toBe("not-reached");
    f.scenario.buildingEdits.home = {
      ...f.place.buildings[0],
      units: null,
      attributeProvenance: {
        version: 1,
        fields: { units: { status: "missing", sourceId: "synthetic-fiscal" } },
      },
    };
    let r = resolveFiscalStudy(f.place, f.project, f.scenario);
    expect(r.base!.withOffer.totals.netRevenue).toBeNull();
    expect(r.base!.withOffer.rows[0].netRevenue).toBe(-1e6);
    expect(r.base!.offerCost).toEqual({ total: 1e6, npv: 1e6 });
    expect(r.base!.payback.status).toBe("unavailable");
    expect(r.base!.withOffer.missingBuildingIds).toContain("home");
    f.scenario.assumptions.annualServiceCostPerResident = 0;
    r = resolveFiscalStudy(f.place, f.project, f.scenario);
    expect(r.status).toBe("stale");
    expect(r.base!.withOffer.totals.serviceCost).toBe(0);
    expect(r.base!.withOffer.totals.netRevenue).not.toBeNull();
  });
  it("persists explicit paired alternatives, including negative growth, without pretending they are confidence bounds", () => {
    const f = fiscalFixture();
    f.scenario.buildingEdits.home = {
      ...f.place.buildings[0],
      assessedValue: 2e6,
    };
    const cases = [
      {
        id: "paired",
        name: "Paired decline",
        description: "Authored coefficient sensitivity on both sides.",
        baseline: { annualGrowthRate: -0.1, effectivePropertyTaxRate: 0.02 },
        proposal: { annualGrowthRate: -0.1, effectivePropertyTaxRate: 0.03 },
        sourceIds: ["synthetic-fiscal"],
      },
    ];
    f.scenario.fiscal = createFiscalScenarioReview(
      f.scenario,
      f.project.fiscalStudy!.profileHash,
      { ...f.review, notes: "Both sides reviewed." },
      cases,
    );
    const r = resolveFiscalStudy(f.place, f.project, f.scenario);
    expect(r.cases[0].baseline.rows[1].propertyRevenue).toBe(20000);
    expect(r.cases[0].withOffer.rows[1].propertyRevenue).toBe(60000);
    expect(r.cases[0].baseline.rows[2].serviceCost).toBeCloseTo(720);
    expect(r.cases[0].incremental.withOffer.rows[1].propertyRevenue).toBe(
      40000,
    );
    expect(r.notes.join(" ")).toContain("not statistical confidence");
    expect(r.clock).toMatchObject({
      dollarYear: 2025,
      baseFiscalYear: 2026,
      firstOperatingYear: 2026,
    });
  });
  it("keeps review current for geometry/offers but requires explicit review after monetary changes", () => {
    const f = fiscalFixture();
    const beforeHash = fiscalResolutionInputHash(
      f.place,
      f.scenario,
      f.project.fiscalStudy,
    );
    const offer = {
      incentiveGrant: 1000,
      abatementPercent: 0.1,
      abatementYears: 3,
    };
    const command = commandSchema.parse({
      type: "scenario.fiscal",
      fiscal: f.scenario.fiscal,
      offer,
    });
    let s = applyCommand(f.scenario, command);
    expect(resolveFiscalStudy(f.place, f.project, s).reviewState).toBe(
      "current",
    );
    expect(
      fiscalResolutionInputHash(f.place, s, f.project.fiscalStudy),
    ).not.toBe(beforeHash);
    s = applyCommand(s, {
      type: "assumptions.update",
      patch: { discountRate: 0.2 },
    });
    expect(resolveFiscalStudy(f.place, f.project, s).reviewState).toBe("stale");
    s.fiscal = createFiscalScenarioReview(
      s,
      f.project.fiscalStudy!.profileHash,
      { ...f.review, notes: "Explicit authored discount override." },
    );
    const r = resolveFiscalStudy(f.place, f.project, s);
    expect(r.reviewState).toBe("current");
    expect(r.deviations).toEqual([
      {
        key: "discountRate",
        profileValue: 0.1,
        currentValue: 0.2,
        kind: "authored-override",
      },
    ]);
    expect(f.project.fiscalStudy!.profile.coefficients.discountRate).toBe(0.1);
  });
  it("withholds mismatched source/profile contexts, and captures the deterministic resolution in model results", () => {
    const f = fiscalFixture();
    const r = calculateImpact(
      f.place,
      f.scenario,
      {},
      { fiscalStudy: f.project.fiscalStudy },
    );
    expect(r.fiscal).toEqual(
      resolveFiscalStudy(f.place, f.project, f.scenario),
    );
    const changed = { ...f.place, name: "Different baseline" };
    const invalid = calculateImpact(
      changed,
      f.scenario,
      {},
      { fiscalStudy: f.project.fiscalStudy },
    );
    expect(invalid.fiscal!.reviewState).toBe("invalid");
    expect(
      invalid.metrics.find((m) => m.id === "fiscal.npv")!.value,
    ).toBeNull();
  });
  it("keeps fiscal citations in their own media namespace with no source-project history or review lineage", () => {
    const f = fiscalFixture();
    const results = calculateImpact(
      f.place,
      f.scenario,
      {},
      { fiscalStudy: f.project.fiscalStudy },
    );
    const scene = createMediaScene({
      projectId: f.project.id,
      projectVersion: 1,
      place: f.place,
      scenario: f.scenario,
      results,
      fiscalStudy: f.project.fiscalStudy,
      createdAt: f.review.reviewedAt,
    });
    expect(
      scene.sources
        .filter((s) => s.source.id === "synthetic-fiscal")
        .map((s) => s.namespace),
    ).toEqual(["planning-baseline", "fiscal-profile"]);
    expect(scene.binding.fiscalProfileHash).toBe(
      f.project.fiscalStudy!.profileHash,
    );
    expect(scene).not.toHaveProperty("fiscalStudy");
    expect(scene.fiscalProfile).toEqual(f.profile);
    expect(() =>
      createMediaScene({
        projectId: f.project.id,
        projectVersion: 1,
        place: f.place,
        scenario: f.scenario,
        results,
        createdAt: f.review.reviewedAt,
      }),
    ).toThrow(/fiscal/);
  });
});
