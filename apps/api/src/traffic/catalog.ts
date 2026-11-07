import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  TRAFFIC_METHOD_VERSION,
  canonicalJSON,
  trafficContentHash,
  trafficCountPackSchema,
  trafficPeriodSchema,
  studyAreaBounds,
  studyAreaGeometry,
  validateTrafficCountPack,
  type Place,
  type Source,
} from "@urban/core";
import { ApiError } from "../errors.js";
import { loadPreparedTrafficNetwork } from "./runtime.js";
import { SUMO_IMAGE, SUMO_VERSION } from "./types.js";
import type {
  TrafficPreparedIdentity,
  TrafficPreparedChoice,
} from "./jobs-types.js";
import type { TrafficExperimentRequest } from "./experiment.js";
import {
  loadTrafficCommutePreset,
  trafficCommutePresetSchema,
  TRAFFIC_COMMUTE_ASSET_LIMITS,
  trafficCommutePresetView,
  type VerifiedTrafficCommutePreset,
} from "./commute-evidence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const baseEntrySchema = z
  .object({
    id: z.string().min(1).max(160),
    placeId: z.string().min(1).max(160),
    studyAreaHash: hash,
    networkDirectory: z.string().min(1).max(1000),
    networkHash: hash,
    inventoryHash: hash,
    sourceEnvelope: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-85).max(85),
      z.number().min(-180).max(180),
      z.number().min(-85).max(85),
    ]),
    bufferMeters: z.number().finite().min(0).max(50000),
    countPackPath: z.string().min(1).max(1000).optional(),
    countPackHash: hash.optional(),
    initialPeriod: trafficPeriodSchema,
  })
  .strict();
const completeCountReference = (value: z.infer<typeof baseEntrySchema>) =>
  !!value.countPackPath === !!value.countPackHash;
const entrySchema = baseEntrySchema.refine(
  completeCountReference,
  "Retained count pack path and hash are required together",
);
const entryV2Schema = baseEntrySchema
  .extend({
    label: z.string().trim().min(1).max(240),
    defaultForStudy: z.boolean(),
    commutePresets: z
      .array(trafficCommutePresetSchema)
      .max(TRAFFIC_COMMUTE_ASSET_LIMITS.presets)
      .optional(),
  })
  .refine(
    completeCountReference,
    "Retained count pack path and hash are required together",
  );
export const trafficRegistrySchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal(1),
      entries: z.array(entrySchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      entries: z.array(entryV2Schema).min(1).max(100),
    })
    .strict(),
]);
type Entry = z.infer<typeof entrySchema> | z.infer<typeof entryV2Schema>;
const unavailable = (
  message = "No verified traffic network is configured for this exact saved study area.",
) => new ApiError(503, "TRAFFIC_SOURCES_UNAVAILABLE", message);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function trafficWorkerHash() {
  const path = fileURLToPath(
    new URL("../../../../scripts/traffic-worker.py", import.meta.url),
  );
  if ((await lstat(path)).size > 256 * 1024)
    throw unavailable("The native worker exceeds its reviewed source bound.");
  return sha(await readFile(path));
}
async function boundedFile(path: string, cap: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > cap)
    throw unavailable();
  const bytes = await readFile(path);
  if (bytes.length > cap) throw unavailable();
  return bytes;
}
/** Operator-owned registry. No request URL/path or visitor-triggered source fetch is accepted. */
export class TrafficCatalog {
  private entries?: Promise<Entry[]>;
  private loaded = new Map<
    string,
    Promise<Awaited<ReturnType<TrafficCatalog["load"]>>>
  >();
  private loadedCommute = new Map<
    string,
    Promise<VerifiedTrafficCommutePreset[]>
  >();
  constructor(readonly registryPath: string) {}
  private async registry() {
    this.entries ??= (async () => {
      const parsed = trafficRegistrySchema.parse(
        JSON.parse(
          (await boundedFile(resolve(this.registryPath), 128 * 1024)).toString(
            "utf8",
          ),
        ),
      );
      if (
        new Set(parsed.entries.map((entry) => entry.id)).size !==
        parsed.entries.length
      )
        throw unavailable(
          "The prepared traffic registry contains duplicate prepared identities.",
        );
      if (
        parsed.version === 1 &&
        new Set(parsed.entries.map((entry) => entry.placeId)).size !==
          parsed.entries.length
      )
        throw unavailable(
          "The prepared traffic registry contains duplicate study identities.",
        );
      if (parsed.version === 2) {
        const studies = new Map<string, typeof parsed.entries>();
        for (const entry of parsed.entries) {
          const key = canonicalJSON([entry.placeId, entry.studyAreaHash]);
          studies.set(key, [...(studies.get(key) ?? []), entry]);
        }
        for (const entries of studies.values())
          if (entries.filter((entry) => entry.defaultForStudy).length !== 1)
            throw unavailable(
              "Each exact study must have one explicit default prepared traffic identity.",
            );
        for (const entry of parsed.entries)
          if (
            new Set(entry.commutePresets?.map((p) => p.id)).size !==
            (entry.commutePresets?.length ?? 0)
          )
            throw unavailable(
              "A prepared traffic identity has duplicate commute preset identifiers.",
            );
      }
      return parsed.entries;
    })();
    return this.entries;
  }
  private async confined(path: string) {
    const root = await realpath(dirname(resolve(this.registryPath))),
      full = await realpath(resolve(root, path)),
      delta = relative(root, full);
    if (
      !delta ||
      delta === ".." ||
      delta.startsWith(`..${sep}`) ||
      delta.startsWith(sep)
    )
      throw unavailable(
        "A traffic source path is outside the operator registry root.",
      );
    return full;
  }
  private async load(entry: Entry) {
    const network = await loadPreparedTrafficNetwork(
      await this.confined(entry.networkDirectory),
    );
    if (
      network.network.manifest.networkFileSha256 !== entry.networkHash ||
      (await trafficContentHash(network.network)) !== entry.inventoryHash ||
      network.network.manifest.engine.version !== SUMO_VERSION ||
      network.network.manifest.engine.imageDigest !== SUMO_IMAGE.split("@")[1]
    )
      throw unavailable(
        "The prepared native graph or inventory differs from its operator capture.",
      );
    const pack = entry.countPackPath
      ? trafficCountPackSchema.parse(
          JSON.parse(
            (
              await boundedFile(
                await this.confined(entry.countPackPath),
                8 * 1024 ** 2,
              )
            ).toString("utf8"),
          ),
        )
      : {
          version: 1 as const,
          id: `empty-${entry.id}`,
          sources: [],
          files: [],
          counts: [],
          annualCounts: [],
          notes: [
            "No observed count pack was configured. Supply and review local evidence before assessing count fit.",
          ],
        };
    if (
      entry.countPackHash &&
      (await trafficContentHash(pack)) !== entry.countPackHash
    )
      throw unavailable(
        "The configured traffic observations changed; no replacement was fetched.",
      );
    validateTrafficCountPack(pack, network.network);
    return { network, pack, entry };
  }
  async choices(place: Place): Promise<TrafficPreparedChoice[]> {
    try {
      const geometryHash = await trafficContentHash(studyAreaGeometry(place));
      return (await this.registry())
        .filter(
          (entry) =>
            entry.placeId === place.id && entry.studyAreaHash === geometryHash,
        )
        .map((entry) => ({
          id: entry.id,
          label: "label" in entry ? entry.label : entry.id,
          networkHash: entry.networkHash,
        }));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable("The operator traffic choices could not be verified.");
    }
  }
  async forPlace(place: Place, preparedId?: string) {
    try {
      const entries = await this.registry(),
        geometryHash = await trafficContentHash(studyAreaGeometry(place));
      const entry = entries.find(
        (entry) =>
          entry.placeId === place.id &&
          entry.studyAreaHash === geometryHash &&
          (preparedId !== undefined
            ? entry.id === preparedId
            : !("defaultForStudy" in entry) || entry.defaultForStudy),
      );
      if (!entry) throw unavailable();
      const bounds = studyAreaBounds(place),
        source = entry.sourceEnvelope;
      if (
        !(source[0] < source[2] && source[1] < source[3]) ||
        bounds[0] < source[0] ||
        bounds[1] < source[1] ||
        bounds[2] > source[2] ||
        bounds[3] > source[3]
      )
        throw unavailable(
          "The recorded source envelope does not cover the complete saved study area.",
        );
      const key = canonicalJSON(entry);
      if (!this.loaded.has(key)) this.loaded.set(key, this.load(entry));
      const value = await this.loaded.get(key)!;
      const identity: TrafficPreparedIdentity = {
        id: entry.id,
        placeId: place.id,
        studyAreaHash: geometryHash,
        networkHash: entry.networkHash,
        inventoryHash: entry.inventoryHash,
        sourceEnvelope: entry.sourceEnvelope,
        bufferMeters: entry.bufferMeters,
        methodVersion: TRAFFIC_METHOD_VERSION,
        workerHash: await trafficWorkerHash(),
      };
      return { ...value, identity };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable(
        "The operator-configured traffic graph, source records or study binding could not be verified. No download or simulation was started.",
      );
    }
  }
  async commutePresets(
    place: Place,
    preparedId?: string,
    fresh = false,
  ): Promise<VerifiedTrafficCommutePreset[]> {
    const prepared = await this.forPlace(place, preparedId);
    const descriptors =
      "commutePresets" in prepared.entry
        ? (prepared.entry.commutePresets ?? [])
        : [];
    const key = canonicalJSON([
      prepared.identity.networkHash,
      prepared.identity.inventoryHash,
      descriptors,
    ]);
    const load = async () => {
      const presets: VerifiedTrafficCommutePreset[] = [];
      for (const descriptor of descriptors)
        presets.push(
          await loadTrafficCommutePreset({
            descriptor,
            network: prepared.network.network,
            directory: await this.confined(descriptor.directory),
            regionalProofDirectory: await this.confined(
              descriptor.regionalProofDirectory,
            ),
          }),
        );
      if (
        Buffer.byteLength(
          JSON.stringify(presets.map(trafficCommutePresetView)),
        ) >
        8 * 1024 ** 2
      )
        throw unavailable(
          "Prepared commute review data exceeds its 8 MiB context bound. No presets were omitted.",
        );
      return presets;
    };
    if (fresh) return load();
    if (!this.loadedCommute.has(key)) this.loadedCommute.set(key, load());
    return this.loadedCommute.get(key)!;
  }
  async initialRequest(
    place: Place,
    projectId: string,
    preparedId?: string,
  ): Promise<TrafficExperimentRequest> {
    const { entry, network, pack } = await this.forPlace(place, preparedId);
    const source: Source = {
      id: `traffic-authored-${projectId}`,
      name: "Authored traffic assumptions",
      url: "",
      vintage: "Project-authored",
      license:
        "Author-supplied scenario assumptions; private project use until explicitly declared public.",
      kind: "user-supplied",
      description:
        "Explicit trip totals, candidate paths and experiment criteria supplied by the project author. These are assumptions, not an observed OD survey.",
    };
    return {
      version: 1,
      networkHash: network.network.manifest.networkFileSha256,
      countPack: structuredClone(pack),
      demand: {
        version: 1,
        rows: [],
        candidateRoutes: [],
        sources: [source],
        notes: [
          "Enter explicit one-way trip demand and reviewed connected candidate paths. Building/activity changes do not automatically generate these trips.",
        ],
      },
      period: structuredClone(entry.initialPeriod),
      seed: 42,
      overlays: [],
      calibrationPlan: null,
      unsupportedChanges: [],
    };
  }
}
