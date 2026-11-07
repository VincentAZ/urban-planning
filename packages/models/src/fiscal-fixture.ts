/** Synthetic coefficient/geometry fixture; never a published local fiscal profile. */
import {
  FISCAL_COEFFICIENT_KEYS,
  FISCAL_METHOD_VERSION,
  type FiscalProfile,
  type Place,
} from "@urban/core";
import { createProject } from "./helpers";
import { createFiscalStudy } from "./fiscal";
export function fiscalFixture() {
  const source = {
    id: "synthetic-fiscal",
    name: "Synthetic fiscal test assumptions",
    url: "",
    vintage: "2026",
    license: "Synthetic test data",
    kind: "user-supplied" as const,
  };
  const place: Place = {
    id: "fiscal-test",
    name: "Synthetic fiscal area",
    city: "Fixture",
    state: "AZ",
    zip: "85003",
    center: [-112.075, 33.45],
    bounds: [-112.08, 33.44, -112.07, 33.46],
    boundary: [
      [-112.08, 33.44],
      [-112.07, 33.44],
      [-112.07, 33.46],
      [-112.08, 33.46],
      [-112.08, 33.44],
    ],
    buildings: [
      {
        id: "home",
        name: "Forty homes",
        use: "multifamily",
        footprint: [
          [-112.075, 33.45],
          [-112.074, 33.45],
          [-112.074, 33.451],
          [-112.075, 33.451],
          [-112.075, 33.45],
        ],
        height: 12,
        floors: 4,
        areaSqm: 1000,
        units: 40,
        jobs: 0,
        parkingSpaces: 45,
        sourceId: source.id,
        estimated: false,
        assessedValue: 1_000_000,
      },
    ],
    roads: [],
    sources: [source],
    coverage: [],
    loadedAt: "2026-11-06T00:00:00.000Z",
    extentLabel: "Synthetic exact boundary",
  };
  const original = createProject(place);
  for (const s of original.scenarios) {
    s.assumptions.householdSize = s.baselineAssumptions.householdSize = 2;
    s.assumptions.vacancyRate = s.baselineAssumptions.vacancyRate = 0;
  }
  const profile: FiscalProfile = {
    version: 1,
    id: "test-profile",
    name: "Synthetic fiscal profile",
    profileVersion: "1",
    methodVersion: FISCAL_METHOD_VERSION,
    jurisdiction: {
      id: "synthetic",
      name: "Synthetic city",
      geography: "Test boundary only",
      sourceIds: [source.id],
    },
    fiscalYear: 2026,
    dollarYear: 2025,
    currency: "USD",
    priceBasis: "constant-dollars",
    discountBasis: "real",
    coefficients: {
      assessedValuePerSqft: 200,
      effectivePropertyTaxRate: 0.01,
      annualServiceCostPerResident: 10,
      annualServiceCostPerJob: 0,
      annualGrowthRate: 0,
      discountRate: 0.1,
      salesPerSqft: 0,
      localSalesTaxRate: 0,
      retailCaptureRate: 0,
    },
    provenance: Object.fromEntries(
      FISCAL_COEFFICIENT_KEYS.map((k) => [
        k,
        {
          kind: "authored",
          sourceIds: [source.id],
          description: `Synthetic ${k}, not a local observation.`,
        },
      ]),
    ) as FiscalProfile["provenance"],
    valuation: {
      buildingValueBasis: "taxable-assessed",
      fallbackValueBasis: "taxable-assessed-per-gross-sqft",
      compatibilityNotes:
        "Synthetic records explicitly represent a taxable assessed base, not market value.",
    },
    serviceAllocation: {
      method: "authored-case-study",
      notes:
        "Synthetic resident service allocation; job coefficient explicitly zero, no duplicate expense.",
      sourceIds: [source.id],
    },
    sources: [source],
    files: [],
    notes: [
      "All coefficients are synthetic; no local tax or service-cost determination.",
    ],
  };
  const review = {
    reviewedBy: "fixture-reviewer",
    reviewedAt: "2026-11-06T00:00:00.000Z",
    applicabilityNotes:
      "Explicit synthetic boundary and taxable-value compatibility test.",
  };
  const project = createFiscalStudy({
    place,
    project: original,
    scenarioId: original.activeScenarioId,
    profile,
    review,
  });
  return {
    place,
    original,
    profile,
    review,
    project,
    scenario: project.scenarios.find((s) => s.id === project.activeScenarioId)!,
  };
}
