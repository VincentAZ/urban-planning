import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import {
  canonicalJSON,
  housingIncomeLimitPackHash,
  validateHousingIncomeLimitPack,
  type HousingIncomeLimitPack,
  type Source,
} from "@urban/core";
import type { HousingCatalogEntry } from "../housing-catalog";

export const HOUSING_PREPARATION_VERSION = "hud-section8-fy2026-1.0.0";
export const HUD_WORKBOOK_URL =
  "https://www.huduser.gov/portal/datasets/il/il26/Section8-FY26.xlsx";
export const HUD_AREA_URL =
  "https://www.huduser.gov/portal/datasets/il/il26/area-definitions-FY26.pdf";
export const HUD_METHOD_URL =
  "https://www.huduser.gov/portal/datasets/il/il26/IncomeLimitsMethodology-FY26.pdf";
export const HUD_TABLE_PDF_URL =
  "https://www.huduser.gov/portal/datasets/il/il26/Section8-IncomeLimits-FY26.pdf";
export const HUD_EFFECTIVE_DATE = "2026-05-01";
export const HOUSING_SOURCE_LIMITS = {
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  expandedWorkbookBytes: 32 * 1024 * 1024,
  rows: 10000,
  areas: 10000,
};
const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const canonicalBytes = (value: unknown) => Buffer.from(canonicalJSON(value));
const headers = [
  "fips",
  "stusps",
  "state",
  "state_name",
  "hud_area_code",
  "hud_area_name",
  "county",
  "County_Name",
  "county_town_name",
  "metro",
  "median2026",
  ...Array.from({ length: 8 }, (_, i) => `l50_${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `ELI_${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `l80_${i + 1}`),
];
export interface HousingRawRow {
  sheet: string;
  row: number;
  cells: Record<string, string | number | null>;
}
export interface HousingWorkbookTable {
  version: 1;
  methodVersion: typeof HOUSING_PREPARATION_VERSION;
  headers: string[];
  fieldDescriptions: HousingRawRow[];
  rows: HousingRawRow[];
}

/** Inspect the central directory before ExcelJS can decompress any entry. No ZIP64, encryption or multi-disk input. */
function assertWorkbookBounds(bytes: Buffer) {
  if (
    bytes.length < 22 ||
    bytes.length > HOUSING_SOURCE_LIMITS.fileBytes ||
    bytes.readUInt32LE(0) !== 0x04034b50
  )
    throw new Error("HUD workbook must be a bounded nonempty XLSX ZIP.");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    throw new Error("Unsupported workbook ZIP directory.");
  const entries = bytes.readUInt16LE(end + 10),
    directory = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (
    entries < 1 ||
    entries > 256 ||
    bytes.readUInt16LE(end + 8) !== entries ||
    directory + size !== end
  )
    throw new Error("Workbook ZIP inventory exceeds limits.");
  let cursor = directory,
    expanded = 0;
  const names = new Set<string>();
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Malformed workbook ZIP entry.");
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      uncompressed = bytes.readUInt32LE(cursor + 24),
      n = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      next = cursor + 46 + n + extra + comment;
    const name = bytes.subarray(cursor + 46, cursor + 46 + n).toString("utf8");
    if (
      next > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      uncompressed === 0xffffffff ||
      !name ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      names.has(name)
    )
      throw new Error("Unsafe or ambiguous workbook ZIP entry.");
    expanded += uncompressed;
    if (expanded > HOUSING_SOURCE_LIMITS.expandedWorkbookBytes)
      throw new Error("Expanded workbook exceeds 32 MiB.");
    names.add(name);
    cursor = next;
  }
  if (cursor !== end) throw new Error("Workbook ZIP directory mismatch.");
}
export async function parseHousingWorkbook(
  bytes: Buffer,
): Promise<HousingWorkbookTable> {
  assertWorkbookBounds(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  if (workbook.worksheets.length !== 2)
    throw new Error("Unexpected HUD workbook sheets.");
  const sheet = workbook.getWorksheet("Section8-FY26"),
    dictionary = workbook.getWorksheet("Field_Descriptions");
  if (
    !sheet ||
    !dictionary ||
    sheet.rowCount < 2 ||
    sheet.rowCount > HOUSING_SOURCE_LIMITS.rows + 1 ||
    sheet.columnCount !== headers.length ||
    dictionary.rowCount > 100 ||
    dictionary.columnCount !== 2
  )
    throw new Error("Unexpected HUD workbook shape.");
  const scalar = (cell: ExcelJS.Cell): string | number | null => {
    const v = cell.value;
    if (
      v === null ||
      typeof v === "string" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return v;
    throw new Error(
      "HUD source cells must be literal strings or numbers, not formulas or rich values.",
    );
  };
  if (
    canonicalJSON(headers) !==
    canonicalJSON(headers.map((_, i) => scalar(sheet.getRow(1).getCell(i + 1))))
  )
    throw new Error("Unsupported HUD FY2026 column schema.");
  const rows: HousingRawRow[] = [],
    geographies = new Set<string>();
  for (let n = 2; n <= sheet.rowCount; n++) {
    const cells = Object.fromEntries(
      headers.map((key, i) => [key, scalar(sheet.getRow(n).getCell(i + 1))]),
    );
    for (const key of headers.slice(0, 9))
      if (typeof cells[key] !== "string" || !(cells[key] as string).trim())
        throw new Error("Missing HUD geography identifier or name.");
    if (
      !/^\d{10}$/.test(String(cells.fips)) ||
      !/^\d{2}$/.test(String(cells.state)) ||
      !/^\d{3}$/.test(String(cells.county)) ||
      String(cells.fips).slice(0, 5) !==
        String(cells.state) + String(cells.county) ||
      geographies.has(String(cells.fips))
    )
      throw new Error("HUD geography identity is inconsistent or duplicated.");
    if (![0, 1].includes(Number(cells.metro)))
      throw new Error("Invalid HUD metro flag.");
    for (const key of headers.slice(10))
      if (!Number.isSafeInteger(cells[key]) || Number(cells[key]) < 0)
        throw new Error(
          "HUD published income values must be nonnegative integer dollars.",
        );
    geographies.add(String(cells.fips));
    rows.push({ sheet: sheet.name, row: n, cells });
  }
  const fieldDescriptions: HousingRawRow[] = [];
  for (let n = 1; n <= dictionary.rowCount; n++)
    fieldDescriptions.push({
      sheet: dictionary.name,
      row: n,
      cells: {
        A: scalar(dictionary.getRow(n).getCell(1)),
        B: scalar(dictionary.getRow(n).getCell(2)),
      },
    });
  return {
    version: 1,
    methodVersion: HOUSING_PREPARATION_VERSION,
    headers,
    fieldDescriptions,
    rows,
  };
}
const fileSchema = z
  .object({
    filename: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(HOUSING_SOURCE_LIMITS.fileBytes),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    methodVersion: z.literal(HOUSING_PREPARATION_VERSION),
    preparedAt: z.iso.datetime(),
    declaredBy: z.string().min(1).max(240),
    files: z.array(fileSchema).length(4),
    acquisitionReceipts: z
      .array(fileSchema.omit({ url: true }))
      .min(1)
      .max(8),
    table: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
      })
      .strict(),
    packs: z
      .array(
        z
          .object({
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z
              .number()
              .int()
              .positive()
              .max(512 * 1024),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
export function deriveHousingPacks(
  table: HousingWorkbookTable,
  files: Manifest["files"],
  declaration: { declaredBy: string; preparedAt: string },
): HousingIncomeLimitPack[] {
  const workbook = files.find((f) => f.url === HUD_WORKBOOK_URL),
    area = files.find((f) => f.url === HUD_AREA_URL);
  if (
    !workbook ||
    !area ||
    !files.some((f) => f.url === HUD_METHOD_URL) ||
    !files.some((f) => f.url === HUD_TABLE_PDF_URL)
  )
    throw new Error(
      "Retain the exact HUD Section 8 workbook and official area definitions.",
    );
  const sourceId = "hud-section8-fy2026";
  const source: Source = {
    id: sourceId,
    name: "HUD FY 2026 Section 8 Income Limits",
    url: HUD_WORKBOOK_URL,
    vintage: "FY 2026; effective May 1, 2026",
    license:
      "U.S. Department of Housing and Urban Development published federal data; attribution retained",
    kind: "published-estimate",
    description:
      "Exact published household-size income limits and HUD area assignments. These are Section 8 income limits, not MTSP/LIHTC limits, market rents, program eligibility certification, or an inferred percentage of median income.",
    rights: {
      version: 1,
      privateUse: true,
      cache: true,
      analyze: true,
      privateDisplay: true,
      export: true,
      historicalRetention: true,
      publicRedistribution: true,
      declaredBy: declaration.declaredBy,
      declaredAt: declaration.preparedAt,
    },
  };
  const groups = new Map<string, HousingRawRow[]>();
  for (const row of table.rows) {
    const id = String(row.cells.hud_area_code);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  if (groups.size > HOUSING_SOURCE_LIMITS.areas)
    throw new Error("HUD area inventory exceeds limits.");
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, rows]) => {
      const first = rows[0].cells;
      const limits = (cells: HousingRawRow["cells"]) =>
        Array.from({ length: 8 }, (_, i) => ({
          householdSize: (i + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
          extremelyLow: Number(cells[`ELI_${i + 1}`]),
          veryLow: Number(cells[`l50_${i + 1}`]),
          low: Number(cells[`l80_${i + 1}`]),
        }));
      if (
        rows.some(
          (r) =>
            r.cells.hud_area_name !== first.hud_area_name ||
            canonicalJSON(limits(r.cells)) !== canonicalJSON(limits(first)),
        )
      )
        throw new Error(
          "One HUD area has conflicting published names or limits; no row was preferred silently.",
        );
      return validateHousingIncomeLimitPack({
        version: 1,
        program: "hud-section8",
        fiscalYear: 2026,
        effectiveDate: HUD_EFFECTIVE_DATE,
        currency: "USD",
        area: {
          id,
          name: String(first.hud_area_name),
          geographies: rows.map(({ cells }) => ({
            stateFips: String(cells.state),
            countyFips: String(cells.state) + String(cells.county),
            ...(String(cells.fips).slice(5) !== "99999"
              ? { countySubdivisionFips: String(cells.fips).slice(5) }
              : {}),
            name: [
              cells.county_town_name,
              ...(cells.county_town_name === cells.County_Name
                ? []
                : [cells.County_Name]),
              cells.state_name,
            ].join(", "),
          })),
        },
        limits: limits(first),
        sources: [source],
        files: files.map(({ url, sha256, bytes }) => ({
          sourceId,
          url,
          sha256,
          bytes,
        })),
        sourceRows: rows.map((r) => ({ fileSha256: workbook.sha256, ...r })),
        notes: [
          "HUD county and county-subdivision assignments are retained exactly from the workbook. A 99999 county-subdivision code denotes the published county-wide row; it is not a real town code.",
          "Users must review geographic applicability to each housing group. No ZIP-centroid, county-only exception override, or automatic building-to-HUD-area assignment is performed.",
          "All published extremely-low, very-low and low limits for household sizes 1–8 are retained. Limits are never regenerated from percentages of median family income.",
          "This capture supports a planning cost comparison, not a determination of household eligibility or subsidized program rent compliance.",
        ],
      });
    });
}
function verifyDownloadReceipts(files: Manifest["files"], receipts: Buffer[]) {
  const rows = receipts.flatMap((b) => {
    const value = JSON.parse(b.toString());
    if (!Array.isArray(value)) throw new Error("Invalid acquisition receipts.");
    return value;
  });
  for (const file of files)
    if (
      !rows.some(
        (r) =>
          r.url === file.url &&
          r.downloaded === true &&
          r.sha256 === file.sha256 &&
          r.bytes === file.bytes,
      )
    )
      throw new Error("Missing exact successful official download receipt.");
}
async function bounded(path: string, max: number) {
  if ((await stat(path)).size > max)
    throw new Error("Housing evidence exceeds byte limit.");
  const b = await readFile(path);
  if (!b.length || b.length > max)
    throw new Error("Housing evidence is empty or oversized.");
  return b;
}
async function confined(root: string, path: string, max: number) {
  const resolved = await realpath(path),
    rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Housing evidence escapes its catalog directory.");
  return bounded(resolved, max);
}
export async function prepareHousingCatalog(input: {
  sourceDirectory: string;
  outputDirectory: string;
  declaredBy: string;
  preparedAt?: string;
}) {
  const source = await realpath(input.sourceDirectory),
    preparedAt = input.preparedAt ?? new Date().toISOString();
  const originals = [
    { filename: "Section8-FY26.xlsx", url: HUD_WORKBOOK_URL },
    { filename: "area-definitions-FY26.pdf", url: HUD_AREA_URL },
    { filename: "IncomeLimitsMethodology-FY26.pdf", url: HUD_METHOD_URL },
    { filename: "Section8-IncomeLimits-FY26.pdf", url: HUD_TABLE_PDF_URL },
  ];
  const raw = await Promise.all(
    originals.map(async (f) => ({
      ...f,
      body: await bounded(
        join(source, f.filename),
        HOUSING_SOURCE_LIMITS.fileBytes,
      ),
    })),
  );
  if (raw.slice(1).some((f) => f.body.subarray(0, 5).toString() !== "%PDF-"))
    throw new Error("HUD area definitions are not a valid PDF response.");
  const files = raw.map(({ body, ...file }) => ({
    ...file,
    sha256: sha(body),
    bytes: body.length,
  }));
  const receipts = await Promise.all(
    ["receipts.json", "pdf-navigation-receipts.json"].map(async (filename) => ({
      filename,
      body: await bounded(join(source, filename), 1024 * 1024),
    })),
  );
  verifyDownloadReceipts(
    files,
    receipts.map((r) => r.body),
  );
  const table = await parseHousingWorkbook(raw[0].body),
    packs = deriveHousingPacks(table, files, {
      declaredBy: input.declaredBy,
      preparedAt,
    }),
    tableBytes = canonicalBytes(table);
  const manifest: Manifest = {
    version: 1,
    methodVersion: HOUSING_PREPARATION_VERSION,
    preparedAt,
    declaredBy: input.declaredBy,
    files,
    acquisitionReceipts: receipts.map((r) => ({
      filename: r.filename,
      sha256: sha(r.body),
      bytes: r.body.length,
    })),
    table: { sha256: sha(tableBytes), bytes: tableBytes.length },
    packs: packs.map((pack) => ({
      hash: housingIncomeLimitPackHash(pack),
      bytes: canonicalBytes(pack).length,
    })),
  };
  manifestSchema.parse(manifest);
  await mkdir(input.outputDirectory, { recursive: false });
  await mkdir(join(input.outputDirectory, "raw"));
  await mkdir(join(input.outputDirectory, "packs"));
  for (const file of receipts)
    await writeFile(
      join(input.outputDirectory, "raw", file.filename),
      file.body,
      { flag: "wx" },
    );
  for (const file of raw)
    await writeFile(
      join(input.outputDirectory, "raw", file.filename),
      file.body,
      { flag: "wx" },
    );
  await writeFile(
    join(input.outputDirectory, "national-table.json"),
    tableBytes,
    { flag: "wx" },
  );
  for (const [i, pack] of packs.entries())
    await writeFile(
      join(input.outputDirectory, "packs", manifest.packs[i].hash + ".json"),
      canonicalBytes(pack),
      { flag: "wx" },
    );
  await writeFile(
    join(input.outputDirectory, "manifest.json"),
    canonicalBytes(manifest),
    { flag: "wx" },
  );
  return {
    areas: packs.length,
    rows: table.rows.length,
    sourceManifestHash: sha(canonicalBytes(manifest)),
    bytes: manifest.packs.reduce((s, p) => s + p.bytes, 0),
  };
}
export async function loadPreparedHousingCatalog(
  directory: string,
): Promise<HousingCatalogEntry[]> {
  const root = await realpath(directory),
    manifest = manifestSchema.parse(
      JSON.parse(
        (
          await confined(root, join(root, "manifest.json"), 4 * 1024 * 1024)
        ).toString(),
      ),
    ),
    sourceManifestHash = sha(canonicalBytes(manifest));
  if (
    manifest.packs.reduce((sum, p) => sum + p.bytes, 0) >
    HOUSING_SOURCE_LIMITS.totalBytes
  )
    throw new Error("Housing catalog pack inventory exceeds 64 MiB.");
  let total = 0;
  const files = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const b = await confined(
      root,
      join(root, "raw", file.filename),
      HOUSING_SOURCE_LIMITS.fileBytes,
    );
    total += b.length;
    if (
      total > HOUSING_SOURCE_LIMITS.totalBytes ||
      b.length !== file.bytes ||
      sha(b) !== file.sha256
    )
      throw new Error("Housing raw source identity mismatch.");
    files.set(file.url, b);
  }
  const receiptBytes: Buffer[] = [];
  for (const file of manifest.acquisitionReceipts) {
    const b = await confined(
      root,
      join(root, "raw", file.filename),
      1024 * 1024,
    );
    if (sha(b) !== file.sha256 || b.length !== file.bytes)
      throw new Error("HUD acquisition receipt changed.");
    receiptBytes.push(b);
  }
  verifyDownloadReceipts(manifest.files, receiptBytes);
  const workbook = files.get(HUD_WORKBOOK_URL),
    area = files.get(HUD_AREA_URL);
  if (!workbook || area?.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("Required official HUD originals are missing.");
  const table = await parseHousingWorkbook(workbook),
    saved = await confined(
      root,
      join(root, "national-table.json"),
      32 * 1024 * 1024,
    );
  if (
    saved.length !== manifest.table.bytes ||
    sha(saved) !== manifest.table.sha256 ||
    !canonicalBytes(table).equals(saved)
  )
    throw new Error(
      "Retained national HUD rows do not replay from the original workbook.",
    );
  const packs = deriveHousingPacks(table, manifest.files, manifest);
  if (
    packs.length !== manifest.packs.length ||
    new Set(manifest.packs.map((p) => p.hash)).size !== packs.length
  )
    throw new Error("HUD catalog inventory is incomplete or duplicated.");
  const entries: HousingCatalogEntry[] = [];
  // One bounded file read at a time; national catalogs must not open thousands of files concurrently.
  for (const [i, pack] of packs.entries()) {
    const id = housingIncomeLimitPackHash(pack),
      entry = manifest.packs[i];
    if (entry.hash !== id)
      throw new Error("HUD catalog pack identity mismatch.");
    const bytes = await confined(
      root,
      join(root, "packs", id + ".json"),
      512 * 1024,
    );
    if (bytes.length !== entry.bytes || !canonicalBytes(pack).equals(bytes))
      throw new Error("HUD area pack differs from the source row replay.");
    entries.push({
      id,
      pack,
      registeredAt: manifest.preparedAt,
      sourceManifestHash,
    });
  }
  return entries;
}
