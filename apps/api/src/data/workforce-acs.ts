import { createHash } from "node:crypto";
import { parseCensusValue } from "./acs";
import type { CensusValue } from "@urban/core";

/** Pinned release; updating this changes the evidence pack, never an existing run. */
export const WORKFORCE_ACS_VINTAGE = 2024;
export const WORKFORCE_ACS_TABLES = {
  B15003: {
    cells: 25,
    universe: "Population 25 years and over",
    title: "Educational attainment",
  },
  C24010: {
    cells: 73,
    universe: "Civilian employed population 16 years and over",
    title: "Occupation",
  },
} as const;
export type WorkforceAcsTable = keyof typeof WORKFORCE_ACS_TABLES;
export const WORKFORCE_ACS_MAX_FILE_BYTES = 300_000_000;
export function workforceSummaryUrl(table: WorkforceAcsTable): string {
  return `https://www2.census.gov/programs-surveys/acs/summary_file/${WORKFORCE_ACS_VINTAGE}/table-based-SF/data/5YRData/acsdt5y${WORKFORCE_ACS_VINTAGE}-${table.toLowerCase()}.dat`;
}
export function workforceAcsColumns(table: WorkforceAcsTable): string[] {
  if (!Object.hasOwn(WORKFORCE_ACS_TABLES, table))
    throw new Error("Unsupported workforce ACS table.");
  return Array.from({ length: WORKFORCE_ACS_TABLES[table].cells }, (_, i) => {
    const line = String(i + 1).padStart(3, "0");
    return [`${table}_E${line}`, `${table}_M${line}`];
  }).flat();
}
export interface WorkforceAcsSubset {
  version: 1;
  table: WorkforceAcsTable;
  vintage: 2024;
  state: string;
  geography: "block-group";
  columns: string[];
  /** Original summary-file strings, including missing values and jam codes. */
  rows: Record<string, string[]>;
  source: { url: string; sha256: string; bytes: number; retrievedAt: string };
}

const jamValues = new Set([
  "-999999999",
  "-888888888",
  "-666666666",
  "-555555555",
  "-333333333",
  "-222222222",
]);
function validCell(value: string): boolean {
  return (
    value === "" ||
    jamValues.has(value) ||
    (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
  );
}

/** Streaming national-file reader: retain complete native BG rows for one state. */
export async function readWorkforceAcsSummary(
  input: AsyncIterable<Uint8Array>,
  table: WorkforceAcsTable,
  state: string,
  options: { maxBytes?: number; retrievedAt?: string } = {},
): Promise<WorkforceAcsSubset> {
  if (!/^\d{2}$/.test(state))
    throw new Error("A two-digit Census state FIPS is required.");
  if (!Object.hasOwn(WORKFORCE_ACS_TABLES, table))
    throw new Error("Unsupported workforce ACS table.");
  const maxBytes = options.maxBytes ?? WORKFORCE_ACS_MAX_FILE_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > WORKFORCE_ACS_MAX_FILE_BYTES
  )
    throw new Error("Invalid workforce ACS byte limit.");
  const columns = workforceAcsColumns(table);
  const rows: Record<string, string[]> = Object.create(null);
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let remainder = "",
    bytes = 0,
    lines = 0,
    width = 0,
    rowCount = 0;
  let indices: number[] | undefined;
  const parseLine = (text: string) => {
    lines++;
    if (lines > 2_000_000 || text.length > 64_000)
      throw new Error("ACS source exceeds record limits.");
    text = text.replace(/\r$/, "");
    if (!text) throw new Error("ACS source contains an empty record.");
    if (!indices) {
      const header = text.replace(/^\uFEFF/, "").split("|");
      width = header.length;
      if (
        header[0] !== "GEO_ID" ||
        width !== columns.length + 1 ||
        new Set(header).size !== width
      )
        throw new Error(`${table}: unexpected or duplicated source header.`);
      indices = columns.map((column) => {
        const index = header.indexOf(column);
        if (index < 1)
          throw new Error(`${table}: missing source column ${column}.`);
        return index;
      });
      return;
    }
    // Other Census summary levels are intentionally outside this native-BG pack.
    if (!text.startsWith(`1500000US${state}`)) return;
    const fields = text.split("|");
    const geoid = fields[0].slice(9);
    if (
      !/^\d{12}$/.test(geoid) ||
      fields.length !== width ||
      Object.hasOwn(rows, geoid)
    )
      throw new Error(`${table}: malformed or duplicate block-group row.`);
    const row = indices.map((index) => fields[index]);
    if (row.some((value) => !validCell(value)))
      throw new Error(
        `${table}: unrecognized numeric value or Census jam code.`,
      );
    rows[geoid] = row;
    if (++rowCount > 50_000)
      throw new Error("ACS state subset exceeds the native-unit limit.");
  };
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes)
      throw new Error("ACS source exceeds the preparation byte limit.");
    hash.update(chunk);
    remainder += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = remainder.indexOf("\n")) >= 0) {
      parseLine(remainder.slice(0, end));
      remainder = remainder.slice(end + 1);
    }
    if (remainder.length > 64_000)
      throw new Error("ACS source exceeds the line-length limit.");
  }
  remainder += decoder.decode();
  if (remainder) parseLine(remainder);
  if (!indices || !Object.keys(rows).length)
    throw new Error(
      `${table}: no native block groups were found for the requested state.`,
    );
  return {
    version: 1,
    table,
    vintage: WORKFORCE_ACS_VINTAGE,
    state,
    geography: "block-group",
    columns,
    rows,
    source: {
      url: workforceSummaryUrl(table),
      sha256: hash.digest("hex"),
      bytes,
      retrievedAt: options.retrievedAt ?? new Date().toISOString(),
    },
  };
}

/** Preserve native cells: grouping and conditional sampling MOEs belong to the model. */
export function workforceAcsCells(
  subset: WorkforceAcsSubset,
  geoid: string,
): Record<string, { estimate: CensusValue; marginOfError: CensusValue }> {
  const columns = workforceAcsColumns(subset.table);
  if (
    subset.version !== 1 ||
    subset.vintage !== 2024 ||
    subset.geography !== "block-group" ||
    columns.join("|") !== subset.columns.join("|") ||
    !/^\d{12}$/.test(geoid) ||
    !geoid.startsWith(subset.state)
  )
    throw new Error(
      "The workforce ACS subset does not match its native table contract.",
    );
  const row = subset.rows[geoid];
  if (
    !row ||
    row.length !== columns.length ||
    row.some((value) => typeof value !== "string" || !validCell(value))
  )
    throw new Error("A complete retained ACS source row is required.");
  return Object.fromEntries(
    Array.from({ length: WORKFORCE_ACS_TABLES[subset.table].cells }, (_, i) => [
      `${subset.table}_${String(i + 1).padStart(3, "0")}`,
      {
        estimate: parseCensusValue(row[2 * i], null, "estimate"),
        marginOfError: parseCensusValue(row[2 * i + 1], null, "moe"),
      },
    ]),
  );
}
