import { useEffect, useState } from "react";
import {
  compareTrafficRuns,
  type TrafficComparison,
  type TrafficCalibrationResult,
} from "@urban/models";
import type {
  TrafficCountPack,
  TrafficPairRecipe,
  TrafficSimulationResult,
} from "../../../../../packages/core/src/traffic";
import { trafficClock, trafficNumber } from "./TrafficFields";
import type {
  TrafficPlanningRoadMapping,
  TrafficCapturedSignalTiming,
  TrafficCommuteSummary,
} from "@urban/core";
import { TrafficSignalEvidence } from "./TrafficSignalEvidence";
import { TrafficCommuteReadout } from "./TrafficCommutePanel";
import {
  TrafficPlanningCoverage,
  TrafficPlanningSources,
} from "./TrafficPlanningRoadPanel";
export interface TrafficResultPair {
  id: string;
  scenarioRevision: number;
  recipe: TrafficPairRecipe;
  baseline: TrafficSimulationResult;
  proposal: TrafficSimulationResult;
  countPack: TrafficCountPack;
  /** Fit to observed baseline counts only. Proposal detectors are future predictions. */
  calibration?: TrafficCalibrationResult | null;
  planningRoads?: TrafficPlanningRoadMapping;
  signalTimings?: TrafficCapturedSignalTiming[];
  commute?: TrafficCommuteSummary;
}
export const trafficMeasures = [
  {
    key: "meanTravelTimeSeconds",
    label: "Mean travel time",
    unit: "seconds/trip",
  },
  {
    key: "meanTimeLossSeconds",
    label: "Mean simulated time loss",
    unit: "seconds/trip",
  },
  {
    key: "meanDepartureDelaySeconds",
    label: "Mean insertion delay",
    unit: "seconds/trip",
  },
  { key: "vehicleKilometers", label: "Vehicle distance", unit: "vehicle-km" },
  { key: "vehicleHours", label: "Vehicle time", unit: "vehicle-hours" },
] as const;
export function TrafficResults({
  pair,
  stale,
  staleReason,
  onDownload,
}: {
  pair: TrafficResultPair | null;
  stale: boolean;
  staleReason?: string;
  onDownload?: (id: string) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<{
      pair: TrafficResultPair;
      comparison?: TrafficComparison;
      error?: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    void compareTrafficRuns(pair.baseline, pair.proposal, pair.recipe).then(
      (comparison) => {
        if (!cancelled) setOutcome({ pair, comparison });
      },
      (failure) => {
        if (!cancelled) setOutcome({ pair, error: (failure as Error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pair]);
  if (!pair)
    return (
      <div className="traffic-empty">
        <h3>A result needs a real run.</h3>
        <p>
          No paired traffic capture is available. Review a connected network,
          cited demand, counts and the analysis period before requesting a
          baseline/proposal run.
        </p>
        <p>
          Illustrative city vehicles do not establish link volumes, congestion,
          signal delay or level of service.
        </p>
      </div>
    );
  const current = outcome?.pair === pair ? outcome : null,
    comparison = current?.comparison;
  return (
    <>
      <div className="traffic-section-heading">
        <div>
          <span className="eyebrow">PAIRED CAPTURE</span>
          <h3>What changed, and what is still uncertain.</h3>
        </div>
        <span className={`traffic-badge ${stale ? "warning" : ""}`}>
          {stale ? "Earlier inputs" : "Captured analysis"} · r
          {pair.scenarioRevision}
        </span>
      </div>
      {stale && (
        <p className="traffic-warning" role="status">
          {staleReason ||
            "The current draft or scenario inputs differ from this capture. These values are retained for inspection and must not be presented as the current alternative."}
        </p>
      )}
      <p>
        {pair.recipe.period.date} ·{" "}
        {trafficClock(pair.recipe.period.beginSeconds)}–
        {trafficClock(pair.recipe.period.endSeconds)} ·{" "}
        {pair.recipe.period.timeZone} · seed {pair.recipe.seed}
      </p>
      {current?.error ? (
        <p className="traffic-error" role="alert">
          Comparison unavailable: {current.error}. The captured sides do not
          satisfy the shared comparison recipe.
        </p>
      ) : !comparison ? (
        <p role="status">Checking the paired result identities…</p>
      ) : (
        <>
          <div className="traffic-stats">
            {(["baseline", "proposal"] as const).map((side) => (
              <div key={side}>
                <span>{side === "baseline" ? "Baseline" : "Proposal"}</span>
                <strong>
                  {trafficNumber(comparison[side].completed, 0)} /{" "}
                  {trafficNumber(comparison[side].requested, 0)}
                </strong>
                <span>
                  completed / admitted vehicles · {comparison[side].status}
                </span>
                <small>
                  Analysis-window cohort:{" "}
                  {trafficNumber(comparison[side].measurementCompleted, 0)}{" "}
                  completed /{" "}
                  {trafficNumber(comparison[side].measurementRequested, 0)}{" "}
                  requested. Warmup is excluded from measures.
                </small>
              </div>
            ))}
          </div>
          {pair.commute && <TrafficCommuteReadout summary={pair.commute} />}
          <TrafficComparisonTable comparison={comparison} />
          <TrafficPlanningCoverage mapping={pair.planningRoads} />
          <TrafficSignalEvidence timings={pair.signalTimings} />
          <TrafficPlanningSources mapping={pair.planningRoads} />
          <p className="traffic-warning">
            SUMO time loss measures travel below the vehicle’s ideal speed. It
            is not HCM intersection control delay or a level-of-service grade.
          </p>
          {(["baseline", "proposal"] as const).map((side) => (
            <section className="traffic-card" key={side}>
              <h4>
                {side === "baseline" ? "Baseline" : "Proposal"} run integrity
              </h4>
              <dl className="traffic-diagnostics">
                {Object.entries(pair[side].diagnostics).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{trafficNumber(value, 0)}</dd>
                  </div>
                ))}
              </dl>
              {comparison[side].reasons.length > 0 && (
                <ul className="traffic-warning">
                  {comparison[side].reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              )}
              {comparison[side].status !== "complete" && (
                <details>
                  <summary>
                    Completed-trip subset — not a complete-run estimate
                  </summary>
                  <table>
                    <tbody>
                      {trafficMeasures.map((measure) => (
                        <tr key={measure.key}>
                          <th>{measure.label}</th>
                          <td>
                            {trafficNumber(
                              comparison[side].completedSubtotal[measure.key],
                            )}{" "}
                            {measure.unit}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </section>
          ))}
          <ul className="traffic-muted">
            {comparison.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </>
      )}
      <ObservedCounts key={pair.id} pair={pair} />
      <EdgeResults key={`edges:${pair.id}`} pair={pair} />
      <details className="traffic-source-details">
        <summary>Run identity, files and source limitations</summary>
        <p>Recipe: {pair.baseline.recipeHash}</p>
        <p>Original demand: {pair.recipe.demandHash}</p>
        <p>Baseline graph: {pair.recipe.baselineNetworkHash}</p>
        <p>Proposal graph: {pair.recipe.proposalNetworkHash}</p>
        <p>Baseline assigned routes: {pair.baseline.assignedRoutesHash}</p>
        <p>Proposal assigned routes: {pair.proposal.assignedRoutesHash}</p>
        {[pair.baseline, pair.proposal].map((run) => (
          <div key={run.side}>
            <strong>{run.side} files</strong>
            <ul>
              {run.files.map((file, i) => (
                <li key={i}>
                  {file.sourceId} · {file.sha256} ·{" "}
                  {file.bytes.toLocaleString()} bytes
                </li>
              ))}
            </ul>
            <ul>
              {run.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        ))}
      </details>
      {onDownload && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onDownload(pair.id);
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "Preparing evidence download…"
            : "Download retained traffic evidence"}
        </button>
      )}
      {error && (
        <p role="alert" className="traffic-error">
          {error}
        </p>
      )}
    </>
  );
}
function ObservedCounts({ pair }: { pair: TrafficResultPair }) {
  const [limit, setLimit] = useState(50);
  const base = new Map(
      pair.baseline.predictions.map((value) => [value.countId, value]),
    ),
    proposal = new Map(
      pair.proposal.predictions.map((value) => [value.countId, value]),
    );
  return (
    <section className="traffic-card">
      <h4>Count evidence versus modeled vehicles</h4>
      <p className="traffic-muted">
        Each row retains its original interval and class coverage. Observed,
        factored, excluded and missing rows remain distinct; only eligible
        observations can support a count-fit check.
      </p>
      {pair.calibration ? (
        <div className="traffic-stats">
          <div>
            <strong>{pair.calibration.status}</strong>
            <span>Baseline interval-count fit</span>
            <span>
              {pair.calibration.holdout.evaluated} declared holdout rows
              evaluated
            </span>
          </div>
        </div>
      ) : (
        <p className="traffic-warning">
          Count fit: Not assessed. No recorded calibration/holdout evaluation is
          attached. A completed simulation is not evidence of calibration.
        </p>
      )}
      {pair.calibration && (
        <p className="traffic-muted">
          Held-out observations are selected by the study author. Separate roles
          do not establish independent validation.
        </p>
      )}
      <p className="traffic-muted">
        Proposal detector values are predictions under changed network controls.
        They are not recalibrated against the historical baseline observations.
      </p>
      <p className="traffic-muted">
        The detailed table scrolls horizontally on small screens. Focus it to
        use the arrow keys.
      </p>
      <div
        className="traffic-table-scroll"
        role="region"
        aria-label="Observed and modeled count details"
        tabIndex={0}
      >
        <table>
          <caption>
            Recorded interval counts, without converting AADT or unknown values
          </caption>
          <thead>
            <tr>
              <th>Station / interval</th>
              <th>Evidence</th>
              <th>Source count</th>
              <th>Baseline modeled</th>
              <th>Proposal prediction</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {pair.countPack.counts.slice(0, limit).map((count) => (
              <tr key={count.id}>
                <th>
                  {count.stationId}
                  <small>
                    {count.date} {trafficClock(count.beginSeconds)}–
                    {trafficClock(count.endSeconds)}
                  </small>
                </th>
                <td>
                  {count.kind} · {count.status}
                </td>
                <td>
                  {count.status === "missing"
                    ? "Missing"
                    : trafficNumber(
                        count.value,
                        count.kind === "observed" ? 0 : 2,
                      )}
                </td>
                <td>
                  {base.get(count.id)?.status === "available"
                    ? trafficNumber(base.get(count.id)?.vehicles, 0)
                    : "Unavailable"}
                  <small>{base.get(count.id)?.reason}</small>
                </td>
                <td>
                  {proposal.get(count.id)?.status === "available"
                    ? trafficNumber(proposal.get(count.id)?.vehicles, 0)
                    : "Unavailable"}
                  <small>{proposal.get(count.id)?.reason}</small>
                </td>
                <td>
                  {count.vehicleClasses?.join(", ") || "Classes unknown"}
                  <small>{count.target?.kind ?? "Unmapped"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pair.countPack.counts.length > limit && (
        <button
          type="button"
          className="button"
          onClick={() => setLimit((value) => value + 50)}
        >
          Show 50 more observed rows
        </button>
      )}
      {pair.calibration && (
        <details className="traffic-source-details">
          <summary>Count-fit rows and held-out checks</summary>
          <div>
            <h4>Baseline count-fit diagnostics</h4>
            <div
              className="traffic-table-scroll"
              role="region"
              aria-label="Baseline count-fit diagnostics"
              tabIndex={0}
            >
              <table>
                <caption>
                  Recorded count-fit diagnostics · {pair.calibration.scope}
                </caption>
                <thead>
                  <tr>
                    <th>Observation</th>
                    <th>Role</th>
                    <th>Observed / hour</th>
                    <th>Modeled / hour</th>
                    <th>GEH</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {pair.calibration.rows.slice(0, limit).map((row) => (
                    <tr key={row.countId}>
                      <th>{row.countId}</th>
                      <td>{row.role}</td>
                      <td>{trafficNumber(row.observedHourly)}</td>
                      <td>{trafficNumber(row.modeledHourly)}</td>
                      <td>{trafficNumber(row.geh, 2)}</td>
                      <td>
                        {row.passed === null
                          ? "Unavailable"
                          : row.passed
                            ? "Within recorded criteria"
                            : "Outside recorded criteria"}
                        <small>{row.reason}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pair.calibration.rows.length > limit && (
              <button
                type="button"
                className="button"
                onClick={() => setLimit((value) => value + 50)}
              >
                Show 50 more fit rows
              </button>
            )}
            <ul>
              {pair.calibration.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        </details>
      )}
      <p className="traffic-muted">
        A passing count fit is conditional on its recorded acceptance criteria
        and held-out observations. It is not certification of engineering
        accuracy.
      </p>
    </section>
  );
}

export function TrafficComparisonTable({
  comparison,
}: {
  comparison: TrafficComparison;
}) {
  return (
    <>
      <div className="traffic-table-scroll traffic-comparison-table">
        <table>
          <caption>
            Comparable completed-run measures; unavailable values are not zero
          </caption>
          <thead>
            <tr>
              <th>Measure</th>
              <th>Baseline</th>
              <th>Proposal</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>
            {trafficMeasures.map((measure) => (
              <tr key={measure.key}>
                <th>
                  {measure.label}
                  <small>{measure.unit}</small>
                </th>
                <td>{trafficNumber(comparison.baseline[measure.key])}</td>
                <td>{trafficNumber(comparison.proposal[measure.key])}</td>
                <td>{trafficNumber(comparison.delta[measure.key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className="traffic-comparison-cards"
        aria-label="Traffic measure comparison"
      >
        <p className="traffic-muted">
          Comparable completed-run measures; unavailable values are not zero.
        </p>
        {trafficMeasures.map((measure) => (
          <section
            className="traffic-comparison-card"
            key={measure.key}
            aria-label={measure.label}
          >
            <h4>{measure.label}</h4>
            <p>{measure.unit}</p>
            <dl>
              <div>
                <dt>Baseline</dt>
                <dd>{trafficNumber(comparison.baseline[measure.key])}</dd>
              </div>
              <div>
                <dt>Proposal</dt>
                <dd>{trafficNumber(comparison.proposal[measure.key])}</dd>
              </div>
              <div>
                <dt>Change</dt>
                <dd>{trafficNumber(comparison.delta[measure.key])}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>
    </>
  );
}

function EdgeResults({ pair }: { pair: TrafficResultPair }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const matches = pair.baseline.edges.filter((row) =>
    row.edgeId.toLowerCase().includes(query.toLowerCase()),
  );
  const proposed = new Map(
    pair.proposal.edges.map((row) => [
      `${row.edgeId}:${row.beginSeconds}:${row.endSeconds}`,
      row,
    ]),
  );
  const baselineKeys = new Set(
    pair.baseline.edges.map(
      (row) => `${row.edgeId}:${row.beginSeconds}:${row.endSeconds}`,
    ),
  );
  const proposalOnly = pair.proposal.edges.filter(
    (row) =>
      !baselineKeys.has(`${row.edgeId}:${row.beginSeconds}:${row.endSeconds}`),
  );
  return (
    <details className="traffic-card">
      <summary>Directed-edge interval results</summary>
      <p className="traffic-muted">
        Native measurements for each exact edge and interval. Entered vehicles
        are link flows, not unique regional trips; never sum them as trip
        totals. An absent counterpart is unavailable, not zero.
      </p>
      <label className="traffic-search">
        <span>Find result edge</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(50);
          }}
        />
      </label>
      <div className="traffic-table-scroll">
        <table>
          <caption>
            Baseline and proposal link measurements · m/s and seconds
          </caption>
          <thead>
            <tr>
              <th>Edge / interval</th>
              <th>Entered: baseline / proposal</th>
              <th>Mean speed: baseline / proposal</th>
              <th>Mean travel time: baseline / proposal</th>
            </tr>
          </thead>
          <tbody>
            {matches.slice(0, limit).map((row) => {
              const key = `${row.edgeId}:${row.beginSeconds}:${row.endSeconds}`,
                other = proposed.get(key);
              return (
                <tr key={key}>
                  <th>
                    {row.edgeId}
                    <small>
                      {trafficClock(row.beginSeconds)}–
                      {trafficClock(row.endSeconds)}
                    </small>
                  </th>
                  <td>
                    {trafficNumber(row.entered, 0)} /{" "}
                    {trafficNumber(other?.entered, 0)}
                  </td>
                  <td>
                    {trafficNumber(row.meanSpeedMps)} /{" "}
                    {trafficNumber(other?.meanSpeedMps)}
                  </td>
                  <td>
                    {trafficNumber(row.meanTravelTimeSeconds)} /{" "}
                    {trafficNumber(other?.meanTravelTimeSeconds)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {matches.length > limit && (
        <button
          type="button"
          className="button"
          onClick={() => setLimit((value) => value + 50)}
        >
          Show 50 more edge intervals
        </button>
      )}
      {proposalOnly.length > 0 && (
        <p>
          {proposalOnly.length.toLocaleString()} proposal-only edge intervals
          have no baseline counterpart. They remain in the complete evidence
          download and are excluded from this aligned table.
        </p>
      )}
      <p className="traffic-muted">
        These measurements do not supply lane-capacity, queue or
        level-of-service claims absent from the captured result.
      </p>
    </details>
  );
}
