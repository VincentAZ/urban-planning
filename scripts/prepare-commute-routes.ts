/** Bounded operator capture: one retained regional route per selected source OD, never a sampled subset. */
import { readFile, stat, mkdir, open, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  canonicalJSON,
  trafficCommuteRoutingFlows,
  validateTrafficCommuteSourcePack,
  validateTrafficCommuteRecipe,
  validateTrafficCommuteRouteSet,
  type TrafficCommuteSourcePack,
  type TrafficCommuteRouteAttachment,
  type TrafficCommuteRouteSet,
  type TrafficNetwork,
} from "@urban/core";
import {
  CommuteValhallaRouter,
  CommuteRoutingError,
  normalizeCommuteRoute,
  commuteHash,
  commuteBytesHash,
  commuteMeters,
} from "../apps/api/src/traffic/commute-routing-valhalla.js";
import {
  projectCommuteNativeGeometry,
  restoreCommuteNativeGeometry,
  commuteProjectionArtifact,
} from "../apps/api/src/traffic/commute-routing-projection.js";
import { bindCommuteSourceGeometry } from "../apps/api/src/traffic/commute-routing-source.js";
import {
  buildCommuteNativeIndex,
  matchCommuteRoute,
} from "../apps/api/src/traffic/commute-routing.js";
import {
  loadRoutingManifest,
  pointCovered,
} from "../apps/api/src/routing/manifest.js";
const args = process.argv.slice(2);
const policyAt = args.indexOf("--policy-version"),
  policyValue = policyAt < 0 ? "2" : args[policyAt + 1];
if (policyValue !== "2" && policyValue !== "3")
  throw new Error("--policy-version must be 2 or 3.");
const policyVersion = Number(policyValue) as 2 | 3;
if (policyAt >= 0) args.splice(policyAt, 2);
function option(name: string): string | null {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const value = args[at + 1];
  if (!value || value.startsWith("--"))
    throw new Error("Missing " + name + " argument");
  args.splice(at, 2);
  return resolve(value);
}
const cachePath = option("--route-cache"),
  projectionPath = option("--projection-cache"),
  sourceGeometryPath = option("--source-geometry");
const cachedOnly = args.includes("--cached-only");
if (cachedOnly) args.splice(args.indexOf("--cached-only"), 1);
if (args.length > 5 || args.some((a) => a.startsWith("--")))
  throw new Error("Unknown commute routing argument");
if (cachedOnly && !projectionPath)
  throw new Error(
    "Cached-only replay requires --projection-cache; no native projection is started.",
  );
const source = resolve(
    args[0] ??
      ".local/traffic/commute-prepared/commute-pack-d28719b8d15329804b39ff7229bcb9b6ae715e051aad65fbfa6bdd4337e0dd07.json",
  ),
  proofPath = resolve(args[1] ?? ".local/qa/traffic/commute/prior-proof.json"),
  profileDir = resolve(
    args[2] ?? ".local/traffic/commute-routing/profile-1c1c41886db5299e",
  ),
  nativeDir = resolve(
    args[3] ?? ".local/traffic/networks/phoenix-85004-1km-stable-turns",
  ),
  output = resolve(args[4] ?? ".local/qa/traffic/commute-routing");
async function bounded(path: string, cap = 64 * 1024 ** 2) {
  if ((await stat(path)).size > cap) throw new Error("Input exceeds bound");
  const b = await readFile(path);
  if (b.length > cap) throw new Error("Input exceeds bound");
  return b;
}
async function immutable(path: string, bytes: string | Buffer) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const tmp = path + "." + process.pid + ".tmp",
    f = await open(tmp, "wx", 0o600);
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
  try {
    await link(tmp, path);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== "EEXIST" ||
      commuteBytesHash(await bounded(path)) !== commuteBytesHash(bytes)
    )
      throw e;
  } finally {
    await unlink(tmp);
  }
}
const pack = JSON.parse(
    (await bounded(source)).toString(),
  ) as TrafficCommuteSourcePack,
  proof = JSON.parse((await bounded(proofPath, 2 * 1024 ** 2)).toString()),
  profile = JSON.parse(
    (await bounded(join(profileDir, "profile.json"), 2 * 1024 ** 2)).toString(),
  ),
  network = JSON.parse(
    (await bounded(join(nativeDir, "network.json"))).toString(),
  ) as TrafficNetwork;
validateTrafficCommuteSourcePack(pack);
validateTrafficCommuteRecipe(proof.recipe, pack);
if (commuteHash(pack) !== proof.sourcePackHash)
  throw new Error("Prior and source pack differ");
const prior = JSON.parse((await bounded(resolve(proof.priorPath))).toString());
if (commuteHash(prior) !== proof.priorHash)
  throw new Error("Prior checksum mismatch");
let native = buildCommuteNativeIndex(
  network,
  await bounded(join(nativeDir, "network.net.xml")),
);
native = projectionPath
  ? restoreCommuteNativeGeometry(native, await bounded(projectionPath))
  : await projectCommuteNativeGeometry(native);
if (sourceGeometryPath)
  native = bindCommuteSourceGeometry(
    native,
    await bounded(sourceGeometryPath, 100 * 1024 ** 2),
  );
const manifest = await loadRoutingManifest(
  join(profile.graphDirectory, "manifest.json"),
);
if (
  commuteBytesHash(
    await bounded(join(profile.graphDirectory, "manifest.json"), 2 * 1024 ** 2),
  ) !== profile.sourceManifestSha256 ||
  canonicalJSON(manifest.graph) !== canonicalJSON(profile.graph) ||
  canonicalJSON(manifest.sources) !== canonicalJSON(profile.sourceFiles)
)
  throw new Error(
    "Regional profile no longer matches its retained graph manifest.",
  );

if (
  commuteBytesHash(
    await bounded(join(profileDir, "valhalla.json"), 2 * 1024 ** 2),
  ) !== profile.configSha256
)
  throw new Error("Route profile config changed");
if (native.projectionHash && native.projectionReceipt)
  await immutable(
    join(output, "projections", native.projectionHash + ".json"),
    canonicalJSON(native.projectionReceipt),
  );
const projectionArtifact = commuteProjectionArtifact(native);
await immutable(
  join(
    output,
    "projection-artifacts",
    commuteHash(projectionArtifact) + ".json",
  ),
  canonicalJSON(projectionArtifact),
);
const blocks = new Map(pack.blocks.map((b) => [b.geoid, b])),
  identity = {
    graphHash: profile.graph.sha256,
    settingsHash: profile.configSha256,
    sourcePbfHash: profile.sourceFiles[0].sha256,
  };
const selected = new Set(
  trafficCommuteRoutingFlows(pack, proof.recipe).map((f) => f.id),
);
if (!selected.size) throw new Error("Prior has no selected source flows");
const attachments: TrafficCommuteRouteAttachment[] = [],
  started = new Date().toISOString();
let queried = 0,
  cached = 0;
for (const flow of pack.flows.filter((f) => selected.has(f.id))) {
  const home = blocks.get(flow.homeBlockGeoid)?.position,
    work = blocks.get(flow.workBlockGeoid)?.position;
  const base = {
    flowId: flow.id,
    regionalRouteHash: null,
    regionalSeconds: null,
    local: null,
    notes: [],
  };
  if (!home || !work) {
    attachments.push({
      ...base,
      status: "unsnappable",
      notes: ["One or both retained block internal points are unavailable."],
    });
    continue;
  }
  if (commuteMeters(home, work) < 0.01) {
    attachments.push({
      ...base,
      status: "unmatched-local-network",
      notes: [
        "Coincident representative block points cannot resolve a within-block commute route; demand mass is not treated as zero.",
      ],
    });
    continue;
  }
  if (!pointCovered(home, manifest) || !pointCovered(work, manifest)) {
    attachments.push({
      ...base,
      status: "outside-coverage",
      notes: [
        "A retained endpoint lies outside the captured regional polygon; no extrapolated route was requested.",
      ],
    });
    continue;
  }
  const key = commuteHash({ home, work, ...identity }),
    dir = join(cachePath ?? join(output, "route-cache"), key);
  if (!cachedOnly) await mkdir(dir, { recursive: true });
  let captured;
  try {
    let response: {
      routeHash: string;
      traceHash: string | null;
      routeStatus: number;
      traceStatus: number | null;
    } | null = null;
    try {
      response = JSON.parse(
        (await bounded(join(dir, "receipt.json"), 10000)).toString(),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (response) {
      const rawRoute = await bounded(join(dir, "route.json"), 16 * 1024 ** 2);
      if (commuteBytesHash(rawRoute) !== response.routeHash)
        throw new Error("Cached route bytes changed");
      cached++;
      if (response.routeStatus >= 400) {
        const error = JSON.parse(rawRoute.toString());
        throw new CommuteRoutingError(
          error.error_code === 442
            ? "UNREACHABLE"
            : error.error_code === 171
              ? "UNSNAPPABLE"
              : "ROUTING_FAILED",
          `Regional route failed (${response.routeStatus}); cached original response retained.`,
        );
      }
      if (!response.traceHash)
        throw new Error(
          "Successful route has no completed exact trace receipt",
        );
      const rawTrace = await bounded(join(dir, "trace.json"), 16 * 1024 ** 2);
      if (commuteBytesHash(rawTrace) !== response.traceHash)
        throw new Error("Cached trace bytes changed");
      captured = normalizeCommuteRoute({
        home,
        work,
        ...identity,
        rawRoute,
        rawTrace,
      });
    } else {
      if (cachedOnly)
        throw new Error(
          "The exact captured route receipt is unavailable; cached-only replay forbids new requests.",
        );
      const bodies = new Map<string, { bytes: Buffer; status: number }>(),
        client = new CommuteValhallaRouter(
          "http://127.0.0.1:8004",
          identity,
          fetch,
          async (action, bytes, status) => {
            bodies.set("/" + action, { bytes, status });
          },
        );
      try {
        captured = await client.route(home, work);
      } finally {
        queried++;
        for (const [name, v] of bodies)
          await immutable(
            join(dir, name === "/route" ? "route.json" : "trace.json"),
            v.bytes,
          );
        const route = bodies.get("/route"),
          trace = bodies.get("/trace_attributes");
        if (route && (trace || route.status >= 400))
          await immutable(
            join(dir, "receipt.json"),
            canonicalJSON({
              routeHash: commuteBytesHash(route.bytes),
              traceHash: trace ? commuteBytesHash(trace.bytes) : null,
              routeStatus: route.status,
              traceStatus: trace?.status ?? null,
            }),
          );
      }
    }
    await immutable(
      join(output, "regional", captured.routeHash + ".json"),
      canonicalJSON(captured.route),
    );
    const matched = matchCommuteRoute(flow.id, captured.route, native, {
      policyVersion,
    });
    attachments.push(matched.attachment);
    await immutable(
      join(output, "bindings", matched.evidence.bindingHash + ".json"),
      canonicalJSON(matched.evidence),
    );
  } catch (error) {
    const code =
        error instanceof CommuteRoutingError ? error.code : "EVIDENCE_REJECTED",
      status: TrafficCommuteRouteAttachment["status"] =
        code === "UNREACHABLE"
          ? "unreachable"
          : code === "UNSNAPPABLE"
            ? "unsnappable"
            : "unmatched-local-network";
    attachments.push({
      ...base,
      status,
      notes: [
        `${code}: ${error instanceof Error ? error.message : String(error)}`,
        `Raw response cache identity: ${key}`,
      ],
    });
  }
  if (attachments.length % 25 === 0)
    console.log(
      JSON.stringify({
        processed: attachments.length,
        total: selected.size,
        queried,
        cached,
        routed: attachments.filter((a) => a.status === "routed").length,
      }),
    );
}
if (attachments.length !== selected.size)
  throw new Error("Selected prior sourceflow coverage is incomplete");
const routeSet: TrafficCommuteRouteSet = {
  version: 1,
  sourcePackHash: proof.sourcePackHash,
  priorHash: proof.priorHash,
  regionalGraphHash: identity.graphHash,
  regionalSettingsHash: identity.settingsHash,
  localNetworkHash: native.networkHash,
  localInventoryHash: native.inventoryHash,
  attachments,
  notes: [
    "All selected source flows retained exactly once; no silent flow cap or rerouting to a convenient port.",
    "Modelled block internal points, static car route, captured shared OSM source; not observed driveways or travel routes.",
    "Raw route/trace receipts and full geometry/time/source correspondence archived separately.",
  ],
};
validateTrafficCommuteRouteSet(routeSet, [...selected]);
const hash = commuteHash(routeSet),
  path = join(output, "routes-" + hash + ".json");
await immutable(path, canonicalJSON(routeSet));
const summary = {
  started,
  finished: new Date().toISOString(),
  sourceFileSha256: commuteBytesHash(await bounded(source)),
  sourcePackHash: proof.sourcePackHash,
  priorHash: proof.priorHash,
  path,
  hash,
  queried,
  cached,
  counts: Object.fromEntries(
    [...new Set(attachments.map((a) => a.status))].map((s) => [
      s,
      attachments.filter((a) => a.status === s).length,
    ]),
  ),
};
await immutable(
  join(output, "run-" + commuteHash(summary) + ".json"),
  canonicalJSON(summary),
);
console.log(JSON.stringify(summary));
