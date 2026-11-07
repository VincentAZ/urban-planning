import { useEffect, useRef, useState } from "react";
import { ArrowRight, FileDown, Route } from "lucide-react";
import {
  TRAFFIC_COMMUTE_DEPARTURE_BINS,
  type Source,
  type TrafficCommuteRecipe,
  type TrafficCommuteSummary,
} from "@urban/core";
import type { TrafficCommuteCompilation } from "@urban/models";
import { download as downloadFile } from "../../lib/api";
import {
  trafficCommuteLedgerCSV,
  type TrafficCommuteLedgerView,
} from "../../lib/traffic-commute-ledger";
import { TrafficCommuteLedgerPanel } from "./TrafficCommuteLedgerPanel";

function CommuteInspection({
  compilationHash,
  busy,
  onInspect,
}: {
  compilationHash: string;
  busy?: boolean;
  onInspect: () => Promise<TrafficCommuteLedgerView>;
}) {
  const [view, setView] = useState<TrafficCommuteLedgerView | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(false);
  const ledgerContainer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (view) ledgerContainer.current?.focus();
  }, [view]);
  async function inspect() {
    if (busy || loading) return;
    setLoading(true);
    setError("");
    try {
      const next = await onInspect();
      if (!mounted.current) return;
      if (next.binding.compilationHash !== compilationHash)
        throw new Error(
          "The inspected ledger belongs to a different preparation. Reopen this review to try again.",
        );
      setView(next);
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "The complete trip ledger could not be inspected.",
        );
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  function exportLedger(kind: "flows" | "source-cells") {
    if (!view) return;
    setError("");
    try {
      downloadFile(
        `commute-${kind}-${compilationHash.slice(0, 12)}.csv`,
        trafficCommuteLedgerCSV(view, kind),
        "text/csv;charset=utf-8",
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The complete trip ledger could not be exported.",
      );
    }
  }
  return (
    <>
      {!view && (
        <div className="traffic-actions">
          <button
            type="button"
            className="button"
            disabled={busy || loading}
            onClick={() => void inspect()}
          >
            <Route size={15} aria-hidden="true" />
            {loading ? "Checking trip accounting…" : "Inspect trip accounting"}
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="traffic-muted">
          Checking the complete retained ledger before showing any records.
        </p>
      )}
      {error && (
        <p role="alert" className="traffic-warning">
          {error}
        </p>
      )}
      {view && (
        <>
          <p role="status" className="traffic-muted">
            Loaded {view.rows.length.toLocaleString("en-US")} complete flow/bin
            records and {view.cells.length.toLocaleString("en-US")} source
            cells.
          </p>
          <div
            ref={ledgerContainer}
            tabIndex={-1}
            role="group"
            aria-label="Complete trip accounting"
          >
            <TrafficCommuteLedgerPanel view={view} onExport={exportLedger} />
          </div>
        </>
      )}
    </>
  );
}

/** A review of an exact retained preparation; selecting it never starts a run. */
export interface TrafficCommuteReview {
  id: string;
  label: string;
  recipe: TrafficCommuteRecipe;
  compilationHash: string;
  sources: Source[];
  coverage: TrafficCommuteCompilation["coverage"];
  totals: TrafficCommuteCompilation["totals"];
  conditionalAcsSampling: TrafficCommuteCompilation["conditionalAcsSampling"];
  notes: string[];
}

const number = (value: number | null, digits = 2) =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const clock = (value: number) =>
  `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}`;

export function TrafficCommuteReadout({
  summary,
}: {
  summary: TrafficCommuteSummary;
}) {
  return (
    <TrafficCommutePanel
      review={{
        ...summary,
        id: summary.binding.presetId,
        label: "Retained source preparation for this captured run",
        compilationHash: summary.binding.compilationHash,
      }}
      selected={false}
      canEdit={false}
      onUse={() => {}}
      onDetach={() => {}}
    />
  );
}

export function TrafficCommutePanel({
  review,
  selected,
  canEdit,
  busy,
  onUse,
  onDetach,
  onDownload,
  onInspect,
}: {
  review: TrafficCommuteReview;
  selected: boolean;
  canEdit: boolean;
  busy?: boolean;
  onUse: () => void;
  onDetach: () => void;
  onDownload?: () => Promise<void>;
  onInspect?: () => Promise<TrafficCommuteLedgerView>;
}) {
  const [downloading, setDownloading] = useState(false),
    [error, setError] = useState("");
  const { totals, coverage, recipe } = review;
  const losses: [string, number][] = [
    [
      "Destination or source allocation unresolved",
      totals.knownUnresolvedSourceVehicles,
    ],
    ["Local route unresolved", totals.unresolvedRouteVehicles],
    ["Route does not cross this network", totals.noLocalIntersectionVehicles],
    ["Enters before the selected window", totals.beforeWindowVehicles],
    ["Enters after the selected window", totals.afterWindowVehicles],
    [
      "Supported within this network and window",
      totals.admittedExpectedVehicles,
    ],
  ];
  const total = totals.knownSourceVehicles;
  const admittedShare =
    total !== null && total > 0
      ? Math.min(100, (totals.admittedExpectedVehicles / total) * 100)
      : null;
  const departures = recipe.departureCellIds.flatMap((id) => {
    const bin = TRAFFIC_COMMUTE_DEPARTURE_BINS.find(
      (value) => value.cellId === id,
    );
    return bin ? [`${clock(bin.beginSeconds)}–${clock(bin.endSeconds)}`] : [];
  });
  async function download() {
    if (!onDownload || downloading) return;
    setDownloading(true);
    setError("");
    try {
      await onDownload();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The retained commute evidence could not be downloaded.",
      );
    } finally {
      setDownloading(false);
    }
  }
  return (
    <section
      className="traffic-card traffic-commute"
      aria-label="Census commute preparation"
    >
      <div className="traffic-section-heading">
        <div>
          <span className="eyebrow">A MORNING, WITH ITS SOURCES</span>
          <h3>Census commute recipe</h3>
          <p>{review.label}</p>
        </div>
        <span
          className={`traffic-badge${coverage.status === "partial" ? " warning" : ""}`}
        >
          {coverage.status === "partial"
            ? "Partial cohort coverage"
            : "Declared cohort covered"}
        </span>
      </div>
      <p>
        Drive-alone departure estimates are distributed using primary-job
        destinations. This is a modeled commute subset. It does not include all
        travel purposes or establish a whole-area traffic forecast.
      </p>
      <dl className="traffic-commute-stats">
        <div>
          <dt>Source estimate</dt>
          <dd>{number(totals.sourceVehicles)}</dd>
          <small>commuters in the selected home-departure bins</small>
        </div>
        <div>
          <dt>Supported local demand</dt>
          <dd>{number(totals.admittedExpectedVehicles)}</dd>
          <small>
            {admittedShare === null
              ? "Share unavailable"
              : `${number(admittedShare, 1)}% of the known source estimate`}
          </small>
        </div>
        <div>
          <dt>Simulation vehicles</dt>
          <dd>{number(totals.vehicles, 0)}</dd>
          <small>one deterministic rounding of supported demand</small>
        </div>
      </dl>
      <div className="traffic-commute-coverage" aria-hidden="true">
        <span style={{ width: `${admittedShare ?? 0}%` }} />
      </div>
      <p className="traffic-muted">
        {number(coverage.routeStatusCounts.routed, 0)} of{" "}
        {number(coverage.selectedNativeFlows, 0)} source origin–destination
        pairs have a supported local path.
        {coverage.unknownEstimateCells > 0 &&
          ` ${number(coverage.unknownEstimateCells, 0)} source cells have unavailable estimates; the full source total is unknown.`}{" "}
        Unresolved trips are retained in the evidence; they are not
        redistributed onto the routes that work.
      </p>
      <details>
        <summary>Where every estimated trip goes</summary>
        <div
          className="traffic-table-scroll"
          tabIndex={0}
          aria-label="Commute conservation table"
        >
          <table>
            <caption>Fractional expected vehicles before rounding</caption>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Expected vehicles</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Known source estimate</th>
                <td>{number(totals.knownSourceVehicles, 6)}</td>
              </tr>
              {losses.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{number(value, 6)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Rounding adjustment on supported demand</th>
                <td>{number(totals.roundingDelta, 6)}</td>
              </tr>
              <tr>
                <th scope="row">Conservation residual before rounding</th>
                <td>{number(totals.conservationResidual, 6)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="traffic-muted">
          Supported demand includes {number(totals.warmupExpectedVehicles)}{" "}
          warm-up and {number(totals.measurementExpectedVehicles)}{" "}
          measurement-window vehicles. Displayed values are rounded; the
          downloadable ledger preserves full precision and every flow/bin
          outcome.
        </p>
      </details>
      <details>
        <summary>Review the recipe and assumptions</summary>
        <dl className="traffic-commute-recipe">
          <div>
            <dt>Origin census tracts</dt>
            <dd>{recipe.originTractGeoids.join(", ")}</dd>
          </div>
          <div>
            <dt>Home departure bins</dt>
            <dd>{departures.join(", ")}</dd>
          </div>
          <div>
            <dt>Simulation clock</dt>
            <dd>
              {recipe.period.date} · {clock(recipe.period.beginSeconds)}–
              {clock(recipe.period.endSeconds)} · {recipe.period.timeZone}
            </dd>
          </div>
          <div>
            <dt>Departure distribution</dt>
            <dd>Uniform within each selected source bin</dd>
          </div>
          <div>
            <dt>Conditional ACS sampling margin</dt>
            <dd>
              {number(review.conditionalAcsSampling.conditionalSamplingMoe)}{" "}
              vehicles
            </dd>
          </div>
        </dl>
        <p>
          The chosen simulation date is not the source observation date. The
          sampling margin covers only the retained ACS sampling calculation; it
          excludes routing, synthetic-source and model uncertainty.
        </p>
        <ul>
          {[
            ...new Set([
              ...recipe.notes,
              ...review.notes,
              ...review.conditionalAcsSampling.notes,
            ]),
          ].map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <h4>Source vintages</h4>
        <ul>
          {review.sources.map((source) => (
            <li key={source.id}>
              <strong>{source.name}</strong> · {source.vintage}
              <br />
              {source.license}
            </li>
          ))}
        </ul>
        <p className="traffic-muted traffic-commute-hash">
          Preparation fingerprint: <code>{review.compilationHash}</code>
        </p>
      </details>
      {selected && (
        <p className="traffic-commute-selected">
          <Route size={16} aria-hidden="true" /> This recipe is attached. Its
          demand and clock stay fixed so the source evidence remains
          reproducible.
        </p>
      )}
      <div className="traffic-actions">
        {canEdit &&
          (selected ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={onDetach}
            >
              Make an editable copy
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={onUse}
            >
              Use this commute recipe{" "}
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          ))}
        {onDownload && (
          <button
            type="button"
            className="button"
            disabled={busy || downloading}
            onClick={() => void download()}
          >
            <FileDown size={15} aria-hidden="true" />
            {downloading ? "Checking evidence…" : "Download complete evidence"}
          </button>
        )}
      </div>
      {selected && canEdit && (
        <p className="traffic-muted">
          An editable copy keeps the trip values and routes, but removes the
          verified recipe association. It becomes an authored traffic
          assumption.
        </p>
      )}
      {error && (
        <p role="alert" className="traffic-warning">
          {error}
        </p>
      )}
      {onInspect && (
        <CommuteInspection
          key={`${review.id}:${review.compilationHash}`}
          compilationHash={review.compilationHash}
          busy={busy}
          onInspect={onInspect}
        />
      )}
    </section>
  );
}
