import { describe, expect, it } from "vitest";
import {
  accessibilityFixture,
  accessibilityPackFixture,
  accessibilityRunFixture,
} from "../../../tests/fixtures/accessibility";
import {
  accessibilityContentHash,
  accessibilityRoutingInputHash,
  accessibilityTravelTimeLowerBound,
  type AccessibilityRoutingRun,
} from "@urban/core";
import {
  resolveAccessibility,
  createAccessibilityModeEvidence,
} from "./accessibility";

async function rebind(
  run: AccessibilityRoutingRun,
  pack: ReturnType<typeof accessibilityPackFixture>,
) {
  run.jobsPackHash = await accessibilityContentHash(pack);
  run.inputHash = await accessibilityRoutingInputHash(
    run.jobsPackHash,
    run.request,
    run.network,
    run.sourceCoverage,
  );
}
describe("outbound native workplace accounting", () => {
  it("counts exact threshold boundaries, all partitions and true zero rows without population weighting", async () => {
    const { artifact } = await accessibilityFixture();
    const r = artifact.result;
    expect(r.thresholds.map((t) => t.total.estimate)).toEqual([10, 30, 30]);
    expect(r.coverage).toMatchObject({
      destinationCount: 3,
      zeroJobDestinationCount: 1,
      sourceJobs: 30,
      routeStatusCounts: { reachable: 2, "zero-jobs": 1 },
    });
    for (const t of r.thresholds) {
      for (const family of [t.earnings, t.industries])
        expect(family.reduce((n, c) => n + c.estimate!, 0)).toBe(
          t.total.estimate,
        );
      expect(t.industries[19].estimate).toBe(0);
    }
  });
  it("does not turn a null native route into zero jobs or a passing full result", async () => {
    const pack = accessibilityPackFixture(),
      run = await accessibilityRunFixture(pack);
    run.rows[1] = {
      ...run.rows[1],
      status: "unreachable",
      seconds: null,
      distanceMeters: null,
    };
    const result = await resolveAccessibility(pack, run);
    for (const t of result.thresholds)
      expect(t.total).toEqual({
        estimate: null,
        knownSubtotal: 10,
        status: "partial",
        unresolvedDestinationCount: 1,
        unresolvedJobs: 20,
        upperBound: 30,
      });
    expect(result.thresholds[0].industries[19]).toMatchObject({
      estimate: 0,
      status: "complete",
      unresolvedJobs: 0,
    });
  });
  it("distinguishes wholly unresolved positive source mass from known zero reachability", async () => {
    const pack = accessibilityPackFixture();
    pack.destinations.pop();
    const run = await accessibilityRunFixture(pack);
    run.rows = run.rows.map((r) => ({
      ...r,
      status: "unsnappable",
      seconds: null,
      distanceMeters: null,
      snapMeters: null,
    }));
    const result = await resolveAccessibility(pack, run);
    expect(result.thresholds[0].total).toEqual({
      estimate: null,
      knownSubtotal: null,
      status: "unavailable",
      unresolvedDestinationCount: 2,
      unresolvedJobs: 30,
      upperBound: 30,
    });
    expect(result.thresholds[0].industries[19].estimate).toBe(0);
  });
  it("uses conservative exclusion separately at each threshold while retaining unresolved45-minute jobs", async () => {
    const pack = accessibilityPackFixture();
    pack.destinations[1].position = [-111.07, 33.45];
    const run = await accessibilityRunFixture(pack);
    run.rows[1] = {
      ...run.rows[1],
      status: "unreachable",
      seconds: null,
      distanceMeters: null,
    };
    const bound = accessibilityTravelTimeLowerBound(
      pack.destinations[1].position,
      run.request.site,
      run.network,
    )!;
    expect(bound).toBeGreaterThan(1800);
    expect(bound).toBeLessThan(2700);
    const result = await resolveAccessibility(pack, run);
    expect(result.thresholds.map((t) => t.total.estimate)).toEqual([
      10,
      10,
      null,
    ]);
    expect(result.thresholds[2].total.unresolvedJobs).toBe(20);
  });
  it("withholds full totals and finite upper bounds when either source or graph coverage is incomplete", async () => {
    for (const kind of ["source", "network"]) {
      const pack = accessibilityPackFixture(),
        run = await accessibilityRunFixture(pack);
      if (kind === "source") run.sourceCoverage.status = "bounded";
      else run.network.coverage = "bounded";
      await rebind(run, pack);
      const r = await resolveAccessibility(pack, run);
      expect(r.thresholds[1].total).toMatchObject({
        estimate: null,
        knownSubtotal: 30,
        status: "partial",
        unresolvedJobs: 0,
        upperBound: null,
      });
    }
  });
  it("rejects missing/duplicate/foreign route identities, stale inputs and forged exclusions", async () => {
    const pack = accessibilityPackFixture(),
      original = await accessibilityRunFixture(pack);
    for (const change of [
      (r: AccessibilityRoutingRun) => {
        r.rows.pop();
      },
      (r: AccessibilityRoutingRun) => {
        r.rows[1] = r.rows[0];
      },
      (r: AccessibilityRoutingRun) => {
        r.rows[1].id = "040130001009999";
      },
      (r: AccessibilityRoutingRun) => {
        r.request.mode = "walk";
      },
      (r: AccessibilityRoutingRun) => {
        r.rows[0] = {
          ...r.rows[0],
          status: "zero-jobs",
          seconds: null,
          distanceMeters: null,
        };
      },
      (r: AccessibilityRoutingRun) => {
        r.rows[0] = {
          ...r.rows[0],
          status: "outside-threshold",
          seconds: null,
          distanceMeters: null,
          lowerBoundSeconds: 3000,
        };
      },
    ]) {
      const run = structuredClone(original);
      change(run);
      await expect(resolveAccessibility(pack, run)).rejects.toThrow();
    }
  });
  it("is invariant to ledger ordering and does not mutate frozen source evidence", async () => {
    const pack = accessibilityPackFixture(),
      run = await accessibilityRunFixture(pack),
      before = JSON.stringify({ pack, run });
    const first = await resolveAccessibility(pack, run);
    expect(JSON.stringify({ pack, run })).toBe(before);
    run.rows.reverse();
    const reversed = await resolveAccessibility(pack, run);
    expect(reversed.thresholds).toEqual(first.thresholds);
    expect(reversed.routingRunHash).not.toBe(first.routingRunHash);
  });
  it("recomputes captures, rejects forged counts/contour identity and retains exact source namespaces", async () => {
    const f = await accessibilityFixture(),
      options = {
        binding: f.evidence.binding,
        pack: f.pack,
        receipt: f.evidence.receipt,
      };
    expect(
      await createAccessibilityModeEvidence({
        ...options,
        artifact: f.artifact,
      }),
    ).toEqual(f.evidence);
    const fake = structuredClone(f.artifact);
    fake.result.thresholds[0].total.estimate = 20;
    await expect(
      createAccessibilityModeEvidence({ ...options, artifact: fake }),
    ).rejects.toThrow(/does not match/);
    const wrong = structuredClone(f.artifact);
    wrong.contour.direction = "inbound" as "outbound";
    await expect(
      createAccessibilityModeEvidence({ ...options, artifact: wrong }),
    ).rejects.toThrow(/same outbound/);
    await expect(
      createAccessibilityModeEvidence({
        ...options,
        artifact: f.artifact,
        extraSources: [{ ...f.pack.sources[0], name: "Different citation" }],
      }),
    ).rejects.toThrow(/Conflicting/);
  });
});
