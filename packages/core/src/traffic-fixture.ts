/** Small synthetic test graph. No real traffic, coordinates, source counts or calibration are asserted. */
import type {
  TrafficNetwork,
  TrafficDemand,
  TrafficCountPack,
  TrafficPeriod,
  TrafficCalibrationPlan,
  TrafficPairRecipe,
  TrafficSimulationResult,
} from "./traffic";
import type { Source } from "./index";
export const trafficFixtureSource: Source = {
  id: "traffic-fixture",
  name: "Synthetic traffic test fixture",
  url: "",
  vintage: "Synthetic",
  license: "Test fixture",
  kind: "user-supplied",
};
export const trafficFixturePeriod: TrafficPeriod = {
  date: "2026-01-12",
  timeZone: "America/Phoenix",
  utcOffsetMinutes: -420,
  beginSeconds: 28800,
  endSeconds: 32400,
  warmupSeconds: 900,
  cooldownSeconds: 900,
};
export function trafficNetworkFixture(): TrafficNetwork {
  const sourceIds = [trafficFixtureSource.id],
    quality = "authored" as const;
  const nodes = [
    { id: "a", position: [-112.005, 33] },
    { id: "b", position: [-112.004, 33] },
    { id: "c", position: [-112.003, 33.001] },
    { id: "d", position: [-112.003, 32.999] },
    { id: "e", position: [-112.002, 33] },
    { id: "f", position: [-112.001, 33] },
  ].map((n) => ({
    ...n,
    position: n.position as [number, number],
    type: n.id === "b" ? ("traffic_light" as const) : ("priority" as const),
    external: n.id === "a" || n.id === "f",
    quality,
    sourceIds,
  }));
  const edges = [
    { id: "in", from: "a", to: "b" },
    { id: "top", from: "b", to: "c" },
    { id: "bottom", from: "b", to: "d" },
    { id: "topjoin", from: "c", to: "e" },
    { id: "bottomjoin", from: "d", to: "e" },
    { id: "out", from: "e", to: "f" },
  ].map((e) => ({
    ...e,
    sourceWayIds: [`fixture-${e.id}`],
    quality,
    sourceIds,
    lanes: [
      {
        id: `${e.id}_0`,
        index: 0,
        shape: [
          nodes.find((n) => n.id === e.from)!.position,
          nodes.find((n) => n.id === e.to)!.position,
        ],
        lengthMeters: 100,
        speedMps: 10,
        allowedClasses: ["passenger" as const, "truck" as const],
        quality,
        sourceIds,
      },
    ],
  }));
  const connections = [
    ["in", "top"],
    ["in", "bottom"],
    ["top", "topjoin"],
    ["bottom", "bottomjoin"],
    ["topjoin", "out"],
    ["bottomjoin", "out"],
  ].map(([fromEdge, toEdge], i) => ({
    id: `connection-${i}`,
    fromEdge,
    toEdge,
    fromLane: `${fromEdge}_0`,
    toLane: `${toEdge}_0`,
    viaLaneIds: [],
    direction: "straight" as const,
    ...(i < 2 ? { signalId: "signal-b", signalIndex: 0 } : {}),
    quality,
    sourceIds,
  }));
  return {
    version: 1,
    id: "synthetic-diamond",
    manifest: {
      engine: {
        name: "sumo",
        version: "synthetic-test",
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      networkFileSha256: "a".repeat(64),
      sourceFiles: [],
      sources: [trafficFixtureSource],
      conversion: { version: "fixture", options: [], warnings: [] },
      bounds: [-112.01, 32.99, -111.99, 33.01],
      notes: ["Synthetic graph for deterministic unit tests only."],
    },
    nodes,
    edges,
    connections,
    signals: [
      {
        id: "signal-b",
        nodeIds: ["b"],
        programId: "fixture",
        offsetSeconds: 0,
        connectionIds: [["connection-0", "connection-1"]],
        phases: [
          { durationSeconds: 30, state: "G" },
          { durationSeconds: 30, state: "r" },
        ],
        quality,
        sourceIds,
      },
    ],
  };
}
export function trafficDemandFixture(): TrafficDemand {
  return {
    version: 1,
    rows: [
      {
        id: "commute",
        originEdge: "in",
        destinationEdge: "out",
        beginSeconds: 28800,
        endSeconds: 32400,
        vehicleClass: "passenger",
        vehicles: 7,
        purpose: "commute",
        quality: "authored",
        sourceIds: [trafficFixtureSource.id],
      },
    ],
    candidateRoutes: [
      {
        id: "upper",
        odId: "commute",
        edges: ["in", "top", "topjoin", "out"],
        weight: 0.6,
        sourceIds: [trafficFixtureSource.id],
      },
      {
        id: "lower",
        odId: "commute",
        edges: ["in", "bottom", "bottomjoin", "out"],
        weight: 0.4,
        sourceIds: [trafficFixtureSource.id],
      },
    ],
    sources: [trafficFixtureSource],
    notes: ["Explicit synthetic one-way trips, not a population conversion."],
  };
}
export function trafficCountFixture(): TrafficCountPack {
  return {
    version: 1,
    id: "synthetic-counts",
    sources: [trafficFixtureSource],
    files: [],
    annualCounts: [],
    notes: [],
    counts: ["in", "out"].map((edgeId, i) => ({
      id: `count-${i}`,
      stationId: `fixture-${i}`,
      position: null,
      date: trafficFixturePeriod.date,
      timeZone: trafficFixturePeriod.timeZone,
      utcOffsetMinutes: trafficFixturePeriod.utcOffsetMinutes,
      beginSeconds: 28800,
      endSeconds: 29700,
      value: i ? 4 : 3,
      status: "available",
      kind: "observed",
      target: { kind: "edge", edgeId, positionFraction: 0.5 },
      mapping: {
        networkFileSha256: "a".repeat(64),
        method: "manual",
        snapMeters: 0,
        directionAgreement: "confirmed",
        reviewedBy: "fixture",
        reviewedAt: "2026-01-12T00:00:00Z",
      },
      vehicleClasses: ["passenger"],
      raw: {
        directionCode: "1",
        laneCode: "0",
        classCode: "passenger",
        recordId: `fixture-${i}`,
        value: String(i ? 4 : 3),
      },
      sourceIds: [trafficFixtureSource.id],
      notes: ["Synthetic observed-shaped record, not real traffic evidence."],
    })),
  };
}
export function trafficCalibrationFixture(): TrafficCalibrationPlan {
  return {
    calibrationCountIds: ["count-0"],
    holdoutCountIds: ["count-1"],
    criteria: {
      gehMaximum: 5,
      absoluteHourlyErrorMaximum: 20,
      relativeErrorMaximum: 0.15,
      requiredPassingFraction: 1,
      minimumCalibrationCounts: 1,
      minimumHoldoutCounts: 1,
    },
    sourceIds: [trafficFixtureSource.id],
    description: "Synthetic test acceptance criteria; not agency guidance.",
  };
}
export function trafficRecipeFixture(): TrafficPairRecipe {
  return {
    version: 1,
    baselineNetworkHash: "a".repeat(64),
    proposalNetworkHash: "b".repeat(64),
    demandHash: "c".repeat(64),
    countPackHash: "d".repeat(64),
    settingsHash: "e".repeat(64),
    period: { ...trafficFixturePeriod },
    seed: 42,
    methodVersion: "1.0.0",
  };
}
export function trafficResultFixture(
  side: "baseline" | "proposal" = "baseline",
): TrafficSimulationResult {
  const recipe = trafficRecipeFixture();
  return {
    version: 1,
    side,
    recipeHash: "f".repeat(64),
    networkHash:
      side === "baseline"
        ? recipe.baselineNetworkHash
        : recipe.proposalNetworkHash,
    demandHash: recipe.demandHash,
    assignedRoutesHash: "1".repeat(64),
    seed: 42,
    period: { ...recipe.period },
    diagnostics: {
      requested: 2,
      loaded: 2,
      inserted: 2,
      arrived: 2,
      running: 0,
      waiting: 0,
      discarded: 0,
      teleports: 0,
      collisions: 0,
      routeErrors: 0,
    },
    trips: [0, 1].map((i) => ({
      id: `vehicle-${i}`,
      requestedDepartSeconds: 28800 + i,
      arrived: true,
      departSeconds: 28800 + i,
      arrivalSeconds: 28840 + i,
      durationSeconds: 40,
      routeLengthMeters: 400,
      waitingSeconds: 0,
      timeLossSeconds: 0,
      departDelaySeconds: 0,
    })),
    predictions: [],
    edges: [],
    files: [],
    notes: [],
  };
}
