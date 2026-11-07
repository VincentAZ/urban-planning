import { createHash } from "node:crypto";
import { lstat, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ACCESSIBILITY_CELLS,
  assertAccessibilityDestinationPack,
  accessibilityContentHash,
  canonicalJSON,
  type AccessibilityDestinationPack,
  type AccessibilityDestination,
  type AccessibilitySourceFile,
} from "@urban/core";
import {
  readLodesArea,
  verifyCommuteSource,
  openCommuteSource,
  COMMUTE_SOURCE_URLS,
} from "./traffic-commute-sources";
import {
  loadWorkforceBlockSource,
  readCensusDbf,
  type PreparedWorkforceBlocks,
} from "./workforce-blocks";

export const ACCESSIBILITY_PACK_MAX_BYTES = 96 * 1024 * 1024;
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const counties = [
  "04001",
  "04003",
  "04005",
  "04007",
  "04009",
  "04011",
  "04012",
  "04013",
  "04015",
  "04017",
  "04019",
  "04021",
  "04023",
  "04025",
  "04027",
];
export interface PrepareAccessibilityOptions {
  sourceDirectory: string;
  blocksFile: string;
  blocksSha256: string;
  blockSourceDirectory: string;
}

/** Reads already captured files only. No downloads, source mutation, area allocation, or selected-tract filtering. */
export async function prepareAccessibilityDestinationPack(
  options: PrepareAccessibilityOptions,
): Promise<AccessibilityDestinationPack> {
  const name = "az_wac_S000_JT01_2023.csv.gz",
    url = COMMUTE_SOURCE_URLS[name];
  const wac = await verifyCommuteSource(options.sourceDirectory, name, url);
  const metadata = await verifyCommuteSource(
    options.sourceDirectory,
    "version.txt",
    COMMUTE_SOURCE_URLS["version.txt"],
  );
  const checksumName = "az_wac_S000_JT01_2023.csv.sha256sum",
    checksum = await verifyCommuteSource(
      options.sourceDirectory,
      checksumName,
      url.replace(/\.gz$/, ".sha256sum"),
    );
  const info = await lstat(options.blocksFile);
  if (
    !info.isFile() ||
    info.size > ACCESSIBILITY_PACK_MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(options.blocksSha256)
  )
    throw new Error(
      "Supply a bounded, explicitly hashed complete native block artifact.",
    );
  const blockBytes = await readFile(options.blocksFile);
  if (digest(blockBytes) !== options.blocksSha256)
    throw new Error("Native block artifact hash mismatch.");
  const blocks = JSON.parse(
    blockBytes.toString("utf8"),
  ) as PreparedWorkforceBlocks;
  if (
    blocks.schemaVersion !== 1 ||
    blocks.stateFips !== "04" ||
    blocks.blockGeographyVintage !== 2020 ||
    [...blocks.countyGeoids].sort().join() !== counties.join() ||
    blocks.blocks.length + blocks.unallocatedBlocks.length !==
      blocks.completeness.stateBlockRows
  )
    throw new Error(
      "The complete Arizona native 2020 block inventory is required.",
    );
  // Check original Census INTPT fields as well as the prepared artifact's hash. This deliberately ignores current-BG allocation status.
  await lstat(
    resolve(options.blockSourceDirectory, "tl_2024_04_tabblock20.zip"),
  );
  await lstat(
    resolve(options.blockSourceDirectory, "tl_2024_04_tabblock20.zip.json"),
  );
  const native = await loadWorkforceBlockSource(
    options.blockSourceDirectory,
    "04",
    "tabblock20",
    async () => {
      throw new Error(
        "Accessibility preparation does not download missing sources.",
      );
    },
  );
  const original = new Map(
    [...readCensusDbf(native.dbf).rows()].map((r) => [r.GEOID20, r]),
  );
  if (
    original.size !== blocks.completeness.stateBlockRows ||
    native.source.sha256 !==
      blocks.sources.find((s) => s.kind === "tabblock20")?.sha256
  )
    throw new Error("Native point source identity or completeness mismatch.");
  const points = new Map(
    [...blocks.blocks, ...blocks.unallocatedBlocks].map((b) => [
      b.id,
      b.position,
    ]),
  );
  if (points.size !== blocks.completeness.stateBlockRows)
    throw new Error("Native workplace point IDs must be unique.");
  const destinations: AccessibilityDestination[] = [];
  const parsed = await readLodesArea(
    openCommuteSource(wac.path, true),
    "wac",
    (raw, sourceRow) => {
      const point = points.get(raw.w_geocode),
        originalPoint = original.get(raw.w_geocode);
      if (
        !point ||
        !originalPoint ||
        point[0] !== Number(originalPoint.INTPTLON20) ||
        point[1] !== Number(originalPoint.INTPTLAT20)
      )
        throw new Error(
          "A workplace is missing its exact original Census internal point.",
        );
      destinations.push({
        id: raw.w_geocode,
        position: [...point],
        sourceRow,
        cells: Object.fromEntries(
          ACCESSIBILITY_CELLS.map((k) => [k, Number(raw[k])]),
        ),
        raw: { ...raw },
      });
    },
  );
  const checksumText = (await readFile(checksum.path, "utf8")).trim();
  if (checksumText !== `${parsed.source.sha256}  ${name.replace(/\.gz$/, "")}`)
    throw new Error(
      "The complete expanded WAC source does not match its official checksum.",
    );
  const version = await readFile(metadata.path, "utf8"),
    formatVersion = version.match(/Release Format Version\s*([\d.]+)/)?.[1],
    dataVintage = version.match(/Data Vintage:\s*([\w_]+)/)?.[1];
  if (!formatVersion || !dataVintage)
    throw new Error("Retain the exact captured LODES release metadata.");
  const files: AccessibilitySourceFile[] = [
    ...[wac, metadata, checksum].map((f) => ({
      sourceId: "accessibility-lodes-2023",
      url: f.receipt.url,
      sha256: f.receipt.sha256,
      bytes: f.receipt.bytes,
      retrievedAt: f.receipt.retrievedAt,
    })),
    {
      sourceId: "accessibility-block-points",
      url: native.source.url,
      sha256: native.source.sha256,
      bytes: native.source.bytes,
      retrievedAt: native.source.retrievedAt,
    },
    {
      sourceId: "accessibility-block-points",
      url: "",
      sha256: options.blocksSha256,
      bytes: blockBytes.length,
      retrievedAt: native.source.retrievedAt,
      table: "Prepared complete native 2020 block point inventory",
    },
  ];
  const pack: AccessibilityDestinationPack = {
    version: 1,
    id: "az-lodes-2023-jt01-workplaces",
    lodes: {
      year: 2023,
      jobType: "JT01",
      segment: "S000",
      blockGeographyVintage: 2020,
      formatVersion,
      dataVintage,
      createdates: parsed.createdates,
    },
    region: {
      stateFips: "04",
      label: "Arizona — complete retained 2023 primary-job workplaces",
      countyGeoids: counties,
      complete: true,
    },
    pointMethod: "census-native-block-internal-point",
    sources: [
      {
        id: "accessibility-lodes-2023",
        name: "Census LODES 2023 Arizona primary jobs at workplaces",
        url,
        vintage:
          "2023; exact captured release metadata and createdates retained",
        license: "US Census public data",
        kind: "published-estimate",
        description:
          "Complete S000 JT01 WAC; primary-job workplace counts, not vacancies or measured trips.",
      },
      {
        id: "accessibility-block-points",
        name: "Census TIGER2024 native 2020 block internal points",
        url: native.source.url,
        vintage: "2020 blocks, TIGER2024 source",
        license: "US Census public data",
        kind: "observed",
        description:
          "Exact native INTPTLON20/INTPTLAT20 values, not observed workplace entrances. No population allocation or 2024 block-group join is used.",
      },
    ],
    files,
    destinations,
    notes: [
      "All rows of the retained state WAC file are included once, including true-zero counts. No positive-job block is filtered by resident population.",
      "The captured state inventory is complete for the retained LODES source. Completeness of a particular outbound catchment additionally requires both exact state-boundary and network coverage proofs.",
      "Release format/data vintage metadata and row createdates are distinct provenance fields; neither is inferred from the 2023 observation year.",
      "Industry and earnings cells each reconcile separately to C000 for every native source row. Other original WAC cells remain retained in the full source ledger.",
    ],
  };
  assertAccessibilityDestinationPack(pack);
  return pack;
}
export async function writeAccessibilityDestinationPack(
  pack: AccessibilityDestinationPack,
  directory: string,
) {
  assertAccessibilityDestinationPack(pack);
  const bytes = Buffer.from(canonicalJSON(pack));
  if (bytes.length > ACCESSIBILITY_PACK_MAX_BYTES)
    throw new Error("Accessibility pack exceeds its bounded artifact size.");
  const sha256 = digest(bytes),
    path = resolve(directory, `jobs-${sha256}.json`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      digest(await readFile(path)) !== sha256
    )
      throw error;
  }
  return {
    path,
    sha256,
    bytes: bytes.length,
    jobsPackHash: await accessibilityContentHash(pack),
    destinations: pack.destinations.length,
    jobs: pack.destinations.reduce((sum, d) => sum + d.cells.C000, 0),
  };
}
export async function verifyPreparedAccessibilityDestinationPack(
  path: string,
): Promise<AccessibilityDestinationPack> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > ACCESSIBILITY_PACK_MAX_BYTES)
    throw new Error("Invalid bounded accessibility pack.");
  const bytes = await readFile(path);
  const match = path.match(/jobs-([a-f0-9]{64})\.json$/);
  if (!match || digest(bytes) !== match[1])
    throw new Error("Prepared accessibility artifact byte hash mismatch.");
  const pack: unknown = JSON.parse(bytes.toString("utf8"));
  assertAccessibilityDestinationPack(pack);
  return pack;
}
