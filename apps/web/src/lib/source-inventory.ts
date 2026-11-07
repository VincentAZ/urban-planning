import {
  USER_ACTIVITY_SOURCE,
  USER_RETAIL_SOURCE,
  type Place,
  type Scenario,
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
