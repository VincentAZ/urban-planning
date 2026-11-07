import {
  aggregateBuildingQuantity,
  quantityProduct,
  quantityDifference,
  quantitySum,
} from "@urban/core";
import {
  USER_ACTIVITY_SOURCE,
  validateActivityScenario,
  buildingGeometry,
  buildingProgramTotals,
  geometryIntersectionAreaSqm,
  materializeBuildings,
  studyAreaBounds,
  studyAreaGeometry,
  studyAreaSqm,
  type ActivityScenario,
  type ActivityReferenceChoice,
  type ActivityNeighborhood,
  type CountTarget,
  type Building,
  type Place,
  type Scenario,
  type VehicleAvailability,
} from "@urban/core";

export interface ActivityCountResolution {
  reference: number | null;
  baseline: number | null;
  natural: number | null;
  beforeAreas: number | null;
  value: number | null;
  delta: number | null;
  referenceLabel: string;
  status: "ready" | "incomplete" | "unavailable";
  sourceIds: string[];
  notes: string[];
}
export interface ActivityNeighborhoodResolution {
  id: string;
  name: string;
  areaSqm: number;
  population: ActivityCountResolution;
  employment: ActivityCountResolution;
}
export interface ActivityResolution {
  population: ActivityCountResolution;
  employment: ActivityCountResolution;
  vehicles: ActivityCountResolution;
  neighborhoods: ActivityNeighborhoodResolution[];
  unallocated: { population: number | null; employment: number | null };
  warnings: string[];
  buildingFactors: Record<
    string,
    { population: number | null; employment: number | null }
  >;
  vehicleDemandFactor: number | null;
  /** A positive target has no corresponding building quantity to carry its proportional demand. */
  unmappedDemand: { population: boolean; employment: boolean };
}
export class ActivityResolutionError extends Error {
  readonly code = "ACTIVITY_COMPLEXITY";
}
type Dimension = "population" | "employment";
export type ActivityPresetInput =
  | { kind: "population-plus-25" }
  | { kind: "regional-forecast-10" }
  | {
      kind: "plant-closure";
      neighborhoodId: string;
      jobsRemoved: number;
      currentEmployment: number;
    };
const unique = (ids: string[]) => [...new Set(ids)];
const nullable = (value: number | null) =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : null;
export function activityTargetValue(
  target: CountTarget | undefined,
  reference: number | null,
  fallback: number | null,
): number | null {
  if (!target) return fallback;
  return target.mode === "absolute"
    ? target.value
    : reference === null
      ? null
      : (reference * target.percent) / 100;
}
export function matchingActivityPopulation(place: Place) {
  const p = place.demographics;
  return p &&
    place.geography?.type === "zcta" &&
    place.geography.code === p.geography.id &&
    place.zip === p.geography.id &&
    p.geography.relationshipToStudyArea === "same-area" &&
    p.measures.population.estimate.status === "available"
    ? p
    : null;
}
export function matchingActivityVehicles(
  place: Place,
  supplement?: VehicleAvailability,
) {
  const p = supplement ?? place.vehicleAvailability;
  return p &&
    place.geography?.type === "zcta" &&
    place.geography.code === p.geography.id &&
    place.zip === p.geography.id &&
    place.geography.boundaryVintage === p.geography.boundaryVintage &&
    p.geography.relationshipToStudyArea === "same-area" &&
    p.measure.estimate.status === "available"
    ? p
    : null;
}
function physical(buildings: Building[], a: Scenario["assumptions"]) {
  const units = aggregateBuildingQuantity(
      buildings,
      (b) => buildingProgramTotals(b).units,
    ),
    jobs = aggregateBuildingQuantity(
      buildings,
      (b) => buildingProgramTotals(b).jobs,
    );
  return {
    units: units.value,
    jobs: jobs.value,
    population: quantityProduct(
      units.value,
      1 - a.vacancyRate,
      a.householdSize,
    ),
    coverage: { units, jobs },
  };
}
function physicalDelta(
  before: Building[],
  after: Building[],
  dimension: Dimension,
  a: Scenario["assumptions"],
  b: Scenario["assumptions"],
) {
  const oldPhysical = physical(before, b),
    nextPhysical = physical(after, a);
  const oldValue =
      dimension === "employment" ? oldPhysical.jobs : oldPhysical.population,
    nextValue =
      dimension === "employment" ? nextPhysical.jobs : nextPhysical.population;
  if (oldValue !== null && nextValue !== null) return nextValue - oldValue;
  const old = new Map(before.map((x) => [x.id, x])),
    next = new Map(after.map((x) => [x.id, x]));
  let delta = 0;
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const left = old.get(id),
      right = next.get(id);
    if (
      left &&
      right &&
      (dimension === "employment"
        ? buildingProgramTotals(left).jobs === buildingProgramTotals(right).jobs
        : buildingProgramTotals(left).units ===
            buildingProgramTotals(right).units &&
          a.vacancyRate === b.vacancyRate &&
          a.householdSize === b.householdSize)
    )
      continue;
    const value = (
      building: Building | undefined,
      assumptions: Scenario["assumptions"],
    ) =>
      !building
        ? 0
        : dimension === "employment"
          ? buildingProgramTotals(building).jobs
          : quantityProduct(
              buildingProgramTotals(building).units,
              1 - assumptions.vacancyRate,
              assumptions.householdSize,
            );
    const change = quantityDifference(value(right, a), value(left, b));
    if (change === null) return null;
    delta += change;
  }
  return delta;
}

function reference(
  place: Place,
  scenario: Scenario,
  activity: ActivityScenario,
  dimension: Dimension | "vehicles",
) {
  const choice = activity.reference[dimension];
  const ref = {
    value: null as number | null,
    label: "No matching reference supplied",
    sourceIds: [] as string[],
    notes: [] as string[],
  };
  if (!choice) return ref;
  if (choice.kind === "entered")
    return {
      value: choice.value,
      label: `User-entered ${choice.asOfYear} reference: ${choice.universe}`,
      sourceIds: [choice.sourceId],
      notes: ["An entered reference is not independently verified."],
    };
  if (choice.kind === "building-derived") {
    const counts = physical(place.buildings, scenario.baselineAssumptions);
    return {
      value:
        dimension === "population"
          ? counts.population
          : dimension === "employment"
            ? counts.jobs
            : null,
      label:
        dimension === "population"
          ? "Housing-supported resident reference"
          : "Entered or estimated building-job reference",
      sourceIds: unique(
        place.buildings.flatMap((b) => [
          b.sourceId,
          ...(b.attributeSourceId ? [b.attributeSourceId] : []),
          ...(b.programSourceId ? [b.programSourceId] : []),
          ...Object.values(b.attributeProvenance?.fields ?? {}).flatMap((e) =>
            e ? [e.sourceId] : [],
          ),
        ]),
      ),
      notes: [
        "Building programs are capacity or entered estimates; they do not establish observed residents or occupied jobs.",
        ...((dimension === "population" ? counts.population : counts.jobs) ===
        null
          ? [
              "Required building quantities are unknown; known rows are not silently renormalized into a complete reference.",
            ]
          : []),
      ],
    };
  }
  if (dimension === "population") {
    const p = matchingActivityPopulation(place);
    return p
      ? {
          value: p.measures.population.estimate.value,
          label: `ACS ${p.period.start}–${p.period.end}, whole ZCTA ${p.geography.id}`,
          sourceIds: [p.source.id],
          notes: [
            "Published historical population estimate; not a current-year count. Its margin of error is not propagated into scenario results.",
          ],
        }
      : ref;
  }
  if (dimension === "vehicles") {
    const p = matchingActivityVehicles(place, activity.vehicleReference);
    return p
      ? {
          value: p.measure.estimate.value,
          label: `ACS ${p.period.start}–${p.period.end} household vehicles available, whole ZCTA ${p.geography.id}`,
          sourceIds: [p.source.id],
          notes: [
            "Vehicles available to occupied housing units, not registered fleet, roadway counts, daily trips or visible agents. Published sampling uncertainty is not propagated.",
          ],
        }
      : ref;
  }
  return ref;
}

/** Explicit adoption changes no Place/building data. Existing sensitivity targets are previewed as counts. */
export function adoptActivityScenario(
  place: Place,
  scenario: Scenario,
): ActivityScenario {
  const a = scenario.assumptions,
    b = scenario.baselineAssumptions;
  const before = physical(place.buildings, b),
    next = physical(materializeBuildings(place, scenario), a);
  const published = matchingActivityPopulation(place);
  const p = published?.measures.population.estimate.value ?? before.population;
  const growth = (1 + a.annualGrowthRate) ** scenario.horizon;
  const population = quantityProduct(
      p !== null && next.population !== null && before.population !== null
        ? p + next.population - before.population
        : quantitySum(
            p,
            physicalDelta(
              place.buildings,
              materializeBuildings(place, scenario),
              "population",
              a,
              b,
            ),
          ),
      a.populationMultiplier,
      growth,
    ),
    employment = quantityProduct(next.jobs, growth);
  return {
    version: 1,
    reference: {
      population: { kind: published ? "published" : "building-derived" },
      employment: { kind: "building-derived" },
      ...(matchingActivityVehicles(place)
        ? { vehicles: { kind: "published" as const } }
        : {}),
    },
    allocation: {
      population: "building-weighted",
      employment: "building-weighted",
    },
    global: {
      ...(population === null
        ? {}
        : {
            population: {
              mode: "absolute" as const,
              value: Math.max(0, population),
            },
          }),
      ...(employment === null
        ? {}
        : { employment: { mode: "absolute" as const, value: employment } }),
    },
    neighborhoods: [],
    demandResponse: {
      population: "none",
      employment: "none",
      vehicles: "none",
      reviewed: false,
      sourceId: USER_ACTIVITY_SOURCE.id,
    },
  };
}

export function applyActivityPreset(
  activity: ActivityScenario,
  preset: ActivityPresetInput,
): ActivityScenario {
  const next = structuredClone(activity),
    sourceId = USER_ACTIVITY_SOURCE.id,
    appliedAt = new Date().toISOString();
  if (preset.kind === "population-plus-25")
    next.global.population = { mode: "baseline-percent", percent: 125 };
  if (preset.kind === "regional-forecast-10") {
    const f = next.forecast;
    if (!f || f.targetYear - f.baseYear !== 10)
      throw new Error(
        "Supply an explicitly sourced ten-year forecast before applying this preset.",
      );
    for (const key of [
      "population",
      "employment",
      "householdVehicles",
    ] as const) {
      const v = f[key];
      if (v)
        next.global[key] =
          f.application === "matching-area-totals"
            ? { mode: "absolute", value: v.target }
            : {
                mode: "baseline-percent",
                percent: (v.target / v.baseline) * 100,
              };
    }
    next.preset = { kind: preset.kind, sourceId: f.sourceId, appliedAt };
    return next;
  }
  if (preset.kind === "plant-closure") {
    const n = next.neighborhoods.find((n) => n.id === preset.neighborhoodId);
    if (
      !n ||
      !Number.isFinite(preset.currentEmployment) ||
      !Number.isFinite(preset.jobsRemoved) ||
      preset.currentEmployment < 0 ||
      preset.jobsRemoved < 0 ||
      preset.jobsRemoved > preset.currentEmployment
    )
      throw new Error(
        "Select a neighborhood with a known job count and enter no more jobs removed than it contains.",
      );
    n.employment = {
      mode: "absolute",
      value: preset.currentEmployment - preset.jobsRemoved,
    };
    next.preset = {
      kind: preset.kind,
      sourceId,
      appliedAt,
      neighborhoodId: n.id,
      jobsRemoved: preset.jobsRemoved,
    };
    return next;
  }
  next.preset = { kind: preset.kind, sourceId, appliedAt };
  return next;
}

const overlap = (a: readonly number[], b: readonly number[]) =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const geometryCache = new WeakMap<
  Building,
  { key: string; fractions: number[] }
>();
/** Per-building fractions use one common local plane. Distinct overlapping source buildings retain separate entered programs. */
function buildingFractions(
  buildings: Building[],
  regions: ActivityNeighborhood[],
  key: string,
) {
  const boxes = regions.map((n) => studyAreaBounds(n.geometry));
  const out = new Map<Building, number[]>();
  for (const b of buildings) {
    const cached = geometryCache.get(b);
    if (cached?.key === key) {
      out.set(b, cached.fractions);
      continue;
    }
    const g = buildingGeometry(b),
      box = studyAreaBounds(g);
    let area: number | undefined;
    const fractions = regions.map((n, i) => {
      if (!overlap(box, boxes[i])) return 0;
      area ??= geometryIntersectionAreaSqm(g, g);
      return area > 0
        ? Math.max(
            0,
            Math.min(1, geometryIntersectionAreaSqm(g, n.geometry) / area),
          )
        : 0;
    });
    if (fractions.reduce((s, v) => s + v, 0) > 1 + 1e-7)
      throw new Error(
        "Neighborhood allocation overlaps exceed the whole building weight.",
      );
    geometryCache.set(b, { key, fractions });
    out.set(b, fractions);
  }
  return out;
}
function weights(
  buildings: Building[],
  fractions: Map<Building, number[]>,
  regions: ActivityNeighborhood[],
  dimension: Dimension,
  method: ActivityScenario["allocation"][Dimension],
  place: Place,
) {
  if (method === "unallocated") return null;
  if (method === "uniform-area") {
    const g = studyAreaGeometry(place),
      total = geometryIntersectionAreaSqm(g, g);
    return total > 0
      ? regions.map((n) => geometryIntersectionAreaSqm(g, n.geometry) / total)
      : null;
  }
  let total = 0;
  const values = regions.map(() => 0);
  for (const b of buildings) {
    const p = buildingProgramTotals(b),
      value = dimension === "population" ? p.units : p.jobs;
    if (value === null) return null;
    total += value;
    fractions.get(b)!.forEach((f, i) => (values[i] += value * f));
  }
  return total > 0 ? values.map((v) => v / total) : null;
}
const scale = (n: number | null, f: number | null) =>
  n === null || f === null ? null : n * f;
const ratio = (target: number | null, basis: number | null) =>
  // A reviewed zero-activity choice explicitly removes its eligible demand;
  // it does not assert a calibrated elasticity for a zero/unknown reference.
  target === 0
    ? 0
    : target === null || basis === null || basis <= 0
      ? null
      : target / basis;
/** Deterministic compensated accumulation avoids cancellation and input-order drift. */
function sumNonnegative(values: readonly number[]) {
  let sum = 0,
    correction = 0;
  for (const value of [...values].sort((a, b) => a - b)) {
    const adjusted = value - correction,
      next = sum + adjusted;
    correction = next - sum - adjusted;
    sum = next;
  }
  return sum;
}
function remainingWeight(values: readonly number[]) {
  const used = sumNonnegative(values);
  // Validated disjoint weights cannot exceed one. Only correct an accumulated
  // floating-point overshoot; a positive uncovered remainder is never erased.
  const floatingBound = 8 * Number.EPSILON * Math.max(1, values.length);
  if (used > 1 + floatingBound)
    throw new Error(
      "Neighborhood allocation exceeds the available whole-study weight.",
    );
  return used > 1 ? 0 : 1 - used;
}
function result(
  ref: ReturnType<typeof reference>,
  baseline: number | null,
  natural: number | null,
  beforeAreas: number | null,
  value: number | null,
  notes: string[] = [],
): ActivityCountResolution {
  return {
    reference: ref.value,
    baseline,
    natural,
    beforeAreas,
    value,
    delta: value === null || baseline === null ? null : value - baseline,
    referenceLabel: ref.label,
    status:
      value === null
        ? "unavailable"
        : baseline === null
          ? "incomplete"
          : "ready",
    sourceIds: ref.sourceIds,
    notes: [...ref.notes, ...notes],
  };
}
export function resolveActivity(
  place: Place,
  scenario: Scenario,
): ActivityResolution {
  const activity = scenario.activity ?? adoptActivityScenario(place, scenario);
  validateActivityScenario(activity, place);
  const regions = activity.neighborhoods,
    buildings = materializeBuildings(place, scenario);
  const key = JSON.stringify(regions.map((n) => n.geometry)),
    boxes = regions.map((n) => studyAreaBounds(n.geometry));
  // Admission is independent of cache warmth and checks both captured and changed geometry before expensive clipping.
  let candidateCount = 0;
  for (const b of new Set([...place.buildings, ...buildings])) {
    const box = studyAreaBounds(buildingGeometry(b));
    for (const region of boxes)
      if (overlap(box, region) && ++candidateCount > 50000)
        throw new ActivityResolutionError(
          "Neighborhood allocation exceeds 50,000 spatial candidates. Use fewer or smaller neighborhoods; no building weights were discarded.",
        );
  }
  const baseFractions = buildingFractions(place.buildings, regions, key),
    nextFractions = buildingFractions(buildings, regions, key);
  const before = physical(place.buildings, scenario.baselineAssumptions),
    next = physical(buildings, scenario.assumptions);
  const growth =
      (1 + scenario.assumptions.annualGrowthRate) ** scenario.horizon,
    baseGrowth =
      (1 + scenario.baselineAssumptions.annualGrowthRate) ** scenario.horizon;
  const warnings = [
    "Neighborhood counts are modeled allocations, not observed neighborhood demographics. Painted areas replace their own counts only; the rest of the study area is not rebalanced.",
    "Targets apply at the selected horizon and are not grown again. Building homes, jobs, floor area, parking supply and assessed values remain unchanged.",
  ];
  const neighborhoodRows = regions.map((n) => ({
    id: n.id,
    name: n.name,
    areaSqm: studyAreaSqm(n.geometry),
  })) as ActivityNeighborhoodResolution[];
  const buildingFactors: ActivityResolution["buildingFactors"] = {};
  for (const b of buildings)
    Object.defineProperty(buildingFactors, b.id, {
      value: { population: 1, employment: 1 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  const resolved = {} as Record<Dimension, ActivityCountResolution>;
  const unallocated = {
    population: null as number | null,
    employment: null as number | null,
  };
  const unmappedDemand = { population: false, employment: false };
  for (const dimension of ["population", "employment"] as const) {
    const ref = reference(place, scenario, activity, dimension),
      baseline = scale(ref.value, baseGrowth);
    const delta = physicalDelta(
      place.buildings,
      buildings,
      dimension,
      scenario.assumptions,
      scenario.baselineAssumptions,
    );
    const natural =
      ref.value === null || delta === null
        ? null
        : nullable((ref.value + delta) * growth);
    const defaultValue = scale(
      natural,
      dimension === "population"
        ? scenario.assumptions.populationMultiplier
        : 1,
    );
    const global = activityTargetValue(
      activity.global[dimension],
      ref.value,
      defaultValue,
    );
    const baseWeights = weights(
        place.buildings,
        baseFractions,
        regions,
        dimension,
        activity.allocation[dimension],
        place,
      ),
      nextWeights = weights(
        buildings,
        nextFractions,
        regions,
        dimension,
        activity.allocation[dimension],
        place,
      );
    const demandWeights =
      activity.allocation[dimension] === "building-weighted"
        ? nextWeights
        : weights(
            buildings,
            nextFractions,
            regions,
            dimension,
            "building-weighted",
            place,
          );
    let unknown = false;
    const replacementWeights: number[] = [],
      replacementCounts: number[] = [];
    const areaFactors: (number | null)[] = [];
    regions.forEach((n, i) => {
      const refCount = scale(ref.value, baseWeights?.[i] ?? null),
        nat = scale(natural, nextWeights?.[i] ?? null),
        allocated = scale(global, nextWeights?.[i] ?? null);
      const value = activityTargetValue(n[dimension], refCount, allocated);
      if (
        n[dimension] &&
        value !== null &&
        value > 0 &&
        (demandWeights?.[i] ?? 0) === 0
      )
        unmappedDemand[dimension] = true;
      if (n[dimension]) {
        if (allocated === null || value === null) {
          unknown = true;
          warnings.push(
            `${n.name}: ${dimension} target cannot be reconciled with an unknown allocated remainder. Its entered count is retained; the complete study total is unavailable.`,
          );
        } else {
          replacementWeights.push(nextWeights![i]);
          replacementCounts.push(value);
        }
      }
      neighborhoodRows[i][dimension] = result(
        { ...ref, value: refCount },
        scale(baseline, baseWeights?.[i] ?? null),
        nat,
        allocated,
        value,
        [
          `${activity.allocation[dimension]} allocation; footprint-straddling building weights are proportionally clipped, without changing building records.`,
          ...(n[dimension]
            ? [
                "This local target is an exception to the global pre-area count.",
              ]
            : []),
        ],
      );
      areaFactors.push(
        n[dimension] ? ratio(value, nat) : ratio(global, natural),
      );
    });
    const final =
      unknown || global === null
        ? null
        : global * remainingWeight(replacementWeights) +
          sumNonnegative(replacementCounts);
    unallocated[dimension] =
      regions.length && nextWeights === null ? global : 0;
    resolved[dimension] = result(
      ref,
      baseline,
      natural,
      global,
      nullable(final),
      [
        "Percentages use the captured year-zero reference; baseline comparison is evaluated at the selected horizon.",
        ...(regions.length && nextWeights === null
          ? [
              "No usable spatial weights: the count remains unallocated, not spread uniformly by default.",
            ]
          : []),
      ],
    );
    if (
      regions.length &&
      nextWeights === null &&
      resolved[dimension].value !== null
    )
      resolved[dimension].status = "incomplete";
    if (
      final === null ||
      (final > 0 &&
        ((dimension === "population" ? next.units : next.jobs) === null ||
          (dimension === "population" ? next.units : next.jobs) === 0))
    )
      unmappedDemand[dimension] = true;
    resolved[dimension].sourceIds = unique([
      ...ref.sourceIds,
      USER_ACTIVITY_SOURCE.id,
      ...regions.filter((n) => n[dimension]).map((n) => n.sourceId),
      ...(activity.forecast ? [activity.forecast.sourceId] : []),
    ]);
    const globalRatio = ratio(global, natural);
    for (const b of buildings) {
      const fractions = nextFractions.get(b)!;
      let factor = globalRatio;
      fractions.forEach((fraction, i) => {
        if (!fraction || !regions[i][dimension]) return;
        const local = areaFactors[i];
        factor =
          factor === null || local === null
            ? null
            : factor + (local - (globalRatio ?? 0)) * fraction;
      });
      buildingFactors[b.id][dimension] =
        factor === null ? null : Math.max(0, factor);
    }
  }
  const vehicleRef = reference(place, scenario, activity, "vehicles");
  const vehicleValue = activityTargetValue(
    activity.global.householdVehicles,
    vehicleRef.value,
    vehicleRef.value,
  );
  const vehicles = result(
    vehicleRef,
    vehicleRef.value,
    vehicleRef.value,
    vehicleValue,
    vehicleValue,
    [
      "A household-vehicle stock target is separate from generated daily vehicle-trip ends. Population and employment changes do not automatically change this stock.",
    ],
  );
  if (activity.global.householdVehicles)
    vehicles.sourceIds = unique([
      ...vehicles.sourceIds,
      USER_ACTIVITY_SOURCE.id,
      ...(activity.forecast ? [activity.forecast.sourceId] : []),
    ]);
  const vehicleDemandFactor = ratio(vehicleValue, vehicleRef.value);
  for (const dimension of ["population", "employment"] as const)
    if (
      activity.demandResponse[dimension] !== "none" &&
      unmappedDemand[dimension]
    )
      warnings.push(
        `The ${dimension} response has an unknown count or positive activity without a mapped building quantity to carry demand. Affected trip estimates are unavailable; no missing activity was assigned zero trips.`,
      );
  if (
    activity.demandResponse.vehicles !== "none" &&
    (vehicleValue === null ||
      (vehicleValue > 0 && (next.units === null || next.units === 0)))
  )
    warnings.push(
      "The household-vehicle response has no usable residential demand quantity. A vehicle-stock count does not establish daily trips on its own.",
    );
  if (
    activity.demandResponse.vehicles !== "none" &&
    vehicleDemandFactor === null
  )
    warnings.push(
      "The household-vehicle demand sensitivity needs a positive matched reference stock. An absolute stock target alone does not establish its trip response.",
    );
  if (
    activity.demandResponse.population !== "none" ||
    activity.demandResponse.employment !== "none" ||
    activity.demandResponse.vehicles !== "none"
  )
    warnings.push(
      "Proportional activity demand is a reviewed planning sensitivity, not a calibrated mode-choice, routing or traffic model. Household-stock response replaces the residential population response; it does not multiply both.",
    );
  return {
    ...resolved,
    vehicles,
    neighborhoods: neighborhoodRows,
    unallocated,
    warnings: unique(warnings),
    buildingFactors,
    vehicleDemandFactor,
    unmappedDemand,
  };
}
