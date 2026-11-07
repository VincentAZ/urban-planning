import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";
import type { CensusValue } from "@urban/core";
import { parseCensusValue } from "./acs";
import type { PreparedWorkforceBlocks } from "./workforce-blocks";

export const COMMUTE_SOURCE_LIMITS = {
  downloadBytes: 256 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  rows: 4_000_000,
  lineBytes: 64_000,
} as const;
const lodes = "https://lehd.ces.census.gov/data/lodes/LODES8/az/";
const acs =
  "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/";
export const COMMUTE_SOURCE_URLS = {
  "version.txt": `${lodes}version.txt`,
  "az_xwalk.csv.gz": `${lodes}az_xwalk.csv.gz`,
  "az_od_main_JT01_2023.csv.gz": `${lodes}od/az_od_main_JT01_2023.csv.gz`,
  "az_od_aux_JT01_2023.csv.gz": `${lodes}od/az_od_aux_JT01_2023.csv.gz`,
  "az_rac_S000_JT01_2023.csv.gz": `${lodes}rac/az_rac_S000_JT01_2023.csv.gz`,
  "az_wac_S000_JT01_2023.csv.gz": `${lodes}wac/az_wac_S000_JT01_2023.csv.gz`,
  "B08132-2024-metadata.json":
    "https://api.census.gov/data/2024/acs/acs5/groups/B08132.json",
  "acsdt5y2024-b08132.dat": `${acs}data/5YRData/acsdt5y2024-b08132.dat`,
  "ACS20245YR_Table_Shells.txt": `${acs}documentation/ACS20245YR_Table_Shells.txt`,
} as const;
export interface CommuteSourceReceipt {
  url: string;
  retrievedAt: string;
  bytes: number;
  sha256: string;
  lastModified?: string | null;
  etag?: string | null;
  contentType?: string | null;
}
export interface CommuteParsedSource {
  bytes: number;
  sha256: string;
  rows: number;
  header: string[];
}
export const COMMUTE_ACS_UNIVERSE =
  "Workers 16 years and over who did not work from home";
export const COMMUTE_DEPARTURE_LABELS = [
  "12:00 a.m. to 4:59 a.m.",
  "5:00 a.m. to 5:29 a.m.",
  "5:30 a.m. to 5:59 a.m.",
  "6:00 a.m. to 6:29 a.m.",
  "6:30 a.m. to 6:59 a.m.",
  "7:00 a.m. to 7:29 a.m.",
  "7:30 a.m. to 7:59 a.m.",
  "8:00 a.m. to 8:29 a.m.",
  "8:30 a.m. to 8:59 a.m.",
  "9:00 a.m. to 9:59 a.m.",
  "10:00 a.m. to 10:59 a.m.",
  "11:00 a.m. to 11:59 a.m.",
  "12:00 p.m. to 3:59 p.m.",
  "4:00 p.m. to 11:59 p.m.",
] as const;
export const COMMUTE_DEPARTURE_BINS = [
  [0, 300],
  [300, 330],
  [330, 360],
  [360, 390],
  [390, 420],
  [420, 450],
  [450, 480],
  [480, 510],
  [510, 540],
  [540, 600],
  [600, 660],
  [660, 720],
  [720, 960],
  [960, 1440],
] as const;
const integer = (value: string) => {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > 1e12
  )
    throw new Error("Invalid nonnegative integer in commute source.");
  return Number(value);
};
const geoid = (value: string, width: number) => {
  if (!new RegExp(`^\\d{${width}}$`).test(value))
    throw new Error("Invalid Census geographic identifier.");
  return value;
};

/** RFC4180 quoted fields within one physical record; embedded newlines are rejected explicitly. */
function csvLine(line: string): string[] {
  const fields: string[] = [];
  let value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else value += c;
    } else if (c === ",") {
      fields.push(value);
      value = "";
      closed = false;
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (c === '"' || closed)
      throw new Error("Malformed quoted Census CSV field.");
    else value += c;
  }
  if (quoted)
    throw new Error(
      "Multiline or unterminated Census CSV field is unsupported.",
    );
  fields.push(value);
  return fields;
}

/** Stream the complete file, preserving original-byte identity even when retaining only a cohort. */
export async function readCommuteTable(
  input: AsyncIterable<Uint8Array>,
  delimiter: "," | "|",
  requiredHeader: readonly string[],
  visit: (row: Record<string, string>, sourceRow: number) => void,
  limits: { bytes?: number; rows?: number } = {},
): Promise<CommuteParsedSource> {
  const maxBytes = limits.bytes ?? COMMUTE_SOURCE_LIMITS.expandedBytes;
  const maxRows = limits.rows ?? COMMUTE_SOURCE_LIMITS.rows;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > COMMUTE_SOURCE_LIMITS.expandedBytes ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > COMMUTE_SOURCE_LIMITS.rows
  )
    throw new Error("Invalid commute parser limit.");
  const hash = createHash("sha256"),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    rows = 0,
    rest = "",
    header: string[] | undefined;
  const line = (raw: string) => {
    const text = raw.replace(/\r$/, "");
    if (Buffer.byteLength(text) > COMMUTE_SOURCE_LIMITS.lineBytes || !text)
      throw new Error("Empty or oversized commute source record.");
    const cells = delimiter === "," ? csvLine(text) : text.split("|");
    if (!header) {
      cells[0] = cells[0].replace(/^\uFEFF/, "");
      if (
        new Set(cells).size !== cells.length ||
        cells.length !== requiredHeader.length ||
        requiredHeader.some((field) => !cells.includes(field))
      )
        throw new Error(
          "Commute source header does not match the pinned table contract.",
        );
      header = cells;
      return;
    }
    if (++rows > maxRows || cells.length !== header.length)
      throw new Error(
        "Commute source row count or column width exceeds its contract.",
      );
    visit(
      Object.fromEntries(header.map((field, i) => [field, cells[i]])),
      rows + 1,
    );
  };
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes)
      throw new Error("Commute source exceeds the expanded byte limit.");
    hash.update(chunk);
    rest += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = rest.indexOf("\n")) >= 0) {
      line(rest.slice(0, end));
      rest = rest.slice(end + 1);
    }
    if (Buffer.byteLength(rest) > COMMUTE_SOURCE_LIMITS.lineBytes)
      throw new Error("Commute source exceeds the line limit.");
  }
  rest += decoder.decode();
  if (rest) line(rest);
  if (!header || !rows)
    throw new Error("Commute source has no complete data records.");
  return { bytes, sha256: hash.digest("hex"), rows, header };
}

export const COMMUTE_ACS_COLUMNS = Array.from({ length: 90 }, (_, i) =>
  ["E", "M"].map((kind) => `B08132_${kind}${String(i + 1).padStart(3, "0")}`),
).flat();
export interface CommuteAcsCell {
  estimate: CensusValue;
  marginOfError: CensusValue;
}
export interface CommuteAcsTract {
  geoid: string;
  cells: Record<string, CommuteAcsCell>;
}
export async function readCommuteAcs(
  input: AsyncIterable<Uint8Array>,
  retainTracts?: ReadonlySet<string>,
) {
  const tracts = new Map<string, CommuteAcsTract>();
  const seen = new Set<string>();
  const source = await readCommuteTable(
    input,
    "|",
    ["GEO_ID", ...COMMUTE_ACS_COLUMNS],
    (row) => {
      if (!row.GEO_ID.startsWith("1400000US04")) return;
      const id = geoid(row.GEO_ID.slice(9), 11);
      if (seen.has(id)) throw new Error("Duplicate ACS tract record.");
      seen.add(id);
      const cells: Record<string, CommuteAcsCell> = Object.create(null);
      for (let i = 1; i <= 90; i++) {
        const suffix = String(i).padStart(3, "0");
        for (const k of ["E", "M"]) {
          const v = row[`B08132_${k}${suffix}`];
          if (
            v !== "" &&
            !/^(?:\d+|-999999999|-888888888|-666666666|-555555555|-333333333|-222222222)$/.test(
              v,
            )
          )
            throw new Error(
              "Invalid ACS cell; unknown sentinels are not zero.",
            );
        }
        cells[`B08132_${suffix}`] = {
          estimate: parseCensusValue(
            row[`B08132_E${suffix}`],
            null,
            "estimate",
          ),
          marginOfError: parseCensusValue(
            row[`B08132_M${suffix}`],
            null,
            "moe",
          ),
        };
      }
      const total = cells.B08132_016.estimate.value;
      const bins = Array.from(
        { length: 14 },
        (_, i) =>
          cells[`B08132_${String(i + 17).padStart(3, "0")}`].estimate.value,
      );
      if (
        total !== null &&
        bins.every((v) => v !== null) &&
        bins.reduce((sum, v) => sum + v, 0) !== total
      )
        throw new Error(
          "ACS drive-alone departure bins do not reconcile to their published total.",
        );
      if (!retainTracts || retainTracts.has(id))
        tracts.set(id, { geoid: id, cells });
    },
  );
  if (!seen.size) throw new Error("No Arizona ACS tracts found.");
  return { tracts, source, nativeTractRows: seen.size };
}

export const LODES_OD_COLUMNS = [
  "w_geocode",
  "h_geocode",
  "S000",
  "SA01",
  "SA02",
  "SA03",
  "SE01",
  "SE02",
  "SE03",
  "SI01",
  "SI02",
  "SI03",
  "createdate",
];
const commonAreaColumns = [
  "C000",
  "CA01",
  "CA02",
  "CA03",
  "CE01",
  "CE02",
  "CE03",
  ...Array.from(
    { length: 20 },
    (_, i) => `CNS${String(i + 1).padStart(2, "0")}`,
  ),
  "CR01",
  "CR02",
  "CR03",
  "CR04",
  "CR05",
  "CR07",
  "CT01",
  "CT02",
  "CD01",
  "CD02",
  "CD03",
  "CD04",
  "CS01",
  "CS02",
];
export const lodesAreaColumns = (kind: "rac" | "wac") => [
  kind === "rac" ? "h_geocode" : "w_geocode",
  ...commonAreaColumns,
  ...(kind === "wac"
    ? [
        "CFA01",
        "CFA02",
        "CFA03",
        "CFA04",
        "CFA05",
        "CFS01",
        "CFS02",
        "CFS03",
        "CFS04",
        "CFS05",
      ]
    : []),
  "createdate",
];
function recordDate(row: Record<string, string>, dates: Set<string>) {
  if (!/^\d{8}$/.test(row.createdate))
    throw new Error("Invalid LODES row creation date.");
  dates.add(row.createdate);
}
export async function readLodesArea(
  input: AsyncIterable<Uint8Array>,
  kind: "rac" | "wac",
  visit?: (row: Record<string, string>, sourceRow: number) => void,
) {
  const counts = new Map<string, number>(),
    dates = new Set<string>();
  const source = await readCommuteTable(
    input,
    ",",
    lodesAreaColumns(kind),
    (row, sourceRow) => {
      const id = geoid(row[kind === "rac" ? "h_geocode" : "w_geocode"], 15);
      if (!id.startsWith("04") || counts.has(id))
        throw new Error("Duplicate or non-Arizona LODES area record.");
      for (const field of lodesAreaColumns(kind).slice(1, -1))
        integer(row[field]);
      counts.set(id, integer(row.C000));
      recordDate(row, dates);
      visit?.(row, sourceRow);
    },
  );
  return { counts, createdates: [...dates].sort(), source };
}
export async function readLodesOd(
  input: AsyncIterable<Uint8Array>,
  kind: "main" | "aux",
  visit?: (
    home: string,
    work: string,
    jobs: number,
    row: Record<string, string>,
    sourceRow: number,
  ) => void,
) {
  const homes = new Map<string, number>(),
    workplaces = new Map<string, number>(),
    dates = new Set<string>();
  let previous = "";
  const source = await readCommuteTable(
    input,
    ",",
    LODES_OD_COLUMNS,
    (row, sourceRow) => {
      const home = geoid(row.h_geocode, 15),
        work = geoid(row.w_geocode, 15),
        key = `${work}:${home}`;
      // Official files are sorted by workplace then home; this detects duplicates without retaining millions of keys.
      if (
        key <= previous ||
        !work.startsWith("04") ||
        home.startsWith("04") !== (kind === "main")
      )
        throw new Error(
          "Unordered, duplicate, or wrong-state LODES OD record.",
        );
      previous = key;
      for (const field of LODES_OD_COLUMNS.slice(2, -1)) integer(row[field]);
      const n = integer(row.S000);
      const homeJobs = (homes.get(home) ?? 0) + n,
        workJobs = (workplaces.get(work) ?? 0) + n;
      if (!Number.isSafeInteger(homeJobs) || !Number.isSafeInteger(workJobs))
        throw new Error("LODES aggregate exceeds exact integer limits.");
      homes.set(home, homeJobs);
      workplaces.set(work, workJobs);
      recordDate(row, dates);
      visit?.(home, work, n, row, sourceRow);
    },
  );
  return { homes, workplaces, createdates: [...dates].sort(), source };
}

/** Resolve current tracts from official 2024 suffix relationships; never guess from block ID prefixes. */
export function commuteTractRelationships(blocks: PreparedWorkforceBlocks) {
  if (
    blocks.stateFips !== "04" ||
    blocks.targetGeographyVintage !== 2024 ||
    blocks.blockGeographyVintage !== 2020 ||
    blocks.sourceRelease !== "TIGER2024" ||
    blocks.geographyMatch.status !== "verified" ||
    blocks.blocks.length + blocks.unallocatedBlocks.length !==
      blocks.completeness.stateBlockRows
  )
    throw new Error(
      "A complete Arizona2020-block to2024-geography relationship is required.",
    );
  const resolved = new Map<
    string,
    { tract: string; position: [number, number] }
  >();
  const ambiguous = new Map<
    string,
    { tracts: string[]; position: [number, number] }
  >();
  const seen = new Set<string>();
  for (const block of [...blocks.blocks, ...blocks.unallocatedBlocks]) {
    geoid(block.id, 15);
    if (
      seen.has(block.id) ||
      !block.id.startsWith("04") ||
      block.position.length !== 2 ||
      !block.position.every(Number.isFinite) ||
      Math.abs(block.position[0]) > 180 ||
      Math.abs(block.position[1]) > 90
    )
      throw new Error("Invalid or duplicate Census block relationship.");
    seen.add(block.id);
    const groups =
      "unitGeoid" in block ? [block.unitGeoid] : block.candidateUnitGeoids;
    const tracts = [
      ...new Set(groups.map((g) => geoid(g, 12).slice(0, 11))),
    ].sort();
    if (!tracts.length)
      throw new Error("Block relationship lacks target geography.");
    if (tracts.length === 1)
      resolved.set(block.id, { tract: tracts[0], position: block.position });
    else ambiguous.set(block.id, { tracts, position: block.position });
  }
  return { resolved, ambiguous };
}

export async function verifyCommuteSource(
  directory: string,
  name: string,
  url: string,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
    throw new Error("Invalid source filename.");
  const path = resolve(directory, name),
    info = await lstat(path);
  if (!info.isFile() || info.size > COMMUTE_SOURCE_LIMITS.downloadBytes)
    throw new Error("Commute source must be a bounded regular file.");
  const receiptPath = `${path}.receipt.json`,
    receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.size > 16_384)
    throw new Error("Invalid source receipt.");
  const receipt = JSON.parse(
    await readFile(receiptPath, "utf8"),
  ) as CommuteSourceReceipt;
  if (
    receipt.url !== url ||
    receipt.bytes !== info.size ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
    !Number.isFinite(Date.parse(receipt.retrievedAt))
  )
    throw new Error("Commute source receipt does not match its pinned input.");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > receipt.bytes)
      throw new Error("Commute source grew during verification.");
    hash.update(chunk);
  }
  if (bytes !== receipt.bytes || hash.digest("hex") !== receipt.sha256)
    throw new Error(
      "Commute source hash mismatch; original bytes are unchanged.",
    );
  return { path, receipt };
}
export function openCommuteSource(
  path: string,
  compressed = false,
): AsyncIterable<Uint8Array> {
  const input = createReadStream(path);
  if (!compressed) return input;
  const output = createGunzip();
  input.on("error", (error) => output.destroy(error));
  output.on("close", () => input.destroy());
  return input.pipe(output);
}
