import {
  FISCAL_COEFFICIENT_KEYS,
  FISCAL_METHOD_VERSION,
  applyCommand,
  type FiscalProfile,
  type Place,
  type Building,
} from "@urban/core";
import {
  createProject,
  createFiscalStudy,
  calculateImpact,
} from "@urban/models";
import type { ReportSnapshot } from "./exports";

/** Deliberately simple authored amounts for independent arithmetic and document QA. */
export function fiscalReportFixture(): ReportSnapshot {
  const stamp = "2026-11-06T12:00:00.000Z";
  const building = (
    id: string,
    x: number,
    value: number,
    jobs: number,
  ): Building => ({
    id: id.toLowerCase().replaceAll(" ", "-"),
    name: id,
    use: "office",
    height: 8,
    floors: 2,
    areaSqm: 100,
    units: 0,
    jobs,
    parkingSpaces: 0,
    sourceId: "qa-planning",
    estimated: false,
    assessedValue: value,
    footprint: [
      [x, 33],
      [x + 0.0001, 33],
      [x + 0.0001, 33.0001],
      [x, 33.0001],
      [x, 33],
    ],
  });
  const place: Place = {
    id: "fiscal-report-qa",
    name: "Fiscal arithmetic study",
    city: "QA",
    state: "AZ",
    zip: "85004",
    center: [-112, 33],
    bounds: [-112.01, 32.99, -111.99, 33.01],
    boundary: [
      [-112.01, 32.99],
      [-111.99, 32.99],
      [-111.99, 33.01],
      [-112.01, 33.01],
      [-112.01, 32.99],
    ],
    buildings: [building("Existing office", -112.001, 100000, 10)],
    roads: [],
    coverage: [],
    loadedAt: stamp,
    extentLabel: "Authored test geography; no observed local fiscal claims",
    sources: [
      {
        id: "qa-planning",
        name: "Authored geometry for arithmetic verification",
        url: "https://example.invalid/planning-qa",
        vintage: "2026",
        license: "Authored QA fixture",
        kind: "user-supplied",
      },
    ],
  };
  const original = createProject(place);
  original.scenarios[1] = applyCommand(original.scenarios[1], {
    type: "building.upsert",
    building: building("Added office", -112.0007, 50000, 5),
  });
  const profile: FiscalProfile = {
    version: 1,
    id: "qa-fiscal-profile",
    name: "Reviewed arithmetic assumptions",
    profileVersion: "1",
    methodVersion: FISCAL_METHOD_VERSION,
    jurisdiction: {
      id: "qa",
      name: "Authored QA jurisdiction",
      geography: "Synthetic study geography only",
      sourceIds: ["qa-fiscal"],
    },
    fiscalYear: 2027,
    dollarYear: 2026,
    currency: "USD",
    priceBasis: "constant-dollars",
    discountBasis: "real",
    coefficients: {
      assessedValuePerSqft: 100,
      effectivePropertyTaxRate: 0.01,
      annualServiceCostPerResident: 0,
      annualServiceCostPerJob: 20,
      annualGrowthRate: 0,
      discountRate: 0.1,
      salesPerSqft: 0,
      localSalesTaxRate: 0,
      retailCaptureRate: 0,
    },
    provenance: Object.fromEntries(
      FISCAL_COEFFICIENT_KEYS.map((key) => [
        key,
        {
          kind: "authored",
          sourceIds: ["qa-fiscal"],
          description: `Authored ${key} for independent arithmetic verification; no municipal estimate.`,
        },
      ]),
    ) as FiscalProfile["provenance"],
    valuation: {
      buildingValueBasis: "taxable-assessed",
      fallbackValueBasis: "taxable-assessed-per-gross-sqft",
      compatibilityNotes:
        "Both buildings have explicit authored taxable assessed values of 100000 and 50000 USD; no market-value conversion.",
    },
    serviceAllocation: {
      method: "authored-case-study",
      notes:
        "20 USD per workplace job per year; resident service cost zero. These authored values do not allocate a real budget.",
      sourceIds: ["qa-fiscal"],
    },
    sources: [
      {
        id: "qa-fiscal",
        name: "Authored fiscal arithmetic worksheet",
        url: "https://example.invalid/fiscal-qa",
        vintage: "2026",
        license: "Authored test data; unrestricted QA redistribution",
        kind: "user-supplied",
        rights: {
          version: 1,
          privateUse: true,
          cache: true,
          analyze: true,
          privateDisplay: true,
          export: true,
          historicalRetention: true,
          publicRedistribution: true,
          declaredBy: "QA reviewer",
          declaredAt: stamp,
        },
      },
    ],
    files: [],
    notes: [
      "This report is generated solely to verify arithmetic and layout; coefficients are not local government facts.",
    ],
  };
  const project = createFiscalStudy({
    place,
    project: original,
    scenarioId: original.scenarios[1].id,
    profile,
    review: {
      reviewedBy: "QA reviewer",
      reviewedAt: stamp,
      applicabilityNotes:
        "Synthetic geometry and authored values reviewed for this test only.",
    },
    name: "Fiscal proposal review",
  });
  let scenario = project.scenarios[1];
  scenario = applyCommand(scenario, {
    type: "scenario.fiscal",
    fiscal: {
      ...scenario.fiscal!,
      cases: [
        {
          id: "lower-rate",
          name: "Lower retained levy",
          description:
            "Both sides use a 0.5% retained levy, keeping the offer and other assumptions unchanged.",
          baseline: { effectivePropertyTaxRate: 0.005 },
          proposal: { effectivePropertyTaxRate: 0.005 },
          sourceIds: ["qa-fiscal"],
        },
        {
          id: "higher-cost",
          name: "Higher service allocation",
          description:
            "Both sides allocate 30 USD per job per year. This is an authored sensitivity, not a statistical range.",
          baseline: { annualServiceCostPerJob: 30 },
          proposal: { annualServiceCostPerJob: 30 },
          sourceIds: ["qa-fiscal"],
        },
      ],
    },
    offer: { incentiveGrant: 1000, abatementPercent: 0.5, abatementYears: 2 },
  });
  project.scenarios[1] = scenario;
  return {
    project,
    place,
    scenario,
    results: calculateImpact(
      place,
      scenario,
      {},
      { fiscalStudy: project.fiscalStudy },
    ),
    generatedAt: stamp,
    projectVersion: 1,
  };
}
