import type {
  ActivityScenario,
  CountTarget,
  Place,
  Scenario,
} from "@urban/core";
import { MODEL_VERSION } from "@urban/models";
import type {
  ActivityCountResolution,
  ActivityResolution,
} from "@urban/models";
import { useActivityResolution } from "./useActivityResolution";
import "./activity.css";

export const countLabel = (value: number | null | undefined) =>
  value == null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
        value,
      );
export function CountSummary({
  label,
  count,
}: {
  label: string;
  count: ActivityCountResolution;
}) {
  return (
    <section className="activity-count" aria-label={`${label} estimate`}>
      <div>
        <span>{label}</span>
        <strong>{countLabel(count.value)}</strong>
      </div>
      <dl>
        <div>
          <dt>Year-zero reference</dt>
          <dd>{countLabel(count.reference)}</dd>
        </div>
        <div>
          <dt>Before area exceptions</dt>
          <dd>{countLabel(count.beforeAreas)}</dd>
        </div>
        <div>
          <dt>Final change from baseline</dt>
          <dd>
            {count.delta == null
              ? "Unavailable"
              : `${count.delta > 0 ? "+" : ""}${countLabel(count.delta)}`}
          </dd>
        </div>
      </dl>
      <p>{count.referenceLabel}</p>
      {count.status !== "ready" && (
        <p className="activity-warning">
          {count.status === "incomplete"
            ? "Incomplete allocation — inspect the remaining counts below."
            : "A usable reference or target is needed."}
        </p>
      )}
      {!!count.notes.length && (
        <details>
          <summary>Method & limitations</summary>
          <ul>
            {count.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
export function ActivitySummary({
  resolution,
  activity,
}: {
  resolution: ActivityResolution;
  activity?: ActivityScenario;
}) {
  return (
    <div className="activity-summary">
      <CountSummary label="People" count={resolution.population} />
      <CountSummary label="Workplace jobs" count={resolution.employment} />
      <CountSummary label="Household vehicles" count={resolution.vehicles} />
      <div className="activity-note">
        Targets describe the selected horizon. Local exceptions replace their
        allocated area counts; people and jobs elsewhere are not redistributed.
      </div>
      {(resolution.unallocated.population !== 0 ||
        resolution.unallocated.employment !== 0) && (
        <p className="activity-warning">
          Without spatial allocation:{" "}
          {countLabel(resolution.unallocated.population)} people ·{" "}
          {countLabel(resolution.unallocated.employment)} jobs. This is a
          remainder, not an additional population.
        </p>
      )}
      {!!resolution.warnings.length && (
        <details open>
          <summary>Review these limitations</summary>
          <ul className="activity-warning">
            {resolution.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {activity?.preset && (
        <p className="activity-note">
          Last preset: {activity.preset.kind.replaceAll("-", " ")} ·{" "}
          {new Date(activity.preset.appliedAt).toLocaleDateString()}. Subsequent
          edits may change its targets.
        </p>
      )}
    </div>
  );
}
export function PublishedActivity({
  place,
  scenario,
  modelVersion,
}: {
  place: Place;
  scenario: Scenario;
  modelVersion: string;
}) {
  const compatible = modelVersion === MODEL_VERSION;
  const { resolution, error, updating, failed, retry } = useActivityResolution(
    scenario.activity && compatible ? place : null,
    scenario.activity && compatible ? scenario : undefined,
  );
  if (!scenario.activity) return null;
  const activity = scenario.activity;
  const vehicles = activity.vehicleReference ?? place.vehicleAvailability;
  const sources = [
    ...place.sources,
    ...(scenario.sources ?? []),
    ...(vehicles ? [vehicles.source] : []),
  ];
  const target = (value: CountTarget | undefined, fallback: string) =>
    !value
      ? fallback
      : value.mode === "absolute"
        ? `${countLabel(value.value)} (absolute count)`
        : `${value.percent}% of captured year-zero reference`;
  return (
    <section
      className="published-activity"
      aria-label="Frozen population and activity controls"
      aria-busy={updating}
    >
      <h3>Population, jobs & household vehicles</h3>
      {failed && (
        <button type="button" className="button" onClick={retry}>
          Retry activity calculation
        </button>
      )}
      <p>
        These controls and their sources were frozen with this proposal.
        Building capacity is recorded separately.
      </p>
      {!compatible && (
        <p className="notice">
          This snapshot uses model {modelVersion}. The frozen controls remain
          below; its stored scorecards retain the original results. Local
          allocations are not recalculated with a different model.
        </p>
      )}
      {updating ? (
        <p role="status">Resolving the frozen controls…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : (
        resolution && (
          <>
            <ActivitySummary
              resolution={resolution}
              activity={scenario.activity}
            />
            <h4>Neighborhood exceptions</h4>
            {resolution.neighborhoods.length ? (
              <div className="activity-area-list">
                {resolution.neighborhoods.map((area) => (
                  <article key={area.id}>
                    <strong>{area.name}</strong>
                    <p>
                      {countLabel(area.population.value)} people ·{" "}
                      {countLabel(area.employment.value)} jobs
                    </p>
                    <small>
                      {countLabel(area.areaSqm)} m² · Modeled allocation
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <p>No local exceptions.</p>
            )}
          </>
        )
      )}
      <details>
        <summary>Exact authored targets & references</summary>
        <p>
          Population:{" "}
          {target(
            activity.global.population,
            "Derived from capacity and growth",
          )}
          .
        </p>
        <p>
          Workplace jobs:{" "}
          {target(
            activity.global.employment,
            "Derived from capacity and growth",
          )}
          .
        </p>
        <p>
          Household vehicles:{" "}
          {target(activity.global.householdVehicles, "Keep reference stock")}.
        </p>
        {Object.entries(activity.reference).map(([dimension, reference]) => (
          <div key={dimension} className="activity-note">
            <strong>
              {dimension === "vehicles" ? "Household vehicles" : dimension}{" "}
              reference:
            </strong>{" "}
            {reference.kind === "entered" ? (
              <>
                {countLabel(reference.value)} · {reference.asOfYear} ·{" "}
                {reference.universe} ·{" "}
                {sources.find((source) => source.id === reference.sourceId)
                  ?.name ?? reference.sourceId}
              </>
            ) : reference.kind === "published" ? (
              "Captured published estimate; see the source period and uncertainty."
            ) : (
              "Building-derived capacity estimate; observed occupancy is not established."
            )}
          </div>
        ))}
        {activity.neighborhoods.map((area) => (
          <article key={area.id} className="activity-note">
            <strong>{area.name}</strong>
            <p>
              Population: {target(area.population, "Allocated global count")}.
              Workplace jobs:{" "}
              {target(area.employment, "Allocated global count")}.
            </p>
          </article>
        ))}
        {activity.forecast && (
          <p>
            Forecast supplied for {activity.forecast.geography},{" "}
            {activity.forecast.baseYear}–{activity.forecast.targetYear}.
            Application:{" "}
            {activity.forecast.application === "regional-ratio"
              ? "Wider-region growth ratio applied locally as an author assumption"
              : "Matching-area target totals"}
            . Source:{" "}
            {sources.find((source) => source.id === activity.forecast!.sourceId)
              ?.name ?? activity.forecast.sourceId}
            .
          </p>
        )}
        {vehicles && (
          <p>
            ACS {vehicles.period.start}–{vehicles.period.end},{" "}
            {vehicles.geography.name}:{" "}
            {countLabel(vehicles.measure.estimate.value)} household vehicles
            available ± {countLabel(vehicles.measure.marginOfError.value)} (90%
            margin of error). Sampling uncertainty is not propagated into
            scenario results.
          </p>
        )}
      </details>
      <details>
        <summary>Allocation & demand settings</summary>
        <p>
          People: {scenario.activity.allocation.population}. Jobs:{" "}
          {scenario.activity.allocation.employment}.
        </p>
        <p>
          Residential demand: {scenario.activity.demandResponse.population}.
          Employment demand: {scenario.activity.demandResponse.employment}.
          Vehicle stock response: {scenario.activity.demandResponse.vehicles}.
        </p>
        <p>
          Proportional responses are scenario sensitivities, not calibrated
          transport forecasts. Stock-based residential response replaces the
          population response.
        </p>
      </details>
    </section>
  );
}
