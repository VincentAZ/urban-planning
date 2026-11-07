import { it, expect } from "vitest";
import { calculateImpact, fiscalCashFlows } from "./engine";
import { numericParityFixtures } from "./numeric-parity-fixture";
import captured from "./fixtures/numeric-0.6-parity.json";
it("preserves every numeric metric and fiscal flow from the pre-nullable engine across eight synthetic numeric scenarios", () => {
  const actual = numericParityFixtures().map(({ place, scenario }) => ({
    id: scenario.id,
    metrics: calculateImpact(place, scenario).metrics.map(
      ({ id, baseline, value, delta, status }) => ({
        id,
        baseline,
        value,
        delta,
        status,
      }),
    ),
    flows: fiscalCashFlows(place, scenario),
  }));
  expect(actual).toEqual(captured);
});
