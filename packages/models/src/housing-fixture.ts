/** Synthetic evidence for arithmetic/authority tests; never an official HUD row. */
import {
  housingIncomeLimitPackHash,
  createHousingAffordabilityScenario,
  installHousingIncomeLimitPack,
  HOUSING_RENT_COST_KINDS,
  HOUSING_OWNER_COST_KINDS,
  type HousingIncomeLimitPack,
  type HousingCostGroup,
  type HousingCostItem,
  type HousingHouseholdSize,
  type Source,
} from "@urban/core";
import { fiscalFixture } from "./fiscal-fixture";
import { createProject } from "./helpers";
export function housingFixture() {
  const place = structuredClone(fiscalFixture().place);
  place.id = "housing-test";
  place.name = "Synthetic housing study";
  place.buildings[0].units = 10;
  const source: Source = {
    id: "housing-synthetic",
    name: "Synthetic housing limit and cost test data",
    url: "",
    vintage: "2026",
    license: "Synthetic test fixture; not official HUD data",
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
      declaredBy: "fixture",
      declaredAt: "2026-11-06T00:00:00.000Z",
    },
  };
  const pack: HousingIncomeLimitPack = {
    version: 1,
    program: "hud-section8",
    fiscalYear: 2026,
    effectiveDate: "2026-05-01",
    currency: "USD",
    area: {
      id: "SYNTHETIC",
      name: "Synthetic income-limit area",
      geographies: [
        {
          stateFips: "04",
          countyFips: "04013",
          name: "Synthetic county component",
        },
      ],
    },
    limits: Array.from({ length: 8 }, (_, i) => ({
      householdSize: (i + 1) as HousingHouseholdSize,
      extremelyLow: 20000 + i * 10000,
      veryLow: 40000 + i * 10000,
      low: 60000 + i * 10000,
    })),
    sources: [source],
    files: [
      { sourceId: source.id, url: "", sha256: "1".repeat(64), bytes: 100 },
    ],
    sourceRows: [
      {
        fileSha256: "1".repeat(64),
        sheet: "Synthetic",
        row: 2,
        cells: {
          area: "SYNTHETIC",
          explanation: "Invented values solely for test arithmetic",
        },
      },
    ],
    notes: ["Synthetic test values, not official HUD limits."],
  };
  const areaHash = housingIncomeLimitPackHash(pack);
  const group = (
    id: string,
    count = 10,
    tenure: "rent" | "own" = "rent",
  ): HousingCostGroup => ({
    id,
    buildingId: "home",
    units: count,
    tenure,
    householdSize: 1,
    areaHash,
    areaOrigin: "imported",
    costYear: 2026,
    notes: "Synthetic reviewed location and cost assignment.",
    costs: (tenure === "rent"
      ? HOUSING_RENT_COST_KINDS
      : HOUSING_OWNER_COST_KINDS
    ).map(
      (kind) =>
        ({
          id: kind,
          kind,
          state: "separate",
          monthlyCents:
            kind === "rent" || kind === "loan-payment"
              ? 45000
              : kind === "utilities"
                ? 5000
                : 0,
          provenance: {
            kind: "authored",
            sourceIds: [source.id],
            description:
              "Explicit synthetic cost, zero denotes a reviewed zero amount.",
          },
        }) as HousingCostItem,
    ),
  });
  let project = installHousingIncomeLimitPack(createProject(place), pack);
  const scenario = project.scenarios[1];
  const review = {
    reviewedBy: "fixture",
    reviewedAt: "2026-11-06T00:00:00.000Z",
    notes:
      "The synthetic geography, same-dollar clock, mutually exclusive units and full costs were reviewed.",
  };
  scenario.affordability = createHousingAffordabilityScenario(
    place,
    scenario,
    {
      baselineGroups: [group("baseline")],
      proposalGroups: [group("proposal")],
      sources: [source],
    },
    review,
  );
  project = { ...project, scenarios: [project.scenarios[0], scenario] };
  return { place, project, scenario, pack, areaHash, source, group, review };
}
