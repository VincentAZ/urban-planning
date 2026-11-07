import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Place } from "@urban/core";
import { Plus, Upload } from "lucide-react";
import type {
  TrafficCount,
  TrafficCountPack,
  TrafficNetwork,
  TrafficPeriod,
} from "../../../../../packages/core/src/traffic";
import {
  parseTrafficCSV,
  TRAFFIC_CSV_LIMITS,
  type TrafficCSV,
} from "../../lib/traffic-csv";
import {
  changeTrafficCountTarget,
  countsFromCSV,
  trafficClasses,
  trafficCSVFields,
  type TrafficCountDraft,
  type TrafficCSVMapping,
  type TrafficSourceDeclaration,
  type TrafficStagedCSV,
} from "../../lib/traffic-draft";
import {
  TrafficField,
  TrafficNumber,
  TrafficText,
  trafficClock,
  trafficNumber,
} from "./TrafficFields";

import {
  applyTrafficSeriesMapping,
  countWithinTrafficPeriod,
  groupTrafficCounts,
  previewTrafficSeriesMapping,
  trafficCountSeriesKey,
  trafficSeriesPreviewCurrent,
  type TrafficCountSeries,
  type TrafficSeriesMappingPreview,
} from "../../lib/traffic-count-groups";
import "./traffic-count-groups.css";
const CountMappingMap = lazy(() => import("./TrafficNetworkMap"));

export interface TrafficCountBatch {
  counts: TrafficCount[];
  source: TrafficSourceDeclaration;
  file?: TrafficStagedCSV;
}
import { newDeclaration, TrafficSourceForm } from "./TrafficSourceForm";
export function TrafficCountsPanel({
  place,
  network,
  rows,
  pack,
  period,
  canEdit,
  onChange,
  onAddBatch,
  onDirtyChange,
}: {
  place?: Place;
  network: TrafficNetwork | null;
  rows: TrafficCountDraft[];
  pack: TrafficCountPack;
  period: TrafficPeriod;
  canEdit: boolean;
  onChange: (rows: TrafficCountDraft[]) => void;
  onAddBatch: (batch: TrafficCountBatch) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [table, setTable] = useState<TrafficCSV | null>(null),
    [fileHash, setFileHash] = useState("");
  const [mapping, setMapping] = useState<TrafficCSVMapping>({}),
    [usePeriod, setUsePeriod] = useState(false),
    [kind, setKind] = useState<TrafficCount["kind"]>("observed");
  const [declaration, setDeclaration] = useState(newDeclaration),
    [adding, setAdding] = useState<"csv" | "manual" | null>(null),
    [error, setError] = useState(""),
    [reading, setReading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(50),
    [periodOnly, setPeriodOnly] = useState(true);
  const generation = useRef(0),
    mounted = useRef(true),
    editable = useRef(canEdit);
  editable.current = canEdit;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    onDirtyChange(!!adding);
    return () => onDirtyChange(false);
  }, [adding, onDirtyChange]);
  useEffect(() => {
    if (!canEdit) {
      generation.current++;
      setFile(null);
      setTable(null);
      setDeclaration(newDeclaration());
      setAdding(null);
      setReading(false);
      setError("");
    }
  }, [canEdit]);
  async function read(file: File | undefined) {
    const id = ++generation.current;
    setFile(file ?? null);
    setTable(null);
    setFileHash("");
    setError("");
    setMapping({});
    if (!file) return;
    setReading(true);
    try {
      if (file.size > TRAFFIC_CSV_LIMITS.bytes)
        throw new Error(
          "Use a CSV no larger than 5 MiB. Larger source packs need server preparation.",
        );
      const data = await file.arrayBuffer();
      const parsed = parseTrafficCSV(
        new TextDecoder("utf-8", { fatal: true }).decode(data),
      );
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      if (mounted.current && editable.current && id === generation.current) {
        setTable(parsed);
        setFileHash(hash);
      }
    } catch (failure) {
      if (id === generation.current && mounted.current)
        setError((failure as Error).message);
    } finally {
      if (id === generation.current && mounted.current) setReading(false);
    }
  }
  function finishAdd() {
    if (!canEdit) return;
    try {
      if (
        !declaration.name.trim() ||
        !declaration.vintage.trim() ||
        !declaration.license.trim() ||
        !declaration.privateUseConfirmed
      )
        throw new Error(
          "Supply the source name, vintage, permission terms and private-use declaration.",
        );
      if (declaration.url && !/^https?:\/\//i.test(declaration.url))
        throw new Error("Use an http(s) source citation or leave it blank.");
      const batchId = `count-${crypto.randomUUID()}`;
      const counts =
        adding === "csv" && table
          ? countsFromCSV(
              table,
              mapping,
              period,
              declaration.sourceId,
              usePeriod,
              kind,
              batchId,
            )
          : [
              {
                id: batchId,
                stationId: "New station",
                position: null,
                date: period.date,
                timeZone: period.timeZone,
                utcOffsetMinutes: period.utcOffsetMinutes,
                beginSeconds: period.beginSeconds,
                endSeconds: period.endSeconds,
                value: null,
                status: "missing" as const,
                kind,
                target: null,
                vehicleClasses: null,
                raw: {
                  directionCode: "",
                  laneCode: "",
                  classCode: "",
                  recordId: "manual",
                  value: null,
                },
                sourceIds: [declaration.sourceId],
                notes: [
                  "Manually entered traffic evidence; review its observation period, classes and mapping.",
                ],
              },
            ];
      if (adding === "csv" && (!file || !table || !fileHash))
        throw new Error("Inspect a complete CSV before staging its records.");
      onAddBatch({
        counts,
        source: declaration,
        ...(adding === "csv" && file
          ? {
              file: {
                file,
                sha256: fileHash,
                bytes: file.size,
                sourceId: declaration.sourceId,
                mapping,
                useAnalysisPeriod: usePeriod,
                kind,
                batchId,
              },
            }
          : {}),
      });
      setSelectedId(counts[0]?.id ?? null);
      setAdding(null);
      setFile(null);
      setTable(null);
      setDeclaration(newDeclaration());
      setError("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  const groups = useMemo(() => groupTrafficCounts(rows), [rows]);
  const visibleGroups = useMemo(() => {
    const search = query.trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) => !periodOnly || countWithinTrafficPeriod(row, period),
        ),
      }))
      .filter(
        (group) =>
          group.rows.length &&
          group.rows.some((row) =>
            `${row.count.stationId} ${row.count.id} ${row.count.raw.directionCode} ${row.count.raw.laneCode} ${row.count.raw.classCode} ${row.count.date}`
              .toLowerCase()
              .includes(search),
          ),
      );
  }, [groups, query, periodOnly, period]);
  const selected = visibleGroups
    .flatMap((group) => group.rows)
    .find((row) => row.count.id === selectedId);
  const selectedSeries = selected
    ? (groups.find((group) => group.key === trafficCountSeriesKey(selected))
        ?.rows ?? [])
    : [];
  const periodCount = rows.filter((row) =>
    countWithinTrafficPeriod(row, period),
  ).length;
  function update(row: TrafficCountDraft) {
    if (canEdit)
      onChange(
        rows.map((value) => (value.count.id === row.count.id ? row : value)),
      );
  }
  return (
    <>
      <div className="traffic-section-heading">
        <div>
          <span className="eyebrow">TRAFFIC EVIDENCE</span>
          <h3>Keep the count, its meaning and its place together.</h3>
        </div>
        <div className="traffic-actions">
          <button
            type="button"
            className="button"
            disabled={!canEdit || !!adding}
            onClick={() => setAdding("csv")}
          >
            <Upload size={14} />
            Stage count CSV
          </button>
          <button
            type="button"
            className="button"
            disabled={!canEdit || !!adding}
            onClick={() => setAdding("manual")}
          >
            <Plus size={14} />
            Enter a count
          </button>
        </div>
      </div>
      <p className="traffic-muted">
        Interval vehicle counts, annual averages and modeled trips are different
        evidence. Blank values remain missing; a genuine zero is retained. Count
        matching never determines a unique origin–destination demand pattern.
      </p>
      {adding && (
        <section className="traffic-card">
          <h4>
            {adding === "csv"
              ? "Inspect and map a count file"
              : "Start a cited count record"}
          </h4>
          {adding === "csv" && (
            <>
              <TrafficField
                label="Traffic count CSV"
                hint="UTF-8, comma-separated; up to 5 MiB and 10,000 rows per local batch. The original bytes are retained on admission."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    type="file"
                    accept=".csv,text/csv"
                    disabled={!canEdit || reading}
                    onChange={(event) => void read(event.target.files?.[0])}
                  />
                )}
              </TrafficField>
              {reading && (
                <p role="status">Reading and hashing source bytes…</p>
              )}
              {table && (
                <>
                  <p>
                    {table.rows.length.toLocaleString()} records ·{" "}
                    {table.headers.length} columns · SHA-256{" "}
                    {fileHash.slice(0, 12)}…
                  </p>
                  <div className="traffic-field-grid">
                    {trafficCSVFields.map((field) => (
                      <TrafficField key={field.id} label={field.label}>
                        {({ id }) => (
                          <select
                            id={id}
                            value={mapping[field.id] ?? ""}
                            onChange={(event) =>
                              setMapping({
                                ...mapping,
                                [field.id]:
                                  event.target.value === ""
                                    ? undefined
                                    : Number(event.target.value),
                              })
                            }
                          >
                            <option value="">Not supplied</option>
                            {table.headers.map((header, index) => (
                              <option value={index} key={index}>
                                {header}
                              </option>
                            ))}
                          </select>
                        )}
                      </TrafficField>
                    ))}
                  </div>
                  <label className="traffic-check">
                    <input
                      type="checkbox"
                      checked={usePeriod}
                      onChange={(event) => setUsePeriod(event.target.checked)}
                    />
                    <span>
                      For missing date/time fields, use the reviewed analysis
                      period: {period.date}, {trafficClock(period.beginSeconds)}
                      –{trafficClock(period.endSeconds)}, {period.timeZone}.
                      This is an explicit assumption.
                    </span>
                  </label>
                  <div className="traffic-table-scroll">
                    <table>
                      <caption>
                        First five raw source records; remaining records are
                        also retained
                      </caption>
                      <thead>
                        <tr>
                          {table.headers.map((header, i) => (
                            <th key={i}>{header}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.slice(0, 5).map((row) => (
                          <tr key={row.line}>
                            {row.cells.map((cell, i) => (
                              <td key={i}>{cell || <em>Blank</em>}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
          <TrafficField label="Count measurement basis">
            {({ id }) => (
              <select
                id={id}
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as TrafficCount["kind"])
                }
              >
                <option value="observed">Observed interval count</option>
                <option value="factored">Factored / adjusted count</option>
              </select>
            )}
          </TrafficField>
          <TrafficSourceForm
            value={declaration}
            onChange={setDeclaration}
            disabled={!canEdit}
          />
          {error && (
            <p className="traffic-error" role="alert">
              {error}
            </p>
          )}
          <div className="traffic-actions">
            <button
              type="button"
              className="button primary"
              disabled={!canEdit || reading || (adding === "csv" && !table)}
              onClick={finishAdd}
            >
              Add to local review
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                generation.current++;
                setAdding(null);
                setFile(null);
                setTable(null);
                setReading(false);
                setDeclaration(newDeclaration());
                setError("");
              }}
            >
              Discard this source entry
            </button>
          </div>
        </section>
      )}
      <div className="traffic-stats">
        <div>
          <strong>{rows.length.toLocaleString()}</strong>
          <span>retained interval records</span>
        </div>
        <div>
          <strong>
            {rows.filter((row) => row.targetKind === "unmapped").length}
          </strong>
          <span>need network mapping</span>
        </div>
        <div>
          <strong>
            {rows.filter((row) => !row.count.vehicleClasses?.length).length}
          </strong>
          <span>need class review</span>
        </div>
      </div>
      <div className="traffic-series-toolbar">
        <TrafficText
          label="Find a count station"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setLimit(50);
          }}
        />
        <label className="traffic-check">
          <input
            type="checkbox"
            checked={periodOnly}
            onChange={(event) => {
              setPeriodOnly(event.target.checked);
              setLimit(50);
            }}
          />
          <span>Only intervals wholly within the analysis period</span>
        </label>
        <p className="traffic-muted">
          {periodCount.toLocaleString()} of {rows.length.toLocaleString()}{" "}
          records match {period.date}, {trafficClock(period.beginSeconds)}–
          {trafficClock(period.endSeconds)} ({period.timeZone}). Other dates and
          partial intervals remain retained.
        </p>
      </div>
      <div className="traffic-series-list" aria-label="Observation series">
        {visibleGroups.slice(0, limit).map((group) => (
          <CountSeries
            key={group.key}
            group={group}
            selectedId={selectedId}
            onSelect={setSelectedId}
            network={network}
          />
        ))}
      </div>
      {!visibleGroups.length && (
        <p className="traffic-empty">
          No observation series matches this view. Clear the search or include
          intervals outside the analysis period; no source records have been
          removed.
        </p>
      )}
      {visibleGroups.length > limit && (
        <button
          type="button"
          className="button"
          onClick={() => setLimit((value) => value + 50)}
        >
          Show 50 more observation series
        </button>
      )}
      {selected && (
        <CountEditor
          key={selected.count.id}
          value={selected}
          network={network}
          place={place}
          sources={pack.sources}
          onChange={update}
          canEdit={canEdit}
          rows={rows}
          seriesRows={selectedSeries}
          period={period}
          onRowsChange={onChange}
        />
      )}
      <details className="traffic-source-details">
        <summary>Annual traffic context ({pack.annualCounts.length})</summary>
        <p>
          AADT is retained as an annual average. It is not silently converted to
          the selected hour or used as a directional count.
        </p>
        <div className="traffic-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Station</th>
                <th>Year</th>
                <th>AADT</th>
                <th>Direction</th>
              </tr>
            </thead>
            <tbody>
              {pack.annualCounts.map((row) => (
                <tr key={row.id}>
                  <th>{row.stationId}</th>
                  <td>{row.year}</td>
                  <td>
                    {row.status === "available"
                      ? trafficNumber(row.value, 0)
                      : "Missing"}
                  </td>
                  <td>{row.direction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function CountSeries({
  group,
  selectedId,
  onSelect,
  network,
}: {
  group: TrafficCountSeries;
  selectedId: string | null;
  onSelect: (id: string) => void;
  network: TrafficNetwork | null;
}) {
  const [limit, setLimit] = useState(24);
  const count = group.rows[0].count;
  return (
    <details className="traffic-count-series">
      <summary>
        <strong>{count.stationId}</strong>
        <span>
          Direction {count.raw.directionCode || "unknown"} · lane{" "}
          {count.raw.laneCode || "unknown"} ·{" "}
          {group.rows.length.toLocaleString()}{" "}
          {group.rows.length === 1 ? "interval" : "intervals"}
        </span>
        <small>
          {count.date} · {count.timeZone} · raw class:{" "}
          {count.raw.classCode || "not supplied"}
        </small>
      </summary>
      <p className="traffic-muted">
        One exact source/location series. Select an interval to review it
        individually. Source IDs: {count.sourceIds.join(", ")}.
      </p>
      <ul className="traffic-interval-list">
        {group.rows.slice(0, limit).map((row) => (
          <li key={row.count.id}>
            <button
              type="button"
              className="traffic-interval-button"
              aria-pressed={row.count.id === selectedId}
              onClick={() => onSelect(row.count.id)}
            >
              <strong>
                {row.begin}–{row.end}
              </strong>
              <span>
                {row.count.status === "missing"
                  ? "Missing"
                  : row.value || "Not supplied"}{" "}
                vehicles · {row.count.status}
              </span>
              <small>
                {row.targetKind === "unmapped"
                  ? "Unmapped"
                  : `${row.targetKind}: ${row.targetId}`}{" "}
                ·{" "}
                {row.mappingReviewed &&
                (row.mappingChanged ||
                  row.count.mapping?.networkFileSha256 ===
                    network?.manifest.networkFileSha256)
                  ? "Mapping reviewed"
                  : "Mapping needs review"}
              </small>
              <small>
                {row.count.vehicleClasses?.join(", ") ||
                  "Class coverage unknown"}{" "}
                · {row.count.kind}
              </small>
              <span className="traffic-interval-action">Review interval</span>
            </button>
          </li>
        ))}
      </ul>
      {group.rows.length > limit && (
        <button
          type="button"
          className="button"
          onClick={() => setLimit((value) => value + 48)}
        >
          Show 48 more intervals in this series
        </button>
      )}
    </details>
  );
}

function CountEditor({
  value,
  network,
  sources,
  onChange,
  canEdit,
  place,
  rows,
  seriesRows,
  period,
  onRowsChange,
}: {
  value: TrafficCountDraft;
  network: TrafficNetwork | null;
  sources: TrafficCountPack["sources"];
  onChange: (value: TrafficCountDraft) => void;
  canEdit: boolean;
  place?: Place;
  rows: TrafficCountDraft[];
  seriesRows: TrafficCountDraft[];
  period: TrafficPeriod;
  onRowsChange: (rows: TrafficCountDraft[]) => void;
}) {
  const count = value.count;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const classSignature = JSON.stringify([
    count.vehicleClasses,
    count.raw.classCode,
    count.sourceIds,
    sources.filter((source) => count.sourceIds.includes(source.id)),
    network?.manifest.networkFileSha256,
  ]);
  const [classReview, setClassReview] = useState(() => ({
    signature: classSignature,
    confirmed:
      !!count.mapping &&
      count.mapping.networkFileSha256 === network?.manifest.networkFileSha256 &&
      !!count.vehicleClasses?.length,
  }));
  const classConfirmed =
    classReview.signature === classSignature && classReview.confirmed;
  const [showMap, setShowMap] = useState(false);
  const [seriesScope, setSeriesScope] = useState<"period" | "all">("period"),
    [seriesNote, setSeriesNote] = useState(""),
    [seriesPreview, setSeriesPreview] =
      useState<TrafficSeriesMappingPreview | null>(null),
    [seriesError, setSeriesError] = useState(""),
    [seriesMessage, setSeriesMessage] = useState(""),
    [seriesConfirmed, setSeriesConfirmed] = useState(false);
  const selectedSeriesRows = seriesRows.filter(
    (row) => seriesScope === "all" || countWithinTrafficPeriod(row, period),
  );
  const previewCurrent = useMemo(
    () =>
      !!seriesPreview &&
      !!network &&
      trafficSeriesPreviewCurrent(seriesPreview, rows, network, period),
    [seriesPreview, rows, network, period],
  );
  const mapCounts = useMemo(() => [count], [count]);
  const rowsById = useMemo(
    () => new Map(rows.map((row) => [row.count.id, row])),
    [rows],
  );
  const turn =
    value.targetKind === "turn"
      ? network?.connections.find((item) => item.id === value.targetId)
      : undefined;
  const mapEdges = useMemo(
    () => (turn ? [turn.fromEdge, turn.toEdge] : []),
    [turn],
  );

  const csvRecord = count.notes.some((note) =>
    note.startsWith("CSV source line "),
  );
  const adjustment =
    count.notes
      .find((note) => note.startsWith("User adjustment: "))
      ?.slice(17) ?? "";
  const patch = (next: Partial<TrafficCountDraft>) =>
    onChange({ ...value, ...next });
  const field = (next: Partial<TrafficCount>) =>
    patch({
      count: { ...count, ...next },
      ...(next.vehicleClasses !== undefined
        ? { mappingChanged: true, mappingReviewed: false }
        : {}),
    });
  const changeMapping = (next: Partial<TrafficCountDraft>) =>
    patch({ ...next, mappingChanged: true, mappingReviewed: false });
  const edge = network?.edges.find((edge) => edge.id === value.targetId);
  const [targetSearch, setTargetSearch] = useState("");
  const targets =
    value.targetKind === "edge"
      ? network?.edges
          .filter((edge) =>
            `${edge.id} ${edge.from} ${edge.to}`
              .toLowerCase()
              .includes(targetSearch.toLowerCase()),
          )
          .slice(0, 200)
          .map((edge) => ({
            id: edge.id,
            label: `${edge.id}: ${edge.from} → ${edge.to}`,
          }))
      : network?.connections
          .filter((connection) =>
            `${connection.id} ${connection.fromEdge} ${connection.toEdge}`
              .toLowerCase()
              .includes(targetSearch.toLowerCase()),
          )
          .slice(0, 200)
          .map((connection) => ({
            id: connection.id,
            label: `${connection.direction}: ${connection.fromEdge} → ${connection.toEdge} (${connection.id})`,
          }));
  return (
    <section className="traffic-card">
      <h4 ref={heading} tabIndex={-1}>
        Review {count.stationId} · {value.begin}–{value.end}
      </h4>
      {place && network && (
        <div className="traffic-count-map">
          <button
            type="button"
            className="button"
            onClick={() => setShowMap((open) => !open)}
            aria-expanded={showMap}
          >
            {showMap ? "Hide count mapping map" : "Show count mapping map"}
          </button>
          {showMap && (
            <>
              <p className="traffic-muted">
                Amber is the retained source location. Selecting a native line
                chooses a pending directed-edge target; confirm direction,
                detector position and lane coverage below. The source coordinate
                is not moved.
              </p>
              <Suspense
                fallback={<p role="status">Loading count mapping map…</p>}
              >
                <CountMappingMap
                  countReview
                  place={place}
                  network={network}
                  counts={mapCounts}
                  selectedEdgeId={
                    value.targetKind === "edge"
                      ? value.targetId || null
                      : (turn?.fromEdge ?? null)
                  }
                  reviewedEdgeIds={mapEdges}
                  onSelectEdge={(id) => {
                    if (canEdit)
                      onChange(changeTrafficCountTarget(value, "edge", id));
                  }}
                />
              </Suspense>
            </>
          )}
        </div>
      )}
      <fieldset disabled={!canEdit}>
        <div className="traffic-field-grid">
          <TrafficText
            label="Station name or ID"
            disabled={csvRecord}
            value={count.stationId}
            onChange={(stationId) => field({ stationId })}
          />
          <TrafficField label="Count status">
            {({ id }) => (
              <select
                id={id}
                value={count.status}
                onChange={(event) =>
                  field({
                    status: event.target.value as TrafficCount["status"],
                  })
                }
              >
                <option value="available">Available</option>
                <option value="missing">Missing</option>
                <option value="excluded">Explicitly excluded</option>
              </select>
            )}
          </TrafficField>
          <TrafficField label="Interval evidence kind">
            {({ id }) => (
              <select
                id={id}
                value={count.kind}
                onChange={(event) =>
                  field({ kind: event.target.value as TrafficCount["kind"] })
                }
              >
                <option value="observed">Observed interval count</option>
                <option value="factored">Factored or adjusted count</option>
              </select>
            )}
          </TrafficField>
          <TrafficNumber
            label="Observed or factored vehicles"
            value={value.value}
            onChange={(number) => patch({ value: number })}
            disabled={
              count.status === "missing" ||
              (csvRecord && count.kind === "observed")
            }
            hint="Zero is a count. Excluded values remain recorded but are not eligible for count fitting."
          />
          <TrafficText
            label="Count observation date"
            disabled={csvRecord}
            type="date"
            value={count.date}
            onChange={(date) => field({ date })}
          />
          <TrafficText
            label="Count interval start"
            disabled={csvRecord}
            value={value.begin}
            onChange={(begin) => patch({ begin })}
          />
          <TrafficText
            label="Count interval end"
            disabled={csvRecord}
            value={value.end}
            onChange={(end) => patch({ end })}
          />
          <TrafficNumber
            label="Count station longitude"
            value={value.longitude}
            onChange={(longitude) =>
              patch({ longitude, mappingChanged: true, mappingReviewed: false })
            }
          />
          <TrafficNumber
            label="Count station latitude"
            value={value.latitude}
            onChange={(latitude) =>
              patch({ latitude, mappingChanged: true, mappingReviewed: false })
            }
          />
        </div>
        {csvRecord && (
          <p className="traffic-muted">
            Original CSV station, date and interval are retained. Correct the
            file and import it again to change those source fields; exclude an
            unsuitable row. A numeric adjustment must be marked Factored and
            explained.
          </p>
        )}
        {count.kind === "factored" && (
          <TrafficField
            label="Count adjustment explanation"
            hint="Explain any change from the original value. The original bytes and raw count remain retained."
          >
            {({ id, describedBy }) => (
              <textarea
                id={id}
                aria-describedby={describedBy}
                maxLength={3500}
                value={adjustment}
                onChange={(event) =>
                  field({
                    notes: [
                      ...count.notes.filter(
                        (note) => !note.startsWith("User adjustment: "),
                      ),
                      ...(event.target.value
                        ? [`User adjustment: ${event.target.value}`]
                        : []),
                    ],
                  })
                }
              />
            )}
          </TrafficField>
        )}
        <p className="traffic-muted">
          {count.timeZone} · UTC offset {count.utcOffsetMinutes} minutes.
          Station coordinates may be unknown; leave both blank. No point is
          invented.
        </p>
        <fieldset>
          <legend>Reviewed vehicle classes</legend>
          <div className="traffic-check-grid">
            {trafficClasses.map((vehicleClass) => (
              <label className="traffic-check" key={vehicleClass}>
                <input
                  type="checkbox"
                  checked={
                    count.vehicleClasses?.includes(vehicleClass) ?? false
                  }
                  onChange={(event) =>
                    field({
                      vehicleClasses: event.target.checked
                        ? [...(count.vehicleClasses ?? []), vehicleClass]
                        : (count.vehicleClasses ?? []).filter(
                            (value) => value !== vehicleClass,
                          ),
                    })
                  }
                />
                <span>{vehicleClass}</span>
              </label>
            ))}
          </div>
          <p className="traffic-muted">
            Source class code: {count.raw.classCode || "not supplied"}. Select
            only the classes covered by this measurement; overlapping class
            totals must not be summed twice.
          </p>
        </fieldset>
        <div className="traffic-field-grid">
          <TrafficField label="Count network target">
            {({ id }) => (
              <select
                id={id}
                disabled={!network}
                value={value.targetKind}
                onChange={(event) =>
                  onChange(
                    changeTrafficCountTarget(
                      value,
                      event.target.value as TrafficCountDraft["targetKind"],
                      "",
                    ),
                  )
                }
              >
                <option value="unmapped">Unmapped — retain for review</option>
                <option value="edge">Directed edge</option>
                <option value="turn">Turning movement</option>
              </select>
            )}
          </TrafficField>
          {value.targetKind !== "unmapped" && (
            <>
              <TrafficText
                label="Find a count target"
                value={targetSearch}
                onChange={setTargetSearch}
              />
              <TrafficField
                label={
                  value.targetKind === "edge"
                    ? "Matched directed edge"
                    : "Matched turning movement"
                }
                hint="Search by ID to narrow the first 200 matches. No nearest-road match is accepted automatically."
              >
                {({ id, describedBy }) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    value={value.targetId}
                    onChange={(event) =>
                      onChange(
                        changeTrafficCountTarget(
                          value,
                          value.targetKind,
                          event.target.value,
                        ),
                      )
                    }
                  >
                    <option value="">Choose the reviewed target</option>
                    {value.targetId &&
                      !targets?.some(
                        (target) => target.id === value.targetId,
                      ) && (
                        <option value={value.targetId}>{value.targetId}</option>
                      )}
                    {targets?.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.label}
                      </option>
                    ))}
                  </select>
                )}
              </TrafficField>
            </>
          )}
          {value.targetKind === "edge" && (
            <TrafficNumber
              label="Count location along directed edge (%)"
              value={value.positionPercent}
              onChange={(positionPercent) => changeMapping({ positionPercent })}
              hint="0% is the recorded from-node, 100% the to-node. Enter the actual reviewed detector position; no midpoint is assumed."
            />
          )}
        </div>
        {value.targetKind === "edge" && edge && (
          <fieldset>
            <legend>Lane coverage</legend>
            <TrafficField label="Reviewed lane coverage">
              {({ id }) => (
                <select
                  id={id}
                  value={
                    value.laneCoverageNetworkHash ===
                    network?.manifest.networkFileSha256
                      ? value.laneCoverage
                      : "unknown"
                  }
                  onChange={(event) =>
                    changeMapping({
                      laneCoverage: event.target
                        .value as TrafficCountDraft["laneCoverage"],
                      laneCoverageNetworkHash:
                        network?.manifest.networkFileSha256 ?? null,
                      laneIds: [],
                    })
                  }
                >
                  <option value="unknown">
                    Choose coverage — not yet reviewed
                  </option>
                  <option value="all">All lanes of this directed edge</option>
                  <option value="specific">Specific reviewed lanes</option>
                </select>
              )}
            </TrafficField>
            <p className="traffic-muted">
              All lanes means only this direction, never both directions of a
              street. Native lane IDs are not assumed to match the source lane
              numbering.
            </p>
            {value.laneCoverageNetworkHash ===
              network?.manifest.networkFileSha256 &&
              value.laneCoverage === "specific" &&
              edge.lanes.map((lane) => (
                <label className="traffic-check" key={lane.id}>
                  <input
                    type="checkbox"
                    checked={value.laneIds.includes(lane.id)}
                    onChange={(event) =>
                      changeMapping({
                        laneIds: event.target.checked
                          ? [...value.laneIds, lane.id]
                          : value.laneIds.filter((id) => id !== lane.id),
                      })
                    }
                  />
                  <span>{lane.id}</span>
                </label>
              ))}
          </fieldset>
        )}
        <label className="traffic-check">
          <input
            type="checkbox"
            checked={classConfirmed}
            onChange={(event) => {
              setClassReview({
                signature: classSignature,
                confirmed: event.target.checked,
              });
              if (!event.target.checked)
                patch({ mappingReviewed: false, mappingChanged: true });
            }}
          />
          <span>
            I reviewed the class coverage interpretation:{" "}
            {count.vehicleClasses?.length
              ? count.vehicleClasses.join(", ")
              : "coverage remains unknown"}
            . Coverage identifies included vehicle classes; it does not
            establish their proportions.
          </span>
        </label>
        {value.targetKind !== "unmapped" && (
          <label className="traffic-check">
            <input
              type="checkbox"
              checked={
                value.mappingReviewed &&
                (value.mappingChanged ||
                  count.mapping?.networkFileSha256 ===
                    network?.manifest.networkFileSha256)
              }
              disabled={
                !classConfirmed ||
                (value.targetKind === "edge" &&
                  (value.laneCoverage === "unknown" ||
                    value.laneCoverageNetworkHash !==
                      network?.manifest.networkFileSha256 ||
                    (value.laneCoverage === "specific" &&
                      !value.laneIds.length)))
              }
              onChange={(event) =>
                patch({
                  mappingReviewed: event.target.checked,
                  mappingChanged: true,
                })
              }
            />
            <span>
              I reviewed the station direction, measurement position, lane
              coverage and target against this exact graph. Original direction:{" "}
              {count.raw.directionCode || "not supplied"}; lane code:{" "}
              {count.raw.laneCode || "not supplied"}.
            </span>
          </label>
        )}
        <TrafficField label="Count review notes">
          {({ id }) => (
            <textarea
              id={id}
              value={count.notes.join("\n")}
              onChange={(event) =>
                field({ notes: event.target.value.split("\n") })
              }
              maxLength={5000}
            />
          )}
        </TrafficField>
      </fieldset>
      {seriesRows.length > 1 && (
        <section
          className="traffic-series-apply"
          aria-label="Apply reviewed mapping to observation series"
        >
          <h4>Reuse this reviewed mapping</h4>
          <p>
            Only the target, detector position, lane/class interpretation and
            the note below are copied. Every source value, status, observation
            clock, original code and station coordinate stays with its own
            record.
          </p>
          {seriesMessage && <p role="status">{seriesMessage}</p>}
          <fieldset disabled={!canEdit}>
            <TrafficField label="Series mapping scope">
              {({ id }) => (
                <select
                  id={id}
                  value={seriesScope}
                  onChange={(event) => {
                    setSeriesScope(event.target.value as "period" | "all");
                    setSeriesPreview(null);
                  }}
                >
                  <option value="period">
                    Intervals within the analysis period
                  </option>
                  <option value="all">
                    All intervals in this exact series
                  </option>
                </select>
              )}
            </TrafficField>
            <p>
              {selectedSeriesRows.length} affected records · {count.stationId} ·{" "}
              {count.date} · direction {count.raw.directionCode || "unknown"} ·
              source lane {count.raw.laneCode || "unknown"}.
            </p>
            <TrafficField
              label="Series mapping review note"
              hint="Optional; copied as a new review note, without replacing each record’s existing notes."
            >
              {({ id, describedBy }) => (
                <textarea
                  id={id}
                  aria-describedby={describedBy}
                  value={seriesNote}
                  maxLength={2000}
                  onChange={(event) => {
                    setSeriesNote(event.target.value);
                    setSeriesPreview(null);
                  }}
                />
              )}
            </TrafficField>
            <button
              type="button"
              className="button"
              disabled={
                !network ||
                !classConfirmed ||
                !value.mappingReviewed ||
                !selectedSeriesRows.length
              }
              onClick={() => {
                setSeriesError("");
                setSeriesMessage("");
                setSeriesConfirmed(false);
                try {
                  setSeriesPreview(
                    previewTrafficSeriesMapping(
                      rows,
                      count.id,
                      selectedSeriesRows.map((row) => row.count.id),
                      network!,
                      {
                        classCoverageConfirmed: classConfirmed,
                        note: seriesNote,
                        ...(seriesScope === "period" ? { period } : {}),
                      },
                    ),
                  );
                } catch (error) {
                  setSeriesPreview(null);
                  setSeriesError((error as Error).message);
                }
              }}
            >
              Preview series mapping
            </button>
            {seriesPreview && (
              <div className="traffic-series-preview">
                <p>
                  <strong>
                    {seriesPreview.recordIds.length} records will receive this
                    mapping.
                  </strong>{" "}
                  {seriesPreview.changedExistingMappings} other records have a
                  different existing mapping or class interpretation that will
                  be replaced.
                </p>
                <p>
                  {value.targetKind}: {value.targetId} ·{" "}
                  {value.targetKind === "edge"
                    ? `${value.positionPercent}% along edge; ${value.laneCoverage === "all" ? "all directed lanes" : value.laneIds.join(", ")}`
                    : "exact turning movement"}{" "}
                  · classes: {count.vehicleClasses?.join(", ") || "unknown"}.
                </p>
                <details>
                  <summary>
                    Exact affected records ({seriesPreview.recordIds.length})
                  </summary>
                  <ul>
                    {seriesPreview.recordIds.map((id) => {
                      const row = rowsById.get(id);
                      return (
                        <li key={id}>
                          <strong>{id}</strong> · {row?.begin}–{row?.end} ·{" "}
                          {row?.value || "Missing"} · {row?.count.status}
                        </li>
                      );
                    })}
                  </ul>
                </details>
                {!previewCurrent && (
                  <p className="traffic-warning" role="status">
                    The records, analysis period or graph changed. Preview this
                    mapping again before applying.
                  </p>
                )}
                <label className="traffic-check">
                  <input
                    type="checkbox"
                    checked={seriesConfirmed}
                    onChange={(event) =>
                      setSeriesConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    I reviewed these exact affected records, including any
                    existing interpretations being replaced.
                  </span>
                </label>
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !previewCurrent || !seriesConfirmed || !classConfirmed
                  }
                  onClick={() => {
                    if (!canEdit || !network) return;
                    try {
                      onRowsChange(
                        applyTrafficSeriesMapping(
                          seriesPreview,
                          rows,
                          network,
                          period,
                        ),
                      );
                      setSeriesMessage(
                        `Mapping applied to ${seriesPreview.recordIds.length} local records. Source values and coordinates are unchanged; save the configuration to retain this review.`,
                      );
                      setSeriesPreview(null);
                      setSeriesError("");
                      heading.current?.focus();
                    } catch (error) {
                      setSeriesError((error as Error).message);
                    }
                  }}
                >
                  Apply mapping to this series
                </button>
              </div>
            )}
            {seriesError && (
              <p className="traffic-error" role="alert">
                {seriesError}
              </p>
            )}
          </fieldset>
        </section>
      )}
      <details>
        <summary>Original record and source</summary>
        <p>
          Record {count.raw.recordId} · original value{" "}
          {count.raw.value ?? "missing"}
        </p>
        <p>
          Current graph: {network?.manifest.networkFileSha256 ?? "unavailable"}
        </p>
        {count.sourceIds.map((id) => {
          const source = sources.find((source) => source.id === id);
          return (
            <p key={id}>
              {source?.name ?? id} · {source?.vintage ?? "Unknown vintage"} ·{" "}
              {source?.license ?? "Permission statement unavailable"}
            </p>
          );
        })}
        {count.mapping && (
          <p>
            Retained review: {count.mapping.reviewedAt} · graph{" "}
            {count.mapping.networkFileSha256} · {count.mapping.method}; snap
            distance{" "}
            {count.mapping.snapMeters === null
              ? "not recorded"
              : `${count.mapping.snapMeters} m`}
            .
          </p>
        )}
      </details>
    </section>
  );
}
