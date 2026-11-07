import { describe, it, expect } from "vitest";
import { createProject, calculateImpact } from "@urban/models";
import { floodFixture } from "../../../tests/fixtures/flood";
import {
  canonicalJSON,
  type Place,
  type Source,
  type MediaScene,
  type MediaVideoRecipe,
  type MediaExportManifest,
  type MediaFrameReceipt,
  createMediaScene,
  assertMediaScene,
  mediaContentHash,
  mediaExportRecipeSchema,
  validateMediaExport,
  defaultMediaExportRecipe,
  mediaFrameCount,
  mediaFrameAt,
  mediaLayout,
  mediaTranscript,
  mediaWebVtt,
  interpolateMediaCamera,
  assertMediaExportManifest,
  MEDIA_METHOD_VERSION,
  MAX_MEDIA_SCENE_BYTES,
  prepareMediaTimeline,
  assertMediaFrameReceipts,
  MEDIA_HOLD_REUSE_NOTE,
} from "./index";

function fixture(count = 2) {
  const source: Source = {
    id: "source",
    name: "Synthetic media test source",
    url: "",
    vintage: "test",
    license: "test",
    kind: "user-supplied",
  };
  const place: Place = {
    id: "media-fixture",
    name: "Synthetic media fixture",
    city: "Test",
    state: "AZ",
    zip: "00000",
    center: [-112.07, 33.45],
    bounds: [-112.08, 33.44, -112.06, 33.46],
    boundary: [
      [-112.08, 33.44],
      [-112.06, 33.44],
      [-112.06, 33.46],
      [-112.08, 33.46],
      [-112.08, 33.44],
    ],
    buildings: [],
    roads: [],
    sources: [source],
    coverage: [],
    loadedAt: "2026-11-06",
    extentLabel: "Synthetic fixture",
  };
  const project = createProject(place),
    scenario = project.scenarios[1];
  scenario.presentation = {
    version: 1,
    title: "Saved authored tour",
    stops: Array.from({ length: count }, (_, i) => ({
      id: `stop-${i}`,
      title: `Stop ${i}`,
      callout: `Exact callout ${i}`,
      narration: `Authored narration ${i}`,
      view: "3d",
      camera: {
        center: [-112.07 + i * 0.0001, 33.45],
        zoom: 14 + i * 0.1,
        pitch: 45,
        bearing: i * 5,
      },
      metricIds: ["housing.units", "missing.metric"],
    })),
  };
  const results = calculateImpact(place, scenario);
  const scene = createMediaScene({
    projectId: project.id,
    projectVersion: 1,
    place,
    scenario,
    results,
    createdAt: "2026-11-06T12:00:00.000Z",
  });
  const recipe = defaultMediaExportRecipe(scene, "mp4") as MediaVideoRecipe;
  recipe.stops = recipe.stops.map((s, i) => ({
    ...s,
    holdFrames: 3,
    transitionFrames: i === count - 1 ? 0 : 2,
  }));
  return { place, project, scenario, results, scene, recipe };
}
const rehash = (scene: MediaScene) => {
  const { sceneHash: _, ...body } = scene;
  scene.sceneHash = mediaContentHash(body);
};
const rebind = (scene: MediaScene) => {
  scene.binding.scenarioHash = mediaContentHash(scene.scenario);
  scene.binding.presentationHash = scene.scenario.presentation
    ? mediaContentHash(scene.scenario.presentation)
    : null;
  rehash(scene);
};
function receiptFixture() {
  const f = fixture(),
    timeline = prepareMediaTimeline(f.scene, f.recipe);
  const receipts: MediaFrameReceipt[] = Array.from(
    { length: timeline.frameCount },
    (_, i) => {
      const frame = timeline.frameAt(i);
      return {
        index: i,
        timestampMicroseconds: frame.timestampMicroseconds,
        durationMicroseconds: frame.durationMicroseconds,
        sceneHash: timeline.sceneHash,
        recipeHash: timeline.recipeHash,
        generation: "load-generation",
        drawSerial: i + 1,
        requestedCamera: frame.camera,
        actualCamera: structuredClone(frame.camera),
        width: timeline.width,
        height: timeline.height,
        pixelHash: mediaContentHash([frame.camera, frame.title, frame.caption]),
      };
    },
  );
  return { ...f, timeline, receipts };
}
describe("saved media scene integrity", () => {
  it("keeps a detached exact saved scene without changing existing presentation or project bytes", () => {
    const f = fixture(),
      prior = canonicalJSON(f.project);
    expect(() => assertMediaScene(f.scene)).not.toThrow();
    defaultMediaExportRecipe(f.scene, "mp4");
    expect(canonicalJSON(f.project)).toBe(prior);
    f.scenario.presentation!.stops[0].callout = "Changed later";
    expect(f.scene.scenario.presentation!.stops[0].callout).toBe(
      "Exact callout 0",
    );
    expect(f.scene.binding.scenarioHash).toBe(
      mediaContentHash(f.scene.scenario),
    );
    expect(Object.keys(f.scene).sort()).toEqual(
      [
        "binding",
        "createdAt",
        "place",
        "results",
        "scenario",
        "sceneHash",
        "sources",
        "version",
      ].sort(),
    );
    expect(Object.keys(f.scene.scenario.presentation!).sort()).toEqual(
      ["version", "title", "stops"].sort(),
    );
  });
  it("rejects stale metrics, changed scene bytes and rehashed mismatched nested bindings", () => {
    const f = fixture();
    const changed = structuredClone(f.scene);
    changed.scenario.revision++;
    expect(() => assertMediaScene(changed)).toThrow(/hash mismatch/);
    rehash(changed);
    expect(() => assertMediaScene(changed)).toThrow(/binding/);
    expect(() =>
      createMediaScene({
        ...f.scene.binding,
        place: f.place,
        scenario: f.scenario,
        results: { ...f.results, revision: f.results.revision + 1 },
        createdAt: f.scene.createdAt,
      }),
    ).toThrow(/revision/);
  });
  it("rejects private comment/history baggage rather than stripping it from a purported scene", () => {
    const f = fixture(),
      value = { ...f.scene, comments: [{ text: "private" }] };
    expect(() => assertMediaScene(value)).toThrow();
    const nested = structuredClone(f.scene) as MediaScene & {
      place: Place & { comments?: string[] };
    };
    nested.place.comments = ["private"];
    rehash(nested);
    expect(() => assertMediaScene(nested)).toThrow(/unknown scene fields/);
  });
  it("preserves same-ID independent source namespaces and refuses inventory substitution", () => {
    const f = fixture();
    f.scenario.sources = [
      { ...f.place.sources[0], name: "Separate authored source" },
    ];
    const scene = createMediaScene({
      ...f.scene.binding,
      place: f.place,
      scenario: f.scenario,
      results: f.results,
      createdAt: f.scene.createdAt,
    });
    expect(scene.sources.map((x) => [x.namespace, x.source.name])).toEqual([
      ["planning-baseline", "Synthetic media test source"],
      ["planning-scenario", "Separate authored source"],
    ]);
    scene.sources.pop();
    rehash(scene);
    expect(() => assertMediaScene(scene)).toThrow(/binding|inventory/);
  });
  it("includes only the selected flood dataset and rejects a rehashed scene containing altered dataset bytes", async () => {
    const f = await floodFixture(),
      other = structuredClone(f.dataset);
    other.notes.push("A separate unselected source record");
    const catalog = {
      ...f.project.floodDatasets,
      [mediaContentHash(other)]: other,
    };
    const results = calculateImpact(f.place, f.scenario, undefined, {
      floodDatasets: catalog,
    });
    const args = {
      projectId: f.project.id,
      projectVersion: 1,
      place: f.place,
      scenario: f.scenario,
      results,
      createdAt: "2026-11-06T12:00:00.000Z",
    };
    expect(() => createMediaScene(args)).toThrow(/unavailable/);
    const scene = createMediaScene({ ...args, floodDatasets: catalog });
    expect(Object.keys(scene.floodDatasets!)).toEqual([f.datasetHash]);
    expect(
      scene.sources.filter((s) => s.namespace === "flood").map((s) => s.source),
    ).toEqual(f.dataset.sources);
    const geometry = scene.floodDatasets![f.datasetHash].zones[0].geometry;
    if (geometry.type !== "Polygon")
      throw new Error("Expected polygon fixture");
    geometry.coordinates[0][1] = [-112.071, 33.44];
    scene.binding.datasetsHash = mediaContentHash(scene.floodDatasets);
    rehash(scene);
    expect(() => assertMediaScene(scene)).toThrow(/dataset hash/);
  });
  it("preserves unknown metric values and complete missing references in the transcript", () => {
    const f = fixture();
    const metric = f.scene.results.metrics[0];
    metric.value = null;
    metric.delta = null;
    metric.status = "incomplete";
    f.scene.binding.resultsHash = mediaContentHash(f.scene.results);
    rehash(f.scene);
    expect(() => assertMediaScene(f.scene)).not.toThrow();
    expect(mediaTranscript(f.scene, f.recipe)).toContain('"value":null');
    expect(mediaTranscript(f.scene, f.recipe)).toContain(
      "missing.metric: Unavailable",
    );
  });
  it("rejects explicit export restrictions and credential-bearing source URLs", () => {
    const f = fixture();
    f.scene.sources[0].source.rights = {
      version: 1,
      privateUse: true,
      cache: true,
      analyze: true,
      privateDisplay: true,
      export: false,
      historicalRetention: true,
      publicRedistribution: false,
      declaredBy: "test",
      declaredAt: f.scene.createdAt,
    };
    expect(() => validateMediaExport(f.scene, f.recipe)).toThrow(
      /permit private/,
    );
    delete f.scene.sources[0].source.rights;
    f.scene.sources[0].source.url = "https://example.test/tiles?key=private";
    expect(() => validateMediaExport(f.scene, f.recipe)).toThrow(/credential/);
  });
  it("refuses payload overflow without removing data", () => {
    const f = fixture();
    f.scene.scenario.description = "x".repeat(MAX_MEDIA_SCENE_BYTES);
    expect(() => assertMediaScene(f.scene)).toThrow(/payload bound/);
  });
});
describe("complete deterministic media timeline", () => {
  it("retains all 24 stops with default thirty-second holds", () => {
    const f = fixture(24),
      recipe = defaultMediaExportRecipe(f.scene, "mp4") as MediaVideoRecipe;
    expect(validateMediaExport(f.scene, recipe).format).toBe("mp4");
    expect(mediaFrameCount(recipe)).toBe(24 * 900 + 23 * 54);
    expect(mediaFrameAt(f.scene, recipe, 0).camera).toEqual(
      f.scene.scenario.presentation!.stops[0].camera,
    );
    expect(
      mediaFrameAt(f.scene, recipe, mediaFrameCount(recipe) - 1).stopId,
    ).toBe("stop-23");
  });
  it("samples exact holds and interior transitions without reading elapsed wall time", () => {
    const { scene, recipe } = fixture();
    const timeline = prepareMediaTimeline(scene, recipe);
    const frames = Array.from({ length: timeline.frameCount }, (_, i) =>
      timeline.frameAt(i),
    );
    expect(frames.map((f) => f.phase)).toEqual([
      "hold",
      "hold",
      "hold",
      "transition",
      "transition",
      "hold",
      "hold",
      "hold",
    ]);
    expect(frames[2].camera).toEqual(
      scene.scenario.presentation!.stops[0].camera,
    );
    expect(frames[3].camera).toEqual(
      interpolateMediaCamera(
        scene.scenario.presentation!.stops[0].camera,
        scene.scenario.presentation!.stops[1].camera,
        1 / 3,
      ),
    );
    expect(frames[5].camera).toEqual(
      scene.scenario.presentation!.stops[1].camera,
    );
    expect(mediaFrameAt(scene, recipe, 4)).toEqual(frames[4]);
    expect(frames.reduce((n, f) => n + f.durationMicroseconds, 0)).toBe(
      Math.floor((frames.length * 1_000_000) / 30),
    );
    expect(frames.map((f) => f.timestampMicroseconds)).toEqual([
      0, 33333, 66666, 100000, 133333, 166666, 200000, 233333,
    ]);
  });
  it("takes the short angular path and preserves exact endpoint cameras", () => {
    const a = {
        center: [179, 10] as [number, number],
        zoom: 10,
        pitch: 20,
        bearing: 170,
      },
      b = {
        center: [-179, 20] as [number, number],
        zoom: 14,
        pitch: 40,
        bearing: -170,
      };
    expect(interpolateMediaCamera(a, b, 0)).toEqual(a);
    expect(interpolateMediaCamera(a, b, 1)).toEqual(b);
    const middle = interpolateMediaCamera(a, b, 0.5);
    expect(middle.center[0]).toBe(-180);
    expect(middle.bearing).toBe(-180);
    expect(middle.pitch).toBe(30);
    expect(middle.center[1]).toBeGreaterThan(15);
  });
  it("rejects dropped/reordered stops, fractional frames, absent end target and overlong output", () => {
    const { scene, recipe } = fixture();
    expect(() =>
      validateMediaExport(scene, {
        ...recipe,
        stops: [recipe.stops[1], recipe.stops[0]],
      }),
    ).toThrow();
    expect(() =>
      validateMediaExport(scene, {
        ...recipe,
        stops: [{ ...recipe.stops[0], transitionFrames: 0 }],
      }),
    ).toThrow(/every saved/);
    expect(() =>
      mediaExportRecipeSchema.parse({
        ...recipe,
        stops: recipe.stops.map((s) => ({ ...s, holdFrames: 2.5 })),
      }),
    ).toThrow();
    expect(() =>
      mediaExportRecipeSchema.parse({
        ...recipe,
        stops: recipe.stops.map((s) => ({ ...s, transitionFrames: 2 })),
      }),
    ).toThrow(/final stop/);
    const f = fixture(24);
    expect(() =>
      mediaExportRecipeSchema.parse({
        ...f.recipe,
        stops: f.recipe.stops.map((s) => ({ ...s, holdFrames: 3600 })),
      }),
    ).toThrow(/frame bound/);
    expect(() => mediaFrameAt(scene, recipe, 8)).toThrow(/frame index/);
  });
  it("rejects imagery fallback and requires cuts between 3D and plan views", () => {
    const { scene, recipe } = fixture();
    scene.scenario.presentation!.stops[1].view = "satellite";
    expect(() => validateMediaExport(scene, recipe)).toThrow(/satellite/);
    scene.scenario.presentation!.stops[1].view = "2d";
    expect(() => validateMediaExport(scene, recipe)).toThrow(/explicit cut/);
    recipe.stops[0].transitionFrames = 0;
    rebind(scene);
    expect(mediaFrameAt(scene, recipe, 3).camera.pitch).toBe(0);
  });
  it("requires deliberate short captions while retaining all authored text and escaped VTT content", () => {
    const { scene, recipe } = fixture();
    const original = "Long & <authored> --> text. ".repeat(25);
    scene.scenario.presentation!.stops[0].callout = original;
    expect(() => validateMediaExport(scene, recipe)).toThrow(
      /brief screen caption/,
    );
    recipe.stops[0].caption = "Reviewed brief caption";
    rebind(scene);
    expect(mediaFrameAt(scene, recipe, 0).caption).toBe(
      "Reviewed brief caption",
    );
    expect(mediaTranscript(scene, recipe)).toContain(original);
    expect(
      mediaTranscript(scene, defaultMediaExportRecipe(scene, "png")),
    ).toContain(original);
    const vtt = mediaWebVtt(scene, recipe);
    expect(vtt).toContain("&lt;authored&gt;");
    expect(vtt).toContain("--&gt;");
    expect(vtt).toContain("00:00:00.000 --> 00:00:00.166");
    expect(vtt).toContain("Authored narration 1");
  });
  it("prepares the full 30,000-frame 24-stop timeline once and isolates every subsequent mutation", () => {
    const { scene, recipe } = fixture(24);
    recipe.stops = recipe.stops.map((s, i) => ({
      ...s,
      holdFrames: 1200,
      transitionFrames: i === 23 ? 0 : i === 22 ? 56 : 52,
    }));
    const timeline = prepareMediaTimeline(scene, recipe),
      first = timeline.frameAt(0);
    expect(timeline.frameCount).toBe(30_000);
    scene.scenario.presentation!.stops[0].camera.center[0] = 0;
    recipe.stops[0].holdFrames = 1;
    first.camera.center[0] = 10;
    first.metricIds.push("mutated");
    expect(timeline.frameAt(0).camera.center[0]).toBe(-112.07);
    expect(timeline.frameAt(0).metricIds).not.toContain("mutated");
    let totalUs = 0,
      previousEnd = 0;
    const holds = new Map<string, number>(),
      transitions = new Map<string, number>();
    for (let i = 0; i < timeline.frameCount; i++) {
      const frame = timeline.frameAt(i);
      if (
        frame.index !== i ||
        frame.timestampMicroseconds !== previousEnd ||
        frame.timeSeconds !== i / 30
      )
        throw new Error("Noncontiguous clock");
      previousEnd = frame.timestampMicroseconds + frame.durationMicroseconds;
      totalUs += frame.durationMicroseconds;
      const totals = frame.phase === "hold" ? holds : transitions;
      totals.set(frame.stopId!, 1 + (totals.get(frame.stopId!) ?? 0));
    }
    expect([...holds.values()]).toEqual(Array(24).fill(1200));
    expect([...transitions.values()]).toEqual([...Array(22).fill(52), 56]);
    expect(totalUs).toBe(1_000_000_000);
    expect(timeline.duration).toEqual({ numerator: 30_000, denominator: 30 });
    expect(() => {
      timeline.layout.map.height = 1;
    }).toThrow();
  });
  it("accepts complete genuine draws and explicitly reused identical holds with current timestamps", () => {
    const { timeline, receipts } = receiptFixture();
    expect(() => assertMediaFrameReceipts(timeline, receipts)).not.toThrow();
    for (const [i, from] of [
      [1, 0],
      [2, 0],
      [6, 5],
      [7, 5],
    ])
      receipts[i] = {
        ...receipts[i],
        reusedFromFrame: from,
        drawSerial: receipts[from].drawSerial,
        pixelHash: receipts[from].pixelHash,
      };
    expect(() => assertMediaFrameReceipts(timeline, receipts)).not.toThrow();
    expect(receipts[1].timestampMicroseconds).not.toBe(
      receipts[0].timestampMicroseconds,
    );
    expect(() => assertMediaFrameReceipts(timeline, receipts.slice(1))).toThrow(
      /count/,
    );
    expect(() => assertMediaFrameReceipts({ ...timeline }, receipts)).toThrow(
      /locally prepared/,
    );
  });
  it("rejects stale camera/generation/clock, duplicate draws, transition reuse, cross-stop reuse and reuse chains", () => {
    const { timeline, receipts } = receiptFixture();
    const mutations: Array<(rows: MediaFrameReceipt[]) => void> = [
      (r) => {
        r[1].actualCamera.center[0] += 0.001;
      },
      (r) => {
        r[1].requestedCamera.zoom += 0.01;
      },
      (r) => {
        r[1].generation = "stale";
      },
      (r) => {
        r[1].timestampMicroseconds = 0;
      },
      (r) => {
        r[1].durationMicroseconds = 1;
      },
      (r) => {
        r[1].drawSerial = r[0].drawSerial;
      },
      (r) => {
        r[3] = { ...r[3], reusedFromFrame: 0, drawSerial: r[0].drawSerial };
      },
      (r) => {
        r[5] = { ...r[5], reusedFromFrame: 0, drawSerial: r[0].drawSerial };
      },
      (r) => {
        r[1] = { ...r[1], reusedFromFrame: 0, drawSerial: r[0].drawSerial };
        r[2] = { ...r[2], reusedFromFrame: 1, drawSerial: r[0].drawSerial };
      },
      (r) => {
        r[1] = {
          ...r[1],
          reusedFromFrame: 0,
          drawSerial: r[0].drawSerial,
          pixelHash: "a".repeat(64),
        };
      },
      (r) => {
        r[1].reusedFromFrame = 1;
      },
      (r) => {
        (r[1] as unknown as { generation: number }).generation = 1;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(receipts);
      mutate(changed);
      expect(() => assertMediaFrameReceipts(timeline, changed)).toThrow();
    }
  });
  it("defines exact image dimensions including credit/callout rectangles", () => {
    const { scene } = fixture(),
      recipe = {
        ...defaultMediaExportRecipe(scene),
        width: 3840,
        height: 2160,
      };
    const layout = mediaLayout(recipe);
    expect(layout.credits.y + layout.credits.height).toBe(2160);
    expect(
      layout.map.height + layout.callout.height + layout.credits.height,
    ).toBe(2160);
    expect(mediaFrameCount(recipe)).toBe(1);
    expect(() =>
      mediaExportRecipeSchema.parse({ ...recipe, width: 4000 }),
    ).toThrow(/exact supported/);
  });
  it("refuses a manifest with dropped frames, wrong scene or incomplete sidecars", () => {
    const { scene, recipe } = fixture(),
      hash = "a".repeat(64);
    const manifest: MediaExportManifest = {
      version: 1,
      methodVersion: MEDIA_METHOD_VERSION,
      sceneHash: scene.sceneHash,
      binding: scene.binding,
      recipe,
      recipeHash: mediaContentHash(recipe),
      frameCount: 8,
      duration: { numerator: 8, denominator: 30 },
      layout: mediaLayout(recipe),
      frameReceiptsHash: hash,
      runtime: { profileVersion: "synthetic-runtime-1", hash },
      renderer: {
        name: "test",
        version: "1",
        profileHash: hash,
        fontHashes: [hash],
      },
      encoder: { name: "test", version: "1", profileHash: hash },
      files: [
        { name: "tour.mp4", sha256: hash, bytes: 1, contentType: "video/mp4" },
        {
          name: "transcript.txt",
          sha256: hash,
          bytes: 1,
          contentType: "text/plain",
        },
        {
          name: "captions.vtt",
          sha256: hash,
          bytes: 1,
          contentType: "text/vtt",
        },
      ],
      sources: scene.sources,
      notes: ["Synthetic test only"],
    };
    expect(() =>
      assertMediaExportManifest(scene, recipe, manifest),
    ).not.toThrow();
    expect(() =>
      assertMediaExportManifest(scene, recipe, { ...manifest, frameCount: 7 }),
    ).toThrow(/timeline/);
    expect(() =>
      assertMediaExportManifest(scene, recipe, {
        ...manifest,
        sceneHash: hash,
      }),
    ).toThrow(/timeline/);
    expect(() =>
      assertMediaExportManifest(scene, recipe, {
        ...manifest,
        files: manifest.files.slice(0, 1),
      }),
    ).toThrow(/sidecars/);
    for (const change of [
      { runtime: { profileVersion: "", hash } },
      { runtime: { profileVersion: "test", hash: "wrong" } },
      { renderer: { ...manifest.renderer, fontHashes: ["wrong"] } },
      { encoder: null },
      { encoder: { ...manifest.encoder!, profileHash: "b".repeat(64) } },
      {
        files: manifest.files.map((f) => ({
          ...f,
          contentType: "text/plain\r\nInjected: true",
        })),
      },
    ])
      expect(() =>
        assertMediaExportManifest(scene, recipe, { ...manifest, ...change }),
      ).toThrow();
    const { receipts } = receiptFixture();
    // Receipt identities are scene-specific; use this test's exact frame/camera fields.
    for (const r of receipts) {
      r.sceneHash = scene.sceneHash;
      r.recipeHash = mediaContentHash(recipe);
    }
    receipts[1] = {
      ...receipts[1],
      reusedFromFrame: 0,
      drawSerial: receipts[0].drawSerial,
      pixelHash: receipts[0].pixelHash,
    };
    manifest.frameReceiptsHash = mediaContentHash(receipts);
    expect(() =>
      assertMediaExportManifest(scene, recipe, manifest, receipts),
    ).toThrow(/disclosed/);
    manifest.notes.push(MEDIA_HOLD_REUSE_NOTE);
    expect(() =>
      assertMediaExportManifest(scene, recipe, manifest, receipts),
    ).not.toThrow();
  });
});
