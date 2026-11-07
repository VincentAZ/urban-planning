import { Plus, Trash2 } from "lucide-react";
import type { GisInspection } from "../../../../api/src/gis-types";
import {
  newControlPoint,
  sourceLayer,
  excludedImportEntities,
  type ImportControlPoint,
  type SpatialDraft,
} from "./spatial-draft";

function ControlPoints({
  points,
  onChange,
  check = false,
}: {
  points: ImportControlPoint[];
  onChange: (points: ImportControlPoint[]) => void;
  check?: boolean;
}) {
  const label = check ? "Check point" : "Control";
  return (
    <fieldset className="import-controls">
      <legend>
        {check ? "Independent check points (optional)" : "Known control points"}
      </legend>
      {points.map((p, index) => (
        <div className="import-control-row" key={p.id}>
          <strong>
            {label} {index + 1}
          </strong>
          {(
            [
              ["x", "Source X"],
              ["y", "Source Y"],
              ["longitude", "Longitude"],
              ["latitude", "Latitude"],
            ] as const
          ).map(([key, text]) => (
            <label className="field" key={key}>
              <span>{text}</span>
              <input
                aria-label={`${label} ${index + 1} ${text}`}
                inputMode="decimal"
                value={p[key]}
                onChange={(event) =>
                  onChange(
                    points.map((item) =>
                      item.id === p.id
                        ? { ...item, [key]: event.target.value }
                        : item,
                    ),
                  )
                }
              />
            </label>
          ))}
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            disabled={!check && points.length <= 2}
            onClick={() => onChange(points.filter((item) => item.id !== p.id))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button"
        disabled={points.length >= 20}
        onClick={() => onChange([...points, newControlPoint()])}
      >
        <Plus size={14} /> Add {label.toLowerCase()}
      </button>
    </fieldset>
  );
}
export function ImportSpatialStep({
  inspection,
  value,
  onChange,
}: {
  inspection: GisInspection;
  value: SpatialDraft;
  onChange: (value: SpatialDraft) => void;
}) {
  const layer = sourceLayer(inspection, value);
  const exclusions = excludedImportEntities(inspection, value.layerId);
  const patch = (change: Partial<SpatialDraft>) =>
    onChange({ ...value, ...change });
  return (
    <section className="import-section">
      <h3>Put this layer in the right place.</h3>
      <p>
        Choose the exact source layer and its coordinate reference. Conversion
        retains complete polygons, holes and separate parts.
      </p>
      <label className="field">
        <span>Source layer</span>
        <select
          aria-label="Source layer"
          value={value.layerId}
          onChange={(event) =>
            patch({
              layerId: event.target.value,
              acknowledgeExcluded: false,
              flattenZ: false,
            })
          }
        >
          {inspection.layers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.featureCount.toLocaleString()} entities
            </option>
          ))}
        </select>
      </label>
      {layer && (
        <>
          <div className="import-stats">
            <div>
              <strong>{layer.supportedFootprints.toLocaleString()}</strong>
              <span>supported footprints</span>
            </div>
            <div>
              <strong>{layer.unsupportedEntities.toLocaleString()}</strong>
              <span>unsupported entities</span>
            </div>
            <div>
              <strong>{layer.fields.length}</strong>
              <span>attribute fields</span>
            </div>
          </div>
          <details>
            <summary>Layer inventory and recorded spatial reference</summary>
            <dl>
              <dt>Geometry types</dt>
              <dd>
                {Object.entries(layer.geometryTypes)
                  .map(([name, count]) => `${name}: ${count}`)
                  .join(" · ") || "Not reported"}
              </dd>
              <dt>Entity types</dt>
              <dd>
                {Object.entries(layer.entityTypes)
                  .map(([name, count]) => `${name}: ${count}`)
                  .join(" · ") || "Not applicable"}
              </dd>
              <dt>Recorded CRS</dt>
              <dd>
                {layer.crs?.authority ?? layer.crs?.wkt ?? "Not supplied"}
              </dd>
              <dt>Recorded units</dt>
              <dd>{layer.crs?.unit ?? "Not supplied"}</dd>
              <dt>Source bounds</dt>
              <dd>{layer.bounds?.join(", ") ?? "Not reported"}</dd>
            </dl>
          </details>
        </>
      )}
      <label className="field">
        <span>Coordinate reference</span>
        <select
          aria-label="Coordinate reference"
          value={value.reference}
          onChange={(event) =>
            patch({
              reference: event.target.value as SpatialDraft["reference"],
            })
          }
        >
          <option value="file">Use the file’s recorded CRS</option>
          <option value="epsg">Specify the source EPSG code</option>
          {inspection.format === "dxf" && (
            <option value="local">
              Georeference a local drawing with known points
            </option>
          )}
        </select>
      </label>
      {value.reference === "epsg" && (
        <label className="field">
          <span>Source EPSG code</span>
          <input
            aria-label="Source EPSG code"
            inputMode="numeric"
            value={value.epsg}
            placeholder="For example, 26912"
            onChange={(event) => patch({ epsg: event.target.value })}
          />
          <small>
            Use the CRS in which the original coordinates were created, not the
            desired display CRS.
          </small>
        </label>
      )}
      {inspection.format === "geojson" && (
        <p className="import-help">
          Standard GeoJSON uses WGS84 longitude, latitude in decimal degrees. A
          nonstandard source must be declared explicitly.
        </p>
      )}
      {inspection.format === "shapefile" && (
        <label className="field">
          <span>Attribute text encoding</span>
          <select
            aria-label="Attribute text encoding"
            value={value.encoding}
            onChange={(event) =>
              patch({
                encoding: event.target.value as SpatialDraft["encoding"],
              })
            }
          >
            <option value="">Use recorded encoding</option>
            {["UTF-8", "CP1252", "ISO-8859-1", "CP437", "CP850"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
      {inspection.format === "dxf" && (
        <>
          <div className="field-grid">
            <label className="field">
              <span>Drawing units</span>
              <select
                aria-label="Drawing units"
                value={value.units}
                onChange={(event) =>
                  patch({ units: event.target.value as SpatialDraft["units"] })
                }
              >
                <option value="">Choose known units</option>
                {[
                  "meters",
                  "feet",
                  "us-survey-feet",
                  "millimeters",
                  "centimeters",
                  "inches",
                ].map((unit) => (
                  <option key={unit}>{unit}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Curve tolerance (meters)</span>
              <input
                aria-label="Curve tolerance (meters)"
                inputMode="decimal"
                value={value.tolerance}
                onChange={(event) => patch({ tolerance: event.target.value })}
              />
            </label>
          </div>
          <p className="import-help">
            Curves become bounded polygon segments using this retained
            tolerance. Unsupported open lines are not guessed into footprints.
          </p>
        </>
      )}
      {value.reference === "local" && (
        <>
          <p className="notice">
            Two points determine a translation, rotation and uniform scale. They
            do not independently prove accuracy. Add separate check points to
            evaluate placement, and review the resulting residuals before Apply.
          </p>
          <ControlPoints
            points={value.controls}
            onChange={(controls) => patch({ controls })}
          />
          <ControlPoints
            points={value.checkpoints}
            check
            onChange={(checkpoints) => patch({ checkpoints })}
          />
          <label className="field">
            <span>Maximum allowed residual (meters)</span>
            <input
              aria-label="Maximum allowed residual (meters)"
              inputMode="decimal"
              value={value.maximumResidual}
              onChange={(event) =>
                patch({ maximumResidual: event.target.value })
              }
            />
          </label>
        </>
      )}
      {!!layer?.hasZ && (
        <label className="import-check">
          <input
            type="checkbox"
            checked={value.flattenZ}
            onChange={(event) => patch({ flattenZ: event.target.checked })}
          />
          <span>
            Flatten Z coordinates to 2D footprints. Z is not interpreted as
            building height.
          </span>
        </label>
      )}
      {exclusions.total > 0 && (
        <label className="import-check">
          <input
            type="checkbox"
            checked={value.acknowledgeExcluded}
            onChange={(event) =>
              patch({ acknowledgeExcluded: event.target.checked })
            }
          />
          <span>
            I reviewed the {exclusions.total.toLocaleString()} excluded
            entities: {exclusions.unsupported.toLocaleString()} unsupported in
            the selected layer and {exclusions.unselected.toLocaleString()} in
            unselected layers. Exclude them and retain their counts in
            provenance.
          </span>
        </label>
      )}
    </section>
  );
}
