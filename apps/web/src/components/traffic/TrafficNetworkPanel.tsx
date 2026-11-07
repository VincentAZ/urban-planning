import { lazy, Suspense, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Place, Scenario, TrafficOverlay } from "@urban/core";
import type {
  TrafficNetwork,
  TrafficCount,
} from "../../../../../packages/core/src/traffic";
import { TrafficNumber, trafficQuality, trafficNumber } from "./TrafficFields";
import {
  TrafficPlanningRoadPanel,
  type TrafficPlanningPreview,
} from "./TrafficPlanningRoadPanel";
import type {
  TrafficPlanningReviewDraft,
  TrafficPlanningSourceDraft,
} from "../../lib/traffic-planning-draft";
import type {
  TrafficSignalDraft,
  TrafficSignalEligibility,
} from "../../lib/traffic-signal-draft";
import { TrafficSignalPanel } from "./TrafficSignalPanel";
const TrafficNetworkMap = lazy(() => import("./TrafficNetworkMap"));
export interface TrafficOverlayDraft {
  edgeId: string;
  closed: boolean;
  lanes: string;
  speedMps: string;
}
export function TrafficNetworkPanel({
  place,
  scenario,
  network,
  counts,
  selectedEdgeId,
  onSelectEdge,
  overlays,
  onOverlaysChange,
  canEdit,
  planningReviews = [],
  onPlanningReviewsChange,
  planningPreview,
  onCheckPlanning,
  mappedOverlays = [],
  planningSourceDeclarations = [],
  onPlanningSourceDeclarationsChange,
  signalDrafts = [],
  onSignalDraftsChange,
  signalEligibility,
}: {
  place: Place;
  scenario?: Scenario;
  network: TrafficNetwork | null;
  counts: readonly TrafficCount[];
  selectedEdgeId: string | null;
  onSelectEdge: (id: string) => void;
  overlays: TrafficOverlayDraft[];
  onOverlaysChange: (value: TrafficOverlayDraft[]) => void;
  canEdit: boolean;
  planningReviews?: TrafficPlanningReviewDraft[];
  onPlanningReviewsChange?: (value: TrafficPlanningReviewDraft[]) => void;
  planningPreview?: TrafficPlanningPreview;
  onCheckPlanning?: () => void;
  mappedOverlays?: TrafficOverlay[];
  planningSourceDeclarations?: TrafficPlanningSourceDraft[];
  onPlanningSourceDeclarationsChange?: (
    value: TrafficPlanningSourceDraft[],
  ) => void;
  signalDrafts?: TrafficSignalDraft[];
  onSignalDraftsChange?: (values: TrafficSignalDraft[]) => void;
  signalEligibility?: TrafficSignalEligibility;
}) {
  const [query, setQuery] = useState(""),
    [limit, setLimit] = useState(40);
  const [view, setView] = useState<"native" | "planning" | "signals">("native");
  const matching = useMemo(
    () =>
      network?.edges.filter((edge) =>
        `${edge.id} ${edge.roadId ?? ""} ${edge.from} ${edge.to}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ) ?? [],
    [network, query],
  );
  if (!network)
    return (
      <div className="traffic-empty">
        <h3>A connected network comes first.</h3>
        <p>
          This project has no prepared traffic graph. Displayed street
          centerlines alone do not establish junctions, permitted turns, or
          traffic outside the study area.
        </p>
        <p>
          Prepare the study area and its recorded external-traffic buffer before
          matching counts or requesting an analysis.
        </p>
      </div>
    );
  const selected = network.edges.find((edge) => edge.id === selectedEdgeId);
  const edit = overlays.find((value) => value.edgeId === selectedEdgeId);
  const mapped = mappedOverlays.find(
    (value) => value.edgeId === selectedEdgeId,
  );
  const movements = network.connections.filter(
    (value) => value.fromEdge === selectedEdgeId,
  );
  function change(patch: Partial<TrafficOverlayDraft>) {
    if (!canEdit || !selected) return;
    onOverlaysChange([
      ...overlays.filter((value) => value.edgeId !== selected.id),
      {
        edgeId: selected.id,
        closed: false,
        lanes: "",
        speedMps: "",
        ...edit,
        ...patch,
      },
    ]);
  }
  return (
    <>
      {(onSignalDraftsChange ||
        (scenario && onPlanningReviewsChange && planningPreview)) && (
        <div
          className="traffic-actions traffic-network-views"
          role="group"
          aria-label="Network review view"
        >
          <button
            type="button"
            className="button"
            aria-pressed={view === "native"}
            onClick={() => setView("native")}
          >
            Native network
          </button>
          {scenario && onPlanningReviewsChange && planningPreview && (
            <button
              type="button"
              className="button"
              aria-pressed={view === "planning"}
              onClick={() => setView("planning")}
            >
              Planning street changes
            </button>
          )}
          {onSignalDraftsChange && (
            <button
              type="button"
              className="button"
              aria-pressed={view === "signals"}
              onClick={() => setView("signals")}
            >
              Signal timing
            </button>
          )}
        </div>
      )}
      {view === "signals" && onSignalDraftsChange ? (
        <TrafficSignalPanel
          place={place}
          network={network}
          counts={counts}
          drafts={signalDrafts}
          onChange={onSignalDraftsChange}
          canEdit={canEdit}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={onSelectEdge}
          eligibility={signalEligibility}
        />
      ) : view === "planning" &&
        scenario &&
        onPlanningReviewsChange &&
        planningPreview &&
        onCheckPlanning ? (
        <TrafficPlanningRoadPanel
          place={place}
          scenario={scenario}
          network={network}
          counts={counts}
          reviews={planningReviews}
          onChange={onPlanningReviewsChange}
          preview={planningPreview}
          onCheck={onCheckPlanning}
          canEdit={canEdit}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={onSelectEdge}
          sourceDeclarations={planningSourceDeclarations}
          onSourceDeclarationsChange={onPlanningSourceDeclarationsChange}
        />
      ) : (
        <>
          <div className="traffic-section-heading">
            <div>
              <span className="eyebrow">NETWORK EVIDENCE</span>
              <h3>One connected place, with room beyond its edges.</h3>
            </div>
            <span className="traffic-badge">
              {network.edges.length.toLocaleString()} directed edges
            </span>
          </div>
          <div className="traffic-stats">
            <div>
              <strong>{network.nodes.length.toLocaleString()}</strong>
              <span>junctions and endpoints</span>
            </div>
            <div>
              <strong>
                {network.nodes.filter((node) => node.external).length}
              </strong>
              <span>recorded external ports</span>
            </div>
            <div>
              <strong>{network.signals.length}</strong>
              <span>signal programs</span>
            </div>
          </div>
          <Suspense fallback={<p role="status">Loading network map…</p>}>
            <TrafficNetworkMap
              place={place}
              network={network}
              counts={counts}
              selectedEdgeId={selectedEdgeId}
              onSelectEdge={onSelectEdge}
            />
          </Suspense>
          <div className="traffic-split">
            <div>
              <label className="traffic-search">
                <Search size={15} />
                <input
                  aria-label="Find a directed street"
                  placeholder="Edge, road or junction ID"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setLimit(40);
                  }}
                />
              </label>
              <div
                className="traffic-network-list"
                aria-label="Directed streets"
              >
                {matching.slice(0, limit).map((edge) => (
                  <button
                    type="button"
                    key={edge.id}
                    aria-pressed={edge.id === selectedEdgeId}
                    onClick={() => onSelectEdge(edge.id)}
                  >
                    <strong>{edge.roadId ?? edge.id}</strong>
                    <span>
                      {edge.from} → {edge.to}
                    </span>
                    <small>
                      {edge.id} · {edge.lanes.length} lanes ·{" "}
                      {trafficQuality[edge.quality]}
                    </small>
                  </button>
                ))}
              </div>
              {!matching.length && <p>No directed edges match that search.</p>}
              {matching.length > limit && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setLimit((value) => value + 40)}
                >
                  Show 40 more directions
                </button>
              )}
            </div>
            <div>
              {selected ? (
                <section className="traffic-card">
                  <h4>{selected.roadId ?? selected.id}</h4>
                  <p>
                    <strong>
                      {selected.from} → {selected.to}
                    </strong>
                  </p>
                  <p className="traffic-muted">
                    Direction is defined by these graph endpoints. A two-way
                    street has separate directed edges.
                  </p>
                  <div className="traffic-table-scroll">
                    <table>
                      <caption>Recorded lanes for {selected.id}</caption>
                      <thead>
                        <tr>
                          <th>Lane</th>
                          <th>Speed</th>
                          <th>Permitted classes</th>
                          <th>Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.lanes.map((lane) => (
                          <tr key={lane.id}>
                            <th>{lane.id}</th>
                            <td>{trafficNumber(lane.speedMps)} m/s</td>
                            <td>
                              {lane.allowedClasses.join(", ") ||
                                "None recorded"}
                            </td>
                            <td>{trafficQuality[lane.quality]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <details>
                    <summary>Outgoing movements ({movements.length})</summary>
                    {movements.length ? (
                      <ul className="traffic-movement-list">
                        {movements.map((movement) => (
                          <li key={movement.id}>
                            <strong>
                              {movement.direction} → {movement.toEdge}
                            </strong>
                            <span>
                              {movement.fromLane} → {movement.toLane}
                            </span>
                            <small>
                              {movement.id} · {trafficQuality[movement.quality]}
                              {movement.signalId
                                ? ` · signal ${movement.signalId}`
                                : ""}
                            </small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        No outgoing movement is recorded. Check whether this is
                        an intentional external sink or an unresolved
                        connection.
                      </p>
                    )}
                  </details>
                  <details className="traffic-source-details">
                    <summary>Junction controls and signal phases</summary>
                    {network.nodes
                      .filter(
                        (node) =>
                          node.id === selected.from || node.id === selected.to,
                      )
                      .map((node) => (
                        <p key={node.id}>
                          {node.id}: {node.type} ·{" "}
                          {trafficQuality[node.quality]}
                          {node.external ? " · external port" : ""}
                        </p>
                      ))}
                    {network.signals
                      .filter(
                        (signal) =>
                          signal.nodeIds.includes(selected.from) ||
                          signal.nodeIds.includes(selected.to),
                      )
                      .map((signal) => (
                        <section key={signal.id}>
                          <h4>
                            {signal.id} · {signal.programId}
                          </h4>
                          <p>
                            {trafficQuality[signal.quality]} · offset{" "}
                            {signal.offsetSeconds}s. Source/inferred timing is
                            not a verified field signal plan.
                          </p>
                          <div className="traffic-table-scroll">
                            <table>
                              <caption>Recorded phase sequence</caption>
                              <thead>
                                <tr>
                                  <th>Phase</th>
                                  <th>Duration (seconds)</th>
                                  <th>Native signal state</th>
                                </tr>
                              </thead>
                              <tbody>
                                {signal.phases.map((phase, index) => (
                                  <tr key={index}>
                                    <th>{index + 1}</th>
                                    <td>{phase.durationSeconds}</td>
                                    <td>
                                      <code>{phase.state}</code>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="traffic-muted">
                            State positions map to these movement groups; a
                            state character can control multiple connections.
                          </p>
                          <ol>
                            {signal.connectionIds.map((ids, index) => (
                              <li key={index}>
                                Index {index}:{" "}
                                {ids.join(", ") || "No connection"}
                              </li>
                            ))}
                          </ol>
                        </section>
                      ))}
                  </details>
                  <fieldset disabled={!canEdit}>
                    <legend>Reviewed traffic overlay</legend>
                    {mapped && (
                      <div className="traffic-warning">
                        <p>
                          Some controls on this edge come from a reviewed
                          planning street. Those properties are read-only here.
                          Unlink the street before replacing them with
                          independent controls.
                        </p>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setView("planning")}
                        >
                          Review planning links
                        </button>
                        <p>
                          {mapped.closed === undefined
                            ? ""
                            : `Mapped closure: ${mapped.closed ? "closed" : "open"}. `}
                          {mapped.lanes === undefined
                            ? ""
                            : `Mapped lanes: ${mapped.lanes}. `}
                          {mapped.speedMps === undefined
                            ? ""
                            : `Mapped speed: ${trafficNumber(mapped.speedMps, 4)} m/s.`}
                        </p>
                      </div>
                    )}
                    <p className="traffic-muted">
                      These changes apply to this directed traffic edge. They do
                      not claim that every drawing edit has been mapped into the
                      prepared graph.
                    </p>
                    <label className="traffic-check">
                      <input
                        type="checkbox"
                        checked={mapped?.closed ?? edit?.closed ?? false}
                        disabled={mapped?.closed !== undefined}
                        onChange={(event) =>
                          change({ closed: event.target.checked })
                        }
                      />
                      <span>Close this direction for the proposal</span>
                    </label>
                    <div className="traffic-field-grid">
                      <TrafficNumber
                        label="Proposed directional lanes"
                        value={
                          mapped?.lanes === undefined
                            ? (edit?.lanes ?? "")
                            : String(mapped.lanes)
                        }
                        disabled={mapped?.lanes !== undefined}
                        onChange={(lanes) => change({ lanes })}
                        hint="Blank retains the recorded graph."
                      />
                      <TrafficNumber
                        label="Proposed speed (m/s)"
                        value={
                          mapped?.speedMps === undefined
                            ? (edit?.speedMps ?? "")
                            : String(mapped.speedMps)
                        }
                        disabled={mapped?.speedMps !== undefined}
                        onChange={(speedMps) => change({ speedMps })}
                        hint="Blank retains recorded lane speeds."
                      />
                    </div>
                    {edit && (
                      <button
                        type="button"
                        className="button"
                        onClick={() =>
                          onOverlaysChange(
                            overlays.filter(
                              (value) => value.edgeId !== selected.id,
                            ),
                          )
                        }
                      >
                        Remove this traffic overlay
                      </button>
                    )}
                  </fieldset>
                </section>
              ) : (
                <div className="traffic-empty">
                  Choose a direction from the map or street list to inspect
                  lanes, movements and proposal settings.
                </div>
              )}
            </div>
          </div>
          <details className="traffic-source-details">
            <summary>
              Network sources and preparation ({network.manifest.sources.length}
              )
            </summary>
            <p>
              SUMO {network.manifest.engine.version} · graph{" "}
              {network.manifest.networkFileSha256}
            </p>
            {network.manifest.sources.map((source) => (
              <div key={source.id}>
                <strong>{source.name}</strong>
                <p>
                  {source.vintage} · {source.license}
                </p>
                {/^https?:\/\//i.test(source.url) && (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    Source citation
                  </a>
                )}
              </div>
            ))}
            <ul>
              {[
                ...network.manifest.notes,
                ...network.manifest.conversion.warnings,
              ].map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </>
  );
}
