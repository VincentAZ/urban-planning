import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  trafficPlanningRoadChanges,
  type Place,
  type Scenario,
  type TrafficNetwork,
  type TrafficCount,
  type TrafficPlanningRoadMapping,
  type TrafficPlanningSupportedProperty,
  type Source,
} from "@urban/core";
import {
  movePlanningEdge,
  newPlanningReview,
  planningRoadCandidateIds,
  planningReviewBinding,
  currentPlanningSourceDeclaration,
  updatePlanningSourceDeclaration,
  type TrafficPlanningReviewDraft,
  type TrafficPlanningSourceDraft,
} from "../../lib/traffic-planning-draft";
import { TrafficNumber, trafficNumber } from "./TrafficFields";
const TrafficNetworkMap = lazy(() => import("./TrafficNetworkMap"));

export interface TrafficPlanningPreview {
  mapping: TrafficPlanningRoadMapping | null;
  pending: boolean;
  needsCheck: boolean;
  error: string | null;
}
export function TrafficPlanningRoadPanel({
  place,
  scenario,
  network,
  counts,
  reviews,
  onChange,
  preview,
  onCheck,
  canEdit,
  selectedEdgeId,
  onSelectEdge,
  sourceDeclarations,
  onSourceDeclarationsChange,
}: {
  place: Place;
  scenario: Scenario;
  network: TrafficNetwork;
  counts: readonly TrafficCount[];
  reviews: TrafficPlanningReviewDraft[];
  onChange: (reviews: TrafficPlanningReviewDraft[]) => void;
  preview: TrafficPlanningPreview;
  onCheck: () => void;
  canEdit: boolean;
  selectedEdgeId: string | null;
  onSelectEdge: (id: string) => void;
  sourceDeclarations: TrafficPlanningSourceDraft[];
  onSourceDeclarationsChange?: (value: TrafficPlanningSourceDraft[]) => void;
}) {
  const changes = useMemo(
    () => trafficPlanningRoadChanges(place, scenario),
    [place, scenario],
  );
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null);
  const [direction, setDirection] = useState<"with-road" | "against-road">(
    "with-road",
  );
  const [query, setQuery] = useState("");
  const [onlyCandidates, setOnlyCandidates] = useState(true);
  const [limit, setLimit] = useState(30);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const change =
    changes.find((value) => value.roadId === selectedRoadId) ?? changes[0];
  const draft = reviews.find((value) => value.roadId === change?.roadId);
  const candidateIds = useMemo(
    () => (change ? planningRoadCandidateIds(change, network) : []),
    [change, network],
  );
  const selectedIds = draft?.directions.flatMap((group) => group.edgeIds) ?? [];
  const edgeIndex = useMemo(
    () => new Map(network.edges.map((edge) => [edge.id, edge])),
    [network],
  );
  const edges = useMemo(() => {
    const candidates = new Set(candidateIds),
      term = query.trim().toLowerCase();
    return network.edges.filter(
      (edge) =>
        (!onlyCandidates || !candidates.size || candidates.has(edge.id)) &&
        `${edge.id} ${edge.from} ${edge.to} ${edge.roadId ?? ""} ${edge.sourceWayIds.join(" ")}`
          .toLowerCase()
          .includes(term),
    );
  }, [network, candidateIds, onlyCandidates, query]);
  useEffect(() => {
    setQuery("");
    setOnlyCandidates(true);
    setDirection("with-road");
    setLimit(30);
  }, [change?.roadId]);
  const road = change?.proposal ?? change?.baseline;
  const review = preview.mapping?.reviews.find(
    (value) => value.roadId === change?.roadId,
  );
  const linkConfirmed =
    !!draft?.confirmed &&
    !!preview.mapping &&
    draft.confirmedFor === planningReviewBinding(preview.mapping);
  const hasSupportedChange = change?.properties.some((property) =>
    ["lanes", "speed", "closure"].includes(property),
  );
  const sources = useMemo(() => {
    const ids = new Set(
      changes.flatMap((item) =>
        [item.baseline, item.proposal].flatMap((r) =>
          r
            ? [r.sourceId, r.attributeSourceId, r.geometrySourceId].filter(
                (id): id is string => !!id,
              )
            : [],
        ),
      ),
    );
    return [
      ...new Map(
        [...place.sources, ...(scenario.sources ?? [])]
          .filter((s) => ids.has(s.id))
          .map((s) => [s.id, s]),
      ).values(),
    ];
  }, [changes, place.sources, scenario.sources]);
  function sourcePermission(
    source: Source,
    patch: { privateUseConfirmed?: boolean; publicRedistribution?: boolean },
  ) {
    if (!canEdit || !onSourceDeclarationsChange) return;
    onSourceDeclarationsChange(
      updatePlanningSourceDeclaration(source, sourceDeclarations, patch),
    );
  }
  function update(patch: Partial<TrafficPlanningReviewDraft>) {
    if (!draft || !canEdit) return;
    onChange(
      reviews.map((value) =>
        value.roadId === draft.roadId
          ? { ...value, ...patch, confirmed: false }
          : value,
      ),
    );
  }
  function edgeGroup(ids: string[], groupDirection = direction) {
    if (!draft) return;
    update({
      directions: draft.directions.map((group) =>
        group.direction === groupDirection ? { ...group, edgeIds: ids } : group,
      ),
    });
  }
  function add(id: string) {
    if (!draft || selectedIds.includes(id) || !edgeIndex.has(id)) return;
    const group = draft.directions.find(
      (value) => value.direction === direction,
    );
    if (group) edgeGroup([...group.edgeIds, id]);
  }
  const label = (property: string) =>
    ({
      lanes: "Travel lanes",
      speed: "Speed",
      closure: "Closure",
      removal: "Removed street",
      addition: "New street",
      geometry: "Centerline geometry",
      direction: "One-way direction",
      bikeLane: "Bicycle lane",
      busLane: "Bus lane",
      signal: "Signal",
      cycleSeconds: "Signal cycle",
      greenSplit: "Green split",
      aadt: "Traffic count context",
      kind: "Street type",
      source: "Source metadata",
      name: "Name",
    })[property] ?? property;
  function value(side: "baseline" | "proposal", property: string) {
    const r = change?.[side];
    if (!r) return side === "baseline" ? "Not present" : "Removed";
    if (property === "speed") return `${r.speedMph} mph`;
    if (property === "closure") return r.closed ? "Closed" : "Open";
    if (property === "direction") return r.oneWay ? "One way" : "Two way";
    if (property === "geometry")
      return `${r.coordinates.length} centerline points`;
    if (property === "addition" || property === "removal") return "Present";
    if (property === "source") return r.attributeSourceId ?? r.sourceId;
    const v = r[property as keyof typeof r];
    return typeof v === "boolean"
      ? v
        ? "Yes"
        : "No"
      : v === undefined
        ? "Not recorded"
        : String(v);
  }
  if (!change || !road)
    return (
      <section className="traffic-empty">
        <h3>No planning-street changes to link.</h3>
        <p>
          Change a street in the planning workspace, save the project, then
          review its exact native directions here. Independent native controls
          remain available in Native network.
        </p>
      </section>
    );
  return (
    <section className="traffic-planning-review">
      <div className="traffic-section-heading">
        <div>
          <span className="eyebrow">PLANNING STREETS → NATIVE DIRECTIONS</span>
          <h3>Make the connection explicit.</h3>
        </div>
        <span className="traffic-badge">{changes.length} changed streets</span>
      </div>
      <p className="traffic-muted">
        A centerline is not a connected traffic graph. Review directions and the
        entire affected native extent. Source-way candidates are suggestions
        only; nothing is selected automatically.
      </p>
      <button
        type="button"
        className="button"
        disabled={preview.pending}
        onClick={onCheck}
      >
        Check correspondence
      </button>
      <div
        className="traffic-planning-roads"
        role="group"
        aria-label="Changed planning streets"
      >
        {changes.map((item) => {
          const linked = reviews.find((r) => r.roadId === item.roadId);
          const omitted =
            preview.mapping?.exclusions.filter(
              (e) => e.roadId === item.roadId && e.reason !== "cosmetic",
            ) ?? [];
          const supported = item.properties.some((p) =>
            ["lanes", "speed", "closure"].includes(p),
          );
          const confirmed =
            linked?.confirmed &&
            preview.mapping &&
            linked.confirmedFor === planningReviewBinding(preview.mapping);
          return (
            <button
              type="button"
              key={item.roadId}
              aria-pressed={item.roadId === change.roadId}
              onClick={() => setSelectedRoadId(item.roadId)}
            >
              <strong>
                {(item.proposal ?? item.baseline)?.name ?? item.roadId}
              </strong>
              <span>
                {!item.mappingEligible
                  ? "Unsupported correspondence"
                  : !supported
                    ? item.properties.every((p) =>
                        ["name", "source"].includes(p),
                      )
                      ? "No traffic control change"
                      : "Unsupported control changes"
                    : !linked
                      ? "Not reviewed"
                      : !confirmed
                        ? "Review in progress"
                        : omitted.length
                          ? "Partly represented"
                          : "Reviewed properties"}
              </span>
              <small>{item.roadId}</small>
            </button>
          );
        })}
      </div>
      <div className="traffic-card">
        <h4>{road.name}</h4>
        <dl className="traffic-planning-diff">
          {change.properties.map((property) => (
            <div key={property}>
              <dt>{label(property)}</dt>
              <dd>
                <span>Baseline: {value("baseline", property)}</span>
                <span>Proposal: {value("proposal", property)}</span>
              </dd>
            </div>
          ))}
        </dl>
        {change.blocker && <p className="traffic-warning">{change.blocker}</p>}
        <p className="traffic-muted">
          Geometry, new streets, changed direction, signals and turn controls
          are not created by this review. Unsupported or omitted properties
          remain listed in the captured evidence.
        </p>
      </div>
      <Suspense
        fallback={<p role="status">Loading street correspondence map…</p>}
      >
        <TrafficNetworkMap
          place={place}
          network={network}
          counts={counts}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={onSelectEdge}
          planningChange={change}
          candidateEdgeIds={candidateIds}
          reviewedEdgeIds={selectedIds}
        />
      </Suspense>
      {!hasSupportedChange && (
        <p className="traffic-muted">
          This edit has no supported lane, speed or closure change to link. Its
          context remains in the exclusion ledger; no native controls will be
          invented.
        </p>
      )}
      {!draft ? (
        <button
          type="button"
          className="button primary"
          disabled={!canEdit || !change.mappingEligible || !hasSupportedChange}
          onClick={() => onChange([...reviews, newPlanningReview(change)])}
        >
          Review this street
        </button>
      ) : (
        <>
          <fieldset disabled={!canEdit} className="traffic-card">
            <legend>Properties represented by this link</legend>
            <div className="traffic-check-grid">
              {(
                [
                  "lanes",
                  "speed",
                  "closure",
                ] as TrafficPlanningSupportedProperty[]
              ).map((property) => (
                <label className="traffic-check" key={property}>
                  <input
                    type="checkbox"
                    checked={draft.properties.includes(property)}
                    disabled={
                      !change.properties.includes(property) &&
                      !(property === "closure" && change.proposal === null)
                    }
                    onChange={(e) =>
                      update({
                        properties: e.target.checked
                          ? [...draft.properties, property]
                          : draft.properties.filter((v) => v !== property),
                      })
                    }
                  />
                  <span>{label(property)}</span>
                </label>
              ))}
            </div>
            {change.proposal === null && (
              <label className="traffic-check">
                <input
                  type="checkbox"
                  checked={!!draft.deletionAsClosure}
                  onChange={(e) =>
                    update({ deletionAsClosure: e.target.checked })
                  }
                />
                <span>
                  Represent this removed planning street as a closure of the
                  reviewed native directions. This does not delete or rebuild
                  graph geometry.
                </span>
              </label>
            )}
            <label className="traffic-field">
              <span>Reviewed street extent</span>
              <select
                aria-label="Reviewed street extent"
                value={draft.extent}
                onChange={(e) =>
                  update({
                    extent: e.target
                      .value as TrafficPlanningReviewDraft["extent"],
                  })
                }
              >
                <option value="full-road">Full planning street</option>
                <option value="partial-road">
                  Only part of the planning street
                </option>
              </select>
            </label>
            <label className="traffic-check">
              <input
                type="checkbox"
                checked={draft.nativeExtensionAcknowledged}
                onChange={(e) =>
                  update({ nativeExtensionAcknowledged: e.target.checked })
                }
              />
              <span>
                I reviewed the full native edge extent, including any
                continuation beyond this planning segment. Controls affect
                entire selected native edges.
              </span>
            </label>
            <label className="traffic-field">
              <span>Correspondence rationale</span>
              <textarea
                aria-label="Correspondence rationale"
                value={draft.rationale}
                maxLength={2000}
                rows={3}
                onChange={(e) => update({ rationale: e.target.value })}
                placeholder="Explain the direction, source evidence and extent reviewed."
              />
            </label>
          </fieldset>
          <div className="traffic-split">
            <section className="traffic-card">
              <h4>Select exact native directions</h4>
              <label className="traffic-field">
                <span>Add edges to direction</span>
                <select
                  aria-label="Add edges to direction"
                  value={direction}
                  onChange={(e) =>
                    setDirection(e.target.value as typeof direction)
                  }
                >
                  {draft.directions.map((group) => (
                    <option key={group.direction} value={group.direction}>
                      {group.direction === "with-road"
                        ? "With centerline coordinate order"
                        : "Against centerline coordinate order"}
                    </option>
                  ))}
                </select>
              </label>
              <p className="traffic-muted">
                The map's start and end labels define centerline order. Native
                arrows use their actual from → to direction. Add serial edges in
                travel order, not parallel alternatives.
              </p>
              {selectedEdgeId && (
                <button
                  type="button"
                  className="button"
                  disabled={!canEdit || selectedIds.includes(selectedEdgeId)}
                  onClick={() => add(selectedEdgeId)}
                >
                  Add selected edge {selectedEdgeId}
                </button>
              )}
              <label className="traffic-field">
                <span>Find a native edge</span>
                <input
                  aria-label="Find a native edge"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setLimit(30);
                  }}
                  placeholder="Exact edge, source way or junction ID"
                />
              </label>
              {!!candidateIds.length && (
                <label className="traffic-check">
                  <input
                    type="checkbox"
                    checked={onlyCandidates}
                    onChange={(e) => {
                      setOnlyCandidates(e.target.checked);
                      setLimit(30);
                    }}
                  />
                  <span>
                    Show source-way candidates ({candidateIds.length}); still
                    requires review
                  </span>
                </label>
              )}
              {!candidateIds.length && (
                <p className="traffic-muted">
                  No exact source-way candidate is recorded. Search the full
                  graph and inspect the geometry; proximity alone is not proof.
                </p>
              )}
              <ul className="traffic-edge-choices">
                {edges.slice(0, limit).map((edge) => (
                  <li key={edge.id}>
                    <button
                      type="button"
                      className="traffic-edge-inspect"
                      aria-pressed={selectedEdgeId === edge.id}
                      onClick={() => onSelectEdge(edge.id)}
                    >
                      <strong>{edge.id}</strong>
                      <span>
                        {edge.from} → {edge.to}
                      </span>
                      <small>
                        {edge.lanes.length} native lanes ·{" "}
                        {edge.lanes
                          .map((lane) => trafficNumber(lane.speedMps))
                          .join(" / ")}{" "}
                        m/s
                      </small>
                    </button>
                    <button
                      type="button"
                      className="button small"
                      aria-label={`Add edge ${edge.id} to ${direction}`}
                      disabled={!canEdit || selectedIds.includes(edge.id)}
                      onClick={() => add(edge.id)}
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
              {!edges.length && <p>No native edges match this filter.</p>}
              {edges.length > limit && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setLimit((n) => n + 30)}
                >
                  Show 30 more edges
                </button>
              )}
            </section>
            <section className="traffic-card">
              <h4>Reviewed directional chains</h4>
              <p className="traffic-muted">
                Planning total: {road.lanes} travel lanes. Allocate it
                explicitly between directions; serial edges do not multiply that
                total. No automatic split is assumed.
              </p>
              {draft.directions.map((group) => (
                <fieldset disabled={!canEdit} key={group.direction}>
                  <legend>
                    {group.direction === "with-road"
                      ? "With centerline order"
                      : "Against centerline order"}
                  </legend>
                  {draft.properties.includes("lanes") && (
                    <TrafficNumber
                      label={`${group.direction === "with-road" ? "With" : "Against"} direction lanes`}
                      value={group.lanes}
                      onChange={(lanes) =>
                        update({
                          directions: draft.directions.map((g) =>
                            g.direction === group.direction
                              ? { ...g, lanes }
                              : g,
                          ),
                        })
                      }
                      hint="One reviewed count for this direction, applied to each serial edge."
                    />
                  )}
                  <ol className="traffic-edge-chain">
                    {group.edgeIds.map((id, index) => (
                      <li key={id}>
                        <strong>{id}</strong>
                        <small>
                          {edgeIndex.get(id)?.from} → {edgeIndex.get(id)?.to}
                        </small>
                        <div className="traffic-actions">
                          <button
                            type="button"
                            className="button small"
                            disabled={index === 0}
                            aria-label={`Move ${id} earlier in ${group.direction}`}
                            onClick={() =>
                              edgeGroup(
                                movePlanningEdge(group.edgeIds, index, -1),
                                group.direction,
                              )
                            }
                          >
                            Earlier
                          </button>
                          <button
                            type="button"
                            className="button small"
                            disabled={index === group.edgeIds.length - 1}
                            aria-label={`Move ${id} later in ${group.direction}`}
                            onClick={() =>
                              edgeGroup(
                                movePlanningEdge(group.edgeIds, index, 1),
                                group.direction,
                              )
                            }
                          >
                            Later
                          </button>
                          <button
                            type="button"
                            className="button small"
                            aria-label={`Remove ${id} from ${group.direction}`}
                            onClick={() =>
                              edgeGroup(
                                group.edgeIds.filter((v) => v !== id),
                                group.direction,
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {!group.edgeIds.length && <p>No direction selected.</p>}
                </fieldset>
              ))}
            </section>
          </div>
          <section className="traffic-card">
            <h4>Native control preview</h4>
            {preview.needsCheck && (
              <p role="status">
                Inputs changed. Check correspondence to refresh the exact
                control preview; earlier confirmation does not cover new inputs.
              </p>
            )}
            {preview.pending ? (
              <p role="status">
                Checking exact road and network correspondence…
              </p>
            ) : preview.error ? (
              <p role="alert" className="traffic-error">
                {preview.error}
              </p>
            ) : review ? (
              <>
                <ul className="traffic-control-preview">
                  {review.overlays.map((overlay) => (
                    <li key={overlay.edgeId}>
                      <strong>{overlay.edgeId}</strong>
                      <span>
                        {overlay.closed !== undefined
                          ? overlay.closed
                            ? "Closed"
                            : "Open"
                          : "Closure unchanged"}{" "}
                        ·{" "}
                        {overlay.lanes === undefined
                          ? "Lanes unchanged"
                          : `${overlay.lanes} directional lanes`}{" "}
                        ·{" "}
                        {overlay.speedMps === undefined
                          ? "Speed unchanged"
                          : `${trafficNumber(overlay.speedMps, 4)} m/s`}
                      </span>
                    </li>
                  ))}
                </ul>
                {review.notes.map((note, index) => (
                  <p className="traffic-muted" key={index}>
                    {note}
                  </p>
                ))}
                <p className="traffic-muted">
                  Preview only. The server records the reviewer and timestamp
                  when you save the configuration. Controls linked here are
                  read-only in Native network; unlink before editing them
                  independently.
                </p>
              </>
            ) : (
              <p>Select properties and directions to review their controls.</p>
            )}
            <div className="traffic-actions">
              <button
                type="button"
                className="button primary"
                disabled={
                  !canEdit ||
                  preview.pending ||
                  !!preview.error ||
                  !review ||
                  linkConfirmed
                }
                onClick={() =>
                  onChange(
                    reviews.map((r) =>
                      r.roadId === draft.roadId && preview.mapping
                        ? {
                            ...r,
                            confirmed: true,
                            confirmedFor: planningReviewBinding(
                              preview.mapping,
                            ),
                          }
                        : r,
                    ),
                  )
                }
              >
                {linkConfirmed
                  ? "Link confirmed in draft"
                  : "Confirm reviewed link"}
              </button>
              <button
                type="button"
                className="button"
                disabled={!canEdit}
                onClick={() =>
                  onChange(reviews.filter((r) => r.roadId !== draft.roadId))
                }
              >
                Unlink this street
              </button>
            </div>
          </section>
        </>
      )}
      <TrafficPlanningCoverage mapping={preview.mapping} />
      <details
        className="traffic-card"
        open={sourcesOpen}
        onToggle={(event) => setSourcesOpen(event.currentTarget.open)}
      >
        <summary>Planning source permissions ({sources.length})</summary>
        <p className="traffic-muted">
          These are the original citations for changed planning streets,
          including omitted properties. They remain separate from native-network
          and count sources. Permissions are your declarations, not independent
          license verification.
        </p>
        {sources.map((source) => {
          const declaration = currentPlanningSourceDeclaration(
            source,
            sourceDeclarations,
          );
          const stale =
            !declaration &&
            sourceDeclarations.some((d) => d.sourceId === source.id);
          return (
            <section className="traffic-planning-source" key={source.id}>
              <h4>{source.name}</h4>
              <p>
                {source.vintage} · {source.license} · {source.id}
              </p>
              {/^https?:\/\//i.test(source.url) && (
                <a href={source.url} target="_blank" rel="noreferrer">
                  Original planning citation
                </a>
              )}
              {stale && (
                <p className="traffic-warning">
                  This source citation changed. Review its current terms and
                  confirm permissions again; earlier declarations apply only to
                  the earlier citation.
                </p>
              )}
              <fieldset disabled={!canEdit || !onSourceDeclarationsChange}>
                <label className="traffic-check">
                  <input
                    type="checkbox"
                    checked={declaration?.privateUseConfirmed ?? false}
                    onChange={(e) =>
                      sourcePermission(source, {
                        privateUseConfirmed: e.target.checked,
                      })
                    }
                  />
                  <span>
                    I have permission to process and retain {source.name}{" "}
                    privately for this traffic review.
                  </span>
                </label>
                <label className="traffic-check">
                  <input
                    type="checkbox"
                    checked={declaration?.publicRedistribution ?? false}
                    onChange={(e) =>
                      sourcePermission(source, {
                        publicRedistribution: e.target.checked,
                      })
                    }
                  />
                  <span>
                    This source permits public redistribution of its input
                    values and attribution in snapshots and downloads:{" "}
                    {source.name}.
                  </span>
                </label>
              </fieldset>
            </section>
          );
        })}
      </details>
    </section>
  );
}

export function TrafficPlanningCoverage({
  mapping,
}: {
  mapping?: TrafficPlanningRoadMapping | null;
}) {
  if (!mapping) return null;
  const omitted = mapping.exclusions.filter(
    (entry) => entry.reason !== "cosmetic",
  );
  return (
    <details className="traffic-card traffic-planning-coverage">
      <summary>
        Planning correspondence and omitted changes ({omitted.length})
      </summary>
      <p>
        {mapping.reviews.length} reviewed street links. This is property-level
        correspondence, not proof that all planning changes were simulated.
      </p>
      <ul>
        {mapping.reviews.map((review) => (
          <li key={review.roadId}>
            <strong>{review.roadId}</strong>: {review.properties.join(", ")} ·{" "}
            {review.extent === "full-road"
              ? "full street declared"
              : "partial street"}
            <p>{review.rationale}</p>
            <ul>
              {review.directions.map((direction) => (
                <li key={direction.direction}>
                  {direction.direction}: {direction.edgeIds.join(" → ")}
                  {direction.lanes === undefined
                    ? ""
                    : ` · ${direction.lanes} lanes per serial edge`}
                </li>
              ))}
            </ul>
            {review.nativeExtensionAcknowledged && (
              <p>
                Full native edge effects beyond the planning segment were
                acknowledged.
              </p>
            )}
          </li>
        ))}
      </ul>
      {mapping.exclusions.length ? (
        <ul>
          {mapping.exclusions.map((entry, index) => (
            <li key={`${entry.roadId}:${entry.property}:${index}`}>
              <strong>
                {entry.roadId} · {entry.property}
              </strong>{" "}
              — {entry.detail}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No additional changed properties are listed as omitted. Native
          assumptions and demand limitations still apply.
        </p>
      )}
    </details>
  );
}

export function TrafficPlanningSources({
  mapping,
}: {
  mapping?: TrafficPlanningRoadMapping;
}) {
  if (!mapping?.sources.length) return null;
  return (
    <details className="traffic-source-details">
      <summary>Planning-road sources ({mapping.sources.length})</summary>
      <p>
        Original planning citations and their separate permission declarations.
        These IDs are not merged with native-network or count sources.
      </p>
      {mapping.sources.map((source) => (
        <section key={source.id}>
          <h4>{source.name}</h4>
          <p>
            {source.id} · {source.vintage} · {source.license}
          </p>
          {source.description && <p>{source.description}</p>}
          {/^https?:\/\//i.test(source.url) && (
            <a href={source.url} target="_blank" rel="noreferrer">
              Original source citation
            </a>
          )}
          <p>
            {mapping.sourceDeclarations.find((d) => d.sourceId === source.id)
              ?.publicRedistribution
              ? "Public redistribution declared by the reviewer."
              : "No public redistribution declaration retained."}{" "}
            Permission declarations are not independent license verification.
          </p>
        </section>
      ))}
    </details>
  );
}
