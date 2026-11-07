import {
  assertRetailScenario,
  retailSourceIds,
  type Place,
  type RetailScenario,
  type Scenario,
} from "@urban/core";

export interface RetailTotals {
  baselineDemand: number | null;
  scenarioDemand: number | null;
  baselineSales: number | null;
  baselineGap: number | null;
  eligibleGap: number | null;
  grossCapturedSales: number | null;
  displacedSales: number | null;
  netNewSales: number | null;
  scenarioSales: number | null;
  scenarioGap: number | null;
  baselineEstablishmentEquivalent: number | null;
  scenarioEstablishmentEquivalent: number | null;
}
export interface RetailCategoryResult extends RetailTotals {
  id: string;
  name: string;
  code: string;
  status: "ready" | "incomplete" | "unavailable";
  warnings: string[];
  sourceIds: string[];
}
export interface RetailResolution {
  status: "ready" | "incomplete" | "unavailable" | "stale";
  context: RetailScenario["context"];
  categories: RetailCategoryResult[];
  totals: RetailTotals;
  knownSubtotal: RetailTotals;
  coverage: { categories: number; completeCategories: number };
  warnings: string[];
  sourceIds: string[];
}
const fields: readonly (keyof RetailTotals)[] = [
  "baselineDemand",
  "scenarioDemand",
  "baselineSales",
  "baselineGap",
  "eligibleGap",
  "grossCapturedSales",
  "displacedSales",
  "netNewSales",
  "scenarioSales",
  "scenarioGap",
  "baselineEstablishmentEquivalent",
  "scenarioEstablishmentEquivalent",
];
const finite = (v: number | null) =>
  v !== null && Number.isFinite(v) ? v : null;
const difference = (a: number | null, b: number | null) =>
  a === null || b === null ? null : finite(a - b);
const sum = (values: number[]) => {
  let total = 0,
    correction = 0;
  for (const value of [...values].sort(
    (a, b) => Math.abs(a) - Math.abs(b) || a - b,
  )) {
    const next = total + value;
    correction +=
      Math.abs(total) >= Math.abs(value)
        ? total - next + value
        : value - next + total;
    total = next;
  }
  return total + correction;
};
const unique = (items: string[]) => [...new Set(items)];

/** Authored annual category sensitivities. No automatic floor-area, population, inflation, or fiscal linkage. */
export function resolveRetail(
  place: Place,
  scenario: Scenario,
): RetailResolution | null {
  const retail = scenario.retail;
  if (!retail) return null;
  assertRetailScenario(retail);
  const stale = retail.context.horizon !== scenario.horizon;
  const attested =
    retail.context.comparabilityConfirmed &&
    retail.context.disjointCategoriesConfirmed;
  const sourceIds = retailSourceIds(retail);
  const privateAuthorized = sourceIds.every((id) =>
    retail.sourceRights.some(
      (r) => r.sourceId === id && r.authorizedPrivateUse,
    ),
  );
  const retained = new Set(
    [...place.sources, ...(scenario.sources ?? [])].map((s) => s.id),
  );
  const sourcesComplete = sourceIds.every(
    (id) => retained.has(id) || id === "user-retail-analysis",
  );
  const warnings = [
    "Demand minus establishment sales is a signed demand–sales gap, not measured resident spending leakage. Sales can include visitors, commuters and online transactions; this model does not identify buyer origins.",
    "Results cover only the studied mutually exclusive categories. They do not represent the complete local retail economy or forecast business openings.",
    "Annual proposed sales capacity is entered per category. Building floor area, population, employment, prices, existing-store sales and fiscal revenue are not automatically changed.",
  ];
  if (!attested)
    warnings.push(
      "Comparability and category-disjointness declarations are not complete. Preview values are provisional until reviewed.",
    );
  if (!privateAuthorized)
    warnings.push(
      "Private storage/analysis/export rights have not been confirmed for every referenced source.",
    );
  if (!sourcesComplete)
    warnings.push("One or more retail source records are missing.");
  if (stale)
    warnings.push(
      `The study was reviewed for horizon ${retail.context.horizon}, but this scenario uses ${scenario.horizon}. Baseline evidence is retained; review and reapply the study before using proposal results.`,
    );
  if (retail.context.relationshipToStudyArea === "context-only")
    warnings.push(
      `This study describes ${retail.context.geography} as context, not totals for ${place.extentLabel}. No geographic scaling has been applied.`,
    );
  const categories = retail.categories.map((c): RetailCategoryResult => {
    const baselineDemand = c.baselineDemand.value,
      baselineSales = c.baselineSales.value;
    const scenarioDemand = stale ? null : (c.scenarioDemand ?? baselineDemand);
    const baselineGap = difference(baselineDemand, baselineSales);
    const candidateGap = difference(scenarioDemand, baselineSales);
    const eligibleGap =
      stale || candidateGap === null ? null : Math.max(0, candidateGap);
    // An explicit no-addition choice is a known zero even if reference demand is missing.
    const grossCapturedSales = stale
      ? null
      : c.annualSalesCapacity === 0 || c.captureShare === 0
        ? 0
        : eligibleGap === null
          ? null
          : Math.min(eligibleGap * c.captureShare, c.annualSalesCapacity);
    const displacedSales = stale
      ? null
      : c.displacementShare === 0
        ? 0
        : grossCapturedSales === null
          ? null
          : grossCapturedSales * c.displacementShare;
    const netNewSales = stale
      ? null
      : c.displacementShare === 1
        ? 0
        : grossCapturedSales === null
          ? null
          : grossCapturedSales * (1 - c.displacementShare);
    const scenarioSales =
      baselineSales === null || netNewSales === null
        ? null
        : finite(baselineSales + netNewSales);
    const scenarioGap = difference(scenarioDemand, scenarioSales);
    const benchmark = c.salesPerEstablishment.value;
    const equivalent = (gap: number | null) =>
      gap === null || benchmark === null
        ? null
        : finite(Math.max(0, gap) / benchmark);
    const baselineEstablishmentEquivalent = equivalent(baselineGap),
      scenarioEstablishmentEquivalent = stale ? null : equivalent(scenarioGap);
    const rowWarnings: string[] = [];
    for (const [name, measure] of [
      ["Resident annual demand", c.baselineDemand],
      ["Local establishment sales", c.baselineSales],
      ["Sales-per-establishment benchmark", c.salesPerEstablishment],
    ] as const)
      if (measure.status !== "available")
        rowWarnings.push(
          `${name} is ${measure.status}; it has not been replaced with zero.`,
        );
    if (baselineGap !== null && baselineGap < 0)
      rowWarnings.push(
        "Sales exceed resident demand. This is a surplus relative to the supplied demand estimate, not proof of consumer inflows or oversupply.",
      );
    if (c.annualSalesCapacity > 0 && eligibleGap === 0)
      rowWarnings.push(
        "No positive eligible demand–sales gap remains; proposed capacity alone does not manufacture sales capture.",
      );
    if (
      benchmark !== null &&
      ((baselineGap !== null && baselineEstablishmentEquivalent === null) ||
        (scenarioGap !== null && scenarioEstablishmentEquivalent === null))
    )
      rowWarnings.push(
        "The supplied benchmark produces an unrepresentable establishment equivalent; that result is unavailable.",
      );
    const monetaryComplete = [
      baselineDemand,
      baselineSales,
      scenarioDemand,
      eligibleGap,
      scenarioSales,
      scenarioGap,
    ].every((v) => v !== null);
    return {
      id: c.id,
      name: c.name,
      code: c.code,
      baselineDemand,
      scenarioDemand,
      baselineSales,
      baselineGap,
      eligibleGap,
      grossCapturedSales,
      displacedSales,
      netNewSales,
      scenarioSales,
      scenarioGap,
      baselineEstablishmentEquivalent,
      scenarioEstablishmentEquivalent,
      status:
        monetaryComplete && attested && privateAuthorized && sourcesComplete
          ? "ready"
          : baselineDemand === null &&
              baselineSales === null &&
              scenarioDemand === null
            ? "unavailable"
            : "incomplete",
      warnings: rowWarnings,
      sourceIds: unique([
        c.assumptionSourceId,
        ...[c.baselineDemand, c.baselineSales, c.salesPerEstablishment].flatMap(
          (m) => (m.sourceId ? [m.sourceId] : []),
        ),
      ]),
    };
  });
  const totals = {} as RetailTotals,
    knownSubtotal = {} as RetailTotals;
  for (const field of fields) {
    const known = categories.flatMap((c) =>
      c[field] === null ? [] : [c[field]!],
    );
    knownSubtotal[field] = known.length ? finite(sum(known)) : null;
    totals[field] =
      known.length === categories.length ? knownSubtotal[field] : null;
  }
  const completeCategories = categories.filter(
    (c) => c.status === "ready",
  ).length;
  return {
    status: stale
      ? "stale"
      : completeCategories === categories.length
        ? "ready"
        : categories.every((c) => c.status === "unavailable")
          ? "unavailable"
          : "incomplete",
    context: structuredClone(retail.context),
    categories,
    totals,
    knownSubtotal,
    coverage: { categories: categories.length, completeCategories },
    warnings,
    sourceIds,
  };
}
