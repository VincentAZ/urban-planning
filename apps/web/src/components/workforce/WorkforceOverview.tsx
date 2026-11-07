import { useState } from "react";
import { ArrowUpRight, Footprints, UsersRound } from "lucide-react";
import type {
  Scenario,
  WorkforceCapturedCount,
  WorkforceCapture,
  WorkforceScenario,
} from "@urban/core";
import "./workforce.css";

export const workforceNumber = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
        value,
      );
export const workforceMode = (mode: "car" | "walk") =>
  mode === "car" ? "Driving" : "Walking";
const capturedDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export const workforceOriginLabel = (workforce: WorkforceScenario) =>
  workforce.origin === "server-run"
    ? "Captured analysis"
    : "Imported evidence · not verified by this server";

function WorkforceOriginNotice({
  workforce,
}: {
  workforce: WorkforceScenario;
}) {
  const imported = workforce.origin !== "server-run";
  return (
    <p
      className={
        imported
          ? "workforce-warning workforce-origin"
          : "workforce-note workforce-origin"
      }
    >
      <strong>{workforceOriginLabel(workforce)}</strong>
      {imported && (
        <span>
          These values and citations were retained from an imported project. Its
          receipt and hashes do not establish that this server produced or
          checked the analysis. Inspect its sources, or request a new run before
          adopting new server evidence.
        </span>
      )}
    </p>
  );
}

function CountEvidence({ count }: { count: WorkforceCapturedCount }) {
  return (
    <details className="workforce-count-evidence">
      <summary>
        {count.status === "complete"
          ? "Complete estimate"
          : count.status === "partial"
            ? "Partial evidence"
            : "Unavailable"}
      </summary>
      <dl>
        <div>
          <dt>Missing source units</dt>
          <dd>{count.missingUnitCount}</dd>
        </div>
        <div>
          <dt>Suppressed source units</dt>
          <dd>{count.suppressedUnitCount}</dd>
        </div>
        <div>
          <dt>Unknown spatial allocation</dt>
          <dd>{count.unresolvedAllocationUnitCount}</dd>
        </div>
        <div>
          <dt>Allocation limits on uncertainty</dt>
          <dd>{count.unresolvedAllocationMoeUnitCount}</dd>
        </div>
        <div>
          <dt>Missing source margins</dt>
          <dd>{count.missingMoeUnitCount}</dd>
        </div>
        <div>
          <dt>Partly reached native units</dt>
          <dd>{count.geographicallyPartialUnitCount}</dd>
        </div>
      </dl>
      {Object.entries(count.sourceIssueCellCounts).some(([, n]) => n > 0) && (
        <p>
          Source cells:{" "}
          {Object.entries(count.sourceIssueCellCounts)
            .filter(([, n]) => n > 0)
            .map(([status, n]) => `${n} ${status}`)
            .join("; ")}
          . These are cell counts, not people.
        </p>
      )}
    </details>
  );
}
function CountValue({ count }: { count: WorkforceCapturedCount }) {
  return (
    <>
      <strong>{workforceNumber(count.estimate ?? count.knownSubtotal)}</strong>
      {count.estimate === null && count.knownSubtotal !== null && (
        <small>Known subtotal only</small>
      )}
    </>
  );
}
function CountMargin({ count }: { count: WorkforceCapturedCount }) {
  const value =
    count.estimate === null
      ? count.knownSubtotalMarginOfError90
      : count.marginOfError90;
  return (
    <>
      {value === null ? "Unavailable" : `± ${workforceNumber(value)}`}
      {count.estimate === null && value !== null && (
        <small>For known subtotal</small>
      )}
    </>
  );
}

export function WorkforceResults({
  workforce,
  minutes,
  onMinutesChange,
  panelId: controlledPanelId,
  onPanelChange,
}: {
  workforce: WorkforceScenario;
  minutes?: 15 | 30 | 45;
  onMinutesChange?: (value: 15 | 30 | 45) => void;
  panelId?: "education" | "occupation";
  onPanelChange?: (value: "education" | "occupation") => void;
}) {
  const [ownMinutes, setOwnMinutes] = useState<15 | 30 | 45>(30);
  const [ownPanelId, setPanelId] = useState<"education" | "occupation">(
    "education",
  );
  const panelId = controlledPanelId ?? ownPanelId;
  const threshold = minutes ?? ownMinutes;
  const capture = workforce.capture;
  const panel = capture.panels.find((value) => value.id === panelId)!;
  const results = panel.thresholds.find(
    (value) => value.minutes === threshold,
  )!;
  return (
    <section
      className="workforce-results"
      aria-label="Captured workforce evidence"
    >
      <div className="workforce-result-heading">
        <div>
          <span className="eyebrow">PEOPLE WITHIN REACH</span>
          <h3>Travel to this site</h3>
        </div>
        <span className="workforce-chip">
          {workforceMode(capture.request.mode)} · inbound
        </span>
      </div>
      <WorkforceOriginNotice workforce={workforce} />
      <div className="workforce-results-controls">
        <div
          className="workforce-segment"
          role="group"
          aria-label="Workforce evidence population"
        >
          {capture.panels.map((value) => (
            <button
              type="button"
              key={value.id}
              aria-pressed={panelId === value.id}
              onClick={() => {
                setPanelId(value.id);
                onPanelChange?.(value.id);
              }}
            >
              {value.id === "education" ? "Education" : "Occupation"}
            </button>
          ))}
        </div>
        <div
          className="workforce-segment"
          role="group"
          aria-label="Captured travel-time threshold"
        >
          {([15, 30, 45] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={threshold === value}
              onClick={() => {
                setOwnMinutes(value);
                onMinutesChange?.(value);
              }}
            >
              {value} min
            </button>
          ))}
        </div>
      </div>
      <p className="workforce-universe">
        <strong>{panel.label}</strong>
        <span>
          {panel.universe} · ACS {capture.cohort.acs.period.start}–
          {capture.cohort.acs.period.end}, {panel.table}
        </span>
      </p>
      <div className="workforce-total">
        <div>
          <span>
            {results.total.estimate === null
              ? "Known subtotal"
              : "Estimated population"}
          </span>
          <CountValue count={results.total} />
        </div>
        <div>
          <span>Conditional 90% sampling margin</span>
          <CountMargin count={results.total} />
        </div>
        <CountEvidence count={results.total} />
      </div>
      {results.total.estimate === null && (
        <p className="workforce-warning">
          The full {threshold}-minute total is unavailable. Any known subtotal
          excludes unresolved or missing evidence and must not be treated as the
          complete workforce shed.
        </p>
      )}
      <table className="workforce-table">
        <caption>
          {threshold}-minute inbound{" "}
          {workforceMode(capture.request.mode).toLowerCase()} · captured{" "}
          {capturedDate(capture.capturedAt)}. Counts are allocated estimates,
          not a register of available workers.
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {panel.id === "education"
                ? "Educational attainment"
                : "Occupation group"}
            </th>
            <th scope="col">Estimate</th>
            <th scope="col">Conditional 90% margin</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {results.categories.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                {row.label}
                <details className="workforce-source-cells">
                  <summary>Source cells</summary>
                  <small>{row.sourceCells.join(", ")}</small>
                </details>
              </th>
              <td data-label="Estimate">
                <CountValue count={row} />
              </td>
              <td data-label="Conditional 90% margin">
                <CountMargin count={row} />
              </td>
              <td data-label="Evidence">
                <CountEvidence count={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="workforce-note">
        Education and occupation use different Census populations. They cannot
        be combined into a count of people with both a particular qualification
        and occupation. These are resident characteristics, not vacancies,
        willingness to commute, or applicants.
      </p>
    </section>
  );
}

export function WorkforceQuickResult({
  workforce,
  minutes,
  panelId,
  stale,
}: {
  workforce: WorkforceScenario;
  minutes: 15 | 30 | 45;
  panelId: "education" | "occupation";
  stale: boolean;
}) {
  const panel = workforce.capture.panels.find((value) => value.id === panelId)!;
  const total = panel.thresholds.find(
    (value) => value.minutes === minutes,
  )!.total;
  return (
    <section
      className="workforce-quick"
      aria-label="Captured workforce at a glance"
    >
      <div>
        <span>
          {minutes}-minute{" "}
          {workforceMode(workforce.capture.request.mode).toLowerCase()} ·
          inbound
        </span>
        <strong>
          {workforceNumber(total.estimate ?? total.knownSubtotal)}
        </strong>
        <small>
          {total.estimate === null
            ? "Known subtotal only"
            : "Estimated population"}
        </small>
      </div>
      <div>
        <strong>{panel.label}</strong>
        <p>{panel.universe}</p>
        <small>
          {workforceOriginLabel(workforce)}
          {stale ? " · Previous query" : ""}
        </small>
        {total.estimate === null && (
          <p className="workforce-quick-caveat">
            Full total unavailable. This subtotal excludes unresolved or missing
            evidence.
          </p>
        )}
      </div>
    </section>
  );
}

export function WorkforceMethod({ capture }: { capture: WorkforceCapture }) {
  const coverage = capture.coverage;
  return (
    <details className="workforce-method">
      <summary>Sources, routing & uncertainty</summary>
      <div className="workforce-method-grid">
        <section>
          <h4>Captured query</h4>
          <dl>
            <div>
              <dt>Site latitude, longitude</dt>
              <dd>
                {capture.request.site[1]}, {capture.request.site[0]}
              </dd>
            </div>
            <div>
              <dt>Site-to-network connection</dt>
              <dd>
                {workforceNumber(capture.siteSnapMeters)} m · exact connection
                coordinate unavailable
              </dd>
            </div>
            <div>
              <dt>Travel</dt>
              <dd>
                {workforceMode(capture.request.mode)} to the site · 15 / 30 / 45
                minutes
              </dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>
                {capture.network.engine} {capture.network.engineVersion} ·{" "}
                {capture.network.costing === "static"
                  ? "Static costs; not live traffic"
                  : "Time-dependent costs"}
              </dd>
            </div>
            <div>
              <dt>Captured</dt>
              <dd>{new Date(capture.capturedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Method</dt>
              <dd>{capture.methodVersion}</dd>
            </div>
          </dl>
          <p>
            Local street edits are not part of this regional routing graph.
            Feature anchors are suggested site positions, not verified
            entrances. The actual routing connection may be displaced from the
            chosen site.
          </p>
        </section>
        <section>
          <h4>Source coverage</h4>
          <dl>
            <div>
              <dt>Region</dt>
              <dd>{capture.cohort.region.label}</dd>
            </div>
            <div>
              <dt>Source county inventory</dt>
              <dd>
                {capture.cohort.region.countyGeoids.length} counties ·{" "}
                {coverage.regionDataComplete
                  ? "complete declared inventory"
                  : "incomplete declared inventory"}
              </dd>
            </div>
            <div>
              <dt>Potential catchment</dt>
              <dd>
                Graph: {coverage.network}; source region:{" "}
                {coverage.cohort.status}
              </dd>
            </div>
            <div>
              <dt>Native block groups</dt>
              <dd>{workforceNumber(coverage.nativeUnits)}</dd>
            </div>
            <div>
              <dt>Unresolved block allocation</dt>
              <dd>
                {workforceNumber(coverage.unallocatedOriginCount)} original
                blocks · {workforceNumber(coverage.unallocatedPopulation2020)}{" "}
                people in 2020
              </dd>
            </div>
            <div>
              <dt>Affected block groups</dt>
              <dd>{workforceNumber(coverage.ambiguousAffectedUnitCount)}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h4>Allocation & uncertainty</h4>
          <p>
            Native ACS block-group estimates are allocated using retained 2020
            Census block populations and individually routed origins. Geographic
            splits with unknown allocation are retained as unresolved; their
            population is not silently redistributed.
          </p>
          <p>
            Approximate conditional 90% sampling margins exclude
            spatial-allocation error and routing error. A smaller displayed
            margin does not remove those limitations.
          </p>
          <p>{capture.uncertainty.formula}</p>
        </section>
        <section>
          <h4>Routing outcomes</h4>
          <dl>
            {Object.entries(coverage.routeStatusCounts).map(
              ([status, count]) => (
                <div key={status}>
                  <dt>{status.replaceAll("-", " ")}</dt>
                  <dd>{workforceNumber(count)}</dd>
                </div>
              ),
            )}
          </dl>
          <p>
            Unreachable and outside the time threshold are distinct from
            missing, unsnappable, or outside-coverage origins.
          </p>
        </section>
      </div>
      {[
        ...capture.notes,
        ...capture.network.notes,
        ...capture.cohort.allocation.notes,
        ...coverage.cohort.notes,
      ].length > 0 && (
        <details>
          <summary>Captured limitations</summary>
          <ul>
            {[
              ...new Set([
                ...capture.notes,
                ...capture.network.notes,
                ...capture.cohort.allocation.notes,
                ...coverage.cohort.notes,
              ]),
            ].map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      <h4>Source citations</h4>
      <WorkforceSources capture={capture} />
      <details>
        <summary>Reproducible artifact identities</summary>
        <dl className="workforce-hashes">
          {[
            ["Input", capture.inputHash],
            ["Cohort pack", capture.cohortPackHash],
            ["Graph", capture.network.graphHash],
            ["Routing profile", capture.network.profileHash],
            ["Result", capture.resultHash],
            ["Contour", capture.contour.sha256],
            [
              "Source-region boundary",
              capture.coverage.cohort.boundaryHash ?? "Unavailable",
            ],
          ].map(([label, hash]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <code>{hash}</code>
              </dd>
            </div>
          ))}
        </dl>
        <p>
          Hashes identify captured bytes; a hash or imported receipt alone does
          not establish server verification.
        </p>
        <ul className="workforce-file-list">
          {capture.files.map((file, index) => (
            <li key={`${file.sha256}:${index}`}>
              <a href={file.url} target="_blank" rel="noreferrer">
                {file.table ?? file.sourceId}
              </a>{" "}
              · retrieved {capturedDate(file.retrievedAt)}
              <code>{file.sha256}</code>
            </li>
          ))}
        </ul>
      </details>
    </details>
  );
}

export function WorkforcePanel({
  scenario,
  onOpen,
}: {
  scenario: Scenario;
  onOpen: () => void;
}) {
  return (
    <div className="workforce-launcher">
      <span className="workforce-launch-icon">
        <UsersRound size={23} />
      </span>
      <h3>Who can reach this site?</h3>
      <p>
        Explore source-backed education and occupation evidence within 15, 30,
        and 45 minutes of travel to a chosen location.
      </p>
      {scenario.workforce && (
        <p className="workforce-saved-note">
          <strong>{workforceOriginLabel(scenario.workforce)}</strong>
          <br />
          {workforceMode(
            scenario.workforce.capture.request.mode,
          ).toLowerCase()}{" "}
          evidence · {capturedDate(scenario.workforce.capture.capturedAt)}
        </p>
      )}
      <button
        type="button"
        className="button secondary-button"
        onClick={onOpen}
      >
        <Footprints size={16} />
        Open workforce workbench
      </button>
      <small>Regional routing · separate from local street edits</small>
    </div>
  );
}
export function PublishedWorkforce({ scenario }: { scenario: Scenario }) {
  if (!scenario.workforce) return null;
  return (
    <details className="workforce-published">
      <summary>
        Workforce shed · {workforceOriginLabel(scenario.workforce)}
      </summary>
      <p className="workforce-note">
        This is the frozen summary included in this proposal. The separately
        stored regional contour is not included here; no private job or archive
        is requested.
      </p>
      <WorkforceResults workforce={scenario.workforce} />
      <WorkforceMethod capture={scenario.workforce.capture} />
    </details>
  );
}

/** Kept separate from feature/scorecard source IDs, including imported captures. */
export function WorkforceSources({ capture }: { capture: WorkforceCapture }) {
  return (
    <div className="workforce-sources">
      {capture.sources.map((source) => (
        <article key={source.id}>
          <strong>{source.name}</strong>
          <p>
            {source.vintage} · {source.kind} · {source.license}
          </p>
          {source.description && <p>{source.description}</p>}
          {/^https?:\/\//i.test(source.url) && (
            <a href={source.url} target="_blank" rel="noreferrer">
              Open source <ArrowUpRight size={13} />
            </a>
          )}
        </article>
      ))}
    </div>
  );
}
