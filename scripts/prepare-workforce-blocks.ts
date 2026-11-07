import { resolve } from "node:path";
import {
  loadWorkforceBlockSource,
  prepareWorkforceBlocks,
  writeWorkforceBlocks,
} from "../apps/api/src/data/workforce-blocks";

// No private records or running service are touched. Only official public source archives and derived origins.
const args = process.argv.slice(2);
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return args[index + 1];
};
for (let i = 0; i < args.length; i += 2)
  if (!["--state", "--counties", "--directory"].includes(args[i]))
    throw new Error(`Unknown option ${args[i]}.`);
const stateFips = value("--state", "04")!;
const directory = resolve(value("--directory", ".local/workforce")!);
const counties = value("--counties");
const blocks = await loadWorkforceBlockSource(
  resolve(directory, "sources"),
  stateFips,
  "tabblock20",
);
process.stdout.write(
  `Verified original blocks: ${blocks.source.records} rows; ${blocks.source.bytes} archive bytes.\n`,
);
const relationships = await loadWorkforceBlockSource(
  resolve(directory, "sources"),
  stateFips,
  "tabblocksufx",
);
process.stdout.write(
  `Verified current block relationships: ${relationships.source.records} rows; ${relationships.source.bytes} archive bytes.\n`,
);
const groups = await loadWorkforceBlockSource(
  resolve(directory, "sources"),
  stateFips,
  "bg",
);
const prepared = prepareWorkforceBlocks({
  stateFips,
  countyGeoids: counties?.split(","),
  blocksDbf: blocks.dbf,
  relationshipsDbf: relationships.dbf,
  blockGroupsDbf: groups.dbf,
  sources: [blocks.source, relationships.source, groups.source],
});
const artifact = await writeWorkforceBlocks(
  resolve(directory, "prepared"),
  prepared,
);
process.stdout.write(
  JSON.stringify({
    ...artifact,
    counties: prepared.completeness.counties,
    geographyMatch: prepared.geographyMatch,
  }) + "\n",
);
