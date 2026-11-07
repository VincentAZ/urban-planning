import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countsFromCSV, parseTrafficCSV, type Source } from "@urban/core";
import {
  trafficNetworkFixture,
  trafficCountFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
  trafficFixtureSource,
  trafficCalibrationFixture,
} from "../../../../packages/core/src/traffic-fixture";
import { createProject } from "@urban/models";
import { trafficPlaceFixture } from "../../../../tests/fixtures/traffic";
import { TrafficArchive } from "./archive";
import {
  reviewTrafficSubmission,
  type TrafficConfigurationSubmission,
} from "./source-review";
import type { TrafficExperimentRequest } from "./experiment";
import type {
  TrafficConfigurationRecord,
  TrafficUploadRecord,
} from "./jobs-types";
import { packagedCommuteFixture } from "./commute-evidence-fixture";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const declaration = (s: Source) => ({
  sourceId: s.id,
  name: s.name,
  url: s.url,
  vintage: s.vintage,
  license: s.license,
  privateUseConfirmed: true as const,
  publicRedistribution: false,
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "traffic-review-"));
  dirs.push(dir);
  const network = structuredClone(trafficNetworkFixture());
  network.manifest.sources[0].kind = "observed";
  const countPack = structuredClone(trafficCountFixture());
  countPack.sources[0].kind = "observed";
  for (const c of countPack.counts) {
    c.target = null;
    delete c.mapping;
    c.notes = ["Synthetic provider quality restriction retained."];
  }
  const demand = structuredClone(trafficDemandFixture()),
    source: Source = {
      ...trafficFixtureSource,
      id: "entered-demand",
      kind: "user-supplied",
    };
  demand.sources = [source];
  demand.rows.forEach((r) => (r.sourceIds = [source.id]));
  demand.candidateRoutes.forEach((r) => (r.sourceIds = [source.id]));
  const original: TrafficExperimentRequest = {
    version: 1,
    networkHash: network.manifest.networkFileSha256,
    countPack,
    demand,
    period: { ...trafficFixturePeriod },
    seed: 42,
    overlays: [],
    calibrationPlan: null,
    unsupportedChanges: [],
  };
  const place = structuredClone(trafficPlaceFixture),
    scenario = createProject(place).scenarios[1];
  const context = {
    place,
    scenario,
    organizationId: "org",
    projectId: "project",
    userId: "actor",
    now: "2026-11-06T10:00:00Z",
    network,
    original,
    previous: null as TrafficConfigurationRecord | null,
    uploads: [] as TrafficUploadRecord[],
    archive: new TrafficArchive(dir),
  };
  const input: TrafficConfigurationSubmission = {
    scenarioId: "option",
    expectedVersion: 1,
    expectedRevision: 0,
    expectedConfigurationId: null,
    idempotencyKey: "test-key-123",
    request: structuredClone(original),
    sourceDeclarations: [declaration(source)],
    uploadBindings: [],
    mappingReviews: [],
    scopeAcknowledged: true,
  };
  return { input, context, request: input.request as TrafficExperimentRequest };
}
function prior(
  f: Awaited<ReturnType<typeof fixture>>,
  result: Awaited<ReturnType<typeof reviewTrafficSubmission>>,
): TrafficConfigurationRecord {
  return {
    id: "configuration",
    organizationId: f.context.organizationId,
    projectId: f.context.projectId,
    scenarioId: "option",
    userId: "actor",
    createdAt: f.context.now,
    projectVersion: 1,
    scenarioRevision: 0,
    baselineHash: "a".repeat(64),
    roadEditsHash: "b".repeat(64),
    prepared: {
      id: "prepared",
      placeId: "place",
      studyAreaHash: "a".repeat(64),
      networkHash: f.context.network.manifest.networkFileSha256,
      inventoryHash: "b".repeat(64),
      sourceEnvelope: [-113, 32, -111, 34],
      bufferMeters: 1000,
      methodVersion: "1",
      workerHash: "c".repeat(64),
    },
    request: result.request,
    requestHash: "d".repeat(64),
    submissionHash: "e".repeat(64),
    uploadIds: result.uploadBindings.map((b) => b.uploadId),
    uploadBindings: result.uploadBindings,
    idempotencyKey: "test-key-123",
    scopeAcknowledged: true,
  };
}
async function upload(f: Awaited<ReturnType<typeof fixture>>) {
  const raw = Buffer.from("station,count\nA,0\nB,\n"),
    source = { ...trafficFixtureSource, id: "upload-source" },
    period = { ...trafficFixturePeriod, date: "2026-01-11" };
  const staged = await f.context.archive.stage(f.context, {
    "counts.csv": raw,
  });
  await staged.settle(true);
  const record: TrafficUploadRecord = {
    id: "upload",
    organizationId: "org",
    projectId: "project",
    userId: "actor",
    createdAt: f.context.now,
    filename: "counts.csv",
    sourceId: source.id,
    sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: raw.length,
    rows: 2,
    idempotencyKey: "upload-key",
    archive: staged.reference,
  };
  f.context.uploads.push(record);
  const binding = {
    uploadId: record.id,
    sourceId: source.id,
    mapping: { station: 0, value: 1 },
    useAnalysisPeriod: true,
    kind: "observed" as const,
    batchId: "csv-batch",
    period,
  };
  f.input.uploadBindings.push(binding);
  f.input.sourceDeclarations.push(declaration(source));
  f.request.countPack.sources.push(source);
  f.request.countPack.counts.push(
    ...countsFromCSV(
      parseTrafficCSV(raw.toString()),
      binding.mapping,
      period,
      source.id,
      true,
      "observed",
      binding.batchId,
    ),
  );
  return { record, binding, raw };
}
describe("traffic source rights, original-byte lineage and reviewed count mapping", () => {
  it("accepts only server-prepared exact commute values and keeps explicit detached copies authored", async () => {
    const f = await fixture(),
      directory = await mkdtemp(join(tmpdir(), "traffic-commute-review-"));
    dirs.push(directory);
    const c = await packagedCommuteFixture(directory, f.context.network);
    f.request.demand = structuredClone(c.preset.demand);
    f.request.period = structuredClone(c.prior.recipe.period);
    f.request.commute = structuredClone(c.preset.summary.binding);
    f.input.sourceDeclarations = [];
    const context = { ...f.context, commutePresets: [c.preset] };
    const admitted = await reviewTrafficSubmission(f.input, context);
    expect(admitted.request.commute).toEqual(c.preset.summary.binding);
    expect(admitted.request.demand).toEqual(c.preset.demand);
    f.request.demand.rows[0].vehicles++;
    await expect(reviewTrafficSubmission(f.input, context)).rejects.toThrow(
      /changed|detach/,
    );
    delete f.request.commute;
    f.request.demand.notes.push(
      "Copied from prepared Census evidence; detached and now authored/unverified.",
    );
    const detached = await reviewTrafficSubmission(f.input, context);
    expect(detached.request.commute).toBeUndefined();
    expect(detached.request.demand.sources).toEqual(c.preset.demand.sources);
    expect(detached.request.demand.rows[0].vehicles).toBe(
      c.preset.demand.rows[0].vehicles + 1,
    );
  });
  it("admits a criteria-only declared source without inventing observations and preserves its server-stamped attribution on the next save", async () => {
    const f = await fixture(),
      source: Source = {
        ...trafficFixtureSource,
        id: "count-check-criteria",
        name: "User-entered baseline count-check criteria",
        description:
          "Project-specific criteria, not agency-approved thresholds.",
      };
    f.request.calibrationPlan = {
      ...trafficCalibrationFixture(),
      sourceIds: [source.id],
    };
    f.request.countPack.sources.push(source);
    f.input.sourceDeclarations.push(declaration(source));
    const result = await reviewTrafficSubmission(f.input, f.context),
      retained = result.request.countPack.sources.find(
        (s) => s.id === source.id,
      )!;
    expect(result.request.countPack.counts).toEqual(
      f.context.original.countPack.counts,
    );
    expect(retained.rights).toMatchObject({
      declaredBy: "actor",
      declaredAt: f.context.now,
      publicRedistribution: false,
      privateUse: true,
    });
    // Unmapped observations remain visible and ineligible; saving a plan does not qualify them.
    expect(
      result.request.countPack.counts.every((c) => c.target === null),
    ).toBe(true);
    expect(result.request.calibrationPlan?.sourceIds).toEqual([source.id]);
    f.context.previous = prior(f, result);
    f.input.request = structuredClone(result.request);
    f.input.sourceDeclarations = [];
    f.context.now = "2026-11-06T11:00:00Z";
    const next = await reviewTrafficSubmission(f.input, f.context);
    expect(
      next.request.countPack.sources.find((s) => s.id === source.id),
    ).toEqual(retained);
  });

  it("requires a private-use declaration for a new criteria-only source", async () => {
    const f = await fixture(),
      source = { ...trafficFixtureSource, id: "undeclared-criteria" };
    f.request.countPack.sources.push(source);
    f.request.calibrationPlan = {
      ...trafficCalibrationFixture(),
      sourceIds: [source.id],
    };
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /Declare private processing/,
    );
  });

  it.each([
    "unknown-count",
    "duplicate-count",
    "cross-role",
    "outside-period",
    "missing-source",
  ] as const)(
    "rejects a structurally invalid new %s count-check selection before configuration admission",
    async (issue) => {
      const f = await fixture();
      f.request.calibrationPlan = trafficCalibrationFixture();
      const plan = f.request.calibrationPlan;
      if (issue === "unknown-count")
        plan.calibrationCountIds = ["not-retained"];
      if (issue === "duplicate-count") plan.calibrationCountIds.push("count-0");
      if (issue === "cross-role") plan.holdoutCountIds = ["count-0"];
      if (issue === "missing-source") plan.sourceIds = ["not-retained"];
      if (issue === "outside-period") {
        for (const pack of [f.request.countPack, f.context.original.countPack])
          pack.counts[0].beginSeconds = f.request.period.beginSeconds - 60;
      }
      await expect(
        reviewTrafficSubmission(f.input, f.context),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: "TRAFFIC_CALIBRATION_SELECTION",
      });
    },
  );

  it("rejects fitting versus holdout leakage across different lanes and hours at one station-direction-day", async () => {
    const f = await fixture();
    for (const pack of [f.request.countPack, f.context.original.countPack]) {
      pack.counts[1].stationId = pack.counts[0].stationId;
      pack.counts[0].raw.laneCode = "1";
      pack.counts[1].raw.laneCode = "2";
      pack.counts[1].beginSeconds = 29700;
      pack.counts[1].endSeconds = 30600;
    }
    f.request.calibrationPlan = trafficCalibrationFixture();
    await expect(
      reviewTrafficSubmission(f.input, f.context),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "TRAFFIC_CALIBRATION_SELECTION",
    });
    // Clearing the optional check plan preserves the existing source/count workflow.
    f.request.calibrationPlan = null;
    expect(
      (await reviewTrafficSubmission(f.input, f.context)).request
        .calibrationPlan,
    ).toBeNull();
  });

  it("does not accept different station names or detector positions as holdout independence on one reviewed directed edge", async () => {
    const f = await fixture();
    f.request.calibrationPlan = trafficCalibrationFixture();
    for (let i = 0; i < f.request.countPack.counts.length; i++) {
      const count = f.request.countPack.counts[i];
      count.target = {
        kind: "edge",
        edgeId: "in",
        positionFraction: i ? 0.8 : 0.2,
      };
      f.input.mappingReviews.push({
        countId: count.id,
        target: count.target,
        networkFileSha256: f.request.networkHash,
        directionAgreement: "confirmed",
      });
    }
    await expect(
      reviewTrafficSubmission(f.input, f.context),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "TRAFFIC_CALIBRATION_SELECTION",
    });
  });

  it("rejects a complete but oversized correspondence inventory before native admission without truncating citations", async () => {
    const f = await fixture(),
      template = f.context.place.roads[0];
    f.context.place.roads = [];
    f.context.place.sources = [];
    f.input.planningRoadReviews = [];
    f.input.planningSourceDeclarations = [];
    for (let i = 0; i < 30; i++) {
      const road = { ...template, id: `road-${i}`, sourceId: `source-${i}` };
      f.context.place.roads.push(road);
      f.context.place.sources.push({
        ...trafficFixtureSource,
        id: road.sourceId,
        description: "Original retained citation. " + "x".repeat(4900),
      });
      f.context.scenario.roadEdits[road.id] = { ...road, speedMph: 35 };
      f.input.planningSourceDeclarations.push({
        sourceId: road.sourceId,
        privateUseConfirmed: true,
        publicRedistribution: false,
      });
    }
    await expect(
      reviewTrafficSubmission(f.input, f.context),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "TRAFFIC_PLANNING_CAPTURE_LIMIT",
    });
    expect(f.context.place.sources).toHaveLength(30);
    expect(f.context.scenario.roadEdits).toHaveProperty("road-29");
  });

  it("derives planning controls from exact saved roads, stamps reviews and isolated permissions, and retains unsupported property coverage", async () => {
    const f = await fixture(),
      road = f.context.place.roads[0];
    f.context.scenario.roadEdits[road.id] = {
      ...road,
      speedMph: 35,
      signal: true,
    };
    f.input.planningRoadReviews = [
      {
        roadId: road.id,
        properties: ["speed"],
        directions: [{ direction: "with-road", edgeIds: ["in"] }],
        extent: "partial-road",
        nativeExtensionAcknowledged: true,
        rationale: "Synthetic manual direction and extent review.",
      },
    ];
    f.input.planningSourceDeclarations = [
      {
        sourceId: road.sourceId,
        privateUseConfirmed: true,
        publicRedistribution: false,
      },
    ];
    f.request.overlays = [{ edgeId: "in", lanes: 2 }];
    const result = await reviewTrafficSubmission(f.input, f.context),
      mapping = result.request.planningRoads!;
    expect(result.request.overlays).toEqual([
      { edgeId: "in", lanes: 2, speedMps: 35 * 0.44704 },
    ]);
    expect(mapping.reviews[0]).toMatchObject({
      reviewedBy: "actor",
      reviewedAt: f.context.now,
    });
    expect(mapping.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roadId: road.id,
          property: "signal",
          reason: "unsupported",
        }),
        expect.objectContaining({
          roadId: road.id,
          property: "speed",
          reason: "partial-extent",
        }),
      ]),
    );
    expect(mapping.sources).toEqual(f.context.place.sources);
    expect(mapping.sourceDeclarations).toEqual([
      {
        sourceId: road.sourceId,
        privateUseConfirmed: true,
        publicRedistribution: false,
        declaredBy: "actor",
        declaredAt: f.context.now,
      },
    ]);
    expect(mapping.sources[0].kind).toBe("user-supplied");
    expect(result.request.countPack.sources[0].kind).toBe("observed");
    expect(f.context.place.sources[0]).not.toHaveProperty("rights");

    f.context.previous = prior(f, result);
    f.input.request = structuredClone(result.request);
    delete f.input.planningRoadReviews;
    delete f.input.planningSourceDeclarations;
    f.context.now = "2026-11-06T11:00:00Z";
    const reused = await reviewTrafficSubmission(f.input, f.context);
    expect(reused.request.planningRoads).toEqual(mapping);
    (f.input.request as TrafficExperimentRequest).overlays[0].speedMps = 5;
    await expect(
      reviewTrafficSubmission(f.input, f.context),
    ).rejects.toMatchObject({ code: "TRAFFIC_PLANNING_REVIEW_REQUIRED" });
    f.input.request = structuredClone(result.request);
    (
      f.input.request as TrafficExperimentRequest
    ).planningRoads!.reviews[0].reviewedBy = "forged-reviewer";
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /recorded by the server/,
    );
    f.input.request = structuredClone(result.request);
    f.context.scenario.roadEdits[road.id]!.speedMph = 40;
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /differs/,
    );
  });
  it("requires explicit planning permissions, rejects control ownership conflicts and unlinks without converting generated controls into manual changes", async () => {
    const f = await fixture(),
      road = f.context.place.roads[0];
    f.context.scenario.roadEdits[road.id] = { ...road, speedMph: 35 };
    f.input.planningRoadReviews = [
      {
        roadId: road.id,
        properties: ["speed"],
        directions: [{ direction: "with-road", edgeIds: ["in"] }],
        extent: "full-road",
        nativeExtensionAcknowledged: true,
        rationale: "Synthetic manual correspondence review.",
      },
    ];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /Confirm private/,
    );
    f.input.planningSourceDeclarations = [
      {
        sourceId: road.sourceId,
        privateUseConfirmed: true,
        publicRedistribution: false,
      },
    ];
    f.request.overlays = [{ edgeId: "in", speedMps: 35 * 0.44704 }];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /same native edge property/,
    );
    f.request.overlays = [];
    const result = await reviewTrafficSubmission(f.input, f.context);
    f.input.request = structuredClone(result.request);
    delete f.input.planningRoadReviews;
    f.context.previous = null;
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /caller-created receipt/,
    );
    f.context.previous = prior(f, result);
    f.input.planningRoadReviews = [];
    (f.input.request as TrafficExperimentRequest).overlays = [];
    const unlinked = await reviewTrafficSubmission(f.input, f.context);
    expect(unlinked.request.overlays).toEqual([]);
    expect(unlinked.request.planningRoads!.reviews).toEqual([]);
    expect(unlinked.request.planningRoads!.exclusions).toContainEqual(
      expect.objectContaining({
        roadId: road.id,
        property: "speed",
        reason: "not-reviewed",
      }),
    );
  });

  it("requires explicit authored-source rights and server-stamps them without promoting user claims to provider evidence", async () => {
    const f = await fixture();
    f.input.sourceDeclarations = [];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /Declare private/,
    );
    f.input.sourceDeclarations = [declaration(f.request.demand.sources[0])];
    f.request.demand.sources[0].kind = "observed";
    const result = await reviewTrafficSubmission(f.input, f.context);
    expect(result.request.demand.sources[0]).toMatchObject({
      kind: "user-supplied",
      rights: {
        declaredBy: "actor",
        declaredAt: f.context.now,
        publicRedistribution: false,
        privateUse: true,
        historicalRetention: true,
      },
    });
    f.request.countPack.sources[0].name = "Rewritten provider";
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /original provider attribution/,
    );
  });
  it("retains every source observation and raw interval; adjustments require factored labeling and a new explanation", async () => {
    for (const mutate of [
      (r: TrafficExperimentRequest) => r.countPack.counts.pop(),
      (r: TrafficExperimentRequest) =>
        (r.countPack.counts[0].raw.recordId = "forged"),
      (r: TrafficExperimentRequest) => (r.countPack.counts[0].value = 999),
    ]) {
      const f = await fixture();
      mutate(f.request);
      await expect(
        reviewTrafficSubmission(f.input, f.context),
      ).rejects.toThrow();
    }
    const f = await fixture();
    const row = f.request.countPack.counts[0];
    row.kind = "factored";
    row.value = 7;
    row.notes = [];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /explanatory note/,
    );
    row.notes = ["Explicit adjustment for synthetic test only."];
    const result = await reviewTrafficSubmission(f.input, f.context);
    expect(result.request.countPack.counts[0]).toMatchObject({
      kind: "factored",
      value: 7,
      raw: f.context.original.countPack.counts[0].raw,
    });
    expect(result.request.countPack.counts[0].notes).toContain(
      "Synthetic provider quality restriction retained.",
    );
  });
  it("binds target/class/coordinate review to the current graph and replaces forged reviewer fields", async () => {
    const f = await fixture(),
      row = f.request.countPack.counts[0];
    row.target = { kind: "edge", edgeId: "in", positionFraction: 0.5 };
    row.position = [-112.0045, 33];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /explicitly review/,
    );
    f.input.mappingReviews = [
      {
        countId: row.id,
        target: row.target,
        networkFileSha256: f.request.networkHash,
        directionAgreement: "confirmed",
      },
    ];
    row.mapping = {
      networkFileSha256: f.request.networkHash,
      method: "source-id",
      snapMeters: 0,
      directionAgreement: "confirmed",
      reviewedBy: "forged-owner",
      reviewedAt: "2025-01-01T00:00:00Z",
    };
    const result = await reviewTrafficSubmission(f.input, f.context);
    expect(result.request.countPack.counts[0].mapping).toMatchObject({
      reviewedBy: "actor",
      reviewedAt: f.context.now,
      method: "manual",
      snapMeters: null,
    });
    f.context.previous = prior(f, result);
    f.input.request = structuredClone(result.request);
    f.input.mappingReviews = [];
    f.input.sourceDeclarations = [];
    await expect(
      reviewTrafficSubmission(f.input, f.context),
    ).resolves.toBeTruthy();
    (
      f.input.request as TrafficExperimentRequest
    ).countPack.counts[0].vehicleClasses = ["truck"];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /explicitly review/,
    );
    f.input.mappingReviews = [
      {
        countId: row.id,
        target: row.target,
        networkFileSha256: "0".repeat(64),
        directionAgreement: "confirmed",
      },
    ];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /exact selected/,
    );
  });
  it("does not silently replace original station positions without a mapped review, and restores provider notes", async () => {
    const f = await fixture();
    f.request.countPack.counts[0].notes = [];
    const result = await reviewTrafficSubmission(f.input, f.context);
    expect(result.request.countPack.counts[0].notes).toEqual(
      f.context.original.countPack.counts[0].notes,
    );
    f.request.countPack.counts[0].position = [-112, 33];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /station position/,
    );
  });
  it("reconstructs CSV zero and missing rows from private bytes under the explicitly frozen import clock", async () => {
    const f = await fixture();
    const { binding, record } = await upload(f);
    const result = await reviewTrafficSubmission(f.input, f.context);
    expect(result.uploadBindings[0].period).toEqual(binding.period);
    expect(
      result.request.countPack.counts
        .slice(-2)
        .map((c) => [c.value, c.status, c.date]),
    ).toEqual([
      [0, "available", "2026-01-11"],
      [null, "missing", "2026-01-11"],
    ]);
    expect(result.request.countPack.files.at(-1)).toMatchObject({
      sha256: record.sha256,
      bytes: record.bytes,
      url: "urn:urban:traffic-upload:upload:counts.csv",
    });
    f.context.previous = prior(f, result);
    f.input.request = structuredClone(result.request);
    f.input.uploadBindings = [];
    f.input.sourceDeclarations = [];
    (f.input.request as TrafficExperimentRequest).period.date = "2026-01-13";
    const next = await reviewTrafficSubmission(f.input, f.context);
    expect(next.uploadBindings[0].period.date).toBe("2026-01-11");
    expect(next.request.countPack.counts.at(-1)!.date).toBe("2026-01-11");
    f.input.uploadBindings = [
      { ...binding, mapping: { station: 1, value: 0 } },
    ];
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /mapping is immutable/,
    );
  });
  it("rejects missing-to-zero invention, another-project upload and mismatched upload hashes or row counts", async () => {
    for (const change of ["missing", "project", "hash", "rows"]) {
      const f = await fixture();
      const { record } = await upload(f);
      if (change === "missing") {
        const row = f.request.countPack.counts.at(-1)!;
        row.value = 0;
        row.status = "available";
        row.kind = "factored";
        row.notes.push("Inventing missing data is not allowed.");
      }
      if (change === "project") record.projectId = "other";
      if (change === "hash") record.sha256 = "f".repeat(64);
      if (change === "rows") record.rows = 99;
      await expect(
        reviewTrafficSubmission(f.input, f.context),
        change,
      ).rejects.toThrow();
    }
  });
  it("rejects unknown file provenance and annual-count mutation instead of converting them into hourly evidence", async () => {
    const f = await fixture();
    f.request.countPack.files.push({
      sourceId: f.request.countPack.sources[0].id,
      url: "https://example.com/fabricated.csv",
      sha256: "f".repeat(64),
      bytes: 1,
      retrievedAt: f.context.now,
    });
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /no retained original/,
    );
    f.request.countPack.files = [];
    f.request.countPack.annualCounts.push({
      id: "invented",
      stationId: "test",
      position: null,
      year: 2025,
      value: 123,
      status: "available",
      direction: "both",
      sourceIds: [f.request.countPack.sources[0].id],
      notes: [],
    });
    await expect(reviewTrafficSubmission(f.input, f.context)).rejects.toThrow(
      /annual counts/,
    );
  });
});
