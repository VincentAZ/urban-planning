import { describe, expect, it } from "vitest";
import { createScenario } from "@urban/models";
import {
  canonicalJSON,
  scenarioPresentationSchema,
  type MetricResult,
  type ModelResults,
  type Place,
  type PresentationCamera,
  type PresentationStop,
} from "@urban/core";
import {
  localNarrationVoices,
  movePresentationStop,
  overviewCamera,
  overviewPresentation,
  presentationMetric,
} from "./state";

const place: Place = {
  id: "presentation-helper-fixture",
  name: "Fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
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
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05",
  extentLabel: "Synthetic captured area",
};
function metric(id: string, revision = 3): MetricResult {
  return {
    id,
    label: id,
    domain: "Housing",
    unit: "units",
    baseline: 10,
    value: 12,
    delta: 2,
    status: "incomplete",
    explanation: "Supplied quantities",
    formula: "Sum quantities",
    inputs: [],
    sourceIds: [],
    method: "Fixture",
    methodVersion: "fixture-1",
    scenarioRevision: revision,
    geography: place.extentLabel,
  };
}
function fixture() {
  const scenario = { ...createScenario("Option A"), revision: 3 };
  const results: ModelResults = {
    scenarioId: scenario.id,
    revision: 3,
    computedAt: "2026-11-05T00:00:00.000Z",
    modelVersion: "0.4.0",
    warnings: [],
    metrics: [
      metric("housing.units"),
      metric("economy.jobs"),
      metric("mobility.los"),
      metric("future.metric"),
    ],
  };
  return { scenario, results };
}
function stop(id: string): PresentationStop {
  return {
    id,
    title: id,
    callout: "",
    camera: overviewCamera(place),
    view: "3d",
  };
}
function voice(
  name: string,
  lang: string,
  localService: boolean,
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    localService,
    voiceURI: `voice:${name}`,
    default: false,
  };
}

describe("presentation state helpers", () => {
  it("creates an unsaved valid overview for a legacy scenario without mutating captured data or borrowing its camera", () => {
    const { scenario, results } = fixture();
    const camera: PresentationCamera = {
      center: [...place.center],
      zoom: 16,
      pitch: 30,
      bearing: 15,
    };
    const prior = canonicalJSON({ place, scenario, results, camera });
    const overview = overviewPresentation(place, scenario, results, camera);
    expect(scenarioPresentationSchema.safeParse(overview).success).toBe(true);
    expect(overview.stops.map((item) => item.title)).toEqual([
      "Start with the place",
      "See what changes",
    ]);
    expect(new Set(overview.stops.map((item) => item.id)).size).toBe(2);
    expect(overview.stops[0].callout).toContain(place.extentLabel);
    expect(overview.stops[1].metricIds).toEqual([
      "housing.units",
      "economy.jobs",
    ]);
    expect(scenario).not.toHaveProperty("presentation");
    expect(canonicalJSON({ place, scenario, results, camera })).toBe(prior);
    overview.stops[0].camera.center[0] = 0;
    expect(overview.stops[1].camera.center).toEqual(camera.center);
    expect(camera.center).toEqual(place.center);
    expect(canonicalJSON({ place, scenario, results, camera })).toBe(prior);
  });

  it("uses exact multipart study bounds for the overview and respects title/callout limits", () => {
    const { scenario, results } = fixture();
    const exact: Place = {
      ...place,
      studyArea: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-112.2, 33.4],
              [-112.19, 33.4],
              [-112.19, 33.41],
              [-112.2, 33.41],
              [-112.2, 33.4],
            ],
          ],
          [
            [
              [-111.9, 33.6],
              [-111.89, 33.6],
              [-111.89, 33.61],
              [-111.9, 33.61],
              [-111.9, 33.6],
            ],
          ],
        ],
      },
    };
    const camera = overviewCamera(exact);
    expect(camera.center[0]).toBeCloseTo(-112.045);
    expect(camera.center[1]).toBeCloseTo(33.505);
    expect(camera.zoom).toBeGreaterThanOrEqual(2);
    expect(camera.zoom).toBeLessThanOrEqual(17);
    const long = {
      ...scenario,
      name: "N".repeat(240),
      description: "D".repeat(10000),
    };
    const overview = overviewPresentation(exact, long, results);
    expect(overview.title).toHaveLength(160);
    expect(overview.stops[0].callout).toHaveLength(2000);
    expect(long.description).toHaveLength(10000);
    expect(scenarioPresentationSchema.safeParse(overview).success).toBe(true);
  });

  it("resolves only matching scenario and metric revisions while preserving known unavailable results and absent-model references", () => {
    const { scenario, results } = fixture();
    expect(presentationMetric("housing.units", scenario, results)).toBe(
      results.metrics[0],
    );
    expect(
      presentationMetric("housing.units", scenario, {
        ...results,
        scenarioId: "different-scenario",
      }),
    ).toBeNull();
    expect(
      presentationMetric("housing.units", scenario, {
        ...results,
        revision: 2,
      }),
    ).toBeNull();
    expect(
      presentationMetric("housing.units", scenario, {
        ...results,
        metrics: [metric("housing.units", 2)],
      }),
    ).toBeNull();
    expect(
      presentationMetric("housing.townhome", scenario, results),
    ).toBeNull();
    const unavailable: MetricResult = {
      ...metric("mobility.los"),
      status: "unavailable",
      value: null,
      baseline: null,
      delta: null,
    };
    expect(
      presentationMetric("mobility.los", scenario, {
        ...results,
        metrics: [unavailable],
      }),
    ).toBe(unavailable);
    const newerModel = {
      ...results,
      modelVersion: "future-model",
      metrics: [metric("future.metric")],
    };
    expect(
      presentationMetric("housing.units", scenario, newerModel),
    ).toBeNull();
    expect(presentationMetric("future.metric", scenario, newerModel)).toBe(
      newerModel.metrics[0],
    );
  });

  it("reorders adjacent stops without mutating the original and treats boundaries or missing IDs as no-ops", () => {
    const stops = [stop("first"), stop("second"), stop("third")],
      prior = canonicalJSON(stops);
    expect(movePresentationStop(stops, "first", -1)).toBe(stops);
    expect(movePresentationStop(stops, "third", 1)).toBe(stops);
    expect(movePresentationStop(stops, "missing", 1)).toBe(stops);
    const later = movePresentationStop(stops, "first", 1);
    expect(later.map((item) => item.id)).toEqual(["second", "first", "third"]);
    expect(movePresentationStop(later, "first", -1)).toEqual(stops);
    expect(canonicalJSON(stops)).toBe(prior);
    expect(later[1]).toBe(stops[0]);
    expect(movePresentationStop([], "missing", -1)).toEqual([]);
  });

  it("excludes every browser-reported remote voice and orders local choices without mutating the supplied voice list", () => {
    const voices = [
      voice("Remote English", "en-US", false),
      voice("Local Spanish", "es-US", true),
      voice("Zed English", "en-GB", true),
      voice("Amy English", "en-US", true),
      voice("Remote French", "fr-FR", false),
    ];
    const original = [...voices];
    const eligible = localNarrationVoices(voices);
    expect(eligible.map((item) => item.name)).toEqual([
      "Amy English",
      "Zed English",
      "Local Spanish",
    ]);
    expect(eligible.every((item) => item.localService)).toBe(true);
    expect(eligible).not.toBe(voices);
    expect(voices).toEqual(original);
    expect(
      localNarrationVoices([voice("Remote only", "en-US", false)]),
    ).toEqual([]);
    expect(localNarrationVoices([])).toEqual([]);
  });
});
