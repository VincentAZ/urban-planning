import { recordBudgetAdjustment } from "../budget.js";
import {
  enableReviewedBudgetForFixture,
  reviewBudgetForFixture,
} from "../budget-test-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyCommand,
  projectWithTrafficVersion,
  trafficContentHash,
  type Source,
} from "@urban/core";
import { createProject } from "@urban/models";
import { trafficPlaceFixture } from "../../../../tests/fixtures/traffic";
import {
  trafficNetworkFixture,
  trafficCountFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
  trafficFixtureSource,
  trafficCalibrationFixture,
} from "../../../../packages/core/src/traffic-fixture";
import { FileStore, authorize, type DataState } from "../store";
import { ApiError } from "../errors";
import { acquireNativeCapacity } from "../native-capacity";
import { TrafficJobService } from "./jobs";
import { FixtureRuntime } from "./job-fixture";
import type { TrafficConfigurationSubmission } from "./source-review";
import type { TrafficExperimentRequest } from "./experiment";
import type { PreparedTrafficNetwork } from "./types";
import type { TrafficPreparedIdentity } from "./jobs-types";
import { packagedCommuteFixture } from "./commute-evidence-fixture";
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "traffic-jobs-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"),
    store = new FileStore(file);
  clean.push(() => store.close());
  const place = structuredClone(trafficPlaceFixture),
    project = createProject(place),
    now = new Date().toISOString(),
    sessionHash = "session-fixture";
  await store.transaction((s) => {
    s.users.push({
      id: "owner",
      email: "owner@example.test",
      name: "Owner",
      createdAt: now,
    });
    s.organizations.push({
      id: "org",
      name: "Fixture workspace",
      createdAt: now,
    });
    s.memberships.push({
      userId: "owner",
      organizationId: "org",
      role: "owner",
    });
    s.sessions.push({
      hash: sessionHash,
      userId: "owner",
      organizationId: "org",
      csrfToken: "csrf-fixture",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    s.projects.push({
      organizationId: "org",
      project,
      version: 1,
      baseline: place,
      createdBy: "owner",
      createdAt: now,
    });
    enableReviewedBudgetForFixture(s.budget);
  });
  const runtime = new FixtureRuntime(),
    bytes = Buffer.from("<net>synthetic fixture</net>"),
    network: PreparedTrafficNetwork = {
      network: structuredClone(trafficNetworkFixture()),
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
  network.network.manifest.networkFileSha256 = hash(bytes);
  network.network.manifest.sources[0].kind = "observed";
  const counts = structuredClone(trafficCountFixture());
  counts.sources[0].kind = "observed";
  for (const c of counts.counts) {
    c.target = null;
    delete c.mapping;
  }
  const demand = structuredClone(trafficDemandFixture()),
    source: Source = {
      ...trafficFixtureSource,
      id: "authored-demand",
      kind: "user-supplied",
    };
  demand.sources = [source];
  demand.rows.forEach((r) => (r.sourceIds = [source.id]));
  demand.candidateRoutes.forEach((r) => (r.sourceIds = [source.id]));
  const original: TrafficExperimentRequest = {
    version: 1,
    networkHash: network.network.manifest.networkFileSha256,
    countPack: counts,
    demand,
    period: { ...trafficFixturePeriod },
    seed: 42,
    overlays: [],
    calibrationPlan: null,
    unsupportedChanges: [],
  };
  const identity: TrafficPreparedIdentity = {
    id: "prepared",
    placeId: place.id,
    studyAreaHash: "a".repeat(64),
    networkHash: original.networkHash,
    inventoryHash: await trafficContentHash(network.network),
    sourceEnvelope: [-113, 32, -111, 34],
    bufferMeters: 1000,
    methodVersion: "1.0.0",
    workerHash: hash(runtime.worker),
  };
  const options = {
    enabled: true,
    archiveDirectory: join(dir, "archive"),
    automaticWorker: false,
    catalog: {
      forPlace: async () => ({
        network,
        identity,
        pack: counts,
        entry: {
          ...identity,
          networkDirectory: "synthetic",
          initialPeriod: original.period,
        },
      }),
      initialRequest: async () => structuredClone(original),
    },
    runtime,
    capacity: {
      mode: "fixed-capacity" as const,
      environment: "local-development" as const,
      statement:
        "Existing isolated local fixture capacity; not a production cost claim.",
    },
  };
  const service = new TrafficJobService(store, options);
  clean.push(() => service.close());
  const auth = (s: DataState) => authorize(s, sessionHash);
  const input: TrafficConfigurationSubmission = {
    scenarioId: project.activeScenarioId,
    expectedVersion: 1,
    expectedRevision: 0,
    expectedConfigurationId: null,
    idempotencyKey: "configuration-request-1",
    request: structuredClone(original),
    sourceDeclarations: [
      {
        sourceId: source.id,
        name: source.name,
        url: source.url,
        vintage: source.vintage,
        license: source.license,
        privateUseConfirmed: true,
        publicRedistribution: false,
      },
    ],
    uploadBindings: [],
    mappingReviews: [],
    scopeAcknowledged: true,
  };
  const save = () =>
    service.saveConfiguration(project.id, input, auth, sessionHash);
  const enqueue = async () => {
    const config = await save();
    return service.enqueue(
      project.id,
      {
        configurationId: config.id,
        expectedVersion: 1,
        expectedRevision: 0,
        idempotencyKey: "run-request-1",
      },
      auth,
      sessionHash,
    );
  };
  return {
    dir,
    file,
    store,
    place,
    project,
    runtime,
    identity,
    service,
    options,
    auth,
    sessionHash,
    input,
    save,
    enqueue,
  };
}
describe("durable traffic configuration and native-job lifecycle", () => {
  it("retains exact prepared commute authority and every loss row through queued execution and archive capture", async () => {
    const f = await setup();
    const prepared = await f.options.catalog.forPlace();
    const commute = await packagedCommuteFixture(
      join(f.dir, "commute"),
      prepared.network.network,
    );
    const selected: (string | undefined)[] = [];
    f.service.options.catalog = {
      ...f.options.catalog,
      forPlace: async (_place, id) => {
        selected.push(id);
        if (id !== undefined && id !== f.identity.id)
          throw new Error("Wrong selected graph");
        return prepared;
      },
      commutePresets: async (_place, id) => {
        expect(id).toBe(f.identity.id);
        return [await commute.load()];
      },
    };
    f.input.preparedId = f.identity.id;
    const request = f.input.request as TrafficExperimentRequest;
    request.commute = commute.preset.summary.binding;
    request.demand = commute.preset.demand;
    request.period = commute.prior.recipe.period;
    f.input.sourceDeclarations = [];
    const job = await f.enqueue();
    expect(f.runtime.calls).toBe(0);
    await f.service.runOne();
    const completed = await f.store.read(
      (s) => s.trafficJobs.find((j) => j.id === job.id)!,
    );
    expect(completed.error).toBeUndefined();
    expect(completed.status).toBe("completed");
    const artifact = await f.store.read((s) => s.trafficArtifacts[0]);
    expect(artifact.traffic.capture.originalDemand.commute).toEqual(
      commute.preset.summary,
    );
    const raw = await f.service.archive.read(
      completed,
      completed.result!.archive,
      "commute-compilation.json",
    );
    expect(JSON.parse(raw.toString()).ledger).toEqual(
      commute.compilation.ledger,
    );
    expect(selected.every((id) => id === f.identity.id)).toBe(true);
    expect(f.runtime.calls).toBe(1);
  });
  it("rejects a missing frozen commute dependency before native execution", async () => {
    const f = await setup(),
      prepared = await f.options.catalog.forPlace();
    const commute = await packagedCommuteFixture(
      join(f.dir, "commute"),
      prepared.network.network,
    );
    let available = true;
    f.service.options.catalog = {
      ...f.options.catalog,
      commutePresets: async () => (available ? [commute.preset] : []),
    };
    const request = f.input.request as TrafficExperimentRequest;
    request.commute = commute.preset.summary.binding;
    request.demand = commute.preset.demand;
    request.period = commute.prior.recipe.period;
    f.input.sourceDeclarations = [];
    const job = await f.enqueue();
    available = false;
    await f.service.runOne();
    expect(f.runtime.calls).toBe(0);
    expect(
      (await f.store.read((s) => s.trafficJobs.find((j) => j.id === job.id)!))
        .status,
    ).toBe("failed");
    expect(await f.store.read((s) => s.trafficArtifacts)).toEqual([]);
  });
  it("rejects invalid count-check selections before storing a configuration or consuming native capacity, then permits an explicit repair", async () => {
    const f = await setup(),
      request = f.input.request as TrafficExperimentRequest;
    request.calibrationPlan = {
      ...trafficCalibrationFixture(),
      holdoutCountIds: ["count-0"],
    };
    const before = await f.store.read((s) => ({
      audit: s.audit,
      budget: s.budget,
      capacity: s.nativeCapacity,
    }));
    await expect(f.save()).rejects.toMatchObject({
      statusCode: 422,
      code: "TRAFFIC_CALIBRATION_SELECTION",
    });
    const rejected = await f.store.read((s) => s);
    expect(rejected.trafficConfigs).toEqual([]);
    expect(rejected.trafficJobs).toEqual([]);
    expect(rejected.trafficArtifacts).toEqual([]);
    expect(rejected.audit).toEqual(before.audit);
    expect(rejected.budget).toEqual(before.budget);
    expect(rejected.nativeCapacity).toEqual(before.capacity);
    expect(f.runtime.calls).toBe(0);
    expect(await readdir(join(f.dir, "archive")).catch(() => [])).toEqual([]);

    request.calibrationPlan = trafficCalibrationFixture();
    const admitted = await f.save();
    expect(admitted.request.calibrationPlan).toEqual(request.calibrationPlan);
    expect(
      (await f.store.read((s) => s.trafficConfigs)).map((c) => c.id),
    ).toEqual([admitted.id]);
    expect(f.runtime.calls).toBe(0);
  });

  it("reauthorizes after native completion and never publishes a result after the requester loses edit access", async () => {
    const f = await setup();
    await f.enqueue();
    f.runtime.onRun = async () => {
      await f.store.transaction((s) => {
        s.memberships[0].role = "viewer";
      });
    };
    await f.service.runOne();
    const state = await f.store.read((s) => s);
    expect(state.trafficJobs[0].status).toBe("failed");
    expect(["TRAFFIC_CANCELLED", "TRAFFIC_FAILED"]).toContain(
      state.trafficJobs[0].error?.code,
    );
    expect(state.trafficArtifacts).toEqual([]);
    expect(state.nativeCapacity.slot).toBeNull();
    expect(f.runtime.calls).toBe(1);
  });
  it("completes and reopens exact incomplete count-check evidence instead of failing during archive capture", async () => {
    const f = await setup();
    (f.input.request as TrafficExperimentRequest).calibrationPlan =
      trafficCalibrationFixture();
    const queued = await f.enqueue();
    await f.service.runOne();
    const state = await f.store.read((s) => s),
      job = state.trafficJobs.find((j) => j.id === queued.id)!;
    expect(job.status, JSON.stringify(job.error)).toBe("completed");
    expect(f.runtime.calls).toBe(1);
    expect(state.nativeCapacity.slot).toBeNull();
    expect(state.trafficArtifacts).toHaveLength(1);
    const traffic = state.trafficArtifacts[0].traffic;
    expect(traffic.capture.calibration).toMatchObject({
      status: "incomplete",
      calibration: {
        requested: 1,
        evaluated: 0,
        unavailable: 1,
        status: "incomplete",
      },
      holdout: {
        requested: 1,
        evaluated: 0,
        unavailable: 1,
        status: "incomplete",
      },
    });
    expect(traffic.capture.countEvidence).toMatchObject({
      mappedCountCount: 0,
      unmappedCountCount: 2,
    });
    await f.service.archive.verify(
      { organizationId: "org", projectId: f.project.id },
      job.result!.archive,
    );
    await f.store.close();
    const reopened = new FileStore(f.file);
    clean.push(() => reopened.close());
    expect(await reopened.read((s) => s.trafficArtifacts[0].traffic)).toEqual(
      traffic,
    );
  });
  it("checks the latest configuration again after asynchronous admission and rejects a collaborator's superseded input", async () => {
    const f = await setup(),
      first = await f.save();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      arrived = new Promise<void>((r) => (entered = r)),
      original = f.options.catalog.forPlace;
    let calls = 0;
    f.options.catalog.forPlace = async () => {
      if (++calls === 1) {
        entered();
        await held;
      }
      return original();
    };
    const pending = f.service.enqueue(
      f.project.id,
      {
        configurationId: first.id,
        expectedVersion: 1,
        expectedRevision: 0,
        idempotencyKey: "racing-run",
      },
      f.auth,
      f.sessionHash,
    );
    await arrived;
    f.input.idempotencyKey = "new-configuration";
    f.input.expectedConfigurationId = first.id;
    (f.input.request as TrafficExperimentRequest).seed = 5;
    await f.save();
    release();
    await expect(pending).rejects.toMatchObject({
      code: "TRAFFIC_CONFIGURATION_CHANGED",
    });
    expect(await f.store.read((s) => s.trafficJobs)).toEqual([]);
    expect(f.runtime.calls).toBe(0);
  });
  it("rejects new jobs under paused or exhausted budget policy without writing a queue or attempt", async () => {
    const f = await setup();
    await f.save();
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    await expect(f.enqueue()).rejects.toMatchObject({
      code: "TRAFFIC_CAPACITY_PAUSED",
    });
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
      s.budget.policy.monthlyLimitCents = 0;
      s.budget.policy.safetyMarginCents = 0;
    });
    await expect(f.enqueue()).rejects.toMatchObject({
      code: "TRAFFIC_BUDGET_EXHAUSTED",
    });
    expect(await f.store.read((s) => s.trafficJobs)).toEqual([]);
    expect(f.runtime.calls).toBe(0);
  });
  it("saves reviewed inputs idempotently, runs exactly once and retains exact compact authority/archive through SQLite reopen", async () => {
    const f = await setup(),
      config = await f.save();
    expect((await f.save()).id).toBe(config.id);
    const first = await f.enqueue();
    expect((await f.enqueue()).id).toBe(first.id);
    expect(f.runtime.calls).toBe(0);
    await f.service.runOne();
    await f.service.runOne();
    expect(f.runtime.calls).toBe(1);
    const state = await f.store.read((s) => s);
    const job = state.trafficJobs[0];
    expect(job.status, JSON.stringify(job.error)).toBe("completed");
    expect(job.attempt).toBe(1);
    expect(job.attempts[0].outcome).toBe("completed");
    expect(state.nativeCapacity.slot).toBeNull();
    expect(state.trafficArtifacts).toHaveLength(1);
    const traffic = state.trafficArtifacts[0].traffic;
    expect(traffic.origin).toBe("server-run");
    expect(traffic.capture.calibration).toBeNull();
    expect(traffic.capture.comparison.baseline.meanTravelTimeSeconds).toBe(40);
    expect(traffic.capture.runs.baseline.diagnostics.requested).toBe(7);
    expect(job.result!.captureHash).toBe(traffic.captureHash);
    await f.service.archive.verify(
      { organizationId: "org", projectId: f.project.id },
      job.result!.archive,
    );
    await f.store.close();
    const reopened = new FileStore(f.file);
    clean.push(() => reopened.close());
    expect(await reopened.read((s) => s.trafficArtifacts[0].traffic)).toEqual(
      traffic,
    );
  });
  it("rejects stale request versions and changed planning roads while preserving exact configuration idempotency", async () => {
    const f = await setup(),
      config = await f.save();
    (f.input.request as TrafficExperimentRequest).seed = 99;
    await expect(f.save()).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    f.input.idempotencyKey = "configuration-request-2";
    await expect(f.save()).rejects.toMatchObject({
      code: "TRAFFIC_CONFIGURATION_CHANGED",
    });
    f.input.expectedConfigurationId = config.id;
    f.input.expectedRevision = 1;
    await expect(f.save()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await f.store.transaction((s) => s.projects[0].version++);
    await expect(
      f.service.enqueue(
        f.project.id,
        {
          configurationId: config.id,
          expectedVersion: 1,
          expectedRevision: 0,
          idempotencyKey: "stale-request-key",
        },
        f.auth,
        f.sessionHash,
      ),
    ).rejects.toMatchObject({ code: "TRAFFIC_CONFIGURATION_STALE" });
    await f.store.transaction((state) => {
      const record = state.projects[0];
      const scenario = record.project.scenarios[1];
      record.project.scenarios[1] = applyCommand(scenario, {
        type: "road.upsert",
        road: { ...record.baseline.roads[0], speedMph: 15 },
      });
      record.version++;
    });
    await expect(
      f.service.enqueue(
        f.project.id,
        {
          configurationId: config.id,
          expectedVersion: 3,
          expectedRevision: 1,
          idempotencyKey: "new-run-key",
        },
        f.auth,
        f.sessionHash,
      ),
    ).rejects.toMatchObject({ code: "TRAFFIC_CONFIGURATION_STALE" });
    expect(f.runtime.calls).toBe(0);
  });
  it("can rerun an unchanged explicit experiment after adoption advances the saved project revision", async () => {
    const f = await setup();
    const config = await f.save();
    await f.enqueue();
    await f.service.runOne();
    await f.store.transaction((state) => {
      const record = state.projects[0];
      record.project.scenarios[1] = applyCommand(record.project.scenarios[1], {
        type: "scenario.traffic",
        traffic: state.trafficArtifacts[0].traffic,
      });
      record.project = projectWithTrafficVersion(
        record.project,
        record.baseline,
      );
      record.version++;
    });
    const next = await f.service.enqueue(
      f.project.id,
      {
        configurationId: config.id,
        expectedVersion: 2,
        expectedRevision: 1,
        idempotencyKey: "rerun-after-adoption",
      },
      f.auth,
      f.sessionHash,
    );
    expect(next.status).toBe("queued");
    const state = await f.store.read((s) => s);
    expect(state.trafficConfigs[0].projectVersion).toBe(1);
    expect(state.trafficConfigs[0].scenarioRevision).toBe(0);
    expect(state.trafficJobs.at(-1)?.projectVersion).toBe(2);
    expect(state.trafficJobs.at(-1)?.scenarioRevision).toBe(1);
    expect(state.trafficJobs.at(-1)?.roadEditsHash).toBe(config.roadEditsHash);
    expect(f.runtime.calls).toBe(1);
  });
  it("rechecks budget and creator permission before consuming native capacity or an attempt", async () => {
    const f = await setup();
    await f.enqueue();
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    await f.service.runOne();
    expect(
      await f.store.read((s) => ({
        status: s.trafficJobs[0].status,
        attempt: s.trafficJobs[0].attempt,
        slot: s.nativeCapacity.slot,
      })),
    ).toEqual({ status: "queued", attempt: 0, slot: null });
    expect(f.runtime.calls).toBe(0);
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
      s.memberships[0].role = "viewer";
    });
    await f.service.runOne();
    const job = await f.store.read((s) => s.trafficJobs[0]);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("TRAFFIC_REQUESTER_REVOKED");
    expect(job.attempt).toBe(0);
    expect(f.runtime.calls).toBe(0);
  });
  it("leaves queued work and attempt counts unchanged while another native service holds the shared slot", async () => {
    const f = await setup();
    await f.enqueue();
    await f.store.transaction((s) => {
      acquireNativeCapacity(s, {
        kind: "gis",
        jobId: "other-native-job",
        workerId: "other-worker",
        runMilliseconds: 60000,
      });
    });
    await f.service.runOne();
    expect(
      await f.store.read((s) => ({
        status: s.trafficJobs[0].status,
        attempt: s.trafficJobs[0].attempt,
        kind: s.nativeCapacity.slot?.kind,
      })),
    ).toEqual({ status: "queued", attempt: 0, kind: "gis" });
    expect(f.runtime.calls).toBe(0);
  });
  it("cancels running work without publishing an artifact, then explicitly retries with the original inputs and retained attempt ledger", async () => {
    const f = await setup();
    const job = await f.enqueue();
    f.runtime.onRun = async () => {
      for (let i = 0; i < 3; i++) {
        const current = await f.store.read((s) => s.trafficJobs[0]);
        try {
          await f.service.cancel(
            f.project.id,
            job.id,
            current.version,
            f.auth,
            f.sessionHash,
          );
          return;
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== "TRAFFIC_JOB_CHANGED")
            throw e;
        }
      }
      throw new Error("Cancellation could not obtain a current job version.");
    };
    await f.service.runOne();
    let current = await f.store.read((s) => s.trafficJobs[0]);
    expect(current.status, JSON.stringify(current.error)).toBe("cancelled");
    expect(current.attempt).toBe(1);
    expect(await f.store.read((s) => s.trafficArtifacts)).toEqual([]);
    expect(await f.store.read((s) => s.nativeCapacity.slot)).toBeNull();
    f.runtime.onRun = undefined;
    const queued = await f.service.retry(
      f.project.id,
      job.id,
      current.version,
      "explicit-retry-1",
      f.auth,
      f.sessionHash,
    );
    expect(queued.attempt).toBe(1);
    await f.service.runOne();
    current = await f.store.read((s) => s.trafficJobs[0]);
    expect(current.status, JSON.stringify(current.error)).toBe("completed");
    expect(current.attempts.map((a) => a.outcome)).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(f.runtime.calls).toBe(2);
  });
  it("rejects changed prepared worker identity before native execution and preserves failure as a consumed attempt", async () => {
    const f = await setup();
    await f.enqueue();
    f.identity.workerHash = "f".repeat(64);
    await f.service.runOne();
    const job = await f.store.read((s) => s.trafficJobs[0]);
    expect(job.error?.code).toBe("TRAFFIC_SOURCE_CHANGED");
    expect(job.error?.retryable).toBe(false);
    expect(job.attempt).toBe(1);
    expect(f.runtime.calls).toBe(0);
    expect(await f.store.read((s) => s.trafficArtifacts)).toEqual([]);
  });
  it("quarantines unconfirmed native cleanup and does not admit a subsequent attempt automatically", async () => {
    const f = await setup();
    const posted = await f.enqueue();
    f.runtime.error = new ApiError(
      503,
      "NATIVE_CLEANUP_UNCONFIRMED",
      "Synthetic fixture could not confirm container stop.",
    );
    await f.service.runOne();
    const state = await f.store.read((s) => s);
    expect(state.trafficJobs[0].status).toBe("failed");
    expect(state.nativeCapacity.slot?.status).toBe("quarantined");
    expect(state.trafficArtifacts).toEqual([]);
    f.runtime.error = undefined;
    await f.service.retry(
      f.project.id,
      posted.id,
      state.trafficJobs[0].version,
      "retry-after-failure",
      f.auth,
      f.sessionHash,
    );
    await f.service.runOne();
    expect(await f.store.read((s) => s.trafficJobs[0].attempt)).toBe(1);
    expect(f.runtime.calls).toBe(1);
    expect(
      (await readdir(join(f.dir, "archive"))).filter((n) =>
        n.startsWith("bundle-"),
      ),
    ).toHaveLength(0);
  });
});

describe("cost evidence before native dispatch", () => {
  it("keeps queued work idle after a manual cost change until an explicit fresh review", async () => {
    const f = await setup();
    await f.save();
    await f.enqueue();
    await f.store.transaction((s) =>
      recordBudgetAdjustment(
        s.budget,
        {
          idempotencyKey: "unreviewed-fixture-charge",
          amountCents: 100,
          category: "variable",
          reason: "New external fixture cost requires an explicit cost review",
        },
        "fixture-budget-admin",
      ),
    );
    await f.service.runOne();
    expect(f.runtime.calls).toBe(0);
    expect(
      await f.store.read((s) => ({
        status: s.trafficJobs[0].status,
        attempt: s.trafficJobs[0].attempt,
        slot: s.nativeCapacity.slot,
      })),
    ).toEqual({ status: "queued", attempt: 0, slot: null });
    await f.store.transaction((s) => reviewBudgetForFixture(s.budget));
    await f.service.runOne();
    expect(f.runtime.calls).toBe(1);
  });
});
