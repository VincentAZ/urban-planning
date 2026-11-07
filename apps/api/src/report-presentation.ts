import { assertScenarioPresentation } from "@urban/core";
import type { ReportSnapshot } from "./exports";

export const presentationReportDisclosure =
  "This outline preserves the scenario author's presentation text and requested camera views. It is not a model conclusion, verified evidence, generated narration audio, or a video export. Referenced metrics belong to this saved scenario revision; their values, methods and limitations remain in the scorecard. Missing references are retained and explicitly labeled unavailable. Requested satellite views depend on configured imagery and are not supplied by this outline.";

/** Keep the authored narrative separate from calculated evidence and never fill missing metric references with invented values. */
export function presentationReportOutline(snapshot: ReportSnapshot) {
  const presentation = snapshot.scenario.presentation;
  if (!presentation) return null;
  assertScenarioPresentation(presentation);
  const metrics = new Map(
    snapshot.results.metrics.map((metric) => [metric.id, metric]),
  );
  return {
    title: presentation.title,
    scenarioId: snapshot.scenario.id,
    revision: snapshot.scenario.revision,
    stops: presentation.stops.map((stop, index) => ({
      order: index + 1,
      id: stop.id,
      title: stop.title,
      callout: stop.callout,
      narration: stop.narration,
      view: stop.view,
      camera: { ...stop.camera, center: [...stop.camera.center] },
      cameraDescription: `Requested ${stop.view} view; center longitude ${stop.camera.center[0]}, latitude ${stop.camera.center[1]}; zoom ${stop.camera.zoom}; pitch ${stop.camera.pitch}°; bearing ${stop.camera.bearing}°.`,
      metricIds: [...(stop.metricIds ?? [])],
      metricReferences: (stop.metricIds ?? []).map((id) => {
        const metric = metrics.get(id);
        return metric
          ? `${metric.label} [${id}]${metric.status === "unavailable" ? " — unavailable in this saved result bundle" : ""}`
          : `${id} — unavailable in this saved result bundle`;
      }),
    })),
  };
}
