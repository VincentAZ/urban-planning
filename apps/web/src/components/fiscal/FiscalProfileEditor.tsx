import type { FiscalProfile, Source } from "@urban/core";
import {
  fiscalFields,
  newFiscalSource,
  type FiscalProfileDraft,
} from "./draft";
import { FiscalField, FiscalNumber, FiscalText } from "./FiscalFields";

export function FiscalCitations({
  label,
  sources,
  value,
  onChange,
}: {
  label: string;
  sources: Source[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="fiscal-citations">
      <legend>{label}</legend>
      {sources.map((source) => (
        <label className="check-row" key={source.id}>
          <input
            type="checkbox"
            checked={value.includes(source.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, source.id]
                  : value.filter((id) => id !== source.id),
              )
            }
          />
          <span>{source.name || "Untitled source"}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function FiscalProfileEditor({
  draft,
  onChange,
}: {
  draft: FiscalProfileDraft;
  onChange: (draft: FiscalProfileDraft) => void;
}) {
  const patch = (change: Partial<FiscalProfileDraft>) =>
    onChange({ ...draft, ...change });
  const sources = draft.sources.map((item) => item.source);
  const sourceChange = (index: number, change: Partial<Source>) =>
    patch({
      sources: draft.sources.map((item, i) =>
        i === index
          ? {
              ...item,
              source: { ...item.source, ...change },
              privateUse: false,
              exportAllowed: false,
              publicRedistribution: false,
            }
          : item,
      ),
    });
  return (
    <div className="fiscal-section">
      <p className="notice">
        Start with explicit local evidence or clearly authored assumptions. The
        starting numbers are not verified local rates. This profile changes only
        a new fiscal study; the original project and earlier reports stay
        intact.
      </p>
      <div className="fiscal-grid">
        <FiscalText
          label="Fiscal profile name"
          value={draft.name}
          maxLength={240}
          onChange={(name) => patch({ name })}
        />
        <FiscalText
          label="Profile version label"
          value={draft.profileVersion}
          maxLength={240}
          onChange={(profileVersion) => patch({ profileVersion })}
        />
        <FiscalText
          label="Receiving jurisdiction"
          value={draft.jurisdictionName}
          maxLength={240}
          onChange={(jurisdictionName) => patch({ jurisdictionName })}
        />
        <FiscalText
          label="Jurisdiction identifier"
          value={draft.jurisdictionId}
          maxLength={240}
          hint="Use a documented local identifier; this does not establish a legal boundary match."
          onChange={(jurisdictionId) => patch({ jurisdictionId })}
        />
        <FiscalNumber
          label="Fiscal reference year"
          value={draft.fiscalYear}
          onChange={(fiscalYear) => patch({ fiscalYear })}
        />
        <FiscalNumber
          label="Constant-dollar price year"
          value={draft.dollarYear}
          hint="All monetary inputs use USD in this price year. The discount rate is real."
          onChange={(dollarYear) => patch({ dollarYear })}
        />
      </div>
      <FiscalText
        label="Jurisdiction geography and applicability"
        value={draft.geography}
        multiline
        maxLength={4000}
        hint="Explain how the jurisdiction relates to the study area, including partial overlaps or exclusions."
        onChange={(geography) => patch({ geography })}
      />
      <FiscalText
        label="Taxable assessed-value compatibility"
        value={draft.valuationNotes}
        multiline
        maxLength={4000}
        hint="Explain the supplied building values, assessment basis, exemptions and fallback compatibility. Market value is not automatically taxable assessed value."
        onChange={(valuationNotes) => patch({ valuationNotes })}
      />
      <FiscalField label="Service-cost allocation method">
        {(props) => (
          <select
            {...props}
            value={draft.allocationMethod}
            onChange={(event) =>
              patch({
                allocationMethod: event.target
                  .value as FiscalProfile["serviceAllocation"]["method"],
              })
            }
          >
            <option value="average-cost-allocation">
              Average cost allocation
            </option>
            <option value="authored-case-study">Authored case study</option>
          </select>
        )}
      </FiscalField>
      <FiscalText
        label="Service-cost allocation notes"
        value={draft.allocationNotes}
        multiline
        maxLength={4000}
        hint="State the resident/job allocation, excluded services, overlap and capital-cost limitations."
        onChange={(allocationNotes) => patch({ allocationNotes })}
      />
      <details open>
        <summary>Citations and reuse declarations</summary>
        <div className="fiscal-section">
          {draft.sources.map((item, index) => (
            <section
              className="fiscal-source"
              key={item.source.id}
              aria-label={`Fiscal source ${index + 1}`}
            >
              <h4>Source {index + 1}</h4>
              <div className="fiscal-grid">
                <FiscalText
                  label={`Source ${index + 1} title`}
                  value={item.source.name}
                  maxLength={240}
                  onChange={(name) => sourceChange(index, { name })}
                />
                <FiscalText
                  label={`Source ${index + 1} vintage`}
                  value={item.source.vintage}
                  maxLength={240}
                  onChange={(vintage) => sourceChange(index, { vintage })}
                />
                <FiscalText
                  label={`Source ${index + 1} citation URL`}
                  value={item.source.url}
                  maxLength={2000}
                  hint="A citation link or blank for authored/local records; no remote document is fetched."
                  onChange={(url) => sourceChange(index, { url })}
                />
                <FiscalText
                  label={`Source ${index + 1} reuse terms`}
                  value={item.source.license}
                  maxLength={1000}
                  onChange={(license) => sourceChange(index, { license })}
                />
              </div>
              <FiscalField label={`Source ${index + 1} kind`}>
                {(props) => (
                  <select
                    {...props}
                    value={item.source.kind}
                    onChange={(event) =>
                      sourceChange(index, {
                        kind: event.target.value as Source["kind"],
                      })
                    }
                  >
                    <option value="user-supplied">
                      User supplied / authored
                    </option>
                    <option value="observed">Observed record</option>
                    <option value="published-estimate">
                      Published estimate
                    </option>
                    <option value="inferred">Inferred</option>
                  </select>
                )}
              </FiscalField>
              <FiscalText
                label={`Source ${index + 1} context`}
                value={item.source.description ?? ""}
                multiline
                onChange={(description) => sourceChange(index, { description })}
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={item.privateUse}
                  onChange={(event) =>
                    patch({
                      sources: draft.sources.map((value, i) =>
                        i === index
                          ? { ...value, privateUse: event.target.checked }
                          : value,
                      ),
                    })
                  }
                />
                <span>
                  I may use, retain, analyze and privately display this source
                  and its input values.
                </span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={item.exportAllowed}
                  onChange={(event) =>
                    patch({
                      sources: draft.sources.map((value, i) =>
                        i === index
                          ? { ...value, exportAllowed: event.target.checked }
                          : value,
                      ),
                    })
                  }
                />
                <span>
                  This source permits downloads and exports of its input values
                  and attribution.
                </span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={item.publicRedistribution}
                  onChange={(event) =>
                    patch({
                      sources: draft.sources.map((value, i) =>
                        i === index
                          ? {
                              ...value,
                              publicRedistribution: event.target.checked,
                            }
                          : value,
                      ),
                    })
                  }
                />
                <span>
                  This source permits public redistribution of its input values
                  and attribution in snapshots and downloads.
                </span>
              </label>
              {draft.sources.length > 1 && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    const id = item.source.id;
                    patch({
                      sources: draft.sources.filter((_, i) => i !== index),
                      jurisdictionSources: draft.jurisdictionSources.filter(
                        (value) => value !== id,
                      ),
                      allocationSources: draft.allocationSources.filter(
                        (value) => value !== id,
                      ),
                      files: draft.files.filter((file) => file.sourceId !== id),
                      provenance: Object.fromEntries(
                        fiscalFields.map(({ key }) => [
                          key,
                          {
                            ...draft.provenance[key],
                            sourceIds: draft.provenance[key].sourceIds.filter(
                              (value) => value !== id,
                            ),
                          },
                        ]),
                      ) as FiscalProfile["provenance"],
                    });
                  }}
                >
                  Remove source {index + 1}
                </button>
              )}
            </section>
          ))}
          <button
            type="button"
            className="button"
            disabled={draft.sources.length >= 100}
            onClick={() =>
              patch({ sources: [...draft.sources, newFiscalSource()] })
            }
          >
            Add fiscal source
          </button>
          <FiscalCitations
            label="Jurisdiction citations"
            sources={sources}
            value={draft.jurisdictionSources}
            onChange={(jurisdictionSources) => patch({ jurisdictionSources })}
          />
          <FiscalCitations
            label="Service allocation citations"
            sources={sources}
            value={draft.allocationSources}
            onChange={(allocationSources) => patch({ allocationSources })}
          />
        </div>
      </details>
      <h3>Nine inputs. Every assumption visible.</h3>
      {fiscalFields.map((field) => (
        <section className="fiscal-source" key={field.key}>
          <FiscalNumber
            label={`${field.label} (${field.unit})`}
            hint={field.hint}
            value={draft.coefficients[field.key]}
            onChange={(raw) =>
              patch({
                coefficients: { ...draft.coefficients, [field.key]: raw },
                provenance: {
                  ...draft.provenance,
                  [field.key]: {
                    ...draft.provenance[field.key],
                    kind: "authored",
                  },
                },
              })
            }
          />
          <details>
            <summary>Evidence for {field.label.toLowerCase()}</summary>
            <div className="fiscal-section">
              <FiscalField label={`${field.label} evidence kind`}>
                {(props) => (
                  <select
                    {...props}
                    value={draft.provenance[field.key].kind}
                    onChange={(event) =>
                      patch({
                        provenance: {
                          ...draft.provenance,
                          [field.key]: {
                            ...draft.provenance[field.key],
                            kind: event.target.value as
                              | "published"
                              | "derived"
                              | "authored",
                          },
                        },
                      })
                    }
                  >
                    <option value="authored">Authored assumption</option>
                    <option value="published">Published value</option>
                    <option value="derived">Derived from cited inputs</option>
                  </select>
                )}
              </FiscalField>
              <FiscalText
                label={`${field.label} evidence notes`}
                value={draft.provenance[field.key].description}
                multiline
                maxLength={4000}
                onChange={(description) =>
                  patch({
                    provenance: {
                      ...draft.provenance,
                      [field.key]: {
                        ...draft.provenance[field.key],
                        description,
                      },
                    },
                  })
                }
              />
              {draft.provenance[field.key].kind === "derived" && (
                <FiscalText
                  label={`${field.label} derivation`}
                  value={draft.provenance[field.key].derivation ?? ""}
                  multiline
                  maxLength={4000}
                  onChange={(derivation) =>
                    patch({
                      provenance: {
                        ...draft.provenance,
                        [field.key]: {
                          ...draft.provenance[field.key],
                          derivation,
                        },
                      },
                    })
                  }
                />
              )}
              <FiscalCitations
                label={`${field.label} citations`}
                sources={sources}
                value={draft.provenance[field.key].sourceIds}
                onChange={(sourceIds) =>
                  patch({
                    provenance: {
                      ...draft.provenance,
                      [field.key]: {
                        ...draft.provenance[field.key],
                        sourceIds,
                      },
                    },
                  })
                }
              />
            </div>
          </details>
        </section>
      ))}
      <FiscalText
        label="Other profile notes"
        value={draft.notes}
        multiline
        maxLength={10000}
        hint="One note per line. The original source files, if present in an imported profile, remain retained by hash."
        onChange={(notes) => patch({ notes })}
      />
    </div>
  );
}
