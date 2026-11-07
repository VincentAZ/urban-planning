import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePlace } from "@urban/core";
import { prepareFloodDataset } from "../apps/api/src/data/flood";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--place" || args[2] !== "--output")
  throw new Error(
    "Usage: tsx scripts/prepare-flood.ts --place BASELINE.json --output NEW_DIRECTORY",
  );
const path = resolve(args[1]);
if ((await stat(path)).size > 32 * 1024 * 1024)
  throw new Error("Baseline file exceeds32MiB.");
const raw = await readFile(path);
if (raw.length > 32 * 1024 * 1024)
  throw new Error("Baseline file exceeds32MiB.");
const place = validatePlace(JSON.parse(raw.toString("utf8")));
console.log(
  JSON.stringify(await prepareFloodDataset(place, resolve(args[3])), null, 2),
);
