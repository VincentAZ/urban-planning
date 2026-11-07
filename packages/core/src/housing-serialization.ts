import {
  HOUSING_AFFORDABILITY_METHOD_VERSION,
  HOUSING_INCOME_LIMIT_KEYS,
  housingAffordabilityResolutionInputHash,
  housingIncomeLimitPackHash,
  type HousingAffordabilityResolution,
  type HousingCostKind,
  type HousingIncomeLimitCatalog,
  type HousingIncomeLimitKey,
} from "./housing";
import type { ModelResults, Place, Scenario } from "./index";

export const HOUSING_REPORT_DISCLOSURE =
  "Housing-cost comparison at 30% of gross household income. Published HUD Section 8 limits include adjustments and are not simple percentages of area median income. A home affordable at a category's income ceiling may be unaffordable to households below that ceiling. This is not a housing-program eligibility, LIHTC compliance, observed cost-burden or housing-demand determination. Household size is explicitly entered; bedrooms do not determine it. Costs and income limits must use the same year. No automatic inflation or future income-limit prediction is applied.";
export const housingLimitLabels: Record<HousingIncomeLimitKey, string> = {
  extremelyLow: "Extremely low income ceiling",
  veryLow: "Very low income ceiling",
  low: "Low income ceiling",
};
export const housingCostLabels: Record<HousingCostKind, string> = {
  rent: "Rent",
  utilities: "Utilities",
  "mandatory-fees": "Other mandatory housing fees",
  "loan-payment": "Loan payment",
  "property-tax": "Property tax",
  "property-insurance": "Property insurance",
  "flood-insurance": "Flood insurance",
  "mortgage-insurance": "Mortgage insurance",
  "association-fees": "Association / condominium fees",
  "ground-rent": "Ground rent",
};
export const housingAmount = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);
const count = (value: number | null) =>
  value === null ? "Unavailable" : String(value);

/** Consume the exact frozen bundle, including incomplete/stale states; never recompute it. */
export function housingExportInventory(
  place: Place,
  scenario: Scenario,
  results: ModelResults,
  catalog?: HousingIncomeLimitCatalog,
) {
  const controls = scenario.affordability,
    resolution = results.affordability;
  if (!controls && !resolution) return null;
  const packs: HousingIncomeLimitCatalog = {};
  for (const group of [
    ...(controls?.baselineGroups ?? []),
    ...(controls?.proposalGroups ?? []),
  ]) {
    const pack = catalog?.[group.areaHash];
    if (!pack || housingIncomeLimitPackHash(pack) !== group.areaHash)
      throw new Error(
        "The housing export requires every matching retained income-limit pack.",
      );
    packs[group.areaHash] = pack;
  }
  if (
    !controls ||
    !resolution ||
    resolution.methodVersion !== HOUSING_AFFORDABILITY_METHOD_VERSION ||
    resolution.scenarioId !== scenario.id ||
    resolution.scenarioRevision !== scenario.revision ||
    results.scenarioId !== scenario.id ||
    results.revision !== scenario.revision ||
    resolution.inputHash !==
      housingAffordabilityResolutionInputHash(place, scenario, packs)
  )
    throw new Error(
      "The housing export needs its matching frozen costs, income limits and results. Wait for this revision to finish calculating before exporting.",
    );
  const summaryRows = HOUSING_INCOME_LIMIT_KEYS.map((key) => [
    housingLimitLabels[key],
    count(resolution.baseline.cumulative[key].estimate),
    count(resolution.proposal.cumulative[key].estimate),
    count(resolution.delta[key]),
    `${resolution.baseline.cumulative[key].knownSubtotal} / ${resolution.proposal.cumulative[key].knownSubtotal}`,
  ]);
  const bandRows = ([...HOUSING_INCOME_LIMIT_KEYS, "above-low"] as const).map(
    (key) => [
      key === "above-low"
        ? "Above the low income ceiling"
        : housingLimitLabels[key],
      count(resolution.baseline.bands[key].estimate),
      count(resolution.proposal.bands[key].estimate),
      `${resolution.baseline.bands[key].knownSubtotal} / ${resolution.proposal.bands[key].knownSubtotal}`,
    ],
  );
  const coverageRows = (["baseline", "proposal"] as const).map((side) => {
    const s = resolution[side];
    return [
      side === "baseline" ? "Baseline" : "Proposal",
      count(s.totalUnits),
      String(s.evaluatedUnits),
      String(s.unassignedUnits),
      String(s.unresolvedAssignedUnits),
      String(s.unknownUnitBuildingIds.length),
    ];
  });
  const panels = (["baseline", "proposal"] as const).flatMap((side) =>
    resolution[side].rows.map((row) => {
      const group = controls[
        side === "baseline" ? "baselineGroups" : "proposalGroups"
      ].find((g) => g.id === row.groupId);
      if (!group)
        throw new Error(
          "The frozen housing result contains a group missing from its retained inputs.",
        );
      const pack = packs[group.areaHash];
      return {
        side,
        row,
        group,
        pack,
        title: `${side === "baseline" ? "Baseline" : "Proposal"} · ${group.id}`,
        context: [
          `Building ${group.buildingId}${group.componentId ? `; program component ${group.componentId}` : ""}. ${group.units} homes; ${group.tenure === "rent" ? "rental" : "ownership"}; household size ${group.householdSize}${group.bedrooms === undefined ? "" : `; ${group.bedrooms} bedrooms (descriptive only)`}. Cost year ${group.costYear}.`,
          `${pack.area.name}; ${pack.area.id}; HUD Section 8 FY ${pack.fiscalYear}, effective ${pack.effectiveDate}. ${group.areaOrigin === "server-catalog" ? "Retained server-catalog source" : "Imported income limits; source contents not independently verified"}. Geographic applicability is user-reviewed.`,
          `Status ${row.status}. Complete monthly housing cost ${housingAmount(row.grossMonthlyCents === null ? null : row.grossMonthlyCents / 100)}; known separate costs ${housingAmount(row.knownMonthlyCents / 100)}. Required annual income ${housingAmount(row.requiredAnnualIncome)}.`,
          ...row.reasons,
          ...(group.notes ? [group.notes] : []),
          `Income-limit pack SHA-256 ${group.areaHash}.`,
        ],
        costRows: group.costs.map((c) => [
          housingCostLabels[c.kind],
          c.state === "separate"
            ? housingAmount(c.monthlyCents / 100)
            : c.state === "included"
              ? `Included in ${housingCostLabels[group.costs.find((t) => t.id === c.includedIn)!.kind]}`
              : c.state === "not-applicable"
                ? "Not applicable"
                : "Unknown",
          `${c.provenance.kind}: ${c.provenance.description} Sources: ${c.provenance.sourceIds.join(", ") || "Author entry"}.`,
        ]),
        thresholdRows: HOUSING_INCOME_LIMIT_KEYS.map((key) => [
          housingLimitLabels[key],
          housingAmount(row.limits?.[key] ?? null),
          row.affordableAt[key] === null
            ? "Unavailable"
            : row.affordableAt[key]
              ? "Within ceiling"
              : "Above ceiling",
        ]),
      };
    }),
  );
  const context = [
    `Result ${resolution.status}; input review ${resolution.reviewState}. Reviewed by ${controls.review.reviewedBy} on ${controls.review.reviewedAt}: ${controls.review.notes}.`,
    "Cumulative counts overlap; do not add them. The exclusive bands identify the lowest published ceiling that accommodates each complete cost. Unassigned, unknown and stale inputs are not zero-cost homes.",
    ...(["baseline", "proposal"] as const).map(
      (side) =>
        `${side}: known home count ${resolution[side].knownUnits}; assigned ${resolution[side].assignedUnits}; evaluated ${resolution[side].evaluatedUnits}; unassigned ${resolution[side].unassignedUnits}; unresolved assigned ${resolution[side].unresolvedAssignedUnits}. Unknown-unit buildings: ${resolution[side].unknownUnitBuildingIds.join(", ") || "None"}. Stale groups: ${resolution[side].staleGroupIds.join(", ") || "None"}.`,
    ),
    ...resolution.notes,
    `Method ${resolution.methodVersion}; input SHA-256 ${resolution.inputHash}; scenario ${scenario.id}, revision ${scenario.revision}.`,
  ];
  return {
    controls,
    resolution,
    packs,
    summaryRows,
    bandRows,
    coverageRows,
    panels,
    context,
  };
}

const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  if (
    typeof value !== "number" &&
    (/^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
/** Complete typed ledger. Callers enforce frozen-input matching and source permissions. */
export function housingAffordabilityCSV(
  scenario: Scenario,
  resolution: HousingAffordabilityResolution,
  packs: HousingIncomeLimitCatalog,
) {
  const headers = [
    "record_type",
    "scenario_id",
    "scenario_revision",
    "method_version",
    "input_sha256",
    "side",
    "group_id",
    "building_id",
    "component_id",
    "homes",
    "tenure",
    "household_size",
    "cost_year",
    "income_limits_fy",
    "area_sha256",
    "area_origin",
    "status",
    "gross_monthly_usd",
    "known_monthly_usd",
    "required_annual_income_usd",
    "extremely_low_limit_usd",
    "very_low_limit_usd",
    "low_limit_usd",
    "within_extremely_low_ceiling",
    "within_very_low_ceiling",
    "within_low_ceiling",
    "minimum_band",
    "details_json",
  ];
  const identity = {
    scenario_id: scenario.id,
    scenario_revision: scenario.revision,
    method_version: resolution.methodVersion,
    input_sha256: resolution.inputHash,
  };
  const rows: Record<string, unknown>[] = [
    {
      record_type: "comparison",
      ...identity,
      status: resolution.status,
      details_json: JSON.stringify({
        controls: scenario.affordability,
        notes: resolution.notes,
        reviewState: resolution.reviewState,
        delta: resolution.delta,
        interpretation: HOUSING_REPORT_DISCLOSURE,
      }),
    },
  ];
  for (const [hash, pack] of Object.entries(packs))
    rows.push({
      record_type: "income-limit-pack",
      ...identity,
      area_sha256: hash,
      income_limits_fy: pack.fiscalYear,
      details_json: JSON.stringify(pack),
    });
  for (const side of ["baseline", "proposal"] as const) {
    const { rows: groupRows, ...totals } = resolution[side];
    rows.push({
      record_type: "reconciliation",
      ...identity,
      side,
      details_json: JSON.stringify(totals),
    });
    for (const row of groupRows) {
      const group = scenario.affordability?.[
        side === "baseline" ? "baselineGroups" : "proposalGroups"
      ].find((g) => g.id === row.groupId);
      rows.push({
        record_type: "cost-group",
        ...identity,
        side,
        group_id: row.groupId,
        building_id: row.buildingId,
        component_id: row.componentId,
        homes: row.units,
        tenure: row.tenure,
        household_size: row.householdSize,
        cost_year: row.costYear,
        income_limits_fy: row.fiscalYear,
        area_sha256: row.areaHash,
        area_origin: group?.areaOrigin,
        status: row.status,
        gross_monthly_usd:
          row.grossMonthlyCents === null ? null : row.grossMonthlyCents / 100,
        known_monthly_usd: row.knownMonthlyCents / 100,
        required_annual_income_usd: row.requiredAnnualIncome,
        extremely_low_limit_usd: row.limits?.extremelyLow,
        very_low_limit_usd: row.limits?.veryLow,
        low_limit_usd: row.limits?.low,
        within_extremely_low_ceiling: row.affordableAt.extremelyLow,
        within_very_low_ceiling: row.affordableAt.veryLow,
        within_low_ceiling: row.affordableAt.low,
        minimum_band: row.minimumBand,
        details_json: JSON.stringify({ group, result: row }),
      });
    }
  }
  return (
    "\uFEFF" +
    [headers, ...rows.map((row) => headers.map((key) => row[key]))]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n") +
    "\r\n"
  );
}
