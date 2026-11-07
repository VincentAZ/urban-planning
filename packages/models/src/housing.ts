import {
  HOUSING_AFFORDABILITY_METHOD_VERSION,
  HOUSING_INCOME_LIMIT_KEYS,
  housingAffordabilityScenarioSchema,
  housingAffordabilityReviewInputHash,
  housingAffordabilityResolutionInputHash,
  housingIncomeLimitPackSchema,
  housingContentHash,
  materializeBuildings,
  type Building,
  type Place,
  type Scenario,
  type HousingIncomeLimitCatalog,
  type HousingIncomeLimitPack,
  type HousingCostGroup,
  type HousingAffordabilityRow,
  type HousingAffordabilitySide,
  type HousingAffordabilityResolution,
  type HousingIncomeLimitKey,
} from "@urban/core";

export const HOUSING_AFFORDABILITY_DISCLOSURE =
  "Housing cost screening at each group's declared household size and published HUD Section 8 income limits. These adjusted limits are not literal percentages of area median income. A home affordable at a limit is not necessarily affordable to every household below it. This is not household cost-burden measurement, subsidy eligibility, LIHTC/HOME rent compliance, a housing-need estimate or a price forecast.";
export const HOUSING_AFFORDABILITY_CLOCK =
  "Costs and published income limits must use the same declared dollar year. No automatic inflation, rent growth, mortgage financing or horizon extrapolation is applied. Separate rental and ownership assumptions include only stated recurring costs; maintenance, transaction costs and access to a down payment are not inferred.";
const flags = (
  value: boolean | null,
): Record<HousingIncomeLimitKey, boolean | null> => ({
  extremelyLow: value,
  veryLow: value,
  low: value,
});
const counts = () => ({
  extremelyLow: { estimate: null, knownSubtotal: 0 },
  veryLow: { estimate: null, knownSubtotal: 0 },
  low: { estimate: null, knownSubtotal: 0 },
});
function emptySide(buildings: Building[]): HousingAffordabilitySide {
  const knownUnits = buildings.reduce((sum, b) => sum + (b.units ?? 0), 0),
    unknownUnitBuildingIds = buildings
      .filter((b) => b.units === null)
      .map((b) => b.id)
      .sort();
  return {
    totalUnits: unknownUnitBuildingIds.length ? null : knownUnits,
    knownUnits,
    assignedUnits: 0,
    evaluatedUnits: 0,
    unassignedUnits: knownUnits,
    unresolvedAssignedUnits: 0,
    unknownUnitBuildingIds,
    staleGroupIds: [],
    cumulative: counts(),
    bands: { ...counts(), "above-low": { estimate: null, knownSubtotal: 0 } },
    rows: [],
  };
}
function resolveSide(
  buildings: Building[],
  groups: HousingCostGroup[],
  packs: Map<string, HousingIncomeLimitPack>,
  reviewCurrent: boolean,
  mixedYears: boolean,
): HousingAffordabilitySide {
  const side = emptySide(buildings),
    byId = new Map(buildings.map((b) => [b.id, b]));
  const grouped = new Map<
    string,
    {
      units: number;
      components: Map<string, number>;
      whole: boolean;
      component: boolean;
    }
  >();
  for (const g of groups) {
    let stats = grouped.get(g.buildingId);
    if (!stats) {
      stats = {
        units: 0,
        components: new Map(),
        whole: false,
        component: false,
      };
      grouped.set(g.buildingId, stats);
    }
    stats.units += g.units;
    if (g.componentId === undefined) stats.whole = true;
    else {
      stats.component = true;
      stats.components.set(
        g.componentId,
        (stats.components.get(g.componentId) ?? 0) + g.units,
      );
    }
  }
  for (const group of groups) {
    const b = byId.get(group.buildingId),
      siblings = grouped.get(group.buildingId)!,
      reasons: string[] = [];
    let assignmentValid = true;
    if (!b) {
      reasons.push("Referenced building no longer exists on this side.");
      assignmentValid = false;
    } else if (b.units === null) {
      reasons.push("Building dwelling-unit capacity is unknown.");
      assignmentValid = false;
    } else if (siblings.units > b.units) {
      reasons.push(
        "Assigned groups exceed this building's dwelling-unit capacity.",
      );
      assignmentValid = false;
    }
    if (siblings.component && siblings.whole) {
      reasons.push(
        "Whole-building and component assignments cannot be mixed within one building.",
      );
      assignmentValid = false;
    }
    if (group.componentId !== undefined) {
      const component = b?.program?.components.find(
        (c) => c.id === group.componentId,
      );
      if (!component) {
        reasons.push(
          "Referenced residential program component is unavailable.",
        );
        assignmentValid = false;
      } else if (
        (siblings.components.get(group.componentId) ?? 0) > component.units
      ) {
        reasons.push(
          "Assigned groups exceed this component's dwelling-unit capacity.",
        );
        assignmentValid = false;
      }
    }
    if (assignmentValid) side.assignedUnits += group.units;
    const pack = packs.get(group.areaHash),
      threshold = pack?.limits.find(
        (l) => l.householdSize === group.householdSize,
      );
    if (!pack || !threshold)
      reasons.push(
        "The exact retained income-limit pack is missing or invalid.",
      );
    else if (pack.fiscalYear !== group.costYear)
      reasons.push(
        "Housing costs and income limits have different dollar years.",
      );
    if (mixedYears)
      reasons.push(
        "The comparison contains different dollar years; a common year is required.",
      );
    if (!reviewCurrent)
      reasons.push(
        "The reviewed building/program/geography/cost assignment is stale; review it again.",
      );
    const missingCostKinds = group.costs
      .filter((c) => c.state === "unknown")
      .map((c) => c.kind);
    const knownMonthlyCents = group.costs.reduce(
      (n, c) => n + (c.state === "separate" ? c.monthlyCents : 0),
      0,
    );
    if (missingCostKinds.length)
      reasons.push(
        "One or more required recurring cost components are unknown.",
      );
    const grossMonthlyCents = missingCostKinds.length
      ? null
      : knownMonthlyCents;
    const ready = reasons.length === 0;
    const affordableAt = flags(null);
    if (ready && threshold && grossMonthlyCents !== null)
      for (const key of HOUSING_INCOME_LIMIT_KEYS)
        affordableAt[key] = grossMonthlyCents * 2 <= threshold[key] * 5;
    const minimumBand = ready
      ? (HOUSING_INCOME_LIMIT_KEYS.find((key) => affordableAt[key]) ??
        "above-low")
      : null;
    const row: HousingAffordabilityRow = {
      groupId: group.id,
      buildingId: group.buildingId,
      ...(group.componentId ? { componentId: group.componentId } : {}),
      units: group.units,
      tenure: group.tenure,
      householdSize: group.householdSize,
      areaHash: group.areaHash,
      areaOrigin: group.areaOrigin,
      areaName: pack?.area.name ?? null,
      fiscalYear: pack?.fiscalYear ?? null,
      costYear: group.costYear,
      status:
        !assignmentValid || !reviewCurrent
          ? "stale"
          : ready
            ? "ready"
            : "incomplete",
      grossMonthlyCents,
      knownMonthlyCents,
      requiredAnnualIncome:
        grossMonthlyCents === null ? null : (grossMonthlyCents * 2) / 5,
      limits: threshold
        ? {
            extremelyLow: threshold.extremelyLow,
            veryLow: threshold.veryLow,
            low: threshold.low,
          }
        : null,
      affordableAt,
      minimumBand,
      missingCostKinds,
      reasons,
      sourceIds: [
        ...new Set(group.costs.flatMap((c) => c.provenance.sourceIds)),
      ],
    };
    side.rows.push(row);
    if (row.status === "stale") side.staleGroupIds.push(group.id);
    if (ready) {
      side.evaluatedUnits += group.units;
      for (const key of HOUSING_INCOME_LIMIT_KEYS)
        if (affordableAt[key])
          side.cumulative[key].knownSubtotal += group.units;
      side.bands[minimumBand!].knownSubtotal += group.units;
    }
  }
  side.unassignedUnits = side.knownUnits - side.assignedUnits;
  side.unresolvedAssignedUnits = side.assignedUnits - side.evaluatedUnits;
  const complete =
    reviewCurrent &&
    !mixedYears &&
    side.totalUnits !== null &&
    side.unassignedUnits === 0 &&
    side.unresolvedAssignedUnits === 0 &&
    side.staleGroupIds.length === 0;
  if (complete)
    for (const count of [
      ...Object.values(side.cumulative),
      ...Object.values(side.bands),
    ])
      count.estimate = count.knownSubtotal;
  return side;
}

export function resolveHousingAffordability(
  place: Place,
  scenario: Scenario,
  context: { housingIncomeLimits?: HousingIncomeLimitCatalog } = {},
): HousingAffordabilityResolution {
  const buildings = materializeBuildings(place, scenario),
    a = scenario.affordability;
  const result: HousingAffordabilityResolution = {
    methodVersion: HOUSING_AFFORDABILITY_METHOD_VERSION,
    scenarioId: scenario.id,
    scenarioRevision: scenario.revision,
    inputHash: housingAffordabilityResolutionInputHash(
      place,
      scenario,
      context.housingIncomeLimits,
    ),
    status: "unavailable",
    reviewState: a ? "invalid" : "missing",
    baseline: emptySide(place.buildings),
    proposal: emptySide(buildings),
    delta: { extremelyLow: null, veryLow: null, low: null },
    notes: [HOUSING_AFFORDABILITY_DISCLOSURE, HOUSING_AFFORDABILITY_CLOCK],
  };
  if (!a) {
    result.notes.push("No reviewed housing cost groups have been supplied.");
    return result;
  }
  const parsed = housingAffordabilityScenarioSchema.safeParse(a);
  if (!parsed.success) {
    result.notes.push(
      "Housing cost evidence is malformed; no classification was calculated.",
    );
    return result;
  }
  const reviewCurrent =
    a.review.inputHash ===
    housingAffordabilityReviewInputHash(place, scenario, a);
  result.reviewState = reviewCurrent ? "current" : "stale";
  const packs = new Map<string, HousingIncomeLimitPack>();
  for (const key of new Set(
    [...a.baselineGroups, ...a.proposalGroups].map((g) => g.areaHash),
  )) {
    const p = context.housingIncomeLimits?.[key];
    if (
      p &&
      housingIncomeLimitPackSchema.safeParse(p).success &&
      housingContentHash(p) === key
    )
      packs.set(key, p);
  }
  const mixedYears =
    new Set([...a.baselineGroups, ...a.proposalGroups].map((g) => g.costYear))
      .size > 1;
  result.baseline = resolveSide(
    place.buildings,
    a.baselineGroups,
    packs,
    reviewCurrent,
    mixedYears,
  );
  result.proposal = resolveSide(
    buildings,
    a.proposalGroups,
    packs,
    reviewCurrent,
    mixedYears,
  );
  result.status =
    !reviewCurrent ||
    result.baseline.staleGroupIds.length ||
    result.proposal.staleGroupIds.length
      ? "stale"
      : result.baseline.cumulative.low.estimate !== null &&
          result.proposal.cumulative.low.estimate !== null
        ? "ready"
        : "incomplete";
  for (const key of HOUSING_INCOME_LIMIT_KEYS) {
    const old = result.baseline.cumulative[key].estimate,
      next = result.proposal.cumulative[key].estimate;
    result.delta[key] = old !== null && next !== null ? next - old : null;
  }
  result.notes.push(
    "Groups are mutually exclusive authored assignments. Unassigned homes, unknown unit capacities and incomplete cost groups are retained; no average rent is used to classify homes. Household size is explicitly selected and never inferred from bedrooms. Geography applicability is the user's review, not an automatic boundary determination.",
  );
  if (
    [...a.baselineGroups, ...a.proposalGroups].some(
      (g) => g.areaOrigin === "imported",
    )
  )
    result.notes.push(
      "One or more income-limit inputs were imported; their server-catalog authority is unverified. Source citation and content hashes do not independently establish official authenticity.",
    );
  if (!reviewCurrent)
    result.notes.push(
      "Building capacity, program, geometry, sources or cost assignments changed after review; classifications are withheld until reviewed again.",
    );
  return result;
}
