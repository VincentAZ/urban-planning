import {
  FISCAL_COEFFICIENT_KEYS,
  FISCAL_METHOD_VERSION,
  fiscalResolutionInputHash,
  type FiscalCaseResult,
  type FiscalCoefficientKey,
} from "@urban/core";
import type { ReportSnapshot } from "./exports";
import { assertFiscalExport } from "./fiscal-rights";
import { ApiError } from "./errors";

export {
  FISCAL_REPORT_DISCLOSURE as fiscalReportDisclosure,
  FISCAL_CLOCK_DISCLOSURE as fiscalClockDisclosure,
} from "@urban/core";
export const fiscalParameterLabels: Record<FiscalCoefficientKey, string> = {
  assessedValuePerSqft: "Fallback taxable assessed value · USD/gross ft²",
  effectivePropertyTaxRate:
    "Retained property-tax rate · fraction of assessed value",
  annualServiceCostPerResident: "Annual allocated service cost · USD/resident",
  annualServiceCostPerJob: "Annual allocated service cost · USD/workplace job",
  annualGrowthRate: "Annual real growth · fraction",
  discountRate: "Real discount rate · fraction",
  salesPerSqft: "Annual sales · USD/retail ft²",
  localSalesTaxRate: "Retained local sales-tax rate · fraction",
  retailCaptureRate: "Retail capture share · fraction",
};

/** Full source/profile text is retained; no truncation of explanations or derivations. */
export function fiscalProfileInventory(snapshot: ReportSnapshot) {
  const study = snapshot.project.fiscalStudy;
  if (!study) return null;
  assertFiscalExport(snapshot.project);
  const profile = study.profile;
  const parameterRows = FISCAL_COEFFICIENT_KEYS.map((key) => [
    fiscalParameterLabels[key],
    String(profile.coefficients[key]),
    String(snapshot.scenario.baselineAssumptions[key]),
    String(snapshot.scenario.assumptions[key]),
  ]);
  const parameterNotes = FISCAL_COEFFICIENT_KEYS.map((key) => {
    const provenance = profile.provenance[key];
    const deviation =
      snapshot.scenario.assumptions[key] !== profile.coefficients[key];
    return `${fiscalParameterLabels[key]}. Profile value ${profile.coefficients[key]} is ${provenance.kind}. ${provenance.description}${provenance.derivation ? ` Derivation: ${provenance.derivation}` : ""} Sources: ${provenance.sourceIds.join(", ")}.${deviation ? ` Current proposal value ${snapshot.scenario.assumptions[key]} is an authored deviation; the original profile citation does not establish this changed value.` : ""}`;
  });
  const context = [
    `${profile.name}; version ${profile.profileVersion}; jurisdiction ${profile.jurisdiction.name} (${profile.jurisdiction.id}). ${profile.jurisdiction.geography}. Fiscal year ${profile.fiscalYear}; constant ${profile.dollarYear} USD.`,
    `Currency ${profile.currency}; price basis ${profile.priceBasis}; discount basis ${profile.discountBasis}. Method ${study.methodVersion}; profile SHA-256 ${study.profileHash}.`,
    `Applicability reviewed by ${study.applicability.reviewedBy} on ${study.applicability.reviewedAt}: ${study.applicability.applicabilityNotes}. Review type: ${study.applicability.kind}.`,
    `Valuation compatibility: ${profile.valuation.compatibilityNotes}. Recorded values: ${profile.valuation.buildingValueBasis}; fallback: ${profile.valuation.fallbackValueBasis}.`,
    `Service allocation: ${profile.serviceAllocation.method}. ${profile.serviceAllocation.notes}. Sources: ${profile.serviceAllocation.sourceIds.join(", ")}.`,
    `Source project ${study.lineage.projectId}; scenario ${study.lineage.scenarioId}, revision ${study.lineage.scenarioRevision}; copied ${study.lineage.copiedAt}. Copy policy: ${study.lineage.policy}. The source project's original history is retained separately.`,
    `Source project SHA-256 ${study.lineage.projectHash}; source scenario SHA-256 ${study.lineage.scenarioHash}; source history SHA-256 ${study.lineage.historyHash}; captured place SHA-256 ${study.placeHash}; frozen baseline assumptions SHA-256 ${study.baselineAssumptionsHash}.`,
    ...profile.notes,
    ...profile.files.map(
      (file) =>
        `Retained source-file receipt: ${file.sourceId}; ${file.url}; ${file.bytes} bytes; SHA-256 ${file.sha256}. The receipt identifies a declared file; it does not independently authenticate its contents.`,
    ),
  ];
  return { study, profile, parameterRows, parameterNotes, context };
}

export const fiscalAmount = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);
export const fiscalPayback = (value: FiscalCaseResult["payback"]) =>
  value.status === "reached"
    ? `Year ${value.year}`
    : value.status === "not-needed"
      ? "No incentive cost"
      : value.status === "not-reached"
        ? "Not reached within 20 years"
        : "Unavailable";
export const fiscalAlternatives = [
  ["baseline", "Frozen baseline"],
  ["withoutOffer", "Development without offer"],
  ["withOffer", "Development with offer"],
] as const;

/** Documents consume the frozen result bundle, never recalculate old publications. */
export function fiscalReportInventory(snapshot: ReportSnapshot) {
  const profile = fiscalProfileInventory(snapshot);
  const resolution = snapshot.results.fiscal;
  if (!profile && !resolution) return null;
  if (
    !profile ||
    !resolution ||
    resolution.methodVersion !== FISCAL_METHOD_VERSION ||
    resolution.profileHash !== profile.study.profileHash ||
    resolution.scenarioId !== snapshot.scenario.id ||
    resolution.scenarioRevision !== snapshot.scenario.revision ||
    resolution.inputHash !==
      fiscalResolutionInputHash(
        snapshot.place,
        snapshot.scenario,
        profile.study,
      )
  )
    throw new ApiError(
      409,
      "FISCAL_RESULT_MISMATCH",
      "The fiscal report needs its matching frozen profile and result bundle. Recalculate and save this study before exporting; old results are not silently recomputed.",
    );
  const cases = [
    ...(resolution.base ? [resolution.base] : []),
    ...resolution.cases,
  ];
  const review = snapshot.scenario.fiscal?.review;
  const context = [
    ...profile.context,
    `Result status: ${resolution.status}. Input review: ${resolution.reviewState}.${review ? ` Reviewed by ${review.reviewedBy} on ${review.reviewedAt}. ${review.notes}` : " No retained proposal input review."}`,
    `Fiscal result input SHA-256 ${resolution.inputHash}.`,
    ...(resolution.clock
      ? [
          `Operating years ${resolution.clock.firstOperatingYear} through ${resolution.clock.firstOperatingYear + resolution.clock.years - 1}; scenario horizon ${resolution.clock.horizonYears} years. Time-zero grant precedes operating year one. All monetary values in constant ${resolution.clock.dollarYear} USD; real discount rate; NPV date is the start of the selected horizon.`,
        ]
      : []),
    ...resolution.notes,
  ];
  const summaryRows = cases.map((c) => [
    c.name,
    fiscalAmount(c.incremental.withoutOffer.netRevenue),
    fiscalAmount(c.incremental.withOffer.netRevenue),
    fiscalAmount(c.incremental.withOffer.npv),
    fiscalPayback(c.payback),
  ]);
  const panels = cases.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    notes: [
      `Status: ${c.status}. Sources: ${c.sourceIds.join(", ")}.`,
      `Offer: upfront grant ${fiscalAmount(c.assumptions.proposal.incentiveGrant)}; ${c.assumptions.proposal.abatementPercent * 100}% of the modeled levy on added assessed value for ${c.assumptions.proposal.abatementYears} years. Undiscounted offer cost ${fiscalAmount(c.offerCost.total)}; offer-cost present value ${fiscalAmount(c.offerCost.npv)}. Payback: ${fiscalPayback(c.payback)}.`,
      ...fiscalAlternatives.map(
        ([key, label]) =>
          `${label}: 20-year property receipts ${fiscalAmount(c[key].totals.propertyRevenue)}, sales receipts ${fiscalAmount(c[key].totals.salesRevenue)}, allocated service costs ${fiscalAmount(c[key].totals.serviceCost)}, abatement ${fiscalAmount(c[key].totals.abatementCost)}, grant ${fiscalAmount(c[key].totals.grantCost)}, net ${fiscalAmount(c[key].totals.netRevenue)}, NPV ${fiscalAmount(c[key].totals.npv)}.${c[key].missingBuildingIds.length ? ` Missing required building quantities: ${c[key].missingBuildingIds.join(", ")}.` : ""}`,
      ),
    ],
    annualRows: c.baseline.rows.map((row, i) => [
      row.year === 0
        ? "Time zero"
        : `${row.year} / ${row.fiscalYear ?? "unspecified"}`,
      fiscalAmount(row.netRevenue),
      fiscalAmount(c.withoutOffer.rows[i].netRevenue),
      fiscalAmount(c.withOffer.rows[i].netRevenue),
      fiscalAmount(c.incremental.withOffer.rows[i].netRevenue),
    ]),
    inputRows: FISCAL_COEFFICIENT_KEYS.map((key) => [
      fiscalParameterLabels[key],
      String(c.assumptions.baseline[key]),
      String(c.assumptions.proposal[key]),
    ]),
  }));
  return { ...profile, resolution, cases, context, summaryRows, panels };
}

export function requireFiscalReport(snapshot: ReportSnapshot) {
  const result = fiscalReportInventory(snapshot);
  if (!result)
    throw new ApiError(
      422,
      "FISCAL_STUDY_REQUIRED",
      "Create and save a reviewed fiscal study before exporting its annual cash flows.",
    );
  return result;
}

export function assertFiscalDocumentLimit(snapshot: ReportSnapshot) {
  if (
    snapshot.project.fiscalStudy &&
    JSON.stringify({
      profile: snapshot.project.fiscalStudy,
      controls: snapshot.scenario.fiscal,
    }).length > 120_000
  )
    throw new ApiError(
      413,
      "FISCAL_REPORT_TOO_LARGE",
      "This fiscal evidence pack exceeds the document appendix limit. Export its complete CSV, workbook or project records; no sources or cases have been omitted.",
    );
}
