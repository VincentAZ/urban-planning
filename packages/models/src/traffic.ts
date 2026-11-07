import {
  TRAFFIC_METHOD_VERSION,
  trafficCalibrationPlanSchema,
  trafficPeriodSchema,
  trafficSimulationResultSchema,
  trafficPairRecipeHash,
  trafficContentHash,
  validateTrafficCountPack,
  validateTrafficDemand,
  validateTrafficNetwork,
  type TrafficCountPack,
  type TrafficCountPrediction,
  type TrafficCalibrationPlan,
  type TrafficNetwork,
  type TrafficPeriod,
  type TrafficDemand,
  type TrafficVehicle,
  type TrafficSimulationResult,
  type TrafficPairRecipe,
  type TrafficCount,
  type TrafficCalibrationRow,
  type TrafficCalibrationGroup,
  type TrafficCalibrationResult,
  type TrafficRunSummary,
  type TrafficComparison,
} from "@urban/core";

export interface TrafficDemandAllocation {
  vehicles: TrafficVehicle[];
  routeCounts: { odId: string; routeId: string; vehicles: number }[];
  seed: number;
  methodVersion: string;
  notes: string[];
}
function ordered(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer one-way trips over explicitly provided paths; this does not infer OD demand from counts or trip ends. */
export function allocateTrafficVehicles(
  demand: TrafficDemand,
  network: TrafficNetwork,
  seed: number,
  period?: TrafficPeriod,
): TrafficDemandAllocation {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("Traffic seed must be an unsigned 32-bit integer.");
  validateTrafficNetwork(network);
  validateTrafficDemand(demand, network, period);
  const random = randomGenerator(seed),
    vehicles: TrafficVehicle[] = [],
    routeCounts: TrafficDemandAllocation["routeCounts"] = [];
  const rows = [...demand.rows].sort((a, b) => ordered(a.id, b.id));
  const grouped = new Map<string, typeof demand.candidateRoutes>();
  for (const r of demand.candidateRoutes) {
    const list = grouped.get(r.odId) ?? [];
    list.push(r);
    grouped.set(r.odId, list);
  }
  rows.forEach((row, rowIndex) => {
    const routes = [...(grouped.get(row.id) ?? [])].sort((a, b) =>
        ordered(a.id, b.id),
      ),
      total = routes.reduce((n, r) => n + r.weight, 0);
    if (!Number.isFinite(total))
      throw new Error(`Route weights for ${row.id} exceed finite arithmetic.`);
    const allocation = routes.map((r) => {
      const quota = total > 0 ? (r.weight / total) * row.vehicles : 0;
      return {
        route: r,
        count: Math.floor(quota),
        remainder: quota - Math.floor(quota),
      };
    });
    const remaining =
      row.vehicles - allocation.reduce((n, r) => n + r.count, 0);
    if (remaining < 0 || remaining > allocation.length)
      throw new Error("Route apportionment failed; no demand was discarded.");
    [...allocation]
      .sort(
        (a, b) => b.remainder - a.remainder || ordered(a.route.id, b.route.id),
      )
      .slice(0, remaining)
      .forEach((r) => r.count++);
    const routeSlots = allocation.flatMap((r) =>
      Array.from({ length: r.count }, () => r.route),
    );
    for (let i = routeSlots.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [routeSlots[i], routeSlots[j]] = [routeSlots[j], routeSlots[i]];
    }
    allocation.forEach((r) =>
      routeCounts.push({
        odId: row.id,
        routeId: r.route.id,
        vehicles: r.count,
      }),
    );
    routeSlots.forEach((route, i) =>
      vehicles.push({
        id: `traffic-${rowIndex}-${i}`,
        odId: row.id,
        routeId: route.id,
        departSeconds:
          row.beginSeconds +
          ((i + random()) / row.vehicles) * (row.endSeconds - row.beginSeconds),
        edges: [...route.edges],
        vehicleClass: row.vehicleClass,
        ...(row.endpoints ? { endpoints: { ...row.endpoints } } : {}),
      }),
    );
  });
  vehicles.sort(
    (a, b) => a.departSeconds - b.departSeconds || ordered(a.id, b.id),
  );
  return {
    vehicles,
    routeCounts,
    seed,
    methodVersion: TRAFFIC_METHOD_VERSION,
    notes: [
      "Entered OD quantities are one-way vehicle trips. No automatic conversion from building trip ends, AADT, workers, or population was performed.",
      "Route weights use deterministic largest-remainder integer apportionment; departures are seed-reproducible stratified uniform draws inside each entered interval, not observed departure times.",
    ],
  };
}

/** Missing, excluded, factored, unmapped and mismatched-period observations cannot certify a fitted count. */
function unusable(
  c: TrafficCount,
  p: TrafficCountPrediction | undefined,
  period: TrafficPeriod,
): string | null {
  if (c.status !== "available" || c.value === null)
    return `Source observation is ${c.status}.`;
  if (c.kind !== "observed")
    return "Factored estimates are context, not observed interval calibration counts.";
  if (!c.target || !c.mapping) return "Count has no reviewed network mapping.";
  if (!c.vehicleClasses?.length)
    return "Vehicle-class coverage has not been mapped.";
  if (
    c.date !== period.date ||
    c.timeZone !== period.timeZone ||
    c.utcOffsetMinutes !== period.utcOffsetMinutes ||
    c.beginSeconds < period.beginSeconds ||
    c.endSeconds > period.endSeconds
  )
    return "Count does not match the analysis date, clock, or period.";
  if (!p || p.status !== "available" || p.vehicles === null)
    return p?.reason ?? "The simulation has no matching detector result.";
  if (!Number.isSafeInteger(p.vehicles) || p.vehicles < 0)
    throw new Error(
      "Simulated detector counts must be nonnegative whole vehicles.",
    );
  return null;
}
function sameTarget(a: TrafficCount, b: TrafficCount): boolean {
  if (!a.target || !b.target || a.target.kind !== b.target.kind) return false;
  if (a.target.kind === "turn" && b.target.kind === "turn")
    return a.target.connectionId === b.target.connectionId;
  if (a.target.kind === "edge" && b.target.kind === "edge") {
    const left = a.target,
      right = b.target;
    return (
      left.edgeId === right.edgeId &&
      left.positionFraction === right.positionFraction &&
      (!left.laneIds ||
        !right.laneIds ||
        left.laneIds.some((id) => right.laneIds!.includes(id)))
    );
  }
  return false;
}
export function evaluateTrafficCalibration(
  pack: TrafficCountPack,
  predictions: readonly TrafficCountPrediction[],
  plan: TrafficCalibrationPlan,
  network: TrafficNetwork,
  period: TrafficPeriod,
): TrafficCalibrationResult {
  validateTrafficCountPack(pack, network);
  trafficPeriodSchema.parse(period);
  trafficCalibrationPlanSchema.parse(plan);
  const requested = [...plan.calibrationCountIds, ...plan.holdoutCountIds];
  if (new Set(requested).size !== requested.length)
    throw new Error(
      "Calibration and held-out count identities must be unique and disjoint.",
    );
  if (plan.sourceIds.some((id) => !pack.sources.some((s) => s.id === id)))
    throw new Error(
      "Calibration criteria require retained source attribution.",
    );
  const counts = new Map(pack.counts.map((c) => [c.id, c])),
    predicted = new Map<string, TrafficCountPrediction>();
  for (const p of predictions) {
    if (predicted.has(p.countId))
      throw new Error(`Duplicate detector prediction ${p.countId}`);
    if (
      (p.status === "available") !== (p.vehicles !== null) ||
      (p.vehicles !== null &&
        (!Number.isSafeInteger(p.vehicles) || p.vehicles < 0))
    )
      throw new Error(
        "Detector prediction status and whole-vehicle count disagree.",
      );
    predicted.set(p.countId, p);
  }
  const selected = requested.map((id) => {
    const c = counts.get(id);
    if (!c) throw new Error(`Unknown selected count ${id}`);
    return c;
  });
  // Bucket overlapping constraints by physical target. A held-out duplicate is not independent evidence.
  const buckets = new Map<string, TrafficCount[]>();
  let overlapCandidates = 0;
  for (const c of [...selected].sort(
    (a, b) => a.beginSeconds - b.beginSeconds,
  )) {
    if (!c.target) continue;
    const key =
      c.target.kind === "edge"
        ? `edge:${c.target.edgeId}:${c.date}:${c.timeZone}:${c.target.positionFraction}`
        : `turn:${c.target.connectionId}:${c.date}:${c.timeZone}`;
    const prior = (buckets.get(key) ?? []).filter(
      (other) => other.endSeconds > c.beginSeconds,
    );
    for (const other of prior) {
      if (++overlapCandidates > 1000000)
        throw new Error(
          "Traffic count overlap-validation budget exceeded; reduce overlapping constraints without dropping source records.",
        );
      if (
        c.date === other.date &&
        c.timeZone === other.timeZone &&
        c.beginSeconds < other.endSeconds &&
        other.beginSeconds < c.endSeconds &&
        sameTarget(c, other) &&
        c.vehicleClasses &&
        other.vehicleClasses &&
        c.vehicleClasses.some((v) => other.vehicleClasses!.includes(v))
      )
        throw new Error(
          "Selected counts overlap in time, target and vehicle class; they cannot be treated as independent fitting or held-out evidence.",
        );
    }
    prior.push(c);
    buckets.set(key, prior);
  }
  const training = new Set(plan.calibrationCountIds);
  const rows: TrafficCalibrationRow[] = selected.map((c) => {
    const p = predicted.get(c.id),
      reason = unusable(c, p, period),
      base = {
        countId: c.id,
        role: training.has(c.id)
          ? ("calibration" as const)
          : ("holdout" as const),
        observed: c.value,
        modeled: p?.vehicles ?? null,
      };
    if (reason)
      return {
        ...base,
        observedHourly: null,
        modeledHourly: null,
        absoluteHourlyError: null,
        relativeError: null,
        geh: null,
        passed: null,
        reason,
      };
    const hours = (c.endSeconds - c.beginSeconds) / 3600,
      observed = c.value! / hours,
      modeled = p!.vehicles! / hours,
      error = Math.abs(modeled - observed),
      relative = observed === 0 ? (modeled === 0 ? 0 : null) : error / observed,
      geh =
        observed + modeled === 0
          ? 0
          : Math.sqrt((2 * (modeled - observed) ** 2) / (modeled + observed)),
      criteria = plan.criteria;
    return {
      ...base,
      observedHourly: observed,
      modeledHourly: modeled,
      absoluteHourlyError: error,
      relativeError: relative,
      geh,
      passed:
        geh <= criteria.gehMaximum &&
        (error <= criteria.absoluteHourlyErrorMaximum ||
          (relative !== null && relative <= criteria.relativeErrorMaximum)),
      reason: null,
    };
  });
  const group = (
    role: TrafficCalibrationRow["role"],
    minimum: number,
  ): TrafficCalibrationGroup => {
    const subset = rows.filter((r) => r.role === role),
      evaluated = subset.filter((r) => r.passed !== null),
      passed = evaluated.filter((r) => r.passed).length,
      fraction = evaluated.length ? passed / evaluated.length : null;
    return {
      requested: subset.length,
      evaluated: evaluated.length,
      unavailable: subset.length - evaluated.length,
      passed,
      passingFraction: fraction,
      status:
        evaluated.length < minimum || evaluated.length !== subset.length
          ? "incomplete"
          : fraction! >= plan.criteria.requiredPassingFraction
            ? "passed"
            : "failed",
    };
  };
  const calibration = group(
      "calibration",
      plan.criteria.minimumCalibrationCounts,
    ),
    holdout = group("holdout", plan.criteria.minimumHoldoutCounts);
  return {
    methodVersion: TRAFFIC_METHOD_VERSION,
    rows,
    calibration,
    holdout,
    status:
      calibration.status === "failed" || holdout.status === "failed"
        ? "failed"
        : calibration.status === "passed" && holdout.status === "passed"
          ? "passed"
          : "incomplete",
    scope: "interval-count-fit",
    notes: [
      "GEH and absolute errors use hourly-equivalent rates from the actual observed interval; AADT is not accepted as an interval observation.",
      "Acceptance requires GEH within the declared maximum AND either the declared absolute hourly or relative error tolerance. These entered criteria are not a universal agency standard.",
      "Held-out count fit is reported separately. Volume fit alone does not validate travel times, queues, turning behavior, junction control delay, or intersection LOS.",
    ],
  };
}

export function summarizeTrafficRun(
  result: TrafficSimulationResult,
): TrafficRunSummary {
  trafficSimulationResultSchema.parse(result);
  const d = result.diagnostics,
    ids = new Set<string>(),
    reasons: string[] = [];
  for (const t of result.trips) {
    if (ids.has(t.id)) throw new Error(`Duplicate simulated trip ${t.id}`);
    ids.add(t.id);
    if (
      t.requestedDepartSeconds <
        result.period.beginSeconds - result.period.warmupSeconds ||
      t.requestedDepartSeconds >= result.period.endSeconds
    )
      throw new Error(
        `Trip ${t.id} was not requested inside the admitted departure period.`,
      );
    if (
      t.arrived &&
      (t.departSeconds === null ||
        t.arrivalSeconds === null ||
        t.durationSeconds === null ||
        t.routeLengthMeters === null ||
        t.timeLossSeconds === null ||
        t.departDelaySeconds === null ||
        t.arrivalSeconds < t.departSeconds ||
        Math.abs(t.arrivalSeconds - t.departSeconds - t.durationSeconds) > 1e-5)
    )
      throw new Error(
        `Arrived trip ${t.id} has incomplete or inconsistent measurements.`,
      );
  }
  const allArrived = result.trips.filter((t) => t.arrived),
    measurement = result.trips.filter(
      (t) =>
        t.requestedDepartSeconds >= result.period.beginSeconds &&
        t.requestedDepartSeconds < result.period.endSeconds,
    ),
    arrived = measurement.filter((t) => t.arrived);
  if (d.arrived !== allArrived.length)
    reasons.push(
      "Arrived trip records do not reconcile with simulation diagnostics.",
    );
  if (
    result.trips.length !== d.requested ||
    d.loaded !== d.requested ||
    d.inserted + d.waiting !== d.loaded ||
    d.arrived + d.running + d.discarded !== d.inserted
  )
    reasons.push(
      "Vehicle admission/completion totals do not reconcile; omitted trips cannot be treated as zero demand.",
    );
  if (d.routeErrors) reasons.push(`${d.routeErrors} route errors occurred.`);
  if (d.teleports)
    reasons.push(`${d.teleports} teleports occurred; congestion was bypassed.`);
  if (d.collisions) reasons.push(`${d.collisions} collisions occurred.`);
  if (d.discarded) reasons.push(`${d.discarded} vehicles were discarded.`);
  const failed = reasons.length > 0;
  if (d.running || d.waiting)
    reasons.push(
      "Some requested vehicles are still running or waiting to enter; completed-trip averages are censored.",
    );
  const complete =
    !failed && d.arrived === d.requested && d.running === 0 && d.waiting === 0;
  const sum = (
      field:
        | "routeLengthMeters"
        | "durationSeconds"
        | "timeLossSeconds"
        | "departDelaySeconds",
    ) => arrived.reduce((n, t) => n + t[field]!, 0),
    known =
      (result.trips.length === d.requested && measurement.length === 0) ||
      arrived.length > 0;
  const subtotal = {
    vehicleKilometers: known ? sum("routeLengthMeters") / 1000 : null,
    vehicleHours: known ? sum("durationSeconds") / 3600 : null,
    meanTravelTimeSeconds: arrived.length
      ? sum("durationSeconds") / arrived.length
      : null,
    meanTimeLossSeconds: arrived.length
      ? sum("timeLossSeconds") / arrived.length
      : null,
    meanDepartureDelaySeconds: arrived.length
      ? sum("departDelaySeconds") / arrived.length
      : null,
  };
  return {
    status: failed ? "failed" : complete ? "complete" : "incomplete",
    requested: d.requested,
    completed: allArrived.length,
    incomplete: Math.max(0, d.requested - allArrived.length),
    completionFraction: d.requested ? allArrived.length / d.requested : null,
    measurementRequested:
      result.trips.length === d.requested ? measurement.length : null,
    measurementCompleted: arrived.length,
    meanTravelTimeSeconds: complete ? subtotal.meanTravelTimeSeconds : null,
    meanTimeLossSeconds: complete ? subtotal.meanTimeLossSeconds : null,
    meanDepartureDelaySeconds: complete
      ? subtotal.meanDepartureDelaySeconds
      : null,
    vehicleKilometers: complete ? subtotal.vehicleKilometers : null,
    vehicleHours: complete ? subtotal.vehicleHours : null,
    completedSubtotal: subtotal,
    reasons,
    notes: [
      "Trip measures use vehicles whose requested departure falls inside the analysis window; warmup departures are excluded. Diagnostics retain every admitted vehicle. These are simulations, not observed commutes or daily totals.",
      "SUMO timeLoss is travel below the vehicle's ideal speed; it is not HCM intersection control delay or a level-of-service grade.",
      "Incomplete runs retain explicitly censored completed-trip subtotals, never a complete travel-time estimate.",
    ],
  };
}
export async function compareTrafficRuns(
  baseline: TrafficSimulationResult,
  proposal: TrafficSimulationResult,
  recipe: TrafficPairRecipe,
): Promise<TrafficComparison> {
  const recipeHash = await trafficPairRecipeHash(recipe);
  for (const [side, result, network] of [
    ["baseline", baseline, recipe.baselineNetworkHash],
    ["proposal", proposal, recipe.proposalNetworkHash],
  ] as const) {
    if (
      result.side !== side ||
      result.recipeHash !== recipeHash ||
      result.networkHash !== network ||
      result.demandHash !== recipe.demandHash ||
      result.seed !== recipe.seed ||
      (await trafficContentHash(result.period)) !==
        (await trafficContentHash(recipe.period))
    )
      throw new Error(
        "Traffic comparison requires the exact paired network, original demand, seed, period, and settings recipe.",
      );
  }
  const baselineTrips = new Map(
    baseline.trips.map((trip) => [trip.id, trip.requestedDepartSeconds]),
  );
  if (
    baseline.diagnostics.requested !== proposal.diagnostics.requested ||
    baseline.trips.length !== proposal.trips.length ||
    proposal.trips.some(
      (trip) => baselineTrips.get(trip.id) !== trip.requestedDepartSeconds,
    )
  )
    throw new Error(
      "Paired traffic runs must retain the same requested vehicle identities and departure times; rerouting cannot remove or reschedule demand.",
    );
  const before = summarizeTrafficRun(baseline),
    after = summarizeTrafficRun(proposal),
    difference = (key: keyof TrafficComparison["delta"]) =>
      before[key] === null || after[key] === null
        ? null
        : after[key]! - before[key]!;
  return {
    methodVersion: TRAFFIC_METHOD_VERSION,
    recipeHash,
    baseline: before,
    proposal: after,
    delta: {
      meanTravelTimeSeconds: difference("meanTravelTimeSeconds"),
      meanTimeLossSeconds: difference("meanTimeLossSeconds"),
      meanDepartureDelaySeconds: difference("meanDepartureDelaySeconds"),
      vehicleKilometers: difference("vehicleKilometers"),
      vehicleHours: difference("vehicleHours"),
    },
    notes: [
      "Both captures use the same original one-way demand, vehicle classes, departure window, and seed. Assigned routes may differ; their hashes are retained independently.",
      "A completed comparison is not evidence of calibration. Count fit, held-out performance and network/control assumptions must be reviewed separately.",
    ],
  };
}

export type {
  TrafficCalibrationRow,
  TrafficCalibrationGroup,
  TrafficCalibrationResult,
  TrafficRunSummary,
  TrafficComparison,
} from "@urban/core";
