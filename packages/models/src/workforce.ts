import {
  WORKFORCE_ALLOCATION_TOLERANCE,
  WORKFORCE_PANELS,
  WORKFORCE_THRESHOLDS,
  verifyWorkforceRun,
  workforceContentHash,
  type CensusValueStatus,
  type WorkforceCohortPack,
  type WorkforceNetwork,
  type WorkforceRequest,
  type WorkforceRouteStatus,
  type WorkforceRoutingRun,
} from "@urban/core";

/** Independent experimental module; does not alter the existing impact model. */
export const WORKFORCE_METHOD_VERSION = "workforce-1.0.2";
export interface WorkforceCount {
  estimate: number | null;
  knownSubtotal: number | null;
  marginOfError90: number | null;
  knownSubtotalMarginOfError90: number | null;
  status: "complete" | "partial" | "unavailable";
  missingUnitGeoids: string[];
  suppressedUnitGeoids: string[];
  /** Retains the distinction between missing, suppressed and other source states. */
  sourceIssues: { geoid: string; cell: string; status: CensusValueStatus }[];
  unresolvedAllocationUnitGeoids: string[];
  /** Unknown reachable shares prevent propagation of full-shed sampling uncertainty. */
  unresolvedAllocationMoeUnitGeoids: string[];
  /** Unusable source MOEs among cells with an explicitly known routed share. */
  missingMoeUnitGeoids: string[];
  geographicallyPartialUnitCount: number;
}
export interface WorkforceThresholdResult {
  minutes: 15 | 30 | 45;
  total: WorkforceCount;
  categories: (WorkforceCount & {
    id: string;
    label: string;
    sourceCells: string[];
  })[];
}
export interface WorkforcePanelResult {
  id: "education" | "occupation";
  label: string;
  universe: string;
  table: "B15003" | "C24010";
  thresholds: WorkforceThresholdResult[];
}
export interface WorkforceResolution {
  version: 1;
  methodVersion: typeof WORKFORCE_METHOD_VERSION;
  cohortPackHash: string;
  routingRunHash: string;
  inputHash: string;
  capturedAt: string;
  request: WorkforceRequest;
  network: WorkforceNetwork;
  sourceIds: string[];
  panels: WorkforcePanelResult[];
  coverage: {
    regionDataComplete: boolean;
    network: WorkforceNetwork["coverage"];
    cohort: WorkforceRoutingRun["cohortCoverage"];
    nativeUnits: number;
    allocationCompleteUnits: number;
    allocationIncompleteUnits: number;
    allocationUnavailableUnits: number;
    origins: number;
    unallocatedOriginCount: number;
    unallocatedPopulation2020: number;
    ambiguousAffectedUnitCount: number;
    routeStatusCounts: Record<WorkforceRouteStatus, number>;
    /** All retained population, including ambiguous original blocks exactly once. */
    allocationPopulation2020: number;
    /** Unknown routes among regular origins only; excludes ambiguous unallocated records. */
    unroutedAllocationPopulation2020: number;
  };
  allocationMethod: "2020-block-population";
  uncertainty: {
    sampling: "approximate-90-percent-conditional";
    formula: string;
    includesSpatialAllocationError: false;
    includesRoutingError: false;
  };
  notes: string[];
}
interface UnitReachability {
  fractions: [number, number, number];
  partiallyReached: [boolean, boolean, boolean];
  unresolved: boolean;
}
/** Compensated sums make order-dependent floating point drift negligible. */
function sum(values: Iterable<number>): number {
  let total = 0,
    correction = 0;
  for (const value of values) {
    const next = value - correction,
      updated = total + next;
    correction = updated - total - next;
    total = updated;
  }
  return total;
}
function boundedWeight(value: number): number {
  // Clamp roundoff outside the interval only; a tiny genuine share must survive.
  if (value < 0 && value >= -WORKFORCE_ALLOCATION_TOLERANCE) return 0;
  if (value > 1 && value <= 1 + WORKFORCE_ALLOCATION_TOLERANCE) return 1;
  return value;
}
function reachability(
  pack: WorkforceCohortPack,
  run: WorkforceRoutingRun,
): Map<string, UnitReachability> {
  const routes = new Map(run.rows.map((r) => [r.id, r]));
  const groups = new Map<string, typeof pack.origins>();
  for (const origin of pack.origins) {
    const group = groups.get(origin.unitGeoid) ?? [];
    group.push(origin);
    groups.set(origin.unitGeoid, group);
  }
  return new Map(
    pack.units.map((unit) => {
      const origins = groups.get(unit.geoid) ?? [];
      const unresolved =
        unit.allocationStatus !== "complete" ||
        origins.some(
          (o) =>
            o.weight > 0 &&
            !["reachable", "unreachable", "outside-threshold"].includes(
              routes.get(o.id)!.status,
            ),
        );
      const fractions = WORKFORCE_THRESHOLDS.map((minutes) =>
        boundedWeight(
          sum(
            origins.map((o) => {
              const row = routes.get(o.id)!;
              return row.status === "reachable" && row.seconds! <= minutes * 60
                ? o.weight
                : 0;
            }),
          ),
        ),
      ) as [number, number, number];
      // Membership is exact even when a complete set of normalized weights sums
      // to 1 minus a floating-point ulp. Do not round fractions: a genuinely tiny
      // excluded origin must still make the unit geographically partial.
      const positiveOrigins = origins.filter((origin) => origin.weight > 0);
      const partiallyReached = WORKFORCE_THRESHOLDS.map((minutes) => {
        const reached = (origin: (typeof origins)[number]) => {
          const row = routes.get(origin.id)!;
          return row.status === "reachable" && row.seconds! <= minutes * 60;
        };
        const fullyReached =
          unit.allocationStatus === "complete" &&
          positiveOrigins.every(reached);
        return positiveOrigins.some(reached) && !fullyReached;
      }) as [boolean, boolean, boolean];
      return [unit.geoid, { fractions, partiallyReached, unresolved }];
    }),
  );
}
const usable = (status: CensusValueStatus) =>
  status === "available" || status === "controlled";
function aggregate(
  pack: WorkforceCohortPack,
  units: Map<string, UnitReachability>,
  panel: "education" | "occupation",
  cells: readonly string[],
  thresholdIndex: number,
  globalCoverageComplete: boolean,
): WorkforceCount {
  const contributions: number[] = [],
    varianceTerms: number[] = [];
  const missing = new Set<string>(),
    suppressed = new Set<string>(),
    allocation = new Set<string>(),
    allocationMoe = new Set<string>(),
    missingMoe = new Set<string>();
  const sourceIssues: WorkforceCount["sourceIssues"] = [];
  let hasKnownTerm = false,
    incomplete = !globalCoverageComplete,
    partialUnits = 0,
    knownMoeComplete = true;
  for (const unit of pack.units) {
    const reach = units.get(unit.geoid)!,
      fraction = reach.fractions[thresholdIndex];
    // A proven zero reachable share contributes zero even if an irrelevant native cell is absent.
    if (fraction === 0 && !reach.unresolved) {
      hasKnownTerm = true;
      continue;
    }
    if (reach.partiallyReached[thresholdIndex]) partialUnits++;
    const rows = cells.map((id) => ({ id, ...unit[panel][id] }));
    const known = rows.filter((r) => usable(r.estimate.status));
    const value =
      known.length === rows.length
        ? sum(known.map((r) => r.estimate.value!))
        : null;
    if (reach.unresolved) {
      allocation.add(unit.geoid);
      // A published zero is still a usable point estimate. Its unknown spatial
      // share must not erase a positive source MOE or contaminate the conditional
      // margin of the separately known routed shares.
      if (value === 0) hasKnownTerm = true;
      else incomplete = true;
      if (
        rows.some(
          (r) => !usable(r.marginOfError.status) || r.marginOfError.value !== 0,
        )
      )
        allocationMoe.add(unit.geoid);
    }
    for (const row of rows) {
      if (!usable(row.estimate.status)) {
        incomplete = true;
        (row.estimate.status === "suppressed" ? suppressed : missing).add(
          unit.geoid,
        );
        sourceIssues.push({
          geoid: unit.geoid,
          cell: row.id,
          status: row.estimate.status,
        });
      }
    }
    if (fraction > 0 && known.length) {
      hasKnownTerm = true;
      contributions.push(fraction * sum(known.map((r) => r.estimate.value!)));
      // First combine native source cells, THEN scale once by the whole-unit reachable share.
      // Treating allocated blocks as independent observations would understate uncertainty.
      if (known.every((r) => usable(r.marginOfError.status))) {
        varianceTerms.push(
          fraction ** 2 * sum(known.map((r) => r.marginOfError.value! ** 2)),
        );
      } else {
        knownMoeComplete = false;
        missingMoe.add(unit.geoid);
      }
    }
  }
  const subtotal = hasKnownTerm ? sum(contributions) : null;
  const subtotalMoe =
    hasKnownTerm && knownMoeComplete ? Math.sqrt(sum(varianceTerms)) : null;
  const estimate = incomplete ? null : subtotal;
  return {
    estimate,
    knownSubtotal: subtotal,
    marginOfError90:
      estimate !== null && allocationMoe.size === 0 ? subtotalMoe : null,
    knownSubtotalMarginOfError90: subtotalMoe,
    status:
      estimate !== null
        ? "complete"
        : subtotal !== null
          ? "partial"
          : "unavailable",
    missingUnitGeoids: [...missing].sort(),
    suppressedUnitGeoids: [...suppressed].sort(),
    sourceIssues,
    unresolvedAllocationUnitGeoids: [...allocation].sort(),
    unresolvedAllocationMoeUnitGeoids: [...allocationMoe].sort(),
    missingMoeUnitGeoids: [...missingMoe].sort(),
    geographicallyPartialUnitCount: partialUnits,
  };
}

/** Verify retained input identities before producing a deterministic, source-unit aggregation. */
export async function resolveWorkforce(
  pack: WorkforceCohortPack,
  run: WorkforceRoutingRun,
): Promise<WorkforceResolution> {
  // Capture before the first await: a caller cannot mutate data between hashing
  // and aggregation to produce results for a different payload under an old hash.
  pack = structuredClone(pack);
  run = structuredClone(run);
  await verifyWorkforceRun(pack, run);
  const units = reachability(pack, run);
  const complete =
    pack.region.complete &&
    run.network.coverage === "complete" &&
    run.cohortCoverage.status === "complete";
  const statuses: Record<WorkforceRouteStatus, number> = {
    reachable: 0,
    unreachable: 0,
    "outside-threshold": 0,
    unsnappable: 0,
    "outside-coverage": 0,
    unavailable: 0,
  };
  const routes = new Map(
    run.rows.map((r) => {
      statuses[r.status]++;
      return [r.id, r];
    }),
  );
  return {
    version: 1,
    methodVersion: WORKFORCE_METHOD_VERSION,
    cohortPackHash: run.cohortPackHash,
    routingRunHash: await workforceContentHash(run),
    inputHash: run.inputHash,
    capturedAt: run.createdAt,
    request: structuredClone(run.request),
    network: structuredClone(run.network),
    sourceIds: pack.sources.map((s) => s.id),
    panels: (["education", "occupation"] as const).map((id) => {
      const definition = WORKFORCE_PANELS[id];
      return {
        id,
        label: definition.label,
        universe: definition.universe,
        table: definition.table,
        thresholds: WORKFORCE_THRESHOLDS.map((minutes, i) => ({
          minutes,
          total: aggregate(
            pack,
            units,
            id,
            [definition.totalCell],
            i,
            complete,
          ),
          categories: definition.categories.map((category) => ({
            id: category.id,
            label: category.label,
            sourceCells: [...category.cells],
            ...aggregate(pack, units, id, category.cells, i, complete),
          })),
        })),
      };
    }),
    coverage: {
      regionDataComplete: pack.region.complete,
      network: run.network.coverage,
      cohort: structuredClone(run.cohortCoverage),
      nativeUnits: pack.units.length,
      allocationCompleteUnits: pack.units.filter(
        (u) => u.allocationStatus === "complete",
      ).length,
      allocationIncompleteUnits: pack.units.filter(
        (u) => u.allocationStatus === "incomplete",
      ).length,
      allocationUnavailableUnits: pack.units.filter(
        (u) => u.allocationStatus === "unavailable",
      ).length,
      origins: pack.origins.length,
      unallocatedOriginCount: pack.unallocatedOrigins.length,
      unallocatedPopulation2020: sum(
        pack.unallocatedOrigins.map((o) => o.population2020),
      ),
      ambiguousAffectedUnitCount: new Set(
        pack.unallocatedOrigins
          .filter((o) => o.population2020 > 0)
          .flatMap((o) => o.candidateUnitGeoids),
      ).size,
      routeStatusCounts: statuses,
      allocationPopulation2020: sum(
        [...pack.origins, ...pack.unallocatedOrigins].map(
          (o) => o.population2020,
        ),
      ),
      unroutedAllocationPopulation2020: sum(
        pack.origins
          .filter(
            (o) =>
              !["reachable", "unreachable", "outside-threshold"].includes(
                routes.get(o.id)!.status,
              ),
          )
          .map((o) => o.population2020),
      ),
    },
    allocationMethod: "2020-block-population",
    uncertainty: {
      sampling: "approximate-90-percent-conditional",
      formula:
        "sqrt(sum over native units of reachableWeight^2 × sum of source-cell MOE^2))",
      includesSpatialAllocationError: false,
      includesRoutingError: false,
    },
    notes: [
      "Education describes residents aged 25+; occupation describes civilian employed residents aged 16+. The panels have different universes and must not be added or interpreted as a joint education-by-occupation table.",
      "Reachability uses inbound elapsed network time from retained Census block internal points to the site. It does not measure applicants, willingness to commute, vacancies, observed commuting patterns or current congestion.",
      "ACS 2020–2024 estimates are allocated using 2020 block population proportions. Within-unit education and occupation distributions are assumed to follow that population; these are modeled subarea estimates, not published block-level cohorts.",
      "Approximate 90% margins describe conditional ACS sampling uncertainty only. They omit spatial allocation, source vintage, network and travel-cost uncertainty and do not account for covariance among source estimates.",
      "Known-subtotal margins use only explicitly known routed shares. Unknown allocation has its own uncertainty flag and does not mean a Census MOE is missing. A zero margin for an empty known share is not a zero uncertainty bound for the unresolved remainder.",
      "Known subtotals exclude unresolved contributions. A missing or suppressed value is never replaced by zero. Census source sentinels and annotations remain in the retained native rows.",
      "Original blocks split across current block groups are retained once without invented fractions. Positive ambiguous population makes every affected native group's allocation unavailable; zero-population split records add no allocation mass.",
      "A native unit with positive ACS estimates but no usable allocation population remains unresolved. Without a separate native-boundary exclusion proof, it is not assumed outside the commute shed merely because other origins appear distant.",
      "Results represent the captured regional network and source period. Scenario population growth, building jobs and authored street geometry are not automatically applied; no forecast or before/after routing effect is implied.",
      ...pack.allocation.notes,
      ...run.network.notes,
    ],
  };
}
