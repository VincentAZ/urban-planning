import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Brush,
  Check,
  Eraser,
  Hand,
  MapPin,
  Pencil,
  Plus,
  Redo2,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Users,
} from "lucide-react";
import {
  buildingGeometry,
  materializeBuildings,
  USER_ACTIVITY_SOURCE,
  type ActivityScenario,
  type Place,
  type Scenario,
} from "@urban/core";
import { applyActivityPreset } from "@urban/models";
import type { ActivityEditorController } from "./useActivityEditor";
import { activeAreaPath } from "./draft";
import { ActivitySummary, countLabel } from "./ActivitySummary";
import { ActivityNumber, TargetFields } from "./ActivityFields";
import {
  ClosureDialog,
  ForecastDialog,
  ReferenceDialog,
} from "./ActivityDialogs";
import "./activity.css";

type ReferenceDimension = "population" | "employment" | "vehicles";
export function ActivityPanel({
  editor,
  place,
  scenario,
  canFetchReference,
  onAssumptions,
  onFocus,
  onCreateAlternative,
}: {
  editor: ActivityEditorController;
  place: Place;
  scenario: Scenario;
  canFetchReference: boolean;
  onAssumptions: () => void;
  onFocus: (id: string) => void;
  onCreateAlternative: () => void;
}) {
  const { draft, area, preview, selected } = editor;
  const [tab, setTab] = useState<"counts" | "areas" | "demand">("counts");
  const [dialog, setDialog] = useState<
    ReferenceDimension | "forecast" | "closure" | null
  >(null);
  const [presetError, setPresetError] = useState("");
  useEffect(() => {
    setDialog(null);
    setPresetError("");
  }, [draft?.id]);
  const activity = draft?.activity ?? scenario.activity;
  const plants = useMemo(
    () =>
      materializeBuildings(place, scenario).filter(
        (building) =>
          building.use === "industrial" || building.use === "warehouse",
      ),
    [place, scenario],
  );
  function preset() {
    if (!draft) return;
    try {
      editor.update(
        applyActivityPreset(draft.activity, { kind: "population-plus-25" }),
      );
      setPresetError("");
    } catch (error) {
      setPresetError((error as Error).message);
    }
  }
  function global(
    key: keyof ActivityScenario["global"],
    target: ActivityScenario["global"][typeof key],
  ) {
    if (draft)
      editor.update({
        ...draft.activity,
        global: { ...draft.activity.global, [key]: target },
      });
  }
  const resolution = preview.resolution;
  return (
    <section
      className={`activity-panel ${draft ? "activity-panel-editing" : ""}`}
      aria-label="Population and activity controls"
    >
      <div className="panel-intro">
        <span className="eyebrow">ROOM FOR WHAT’S NEXT</span>
        <h2>People make the place.</h2>
        {!draft && (
          <p>
            Explore who lives and works here, then shape a different future.
          </p>
        )}
      </div>
      <div className="activity-horizon">
        <Users size={16} />
        <span>
          {draft ? "Draft preview" : "Applied scenario"} ·{" "}
          {draft?.horizon ?? scenario.horizon} year horizon
        </span>
        {draft && <b>UNAPPLIED</b>}
      </div>
      {draft && !area && (
        <div
          className="activity-live-total"
          aria-label="Resulting draft counts"
          aria-busy={preview.updating}
          aria-live="polite"
        >
          <div>
            <span>People</span>
            <strong>
              {preview.updating
                ? "Updating…"
                : countLabel(resolution?.population.value)}
            </strong>
          </div>
          <div>
            <span>Workplace jobs</span>
            <strong>
              {preview.updating
                ? "Updating…"
                : countLabel(resolution?.employment.value)}
            </strong>
          </div>
          <div>
            <span>Household vehicles</span>
            <strong>
              {preview.updating
                ? "Updating…"
                : countLabel(resolution?.vehicles.value)}
            </strong>
          </div>
          <small>Final totals, after neighborhood exceptions</small>
        </div>
      )}
      {preview.failed && (
        <button type="button" className="button" onClick={preview.retry}>
          Retry activity calculation
        </button>
      )}
      {!draft ? (
        <>
          <p className="activity-note">
            {activity
              ? "Count targets and local exceptions are active. Physical homes, workplace capacity and property values are retained separately."
              : "Currently using building-based scenario assumptions. Add explicit count controls to choose references and neighborhood exceptions."}
          </p>
          {editor.editable ? (
            <div className="activity-actions">
              <button className="button primary" onClick={editor.start}>
                <SlidersHorizontal size={15} />
                {activity ? "Edit People controls" : "Set up People controls"}
              </button>
              {activity && (
                <button className="button subtle" onClick={editor.remove}>
                  Remove controls
                </button>
              )}
            </div>
          ) : scenario.id === "baseline" ? (
            <button className="button primary" onClick={onCreateAlternative}>
              Create an alternative
            </button>
          ) : (
            <p className="notice">
              These controls are available for inspection. An editor can change
              an alternative.
            </p>
          )}
          <div aria-live="polite" aria-busy={preview.updating}>
            {preview.updating ? (
              <p role="status">Resolving population and activity…</p>
            ) : preview.error ? (
              <p className="error-message" role="alert">
                {preview.error}
              </p>
            ) : (
              resolution && (
                <ActivitySummary resolution={resolution} activity={activity} />
              )
            )}
          </div>
          {!!editor.areas.length && (
            <>
              <h3 className="section-label">NEIGHBORHOOD EXCEPTIONS</h3>
              <div className="activity-area-list">
                {editor.areas.map((n) => (
                  <button
                    key={n.id}
                    aria-pressed={selected?.id === n.id}
                    onClick={() => {
                      editor.select(n.id);
                      onFocus(n.id);
                    }}
                  >
                    <MapPin size={16} />
                    <span>
                      <strong>{n.name}</strong>
                      <small>
                        {countLabel(
                          resolution?.neighborhoods.find((r) => r.id === n.id)
                            ?.population.value,
                        )}{" "}
                        people ·{" "}
                        {countLabel(
                          resolution?.neighborhoods.find((r) => r.id === n.id)
                            ?.employment.value,
                        )}{" "}
                        jobs
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {selected && (
                <div className="activity-note">
                  {selected.name}:{" "}
                  {selected.population
                    ? selected.population.mode === "absolute"
                      ? `${countLabel(selected.population.value)} people`
                      : `${selected.population.percent}% of area’s year-zero population`
                    : "Allocated population"}
                  ;{" "}
                  {selected.employment
                    ? selected.employment.mode === "absolute"
                      ? `${countLabel(selected.employment.value)} jobs`
                      : `${selected.employment.percent}% of area’s year-zero jobs`
                    : "allocated jobs"}
                  . This is a modeled area allocation.
                </div>
              )}
            </>
          )}
          <button className="button activity-mode-link" onClick={onAssumptions}>
            Inspect travel mode shares & other assumptions
          </button>
        </>
      ) : (
        <>
          {!area && (
            <div className="activity-tabs" aria-label="People editor sections">
              {(
                [
                  ["counts", "Counts"],
                  ["areas", "Neighborhoods"],
                  ["demand", "Demand"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={tab === key}
                  className={tab === key ? "active" : ""}
                  onClick={() => {
                    if (editor.validFields()) setTab(key);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <form
            ref={editor.formRef}
            onSubmit={(event) => {
              event.preventDefault();
              area ? editor.finishArea() : editor.apply();
            }}
          >
            <fieldset className="permission-fields" disabled={editor.busy}>
              {area ? (
                <AreaEditor editor={editor} />
              ) : (
                <>
                  {tab === "counts" && (
                    <>
                      <details className="activity-preset-picker">
                        <summary>
                          <Sparkles size={14} /> Try a scenario preset
                        </summary>
                        <div className="activity-presets">
                          <button type="button" onClick={preset}>
                            <Sparkles size={15} />
                            <span>
                              +25% population
                              <small>125% of the fixed reference</small>
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDialog("forecast")}
                          >
                            <span>
                              +10 years at regional forecast
                              <small>Bring a cited projection</small>
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={
                              !draft.activity.neighborhoods.length ||
                              !resolution ||
                              preview.updating
                            }
                            onClick={() => setDialog("closure")}
                          >
                            <span>
                              Post-plant-closure
                              <small>
                                {draft.activity.neighborhoods.length
                                  ? "Use documented jobs removed"
                                  : "Define the plant area first"}
                              </small>
                            </span>
                          </button>
                        </div>
                      </details>
                      <TargetFields
                        label="Population"
                        target={draft.activity.global.population}
                        reference={resolution?.population.reference}
                        onChange={(target) => global("population", target)}
                      />
                      <button
                        type="button"
                        className="activity-reference-link"
                        onClick={() => setDialog("population")}
                      >
                        Choose population reference
                      </button>
                      <TargetFields
                        label="Workplace jobs"
                        target={draft.activity.global.employment}
                        reference={resolution?.employment.reference}
                        onChange={(target) => global("employment", target)}
                      />
                      <button
                        type="button"
                        className="activity-reference-link"
                        onClick={() => setDialog("employment")}
                      >
                        Choose employment reference
                      </button>
                      <TargetFields
                        label="Household vehicles"
                        scope="vehicles"
                        target={draft.activity.global.householdVehicles}
                        reference={resolution?.vehicles.reference}
                        onChange={(target) =>
                          global("householdVehicles", target)
                        }
                      />
                      <button
                        type="button"
                        className="activity-reference-link"
                        onClick={() => setDialog("vehicles")}
                      >
                        Choose vehicle reference
                      </button>
                      <p className="activity-note">
                        Household vehicles are a stock: vehicles available to
                        occupied homes. Roadway traffic, daily trips and the
                        map’s decorative agents are different quantities.
                      </p>
                      {canFetchReference && (
                        <button
                          type="button"
                          className="button"
                          onClick={editor.fetchVehicleReference}
                        >
                          Check prepared Census vehicle reference
                        </button>
                      )}
                      {!canFetchReference && !place.vehicleAvailability && (
                        <p className="activity-note">
                          For an existing captured ZCTA, save to your free
                          account to check the prepared Census supplement. You
                          can also enter a sourced reference above.
                        </p>
                      )}
                      {editor.referenceNotice && (
                        <p role="status" className="notice">
                          {editor.referenceNotice}
                        </p>
                      )}
                      <VehicleSource activity={draft.activity} place={place} />
                    </>
                  )}
                  {tab === "areas" && (
                    <>
                      <h3>A little local detail.</h3>
                      <p className="activity-note">
                        Paint a neighborhood, draw precise edges, or start from
                        a plant footprint. Exceptions replace their own
                        allocated population or jobs. Areas cannot overlap.
                      </p>
                      {(
                        [
                          ["population", "Population"],
                          ["employment", "Employment"],
                        ] as const
                      ).map(([key, label]) => (
                        <label className="field" key={key}>
                          <span>{label} allocation</span>
                          <select
                            value={draft.activity.allocation[key]}
                            onChange={(event) =>
                              editor.update({
                                ...draft.activity,
                                allocation: {
                                  ...draft.activity.allocation,
                                  [key]: event.target.value,
                                },
                              })
                            }
                          >
                            <option value="building-weighted">
                              Weight by{" "}
                              {key === "population" ? "homes" : "building jobs"}
                            </option>
                            <option value="uniform-area">
                              Uniform per square meter
                            </option>
                            <option value="unallocated">
                              Keep spatially unallocated
                            </option>
                          </select>
                        </label>
                      ))}
                      <p className="activity-note">
                        Building weighting uses clipped footprint shares across
                        boundaries. Uniform area assumes even distribution.
                        Neither is an observed neighborhood Census count;
                        missing weights stay unallocated.
                      </p>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => editor.startArea()}
                      >
                        <Brush size={15} />
                        Paint a neighborhood
                      </button>
                      {!!plants.length && (
                        <label className="field activity-plant-picker">
                          <span>Or start from a plant footprint</span>
                          <select
                            value=""
                            onChange={(event) => {
                              const plant = plants.find(
                                (p) => p.id === event.target.value,
                              );
                              if (plant)
                                editor.startArea({
                                  id: `neighborhood-${crypto.randomUUID()}`,
                                  name: plant.name || "Plant area",
                                  geometry: buildingGeometry(plant),
                                  sourceId: USER_ACTIVITY_SOURCE.id,
                                });
                            }}
                          >
                            <option value="">
                              Choose an industrial or warehouse building
                            </option>
                            {plants.map((plant) => (
                              <option key={plant.id} value={plant.id}>
                                {plant.name || plant.id}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <div className="activity-area-list">
                        {draft.activity.neighborhoods.map((n) => (
                          <article key={n.id}>
                            <strong>{n.name}</strong>
                            <p>
                              {countLabel(
                                resolution?.neighborhoods.find(
                                  (r) => r.id === n.id,
                                )?.population.value,
                              )}{" "}
                              people ·{" "}
                              {countLabel(
                                resolution?.neighborhoods.find(
                                  (r) => r.id === n.id,
                                )?.employment.value,
                              )}{" "}
                              jobs
                            </p>
                            <div className="activity-actions">
                              <button
                                type="button"
                                className="button"
                                onClick={() => {
                                  editor.startArea(n);
                                  onFocus(n.id);
                                }}
                              >
                                Edit area
                              </button>
                              <button
                                type="button"
                                className="button subtle"
                                onClick={() => editor.removeArea(n.id)}
                              >
                                Remove area
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                  {tab === "demand" && (
                    <>
                      <h3>How should activity affect demand?</h3>
                      <p className="activity-note">
                        These are proportional sensitivities. Review the method
                        before enabling them. Effective residents and jobs also
                        feed eligible service costs and economic metrics.
                      </p>
                      <label className="activity-check">
                        <input
                          type="checkbox"
                          checked={draft.activity.demandResponse.reviewed}
                          onChange={(event) =>
                            editor.update({
                              ...draft.activity,
                              demandResponse: event.target.checked
                                ? {
                                    ...draft.activity.demandResponse,
                                    reviewed: true,
                                  }
                                : {
                                    ...draft.activity.demandResponse,
                                    reviewed: false,
                                    population: "none",
                                    employment: "none",
                                    vehicles: "none",
                                  },
                            })
                          }
                        />
                        <span>
                          I have reviewed proportional demand responses and
                          their limits.
                        </span>
                      </label>
                      <fieldset
                        className="permission-fields"
                        disabled={!draft.activity.demandResponse.reviewed}
                      >
                        <label className="activity-check">
                          <input
                            type="checkbox"
                            checked={
                              draft.activity.demandResponse.population !==
                              "none"
                            }
                            onChange={(event) =>
                              editor.update({
                                ...draft.activity,
                                demandResponse: {
                                  ...draft.activity.demandResponse,
                                  population: event.target.checked
                                    ? "proportional-residential"
                                    : "none",
                                },
                              })
                            }
                          />
                          <span>
                            Scale residential demand with effective population.
                          </span>
                        </label>
                        <label className="activity-check">
                          <input
                            type="checkbox"
                            checked={
                              draft.activity.demandResponse.employment !==
                              "none"
                            }
                            onChange={(event) =>
                              editor.update({
                                ...draft.activity,
                                demandResponse: {
                                  ...draft.activity.demandResponse,
                                  employment: event.target.checked
                                    ? "proportional-employment"
                                    : "none",
                                },
                              })
                            }
                          />
                          <span>
                            Scale eligible office, industrial and warehouse
                            demand with effective jobs.
                          </span>
                        </label>
                        <label className="activity-check">
                          <input
                            type="checkbox"
                            checked={
                              draft.activity.demandResponse.vehicles !== "none"
                            }
                            onChange={(event) =>
                              editor.update({
                                ...draft.activity,
                                demandResponse: {
                                  ...draft.activity.demandResponse,
                                  vehicles: event.target.checked
                                    ? "replace-residential-with-stock"
                                    : "none",
                                },
                              })
                            }
                          />
                          <span>
                            Use the household vehicle stock ratio for
                            residential demand.
                          </span>
                        </label>
                      </fieldset>
                      <div className="notice">
                        Vehicle stock replaces the population demand factor.
                        Choosing both does not multiply the two effects. Missing
                        or zero references can make affected outputs
                        unavailable.
                      </div>
                      <p className="activity-note">
                        Retail customer demand, school attendance and hospital
                        bed demand are not scaled with workforce changes. Mode
                        shares remain scenario assumptions; network assignment
                        and calibration require separate evidence.
                      </p>
                    </>
                  )}
                </>
              )}
            </fieldset>
            <div aria-live="polite">
              {editor.busy && (
                <p role="status">
                  {area
                    ? "Calculating the completed brush stroke…"
                    : "Checking the prepared reference…"}
                </p>
              )}
              {(editor.localError || presetError) && (
                <p role="alert" className="error-message">
                  {editor.localError || presetError}
                </p>
              )}
              {preview.error && !area && (
                <p role="alert" className="error-message">
                  {preview.error}
                </p>
              )}
            </div>
            <div className="activity-draft-actions">
              <div className="activity-actions">
                <button
                  type="button"
                  className="button"
                  disabled={
                    editor.busy ||
                    !draft.past.length ||
                    !!area?.coordinateText.trim()
                  }
                  onClick={editor.undo}
                >
                  <Undo2 size={14} />
                  Undo draft
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={
                    editor.busy ||
                    !draft.future.length ||
                    !!area?.coordinateText.trim()
                  }
                  onClick={editor.redo}
                >
                  <Redo2 size={14} />
                  Redo
                </button>
              </div>
              <div className="activity-actions">
                <button
                  type="button"
                  className="button"
                  disabled={editor.busy}
                  onClick={area ? editor.discardArea : editor.discard}
                >
                  {area ? "Discard area edit" : "Discard controls"}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={
                    editor.busy ||
                    !!(area
                      ? area.coordinateText.trim() ||
                        !editor.areaPreview.geometry
                      : preview.error || preview.updating)
                  }
                >
                  <Check size={15} />
                  {area ? "Keep area in draft" : "Apply People controls"}
                </button>
              </div>
            </div>
          </form>
          {!area && (
            <details className="activity-preview">
              <summary>Resulting counts · draft</summary>
              <div aria-busy={preview.updating}>
                {preview.updating ? (
                  <p role="status">Updating counts…</p>
                ) : (
                  resolution && (
                    <ActivitySummary
                      resolution={resolution}
                      activity={draft.activity}
                    />
                  )
                )}
              </div>
            </details>
          )}
          {dialog &&
            ["population", "employment", "vehicles"].includes(dialog) && (
              <ReferenceDialog
                dimension={dialog as ReferenceDimension}
                activity={draft.activity}
                place={place}
                onApply={editor.update}
                onClose={() => setDialog(null)}
              />
            )}
          {dialog === "forecast" && (
            <ForecastDialog
              activity={draft.activity}
              onApply={(activity, sources) =>
                editor.update(activity, sources, 10)
              }
              onClose={() => setDialog(null)}
            />
          )}
          {dialog === "closure" && resolution && (
            <ClosureDialog
              activity={draft.activity}
              resolution={resolution}
              onApply={editor.update}
              onClose={() => setDialog(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

function VehicleSource({
  activity,
  place,
}: {
  activity: ActivityScenario;
  place: Place;
}) {
  const reference = activity.vehicleReference ?? place.vehicleAvailability;
  return reference ? (
    <details className="activity-source">
      <summary>Household vehicle source & uncertainty</summary>
      <p>
        {reference.geography.name} · ACS {reference.period.start}–
        {reference.period.end}
      </p>
      <p>
        {countLabel(reference.measure.estimate.value)} vehicles ±{" "}
        {countLabel(reference.measure.marginOfError.value)} (90% margin of
        error). Scenario outputs do not propagate this sampling uncertainty.
      </p>
      <a
        href={
          /^https?:\/\//i.test(reference.source.url)
            ? reference.source.url
            : undefined
        }
        target="_blank"
        rel="noreferrer"
      >
        {reference.source.name}
      </a>
      <ul>
        {reference.notes.map((note, i) => (
          <li key={i}>{note}</li>
        ))}
      </ul>
    </details>
  ) : null;
}
function AreaEditor({ editor }: { editor: ActivityEditorController }) {
  const { area, draft } = editor;
  if (!area || !draft) return null;
  const resolved = editor.preview.resolution?.neighborhoods.find(
    (n) => n.id === area.id,
  );
  const path = activeAreaPath(area),
    pending = !!area.coordinateText.trim();
  return (
    <div
      className="activity-area-editor"
      aria-label="Neighborhood drawing editor"
    >
      <h3>Give this neighborhood a shape.</h3>
      <label className="field">
        <span>Neighborhood name</span>
        <input
          value={area.name}
          required
          maxLength={240}
          onChange={(event) => editor.patchArea({ name: event.target.value })}
        />
      </label>
      <div
        className="activity-drawing-modes"
        aria-label="Neighborhood drawing mode"
      >
        {(
          [
            { id: "paint", label: "Paint", icon: Brush },
            { id: "erase", label: "Erase", icon: Eraser },
            { id: "draw", label: "Draw", icon: Plus },
            { id: "reshape", label: "Reshape", icon: Pencil },
            { id: "pan", label: "Pan", icon: Hand },
          ] as const
        ).map((mode) => (
          <button
            type="button"
            key={mode.id}
            disabled={pending}
            aria-pressed={area.mode === mode.id}
            onClick={() => editor.patchArea({ mode: mode.id }, false)}
          >
            <mode.icon size={17} />
            {mode.label}
          </button>
        ))}
      </div>
      {area.mode === "paint" || area.mode === "erase" ? (
        <>
          <ActivityNumber
            label="Brush radius (meters)"
            value={area.brushRadiusMeters}
            min={5}
            max={1000}
            step={1}
            onChange={(brushRadiusMeters) =>
              editor.patchArea({ brushRadiusMeters }, false)
            }
          />
          <p className="activity-note">
            Click for a disk or drag a stroke. Each finished stroke is one undo
            step. Painting clips to the study boundary and excludes other
            neighborhoods.
          </p>
        </>
      ) : (
        <p className="activity-note">
          {area.mode === "draw"
            ? "Click the map to add corners to the active ring."
            : area.mode === "reshape"
              ? "Select a point and drag to reshape. Coordinates below offer a precise alternative."
              : "Pan and zoom without changing the boundary."}{" "}
          Keep the area when its boundary is ready.
        </p>
      )}
      {editor.brushResult && editor.brushResult.excludedAreaSqm > 0 && (
        <p role="status" className="activity-warning">
          Excluded {countLabel(editor.brushResult.excludedAreaSqm)} m², shown in
          amber: {countLabel(editor.brushResult.excludedStudyAreaSqm)} m²
          outside the study area and{" "}
          {countLabel(editor.brushResult.excludedNeighborhoodAreaSqm)} m² inside
          other neighborhoods.
        </p>
      )}
      <details className="activity-precision">
        <summary>Precise boundary, holes & parts</summary>
        <label className="field">
          <span>Active boundary ring</span>
          <select
            disabled={pending}
            value={area.activeRingId ?? ""}
            onChange={(event) =>
              editor.patchArea(
                { activeRingId: event.target.value, selectedVertexIndex: null },
                false,
              )
            }
          >
            {area.rings.map((ring) => (
              <option value={ring.id} key={ring.id}>
                Part {ring.partIndex + 1} ·{" "}
                {ring.ringIndex === 0
                  ? "outer boundary"
                  : `hole ${ring.ringIndex}`}{" "}
                · {ring.coordinates.length} points
              </option>
            ))}
          </select>
        </label>
        <div className="activity-actions">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => editor.addRing(true)}
          >
            Add hole
          </button>
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => editor.addRing(false)}
          >
            Add part
          </button>
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={editor.removeRing}
          >
            Remove ring
          </button>
        </div>
        <label className="field">
          <span>Ring coordinates (longitude, latitude)</span>
          <textarea
            rows={6}
            value={area.coordinateText}
            placeholder="One longitude, latitude pair per line"
            onChange={(event) =>
              editor.patchArea({ coordinateText: event.target.value }, false)
            }
          />
        </label>
        <div className="activity-actions">
          <button
            type="button"
            className="button"
            disabled={!pending}
            onClick={editor.useCoordinates}
          >
            Use coordinates
          </button>
          <button
            type="button"
            className="button"
            disabled={!pending}
            onClick={() => editor.patchArea({ coordinateText: "" }, false)}
          >
            Discard coordinate text
          </button>
        </div>
        <button
          type="button"
          className="activity-reference-link"
          disabled={pending || !path.length}
          onClick={() =>
            editor.patchArea(
              {
                coordinateText: path
                  .map((point) => point.join(", "))
                  .join("\n"),
              },
              false,
            )
          }
        >
          Load current ring into text
        </button>
        {!!path.length && (
          <label className="field">
            <span>Selected boundary point</span>
            <select
              disabled={pending}
              value={area.selectedVertexIndex ?? ""}
              onChange={(event) =>
                event.target.value !== "" &&
                editor.vertexSelect(
                  area.activeRingId!,
                  Number(event.target.value),
                )
              }
            >
              <option value="">Choose a point</option>
              {path.map((point, index) => (
                <option key={index} value={index}>
                  {index + 1}: {point.map((n) => n.toFixed(6)).join(", ")}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="button"
          disabled={pending || area.selectedVertexIndex === null}
          onClick={() => editor.removeVertex()}
        >
          Remove selected point
        </button>
        <p className="activity-note">
          Up to 500 points per ring, 5,000 vertices per area and 50,000 across
          all areas. Geometry is never silently simplified.
        </p>
      </details>
      {!editor.areaPreview.geometry && (
        <p className="activity-note">
          {editor.areaPreview.error ?? "Paint or draw a boundary to begin."}
        </p>
      )}
      <TargetFields
        label="Area population"
        scope="area"
        target={area.population}
        reference={resolved?.population.reference}
        onChange={(population) => editor.patchArea({ population })}
      />
      <TargetFields
        label="Area workplace jobs"
        scope="area"
        target={area.employment}
        reference={resolved?.employment.reference}
        onChange={(employment) => editor.patchArea({ employment })}
      />
      <p className="activity-note">
        Keep this area in the draft to calculate its allocated reference and
        resulting counts. Apply People controls to update the scenario. Erasing
        every part leaves an empty draft; removing a saved area is a separate
        action.
      </p>
    </div>
  );
}
