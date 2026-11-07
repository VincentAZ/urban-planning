import { useEffect, useState } from "react";
import {
  trafficScenarioStatus,
  type Place,
  type TrafficCapture,
  type Scenario,
} from "@urban/core";
import { TrafficComparisonTable, trafficMeasures } from "./TrafficResults";
import { trafficClock, trafficNumber } from "./TrafficFields";
import {
  TrafficPlanningCoverage,
  TrafficPlanningSources,
} from "./TrafficPlanningRoadPanel";
import "./traffic.css";
import { TrafficSignalEvidence } from "./TrafficSignalEvidence";
import { TrafficCommuteReadout } from "./TrafficCommutePanel";

/** Frozen numerical evidence works offline; this component never requests a private job archive. */
export function PublishedTraffic({
  place,
  scenario,
}: {
  place: Place;
  scenario: Scenario;
}) {
  const value = scenario.traffic;
  const [check, setCheck] = useState<{
    place: Place;
    scenario: Scenario;
    stale?: boolean;
    notes?: string[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    void trafficScenarioStatus(value, place, scenario).then(
      (status) => {
        if (!cancelled) setCheck({ place, scenario, ...status });
      },
      (error) => {
        if (!cancelled)
          setCheck({ place, scenario, error: (error as Error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value, place, scenario]);
  if (!value) return null;
  const current =
    check?.place === place && check.scenario === scenario ? check : null;
  const capture = value.capture,
    calibration = capture.calibration;
  return (
    <section className="traffic-workbench traffic-captured">
      <div className="traffic-section-heading">
        <div>
          <span className="eyebrow">TRAFFIC EVIDENCE</span>
          <h3>Captured street response</h3>
        </div>
        <span
          className={`traffic-badge ${value.origin === "imported" || current?.stale ? "warning" : ""}`}
        >
          {value.origin === "imported"
            ? "Imported evidence · not verified by this server"
            : "Captured analysis"}
        </span>
      </div>
      {!current ? (
        <p role="status">Checking captured inputs…</p>
      ) : current.error ? (
        <p className="traffic-error" role="alert">
          Capture consistency could not be established: {current.error}
        </p>
      ) : current.stale ? (
        <p className="traffic-warning">
          Road inputs have changed. These retained values describe the earlier
          network experiment.
        </p>
      ) : null}
      <p>
        {capture.recipe.period.date} ·{" "}
        {trafficClock(capture.recipe.period.beginSeconds)}–
        {trafficClock(capture.recipe.period.endSeconds)} ·{" "}
        {capture.recipe.period.timeZone} · seed {capture.recipe.seed}
      </p>
      <p className="traffic-muted">
        This explicit network experiment uses{" "}
        {capture.originalDemand.commute
          ? "a retained Census commute subset"
          : "entered vehicle demand"}
        . Building, population and horizon edits do not automatically change it.
        Detailed graph, trajectories and count rows are not included in this
        summary.
      </p>
      {capture.originalDemand.commute && (
        <TrafficCommuteReadout summary={capture.originalDemand.commute} />
      )}
      <TrafficComparisonTable comparison={capture.comparison} />
      <TrafficSignalEvidence timings={capture.proposal.signalTimings} />
      <TrafficPlanningCoverage
        mapping={capture.proposal.planningRoadMapping.correspondence}
      />
      <TrafficPlanningSources
        mapping={capture.proposal.planningRoadMapping.correspondence}
      />
      <p className="traffic-warning">
        Simulated time loss is not HCM control delay or level of service. Count
        fit alone does not validate travel times or queues.
      </p>
      <details className="traffic-card">
        <summary>Completion, held-out counts and limitations</summary>
        {(["baseline", "proposal"] as const).map((side) => (
          <div key={side}>
            <h4>
              {side === "baseline" ? "Baseline" : "Proposal"}:{" "}
              {capture.comparison[side].status}
            </h4>
            <p>
              {trafficNumber(capture.comparison[side].completed, 0)} /{" "}
              {trafficNumber(capture.comparison[side].requested, 0)} admitted
              vehicles completed. Analysis window:{" "}
              {trafficNumber(capture.comparison[side].measurementCompleted, 0)}{" "}
              /{" "}
              {trafficNumber(capture.comparison[side].measurementRequested, 0)};
              warmup excluded from measures.
            </p>
            {capture.comparison[side].status !== "complete" && (
              <div className="traffic-table-scroll">
                <table>
                  <caption>
                    Completed-trip subset only; not a complete-run estimate
                  </caption>
                  <tbody>
                    {trafficMeasures.map((measure) => (
                      <tr key={measure.key}>
                        <th>{measure.label}</th>
                        <td>
                          {trafficNumber(
                            capture.comparison[side].completedSubtotal[
                              measure.key
                            ],
                          )}{" "}
                          {measure.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <dl className="traffic-diagnostics">
              {Object.entries(capture.runs[side].diagnostics).map(
                ([key, number]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{trafficNumber(number, 0)}</dd>
                  </div>
                ),
              )}
            </dl>
            <ul>
              {capture.comparison[side].reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </div>
        ))}
        {calibration ? (
          <>
            <h4>Recorded interval-count fit: {calibration.status}</h4>
            <p>
              {calibration.calibration.evaluated} /{" "}
              {calibration.calibration.requested} calibration rows and{" "}
              {calibration.holdout.evaluated} / {calibration.holdout.requested}{" "}
              held-out rows evaluated.{" "}
              {capture.countEvidence.unmappedCountCount} observations remain
              unmapped.
            </p>
            <p>{calibration.criteriaDescription}</p>
            <dl className="traffic-diagnostics">
              {Object.entries(calibration.criteria).map(([key, number]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{trafficNumber(number, 3)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="traffic-warning">
            Count fit not assessed. No acceptance criteria or
            calibration/holdout selection is recorded. Completing the simulation
            does not establish calibration.
          </p>
        )}
        <ul>
          {[
            ...(calibration?.notes ?? []),
            ...capture.notes,
            ...(current?.notes ?? []),
          ].map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      </details>
      <details className="traffic-source-details">
        <summary>Sources and exact capture identity</summary>
        <p>
          Captured {capture.capturedAt} · method {capture.methodVersion} · SUMO{" "}
          {capture.network.engine.version}
        </p>
        <p>Capture SHA-256: {value.captureHash}</p>
        <p>Network: {capture.network.baselineFileSha256}</p>
        <p>Proposal graph: {capture.network.proposalFileSha256}</p>
        <p>
          Demand: {capture.originalDemand.hash} ·{" "}
          {capture.originalDemand.vehicleCount.toLocaleString()} entered
          vehicles
        </p>
        <p>{capture.originalDemand.description}</p>
        <p>
          Planning-road correspondence:{" "}
          {capture.proposal.planningRoadMapping.status}.{" "}
          {capture.proposal.planningRoadMapping.correspondence ? (
            <>
              {capture.proposal.planningRoadMapping.unrepresentedRoadIds.length}{" "}
              roads without a reviewed link;{" "}
              {
                capture.proposal.planningRoadMapping.correspondence.exclusions.filter(
                  (item) => item.reason !== "cosmetic",
                ).length
              }{" "}
              omitted traffic properties.
            </>
          ) : (
            <>
              {capture.proposal.planningRoadMapping.unrepresentedRoadIds.length}{" "}
              planning roads are unrepresented.
            </>
          )}
        </p>
        <TrafficSources capture={capture} />
      </details>
    </section>
  );
}

export function TrafficSources({ capture }: { capture: TrafficCapture }) {
  return (
    <div className="traffic-source-details">
      {capture.sources.map((source) => (
        <div key={source.id}>
          <strong>{source.name}</strong>
          <p>
            {source.vintage} · {source.kind} · {source.license}
          </p>
          {/^https?:\/\//i.test(source.url) ? (
            <a href={source.url} target="_blank" rel="noreferrer">
              Source citation
            </a>
          ) : source.url ? (
            <p>{source.url}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
