import { MODEL_VERSION, resolveRetail } from "@urban/models";
import type { RetailMeasure } from "@urban/core";
import { ApiError } from "./errors.js";
import type { ReportSnapshot } from "./exports.js";

export const retailReportDisclosure =
  "Retail demand–sales screening uses entered category evidence and explicit annual capacity, capture and displacement assumptions. Demand minus local sales is not measured resident spending outside the area: inbound customers, online spending, commodity/industry definitions and coverage can differ. Establishment equivalents are demand-capacity ratios, not predicted openings or site feasibility. No automatic building-area allocation, population growth, fiscal-tax adjustment or cross-category transfer is applied. Missing and suppressed values remain unknown.";
const amount = (value: number | null) =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const measure = (value: RetailMeasure) =>
  `${value.status === "available" ? amount(value.value) : value.status === "suppressed" ? "Suppressed" : "Missing"}${value.sourceId ? ` · ${value.sourceId}` : ""}${value.note ? ` · ${value.note}` : ""}`;

export function retailReportInventory(snapshot: ReportSnapshot) {
  const retail = snapshot.scenario.retail;
  if (!retail) return null;
  if (snapshot.results.modelVersion !== MODEL_VERSION)
    throw new ApiError(
      409,
      "RETAIL_MODEL_VERSION_MISMATCH",
      "These frozen results were calculated with a different model version. Use their saved scorecard and complete records; retail category results must not be silently recalculated for this export.",
    );
  const resolved = resolveRetail(snapshot.place, snapshot.scenario)!;
  const context = retail.context;
  const contextDescription = `${context.geography}; ${context.relationshipToStudyArea}; reference year ${context.referenceYear}; constant ${context.dollarYear} USD/year; ${context.classification.system} ${context.classification.version}; evidence horizon ${context.horizon}, scenario horizon ${snapshot.scenario.horizon}; scenario revision ${snapshot.scenario.revision}. Status: ${resolved.status}.`;
  const resultRows = resolved.categories.map((row) => [
    `${row.name}\n${row.code} · ${row.status}`,
    `${amount(row.baselineDemand)} / ${amount(row.scenarioDemand)}`,
    `${amount(row.baselineSales)} / ${amount(row.scenarioSales)}`,
    `${amount(row.baselineGap)} / ${amount(row.scenarioGap)}`,
    `${amount(row.netNewSales)}\n${amount(row.scenarioEstablishmentEquivalent)} establishments`,
  ]);
  const captureRows = resolved.categories.map((row) => [
    row.name,
    amount(row.eligibleGap),
    amount(row.grossCapturedSales),
    amount(row.displacedSales),
    amount(row.netNewSales),
  ]);
  const inputRows = retail.categories.map((row) => [
    `${row.name}\nID ${row.id}`,
    `${measure(row.baselineDemand)}\nScenario: ${row.scenarioDemand === null ? "Keep reference demand" : amount(row.scenarioDemand)}`,
    `${measure(row.baselineSales)}\nBenchmark: ${measure(row.salesPerEstablishment)}`,
    `${amount(row.annualSalesCapacity)}\nCapture ${(row.captureShare * 100).toLocaleString("en-US")}%\nDisplacement ${(row.displacementShare * 100).toLocaleString("en-US")}%\n${row.assumptionSourceId}`,
  ]);
  const notes = [
    `Complete categories: ${resolved.coverage.completeCategories} of ${resolved.coverage.categories}. Totals with missing required values are unavailable; known-category subtotals are not complete study totals.`,
    ...resolved.warnings,
    ...resolved.categories.flatMap((row) =>
      row.warnings.map((warning) => `${row.name}: ${warning}`),
    ),
    ...retail.sourceRights.map(
      (right) =>
        `Source ${right.sourceId}. Private storage, analysis, team sharing and exports: ${right.authorizedPrivateUse ? "user-attested permitted" : "not permitted"}. Public redistribution of input values and attribution: ${right.publicRedistribution ? "user-attested permitted" : "not permitted"}. ${right.statement}`,
    ),
    "Source-rights declarations are user attestations, not independent verification of a license. This private report retains the authorized project's entered evidence.",
  ];
  return {
    retail,
    resolved,
    contextDescription,
    resultRows,
    captureRows,
    inputRows,
    notes,
  };
}

/** Native document generation must fail clearly instead of dropping long input notes. */
export function assertRetailDocumentLimit(snapshot: ReportSnapshot) {
  if (
    snapshot.scenario.retail &&
    JSON.stringify(snapshot.scenario.retail).length > 120_000
  )
    throw new ApiError(
      413,
      "RETAIL_REPORT_TOO_LARGE",
      "This retail evidence pack is too large for a PDF or Word appendix. Export its CSV, XLSX or complete saved records; no categories have been omitted.",
    );
}
