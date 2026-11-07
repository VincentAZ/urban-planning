import { useEffect, useMemo, useState } from "react";
import type {
  TrafficCountPack,
  TrafficNetwork,
  TrafficPeriod,
} from "@urban/core";
import {
  inspectTrafficCalibrationSelection,
  trafficCalibrationSelectionGroups,
} from "@urban/models";
import {
  assignTrafficCalibrationGroup,
  newTrafficCalibrationDraft,
  readTrafficCalibrationDraft,
  trafficCriteriaFields,
  type TrafficCalibrationDraft,
} from "../../lib/traffic-calibration-draft";
import type { TrafficSourceDeclaration } from "../../lib/traffic-draft";
import { TrafficField, TrafficNumber } from "./TrafficFields";
import { newDeclaration, TrafficSourceForm } from "./TrafficSourceForm";
import "./traffic-calibration.css";

export function TrafficCalibrationPanel({
  value,
  onChange,
  pack,
  network,
  period,
  periodError,
  pendingMappingCountIds,
  canEdit,
  onAddSource,
  onDirtyChange,
}: {
  value: TrafficCalibrationDraft | null;
  onChange: (value: TrafficCalibrationDraft | null) => void;
  pack: TrafficCountPack;
  network: TrafficNetwork | null;
  period: TrafficPeriod | null;
  periodError: string;
  pendingMappingCountIds: readonly string[];
  canEdit: boolean;
  onAddSource: (source: TrafficSourceDeclaration) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [adding, setAdding] = useState(false),
    [source, setSource] = useState(newDeclaration);
  useEffect(() => {
    onDirtyChange(adding);
    return () => onDirtyChange(false);
  }, [adding, onDirtyChange]);
  useEffect(() => {
    if (!canEdit) {
      setAdding(false);
      setSource(newDeclaration());
    }
  }, [canEdit]);
  const inspection = useMemo(() => {
    if (!value || !network || !period) return { selection: null, error: "" };
    try {
      const plan = readTrafficCalibrationDraft(value)!;
      return {
        selection: inspectTrafficCalibrationSelection(
          pack,
          plan,
          network,
          period,
          { pendingMappingCountIds },
        ),
        error: "",
      };
    } catch (failure) {
      return { selection: null, error: (failure as Error).message };
    }
  }, [value, pack, network, period, pendingMappingCountIds]);
  const groups = useMemo(
    () =>
      network && period
        ? trafficCalibrationSelectionGroups(pack, network, period, {
            pendingMappingCountIds,
          })
        : [],
    [pack, network, period, pendingMappingCountIds],
  );
  const countById = useMemo(
    () => new Map(pack.counts.map((count) => [count.id, count])),
    [pack],
  );
  const checkById = useMemo(
    () =>
      new Map(
        inspection.selection?.rows.map((row) => [row.countId, row]) ?? [],
      ),
    [inspection],
  );
  const sourceReady =
    source.name.trim() &&
    source.vintage.trim() &&
    source.license.trim() &&
    source.privateUseConfirmed &&
    (!source.url || /^https?:\/\//i.test(source.url));
  return (
    <section
      className="traffic-card traffic-calibration"
      id="traffic-count-validation"
    >
      <span className="eyebrow">4 · BASELINE COUNT CHECK</span>
      <h3>Decide what a useful fit means.</h3>
      <p className="traffic-muted">
        Choose observations and acceptance criteria before running. This
        compares simulated baseline detector passages with observations; it does
        not automatically fit demand. The proposal uses the same demand.
      </p>
      {!value ? (
        <>
          <p className="traffic-empty">
            Count fit is not assessed until you add a plan. All source
            observations remain available for review.
          </p>
          <button
            type="button"
            className="button"
            disabled={!canEdit}
            onClick={() => onChange(newTrafficCalibrationDraft())}
          >
            Add baseline count-check plan
          </button>
        </>
      ) : (
        <fieldset disabled={!canEdit}>
          <legend>Study-specific count-check plan</legend>
          <p className="traffic-muted">
            Calibration observations may inform your demand assumptions.
            Held-out observations should be set aside from that work. Keeping
            groups separate reduces obvious overlap; this app cannot establish
            that you have never used the held-out data.
          </p>
          <div className="traffic-stats">
            <div>
              <strong>{value.calibrationCountIds.length}</strong>
              <span>calibration intervals selected</span>
            </div>
            <div>
              <strong>{value.holdoutCountIds.length}</strong>
              <span>held-out intervals selected</span>
            </div>
            <div>
              <strong>
                {inspection.selection?.rows.filter(
                  (row) =>
                    row.eligible &&
                    (row.role === "calibration" || row.role === "holdout"),
                ).length ?? "—"}
              </strong>
              <span>selected intervals ready for comparison</span>
            </div>
          </div>
          <h4>Keep related observations together</h4>
          <p className="traffic-muted">
            Roles apply to a whole station/direction/day group inside this
            analysis period, including its lanes and vehicle classes. Related
            reviewed targets on the same directed edge are grouped together.
            Other dates require a separate run.
          </p>
          {periodError && (
            <p role="status" className="traffic-warning">
              {periodError} Correct the period before selecting observations.
            </p>
          )}
          {!network && (
            <p className="traffic-empty">
              Prepare a traffic network to review count-check groups.
            </p>
          )}
          {network && period && !groups.length && (
            <p className="traffic-empty">
              No retained intervals fall wholly within this date, time zone, UTC
              offset and time window. Change the period or add matching
              evidence.
            </p>
          )}
          <div
            className="traffic-validation-groups"
            aria-label="Count-check observation groups"
          >
            {groups.map((group) => {
              const calibration = group.countIds.filter((id) =>
                value.calibrationCountIds.includes(id),
              ).length;
              const holdout = group.countIds.filter((id) =>
                value.holdoutCountIds.includes(id),
              ).length;
              const role =
                calibration && holdout
                  ? "conflict"
                  : calibration
                    ? "calibration"
                    : holdout
                      ? "holdout"
                      : "context";
              const records = group.countIds
                .map((id) => countById.get(id)!)
                .filter(Boolean);
              const label = [
                ...new Set(records.map((count) => count.stationId)),
              ].join(" / ");
              return (
                <article key={group.key} className="traffic-validation-group">
                  <div>
                    <strong>{label}</strong>
                    <p>
                      {records[0]?.date} · direction{" "}
                      {records[0]?.raw.directionCode || "unknown"} ·{" "}
                      {group.countIds.length} interval records
                    </p>
                    {calibration + holdout > 0 &&
                      calibration + holdout < group.countIds.length && (
                        <small>
                          Earlier selection includes {calibration + holdout} of
                          these records. Choosing a role applies it to the whole
                          group.
                        </small>
                      )}
                  </div>
                  <TrafficField
                    label={`Role for ${label} direction ${records[0]?.raw.directionCode || "unknown"}`}
                  >
                    {({ id }) => (
                      <select
                        id={id}
                        value={role}
                        onChange={(event) =>
                          onChange(
                            assignTrafficCalibrationGroup(
                              value,
                              group.countIds,
                              event.target.value as
                                | "calibration"
                                | "holdout"
                                | "context",
                            ),
                          )
                        }
                      >
                        {role === "conflict" && (
                          <option value="conflict" disabled>
                            Conflicting roles — review
                          </option>
                        )}
                        <option value="context">Context only</option>
                        <option value="calibration">Calibration</option>
                        <option value="holdout">Held out</option>
                      </select>
                    )}
                  </TrafficField>
                  <details>
                    <summary>
                      Inspect {group.countIds.length} retained intervals
                    </summary>
                    <ul>
                      {records.map((count) => {
                        const check = checkById.get(count.id);
                        return (
                          <li key={count.id}>
                            <strong>{count.id}</strong> · lane{" "}
                            {count.raw.laneCode || "unknown"} ·{" "}
                            {count.status === "available"
                              ? count.value
                              : count.status}{" "}
                            vehicles
                            {check?.reasons.length ? (
                              <span> · {check.reasons.join("; ")}</span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </article>
              );
            })}
          </div>
          <h4>Enter your acceptance criteria</h4>
          <p className="traffic-muted">
            No agency standard is assumed. An interval passes when GEH is within
            its limit and either absolute hourly error or relative error is
            within its limit. Every selected observation must be evaluable; each
            set must meet its minimum size and passing percentage.
          </p>
          <div className="traffic-field-grid">
            {trafficCriteriaFields.map(({ key, label, hint }) => (
              <TrafficNumber
                key={key}
                label={label}
                hint={hint}
                value={value.criteria[key]}
                onChange={(text) =>
                  onChange({
                    ...value,
                    criteria: { ...value.criteria, [key]: text },
                  })
                }
              />
            ))}
          </div>
          <TrafficField
            label="Count-check study rationale"
            hint="Explain why these tolerances and groups suit this study, how held-out evidence was set aside, and any remaining coverage limits."
          >
            {({ id, describedBy }) => (
              <textarea
                id={id}
                aria-describedby={describedBy}
                rows={4}
                maxLength={3500}
                value={value.description}
                onChange={(event) =>
                  onChange({ ...value, description: event.target.value })
                }
              />
            )}
          </TrafficField>
          <fieldset>
            <legend>Sources for these criteria</legend>
            <p className="traffic-muted">
              Select evidence that supports the criteria, or add your own
              authored study protocol. A count-data source does not
              automatically endorse a tolerance.
            </p>
            {pack.sources.map((item) => (
              <label key={item.id} className="traffic-check">
                <input
                  type="checkbox"
                  checked={value.sourceIds.includes(item.id)}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      sourceIds: event.target.checked
                        ? [...value.sourceIds, item.id]
                        : value.sourceIds.filter((id) => id !== item.id),
                    })
                  }
                />
                <span>
                  {item.name} · {item.vintage}
                </span>
              </label>
            ))}
          </fieldset>
          {adding ? (
            <div className="traffic-card">
              <TrafficSourceForm
                value={source}
                onChange={setSource}
                disabled={!canEdit}
                prefix="Criteria"
              />
              <div className="traffic-actions">
                <button
                  type="button"
                  className="button"
                  disabled={!sourceReady}
                  onClick={() => {
                    onAddSource(source);
                    setAdding(false);
                    setSource(newDeclaration());
                  }}
                >
                  Add criteria citation to review
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setAdding(false);
                    setSource(newDeclaration());
                  }}
                >
                  Discard criteria citation
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="button"
              onClick={() => setAdding(true)}
            >
              Add criteria source
            </button>
          )}
          {inspection.error && (
            <p className="traffic-warning" role="status">
              {inspection.error}
            </p>
          )}
          {!!inspection.selection?.errors.length && (
            <div className="traffic-warning" role="status">
              <strong>Review before saving</strong>
              <ul>
                {inspection.selection.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          {!!inspection.selection?.warnings.length && (
            <details className="traffic-validation-readiness">
              <summary>
                Evidence readiness ({inspection.selection.warnings.length})
              </summary>
              <ul>
                {inspection.selection.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="traffic-muted">
            Saving retains the exact selection, criteria and inputs as a new
            configuration. Changing them later creates another configuration. A
            passing count check covers these intervals only; it does not
            validate the whole ZIP, travel times, queues or intersection level
            of service.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              onChange(null);
              setAdding(false);
              setSource(newDeclaration());
            }}
          >
            Remove count-check plan from draft
          </button>
        </fieldset>
      )}
    </section>
  );
}
