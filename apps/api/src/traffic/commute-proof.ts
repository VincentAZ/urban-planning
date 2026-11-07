/** Pure retained-file correspondence replay. No routing, PROJ process or network access. */
import { constants } from "node:fs";
import { lstat, open, realpath, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  canonicalJSON,
  type TrafficCommuteRouteSet,
  type TrafficNetwork,
} from "@urban/core";
import {
  buildCommuteNativeIndex,
  trafficCommuteMatchPolicy,
  matchCommuteRoute,
} from "./commute-routing.js";
import { restoreCommuteNativeGeometry } from "./commute-routing-projection.js";
import { bindCommuteSourceGeometry } from "./commute-routing-source.js";
import {
  commuteBytesHash,
  commuteHash,
  normalizeCommuteRoute,
  type CommuteRegionalRoute,
} from "./commute-routing-valhalla.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TRAFFIC_COMMUTE_PROOF_PROFILE =
  "original-osm-junction-v1" as const;
const named = (folder: string, extension: string) =>
  z.string().regex(new RegExp(`^${folder}/[a-f0-9]{64}\\.${extension}$`));
export const trafficCommuteCorrespondenceInputSchema = z
  .object({
    profile: z.literal(TRAFFIC_COMMUTE_PROOF_PROFILE),
    policyVersion: z.union([z.literal(2), z.literal(3)]),
    nativeXmlFile: named("native", "net\\.xml"),
    sourceGeometryFile: named("sources", "osm\\.xml"),
    projectionArtifactFile: named("projection-artifacts", "json"),
    recipeFile: named("recipes", "json"),
  })
  .strict();
export type TrafficCommuteCorrespondenceInput = z.infer<
  typeof trafficCommuteCorrespondenceInputSchema
>;
export const trafficCommuteProofFileSchema = z
  .object({
    name: z.string().max(240),
    sha256: hash,
    bytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 ** 2),
  })
  .strict();
export type TrafficCommuteProofFile = z.infer<
  typeof trafficCommuteProofFileSchema
>;
export const trafficCommuteReplayReceiptSchema = z
  .object({
    version: z.literal(1),
    profile: z.literal(TRAFFIC_COMMUTE_PROOF_PROFILE),
    policyVersion: z.union([z.literal(2), z.literal(3)]),
    networkHash: hash,
    inventoryHash: hash,
    sourceGeometryHash: hash,
    projectionHash: hash,
    projectionArtifactHash: hash,
    recipeHash: hash,
    routesHash: hash,
    acceptedBindingsHash: hash,
    routedFlows: z.number().int().min(1).max(5000),
  })
  .strict();
export type TrafficCommuteReplayReceipt = z.infer<
  typeof trafficCommuteReplayReceiptSchema
>;
export const trafficCommuteCorrespondenceSchema = z
  .object({
    profile: z.literal(TRAFFIC_COMMUTE_PROOF_PROFILE),
    policyVersion: z.union([z.literal(2), z.literal(3)]),
    nativeXml: trafficCommuteProofFileSchema,
    sourceGeometry: trafficCommuteProofFileSchema,
    projectionArtifact: trafficCommuteProofFileSchema,
    recipe: trafficCommuteProofFileSchema,
    replay: trafficCommuteReplayReceiptSchema,
  })
  .strict();
export type TrafficCommuteCorrespondence = z.infer<
  typeof trafficCommuteCorrespondenceSchema
>;
export async function trafficCommuteCorrespondenceRecipe(
  policyVersion: 2 | 3 = 2,
) {
  const implementationFiles = [];
  for (const name of [
    "commute-proof.ts",
    "commute-routing.ts",
    "commute-routing-source.ts",
    "commute-routing-projection.ts",
    "commute-routing-valhalla.ts",
  ]) {
    const path = new URL(name, import.meta.url),
      stat = await lstat(path);
    if (!stat.isFile() || stat.size > 256 * 1024)
      fail("Correspondence implementation exceeds its fixed source bound.");
    const bytes = await readFile(path);
    if (bytes.length > 256 * 1024)
      fail("Correspondence implementation exceeds its fixed source bound.");
    implementationFiles.push({
      name,
      sha256: commuteBytesHash(bytes),
      bytes: bytes.length,
    });
  }
  return {
    version: 1,
    profile: TRAFFIC_COMMUTE_PROOF_PROFILE,
    algorithmRevision:
      policyVersion === 2
        ? "positive-source-sides-v2"
        : "source-junction-boundary-sides-v3",
    policyVersion,
    matchPolicy: trafficCommuteMatchPolicy(policyVersion),
    implementationFiles,
    projection: "retained-wgs84-utm-v2",
    source: "exact-retained-native-osm-extract",
    comparison: "entire-routed-correspondence-and-local-attachment",
  };
}
export function trafficCommuteProofFileLimit(name: string) {
  if (/^native\/[a-f0-9]{64}\.net\.xml$/.test(name)) return 64 * 1024 ** 2;
  if (/^sources\/[a-f0-9]{64}\.osm\.xml$/.test(name)) return 100 * 1024 ** 2;
  if (/^projection-artifacts\/[a-f0-9]{64}\.json$/.test(name))
    return 64 * 1024 ** 2;
  if (/^recipes\/[a-f0-9]{64}\.json$/.test(name)) return 16 * 1024;
  return 16 * 1024 ** 2;
}
export type TrafficCommuteReplayInput = {
  directory: string;
  files: TrafficCommuteProofFile[];
  network: TrafficNetwork;
  routes: TrafficCommuteRouteSet;
  correspondence: Omit<TrafficCommuteCorrespondence, "replay">;
};
function fail(message: string): never {
  throw new Error(message);
}
function parse(raw: Buffer) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
}
function accepted(routes: TrafficCommuteRouteSet) {
  return routes.attachments
    .filter((a) => a.local)
    .map((a) => ({ flowId: a.flowId, bindingHash: a.local!.bindingHash }));
}
export function expectedTrafficCommuteReplay(
  input: Omit<TrafficCommuteReplayInput, "directory" | "files">,
  projectionHash: string,
): TrafficCommuteReplayReceipt {
  return {
    version: 1,
    profile: TRAFFIC_COMMUTE_PROOF_PROFILE,
    policyVersion: input.correspondence.policyVersion,
    networkHash: input.network.manifest.networkFileSha256,
    inventoryHash: commuteHash(input.network),
    sourceGeometryHash: input.correspondence.sourceGeometry.sha256,
    projectionHash,
    projectionArtifactHash: input.correspondence.projectionArtifact.sha256,
    recipeHash: input.correspondence.recipe.sha256,
    routesHash: commuteHash(input.routes),
    acceptedBindingsHash: commuteHash(accepted(input.routes)),
    routedFlows: accepted(input.routes).length,
  };
}
export async function replayTrafficCommuteCorrespondence(
  input: TrafficCommuteReplayInput,
): Promise<TrafficCommuteReplayReceipt> {
  const root = await realpath(input.directory),
    files = new Map(input.files.map((f) => [f.name, f]));
  async function read(file: TrafficCommuteProofFile) {
    if (canonicalJSON(files.get(file.name)) !== canonicalJSON(file))
      fail("Correspondence dependency is absent from its manifest.");
    const candidate = resolve(root, file.name),
      full = await realpath(candidate),
      delta = relative(root, full);
    if (
      !delta ||
      delta === ".." ||
      delta.startsWith(`..${sep}`) ||
      delta.startsWith(sep) ||
      (await lstat(candidate)).isSymbolicLink()
    )
      fail("Correspondence dependency is outside its retained directory.");
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(),
        limit = trafficCommuteProofFileLimit(file.name);
      if (!stat.isFile() || stat.size !== file.bytes || stat.size > limit)
        fail("Correspondence dependency size differs or exceeds its bound.");
      const raw = await handle.readFile();
      if (
        raw.length !== file.bytes ||
        raw.length > limit ||
        commuteBytesHash(raw) !== file.sha256
      )
        fail("Correspondence dependency bytes changed.");
      return raw;
    } finally {
      await handle.close();
    }
  }
  const c = input.correspondence;
  trafficCommuteCorrespondenceInputSchema.parse({
    profile: c.profile,
    policyVersion: c.policyVersion,
    nativeXmlFile: c.nativeXml.name,
    sourceGeometryFile: c.sourceGeometry.name,
    projectionArtifactFile: c.projectionArtifact.name,
    recipeFile: c.recipe.name,
  });
  for (const file of [
    c.nativeXml,
    c.sourceGeometry,
    c.projectionArtifact,
    c.recipe,
  ])
    if (file.name.split("/")[1].split(".")[0] !== file.sha256)
      fail("Correspondence file name differs from its exact byte hash.");
  const recipe = parse(await read(c.recipe));
  if (
    canonicalJSON(recipe) !==
    canonicalJSON(await trafficCommuteCorrespondenceRecipe(c.policyVersion))
  )
    fail(
      "Unsupported correspondence recipe; no fallback matching policy was applied.",
    );
  let index = buildCommuteNativeIndex(input.network, await read(c.nativeXml));
  index = restoreCommuteNativeGeometry(index, await read(c.projectionArtifact));
  index = bindCommuteSourceGeometry(index, await read(c.sourceGeometry));
  const regionalRoutes = new Map<string, CommuteRegionalRoute>();
  for (const attachment of input.routes.attachments) {
    if (!attachment.regionalRouteHash) continue;
    if (regionalRoutes.has(attachment.regionalRouteHash)) continue;
    const file = files.get(`regional/${attachment.regionalRouteHash}.json`);
    if (!file) fail("Retained regional route is absent.");
    const regional = parse(await read(file)) as CommuteRegionalRoute;
    if (
      commuteHash(regional) !== attachment.regionalRouteHash ||
      !index.sourcePbfHashes.includes(regional.sourcePbfHash)
    )
      fail("Regional route differs from the exact shared PBF/native source.");
    const identity = {
        home: regional.request.home,
        work: regional.request.work,
        graphHash: regional.graphHash,
        settingsHash: regional.settingsHash,
        sourcePbfHash: regional.sourcePbfHash,
      },
      key = commuteHash(identity);
    const routeFile = files.get(`route-cache/${key}/route.json`),
      traceFile = files.get(`route-cache/${key}/trace.json`),
      receiptFile = files.get(`route-cache/${key}/receipt.json`);
    if (!routeFile || !traceFile || !receiptFile)
      fail("The exact source-pair raw route/trace receipt is absent.");
    const rawRoute = await read(routeFile),
      rawTrace = await read(traceFile),
      receipt = parse(await read(receiptFile));
    if (
      receipt.routeStatus !== 200 ||
      receipt.traceStatus !== 200 ||
      receipt.routeHash !== commuteBytesHash(rawRoute) ||
      receipt.traceHash !== commuteBytesHash(rawTrace)
    )
      fail(
        "The raw route/trace status or identity differs from its retained receipt.",
      );
    const rebuilt = normalizeCommuteRoute({ ...identity, rawRoute, rawTrace });
    if (canonicalJSON(rebuilt.route) !== canonicalJSON(regional))
      fail(
        "Normalized regional geometry, elapsed time or source metadata differs from exact retained route/trace bytes.",
      );
    regionalRoutes.set(attachment.regionalRouteHash, regional);
  }
  const routed = input.routes.attachments.filter((a) => a.local);
  if (!routed.length || routed.length > 5000)
    fail("Correspondence replay exceeds its accepted-route bound.");
  for (const attachment of routed) {
    const regionalFile = files.get(
        `regional/${attachment.regionalRouteHash}.json`,
      ),
      bindingFile = files.get(`bindings/${attachment.local!.bindingHash}.json`);
    if (!regionalFile || !bindingFile)
      fail("Accepted correspondence is missing its retained inputs.");
    const regional = parse(await read(regionalFile)) as CommuteRegionalRoute,
      evidence = parse(await read(bindingFile));
    const replay = matchCommuteRoute(attachment.flowId, regional, index, {
      policyVersion: c.policyVersion,
    });
    if (
      canonicalJSON(replay.evidence) !== canonicalJSON(evidence) ||
      canonicalJSON(replay.attachment.local) !==
        canonicalJSON(attachment.local) ||
      replay.attachment.status !== attachment.status ||
      replay.attachment.regionalSeconds !== attachment.regionalSeconds
    )
      fail(
        "Retained original-source junction correspondence does not replay exactly.",
      );
  }
  return trafficCommuteReplayReceiptSchema.parse(
    expectedTrafficCommuteReplay(input, index.projectionHash!),
  );
}
