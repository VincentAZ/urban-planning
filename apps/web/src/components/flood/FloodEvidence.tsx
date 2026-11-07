import { useMemo, useState } from "react";
import {
  materializeBuildings,
  type FloodDataset,
  type Place,
  type Scenario,
} from "@urban/core";
import type {
  FloodBuildingExposure,
  FloodResolution,
  ModelContext,
} from "@urban/models";
import { exportFloodCSV } from "../../lib/flood-export";
import {
  FLOOD_CAVEAT,
  floodColors,
  floodCount,
  floodDates,
  floodLabels,
  floodStatus,
} from "./presentation";
import "./flood.css";
import { FloodMethod } from "./FloodMethod";
export function FloodLegend() {
  return (
    <div className="flood-legend" aria-label="Flood map legend">
      {Object.entries(floodLabels).map(([key, label]) => (
        <span key={key}>
          <i
            style={{
              background: `rgba(${floodColors[key as keyof typeof floodColors].slice(0, 3).join(",")},.7)`,
            }}
          />
          {label}
        </span>
      ))}
      <span>Unmapped or absent coverage is unknown.</span>
    </div>
  );
}
export function FloodPanel({
  scenario,
  resolution,
  onOpen,
}: {
  scenario: Scenario;
  resolution: FloodResolution | null;
  onOpen: () => void;
}) {
  return (
    <section className="flood-panel">
      <span className="eyebrow">CAPTURED FLOOD MAP</span>
      <h3>See where footprints intersect.</h3>
      <p>
        {scenario.flood
          ? resolution
            ? `${floodCount(resolution.scenario)} potential homes in SFHA-intersecting buildings.`
            : "Checking the attached map…"
          : "Attach a retained FEMA map to compare baseline and proposed buildings."}
      </p>
      <button type="button" className="button" onClick={onOpen}>
        {scenario.flood ? "Review flood exposure" : "Explore flood evidence"}
      </button>
    </section>
  );
}
export function FloodBuildingContext({
  row,
  onOpen,
}: {
  row?: FloodBuildingExposure;
  onOpen?: () => void;
}) {
  return (
    <section className="flood-building">
      <h3>Captured flood map</h3>
      <p>
        {row
          ? floodStatus(row)
          : "Exposure is unavailable or still calculating."}
      </p>
      {row && (
        <>
          <p>
            {row.units === null
              ? "Homes unknown"
              : `${row.units.toLocaleString()} homes in this building`}{" "}
            ·{" "}
            {row.intersectionAreaSqm === null
              ? "Intersection area unavailable"
              : `${row.intersectionAreaSqm.toLocaleString(undefined, { maximumFractionDigits: 1 })} m² intersects SFHA`}
          </p>
          {row.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </>
      )}
      {onOpen && (
        <button type="button" className="button compact" onClick={onOpen}>
          Review flood evidence
        </button>
      )}
    </section>
  );
}
export function FloodSources({ dataset }: { dataset: FloodDataset }) {
  return (
    <details className="flood-sources">
      <summary>Source, effective dates & coverage</summary>
      <p>
        Captured {new Date(dataset.capturedAt).toLocaleString()}. A captured
        effective map does not describe future conditions or guarantee complete
        knowledge of flood hazards.
      </p>
      <ul>
        {floodDates(dataset).map((date) => (
          <li key={date}>{date}</li>
        ))}
      </ul>
      <p>
        {dataset.zones.length} retained zones · {dataset.availability.length}{" "}
        availability features · {dataset.panels.length} panels ·{" "}
        {dataset.revisions.length} revisions · {dataset.seclusions.length}{" "}
        seclusions.
      </p>
      {dataset.notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
      {dataset.sources.map((s) => (
        <div key={s.id}>
          <strong>{s.name}</strong>
          <p>
            {s.vintage} · {s.license}
          </p>
          {/^https?:\/\//.test(s.url) && (
            <a href={s.url} target="_blank" rel="noreferrer">
              Original source
            </a>
          )}
        </div>
      ))}
      <details>
        <summary>Exact capture receipts</summary>
        <pre>
          {JSON.stringify(
            {
              studyAreaHash: dataset.studyAreaHash,
              capture: dataset.capture,
              files: dataset.files,
              panelAttributes: dataset.panels.map(({ id, attributes }) => ({
                id,
                attributes,
              })),
              revisionAttributes: dataset.revisions.map(
                ({ id, attributes }) => ({ id, attributes }),
              ),
            },
            null,
            2,
          )}
        </pre>
      </details>
    </details>
  );
}
export function FloodEvidence({
  place,
  scenario,
  dataset,
  resolution,
  calculationError,
  context,
  onSelect,
  onUpdateMethod,
  methodUpdateDisabled,
}: {
  place: Place;
  scenario: Scenario;
  dataset?: FloodDataset;
  resolution: FloodResolution | null;
  calculationError?: string | null;
  context: ModelContext;
  onSelect?: (id: string) => void;
  onUpdateMethod?: () => void;
  methodUpdateDisabled?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [page, setPage] = useState(0);
  const names = useMemo(
    () =>
      new Map(materializeBuildings(place, scenario).map((b) => [b.id, b.name])),
    [place, scenario],
  );
  const all = resolution?.scenario.buildings ?? [];
  const filtered = all.filter(
    (row) =>
      (status === "all" || row.status === status) &&
      `${row.buildingId} ${names.get(row.buildingId) ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 50)),
    currentPage = Math.min(page, pages - 1),
    rows = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  return (
    <section className="flood-evidence" aria-label="Flood exposure evidence">
      <p className="eyebrow">
        {scenario.flood?.origin === "imported"
          ? "IMPORTED EVIDENCE · NOT VERIFIED BY THIS SERVER"
          : "CAPTURED EFFECTIVE MAP"}
      </p>
      <p>{FLOOD_CAVEAT}</p>
      {scenario.flood && (
        <FloodMethod
          reference={scenario.flood}
          onUpdate={onUpdateMethod}
          disabled={methodUpdateDisabled}
        />
      )}
      {!resolution ? (
        calculationError ? (
          <p role="alert">Flood exposure is unavailable: {calculationError}</p>
        ) : (
          <p role="status">Calculating footprint intersections…</p>
        )
      ) : (
        <>
          <div className="flood-totals">
            {(["baseline", "scenario"] as const).map((side) => (
              <div key={side}>
                <span>
                  {side === "baseline" ? "Captured baseline" : "Proposal"} ·
                  potential homes
                </span>
                <strong>{floodCount(resolution[side])}</strong>
                <small>
                  {resolution[side].missingUnitBuildingIds.length}{" "}
                  {resolution[side].missingUnitBuildingIds.length === 1
                    ? "building"
                    : "buildings"}{" "}
                  with unresolved home quantities ·{" "}
                  {resolution[side].unclassifiedBuildingIds.length}{" "}
                  {resolution[side].unclassifiedBuildingIds.length === 1
                    ? "building"
                    : "buildings"}{" "}
                  with undetermined coverage affecting the total
                </small>
              </div>
            ))}
          </div>
          <p>
            <strong>Change in potential exposed homes: </strong>
            {resolution.delta === null
              ? "Unavailable while coverage or home counts remain incomplete"
              : `${resolution.delta > 0 ? "+" : ""}${resolution.delta.toLocaleString()}`}
          </p>
          {resolution.error && <p role="alert">{resolution.error}</p>}
          {resolution.warnings.map((w) => (
            <p className="notice" key={w}>
              {w}
            </p>
          ))}
        </>
      )}
      <FloodLegend />
      {dataset && <FloodSources dataset={dataset} />}
      <div className="flood-table-heading">
        <h3>Every proposed building</h3>
        <button
          type="button"
          className="button compact"
          disabled={!resolution || !dataset}
          onClick={() => {
            if (resolution)
              exportFloodCSV(place, scenario, context, resolution);
          }}
        >
          Download all flood exposure · CSV
        </button>
      </div>
      <div className="flood-filters">
        <label>
          Find a building
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          Footprint screen
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All buildings</option>
            <option value="intersects-sfha">SFHA intersection</option>
            <option value="no-sfha-intersection">
              No mapped SFHA intersection
            </option>
            <option value="undetermined">Undetermined</option>
          </select>
        </label>
      </div>
      <p>
        {filtered.length.toLocaleString()} of {all.length.toLocaleString()}{" "}
        buildings. CSV includes both baseline and proposal, independent of
        filters.
      </p>
      <div className="flood-buildings">
        {rows.map((row) => (
          <article key={row.buildingId}>
            <div>
              {onSelect ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onSelect(row.buildingId)}
                >
                  {names.get(row.buildingId) || row.buildingId}
                </button>
              ) : (
                <strong>{names.get(row.buildingId) || row.buildingId}</strong>
              )}
              <span>{floodStatus(row)}</span>
            </div>
            <dl>
              <div>
                <dt>Building homes</dt>
                <dd>
                  {row.units === null ? "Unknown" : row.units.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Counted exposed homes</dt>
                <dd>
                  {row.exposedUnits === null
                    ? "Unknown"
                    : row.exposedUnits.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>SFHA intersection</dt>
                <dd>
                  {row.intersectionAreaSqm === null
                    ? "Unknown"
                    : `${row.intersectionAreaSqm.toLocaleString(undefined, { maximumFractionDigits: 1 })} m²`}
                </dd>
              </div>
            </dl>
            <details>
              <summary>Zones & method notes</summary>
              <p>
                {row.zoneIds.length
                  ? row.zoneIds.join(", ")
                  : "No classified zone intersection retained."}
              </p>
              {row.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
              <code>{row.buildingId}</code>
            </details>
          </article>
        ))}
      </div>
      {filtered.length === 0 && resolution && (
        <p>No buildings match these filters.</p>
      )}
      <nav className="flood-pagination" aria-label="Flood building pages">
        <button
          type="button"
          className="button compact"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous
        </button>
        <span>
          Page {currentPage + 1} of {pages}
        </span>
        <button
          type="button"
          className="button compact"
          disabled={currentPage + 1 >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next
        </button>
      </nav>
    </section>
  );
}
