import type { TrafficCount, TrafficPeriod } from "./traffic";
/** Local count-file inspection only. Parsing does not assign a station, infer a
 * measurement period, convert AADT to hourly flow, or apply anything to a project. */
export const TRAFFIC_CSV_LIMITS = {
  bytes: 5 * 1024 ** 2,
  rows: 10000,
  columns: 64,
  cellCharacters: 10000,
} as const;
export interface TrafficCSVRow {
  /** Physical source line where the record begins (quoted records may span lines). */
  line: number;
  cells: string[];
}
export interface TrafficCSV {
  headers: string[];
  rows: TrafficCSVRow[];
}
export function parseTrafficCSV(text: string): TrafficCSV {
  if (new TextEncoder().encode(text).byteLength > TRAFFIC_CSV_LIMITS.bytes)
    throw new Error("Use a traffic-count CSV no larger than 5 MiB.");
  const input = text.replace(/^\uFEFF/, "");
  const records: TrafficCSVRow[] = [];
  let cells: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  let line = 1,
    recordLine = 1,
    started = false;
  function append(value: string) {
    cell += value;
    if (cell.length > TRAFFIC_CSV_LIMITS.cellCharacters)
      throw new Error(
        `Line ${recordLine}: a CSV field exceeds 10,000 characters.`,
      );
  }
  function field() {
    cells.push(cell);
    if (cells.length > TRAFFIC_CSV_LIMITS.columns)
      throw new Error(`Line ${recordLine}: use at most 64 CSV columns.`);
    cell = "";
    closed = false;
  }
  function record() {
    if (started || cells.length || cell.length || closed) {
      field();
      records.push({ line: recordLine, cells });
      if (records.length > TRAFFIC_CSV_LIMITS.rows + 1)
        throw new Error(
          "Use at most 10,000 count records. No rows were truncated.",
        );
    }
    cells = [];
    cell = "";
    started = false;
    closed = false;
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          append('"');
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (char === "\r" || char === "\n") {
        if (char === "\r" && input[i + 1] === "\n") i++;
        append("\n");
        line++;
      } else append(char);
      continue;
    }
    if (char === ",") {
      field();
      started = true;
    } else if (char === "\r" || char === "\n") {
      record();
      if (char === "\r" && input[i + 1] === "\n") i++;
      line++;
      recordLine = line;
    } else if (char === '"' && !cell.length && !closed) {
      quoted = true;
      started = true;
    } else {
      if (closed || char === '"')
        throw new Error(
          `Line ${line}: CSV quotes are not properly paired. Quote the complete field and double any quotation marks inside it.`,
        );
      append(char);
      started = true;
    }
  }
  if (quoted)
    throw new Error(`Line ${recordLine}: a quoted CSV field is unfinished.`);
  record();
  if (!records.length)
    throw new Error(
      "The CSV is empty. Include a header row and count records.",
    );
  const headers = records[0].cells;
  if (headers.some((header) => !header.trim()))
    throw new Error(
      "Every CSV column needs a header so its meaning can be reviewed.",
    );
  if (new Set(headers).size !== headers.length)
    throw new Error(
      "CSV column headers must be unique; duplicate headers make field mapping ambiguous.",
    );
  const rows = records.slice(1);
  if (!rows.length)
    throw new Error("The CSV contains headers but no count records.");
  for (const row of rows)
    if (row.cells.length !== headers.length)
      throw new Error(
        `Line ${row.line}: found ${row.cells.length} fields but the header has ${headers.length}. No partial rows were accepted.`,
      );
  return { headers, rows };
}

/** Empty means missing, while an explicit 0 is retained. Locale conversion must
 * be a separate reviewed mapping decision; formulas and mixed units are rejected. */
export function trafficNumericCell(raw: string, label: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
    throw new Error(
      `${label}: enter a plain number without grouping separators, formulas or unit text.`,
    );
  const value = Number(text);
  if (!Number.isFinite(value))
    throw new Error(`${label}: enter a finite number.`);
  return value;
}

export const trafficCSVFields = [
  { id: "station", label: "Station ID", required: true },
  { id: "value", label: "Count value", required: true },
  { id: "date", label: "Observation date (YYYY-MM-DD)" },
  { id: "begin", label: "Interval start (HH:MM)" },
  { id: "end", label: "Interval end (HH:MM)" },
  { id: "longitude", label: "Station longitude" },
  { id: "latitude", label: "Station latitude" },
  { id: "direction", label: "Original direction code" },
  { id: "lane", label: "Original lane code" },
  { id: "class", label: "Original vehicle-class code" },
  { id: "record", label: "Original record ID" },
] as const;
export type TrafficCSVField = (typeof trafficCSVFields)[number]["id"];
export type TrafficCSVMapping = Partial<Record<TrafficCSVField, number>>;
export function readTrafficClock(value: string, label: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match)
    throw new Error(
      `${label}: use HH:MM or HH:MM:SS in the recorded local day.`,
    );
  const hours = Number(match[1]),
    minutes = Number(match[2]),
    seconds = Number(match[3] ?? 0);
  if (
    hours > 24 ||
    minutes > 59 ||
    seconds > 59 ||
    (hours === 24 && (minutes !== 0 || seconds !== 0))
  )
    throw new Error(`${label}: enter a time between 00:00 and 24:00.`);
  return hours * 3600 + minutes * 60 + seconds;
}
export function readTrafficCoordinates(
  longitude: string,
  latitude: string,
): [number, number] | null {
  const lon = trafficNumericCell(longitude, "Longitude"),
    lat = trafficNumericCell(latitude, "Latitude");
  if (lon === null && lat === null) return null;
  if (lon === null || lat === null)
    throw new Error(
      "Supply both coordinates, or leave both blank for an unlocated station.",
    );
  if (lon < -180 || lon > 180 || lat < -85 || lat > 85)
    throw new Error(
      "Station coordinates must be valid longitude and latitude (latitude within ±85°).",
    );
  return [lon, lat];
}
export function countsFromCSV(
  table: TrafficCSV,
  mapping: TrafficCSVMapping,
  period: TrafficPeriod,
  sourceId: string,
  useAnalysisPeriod: boolean,
  kind: TrafficCount["kind"],
  batchId: string,
): TrafficCount[] {
  for (const field of trafficCSVFields) {
    const index = mapping[field.id];
    if ("required" in field && field.required && index === undefined)
      throw new Error(`Map ${field.label}.`);
    if (
      index !== undefined &&
      (!Number.isInteger(index) || index < 0 || index >= table.headers.length)
    )
      throw new Error(`Choose an existing CSV column for ${field.label}.`);
  }
  if (
    !useAnalysisPeriod &&
    ["date", "begin", "end"].some(
      (field) => mapping[field as TrafficCSVField] === undefined,
    )
  )
    throw new Error(
      "Map the observation date and interval, or explicitly use the analysis period for missing fields.",
    );
  return table.rows.map((row) => {
    const cell = (key: TrafficCSVField) =>
      mapping[key] === undefined ? "" : row.cells[mapping[key]!];
    const stationId = cell("station").trim();
    if (!stationId) throw new Error(`Line ${row.line}: Station ID is blank.`);
    const raw = cell("value"),
      value = trafficNumericCell(raw, `Line ${row.line}, count`);
    if (
      value !== null &&
      (value < 0 || (kind === "observed" && !Number.isSafeInteger(value)))
    )
      throw new Error(
        `Line ${row.line}: a count must be nonnegative (whole vehicles for observations); blank remains missing.`,
      );
    const date = cell("date").trim() || (useAnalysisPeriod ? period.date : "");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new Error(
        `Line ${row.line}: supply a real observation date as YYYY-MM-DD.`,
      );
    const beginSeconds = cell("begin").trim()
      ? readTrafficClock(cell("begin"), `Line ${row.line}, start`)
      : useAnalysisPeriod
        ? period.beginSeconds
        : null;
    const endSeconds = cell("end").trim()
      ? readTrafficClock(cell("end"), `Line ${row.line}, end`)
      : useAnalysisPeriod
        ? period.endSeconds
        : null;
    if (
      beginSeconds === null ||
      endSeconds === null ||
      beginSeconds >= endSeconds
    )
      throw new Error(
        `Line ${row.line}: the interval end must follow its start within the recorded day. Split overnight or daylight-saving transition intervals explicitly.`,
      );
    return {
      id: `${batchId}-${row.line}`,
      stationId,
      position: readTrafficCoordinates(cell("longitude"), cell("latitude")),
      date,
      timeZone: period.timeZone,
      utcOffsetMinutes: period.utcOffsetMinutes,
      beginSeconds,
      endSeconds,
      value,
      status: value === null ? "missing" : "available",
      kind,
      target: null,
      vehicleClasses: null,
      raw: {
        directionCode: cell("direction"),
        laneCode: cell("lane"),
        classCode: cell("class"),
        recordId: cell("record") || `line-${row.line}`,
        value: raw || null,
      },
      sourceIds: [sourceId],
      notes: [
        `CSV source line ${row.line}; direction, lane, class and target still require review.`,
        ...(useAnalysisPeriod
          ? [
              "Analysis-period defaults were explicitly selected for any missing date/time fields.",
            ]
          : []),
      ],
    };
  });
}
