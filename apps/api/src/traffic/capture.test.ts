import { FixtureRuntime } from "./job-fixture";
import { packagedCommuteFixture } from "./commute-evidence-fixture";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJSON,
  trafficContentHash,
  reviewTrafficPlanningRoads,
  trafficPairRecipeHash,
  verifyTrafficScenario,
} from "@urban/core";
import { createProject } from "@urban/models";
import {
  trafficNetworkFixture,
  trafficCountFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
  trafficRecipeFixture,
  trafficResultFixture,
  trafficCalibrationFixture,
} from "../../../../packages/core/src/traffic-fixture";
import { trafficPlaceFixture } from "../../../../tests/fixtures/traffic";
import { TrafficArchive } from "./archive";
import {
  runTrafficExperiment,
  type TrafficExperimentRequest,
} from "./experiment";
import {
  createTrafficScenarioFromArchive,
  retainedTrafficSpeedPrecision,
} from "./capture";
import type { PreparedTrafficNetwork, TrafficNativePairRequest } from "./types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  calibrated = false,
  ignoredPlanningOverlay = false,
  retainSettings = false,
  unmappedCounts = false,
  exactEndpoints = false,
  commute = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "traffic-compact-"));
  dirs.push(directory);
  const archive = new TrafficArchive(directory),
    place = structuredClone(trafficPlaceFixture),
    project = createProject(place),
    scenario = project.scenarios[1];
  const bytes = Buffer.from(
      "<net>synthetic contract fixture; no simulation</net>",
    ),
    hash = createHash("sha256").update(bytes).digest("hex");
  const network: PreparedTrafficNetwork = {
    network: trafficNetworkFixture(),
    networkXml: bytes,
    files: { "network.net.xml": bytes },
    resources: {
      wallMilliseconds: 1,
      peakMemoryBytes: 1,
      cpuLimit: 1,
      memoryLimitBytes: 2 ** 30,
      outputBytes: 1,
    },
  };
  network.network.manifest.networkFileSha256 = hash;
  const counts = trafficCountFixture();
  counts.counts.forEach((row) => {
    row.mapping!.networkFileSha256 = hash;
    if (unmappedCounts) {
      row.target = null;
      row.vehicleClasses = null;
      delete row.mapping;
    }
  });
  const request: TrafficExperimentRequest = {
    version: 1,
    networkHash: hash,
    countPack: counts,
    demand: trafficDemandFixture(),
    period: { ...trafficFixturePeriod },
    seed: 42,
    overlays: [],
    calibrationPlan: calibrated ? trafficCalibrationFixture() : null,
    unsupportedChanges: [],
  };
  if (retainSettings) request.signalTimings = [];
  if (exactEndpoints)
    request.demand.rows[0].endpoints = {
      departLaneId: "in_0",
      departPositionMeters: 12.25,
      arrivalLaneId: "out_0",
      arrivalPositionMeters: 75.5,
    };
  const commuteDirectory = commute
    ? await mkdtemp(join(tmpdir(), "traffic-commute-source-"))
    : null;
  if (commuteDirectory) dirs.push(commuteDirectory);
  const commutePreset = commuteDirectory
    ? await packagedCommuteFixture(commuteDirectory, network.network)
    : null;
  if (commutePreset) {
    request.demand = commutePreset.preset.demand;
    request.period = commutePreset.prior.recipe.period;
    request.commute = commutePreset.preset.summary.binding;
  }
  if (ignoredPlanningOverlay) {
    const road = place.roads[0];
    scenario.roadEdits[road.id] = { ...road, speedMph: 35 };
    const reviewed = await reviewTrafficPlanningRoads({
      place,
      scenario,
      network: network.network,
      reviews: [
        {
          roadId: road.id,
          properties: ["speed"],
          directions: [{ direction: "with-road", edgeIds: ["in"] }],
          extent: "full-road",
          nativeExtensionAcknowledged: true,
          rationale: "Synthetic test of an ignored native control.",
        },
      ],
      reviewedBy: "fixture-reviewer",
      reviewedAt: "2026-11-06T10:00:00Z",
      sourceDeclarations: [
        {
          sourceId: road.sourceId,
          privateUseConfirmed: true,
          publicRedistribution: false,
          declaredBy: "fixture-reviewer",
          declaredAt: "2026-11-06T10:00:00Z",
        },
      ],
    });
    request.overlays = reviewed.overlays;
    request.planningRoads = reviewed.planningRoads;
  }
  const captured = await runTrafficExperiment(
    network,
    request,
    retainSettings || exactEndpoints || commute
      ? new FixtureRuntime()
      : {
          runPair: async (input: TrafficNativePairRequest) => {
            const recipe = {
                ...trafficRecipeFixture(),
                baselineNetworkHash: hash,
                proposalNetworkHash: hash,
                demandHash: input.demandHash,
                countPackHash: input.countPackHash,
                seed: input.seed,
                period: input.period,
              },
              recipeHash = await trafficPairRecipeHash(recipe);
            const result = (side: "baseline" | "proposal") => ({
              ...trafficResultFixture(side),
              recipeHash,
              networkHash: hash,
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
              trips: input.vehicles.map((v) => ({
                id: v.id,
                requestedDepartSeconds: v.departSeconds,
                arrived: true,
                departSeconds: v.departSeconds,
                arrivalSeconds: v.departSeconds + 40,
                durationSeconds: 40,
                routeLengthMeters: 400,
                waitingSeconds: 0,
                timeLossSeconds: 0,
                departDelaySeconds: 0,
              })),
              predictions: input.counts.map((c) => ({
                countId: c.id,
                vehicles: c.value,
                status: "available" as const,
              })),
            });
            return {
              recipe,
              recipeHash,
              baselineNetwork: network.network,
              proposalNetwork: ignoredPlanningOverlay
                ? {
                    ...network.network,
                    manifest: {
                      ...network.network.manifest,
                      conversion: {
                        ...network.network.manifest.conversion,
                        options: ["--precision", "6"],
                      },
                    },
                  }
                : network.network,
              baseline: result("baseline"),
              proposal: result("proposal"),
              resources: network.resources,
              files: {
                "baseline.net.xml": bytes,
                "baseline-tripinfo.xml": Buffer.from(
                  "<tripinfos>private raw records</tripinfos>",
                ),
              },
              notes: ["Synthetic fixture only."],
            };
          },
        },
  );
  if (commutePreset)
    Object.assign(captured.files, commutePreset.preset.archiveFiles);
  const scope = { organizationId: "org", projectId: project.id },
    publication = await archive.stage(scope, captured.files);
  await publication.settle(true);
  const input = {
    archive,
    reference: publication.reference,
    scope,
    network,
    experiment: captured.capture,
    place,
    scenario,
    receipt: { projectId: project.id, jobId: "job", captureId: "capture" },
  };
  return { input, directory, captured, commutePreset };
}
describe("verified native archive to compact saved traffic evidence", () => {
  it("projects verified complete commute files into a compact adopted summary and rejects altered or omitted ledger assets", async () => {
    const { input, captured, commutePreset } = await fixture(
      false,
      false,
      false,
      false,
      false,
      true,
    );
    const saved = await createTrafficScenarioFromArchive(input);
    expect(saved.capture.originalDemand.commute).toEqual(
      commutePreset!.preset.summary,
    );
    expect(saved.capture.originalDemand.description).toContain(
      "not observed dated OD or total local traffic",
    );
    expect(
      saved.capture.originalDemand.commute!.totals
        .knownUnresolvedSourceVehicles,
    ).toBe(6);
    expect(saved.capture.originalDemand.commute!.coverage.status).toBe(
      "partial",
    );
    expect(saved.capture.originalDemand).not.toHaveProperty("ledger");
    await expect(
      verifyTrafficScenario(saved, input.place),
    ).resolves.toBeUndefined();
    const full = JSON.parse(
      captured.files["commute-compilation.json"].toString(),
    );
    expect(full.ledger).toEqual(commutePreset!.compilation.ledger);
    const changed = {
      ...captured.files,
      "commute-compilation.json": Buffer.from(
        canonicalJSON({ ...full, ledger: full.ledger.slice(1) }),
      ),
    };
    const stage = await input.archive.stage(input.scope, changed);
    await stage.settle(true);
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        reference: stage.reference,
      }),
    ).rejects.toThrow();
    const missing = { ...captured.files };
    delete missing["commute-prior.json"];
    const absent = await input.archive.stage(input.scope, missing);
    await absent.settle(true);
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        reference: absent.reference,
      }),
    ).rejects.toThrow();
  });
  it("requires the exact attachment policy even without optional signal timing controls", async () => {
    const { input, captured } = await fixture(false, false, false, false, true);
    expect(captured.capture.request.signalTimings).toBeUndefined();
    const saved = await createTrafficScenarioFromArchive(input);
    expect(saved.capture.runs.baseline.diagnostics.requested).toBe(7);
    const settings = JSON.parse(
      captured.files["native-settings.json"].toString(),
    );
    expect(settings.endpointPolicy).toBe(
      "explicit-native-lanes-and-front-positions",
    );
    delete settings.endpointPolicy;
    const altered = await input.archive.stage(input.scope, {
      ...captured.files,
      "native-settings.json": Buffer.from(canonicalJSON(settings)),
    });
    await altered.settle(true);
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        reference: altered.reference,
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_CAPTURE_IDENTITY" });
  });
  it("verifies a retained settings preimage even when an optional timing field is maliciously omitted", async () => {
    const { input, captured } = await fixture(false, false, true);
    const saved = await createTrafficScenarioFromArchive(input);
    expect(saved.capture.proposal.signalTimings).toEqual([]);
    delete captured.capture.request.signalTimings;
    captured.capture.requestHash = await trafficContentHash(
      captured.capture.request,
    );
    const files = {
      ...captured.files,
      "experiment.json": Buffer.from(canonicalJSON(captured.capture)),
    };
    const changed = await input.archive.stage(input.scope, files);
    await changed.settle(true);
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        reference: changed.reference,
        experiment: captured.capture,
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_CAPTURE_IDENTITY" });
  });
  it("rejects an altered settings preimage even when the request and native graphs are unchanged", async () => {
    const { input, captured } = await fixture(false, false, true);
    const settings = JSON.parse(
      captured.files["native-settings.json"].toString(),
    );
    settings.stepSeconds = 2;
    const changed = await input.archive.stage(input.scope, {
      ...captured.files,
      "native-settings.json": Buffer.from(canonicalJSON(settings)),
    });
    await changed.settle(true);
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        reference: changed.reference,
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_CAPTURE_IDENTITY" });
  });

  it("uses retained converter precision for new independent controls as well as planning-derived runs", () => {
    const network = trafficNetworkFixture();
    expect(retainedTrafficSpeedPrecision(network)).toBe(2);
    expect(() => retainedTrafficSpeedPrecision(network, true)).toThrow(
      /does not match/,
    );
    network.manifest.conversion.options = ["--precision", "6"];
    expect(retainedTrafficSpeedPrecision(network)).toBe(6);
    expect(retainedTrafficSpeedPrecision(network, true)).toBe(6);
    network.manifest.conversion.options = ["--precision=6", "--precision", "2"];
    expect(retainedTrafficSpeedPrecision(network)).toBe(2);
    expect(() => retainedTrafficSpeedPrecision(network, true)).toThrow();
    network.manifest.conversion.options = ["--precision", "4"];
    expect(() => retainedTrafficSpeedPrecision(network)).toThrow();
    network.manifest.conversion.options = ["--precision"];
    expect(() => retainedTrafficSpeedPrecision(network)).toThrow();
  });

  it("rejects a hash-consistent native archive that ignored a reviewed planning control", async () => {
    const { input } = await fixture(false, true);
    await expect(createTrafficScenarioFromArchive(input)).rejects.toMatchObject(
      { code: "TRAFFIC_OVERLAY_EFFECT" },
    );
  });

  it("retains exact summaries, null calibration, source namespaces and unmapped edits without copying private native rows", async () => {
    const { input } = await fixture();
    input.scenario.roadEdits["planning-road"] = {
      ...input.place.roads[0],
      speedMph: 20,
    };
    const saved = await createTrafficScenarioFromArchive(input);
    await verifyTrafficScenario(saved, input.place);
    expect(saved.origin).toBe("server-run");
    expect(saved.capture.calibration).toBeNull();
    expect(saved.capture.comparison).toEqual(input.experiment.comparison);
    expect(saved.capture.runs.baseline.diagnostics).toEqual(
      input.experiment.baseline.diagnostics,
    );
    expect(saved.capture.sources).toEqual(input.experiment.sources);
    expect(saved.capture.proposal.planningRoadMapping).toMatchObject({
      status: "unmapped",
      reviewedLinks: [],
      unrepresentedRoadIds: ["planning-road"],
    });
    expect(saved.capture.privateArchive).toEqual(input.reference);
    expect(saved.capture.files).toHaveLength(input.reference.fileCount);
    expect(
      saved.capture.files.every((file) =>
        file.url.startsWith("urn:urban:traffic:archive:"),
      ),
    ).toBe(true);
    const raw = JSON.stringify(saved);
    expect(raw).not.toContain("private raw records");
    expect(raw).not.toContain('"trips":');
    expect(raw).not.toContain('"nodes":');
    expect(raw).not.toContain('"edges":[');
    expect(raw.length).toBeLessThan(20000);
  });
  it("keeps baseline-only calibration and independent holdout exactly without fabricating proposal calibration", async () => {
    const { input } = await fixture(true),
      saved = await createTrafficScenarioFromArchive(input);
    expect(saved.capture.calibration?.calibration).toEqual(
      input.experiment.calibration!.calibration,
    );
    expect(saved.capture.calibration?.holdout).toEqual(
      input.experiment.calibration!.holdout,
    );
    expect(saved.capture.calibration?.criteria).toEqual(
      input.experiment.request.calibrationPlan!.criteria,
    );
    expect(saved.capture.calibration?.criteriaSourceIds).toEqual(
      input.experiment.request.calibrationPlan!.sourceIds,
    );
  });
  it("verifies and compacts an archived incomplete plan selecting unmapped class-unresolved observations", async () => {
    const { input } = await fixture(true, false, true, true),
      saved = await createTrafficScenarioFromArchive(input);
    expect(saved.capture.countEvidence).toMatchObject({
      mappedCountCount: 0,
      unmappedCountCount: 2,
    });
    expect(saved.capture.calibration).toMatchObject({
      status: "incomplete",
      calibration: {
        requested: 1,
        evaluated: 0,
        unavailable: 1,
        passed: 0,
        passingFraction: null,
        status: "incomplete",
      },
      holdout: {
        requested: 1,
        evaluated: 0,
        unavailable: 1,
        passed: 0,
        passingFraction: null,
        status: "incomplete",
      },
    });
    expect(saved.capture.calibration?.calibration).toEqual(
      input.experiment.calibration!.calibration,
    );
    expect(saved.capture.calibration?.holdout).toEqual(
      input.experiment.calibration!.holdout,
    );
    await expect(
      verifyTrafficScenario(saved, input.place),
    ).resolves.toBeUndefined();
  });
  it("rejects cross-project scope, changed supplied experiment and mismatched prepared native bytes", async () => {
    const { input } = await fixture();
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        scope: { ...input.scope, projectId: "other" },
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_CAPTURE_IDENTITY" });
    const changed = structuredClone(input.experiment);
    changed.comparison.baseline.meanTravelTimeSeconds = 999;
    await expect(
      createTrafficScenarioFromArchive({ ...input, experiment: changed }),
    ).rejects.toMatchObject({ code: "TRAFFIC_CAPTURE_IDENTITY" });
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        network: { ...input.network, networkXml: Buffer.from("other") },
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_CAPTURE_IDENTITY" });
  });
  it("checks every archived byte, including private files not copied into the compact result", async () => {
    const { input, directory } = await fixture();
    await writeFile(
      join(
        directory,
        `bundle-${input.reference.sha256}`,
        "baseline-tripinfo.xml",
      ),
      "corrupt",
    );
    await expect(createTrafficScenarioFromArchive(input)).rejects.toMatchObject(
      { code: "TRAFFIC_ARCHIVE_UNAVAILABLE" },
    );
  });
  it("rejects internally inconsistent summaries even when the altered archive is self-consistently rehashed", async () => {
    const { input, captured } = await fixture();
    captured.capture.comparison.baseline.meanTravelTimeSeconds = 999;
    const publication = await input.archive.stage(input.scope, {
      ...captured.files,
      "experiment.json": Buffer.from(canonicalJSON(captured.capture)),
    });
    await publication.settle(true);
    await expect(
      createTrafficScenarioFromArchive({
        ...input,
        experiment: captured.capture,
        reference: publication.reference,
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_CAPTURE_IDENTITY" });
  });
});
