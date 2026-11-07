/** Creates a separately hashed, read-only route/trace profile. Never alters a retained graph. */
import { createHash } from "node:crypto";
import { readFile, mkdir, open, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { canonicalJSON } from "@urban/core";
import { loadRoutingManifest } from "../apps/api/src/routing/manifest.js";
const args = process.argv.slice(2);
const input = resolve(
  args[0] ?? ".local/routing/graphs/az-c51ee5445439a68b/manifest.json",
);
const destination = resolve(args[1] ?? ".local/traffic/commute-routing");
const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const manifest = await loadRoutingManifest(input);
const config = JSON.parse(
  await readFile(join(resolve(input, ".."), "valhalla.json"), "utf8"),
);
config.loki.actions = ["locate", "route", "trace_attributes", "status"];
config.thor.clear_reserved_memory = true;
config.thor.max_reserved_labels_count_astar = 200000;
config.thor.max_reserved_labels_count_bidir_astar = 200000;
config.thor.max_reserved_labels_count_dijkstras = 100000;
config.service_limits.auto.max_locations = 2;
config.service_limits.trace.max_shape = 16000;
config.service_limits.trace.max_distance = 200000;
config.service_limits.trace.max_alternates = 1;
const raw = canonicalJSON(config),
  hash = sha(raw);
const directory = join(destination, `profile-${hash.slice(0, 16)}`);
await mkdir(directory, { recursive: true });
async function immutable(name: string, bytes: string) {
  const path = join(directory, name),
    temporary = path + `.${process.pid}.tmp`;
  const f = await open(temporary, "wx", 0o644);
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
  try {
    await link(temporary, path);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(path, "utf8")) !== bytes
    )
      throw e;
  } finally {
    await unlink(temporary);
  }
}
await immutable("valhalla.json", raw);
const profile = {
  version: 1,
  engine: manifest.engine,
  sourceManifestSha256: sha(await readFile(input)),
  graph: manifest.graph,
  graphDirectory: resolve(input, ".."),
  sourceFiles: manifest.sources,
  baseConfigSha256: manifest.config.sha256,
  configSha256: hash,
  actions: config.loki.actions,
  limits: {
    maximumRouteMeters: 200000,
    maximumShapePoints: 16000,
    maximumSnapMeters: 250,
  },
  notes: [
    "Static auto routing, no traffic observations or time dependence.",
    "Route and exact edge_walk trace share this separately captured profile.",
    "Retained graph and previous service configuration are unchanged.",
  ],
};
await immutable("profile.json", canonicalJSON(profile));
console.log(
  JSON.stringify({
    directory,
    configSha256: hash,
    graphSha256: manifest.graph.sha256,
    profileSha256: sha(canonicalJSON(profile)),
  }),
);
