import {
  missingMetricBuildings,
  withholdIncompleteQuantities,
} from "./quantity-coverage";
import { quantityProduct, aggregateBuildingQuantity } from "@urban/core";
import { parcelSetDevelopment } from "./parcels";
import type {
  Assumptions,
  Building,
  MetricDomain,
  MetricResult,
  ModelResults,
  Place,
  Road,
  Scenario,
} from "@urban/core";
import {
  buildingAreaSqm,
  buildingProgramTotals,
  buildingProgramWarnings,
  assertBuildingProgram,
  materializeBuildings,
  materializeRoads,
  materializeParcels,
  studyAreaSqm,
  USER_ACTIVITY_SOURCE,
} from "@urban/core";
import {
  MODEL_VERSION,
  METERS_PER_MILE,
  SQFT_PER_SQM,
  SQM_PER_ACRE,
  lineLengthMeters,
  validateAssumptions,
} from "./helpers";
import type { FiscalYear, KnownFiscalYear, ModelEvidence } from "./types";
import { resolveActivity, type ActivityResolution } from "./activity";
import { resolveRetail } from "./retail";
import { resolveFloodExposure, type ModelContext } from "./flood";
import { resolveFiscalStudy } from "./fiscal";

const ASSUMPTION_SOURCE =
  "Editable scenario assumption; starter values are illustrative, not locally calibrated";
const PROFILE_CAVEAT =
  "Planning estimate using editable coefficients. Confirm jurisdiction-specific inputs before using the result in a decision or report.";
const RATE_DRIVE_REFERENCE = 0.8;
const USER_ACTIVITY_SOURCE_ID = USER_ACTIVITY_SOURCE.id;

/** Additive known contributions only. Missing contributors are tracked and full outputs withheld below. */
interface Totals {
  units: number;
  occupiedUnits: number;
  residents: number;
  jobs: number;
  floorSqft: number;
  footprintSqm: number;
  parkSqm: number;
  parking: number;
  parkingDemand: number;
  personTripProxy: number;
  trips: number;
  residentialTrips: number;
  nonresTrips: number;
  retailSqft: number;
  value: number;
  payroll: number;
  vmt: number;
  ghg: number;
  roadMiles: number;
  laneMiles: number;
  bikeMiles: number;
  closedMiles: number;
  rentIncome: number | null;
  rentCoveredUnits: number;
  growth: number;
  byType: Record<string, number>;
  heightViolations: number;
  heightChecked: number;
}

function floorArea(b: Building) {
  return quantityProduct(
    buildingProgramTotals(b).grossFloorAreaSqm,
    SQFT_PER_SQM,
  );
}
function commercialArea(b: Building) {
  return quantityProduct(
    buildingProgramTotals(b).nonresidentialFloorAreaSqm,
    SQFT_PER_SQM,
  );
}
function componentQuantity(
  component: import("@urban/core").BuildingProgramComponent,
  rate: import("@urban/core").BuildingRate,
  vacancy: number,
): number {
  const count =
    rate.basis === "dwelling"
      ? component.units
      : rate.basis === "occupied-dwelling"
        ? component.units * (1 - vacancy)
        : rate.basis === "1000-sqft"
          ? (component.grossFloorAreaSqm * SQFT_PER_SQM) / 1000
          : rate.basis === "job"
            ? component.jobs
            : component.beds!;
  return count;
}

function componentDemand(
  component: import("@urban/core").BuildingProgramComponent,
  rate: import("@urban/core").BuildingRate,
  vacancy: number,
) {
  return componentQuantity(component, rate, vacancy) * rate.value;
}
function programRateInputs(
  scope: string,
  buildings: Building[],
  a: Assumptions,
  kind: "trips" | "parking",
): MetricResult["inputs"] {
  const groups = new Map<
    string,
    { name: string; value: number; source: string }
  >();
  for (const building of buildings)
    for (const component of building.program?.components ?? []) {
      const residential = ["residential", "multifamily"].includes(
          component.use,
        ),
        override =
          kind === "trips" ? component.tripRate : component.parkingRate;
      if (component.use === "parking" && !override) continue;
      const rate: import("@urban/core").BuildingRate = override ?? {
        basis: residential
          ? kind === "trips"
            ? "occupied-dwelling"
            : "dwelling"
          : "1000-sqft",
        value:
          kind === "trips"
            ? a.tripRates[component.use]
            : residential
              ? a.parkingPerUnit
              : a.parkingPer1000Sqft,
        sourceId: ASSUMPTION_SOURCE,
      };
      const key = JSON.stringify([
        component.use,
        rate.basis,
        rate.value,
        rate.sourceId,
      ]);
      const row = groups.get(key) ?? {
        name: `${scope} ${component.use}: quantity × ${rate.value} per ${rate.basis}`,
        value: 0,
        source: rate.sourceId,
      };
      row.value += componentQuantity(component, rate, a.vacancyRate);
      groups.set(key, row);
    }
  return [...groups.values()];
}

function matchingCensusPopulation(place: Place) {
  const profile = place.demographics;
  if (
    !profile ||
    place.geography?.type !== "zcta" ||
    place.geography.code !== profile.geography.id ||
    place.zip !== profile.geography.id ||
    profile.geography.relationshipToStudyArea !== "same-area" ||
    profile.measures.population.estimate.status !== "available"
  )
    return null;
  const value = profile.measures.population.estimate.value;
  return value !== null && Number.isFinite(value) && value >= 0
    ? { value, profile }
    : null;
}

/** Census supplies the existing community; edited dwelling capacity supplies only the incremental scenario. */
function residentServiceBase(
  place: Place,
  scenario: Scenario,
  totals: Totals,
  baseline: boolean,
) {
  const published = matchingCensusPopulation(place);
  if (!published) return totals.residents;
  const a = baseline ? scenario.baselineAssumptions : scenario.assumptions;
  const originalUnits = place.buildings.reduce((sum, building) => {
    const units = buildingProgramTotals(building).units;
    return units === null ? sum : sum + units;
  }, 0);
  const addedResidents = baseline
    ? 0
    : (totals.units - originalUnits) * (1 - a.vacancyRate) * a.householdSize;
  return Math.max(
    0,
    (published.value + addedResidents) * a.populationMultiplier,
  );
}

function sumBuildings(
  buildings: Building[],
  roads: Road[],
  a: Assumptions,
  horizon: number,
  activity?: {
    settings: NonNullable<Scenario["activity"]>;
    resolved: ActivityResolution;
  },
): Totals {
  const growth = (1 + a.annualGrowthRate) ** horizon;
  const result: Totals = {
    units: 0,
    occupiedUnits: 0,
    residents: 0,
    jobs: 0,
    floorSqft: 0,
    footprintSqm: 0,
    parkSqm: 0,
    parking: 0,
    parkingDemand: 0,
    personTripProxy: 0,
    trips: 0,
    residentialTrips: 0,
    nonresTrips: 0,
    retailSqft: 0,
    value: 0,
    payroll: 0,
    vmt: 0,
    ghg: 0,
    roadMiles: 0,
    laneMiles: 0,
    bikeMiles: 0,
    closedMiles: 0,
    rentIncome: null,
    rentCoveredUnits: 0,
    growth,
    byType: {},
    heightViolations: 0,
    heightChecked: 0,
  };
  let rentTotal = 0;
  for (const b of buildings) {
    const responseFactor = (
      use: Building["use"],
      basis?: import("@urban/core").BuildingRate["basis"],
    ): number => {
      if (!activity)
        return ["residential", "multifamily"].includes(use)
          ? a.populationMultiplier
          : 1;
      const response = activity.settings.demandResponse,
        factors = activity.resolved.buildingFactors[b.id];
      if (basis === "bed") return 1;
      if (basis === "job")
        return response.employment === "none"
          ? 1
          : (factors?.employment ?? Number.NaN);
      if (["residential", "multifamily"].includes(use)) {
        if (response.vehicles !== "none")
          return activity.resolved.vehicleDemandFactor ?? Number.NaN;
        return response.population === "none"
          ? a.populationMultiplier
          : (factors?.population ?? Number.NaN);
      }
      if (
        ["office", "industrial", "warehouse"].includes(use) &&
        (!basis || basis === "1000-sqft") &&
        response.employment !== "none"
      )
        return factors?.employment ?? Number.NaN;
      return 1;
    };
    const parkingResponseFactor = (
      use: Building["use"],
      basis?: import("@urban/core").BuildingRate["basis"],
    ) => {
      if (!activity || activity.settings.demandResponse.employment === "none")
        return 1;
      const eligible =
        basis === "job" ||
        (["office", "industrial", "warehouse"].includes(use) &&
          (!basis || basis === "1000-sqft"));
      // Employment response divides by natural jobs at the horizon. Unlike
      // trips, parking has no later growth step, so cancel that denominator here.
      return eligible ? responseFactor(use, basis) * growth : 1;
    };
    for (const field of [
      "areaSqm",
      "height",
      "floors",
      "units",
      "jobs",
      "parkingSpaces",
    ] as const) {
      if (b[field] !== null && (!Number.isFinite(b[field]) || b[field] < 0))
        throw new RangeError(
          `${b.id}.${field} must be a finite nonnegative number.`,
        );
    }
    assertBuildingProgram(b);
    const program = buildingProgramTotals(b);
    const sqft = floorArea(b),
      commercial = commercialArea(b);
    if (program.units !== null) result.units += program.units;
    if (program.explicit) {
      for (const component of program.components) {
        const key =
          component.residentialSubtype === "townhome"
            ? "townhome"
            : component.residentialSubtype === "single-family"
              ? "residential"
              : component.residentialSubtype === "apartment"
                ? "multifamily"
                : component.use;
        result.byType[key] = (result.byType[key] ?? 0) + component.units;
      }
    } else if (b.units !== null)
      result.byType[b.use] = (result.byType[b.use] ?? 0) + b.units;
    if (program.jobs !== null) result.jobs += program.jobs;
    if (sqft !== null) result.floorSqft += sqft;
    if (b.parkingSpaces !== null) result.parking += b.parkingSpaces;
    if (b.use === "park") result.parkSqm += buildingAreaSqm(b);
    else if (b.use !== "vacant") result.footprintSqm += buildingAreaSqm(b);
    if (program.explicit) {
      for (const component of program.components) {
        const residential = ["residential", "multifamily"].includes(
          component.use,
        );
        const trips = component.tripRate
          ? componentDemand(component, component.tripRate, a.vacancyRate)
          : residential
            ? component.units * (1 - a.vacancyRate) * a.tripRates[component.use]
            : component.use === "parking"
              ? 0
              : ((component.grossFloorAreaSqm * SQFT_PER_SQM) / 1000) *
                a.tripRates[component.use];
        const adjustedTrips =
          trips === 0
            ? 0
            : trips * responseFactor(component.use, component.tripRate?.basis);
        if (residential) result.residentialTrips += adjustedTrips;
        else result.nonresTrips += adjustedTrips;
        const parkingDemand = component.parkingRate
          ? componentDemand(component, component.parkingRate, a.vacancyRate)
          : residential
            ? component.units * a.parkingPerUnit
            : component.use === "parking"
              ? 0
              : ((component.grossFloorAreaSqm * SQFT_PER_SQM) / 1000) *
                a.parkingPer1000Sqft;
        // Dwelling/bed/customer parking retains its physical denominator;
        // explicit job parking responds regardless of the component's use.
        result.parkingDemand +=
          parkingDemand === 0
            ? 0
            : parkingDemand *
              parkingResponseFactor(
                component.use,
                component.parkingRate?.basis,
              );
      }
      result.retailSqft += program.retailFloorAreaSqm * SQFT_PER_SQM;
    } else {
      if (b.units !== null && commercial !== null)
        result.parkingDemand +=
          b.units * a.parkingPerUnit +
          (commercial === 0
            ? 0
            : (commercial / 1000) *
              a.parkingPer1000Sqft *
              parkingResponseFactor(b.use));
      else {
        if (b.units !== null)
          result.parkingDemand += b.units * a.parkingPerUnit;
        if (commercial !== null)
          result.parkingDemand +=
            commercial === 0
              ? 0
              : (commercial / 1000) *
                a.parkingPer1000Sqft *
                parkingResponseFactor(b.use);
      }
      const residentialRate =
        b.use === "mixed-use"
          ? a.tripRates["mixed-use"]
          : b.use === "residential"
            ? a.tripRates.residential
            : a.tripRates.multifamily;
      if (b.units !== null) {
        const householdTrips = b.units * (1 - a.vacancyRate) * residentialRate;
        result.residentialTrips +=
          householdTrips === 0
            ? 0
            : householdTrips * responseFactor("multifamily");
      }
      if (commercial !== null)
        result.nonresTrips +=
          (commercial / 1000) *
          (b.use === "mixed-use" ? a.tripRates.retail : a.tripRates[b.use]) *
          (activity && commercial > 0
            ? responseFactor(b.use === "mixed-use" ? "retail" : b.use)
            : 1);
      if ((b.use === "retail" || b.use === "mixed-use") && commercial !== null)
        result.retailSqft += commercial;
    }
    if (
      b.assessedValue !== undefined &&
      (!Number.isFinite(b.assessedValue) || b.assessedValue < 0)
    )
      throw new RangeError(`${b.id}.assessedValue must be nonnegative.`);
    if (b.assessedValue !== undefined) result.value += b.assessedValue;
    else if (sqft !== null) result.value += sqft * a.assessedValuePerSqft;
    if (b.rentMonthly !== undefined && b.units !== null && b.units > 0) {
      if (!Number.isFinite(b.rentMonthly) || b.rentMonthly < 0)
        throw new RangeError(`${b.id}.rentMonthly must be nonnegative.`);
      rentTotal += b.rentMonthly * b.units;
      result.rentCoveredUnits += b.units;
    }
    if (b.maxHeight !== undefined && b.height !== null) {
      result.heightChecked++;
      if (b.height > b.maxHeight) result.heightViolations++;
    }
  }
  result.occupiedUnits = result.units * (1 - a.vacancyRate);
  result.residents =
    result.occupiedUnits *
    a.householdSize *
    (activity ? 1 : a.populationMultiplier * growth);
  result.jobs *= growth;
  if (activity) result.jobs = activity.resolved.employment.value ?? Number.NaN;
  result.payroll = result.jobs * a.annualWage;
  if (activity) {
    const { settings, resolved } = activity,
      response = settings.demandResponse;
    if (response.vehicles !== "none") {
      if (
        resolved.vehicles.value === null ||
        (resolved.vehicles.value > 0 && result.units === 0)
      )
        result.residentialTrips = Number.NaN;
    } else if (
      response.population !== "none" &&
      resolved.unmappedDemand.population
    )
      result.residentialTrips = Number.NaN;
    if (response.employment !== "none" && resolved.unmappedDemand.employment) {
      result.nonresTrips = Number.NaN;
      result.parkingDemand = Number.NaN;
    }
  }
  const demandAtReferenceShare =
    (result.residentialTrips + result.nonresTrips) * growth;
  result.personTripProxy = demandAtReferenceShare / RATE_DRIVE_REFERENCE;
  result.trips =
    ((demandAtReferenceShare * a.driveShare) / RATE_DRIVE_REFERENCE) *
    a.vehicleMultiplier;
  result.vmt = result.trips * a.averageTripMiles;
  result.ghg = (result.vmt * 365 * a.emissionsKgPerMile) / 1000;
  result.rentIncome =
    result.rentCoveredUnits > 0
      ? ((rentTotal / result.rentCoveredUnits) * 12) / 0.3
      : null;
  for (const r of roads) {
    const miles = lineLengthMeters(r.coordinates) / METERS_PER_MILE;
    if (r.closed) {
      result.closedMiles += miles;
      continue;
    }
    result.roadMiles += miles;
    result.laneMiles += miles * r.lanes;
    if (r.bikeLane) result.bikeMiles += miles;
  }
  return result;
}

/** Constant-dollar annual operating cash flows. Capital costs/fees require separate local inputs. */
function fiscalCashFlowsKnown(
  place: Place,
  scenario: Scenario,
  years = 20,
  baseline = false,
  activityResolution?: ActivityResolution,
): KnownFiscalYear[] {
  if (!Number.isInteger(years) || years < 1 || years > 100)
    throw new RangeError("Fiscal years must be an integer from 1 to 100.");
  const a = baseline ? scenario.baselineAssumptions : scenario.assumptions;
  const errors = validateAssumptions(a);
  if (errors.length) throw new RangeError(errors.join(" "));
  const buildings = baseline
    ? place.buildings
    : materializeBuildings(place, scenario);
  const roads = baseline ? place.roads : materializeRoads(place, scenario);
  const totals = sumBuildings(buildings, roads, a, 0);
  const active = scenario.activity
    ? (activityResolution ?? resolveActivity(place, scenario))
    : undefined;
  const serviceResidents = active
    ? ((baseline ? active.population.baseline : active.population.value) ??
      Number.NaN)
    : residentServiceBase(place, scenario, totals, baseline);
  const serviceJobs = active
    ? ((baseline ? active.employment.baseline : active.employment.value) ??
      Number.NaN)
    : totals.jobs;
  // Value additions use the same valuation profile on each side; a levy/profile change
  // must not make the existing jurisdiction's entire tax base incentive-eligible.
  const existingValue = baseline
    ? totals.value
    : sumBuildings(place.buildings, place.roads, a, 0).value;
  const eligibleAddedValue = Math.max(0, totals.value - existingValue);
  return Array.from({ length: years }, (_, i) => {
    const year = i + 1,
      growth = (1 + a.annualGrowthRate) ** (scenario.horizon + year - 1);
    const propertyRevenue = totals.value * a.effectivePropertyTaxRate;
    const salesRevenue =
      totals.retailSqft *
      a.salesPerSqft *
      a.retailCaptureRate *
      a.localSalesTaxRate *
      growth;
    const serviceCost =
      ((a.annualServiceCostPerResident === 0
        ? 0
        : serviceResidents * a.annualServiceCostPerResident) +
        (a.annualServiceCostPerJob === 0
          ? 0
          : serviceJobs * a.annualServiceCostPerJob)) *
      (active ? (1 + a.annualGrowthRate) ** (year - 1) : growth);
    const abatementCost =
      !baseline && year <= a.abatementYears
        ? eligibleAddedValue * a.effectivePropertyTaxRate * a.abatementPercent
        : 0;
    const grantCost = !baseline && year === 1 ? a.incentiveGrant : 0;
    const netRevenue =
      propertyRevenue + salesRevenue - serviceCost - abatementCost - grantCost;
    // The grant is paid up front (t=0); recurring flows arrive at each year end.
    return {
      year,
      propertyRevenue,
      salesRevenue,
      serviceCost,
      abatementCost,
      grantCost,
      netRevenue,
      discountedNet:
        (netRevenue + grantCost) / (1 + a.discountRate) ** year - grantCost,
    };
  });
}

/** Missing quantities withhold dependent cash-flow fields; known zero coefficients remain zero. */
export function fiscalCashFlows(
  place: Place,
  scenario: Scenario,
  years = 20,
  baseline = false,
  activityResolution?: ActivityResolution,
): FiscalYear[] {
  const activity = scenario.activity
    ? (activityResolution ?? resolveActivity(place, scenario))
    : undefined;
  const missing = (id: string) =>
    missingMetricBuildings(id, place, scenario, baseline, activity).length > 0;
  const propertyMissing = missing("fiscal.propertyTax"),
    salesMissing = missing("fiscal.salesTax"),
    serviceMissing = missing("fiscal.serviceCost"),
    netMissing = missing("fiscal.netAnnual");
  const oldPropertyMissing =
    missingMetricBuildings(
      "fiscal.propertyTax",
      place,
      scenario,
      true,
      activity,
    ).length > 0;
  return fiscalCashFlowsKnown(place, scenario, years, baseline, activity).map(
    (row) => ({
      ...row,
      propertyRevenue: propertyMissing ? null : row.propertyRevenue,
      salesRevenue: salesMissing ? null : row.salesRevenue,
      serviceCost:
        serviceMissing || !Number.isFinite(row.serviceCost)
          ? null
          : row.serviceCost,
      abatementCost:
        !baseline &&
        row.year <= scenario.assumptions.abatementYears &&
        scenario.assumptions.abatementPercent !== 0 &&
        scenario.assumptions.effectivePropertyTaxRate !== 0 &&
        (propertyMissing || oldPropertyMissing)
          ? null
          : row.abatementCost,
      netRevenue:
        netMissing || !Number.isFinite(row.netRevenue) ? null : row.netRevenue,
      discountedNet:
        netMissing || !Number.isFinite(row.discountedNet)
          ? null
          : row.discountedNet,
    }),
  );
}

function runoffDepthMm(rainMm: number, curveNumber: number) {
  const retention = 25400 / curveNumber - 254;
  const abstraction = 0.2 * retention;
  return rainMm <= abstraction
    ? 0
    : (rainMm - abstraction) ** 2 / (rainMm + 0.8 * retention);
}

/** Pure analytical results, apart from computedAt. All source/data-dependent capabilities use explicit evidence. */
export function calculateImpact(
  place: Place,
  scenario: Scenario,
  evidence: ModelEvidence = {},
  context: ModelContext = {},
): ModelResults {
  for (const [name, a] of [
    ["Scenario", scenario.assumptions],
    ["Baseline", scenario.baselineAssumptions],
  ] as const) {
    const issues = validateAssumptions(a);
    if (issues.length) throw new RangeError(`${name}: ${issues.join(" ")}`);
  }
  const a = scenario.assumptions,
    baselineA = scenario.baselineAssumptions;
  const buildings = materializeBuildings(place, scenario),
    roads = materializeRoads(place, scenario);
  const activity = scenario.activity
    ? resolveActivity(place, scenario)
    : undefined;
  const base = sumBuildings(
    place.buildings,
    place.roads,
    baselineA,
    scenario.horizon,
  );
  const next = sumBuildings(
    buildings,
    roads,
    a,
    scenario.horizon,
    activity ? { settings: scenario.activity!, resolved: activity } : undefined,
  );
  if (activity) {
    base.jobs = activity.employment.baseline ?? Number.NaN;
    base.payroll = base.jobs * baselineA.annualWage;
    base.residents = base.occupiedUnits * baselineA.householdSize;
  }
  const areaSqm = studyAreaSqm(place),
    acres = areaSqm / SQM_PER_ACRE;
  const sourceIds = [
    ...new Set(
      [...place.buildings, ...buildings].flatMap((b) => [
        b.sourceId,
        ...(b.attributeSourceId ? [b.attributeSourceId] : []),
        ...Object.values(b.attributeProvenance?.fields ?? {}).flatMap((e) =>
          e ? [e.sourceId] : [],
        ),
        ...(b.attributeProvenance?.use
          ? [b.attributeProvenance.use.sourceId]
          : []),
        ...(b.geometrySourceId ? [b.geometrySourceId] : []),
        ...(b.programSourceId ? [b.programSourceId] : []),
        ...(b.program?.components.flatMap((c) =>
          [c.sourceId, c.tripRate?.sourceId, c.parkingRate?.sourceId].filter(
            (x): x is string => !!x,
          ),
        ) ?? []),
      ]),
    ),
  ];
  const roadSourceIds = [
    ...new Set(
      [...place.roads, ...roads].flatMap((road) => [
        road.sourceId,
        ...(road.attributeSourceId ? [road.attributeSourceId] : []),
        ...(road.geometrySourceId ? [road.geometrySourceId] : []),
      ]),
    ),
  ];
  const metrics: MetricResult[] = [];
  const warnings: string[] = activity ? [...activity.warnings] : [];
  const input = (
    name: string,
    value: number | string,
    source = ASSUMPTION_SOURCE,
  ) => ({ name, value, source });
  const genericInputs = [
    input("Forecast horizon", scenario.horizon, "Scenario setting"),
    input("Geography", place.extentLabel, "Source manifest"),
  ];
  function add(
    id: string,
    label: string,
    domain: MetricDomain,
    unit: string,
    baseline: number | null,
    value: number | null,
    formula: string,
    explanation: string,
    extras: Partial<MetricResult> = {},
  ) {
    if (baseline !== null && !Number.isFinite(baseline)) baseline = null;
    if (value !== null && !Number.isFinite(value)) value = null;
    metrics.push({
      id,
      label,
      domain,
      unit,
      baseline,
      value,
      delta: baseline === null || value === null ? null : value - baseline,
      status: value === null ? "unavailable" : "ready",
      formula,
      explanation,
      inputs: genericInputs,
      sourceIds,
      method: "Transparent planning calculation",
      methodVersion: MODEL_VERSION,
      scenarioRevision: scenario.revision,
      geography: place.extentLabel,
      desirable: "neutral",
      ...extras,
    });
  }
  function missing(
    id: string,
    label: string,
    domain: MetricDomain,
    unit: string,
    required: string,
    formula: string,
  ) {
    add(id, label, domain, unit, null, null, formula, required, {
      sourceIds: [],
      status: "unavailable",
      caveat: "Missing evidence is not a measured zero.",
    });
  }
  const assumed = { caveat: PROFILE_CAVEAT, status: "incomplete" as const };
  const tripStatus = {
    status:
      a.tripRatesConfirmed && baselineA.tripRatesConfirmed
        ? ("ready" as const)
        : ("incomplete" as const),
    caveat:
      "Vehicle trip ends generated by the included land uses. Illustrative rates unless confirmed; not assigned link volumes or a calibrated traffic study. Mode changes scale reference demand linearly.",
  };
  const fiscalStatus = {
    status:
      a.fiscalInputsConfirmed && baselineA.fiscalInputsConfirmed
        ? ("ready" as const)
        : ("incomplete" as const),
    caveat:
      "Operating fiscal estimate in constant dollars. Omits capital projects, fees, assessment limitations, overlapping taxing districts, and displacement unless supplied. ZCTA is not necessarily the receiving jurisdiction.",
    geography: a.jurisdictionName,
    ...(matchingCensusPopulation(place)
      ? { sourceIds: [...sourceIds, place.demographics!.source.id] }
      : {}),
  };

  add(
    "housing.units",
    "Homes",
    "Housing",
    "units",
    base.units,
    next.units,
    "Sum of dwelling units across included buildings",
    "Units represent the entered or estimated building program; changing the population slider does not create homes.",
    {
      inputs: [
        input("Buildings", buildings.length, "Materialized scenario features"),
      ],
    },
  );
  add(
    "housing.occupiedUnits",
    "Occupied homes",
    "Housing",
    "units",
    base.occupiedUnits,
    next.occupiedUnits,
    "Dwelling units × (1 − vacancy rate)",
    "Estimated occupied homes using the scenario vacancy assumption.",
    { ...assumed, inputs: [input("Vacancy rate", a.vacancyRate)] },
  );
  add(
    "housing.residents",
    activity ? "Housing-supported resident capacity" : "Residents supported",
    "Housing",
    "people",
    base.residents,
    next.residents,
    activity
      ? "Units × (1 − vacancy) × household size"
      : "Units × (1 − vacancy) × household size × population multiplier × (1 + growth)^horizon",
    activity
      ? "Physical housing-program capacity under occupancy and household-size assumptions. Effective activity targets are separate and do not create homes."
      : "Housing-derived population scenario, not the Census population of this area.",
    {
      ...assumed,
      inputs: [
        input("Household size", a.householdSize),
        input("Population multiplier", a.populationMultiplier),
        input("Annual growth", a.annualGrowthRate),
      ],
    },
  );
  if (activity) {
    const activityInputs = (r: ActivityResolution["population"]) => [
      input("Reference", r.reference ?? "Unavailable", r.referenceLabel),
      input(
        "Natural horizon count",
        r.natural ?? "Unavailable",
        "Reference plus changed building capacity, then horizon growth; vehicle stocks do not automatically grow",
      ),
      input(
        "Global count before neighborhood exceptions",
        r.beforeAreas ?? "Unavailable",
        USER_ACTIVITY_SOURCE_ID,
      ),
      input(
        "Final effective count",
        r.value ?? "Unavailable",
        USER_ACTIVITY_SOURCE_ID,
      ),
      input(
        "Neighborhood rule",
        "Replace only the allocated count within each disjoint boundary; leave outside unchanged",
        USER_ACTIVITY_SOURCE_ID,
      ),
    ];
    add(
      "activity.population",
      "Effective residents",
      "Housing",
      "people",
      activity.population.baseline,
      activity.population.value,
      "Global horizon population + Σ(neighborhood target − allocated global population)",
      "Modeled population scenario, separate from housing-supported capacity and the original published demographic estimate.",
      {
        ...assumed,
        status: activity.population.status,
        sourceIds: activity.population.sourceIds,
        inputs: activityInputs(activity.population),
        caveat: activity.population.notes.join(" "),
      },
    );
    add(
      "activity.populationDensity",
      "Effective population density",
      "Housing",
      "people/acre",
      activity.population.baseline === null
        ? null
        : activity.population.baseline / acres,
      activity.population.value === null
        ? null
        : activity.population.value / acres,
      "Effective residents ÷ exact study-boundary acres",
      "Scenario population density; neighborhood allocation is a modeling assumption.",
      {
        ...assumed,
        sourceIds: activity.population.sourceIds,
        inputs: activityInputs(activity.population),
      },
    );
    add(
      "economy.programJobs",
      "Entered building jobs",
      "Economy",
      "jobs",
      aggregateBuildingQuantity(
        place.buildings,
        (b) => buildingProgramTotals(b).jobs,
      ).value,
      aggregateBuildingQuantity(buildings, (b) => buildingProgramTotals(b).jobs)
        .value,
      "Sum of unchanged entered building-program jobs",
      "Physical/entered program quantities remain independent of effective workplace-employment overrides.",
      { ...assumed },
    );
    add(
      "activity.householdVehicles",
      "Household vehicles available",
      "Mobility",
      "vehicles",
      activity.vehicles.baseline,
      activity.vehicles.value,
      "Entered absolute stock target or captured reference × percentage",
      "Household vehicle stock, not daily trips, AADT, registered fleet or visible agents.",
      {
        ...assumed,
        status: activity.vehicles.status,
        sourceIds: activity.vehicles.sourceIds,
        inputs: activityInputs(activity.vehicles),
        caveat: activity.vehicles.notes.join(" "),
      },
    );
  }
  add(
    "housing.density",
    "Gross housing density",
    "Housing",
    "units/acre",
    acres > 0 ? base.units / acres : null,
    acres > 0 ? next.units / acres : null,
    "Dwelling units ÷ study-boundary acres",
    "Gross density includes streets and other land within the displayed study boundary.",
    { inputs: [input("Study area (acres)", acres, "Boundary geometry")] },
  );
  for (const [type, label] of [
    ["residential", "Single-family homes"],
    ["multifamily", "Apartment homes"],
    ["mixed-use", "Mixed-use homes"],
    ...([...place.buildings, ...buildings].some((b) =>
      b.program?.components.some((c) => c.residentialSubtype === "townhome"),
    )
      ? [["townhome", "Townhomes"]]
      : []),
  ] as const) {
    add(
      `housing.${type}`,
      label,
      "Housing",
      "units",
      base.byType[type] ?? 0,
      next.byType[type] ?? 0,
      `Sum of units in ${type} buildings`,
      "Housing mix follows the building-use classification.",
    );
  }
  add(
    "housing.jobsHousingBalance",
    "Jobs / occupied home",
    "Housing",
    "ratio",
    base.occupiedUnits ? base.jobs / base.occupiedUnits : null,
    next.occupiedUnits ? next.jobs / next.occupiedUnits : null,
    "Direct jobs ÷ occupied dwelling units",
    "Employment-to-housing ratio for the included features; it does not establish commuting self-sufficiency.",
    assumed,
  );
  add(
    "housing.incomeRequired",
    "Rent-only income threshold",
    "Housing",
    "$/year",
    base.rentIncome,
    next.rentIncome,
    "Unit-weighted monthly rent × 12 ÷ 0.30",
    "Annual household income at which entered rent is 30% of income. Utilities are excluded; this is a lower-bound screening estimate, not a complete affordability classification.",
    {
      ...assumed,
      ...(next.rentIncome === null ? { status: "unavailable" as const } : {}),
      inputs: [
        input(
          "Homes with rent input",
          next.rentCoveredUnits,
          "Building inputs",
        ),
        input(
          "Rent-to-income convention",
          0.3,
          "HUD cost-burden screening convention",
        ),
      ],
      caveat:
        "Requires utilities, ownership costs where applicable, household size, and local HUD income limits for complete affordability bands.",
    },
  );

  add(
    "economy.jobs",
    "Direct jobs",
    "Economy",
    "jobs",
    base.jobs,
    next.jobs,
    "Sum of building/employer jobs × (1 + growth)^horizon",
    "Direct employment only. Indirect and induced jobs require a regional multiplier pack.",
    {
      ...assumed,
      inputs: [
        input("Annual employment growth", a.annualGrowthRate),
        input(
          "Building job counts",
          aggregateBuildingQuantity(buildings, (b) => b.jobs).knownSubtotal ??
            "Unknown",
          "Supplied or estimated building inputs",
        ),
      ],
    },
  );
  add(
    "economy.payroll",
    "Annual direct payroll",
    "Economy",
    "$/year",
    base.payroll,
    next.payroll,
    "Direct jobs × average annual wage",
    "Gross annual payroll at the editable wage assumption, before taxes and benefits.",
    { ...assumed, inputs: [input("Average annual wage", a.annualWage)] },
  );
  const multipliers = evidence.economicMultipliers;
  if (multipliers) {
    if (
      ![
        multipliers.typeIEmployment,
        multipliers.typeIIEmployment,
        multipliers.annualOutputPerDirectJob,
      ].every(Number.isFinite) ||
      multipliers.typeIEmployment < 1 ||
      multipliers.typeIIEmployment < multipliers.typeIEmployment ||
      multipliers.annualOutputPerDirectJob < 0
    )
      throw new RangeError(
        "Economic multipliers must be finite, Type II ≥ Type I ≥ 1, with nonnegative output per direct job.",
      );
    const regional = {
      sourceIds: [multipliers.sourceId],
      geography: multipliers.geography,
      method: "Regional direct-effect multiplier calculation",
      caveat:
        "Results describe the coefficient pack’s economic region, not necessarily this ZIP. Multipliers must match the modeled industry and employment definition.",
      inputs: [
        input(
          "Type I employment multiplier",
          multipliers.typeIEmployment,
          multipliers.sourceId,
        ),
        input(
          "Type II employment multiplier",
          multipliers.typeIIEmployment,
          multipliers.sourceId,
        ),
        input("Vintage", multipliers.vintage, multipliers.sourceId),
      ],
    };
    add(
      "economy.indirectJobs",
      "Indirect jobs",
      "Economy",
      "jobs",
      base.jobs * (multipliers.typeIEmployment - 1),
      next.jobs * (multipliers.typeIEmployment - 1),
      "Direct jobs × (Type I employment multiplier − 1)",
      "Supply-chain employment associated with direct activity.",
      regional,
    );
    add(
      "economy.inducedJobs",
      "Induced jobs",
      "Economy",
      "jobs",
      base.jobs * (multipliers.typeIIEmployment - multipliers.typeIEmployment),
      next.jobs * (multipliers.typeIIEmployment - multipliers.typeIEmployment),
      "Direct jobs × (Type II employment multiplier − Type I employment multiplier)",
      "Household-spending employment, separated from direct and indirect employment.",
      regional,
    );
    add(
      "economy.output",
      "Annual business output",
      "Economy",
      "$/year",
      base.jobs * multipliers.annualOutputPerDirectJob,
      next.jobs * multipliers.annualOutputPerDirectJob,
      "Direct jobs × region/industry output coefficient",
      "Output is economic production, not payroll, tax revenue, or household income.",
      regional,
    );
  } else {
    missing(
      "economy.indirectJobs",
      "Indirect jobs",
      "Economy",
      "jobs",
      "Supply a licensed or customer-provided regional Type I direct-effect employment multiplier.",
      "Direct jobs × (Type I employment multiplier − 1)",
    );
    missing(
      "economy.inducedJobs",
      "Induced jobs",
      "Economy",
      "jobs",
      "Supply matching regional Type I and Type II direct-effect employment multipliers.",
      "Direct jobs × (Type II employment multiplier − Type I employment multiplier)",
    );
    missing(
      "economy.output",
      "Annual business output",
      "Economy",
      "$/year",
      "Supply a regional, industry-specific output coefficient with permitted reuse.",
      "Direct jobs × region/industry output coefficient",
    );
  }
  const retail = evidence.retail;
  const retailStudy = resolveRetail(place, scenario);
  if (retailStudy) {
    warnings.push(...retailStudy.warnings);
    const context = retailStudy.context,
      t = retailStudy.totals;
    const extra = {
      status: "incomplete" as const,
      sourceIds: retailStudy.sourceIds,
      geography: context.geography,
      method: "Authored annual category demand–sales screening",
      caveat: `Only studied mutually exclusive categories are included. Demand minus establishment sales is not observed resident spending leakage; sales may include visitors, commuters and online transactions. ${context.relationshipToStudyArea === "context-only" ? "The declared geography is context only, not a total for the mapped study area. " : ""}Source comparability and reuse rights are user attestations, not independently verified. No automatic population, floor-area, price-growth, or fiscal-tax linkage. ${retailStudy.status === "stale" ? "The reviewed horizon differs from the current scenario; proposal results are withheld." : ""}`,
      inputs: [
        input(
          "Study geography",
          context.geography,
          "User-declared matched study context",
        ),
        input(
          "Reference year",
          context.referenceYear,
          "Supplied annual evidence",
        ),
        input(
          "Dollar year",
          context.dollarYear,
          "All amounts declared in the same USD price basis; no automatic inflation adjustment",
        ),
        input(
          "Classification",
          `${context.classification.system} ${context.classification.version}`,
          "Matched category definitions; establishment industry and commodities require a documented compatible mapping",
        ),
        input(
          "Reviewed horizon",
          context.horizon,
          "Annual target values at this horizon; no automatic growth",
        ),
        input(
          "Studied categories",
          retailStudy.coverage.categories,
          "Not the complete local retail economy",
        ),
        input(
          "Complete monetary categories",
          retailStudy.coverage.completeCategories,
          "Optional missing establishment benchmarks do not invalidate known monetary values",
        ),
        input(
          "Gross prospective captured sales",
          t.grossCapturedSales ?? "Unavailable",
          "Sum of per-category min(positive demand–sales gap × capture share, entered annual capacity)",
        ),
        input(
          "Displaced local sales",
          t.displacedSales ?? "Unavailable",
          "Gross captured sales × entered displacement share",
        ),
        input(
          "Net new studied-category sales",
          t.netNewSales ?? "Unavailable",
          "Gross less displaced sales; not automatically added to fiscal revenue",
        ),
      ],
    };
    add(
      "economy.retailCaptured",
      "Studied-category annual sales",
      "Economy",
      "$/year",
      t.baselineSales,
      t.scenarioSales,
      "Σ(baseline category sales + min(max(scenario demand − baseline sales, 0) × capture share, annual capacity) × (1 − displacement share))",
      "Annual local-establishment sales scenario for the studied categories only, not measured spending retained from area residents.",
      {
        ...extra,
        status: t.scenarioSales === null ? "unavailable" : "incomplete",
      },
    );
    add(
      "economy.retailGap",
      "Studied-category demand–sales gap",
      "Economy",
      "$/year",
      t.baselineGap,
      t.scenarioGap,
      "Σ(category resident demand − category local-establishment sales)",
      "A positive gap is an addressable-demand screening estimate; a negative gap is a sales surplus relative to supplied resident demand. Neither identifies the origin or destination of spending.",
      {
        ...extra,
        status: t.scenarioGap === null ? "unavailable" : "incomplete",
      },
    );
    add(
      "economy.businessPotential",
      "Studied-category establishment equivalents",
      "Economy",
      "establishments",
      t.baselineEstablishmentEquivalent,
      t.scenarioEstablishmentEquivalent,
      "Σ(max(category demand − category sales, 0) ÷ category annual sales-per-establishment benchmark)",
      "Category-specific fractional revenue equivalents, not a forecast of openings or proof of market/site feasibility. Missing category benchmarks withhold the complete total.",
      {
        ...extra,
        status:
          t.scenarioEstablishmentEquivalent === null
            ? "unavailable"
            : "incomplete",
      },
    );
  } else if (retail) {
    if (
      ![
        retail.residentAnnualDemand,
        retail.baselineAnnualSales,
        retail.annualSalesPerEstablishment,
        retail.displacedLocalSalesFraction,
      ].every(Number.isFinite) ||
      retail.residentAnnualDemand < 0 ||
      retail.baselineAnnualSales < 0 ||
      retail.annualSalesPerEstablishment <= 0 ||
      retail.displacedLocalSalesFraction < 0 ||
      retail.displacedLocalSalesFraction > 1
    )
      throw new RangeError(
        "Retail evidence requires nonnegative demand/sales, positive sales per establishment, and displacement from 0 to 1.",
      );
    const gap = Math.max(
      0,
      retail.residentAnnualDemand - retail.baselineAnnualSales,
    );
    const newCapacity = (next.retailSqft - base.retailSqft) * a.salesPerSqft;
    const captured =
      newCapacity >= 0
        ? Math.min(gap * a.retailCaptureRate, newCapacity) *
          (1 - retail.displacedLocalSalesFraction)
        : Math.max(-retail.baselineAnnualSales, newCapacity);
    const afterSales = retail.baselineAnnualSales + captured;
    const extra = {
      sourceIds: [retail.sourceId],
      geography: retail.geography,
      method: "Retail demand and sales-capacity screening",
      caveat:
        "Demand minus estimated sales is potential unmet demand; it is not observed spending leakage. Scenario capture and displacement remain assumptions.",
      inputs: [
        input("Resident demand", retail.residentAnnualDemand, retail.sourceId),
        input(
          "Estimated baseline sales",
          retail.baselineAnnualSales,
          retail.sourceId,
        ),
        input("Recapture fraction", a.retailCaptureRate),
        input(
          "Local displacement fraction",
          retail.displacedLocalSalesFraction,
        ),
      ],
    };
    add(
      "economy.retailCaptured",
      "Estimated retail sales",
      "Economy",
      "$/year",
      retail.baselineAnnualSales,
      afterSales,
      "Baseline sales + min(eligible unmet demand × capture fraction, new sales capacity) × (1 − displacement)",
      "Captures eligible unmet demand without treating every dollar of proposed retail sales as new local activity.",
      extra,
    );
    add(
      "economy.retailGap",
      "Retail opportunity gap",
      "Economy",
      "$/year",
      retail.residentAnnualDemand - retail.baselineAnnualSales,
      retail.residentAnnualDemand - afterSales,
      "Resident demand − estimated local sales",
      "Negative values mean estimated sales exceed resident demand and may reflect inbound spending.",
      extra,
    );
    add(
      "economy.businessPotential",
      "Additional establishments supported",
      "Economy",
      "establishments",
      gap / retail.annualSalesPerEstablishment,
      Math.max(0, retail.residentAnnualDemand - afterSales) /
        retail.annualSalesPerEstablishment,
      "Remaining addressable unmet demand ÷ annual sales per establishment",
      "Demand-capacity proxy only; not a forecast of business openings or proof of site feasibility.",
      extra,
    );
  } else {
    missing(
      "economy.retailCaptured",
      "Estimated retail sales",
      "Economy",
      "$/year",
      "Supply category-specific resident demand and local sales evidence; building area alone cannot establish captured spending.",
      "Baseline sales + eligible recaptured demand − displaced local sales",
    );
    missing(
      "economy.retailGap",
      "Retail opportunity gap",
      "Economy",
      "$/year",
      "Supply matched resident-spending and local-sales estimates with source vintage.",
      "Resident demand − estimated local sales",
    );
    missing(
      "economy.businessPotential",
      "Additional establishments supported",
      "Economy",
      "establishments",
      "Supply retail demand/sales evidence and an industry sales-per-establishment benchmark.",
      "Addressable unmet demand ÷ annual sales per establishment",
    );
  }

  add(
    "mobility.dailyTrips",
    "Daily vehicle trips",
    "Mobility",
    "trips/day",
    base.trips,
    next.trips,
    "(Occupied homes × residential rate + commercial 1,000 ft² × use rate) × growth × drive share / 0.80 × vehicle multiplier",
    "Daily generated vehicle-trip ends, estimated from building program and transparent demand assumptions.",
    {
      ...tripStatus,
      inputs: [
        input(
          "Trip-rate units",
          "Vehicle trip ends per occupied home or 1,000 commercial ft² per day at 80% reference drive share",
        ),
        input("Drive share", a.driveShare),
        input("Vehicle multiplier", a.vehicleMultiplier),
      ],
    },
  );
  add(
    "mobility.vmt",
    "Daily vehicle miles",
    "Mobility",
    "miles/day",
    base.vmt,
    next.vmt,
    "Generated daily vehicle trips × average trip distance",
    "Trip-distance screening estimate. Includes assumed full trip distances, not only miles traveled inside the study boundary.",
    {
      ...tripStatus,
      inputs: [input("Average trip distance (miles)", a.averageTripMiles)],
    },
  );
  add(
    "mobility.parkingDemand",
    "Parking demand",
    "Mobility",
    "spaces",
    base.parkingDemand,
    next.parkingDemand,
    "Homes × spaces/home + nonresidential 1,000 ft² × spaces/1,000 ft²",
    "Unshared parking-demand estimate. Parking garages supply spaces and do not generate duplicate floor-area parking demand.",
    {
      ...assumed,
      inputs: [
        input("Spaces per home", a.parkingPerUnit),
        input("Spaces per 1,000 commercial ft²", a.parkingPer1000Sqft),
      ],
    },
  );
  add(
    "mobility.parkingSupply",
    "Parking supply",
    "Mobility",
    "spaces",
    base.parking,
    next.parking,
    "Sum of entered building and parking-facility spaces",
    "Includes supplied/estimated spaces only; it does not infer curb parking from road geometry.",
  );
  add(
    "mobility.parkingBalance",
    "Parking surplus / shortfall",
    "Mobility",
    "spaces",
    base.parking - base.parkingDemand,
    next.parking - next.parkingDemand,
    "Parking supply − parking demand",
    "Positive is surplus, negative is shortfall under the selected assumptions.",
    assumed,
  );
  add(
    "mobility.roadMiles",
    "Open road length",
    "Mobility",
    "miles",
    base.roadMiles,
    next.roadMiles,
    "Sum of open-road centerline lengths",
    "Geometric centerline length; lane count does not multiply this metric.",
    { sourceIds: roadSourceIds },
  );
  add(
    "mobility.laneMiles",
    "Open lane miles",
    "Mobility",
    "miles",
    base.laneMiles,
    next.laneMiles,
    "Sum of open-road length × entered lane count",
    "Lane-distance measure, not a capacity or congestion prediction.",
    {
      sourceIds: roadSourceIds,
      ...([...place.roads, ...roads].some((road) => road.estimated)
        ? {
            status: "incomplete" as const,
            caveat:
              "Lane counts include source estimates or user-entered planning assumptions; this is a geometric measure, not validated capacity.",
          }
        : {}),
    },
  );
  add(
    "mobility.bikeMiles",
    "Roads with bike lanes",
    "Mobility",
    "miles",
    base.bikeMiles,
    next.bikeMiles,
    "Sum of open-road lengths flagged with a bike lane",
    "Centerline miles with a bike-lane designation; does not establish protection, continuity, or accessibility.",
    { sourceIds: roadSourceIds },
  );
  missing(
    "mobility.commuteTime",
    "Average commute time",
    "Mobility",
    "minutes",
    "Requires purpose-specific origin/destination demand and a routing or traffic assignment run.",
    "Demand-weighted home-to-work travel times",
  );
  missing(
    "mobility.peakDelay",
    "Peak-hour delay",
    "Mobility",
    "minutes",
    "Requires peak-hour assignment, junction controls, and traffic-count calibration.",
    "Assigned travel time − uncongested travel time",
  );
  missing(
    "mobility.los",
    "Intersection level of service",
    "Mobility",
    "grade",
    "Requires control-delay estimates and the appropriate signalized/unsignalized methodology. Rendered queues do not establish LOS.",
    "Validated control delay classified by the applicable intersection method",
  );
  missing(
    "mobility.transitRidership",
    "Transit ridership",
    "Mobility",
    "boardings/day",
    "Requires transit schedules, origins/destinations, and calibrated mode/transfer assignment. A mode-share slider alone does not establish boardings.",
    "Assigned transit passenger trips plus transfers",
  );

  const baselineFlows = fiscalCashFlowsKnown(
      place,
      scenario,
      20,
      true,
      activity,
    ),
    flows = fiscalCashFlowsKnown(place, scenario, 20, false, activity);
  const bYear = baselineFlows[0],
    year = flows[0];
  const fiscalInputs = [
    input("Receiving jurisdiction", a.jurisdictionName),
    input("Effective retained property levy", a.effectivePropertyTaxRate),
    input("Retained sales-tax rate", a.localSalesTaxRate),
    input("Annual service cost per resident", a.annualServiceCostPerResident),
    input("Annual service cost per job", a.annualServiceCostPerJob),
    ...(activity
      ? [
          input(
            "Population reference",
            activity.population.reference ?? "Unavailable",
            activity.population.referenceLabel,
          ),
          input(
            "Effective residents at horizon",
            activity.population.value ?? "Unavailable",
            USER_ACTIVITY_SOURCE_ID,
          ),
          input(
            "Effective jobs at horizon",
            activity.employment.value ?? "Unavailable",
            USER_ACTIVITY_SOURCE_ID,
          ),
          input(
            "Activity method",
            "Targets apply once at the selected horizon; subsequent fiscal years apply annual growth once",
            USER_ACTIVITY_SOURCE_ID,
          ),
        ]
      : matchingCensusPopulation(place)
        ? [
            input(
              "Existing community population",
              place.demographics!.measures.population.estimate.value!,
              place.demographics!.source.name,
            ),
            input(
              "Population source geography",
              `Whole ZCTA ${place.demographics!.geography.id}`,
              place.demographics!.source.name,
            ),
            input(
              "Population estimate period",
              `${place.demographics!.period.start}–${place.demographics!.period.end}`,
              place.demographics!.source.name,
            ),
            input(
              "Population 90% margin of error",
              place.demographics!.measures.population.marginOfError.value ??
                "Unavailable",
              place.demographics!.source.name,
            ),
            input(
              "Population scenario method",
              "Published population + changed dwelling units × occupancy × household size; then scenario population multiplier and growth",
              ASSUMPTION_SOURCE,
            ),
          ]
        : []),
  ];
  add(
    "fiscal.propertyTax",
    "Annual property revenue",
    "Fiscal",
    "$/year",
    bYear.propertyRevenue,
    year.propertyRevenue,
    "Supplied assessed values (or floor area × assumed value/ft²) × effective retained jurisdiction levy",
    "Gross property revenue before scenario abatements.",
    { ...fiscalStatus, inputs: fiscalInputs },
  );
  add(
    "fiscal.salesTax",
    "Annual sales revenue",
    "Fiscal",
    "$/year",
    bYear.salesRevenue,
    year.salesRevenue,
    "Retail ft² × sales/ft² × local capture assumption × retained tax rate × growth",
    "Illustrative taxable-sales capacity calculation. This is not a measured retail-leakage result.",
    {
      ...fiscalStatus,
      inputs: [
        ...fiscalInputs,
        input("Sales per retail ft²", a.salesPerSqft),
        input("Local taxable-sales capture", a.retailCaptureRate),
      ],
    },
  );
  add(
    "fiscal.serviceCost",
    "Annual cost to serve",
    "Fiscal",
    "$/year",
    bYear.serviceCost,
    year.serviceCost,
    "Estimated residents × service cost/resident + direct jobs × service cost/job",
    activity
      ? "Resident and workplace service costs use the effective activity counts at the selected horizon, including local exceptions. Buildings and tax-base values are unchanged. Following years apply annual growth once; these counts are planning assumptions, not observed occupancy or calibrated forecasts."
      : matchingCensusPopulation(place)
        ? "Existing population uses the published ACS estimate for the exact ZCTA. Scenario dwelling changes add or remove assumed residents; population multipliers and growth are explicit scenarios, not Census forecasts. ACS sampling uncertainty is not propagated into fiscal totals. Resident migration, capital infrastructure, and the difference between ZCTA and taxing jurisdiction remain unmodeled. Census housing totals do not replace mapped building programs."
        : "Per-capita and per-job operating-cost model using housing-derived resident capacity; capital infrastructure is not included.",
    { ...fiscalStatus, inputs: fiscalInputs },
  );
  add(
    "fiscal.netAnnual",
    "Net annual fiscal impact",
    "Fiscal",
    "$/year",
    bYear.netRevenue,
    year.netRevenue,
    "Property revenue + sales revenue − service cost − abatement − first-year grant",
    "First forecast-year operating balance. Delta is the scenario’s incremental fiscal effect versus its frozen baseline profile.",
    { ...fiscalStatus, inputs: fiscalInputs },
  );
  add(
    "fiscal.netPerAcre",
    "Net fiscal impact / acre",
    "Fiscal",
    "$/acre",
    acres > 0 ? bYear.netRevenue / acres : null,
    acres > 0 ? year.netRevenue / acres : null,
    "First forecast-year net operating revenue ÷ study-boundary acres",
    "Uses gross study-area acres, not an inferred legal parcel area.",
    {
      ...fiscalStatus,
      inputs: [
        ...fiscalInputs,
        input("Gross study acres", acres, "Boundary geometry"),
      ],
    },
  );
  add(
    "fiscal.net20Years",
    "20-year net fiscal impact",
    "Fiscal",
    "$",
    baselineFlows.reduce((s, f) => s + f.netRevenue, 0),
    flows.reduce((s, f) => s + f.netRevenue, 0),
    "Sum of annual net operating cash flows for 20 years",
    "Undiscounted constant-dollar sum. Population/employment and sales grow at the entered rate; assessed value remains constant absent a valuation schedule.",
    {
      ...fiscalStatus,
      inputs: [...fiscalInputs, input("Annual growth", a.annualGrowthRate)],
    },
  );
  add(
    "fiscal.npv",
    "20-year fiscal NPV",
    "Fiscal",
    "$",
    baselineFlows.reduce((s, f) => s + f.discountedNet, 0),
    flows.reduce((s, f) => s + f.discountedNet, 0),
    "Sum of annual operating cash flow after abatement / (1 + real discount rate)^year − up-front grant",
    "Recurring flows are discounted at each year end. The grant occurs at time zero; abatements apply only added property value. Compare the delta for incremental scenario NPV.",
    {
      ...fiscalStatus,
      inputs: [...fiscalInputs, input("Real discount rate", a.discountRate)],
    },
  );
  let cumulativeIncremental = 0;
  let payback: number | null =
    a.incentiveGrant === 0 && a.abatementPercent === 0 ? 0 : null;
  if (payback !== 0) {
    for (let i = 0; i < flows.length; i++) {
      cumulativeIncremental +=
        flows[i].netRevenue - baselineFlows[i].netRevenue;
      if (cumulativeIncremental >= 0) {
        payback = i + 1;
        break;
      }
    }
  }
  add(
    "fiscal.incentivePayback",
    "Incentive payback",
    "Fiscal",
    "years",
    0,
    payback,
    "First year cumulative incremental scenario net cash flow, including incentive costs, becomes nonnegative",
    payback === null
      ? "Incentive payback is not reached within the 20-year analysis period."
      : payback === 0
        ? "No grant or abatement is configured."
        : "Undiscounted payback against the unchanged baseline, rounded up to the first recovered year.",
    {
      ...fiscalStatus,
      ...(payback === null ? { status: "incomplete" as const } : {}),
      inputs: [
        input("Up-front grant", a.incentiveGrant),
        input("Abatement fraction on added value", a.abatementPercent),
        input("Abatement years", a.abatementYears),
      ],
      caveat:
        "Not reached is a valid modeled outcome, not missing data. Payback is not a substitute for NPV or policy objectives.",
    },
  );
  missing(
    "fiscal.fees",
    "Development fee revenue",
    "Fiscal",
    "$",
    "Supply the jurisdiction’s fee schedules, exemptions, and timing.",
    "Applicable fee schedule × eligible development quantities",
  );

  add(
    "land.floorArea",
    "Gross floor area",
    "Land & form",
    "ft²",
    base.floorSqft,
    next.floorSqft,
    "Sum of building footprint m² × floors × 10.76391041671",
    "Gross floor area includes parking structures. Zoning-specific exemptions require a local ruleset.",
  );
  add(
    "land.footprint",
    "Built footprint",
    "Land & form",
    "m²",
    base.footprintSqm,
    next.footprintSqm,
    "Sum of nonpark, nonvacant footprints",
    "Sum of entered footprint areas, without parcel union or road pavement. Overlapping structures require geometry validation.",
  );
  add(
    "land.openSpace",
    "Mapped park area",
    "Land & form",
    "acres",
    base.parkSqm / SQM_PER_ACRE,
    next.parkSqm / SQM_PER_ACRE,
    "Sum of park-classified feature area ÷ 4,046.8564224",
    "Mapped/designated park area. Ownership, public access, and canopy are not inferred.",
  );
  add(
    "land.openSpacePerResident",
    "Park area / modeled resident",
    "Land & form",
    "m²/person",
    (activity ? activity.population.baseline : base.residents)
      ? base.parkSqm /
          (activity ? activity.population.baseline! : base.residents)
      : null,
    (activity ? activity.population.value : next.residents)
      ? next.parkSqm / (activity ? activity.population.value! : next.residents)
      : null,
    "Park-classified area ÷ housing-derived residents",
    "Screening ratio; does not establish accessible public open space.",
    assumed,
  );
  const parcels = evidence.parcels;
  if (place.parcels !== undefined || scenario.parcelEdits !== undefined) {
    const baselineParcels = place.parcels ?? [],
      proposalParcels = materializeParcels(place, scenario);
    const baselineSet = parcelSetDevelopment(baselineParcels, place.buildings),
      proposalSet = parcelSetDevelopment(proposalParcels, buildings);
    const sources = [
      ...new Set(
        [...baselineParcels, ...proposalParcels].flatMap((p) => [
          p.sourceId,
          ...(p.geometrySourceId ? [p.geometrySourceId] : []),
          ...(p.lineage?.sourceIds ?? []),
        ]),
      ),
    ];
    const caveat = [
      "Only parcel-kind geometry contributes; block outlines are excluded. Baseline and proposal use their own captured/materialized parcel sets. A missing parcel set is unavailable, never zero. Geometric associations are not verified legal assignments. An aggregate across the parcel union can be calculated even when a building straddles an internal lot boundary; it does not resolve the individual lots' floor-area assignments.",
      ...new Set([
        ...(baselineSet?.development.caveats ?? []),
        ...(proposalSet?.development.caveats ?? []),
      ]),
    ].join(" ");
    const details = {
      sourceIds: [...new Set([...sources, ...sourceIds])],
      status: "incomplete" as const,
      caveat,
      inputs: [
        input(
          "Baseline parcel land area (m²)",
          baselineSet?.areaSqm ?? "Unavailable",
          "Captured parcel geometry",
        ),
        input(
          "Proposal parcel land area (m²)",
          proposalSet?.areaSqm ?? "Unavailable",
          "Materialized parcel geometry",
        ),
      ],
    };
    add(
      "land.far",
      "Floor area ratio",
      "Land & form",
      "FAR",
      baselineSet?.development.far ?? null,
      proposalSet?.development.far ?? null,
      "Whole-contained building gross floor area ÷ parcel land union area",
      "Uses whole-footprint geometric matches. Buildings crossing the parcel-set boundary make floor-area totals unavailable; no fractional floor allocation.",
      {
        ...details,
        ...((baselineSet?.development.quantityCoverage.floorArea
          .missingBuildingIds.length ??
          0) ||
        (proposalSet?.development.quantityCoverage.floorArea.missingBuildingIds
          .length ??
          0)
          ? {
              status:
                proposalSet?.development.far == null
                  ? ("unavailable" as const)
                  : ("incomplete" as const),
              coverage: {
                baseline: {
                  missingBuildingIds:
                    baselineSet?.development.quantityCoverage.floorArea
                      .missingBuildingIds ?? [],
                },
                scenario: {
                  missingBuildingIds:
                    proposalSet?.development.quantityCoverage.floorArea
                      .missingBuildingIds ?? [],
                },
              },
            }
          : {}),
      },
    );
    add(
      "land.lotCoverage",
      "Lot coverage",
      "Land & form",
      "%",
      baselineSet?.development.lotCoveragePercent ?? null,
      proposalSet?.development.lotCoveragePercent ?? null,
      "Union of structural footprints intersecting parcel land ÷ parcel land union area × 100",
      "Clipped footprint union prevents double counting. Roads, paved parking, and landscaping are not included.",
      details,
    );
  } else if (parcels && parcels.parcels.length) {
    const ids = new Set(parcels.parcels.map((p) => p.id));
    const parcelArea = parcels.parcels.reduce((s, p) => s + p.areaSqm, 0);
    if (
      !Number.isFinite(parcelArea) ||
      parcels.parcels.some((p) => p.areaSqm <= 0)
    )
      throw new RangeError("Parcel areas must be finite and positive.");
    const stats = (items: Building[]) => {
      const matched = items.filter((b) => b.parcelId && ids.has(b.parcelId));
      return {
        floor: aggregateBuildingQuantity(
          matched,
          (b) => buildingProgramTotals(b).grossFloorAreaSqm,
        ).value,
        footprint: matched.reduce(
          (sum, b) =>
            sum + (["park", "vacant"].includes(b.use) ? 0 : buildingAreaSqm(b)),
          0,
        ),
      };
    };
    const bs = stats(place.buildings),
      ns = stats(buildings);
    const details = {
      sourceIds: [parcels.sourceId],
      geography: parcels.geography,
      inputs: [input("Matched parcel area (m²)", parcelArea, parcels.sourceId)],
      caveat:
        "Aggregate ratio across supplied parcels; only buildings linked by parcel ID contribute. Overlapping polygons must be normalized during ingestion.",
    };
    add(
      "land.far",
      "Floor area ratio",
      "Land & form",
      "FAR",
      bs.floor === null ? null : bs.floor / parcelArea,
      ns.floor === null ? null : ns.floor / parcelArea,
      "Matched building gross floor area ÷ supplied parcel land area",
      "Computed using actual parcel associations rather than treating a footprint as a parcel.",
      details,
    );
    add(
      "land.lotCoverage",
      "Lot coverage",
      "Land & form",
      "%",
      (bs.footprint / parcelArea) * 100,
      (ns.footprint / parcelArea) * 100,
      "Matched building footprints ÷ supplied parcel area × 100",
      "Building footprint coverage; roads, parking, and landscaping are separate.",
      details,
    );
  } else {
    missing(
      "land.far",
      "Floor area ratio",
      "Land & form",
      "FAR",
      "Supply parcel boundaries/areas and link buildings to parcels. A building footprint is not a legal parcel.",
      "Gross floor area ÷ parcel land area",
    );
    missing(
      "land.lotCoverage",
      "Lot coverage",
      "Land & form",
      "%",
      "Supply parcel geometry and building associations.",
      "Building footprint union ÷ parcel land area × 100",
    );
  }
  add(
    "land.heightConflicts",
    "Known height conflicts",
    "Land & form",
    "buildings",
    base.heightChecked ? base.heightViolations : null,
    next.heightChecked ? next.heightViolations : null,
    "Count of buildings exceeding their supplied maximum height",
    "Checks only features with a supplied height limit; absent limits do not imply conformance.",
    {
      inputs: [
        input(
          "Buildings with supplied height rule",
          next.heightChecked,
          "Building rule attributes",
        ),
      ],
      caveat:
        "Height screening is not full zoning conformance; use, FAR, setbacks, overlays, and exceptions require a reviewed ordinance ruleset.",
    },
  );
  missing(
    "land.impervious",
    "Impervious surface",
    "Land & form",
    "m²",
    "Supply classified land cover or impervious-surface geometry; footprints omit roads and paved parking.",
    "Union area of classified impervious surfaces",
  );

  const access = evidence.access;
  const currentAccess =
    access?.scenarioRevision === scenario.revision ? access : undefined;
  for (const mode of ["car", "transit", "walk"] as const) {
    const capturedAccess =
      mode === "transit" ? undefined : scenario.accessibility?.captures[mode];
    for (const [index, minutes] of [15, 30, 45].entries()) {
      const before = currentAccess?.baselineJobs[mode]?.[index],
        after = currentAccess?.scenarioJobs[mode]?.[index];
      if (before !== undefined && after !== undefined)
        add(
          `access.${mode}${minutes}`,
          `Jobs within ${minutes} min · ${mode}`,
          "Access & equity",
          "jobs",
          before,
          after,
          "Cumulative jobs reachable within the specified network-time budget",
          "Reachability comes from the supplied regional routing run and may extend beyond the editable area.",
          {
            sourceIds: [currentAccess!.sourceId],
            geography: currentAccess!.geography,
            method: "Regional cumulative-opportunity routing",
            inputs: [
              input("Travel mode", mode, "Routing run"),
              input("Time budget (minutes)", minutes, "Routing run"),
              input(
                "Transit service date",
                currentAccess!.serviceDate ?? "Not supplied",
                "Routing run",
              ),
            ],
          },
        );
      else
        missing(
          `access.${mode}${minutes}`,
          `Jobs within ${minutes} min · ${mode}`,
          "Access & equity",
          "jobs",
          access && !currentAccess
            ? "Routing evidence is stale for this scenario revision; rerun accessibility."
            : capturedAccess
              ? `Saved ${mode} jobs accessibility is available in the captured-network summary for origin ${capturedAccess.capture.request.site.join(", ")}. It describes the retained source network, not the effects of this scenario's roads, buildings or horizon. A comparable baseline and proposal network analysis is still required for this change metric.`
              : `Supply regional ${mode} routing and destination employment; the editable ZIP alone is insufficient.`,
          "Sum of jobs reachable within the network travel-time budget",
        );
    }
  }
  missing(
    "access.walkProxy",
    "Essential-destination walk access",
    "Access & equity",
    "index",
    "Requires pedestrian routing and classified essential destinations with an explicit distance-decay method.",
    "Weighted access to essential destination categories",
  );
  const addEquity = (
    id: string,
    label: string,
    before: number | undefined,
    after: number | undefined,
  ) => {
    if (before !== undefined && after !== undefined && currentAccess)
      add(
        id,
        label,
        "Access & equity",
        "jobs",
        before,
        after,
        "Population-weighted 30-minute job access for the specified cohort",
        "Cohort access from supplied regional network and demographic allocation.",
        {
          sourceIds: [currentAccess.sourceId],
          geography: currentAccess.geography,
        },
      );
    else
      missing(
        id,
        label,
        "Access & equity",
        "jobs",
        "Supply current routing results and population allocation for the relevant cohort.",
        "Cohort population-weighted jobs reachable in 30 minutes",
      );
  };
  addEquity(
    "access.lowIncome",
    "30-minute access · low-income residents",
    currentAccess?.baselineLowIncomeJobs30,
    currentAccess?.scenarioLowIncomeJobs30,
  );
  addEquity(
    "access.noCar",
    "30-minute transit access · no-car households",
    currentAccess?.baselineNoCarTransitJobs30,
    currentAccess?.scenarioNoCarTransitJobs30,
  );

  add(
    "environment.ghg",
    "Annual transport CO₂",
    "Environment",
    "tCO₂/year",
    base.ghg,
    next.ghg,
    "Daily vehicle miles × 365 × kg CO₂/mile ÷ 1,000",
    "Screening tailpipe CO₂ estimate from the entered average emission factor; not a lifecycle or all-greenhouse-gas inventory.",
    {
      ...assumed,
      inputs: [
        input("Emission factor (kg CO₂/mile)", a.emissionsKgPerMile),
        input("Average trip length (miles)", a.averageTripMiles),
      ],
      caveat:
        "Starter factor is illustrative. Fleet, speed, year, starts/idling, electric generation, and non-CO₂ gases require a documented emissions model.",
    },
  );
  const environment =
    evidence.environment?.scenarioRevision === scenario.revision
      ? evidence.environment
      : undefined;
  const envExtra = environment
    ? {
        sourceIds: [environment.sourceId],
        geography: environment.geography,
        method: "Source-backed environmental screening",
      }
    : {};
  if (
    environment?.baselineCanopySqm !== undefined &&
    environment.scenarioCanopySqm !== undefined
  )
    add(
      "environment.canopy",
      "Tree canopy",
      "Environment",
      "acres",
      environment.baselineCanopySqm / SQM_PER_ACRE,
      environment.scenarioCanopySqm / SQM_PER_ACRE,
      "Observed or explicitly modeled canopy area ÷ 4,046.8564224",
      "Canopy is distinct from park area; future growth must be supplied explicitly.",
      envExtra,
    );
  else
    missing(
      "environment.canopy",
      "Tree canopy",
      "Environment",
      "acres",
      "Supply observed canopy geometry and explicit scenario canopy changes.",
      "Union area of tree canopy",
    );
  if (
    environment?.stormDepthMm !== undefined &&
    environment.baselineCurveNumber !== undefined &&
    environment.scenarioCurveNumber !== undefined &&
    areaSqm > 0
  ) {
    if (
      environment.stormDepthMm < 0 ||
      !Number.isFinite(environment.stormDepthMm) ||
      ![environment.baselineCurveNumber, environment.scenarioCurveNumber].every(
        (v) => Number.isFinite(v) && v > 0 && v <= 100,
      )
    )
      throw new RangeError(
        "Runoff requires nonnegative storm depth and curve numbers greater than 0 and at most 100.",
      );
    add(
      "environment.runoff",
      "Storm-event runoff",
      "Environment",
      "m³/event",
      (runoffDepthMm(
        environment.stormDepthMm,
        environment.baselineCurveNumber,
      ) /
        1000) *
        areaSqm,
      (runoffDepthMm(
        environment.stormDepthMm,
        environment.scenarioCurveNumber,
      ) /
        1000) *
        areaSqm,
      "S = 25,400/CN − 254 mm; Q = (P − 0.2S)² / (P + 0.8S) for P > 0.2S, else 0; volume = Q × area",
      "NRCS curve-number screening for the specified storm. Requires appropriate soils, land-cover classification, and study-area coefficients.",
      {
        ...envExtra,
        method: "NRCS curve-number event runoff",
        inputs: [
          input(
            "Storm depth (mm)",
            environment.stormDepthMm,
            environment.sourceId,
          ),
          input(
            "Scenario curve number",
            environment.scenarioCurveNumber,
            environment.sourceId,
          ),
        ],
        caveat:
          "Event runoff volume does not establish drainage capacity, peak flow, or flood protection.",
      },
    );
  } else
    missing(
      "environment.runoff",
      "Storm-event runoff",
      "Environment",
      "m³/event",
      "Supply storm depth and hydrologic soil/land-cover curve numbers for baseline and scenario.",
      "NRCS curve-number event runoff depth × study area",
    );
  if (
    environment?.baselineHeatExposureIndex !== undefined &&
    environment.scenarioHeatExposureIndex !== undefined
  )
    add(
      "environment.heat",
      "Relative heat exposure",
      "Environment",
      "index",
      environment.baselineHeatExposureIndex,
      environment.scenarioHeatExposureIndex,
      "Supplied, versioned canopy/imperviousness exposure model",
      "Relative exposure index, not an air-temperature prediction.",
      envExtra,
    );
  else
    missing(
      "environment.heat",
      "Relative heat exposure",
      "Environment",
      "index",
      "Requires canopy/imperviousness and a locally validated baseline land-surface-temperature relationship.",
      "Versioned canopy/imperviousness exposure proxy",
    );
  if (scenario.flood) {
    const flood = resolveFloodExposure(place, scenario, context);
    const dataset = context.floodDatasets?.[scenario.flood.datasetHash];
    const missingIds = (side: typeof flood.baseline) =>
      [
        ...new Set([
          ...side.missingUnitBuildingIds,
          ...side.unclassifiedBuildingIds,
        ]),
      ].sort();
    add(
      "environment.flood",
      "Homes in SFHA-intersecting buildings",
      "Environment",
      "units",
      flood.baseline.value,
      flood.scenario.value,
      "Sum each building's recorded homes once when its complete footprint has positive-area intersection with effective Special Flood Hazard Area geometry",
      flood.error ??
        "Both building sets are evaluated against the same frozen effective map. Entire building home counts are screened; no proportional home allocation, occupancy assumption or horizon growth is applied.",
      {
        status: flood.scenario.value === null ? "unavailable" : flood.status,
        method: "Effective FEMA flood-map footprint screening",
        methodVersion: flood.methodVersion,
        sourceIds: [
          ...new Set([
            ...sourceIds,
            ...(!flood.error ? (dataset?.sources.map((s) => s.id) ?? []) : []),
          ]),
        ],
        coverage: {
          baseline: {
            knownSubtotal: flood.baseline.knownSubtotal,
            missingBuildingIds: missingIds(flood.baseline),
          },
          scenario: {
            knownSubtotal: flood.scenario.knownSubtotal,
            missingBuildingIds: missingIds(flood.scenario),
          },
        },
        inputs: [
          input(
            "Dataset SHA-256",
            scenario.flood.datasetHash,
            "Selected immutable flood dataset",
          ),
          input(
            "Evidence origin",
            scenario.flood.origin,
            "Saved reference; hashes alone do not establish server authority",
          ),
          input(
            "Baseline buildings with unknown homes",
            flood.baseline.missingUnitBuildingIds.length,
            "Captured geometry and quantities",
          ),
          input(
            "Proposal buildings with unclassified exposure",
            flood.scenario.unclassifiedBuildingIds.length,
            "Classified map coverage and geometry checks",
          ),
        ],
        caveat: flood.warnings.join(" "),
        desirable: "decrease",
      },
    );
    warnings.push(...flood.warnings);
  } else if (
    environment?.baselineFloodExposedUnits !== undefined &&
    environment.scenarioFloodExposedUnits !== undefined
  )
    add(
      "environment.flood",
      "Homes in mapped flood hazard",
      "Environment",
      "units",
      environment.baselineFloodExposedUnits,
      environment.scenarioFloodExposedUnits,
      "Dwelling units intersecting the effective mapped flood-hazard layer",
      "Exposure to the supplied hazard map; map coverage gaps do not establish safety.",
      envExtra,
    );
  else
    missing(
      "environment.flood",
      "Homes in mapped flood hazard",
      "Environment",
      "units",
      "Supply effective flood-hazard geometry and an exposure intersection for this revision.",
      "Homes intersecting effective mapped hazard zones",
    );

  const safety =
    evidence.safety?.scenarioRevision === scenario.revision
      ? evidence.safety
      : undefined;
  const safetyMetrics = [
    [
      "safety.conflicts",
      "Pedestrian / bike conflict points",
      "locations",
      safety?.baselineConflictPoints,
      safety?.scenarioConflictPoints,
      "Count of crossing/turn/driveway conflicts in a reviewed multimodal topology",
    ],
    [
      "safety.highInjury",
      "Trips exposed to high-injury corridors",
      "trips/day",
      safety?.baselineHighInjuryTrips,
      safety?.scenarioHighInjuryTrips,
      "Assigned trips intersecting authoritative high-injury corridors",
    ],
    [
      "safety.emergencyCoverage",
      "Emergency travel-time coverage",
      "%",
      safety?.baselineEmergencyCoveragePercent,
      safety?.scenarioEmergencyCoveragePercent,
      "Population within the selected station travel-time budget including dispatch/turnout assumptions",
    ],
  ] as const;
  for (const [id, label, unit, before, after, formula] of safetyMetrics) {
    if (before !== undefined && after !== undefined && safety)
      add(
        id,
        label,
        "Safety",
        unit,
        before,
        after,
        formula,
        "Screening evidence tied to this scenario revision. Exposure is not a prediction of crashes or an emergency-response guarantee.",
        { sourceIds: [safety.sourceId], geography: safety.geography },
      );
    else
      missing(
        id,
        label,
        "Safety",
        unit,
        "Supply the relevant network/exposure evidence for this revision; road graphics alone cannot substantiate this metric.",
        formula,
      );
  }

  if (
    [...place.buildings, ...buildings].some(
      (b) =>
        b.height === null ||
        b.floors === null ||
        b.units === null ||
        b.jobs === null ||
        b.parkingSpaces === null,
    )
  )
    warnings.push(
      "Some building quantities are explicitly unknown. Dependent complete totals and comparisons are withheld; known subtotals do not fill the missing attributes.",
    );
  if (buildings.some((b) => b.estimated))
    warnings.push(
      "Some building attributes are inferred or user-estimated. Inspect source details before relying on totals.",
    );
  if (!a.tripRatesConfirmed || !baselineA.tripRatesConfirmed)
    warnings.push(
      "Trip-generation coefficients are illustrative defaults until reviewed or replaced with an authorized local profile.",
    );
  if (!a.fiscalInputsConfirmed || !baselineA.fiscalInputsConfirmed)
    warnings.push(
      "Fiscal inputs have not been confirmed for both the baseline and scenario jurisdiction profiles.",
    );
  if (a.jurisdictionName === "Unconfigured jurisdiction")
    warnings.push(
      "Choose the receiving fiscal jurisdiction; a ZIP boundary does not define taxing authority.",
    );
  if (scenario.horizon > 0)
    warnings.push(
      "Forecast demand grows under explicit assumptions; geometry and physical housing capacity remain unchanged unless edited.",
    );
  if (next.heightViolations > 0)
    warnings.push(
      `${next.heightViolations} building${next.heightViolations === 1 ? "" : "s"} exceed a supplied height limit. Zoning warnings do not block edits.`,
    );
  if (next.heightChecked < buildings.length)
    warnings.push(
      "Zoning limits are missing for some buildings. No conflict detected does not mean zoning conformance.",
    );
  if (place.population !== undefined || place.demographics)
    warnings.push(
      "Housing-derived residents are separate from any published area population; partial geographic samples must not be presented as full-ZIP totals.",
    );
  if (!activity && matchingCensusPopulation(place))
    warnings.push(
      "Fiscal resident-service costs use the published ACS population only for the matching whole ZCTA. Scenario population changes are planning assumptions; mapped buildings and Census housing units have not been reconciled.",
    );
  if (roads.some((r) => r.closed) || Object.keys(scenario.roadEdits).length > 0)
    warnings.push(
      "Road geometry changes are reflected in network measures. Commute, delay, and accessibility require a new network assignment run.",
    );
  if (
    [evidence.access, evidence.environment, evidence.safety].some(
      (e) => e && e.scenarioRevision !== scenario.revision,
    )
  )
    warnings.push(
      "Some supplied analytical evidence belongs to an earlier revision and has been excluded.",
    );
  const explicitPrograms = [...place.buildings, ...buildings].filter(
    (b) => b.program,
  );
  if (explicitPrograms.length) {
    warnings.push(
      ...new Set(
        [...place.buildings, ...buildings].flatMap(buildingProgramWarnings),
      ),
    );
    for (const result of metrics) {
      // Several metrics share immutable input templates; never append into that shared array.
      result.inputs = [...result.inputs];
      if (result.id === "housing.mixed-use") {
        result.label = "Unclassified mixed-use homes";
        result.formula =
          "Sum homes in legacy mixed-use records without an explicit component program";
        result.explanation =
          "Homes on legacy mixed-use building records without an explicit component housing type. Explicit programs classify their homes as houses, townhomes, or apartments; this row is not the total number of homes located in mixed-use buildings.";
      }
      if (
        [
          "housing.residential",
          "housing.multifamily",
          "housing.townhome",
        ].includes(result.id)
      ) {
        result.formula =
          "Sum homes by explicit component housing type; legacy records use their building-use classification";
        result.explanation =
          "Housing mix describes the entered residential type. Homes in an explicit mixed-use program are classified by that residential component, not counted again as a separate mixed-use housing category.";
      }
      if (result.id === "mobility.dailyTrips") {
        result.formula =
          "Sum(component rate × its explicit dwelling/occupied-dwelling/1,000 ft²/job/bed denominator) + legacy demand; residential demand × population multiplier, then growth × drive share / 0.80 × vehicle multiplier";
        result.inputs = result.inputs.map((i) =>
          i.name === "Trip-rate units"
            ? {
                ...i,
                value:
                  "Vehicle-trip ends per stated component denominator per day at 80% reference drive share; legacy rates per occupied home or 1,000 ft²",
              }
            : i,
        );
      }
      if (result.id === "mobility.parkingDemand")
        result.formula =
          "Sum(component parking rate × stated denominator); fallback residential homes × spaces/home plus nonresidential 1,000 ft² × spaces rate; no default garage/common-area demand";
      if (
        result.id === "mobility.dailyTrips" ||
        result.id === "mobility.parkingDemand"
      ) {
        const kind = result.id === "mobility.dailyTrips" ? "trips" : "parking";
        result.inputs.push(
          ...programRateInputs("Baseline", place.buildings, baselineA, kind),
          ...programRateInputs("Proposal", buildings, a, kind),
        );
      }
      if (result.id === "land.floorArea")
        result.formula =
          "Sum of explicit declared building-program GFA; legacy buildings use recorded footprint area × floors; m² × 10.76391041671";
      if (
        [
          "land.floorArea",
          "land.far",
          "mobility.dailyTrips",
          "mobility.parkingDemand",
          "economy.payroll",
          "fiscal.propertyTax",
          "fiscal.salesTax",
        ].includes(result.id)
      ) {
        result.inputs.push({
          name: "Explicit program buildings",
          value: `Baseline ${place.buildings.filter((b) => b.program).length}; proposal ${buildings.filter((b) => b.program).length}`,
          source:
            "Captured baseline and scenario component programs; each component records its use, quantity, and rate denominator",
        });
        result.caveat = [
          result.caveat,
          "Explicit component programs retain entered homes/jobs. Component rate overrides use their stated denominator; absent overrides use editable illustrative jurisdiction rates. Common area contributes GFA/value but no independent trips or parking demand.",
        ]
          .filter(Boolean)
          .join(" ");
      }
    }
  }
  if (activity) {
    const settings = scenario.activity!,
      affectedJobs = new Set([
        "economy.jobs",
        "economy.payroll",
        "economy.indirectJobs",
        "economy.inducedJobs",
        "economy.output",
        "housing.jobsHousingBalance",
      ]);
    const affectedFiscal = new Set([
      "fiscal.serviceCost",
      "fiscal.netAnnual",
      "fiscal.netPerAcre",
      "fiscal.net20Years",
      "fiscal.npv",
      "fiscal.incentivePayback",
    ]);
    for (const m of metrics) {
      if (m.id === "housing.residents")
        m.inputs = [
          input("Household size", a.householdSize),
          input("Vacancy rate", a.vacancyRate),
          input(
            "Separation",
            "Activity targets do not resize physical housing capacity",
            USER_ACTIVITY_SOURCE_ID,
          ),
        ];
      if (m.id === "economy.jobs") {
        m.formula =
          "Global horizon employment + Σ(neighborhood employment target − allocated global employment)";
        m.explanation =
          "Effective workplace-employment scenario; entered building jobs are retained separately. Activity targets are not observed occupied jobs.";
      }
      if (affectedJobs.has(m.id) || affectedFiscal.has(m.id)) {
        m.inputs = [
          ...m.inputs,
          input(
            "Effective employment at horizon",
            activity.employment.value ?? "Unavailable",
            USER_ACTIVITY_SOURCE_ID,
          ),
          input(
            "Employment reference",
            activity.employment.reference ?? "Unavailable",
            activity.employment.referenceLabel,
          ),
        ];
        m.sourceIds = [
          ...new Set([
            ...m.sourceIds,
            ...activity.employment.sourceIds,
            ...(affectedFiscal.has(m.id) ? activity.population.sourceIds : []),
          ]),
        ];
        if (m.value !== null) m.status = "incomplete";
      }
      if (m.id === "land.openSpacePerResident") {
        m.formula = "Mapped park area ÷ effective scenario residents";
        m.explanation =
          "Park area per effective resident; it does not establish accessible public open space.";
        m.sourceIds = [
          ...new Set([...m.sourceIds, ...activity.population.sourceIds]),
        ];
      }
      if (
        [
          "mobility.dailyTrips",
          "mobility.vmt",
          "mobility.parkingDemand",
          "mobility.parkingBalance",
          "environment.ghg",
        ].includes(m.id)
      ) {
        m.inputs = [
          ...m.inputs,
          input(
            "Population demand response",
            settings.demandResponse.population,
            settings.demandResponse.sourceId,
          ),
          input(
            "Employment demand response",
            settings.demandResponse.employment,
            settings.demandResponse.sourceId,
          ),
          input(
            "Household-vehicle demand response",
            settings.demandResponse.vehicles,
            settings.demandResponse.sourceId,
          ),
          input(
            "Household-stock ratio",
            activity.vehicleDemandFactor ?? "Unavailable",
            activity.vehicles.referenceLabel,
          ),
        ];
        m.sourceIds = [
          ...new Set([
            ...m.sourceIds,
            settings.demandResponse.sourceId,
            ...activity.population.sourceIds,
            ...activity.employment.sourceIds,
            ...(settings.demandResponse.vehicles !== "none"
              ? activity.vehicles.sourceIds
              : []),
          ]),
        ];
        m.caveat = `${m.caveat ?? ""} Reviewed proportional activity sensitivities reweight residential demand and job-based or office/industrial/warehouse floor-area demand. Bed and other customer/visitor denominators remain unchanged. Household-stock response replaces the residential population response, never multiplies both. A reviewed zero target explicitly removes eligible demand even with a zero or unknown reference; positive targets require a usable positive denominator. No traffic assignment or observed trip count is implied.`;
        if (
          m.id === "mobility.parkingDemand" ||
          m.id === "mobility.parkingBalance"
        )
          m.caveat +=
            " Employment parking response removes the horizon-growth term from its denominator because parking has no later growth step. Dwelling, occupied-dwelling, bed and customer parking quantities retain their physical denominators.";
        if (m.value !== null) m.status = "incomplete";
      }
      if (m.id === "mobility.dailyTrips")
        m.formula =
          "Sum entered program reference demand × eligible local activity response; then horizon growth × drive share / 0.80 × legacy trip-demand multiplier. Household-stock ratio replaces residential population ratio when selected.";
      if (m.value === null && m.id !== "fiscal.incentivePayback")
        m.status = "unavailable";
    }
    if (
      (activity.population.value === null ||
        activity.employment.value === null) &&
      payback !== 0
    ) {
      const m = metrics.find((m) => m.id === "fiscal.incentivePayback")!;
      m.value = null;
      m.delta = null;
      m.status = "unavailable";
      m.explanation =
        "A complete effective resident and employment count is required to evaluate payback; missing activity is not a zero cost.";
    }
  }
  // A numerically exact sum of inferred building programs is still an estimate.
  // Preserve the distinction between observed footprints and estimated use/floors/units.
  const housingProgramInferred = [...place.buildings, ...buildings].some(
    (b) =>
      b.estimated &&
      ((b.units !== null && b.units > 0) ||
        ["residential", "multifamily", "mixed-use"].includes(b.use)),
  );
  const floorProgramInferred = [...place.buildings, ...buildings].some(
    (b) => b.estimated && !["park", "vacant"].includes(b.use),
  );
  for (const result of metrics) {
    if (result.value === null) continue;
    if (
      housingProgramInferred &&
      [
        "housing.units",
        "housing.density",
        "housing.residential",
        "housing.multifamily",
        "housing.mixed-use",
        "housing.townhome",
      ].includes(result.id)
    ) {
      result.status = "incomplete";
      result.caveat =
        "Building programs include inferred or user-estimated dwelling counts. These totals are not observed Census housing counts; verify local records before relying on them.";
    }
    if (
      floorProgramInferred &&
      ["land.floorArea", "land.far"].includes(result.id)
    ) {
      result.status = "incomplete";
      result.caveat =
        `${result.caveat ?? ""} Floor counts or building programs include inferred attributes; real footprints do not establish observed gross floor area.`.trim();
    }
  }
  withholdIncompleteQuantities(metrics, place, scenario, activity, evidence);
  if (evidence.sensitivity) {
    const { sensitivity, ...otherEvidence } = evidence;
    // Fixed network/exposure outputs cannot be reused after changing inputs; only
    // recomputable modules participate in the sensitivity calculation.
    const {
      access: _access,
      environment: _environment,
      safety: _safety,
      ...recomputableEvidence
    } = otherEvidence;
    const lowResults = calculateImpact(
      place,
      { ...scenario, assumptions: { ...a, ...sensitivity.low } },
      recomputableEvidence,
      context,
    );
    const highResults = calculateImpact(
      place,
      { ...scenario, assumptions: { ...a, ...sensitivity.high } },
      recomputableEvidence,
      context,
    );
    const lowById = new Map(lowResults.metrics.map((m) => [m.id, m]));
    const highById = new Map(highResults.metrics.map((m) => [m.id, m]));
    for (const m of metrics) {
      const low = lowById.get(m.id)?.value,
        high = highById.get(m.id)?.value;
      if (
        m.value !== null &&
        low !== null &&
        low !== undefined &&
        high !== null &&
        high !== undefined
      ) {
        m.low = Math.min(low, m.value, high);
        m.high = Math.max(low, m.value, high);
        m.inputs = [
          ...m.inputs,
          input(
            "Sensitivity scenario",
            sensitivity.description,
            sensitivity.source,
          ),
        ];
        m.caveat =
          `${m.caveat ?? ""} Low/high are explicit assumption-sensitivity bounds, not statistical confidence intervals.`.trim();
      }
    }
  }
  const fiscal =
    context.fiscalStudy || scenario.fiscal
      ? resolveFiscalStudy(place, context, scenario)
      : undefined;
  if (fiscal) {
    for (const metric of metrics.filter(
      (m) => m.domain === "Fiscal" && m.id !== "fiscal.fees",
    )) {
      metric.method = "Reviewed fiscal operating study";
      metric.methodVersion = fiscal.methodVersion;
      if (metric.id === "fiscal.netAnnual") {
        metric.label = "First-year net fiscal impact";
        metric.formula =
          "Time-zero net cash flow + first year-end net cash flow";
        metric.explanation =
          "Combines the time-zero upfront grant cost with the first year-end operating cash flow. The fiscal study table reports those two rows separately. Delta compares this combined amount with the frozen baseline.";
      } else if (metric.id === "fiscal.netPerAcre") {
        metric.formula =
          "(Time-zero net cash flow + first year-end net cash flow) ÷ study-boundary acres";
        metric.explanation =
          "Uses the same combined time-zero grant cost and first year-end cash flow as first-year net fiscal impact, divided by gross study-area acres, not an inferred legal parcel area.";
      }
      if (!fiscal.base) {
        metric.baseline = metric.value = metric.delta = null;
        metric.status = "unavailable";
      } else {
        if (metric.id === "fiscal.incentivePayback") {
          const payback = fiscal.base.payback;
          metric.value = metric.delta = payback.year;
          metric.explanation =
            payback.status === "not-needed"
              ? "The modeled offer has zero cost; recovery is not required."
              : payback.status === "not-reached"
                ? "Incremental incentive payback is not reached within 20 years."
                : payback.status === "unavailable"
                  ? "Complete incremental operating cash flows are required to evaluate incentive payback."
                  : "First year cumulative incremental cash flow, including time-zero and recurring incentive costs, becomes nonnegative.";
          metric.status =
            payback.status === "unavailable"
              ? "unavailable"
              : payback.status === "not-reached"
                ? "incomplete"
                : "ready";
        }
        if (metric.value !== null && fiscal.reviewState !== "current")
          metric.status = "incomplete";
      }
      metric.caveat =
        `${metric.caveat ?? ""} Fiscal input review: ${fiscal.reviewState}; review is a user attestation, not external validation. Values are in constant dollars at the selected horizon; NPV discounts to that horizon's start. Full paired cases, assumptions, sources and limitations are retained in the fiscal study appendix.${fiscal.deviations.length ? " Changed coefficients are authored overrides, not validated by the original profile citations." : ""}`.trim();
      metric.sourceIds = [
        ...new Set([
          ...metric.sourceIds,
          ...(context.fiscalStudy?.profile.sources.map((s) => s.id) ?? []),
        ]),
      ];
    }
  }
  return {
    scenarioId: scenario.id,
    revision: scenario.revision,
    computedAt: new Date().toISOString(),
    metrics,
    warnings,
    modelVersion: MODEL_VERSION,
    ...(fiscal ? { fiscal } : {}),
  };
}
