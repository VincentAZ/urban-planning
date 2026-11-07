/** Deterministic test-only synthetic fixtures; no observed source data. */
import { buildingPreset, createScenario } from "./helpers";
import { typedBuildingPreset } from "./buildings";
import { USER_ACTIVITY_SOURCE, type Place, type Scenario } from "@urban/core";
export function numericParityFixtures(): {
  place: Place;
  scenario: Scenario;
}[] {
  const buildings = [
    "multifamily",
    "mixed-use",
    "office",
    "retail",
    "parking",
    "park",
  ].map((use, i) => ({
    ...buildingPreset(use as Parameters<typeof buildingPreset>[0], [
      0.003 + i * 0.002,
      0.005,
    ]),
    id: `b-${i}`,
    assessedValue: i === 2 ? 123456 : undefined,
  }));
  const place: Place = {
    id: "parity",
    name: "Numeric parity fixture",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [0.01, 0.01],
    bounds: [0, 0, 0.03, 0.03],
    boundary: [
      [0, 0],
      [0.03, 0],
      [0.03, 0.03],
      [0, 0.03],
      [0, 0],
    ],
    buildings,
    roads: [],
    sources: [USER_ACTIVITY_SOURCE],
    coverage: [],
    extentLabel: "Synthetic arithmetic fixture",
    loadedAt: "2026-11-06T00:00:00Z",
  };
  return [0, 5, 10, 20].flatMap((horizon) =>
    [false, true].map((explicit) => {
      const p = structuredClone(place),
        s = createScenario("Parity");
      s.id = `parity-${horizon}-${explicit}`;
      s.horizon = horizon as Scenario["horizon"];
      s.assumptions.annualGrowthRate = 0.013;
      s.assumptions.populationMultiplier = 1.17;
      s.assumptions.incentiveGrant = 12345;
      s.assumptions.abatementPercent = 0.23;
      s.assumptions.abatementYears = 4;
      s.assumptions.fiscalInputsConfirmed = true;
      s.baselineAssumptions.fiscalInputsConfirmed = true;
      s.buildingEdits["b-0"] = { ...p.buildings[0], units: 91 };
      if (explicit) {
        const b = typedBuildingPreset("hospital", [0.02, 0.01]);
        b.id = "hospital";
        s.buildingEdits.hospital = b;
      }
      return { place: p, scenario: s };
    }),
  );
}
