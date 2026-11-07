import { useState, useEffect } from "react";
import { newDeclaration, TrafficSourceForm } from "./TrafficSourceForm";
import type { TrafficSourceDeclaration } from "../../lib/traffic-draft";
import type {
  TrafficDemand,
  TrafficNetwork,
  TrafficPeriod,
} from "../../../../../packages/core/src/traffic";
import { Plus, Trash2 } from "lucide-react";
import { trafficClasses, readTrafficClock } from "../../lib/traffic-draft";
import { trafficNumericCell } from "../../lib/traffic-csv";
import {
  trafficDemandClock,
  readTrafficDemandClock,
} from "../../lib/traffic-demand-clock";
import {
  TrafficField,
  TrafficNumber,
  TrafficText,
  trafficClock,
} from "./TrafficFields";
export interface TrafficPeriodDraft {
  date: string;
  timeZone: string;
  utcOffsetMinutes: string;
  begin: string;
  end: string;
  warmupSeconds: string;
  cooldownSeconds: string;
}
export const periodDraft = (period: TrafficPeriod): TrafficPeriodDraft => ({
  date: period.date,
  timeZone: period.timeZone,
  utcOffsetMinutes: String(period.utcOffsetMinutes),
  begin: trafficClock(period.beginSeconds),
  end: trafficClock(period.endSeconds),
  warmupSeconds: String(period.warmupSeconds),
  cooldownSeconds: String(period.cooldownSeconds),
});
export function readPeriodDraft(value: TrafficPeriodDraft): TrafficPeriod {
  const number = (text: string, label: string) => {
    const value = trafficNumericCell(text, label);
    if (value === null || !Number.isInteger(value))
      throw new Error(`${label}: enter a whole number.`);
    return value;
  };
  const period = {
    date: value.date,
    timeZone: value.timeZone.trim(),
    utcOffsetMinutes: number(value.utcOffsetMinutes, "UTC offset"),
    beginSeconds: readTrafficClock(value.begin, "Analysis start"),
    endSeconds: readTrafficClock(value.end, "Analysis end"),
    warmupSeconds: number(value.warmupSeconds, "Warmup seconds"),
    cooldownSeconds: number(value.cooldownSeconds, "Cooldown seconds"),
  };
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(period.date) ||
    Number.isNaN(Date.parse(`${period.date}T00:00:00Z`)) ||
    new Date(`${period.date}T00:00:00Z`).toISOString().slice(0, 10) !==
      period.date
  )
    throw new Error("Enter a real analysis date.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: period.timeZone }).format();
  } catch {
    throw new Error(
      "Enter a valid IANA time zone, for example America/Phoenix.",
    );
  }
  if (period.endSeconds <= period.beginSeconds)
    throw new Error(
      "Analysis end must follow its start; split overnight periods explicitly.",
    );
  if (
    period.utcOffsetMinutes < -840 ||
    period.utcOffsetMinutes > 840 ||
    period.warmupSeconds < 0 ||
    period.cooldownSeconds < 0
  )
    throw new Error(
      "Review the UTC offset and nonnegative warmup/cooldown seconds.",
    );
  return period;
}
export interface TrafficODDraft {
  row: TrafficDemand["rows"][number];
  vehicles: string;
  begin: string;
  end: string;
}
export interface TrafficRouteDraft {
  route: TrafficDemand["candidateRoutes"][number];
  weight: string;
  edgeText: string;
}
export const routeDraft = (demand: TrafficDemand): TrafficRouteDraft[] =>
  demand.candidateRoutes.map((route) => ({
    route,
    weight: String(route.weight),
    edgeText: route.edges.join("\n"),
  }));
export function demandDraft(demand: TrafficDemand): TrafficODDraft[] {
  return demand.rows.map((row) => ({
    row,
    vehicles: String(row.vehicles),
    begin: trafficDemandClock(row.beginSeconds),
    end: trafficDemandClock(row.endSeconds),
  }));
}
export function readDemandDraft(
  rows: TrafficODDraft[],
  original: TrafficDemand,
  routes: TrafficRouteDraft[],
): TrafficDemand {
  return {
    ...original,
    candidateRoutes: routes
      .filter((value) => rows.some((row) => row.row.id === value.route.odId))
      .map((value) => {
        const weight = trafficNumericCell(
          value.weight,
          "Candidate route weight",
        );
        if (weight === null || weight <= 0)
          throw new Error(
            "Each candidate route needs a positive relative weight.",
          );
        return {
          ...value.route,
          weight,
          edges: value.edgeText.split(/\s+/).filter(Boolean),
        };
      }),
    rows: rows.map((value) => {
      const vehicles = trafficNumericCell(
        value.vehicles,
        "One-way vehicle trips",
      );
      if (vehicles === null || vehicles < 0 || !Number.isSafeInteger(vehicles))
        throw new Error(
          "Enter a nonnegative whole number of one-way vehicle trips for every OD row.",
        );
      return {
        ...value.row,
        vehicles,
        beginSeconds: readTrafficDemandClock(
          value.begin,
          value.row.beginSeconds,
          "OD interval start",
        ),
        endSeconds: readTrafficDemandClock(
          value.end,
          value.row.endSeconds,
          "OD interval end",
        ),
      };
    }),
  };
}

export function TrafficPeriodPanel({
  period,
  seed,
  onSeedChange,
  onPeriodChange,
  canEdit,
  periodLocked = false,
}: {
  period: TrafficPeriodDraft;
  seed: string;
  onSeedChange: (value: string) => void;
  onPeriodChange: (value: TrafficPeriodDraft) => void;
  canEdit: boolean;
  periodLocked?: boolean;
}) {
  const patchPeriod = (patch: Partial<TrafficPeriodDraft>) =>
    onPeriodChange({ ...period, ...patch });
  return (
    <section className="traffic-card" id="traffic-count-period">
      <span className="eyebrow">1 · ANALYSIS PERIOD</span>
      <h3>Start with the same hour.</h3>
      <p className="traffic-muted">
        Choose the observation date and recorded clock. Baseline and proposal
        share this period and random seed.
      </p>
      <fieldset disabled={!canEdit}>
        <legend>Analysis period</legend>
        <div className="traffic-field-grid">
          <TrafficNumber
            label="Traffic random seed"
            value={seed}
            onChange={onSeedChange}
            hint="A nonnegative whole number shared by baseline and proposal. Retaining it makes the run reproducible."
          />
          <TrafficText
            label="Traffic analysis date"
            disabled={periodLocked}
            type="date"
            value={period.date}
            onChange={(date) => patchPeriod({ date })}
          />
          <TrafficText
            label="Traffic time zone"
            disabled={periodLocked}
            value={period.timeZone}
            onChange={(timeZone) => patchPeriod({ timeZone })}
            hint="Use the recorded IANA zone; do not infer it from the browser."
          />
          <TrafficNumber
            label="UTC offset (minutes)"
            disabled={periodLocked}
            value={period.utcOffsetMinutes}
            onChange={(utcOffsetMinutes) => patchPeriod({ utcOffsetMinutes })}
          />
          <TrafficText
            label="Traffic analysis start"
            disabled={periodLocked}
            value={period.begin}
            onChange={(begin) => patchPeriod({ begin })}
            hint="Recorded local-day HH:MM or HH:MM:SS."
          />
          <TrafficText
            label="Traffic analysis end"
            disabled={periodLocked}
            value={period.end}
            onChange={(end) => patchPeriod({ end })}
          />
          <TrafficNumber
            label="Warmup duration (seconds)"
            disabled={periodLocked}
            value={period.warmupSeconds}
            onChange={(warmupSeconds) => patchPeriod({ warmupSeconds })}
          />
          <TrafficNumber
            label="Cooldown duration (seconds)"
            disabled={periodLocked}
            value={period.cooldownSeconds}
            onChange={(cooldownSeconds) => patchPeriod({ cooldownSeconds })}
          />
        </div>
        <p className="traffic-muted">
          Daylight-saving offset changes require separate periods. Warmup trips
          and unfinished trips must remain separately accounted for.
        </p>
      </fieldset>
      {periodLocked && (
        <p className="traffic-muted">
          This clock is bound to the selected Census commute recipe. Make an
          editable copy of its demand to change the clock.
        </p>
      )}
    </section>
  );
}

export function TrafficDemandPanel({
  period,
  rows,
  onRowsChange,
  routes,
  onRoutesChange,
  demand,
  network,
  canEdit,
  onAddSource,
  onDirtyChange,
}: {
  period: TrafficPeriodDraft;
  rows: TrafficODDraft[];
  onRowsChange: (rows: TrafficODDraft[]) => void;
  routes: TrafficRouteDraft[];
  onRoutesChange: (value: TrafficRouteDraft[]) => void;
  demand: TrafficDemand;
  network: TrafficNetwork | null;
  canEdit: boolean;
  onAddSource: (value: TrafficSourceDeclaration) => void;
  onDirtyChange: (value: boolean) => void;
}) {
  const [addingSource, setAddingSource] = useState(false);
  const [source, setSource] = useState(newDeclaration);
  useEffect(() => {
    onDirtyChange(addingSource);
    return () => onDirtyChange(false);
  }, [addingSource, onDirtyChange]);
  useEffect(() => {
    if (!canEdit) {
      setAddingSource(false);
      setSource(newDeclaration());
    }
  }, [canEdit]);
  const sourceReady =
    source.name.trim() &&
    source.vintage.trim() &&
    source.license.trim() &&
    source.privateUseConfirmed &&
    (!source.url || /^https?:\/\//i.test(source.url));
  const patch = (id: string, value: Partial<TrafficODDraft>) =>
    onRowsChange(
      rows.map((row) => (row.row.id === id ? { ...row, ...value } : row)),
    );
  return (
    <section className="traffic-card" id="traffic-count-demand">
      <span className="eyebrow">3 · DEMAND ASSUMPTIONS</span>
      <h3>Compare the same period and the same trips.</h3>
      <p className="traffic-muted">
        A daily building trip-end estimate, resident count or AADT value is not
        an origin–destination matrix. Enter cited one-way vehicle demand;
        preserve the same admitted demand for both alternatives.
      </p>
      <div className="traffic-section-heading">
        <h4>Origin–destination demand</h4>
        <button
          type="button"
          className="button"
          disabled={!canEdit || !network}
          onClick={() =>
            onRowsChange([
              ...rows,
              {
                row: {
                  id: `od-${crypto.randomUUID()}`,
                  originEdge: "",
                  destinationEdge: "",
                  beginSeconds: 0,
                  endSeconds: 0,
                  vehicleClass: "passenger",
                  vehicles: 0,
                  purpose: "unspecified",
                  quality: "authored",
                  sourceIds: [],
                },
                vehicles: "",
                begin: period.begin,
                end: period.end,
              },
            ])
          }
        >
          <Plus size={14} />
          Add OD row
        </button>
      </div>
      {!rows.length && (
        <p className="traffic-empty">
          No origin–destination demand is supplied. Counts can be retained for
          review while demand is still unavailable.
        </p>
      )}
      <section className="traffic-card">
        <h4>Demand source or authored assumption</h4>
        <p className="traffic-muted">
          Cite the evidence behind OD totals and candidate paths. An authored
          assumption stays authored; it is not a measured route distribution.
        </p>
        {addingSource ? (
          <>
            <TrafficSourceForm
              prefix="Demand"
              value={source}
              onChange={setSource}
              disabled={!canEdit}
            />
            <div className="traffic-actions">
              <button
                type="button"
                className="button"
                disabled={!canEdit || !sourceReady}
                onClick={() => {
                  onAddSource(source);
                  setAddingSource(false);
                  setSource(newDeclaration());
                }}
              >
                Add demand citation to review
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setAddingSource(false);
                  setSource(newDeclaration());
                }}
              >
                Discard demand citation
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="button"
            disabled={!canEdit}
            onClick={() => setAddingSource(true)}
          >
            Add demand source
          </button>
        )}
      </section>
      {rows.map((value) => (
        <fieldset
          key={value.row.id}
          disabled={!canEdit}
          className="traffic-demand-row"
        >
          <legend>{value.row.id}</legend>
          {value.row.endpoints && (
            <p className="hint">
              This route uses explicit positions along its first and last
              streets: {value.row.endpoints.departPositionMeters} m on{" "}
              {value.row.endpoints.departLaneId} to{" "}
              {value.row.endpoints.arrivalPositionMeters} m on{" "}
              {value.row.endpoints.arrivalLaneId}. Changing an endpoint edge
              requires a new route attachment.
            </p>
          )}
          <div className="traffic-field-grid">
            <TrafficText
              label={`Origin edge for ${value.row.id}`}
              value={value.row.originEdge}
              onChange={(originEdge) =>
                patch(value.row.id, { row: { ...value.row, originEdge } })
              }
            />
            <TrafficText
              label={`Destination edge for ${value.row.id}`}
              value={value.row.destinationEdge}
              onChange={(destinationEdge) =>
                patch(value.row.id, { row: { ...value.row, destinationEdge } })
              }
            />
            <TrafficNumber
              label={`One-way trips for ${value.row.id}`}
              value={value.vehicles}
              onChange={(vehicles) => patch(value.row.id, { vehicles })}
            />
            <TrafficField label={`Vehicle class for ${value.row.id}`}>
              {({ id }) => (
                <select
                  id={id}
                  value={value.row.vehicleClass}
                  onChange={(event) =>
                    patch(value.row.id, {
                      row: {
                        ...value.row,
                        vehicleClass: event.target
                          .value as typeof value.row.vehicleClass,
                      },
                    })
                  }
                >
                  {trafficClasses.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              )}
            </TrafficField>
            <TrafficText
              label={`Departure start for ${value.row.id}`}
              value={value.begin}
              onChange={(begin) => patch(value.row.id, { begin })}
            />
            <TrafficText
              label={`Departure end for ${value.row.id}`}
              value={value.end}
              onChange={(end) => patch(value.row.id, { end })}
            />
            <TrafficField label={`Purpose for ${value.row.id}`}>
              {({ id }) => (
                <select
                  id={id}
                  value={value.row.purpose}
                  onChange={(event) =>
                    patch(value.row.id, {
                      row: {
                        ...value.row,
                        purpose: event.target.value as typeof value.row.purpose,
                      },
                    })
                  }
                >
                  {[
                    "unspecified",
                    "commute",
                    "shopping",
                    "school",
                    "freight",
                    "other",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              )}
            </TrafficField>
            <TrafficField label={`Demand source for ${value.row.id}`}>
              {({ id }) => (
                <select
                  id={id}
                  value={value.row.sourceIds[0] ?? ""}
                  onChange={(event) =>
                    patch(value.row.id, {
                      row: {
                        ...value.row,
                        sourceIds: event.target.value
                          ? [event.target.value]
                          : [],
                      },
                    })
                  }
                >
                  <option value="">Select supplied evidence</option>
                  {demand.sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              )}
            </TrafficField>
          </div>
          <p className="traffic-muted">
            {routes.filter((route) => route.route.odId === value.row.id).length}{" "}
            retained candidate routes. The server must validate permitted paths
            or prepare explicit replacement paths before running changed demand.
          </p>
          <button
            type="button"
            className="button"
            onClick={() =>
              onRowsChange(rows.filter((row) => row.row.id !== value.row.id))
            }
          >
            <Trash2 size={14} />
            Remove this OD row
          </button>
        </fieldset>
      ))}
      <section className="traffic-card">
        <h4>Reviewed candidate paths</h4>
        <p className="traffic-muted">
          Paths are explicit directed edge sequences, not straight lines. Each
          path must connect the entered origin and destination and permit the
          selected class. Retained weights describe alternatives, not observed
          route shares.
        </p>
        {routes
          .filter((value) =>
            rows.some((row) => row.row.id === value.route.odId),
          )
          .map((value) => (
            <fieldset disabled={!canEdit} key={value.route.id}>
              <legend>{value.route.id}</legend>
              <div className="traffic-field-grid">
                <TrafficField label={`OD row for route ${value.route.id}`}>
                  {({ id }) => (
                    <select
                      id={id}
                      value={value.route.odId}
                      onChange={(event) =>
                        onRoutesChange(
                          routes.map((item) =>
                            item.route.id === value.route.id
                              ? {
                                  ...item,
                                  route: {
                                    ...item.route,
                                    odId: event.target.value,
                                  },
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      {rows.map((row) => (
                        <option key={row.row.id} value={row.row.id}>
                          {row.row.id}
                        </option>
                      ))}
                    </select>
                  )}
                </TrafficField>
                <TrafficNumber
                  label={`Relative weight for route ${value.route.id}`}
                  value={value.weight}
                  onChange={(weight) =>
                    onRoutesChange(
                      routes.map((item) =>
                        item.route.id === value.route.id
                          ? { ...item, weight }
                          : item,
                      ),
                    )
                  }
                />
                <TrafficField label={`Evidence for route ${value.route.id}`}>
                  {({ id }) => (
                    <select
                      id={id}
                      value={value.route.sourceIds[0] ?? ""}
                      onChange={(event) =>
                        onRoutesChange(
                          routes.map((item) =>
                            item.route.id === value.route.id
                              ? {
                                  ...item,
                                  route: {
                                    ...item.route,
                                    sourceIds: event.target.value
                                      ? [event.target.value]
                                      : [],
                                  },
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <option value="">
                        Select cited evidence or assumption
                      </option>
                      {demand.sources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.name}
                        </option>
                      ))}
                    </select>
                  )}
                </TrafficField>
              </div>
              <TrafficField
                label={`Directed edge sequence for ${value.route.id}`}
                hint="One exact edge ID per line, in travel order. The server validates topology; no missing connection is guessed."
              >
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    aria-describedby={describedBy}
                    value={value.edgeText}
                    onChange={(event) =>
                      onRoutesChange(
                        routes.map((item) =>
                          item.route.id === value.route.id
                            ? { ...item, edgeText: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                )}
              </TrafficField>
              <button
                type="button"
                className="button"
                onClick={() =>
                  onRoutesChange(
                    routes.filter((item) => item.route.id !== value.route.id),
                  )
                }
              >
                Remove candidate route
              </button>
            </fieldset>
          ))}
        <button
          type="button"
          className="button"
          disabled={!canEdit || !rows.length}
          onClick={() =>
            onRoutesChange([
              ...routes,
              {
                route: {
                  id: `route-${crypto.randomUUID()}`,
                  odId: rows[0].row.id,
                  edges: [],
                  weight: 1,
                  sourceIds: rows[0].row.sourceIds,
                },
                weight: "1",
                edgeText: "",
              },
            ])
          }
        >
          Add reviewed candidate path
        </button>
      </section>
      <details className="traffic-source-details">
        <summary>Demand evidence and route assumptions</summary>
        {demand.sources.map((source) => (
          <p key={source.id}>
            <strong>{source.name}</strong> · {source.vintage} · {source.license}
          </p>
        ))}
        <ul>
          {demand.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
        <p>
          Counts constrain possible routes but do not identify a unique travel
          pattern. Calibration and independent holdout checks remain distinct
          from full model validation.
        </p>
      </details>
    </section>
  );
}
