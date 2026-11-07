import {
  MAX_TRAFFIC_COUNTS,
  trafficCalibrationPlanSchema,
  trafficPeriodSchema,
  validateTrafficClock,
  type TrafficCalibrationPlan,
  type TrafficCount,
  type TrafficCountPack,
  type TrafficNetwork,
  type TrafficPeriod,
} from "@urban/core";

export type TrafficCalibrationSelectionRole =
  | "calibration"
  | "holdout"
  | "unassigned"
  | "conflict";
export interface TrafficCalibrationSelectionRow {
  countId: string;
  groupKey: string;
  role: TrafficCalibrationSelectionRole;
  eligible: boolean;
  reasons: string[];
}
export interface TrafficCalibrationSelectionGroup {
  key: string;
  stationId: string;
  direction: string;
  date: string;
  stationIds: string[];
  directions: string[];
  countIds: string[];
  eligibleCountIds: string[];
  selectedCountIds: string[];
  role: TrafficCalibrationSelectionRole;
}
export interface TrafficCalibrationSelection {
  /** Admission validity only: this never means observed count fit passed. */
  valid: boolean;
  rows: TrafficCalibrationSelectionRow[];
  groups: TrafficCalibrationSelectionGroup[];
  errors: string[];
  warnings: string[];
}
export interface TrafficCalibrationSelectionContext {
  /** UI-only locally reviewed targets awaiting server stamps. This can only
   * merge alias groups conservatively; it never makes a count eligible. */
  pendingMappingCountIds?: readonly string[];
}

const normalized = (value: string) => value.trim().toUpperCase();
const directionOf = (count: TrafficCount) => {
  const direction = normalized(count.raw.directionCode);
  // FHWA volume codes 0 and 9 combine directions. Treat all combined/unknown
  // labels conservatively without rewriting the retained raw direction code.
  return [
    "",
    "UNKNOWN",
    "UNSPECIFIED",
    "BOTH",
    "ALL",
    "0",
    "9",
    "N/A",
  ].includes(direction)
    ? ""
    : direction;
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqueSorted = (values: string[]) => [...new Set(values)].sort(compare);

/** Source IDs, lanes, classes and hours cannot create independent station groups.
 * This is the base key; group inventory can merge keys for physical-target aliases.
 * Leading zeroes/suffixes are retained: similar station names are not proof of identity. */
export function trafficCalibrationGroupKey(count: TrafficCount): string {
  return JSON.stringify([
    "station-direction-day-v1",
    normalized(count.stationId),
    directionOf(count),
    count.date,
  ]);
}

/** Exact clock identity, with no partial interval clipping or time-zone alias substitution. */
export function trafficCountInPeriod(
  count: TrafficCount,
  period: TrafficPeriod,
): boolean {
  return (
    count.date === period.date &&
    count.timeZone === period.timeZone &&
    count.utcOffsetMinutes === period.utcOffsetMinutes &&
    Number.isSafeInteger(count.beginSeconds) &&
    Number.isSafeInteger(count.endSeconds) &&
    count.beginSeconds >= 0 &&
    count.endSeconds <= 86400 &&
    count.endSeconds > count.beginSeconds &&
    count.beginSeconds >= period.beginSeconds &&
    count.endSeconds <= period.endSeconds
  );
}

function networkIndex(network: TrafficNetwork) {
  return {
    edges: new Map(network.edges.map((edge) => [edge.id, edge])),
    connections: new Map(network.connections.map((turn) => [turn.id, turn])),
  };
}
type NetworkIndex = ReturnType<typeof networkIndex>;
function targetProblem(
  count: TrafficCount,
  index: NetworkIndex,
): string | null {
  if (!count.target) return "Count has no network target.";
  if (count.target.kind === "turn")
    return index.connections.has(count.target.connectionId)
      ? null
      : "Mapped movement is absent from this network.";
  const edge = index.edges.get(count.target.edgeId);
  if (!edge) return "Mapped edge is absent from this network.";
  const fraction = count.target.positionFraction;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    return "Detector position along the edge is invalid.";
  const lanes = count.target.laneIds;
  if (
    lanes &&
    (!lanes.length ||
      new Set(lanes).size !== lanes.length ||
      lanes.some((id) => !edge.lanes.some((lane) => lane.id === id)))
  )
    return "Mapped lane selection is invalid for this edge.";
  return null;
}

function reasonsFor(
  count: TrafficCount,
  network: TrafficNetwork,
  index: NetworkIndex,
  period: TrafficPeriod,
): string[] {
  const reasons: string[] = [];
  if (count.status !== "available" || count.value === null)
    reasons.push(`Source observation is ${count.status}.`);
  else if (!Number.isSafeInteger(count.value) || count.value < 0)
    reasons.push("Observed interval count must be nonnegative whole vehicles.");
  if (count.kind !== "observed")
    reasons.push("Factored estimates are not observed interval counts.");
  if (!count.vehicleClasses?.length)
    reasons.push("Vehicle-class coverage has not been reviewed.");
  const target = targetProblem(count, index);
  if (target) reasons.push(target);
  if (!count.mapping) reasons.push("Network mapping review is pending.");
  else if (
    count.mapping.networkFileSha256 !== network.manifest.networkFileSha256
  )
    reasons.push("Network mapping belongs to a different graph.");
  if (!trafficCountInPeriod(count, period))
    reasons.push(
      "Count does not match the exact analysis date, clock, or complete window.",
    );
  return reasons;
}

/** Period inventory for whole-group UI assignment. Conservative alias unions prevent
 * changing a source ID, lane/class or detector position on one directed edge from
 * manufacturing a held-out station. These groups do not prove independence. */
export function trafficCalibrationSelectionGroups(
  pack: TrafficCountPack,
  network: TrafficNetwork,
  period: TrafficPeriod,
  context: TrafficCalibrationSelectionContext = {},
): TrafficCalibrationSelectionGroup[] {
  if (pack.counts.length > MAX_TRAFFIC_COUNTS)
    throw new Error("Traffic selection exceeds the retained-count limit.");
  const counts = pack.counts.filter((count) =>
    trafficCountInPeriod(count, period),
  );
  const index = networkIndex(network);
  const pending = new Set(context.pendingMappingCountIds ?? []);
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    let current = key;
    while (parent.get(current) !== current) current = parent.get(current)!;
    while (key !== current) {
      const next = parent.get(key)!;
      parent.set(key, current);
      key = next;
    }
    return current;
  };
  const join = (a: string, b: string) => {
    a = root(a);
    b = root(b);
    if (a !== b)
      parent.set(compare(a, b) < 0 ? b : a, compare(a, b) < 0 ? a : b);
  };
  const stations = new Map<string, { unknown?: string; keys: string[] }>();
  const targets = new Map<string, string>();
  for (const count of counts) {
    const key = trafficCalibrationGroupKey(count);
    if (!parent.has(key)) parent.set(key, key);
    const stationKey = JSON.stringify([
      normalized(count.stationId),
      count.date,
    ]);
    const station = stations.get(stationKey) ?? { keys: [] };
    station.keys.push(key);
    if (!directionOf(count)) station.unknown = key;
    stations.set(stationKey, station);
    // Current server reviews or explicit local reviews can conservatively merge
    // aliases. Pending local review does not change reasonsFor/eligibility.
    if (
      (count.mapping?.networkFileSha256 ===
        network.manifest.networkFileSha256 ||
        pending.has(count.id)) &&
      !targetProblem(count, index)
    ) {
      const edgeId =
        count.target!.kind === "edge"
          ? count.target!.edgeId
          : index.connections.get(count.target!.connectionId)!.fromEdge;
      const physicalKey = JSON.stringify([count.date, edgeId]);
      const other = targets.get(physicalKey);
      if (other) join(key, other);
      else targets.set(physicalKey, key);
    }
  }
  for (const station of stations.values())
    if (station.unknown)
      for (const key of station.keys) join(station.unknown, key);
  const grouped = new Map<string, TrafficCount[]>();
  for (const count of counts) {
    const key = root(trafficCalibrationGroupKey(count));
    const group = grouped.get(key) ?? [];
    group.push(count);
    grouped.set(key, group);
  }
  return [...grouped]
    .sort(([a], [b]) => compare(a, b))
    .map(([key, rows]) => {
      const stationIds = uniqueSorted(rows.map((row) => row.stationId));
      const directions = uniqueSorted(rows.map(directionOf));
      return {
        key,
        stationId: stationIds.join(" / "),
        direction: directions
          .map((direction) => direction || "Unknown or combined")
          .join(" / "),
        date: rows[0].date,
        stationIds,
        directions,
        countIds: uniqueSorted(rows.map((row) => row.id)),
        eligibleCountIds: uniqueSorted(
          rows
            .filter((row) => !reasonsFor(row, network, index, period).length)
            .map((row) => row.id),
        ),
        selectedCountIds: [],
        role: "unassigned",
      };
    });
}

function overlapping(a: TrafficCount, b: TrafficCount): boolean {
  if (!a.target || !b.target || a.target.kind !== b.target.kind) return false;
  if (!a.vehicleClasses?.some((value) => b.vehicleClasses?.includes(value)))
    return false;
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

/** New-plan authoring/admission only. Tolerates pending mapping reviews in UI
 * drafts; authoritative count-pack/schema validation remains the server's job.
 * No predictions are invented, and legacy evaluator/replay semantics are unchanged. */
export function inspectTrafficCalibrationSelection(
  pack: TrafficCountPack,
  plan: TrafficCalibrationPlan,
  network: TrafficNetwork,
  period: TrafficPeriod,
  context: TrafficCalibrationSelectionContext = {},
): TrafficCalibrationSelection {
  const errors: string[] = [],
    warnings: string[] = [
      "Groups prevent known station/direction/day and reviewed-target overlap between roles; user-declared holdout groups are not proof of statistical independence.",
      "This selects baseline count checks. It performs no automatic fitting and does not validate OD purposes, travel times, queues, or LOS.",
    ];
  const empty = (): TrafficCalibrationSelection => ({
    valid: false,
    rows: [],
    groups: [],
    errors,
    warnings,
  });
  const parsedPlan = trafficCalibrationPlanSchema.safeParse(plan);
  if (!parsedPlan.success) {
    errors.push(
      ...parsedPlan.error.issues.map(
        (issue) => `Plan ${issue.path.join(".")}: ${issue.message}`,
      ),
    );
    return empty();
  }
  const parsedPeriod = trafficPeriodSchema.safeParse(period);
  if (!parsedPeriod.success) {
    errors.push(
      ...parsedPeriod.error.issues.map(
        (issue) => `Period ${issue.path.join(".")}: ${issue.message}`,
      ),
    );
    return empty();
  }
  if (pack.counts.length > MAX_TRAFFIC_COUNTS) {
    errors.push("Traffic selection exceeds the retained-count limit.");
    return empty();
  }
  if (!plan.description.trim())
    errors.push(
      "Describe the retained acceptance criteria and their intended count-check scope.",
    );
  const sources = new Map<string, number>();
  for (const source of pack.sources)
    sources.set(source.id, (sources.get(source.id) ?? 0) + 1);
  for (const id of plan.sourceIds)
    if (sources.get(id) !== 1)
      errors.push(
        `Criteria source ${id} must resolve to one retained count-pack source.`,
      );
  const counts = new Map<string, TrafficCount>();
  for (const count of pack.counts) {
    if (counts.has(count.id))
      errors.push(`Duplicate retained count identity ${count.id}.`);
    counts.set(count.id, count);
  }
  const calibration = new Set(plan.calibrationCountIds),
    holdout = new Set(plan.holdoutCountIds);
  const requested = [...plan.calibrationCountIds, ...plan.holdoutCountIds];
  if (new Set(requested).size !== requested.length)
    errors.push(
      "Calibration and holdout count identities must be unique and disjoint.",
    );
  for (const id of new Set(requested)) {
    const count = counts.get(id);
    if (!count) {
      errors.push(`Unknown selected count ${id}.`);
      continue;
    }
    if (!trafficCountInPeriod(count, period))
      errors.push(
        `Selected count ${id} must match the exact date, IANA clock, fixed offset, and lie wholly inside the analysis window.`,
      );
    if (
      Number.isSafeInteger(count.beginSeconds) &&
      Number.isSafeInteger(count.endSeconds) &&
      count.beginSeconds >= 0 &&
      count.endSeconds <= 86400 &&
      Number.isSafeInteger(count.utcOffsetMinutes) &&
      Math.abs(count.utcOffsetMinutes) <= 840
    ) {
      try {
        validateTrafficClock(count);
      } catch {
        errors.push(
          `Selected count ${id} has an invalid or changing fixed-offset clock.`,
        );
      }
    }
  }
  const roleFor = (id: string): TrafficCalibrationSelectionRole =>
    calibration.has(id)
      ? holdout.has(id)
        ? "conflict"
        : "calibration"
      : holdout.has(id)
        ? "holdout"
        : "unassigned";
  const groups = trafficCalibrationSelectionGroups(
    pack,
    network,
    period,
    context,
  );
  const groupFor = new Map<string, string>();
  for (const group of groups) {
    group.countIds.forEach((id) => groupFor.set(id, group.key));
    group.selectedCountIds = group.countIds.filter(
      (id) => calibration.has(id) || holdout.has(id),
    );
    const training = group.countIds.some((id) => calibration.has(id));
    const held = group.countIds.some((id) => holdout.has(id));
    group.role =
      training && held
        ? "conflict"
        : training
          ? "calibration"
          : held
            ? "holdout"
            : "unassigned";
    if (group.role === "conflict")
      errors.push(
        `Station/direction/day group ${group.stationId} (${group.direction}, ${group.date}) cannot be split between calibration and holdout, including adjacent intervals, lanes, classes, or reviewed target aliases.`,
      );
  }
  const index = networkIndex(network);
  const rows = pack.counts
    .filter(
      (count) =>
        trafficCountInPeriod(count, period) ||
        calibration.has(count.id) ||
        holdout.has(count.id),
    )
    .map((count) => {
      const reasons = reasonsFor(count, network, index, period);
      return {
        countId: count.id,
        groupKey: groupFor.get(count.id) ?? trafficCalibrationGroupKey(count),
        role: roleFor(count.id),
        eligible: !reasons.length,
        reasons,
      };
    })
    .sort((a, b) => compare(a.countId, b.countId));
  for (const role of ["calibration", "holdout"] as const) {
    const selected = rows.filter((row) => row.role === role);
    const eligible = selected.filter((row) => row.eligible).length;
    const minimum =
      role === "calibration"
        ? plan.criteria.minimumCalibrationCounts
        : plan.criteria.minimumHoldoutCounts;
    if (eligible < minimum || eligible !== selected.length)
      warnings.push(
        `${role}: ${eligible} of ${selected.length} selected observations are eligible; minimum ${minimum}. Incomplete evidence cannot yield a passing count check.`,
      );
  }
  const buckets = new Map<string, TrafficCount[]>();
  let comparisons = 0;
  for (const count of [...new Set(requested)]
    .map((id) => counts.get(id))
    .filter(
      (count): count is TrafficCount =>
        !!count && trafficCountInPeriod(count, period),
    )
    .sort((a, b) => a.beginSeconds - b.beginSeconds)) {
    if (!count.target) continue;
    const key =
      count.target.kind === "edge"
        ? JSON.stringify([
            "edge",
            count.target.edgeId,
            count.target.positionFraction,
          ])
        : JSON.stringify(["turn", count.target.connectionId]);
    const prior = (buckets.get(key) ?? []).filter(
      (other) => other.endSeconds > count.beginSeconds,
    );
    for (const other of prior) {
      if (++comparisons > 1_000_000) {
        errors.push(
          "Selected count overlap checks exceed the bounded comparison limit; reduce redundant constraints without deleting retained evidence.",
        );
        return { valid: false, rows, groups, errors, warnings };
      }
      if (overlapping(count, other)) {
        errors.push(
          `Selected counts ${other.id} and ${count.id} overlap in time, physical target, lanes and vehicle classes.`,
        );
        return {
          valid: false,
          rows,
          groups,
          errors: [...new Set(errors)],
          warnings,
        };
      }
    }
    prior.push(count);
    buckets.set(key, prior);
  }
  return {
    valid: !errors.length,
    rows,
    groups,
    errors: [...new Set(errors)],
    warnings,
  };
}
