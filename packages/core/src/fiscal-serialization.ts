import type { FiscalStudy, FiscalResolution, Scenario } from "./index";

export const FISCAL_REPORT_DISCLOSURE =
  "Fiscal planning comparison in constant USD. The no-offer alternative assumes the same development; it does not predict whether incentives cause development. A profile review is a user attestation, not external validation. Named sensitivity cases are explicit assumption choices, not probabilities or confidence intervals. Missing quantities remain unknown. All values belong to the retained study and scenario revision.";
export const FISCAL_CLOCK_DISCLOSURE =
  "The operating period starts at the selected scenario horizon. Present values discount to that start, not automatically to today. The grant is paid at time zero; recurring cash flows arrive at year end. Assessed value is held constant. Abatement applies to positive added assessed value using the proposal's valuation assumptions. Average allocated service costs are not automatically marginal development costs.";

export const FISCAL_ALTERNATIVES = [
  ["baseline", "Frozen baseline"],
  ["withoutOffer", "Development without offer"],
  ["withOffer", "Development with offer"],
] as const;

const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet programs execute formulas even when a cell was correctly CSV-quoted.
  if (
    typeof value !== "number" &&
    (/^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))
  )
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

/** Typed complete ledger; source permissions and frozen-input matching are enforced by callers. */
export function fiscalCashFlowCSV(
  study: FiscalStudy,
  scenario: Scenario,
  resolution: FiscalResolution,
) {
  const fiscal = {
    study,
    profile: study.profile,
    resolution,
    cases: [...(resolution.base ? [resolution.base] : []), ...resolution.cases],
  };
  const headers = [
    "record_type",
    "scenario_id",
    "scenario_revision",
    "profile_sha256",
    "method_version",
    "input_sha256",
    "case_id",
    "case_name",
    "alternative",
    "year_zero_is_upfront",
    "fiscal_year",
    "dollar_year",
    "property_revenue_usd",
    "sales_revenue_usd",
    "service_cost_usd",
    "abatement_cost_usd",
    "grant_cost_usd",
    "net_revenue_usd",
    "discounted_net_usd",
    "status",
    "payback_status",
    "payback_year",
    "details_json",
  ];
  const identity = [
    scenario.id,
    scenario.revision,
    fiscal.study.profileHash,
    fiscal.resolution.methodVersion,
    fiscal.resolution.inputHash,
  ];
  const rows: unknown[][] = [
    [
      "study",
      ...identity,
      "",
      "",
      "",
      "",
      "",
      fiscal.profile.dollarYear,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      fiscal.resolution.status,
      "",
      "",
      JSON.stringify({
        study: fiscal.study,
        controls: scenario.fiscal,
        clock: fiscal.resolution.clock,
        reviewState: fiscal.resolution.reviewState,
        deviations: fiscal.resolution.deviations,
        notes: fiscal.resolution.notes,
        interpretation: FISCAL_REPORT_DISCLOSURE,
        cashFlowClock: FISCAL_CLOCK_DISCLOSURE,
      }),
    ],
  ];
  for (const c of fiscal.cases) {
    rows.push([
      "case",
      ...identity,
      c.id,
      c.name,
      "",
      "",
      "",
      fiscal.profile.dollarYear,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      c.status,
      c.payback.status,
      c.payback.year,
      JSON.stringify({
        description: c.description,
        sourceIds: c.sourceIds,
        assumptions: c.assumptions,
        offerCost: c.offerCost,
      }),
    ]);
    for (const [key, label] of FISCAL_ALTERNATIVES) {
      const t = c[key].totals;
      rows.push([
        "total",
        ...identity,
        c.id,
        c.name,
        label,
        "",
        "",
        fiscal.profile.dollarYear,
        t.propertyRevenue,
        t.salesRevenue,
        t.serviceCost,
        t.abatementCost,
        t.grantCost,
        t.netRevenue,
        t.npv,
        c.status,
        "",
        "",
        JSON.stringify({ missingBuildingIds: c[key].missingBuildingIds }),
      ]);
      for (const row of c[key].rows)
        rows.push([
          "annual",
          ...identity,
          c.id,
          c.name,
          label,
          row.year,
          row.fiscalYear,
          fiscal.profile.dollarYear,
          row.propertyRevenue,
          row.salesRevenue,
          row.serviceCost,
          row.abatementCost,
          row.grantCost,
          row.netRevenue,
          row.discountedNet,
          c.status,
          "",
          "",
          "",
        ]);
    }
    for (const key of ["withoutOffer", "withOffer"] as const) {
      const label =
        key === "withOffer"
          ? "Incremental with offer"
          : "Incremental without offer";
      rows.push([
        "total",
        ...identity,
        c.id,
        c.name,
        label,
        "",
        "",
        fiscal.profile.dollarYear,
        "",
        "",
        "",
        "",
        "",
        c.incremental[key].netRevenue,
        c.incremental[key].npv,
        c.status,
        key === "withOffer" ? c.payback.status : "",
        key === "withOffer" ? c.payback.year : "",
        "",
      ]);
      for (const row of c.incremental[key].rows)
        rows.push([
          "annual",
          ...identity,
          c.id,
          c.name,
          label,
          row.year,
          row.fiscalYear,
          fiscal.profile.dollarYear,
          row.propertyRevenue,
          row.salesRevenue,
          row.serviceCost,
          row.abatementCost,
          row.grantCost,
          row.netRevenue,
          row.discountedNet,
          c.status,
          "",
          "",
          "",
        ]);
    }
  }
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
