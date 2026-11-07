import {
  USER_ACTIVITY_SOURCE,
  USER_RETAIL_SOURCE,
  type Place,
  type Scenario,
  type HousingIncomeLimitCatalog,
  type Source,
} from "@urban/core";

/** Feature and scorecard IDs resolve only in the planning namespace.
 * Workforce citations remain in workforce.capture.sources, even if IDs coincide.
 */
export function planningSources(place: Place, scenario: Scenario) {
  return [
    ...new Map(
      [
        ...place.sources,
        ...(scenario.sources ?? []),
        ...(place.vehicleAvailability
          ? [place.vehicleAvailability.source]
          : []),
        ...(scenario.activity ? [USER_ACTIVITY_SOURCE] : []),
        ...(scenario.retail ? [USER_RETAIL_SOURCE] : []),
        ...(scenario.activity?.vehicleReference
          ? [scenario.activity.vehicleReference.source]
          : []),
      ].map((source) => [source.id, source]),
    ).values(),
  ];
}

export interface SourceInventoryRecord {
  key: string;
  namespace: string;
  source: Source;
}

/** IDs are local to the cost inventory or exact income-limit pack. */
export function housingSourceInventory(
  scenario: Scenario,
  catalog?: HousingIncomeLimitCatalog,
) {
  const refs = new Set(
    [
      ...(scenario.affordability?.baselineGroups ?? []),
      ...(scenario.affordability?.proposalGroups ?? []),
    ].map((g) => g.areaHash),
  );
  return [
    ...(scenario.affordability?.sources ?? []).map((source) => ({
      key: `housing-cost:${source.id}`,
      namespace: "Housing cost citation",
      source,
    })),
    ...[...refs].flatMap((hash) =>
      (catalog?.[hash]?.sources ?? []).map((source) => ({
        key: `housing-income:${hash}:${source.id}`,
        namespace: `Income limits · ${catalog![hash].area.name} · FY ${catalog![hash].fiscalYear}`,
        source,
      })),
    ),
  ] satisfies SourceInventoryRecord[];
}

export function housingSources(
  scenario: Scenario,
  catalog?: HousingIncomeLimitCatalog,
) {
  return housingSourceInventory(scenario, catalog).map(
    (record) => record.source,
  );
}
