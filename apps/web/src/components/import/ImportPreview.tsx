import { lazy, Suspense, useMemo, useState } from "react";
import {
  buildingAreaSqm,
  buildingGeometry,
  landUseLabels,
  parcelAreaSqm,
  type Place,
  type Scenario,
} from "@urban/core";
import type { GisPreview } from "../../../../api/src/gis-jobs-types";
import type { ImportMapFeatures } from "./ImportPreviewMap";
import { download } from "../../lib/api";
const ImportPreviewMap = lazy(() => import("./ImportPreviewMap"));
const show = (value: number | null) =>
  value === null
    ? "Unknown"
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
export function ImportPreview({
  preview,
  place,
  scenario,
}: {
  preview: GisPreview;
  place: Place;
  scenario: Scenario;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [page, setPage] = useState(0),
    [filter, setFilter] = useState("");
  const rows = useMemo(
    () =>
      preview.layer === "buildings"
        ? preview.buildings.map((b) => ({
            id: b.id,
            name: b.name,
            geometry: buildingGeometry(b),
            area: buildingAreaSqm(b),
            reference: b.sourceFeatureId,
            building: b,
          }))
        : preview.parcels.map((p) => ({
            id: p.id,
            name: p.name,
            geometry: p.geometry,
            area: parcelAreaSqm(p),
            reference: p.sourceFeatureId,
            building: null,
          })),
    [preview],
  );
  const filtered = rows.filter((row) =>
      `${row.name} ${row.reference ?? ""} ${row.id}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ),
    pages = Math.max(1, Math.ceil(filtered.length / 50)),
    visiblePage = Math.min(page, pages - 1);
  const detail = rows.find((row) => row.id === selected);
  const features = useMemo(
    (): ImportMapFeatures => ({
      type: "FeatureCollection",
      features: rows.map((row) => ({
        type: "Feature",
        properties: { id: row.id, name: row.name },
        geometry: row.geometry,
      })),
    }),
    [rows],
  );
  const warnings = [
    ...new Set([...preview.warnings, ...preview.diagnostics.warnings]),
  ];
  return (
    <section className="import-section">
      <h3>A clear look before you apply.</h3>
      <p>
        Prepared against revision {preview.expectedRevision}. Nothing in this
        preview has changed the alternative.
      </p>
      <div className="import-stats">
        <div>
          <strong>{preview.changes.added.toLocaleString()}</strong>
          <span>new features</span>
        </div>
        <div>
          <strong>{preview.changes.updated.toLocaleString()}</strong>
          <span>matched updates</span>
        </div>
        <div>
          <strong>
            {preview.diagnostics.excludedFeatures.toLocaleString()}
          </strong>
          <span>explicit exclusions</span>
        </div>
      </div>
      <Suspense
        fallback={<p role="status">Loading the exact geometry preview…</p>}
      >
        <ImportPreviewMap
          place={place}
          scenario={scenario}
          features={features}
          selectedId={selected}
          onSelect={setSelected}
        />
      </Suspense>
      {preview.changes.overlaps.length > 0 && (
        <details className="import-warning" open>
          <summary>
            {preview.changes.overlaps.length.toLocaleString()} existing-feature
            overlaps need review
          </summary>
          <p>
            Overlapping buildings may be intentional, but duplicate imports can
            double-count quantities. Go back and choose matched updates when
            these are replacements.
          </p>
          <ul>
            {preview.changes.overlaps.map((entry, i) => (
              <li key={`${entry.importedId}:${entry.existingId}:${i}`}>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setSelected(entry.importedId)}
                >
                  {entry.name}
                </button>{" "}
                · existing ID <code>{entry.existingId}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <label className="field">
        <span>Find a prepared feature</span>
        <input
          aria-label="Find a prepared feature"
          type="search"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
        />
      </label>
      <div
        className="import-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Prepared feature table"
      >
        <table>
          <caption>
            {filtered.length.toLocaleString()} prepared features · unknown is
            distinct from zero
          </caption>
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Shape / area</th>
              {preview.layer === "buildings" && (
                <>
                  <th scope="col">Use</th>
                  <th scope="col">Height / floors</th>
                  <th scope="col">Homes / jobs</th>
                </>
              )}
              <th scope="col">Source reference</th>
            </tr>
          </thead>
          <tbody>
            {filtered
              .slice(visiblePage * 50, (visiblePage + 1) * 50)
              .map((row) => (
                <tr
                  key={row.id}
                  className={selected === row.id ? "selected" : ""}
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="text-button"
                      aria-pressed={selected === row.id}
                      onClick={() => setSelected(row.id)}
                    >
                      {row.name}
                    </button>
                  </th>
                  <td>
                    {row.geometry.type}
                    <br />
                    {show(row.area)} m²
                  </td>
                  {preview.layer === "buildings" && (
                    <>
                      <td>
                        {row.building ? landUseLabels[row.building.use] : "—"}
                      </td>
                      <td>
                        {row.building
                          ? `${show(row.building.height)}${row.building.height === null ? "" : " m"} / ${show(row.building.floors)}`
                          : "—"}
                      </td>
                      <td>
                        {row.building
                          ? `${show(row.building.units)} / ${show(row.building.jobs)}`
                          : "—"}
                      </td>
                    </>
                  )}
                  <td>{row.reference ?? "Not supplied"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="import-pagination">
        <button
          type="button"
          className="button"
          disabled={visiblePage === 0}
          onClick={() => setPage(visiblePage - 1)}
        >
          Previous features
        </button>
        <span>
          Page {visiblePage + 1} of {pages}
        </span>
        <button
          type="button"
          className="button"
          disabled={visiblePage + 1 >= pages}
          onClick={() => setPage(visiblePage + 1)}
        >
          Next features
        </button>
      </div>
      {detail && (
        <div
          className="import-feature-detail"
          aria-label="Selected prepared feature"
        >
          <h4>{detail.name}</h4>
          <p>
            {detail.geometry.type} · {show(detail.area)} m² ·{" "}
            {detail.geometry.type === "Polygon"
              ? detail.geometry.coordinates.length - 1
              : detail.geometry.coordinates.reduce(
                  (n, p) => n + p.length - 1,
                  0,
                )}{" "}
            holes
          </p>
          {detail.building && (
            <>
              <p>
                Parking supply: {show(detail.building.parkingSpaces)}
                {detail.building.parkingSpaces === null ? "" : " spaces"}.{" "}
                {detail.building.height === null &&
                  "No physical height is inferred; the map will display an outlined footprint."}
              </p>
              <details>
                <summary>Field provenance and typed program</summary>
                <dl>
                  {Object.entries(
                    detail.building.attributeProvenance?.fields ?? {},
                  ).map(([field, evidence]) => (
                    <div key={field}>
                      <dt>{field}</dt>
                      <dd>
                        {evidence?.status} ·{" "}
                        {evidence?.sourceField ??
                          evidence?.method ??
                          evidence?.sourceId}
                        {evidence?.sourceUnit
                          ? ` (${evidence.sourceUnit})`
                          : ""}
                      </dd>
                    </div>
                  ))}
                </dl>
                {detail.building.program && (
                  <pre>{JSON.stringify(detail.building.program, null, 2)}</pre>
                )}
              </details>
            </>
          )}
        </div>
      )}
      {!!warnings.length && (
        <details className="import-warning" open>
          <summary>
            {warnings.length.toLocaleString()} preparation notes
          </summary>
          <ul>
            {warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Exact source and conversion record</summary>
        <dl>
          <dt>Source</dt>
          <dd>
            {preview.source.name} · {preview.source.vintage}
          </dd>
          <dt>License</dt>
          <dd>{preview.source.license}</dd>
          <dt>Preview identity</dt>
          <dd>
            <code>{preview.previewHash}</code>
          </dd>
          <dt>Raw source identity</dt>
          <dd>
            <code>
              {preview.source.import?.upload.sha256 ?? "Not supplied"}
            </code>
          </dd>
          <dt>CRS operation</dt>
          <dd>
            {preview.source.import?.operation.name ??
              "Recorded in the prepared source"}
          </dd>
          <dt>Control residuals (meters)</dt>
          <dd>
            {preview.diagnostics.controlResidualsMeters
              ?.map(show)
              .join(" · ") ?? "Not applicable"}
          </dd>
          <dt>Independent check residuals (meters)</dt>
          <dd>
            {preview.diagnostics.checkpointResidualsMeters
              ?.map(show)
              .join(" · ") || "No independent check points supplied"}
          </dd>
          <dt>Expires</dt>
          <dd>{new Date(preview.expiresAt).toLocaleString()}</dd>
        </dl>
        <button
          type="button"
          className="button"
          onClick={() =>
            download(
              `import-review-${preview.importId}.json`,
              JSON.stringify(
                {
                  identity: "Unapplied import preview",
                  source: preview.source,
                  previewHash: preview.previewHash,
                  changes: preview.changes,
                  diagnostics: preview.diagnostics,
                  warnings,
                },
                null,
                2,
              ),
            )
          }
        >
          Download all review notes
        </button>
      </details>
    </section>
  );
}
