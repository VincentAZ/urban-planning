/** Operator-only compilation; retains the complete source/route loss ledger and never starts native work. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  canonicalJSON,
  type TrafficCommuteSourcePack,
  type TrafficCommutePrior,
  type TrafficCommuteRouteSet,
  type TrafficNetwork,
} from "@urban/core";
import { compileTrafficCommuteDemand } from "@urban/models";
import { writeCommuteArtifact } from "../apps/api/src/data/traffic-commute.js";

const args = process.argv.slice(2);
if (args.length !== 5)
  throw new Error(
    "Usage: tsx scripts/compile-traffic-commute.ts SOURCE_PACK.json PRIOR.json ROUTE_SET.json NETWORK_DIRECTORY OUTPUT_DIRECTORY",
  );
const [packPath, priorPath, routePath, networkDirectory, output] = args.map(
  (path) => resolve(path),
);
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
async function read(path: string, cap = 64 * 1024 ** 2) {
  const file = await lstat(path);
  if (!file.isFile() || file.size > cap)
    throw new Error(
      "Commute input must be a regular file within its explicit byte bound.",
    );
  const bytes = await readFile(path);
  if (bytes.length > cap)
    throw new Error("Commute input grew beyond its byte bound.");
  return bytes;
}
const paths = [
  packPath,
  priorPath,
  routePath,
  join(networkDirectory, "network.json"),
  join(networkDirectory, "network.net.xml"),
];
const bytes = await Promise.all(paths.map((path) => read(path)));
const [sourcePack, prior, routes, network] = bytes
  .slice(0, 4)
  .map((value) => JSON.parse(value.toString("utf8"))) as [
  TrafficCommuteSourcePack,
  TrafficCommutePrior,
  TrafficCommuteRouteSet,
  TrafficNetwork,
];
if (sha(bytes[4]) !== network.manifest.networkFileSha256)
  throw new Error(
    "The native network bytes do not match the route attachment identity.",
  );
const compiled = await compileTrafficCommuteDemand(prior, routes, network, {
  sourcePack,
  maximumVehicles: 30000,
});
const compilation = await writeCommuteArtifact(
  output,
  "commute-compilation",
  compiled,
);
const demand = await writeCommuteArtifact(
  output,
  "commute-demand",
  compiled.demand,
);
const receipt = await writeCommuteArtifact(
  output,
  "commute-compilation-receipt",
  {
    version: 1,
    inputs: paths.map((path, index) => ({
      path,
      bytes: bytes[index].length,
      sha256: sha(bytes[index]),
    })),
    compilation,
    demand,
    canonicalCompilationSha256: sha(canonicalJSON(compiled)),
    totals: compiled.totals,
    coverage: compiled.coverage,
    notes: [
      "This is an operator-prepared commute subset, not a complete ZIP traffic forecast or an adopted application result.",
      "Every source flow remains in the separate fractional ledger even when its rounded demand is zero. Native simulation and source access review are separate steps.",
    ],
  },
);
console.log(
  JSON.stringify(
    {
      compilation,
      demand,
      receipt,
      totals: compiled.totals,
      coverage: compiled.coverage,
    },
    null,
    2,
  ),
);
