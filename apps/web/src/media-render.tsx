import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  assertMediaScene,
  prepareMediaTimeline,
  type MediaScene,
  type MediaExportRecipe,
  type MediaFrame,
  type PresentationCamera,
} from "@urban/core";
import { MediaRenderScene } from "./components/media/MediaRenderScene";
import { loadMediaFonts } from "./components/media/fonts";
import { applyScheduledCamera } from "./components/media/scheduled-frame";
import type { MapExportHandle } from "./components/map/export-frame";
const host =
  document.getElementById("root") ??
  document.body.appendChild(document.createElement("div"));
document.documentElement.style.margin = "0";
document.body.style.margin = "0";
const root = createRoot(host),
  rendererRef: { current: MapExportHandle | null } = { current: null };
let loaded: {
    scene: MediaScene;
    recipe: MediaExportRecipe;
    timeline: ReturnType<typeof prepareMediaTimeline>;
  } | null = null,
  generation = 0,
  running = false,
  failure: string | null = null,
  lastFrame: MediaFrame | null = null;
const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const bridge = {
  abiVersion: 1 as const,
  status: () => ({
    loaded: !!loaded,
    running,
    failure,
    sceneHash: loaded?.scene.sceneHash ?? null,
  }),
  async load(scene: MediaScene, input: MediaExportRecipe) {
    if (running) throw new Error("An export frame is already rendering.");
    generation++;
    loaded = null;
    failure = null;
    lastFrame = null;
    rendererRef.current = null;
    flushSync(() => root.render(null));
    assertMediaScene(scene);
    const timeline = prepareMediaTimeline(scene, input),
      recipe = structuredClone(input);
    await loadMediaFonts();
    loaded = { scene: structuredClone(scene), recipe, timeline };
    flushSync(() =>
      root.render(
        <MediaRenderScene
          key={generation}
          scene={loaded!.scene}
          recipe={loaded!.recipe}
          frame={timeline.frameAt(0)}
          rendererRef={rendererRef}
        />,
      ),
    );
    return {
      abiVersion: 1,
      sceneHash: scene.sceneHash,
      recipeHash: timeline.recipeHash,
      frameCount: timeline.frameCount,
      width: recipe.width,
      height: recipe.height,
    };
  },
  async renderFrame(index: number, scheduledCamera?: PresentationCamera) {
    if (!loaded || running)
      throw new Error(
        "Load a frozen scene and finish the previous frame first.",
      );
    running = true;
    const token = generation,
      { scene, recipe, timeline } = loaded;
    try {
      const frame = applyScheduledCamera(
          timeline.frameAt(index),
          scheduledCamera,
        ),
        layout = timeline.layout;
      flushSync(() =>
        root.render(
          <MediaRenderScene
            key={token}
            scene={scene}
            recipe={recipe}
            frame={frame}
            rendererRef={rendererRef}
          />,
        ),
      );
      const deadline = performance.now() + 15000;
      while (!rendererRef.current) {
        if (performance.now() > deadline)
          throw new Error("The 3D export renderer did not initialize.");
        await nextPaint();
      }
      const ack = await rendererRef.current.renderFrame({
        sceneHash: scene.sceneHash,
        frameIndex: index,
        width: layout.map.width,
        height: layout.map.height,
        view: frame.view,
        camera: frame.camera,
      });
      if (token !== generation)
        throw new Error("The export scene changed while rendering.");
      const output = document.getElementById("urban-media-output")!;
      if (
        output.offsetWidth !== recipe.width ||
        output.offsetHeight !== recipe.height
      )
        throw new Error(
          "The compositor did not retain the exact requested output dimensions.",
        );
      for (const element of output.querySelectorAll<HTMLElement>(
        "[data-media-text]",
      ))
        if (
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1
        )
          throw new Error(
            "The complete caption, metric labels or source credits do not fit this composition. Shorten the authored screen caption or choose a larger layout; no text was truncated.",
          );
      failure = null;
      lastFrame = structuredClone(frame);
      return {
        abiVersion: 1,
        index,
        frameIndex: index,
        sceneHash: scene.sceneHash,
        recipeHash: timeline.recipeHash,
        generation: String(token),
        drawSerial: ack.drawSerial,
        requestedCamera: frame.camera,
        actualCamera: ack.camera,
        camera: ack.camera,
        width: recipe.width,
        height: recipe.height,
        timestampMicroseconds: frame.timestampMicroseconds,
        durationMicroseconds: frame.durationMicroseconds,
      };
    } catch (error) {
      failure = error instanceof Error ? error.message : "Export failed.";
      throw error;
    } finally {
      running = false;
    }
  },
  assertFrame(index: number) {
    if (
      !loaded ||
      running ||
      lastFrame?.index !== index ||
      failure ||
      !rendererRef.current
    )
      throw new Error("The captured frame is no longer current.");
    const frame = lastFrame,
      map = loaded.timeline.layout.map;
    rendererRef.current.assertFrame({
      sceneHash: loaded.scene.sceneHash,
      frameIndex: index,
      width: map.width,
      height: map.height,
      view: frame.view,
      camera: frame.camera,
    });
  },
  dispose() {
    generation++;
    loaded = null;
    rendererRef.current = null;
    flushSync(() => root.render(null));
  },
};
Object.assign(window, { urbanMediaRenderer: bridge });
export type UrbanMediaRenderer = typeof bridge;
