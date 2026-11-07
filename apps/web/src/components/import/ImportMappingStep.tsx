import { Plus, Trash2 } from "lucide-react";
import {
  landUseLabels,
  type BuildingQuantityField,
  type LandUse,
  type Source,
} from "@urban/core";
import type { GisLayer } from "../../../../api/src/gis-types";
import { quantityLabels, type MappingDraft } from "./mapping-draft";

function FieldSelect({
  label,
  value,
  layer,
  onChange,
  optional = false,
}: {
  label: string;
  value: string;
  layer: GisLayer;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {optional ? "Not supplied" : "Choose a source field"}
        </option>
        <option value="$featureId">Feature ID</option>
        {layer.fields
          .filter((field) => field.name !== "$featureId")
          .map((field) => (
            <option value={field.name} key={field.name}>
              {field.name} · {field.type}
            </option>
          ))}
      </select>
      {value && (
        <small>
          Samples:{" "}
          {layer.fields
            .find((field) => field.name === value)
            ?.samples.map((sample) =>
              sample === null ? "Unknown" : String(sample),
            )
            .join(" · ") || "No sample values"}
        </small>
      )}
    </label>
  );
}
export function ImportMappingStep({
  layer,
  value,
  sources,
  onChange,
}: {
  layer: GisLayer;
  value: MappingDraft;
  sources: Source[];
  onChange: (value: MappingDraft) => void;
}) {
  const patch = (change: Partial<MappingDraft>) =>
    onChange({ ...value, ...change });
  return (
    <section className="import-section">
      <h3>Give the geometry meaning.</h3>
      <p>
        Map source columns deliberately. Unknown quantities stay unknown; a
        reviewed constant is recorded as your assumption, including a genuine
        zero.
      </p>
      <fieldset className="import-target">
        <legend>How should these features change the alternative?</legend>
        <label className="import-check">
          <input
            type="radio"
            name="import-target"
            checked={value.targetMode === "append"}
            onChange={() => patch({ targetMode: "append" })}
          />
          <span>
            <strong>Add new features</strong>
            <small>
              Existing features remain. Review overlap diagnostics to avoid
              counting duplicate buildings.
            </small>
          </span>
        </label>
        <label className="import-check">
          <input
            type="radio"
            name="import-target"
            checked={value.targetMode === "match"}
            onChange={() => patch({ targetMode: "match" })}
          />
          <span>
            <strong>Update matched features</strong>
            <small>
              Every imported feature must match exactly one existing feature.
              Ambiguous or unmatched rows block Apply. Geometry and reviewed
              quantity/use mappings replace the matched feature. Unmapped
              quantities become Unknown. Existing typed programs and typology
              are removed unless explicitly mapped; the preview lists these
              removals. Unmapped address, parcel link and recorded zoning,
              limits, rent and assessment context are retained. Undo restores
              the complete prior feature.
            </small>
          </span>
        </label>
        {value.targetMode === "match" && (
          <>
            <label className="field">
              <span>Match existing features by</span>
              <select
                aria-label="Match existing features by"
                value={value.matchBy}
                onChange={(event) =>
                  patch({
                    matchBy: event.target.value as MappingDraft["matchBy"],
                  })
                }
              >
                <option value="id">Urban Planning feature ID</option>
                <option value="sourceFeatureId">
                  Original source reference
                </option>
              </select>
            </label>
            <FieldSelect
              label="Matching source field"
              value={value.matchField}
              layer={layer}
              onChange={(matchField) => patch({ matchField })}
            />
            {value.matchBy === "sourceFeatureId" && (
              <label className="field">
                <span>Existing source namespace</span>
                <select
                  aria-label="Existing source namespace"
                  value={value.sourceId}
                  onChange={(event) => patch({ sourceId: event.target.value })}
                >
                  <option value="">
                    Choose the source of existing features
                  </option>
                  {sources.map((source) => (
                    <option value={source.id} key={source.id}>
                      {source.name} · {source.vintage}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
      </fieldset>
      <div className="field-grid">
        <label className="field">
          <span>Feature names</span>
          <select
            aria-label="Feature names"
            value={value.nameMode}
            onChange={(event) =>
              patch({
                nameMode: event.target.value as MappingDraft["nameMode"],
              })
            }
          >
            <option value="default">Generate feature labels</option>
            <option value="field">Use a source field</option>
            <option value="constant">Use a reviewed name</option>
          </select>
        </label>
        {value.nameMode === "field" && (
          <FieldSelect
            label="Name source field"
            value={value.nameField}
            layer={layer}
            onChange={(nameField) => patch({ nameField })}
          />
        )}
        {value.nameMode === "constant" && (
          <label className="field">
            <span>Reviewed feature name</span>
            <input
              aria-label="Reviewed feature name"
              value={value.nameConstant}
              maxLength={240}
              onChange={(event) => patch({ nameConstant: event.target.value })}
            />
          </label>
        )}
        <FieldSelect
          label="Original source reference field"
          optional
          value={value.referenceField}
          layer={layer}
          onChange={(referenceField) => patch({ referenceField })}
        />
      </div>
      {value.layer === "buildings" && (
        <>
          <div className="field-grid">
            <label className="field">
              <span>Land-use mapping</span>
              <select
                aria-label="Land-use mapping"
                value={value.useMode}
                onChange={(event) =>
                  patch({
                    useMode: event.target.value as MappingDraft["useMode"],
                  })
                }
              >
                <option value="constant">Apply one reviewed use</option>
                <option value="field">Map source land-use values</option>
              </select>
            </label>
            {value.useMode === "constant" ? (
              <label className="field">
                <span>Reviewed building use</span>
                <select
                  aria-label="Reviewed building use"
                  value={value.use}
                  onChange={(event) =>
                    patch({ use: event.target.value as LandUse })
                  }
                >
                  <option value="">Choose a reviewed use</option>
                  {Object.entries(landUseLabels).map(([use, label]) => (
                    <option key={use} value={use}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <FieldSelect
                label="Land-use source field"
                value={value.useField}
                layer={layer}
                onChange={(useField) =>
                  patch({
                    useField,
                    useValues: [
                      ...new Set(
                        layer.fields
                          .find((field) => field.name === useField)
                          ?.samples.filter((sample) => sample !== null)
                          .map(String) ?? [],
                      ),
                    ].map((raw) => ({ id: crypto.randomUUID(), raw, use: "" })),
                  })
                }
              />
            )}
          </div>
          {value.useMode === "field" && (
            <div className="import-use-values">
              {value.useValues.map((entry, i) => (
                <div className="field-grid" key={entry.id}>
                  <label className="field">
                    <span>Source value {i + 1}</span>
                    <input
                      aria-label={`Source land-use value ${i + 1}`}
                      value={entry.raw}
                      onChange={(event) =>
                        patch({
                          useValues: value.useValues.map((item) =>
                            item.id === entry.id
                              ? { ...item, raw: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Planning use {i + 1}</span>
                    <select
                      aria-label={`Planning use ${i + 1}`}
                      value={entry.use}
                      onChange={(event) =>
                        patch({
                          useValues: value.useValues.map((item) =>
                            item.id === entry.id
                              ? { ...item, use: event.target.value as LandUse }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="">Choose a reviewed use</option>
                      {Object.entries(landUseLabels).map(([use, label]) => (
                        <option key={use} value={use}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove land-use mapping ${i + 1}`}
                    onClick={() =>
                      patch({
                        useValues: value.useValues.filter(
                          (item) => item.id !== entry.id,
                        ),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                onClick={() =>
                  patch({
                    useValues: [
                      ...value.useValues,
                      { id: crypto.randomUUID(), raw: "", use: "" },
                    ],
                  })
                }
              >
                <Plus size={14} /> Add source value
              </button>
              <p className="import-help">
                Samples may not contain every value. The server checks all rows;
                unmapped values block preparation.
              </p>
            </div>
          )}
          <div className="import-quantity-list">
            {(Object.keys(quantityLabels) as BuildingQuantityField[]).map(
              (key) => {
                const q = value.quantities[key],
                  label = quantityLabels[key];
                const set = (change: Partial<typeof q>) =>
                  patch({
                    quantities: {
                      ...value.quantities,
                      [key]: { ...q, ...change },
                    },
                  });
                return (
                  <fieldset key={key}>
                    <legend>{label}</legend>
                    <div className="field-grid">
                      <label className="field">
                        <span>{label} input</span>
                        <select
                          aria-label={`${label} input`}
                          value={q.mode}
                          onChange={(event) =>
                            set({ mode: event.target.value as typeof q.mode })
                          }
                        >
                          <option value="missing">
                            Unknown / not supplied
                          </option>
                          <option value="field">Map a source field</option>
                          <option value="constant">
                            Use a reviewed assumption
                          </option>
                        </select>
                      </label>
                      {q.mode === "field" && (
                        <FieldSelect
                          label={`${label} source field`}
                          layer={layer}
                          value={q.field}
                          onChange={(field) => set({ field })}
                        />
                      )}
                      {q.mode === "constant" && (
                        <label className="field">
                          <span>{label} assumption</span>
                          <input
                            aria-label={`${label} assumption`}
                            inputMode="decimal"
                            value={q.value}
                            onChange={(event) =>
                              set({ value: event.target.value })
                            }
                          />
                        </label>
                      )}
                      {key === "height" && q.mode !== "missing" && (
                        <label className="field">
                          <span>Height source units</span>
                          <select
                            aria-label="Height source units"
                            value={q.unit}
                            onChange={(event) =>
                              set({ unit: event.target.value as typeof q.unit })
                            }
                          >
                            <option value="meters">Meters</option>
                            <option value="feet">International feet</option>
                            <option value="us-survey-feet">
                              U.S. survey feet
                            </option>
                          </select>
                        </label>
                      )}
                      {q.mode === "field" && (
                        <label className="field">
                          <span>{label} decimal separator</span>
                          <select
                            aria-label={`${label} decimal separator`}
                            value={q.decimal}
                            onChange={(event) =>
                              set({
                                decimal: event.target.value as typeof q.decimal,
                              })
                            }
                          >
                            <option value="dot">Dot (12.5)</option>
                            <option value="comma">Comma (12,5)</option>
                          </select>
                        </label>
                      )}
                    </div>
                  </fieldset>
                );
              },
            )}
          </div>
          <details>
            <summary>Typed building program and typology (optional)</summary>
            <p>
              Use only fields containing the supported Urban Planning program
              JSON or typology values. Arbitrary CAD text is not interpreted as
              homes, jobs or floor-area allocations. An explicit program
              controls homes and jobs.
            </p>
            <FieldSelect
              optional
              label="Typed program source field"
              layer={layer}
              value={value.programField}
              onChange={(programField) => patch({ programField })}
            />
            <FieldSelect
              optional
              label="Typology source field"
              layer={layer}
              value={value.typologyField}
              onChange={(typologyField) => patch({ typologyField })}
            />
          </details>
        </>
      )}
    </section>
  );
}
