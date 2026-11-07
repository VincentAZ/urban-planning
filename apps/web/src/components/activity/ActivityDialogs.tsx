import { useState, type FormEvent } from "react";
import {
  activityForecastSchema,
  activityReferenceChoiceSchema,
  type ActivityForecast,
  type ActivityReferenceChoice,
  type ActivityScenario,
  type Place,
  type Source,
} from "@urban/core";
import { applyActivityPreset, type ActivityResolution } from "@urban/models";
import { Modal } from "../Modal";
import { countLabel } from "./ActivitySummary";

function sourceFrom(form: FormData, vintage: string): Source {
  const name = String(form.get("sourceName") ?? "").trim();
  const url = String(form.get("sourceUrl") ?? "").trim();
  if (!name) throw new Error("Name the source or describe your own estimate.");
  if (url && !/^https?:\/\//i.test(url))
    throw new Error("Source links must begin with https:// or http://.");
  return {
    id: `activity-source-${crypto.randomUUID()}`,
    name,
    url,
    vintage,
    kind: "user-supplied",
    license: "User-supplied reference; verify original reuse terms",
    description:
      "Entered by the scenario author. The app has not independently verified this source or its applicability.",
  };
}
function SourceFields({ source }: { source?: Source }) {
  return (
    <>
      <label className="field">
        <span>Source name or description</span>
        <input
          name="sourceName"
          defaultValue={source?.name}
          required
          maxLength={240}
          placeholder="Agency projection, workforce record, or my estimate"
        />
      </label>
      <label className="field">
        <span>Source URL (if available)</span>
        <input
          name="sourceUrl"
          defaultValue={source?.url}
          type="url"
          maxLength={4000}
          placeholder="https://…"
        />
      </label>
    </>
  );
}
export function ReferenceDialog({
  dimension,
  activity,
  place,
  sources = [],
  onApply,
  onClose,
}: {
  dimension: "population" | "employment" | "vehicles";
  activity: ActivityScenario;
  place: Place;
  sources?: Source[];
  onApply: (activity: ActivityScenario, sources?: Source[]) => void;
  onClose: () => void;
}) {
  const current = activity.reference[dimension];
  const [kind, setKind] = useState<ActivityReferenceChoice["kind"]>(
    current?.kind ?? "entered",
  );
  const [error, setError] = useState("");
  const label =
    dimension === "population"
      ? "Population"
      : dimension === "employment"
        ? "Workplace jobs"
        : "Household vehicles";
  const published =
    dimension === "population"
      ? !!place.demographics
      : dimension === "vehicles"
        ? !!(activity.vehicleReference ?? place.vehicleAvailability)
        : false;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      let choice: ActivityReferenceChoice;
      let source: Source | undefined;
      if (kind === "entered") {
        const asOfYear = Number(data.get("year"));
        source = sourceFrom(data, String(asOfYear));
        choice = {
          kind,
          value: Number(data.get("count")),
          asOfYear,
          universe: String(data.get("universe")).trim(),
          sourceId: source.id,
        };
      } else choice = { kind };
      const checked = activityReferenceChoiceSchema.safeParse(choice);
      if (!checked.success) throw new Error(checked.error.issues[0].message);
      onApply(
        {
          ...activity,
          reference: { ...activity.reference, [dimension]: choice },
        },
        source ? [source] : undefined,
      );
      onClose();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Modal
      title={`${label}: choose the reference`}
      description="Percent targets always use this captured year-zero reference."
      open
      onClose={onClose}
    >
      <form className="activity-dialog-form" onSubmit={submit}>
        <label className="field">
          <span>Reference method</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            {dimension !== "vehicles" && (
              <option value="building-derived">
                Building-derived estimate
              </option>
            )}
            {published && (
              <option value="published">
                Captured published Census estimate
              </option>
            )}
            <option value="entered">Enter a sourced reference</option>
          </select>
        </label>
        {kind === "published" && (
          <p className="notice">
            A published reference is usable only when its complete geography
            matches this study area. Its source period remains visible; it is
            not a current-year count.
          </p>
        )}
        {kind === "building-derived" && (
          <p className="notice">
            {dimension === "employment"
              ? "Building job estimates are workplace capacity; employed residents from Census are a different quantity."
              : "Homes, vacancy and household size give a housing-supported population. They do not establish observed occupancy."}
          </p>
        )}
        {kind === "entered" && (
          <>
            <div className="activity-two-fields">
              <label className="field">
                <span>{label} reference count</span>
                <input
                  type="number"
                  name="count"
                  required
                  min={0}
                  max={1e9}
                  step="any"
                  defaultValue={
                    current?.kind === "entered" ? current.value : undefined
                  }
                />
              </label>
              <label className="field">
                <span>Reference year</span>
                <input
                  type="number"
                  name="year"
                  required
                  min={1900}
                  max={2200}
                  defaultValue={
                    current?.kind === "entered" ? current.asOfYear : undefined
                  }
                  placeholder="YYYY"
                />
              </label>
            </div>
            <label className="field">
              <span>Geography and population covered</span>
              <textarea
                name="universe"
                required
                maxLength={500}
                rows={3}
                defaultValue={
                  current?.kind === "entered" ? current.universe : undefined
                }
                placeholder={
                  dimension === "vehicles"
                    ? "Household vehicles available within the study boundary"
                    : "Describe the complete study boundary and who or what was counted"
                }
              />
            </label>
            <SourceFields
              source={
                current?.kind === "entered"
                  ? sources.find((source) => source.id === current.sourceId)
                  : undefined
              }
            />
            <p className="activity-note">
              Entered values retain your source description and are labeled user
              supplied.{" "}
              {dimension === "vehicles"
                ? "Use household vehicle stock, not daily traffic, trips, or registered fleet totals."
                : dimension === "employment"
                  ? "Count jobs located here, not employed people who live here."
                  : "Use the same population universe across the reference and scenario."}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit">
            Use reference in draft
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ForecastDialog({
  activity,
  onApply,
  onClose,
}: {
  activity: ActivityScenario;
  onApply: (activity: ActivityScenario, sources: Source[]) => void;
  onClose: () => void;
}) {
  const [application, setApplication] =
    useState<ActivityForecast["application"]>("regional-ratio");
  const [included, setIncluded] = useState(["population"]);
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget),
        baseYear = Number(data.get("baseYear")),
        targetYear = Number(data.get("targetYear"));
      const source = sourceFrom(data, `${baseYear}–${targetYear}`);
      const forecast: ActivityForecast = {
        sourceId: source.id,
        geography: String(data.get("geography")).trim(),
        baseYear,
        targetYear,
        application,
      };
      for (const key of [
        "population",
        "employment",
        "householdVehicles",
      ] as const)
        if (included.includes(key))
          forecast[key] = {
            baseline: Number(data.get(`${key}Base`)),
            target: Number(data.get(`${key}Target`)),
          };
      const parsed = activityForecastSchema.safeParse(forecast);
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      const next = applyActivityPreset(
        { ...activity, forecast },
        { kind: "regional-forecast-10" },
      );
      onApply(next, [source]);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Modal
      title="+10 years at a sourced forecast"
      description="Supply an actual ten-year projection. No regional forecast is built in."
      open
      wide
      onClose={onClose}
    >
      <form onSubmit={submit} className="activity-dialog-form">
        <SourceFields />
        <label className="field">
          <span>Forecast geography</span>
          <input
            name="geography"
            required
            maxLength={500}
            placeholder="Agency, region or matching study area"
          />
        </label>
        <div className="activity-two-fields">
          <label className="field">
            <span>Forecast base year</span>
            <input
              name="baseYear"
              type="number"
              required
              min={1900}
              max={2190}
            />
          </label>
          <label className="field">
            <span>Forecast target year</span>
            <input
              name="targetYear"
              type="number"
              required
              min={1910}
              max={2200}
            />
          </label>
        </div>
        <label className="field">
          <span>How this forecast applies</span>
          <select
            value={application}
            onChange={(event) =>
              setApplication(event.target.value as typeof application)
            }
          >
            <option value="regional-ratio">
              Apply a wider region’s growth ratio locally
            </option>
            <option value="matching-area-totals">
              Exact same-area target totals
            </option>
          </select>
        </label>
        <p className="notice">
          {application === "regional-ratio"
            ? "Using regional growth for this study area is your local assumption. The app does not claim the agency forecast was prepared for this boundary."
            : "Confirm that the source geography and population definitions match this complete study area."}{" "}
          This preset sets the scenario horizon to 10 years when you apply the
          controls. Existing neighborhood exceptions remain.
        </p>
        {(
          [
            ["population", "Population"],
            ["employment", "Workplace jobs"],
            ["householdVehicles", "Household vehicles"],
          ] as const
        ).map(([key, label]) => (
          <fieldset className="activity-target" key={key}>
            <legend>
              <label>
                <input
                  type="checkbox"
                  checked={included.includes(key)}
                  onChange={(event) =>
                    setIncluded(
                      event.target.checked
                        ? [...included, key]
                        : included.filter((item) => item !== key),
                    )
                  }
                />{" "}
                {label}
              </label>
            </legend>
            {included.includes(key) && (
              <div className="activity-two-fields">
                <label className="field">
                  <span>{label} at base year</span>
                  <input
                    name={`${key}Base`}
                    type="number"
                    required
                    min={application === "regional-ratio" ? 0.000001 : 0}
                    max={1e9}
                    step="any"
                  />
                </label>
                <label className="field">
                  <span>{label} at target year</span>
                  <input
                    name={`${key}Target`}
                    type="number"
                    required
                    min={0}
                    max={1e9}
                    step="any"
                  />
                </label>
              </div>
            )}
          </fieldset>
        ))}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!included.length}
          >
            Use forecast in draft
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ClosureDialog({
  activity,
  resolution,
  onApply,
  onClose,
}: {
  activity: ActivityScenario;
  resolution: ActivityResolution;
  onApply: (activity: ActivityScenario, sources: Source[]) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(activity.neighborhoods[0]?.id ?? "");
  const [error, setError] = useState("");
  const current = resolution.neighborhoods.find((n) => n.id === id)?.employment
    .value;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (current == null)
        throw new Error(
          "Establish a usable employment count for the selected area first.",
        );
      const data = new FormData(event.currentTarget),
        source = sourceFrom(data, String(new Date().getFullYear()));
      const next = applyActivityPreset(activity, {
        kind: "plant-closure",
        neighborhoodId: id,
        currentEmployment: current,
        jobsRemoved: Number(data.get("jobs")),
      });
      next.preset = { ...next.preset!, sourceId: source.id };
      if (data.get("demand"))
        next.demandResponse = {
          ...next.demandResponse,
          employment: "proportional-employment",
          reviewed: true,
          sourceId: source.id,
        };
      onApply(next, [source]);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Modal
      title="Post-plant-closure scenario"
      description="Remove documented workplace activity while retaining the physical building and its value."
      open
      onClose={onClose}
    >
      <form className="activity-dialog-form" onSubmit={submit}>
        <label className="field">
          <span>Plant or employment area</span>
          <select
            value={id}
            onChange={(event) => setId(event.target.value)}
            required
          >
            <option value="" disabled>
              Select a defined area
            </option>
            {activity.neighborhoods.map((n) => (
              <option value={n.id} key={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <p>
          Current modeled employment in this area:{" "}
          <strong>{countLabel(current)}</strong>.
        </p>
        <label className="field">
          <span>Documented jobs removed</span>
          <input
            type="number"
            name="jobs"
            required
            min={0}
            max={current ?? 0}
            step="any"
          />
        </label>
        <SourceFields />
        <label className="activity-check">
          <input type="checkbox" name="demand" />
          <span>
            I have reviewed the proportional response: scale eligible office,
            industrial and warehouse operating demand with effective employment.
          </span>
        </label>
        <p className="activity-note">
          Retail customers, school attendance and hospital demand are not scaled
          by this workforce change. This preset does not assume layoffs become
          out-migration, or invent indirect employment losses.
        </p>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={current == null}
          >
            Use closure in draft
          </button>
        </div>
      </form>
    </Modal>
  );
}
