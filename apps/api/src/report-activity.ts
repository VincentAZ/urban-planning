import { studyAreaBounds, type CountTarget } from "@urban/core";
import { resolveActivity } from "@urban/models";
import type { ReportSnapshot } from "./exports";

export const activityReportDisclosure =
  "These are authored scenario targets and modeled spatial allocations, not observed neighborhood counts. Targets apply at the selected horizon without growing them again. Area overrides replace their allocated counts; the remainder is not rebalanced. Household vehicles available is a stock estimate, not traffic volume, registered fleet, trips or visible map agents. Proportional demand is a reviewed planning sensitivity, not a calibrated traffic forecast. Buildings and their homes, jobs, floor area, values and parking supply remain unchanged.";
export const activityTargetLabel = (target?: CountTarget) =>
  !target
    ? "No override"
    : target.mode === "absolute"
      ? `${target.value.toLocaleString("en-US")} (absolute)`
      : `${target.percent}% of captured year-zero reference`;
const count = (value: number | null) =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 3 });

/** Render the saved controls and the same deterministic resolution used by models; never infer local observations. */
export function activityReportInventory(snapshot: ReportSnapshot) {
  const activity = snapshot.scenario.activity;
  if (!activity) return null;
  const resolved = resolveActivity(snapshot.place, snapshot.scenario);
  const dimensions = [
    {
      key: "population",
      label: "Population",
      target: activity.global.population,
      value: resolved.population,
    },
    {
      key: "employment",
      label: "Workplace employment",
      target: activity.global.employment,
      value: resolved.employment,
    },
    {
      key: "vehicles",
      label: "Household vehicles available",
      target: activity.global.householdVehicles,
      value: resolved.vehicles,
    },
  ] as const;
  const controls = dimensions.map(({ key, label, target, value }) => ({
    dimension: label,
    target: activityTargetLabel(target),
    reference: value.reference,
    referenceLabel: value.referenceLabel,
    baseline: value.baseline,
    beforeAreas: value.beforeAreas,
    scenario: value.value,
    delta: value.delta,
    allocation:
      key === "vehicles"
        ? "Whole study area only; no neighborhood stock allocation"
        : activity.allocation[key],
    sourceIds: value.sourceIds.join("; "),
    notes: value.notes.join(" "),
  }));
  const reference =
    activity.vehicleReference ?? snapshot.place.vehicleAvailability;
  const referenceNotes = reference
    ? [
        `Captured household-vehicle evidence: ${reference.dataset}, ${reference.period.start}–${reference.period.end}, ${reference.geography.name}, boundary ${reference.geography.boundaryVintage}, ${reference.geography.relationshipToStudyArea}. Universe: ${reference.measure.universe}. Estimate ${count(reference.measure.estimate.value)}; ${reference.confidenceLevel}% margin of error ${count(reference.measure.marginOfError.value)}. Source ${reference.source.id}.`,
        ...(reference.sourceFile
          ? [
              `Official table ${reference.sourceFile.table}; source SHA-256 ${reference.sourceFile.sha256}; ${reference.sourceFile.bytes} bytes; retrieved ${reference.sourceFile.retrievedAt}.`,
            ]
          : []),
        ...reference.notes,
      ]
    : [
        "No published household-vehicle reference is captured. An entered reference, if supplied, remains a user assumption.",
      ];
  const notes = [
    `Scenario ${snapshot.scenario.id}, revision ${snapshot.scenario.revision}, ${snapshot.scenario.horizon}-year horizon.`,
    `Demand response: population ${activity.demandResponse.population}; employment ${activity.demandResponse.employment}; household vehicles ${activity.demandResponse.vehicles}. Review recorded: ${activity.demandResponse.reviewed ? "yes" : "no"}; source ${activity.demandResponse.sourceId}. Household-stock response replaces the residential population response; they are not multiplied together.`,
    ...Object.entries(activity.reference).flatMap(([dimension, reference]) =>
      reference.kind === "entered"
        ? [
            `Entered ${dimension} reference: ${reference.value}; as of ${reference.asOfYear}; universe ${reference.universe}; source ${reference.sourceId}.`,
          ]
        : [],
    ),
    ...(activity.forecast
      ? [
          `Authored forecast: ${activity.forecast.geography}; ${activity.forecast.baseYear}–${activity.forecast.targetYear}; ${activity.forecast.application}; source ${activity.forecast.sourceId}. ${(["population", "employment", "householdVehicles"] as const).flatMap((key) => (activity.forecast?.[key] ? [`${key}: ${activity.forecast[key]!.baseline} to ${activity.forecast[key]!.target}`] : [])).join("; ")}. This supplied forecast is not automatically independently verified.`,
        ]
      : []),
    ...(activity.preset
      ? [
          `Preset: ${activity.preset.kind}; applied ${activity.preset.appliedAt}; source ${activity.preset.sourceId}${activity.preset.neighborhoodId ? `; neighborhood ${activity.preset.neighborhoodId}; jobs removed ${activity.preset.jobsRemoved ?? "not supplied"}` : ""}.`,
        ]
      : []),
    ...referenceNotes,
    ...resolved.warnings,
  ];
  const areas = activity.neighborhoods.map((area, index) => ({
    id: area.id,
    name: area.name,
    geometryType: area.geometry.type,
    bounds: studyAreaBounds(area.geometry).join(", "),
    areaSqm: resolved.neighborhoods[index].areaSqm,
    populationTarget: activityTargetLabel(area.population),
    populationReference: resolved.neighborhoods[index].population.reference,
    population: resolved.neighborhoods[index].population.value,
    employmentTarget: activityTargetLabel(area.employment),
    employmentReference: resolved.neighborhoods[index].employment.reference,
    employment: resolved.neighborhoods[index].employment.value,
    sourceId: area.sourceId,
    description: `Planning allocation, not a legal or statistical neighborhood. ${area.geometry.type}; longitude/latitude bounds ${studyAreaBounds(area.geometry).join(", ")}. Complete geometry is retained in project and GeoJSON exports.`,
  }));
  return {
    controls,
    areas,
    notes,
    controlRows: controls.map((row) => [
      row.dimension,
      row.target,
      `${count(row.reference)}. ${row.referenceLabel}`,
      `${count(row.baseline)} / ${count(row.scenario)}`,
      row.allocation,
    ]),
    areaRows: areas.map((row) => [
      row.name,
      row.populationTarget,
      count(row.population),
      row.employmentTarget,
      count(row.employment),
    ]),
  };
}
