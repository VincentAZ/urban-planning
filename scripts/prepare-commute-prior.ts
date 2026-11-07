/** Source-derived prior only. Home tract/clock/departure-bin choices are explicit recipe inputs. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  trafficCommuteContentHash,
  type TrafficCommuteSourcePack,
  type TrafficCommuteRecipe,
} from "@urban/core";
import { buildTrafficCommutePrior } from "@urban/models";
import { writeCommuteArtifact } from "../apps/api/src/data/traffic-commute.js";
const args = process.argv.slice(2);
if (args.length !== 3)
  throw new Error(
    "Usage: tsx scripts/prepare-commute-prior.ts SOURCE_PACK.json RECIPE.json OUTPUT_DIRECTORY",
  );
const [sourcePath, recipePath, output] = args.map((path) => resolve(path));
async function read(path: string, cap: number) {
  const file = await lstat(path);
  if (!file.isFile() || file.size > cap)
    throw new Error(
      "Commute prior input is not a regular file within its declared bound.",
    );
  const bytes = await readFile(path);
  if (bytes.length > cap)
    throw new Error("Commute prior input grew beyond its bound.");
  return bytes;
}
const sourceBytes = await read(sourcePath, 64 * 1024 ** 2);
const pack = JSON.parse(
  sourceBytes.toString("utf8"),
) as TrafficCommuteSourcePack;
const recipe = JSON.parse(
  (await read(recipePath, 1024 * 1024)).toString("utf8"),
) as TrafficCommuteRecipe;
const prior = buildTrafficCommutePrior(pack, recipe);
const artifact = await writeCommuteArtifact(output, "commute-prior", prior);
const receipt = await writeCommuteArtifact(output, "commute-prior-receipt", {
  sourcePath,
  sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
  sourcePackHash: await trafficCommuteContentHash(pack),
  priorPath: artifact.path,
  priorHash: await trafficCommuteContentHash(prior),
  recipe,
  methodVersion: prior.methodVersion,
  totals: prior.totals,
  coverage: prior.coverage,
  limitations: [
    "No regional routing or local simulation performed at the prior stage.",
    "This selected resident cohort is not all traffic through the study area. Missing destinations are retained without redistribution.",
  ],
});
console.log(
  JSON.stringify(
    { artifact, receipt, totals: prior.totals, coverage: prior.coverage },
    null,
    2,
  ),
);
