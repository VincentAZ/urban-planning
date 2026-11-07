import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const WORKFORCE_BLOCK_DOCUMENTATION =
  "https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2024/TGRSHP2024_TechDoc_F-S.pdf";
export const WORKFORCE_BLOCK_LIMITS = {
  archiveBytes: 256 * 1024 * 1024,
  dbfBytes: 192 * 1024 * 1024,
  records: 1_000_000,
  preparedBytes: 192 * 1024 * 1024,
} as const;
export type WorkforceBlockSourceKind = "tabblock20" | "tabblocksufx" | "bg";
export interface WorkforceBlockSource {
  kind: WorkforceBlockSourceKind;
  url: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
  archiveEntry: string;
  dbfSha256: string;
  dbfBytes: number;
  records: number;
}
export interface PreparedWorkforceBlock {
  id: string;
  /** Official current-BG relationship, not an assumed prefix of the 2020 ID. */
  unitGeoid: string;
  blockGroup2020: string;
  position: [number, number];
  population2020: number;
  housingUnits2020: number;
}
export interface UnallocatedWorkforceBlock
  extends Omit<PreparedWorkforceBlock, "unitGeoid"> {
  candidateUnitGeoids: string[];
  reason: "split-current-geography";
}
export interface PreparedWorkforceBlocks {
  schemaVersion: 1;
  stateFips: string;
  countyGeoids: string[];
  blockGroupGeoids: string[];
  populationVintage: 2020;
  blockGeographyVintage: 2020;
  targetGeographyVintage: 2024;
  sourceRelease: "TIGER2024";
  sources: WorkforceBlockSource[];
  geographyMatch: {
    status: "verified";
    method: "census-current-suffixed-block-relationship";
    documentation: string;
    changedBlockGroupIds: number;
    multipleSuffixPiecesSameGroup: number;
    unmatchedBlocks: 0;
    ambiguouslySplitBlocks: number;
    unresolvedPopulation2020: number;
    missingCurrentBlockGroups: 0;
    /** Relationship evidence does not imply identical polygons across vintages. */
    unchangedPolygonsAsserted: false;
  };
  completeness: {
    stateBlockRows: number;
    stateRelationshipRows: number;
    stateBlockGroupRows: number;
    missingPopulationCounts: 0;
    missingHousingCounts: 0;
    counties: {
      geoid: string;
      blocks: number;
      blockGroups: number;
      zeroPopulationBlocks: number;
      population2020: number;
      housingUnits2020: number;
    }[];
  };
  notes: string[];
  blocks: PreparedWorkforceBlock[];
  unallocatedBlocks: UnallocatedWorkforceBlock[];
}

/** Strict, bounded dBASE III reader for Census attribute tables; no geometry is discarded to infer a join. */
export function readCensusDbf(bytes: Buffer) {
  if (bytes.length < 33 || bytes.length > WORKFORCE_BLOCK_LIMITS.dbfBytes)
    throw new Error(
      "Census DBF is empty, truncated, or exceeds the byte limit.",
    );
  if (bytes[0] !== 3) throw new Error("Unsupported Census DBF format.");
  const records = bytes.readUInt32LE(4);
  const headerLength = bytes.readUInt16LE(8);
  const recordLength = bytes.readUInt16LE(10);
  const end = headerLength + records * recordLength;
  if (
    !records ||
    records > WORKFORCE_BLOCK_LIMITS.records ||
    headerLength < 33 ||
    (headerLength - 33) % 32 !== 0 ||
    headerLength > bytes.length ||
    bytes[headerLength - 1] !== 13 ||
    recordLength < 2 ||
    end > bytes.length ||
    (bytes.length !== end && !(bytes.length === end + 1 && bytes[end] === 26))
  )
    throw new Error(
      "Census DBF record count or length is inconsistent; no partial county is accepted.",
    );
  let offset = 1;
  const fields: {
    name: string;
    type: string;
    offset: number;
    length: number;
  }[] = [];
  for (let at = 32; at < headerLength - 1; at += 32) {
    const name = bytes
      .subarray(at, at + 11)
      .toString("ascii")
      .split("\0")[0];
    const type = String.fromCharCode(bytes[at + 11]);
    const length = bytes[at + 16];
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      fields.some((f) => f.name === name) ||
      !["C", "N", "F", "D", "L"].includes(type) ||
      !length
    )
      throw new Error("Census DBF has an unsupported or duplicate field.");
    fields.push({ name, type, offset, length });
    offset += length;
  }
  if (offset !== recordLength)
    throw new Error("Census DBF field widths do not match its records.");
  return {
    records,
    fields: fields.map((field) => field.name),
    *rows(): Generator<Record<string, string | null>> {
      for (let i = 0; i < records; i++) {
        const start = headerLength + i * recordLength;
        if (bytes[start] !== 32)
          throw new Error(
            "Deleted or malformed Census DBF row; county completeness cannot be established.",
          );
        const row: Record<string, string | null> = Object.create(null);
        for (const field of fields) {
          const raw = bytes
            .subarray(start + field.offset, start + field.offset + field.length)
            .toString("ascii")
            .trim();
          row[field.name] = raw || null;
        }
        yield row;
      }
    },
  };
}

function code(
  row: Record<string, string | null>,
  field: string,
  length: number,
): string {
  const value = row[field];
  if (typeof value !== "string" || !new RegExp(`^\\d{${length}}$`).test(value))
    throw new Error(`Missing or invalid Census geographic code ${field}.`);
  return value;
}
function requiredCount(
  row: Record<string, string | null>,
  field: string,
  id: string,
): number {
  const raw = row[field];
  if (raw === null || raw === undefined)
    throw new Error(
      `${field} is missing for block ${id}; missing counts are not zero and this county was not prepared.`,
    );
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(`Invalid nonnegative integer ${field} for block ${id}.`);
  return Number(raw);
}
function requireFields(
  table: ReturnType<typeof readCensusDbf>,
  fields: string[],
) {
  for (const field of fields)
    if (!table.fields.includes(field))
      throw new Error(`Required Census DBF field ${field} is absent.`);
}
function completeCountSum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total))
      throw new Error("Census count aggregate exceeds safe integer precision.");
  }
  return total;
}

export function prepareWorkforceBlocks(input: {
  stateFips: string;
  /** Whole original-2020 counties only. Omit to retain the entire state. */
  countyGeoids?: string[];
  blocksDbf: Buffer;
  relationshipsDbf: Buffer;
  blockGroupsDbf: Buffer;
  sources: WorkforceBlockSource[];
}): PreparedWorkforceBlocks {
  if (!/^\d{2}$/.test(input.stateFips))
    throw new Error("A two-digit state FIPS code is required.");
  const selected = input.countyGeoids && new Set(input.countyGeoids);
  if (
    selected &&
    (!selected.size ||
      selected.size !== input.countyGeoids!.length ||
      [...selected].some(
        (id) => !/^\d{5}$/.test(id) || !id.startsWith(input.stateFips),
      ))
  )
    throw new Error(
      "Select unique, complete counties within the source state.",
    );
  const tables = {
    tabblock20: readCensusDbf(input.blocksDbf),
    tabblocksufx: readCensusDbf(input.relationshipsDbf),
    bg: readCensusDbf(input.blockGroupsDbf),
  };
  for (const kind of ["tabblock20", "tabblocksufx", "bg"] as const) {
    const matching = input.sources.filter((source) => source.kind === kind);
    const buffer =
      kind === "tabblock20"
        ? input.blocksDbf
        : kind === "bg"
          ? input.blockGroupsDbf
          : input.relationshipsDbf;
    if (
      matching.length !== 1 ||
      matching[0].url !== censusBlockSourceUrl(input.stateFips, kind) ||
      matching[0].archiveEntry !== `tl_2024_${input.stateFips}_${kind}.dbf` ||
      !Number.isSafeInteger(matching[0].bytes) ||
      matching[0].bytes <= 0 ||
      matching[0].bytes > WORKFORCE_BLOCK_LIMITS.archiveBytes ||
      matching[0].records !== tables[kind].records ||
      matching[0].dbfBytes !== buffer.length ||
      matching[0].dbfSha256 !== sha256(buffer) ||
      !/^[a-f0-9]{64}$/.test(matching[0].sha256) ||
      !Number.isFinite(Date.parse(matching[0].retrievedAt))
    )
      throw new Error(
        `Census ${kind} provenance does not match its complete source table.`,
      );
  }
  if (input.sources.length !== 3)
    throw new Error("Exactly three Census source tables are required.");
  requireFields(tables.tabblock20, [
    "STATEFP20",
    "COUNTYFP20",
    "TRACTCE20",
    "BLOCKCE20",
    "GEOID20",
    "POP20",
    "HOUSING20",
    "INTPTLAT20",
    "INTPTLON20",
  ]);
  requireFields(tables.tabblocksufx, [
    "STATEFP20",
    "COUNTYFP20",
    "TRACTCE20",
    "BLOCKCE20",
    "STATEFP",
    "COUNTYFP",
    "TRACTCE",
    "BLKGRPCE",
    "SUFFIXCE",
  ]);
  requireFields(tables.bg, [
    "STATEFP",
    "COUNTYFP",
    "TRACTCE",
    "BLKGRPCE",
    "GEOID",
  ]);
  const currentGroups = new Set<string>();
  for (const row of tables.bg.rows()) {
    const id =
      code(row, "STATEFP", 2) +
      code(row, "COUNTYFP", 3) +
      code(row, "TRACTCE", 6) +
      code(row, "BLKGRPCE", 1);
    if (
      !id.startsWith(input.stateFips) ||
      id !== code(row, "GEOID", 12) ||
      currentGroups.has(id)
    )
      throw new Error(
        "Current block-group table contains mismatched, duplicate, or out-of-state identifiers.",
      );
    currentGroups.add(id);
  }
  const relationships = new Map<
    string,
    { unitGeoids: Set<string>; pieces: number }
  >();
  const relationshipIds = new Set<string>();
  for (const row of tables.tabblocksufx.rows()) {
    const id =
      code(row, "STATEFP20", 2) +
      code(row, "COUNTYFP20", 3) +
      code(row, "TRACTCE20", 6) +
      code(row, "BLOCKCE20", 4);
    if (!id.startsWith(input.stateFips))
      throw new Error(
        "Relationship source contains an unexpected original state.",
      );
    if (selected && !selected.has(id.slice(0, 5))) continue;
    const unitGeoid =
      code(row, "STATEFP", 2) +
      code(row, "COUNTYFP", 3) +
      code(row, "TRACTCE", 6) +
      code(row, "BLKGRPCE", 1);
    const suffix = row.SUFFIXCE ?? "";
    if (!/^[A-Za-z0-9]?$/.test(suffix) || relationshipIds.has(id + suffix))
      throw new Error(
        "Duplicate or malformed current suffixed-block relationship.",
      );
    relationshipIds.add(id + suffix);
    if (!currentGroups.has(unitGeoid))
      throw new Error(
        `Current block group ${unitGeoid} is absent from TIGER2024 BG; no prefix fallback is allowed.`,
      );
    if (unitGeoid.slice(0, 5) !== id.slice(0, 5))
      throw new Error(
        `Block ${id} crosses a county vintage change; an explicit reviewed allocation is required.`,
      );
    const prior = relationships.get(id);
    const unitGeoids = prior?.unitGeoids ?? new Set<string>();
    unitGeoids.add(unitGeoid);
    relationships.set(id, { unitGeoids, pieces: (prior?.pieces ?? 0) + 1 });
  }
  const blocks: PreparedWorkforceBlock[] = [];
  const unallocatedBlocks: UnallocatedWorkforceBlock[] = [];
  const ids = new Set<string>();
  const foundCounties = new Set<string>();
  for (const row of tables.tabblock20.rows()) {
    const id =
      code(row, "STATEFP20", 2) +
      code(row, "COUNTYFP20", 3) +
      code(row, "TRACTCE20", 6) +
      code(row, "BLOCKCE20", 4);
    if (
      !id.startsWith(input.stateFips) ||
      id !== code(row, "GEOID20", 15) ||
      ids.has(id)
    )
      throw new Error(
        "Original block table contains mismatched, duplicate, or out-of-state identifiers.",
      );
    ids.add(id);
    if (selected && !selected.has(id.slice(0, 5))) continue;
    foundCounties.add(id.slice(0, 5));
    const relation = relationships.get(id);
    if (!relation)
      throw new Error(
        `Block ${id} has no official current-BG relationship; no prefix fallback is allowed.`,
      );
    const latitude = row.INTPTLAT20,
      longitude = row.INTPTLON20;
    if (
      !latitude ||
      !longitude ||
      !/^[+-]?\d+\.\d+$/.test(latitude) ||
      !/^[+-]?\d+\.\d+$/.test(longitude) ||
      Math.abs(Number(latitude)) > 90 ||
      Math.abs(Number(longitude)) > 180
    )
      throw new Error(`Invalid Census internal point for block ${id}.`);
    const original: Omit<PreparedWorkforceBlock, "unitGeoid"> = {
      id,
      blockGroup2020: id.slice(0, 12),
      position: [Number(longitude), Number(latitude)],
      population2020: requiredCount(row, "POP20", id),
      housingUnits2020: requiredCount(row, "HOUSING20", id),
    };
    const candidateUnitGeoids = [...relation.unitGeoids].sort();
    if (candidateUnitGeoids.length === 1)
      blocks.push({ ...original, unitGeoid: candidateUnitGeoids[0] });
    else
      unallocatedBlocks.push({
        ...original,
        candidateUnitGeoids,
        reason: "split-current-geography",
      });
  }
  if (
    (!blocks.length && !unallocatedBlocks.length) ||
    (selected && [...selected].some((id) => !foundCounties.has(id)))
  )
    throw new Error(
      "A selected county is absent; no empty or partial county was prepared.",
    );
  for (const id of relationships.keys())
    if (!ids.has(id))
      throw new Error(
        `Current relationship has no matching original block ${id}.`,
      );
  const usedGroups = new Set([
    ...blocks.map((block) => block.unitGeoid),
    ...unallocatedBlocks.flatMap((block) => block.candidateUnitGeoids),
  ]);
  for (const id of currentGroups)
    if (foundCounties.has(id.slice(0, 5)) && !usedGroups.has(id))
      throw new Error(
        `Current block group ${id} has no complete original-block allocation.`,
      );
  blocks.sort((a, b) => a.id.localeCompare(b.id));
  unallocatedBlocks.sort((a, b) => a.id.localeCompare(b.id));
  const countyGeoids = [...foundCounties].sort();
  return {
    schemaVersion: 1,
    stateFips: input.stateFips,
    countyGeoids,
    blockGroupGeoids: [...currentGroups]
      .filter((id) => foundCounties.has(id.slice(0, 5)))
      .sort(),
    populationVintage: 2020,
    blockGeographyVintage: 2020,
    targetGeographyVintage: 2024,
    sourceRelease: "TIGER2024",
    sources: [...input.sources].sort((a, b) => a.kind.localeCompare(b.kind)),
    geographyMatch: {
      status: "verified",
      method: "census-current-suffixed-block-relationship",
      documentation: WORKFORCE_BLOCK_DOCUMENTATION,
      changedBlockGroupIds: blocks.filter(
        (b) => b.unitGeoid !== b.blockGroup2020,
      ).length,
      multipleSuffixPiecesSameGroup: blocks.filter(
        (b) => relationships.get(b.id)!.pieces > 1,
      ).length,
      unmatchedBlocks: 0,
      ambiguouslySplitBlocks: unallocatedBlocks.length,
      unresolvedPopulation2020: completeCountSum(
        unallocatedBlocks.map((block) => block.population2020),
      ),
      missingCurrentBlockGroups: 0,
      unchangedPolygonsAsserted: false,
    },
    completeness: {
      stateBlockRows: tables.tabblock20.records,
      stateRelationshipRows: tables.tabblocksufx.records,
      stateBlockGroupRows: tables.bg.records,
      missingPopulationCounts: 0,
      missingHousingCounts: 0,
      counties: countyGeoids.map((geoid) => {
        const rows = [...blocks, ...unallocatedBlocks].filter((b) =>
          b.id.startsWith(geoid),
        );
        return {
          geoid,
          blocks: rows.length,
          blockGroups: new Set(
            rows.flatMap((b) =>
              "unitGeoid" in b ? [b.unitGeoid] : b.candidateUnitGeoids,
            ),
          ).size,
          zeroPopulationBlocks: rows.filter((b) => b.population2020 === 0)
            .length,
          population2020: completeCountSum(rows.map((b) => b.population2020)),
          housingUnits2020: completeCountSum(
            rows.map((b) => b.housingUnits2020),
          ),
        };
      }),
    },
    notes: [
      "Complete selected counties include zero-population blocks. Missing counts or unmatched geography reject preparation rather than becoming zero.",
      "POP20 and HOUSING20 are 2020 Census counts, not 2024 population estimates, workforce counts, or education/occupation counts.",
      "Original blocks are joined to current 2024 block groups using official current suffixed-block attributes. Blocks split across current block groups are retained once as unallocatedBlocks, with all candidate group IDs and their original counts; no area-proportional allocation or duplicated population is performed.",
      "Verified geographyMatch describes verified source relationships, not complete allocation. Positive-population unallocated blocks make every candidate group allocation unavailable; do not renormalize the remaining blocks. Zero-population ambiguous blocks remain recorded without invented weights.",
      "Geographic identifiers are checked against the complete TIGER2024 block-group table. The ACS table join must separately verify its geography inventory; no ACS counts or weights are prepared here.",
      "Census internal points are geographic representative points, not observed residences, road entrances, or population-weighted centroids. Routing and population allocation remain explicit approximations.",
    ],
    blocks,
    unallocatedBlocks,
  };
}

export function censusBlockSourceUrl(
  stateFips: string,
  kind: WorkforceBlockSourceKind,
) {
  if (!/^\d{2}$/.test(stateFips)) throw new Error("Invalid state FIPS code.");
  return `https://www2.census.gov/geo/tiger/TIGER2024/${kind.toUpperCase()}/tl_2024_${stateFips}_${kind}.zip`;
}
export function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const execFileAsync = promisify(execFile);
/** Local preparation only. ZIP contents are streamed to stdout, never extracted as paths. Requires Info-ZIP unzip. */
export async function loadWorkforceBlockSource(
  directory: string,
  stateFips: string,
  kind: WorkforceBlockSourceKind,
  fetcher: typeof fetch = fetch,
): Promise<{ dbf: Buffer; source: WorkforceBlockSource }> {
  const url = censusBlockSourceUrl(stateFips, kind);
  await mkdir(directory, { recursive: true });
  const filename = resolve(directory, basename(new URL(url).pathname));
  const manifestFile = `${filename}.json`;
  let manifest: {
    url: string;
    sha256: string;
    bytes: number;
    retrievedAt: string;
  };
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const info = await stat(filename);
    if (
      manifest.url !== url ||
      info.size !== manifest.bytes ||
      info.size > WORKFORCE_BLOCK_LIMITS.archiveBytes ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      (await fileHash(filename)) !== manifest.sha256
    )
      throw new Error(
        "Cached Census archive integrity check failed; no source was overwritten.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Never replace an existing unmanifested/partially persisted source.
    try {
      await stat(filename);
      throw new Error(
        "Census archive exists without a complete manifest; review it before retrying.",
      );
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const controller = new AbortController();
    const output = await open(temporary, "wx");
    const timer = setTimeout(() => controller.abort(), 20 * 60_000);
    try {
      const response = await fetcher(url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok || !response.body)
        throw new Error(`Census download failed (${response.status}).`);
      const declared = response.headers.get("content-length");
      if (
        declared &&
        (!/^\d+$/.test(declared) ||
          Number(declared) > WORKFORCE_BLOCK_LIMITS.archiveBytes)
      )
        throw new Error("Census archive exceeds its download byte limit.");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > WORKFORCE_BLOCK_LIMITS.archiveBytes)
          throw new Error("Census archive exceeds its download byte limit.");
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      if (!bytes || (declared && bytes !== Number(declared)))
        throw new Error("Census download is empty or truncated.");
      await output.sync();
      await output.close();
      manifest = {
        url,
        sha256: hash.digest("hex"),
        bytes,
        retrievedAt: new Date().toISOString(),
      };
      // Never overwrite a retained source, including a competing preparation.
      await link(temporary, filename);
      await rm(temporary);
      await writeFile(manifestFile, JSON.stringify(manifest), { flag: "wx" });
    } catch (cause) {
      controller.abort();
      await output.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }
  const archiveEntry = basename(filename, ".zip") + ".dbf";
  const listing = await execFileAsync("unzip", ["-Z", "-1", filename], {
    maxBuffer: 64 * 1024,
    timeout: 30_000,
  });
  if (
    listing.stdout
      .trim()
      .split(/\r?\n/)
      .filter((name) => name === archiveEntry).length !== 1
  )
    throw new Error(
      "Census archive does not contain exactly one expected DBF member.",
    );
  const result = await execFileAsync("unzip", ["-p", filename, archiveEntry], {
    encoding: "buffer",
    maxBuffer: WORKFORCE_BLOCK_LIMITS.dbfBytes,
    timeout: 60_000,
  });
  const dbf = result.stdout;
  const table = readCensusDbf(dbf);
  return {
    dbf,
    source: {
      ...manifest,
      kind,
      archiveEntry,
      dbfSha256: sha256(dbf),
      dbfBytes: dbf.length,
      records: table.records,
    },
  };
}

/** Content-addressed immutable output. Repeated preparations must produce identical bytes. */
export async function writeWorkforceBlocks(
  directory: string,
  prepared: PreparedWorkforceBlocks,
) {
  const bytes = JSON.stringify(prepared);
  if (Buffer.byteLength(bytes) > WORKFORCE_BLOCK_LIMITS.preparedBytes)
    throw new Error("Prepared origins exceed the byte limit.");
  const hash = sha256(bytes);
  await mkdir(directory, { recursive: true });
  const filename = resolve(
    directory,
    `blocks-${prepared.stateFips}-${hash}.json`,
  );
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    // Hard-link publication is atomic and does not overwrite an existing immutable artifact.
    try {
      await link(temporary, filename);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await fileHash(filename)) !== hash
      )
        throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
  return { filename, sha256: hash, bytes: Buffer.byteLength(bytes) };
}
