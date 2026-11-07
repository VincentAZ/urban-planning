import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { workforceContentHash } from "@urban/core";
import {
  readWorkforceAcsSummary,
  type WorkforceAcsTable,
  type WorkforceAcsSubset,
} from "../apps/api/src/data/workforce-acs";
import { buildWorkforceCohortPack } from "../apps/api/src/data/workforce-pack";
import {
  loadWorkforceBlockSource,
  prepareWorkforceBlocks,
  type PreparedWorkforceBlocks,
} from "../apps/api/src/data/workforce-blocks";

const filename = process.argv[2];
if (!filename)
  throw new Error(
    "Usage: tsx scripts/prepare-workforce-pack.ts <prepared blocks JSON> [region label]",
  );
const path = resolve(filename);
if ((await stat(path)).size > 200_000_000)
  throw new Error("Prepared block source exceeds its byte limit.");
const bytes = await readFile(path);
const hash = createHash("sha256").update(bytes).digest("hex");
if (!basename(path).endsWith(`-${hash}.json`))
  throw new Error(
    "Prepared block content does not match its immutable filename.",
  );
const blocks = JSON.parse(bytes.toString("utf8")) as PreparedWorkforceBlocks;
// A self-consistent prepared JSON hash is not evidence that its counts/points
// match Census. Replay the official source join before attaching those citations.
const sourceDirectory = resolve(".local/workforce/sources");
const original = await loadWorkforceBlockSource(
  sourceDirectory,
  blocks.stateFips,
  "tabblock20",
);
const relationships = await loadWorkforceBlockSource(
  sourceDirectory,
  blocks.stateFips,
  "tabblocksufx",
);
const groups = await loadWorkforceBlockSource(
  sourceDirectory,
  blocks.stateFips,
  "bg",
);
const verifiedBlocks = prepareWorkforceBlocks({
  stateFips: blocks.stateFips,
  countyGeoids: blocks.countyGeoids,
  blocksDbf: original.dbf,
  relationshipsDbf: relationships.dbf,
  blockGroupsDbf: groups.dbf,
  sources: [original.source, relationships.source, groups.source],
});
if (JSON.stringify(verifiedBlocks) !== bytes.toString("utf8"))
  throw new Error(
    "Prepared block counts, points or relationships differ from the retained official sources.",
  );
const subsets: WorkforceAcsSubset[] = [];
for (const table of ["B15003", "C24010"] as WorkforceAcsTable[]) {
  const sourcePath = resolve(`.local/workforce/acs-2024/${table}.dat`);
  const receipt = JSON.parse(
    await readFile(`${sourcePath}.receipt.json`, "utf8"),
  );
  const subset = await readWorkforceAcsSummary(
    createReadStream(sourcePath),
    table,
    blocks.stateFips,
    { retrievedAt: receipt.retrievedAt },
  );
  if (
    subset.source.sha256 !== receipt.sha256 ||
    subset.source.bytes !== receipt.bytes ||
    subset.source.url !== receipt.url
  )
    throw new Error(`${table}: cached raw source differs from its receipt.`);
  subsets.push(subset);
}
const pack = buildWorkforceCohortPack({
  blocks: verifiedBlocks,
  education: subsets[0],
  occupation: subsets[1],
  label:
    process.argv[3] ??
    `Census state ${blocks.stateFips} · captured workforce evidence`,
});
const packHash = await workforceContentHash(pack);
const directory = resolve(".local/workforce/packs");
await mkdir(directory, { recursive: true });
const output = resolve(directory, `${packHash}.json`);
const content = JSON.stringify(pack);
const temporary = `${output}.${process.pid}.tmp`;
const handle = await open(temporary, "wx", 0o600);
try {
  await handle.writeFile(content);
  await handle.sync();
  await handle.close();
  try {
    await link(temporary, output);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(output, "utf8")) !== content
    )
      throw error;
  }
} finally {
  await handle.close().catch(() => {});
  await rm(temporary, { force: true });
}
console.log(
  JSON.stringify({
    path: output,
    hash: packHash,
    bytes: Buffer.byteLength(content),
    nativeUnits: pack.units.length,
    origins: pack.origins.length,
    positivePopulationOrigins: pack.origins.filter(
      (origin) => origin.population2020 > 0,
    ).length,
    unavailableAllocationUnits: pack.units
      .filter((unit) => unit.allocationStatus === "unavailable")
      .map((unit) => unit.geoid),
    counties: pack.region.countyGeoids,
  }),
);
