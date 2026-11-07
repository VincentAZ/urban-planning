import { useMemo, type MutableRefObject } from "react";
import {
  mediaLayout,
  type MediaScene,
  type MediaExportRecipe,
  type MediaFrame,
} from "@urban/core";
import { formatMetric } from "@urban/models";
import { CityMap } from "../CityMap";
import type { MapExportHandle } from "../map/export-frame";
import "./media-render.css";
const noSelection = () => {};
const limits = { minZoom: 2, maxZoom: 21, maxPitch: 60 };
export function MediaRenderScene({
  scene,
  recipe,
  frame,
  rendererRef,
}: {
  scene: MediaScene;
  recipe: MediaExportRecipe;
  frame: MediaFrame;
  rendererRef: MutableRefObject<MapExportHandle | null>;
}) {
  const layout = mediaLayout(recipe),
    scale = recipe.width / 1920;
  const exportMode = useMemo(
    () => ({ sceneHash: scene.sceneHash, rendererRef }),
    [scene.sceneHash, rendererRef],
  );
  const credits = useMemo(
    () =>
      [
        ...new Set(
          scene.sources.map(
            ({ source }) => `${source.name} (${source.license})`,
          ),
        ),
      ].join("; "),
    [scene],
  );
  return (
    <div
      id="urban-media-output"
      className="media-render-output"
      style={
        {
          width: recipe.width,
          height: recipe.height,
          "--media-scale": scale,
        } as React.CSSProperties
      }
      data-scene-hash={scene.sceneHash}
      data-frame-index={frame.index}
    >
      <div
        className="media-render-map"
        style={{
          left: layout.map.x,
          top: layout.map.y,
          width: layout.map.width,
          height: layout.map.height,
        }}
      >
        <CityMap
          key={scene.sceneHash}
          place={scene.place}
          scenario={scene.scenario}
          floodDatasets={scene.floodDatasets}
          selectedId={null}
          onSelect={noSelection}
          view={frame.view}
          playing={false}
          speed={1}
          timeOfDay={recipe.timeOfDay}
          layers={recipe.layers}
          camera={frame.camera}
          cameraLimits={limits}
          exportMode={exportMode}
        />
      </div>
      <section
        className="media-render-callout"
        style={{
          left: layout.callout.x,
          top: layout.callout.y,
          width: layout.callout.width,
          height: layout.callout.height,
        }}
      >
        <div className="media-render-story" data-media-text>
          <h1>{frame.title}</h1>
          <p>{frame.caption}</p>
        </div>
        {frame.metricIds.length > 0 && (
          <div className="media-render-metrics" data-media-text>
            {frame.metricIds.map((id) => {
              const metric = scene.results.metrics.find(
                (metric) =>
                  metric.id === id &&
                  metric.scenarioRevision === scene.binding.scenarioRevision,
              );
              return (
                <div key={id}>
                  <span>{metric?.label ?? id}</span>
                  <strong>
                    {metric?.value === null || !metric
                      ? "Unavailable"
                      : formatMetric(metric.value, metric.unit)}
                  </strong>
                  <small>
                    {metric?.status === "ready"
                      ? "Captured scenario estimate"
                      : metric?.status === "incomplete"
                        ? "Incomplete evidence"
                        : "Unavailable"}
                  </small>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <footer
        className="media-render-credits"
        style={{
          left: layout.credits.x,
          top: layout.credits.y,
          width: layout.credits.width,
          height: layout.credits.height,
        }}
        data-media-text
      >
        <strong>
          {scene.scenario.name} · Revision {scene.binding.scenarioRevision} ·{" "}
          {scene.place.extentLabel} ·{" "}
          {frame.view === "3d" ? "3D city" : "2D plan"}
        </strong>
        <p>
          Planning illustration · Attributes may be estimated. No simulated
          traffic or narration audio.{" "}
          {scene.scenario.flood && recipe.layers.includes("flood")
            ? `Flood: ${scene.scenario.flood.origin === "imported" ? "imported, not server verified" : "captured effective FEMA"}; missing coverage unknown; footprint screening, not a regulatory determination. `
            : ""}
          Full notes, methods, sources and permissions accompany this file.
        </p>
        <p>
          Source credits: {credits}. Geometry credit where applicable: ©
          OpenStreetMap contributors · openstreetmap.org/copyright.
        </p>
      </footer>
    </div>
  );
}
