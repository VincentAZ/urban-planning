import { canonicalJSON } from "./canonical";
import { presentationCameraSchema } from "./presentation";
import {
  MEDIA_CAMERA_METHOD_VERSION,
  MEDIA_FPS,
  MEDIA_METHOD_VERSION,
  mediaContentHash,
  mediaExportRecipeSchema,
  validateMediaExport,
  assertMediaScene,
  mediaFrameReceiptSchema,
  mediaExportManifestSchema,
  MEDIA_HOLD_REUSE_NOTE,
  type MediaExportRecipe,
  type MediaScene,
  type MediaFrame,
  type MediaLayout,
  type MediaExportManifest,
  type MediaFrameReceipt,
} from "./media";
import type { PresentationCamera } from "./presentation";

export function defaultMediaExportRecipe(
  scene: MediaScene,
  format: "png" | "mp4" = "png",
): MediaExportRecipe {
  const base = {
    version: 1 as const,
    methodVersion: MEDIA_METHOD_VERSION,
    width: 1920,
    height: 1080,
    layers: [
      "buildings",
      "roads",
      "parks",
      "parcels",
      ...(scene.scenario.flood ? ["flood"] : []),
    ] as MediaExportRecipe["layers"],
    timeOfDay: 15,
    agents: "none" as const,
    audio: "none" as const,
  };
  const stops = scene.scenario.presentation?.stops;
  if (format === "png") {
    const first = stops?.[0];
    if (first?.view === "satellite")
      throw new Error(
        "Media export: satellite export is unsupported; choose an explicit city or plan view.",
      );
    return {
      ...base,
      format,
      camera: first
        ? structuredClone(first.camera)
        : {
            center: [...scene.place.center],
            zoom: 15,
            pitch: 45,
            bearing: -27,
          },
      view: first?.view === "2d" ? "2d" : "3d",
      caption: "",
    };
  }
  if (!stops?.length)
    throw new Error(
      "Media export: save a guided presentation before exporting its flythrough.",
    );
  return {
    ...base,
    format,
    fps: MEDIA_FPS,
    cameraMethodVersion: MEDIA_CAMERA_METHOD_VERSION,
    stops: stops.map((stop, i) => ({
      stopId: stop.id,
      holdFrames: 900,
      transitionFrames:
        i === stops.length - 1 || stop.view !== stops[i + 1].view ? 0 : 54,
    })),
  };
}
export function mediaFrameCount(recipe: MediaExportRecipe): number {
  const valid = mediaExportRecipeSchema.parse(recipe);
  return valid.format === "png"
    ? 1
    : valid.stops.reduce(
        (sum, s) => sum + s.holdFrames + s.transitionFrames,
        0,
      );
}
/** Total output dimensions include all three rectangles; no extra footer is appended. */
export function mediaLayout(recipe: MediaExportRecipe): MediaLayout {
  mediaExportRecipeSchema.parse(recipe);
  const mapHeight = Math.floor(recipe.height * 0.72),
    calloutHeight = Math.floor(recipe.height * 0.18);
  return {
    map: { x: 0, y: 0, width: recipe.width, height: mapHeight },
    callout: { x: 0, y: mapHeight, width: recipe.width, height: calloutHeight },
    credits: {
      x: 0,
      y: mapHeight + calloutHeight,
      width: recipe.width,
      height: recipe.height - mapHeight - calloutHeight,
    },
  };
}
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mercator = (lat: number) =>
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
/** Defined camera path, not wall-clock MapLibre.flyTo; state is a pure function of frame index. */
export function interpolateMediaCamera(
  a: PresentationCamera,
  b: PresentationCamera,
  fraction: number,
): PresentationCamera {
  presentationCameraSchema.parse(a);
  presentationCameraSchema.parse(b);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    throw new Error("Media export: invalid interpolation fraction.");
  if (fraction === 0) return structuredClone(a);
  if (fraction === 1) return structuredClone(b);
  const t = fraction * fraction * (3 - 2 * fraction);
  return {
    center: [
      wrap(a.center[0] + wrap(b.center[0] - a.center[0]) * t),
      ((Math.atan(
        Math.exp(mix(mercator(a.center[1]), mercator(b.center[1]), t)),
      ) -
        Math.PI / 4) *
        360) /
        Math.PI,
    ],
    zoom: mix(a.zoom, b.zoom, t),
    pitch: mix(a.pitch, b.pitch, t),
    bearing: wrap(a.bearing + wrap(b.bearing - a.bearing) * t),
  };
}
function frameAt(
  scene: MediaScene,
  recipe: MediaExportRecipe,
  count: number,
  index: number,
): MediaFrame {
  if (!Number.isInteger(index) || index < 0 || index >= count)
    throw new Error(
      "Media export: frame index is outside the complete timeline.",
    );
  if (recipe.format === "png")
    return {
      index: 0,
      timeSeconds: 0,
      timestampMicroseconds: 0,
      durationMicroseconds: 0,
      camera: {
        ...structuredClone(recipe.camera),
        pitch: recipe.view === "2d" ? 0 : recipe.camera.pitch,
      },
      view: recipe.view,
      stopId: null,
      title: scene.scenario.name,
      caption: recipe.caption,
      metricIds: [],
      phase: "still",
    };
  let start = 0;
  const stops = scene.scenario.presentation!.stops;
  for (let i = 0; i < recipe.stops.length; i++) {
    const timing = recipe.stops[i],
      stop = stops[i],
      end = start + timing.holdFrames + timing.transitionFrames;
    if (index < end) {
      const transition = index >= start + timing.holdFrames;
      // Transition frames are interior samples. Exact endpoints occur in the
      // adjacent holds, so no endpoint is omitted or silently duplicated.
      const camera = transition
        ? interpolateMediaCamera(
            stop.camera,
            stops[i + 1].camera,
            (index - start - timing.holdFrames + 1) /
              (timing.transitionFrames + 1),
          )
        : structuredClone(stop.camera);
      const view = stop.view as "3d" | "2d";
      if (view === "2d") camera.pitch = 0;
      return {
        index,
        timeSeconds: index / recipe.fps,
        timestampMicroseconds: Math.floor((index * 1_000_000) / recipe.fps),
        durationMicroseconds:
          Math.floor(((index + 1) * 1_000_000) / recipe.fps) -
          Math.floor((index * 1_000_000) / recipe.fps),
        camera,
        view,
        stopId: stop.id,
        title: stop.title,
        caption: timing.caption ?? stop.callout,
        metricIds: [...(stop.metricIds ?? [])],
        phase: transition ? "transition" : "hold",
      };
    }
    start = end;
  }
  throw new Error("Media export: incomplete timeline.");
}
export interface PreparedMediaTimeline {
  readonly sceneHash: string;
  readonly recipeHash: string;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly duration: Readonly<{ numerator: number; denominator: number }>;
  readonly layout: MediaLayout;
  frameAt(index: number): MediaFrame;
}
const preparedTimelines = new WeakSet<object>();
/** Validated private clone once per job/load, never a caller-supplied trust flag. */
export function prepareMediaTimeline(
  scene: MediaScene,
  input: MediaExportRecipe,
): PreparedMediaTimeline {
  const frozen = structuredClone(scene),
    recipe = structuredClone(input);
  assertMediaScene(frozen);
  validateMediaExport(frozen, recipe);
  const count = mediaFrameCount(recipe),
    layout = mediaLayout(recipe);
  for (const rect of Object.values(layout)) Object.freeze(rect);
  Object.freeze(layout);
  const timeline = Object.freeze({
    sceneHash: frozen.sceneHash,
    recipeHash: mediaContentHash(recipe),
    frameCount: count,
    width: recipe.width,
    height: recipe.height,
    duration: Object.freeze({
      numerator: recipe.format === "mp4" ? count : 0,
      denominator: recipe.format === "mp4" ? recipe.fps : 1,
    }),
    layout,
    frameAt: (index: number) => frameAt(frozen, recipe, count, index),
  });
  preparedTimelines.add(timeline);
  return timeline;
}
/** Convenience API; repeated frame producers should prepare exactly once. */
export function mediaFrameAt(
  scene: MediaScene,
  recipe: MediaExportRecipe,
  index: number,
): MediaFrame {
  return prepareMediaTimeline(scene, recipe).frameAt(index);
}
function sameCamera(a: PresentationCamera, b: PresentationCamera) {
  return (
    Math.abs(wrap(a.center[0] - b.center[0])) < 1e-7 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-7 &&
    Math.abs(a.zoom - b.zoom) < 1e-5 &&
    Math.abs(a.pitch - b.pitch) < 1e-5 &&
    Math.abs(wrap(a.bearing - b.bearing)) < 1e-5
  );
}
function visualFrame(frame: MediaFrame) {
  const {
    index: _,
    timeSeconds: _t,
    timestampMicroseconds: _ts,
    durationMicroseconds: _d,
    ...visual
  } = frame;
  return visual;
}
/** Complete frame ledger, including explicitly reused still holds. Pixel hashes are produced by the trusted capture host. */
export function assertMediaFrameReceipts(
  timeline: PreparedMediaTimeline,
  receipts: readonly MediaFrameReceipt[],
): void {
  if (!preparedTimelines.has(timeline))
    throw new Error("Media export: a locally prepared timeline is required.");
  if (receipts.length !== timeline.frameCount)
    throw new Error("Media export: incomplete frame receipt count.");
  let serial = -1;
  const generation = receipts[0]?.generation;
  if (!generation || generation.length > 200)
    throw new Error("Media export: missing render generation.");
  for (let i = 0; i < receipts.length; i++) {
    const r = mediaFrameReceiptSchema.parse(receipts[i]),
      expected = timeline.frameAt(i);
    if (
      r.index !== i ||
      r.timestampMicroseconds !== expected.timestampMicroseconds ||
      r.durationMicroseconds !== expected.durationMicroseconds ||
      r.sceneHash !== timeline.sceneHash ||
      r.recipeHash !== timeline.recipeHash ||
      r.generation !== generation ||
      r.width !== timeline.width ||
      r.height !== timeline.height ||
      canonicalJSON(r.requestedCamera) !== canonicalJSON(expected.camera) ||
      !sameCamera(r.actualCamera, expected.camera) ||
      !Number.isSafeInteger(r.drawSerial) ||
      r.drawSerial < 0 ||
      !/^[a-f0-9]{64}$/.test(r.pixelHash)
    )
      throw new Error(
        `Media export: frame ${i} does not match its frozen timeline or completed camera.`,
      );
    if (r.reusedFromFrame !== undefined) {
      const from = r.reusedFromFrame,
        original = receipts[from];
      if (
        !Number.isInteger(from) ||
        from < 0 ||
        from >= i ||
        !original ||
        original.reusedFromFrame !== undefined ||
        expected.phase !== "hold" ||
        timeline.frameAt(from).phase !== "hold" ||
        canonicalJSON(visualFrame(timeline.frameAt(from))) !==
          canonicalJSON(visualFrame(expected)) ||
        r.drawSerial !== original.drawSerial ||
        r.pixelHash !== original.pixelHash ||
        canonicalJSON(r.actualCamera) !== canonicalJSON(original.actualCamera)
      )
        throw new Error(
          `Media export: frame ${i} has an invalid hold reuse receipt.`,
        );
    } else {
      if (r.drawSerial <= serial)
        throw new Error(
          `Media export: frame ${i} has no newer completed render.`,
        );
      serial = r.drawSerial;
    }
  }
}
/** Complete authored strings and sources, including text deliberately shortened on screen. */
export function mediaTranscript(
  scene: MediaScene,
  input: MediaExportRecipe,
): string {
  const recipe = validateMediaExport(scene, input);
  const heading = [
    scene.scenario.name,
    `Saved project ${scene.binding.projectId} version ${scene.binding.projectVersion}; scenario ${scene.binding.scenarioId} revision ${scene.binding.scenarioRevision}.`,
    `Scene SHA256 ${scene.sceneHash}`,
    "Planning illustration. No narration audio is included. Authored text is not a verified model conclusion.",
  ];
  const text = [
    ...(recipe.format === "png"
      ? [
          `Still screen caption: ${recipe.caption}`,
          "Saved presentation text is retained below as reference; the still image has no tour clock.",
        ]
      : []),
    ...(scene.scenario.presentation?.stops ?? []).flatMap((stop, i) => [
      `Stop ${i + 1}: ${stop.title}`,
      `Callout: ${stop.callout}`,
      `Authored narration: ${stop.narration ?? ""}`,
      ...(recipe.format === "mp4"
        ? [`Screen caption: ${recipe.stops[i].caption ?? stop.callout}`]
        : []),
      ...(stop.metricIds ?? []).map((id) => {
        const m = scene.results.metrics.find((m) => m.id === id);
        return m
          ? `Metric ${id}: ${canonicalJSON(m)}`
          : `Metric ${id}: Unavailable in this captured revision.`;
      }),
    ]),
  ];
  return (
    [
      ...heading,
      ...text,
      "Source inventory (independent namespaces):",
      ...scene.sources.map((s) => canonicalJSON(s)),
    ].join("\n\n") + "\n"
  );
}
function vttTime(frame: number, fps: number) {
  const ms = Math.floor((frame * 1000) / fps),
    hours = Math.floor(ms / 3600000),
    minutes = Math.floor(ms / 60000) % 60,
    seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
function vttText(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n\s*\n/g, "\n");
}
/** Full authored callout and narration, not the optional short on-screen caption. */
export function mediaWebVtt(
  scene: MediaScene,
  input: MediaExportRecipe,
): string {
  const recipe = validateMediaExport(scene, input);
  if (recipe.format !== "mp4")
    return "WEBVTT\n\nNOTE Still image; complete text is in transcript.txt.\n";
  let frame = 0;
  const cues: string[] = [];
  for (let i = 0; i < recipe.stops.length; i++) {
    const timing = recipe.stops[i],
      stop = scene.scenario.presentation!.stops[i],
      end = frame + timing.holdFrames + timing.transitionFrames;
    cues.push(
      `${i + 1}\n${vttTime(frame, recipe.fps)} --> ${vttTime(end, recipe.fps)}\n${vttText([stop.title, stop.callout, stop.narration ?? ""].filter(Boolean).join("\n"))}`,
    );
    frame = end;
  }
  return "WEBVTT\n\n" + cues.join("\n\n") + "\n";
}
export function assertMediaExportManifest(
  scene: MediaScene,
  recipe: MediaExportRecipe,
  manifest: MediaExportManifest,
  receipts?: readonly MediaFrameReceipt[],
): void {
  mediaExportManifestSchema.parse(manifest);
  if (
    (recipe.format === "mp4") !== (manifest.encoder !== null) ||
    (manifest.encoder && manifest.encoder.profileHash !== manifest.runtime.hash)
  )
    throw new Error(
      "Media export: encoder identity does not match the format and runtime.",
    );
  validateMediaExport(scene, recipe);
  const count = mediaFrameCount(recipe),
    same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
  if (
    manifest.version !== 1 ||
    manifest.methodVersion !== MEDIA_METHOD_VERSION ||
    manifest.sceneHash !== scene.sceneHash ||
    !same(manifest.binding, scene.binding) ||
    !same(manifest.recipe, recipe) ||
    manifest.recipeHash !== mediaContentHash(recipe) ||
    manifest.frameCount !== count ||
    !same(manifest.duration, {
      numerator: recipe.format === "mp4" ? count : 0,
      denominator: recipe.format === "mp4" ? recipe.fps : 1,
    }) ||
    !same(manifest.layout, mediaLayout(recipe)) ||
    !same(manifest.sources, scene.sources)
  )
    throw new Error(
      "Media export: manifest does not bind the complete captured scene and timeline.",
    );
  if (
    !/^[a-f0-9]{64}$/.test(manifest.frameReceiptsHash) ||
    !manifest.files.length ||
    manifest.files.length > 12 ||
    new Set(manifest.files.map((f) => f.name)).size !== manifest.files.length ||
    manifest.files.some(
      (f) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(f.name) ||
        f.name.includes("..") ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes <= 0,
    )
  )
    throw new Error("Media export: invalid complete artifact inventory.");
  if (
    !manifest.files.some(
      (f) =>
        f.contentType === (recipe.format === "png" ? "image/png" : "video/mp4"),
    ) ||
    !manifest.files.some((f) => f.name === "transcript.txt") ||
    !manifest.files.some((f) => f.name === "captions.vtt")
  )
    throw new Error(
      "Media export: media and complete transcript/caption sidecars are required.",
    );
  if (receipts) {
    assertMediaFrameReceipts(prepareMediaTimeline(scene, recipe), receipts);
    if (mediaContentHash(receipts) !== manifest.frameReceiptsHash)
      throw new Error("Media export: frame receipt inventory hash mismatch.");
    if (
      receipts.some((r) => r.reusedFromFrame !== undefined) &&
      !manifest.notes.includes(MEDIA_HOLD_REUSE_NOTE)
    )
      throw new Error(
        "Media export: reused hold frames must be disclosed in the manifest.",
      );
  }
}
