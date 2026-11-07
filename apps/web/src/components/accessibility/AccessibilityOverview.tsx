import { useState } from "react";
import { ArrowUpRight, BriefcaseBusiness, ExternalLink } from "lucide-react";
import type {
  AccessibilityCapture,
  AccessibilityCount,
  AccessibilityModeEvidence,
  AccessibilityScenario,
  Scenario,
} from "@urban/core";
import "./accessibility.css";

export const accessibilityNumber = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
        value,
      );
export const accessibilityMode = (mode: "car" | "walk") =>
  mode === "car" ? "Driving" : "Walking";
export const accessibilityOriginLabel = (
  evidence: AccessibilityModeEvidence,
) =>
  evidence.origin === "server-run"
    ? "Captured analysis"
    : "Imported evidence · not verified by this server";
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
export function differentAccessibilityOrigins(
  value: AccessibilityScenario | undefined,
) {
  const a = value?.captures.car?.capture.request.site,
    b = value?.captures.walk?.capture.request.site;
  return !!a && !!b && (a[0] !== b[0] || a[1] !== b[1]);
}
function CountValue({ count }: { count: AccessibilityCount }) {
  return (
    <>
      <strong>
        {accessibilityNumber(count.estimate ?? count.knownSubtotal)}
      </strong>
      {count.estimate === null && count.knownSubtotal !== null && (
        <small>Known subtotal only</small>
      )}
    </>
  );
}
function CountLimits({ count }: { count: AccessibilityCount }) {
  return (
    <details className="accessibility-count-evidence">
      <summary>
        {count.status === "complete"
          ? "Complete within captured coverage"
          : count.status === "partial"
            ? "Incomplete evidence"
            : "Unavailable"}
      </summary>
      <dl>
        <div>
          <dt>Unresolved workplace blocks</dt>
          <dd>{accessibilityNumber(count.unresolvedDestinationCount)}</dd>
        </div>
        <div>
          <dt>Jobs in unresolved blocks</dt>
          <dd>{accessibilityNumber(count.unresolvedJobs)}</dd>
        </div>
        <div>
          <dt>Upper bound within proven coverage</dt>
          <dd>{accessibilityNumber(count.upperBound)}</dd>
        </div>
      </dl>
      <p>
        A bound is not a forecast or a confidence interval. Unresolved jobs are
        not assumed reachable or unreachable.
      </p>
    </details>
  );
}
export function AccessibilityQuickResult({
  accessibility,
  stale = false,
  minutes = 30,
}: {
  accessibility: AccessibilityModeEvidence;
  stale?: boolean;
  minutes?: 15 | 30 | 45;
}) {
  const threshold = accessibility.capture.thresholds.find(
    (t) => t.minutes === minutes,
  )!;
  return (
    <section
      className="accessibility-quick"
      aria-label="Jobs accessibility at a glance"
    >
      <div>
        <span>
          {stale ? "Previous query" : "Captured regional network"} · {minutes}{" "}
          min
        </span>
        <CountValue count={threshold.total} />
        <small>
          Primary jobs ·{" "}
          {accessibilityMode(accessibility.capture.request.mode).toLowerCase()}{" "}
          from this origin
        </small>
      </div>
      <div>
        <strong>
          {accessibility.capture.source.region.label} · LODES{" "}
          {accessibility.capture.source.lodes.year}
        </strong>
        <p>
          {threshold.total.estimate === null
            ? "Full total unavailable. The known subtotal excludes unresolved evidence."
            : "Cumulative jobs within the captured travel-time limit."}
        </p>
        <p className="accessibility-quick-caveat">
          No proposed street, building, or future growth effects are included.
        </p>
      </div>
    </section>
  );
}
export function AccessibilityResults({
  accessibility,
  minutes: controlled,
  onMinutesChange,
}: {
  accessibility: AccessibilityModeEvidence;
  minutes?: 15 | 30 | 45;
  onMinutesChange?: (value: 15 | 30 | 45) => void;
}) {
  const [ownMinutes, setMinutes] = useState<15 | 30 | 45>(30),
    [family, setFamily] = useState<"earnings" | "industries">("earnings");
  const minutes = controlled ?? ownMinutes,
    capture = accessibility.capture,
    threshold = capture.thresholds.find((t) => t.minutes === minutes)!;
  return (
    <section
      className="accessibility-results"
      aria-label="Captured jobs accessibility evidence"
    >
      <div className="accessibility-result-heading">
        <div>
          <span className="eyebrow">JOBS WITHIN REACH</span>
          <h3>Travel from this origin</h3>
        </div>
        <span className="accessibility-chip">
          {accessibilityMode(capture.request.mode)} · outbound
        </span>
      </div>
      <p
        className={
          accessibility.origin === "imported"
            ? "accessibility-warning"
            : "accessibility-note"
        }
      >
        <strong>{accessibilityOriginLabel(accessibility)}</strong>
        {accessibility.origin === "imported" &&
          " · Retained numbers and source claims were imported. A copied receipt or hash does not establish server verification."}
      </p>
      <p className="accessibility-universe">
        <strong>
          Primary jobs at workplaces · {capture.source.lodes.jobType}
        </strong>
        <span>
          LODES {capture.source.lodes.year} · {capture.source.region.label}.
          Jobs are not vacancies, available applicants, or distinct employers.
          The travel limits are cumulative; do not add them.
        </span>
      </p>
      <div
        className="accessibility-thresholds"
        role="group"
        aria-label="Captured jobs travel-time thresholds"
      >
        {capture.thresholds.map((row) => (
          <button
            type="button"
            key={row.minutes}
            aria-pressed={minutes === row.minutes}
            onClick={() => {
              setMinutes(row.minutes);
              onMinutesChange?.(row.minutes);
            }}
          >
            <span>{row.minutes} min</span>
            <CountValue count={row.total} />
            <small>
              {row.total.status === "complete"
                ? "Primary jobs"
                : "Full total unavailable"}
            </small>
          </button>
        ))}
      </div>
      {threshold.total.estimate === null && (
        <p className="accessibility-warning">
          The full {minutes}-minute total is unavailable. A known subtotal omits
          unresolved or missing evidence and is not the complete jobs catchment.
        </p>
      )}
      <CountLimits count={threshold.total} />
      <div className="accessibility-results-controls">
        <h4>What kinds of jobs?</h4>
        <div
          className="accessibility-segment"
          role="group"
          aria-label="Workplace job categories"
        >
          {(["earnings", "industries"] as const).map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={family === id}
              onClick={() => setFamily(id)}
            >
              {id === "earnings" ? "Earnings" : "Industry"}
            </button>
          ))}
        </div>
      </div>
      <p className="accessibility-note">
        Each category family describes the same primary-job total. Do not add
        earnings and industry counts together. Earnings are source-year monthly
        bands, not current advertised salaries.
      </p>
      <div
        className="accessibility-category-list"
        role="list"
        aria-label={`${family === "earnings" ? "Earnings" : "Industry"} jobs within ${minutes} minutes`}
      >
        {threshold[family].map((row) => (
          <article key={row.id} role="listitem">
            <div>
              <h4>{row.label}</h4>
              <details className="accessibility-source-cells">
                <summary>Source cells</summary>
                {row.sourceCells.join(", ")}
              </details>
            </div>
            <div className="accessibility-category-value">
              <CountValue count={row} />
              <span>primary jobs</span>
            </div>
            <CountLimits count={row} />
          </article>
        ))}
      </div>
      <p className="accessibility-note">
        Captured {date(capture.capturedAt)}. Counts use each workplace block’s
        routed representative point, not the area inside an interpolated
        contour. No sampling margin is supplied by this method.
      </p>
    </section>
  );
}
export function AccessibilityMethod({
  evidence,
}: {
  evidence: AccessibilityModeEvidence;
}) {
  const c = evidence.capture;
  const statusLabel: Record<string, string> = {
    reachable: "Returned travel time",
    unreachable: "No returned path · unresolved",
    "outside-threshold": "Proven beyond 45 minutes",
    unsnappable: "No accepted network connection",
    "outside-coverage": "Outside captured coverage",
    unavailable: "Routing unavailable",
    "zero-jobs": "Retained zero-job source blocks",
  };
  return (
    <details className="accessibility-method">
      <summary>Coverage, method & sources</summary>
      <p>
        Jobs accessibility is outbound travel from the selected origin. The
        workforce shed is a different question: people who can travel toward a
        destination.
      </p>
      <p>
        This capture uses a static regional source network. Local street,
        signal, building and activity edits, future horizons and illustrative
        city animation do not reroute it. It is not a measured commute or a
        baseline-to-proposal effect.
      </p>
      <div className="accessibility-method-grid">
        <dl>
          <div>
            <dt>Origin longitude, latitude</dt>
            <dd>{c.request.site.join(", ")}</dd>
          </div>
          <div>
            <dt>Origin to routing connection</dt>
            <dd>
              {c.siteSnapMeters.toFixed(1)} m · exact connection coordinate
              unavailable; no entrance is established
            </dd>
          </div>
          <div>
            <dt>Workplace location method</dt>
            <dd>
              Native Census block internal point · not a workplace entrance
            </dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{c.methodVersion}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>
              {c.network.engine} {c.network.engineVersion} · {c.network.costing}
            </dd>
          </div>
        </dl>
        <dl>
          <div>
            <dt>Destination source coverage</dt>
            <dd>{c.coverage.destinations.status}</dd>
          </div>
          <div>
            <dt>Network catchment coverage</dt>
            <dd>{c.coverage.network}</dd>
          </div>
          <div>
            <dt>Complete prepared source inventory</dt>
            <dd>{c.coverage.regionDataComplete ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Retained workplace blocks</dt>
            <dd>{accessibilityNumber(c.coverage.destinationCount)}</dd>
          </div>
          <div>
            <dt>Primary jobs in the full source region</dt>
            <dd>
              {accessibilityNumber(c.coverage.sourceJobs)} · not the catchment
              total
            </dd>
          </div>
          <div>
            <dt>Retained zero-job blocks</dt>
            <dd>{accessibilityNumber(c.coverage.zeroJobDestinationCount)}</dd>
          </div>
        </dl>
      </div>
      <h4>Every destination remains accounted for</h4>
      <dl className="accessibility-route-status">
        {Object.entries(c.coverage.routeStatusCounts).map(([status, value]) => (
          <div key={status}>
            <dt>{statusLabel[status] ?? status}</dt>
            <dd>{accessibilityNumber(value)} blocks</dd>
          </div>
        ))}
      </dl>
      <p>
        Missing native paths remain unresolved unless a conservative bound
        proves the destination is beyond the threshold. Zero jobs are retained
        as zero. Published source counts, block-location approximation and
        routing assumptions are separate uncertainties; no invented confidence
        range is supplied.
      </p>
      {[...c.notes, ...c.network.notes, ...c.coverage.destinations.notes].map(
        (note, index) => (
          <p key={index}>{note}</p>
        ),
      )}
      <h4>Captured source inventory</h4>
      <CaptureSources capture={c} />
      <details>
        <summary>Exact capture and source identities</summary>
        <dl>
          {[
            ["Capture SHA-256", evidence.captureHash],
            ["Original artifact SHA-256", c.artifactHash],
            ["Jobs pack SHA-256", c.jobsPackHash],
            ["Network graph SHA-256", c.network.graphHash],
            ["Routing profile SHA-256", c.network.profileHash],
            ["Contour SHA-256", c.contour.sha256],
            [
              "Source coverage boundary SHA-256",
              c.coverage.destinations.boundaryHash ?? "Unavailable",
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
        {c.files.map((file, index) => (
          <p key={index}>
            {file.sourceId} · {file.bytes.toLocaleString()} bytes · retrieved{" "}
            {date(file.retrievedAt)}
            <code>{file.sha256}</code>
          </p>
        ))}
      </details>
    </details>
  );
}
function CaptureSources({ capture }: { capture: AccessibilityCapture }) {
  return (
    <div className="accessibility-sources">
      {capture.sources.map((source) => (
        <article key={source.id}>
          <strong>{source.name}</strong>
          <p>
            {source.vintage} · {source.kind} · {source.license}
          </p>
          {source.description && <p>{source.description}</p>}
          {/^https?:\/\//i.test(source.url) && (
            <a href={source.url} target="_blank" rel="noreferrer">
              View source <ExternalLink size={12} />
            </a>
          )}
        </article>
      ))}
    </div>
  );
}
export function AccessibilitySources({
  accessibility,
}: {
  accessibility: AccessibilityScenario;
}) {
  return (
    <>
      {(["car", "walk"] as const).map((mode) => {
        const e = accessibility.captures[mode];
        return (
          e && (
            <section key={mode}>
              <h4>
                {accessibilityMode(mode)} capture · {date(e.capture.capturedAt)}
              </h4>
              <CaptureSources capture={e.capture} />
            </section>
          )
        );
      })}
    </>
  );
}
export function AccessibilityPanel({
  scenario,
  onOpen,
}: {
  scenario: Scenario;
  onOpen: () => void;
}) {
  const saved = scenario.accessibility;
  return (
    <section className="accessibility-launcher" aria-label="Jobs accessibility">
      <div className="eyebrow">REGIONAL JOBS</div>
      <h3>Where can you get to work?</h3>
      <p>
        Travel <strong>from</strong> an origin to primary jobs within 15, 30 or
        45 minutes.
      </p>
      {saved && (
        <>
          <p className="accessibility-note">
            Captured source network · proposal effects not modeled
          </p>
          <table className="accessibility-overview-table">
            <caption>Saved cumulative primary-job counts</caption>
            <thead>
              <tr>
                <th scope="col">Mode</th>
                {[15, 30, 45].map((m) => (
                  <th scope="col" key={m}>
                    {m} min
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["car", "walk"] as const).map((mode) => {
                const e = saved.captures[mode];
                return (
                  e && (
                    <tr key={mode}>
                      <th scope="row">{accessibilityMode(mode)}</th>
                      {e.capture.thresholds.map((t) => (
                        <td key={t.minutes}>
                          {accessibilityNumber(
                            t.total.estimate ?? t.total.knownSubtotal,
                          )}
                          {t.total.estimate === null &&
                            t.total.knownSubtotal !== null && (
                              <small>subtotal</small>
                            )}
                        </td>
                      ))}
                    </tr>
                  )
                );
              })}
            </tbody>
          </table>
          {Object.values(saved.captures).some(
            (e) => e.origin === "imported",
          ) && (
            <p className="accessibility-note">
              Imported evidence · not verified by this server
            </p>
          )}
          {differentAccessibilityOrigins(saved) && (
            <p className="accessibility-warning">
              These modes use different origins. They are not a same-origin mode
              comparison.
            </p>
          )}
        </>
      )}
      <button
        type="button"
        className="button secondary-button"
        onClick={onOpen}
      >
        <BriefcaseBusiness size={16} />
        Open jobs accessibility
        <ArrowUpRight size={14} />
      </button>
      <small>Outbound · captured regional network</small>
    </section>
  );
}
export function PublishedAccessibility({
  scenario,
  expanded = false,
}: {
  scenario: Scenario;
  expanded?: boolean;
}) {
  if (!scenario.accessibility) return null;
  return (
    <details className="accessibility-published" open={expanded || undefined}>
      <summary>Jobs accessibility · frozen outbound evidence</summary>
      <p className="accessibility-note">
        These tables are frozen with the proposal. Regional contours are stored
        separately and are not included here; no private job or archive is
        requested. Local proposal changes have not been routed into these
        captured-network results.
      </p>
      {differentAccessibilityOrigins(scenario.accessibility) && (
        <p className="accessibility-warning">
          Driving and walking were captured from different origins. Do not
          present them as a same-origin mode comparison.
        </p>
      )}
      {(["car", "walk"] as const).map((mode) => {
        const e = scenario.accessibility?.captures[mode];
        return (
          e && (
            <div key={mode}>
              <AccessibilityResults accessibility={e} />
              <AccessibilityMethod evidence={e} />
            </div>
          )
        );
      })}
    </details>
  );
}
