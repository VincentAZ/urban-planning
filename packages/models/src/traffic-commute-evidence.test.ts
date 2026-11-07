import { describe, it, expect } from "vitest";
import {
  trafficContentHash,
  trafficCommuteSummarySchema,
  verifyTrafficCommuteSummary,
  verifyTrafficCommuteBinding,
} from "@urban/core";
import { trafficCommuteEvidenceFixture } from "./traffic-commute-evidence-fixture";
import { createTrafficCommuteSummary } from "./traffic-commute";

describe("immutable compact commute evidence", () => {
  it("retains exact source scope, losses, uncertainty and original citations without embedding or mutating the full ledger", async () => {
    const f = await trafficCommuteEvidenceFixture(),
      before = JSON.stringify(f.compilation);
    const summary = await createTrafficCommuteSummary(f);
    expect(summary.totals).toEqual(f.compilation.totals);
    expect(summary.coverage).toEqual(f.compilation.coverage);
    expect(summary.priorCoverage).toEqual(f.prior.coverage);
    expect(summary.conditionalAcsSampling).toEqual(
      f.compilation.conditionalAcsSampling,
    );
    expect(summary.sources).toEqual(f.sourcePack.sources);
    expect(summary.files).toEqual(f.sourcePack.files);
    expect(summary.totals.knownUnresolvedSourceVehicles).toBe(6);
    expect(summary.coverage.status).toBe("partial");
    expect(summary).not.toHaveProperty("ledger");
    expect(JSON.stringify(f.compilation)).toBe(before);
    await expect(verifyTrafficCommuteSummary(summary)).resolves.toBeUndefined();
    summary.sources[0].name = "Changed projection";
    expect(f.sourcePack.sources[0].name).not.toBe(summary.sources[0].name);
  });
  it("reconstructs the full fractional ledger even if a forged compilation is coherently rehashed", async () => {
    const f = await trafficCommuteEvidenceFixture();
    f.compilation.ledger[0].expectedVehicles += 1;
    f.binding.compilationHash = await trafficContentHash(f.compilation);
    await expect(createTrafficCommuteSummary(f)).rejects.toThrow(
      /fractional compilation/,
    );
    const missing = await trafficCommuteEvidenceFixture();
    missing.routes.attachments.pop();
    missing.binding.routesHash = await trafficContentHash(missing.routes);
    await expect(createTrafficCommuteSummary(missing)).rejects.toThrow(
      /exactly|missing|native|flow/i,
    );
  });
  it("refuses source authority after demand, clock, endpoint or inventory edits", async () => {
    const f = await trafficCommuteEvidenceFixture();
    for (const kind of ["vehicles", "endpoint", "period", "network"] as const) {
      const demand = structuredClone(f.compilation.demand),
        period = structuredClone(f.prior.recipe.period),
        network = structuredClone(f.network);
      if (kind === "vehicles") demand.rows[0].vehicles++;
      if (kind === "endpoint")
        demand.rows[0].endpoints!.departPositionMeters += 0.01;
      if (kind === "period") period.warmupSeconds++;
      if (kind === "network") network.edges[0].lanes[0].speedMps += 1;
      await expect(
        verifyTrafficCommuteBinding(f.binding, { demand, period, network }),
      ).rejects.toThrow(/detach/);
    }
  });
  it("keeps missing source totals distinct from known subtotals and conditional routed ACS uncertainty", async () => {
    const f = await trafficCommuteEvidenceFixture({
      changePack(pack) {
        pack.tracts[0].cells.B08132_022.estimate = {
          status: "suppressed",
          value: null,
          raw: "-666666666",
          annotation: "**",
        };
      },
    });
    expect(f.summary.totals.sourceVehicles).toBeNull();
    expect(f.summary.totals.knownSourceVehicles).toBe(20);
    expect(f.summary.coverage.unknownEstimateCells).toBe(1);
    expect(f.summary.conditionalAcsSampling.estimate).not.toBeNull();
    expect(trafficCommuteSummarySchema.safeParse(f.summary).success).toBe(true);
    f.summary.totals.sourceVehicles = 20;
    expect(trafficCommuteSummarySchema.safeParse(f.summary).success).toBe(
      false,
    );
  });
  it("rejects false completeness, omitted losses, altered realization and unknown/private file references", async () => {
    const { summary } = await trafficCommuteEvidenceFixture();
    const cases = [
      (s: typeof summary) => {
        s.coverage.status = "complete-for-declared-cohort";
      },
      (s: typeof summary) => {
        s.totals.knownUnresolvedSourceVehicles = 0;
      },
      (s: typeof summary) => {
        s.totals.vehicles++;
      },
      (s: typeof summary) => {
        s.coverage.routeStatusCounts.unreachable++;
      },
      (s: typeof summary) => {
        s.files[0].sourceId = "missing";
      },
      (s: typeof summary) => {
        s.files[0].url = "/private/operator/cache.json";
      },
      (s: typeof summary) => {
        s.sources[0].url = "file:///private/operator";
      },
    ];
    for (const change of cases) {
      const bad = structuredClone(summary);
      change(bad);
      expect(trafficCommuteSummarySchema.safeParse(bad).success).toBe(false);
    }
  });
  it("refuses oversized saved projections without truncation and binds the exact frozen recipe clock", async () => {
    const { summary } = await trafficCommuteEvidenceFixture();
    const big = structuredClone(summary);
    big.notes = Array.from({ length: 30 }, () => "x".repeat(3000));
    expect(() => trafficCommuteSummarySchema.parse(big)).toThrow(/64 KiB/);
    expect(big.notes).toHaveLength(30);
    summary.recipe.period.cooldownSeconds++;
    await expect(verifyTrafficCommuteSummary(summary)).rejects.toThrow(/clock/);
  });
});
