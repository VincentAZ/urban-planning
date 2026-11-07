import {
  buildingProgramTotals,
  materializeBuildings,
  type Building,
  type MetricResult,
  type Place,
  type Scenario,
} from "@urban/core";
import type { ActivityResolution } from "./activity";
import type { ModelEvidence } from "./types";

/** Dependency checks never replace an unknown count with zero. Geometry-only measures have no quantity dependency. */
export function missingMetricBuildings(
  id: string,
  place: Place,
  scenario: Scenario,
  baseline: boolean,
  activity?: ActivityResolution,
  evidence: ModelEvidence = {},
  selectedBuildings?: Building[],
): string[] {
  const buildings =
      selectedBuildings ??
      (baseline ? place.buildings : materializeBuildings(place, scenario)),
    a = baseline ? scenario.baselineAssumptions : scenario.assumptions;
  const missing = (predicate: (b: Building) => boolean) =>
    buildings.filter(predicate).map((b) => b.id);
  const units = () => missing((b) => buildingProgramTotals(b).units === null),
    jobs = () =>
      activity ? [] : missing((b) => buildingProgramTotals(b).jobs === null);
  const floor = (b: Building) =>
    buildingProgramTotals(b).grossFloorAreaSqm === null;
  const retail = (b: Building) =>
    buildingProgramTotals(b).retailFloorAreaSqm === null;
  const property = () =>
    a.effectivePropertyTaxRate === 0
      ? []
      : missing((b) => b.assessedValue === undefined && floor(b));
  const sales = () =>
    a.salesPerSqft === 0 ||
    a.retailCaptureRate === 0 ||
    a.localSalesTaxRate === 0
      ? []
      : missing(retail);
  const service = () => {
    const ids: string[] = [];
    if (!activity && a.annualServiceCostPerJob !== 0) ids.push(...jobs());
    if (!activity && a.annualServiceCostPerResident !== 0) {
      const profile = place.demographics,
        observed =
          profile &&
          place.geography?.type === "zcta" &&
          place.geography.code === profile.geography.id &&
          place.zip === profile.geography.id &&
          profile.geography.relationshipToStudyArea === "same-area" &&
          profile.measures.population.estimate.status === "available" &&
          profile.measures.population.estimate.value !== null;
      if (!observed) ids.push(...units());
      else if (!baseline) {
        const old = new Map(place.buildings.map((b) => [b.id, b])),
          next = new Map(buildings.map((b) => [b.id, b]));
        for (const key of new Set([...old.keys(), ...next.keys()])) {
          const left = old.get(key),
            right = next.get(key),
            before = left ? buildingProgramTotals(left).units : 0,
            after = right ? buildingProgramTotals(right).units : 0;
          if (before === null || after === null) {
            if (!left || !right || before !== after) ids.push(key);
          }
        }
      }
    }
    return ids;
  };
  const demand = (parking = false) =>
    missing((b) => {
      if (b.program) return false;
      const response = scenario.activity?.demandResponse;
      const zeroResidential =
        !baseline &&
        !parking &&
        response &&
        ((response.vehicles !== "none" && activity?.vehicles.value === 0) ||
          (response.vehicles === "none" &&
            response.population !== "none" &&
            activity?.population.value === 0));
      const zeroEmployment =
        !baseline &&
        response?.employment !== undefined &&
        response.employment !== "none" &&
        activity?.employment.value === 0 &&
        ["office", "industrial", "warehouse"].includes(b.use);
      return (
        (b.units === null && !zeroResidential) ||
        (buildingProgramTotals(b).nonresidentialFloorAreaSqm === null &&
          !zeroEmployment)
      );
    });
  let result: string[] = [];
  if (
    [
      "housing.units",
      "housing.occupiedUnits",
      "housing.residents",
      "housing.density",
    ].includes(id)
  )
    result = units();
  else if (
    [
      "housing.residential",
      "housing.multifamily",
      "housing.mixed-use",
      "housing.townhome",
    ].includes(id)
  )
    result = missing(
      (b) =>
        !b.program && b.use === id.slice("housing.".length) && b.units === null,
    );
  else if (id === "housing.jobsHousingBalance")
    result = [...units(), ...jobs()];
  else if (id === "housing.incomeRequired")
    result = missing((b) => b.rentMonthly !== undefined && b.units === null);
  else if (id === "economy.programJobs")
    result = missing((b) => buildingProgramTotals(b).jobs === null);
  else if (
    [
      "economy.jobs",
      "economy.payroll",
      "economy.indirectJobs",
      "economy.inducedJobs",
      "economy.output",
    ].includes(id)
  )
    result = jobs();
  else if (
    [
      "economy.retailCaptured",
      "economy.retailGap",
      "economy.businessPotential",
    ].includes(id) &&
    !scenario.retail &&
    evidence.retail &&
    !baseline
  )
    result = [...place.buildings, ...buildings].filter(retail).map((b) => b.id);
  else if (
    [
      "mobility.dailyTrips",
      "mobility.vmt",
      "environment.ghg",
      "mobility.parkingDemand",
    ].includes(id)
  )
    result = demand(id === "mobility.parkingDemand");
  else if (id === "mobility.parkingSupply")
    result = missing((b) => b.parkingSpaces === null);
  else if (id === "mobility.parkingBalance")
    result = [...demand(true), ...missing((b) => b.parkingSpaces === null)];
  else if (id === "fiscal.propertyTax") result = property();
  else if (id === "fiscal.salesTax") result = sales();
  else if (id === "fiscal.serviceCost") result = service();
  else if (
    [
      "fiscal.netAnnual",
      "fiscal.netPerAcre",
      "fiscal.net20Years",
      "fiscal.npv",
    ].includes(id)
  )
    result = [
      ...property(),
      ...sales(),
      ...service(),
      ...(!baseline &&
      a.effectivePropertyTaxRate !== 0 &&
      a.abatementPercent !== 0 &&
      a.abatementYears > 0
        ? place.buildings
            .filter((b) => b.assessedValue === undefined && floor(b))
            .map((b) => b.id)
        : []),
    ];
  else if (
    id === "fiscal.incentivePayback" &&
    !baseline &&
    (a.incentiveGrant !== 0 || a.abatementPercent !== 0)
  )
    result = [
      ...missingMetricBuildings(
        "fiscal.netAnnual",
        place,
        scenario,
        true,
        activity,
        evidence,
        place.buildings,
      ),
      ...missingMetricBuildings(
        "fiscal.netAnnual",
        place,
        scenario,
        false,
        activity,
        evidence,
      ),
    ];
  else if (id === "land.floorArea") result = missing(floor);
  else if (id === "land.heightConflicts")
    result = missing((b) => b.maxHeight !== undefined && b.height === null);
  else if (id === "land.openSpacePerResident" && !activity) result = units();
  // FAR is evaluated against the actual contained buildings in the parcel module.
  return [...new Set(result)];
}
const additive = new Set([
  "housing.units",
  "housing.occupiedUnits",
  "housing.residents",
  "housing.residential",
  "housing.multifamily",
  "housing.mixed-use",
  "housing.townhome",
  "economy.programJobs",
  "economy.jobs",
  "economy.payroll",
  "economy.indirectJobs",
  "economy.inducedJobs",
  "economy.output",
  "mobility.dailyTrips",
  "mobility.vmt",
  "environment.ghg",
  "mobility.parkingDemand",
  "mobility.parkingSupply",
  "fiscal.propertyTax",
  "fiscal.salesTax",
  "fiscal.serviceCost",
  "land.floorArea",
  "land.heightConflicts",
]);
export function withholdIncompleteQuantities(
  metrics: MetricResult[],
  place: Place,
  scenario: Scenario,
  activity?: ActivityResolution,
  evidence: ModelEvidence = {},
): void {
  const proposal = materializeBuildings(place, scenario);
  if (
    ![...place.buildings, ...proposal].some(
      (b) =>
        b.height === null ||
        b.floors === null ||
        b.units === null ||
        b.jobs === null ||
        b.parkingSpaces === null,
    )
  )
    return;
  for (const m of metrics) {
    const before = missingMetricBuildings(
        m.id,
        place,
        scenario,
        true,
        activity,
        evidence,
        place.buildings,
      ),
      after = missingMetricBuildings(
        m.id,
        place,
        scenario,
        false,
        activity,
        evidence,
        proposal,
      );
    if (!before.length && !after.length) continue;
    const coverage = (
      ids: string[],
      items: Building[],
      value: number | null,
    ) => {
      const missingIds = new Set(ids);
      return {
        missingBuildingIds: ids,
        ...(additive.has(m.id)
          ? {
              knownSubtotal: items.some((b) => !missingIds.has(b.id))
                ? value
                : null,
            }
          : {}),
      };
    };
    m.coverage = {
      baseline: coverage(before, place.buildings, m.baseline),
      scenario: coverage(after, proposal, m.value),
    };
    if (before.length) m.baseline = null;
    if (after.length) m.value = null;
    m.delta = null;
    m.status = m.value === null ? "unavailable" : "incomplete";
    delete m.low;
    delete m.high;
    m.caveat =
      `${m.caveat ?? ""} Required building attributes are unknown. Full totals and comparisons are withheld; any known subtotal includes only available contributions and is not a complete estimate.`.trim();
    m.inputs = [
      ...m.inputs,
      {
        name: "Buildings with missing required attributes · baseline",
        value: before.length,
        source: "Per-field import provenance",
      },
      {
        name: "Buildings with missing required attributes · proposal",
        value: after.length,
        source: "Per-field import provenance",
      },
    ];
  }
}
