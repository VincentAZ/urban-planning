import {
  TRAFFIC_COMMUTE_DEPARTURE_BINS,
  TRAFFIC_COMMUTE_METHOD_VERSION,
  validateTrafficCommuteRecipe,
  validateTrafficCommuteSourcePack,
  validateTrafficCommuteRouteSet,
  trafficCommuteRoutingFlows,
  trafficCommuteContentHash,
  trafficContentHash,
  validateTrafficDemand,
  verifyTrafficCommuteBinding,
  verifyTrafficCommuteSummary,
  type TrafficDemand,
  type TrafficNetwork,
  type TrafficCommuteRouteSet,
  type TrafficCommuteFlowMass,
  type TrafficCommutePrior,
  type TrafficCommutePriorCell,
  type TrafficCommuteRecipe,
  type TrafficCommuteSourcePack,
  type TrafficCommuteBinding,
  type TrafficCommuteSummary,
  type TrafficCommuteCoverage,
  type TrafficCommuteTotals,
  type TrafficCommuteSampling,
} from "@urban/core";

/** Compensated summation avoids input-order-dependent loss of small flow masses. */
function sum(values: readonly number[]): number {
  let total = 0,
    correction = 0;
  for (const value of values) {
    const next = total + value;
    correction +=
      Math.abs(total) >= Math.abs(value)
        ? total - next + value
        : value - next + total;
    total = next;
  }
  return total + correction;
}
const sorted = <T>(rows: readonly T[], key: (v: T) => string): T[] =>
  [...rows].sort((a, b) => key(a).localeCompare(key(b), "en"));

/**
 * An ACS absolute drive-alone departure-bin estimate is distributed over retained
 * LODES primary-job destination shares. This is a modeled joint population, not
 * observed vehicle OD, a dated traffic count, or an inferred non-commute residual.
 */
export function buildTrafficCommutePrior(
  pack: TrafficCommuteSourcePack,
  recipe: TrafficCommuteRecipe,
): TrafficCommutePrior {
  validateTrafficCommuteSourcePack(pack);
  validateTrafficCommuteRecipe(recipe, pack);
  if (
    trafficCommuteRoutingFlows(pack, recipe).length *
      recipe.departureCellIds.length >
    250000
  )
    throw new Error(
      "COMMUTE_COMPLEXITY: the explicit cohort and bins exceed250,000 flow-bin records; narrow the reviewed scope, no rows were dropped.",
    );
  const selected = new Set(recipe.originTractGeoids);
  const blocks = new Map(pack.blocks.map((b) => [b.geoid, b]));
  const residences = new Map(pack.residences.map((r) => [r.blockGeoid, r]));
  const tractRows = new Map(pack.tracts.map((t) => [t.geoid, t]));
  const blocked = new Map<string, string>();
  const residentJobs = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const flowsByTract = new Map<string, TrafficCommuteSourcePack["flows"]>();
  let ambiguousResidentPrimaryJobs = 0,
    unselectedResidentPrimaryJobs = 0;

  for (const row of sorted(pack.residences, (r) => r.blockGeoid)) {
    const join = blocks.get(row.blockGeoid)!.tractJoin;
    if (join.status === "unresolved") {
      ambiguousResidentPrimaryJobs += row.jobs;
      if (row.jobs > 0) {
        // Unknown candidates cannot establish a complete denominator for any cohort tract.
        const candidates = join.candidateTractGeoids.length
          ? join.candidateTractGeoids
          : recipe.originTractGeoids;
        for (const t of candidates)
          if (selected.has(t))
            blocked.set(t, "unresolved-native-block-to-acs-tract");
      }
    } else if (selected.has(join.tractGeoid)) {
      residentJobs.set(
        join.tractGeoid,
        (residentJobs.get(join.tractGeoid) ?? 0) + row.jobs,
      );
    } else unselectedResidentPrimaryJobs += row.jobs;
  }
  for (const flow of sorted(pack.flows, (f) => f.id)) {
    if (flow.part !== "main") continue;
    outgoing.set(
      flow.homeBlockGeoid,
      (outgoing.get(flow.homeBlockGeoid) ?? 0) + flow.jobs,
    );
    const join = blocks.get(flow.homeBlockGeoid)!.tractJoin;
    if (join.status === "verified" && selected.has(join.tractGeoid)) {
      const rows = flowsByTract.get(join.tractGeoid) ?? [];
      rows.push(flow);
      flowsByTract.set(join.tractGeoid, rows);
    }
  }
  for (const [home, jobs] of outgoing) {
    if (jobs > (residences.get(home)?.jobs ?? 0)) {
      const join = blocks.get(home)!.tractJoin;
      const tracts =
        join.status === "verified"
          ? [join.tractGeoid]
          : join.candidateTractGeoids.length
            ? join.candidateTractGeoids
            : recipe.originTractGeoids;
      for (const t of tracts)
        if (selected.has(t))
          blocked.set(t, "known-od-exceeds-resident-primary-jobs");
    }
  }
  if (
    pack.coverage.rac !== "complete-for-declared-tracts" ||
    pack.coverage.odMain !== "complete-for-declared-tracts"
  )
    for (const t of selected)
      blocked.set(t, "incomplete-resident-or-destination-source-coverage");

  const cells: TrafficCommutePriorCell[] = [],
    flows: TrafficCommuteFlowMass[] = [];
  for (const tractGeoid of [...selected].sort()) {
    const native = tractRows.get(tractGeoid)!;
    const clock = recipe.homeClocks.find((c) => c.tractGeoid === tractGeoid)!;
    const denominator = residentJobs.get(tractGeoid) ?? 0;
    const nativeFlows = flowsByTract.get(tractGeoid) ?? [];
    const knownJobs = sum(nativeFlows.map((f) => f.jobs));
    const reason = blocked.get(tractGeoid);
    for (const cellId of [...recipe.departureCellIds].sort()) {
      const original = native.cells[cellId];
      const estimate = original.estimate.value;
      const bin = TRAFFIC_COMMUTE_DEPARTURE_BINS.find(
        (b) => b.cellId === cellId,
      )!;
      const cell: TrafficCommutePriorCell = {
        tractGeoid,
        cellId,
        estimate: structuredClone(original.estimate),
        marginOfError: structuredClone(original.marginOfError),
        status: "unavailable",
        residentPrimaryJobs: reason ? null : denominator,
        knownDestinationJobs: reason ? null : knownJobs,
        unresolvedDestinationJobs: reason ? null : denominator - knownJobs,
        allocatedVehicles: null,
        unresolvedVehicles: null,
        reason: null,
      };
      if (estimate === null) {
        cell.reason = `acs-${original.estimate.status}`;
      } else if (reason || (denominator === 0 && estimate > 0)) {
        cell.status = "unresolved";
        cell.allocatedVehicles = 0;
        cell.unresolvedVehicles = estimate;
        cell.reason = reason ?? "positive-acs-with-zero-resident-primary-jobs";
      } else {
        cell.status = "allocated";
        // Zero ACS is an explicit zero without requiring division by a zero denominator.
        const knownShare = denominator === 0 ? 0 : knownJobs / denominator;
        cell.allocatedVehicles = estimate * knownShare;
        cell.unresolvedVehicles =
          denominator === 0
            ? 0
            : estimate * ((denominator - knownJobs) / denominator);
        if (cell.unresolvedVehicles > 0) {
          cell.status = "unresolved";
          cell.reason = "destination-outside-retained-od-coverage";
        }
        for (const flow of nativeFlows) {
          if (flow.jobs === 0 || denominator === 0) continue;
          const destinationShare = flow.jobs / denominator;
          flows.push({
            id: `${flow.id}:${cellId}`,
            flowId: flow.id,
            tractGeoid,
            cellId,
            homeBlockGeoid: flow.homeBlockGeoid,
            workBlockGeoid: flow.workBlockGeoid,
            primaryJobs: flow.jobs,
            residentPrimaryJobs: denominator,
            destinationShare,
            expectedVehicles: estimate * destinationShare,
            homeBeginSeconds: bin.beginSeconds,
            homeEndSeconds: bin.endSeconds,
            localClockShiftSeconds:
              60 * (recipe.period.utcOffsetMinutes - clock.utcOffsetMinutes),
          });
        }
      }
      cells.push(cell);
    }
  }
  const knownCells = cells.filter((c) => c.estimate.value !== null);
  const unknownEstimateCells = cells.length - knownCells.length;
  const knownSourceVehicles = knownCells.length
    ? sum(knownCells.map((c) => c.estimate.value!))
    : null;
  return {
    version: 1,
    methodVersion: TRAFFIC_COMMUTE_METHOD_VERSION,
    recipe: structuredClone(recipe),
    cells,
    flows,
    coverage: {
      selectedTracts: selected.size,
      unknownEstimateCells,
      unavailableMoeCells: cells.filter((c) => c.marginOfError.value === null)
        .length,
      unresolvedAllocationCells: cells.filter((c) => c.status === "unresolved")
        .length,
      externalOriginPrimaryJobs: pack.reconciliation.auxiliaryJobs,
      externalOriginFlowCount: pack.reconciliation.auxiliaryFlowCount,
      unselectedResidentPrimaryJobs,
      ambiguousResidentPrimaryJobs,
    },
    totals: {
      sourceVehicles: unknownEstimateCells ? null : knownSourceVehicles,
      knownSourceVehicles,
      allocatedVehicles: sum(cells.map((c) => c.allocatedVehicles ?? 0)),
      unresolvedVehicles: unknownEstimateCells
        ? null
        : sum(cells.map((c) => c.unresolvedVehicles!)),
    },
    notes: [
      "Modeled one-way home-to-work drive-alone vehicles for the explicitly selected resident tracts and departure bins; not all traffic through the local network.",
      "Each ACS joint drive-alone/departure-bin estimate is allocated using complete resident-tract LODES JT01 destination shares. Mode and departure are not multiplied as independent marginals.",
      "Within a resident tract, the LODES home/destination distribution is assumed to apply to ACS drive-alone workers in each selected bin. LODES covered primary jobs and ACS workers have different universes, reference periods and primary-job definitions.",
      "LODES is partially synthetic and describes Q2 job relationships, not measured vehicle trips. ACS2024 five-year values describe 2020–2024 usual commute patterns, not a particular traffic-count date.",
      "Drove-alone includes some escorted commuters; one outbound vehicle leg is modeled. Escort return trips, carpool vehicles, non-work trips, freight and background residual demand are not invented.",
      "Out-of-state resident auxiliary jobs and unresolved outbound destinations remain separately accounted for. Missing source values, missing geography and routing uncertainty are not zero.",
      "Home departures are uniform within each original ACS bin, an explicit temporal allocation assumption. Regional travel time must be applied before admitting local network entry.",
      "ACS sampling margins do not quantify LODES synthesis, geographic allocation, route choice, date transfer or source-universe uncertainty.",
    ],
  };
}

export interface TrafficCommuteWeightedCell {
  tractGeoid: string;
  cellId: string;
  /** Sum across destinations first; do not treat subdivisions of one source cell as independent. */
  weight: number;
}
/** Conditional ACS-only approximation; never an uncertainty interval for total modeled traffic. */
export function trafficCommuteSamplingMoe(
  prior: TrafficCommutePrior,
  contributions: readonly TrafficCommuteWeightedCell[],
): TrafficCommuteSampling {
  const native = new Map(
    prior.cells.map((c) => [`${c.tractGeoid}:${c.cellId}`, c]),
  );
  const weights = new Map<string, number[]>();
  for (const row of contributions) {
    const key = `${row.tractGeoid}:${row.cellId}`;
    if (
      !native.has(key) ||
      !Number.isFinite(row.weight) ||
      row.weight < 0 ||
      row.weight > 1
    )
      throw new Error(
        "Sampling contributions need retained native cells and finite fractional weights.",
      );
    const values = weights.get(key) ?? [];
    values.push(row.weight);
    weights.set(key, values);
  }
  const estimates: number[] = [],
    squares: number[] = [],
    missingEstimateCells: string[] = [],
    missingMoeCells: string[] = [];
  for (const key of [...weights.keys()].sort()) {
    const weight = sum(weights.get(key)!);
    if (weight > 1 + 8 * Number.EPSILON)
      throw new Error("A native ACS cell cannot be counted more than once.");
    if (weight === 0) continue;
    const cell = native.get(key)!;
    if (cell.estimate.value === null) missingEstimateCells.push(key);
    else estimates.push(cell.estimate.value * weight);
    if (cell.marginOfError.value === null) missingMoeCells.push(key);
    else squares.push((cell.marginOfError.value * weight) ** 2);
  }
  const known = estimates.length
    ? sum(estimates)
    : missingEstimateCells.length
      ? null
      : 0;
  return {
    knownEstimateSubtotal: known,
    estimate: missingEstimateCells.length ? null : known,
    conditionalSamplingMoe:
      missingEstimateCells.length || missingMoeCells.length
        ? null
        : Math.sqrt(sum(squares)),
    missingEstimateCells,
    missingMoeCells,
    notes: [
      "Weights belonging to the same native ACS tract/cell are combined before its published 90% margin is applied. Root-sum-of-squares across distinct native cells is an approximation; covariance is unavailable.",
      "This conditional sampling margin excludes LODES synthesis, destination/clock allocation and routing uncertainty.",
    ],
  };
}

export interface TrafficCommuteCompilationRow {
  id: string;
  flowId: string;
  tractGeoid: string;
  cellId: string;
  expectedVehicles: number;
  routeStatus: TrafficCommuteRouteSet["attachments"][number]["status"];
  regionalRouteHash: string | null;
  localBindingHash: string | null;
  classification: "internal" | "inbound" | "outbound" | "through" | null;
  entryBeginSeconds: number | null;
  entryEndSeconds: number | null;
  admittedBeginSeconds: number | null;
  admittedEndSeconds: number | null;
  admittedExpectedVehicles: number;
  warmupExpectedVehicles: number;
  measurementExpectedVehicles: number;
  beforeWindowVehicles: number;
  afterWindowVehicles: number;
  noLocalIntersectionVehicles: number;
  unresolvedRouteVehicles: number;
  roundedVehicles: number;
  roundingDelta: number;
  /** Null for a fractional contribution rounded to zero or otherwise not admitted. */
  demandRowId: string | null;
}
export interface TrafficCommuteCompilation {
  version: 1;
  methodVersion: typeof TRAFFIC_COMMUTE_METHOD_VERSION;
  sourcePackHash: string;
  priorHash: string;
  routesHash: string;
  demandHash: string;
  demand: TrafficDemand;
  ledger: TrafficCommuteCompilationRow[];
  coverage: TrafficCommuteCoverage;
  totals: TrafficCommuteTotals;
  conditionalAcsSampling: ReturnType<typeof trafficCommuteSamplingMoe>;
  notes: string[];
}

/** Reconstruct the complete compiler ledger before projecting a bounded saved summary.
 * Asset bytes and regional route proof authority must additionally be checked by the server. */
export async function createTrafficCommuteSummary(input: {
  binding: TrafficCommuteBinding;
  sourcePack: TrafficCommuteSourcePack;
  prior: TrafficCommutePrior;
  routes: TrafficCommuteRouteSet;
  compilation: TrafficCommuteCompilation;
  network: TrafficNetwork;
}): Promise<TrafficCommuteSummary> {
  const { binding, sourcePack, prior, routes, compilation, network } = input;
  await verifyTrafficCommuteBinding(binding, {
    demand: compilation.demand,
    period: prior.recipe.period,
    network,
  });
  const rebuilt = await compileTrafficCommuteDemand(prior, routes, network, {
    sourcePack,
  });
  const [packHash, priorHash, routesHash, compiledHash, rebuiltHash] =
    await Promise.all([
      trafficContentHash(sourcePack),
      trafficContentHash(prior),
      trafficContentHash(routes),
      trafficContentHash(compilation),
      trafficContentHash(rebuilt),
    ]);
  if (
    binding.sourcePackHash !== packHash ||
    binding.priorHash !== priorHash ||
    binding.routesHash !== routesHash ||
    binding.compilationHash !== compiledHash ||
    compiledHash !== rebuiltHash
  )
    throw new Error(
      "The full commute source, prior, routes or fractional compilation ledger differs from its immutable binding.",
    );
  const summary: TrafficCommuteSummary = structuredClone({
    version: 1,
    methodVersion: TRAFFIC_COMMUTE_METHOD_VERSION,
    binding,
    routing: {
      regionalGraphHash: routes.regionalGraphHash,
      regionalSettingsHash: routes.regionalSettingsHash,
      localNetworkHash: routes.localNetworkHash,
      localInventoryHash: routes.localInventoryHash,
    },
    recipe: prior.recipe,
    sourceScope: {
      lodes: sourcePack.lodes,
      acs: sourcePack.acs,
      coverage: sourcePack.coverage,
    },
    priorCoverage: prior.coverage,
    coverage: compilation.coverage,
    totals: compilation.totals,
    conditionalAcsSampling: compilation.conditionalAcsSampling,
    sources: sourcePack.sources,
    files: sourcePack.files,
    notes: [
      ...sourcePack.notes,
      ...prior.notes,
      ...routes.notes,
      ...compilation.notes,
      "The complete native-source allocation, routing and window ledger remains in the retained private commute archive. This compact summary does not discard unresolved or rounded-zero rows from that archive.",
      "Regional travel times and entry/exit attachments describe the frozen baseline route. Local proposal controls do not recompute regional destinations, departure choices or outside-network travel times.",
    ],
  });
  await verifyTrafficCommuteSummary(summary);
  return summary;
}

/**
 * Compile only after regional routes and directed local attachments exist. Exact
 * source/prior/network bindings are checked before producing native demand.
 * Native path artifact authenticity remains the server adapter's responsibility.
 */
export async function compileTrafficCommuteDemand(
  prior: TrafficCommutePrior,
  routes: TrafficCommuteRouteSet,
  network: TrafficNetwork,
  context: { sourcePack: TrafficCommuteSourcePack; maximumVehicles?: number },
): Promise<TrafficCommuteCompilation> {
  const rebuilt = buildTrafficCommutePrior(context.sourcePack, prior.recipe);
  const [sourcePackHash, priorHash, rebuiltHash, inventoryHash, routesHash] =
    await Promise.all([
      trafficCommuteContentHash(context.sourcePack),
      trafficCommuteContentHash(prior),
      trafficCommuteContentHash(rebuilt),
      trafficContentHash(network),
      trafficCommuteContentHash(routes),
    ]);
  if (priorHash !== rebuiltHash)
    throw new Error(
      "Commute prior values do not reproduce from the retained source pack and recipe.",
    );
  if (
    routes.sourcePackHash !== sourcePackHash ||
    routes.priorHash !== priorHash ||
    routes.localNetworkHash !== network.manifest.networkFileSha256 ||
    routes.localInventoryHash !== inventoryHash
  )
    throw new Error(
      "Commute source, prior or local network identity changed after routing.",
    );
  const selectedFlows = trafficCommuteRoutingFlows(
    context.sourcePack,
    prior.recipe,
  );
  validateTrafficCommuteRouteSet(
    routes,
    selectedFlows.map((f) => f.id),
  );
  const attachments = new Map(routes.attachments.map((r) => [r.flowId, r]));
  const massById = new Map(prior.flows.map((f) => [f.id, f]));
  const sources = structuredClone(context.sourcePack.sources);
  const sourceIds = [...prior.recipe.sourceIds];
  const period = prior.recipe.period;
  const windowStart = period.beginSeconds - period.warmupSeconds,
    windowEnd = period.endSeconds;
  const endpointOf = (
    local: NonNullable<TrafficCommuteRouteSet["attachments"][number]["local"]>,
  ) => ({
    departLaneId: local.departLaneId,
    departPositionMeters: local.departPositionMeters,
    arrivalLaneId: local.arrivalLaneId,
    arrivalPositionMeters: local.arrivalPositionMeters,
  });
  // Validate even paths later rounded to zero. A zero-mass record is not permission to hide a bad attachment.
  const pathChecks: TrafficDemand = {
    version: 1,
    sources,
    notes: [],
    rows: [],
    candidateRoutes: [],
  };
  for (const [i, route] of sorted(
    routes.attachments,
    (r) => r.flowId,
  ).entries())
    if (route.local) {
      const id = `commute-path-check-${i}`;
      pathChecks.rows.push({
        id,
        originEdge: route.local.edges[0],
        destinationEdge: route.local.edges.at(-1)!,
        endpoints: endpointOf(route.local),
        beginSeconds: windowStart,
        endSeconds: windowEnd,
        vehicleClass: "passenger",
        vehicles: 0,
        purpose: "commute",
        quality: "inferred",
        sourceIds,
      });
      pathChecks.candidateRoutes.push({
        id: `${id}-route`,
        odId: id,
        edges: route.local.edges,
        weight: 1,
        sourceIds,
      });
    }
  validateTrafficDemand(pathChecks, network, period);
  const ledger: TrafficCommuteCompilationRow[] = [];
  const overlap = (a: number, b: number, c: number, d: number) =>
    Math.max(0, Math.min(b, d) - Math.max(a, c));
  for (const mass of sorted(prior.flows, (f) => f.id)) {
    const route = attachments.get(mass.flowId)!;
    const row: TrafficCommuteCompilationRow = {
      id: mass.id,
      flowId: mass.flowId,
      tractGeoid: mass.tractGeoid,
      cellId: mass.cellId,
      expectedVehicles: mass.expectedVehicles,
      routeStatus: route.status,
      regionalRouteHash: route.regionalRouteHash,
      localBindingHash: route.local?.bindingHash ?? null,
      classification: route.local?.classification ?? null,
      entryBeginSeconds: null,
      entryEndSeconds: null,
      admittedBeginSeconds: null,
      admittedEndSeconds: null,
      admittedExpectedVehicles: 0,
      warmupExpectedVehicles: 0,
      measurementExpectedVehicles: 0,
      beforeWindowVehicles: 0,
      afterWindowVehicles: 0,
      noLocalIntersectionVehicles: 0,
      unresolvedRouteVehicles: 0,
      roundedVehicles: 0,
      roundingDelta: 0,
      demandRowId: null,
    };
    if (route.status === "no-local-intersection")
      row.noLocalIntersectionVehicles = mass.expectedVehicles;
    else if (!route.local) row.unresolvedRouteVehicles = mass.expectedVehicles;
    else {
      const begin =
        mass.homeBeginSeconds +
        mass.localClockShiftSeconds +
        route.local.prefixSeconds;
      const end =
        mass.homeEndSeconds +
        mass.localClockShiftSeconds +
        route.local.prefixSeconds;
      const duration = mass.homeEndSeconds - mass.homeBeginSeconds;
      row.entryBeginSeconds = begin;
      row.entryEndSeconds = end;
      const admittedDuration = overlap(begin, end, windowStart, windowEnd);
      if (admittedDuration > 0) {
        row.admittedBeginSeconds = Math.max(begin, windowStart);
        row.admittedEndSeconds = Math.min(end, windowEnd);
      }
      row.admittedExpectedVehicles =
        mass.expectedVehicles * (admittedDuration / duration);
      row.warmupExpectedVehicles =
        mass.expectedVehicles *
        (overlap(begin, end, windowStart, period.beginSeconds) / duration);
      row.measurementExpectedVehicles =
        mass.expectedVehicles *
        (overlap(begin, end, period.beginSeconds, windowEnd) / duration);
      row.beforeWindowVehicles =
        mass.expectedVehicles *
        (Math.max(0, Math.min(end, windowStart) - begin) / duration);
      row.afterWindowVehicles =
        mass.expectedVehicles *
        (Math.max(0, end - Math.max(begin, windowEnd)) / duration);
    }
    ledger.push(row);
  }
  const maximumVehicles = context.maximumVehicles ?? 30000;
  if (maximumVehicles > 30000)
    throw new Error(
      "The current native commute compiler admits at most30,000 vehicles, without truncation.",
    );
  const rounded = roundTrafficCommuteMass(
    ledger.map((r) => ({
      id: r.id,
      expectedVehicles: r.admittedExpectedVehicles,
    })),
    maximumVehicles,
  );
  const roundedRows = new Map(rounded.rows.map((r) => [r.id, r]));
  const demand: TrafficDemand = {
    version: 1,
    rows: [],
    candidateRoutes: [],
    sources,
    notes: [
      ...prior.notes,
      "Demand entry times include the regional home-to-local prefix and source/local clock difference; endpoint positions retain the directed native lane attachment.",
      "Fractional source flow/bin contributions are rounded once by largest remainder across admitted local-entry mass. Omitted destinations, route failures and out-of-window trips are retained in the separate immutable ledger.",
      "Equal fractional remainders use stable source-flow/cell ID order. This single deterministic integer realization can favor that ordering at sparse volumes; the fractional ledger remains authoritative. Zero-vehicle contributions remain in the ledger rather than empty native demand rows.",
      "Native departures within each admitted interval remain a declared uniform allocation. One fixed regional/local path per source OD is a route-choice assumption, not dynamic equilibrium or observed routing.",
      "ACS car/truck/van drive-alone trips use the native passenger vehicle type in this compiler. This simulation class is not an observed FHWA vehicle-class assignment.",
    ],
  };
  for (const [index, row] of ledger.entries()) {
    const roundedRow = roundedRows.get(row.id)!;
    row.roundedVehicles = roundedRow.vehicles;
    row.roundingDelta = roundedRow.roundingDelta;
    if (!roundedRow.vehicles) continue;
    const local = attachments.get(row.flowId)!.local!;
    const id = `commute-${index}`;
    row.demandRowId = id;
    demand.rows.push({
      id,
      originEdge: local.edges[0],
      destinationEdge: local.edges.at(-1)!,
      endpoints: endpointOf(local),
      beginSeconds: row.admittedBeginSeconds!,
      endSeconds: row.admittedEndSeconds!,
      vehicleClass: "passenger",
      vehicles: roundedRow.vehicles,
      purpose: "commute",
      quality: "inferred",
      sourceIds,
    });
    demand.candidateRoutes.push({
      id: `${id}-route`,
      odId: id,
      edges: [...local.edges],
      weight: 1,
      sourceIds,
    });
  }
  validateTrafficDemand(demand, network, period);
  const total = (key: keyof TrafficCommuteCompilationRow) =>
    sum(ledger.map((r) => r[key] as number));
  const knownUnresolvedSourceVehicles = sum(
    prior.cells.map((c) => c.unresolvedVehicles ?? 0),
  );
  const unresolvedRouteVehicles = total("unresolvedRouteVehicles"),
    noLocalIntersectionVehicles = total("noLocalIntersectionVehicles");
  const beforeWindowVehicles = total("beforeWindowVehicles"),
    afterWindowVehicles = total("afterWindowVehicles");
  const admittedExpectedVehicles = rounded.expectedVehicles;
  const conservationResidual =
    prior.totals.knownSourceVehicles === null
      ? null
      : prior.totals.knownSourceVehicles -
        sum([
          knownUnresolvedSourceVehicles,
          unresolvedRouteVehicles,
          noLocalIntersectionVehicles,
          beforeWindowVehicles,
          afterWindowVehicles,
          admittedExpectedVehicles,
        ]);
  if (
    conservationResidual !== null &&
    Math.abs(conservationResidual) >
      64 * Number.EPSILON * Math.max(1, prior.totals.knownSourceVehicles!)
  )
    throw new Error(
      "Commute fractional source mass did not conserve across allocation, route and window outcomes.",
    );
  const routeStatusCounts: TrafficCommuteCompilation["coverage"]["routeStatusCounts"] =
    {
      routed: 0,
      "no-local-intersection": 0,
      unreachable: 0,
      unsnappable: 0,
      "outside-coverage": 0,
      "unmatched-local-network": 0,
      "reentry-unsupported": 0,
    };
  for (const route of routes.attachments) routeStatusCounts[route.status]++;
  return {
    version: 1,
    methodVersion: TRAFFIC_COMMUTE_METHOD_VERSION,
    sourcePackHash,
    priorHash,
    routesHash,
    demandHash: await trafficContentHash(demand),
    demand,
    ledger,
    coverage: {
      status:
        prior.coverage.unknownEstimateCells ||
        prior.coverage.unresolvedAllocationCells ||
        unresolvedRouteVehicles > 0
          ? "partial"
          : "complete-for-declared-cohort",
      selectedNativeFlows: selectedFlows.length,
      routeStatusCounts,
      unknownEstimateCells: prior.coverage.unknownEstimateCells,
      unresolvedAllocationCells: prior.coverage.unresolvedAllocationCells,
      externalOriginPrimaryJobs: prior.coverage.externalOriginPrimaryJobs,
    },
    totals: {
      sourceVehicles: prior.totals.sourceVehicles,
      knownSourceVehicles: prior.totals.knownSourceVehicles,
      knownUnresolvedSourceVehicles,
      unresolvedRouteVehicles,
      noLocalIntersectionVehicles,
      beforeWindowVehicles,
      afterWindowVehicles,
      admittedExpectedVehicles,
      warmupExpectedVehicles: total("warmupExpectedVehicles"),
      measurementExpectedVehicles: total("measurementExpectedVehicles"),
      vehicles: rounded.vehicles,
      roundingDelta: rounded.roundingDelta,
      conservationResidual,
    },
    conditionalAcsSampling: trafficCommuteSamplingMoe(
      prior,
      ledger.map((row) => {
        const mass = massById.get(row.id)!;
        return {
          tractGeoid: row.tractGeoid,
          cellId: row.cellId,
          weight:
            mass.destinationShare *
            (row.expectedVehicles === 0
              ? 0
              : row.admittedExpectedVehicles / row.expectedVehicles),
        };
      }),
    ),
    notes: [
      "Coverage is only for the declared resident cohort; external-origin, other-mode, other-purpose and unselected resident demand are not represented by a complete-cohort status.",
      "Source, routing and temporal losses remain fractional and visible. Rounded vehicles are a simulation realization, not new observed counts or fitted/calibrated demand.",
      "No count residual is assigned a trip purpose. Source-derived drive-alone cars cannot by themselves be compared as complete total motor traffic.",
    ],
  };
}

/** Largest remainder rounds admitted expected mass once, without truncation or hidden scaling. */
export function roundTrafficCommuteMass(
  rows: readonly { id: string; expectedVehicles: number }[],
  maximumVehicles: number,
): {
  rows: {
    id: string;
    expectedVehicles: number;
    vehicles: number;
    roundingDelta: number;
  }[];
  expectedVehicles: number;
  vehicles: number;
  roundingDelta: number;
} {
  if (!Number.isSafeInteger(maximumVehicles) || maximumVehicles < 0)
    throw new Error("A nonnegative integer native vehicle limit is required.");
  if (
    new Set(rows.map((r) => r.id)).size !== rows.length ||
    rows.some(
      (r) =>
        !r.id || !Number.isFinite(r.expectedVehicles) || r.expectedVehicles < 0,
    )
  )
    throw new Error(
      "Rounding requires unique flow IDs and finite nonnegative mass.",
    );
  const ordered = sorted(rows, (r) => r.id);
  const expectedVehicles = sum(ordered.map((r) => r.expectedVehicles));
  const vehicles = Math.round(expectedVehicles);
  if (!Number.isSafeInteger(vehicles) || vehicles > maximumVehicles)
    throw new Error(
      `COMMUTE_CAPACITY: ${vehicles} vehicles exceed the explicit limit ${maximumVehicles}; narrow the reviewed cohort/window, never silently truncate or scale.`,
    );
  const counts = ordered.map((r) => Math.floor(r.expectedVehicles));
  const remaining = vehicles - sum(counts);
  const remainders = ordered
    .map((r, index) => ({
      index,
      fraction: r.expectedVehicles - counts[index],
      id: r.id,
    }))
    .sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id, "en"));
  if (remaining < 0 || remaining > remainders.length)
    throw new Error("Floating-point mass cannot be apportioned safely.");
  for (let i = 0; i < remaining; i++) counts[remainders[i].index]++;
  return {
    rows: ordered.map((r, i) => ({
      ...r,
      vehicles: counts[i],
      roundingDelta: counts[i] - r.expectedVehicles,
    })),
    expectedVehicles,
    vehicles,
    roundingDelta: vehicles - expectedVehicles,
  };
}
