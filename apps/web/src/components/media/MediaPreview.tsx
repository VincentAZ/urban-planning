import { useEffect, useMemo, useRef, useState } from "react";
import {
  prepareMediaTimeline,
  type MediaScene,
  type MediaExportRecipe,
} from "@urban/core";
import { MediaRenderScene } from "./MediaRenderScene";
import { loadMediaFonts } from "./fonts";
import type { MapExportHandle } from "../map/export-frame";
import { renderCurrentExportFrame } from "./preview-frame";
export function MediaPreview({
  scene,
  recipe,
  index,
}: {
  scene: MediaScene;
  recipe: MediaExportRecipe;
  index: number;
}) {
  const host = useRef<HTMLDivElement>(null),
    rendererRef = useRef<MapExportHandle | null>(null);
  const [width, setWidth] = useState(0),
    [fonts, setFonts] = useState(false),
    [status, setStatus] = useState("Preparing exact-resolution preview…"),
    [error, setError] = useState("");
  const timeline = useMemo(
    () => prepareMediaTimeline(scene, recipe),
    [scene, recipe],
  );
  const frame = timeline.frameAt(index),
    layout = timeline.layout;
  useEffect(() => {
    let live = true;
    loadMediaFonts()
      .then(() => {
        if (live) setFonts(true);
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!fonts) return;
    const controller = new AbortController();
    setError("");
    setStatus("Rendering frozen preview…");
    void (async () => {
      await renderCurrentExportFrame(
        () => rendererRef.current,
        {
          sceneHash: scene.sceneHash,
          frameIndex: index,
          width: layout.map.width,
          height: layout.map.height,
          view: frame.view,
          camera: frame.camera,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      for (const element of host.current!.querySelectorAll<HTMLElement>(
        "[data-media-text]",
      ))
        if (
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1
        )
          throw new Error(
            "The complete screen text does not fit. Revise the brief caption before exporting.",
          );
      setStatus(
        `Frozen preview ready · ${recipe.width} × ${recipe.height} pixels · frame ${index + 1}`,
      );
    })().catch((error) => {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : "Preview failed.");
        setStatus("");
      }
    });
    return () => controller.abort();
  }, [fonts, scene, recipe, index]);
  return (
    <section className="media-preview" aria-label="Frozen export preview">
      <div
        ref={host}
        className="media-preview-frame"
        style={{ height: (width * recipe.height) / recipe.width }}
      >
        {fonts && (
          <div
            style={{
              width: recipe.width,
              height: recipe.height,
              transform: `scale(${width / recipe.width})`,
              transformOrigin: "top left",
            }}
          >
            <MediaRenderScene
              scene={scene}
              recipe={recipe}
              frame={frame}
              rendererRef={rendererRef}
            />
          </div>
        )}
      </div>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      <p>
        Preview uses the full output resolution, displayed smaller here. Output
        contains the saved scene, not live edits.
      </p>
    </section>
  );
}
