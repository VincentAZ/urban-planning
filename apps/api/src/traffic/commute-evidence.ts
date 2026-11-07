import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  canonicalJSON,
  trafficContentHash,
  verifyTrafficCommuteBinding,
  type TrafficCommuteBinding,
  type TrafficCommuteSummary,
  type TrafficCommuteSourcePack,
  type TrafficCommutePrior,
  type TrafficCommuteRouteSet,
  type TrafficNetwork,
  type TrafficDemand,
} from "@urban/core";
import {
  createTrafficCommuteSummary,
  type TrafficCommuteCompilation,
} from "@urban/models";
import { ApiError } from "../errors.js";
import type { TrafficArchive, TrafficArchiveReference } from "./archive.js";
import type { TrafficExperimentRequest } from "./experiment.js";
import {
  projectRetainedCommuteAttachment,
  type CommuteCorrespondenceEvidence,
} from "./commute-routing.js";
import type { CommuteRegionalRoute } from "./commute-routing-valhalla.js";
import {
  trafficCommuteCorrespondenceSchema,
  trafficCommuteCorrespondenceInputSchema,
  trafficCommuteProofFileLimit,
  trafficCommuteCorrespondenceRecipe,
  expectedTrafficCommuteReplay,
  type TrafficCommuteCorrespondenceInput,
  type TrafficCommuteCorrespondence,
} from "./commute-proof.js";
import {
  verifyTrafficCommuteInWorker,
  withTrafficCommuteProofAdmission,
} from "./commute-proof-worker.js";

export const TRAFFIC_COMMUTE_ASSET_LIMITS = Object.freeze({
  evidenceBytes: 16 * 1024 ** 2,
  manifestBytes: 32 * 1024,
  proofManifestBytes: 2 * 1024 ** 2,
  regionalFileBytes: 16 * 1024 ** 2,
  regionalTotalBytes: 256 * 1024 ** 2,
  regionalFiles: 10000,
  presets: 8,
});
export const TRAFFIC_COMMUTE_ASSET_NAMES = [
  "commute-source-pack.json",
  "commute-prior.json",
  "commute-routes.json",
  "commute-compilation.json",
  "commute-reconciliation.json",
  "commute-regional-proofs.json",
] as const;
type AssetName = (typeof TRAFFIC_COMMUTE_ASSET_NAMES)[number];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z
  .number()
  .int()
  .positive()
  .max(TRAFFIC_COMMUTE_ASSET_LIMITS.evidenceBytes);
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\s<>"'&\u0000-\u001f]+$/u);
export const trafficCommutePresetSchema = z
  .object({
    id: identifier,
    label: z.string().trim().min(1).max(240),
    directory: z.string().min(1).max(1000),
    manifestHash: hash,
    regionalProofDirectory: z.string().min(1).max(1000),
  })
  .strict();
export type TrafficCommutePresetDescriptor = z.infer<
  typeof trafficCommutePresetSchema
>;
const assetManifestSchema = z
  .object({
    version: z.literal(1),
    presetId: identifier,
    files: z
      .array(
        z
          .object({
            name: z.enum(TRAFFIC_COMMUTE_ASSET_NAMES),
            sha256: hash,
            bytes,
          })
          .strict(),
      )
      .length(TRAFFIC_COMMUTE_ASSET_NAMES.length),
  })
  .strict();
const proofName = z
  .string()
  .max(240)
  .regex(
    /^(?:regional\/[a-f0-9]{64}\.json|bindings\/[a-f0-9]{64}\.json|projections\/[a-f0-9]{64}\.json|route-cache\/[a-f0-9]{64}\/(?:route|trace|receipt)\.json)$/,
  );
const proofV1Schema = z
  .object({
    version: z.literal(1),
    retention: z.literal("operator-immutable"),
    routesHash: hash,
    regionalGraphHash: hash,
    regionalSettingsHash: hash,
    files: z
      .array(
        z
          .object({
            name: proofName,
            sha256: hash,
            bytes: z
              .number()
              .int()
              .positive()
              .max(TRAFFIC_COMMUTE_ASSET_LIMITS.regionalFileBytes),
          })
          .strict(),
      )
      .max(TRAFFIC_COMMUTE_ASSET_LIMITS.regionalFiles),
  })
  .strict();
const proofNameV2 = z
  .string()
  .max(240)
  .refine(
    (name) =>
      proofName.safeParse(name).success ||
      /^(?:native\/[a-f0-9]{64}\.net\.xml|sources\/[a-f0-9]{64}\.osm\.xml|projection-artifacts\/[a-f0-9]{64}\.json|recipes\/[a-f0-9]{64}\.json)$/.test(
        name,
      ),
  );
const proofV2Schema = proofV1Schema
  .extend({
    version: z.literal(2),
    files: z
      .array(
        z
          .object({
            name: proofNameV2,
            sha256: hash,
            bytes: z
              .number()
              .int()
              .positive()
              .max(100 * 1024 ** 2),
          })
          .strict()
          .refine(
            (file) => file.bytes <= trafficCommuteProofFileLimit(file.name),
          ),
      )
      .max(TRAFFIC_COMMUTE_ASSET_LIMITS.regionalFiles),
    correspondence: trafficCommuteCorrespondenceSchema,
  })
  .strict();
export const trafficCommuteRegionalProofsSchema = z.discriminatedUnion(
  "version",
  [proofV1Schema, proofV2Schema],
);
type ProofManifest = z.infer<typeof trafficCommuteRegionalProofsSchema>;
export interface TrafficCommutePresetView {
  id: string;
  label: string;
  summary: TrafficCommuteSummary;
  demand: TrafficDemand;
  evidenceFile: { sha256: string; bytes: number };
}
export interface VerifiedTrafficCommutePreset extends TrafficCommutePresetView {
  /** Exact private bundle additions; never expose directory paths or raw regional responses in context. */
  archiveFiles: Record<string, Buffer>;
  evidenceBytes: Buffer;
}
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function unavailable(
  message = "The exact prepared commute evidence is unavailable or changed. No source replacement or routing request was started.",
): never {
  throw new ApiError(503, "TRAFFIC_COMMUTE_UNAVAILABLE", message);
}
function invalid(message: string): never {
  throw new ApiError(422, "TRAFFIC_COMMUTE_BINDING", message);
}
function overLimit(): never {
  throw new ApiError(
    413,
    "TRAFFIC_COMMUTE_LIMIT",
    "Complete normalized commute evidence exceeds its 16 MiB bound. No ledger or source records were truncated.",
  );
}
function parse(raw: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return unavailable(
      "A retained commute JSON artifact is invalid; its original bytes remain unchanged.",
    );
  }
}
async function boundedFile(
  path: string,
  maximum: number,
  expected?: { bytes: number; sha256: string },
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maximum ||
      (expected && info.size !== expected.bytes)
    )
      unavailable();
    const raw = await handle.readFile();
    if (
      raw.length > maximum ||
      (expected &&
        (raw.length !== expected.bytes || sha(raw) !== expected.sha256))
    )
      unavailable();
    return raw;
  } finally {
    await handle.close();
  }
}
async function confined(root: string, name: string) {
  const base = await realpath(root),
    full = await realpath(resolve(base, name)),
    delta = relative(base, full);
  if (
    !delta ||
    delta === ".." ||
    delta.startsWith(`..${sep}`) ||
    delta.startsWith(sep) ||
    (await lstat(resolve(base, name))).isSymbolicLink()
  )
    unavailable("Commute evidence is outside its operator asset directory.");
  return full;
}
function checkManifest(raw: Buffer) {
  if (raw.length > TRAFFIC_COMMUTE_ASSET_LIMITS.manifestBytes) overLimit();
  const manifest = assetManifestSchema.parse(parse(raw));
  if (
    new Set(manifest.files.map((f) => f.name)).size !==
    TRAFFIC_COMMUTE_ASSET_NAMES.length
  )
    unavailable(
      "The commute manifest has duplicate or missing normalized files.",
    );
  if (
    manifest.files.reduce((n, f) => n + f.bytes, raw.length) >
    TRAFFIC_COMMUTE_ASSET_LIMITS.evidenceBytes
  )
    overLimit();
  return manifest;
}
function checkProofManifest(raw: Buffer, routes: TrafficCommuteRouteSet) {
  if (raw.length > TRAFFIC_COMMUTE_ASSET_LIMITS.proofManifestBytes) overLimit();
  const value = trafficCommuteRegionalProofsSchema.parse(parse(raw));
  if (
    new Set(value.files.map((f) => f.name)).size !== value.files.length ||
    value.files.reduce((n, f) => n + f.bytes, 0) >
      TRAFFIC_COMMUTE_ASSET_LIMITS.regionalTotalBytes
  )
    unavailable(
      "The retained regional proof inventory is duplicated or exceeds its bounded capacity.",
    );
  if (
    value.regionalGraphHash !== routes.regionalGraphHash ||
    value.regionalSettingsHash !== routes.regionalSettingsHash ||
    value.routesHash !== sha(canonicalJSON(routes))
  )
    unavailable(
      "Regional proof identities differ from the retained route set.",
    );
  if (value.version === 2) {
    const c = value.correspondence,
      byName = new Map(value.files.map((f) => [f.name, f]));
    trafficCommuteCorrespondenceInputSchema.parse({
      profile: c.profile,
      policyVersion: c.policyVersion,
      nativeXmlFile: c.nativeXml.name,
      sourceGeometryFile: c.sourceGeometry.name,
      projectionArtifactFile: c.projectionArtifact.name,
      recipeFile: c.recipe.name,
    });
    for (const ref of [
      c.nativeXml,
      c.sourceGeometry,
      c.projectionArtifact,
      c.recipe,
    ])
      if (
        canonicalJSON(byName.get(ref.name)) !== canonicalJSON(ref) ||
        ref.name.split("/")[1].split(".")[0] !== ref.sha256
      )
        unavailable(
          "A replay dependency is absent or differs from its exact byte identity.",
        );
  }
  const names = new Set(value.files.map((f) => f.name));
  for (const attachment of routes.attachments) {
    if (
      attachment.regionalRouteHash &&
      !names.has(`regional/${attachment.regionalRouteHash}.json`)
    )
      unavailable(
        "A normalized regional route is absent from the durable proof inventory.",
      );
    if (
      attachment.local &&
      !names.has(`bindings/${attachment.local.bindingHash}.json`)
    )
      unavailable(
        "An exact local route attachment is absent from the durable proof inventory.",
      );
  }
  return value;
}
async function normalized(
  rawManifest: Buffer,
  files: Record<string, Buffer>,
  network: TrafficNetwork,
  expected?: TrafficCommuteBinding,
) {
  const manifest = checkManifest(rawManifest);
  for (const file of manifest.files) {
    const raw = files[file.name];
    if (!raw || raw.length !== file.bytes || sha(raw) !== file.sha256)
      unavailable();
  }
  const sourcePack = parse(
    files["commute-source-pack.json"],
  ) as TrafficCommuteSourcePack;
  const prior = parse(files["commute-prior.json"]) as TrafficCommutePrior;
  const routes = parse(files["commute-routes.json"]) as TrafficCommuteRouteSet;
  const compilation = parse(
    files["commute-compilation.json"],
  ) as TrafficCommuteCompilation;
  const proofManifest = checkProofManifest(
    files["commute-regional-proofs.json"],
    routes,
  );
  if (
    proofManifest.version === 2 &&
    canonicalJSON(proofManifest.correspondence.replay) !==
      canonicalJSON(
        expectedTrafficCommuteReplay(
          { network, routes, correspondence: proofManifest.correspondence },
          proofManifest.correspondence.replay.projectionHash,
        ),
      )
  )
    unavailable(
      "The archived correspondence replay receipt differs from its graph, source, recipe or routed binding inventory.",
    );
  if (
    sourcePack.reconciliation?.evidenceFileSha256 !==
    sha(files["commute-reconciliation.json"])
  )
    unavailable(
      "The full resident/workplace reconciliation does not match the frozen source pack.",
    );
  const binding: TrafficCommuteBinding = {
    version: 1,
    presetId: manifest.presetId,
    assetHash: sha(rawManifest),
    sourcePackHash: await trafficContentHash(sourcePack),
    priorHash: await trafficContentHash(prior),
    routesHash: await trafficContentHash(routes),
    compilationHash: await trafficContentHash(compilation),
    demandHash: await trafficContentHash(compilation.demand),
    periodHash: await trafficContentHash(prior.recipe.period),
    networkHash: network.manifest.networkFileSha256,
    inventoryHash: await trafficContentHash(network),
  };
  if (expected && canonicalJSON(expected) !== canonicalJSON(binding))
    invalid(
      "The selected commute preset differs from its immutable source, compilation, clock or graph binding.",
    );
  const summary = await createTrafficCommuteSummary({
    binding,
    sourcePack,
    prior,
    routes,
    compilation,
    network,
  });
  const evidenceBytes = Buffer.from(
    canonicalJSON({
      version: 1,
      manifest,
      sourcePack,
      prior,
      routes,
      compilation,
      reconciliation: parse(files["commute-reconciliation.json"]),
      regionalProofs: proofManifest,
    }),
  );
  if (evidenceBytes.length > TRAFFIC_COMMUTE_ASSET_LIMITS.evidenceBytes)
    overLimit();
  return {
    summary,
    demand: compilation.demand,
    evidenceBytes,
    sourcePack,
    routes,
    proofManifest,
  };
}
/** Validate actual durable regional files; presence in a mutable cache is never inferred. */
async function verifyRegionalFiles(
  directory: string,
  proof: ProofManifest,
  pack: TrafficCommuteSourcePack,
  routes: TrafficCommuteRouteSet,
  network: TrafficNetwork,
) {
  const entries = new Map(proof.files.map((f) => [f.name, f])),
    byHash = new Map(proof.files.map((f) => [f.sha256, f]));
  const retained = new Map<string, Buffer>();
  // Read and hash each bounded file serially; retain only normalized linking records, not all raw response bodies.
  for (const file of proof.files) {
    const raw = await boundedFile(
      await confined(directory, file.name),
      trafficCommuteProofFileLimit(file.name),
      file,
    );
    if (/^(?:regional|bindings|projections)\//.test(file.name))
      retained.set(file.name, raw);
  }
  const blocks = new Map(pack.blocks.map((b) => [b.geoid, b])),
    flows = new Map(pack.flows.map((f) => [f.id, f]));
  // Manifest envelopes may be smaller than retained lanes. Exclusion must cover both,
  // exactly as the correspondence matcher does, including segments crossing between vertices.
  const bounds = [...network.manifest.bounds];
  for (const edge of network.edges)
    for (const lane of edge.lanes)
      for (const point of lane.shape) {
        bounds[0] = Math.min(bounds[0], point[0]);
        bounds[1] = Math.min(bounds[1], point[1]);
        bounds[2] = Math.max(bounds[2], point[0]);
        bounds[3] = Math.max(bounds[3], point[1]);
      }
  function provesOutside(regional: CommuteRegionalRoute) {
    if (
      !Array.isArray(regional.shape) ||
      regional.shape.length < 2 ||
      regional.shape.some(
        (p) =>
          !Array.isArray(p) ||
          p.length !== 2 ||
          !p.every(Number.isFinite) ||
          Math.abs(p[0]) > 180 ||
          Math.abs(p[1]) > 90,
      )
    )
      return false;
    for (let i = 1; i < regional.shape.length; i++) {
      const a = regional.shape[i - 1],
        b = regional.shape[i];
      let lo = 0,
        hi = 1;
      for (let axis = 0; axis < 2; axis++) {
        const delta = b[axis] - a[axis];
        if (delta === 0) {
          if (a[axis] < bounds[axis] || a[axis] > bounds[axis + 2]) {
            lo = 2;
            break;
          }
        } else {
          const p = (bounds[axis] - a[axis]) / delta,
            q = (bounds[axis + 2] - a[axis]) / delta;
          lo = Math.max(lo, Math.min(p, q));
          hi = Math.min(hi, Math.max(p, q));
        }
      }
      if (lo <= hi) return false;
    }
    return true;
  }
  for (const attachment of routes.attachments) {
    let regional: CommuteRegionalRoute | undefined;
    if (attachment.regionalRouteHash) {
      const raw = retained.get(
        `regional/${attachment.regionalRouteHash}.json`,
      )!;
      regional = parse(raw) as CommuteRegionalRoute;
      const flow = flows.get(attachment.flowId);
      if (
        !flow ||
        sha(canonicalJSON(regional)) !== attachment.regionalRouteHash ||
        regional.graphHash !== routes.regionalGraphHash ||
        regional.settingsHash !== routes.regionalSettingsHash ||
        canonicalJSON(regional.request?.home) !==
          canonicalJSON(blocks.get(flow.homeBlockGeoid)?.position) ||
        canonicalJSON(regional.request?.work) !==
          canonicalJSON(blocks.get(flow.workBlockGeoid)?.position) ||
        !byHash.get(regional.rawRouteHash)?.name.endsWith("/route.json") ||
        !byHash.get(regional.rawTraceHash)?.name.endsWith("/trace.json") ||
        regional.seconds !== attachment.regionalSeconds ||
        ["unreachable", "unsnappable", "outside-coverage"].includes(
          attachment.status,
        )
      )
        unavailable(
          "Retained regional route/raw response identity, outcome, time or modeled source endpoints differ.",
        );
    }
    if (
      attachment.status === "no-local-intersection" &&
      (!regional || !provesOutside(regional))
    )
      unavailable(
        "A no-local-intersection outcome lacks a retained regional route wholly outside the complete native lane extent. Unresolved routes cannot become known out-of-local mass.",
      );
    if (attachment.local) {
      const raw = retained.get(
        `bindings/${attachment.local.bindingHash}.json`,
      )!;
      const evidence = parse(raw) as CommuteCorrespondenceEvidence;
      const { bindingHash, ...body } = evidence;
      if (
        proof.version === 1 &&
        (body.originalSourceGeometryHash != null ||
          body.movements?.some((movement) => movement.centerlineProof != null))
      )
        unavailable(
          "This commute preset requires original-source geometry proof validation that is not enabled for prepared workbench assets. Retain the candidate separately; do not substitute it for the admitted preset.",
        );
      if (
        bindingHash !== attachment.local.bindingHash ||
        sha(canonicalJSON(body)) !== bindingHash ||
        body.nativeXmlHash !== routes.localNetworkHash ||
        body.nativeInventoryHash !== routes.localInventoryHash ||
        body.regionalRouteHash !== attachment.regionalRouteHash
      )
        unavailable(
          "The retained local correspondence proof differs from the exact selected graph or regional route.",
        );
      if (
        !regional ||
        attachment.status !== "routed" ||
        canonicalJSON(
          projectRetainedCommuteAttachment(attachment.flowId, regional, {
            ...evidence,
          }),
        ) !== canonicalJSON(attachment.local)
      )
        unavailable(
          "The prepared local path, endpoint, classification or entry/exit time differs from its retained correspondence proof.",
        );
      if (body.nativeProjectionHash) {
        const name = `projections/${body.nativeProjectionHash}.json`,
          projection = retained.get(name);
        if (
          !entries.has(name) ||
          !projection ||
          sha(canonicalJSON(parse(projection))) !== body.nativeProjectionHash ||
          (parse(projection) as { networkXmlHash: string }).networkXmlHash !==
            routes.localNetworkHash
        )
          unavailable(
            "The exact native coordinate projection proof is unavailable.",
          );
      }
    }
  }
  if (proof.version === 2) {
    const ref = proof.correspondence.recipe;
    const recipe = parse(
      await boundedFile(
        await confined(directory, ref.name),
        trafficCommuteProofFileLimit(ref.name),
        ref,
      ),
    );
    if (
      canonicalJSON(recipe) !==
      canonicalJSON(
        await trafficCommuteCorrespondenceRecipe(
          proof.correspondence.policyVersion,
        ),
      )
    )
      unavailable(
        "The exact correspondence recipe/implementation is not supported by this verifier. Retain the original preset; no automatic upgrade was applied.",
      );
    const replay = await verifyTrafficCommuteInWorker({
      directory,
      files: proof.files,
      network,
      routes,
      correspondence: proof.correspondence,
    });
    if (canonicalJSON(replay) !== canonicalJSON(proof.correspondence.replay))
      unavailable(
        "The retained correspondence replay receipt does not match fresh verification.",
      );
  }
}
async function loadTrafficCommutePresetUnscheduled(input: {
  descriptor: TrafficCommutePresetDescriptor;
  directory: string;
  regionalProofDirectory: string;
  network: TrafficNetwork;
}): Promise<VerifiedTrafficCommutePreset> {
  try {
    const rawManifest = await boundedFile(
      await confined(input.directory, "commute-manifest.json"),
      TRAFFIC_COMMUTE_ASSET_LIMITS.manifestBytes,
    );
    if (sha(rawManifest) !== input.descriptor.manifestHash) unavailable();
    const manifest = checkManifest(rawManifest);
    if (manifest.presetId !== input.descriptor.id) unavailable();
    const files: Record<string, Buffer> = {};
    for (const file of manifest.files)
      files[file.name] = await boundedFile(
        await confined(input.directory, file.name),
        TRAFFIC_COMMUTE_ASSET_LIMITS.evidenceBytes,
        file,
      );
    const checked = await normalized(rawManifest, files, input.network);
    await verifyRegionalFiles(
      input.regionalProofDirectory,
      checked.proofManifest,
      checked.sourcePack,
      checked.routes,
      input.network,
    );
    return {
      id: input.descriptor.id,
      label: input.descriptor.label,
      summary: checked.summary,
      demand: checked.demand,
      evidenceFile: {
        sha256: sha(checked.evidenceBytes),
        bytes: checked.evidenceBytes.length,
      },
      evidenceBytes: checked.evidenceBytes,
      archiveFiles: { "commute-manifest.json": rawManifest, ...files },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailable();
  }
}
export async function loadTrafficCommutePreset(
  input: Parameters<typeof loadTrafficCommutePresetUnscheduled>[0],
) {
  const key = canonicalJSON({
    directory: resolve(input.directory),
    regionalProofDirectory: resolve(input.regionalProofDirectory),
    descriptor: input.descriptor,
    inventoryHash: await trafficContentHash(input.network),
  });
  return withTrafficCommuteProofAdmission(key, () =>
    loadTrafficCommutePresetUnscheduled(input),
  );
}
export async function verifyArchivedTrafficCommute(input: {
  archive: TrafficArchive;
  reference: TrafficArchiveReference;
  scope: { organizationId: string; projectId: string };
  request: TrafficExperimentRequest;
  network: TrafficNetwork;
}): Promise<TrafficCommuteSummary | undefined> {
  if (!input.request.commute) return undefined;
  const rawManifest = await input.archive.read(
    input.scope,
    input.reference,
    "commute-manifest.json",
  );
  const manifest = checkManifest(rawManifest),
    files: Record<string, Buffer> = {};
  for (const file of manifest.files)
    files[file.name] = await input.archive.read(
      input.scope,
      input.reference,
      file.name,
    );
  const checked = await normalized(
    rawManifest,
    files,
    input.network,
    input.request.commute,
  );
  await verifyTrafficCommuteBinding(input.request.commute, {
    demand: input.request.demand,
    period: input.request.period,
    network: input.network,
  });
  return checked.summary;
}
export function trafficCommutePresetView(
  preset: VerifiedTrafficCommutePreset,
): TrafficCommutePresetView {
  return structuredClone({
    id: preset.id,
    label: preset.label,
    summary: preset.summary,
    demand: preset.demand,
    evidenceFile: preset.evidenceFile,
  });
}
export async function verifyPreparedCommuteRequest(
  request: TrafficExperimentRequest,
  network: TrafficNetwork,
  presets: VerifiedTrafficCommutePreset[],
) {
  if (!request.commute) return undefined;
  const preset = presets.find((p) => p.id === request.commute!.presetId);
  if (
    !preset ||
    canonicalJSON(preset.summary.binding) !== canonicalJSON(request.commute)
  )
    invalid(
      "Select an available server-prepared commute recipe for this exact network. Client-supplied evidence cannot establish source authority.",
    );
  await verifyTrafficCommuteBinding(preset.summary.binding, {
    demand: request.demand,
    period: request.period,
    network,
  });
  return preset;
}

/** Operator-only packaging; fixed names and content-addressed equality, never overwrite originals. */
export async function packageTrafficCommutePreset(input: {
  presetId: string;
  outputDirectory: string;
  network: TrafficNetwork;
  sourcePackPath: string;
  priorPath: string;
  routesPath: string;
  compilationPath: string;
  reconciliationPath: string;
  regionalProofDirectory: string;
  correspondence?: TrafficCommuteCorrespondenceInput;
}) {
  identifier.parse(input.presetId);
  if (input.correspondence)
    trafficCommuteCorrespondenceInputSchema.parse(input.correspondence);
  const files: Record<string, Buffer> = {};
  const normalizationFiles: {
    name: string;
    inputSha256: string;
    inputBytes: number;
    packagedSha256: string;
    packagedBytes: number;
    canonicalSha256: string;
  }[] = [];
  for (const [name, path] of Object.entries({
    "commute-source-pack.json": input.sourcePackPath,
    "commute-prior.json": input.priorPath,
    "commute-routes.json": input.routesPath,
    "commute-compilation.json": input.compilationPath,
    "commute-reconciliation.json": input.reconciliationPath,
  })) {
    const original = await boundedFile(
      path,
      TRAFFIC_COMMUTE_ASSET_LIMITS.evidenceBytes,
    );
    if (input.correspondence && name !== "commute-reconciliation.json") {
      const canonical = Buffer.from(canonicalJSON(parse(original)));
      files[name] = canonical;
      normalizationFiles.push({
        name,
        inputSha256: sha(original),
        inputBytes: original.length,
        packagedSha256: sha(canonical),
        packagedBytes: canonical.length,
        canonicalSha256: sha(canonical),
      });
    } else files[name] = original;
  }
  const routes = parse(files["commute-routes.json"]) as TrafficCommuteRouteSet;
  const regionalFiles: ProofManifest["files"] = [];
  async function walk(folder: string, prefix = "") {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink())
        unavailable("Regional evidence may not contain symlinks.");
      if (entry.isDirectory()) {
        if (name.split("/").length > 2)
          unavailable("Regional evidence has an unexpected nested directory.");
        await walk(join(folder, entry.name), name + "/");
      } else if (entry.isFile()) {
        (input.correspondence ? proofNameV2 : proofName).parse(name);
        const raw = await boundedFile(
          join(folder, entry.name),
          trafficCommuteProofFileLimit(name),
        );
        regionalFiles.push({ name, sha256: sha(raw), bytes: raw.length });
        if (
          regionalFiles.length > TRAFFIC_COMMUTE_ASSET_LIMITS.regionalFiles ||
          regionalFiles.reduce((n, f) => n + f.bytes, 0) >
            TRAFFIC_COMMUTE_ASSET_LIMITS.regionalTotalBytes
        )
          unavailable(
            "Regional evidence exceeds its fixed retained-byte/file bound.",
          );
      } else unavailable();
    }
  }
  await walk(await realpath(input.regionalProofDirectory));
  let correspondence: TrafficCommuteCorrespondence | undefined;
  if (input.correspondence) {
    const entries = new Map(regionalFiles.map((f) => [f.name, f])),
      c = input.correspondence;
    const ref = (name: string) => {
      const f = entries.get(name);
      if (!f) unavailable("A required correspondence dependency is absent.");
      return f;
    };
    const refs = {
      profile: c.profile,
      policyVersion: c.policyVersion,
      nativeXml: ref(c.nativeXmlFile),
      sourceGeometry: ref(c.sourceGeometryFile),
      projectionArtifact: ref(c.projectionArtifactFile),
      recipe: ref(c.recipeFile),
    };
    const artifact = parse(
      await boundedFile(
        await confined(input.regionalProofDirectory, c.projectionArtifactFile),
        trafficCommuteProofFileLimit(c.projectionArtifactFile),
        refs.projectionArtifact,
      ),
    ) as { projectionHash: string };
    correspondence = {
      ...refs,
      replay: expectedTrafficCommuteReplay(
        { network: input.network, routes, correspondence: refs },
        artifact.projectionHash,
      ),
    };
  }
  files["commute-regional-proofs.json"] = Buffer.from(
    canonicalJSON({
      version: correspondence ? 2 : 1,
      retention: "operator-immutable",
      routesHash: await trafficContentHash(routes),
      regionalGraphHash: routes.regionalGraphHash,
      regionalSettingsHash: routes.regionalSettingsHash,
      files: regionalFiles,
      ...(correspondence ? { correspondence } : {}),
    }),
  );
  const manifest = {
    version: 1,
    presetId: input.presetId,
    files: TRAFFIC_COMMUTE_ASSET_NAMES.map((name) => ({
      name,
      sha256: sha(files[name]),
      bytes: files[name].length,
    })),
  };
  const rawManifest = Buffer.from(canonicalJSON(manifest));
  const checked = await normalized(rawManifest, files, input.network);
  await verifyRegionalFiles(
    input.regionalProofDirectory,
    checked.proofManifest,
    checked.sourcePack,
    checked.routes,
    input.network,
  );
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  for (const [name, raw] of Object.entries({
    ...files,
    "commute-manifest.json": rawManifest,
  })) {
    const path = join(input.outputDirectory, name);
    try {
      await writeFile(path, raw, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(
          await boundedFile(path, TRAFFIC_COMMUTE_ASSET_LIMITS.evidenceBytes)
        ).equals(raw)
      )
        throw error;
    }
  }
  return {
    presetId: input.presetId,
    manifestHash: sha(rawManifest),
    evidenceFile: {
      sha256: sha(checked.evidenceBytes),
      bytes: checked.evidenceBytes.length,
    },
    summary: checked.summary,
    ...(input.correspondence
      ? {
          normalization: {
            method: "canonical-json" as const,
            files: normalizationFiles,
          },
        }
      : {}),
  };
}
