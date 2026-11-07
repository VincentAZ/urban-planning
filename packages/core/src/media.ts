import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { canonicalJSON } from "./canonical";
import {
  presentationCameraSchema,
  MAX_PRESENTATION_STOPS,
} from "./presentation";
import {
  floodDatasetHashSync,
  floodDatasetCatalogSchema,
  floodMethodVersion,
} from "./flood";
import {
  placeSchema,
  scenarioSchema,
  sourceSchema,
  fiscalResolutionSchema,
} from "./validation";
import {
  fiscalProfileSchema,
  fiscalProfileHash,
  type FiscalProfile,
  type FiscalStudy,
} from "./fiscal";
import { USER_ACTIVITY_SOURCE } from "./activity";
import { USER_RETAIL_SOURCE } from "./retail";
import type { Place, Scenario, Source, ModelResults } from "./index";
import type { FloodDatasetCatalog } from "./flood";
import type { PresentationCamera } from "./presentation";

export const MEDIA_METHOD_VERSION = "media-export-1.0.0" as const;
export const MEDIA_CAMERA_METHOD_VERSION = "mercator-smoothstep-1.0.0" as const;
export const MEDIA_FPS = 30;
/** Contract bounds, not a claim that every deployment can render this workload. */
export const MAX_MEDIA_FRAMES = 30_000;
export const MAX_MEDIA_SCENE_BYTES = 32 * 1024 * 1024;
export const MAX_MEDIA_COORDINATES = 500_000;
export const MAX_MEDIA_CAPTION_LENGTH = 240;
export const MEDIA_HOLD_REUSE_NOTE =
  "Identical frames within a saved stop's hold may reuse an earlier completed render from that same hold. Every output frame retains its own logical timestamp; reused frames do not claim a new draw.";
export const MEDIA_LAYERS = [
  "buildings",
  "roads",
  "parks",
  "parcels",
  "flood",
] as const;
export type MediaLayer = (typeof MEDIA_LAYERS)[number];
export type MediaView = "3d" | "2d";
export interface MediaSource {
  namespace: string;
  source: Source;
}
export interface MediaSceneBinding {
  projectId: string;
  projectVersion: number;
  placeId: string;
  baselineHash: string;
  scenarioId: string;
  scenarioRevision: number;
  scenarioHash: string;
  resultsHash: string;
  presentationHash: string | null;
  datasetsHash: string;
  sourcesHash: string;
  fiscalProfileHash?: string;
}
/** One saved scenario only. Never include project history, access lists, sessions or comments. */
export interface MediaScene {
  version: 1;
  createdAt: string;
  binding: MediaSceneBinding;
  place: Place;
  scenario: Scenario;
  results: ModelResults;
  floodDatasets?: FloodDatasetCatalog;
  fiscalProfile?: FiscalProfile;
  sources: MediaSource[];
  sceneHash: string;
}
interface MediaRecipeBase {
  version: 1;
  methodVersion: typeof MEDIA_METHOD_VERSION;
  width: number;
  height: number;
  layers: MediaLayer[];
  timeOfDay: number;
  agents: "none";
  audio: "none";
}
export interface MediaStillRecipe extends MediaRecipeBase {
  format: "png";
  camera: PresentationCamera;
  view: MediaView;
  caption: string;
}
export interface MediaTourStop {
  stopId: string;
  holdFrames: number;
  /** Frames after this hold leading to the next stop; the final stop requires zero. */
  transitionFrames: number;
  /** Explicit brief screen text; full authored callout/narration always remain in sidecars. */
  caption?: string;
}
export interface MediaVideoRecipe extends MediaRecipeBase {
  format: "mp4";
  fps: 30;
  cameraMethodVersion: typeof MEDIA_CAMERA_METHOD_VERSION;
  stops: MediaTourStop[];
}
export type MediaExportRecipe = MediaStillRecipe | MediaVideoRecipe;
export interface MediaRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MediaLayout {
  map: MediaRectangle;
  callout: MediaRectangle;
  credits: MediaRectangle;
}
export interface MediaFrame {
  index: number;
  timeSeconds: number;
  /** Integer microsecond timestamps use floor(i*1e6/fps), with no accumulated rounding. */
  timestampMicroseconds: number;
  durationMicroseconds: number;
  camera: PresentationCamera;
  view: MediaView;
  stopId: string | null;
  title: string;
  caption: string;
  metricIds: string[];
  phase: "still" | "hold" | "transition";
}
export interface MediaFrameReceipt {
  index: number;
  timestampMicroseconds: number;
  durationMicroseconds: number;
  sceneHash: string;
  recipeHash: string;
  generation: string;
  drawSerial: number;
  requestedCamera: PresentationCamera;
  actualCamera: PresentationCamera;
  width: number;
  height: number;
  pixelHash: string;
  /** Earlier genuine draw in this same hold; never a transition or a different stop. */
  reusedFromFrame?: number;
}
export interface MediaOutputFile {
  name: string;
  sha256: string;
  bytes: number;
  contentType: string;
}
export interface MediaExportManifest {
  version: 1;
  methodVersion: typeof MEDIA_METHOD_VERSION;
  sceneHash: string;
  binding: MediaSceneBinding;
  recipe: MediaExportRecipe;
  recipeHash: string;
  frameCount: number;
  duration: { numerator: number; denominator: number };
  layout: MediaLayout;
  frameReceiptsHash: string;
  runtime: { profileVersion: string; hash: string };
  renderer: {
    name: string;
    version: string;
    profileHash: string;
    fontHashes: string[];
  };
  encoder: { name: string; version: string; profileHash: string } | null;
  files: MediaOutputFile[];
  sources: MediaSource[];
  notes: string[];
}

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(160);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const mediaFrameReceiptSchema: z.ZodType<MediaFrameReceipt> = z
  .object({
    index: nonnegativeInteger,
    timestampMicroseconds: nonnegativeInteger,
    durationMicroseconds: nonnegativeInteger,
    sceneHash: sha,
    recipeHash: sha,
    generation: z.string().min(1).max(200),
    drawSerial: nonnegativeInteger,
    requestedCamera: presentationCameraSchema,
    actualCamera: presentationCameraSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixelHash: sha,
    reusedFromFrame: nonnegativeInteger.optional(),
  })
  .strict();
const recipeBase = {
  version: z.literal(1),
  methodVersion: z.literal(MEDIA_METHOD_VERSION),
  width: z.number().int(),
  height: z.number().int(),
  layers: z
    .array(z.enum(MEDIA_LAYERS))
    .max(MEDIA_LAYERS.length)
    .refine((x) => new Set(x).size === x.length),
  timeOfDay: z.number().finite().min(0).max(24),
  agents: z.literal("none"),
  audio: z.literal("none"),
};
export const mediaExportRecipeSchema: z.ZodType<MediaExportRecipe> = z
  .discriminatedUnion("format", [
    z
      .object({
        ...recipeBase,
        format: z.literal("png"),
        camera: presentationCameraSchema,
        view: z.enum(["3d", "2d"]),
        caption: z.string().max(MAX_MEDIA_CAPTION_LENGTH),
      })
      .strict(),
    z
      .object({
        ...recipeBase,
        format: z.literal("mp4"),
        fps: z.literal(MEDIA_FPS),
        cameraMethodVersion: z.literal(MEDIA_CAMERA_METHOD_VERSION),
        stops: z
          .array(
            z
              .object({
                stopId: id,
                holdFrames: z.number().int().min(1).max(3600),
                transitionFrames: z.number().int().min(0).max(300),
                caption: z.string().max(MAX_MEDIA_CAPTION_LENGTH).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_PRESENTATION_STOPS),
      })
      .strict(),
  ])
  .superRefine((v, c) => {
    const allowed =
      v.format === "png"
        ? [
            [3840, 2160],
            [1920, 1080],
          ]
        : [
            [1920, 1080],
            [1280, 720],
          ];
    if (!allowed.some(([w, h]) => v.width === w && v.height === h))
      c.addIssue({
        code: "custom",
        message:
          "Choose an exact supported media size; resizing or cropping is not implicit.",
      });
    if (v.format === "mp4") {
      if (new Set(v.stops.map((s) => s.stopId)).size !== v.stops.length)
        c.addIssue({ code: "custom", message: "Tour stops must be unique." });
      if (v.stops.at(-1)?.transitionFrames !== 0)
        c.addIssue({
          code: "custom",
          message: "The final stop cannot transition to an absent stop.",
        });
      if (
        v.stops.reduce((n, s) => n + s.holdFrames + s.transitionFrames, 0) >
        MAX_MEDIA_FRAMES
      )
        c.addIssue({
          code: "custom",
          message:
            "The complete tour exceeds the frame bound; no stops or text were dropped.",
        });
    }
  });
export const mediaSceneBindingSchema: z.ZodType<MediaSceneBinding> = z
  .object({
    projectId: id,
    projectVersion: z.number().int().positive(),
    placeId: id,
    baselineHash: sha,
    scenarioId: id,
    scenarioRevision: nonnegativeInteger,
    scenarioHash: sha,
    resultsHash: sha,
    presentationHash: sha.nullable(),
    datasetsHash: sha,
    sourcesHash: sha,
    fiscalProfileHash: sha.optional(),
  })
  .strict();
const metricSchema = z
  .object({
    id,
    label: z.string(),
    domain: z.enum([
      "Housing",
      "Mobility",
      "Economy",
      "Fiscal",
      "Land & form",
      "Access & equity",
      "Environment",
      "Safety",
    ]),
    unit: z.string(),
    baseline: z.number().finite().nullable(),
    value: z.number().finite().nullable(),
    delta: z.number().finite().nullable(),
    coverage: z
      .object({
        baseline: z
          .object({
            knownSubtotal: z.number().finite().nullable().optional(),
            missingBuildingIds: z.array(id),
          })
          .strict(),
        scenario: z
          .object({
            knownSubtotal: z.number().finite().nullable().optional(),
            missingBuildingIds: z.array(id),
          })
          .strict(),
      })
      .strict()
      .optional(),
    low: z.number().finite().optional(),
    high: z.number().finite().optional(),
    status: z.enum(["ready", "incomplete", "unavailable"]),
    explanation: z.string(),
    formula: z.string(),
    inputs: z.array(
      z
        .object({
          name: z.string(),
          value: z.union([z.string(), z.number().finite()]),
          source: z.string(),
        })
        .strict(),
    ),
    sourceIds: z.array(id),
    method: z.string(),
    methodVersion: z.string(),
    scenarioRevision: nonnegativeInteger,
    geography: z.string(),
    caveat: z.string().optional(),
    desirable: z.enum(["increase", "decrease", "neutral"]).optional(),
  })
  .strict();
export const mediaSceneSchema: z.ZodType<MediaScene> = z
  .object({
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    binding: mediaSceneBindingSchema,
    place: z.lazy(() => placeSchema),
    scenario: z.lazy(() => scenarioSchema),
    results: z
      .object({
        scenarioId: id,
        revision: nonnegativeInteger,
        computedAt: z.string(),
        metrics: z.array(metricSchema).max(1000),
        warnings: z.array(z.string()),
        modelVersion: z.string(),
        fiscal: z.lazy(() => fiscalResolutionSchema).optional(),
      })
      .strict(),
    floodDatasets: z.lazy(() => floodDatasetCatalogSchema).optional(),
    fiscalProfile: z.lazy(() => fiscalProfileSchema).optional(),
    sources: z
      .array(
        z
          .object({ namespace: id, source: z.lazy(() => sourceSchema) })
          .strict(),
      )
      .max(20_000),
    sceneHash: sha,
  })
  .strict() as z.ZodType<MediaScene>;

const mediaRectangleSchema = z
  .object({
    x: nonnegativeInteger,
    y: nonnegativeInteger,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const profileSchema = z
  .object({
    name: z.string().min(1).max(160),
    version: z.string().min(1).max(1000),
    profileHash: sha,
  })
  .strict();
/** Strict compact output metadata; actual bytes and trusted runtime identity are checked by the host. */
export const mediaExportManifestSchema: z.ZodType<MediaExportManifest> = z
  .object({
    version: z.literal(1),
    methodVersion: z.literal(MEDIA_METHOD_VERSION),
    sceneHash: sha,
    binding: mediaSceneBindingSchema,
    recipe: mediaExportRecipeSchema,
    recipeHash: sha,
    frameCount: z.number().int().min(1).max(MAX_MEDIA_FRAMES),
    duration: z
      .object({
        numerator: nonnegativeInteger,
        denominator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    layout: z
      .object({
        map: mediaRectangleSchema,
        callout: mediaRectangleSchema,
        credits: mediaRectangleSchema,
      })
      .strict(),
    frameReceiptsHash: sha,
    runtime: z.object({ profileVersion: id, hash: sha }).strict(),
    renderer: profileSchema.extend({ fontHashes: z.array(sha).max(256) }),
    encoder: profileSchema.nullable(),
    files: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)
              .refine((n) => !n.includes("..")),
            sha256: sha,
            bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            contentType: z
              .string()
              .min(1)
              .max(160)
              .regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:; charset=utf-8)?$/),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    sources: z
      .array(
        z
          .object({ namespace: id, source: z.lazy(() => sourceSchema) })
          .strict(),
      )
      .max(20_000),
    notes: z.array(z.string().min(1).max(4000)).max(200),
  })
  .strict();

export function mediaContentHash(value: unknown): string {
  return Array.from(
    sha256(new TextEncoder().encode(canonicalJSON(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Media export: ${message}`);
}
function sceneBounds(value: unknown) {
  const text = canonicalJSON(value);
  ensure(
    new TextEncoder().encode(text).length <= MAX_MEDIA_SCENE_BYTES,
    "scene exceeds the complete payload bound; no geometry may be dropped.",
  );
  let coordinates = 0,
    nodes = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (++nodes > 4_000_000)
      throw new Error("Media export: scene complexity exceeds the bound.");
    if (Array.isArray(v)) {
      if (
        (v.length === 2 || v.length === 3) &&
        v.every((x) => typeof x === "number")
      )
        coordinates++;
      else for (const child of v) stack.push(child);
    } else if (v && typeof v === "object")
      for (const child of Object.values(v)) stack.push(child);
    ensure(
      coordinates <= MAX_MEDIA_COORDINATES,
      "scene coordinate budget exceeded; no features may be dropped.",
    );
  }
}
/** Preserve independent namespaces, including colliding source IDs. */
export function mediaSceneSources(
  place: Place,
  scenario: Scenario,
  datasets?: FloodDatasetCatalog,
  fiscalProfile?: FiscalProfile,
): MediaSource[] {
  const groups: [string, Source[]][] = [
    ["planning-baseline", place.sources],
    ["planning-scenario", scenario.sources ?? []],
    ...(fiscalProfile
      ? [["fiscal-profile", fiscalProfile.sources] as [string, Source[]]]
      : []),
    [
      "demographics-baseline",
      place.demographics ? [place.demographics.source] : [],
    ],
    ["activity-authored", scenario.activity ? [USER_ACTIVITY_SOURCE] : []],
    ["retail-authored", scenario.retail ? [USER_RETAIL_SOURCE] : []],
    [
      "vehicle-baseline",
      place.vehicleAvailability ? [place.vehicleAvailability.source] : [],
    ],
    [
      "vehicle-scenario",
      scenario.activity?.vehicleReference
        ? [scenario.activity.vehicleReference.source]
        : [],
    ],
    ["workforce", scenario.workforce?.capture.sources ?? []],
    [
      "accessibility-car",
      scenario.accessibility?.captures.car?.capture.sources ?? [],
    ],
    [
      "accessibility-walk",
      scenario.accessibility?.captures.walk?.capture.sources ?? [],
    ],
    ["traffic", scenario.traffic?.capture.sources ?? []],
    [
      "traffic-planning",
      scenario.traffic?.capture.proposal.planningRoadMapping.correspondence
        ?.sources ?? [],
    ],
    [
      "traffic-commute",
      scenario.traffic?.capture.originalDemand.commute?.sources ?? [],
    ],
    [
      "flood",
      scenario.flood
        ? (datasets?.[scenario.flood.datasetHash]?.sources ?? [])
        : [],
    ],
  ];
  return groups.flatMap(([namespace, sources]) => {
    const unique = new Map<string, Source>();
    for (const source of sources) {
      ensure(
        !unique.has(source.id) ||
          canonicalJSON(unique.get(source.id)) === canonicalJSON(source),
        `conflicting ${namespace} source identity ${source.id}.`,
      );
      unique.set(source.id, source);
    }
    return [...unique.values()].map((source) => ({ namespace, source }));
  });
}
function bindingFor(
  input: Omit<MediaScene, "binding" | "sceneHash" | "version">,
  projectId: string,
  projectVersion: number,
): MediaSceneBinding {
  return {
    projectId,
    projectVersion,
    placeId: input.place.id,
    baselineHash: mediaContentHash(input.place),
    scenarioId: input.scenario.id,
    scenarioRevision: input.scenario.revision,
    scenarioHash: mediaContentHash(input.scenario),
    resultsHash: mediaContentHash(input.results),
    presentationHash: input.scenario.presentation
      ? mediaContentHash(input.scenario.presentation)
      : null,
    datasetsHash: mediaContentHash(input.floodDatasets ?? {}),
    sourcesHash: mediaContentHash(input.sources),
    ...(input.fiscalProfile
      ? { fiscalProfileHash: fiscalProfileHash(input.fiscalProfile) }
      : {}),
  };
}
/** Caller supplies a validated, authorized saved snapshot and computed matching results. Run expensive validation in the bounded preparation worker. */
export function createMediaScene(input: {
  projectId: string;
  projectVersion: number;
  place: Place;
  scenario: Scenario;
  results: ModelResults;
  floodDatasets?: FloodDatasetCatalog;
  fiscalStudy?: FiscalStudy;
  createdAt: string;
}): MediaScene {
  const selected = input.scenario.flood
    ? input.floodDatasets?.[input.scenario.flood.datasetHash]
    : undefined;
  ensure(
    !input.scenario.flood || selected,
    "selected flood dataset is unavailable.",
  );
  const data = {
    createdAt: input.createdAt,
    place: input.place,
    scenario: input.scenario,
    results: input.results,
    ...(input.fiscalStudy ? { fiscalProfile: input.fiscalStudy.profile } : {}),
    ...(selected
      ? { floodDatasets: { [input.scenario.flood!.datasetHash]: selected } }
      : {}),
    sources: mediaSceneSources(
      input.place,
      input.scenario,
      selected ? { [input.scenario.flood!.datasetHash]: selected } : undefined,
      input.fiscalStudy?.profile,
    ),
  };
  const body = {
    version: 1 as const,
    ...data,
    binding: bindingFor(data, input.projectId, input.projectVersion),
  };
  const scene = { ...body, sceneHash: mediaContentHash(body) };
  assertMediaScene(scene);
  return structuredClone(scene);
}
export function assertMediaScene(value: unknown): asserts value is MediaScene {
  sceneBounds(value);
  const parsed = mediaSceneSchema.parse(value);
  ensure(
    canonicalJSON(parsed) === canonicalJSON(value),
    "unknown scene fields cannot be silently stripped.",
  );
  const { sceneHash, ...body } = parsed;
  ensure(mediaContentHash(body) === sceneHash, "scene hash mismatch.");
  ensure(
    canonicalJSON(
      bindingFor(
        parsed,
        parsed.binding.projectId,
        parsed.binding.projectVersion,
      ),
    ) === canonicalJSON(parsed.binding),
    "scene content does not match its binding.",
  );
  const { scenario, results } = parsed;
  ensure(
    results.scenarioId === scenario.id &&
      results.revision === scenario.revision &&
      results.metrics.every((m) => m.scenarioRevision === scenario.revision),
    "model results do not belong to this scenario revision.",
  );
  ensure(
    canonicalJSON(
      mediaSceneSources(
        parsed.place,
        scenario,
        parsed.floodDatasets,
        parsed.fiscalProfile,
      ),
    ) === canonicalJSON(parsed.sources),
    "source inventory does not match the scene.",
  );
  ensure(
    !scenario.fiscal ||
      (!!parsed.fiscalProfile &&
        fiscalProfileHash(parsed.fiscalProfile) ===
          scenario.fiscal.profileHash),
    "fiscal source profile is missing or mismatched.",
  );
  ensure(
    !parsed.results.fiscal ||
      (!!parsed.fiscalProfile &&
        parsed.results.fiscal.profileHash ===
          fiscalProfileHash(parsed.fiscalProfile)),
    "fiscal results do not match their source profile.",
  );
  const keys = Object.keys(parsed.floodDatasets ?? {});
  ensure(
    scenario.flood
      ? keys.length === 1 && keys[0] === scenario.flood.datasetHash
      : keys.length === 0,
    "only the selected flood dataset may be included.",
  );
  if (scenario.flood)
    ensure(
      floodDatasetHashSync(
        parsed.floodDatasets![scenario.flood.datasetHash],
      ) === scenario.flood.datasetHash,
      "selected flood dataset hash mismatch.",
    );
}
/** This is a private export permission check, not publication authorization. Retained-history rights checks remain server responsibilities. */
export function assertMediaExportRights(scene: MediaScene) {
  for (const { namespace, source } of scene.sources) {
    const rights = source.rights;
    ensure(
      !rights || (rights.privateUse && rights.privateDisplay && rights.export),
      `${namespace} source ${source.name} does not permit private display/export.`,
    );
    if (source.url) {
      let url: URL | undefined;
      try {
        url = new URL(source.url);
      } catch {
        /* A citation need not be a fetchable URL. */
      }
      ensure(
        !url ||
          (!url.username &&
            !url.password &&
            ![...url.searchParams.keys()].some((k) =>
              /^(key|token|api[_-]?key|access[_-]?token|signature|credential)$/i.test(
                k,
              ),
            )),
        "credential-bearing source URLs cannot enter a media artifact.",
      );
    }
  }
  ensure(
    !scene.scenario.retail?.sourceRights.some((r) => !r.authorizedPrivateUse),
    "retail evidence lacks private-use authorization.",
  );
}
export function validateMediaExport(
  scene: MediaScene,
  input: unknown,
): MediaExportRecipe {
  const recipe = mediaExportRecipeSchema.parse(input);
  assertMediaExportRights(scene);
  if (recipe.layers.includes("flood"))
    ensure(
      !scene.scenario.flood ||
        scene.floodDatasets?.[scene.scenario.flood.datasetHash],
      "selected flood map is unavailable.",
    );
  if (recipe.format === "mp4") {
    const stops = scene.scenario.presentation?.stops;
    ensure(
      stops &&
        stops.length === recipe.stops.length &&
        stops.every((s, i) => s.id === recipe.stops[i].stopId),
      "export must retain every saved tour stop in its exact order.",
    );
    ensure(
      stops.every((stop) => stop.view !== "satellite"),
      "satellite export is unsupported; no imagery or 2D fallback is substituted.",
    );
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i],
        timing = recipe.stops[i];
      ensure(
        (timing.caption ?? stop.callout).length <= MAX_MEDIA_CAPTION_LENGTH,
        "long callouts require an explicit brief screen caption; full authored text remains in the transcript.",
      );
      if (i < stops.length - 1 && stop.view !== stops[i + 1].view)
        ensure(
          timing.transitionFrames === 0,
          "different view modes require an explicit cut, not a hidden projection transition.",
        );
    }
  }
  return recipe;
}
export function mediaSelectedMethods(scene: MediaScene) {
  return {
    modelVersion: scene.results.modelVersion,
    ...(scene.scenario.flood
      ? {
          flood: {
            datasetHash: scene.scenario.flood.datasetHash,
            methodVersion: floodMethodVersion(scene.scenario.flood),
          },
        }
      : {}),
  };
}
