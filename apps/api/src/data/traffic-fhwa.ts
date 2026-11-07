import { createHash } from "node:crypto";
import type { Position, Source } from "@urban/core";
import type {
  TrafficCount,
  TrafficCountPack,
  TrafficFileReference,
} from "../../../../packages/core/src/traffic";

export const FHWA_TRAFFIC_INDEX =
  "https://www.fhwa.dot.gov/policyinformation/tables/tmasdata/";
export const FHWA_TRAFFIC_FORMAT =
  "https://www.fhwa.dot.gov/policyinformation/tmguide/tmg_2022/traffic-data-formats.cfm";
export const FHWA_TRAFFIC_LIMITS = {
  fileBytes: 50_000_000,
  rows: 250_000,
  lineBytes: 16_384,
  selectedCounts: 100_000,
} as const;
export const FHWA_STATION_COLUMNS = [
  "Record_Type",
  "State_Code",
  "Station_Id",
  "Travel_Dir",
  "Travel_Lane",
  "Year_Record",
  "F_System",
  "Number_Lanes_In_Direction",
  "Vehicle_Classification_Groupings",
  "Calibration_of_Weighing_System",
  "Type_Sensor_1",
  "Type_Sensor_2",
  "Latitude",
  "Longitude",
  "Prev_Station_Id",
  "Year_Established",
  "Year_Discontinued",
  "County_Code",
  "NHS",
  "Posted_Route_Signing",
  "Posted_Route_Sign_Number",
  "Station_Location",
];
export const FHWA_VOLUME_COLUMNS = [
  "Record_Type",
  "State_Code",
  "F_System",
  "Station_Id",
  "Travel_Dir",
  "Travel_Lane",
  "Year_Record",
  "Month_Record",
  "Day_Record",
  "Day_of_Week",
  "Restrictions",
  "Time_Increment",
  ...Array.from({ length: 24 }, (_, i) => `Hour_${String(i).padStart(2, "0")}`),
];
const directionNames = [
  "East–west or southeast–northwest combined",
  "North",
  "Northeast",
  "East",
  "Southeast",
  "South",
  "Southwest",
  "West",
  "Northwest",
  "North–south or northeast–southwest combined",
];
const restrictionNames: Record<string, string> = {
  "0": "No restrictions reported",
  "1": "Construction/activity affected flow without reported pattern change",
  "2": "Counting-device problem reported",
  "3": "Weather affected flow without reported pattern change",
  "4": "Construction/activity changed the traffic pattern",
  "5": "Weather changed the traffic pattern",
  "6": "Non-regular event/trend",
  "7": "One-day special event",
  "8": "Multi-day special event",
};
type RawRow = Record<string, string>;
export interface FhwaStation {
  key: string;
  stateFips: string;
  id: string;
  direction: string;
  lane: string;
  year: number;
  position: Position | null;
  laneCount: number | null;
  description: string;
  raw: RawRow;
  line: number;
}
export interface FhwaVolumeDay {
  key: string;
  stateFips: string;
  stationId: string;
  direction: string;
  lane: string;
  year: number;
  date: string;
  restriction: string;
  increment: string;
  offsetSeconds: number;
  intervalSeconds: number;
  values: (number | null)[];
  raw: RawRow;
  line: number;
}
export interface FhwaParsed<T> {
  rows: T[];
  sha256: string;
  bytes: number;
  sourceRows: number;
}
const empty = (value: string) => value.replace(/^\0+|\0+$/g, "").trim();
function integer(value: string, min: number, max: number, field: string) {
  if (
    !/^\d+$/.test(value.trim()) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(
      `Invalid ${field}: an integer from ${min} to ${max} is required.`,
    );
  return Number(value);
}
function identity(row: RawRow, expected: { stateFips: string; year: number }) {
  const stateFips = String(
      integer(row.State_Code, 1, 78, "state FIPS"),
    ).padStart(2, "0"),
    year = integer(row.Year_Record, 2000, 2100, "year"),
    id = row.Station_Id;
  if (!id || id.length > 20 || /[\x00-\x1f|]/.test(id) || id.trim() !== id)
    throw new Error(
      "Station IDs must retain their exact bounded, case-sensitive source spelling.",
    );
  if (stateFips !== expected.stateFips || year !== expected.year)
    throw new Error(
      "A source record does not match the selected state and year.",
    );
  const direction = String(integer(row.Travel_Dir, 0, 9, "travel direction")),
    lane = String(integer(row.Travel_Lane, 0, 9, "travel lane"));
  return {
    stateFips,
    id,
    year,
    direction,
    lane,
    key: `${stateFips}|${id}|${direction}|${lane}|${year}`,
  };
}
async function parsePipe<T>(
  input: AsyncIterable<Uint8Array>,
  columns: string[],
  parse: (row: RawRow, line: number) => T,
  select: (row: T) => boolean,
): Promise<FhwaParsed<T>> {
  const decoder = new TextDecoder("utf-8", { fatal: true }),
    digest = createHash("sha256"),
    rows: T[] = [];
  let pending = "",
    bytes = 0,
    line = 0,
    header: string[] | undefined,
    sourceRows = 0;
  const accept = (text: string) => {
    line++;
    if (Buffer.byteLength(text) > FHWA_TRAFFIC_LIMITS.lineBytes)
      throw new Error("FHWA source line exceeds the bounded record size.");
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (!header) {
      header = text.replace(/^\uFEFF/, "").split("|");
      if (
        header.length !== columns.length ||
        new Set(header).size !== header.length ||
        columns.some((c) => !header!.includes(c))
      )
        throw new Error(
          "FHWA source headers differ from the supported published pipe-delimited format; no columns were discarded.",
        );
      return;
    }
    if (!text) throw new Error(`Unexpected empty source row at line ${line}.`);
    const cells = text.split("|");
    if (cells.length !== header.length)
      throw new Error(
        `Source field count does not match its header at line ${line}.`,
      );
    if (++sourceRows > FHWA_TRAFFIC_LIMITS.rows)
      throw new Error("FHWA source exceeds the bounded record count.");
    let row: T;
    try {
      row = parse(
        Object.fromEntries(header.map((h, i) => [h, cells[i]])),
        line,
      );
    } catch (error) {
      throw new Error(
        `FHWA line ${line}: ${error instanceof Error ? error.message : "invalid record"}`,
      );
    }
    if (select(row)) rows.push(row);
  };
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > FHWA_TRAFFIC_LIMITS.fileBytes)
      throw new Error("FHWA source exceeds the bounded byte limit.");
    digest.update(chunk);
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      accept(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    if (Buffer.byteLength(pending) > FHWA_TRAFFIC_LIMITS.lineBytes)
      throw new Error("FHWA source line exceeds the bounded record size.");
  }
  pending += decoder.decode();
  if (pending) accept(pending);
  if (!header || !sourceRows) throw new Error("FHWA source is empty.");
  return { rows, sha256: digest.digest("hex"), bytes, sourceRows };
}
export async function readFhwaStations(
  input: AsyncIterable<Uint8Array>,
  options: { stateFips: string; year: number; stationIds?: string[] },
): Promise<FhwaParsed<FhwaStation>> {
  const wanted = options.stationIds ? new Set(options.stationIds) : null,
    seen = new Set<string>();
  return parsePipe(
    input,
    FHWA_STATION_COLUMNS,
    (raw, line) => {
      if (raw.Record_Type !== "S")
        throw new Error("Expected station-description record type S.");
      const item = identity(raw, options);
      if (seen.has(item.key))
        throw new Error(
          "Duplicate station/direction/lane/year metadata is ambiguous.",
        );
      seen.add(item.key);
      const latitude = empty(raw.Latitude),
        longitude = empty(raw.Longitude);
      let position: Position | null = null;
      if (latitude || longitude) {
        if (
          !latitude ||
          !longitude ||
          !/^-?\d+(?:\.\d+)?$/.test(latitude) ||
          !/^-?\d+(?:\.\d+)?$/.test(longitude) ||
          Math.abs(Number(latitude)) > 90 ||
          Math.abs(Number(longitude)) > 180
        )
          throw new Error(
            "Station coordinates must be a complete valid longitude/latitude pair or both missing.",
          );
        position = [Number(longitude), Number(latitude)];
      }
      const lanes = empty(raw.Number_Lanes_In_Direction);
      return {
        ...item,
        position,
        laneCount: lanes ? integer(lanes, 0, 9, "reported lane count") : null,
        description: empty(raw.Station_Location),
        raw,
        line,
      };
    },
    (row) => !wanted || wanted.has(row.id),
  );
}
export async function readFhwaVolumes(
  input: AsyncIterable<Uint8Array>,
  options: {
    stateFips: string;
    year: number;
    month: number;
    stationIds?: string[];
    dates?: string[];
  },
): Promise<FhwaParsed<FhwaVolumeDay>> {
  const wanted = options.stationIds ? new Set(options.stationIds) : null,
    dates = options.dates ? new Set(options.dates) : null,
    seen = new Set<string>();
  return parsePipe(
    input,
    FHWA_VOLUME_COLUMNS,
    (raw, line) => {
      if (raw.Record_Type !== "3")
        throw new Error("Expected traffic-volume record type 3.");
      const item = identity(raw, options),
        month = integer(raw.Month_Record, 1, 12, "month"),
        day = integer(raw.Day_Record, 1, 31, "day"),
        date = `${item.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (
        month !== options.month ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
      )
        throw new Error(
          "Record date differs from the selected month or is not a calendar date.",
        );
      if (
        integer(raw.Day_of_Week, 1, 7, "day of week") !==
        new Date(`${date}T00:00:00Z`).getUTCDay() + 1
      )
        throw new Error("Reported weekday does not match the calendar date.");
      const increment = empty(raw.Time_Increment),
        restriction = empty(raw.Restrictions);
      if (restriction && !Object.hasOwn(restrictionNames, restriction))
        throw new Error(
          "Unknown restriction code; it must not be treated as unrestricted traffic.",
        );
      let intervalSeconds: number, offsetSeconds: number;
      if (!increment) {
        intervalSeconds = 3600;
        offsetSeconds = 0;
      } else if (/^[1-4]$/.test(increment)) {
        intervalSeconds = 900;
        offsetSeconds = (Number(increment) - 1) * 900;
      } else if (/^[A-L]$/.test(increment)) {
        intervalSeconds = 300;
        offsetSeconds = (increment.charCodeAt(0) - 65) * 300;
      } else
        throw new Error(
          "Unsupported source time-increment code; no hourly distribution was invented.",
        );
      const key = `${item.key}|${date}|${increment || "hour"}`;
      if (seen.has(key))
        throw new Error(
          "Duplicate station/direction/lane/date/increment record would double-count traffic.",
        );
      seen.add(key);
      const values = Array.from({ length: 24 }, (_, h) => {
        const value = empty(raw[`Hour_${String(h).padStart(2, "0")}`]);
        return value ? integer(value, 0, 99999, "interval volume") : null;
      });
      return {
        ...item,
        key,
        stationId: item.id,
        date,
        restriction,
        increment,
        offsetSeconds,
        intervalSeconds,
        values,
        raw,
        line,
      };
    },
    (row) =>
      (!wanted || wanted.has(row.stationId)) && (!dates || dates.has(row.date)),
  );
}
export interface FhwaPackSelection {
  stateFips: string;
  year: number;
  month: number;
  date: string;
  stationIds: string[];
  timeZone: string;
  utcOffsetMinutes: number;
  timeInterpretationSource: string;
}
function clock(selection: FhwaPackSelection) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(selection.date) ||
    new Date(`${selection.date}T00:00:00Z`).toISOString().slice(0, 10) !==
      selection.date ||
    !Number.isInteger(selection.utcOffsetMinutes) ||
    Math.abs(selection.utcOffsetMinutes) > 14 * 60
  )
    throw new Error("Choose a valid count date and explicit fixed UTC offset.");
  if (
    Number(selection.date.slice(0, 4)) !== selection.year ||
    Number(selection.date.slice(5, 7)) !== selection.month
  )
    throw new Error("Count date must be inside the selected source month.");
  if (!selection.timeInterpretationSource.trim())
    throw new Error(
      "Record the basis for interpreting source local times; the FHWA archive has no timezone column.",
    );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: selection.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const localMidnight = Date.parse(`${selection.date}T00:00:00Z`);
  for (let h = 0; h <= 24; h++) {
    const instant =
      localMidnight + h * 3600000 - selection.utcOffsetMinutes * 60000;
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((p) => [p.type, p.value]),
    );
    const local = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    if (local !== localMidnight + h * 3600000)
      throw new Error(
        "The explicit offset does not cover this local day, or daylight saving changes it. Resolve the source clock before import.",
      );
  }
}
/** Preserve original observations; target/lane/class matching requires a later explicit review. */
export function fhwaCountPack(
  stations: FhwaParsed<FhwaStation>,
  volumes: FhwaParsed<FhwaVolumeDay>,
  selection: FhwaPackSelection,
  files: TrafficFileReference[],
): TrafficCountPack {
  clock(selection);
  if (
    !selection.stationIds.length ||
    selection.stationIds.length > 100 ||
    new Set(selection.stationIds).size !== selection.stationIds.length
  )
    throw new Error("Choose 1–100 distinct source station IDs.");
  const wanted = new Set(selection.stationIds),
    metadata = stations.rows.filter((s) => wanted.has(s.id)),
    byKey = new Map(metadata.map((s) => [s.key, s])),
    selected = volumes.rows.filter(
      (v) => wanted.has(v.stationId) && v.date === selection.date,
    ),
    sourceId = `fhwa-volume-${selection.year}-${String(selection.month).padStart(2, "0")}-${selection.stateFips}`;
  if (
    metadata.some(
      (s) => s.stateFips !== selection.stateFips || s.year !== selection.year,
    ) ||
    selected.some(
      (v) => v.stateFips !== selection.stateFips || v.year !== selection.year,
    )
  )
    throw new Error(
      "Selected station and volume metadata use different source states or years.",
    );
  for (const id of wanted)
    if (
      !metadata.some((s) => s.id === id) &&
      !selected.some((s) => s.stationId === id)
    )
      throw new Error(
        `Station ${id} is absent from both selected source files.`,
      );
  const source: Source = {
    id: sourceId,
    name: `FHWA published ${selection.year} traffic-volume observations`,
    url: FHWA_TRAFFIC_INDEX,
    vintage: `${selection.year}-${String(selection.month).padStart(2, "0")}`,
    license:
      "FHWA public statistical release; state agency attribution retained. See source publication and source-use terms.",
    kind: "observed",
    description:
      "State-reported traffic observations released by FHWA after its stated quality review. Reported zero is retained; blank is missing. Values are not independently verified by this application.",
  };
  const counts: TrafficCount[] = [],
    intervals = new Map<
      string,
      { begin: number; end: number; lane: string; direction: string }[]
    >(),
    present = new Set<string>();
  const add = (
    stationId: string,
    direction: string,
    lane: string,
    position: Position | null,
    begin: number,
    end: number,
    value: number | null,
    raw: TrafficCount["raw"],
    notes: string[],
    excluded = false,
  ) => {
    if (counts.length >= FHWA_TRAFFIC_LIMITS.selectedCounts)
      throw new Error(
        "Selected count pack exceeds the bounded interval count; choose fewer stations.",
      );
    const groupKey = `${stationId}|${selection.date}`,
      group = intervals.get(groupKey) ?? [];
    for (const old of group) {
      const sameDirection =
        old.direction === direction ||
        (direction === "9" &&
          ["1", "2", "5", "6", "9"].includes(old.direction)) ||
        (old.direction === "9" && ["1", "2", "5", "6"].includes(direction)) ||
        (direction === "0" &&
          ["3", "4", "7", "8", "0"].includes(old.direction)) ||
        (old.direction === "0" && ["3", "4", "7", "8"].includes(direction));
      if (
        sameDirection &&
        (old.lane === lane || old.lane === "0" || lane === "0") &&
        begin < old.end &&
        end > old.begin
      )
        throw new Error(
          "Overlapping source intervals or combined/individual lane-direction totals would double-count traffic. Select a consistent source resolution.",
        );
    }
    group.push({ begin, end, lane, direction });
    intervals.set(groupKey, group);
    counts.push({
      id: `fhwa-${selection.stateFips}-${stationId}-${direction}-${lane}-${selection.date}-${begin}-${end}`,
      stationId,
      position,
      date: selection.date,
      timeZone: selection.timeZone,
      utcOffsetMinutes: selection.utcOffsetMinutes,
      beginSeconds: begin,
      endSeconds: end,
      value,
      status: excluded ? "excluded" : value === null ? "missing" : "available",
      kind: "observed",
      target: null,
      vehicleClasses: null,
      raw,
      sourceIds: [sourceId],
      notes,
    });
  };
  for (const row of selected) {
    const stationKey = `${row.stateFips}|${row.stationId}|${row.direction}|${row.lane}|${row.year}`,
      station = byKey.get(stationKey);
    present.add(stationKey);
    for (let h = 0; h < 24; h++) {
      const begin = h * 3600 + row.offsetSeconds,
        value = row.values[h],
        field = `Hour_${String(h).padStart(2, "0")}`;
      const notes = [
        station?.description || "Station description unavailable",
        `Source direction: ${directionNames[Number(row.direction)]}; source lane: ${row.lane === "0" ? "all lanes combined" : row.lane + " (numbered from the rightmost lane)"}.`,
        restrictionNames[row.restriction] ??
          "Restriction code was not supplied; this is not a confirmed unrestricted interval.",
        `Source clock interpretation: ${selection.timeInterpretationSource}`,
      ];
      if (!station)
        notes.push(
          "No exact station/direction/lane/year metadata match; geometry and lane correspondence require review.",
        );
      if (value === null)
        notes.push("Blank source interval retained as missing.");
      if (value === 0)
        notes.push(
          "Reported zero retained as zero; this does not independently rule out counter malfunction.",
        );
      if (row.restriction === "2")
        notes.push(
          "Excluded from calibration because the source reports a counting-device problem; reported value remains retained.",
        );
      add(
        row.stationId,
        row.direction,
        row.lane,
        station?.position ?? null,
        begin,
        begin + row.intervalSeconds,
        value,
        {
          directionCode: row.direction,
          laneCode: row.lane,
          classCode: "unclassified-motorized-volume",
          recordId: `volume-line-${row.line}:${field}`,
          value: row.raw[field],
        },
        notes,
        row.restriction === "2",
      );
    }
  }
  // A missing daily row is not 24 observed zeros. Retain the expected station/lane coverage explicitly.
  for (const station of metadata)
    if (!present.has(station.key))
      for (let h = 0; h < 24; h++) {
        add(
          station.id,
          station.direction,
          station.lane,
          station.position,
          h * 3600,
          (h + 1) * 3600,
          null,
          {
            directionCode: station.direction,
            laneCode: station.lane,
            classCode: "unclassified-motorized-volume",
            recordId: `station-line-${station.line}:absent-volume-row:${h}`,
            value: null,
          },
          [
            station.description,
            "No daily volume record exists for this selected station/direction/lane/date. Expected intervals are missing, not zero.",
            `Source clock interpretation: ${selection.timeInterpretationSource}`,
          ],
        );
      }
  counts.sort((a, b) => a.id.localeCompare(b.id, "en"));
  const selectionHash = createHash("sha256")
    .update(
      JSON.stringify({
        selection,
        stationHash: stations.sha256,
        volumeHash: volumes.sha256,
      }),
    )
    .digest("hex");
  return {
    version: 1,
    id: `fhwa-${selectionHash}`,
    sources: [source],
    files: files.map((f) => ({ ...f, sourceId })),
    counts,
    annualCounts: [],
    notes: [
      "Counts are source observations, not an origin–destination matrix or a calibrated simulation.",
      "All original state records and archive hashes remain in the retained source files. Only the explicitly selected date and station IDs are included here.",
      "Mapping to a network edge/lane/turn and vehicle classes remains unreviewed. No nearest-road match or hourly AADT conversion has been applied.",
      "The archive does not supply a timezone column; the selected local-clock interpretation is an explicit operator assumption.",
      `Parsed ${stations.sourceRows} station metadata rows and ${volumes.sourceRows} daily volume rows without discarding unsupported columns or malformed records.`,
    ],
  };
}
