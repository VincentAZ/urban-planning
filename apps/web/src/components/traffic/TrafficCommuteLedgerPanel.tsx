import { Fragment, useDeferredValue, useId, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, Search } from "lucide-react";
import type {
  TrafficCommuteLedgerCell,
  TrafficCommuteLedgerRow,
  TrafficCommuteLedgerView,
} from "../../lib/traffic-commute-ledger";

export interface TrafficCommuteLedgerPanelProps {
  view: TrafficCommuteLedgerView;
  onExport: (kind: "flows" | "source-cells") => void;
}

const PAGE_SIZE = 50;
const routeLabels: Record<TrafficCommuteLedgerRow["routeStatus"], string> = {
  routed: "Local route supported",
  "no-local-intersection": "Does not cross this network",
  unreachable: "Regional route unavailable",
  unsnappable: "Source point could not attach",
  "outside-coverage": "Outside routing coverage",
  "unmatched-local-network": "Local correspondence unresolved",
  "reentry-unsupported": "Multiple local entries unresolved",
};
const outcomeChoices = [
  ["all", "All outcomes"],
  ["admitted", "Admitted to the local window"],
  ["unresolved", "Route unresolved"],
  ["rounded-zero", "Admitted fraction rounded to zero"],
  ["before", "Includes demand before the window"],
  ["after", "Includes demand after the window"],
  ...Object.entries(routeLabels).map(([key, label]) => [`route:${key}`, label]),
] as const;

function number(value: number | null, exact = false): string {
  if (value === null) return "Unavailable";
  if (exact) return String(value);
  if (value !== 0 && Math.abs(value) < 0.0001)
    return value < 0 ? "> −0.0001" : "< 0.0001";
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function clock(value: number | null): string {
  if (value === null) return "Unavailable";
  const milliseconds = Math.round(value * 1000),
    day = Math.floor(milliseconds / 86400000),
    local = milliseconds - day * 86400000,
    hours = Math.floor(local / 3600000),
    minutes = Math.floor((local % 3600000) / 60000),
    seconds = Math.floor((local % 60000) / 1000),
    fraction = local % 1000;
  return `${day ? `${day > 0 ? "+" : ""}${day}d ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}${seconds || fraction ? `:${String(seconds).padStart(2, "0")}${fraction ? `.${String(fraction).padStart(3, "0")}` : ""}` : ""}`;
}
const interval = (begin: number | null, end: number | null) =>
  begin === null || end === null
    ? "Unavailable"
    : `${clock(begin)}–${clock(end)}`;
function outcome(row: TrafficCommuteLedgerRow): string {
  if (row.routeStatus !== "routed") return routeLabels[row.routeStatus];
  if (row.admittedExpectedVehicles > 0) {
    if (row.beforeWindowVehicles > 0 || row.afterWindowVehicles > 0)
      return "Partly within the local window";
    return row.roundedVehicles === 0
      ? "Admitted · rounded to zero"
      : "Admitted";
  }
  if (row.beforeWindowVehicles > 0) return "Before the local window";
  if (row.afterWindowVehicles > 0) return "After the local window";
  return "Routed · no admitted mass";
}
function matchesOutcome(row: TrafficCommuteLedgerRow, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "admitted") return row.admittedExpectedVehicles > 0;
  if (filter === "unresolved") return row.unresolvedRouteVehicles > 0;
  if (filter === "rounded-zero")
    return row.admittedExpectedVehicles > 0 && row.roundedVehicles === 0;
  if (filter === "before") return row.beforeWindowVehicles > 0;
  if (filter === "after") return row.afterWindowVehicles > 0;
  return filter === `route:${row.routeStatus}`;
}

function Pager({
  page,
  count,
  kind,
  onChange,
}: {
  page: number;
  count: number;
  kind: "flow" | "source cell";
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return (
    <nav
      className="traffic-ledger-pager"
      aria-label={`${kind === "flow" ? "Flow" : "Source cell"} pages`}
    >
      <button
        type="button"
        className="button"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
        aria-label={`Previous ${kind} page`}
      >
        <ArrowLeft size={14} aria-hidden="true" /> Previous
      </button>
      <span>
        Page {page + 1} of {pages} · {PAGE_SIZE} records per page
      </span>
      <button
        type="button"
        className="button"
        disabled={page + 1 >= pages}
        onClick={() => onChange(page + 1)}
        aria-label={`Next ${kind} page`}
      >
        Next <ArrowRight size={14} aria-hidden="true" />
      </button>
    </nav>
  );
}

function FlowDetails({
  row,
  view,
}: {
  row: TrafficCommuteLedgerRow;
  view: TrafficCommuteLedgerView;
}) {
  return (
    <div className="traffic-ledger-record">
      <h5>Trace this flow and departure bin</h5>
      <p>
        {routeLabels[row.routeStatus]}.{" "}
        {row.routeReason || "No route failure was recorded."}
      </p>
      <dl className="traffic-ledger-detail-grid">
        <div>
          <dt>Original primary-job flow</dt>
          <dd>{number(row.primaryJobs)} jobs</dd>
          <small>Repeated in each departure bin; do not add across bins.</small>
        </div>
        <div>
          <dt>Resident primary-job denominator</dt>
          <dd>{number(row.residentPrimaryJobs)} jobs</dd>
          <small>Captured home-tract denominator, not a trip count.</small>
        </div>
        <div>
          <dt>Destination share</dt>
          <dd>{number(row.destinationShare, true)}</dd>
        </div>
        <div>
          <dt>Home departure</dt>
          <dd>{interval(row.homeBeginSeconds, row.homeEndSeconds)}</dd>
          <small>
            {row.homeTimeZone} · UTC offset {row.homeUtcOffsetMinutes} minutes
          </small>
        </div>
        <div>
          <dt>Local entry interval</dt>
          <dd>{interval(row.entryBeginSeconds, row.entryEndSeconds)}</dd>
          <small>
            {view.period.timeZone} · {view.period.date}
          </small>
        </div>
        <div>
          <dt>Retained within local window</dt>
          <dd>{interval(row.admittedBeginSeconds, row.admittedEndSeconds)}</dd>
        </div>
        <div>
          <dt>Local route classification</dt>
          <dd>{row.classification ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Home-to-local clock shift</dt>
          <dd>{number(row.localClockShiftSeconds, true)} seconds</dd>
        </div>
      </dl>
      <h5>Exact modeled vehicle accounting</h5>
      <dl className="traffic-ledger-detail-grid">
        {(
          [
            ["Source expected", row.expectedVehicles],
            ["Admitted expected", row.admittedExpectedVehicles],
            ["Warm-up expected", row.warmupExpectedVehicles],
            ["Measurement expected", row.measurementExpectedVehicles],
            ["Unresolved route", row.unresolvedRouteVehicles],
            ["Outside local network", row.noLocalIntersectionVehicles],
            ["Before local window", row.beforeWindowVehicles],
            ["After local window", row.afterWindowVehicles],
            ["Rounded vehicles", row.roundedVehicles],
            ["Rounding adjustment", row.roundingDelta],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{number(value, true)}</dd>
          </div>
        ))}
      </dl>
      <details className="traffic-ledger-provenance">
        <summary>Original rows, exact times and fingerprints</summary>
        <dl>
          <div>
            <dt>Source physical row</dt>
            <dd>{number(row.sourceRow)}</dd>
          </div>
          <div>
            <dt>Source file SHA-256</dt>
            <dd>
              <code>{row.sourceFileSha256}</code>
            </dd>
          </div>
          <div>
            <dt>Flow / bin identity</dt>
            <dd>
              <code>{row.id}</code>
            </dd>
          </div>
          <div>
            <dt>Source OD identity</dt>
            <dd>
              <code>{row.flowId}</code>
            </dd>
          </div>
          <div>
            <dt>ACS tract / cell</dt>
            <dd>
              {row.tractGeoid} / {row.cellId}
            </dd>
          </div>
          <div>
            <dt>Home interval, exact seconds</dt>
            <dd>
              {number(row.homeBeginSeconds, true)} →{" "}
              {number(row.homeEndSeconds, true)}
            </dd>
          </div>
          <div>
            <dt>Local entry, exact seconds</dt>
            <dd>
              {number(row.entryBeginSeconds, true)} →{" "}
              {number(row.entryEndSeconds, true)}
            </dd>
          </div>
          <div>
            <dt>Admitted interval, exact seconds</dt>
            <dd>
              {number(row.admittedBeginSeconds, true)} →{" "}
              {number(row.admittedEndSeconds, true)}
            </dd>
          </div>
          <div>
            <dt>Regional route SHA-256</dt>
            <dd>
              <code>{row.regionalRouteHash ?? "Unavailable"}</code>
            </dd>
          </div>
          <div>
            <dt>Local correspondence SHA-256</dt>
            <dd>
              <code>{row.localBindingHash ?? "Unavailable"}</code>
            </dd>
          </div>
          <div>
            <dt>Simulation demand row</dt>
            <dd>
              <code>
                {row.demandRowId ?? "No simulation row was allocated"}
              </code>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function CellIdentity({ cell }: { cell: TrafficCommuteLedgerCell }) {
  return (
    <>
      <strong>{cell.tractName}</strong>
      <small>
        {cell.tractGeoid} · {cell.cellId}
      </small>
    </>
  );
}
function CellEvidence({ cell }: { cell: TrafficCommuteLedgerCell }) {
  return (
    <details className="traffic-ledger-provenance">
      <summary>Source cell details</summary>
      <dl>
        <div>
          <dt>Estimate status / raw value</dt>
          <dd>
            {cell.estimate.status} / {cell.estimate.raw ?? "Unavailable"}
          </dd>
        </div>
        <div>
          <dt>Sampling margin</dt>
          <dd>
            {number(cell.marginOfError.value)} · {cell.marginOfError.status}
          </dd>
        </div>
        <div>
          <dt>Sampling margin raw value</dt>
          <dd>{cell.marginOfError.raw ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Allocation status</dt>
          <dd>{cell.status}</dd>
        </div>
        <div>
          <dt>Allocation note</dt>
          <dd>
            {cell.reason ?? "No unresolved source allocation was recorded."}
          </dd>
        </div>
        <div>
          <dt>Source file SHA-256</dt>
          <dd>
            <code>{cell.sourceFileSha256}</code>
          </dd>
        </div>
      </dl>
    </details>
  );
}

function LedgerContents({ view, onExport }: TrafficCommuteLedgerPanelProps) {
  const id = useId(),
    [query, setQuery] = useState(""),
    deferredQuery = useDeferredValue(query),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0),
    [cellPage, setCellPage] = useState(0),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const distinctFlows = useMemo(
    () =>
      new Set(
        view.rows.map((row) => `${row.homeBlockGeoid}:${row.workBlockGeoid}`),
      ).size,
    [view.rows],
  );
  const matched = useMemo(() => {
    const search = deferredQuery.trim();
    return view.rows.filter(
      (row) =>
        (!search ||
          row.homeBlockGeoid.includes(search) ||
          row.workBlockGeoid.includes(search)) &&
        matchesOutcome(row, filter),
    );
  }, [view.rows, deferredQuery, filter]);
  const matchedPairs = useMemo(
    () =>
      new Set(
        matched.map((row) => `${row.homeBlockGeoid}:${row.workBlockGeoid}`),
      ).size,
    [matched],
  );
  const currentPage = Math.min(
      page,
      Math.max(0, Math.ceil(matched.length / PAGE_SIZE) - 1),
    ),
    visible = matched.slice(
      currentPage * PAGE_SIZE,
      (currentPage + 1) * PAGE_SIZE,
    ),
    currentCellPage = Math.min(
      cellPage,
      Math.max(0, Math.ceil(view.cells.length / PAGE_SIZE) - 1),
    ),
    visibleCells = view.cells.slice(
      currentCellPage * PAGE_SIZE,
      (currentCellPage + 1) * PAGE_SIZE,
    ),
    updating = query !== deferredQuery;
  function clear() {
    setQuery("");
    setFilter("all");
    setPage(0);
    setSelectedId(null);
  }
  const inspect = (row: TrafficCommuteLedgerRow, variant: string) => (
    <button
      type="button"
      className="button traffic-ledger-inspect"
      aria-expanded={selectedId === row.id}
      aria-controls={
        selectedId === row.id ? `${id}-${variant}-${row.id}` : undefined
      }
      aria-label={`Inspect flow record ${row.homeBlockGeoid} to ${row.workBlockGeoid}, ${interval(row.homeBeginSeconds, row.homeEndSeconds)}`}
      onClick={() =>
        setSelectedId((value) => (value === row.id ? null : row.id))
      }
    >
      {selectedId === row.id ? "Close details" : "Inspect"}
    </button>
  );
  return (
    <section className="traffic-ledger" aria-labelledby={`${id}-title`}>
      <div className="traffic-section-heading">
        <div>
          <span className="eyebrow">THE FULL RETAINED ACCOUNT</span>
          <h3 id={`${id}-title`}>Follow the trips</h3>
        </div>
        <span
          className={`traffic-badge${view.coverage.status === "partial" ? " warning" : ""}`}
        >
          {view.coverage.status === "partial"
            ? "Partial cohort"
            : "Declared cohort covered"}
        </span>
      </div>
      <p>
        Follow each source estimate through destination allocation, local
        routing and the simulation window. These are modeled commute quantities;
        source jobs and observed traffic counts are different measures.
      </p>
      <div
        className="traffic-ledger-global"
        aria-label="Unfiltered preparation totals"
      >
        <div className="traffic-ledger-totals-heading">
          <strong>Whole preparation</strong>
          <span>Unaffected by search, filters or pagination</span>
        </div>
        <dl className="traffic-ledger-primary">
          <div>
            <dt>Source estimate</dt>
            <dd>{number(view.totals.sourceVehicles)}</dd>
            <small>
              {view.totals.sourceVehicles === null
                ? `Known subtotal: ${number(view.totals.knownSourceVehicles)}`
                : "Selected home-departure bins"}
            </small>
          </div>
          <div>
            <dt>Admitted expected vehicles</dt>
            <dd>{number(view.totals.admittedExpectedVehicles)}</dd>
            <small>Within the local network and window</small>
          </div>
          <div>
            <dt>Rounded simulation vehicles</dt>
            <dd>{number(view.totals.vehicles)}</dd>
            <small>Rounded once across the complete ledger</small>
          </div>
        </dl>
        <dl className="traffic-ledger-losses">
          {(
            [
              [
                "Known source allocation unresolved",
                view.totals.knownUnresolvedSourceVehicles,
              ],
              ["Route unresolved", view.totals.unresolvedRouteVehicles],
              [
                "Does not cross local network",
                view.totals.noLocalIntersectionVehicles,
              ],
              ["Before local window", view.totals.beforeWindowVehicles],
              ["After local window", view.totals.afterWindowVehicles],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{number(value)}</dd>
            </div>
          ))}
        </dl>
        <p>
          {number(view.rows.length)} flow/bin records · {number(distinctFlows)}{" "}
          distinct source OD pairs. {number(view.coverage.unknownEstimateCells)}{" "}
          source estimate cells unavailable. Missing quantities are never
          treated as zero.
        </p>
      </div>

      <details className="traffic-ledger-source-section">
        <summary>
          Source-cell allocation · {number(view.cells.length)} cells
        </summary>
        <p>
          Original primary jobs supply destination shares. Job totals repeat
          across departure cells and must not be added across bins. Allocated
          and unresolved vehicle estimates belong to each individual ACS cell.
        </p>
        <div
          className="traffic-ledger-scroll"
          role="region"
          aria-label="Source-cell allocation records"
          tabIndex={0}
        >
          <table className="traffic-ledger-table traffic-ledger-desktop">
            <caption>
              Source-cell allocation — original jobs and modeled vehicles
            </caption>
            <thead>
              <tr>
                <th scope="col">Home tract / ACS cell</th>
                <th scope="col">Source estimate</th>
                <th scope="col">Original jobs</th>
                <th scope="col">Modeled vehicles</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {visibleCells.map((cell) => (
                <tr key={`${cell.tractGeoid}:${cell.cellId}`}>
                  <th scope="row">
                    <CellIdentity cell={cell} />
                  </th>
                  <td>
                    {number(cell.estimate.value)}
                    <small>{cell.estimate.status}</small>
                  </td>
                  <td>
                    <dl className="traffic-ledger-inline">
                      <div>
                        <dt>Resident</dt>
                        <dd>{number(cell.residentPrimaryJobs)}</dd>
                      </div>
                      <div>
                        <dt>Known destination</dt>
                        <dd>{number(cell.knownDestinationJobs)}</dd>
                      </div>
                      <div>
                        <dt>Unresolved</dt>
                        <dd>{number(cell.unresolvedDestinationJobs)}</dd>
                      </div>
                    </dl>
                  </td>
                  <td>
                    <dl className="traffic-ledger-inline">
                      <div>
                        <dt>Allocated</dt>
                        <dd>{number(cell.allocatedVehicles)}</dd>
                      </div>
                      <div>
                        <dt>Unresolved</dt>
                        <dd>{number(cell.unresolvedVehicles)}</dd>
                      </div>
                    </dl>
                  </td>
                  <td>
                    <CellEvidence cell={cell} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="traffic-ledger-mobile">
            {visibleCells.map((cell) => (
              <article
                className="traffic-ledger-mobile-card"
                key={`${cell.tractGeoid}:${cell.cellId}`}
              >
                <h5>
                  <CellIdentity cell={cell} />
                </h5>
                <dl className="traffic-ledger-detail-grid">
                  {(
                    [
                      ["Source estimate", cell.estimate.value],
                      ["Resident primary jobs", cell.residentPrimaryJobs],
                      ["Known destination jobs", cell.knownDestinationJobs],
                      [
                        "Unresolved destination jobs",
                        cell.unresolvedDestinationJobs,
                      ],
                      ["Allocated modeled vehicles", cell.allocatedVehicles],
                      ["Unresolved modeled vehicles", cell.unresolvedVehicles],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{number(value)}</dd>
                    </div>
                  ))}
                </dl>
                <CellEvidence cell={cell} />
              </article>
            ))}
          </div>
        </div>
        <Pager
          page={currentCellPage}
          count={view.cells.length}
          kind="source cell"
          onChange={setCellPage}
        />
        <button
          type="button"
          className="button"
          onClick={() => onExport("source-cells")}
        >
          <ArrowDownToLine size={14} aria-hidden="true" />
          Export all source cells · CSV
        </button>
      </details>

      <div className="traffic-section-heading">
        <div>
          <h4>Flow and departure-bin ledger</h4>
          <p>
            Each OD pair may appear in several departure bins. Search changes
            the record view, never the global totals or exported rows.
          </p>
        </div>
      </div>
      <div className="traffic-ledger-filters">
        <label htmlFor={`${id}-search`}>
          Search home or work block
          <span className="traffic-ledger-search">
            <Search size={15} aria-hidden="true" />
            <input
              id={`${id}-search`}
              type="search"
              value={query}
              placeholder="Full or partial GEOID"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
                setSelectedId(null);
              }}
            />
          </span>
        </label>
        <label htmlFor={`${id}-outcome`}>
          Flow outcome
          <select
            id={`${id}-outcome`}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(0);
              setSelectedId(null);
            }}
          >
            {outcomeChoices.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          disabled={!query && filter === "all"}
          onClick={clear}
        >
          Clear filters
        </button>
      </div>
      <p
        role="status"
        className="traffic-ledger-match-count"
        aria-live="polite"
      >
        {updating
          ? "Updating record view…"
          : `${number(matched.length)} matching flow/bin records · ${number(matchedPairs)} distinct source OD pairs. ${matched.length ? `Showing ${currentPage * PAGE_SIZE + 1}–${currentPage * PAGE_SIZE + visible.length}.` : "No records match these filters."}`}
      </p>
      <div
        className="traffic-ledger-scroll"
        role="region"
        aria-label="Flow ledger records"
        tabIndex={0}
        aria-busy={updating}
      >
        <table className="traffic-ledger-table traffic-ledger-flows traffic-ledger-desktop">
          <caption>
            Retained flow/bin records — expected values are fractional; rounded
            vehicles are whole counts
          </caption>
          <thead>
            <tr>
              <th scope="col">Home → work block</th>
              <th scope="col">Home departure bin</th>
              <th scope="col">Outcome</th>
              <th scope="col">Source expected</th>
              <th scope="col">Admitted expected</th>
              <th scope="col">Rounded vehicles</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <Fragment key={row.id}>
                <tr>
                  <th scope="row">
                    <span>{row.homeBlockGeoid}</span>
                    <small>to {row.workBlockGeoid}</small>
                  </th>
                  <td>
                    {interval(row.homeBeginSeconds, row.homeEndSeconds)}
                    <small>{row.cellId}</small>
                  </td>
                  <td>
                    <span
                      className={`traffic-ledger-outcome${row.unresolvedRouteVehicles > 0 ? " unresolved" : ""}`}
                    >
                      {outcome(row)}
                    </span>
                    {row.routeReason && (
                      <small
                        className="traffic-ledger-reason"
                        title={row.routeReason}
                      >
                        {row.routeReason}
                      </small>
                    )}
                  </td>
                  <td
                    className="traffic-ledger-number"
                    title={String(row.expectedVehicles)}
                  >
                    {number(row.expectedVehicles)}
                  </td>
                  <td
                    className="traffic-ledger-number"
                    title={String(row.admittedExpectedVehicles)}
                  >
                    {number(row.admittedExpectedVehicles)}
                  </td>
                  <td className="traffic-ledger-number">
                    {number(row.roundedVehicles)}
                  </td>
                  <td>{inspect(row, "desktop")}</td>
                </tr>
                {selectedId === row.id && (
                  <tr>
                    <td colSpan={7} id={`${id}-desktop-${row.id}`}>
                      <FlowDetails row={row} view={view} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        <div className="traffic-ledger-mobile">
          {visible.map((row) => (
            <article className="traffic-ledger-mobile-card" key={row.id}>
              <dl className="traffic-ledger-pair">
                <div>
                  <dt>Home block</dt>
                  <dd>{row.homeBlockGeoid}</dd>
                </div>
                <div>
                  <dt>Work block</dt>
                  <dd>{row.workBlockGeoid}</dd>
                </div>
              </dl>
              <p>
                {interval(row.homeBeginSeconds, row.homeEndSeconds)} ·{" "}
                {row.cellId}
              </p>
              <span
                className={`traffic-ledger-outcome${row.unresolvedRouteVehicles > 0 ? " unresolved" : ""}`}
              >
                {outcome(row)}
              </span>
              <dl className="traffic-ledger-quantities">
                <div>
                  <dt>Source expected</dt>
                  <dd>{number(row.expectedVehicles)}</dd>
                </div>
                <div>
                  <dt>Admitted expected</dt>
                  <dd>{number(row.admittedExpectedVehicles)}</dd>
                </div>
                <div>
                  <dt>Rounded vehicles</dt>
                  <dd>{number(row.roundedVehicles)}</dd>
                </div>
              </dl>
              {row.routeReason && (
                <p className="traffic-ledger-reason">{row.routeReason}</p>
              )}
              {inspect(row, "mobile")}
              {selectedId === row.id && (
                <div id={`${id}-mobile-${row.id}`}>
                  <FlowDetails row={row} view={view} />
                </div>
              )}
            </article>
          ))}
        </div>
        {!visible.length && (
          <div className="traffic-ledger-empty">
            No retained records match this view. Clear the filters to return to
            the complete ledger.
          </div>
        )}
      </div>
      <Pager
        page={currentPage}
        count={matched.length}
        kind="flow"
        onChange={(next) => {
          setPage(next);
          setSelectedId(null);
        }}
      />
      <div className="traffic-ledger-export">
        <button
          type="button"
          className="button"
          onClick={() => onExport("flows")}
        >
          <ArrowDownToLine size={14} aria-hidden="true" />
          Export all flow records · CSV
        </button>
        <small>
          Includes all {number(view.rows.length)} records, their exact
          quantities, source rows and fingerprints.
        </small>
      </div>
    </section>
  );
}

export function TrafficCommuteLedgerPanel(
  props: TrafficCommuteLedgerPanelProps,
) {
  return <LedgerContents key={props.view.binding.compilationHash} {...props} />;
}
