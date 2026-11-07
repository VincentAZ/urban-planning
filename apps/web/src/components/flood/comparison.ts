import {
  floodMethodVersion,
  type Scenario,
  type ModelResults,
  type MetricResult,
} from "@urban/core";

/** A comparison-only baseline inherits an entire common reference, never just its hash. */
export function floodComparisonScenarios(selected: Scenario[]): Scenario[] {
  const proposals = selected.filter((scenario) => scenario.id !== "baseline");
  const common = proposals[0]?.flood;
  if (
    !common ||
    !proposals.every(
      (scenario) =>
        scenario.flood?.datasetHash === common.datasetHash &&
        floodMethodVersion(scenario.flood) === floodMethodVersion(common),
    )
  )
    return selected;
  return selected.map((scenario) =>
    scenario.id === "baseline" ? { ...scenario, flood: common } : scenario,
  );
}

/** Row metadata follows a selected footprint screen, even when the baseline has no common source/method. */
export function floodComparisonMetrics(
  selected: Scenario[],
  results: ModelResults[],
): MetricResult[] {
  const metrics = results[0]?.metrics ?? [];
  const proposal = selected.find(
    (scenario) => scenario.id !== "baseline" && scenario.flood,
  );
  const footprintMetric =
    proposal &&
    results
      .find((result) => result.scenarioId === proposal.id)
      ?.metrics.find((metric) => metric.id === "environment.flood");
  if (!footprintMetric) return metrics;
  return metrics.map((metric) =>
    metric.id === "environment.flood"
      ? { ...metric, label: footprintMetric.label, unit: footprintMetric.unit }
      : metric,
  );
}
