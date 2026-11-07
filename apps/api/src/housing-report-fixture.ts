import {
  createHousingAffordabilityScenario,
  type HousingCostGroup,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import { housingFixture } from "../../../packages/models/src/housing-fixture";
import type { ReportSnapshot } from "./exports";
/** Deliberately synthetic values for independent arithmetic and document QA. */
export function housingReportFixture(): ReportSnapshot {
  const f = housingFixture();
  f.place.buildings[0].name = "Ten modeled homes";
  const group = (
    id: string,
    units: number,
    tenure: "rent" | "own",
    payment: number,
    utilities: number,
  ): HousingCostGroup => {
    const g = f.group(id, units, tenure);
    for (const c of g.costs) {
      if (c.state !== "separate") continue;
      c.monthlyCents =
        c.kind === "rent" || c.kind === "loan-payment"
          ? payment
          : c.kind === "utilities"
            ? utilities
            : 0;
    }
    if (tenure === "own")
      g.costs = g.costs.map((c) =>
        ["property-tax", "property-insurance"].includes(c.kind)
          ? {
              id: c.id,
              kind: c.kind,
              provenance: {
                ...c.provenance,
                description:
                  "Reviewed tax and insurance included in the stated escrow payment.",
              },
              state: "included",
              includedIn: "loan-payment",
            }
          : [
                "flood-insurance",
                "mortgage-insurance",
                "association-fees",
                "ground-rent",
              ].includes(c.kind)
            ? {
                id: c.id,
                kind: c.kind,
                provenance: {
                  ...c.provenance,
                  description:
                    "Reviewed not applicable for this synthetic ownership group.",
                },
                state: "not-applicable",
              }
            : c,
      );
    return g;
  };
  f.scenario.affordability = createHousingAffordabilityScenario(
    f.place,
    f.scenario,
    {
      baselineGroups: [
        group("Existing rental", 6, "rent", 45000, 5000),
        group("Existing ownership", 4, "own", 90000, 10000),
      ],
      proposalGroups: [
        group("Proposed rental", 6, "rent", 70000, 10000),
        group("Proposed ownership", 4, "own", 150000, 20000),
      ],
      sources: [f.source],
    },
    f.review,
  );
  const results = calculateImpact(
    f.place,
    f.scenario,
    {},
    { housingIncomeLimits: f.project.housingIncomeLimits },
  );
  return {
    place: f.place,
    project: f.project,
    scenario: f.scenario,
    results,
    generatedAt: "2026-11-06T12:00:00.000Z",
  };
}
