import { describe, expect, it, vi } from "vitest";
import { trafficContentHash, trafficPairRecipeHash } from "@urban/core";
import {
  trafficNetworkFixture,
  trafficDemandFixture,
  trafficCountFixture,
  trafficFixturePeriod,
  trafficCalibrationFixture,
  trafficResultFixture,
  trafficRecipeFixture,
} from "../../../../packages/core/src/traffic-fixture";
import {
  prepareTrafficExperiment,
  runTrafficExperiment,
  type TrafficExperimentRequest,
} from "./experiment.js";
import type {
  PreparedTrafficNetwork,
  TrafficNativePairRequest,
  TrafficNativePair,
} from "./types.js";

function fixture() {
  const network: PreparedTrafficNetwork = {
    network: trafficNetworkFixture(),
    networkXml: Buffer.from("synthetic-native-placeholder"),
    files: {},
    resources: {
      wallMilliseconds: 1,
      peakMemoryBytes: 1,
      cpuLimit: 2,
      memoryLimitBytes: 2 * 1024 ** 3,
      outputBytes: 1,
    },
  };
  const request: TrafficExperimentRequest = {
    version: 1,
    networkHash: network.network.manifest.networkFileSha256,
    countPack: trafficCountFixture(),
    demand: trafficDemandFixture(),
    period: { ...trafficFixturePeriod },
    seed: 42,
    overlays: [],
    calibrationPlan: null,
    unsupportedChanges: [],
  };
  return { network, request };
}
/** Contract fixture only. Real native behavior is exercised in native.test.ts. */
async function contractPair(
  input: TrafficNativePairRequest,
): Promise<TrafficNativePair> {
  const recipe = {
    ...trafficRecipeFixture(),
    baselineNetworkHash: input.network.network.manifest.networkFileSha256,
    demandHash: input.demandHash,
    countPackHash: input.countPackHash,
    seed: input.seed,
    period: input.period,
  };
  const recipeHash = await trafficPairRecipeHash(recipe);
  const result = (side: "baseline" | "proposal") => ({
    ...trafficResultFixture(side),
    recipeHash,
    networkHash:
      side === "baseline"
        ? recipe.baselineNetworkHash
        : recipe.proposalNetworkHash,
    demandHash: recipe.demandHash,
    seed: input.seed,
    period: input.period,
    diagnostics: {
      requested: input.vehicles.length,
      loaded: input.vehicles.length,
      inserted: input.vehicles.length,
      arrived: input.vehicles.length,
      running: 0,
      waiting: 0,
      discarded: 0,
      teleports: 0,
      collisions: 0,
      routeErrors: 0,
    },
    trips: input.vehicles.map((vehicle) => ({
      id: vehicle.id,
      requestedDepartSeconds: vehicle.departSeconds,
      arrived: true,
      departSeconds: vehicle.departSeconds,
      arrivalSeconds: vehicle.departSeconds + 40,
      durationSeconds: 40,
      routeLengthMeters: 400,
      waitingSeconds: 0,
      timeLossSeconds: 0,
      departDelaySeconds: 0,
    })),
    predictions: input.counts.map((count) => ({
      countId: count.id,
      vehicles: count.value,
      status: "available" as const,
    })),
  });
  return {
    recipe,
    recipeHash,
    baselineNetwork: input.network.network,
    proposalNetwork: {
      ...input.network.network,
      manifest: {
        ...input.network.network.manifest,
        networkFileSha256: recipe.proposalNetworkHash,
      },
    },
    baseline: result("baseline"),
    proposal: result("proposal"),
    resources: input.network.resources,
    files: { "baseline.log": Buffer.from("Synthetic contract fixture only") },
    notes: ["Synthetic contract fixture; no real execution or calibration."],
  };
}

describe("traffic experiment admission and capture", () => {
  it("binds prepared commute demand and its clock without freezing independent seeds or controls", async () => {
    const { network, request } = fixture();
    const originalHash = await trafficContentHash(request);
    const legacy = await prepareTrafficExperiment(network, request);
    expect(legacy.requestHash).toBe(originalHash);
    expect(legacy.request).not.toHaveProperty("commute");
    request.commute = {
      version: 1,
      presetId: "fixture",
      assetHash: "a".repeat(64),
      sourcePackHash: "b".repeat(64),
      priorHash: "c".repeat(64),
      routesHash: "d".repeat(64),
      compilationHash: "e".repeat(64),
      demandHash: await trafficContentHash(request.demand),
      periodHash: await trafficContentHash(request.period),
      networkHash: request.networkHash,
      inventoryHash: await trafficContentHash(network.network),
    };
    const saved = await prepareTrafficExperiment(network, request);
    expect(saved.request.commute).toEqual(request.commute);
    expect(saved.requestHash).not.toBe(originalHash);
    request.seed++;
    request.overlays = [{ edgeId: "in", speedMps: 5 }];
    await expect(
      prepareTrafficExperiment(network, request),
    ).resolves.toBeDefined();
    for (const changed of [
      {
        ...request,
        demand: {
          ...request.demand,
          rows: request.demand.rows.map((row) => ({
            ...row,
            vehicles: row.vehicles + 1,
          })),
        },
      },
      {
        ...request,
        period: {
          ...request.period,
          cooldownSeconds: request.period.cooldownSeconds + 1,
        },
      },
      {
        ...request,
        commute: { ...request.commute, inventoryHash: "f".repeat(64) },
      },
    ])
      await expect(prepareTrafficExperiment(network, changed)).rejects.toThrow(
        /detach/,
      );
    request.demand.rows[0].vehicles++;
    delete request.commute;
    const detached = await prepareTrafficExperiment(network, request);
    expect(detached.request).not.toHaveProperty("commute");
    expect(detached.allocation.vehicles).toHaveLength(8);
  });
  it("rejects oversized explicit demand before per-vehicle route expansion", async () => {
    const { network, request } = fixture();
    request.demand.rows[0].vehicles = 30_001;
    await expect(prepareTrafficExperiment(network, request)).rejects.toThrow(
      /before allocating vehicles/,
    );
  });
  it("retains original out-of-window observations while selecting exact clock intervals", async () => {
    const { network, request } = fixture();
    request.countPack.counts.push({
      ...structuredClone(request.countPack.counts[0]),
      id: "later",
      beginSeconds: 36000,
      endSeconds: 39600,
    });
    const input = await prepareTrafficExperiment(network, request);
    expect(input.counts.map((count) => count.id)).toEqual([
      "count-0",
      "count-1",
    ]);
    expect(input.request.countPack.counts).toHaveLength(3);
    expect(input.allocation.vehicles).toHaveLength(7);
    expect(input.countPackHash).toBe(
      await trafficContentHash(request.countPack),
    );
  });
  it("rejects unsupported changes, stale maps and unresolved demand before invoking native work", async () => {
    const executor = { runPair: vi.fn(contractPair) };
    for (const mutate of [
      (r: TrafficExperimentRequest) => {
        r.unsupportedChanges = ["new turning restriction"];
      },
      (r: TrafficExperimentRequest) => {
        r.networkHash = "e".repeat(64);
      },
      (r: TrafficExperimentRequest) => {
        r.demand.rows[0].vehicles = 0;
      },
      (r: TrafficExperimentRequest) => {
        r.demand.candidateRoutes = [];
      },
      (r: TrafficExperimentRequest) => {
        r.overlays = [{ edgeId: "absent", closed: true }];
      },
      (r: TrafficExperimentRequest) => {
        r.countPack.counts[0].mapping!.networkFileSha256 = "f".repeat(64);
      },
    ]) {
      const { network, request } = fixture();
      mutate(request);
      await expect(
        runTrafficExperiment(network, request, executor),
      ).rejects.toThrow();
    }
    expect(executor.runPair).not.toHaveBeenCalled();
  });
  it("rejects calibration references outside the analysis period and conflicting source declarations", async () => {
    const { network, request } = fixture();
    request.calibrationPlan = trafficCalibrationFixture();
    request.countPack.counts[0].beginSeconds = 36000;
    request.countPack.counts[0].endSeconds = 39600;
    await expect(prepareTrafficExperiment(network, request)).rejects.toThrow(
      /wholly inside/,
    );
    const next = fixture();
    next.request.demand.sources[0] = {
      ...next.request.demand.sources[0],
      license: "changed terms",
    };
    await expect(
      prepareTrafficExperiment(next.network, next.request),
    ).rejects.toThrow(/conflicting declarations/);
  });
  it("produces complete archive inputs and explicitly leaves unrequested calibration unassessed", async () => {
    const { network, request } = fixture(),
      progress: string[] = [];
    const { capture, files } = await runTrafficExperiment(
      network,
      request,
      { runPair: contractPair },
      { progress: (stage) => progress.push(stage) },
    );
    expect(capture.allocation.vehicleCount).toBe(7);
    expect(capture.comparison.baseline.status).toBe("complete");
    expect(capture.calibration).toBeNull();
    expect(capture.analysisScope).toBe("explicit-network-experiment");
    expect(capture.requestHash).toBe(await trafficContentHash(request));
    expect(JSON.parse(files["experiment.json"].toString())).toEqual(capture);
    expect(Object.keys(files)).toEqual([
      "baseline.log",
      "experiment.json",
      "baseline-network.json",
      "proposal-network.json",
    ]);
    expect(progress).toEqual([
      "validating",
      "simulating",
      "evaluating",
      "saving",
    ]);
  });
  it("separates baseline count fit and held-out counts under explicitly supplied criteria", async () => {
    const { network, request } = fixture();
    request.calibrationPlan = trafficCalibrationFixture();
    const { capture } = await runTrafficExperiment(network, request, {
      runPair: contractPair,
    });
    expect(capture.calibration).toMatchObject({
      scope: "interval-count-fit",
      status: "passed",
      calibration: { evaluated: 1 },
      holdout: { evaluated: 1 },
    });
    expect(capture.notes.join(" ")).toMatch(
      /Count fit alone does not validate a forecast/,
    );
  });
  it("rejects a native reply with different original demand or a substituted recipe hash", async () => {
    const { network, request } = fixture();
    for (const change of [
      (pair: TrafficNativePair) => {
        pair.recipe.demandHash = "e".repeat(64);
      },
      (pair: TrafficNativePair) => {
        pair.recipeHash = "e".repeat(64);
      },
    ]) {
      await expect(
        runTrafficExperiment(network, request, {
          runPair: async (input) => {
            const pair = await contractPair(input);
            change(pair);
            return pair;
          },
        }),
      ).rejects.toThrow(/returned/i);
    }
  });
  it("honors cancellation before any native work", async () => {
    const { network, request } = fixture(),
      controller = new AbortController(),
      executor = { runPair: vi.fn(contractPair) };
    controller.abort();
    await expect(
      runTrafficExperiment(network, request, executor, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(executor.runPair).not.toHaveBeenCalled();
  });
});
