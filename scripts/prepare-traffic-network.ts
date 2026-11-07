/** Operator CLI. First extract complete OSM ways with prepare-traffic-network.py. */
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { TrafficRuntime } from "../apps/api/src/traffic/index.js";
import type { Source } from "@urban/core";

const [extractPath, sourceReceiptPath, outputPath, policyFlag] =
  process.argv.slice(2);
if (
  process.argv.slice(2).length > 4 ||
  (policyFlag !== undefined &&
    policyFlag !== "--infer-unrestricted-service-passenger")
)
  throw new Error(
    "Use only the documented optional --infer-unrestricted-service-passenger policy flag.",
  );
if (!extractPath || !sourceReceiptPath || !outputPath)
  throw new Error(
    "Usage: tsx scripts/prepare-traffic-network.ts EXTRACT.osm.xml SOURCE_RECEIPT.json NEW_OUTPUT_DIRECTORY [--infer-unrestricted-service-passenger]",
  );
const extract = resolve(extractPath),
  destination = resolve(outputPath);
try {
  await stat(destination);
  throw new Error("Refusing to overwrite a captured traffic network.");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const receipt = JSON.parse(
  await readFile(extract.replace(/\.[^.]+$/, ".receipt.json"), "utf8"),
);
const sourceReceipt = JSON.parse(await readFile(sourceReceiptPath, "utf8"));
if (
  sourceReceipt.sha256 !== receipt.sourceSha256 ||
  sourceReceipt.bytes !== receipt.sourceBytes
)
  throw new Error("Original PBF receipt and extract identity differ.");
const source: Source = {
  id: "osm-traffic-az-" + sourceReceipt.sha256.slice(0, 12),
  name: "OpenStreetMap contributors — Arizona retained traffic extract",
  url: "https://www.openstreetmap.org/copyright",
  vintage: sourceReceipt.retrievedAt,
  license: "ODbL 1.0",
  kind: "observed",
  description:
    "Captured mapped road topology, tags and turn restrictions from the retained Geofabrik Arizona PBF. Generated lane connections and control timing are inferred, not field observations.",
};
const runtime = new TrafficRuntime({
  workRoot: resolve(".local/traffic/work"),
  allowedInputRoot: resolve(".local/traffic"),
});
const prepared = await runtime.prepareNetwork({
  ...(policyFlag
    ? { serviceRoadPolicy: "infer-unrestricted-service-passenger" as const }
    : {}),
  osmXmlPath: extract,
  osmXmlSha256: receipt.sha256,
  bounds: receipt.bounds,
  sources: [source],
  sourceFiles: [
    {
      sourceId: source.id,
      url: sourceReceipt.url,
      sha256: sourceReceipt.sha256,
      bytes: sourceReceipt.bytes,
      retrievedAt: sourceReceipt.retrievedAt,
    },
    {
      sourceId: source.id,
      url: "urn:urban:traffic:osm-extract:" + receipt.sha256,
      sha256: receipt.sha256,
      bytes: receipt.bytes,
      retrievedAt: sourceReceipt.retrievedAt,
    },
  ],
  notes: [
    "Full study plus buffered source envelope; complete crossing ways and restriction members retained. " +
      receipt.notes.join(" "),
  ],
});
await mkdir(destination, { recursive: true, mode: 0o700 });
for (const [name, raw] of Object.entries(prepared.files))
  await writeFile(join(destination, name), raw, { flag: "wx", mode: 0o400 });
await writeFile(
  join(destination, "network.json"),
  JSON.stringify(prepared.network),
  { flag: "wx", mode: 0o400 },
);
await writeFile(
  join(destination, "resources.json"),
  JSON.stringify(prepared.resources, null, 2),
  { flag: "wx", mode: 0o400 },
);
console.log(
  JSON.stringify({
    id: prepared.network.id,
    destination,
    nodes: prepared.network.nodes.length,
    edges: prepared.network.edges.length,
    connections: prepared.network.connections.length,
    signals: prepared.network.signals.length,
    resources: prepared.resources,
  }),
);
