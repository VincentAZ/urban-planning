import {
  studyAreaBounds,
  type MetricResult,
  type ModelResults,
  type Place,
  type PresentationCamera,
  type PresentationStop,
  type Scenario,
  type ScenarioPresentation,
} from "@urban/core";

export const PRESENTATION_LAYERS = [
  "buildings",
  "roads",
  "parks",
  "parcels",
  "flood",
];
export const PRESENTATION_CAMERA_LIMITS = {
  minZoom: 2,
  maxZoom: 21,
  maxPitch: 60,
};
const priorityIds = [
  "housing.units",
  "economy.jobs",
  "mobility.dailyTrips",
  "fiscal.netAnnual",
];

export function overviewCamera(place: Place): PresentationCamera {
  const [west, south, east, north] = studyAreaBounds(place);
  const span = Math.max(east - west, (north - south) * 1.6, 0.001);
  return {
    center: [(west + east) / 2, (south + north) / 2],
    zoom: Math.max(2, Math.min(17, Math.log2(360 / span) - 0.8)),
    pitch: 45,
    bearing: -27,
  };
}
export function overviewPresentation(
  place: Place,
  scenario: Scenario,
  results: ModelResults,
  camera?: PresentationCamera,
): ScenarioPresentation {
  const source = camera ?? overviewCamera(place);
  const view: PresentationCamera = {
    center: [...source.center],
    zoom: Math.max(2, Math.min(21, source.zoom)),
    pitch: Math.max(0, Math.min(60, source.pitch)),
    bearing: ((((source.bearing + 180) % 360) + 360) % 360) - 180,
  };
  return {
    version: 1,
    title: `${scenario.name} · a guided view`.slice(0, 160),
    stops: [
      {
        id: crypto.randomUUID(),
        title: "Start with the place",
        callout:
          scenario.description.slice(0, 2000) ||
          `Explore ${place.extentLabel}. This view uses the scenario’s captured source geometry.`,
        camera: structuredClone(view),
        view: "3d",
      },
      {
        id: crypto.randomUUID(),
        title: "See what changes",
        callout:
          "Compare the proposal with its unchanged baseline. Open each measure to see its method, inputs, sources, and limitations.",
        camera: structuredClone(view),
        view: "3d",
        metricIds: priorityIds.filter((id) =>
          results.metrics.some((metric) => metric.id === id),
        ),
      },
    ],
  };
}
export function presentationMetric(
  id: string,
  scenario: Scenario,
  results: ModelResults,
): MetricResult | null {
  if (
    results.scenarioId !== scenario.id ||
    results.revision !== scenario.revision
  )
    return null;
  return (
    results.metrics.find(
      (metric) =>
        metric.id === id && metric.scenarioRevision === scenario.revision,
    ) ?? null
  );
}
export function movePresentationStop(
  stops: PresentationStop[],
  id: string,
  direction: -1 | 1,
): PresentationStop[] {
  const index = stops.findIndex((stop) => stop.id === id),
    next = index + direction;
  if (index < 0 || next < 0 || next >= stops.length) return stops;
  const reordered = [...stops];
  [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
  return reordered;
}
export function localNarrationVoices(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice[] {
  return voices
    .filter((voice) => voice.localService)
    .sort(
      (a, b) =>
        Number(b.lang.startsWith("en")) - Number(a.lang.startsWith("en")) ||
        a.name.localeCompare(b.name),
    );
}
