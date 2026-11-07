import { describe, expect, it } from "vitest";
import {
  trafficCalibrationFixture,
  trafficCountFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
} from "../../../../packages/core/src/traffic-fixture";
import {
  admittedTrafficDraft,
  sameTrafficMutationScope,
  TrafficAttempts,
  trafficUploadKey,
} from "./traffic-session";
import type { TrafficDraftValue } from "./traffic-draft";

describe("traffic operation identity and admission", () => {
  it("preserves an explicit commute binding and removes it only for a detached authored request", () => {
    const hash = "a".repeat(64);
    const draft: TrafficDraftValue = {
      networkHash: hash,
      seed: 42,
      calibrationPlan: null,
      scopeAcknowledged: true,
      countPack: trafficCountFixture(),
      demand: trafficDemandFixture(),
      period: trafficFixturePeriod,
      overlays: [],
      sourceDeclarations: [],
      stagedFiles: [],
      mappingReviews: [],
      commute: {
        version: 1,
        presetId: "morning-cohort",
        assetHash: hash,
        sourcePackHash: hash,
        priorHash: hash,
        routesHash: hash,
        compilationHash: hash,
        demandHash: hash,
        periodHash: hash,
        networkHash: hash,
        inventoryHash: hash,
      },
    };
    const bound = admittedTrafficDraft(draft, new Map());
    expect(bound.request.commute).toEqual(draft.commute);
    expect(bound.request.commute).not.toBe(draft.commute);
    expect(
      admittedTrafficDraft({ ...draft, seed: 21 }, new Map()).request.commute,
    ).toEqual(draft.commute);
    const detached = admittedTrafficDraft(
      { ...draft, commute: undefined },
      new Map(),
    );
    expect(detached.request).not.toHaveProperty("commute");
    expect(detached.request.demand).toEqual(bound.request.demand);
  });
  it("retains the exact unknown-outcome request including old version guards until acknowledgement", () => {
    const attempts = new TrafficAttempts();
    const first = attempts.for("same-configuration", {
      expectedVersion: 2,
      expectedRevision: 3,
      expectedConfigurationId: "prior",
    });
    expect(
      attempts.for("same-configuration", {
        expectedVersion: 5,
        expectedRevision: 7,
        expectedConfigurationId: "new",
      }),
    ).toEqual(first);
    attempts.complete("same-configuration");
    const next = attempts.for("same-configuration", {
      expectedVersion: 5,
      expectedRevision: 7,
      expectedConfigurationId: "new",
    });
    expect(next.expectedVersion).toBe(5);
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
    attempts.clear();
    expect(
      attempts.for("same-configuration", { expectedVersion: 5 }).idempotencyKey,
    ).not.toBe(next.idempotencyKey);
  });
  it("keys an upload by exact original bytes, filename and size independently of scenario revisions", async () => {
    const first = await trafficUploadKey(
      { name: "counts.csv", size: 10 },
      "a".repeat(64),
    );
    expect(
      await trafficUploadKey({ name: "counts.csv", size: 10 }, "a".repeat(64)),
    ).toBe(first);
    expect(
      await trafficUploadKey({ name: "other.csv", size: 10 }, "a".repeat(64)),
    ).not.toBe(first);
    expect(
      await trafficUploadKey({ name: "counts.csv", size: 10 }, "b".repeat(64)),
    ).not.toBe(first);
  });
  it("rebinds every cited collection to the server upload source ID without altering values or inventing reviewer metadata", () => {
    const countPack = trafficCountFixture(),
      demand = trafficDemandFixture(),
      originalId = countPack.sources[0].id;
    const draft: TrafficDraftValue = {
      networkHash: "a".repeat(64),
      seed: 42,
      calibrationPlan: trafficCalibrationFixture(),
      scopeAcknowledged: true,
      countPack,
      demand,
      period: trafficFixturePeriod,
      overlays: [],
      sourceDeclarations: [
        {
          sourceId: originalId,
          name: "Count source",
          url: "",
          vintage: "2026",
          license: "Permission",
          privateUseConfirmed: true,
          publicRedistribution: false,
        },
      ],
      stagedFiles: [
        {
          file: new File(["source"], "counts.csv"),
          sha256: "b".repeat(64),
          bytes: 6,
          sourceId: originalId,
          mapping: { station: 0, value: 1 },
          useAnalysisPeriod: true,
          kind: "observed",
          batchId: "batch",
        },
      ],
      mappingReviews: [],
    };
    const original = structuredClone({ countPack, demand });
    const result = admittedTrafficDraft(
      draft,
      new Map([
        [
          originalId,
          {
            id: "upload",
            sourceId: "server-source",
            filename: "counts.csv",
            sha256: "b".repeat(64),
            bytes: 6,
            rows: 2,
          },
        ],
      ]),
    );
    expect(result.request.countPack.sources[0].id).toBe("server-source");
    expect(result.request.countPack.counts[0].sourceIds).toEqual([
      "server-source",
    ]);
    expect(result.request.demand.rows[0].sourceIds).toEqual(["server-source"]);
    expect(result.request.demand.candidateRoutes[0].sourceIds).toEqual([
      "server-source",
    ]);
    expect(result.request.calibrationPlan?.sourceIds).toEqual([
      "server-source",
    ]);
    expect(result.sourceDeclarations[0].sourceId).toBe("server-source");
    expect(result.uploadBindings[0]).toMatchObject({
      uploadId: "upload",
      sourceId: "server-source",
      kind: "observed",
      batchId: "batch",
    });
    expect(result.request.countPack.counts[0].raw).toEqual(
      countPack.counts[0].raw,
    );
    expect(result.request.countPack.counts[0].value).toBe(
      countPack.counts[0].value,
    );
    expect(result.request.countPack.sources[0].rights).toBeUndefined();
    expect({ countPack, demand }).toEqual(original);
    expect(() => admittedTrafficDraft(draft, new Map())).toThrow(
      "exact file reviewed",
    );
    expect(() =>
      admittedTrafficDraft(
        draft,
        new Map([
          [
            originalId,
            {
              id: "upload",
              sourceId: "server-source",
              filename: "counts.csv",
              sha256: "c".repeat(64),
              bytes: 6,
              rows: 2,
            },
          ],
        ]),
      ),
    ).toThrow("exact file reviewed");
  });
  it("rejects late mutations after access, account, project, version or local draft changes", () => {
    const scope = {
      accountScope: "user:org:baseline",
      projectId: "project",
      scenarioId: "proposal",
      projectVersion: 3,
      scenarioRevision: 2,
    };
    expect(sameTrafficMutationScope(scope, { ...scope }, true, false)).toBe(
      true,
    );
    for (const patch of [
      { accountScope: "other:org:baseline" },
      { projectId: "other" },
      { scenarioId: "other" },
      { projectVersion: 4 },
      { scenarioRevision: 3 },
    ])
      expect(
        sameTrafficMutationScope(scope, { ...scope, ...patch }, true, false),
      ).toBe(false);
    expect(sameTrafficMutationScope(scope, scope, false, false)).toBe(false);
    expect(sameTrafficMutationScope(scope, scope, true, true)).toBe(false);
  });
});
