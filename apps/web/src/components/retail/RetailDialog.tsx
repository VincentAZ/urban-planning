import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, BookOpen, Plus, ShieldCheck, Trash2 } from "lucide-react";
import {
  MAX_RETAIL_CATEGORIES,
  USER_RETAIL_SOURCE,
  retailScenarioSchema,
  validateRetailScenario,
  type Place,
  type RetailScenario,
  type RetailSourceRights,
  type Scenario,
  type Source,
} from "@urban/core";
import { Modal } from "../Modal";
import { sourceSchema } from "../../../../../packages/core/src/validation";
import {
  categoryDraft,
  createRetailDraft,
  newRetailSource,
  readRetailDraft,
  retailSourceIds,
  type RetailDraft,
} from "./draft";
import { RetailCategoryEditor, RetailNumber } from "./RetailCategoryEditor";
import { RetailCalculation } from "./RetailCalculation";
import {
  RetailContext,
  RetailCSVButton,
  RetailEvidence,
  RetailResultsTable,
  useRetailPreview,
} from "./RetailOverview";
import "./retail.css";

type Section = "context" | "categories" | "sources";
const sections: { id: Section; label: string }[] = [
  { id: "context", label: "Study context" },
  { id: "categories", label: "Categories" },
  { id: "sources", label: "Sources & rights" },
];
const blankRights = (sourceId: string): RetailSourceRights => ({
  sourceId,
  authorizedPrivateUse: false,
  publicRedistribution: false,
  statement: "",
});

export function RetailDialog({
  place,
  scenario,
  canEdit,
  onSave,
  onClose,
}: {
  place: Place;
  scenario: Scenario;
  canEdit: boolean;
  onSave: (retail: RetailScenario | null, sources: Source[]) => void;
  onClose: () => void;
}) {
  const initial = useMemo(
    () => createRetailDraft(place, scenario),
    [place, scenario],
  );
  const [draft, setDraft] = useState<RetailDraft>(() => initial);
  const [section, setSection] = useState<Section>("context");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editableSources, setEditableSources] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"discard" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [accessChanged, setAccessChanged] = useState(false);
  const previousEditability = useRef(canEdit);
  const current = canEdit ? draft : initial;
  const dirty = canEdit && JSON.stringify(draft) !== JSON.stringify(initial);
  const input = useMemo(() => readRetailDraft(current), [current]);
  const structure = useMemo(
    () => (input.retail ? retailScenarioSchema.safeParse(input.retail) : null),
    [input.retail],
  );
  const validatedRetail = structure?.success ? structure.data : null;
  const previewScenario = useMemo(
    () => ({
      ...scenario,
      sources: current.sources,
      retail: validatedRetail ?? undefined,
    }),
    [scenario, current.sources, validatedRetail],
  );
  const { resolution, error: previewError } = useRetailPreview(
    place,
    previewScenario,
  );
  const selected = current.categories.find(
    (category) => category.id === selectedId,
  );
  const selectedResult = resolution?.categories.find(
    (category) => category.id === selectedId,
  );
  const validationError = useMemo(() => {
    if (input.issues.length) return input.issues[0].message;
    if (!structure?.success)
      return (
        structure?.error.issues[0]?.message ?? "Enter at least one category."
      );
    const ids = retailSourceIds(structure.data);
    for (const source of current.sources) {
      if (!ids.has(source.id)) continue;
      if (
        !source.name.trim() ||
        !source.vintage.trim() ||
        !source.license.trim()
      )
        return `${source.name || "Untitled source"}: supply a source title, vintage and license or reuse terms.`;
      const parsedSource = sourceSchema.safeParse(source);
      if (!parsedSource.success)
        return `${source.name || "Untitled source"}: ${parsedSource.error.issues[0].message}`;
      if (source.url && !/^https?:\/\//i.test(source.url))
        return `${source.name}: use an http(s) citation link or leave it blank.`;
    }
    try {
      validateRetailScenario(structure.data, place, current.sources);
      return "";
    } catch (failure) {
      return failure instanceof Error
        ? failure.message
        : "Review the study before applying.";
    }
  }, [input.issues, structure, current.sources, place]);
  useEffect(() => {
    if (previousEditability.current && !canEdit) {
      setDraft(initial);
      setConfirm(null);
      setError("");
      setAccessChanged(true);
    }
    previousEditability.current = canEdit;
  }, [canEdit, initial]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  function update(patch: Partial<RetailDraft>) {
    if (!canEdit) return;
    setDraft((value) => ({ ...value, ...patch }));
    setError("");
  }
  function requestClose() {
    if (dirty) setConfirm("discard");
    else onClose();
  }
  function save() {
    if (!canEdit || !dirty || !validatedRetail || validationError) return;
    try {
      const ids = retailSourceIds(validatedRetail);
      onSave(
        validatedRetail,
        current.sources.filter((source) => ids.has(source.id)),
      );
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The retail study could not be applied.",
      );
    }
  }
  function changeRights(sourceId: string, patch: Partial<RetailSourceRights>) {
    const existing =
      current.sourceRights.find((right) => right.sourceId === sourceId) ??
      blankRights(sourceId);
    update({
      sourceRights: [
        ...current.sourceRights.filter((right) => right.sourceId !== sourceId),
        { ...existing, ...patch },
      ],
    });
  }
  const referencedIds = new Set(
    current.categories.flatMap((category) =>
      [
        category.assumptionSourceId,
        category.baselineDemand.sourceId,
        category.baselineSales.sourceId,
        category.salesPerEstablishment.sourceId,
      ].filter(Boolean),
    ),
  );
  const sourceRows = current.sources.filter(
    (source) =>
      referencedIds.has(source.id) || editableSources.includes(source.id),
  );
  const context = current.context;
  return (
    <Modal
      title="Retail gap workbench"
      description="Cited evidence, explicit assumptions, and a clear path from inputs to results."
      wide
      open
      onClose={requestClose}
    >
      <div className="retail-workbench">
        {!canEdit && (
          <p className="retail-note">
            Read-only study. Editing requires an editable alternative and
            project editor access.
          </p>
        )}
        {accessChanged && (
          <p className="retail-warning" role="status">
            Editing access changed. Unapplied inputs were discarded; the saved
            study is shown.
          </p>
        )}
        <div className="retail-workbench-head">
          <span
            className={`retail-status ${dirty ? "is-incomplete" : "is-ready"}`}
          >
            {dirty
              ? "Unapplied draft"
              : scenario.retail
                ? "Saved scenario evidence"
                : "New study"}
          </span>
          <span>
            {current.categories.length} / {MAX_RETAIL_CATEGORIES} categories ·
            USD annually
          </span>
        </div>
        <div
          className="retail-tabs"
          role="tablist"
          aria-label="Retail workbench sections"
        >
          {sections.map((item, index) => (
            <button
              type="button"
              key={item.id}
              role="tab"
              id={`retail-tab-${item.id}`}
              aria-selected={section === item.id}
              aria-controls={`retail-panel-${item.id}`}
              tabIndex={section === item.id ? 0 : -1}
              onClick={() => setSection(item.id)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? sections.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          sections.length) %
                        sections.length;
                setSection(sections[next].id);
                document
                  .getElementById(`retail-tab-${sections[next].id}`)
                  ?.focus();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          noValidate
        >
          <section
            role="tabpanel"
            id={`retail-panel-${section}`}
            aria-labelledby={`retail-tab-${section}`}
          >
            {section === "context" && (
              <>
                <div className="retail-section-intro">
                  <BookOpen size={20} />
                  <div>
                    <h3>Start with comparable evidence.</h3>
                    <p>
                      Match geography, annual period, dollar basis and category
                      definitions before comparing demand with sales. These are
                      your declarations, not independent verification.
                    </p>
                  </div>
                </div>
                <fieldset disabled={!canEdit} className="permission-fields">
                  <label className="field">
                    <span>Evidence geography</span>
                    <input
                      required
                      maxLength={500}
                      value={context.geography}
                      onChange={(event) =>
                        update({
                          context: {
                            ...context,
                            geography: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Relationship to study area</span>
                    <select
                      value={context.relationshipToStudyArea}
                      onChange={(event) =>
                        update({
                          context: {
                            ...context,
                            relationshipToStudyArea: event.target
                              .value as typeof context.relationshipToStudyArea,
                          },
                        })
                      }
                    >
                      <option value="same-area">
                        Same area as the captured study
                      </option>
                      <option value="context-only">
                        Different area · context only
                      </option>
                    </select>
                  </label>
                  <p className="retail-note">
                    Captured study: {place.extentLabel}. No geographic scaling
                    or trade-area boundary is inferred.
                  </p>
                  <div className="retail-field-grid">
                    <RetailNumber
                      label="Reference year"
                      value={context.referenceYear}
                      max={2200}
                      invalid={input.issues.some(
                        (issue) => issue.field === "referenceYear",
                      )}
                      onChange={(referenceYear) =>
                        update({ context: { ...context, referenceYear } })
                      }
                    />
                    <RetailNumber
                      label="Dollar year"
                      value={context.dollarYear}
                      max={2200}
                      invalid={input.issues.some(
                        (issue) => issue.field === "dollarYear",
                      )}
                      onChange={(dollarYear) =>
                        update({ context: { ...context, dollarYear } })
                      }
                    />
                    <label className="field">
                      <span>Classification system</span>
                      <select
                        value={context.classification.system}
                        onChange={(event) =>
                          update({
                            context: {
                              ...context,
                              classification: {
                                ...context.classification,
                                system: event.target.value as
                                  "NAICS" | "custom",
                              },
                            },
                          })
                        }
                      >
                        <option value="custom">Custom categories</option>
                        <option value="NAICS">NAICS</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Classification version</span>
                      <input
                        required
                        maxLength={100}
                        value={context.classification.version}
                        onChange={(event) =>
                          update({
                            context: {
                              ...context,
                              classification: {
                                ...context.classification,
                                version: event.target.value,
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Study horizon</span>
                      <select
                        value={context.horizon}
                        onChange={(event) =>
                          update({
                            context: {
                              ...context,
                              horizon: Number(
                                event.target.value,
                              ) as Scenario["horizon"],
                            },
                          })
                        }
                      >
                        {[0, 5, 10, 20].map((value) => (
                          <option key={value} value={value}>
                            {value === 0 ? "Today (0 years)" : `${value} years`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="retail-note">
                      Scenario horizon: {scenario.horizon} years. A different
                      study horizon retains evidence but withholds scenario
                      results until reviewed.
                    </div>
                  </div>
                  <label className="retail-attestation">
                    <input
                      type="checkbox"
                      checked={context.comparabilityConfirmed}
                      onChange={(event) =>
                        update({
                          context: {
                            ...context,
                            comparabilityConfirmed: event.target.checked,
                          },
                        })
                      }
                    />
                    <span>
                      I confirm demand, sales and benchmarks use comparable
                      geography, years, dollar basis and category definitions.
                    </span>
                  </label>
                  <label className="retail-attestation">
                    <input
                      type="checkbox"
                      checked={context.disjointCategoriesConfirmed}
                      onChange={(event) =>
                        update({
                          context: {
                            ...context,
                            disjointCategoriesConfirmed: event.target.checked,
                          },
                        })
                      }
                    />
                    <span>
                      I confirm these categories are mutually exclusive and use
                      a documented compatible classification.
                    </span>
                  </label>
                </fieldset>
                <button
                  type="button"
                  className="button"
                  onClick={() => setSection("categories")}
                >
                  Review categories{" "}
                  <ArrowLeft size={14} className="retail-forward" />
                </button>
              </>
            )}
            {section === "categories" && (
              <>
                <div className="retail-category-toolbar">
                  <div>
                    <h3>
                      {selected
                        ? selected.name || "Category"
                        : "One category, one clear calculation."}
                    </h3>
                    <p>
                      {selected
                        ? "Changes stay in this draft until you apply the complete study."
                        : "Unknown inputs stay unknown. Add only categories supported by your evidence."}
                    </p>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className="button compact"
                      disabled={
                        current.categories.length >= MAX_RETAIL_CATEGORIES
                      }
                      onClick={() => {
                        const category = categoryDraft();
                        update({
                          categories: [...current.categories, category],
                        });
                        setSelectedId(category.id);
                      }}
                    >
                      <Plus size={15} /> Add category
                    </button>
                  )}
                </div>
                {selected ? (
                  <>
                    <div className="retail-category-nav">
                      <button
                        type="button"
                        className="button compact"
                        onClick={() => setSelectedId(null)}
                      >
                        <ArrowLeft size={14} /> All categories
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          className="button compact danger"
                          disabled={current.categories.length <= 1}
                          onClick={() => {
                            update({
                              categories: current.categories.filter(
                                (category) => category.id !== selected.id,
                              ),
                            });
                            setSelectedId(null);
                          }}
                        >
                          <Trash2 size={14} /> Remove category
                        </button>
                      )}
                    </div>
                    <div className="retail-editor-grid">
                      <fieldset
                        disabled={!canEdit}
                        className="permission-fields"
                      >
                        <RetailCategoryEditor
                          category={selected}
                          sources={current.sources}
                          issues={input.issues}
                          onChange={(category) =>
                            update({
                              categories: current.categories.map((item) =>
                                item.id === category.id ? category : item,
                              ),
                            })
                          }
                        />
                      </fieldset>
                      <aside>
                        {selectedResult ? (
                          <RetailCalculation row={selectedResult} />
                        ) : (
                          <div className="retail-calculation">
                            <h3>Calculation preview</h3>
                            <p>
                              Complete valid inputs to calculate. No last-valid
                              result is shown while the draft contains invalid
                              numbers.
                            </p>
                          </div>
                        )}
                        <button
                          type="button"
                          className="button full-width"
                          onClick={() => setSection("sources")}
                        >
                          Review sources & rights
                        </button>
                      </aside>
                    </div>
                  </>
                ) : (
                  <>
                    {resolution ? (
                      <RetailResultsTable
                        resolution={resolution}
                        onSelect={setSelectedId}
                      />
                    ) : (
                      <div className="retail-category-list">
                        {current.categories.map((category) => (
                          <button
                            type="button"
                            key={category.id}
                            onClick={() => setSelectedId(category.id)}
                          >
                            <span>
                              <strong>
                                {category.name || "Unnamed category"}
                              </strong>
                              <small>{category.code}</small>
                            </span>
                            <span>Edit inputs →</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {resolution && !dirty && scenario.retail && (
                      <RetailCSVButton
                        place={place}
                        scenario={scenario}
                        resolution={resolution}
                      />
                    )}
                    {dirty && (
                      <p className="retail-note">
                        Apply the study before exporting category results. Draft
                        values are not labeled with a saved revision.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {section === "sources" && (
              <>
                <div className="retail-category-toolbar">
                  <div>
                    <h3>Citations that travel with the study.</h3>
                    <p>
                      Retain the source and its permitted uses. A web link alone
                      does not grant redistribution rights.
                    </p>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => {
                        const source = newRetailSource();
                        update({
                          sources: [...current.sources, source],
                          sourceRights: [
                            ...current.sourceRights,
                            blankRights(source.id),
                          ],
                        });
                        setEditableSources((ids) => [...ids, source.id]);
                      }}
                    >
                      <Plus size={15} /> Add source
                    </button>
                  )}
                </div>
                {sourceRows.map((source) => {
                  const rights =
                    current.sourceRights.find(
                      (right) => right.sourceId === source.id,
                    ) ?? blankRights(source.id);
                  const sourceEditable =
                    canEdit && editableSources.includes(source.id);
                  function sourceChange(patch: Partial<Source>) {
                    if (sourceEditable)
                      update({
                        sources: current.sources.map((item) =>
                          item.id === source.id ? { ...item, ...patch } : item,
                        ),
                      });
                  }
                  return (
                    <section
                      key={source.id}
                      className="retail-source-editor"
                      aria-label={`Source ${source.name || "new citation"}`}
                    >
                      <h4>{source.name || "New source citation"}</h4>
                      {!sourceEditable && (
                        <p className="retail-note">
                          Captured citation. To correct it, add a new source and
                          reassign the affected category measures; the original
                          record remains unchanged.
                        </p>
                      )}
                      <fieldset
                        className="permission-fields"
                        disabled={!sourceEditable}
                      >
                        <label className="field">
                          <span>Source title</span>
                          <input
                            required
                            maxLength={240}
                            value={source.name}
                            onChange={(event) =>
                              sourceChange({ name: event.target.value })
                            }
                          />
                        </label>
                        <div className="retail-field-grid">
                          <label className="field">
                            <span>Source vintage</span>
                            <input
                              required
                              maxLength={100}
                              value={source.vintage}
                              onChange={(event) =>
                                sourceChange({ vintage: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>Source kind</span>
                            <select
                              value={source.kind}
                              onChange={(event) =>
                                sourceChange({
                                  kind: event.target.value as Source["kind"],
                                })
                              }
                            >
                              <option value="user-supplied">
                                User supplied
                              </option>
                              <option value="published-estimate">
                                Published estimate
                              </option>
                              <option value="observed">Observed data</option>
                              <option value="inferred">
                                Inferred estimate
                              </option>
                            </select>
                          </label>
                        </div>
                        <label className="field">
                          <span>Source citation URL</span>
                          <input
                            type="url"
                            maxLength={2000}
                            value={source.url}
                            placeholder="Optional https:// citation"
                            onChange={(event) =>
                              sourceChange({ url: event.target.value })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>License or reuse terms</span>
                          <input
                            required
                            maxLength={1000}
                            value={source.license}
                            onChange={(event) =>
                              sourceChange({ license: event.target.value })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Source description</span>
                          <textarea
                            rows={2}
                            maxLength={4000}
                            value={source.description ?? ""}
                            onChange={(event) =>
                              sourceChange({ description: event.target.value })
                            }
                          />
                        </label>
                      </fieldset>
                      <fieldset
                        className="permission-fields retail-rights"
                        disabled={!canEdit}
                      >
                        <legend>
                          <ShieldCheck size={15} /> Permitted uses
                        </legend>
                        <label className="retail-attestation">
                          <input
                            type="checkbox"
                            checked={rights.authorizedPrivateUse}
                            onChange={(event) =>
                              changeRights(source.id, {
                                authorizedPrivateUse: event.target.checked,
                                ...(!event.target.checked
                                  ? { publicRedistribution: false }
                                  : {}),
                              })
                            }
                          />
                          <span>
                            I am authorized to store, analyze, share with the
                            project team and privately export this source.
                          </span>
                        </label>
                        <label className="retail-attestation">
                          <input
                            type="checkbox"
                            disabled={!rights.authorizedPrivateUse}
                            checked={rights.publicRedistribution}
                            onChange={(event) =>
                              changeRights(source.id, {
                                publicRedistribution: event.target.checked,
                              })
                            }
                          />
                          <span>
                            This source permits public redistribution of input
                            values and attribution in snapshots and downloads.
                          </span>
                        </label>
                        <label className="field">
                          <span>Rights statement</span>
                          <textarea
                            rows={2}
                            required
                            maxLength={2000}
                            value={rights.statement}
                            placeholder="Describe the permission, license or ownership you rely on."
                            onChange={(event) =>
                              changeRights(source.id, {
                                statement: event.target.value,
                              })
                            }
                          />
                        </label>
                      </fieldset>
                      {!referencedIds.has(source.id) && (
                        <>
                          <p className="retail-note">
                            Not used yet. Select this source in a category
                            measure to retain it with the applied study.
                          </p>
                          {sourceEditable && (
                            <button
                              type="button"
                              className="button compact"
                              onClick={() => {
                                update({
                                  sources: current.sources.filter(
                                    (item) => item.id !== source.id,
                                  ),
                                  sourceRights: current.sourceRights.filter(
                                    (item) => item.sourceId !== source.id,
                                  ),
                                });
                                setEditableSources((ids) =>
                                  ids.filter((id) => id !== source.id),
                                );
                              }}
                            >
                              Remove unused source
                            </button>
                          )}
                        </>
                      )}
                    </section>
                  );
                })}
                {current.sourceRights
                  .filter(
                    (right) =>
                      !referencedIds.has(right.sourceId) &&
                      !editableSources.includes(right.sourceId),
                  )
                  .map((right) => {
                    const name =
                      current.sources.find(
                        (source) => source.id === right.sourceId,
                      )?.name ?? right.sourceId;
                    return (
                      <section
                        className="retail-source-editor"
                        key={`unused-${right.sourceId}`}
                        aria-label={`Unused declaration for ${name}`}
                      >
                        <h4>{name}</h4>
                        <p className="retail-note">
                          No current category references this source. Retiring
                          its declaration removes it from this study; the
                          original citation and scenario history remain
                          retained.
                        </p>
                        <p>{right.statement}</p>
                        <span className="retail-status">
                          {right.publicRedistribution
                            ? "Public redistribution declared"
                            : "Private use only"}
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            className="button compact"
                            aria-label={`Retire unused declaration for ${name}`}
                            onClick={() =>
                              update({
                                sourceRights: current.sourceRights.filter(
                                  (item) => item.sourceId !== right.sourceId,
                                ),
                              })
                            }
                          >
                            Retire unused declaration
                          </button>
                        )}
                      </section>
                    );
                  })}
                <p className="retail-note">
                  No provider is connected. Entries are supplied by you;
                  category estimates have not been independently verified.
                  Public sharing remains unavailable until every referenced
                  source permits it.
                </p>
              </>
            )}
          </section>
          {(error || validationError || previewError) && (
            <div
              className="retail-validation"
              role={error ? "alert" : "status"}
            >
              <strong>{error ? "Could not apply" : "Before applying"}</strong>
              <p>{error || validationError || previewError}</p>
            </div>
          )}
          {!canEdit && scenario.retail && section === "context" && (
            <>
              <RetailContext retail={scenario.retail} />
              <RetailEvidence
                place={place}
                scenario={scenario}
                resolution={resolution}
              />
            </>
          )}
          <div className="retail-actions">
            <div>
              {canEdit && scenario.retail && (
                <button
                  type="button"
                  className="button compact danger"
                  onClick={() => setConfirm("remove")}
                >
                  Remove retail study
                </button>
              )}
            </div>
            <div>
              <button type="button" className="button" onClick={requestClose}>
                {dirty ? "Discard draft" : "Close"}
              </button>
              {canEdit && (
                <button
                  type="submit"
                  className="button primary"
                  disabled={!dirty || !!validationError || !validatedRetail}
                >
                  Apply retail study
                </button>
              )}
            </div>
          </div>
        </form>
        {confirm && (
          <Dialog.Root
            open
            onOpenChange={(open) => {
              if (!open) setConfirm(null);
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="modal-overlay" />
              <Dialog.Content
                className="modal retail-confirm-modal"
                role="alertdialog"
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                <Dialog.Title>
                  {confirm === "discard"
                    ? "Discard unapplied changes?"
                    : "Remove this scenario’s retail study?"}
                </Dialog.Title>
                <Dialog.Description>
                  {confirm === "discard"
                    ? "The saved study is unchanged. Your current draft will be discarded."
                    : "This removes the retail evidence from this alternative in one history step. The captured city baseline is unchanged."}
                </Dialog.Description>
                <div className="retail-confirm-actions">
                  <button
                    type="button"
                    className="button"
                    autoFocus
                    onClick={() => setConfirm(null)}
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => {
                      if (confirm === "discard") onClose();
                      else if (canEdit)
                        try {
                          onSave(null, []);
                          onClose();
                        } catch (failure) {
                          setError(
                            failure instanceof Error
                              ? failure.message
                              : "Could not remove the study.",
                          );
                          setConfirm(null);
                        }
                    }}
                  >
                    {confirm === "discard" ? "Discard changes" : "Remove study"}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>
    </Modal>
  );
}
