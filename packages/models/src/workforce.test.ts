import { describe, expect, it } from "vitest";
import {
  workforceContentHash,
  workforceRoutingInputHash,
  workforceTravelTimeLowerBound,
  type WorkforceCell,
  type WorkforceCohortPack,
  type WorkforceRoutingRun,
} from "@urban/core";
import { resolveWorkforce } from "./workforce";

const cell = (value: number, moe = 0): WorkforceCell => ({
  estimate: {
    value,
    raw: String(value),
    annotation: null,
    status: "available",
  },
  marginOfError: {
    value: moe,
    raw: String(moe),
    annotation: null,
    status: "available",
  },
});
function pack(): WorkforceCohortPack {
  const education = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `B15003_${String(i + 1).padStart(3, "0")}`,
      cell(0),
    ]),
  );
  const occupation = Object.fromEntries(
    Array.from({ length: 73 }, (_, i) => [
      `C24010_${String(i + 1).padStart(3, "0")}`,
      cell(0),
    ]),
  );
  education.B15003_001 = cell(100, 10);
  education.B15003_022 = cell(100, 10);
  occupation.C24010_001 = cell(100, 10);
  occupation.C24010_003 = cell(60, 6);
  occupation.C24010_039 = cell(40, 8);
  return {
    version: 1,
    id: "synthetic-model-fixture",
    acs: {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      confidenceLevel: 90,
      boundaryVintage: "2024",
    },
    region: {
      label: "Synthetic unit test",
      countyGeoids: ["04013"],
      complete: true,
    },
    sources: [
      {
        id: "fixture",
        name: "Synthetic unit test",
        url: "",
        vintage: "2024",
        license: "Test",
        kind: "user-supplied",
      },
    ],
    files: [
      {
        sourceId: "fixture",
        url: "https://example.org/test",
        sha256: "a".repeat(64),
        retrievedAt: "2026-11-06T00:00:00Z",
      },
    ],
    allocation: {
      method: "2020-block-population",
      sourceId: "fixture",
      vintage: 2020,
      geographyMatch: "verified",
      notes: ["Synthetic evidence only."],
    },
    units: [
      {
        geoid: "040130001001",
        name: "Synthetic BG",
        education,
        occupation,
        allocationStatus: "complete",
      },
    ],
    unallocatedOrigins: [],
    origins: [
      {
        id: "040130001001001",
        unitGeoid: "040130001001",
        position: [-112, 33],
        population2020: 20,
        weight: 0.2,
      },
      {
        id: "040130001001002",
        unitGeoid: "040130001001",
        position: [-112.01, 33],
        population2020: 80,
        weight: 0.8,
      },
    ],
  };
}
async function run(
  p: WorkforceCohortPack,
  seconds = [900, 1800],
): Promise<WorkforceRoutingRun> {
  const r: WorkforceRoutingRun = {
    version: 1,
    cohortPackHash: await workforceContentHash(p),
    inputHash: "0".repeat(64),
    createdAt: "2026-11-06T00:00:00Z",
    request: {
      site: [-112, 33],
      mode: "car",
      direction: "inbound",
      thresholdsMinutes: [15, 30, 45],
    },
    network: {
      id: "fixture-network",
      engine: "fixture",
      engineVersion: "1",
      graphHash: "1".repeat(64),
      profileHash: "2".repeat(64),
      sourceHashes: ["3".repeat(64)],
      extent: [-113, 32, -111, 34],
      coverage: "complete",
      costing: "static",
      notes: [],
    },
    cohortCoverage: {
      status: "complete",
      boundaryHash: "b".repeat(64),
      notes: ["Synthetic fixture coverage proof."],
    },
    rows: p.origins.map((o, i) => ({
      id: o.id,
      status: "reachable",
      seconds: seconds[i] ?? 100,
      distanceMeters: 100,
      snapMeters: 1,
    })),
  };
  r.inputHash = await workforceRoutingInputHash(
    r.cohortPackHash,
    r.request,
    r.network,
    r.cohortCoverage,
  );
  return r;
}
const total = (
  r: Awaited<ReturnType<typeof resolveWorkforce>>,
  threshold = 0,
  panel = 0,
) => r.panels[panel].thresholds[threshold].total;

describe("inbound workforce aggregation", () => {
  it("retains ambiguous population once without routing or assigning it to each candidate group", async () => {
    const p = pack(),
      second = structuredClone(p.units[0]);
    second.geoid = "040130002001";
    second.allocationStatus = "unavailable";
    p.units.push(second);
    p.units[0].allocationStatus = "unavailable";
    p.origins.forEach((o) => {
      o.weight = 0;
    });
    p.unallocatedOrigins.push({
      id: "040130003001001",
      position: [-112, 33],
      population2020: 50,
      candidateUnitGeoids: p.units.map((u) => u.geoid),
      reason: "split-current-geography",
    });
    const routed = await run(p),
      r = await resolveWorkforce(p, routed);
    expect(routed.rows).toHaveLength(2);
    expect(r.coverage).toMatchObject({
      origins: 2,
      unallocatedOriginCount: 1,
      unallocatedPopulation2020: 50,
      ambiguousAffectedUnitCount: 2,
      allocationPopulation2020: 150,
      allocationUnavailableUnits: 2,
    });
    expect(total(r)).toMatchObject({
      estimate: null,
      knownSubtotal: null,
      status: "unavailable",
      unresolvedAllocationUnitGeoids: p.units.map((u) => u.geoid),
    });
    routed.rows.push({
      id: p.unallocatedOrigins[0].id,
      status: "reachable",
      seconds: 1,
      distanceMeters: 1,
      snapMeters: 0,
    });
    await expect(resolveWorkforce(p, routed)).rejects.toThrow(
      "every cohort origin",
    );
  });
  it("uses actual inclusive origin times and retains native-unit MOE instead of treating blocks as samples", async () => {
    const p = pack(),
      r = await resolveWorkforce(p, await run(p));
    expect(r.panels.map((x) => x.universe)).toEqual([
      "Population 25 years and over",
      "Civilian employed population 16 years and over",
    ]);
    expect(r.panels[0].thresholds.map((t) => t.total.estimate)).toEqual([
      20, 100, 100,
    ]);
    expect(r.panels[0].thresholds.map((t) => t.total.marginOfError90)).toEqual([
      2, 10, 10,
    ]);
    expect(r.panels[1].thresholds[0].categories[0].estimate).toBe(20);
    expect(r.panels[1].thresholds[0].categories[0].marginOfError90).toBe(2);
    expect(total(r, 1).marginOfError90).not.toBeCloseTo(
      Math.sqrt(2 ** 2 + 8 ** 2),
    );
    expect(total(r).geographicallyPartialUnitCount).toBe(1);
    expect(total(r, 1).geographicallyPartialUnitCount).toBe(0);
    expect(r.uncertainty.includesSpatialAllocationError).toBe(false);
  });
  it("uses the published total independently of rounded or incomplete category sums", async () => {
    const p = pack();
    p.units[0].education.B15003_022 = cell(99, 5);
    const r = await resolveWorkforce(p, await run(p, [100, 100]));
    expect(total(r).estimate).toBe(100);
    expect(
      r.panels[0].thresholds[0].categories.find((c) => c.id === "bachelor")
        ?.estimate,
    ).toBe(99);
  });
  it("combines different native units once and uses sqrt of weighted native variances", async () => {
    const p = pack(),
      u = structuredClone(p.units[0]);
    u.geoid = "040130002001";
    u.education.B15003_001 = cell(80, 20);
    p.units.push(u);
    p.origins.push(
      {
        id: "040130002001001",
        unitGeoid: u.geoid,
        position: [-112, 33],
        population2020: 10,
        weight: 0.5,
      },
      {
        id: "040130002001002",
        unitGeoid: u.geoid,
        position: [-112, 33],
        population2020: 10,
        weight: 0.5,
      },
    );
    const r = await resolveWorkforce(p, await run(p, [100, 1900, 100, 1900]));
    expect(total(r).estimate).toBe(60);
    expect(total(r).marginOfError90).toBeCloseTo(Math.sqrt(4 + 100));
    expect(total(r, 2).estimate).toBe(180);
    expect(total(r, 2).marginOfError90).toBeCloseTo(Math.sqrt(100 + 400));
  });
  it("keeps suppressed estimates null and retains a known subtotal only where values exist", async () => {
    const p = pack();
    p.units[0].education.B15003_001.estimate = {
      value: null,
      raw: "-666666666",
      annotation: "***",
      status: "suppressed",
    };
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: null,
      knownSubtotal: null,
      marginOfError90: null,
      status: "unavailable",
      suppressedUnitGeoids: [p.units[0].geoid],
    });
    expect(total(r).sourceIssues).toEqual([
      { geoid: p.units[0].geoid, cell: "B15003_001", status: "suppressed" },
    ]);
    expect(total(r, 0, 1).estimate).toBe(20);
    expect(
      r.panels[0].thresholds[0].categories.find((c) => c.id === "bachelor")
        ?.estimate,
    ).toBe(20);
  });
  it("reports partial category cells without substituting zero for the missing part", async () => {
    const p = pack();
    p.units[0].occupation.C24010_039.estimate = {
      value: null,
      raw: null,
      annotation: null,
      status: "missing",
    };
    const r = await resolveWorkforce(p, await run(p, [100, 100]));
    const category = r.panels[1].thresholds[0].categories[0];
    expect(category).toMatchObject({
      estimate: null,
      knownSubtotal: 60,
      knownSubtotalMarginOfError90: 6,
      status: "partial",
      missingUnitGeoids: [p.units[0].geoid],
    });
    expect(total(r, 0, 1).estimate).toBe(100);
  });
  it("retains known estimates when only MOEs are missing and never invents a precision range", async () => {
    const p = pack();
    p.units[0].education.B15003_001.marginOfError = {
      value: null,
      raw: "-999999999",
      annotation: null,
      status: "uncomputable",
    };
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: 20,
      marginOfError90: null,
      knownSubtotalMarginOfError90: null,
      status: "complete",
      missingMoeUnitGeoids: [p.units[0].geoid],
    });
  });
  it("distinguishes known unreachable origins from unsnappable or missing network origins", async () => {
    const p = pack(),
      routed = await run(p);
    routed.rows[1] = {
      ...routed.rows[1],
      status: "unreachable",
      seconds: null,
      distanceMeters: null,
    };
    const unreachable = await resolveWorkforce(p, routed);
    expect(total(unreachable)).toMatchObject({
      estimate: 20,
      status: "complete",
    });
    for (const status of [
      "unsnappable",
      "outside-coverage",
      "unavailable",
    ] as const) {
      routed.rows[1].status = status;
      const missing = await resolveWorkforce(p, routed);
      expect(total(missing)).toMatchObject({
        estimate: null,
        knownSubtotal: 20,
        status: "partial",
        unresolvedAllocationUnitGeoids: [p.units[0].geoid],
      });
      expect(missing.coverage.routeStatusCounts[status]).toBe(1);
      expect(missing.coverage.unroutedAllocationPopulation2020).toBe(80);
    }
  });
  it("withholds whole-shed totals for incomplete region or network coverage even when all loaded routes succeed", async () => {
    const p = pack();
    p.region.complete = false;
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: null,
      knownSubtotal: 20,
      status: "partial",
    });
    const p2 = pack(),
      route = await run(p2);
    route.network.coverage = "bounded";
    route.inputHash = await workforceRoutingInputHash(
      route.cohortPackHash,
      route.request,
      route.network,
      route.cohortCoverage,
    );
    const r2 = await resolveWorkforce(p2, route);
    expect(total(r2)).toMatchObject({
      estimate: null,
      knownSubtotal: 20,
      status: "partial",
    });
    const route3 = await run(p2);
    route3.cohortCoverage = {
      status: "bounded",
      boundaryHash: "b".repeat(64),
      notes: ["Only selected counties; possible catchment extends farther."],
    };
    route3.inputHash = await workforceRoutingInputHash(
      route3.cohortPackHash,
      route3.request,
      route3.network,
      route3.cohortCoverage,
    );
    const r3 = await resolveWorkforce(p2, route3);
    expect(total(r3)).toMatchObject({
      estimate: null,
      knownSubtotal: 20,
      status: "partial",
    });
    expect(r3.coverage.network).toBe("complete");
    expect(r3.coverage.regionDataComplete).toBe(true);
    expect(r3.coverage.cohort.status).toBe("bounded");
  });
  it("counts proven beyond-threshold origins as known zero without pretending they were routed", async () => {
    const p = pack();
    p.origins[1].position = [-114, 33];
    const route = await run(p);
    route.network.exclusionProof = {
      method: "conservative-great-circle",
      maximumSpeedKph: 140,
      snapAllowanceMeters: 500,
    };
    route.rows[1] = {
      id: p.origins[1].id,
      status: "outside-threshold",
      seconds: null,
      distanceMeters: null,
      snapMeters: null,
      lowerBoundSeconds: workforceTravelTimeLowerBound(
        p.origins[1].position,
        route.request.site,
        route.network.exclusionProof,
      ),
    };
    route.inputHash = await workforceRoutingInputHash(
      route.cohortPackHash,
      route.request,
      route.network,
      route.cohortCoverage,
    );
    const r = await resolveWorkforce(p, route);
    expect(r.panels[0].thresholds.map((t) => t.total.estimate)).toEqual([
      20, 20, 20,
    ]);
    expect(r.coverage.routeStatusCounts["outside-threshold"]).toBe(1);
    expect(r.coverage.routeStatusCounts.unreachable).toBe(0);
    expect(r.coverage.unroutedAllocationPopulation2020).toBe(0);
  });
  it("keeps unresolved allocation for zero estimates distinct from an exact sampling margin", async () => {
    const p = pack();
    p.units[0].education.B15003_001 = cell(0, 10);
    p.units[0].allocationStatus = "unavailable";
    p.origins.forEach((o) => {
      o.weight = 0;
      o.population2020 = 0;
    });
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: 0,
      marginOfError90: null,
      knownSubtotalMarginOfError90: 0,
      missingMoeUnitGeoids: [],
      unresolvedAllocationMoeUnitGeoids: [p.units[0].geoid],
      unresolvedAllocationUnitGeoids: [p.units[0].geoid],
    });
  });
  it("does not let a zero-estimate unallocated unit erase the conditional MOE of other known routed shares", async () => {
    const p = pack(),
      zero = structuredClone(p.units[0]);
    zero.geoid = "040130002001";
    zero.allocationStatus = "unavailable";
    zero.education.B15003_001 = cell(0, 14);
    p.units.push(zero);
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: 20,
      knownSubtotal: 20,
      marginOfError90: null,
      knownSubtotalMarginOfError90: 2,
      missingMoeUnitGeoids: [],
      unresolvedAllocationMoeUnitGeoids: [zero.geoid],
      unresolvedAllocationUnitGeoids: [zero.geoid],
    });
    zero.education.B15003_001 = cell(50, 14);
    const positive = await resolveWorkforce(p, await run(p));
    expect(total(positive)).toMatchObject({
      estimate: null,
      knownSubtotal: 20,
      marginOfError90: null,
      knownSubtotalMarginOfError90: 2,
      status: "partial",
      missingMoeUnitGeoids: [],
      unresolvedAllocationMoeUnitGeoids: [zero.geoid],
    });
  });
  it("propagates a zero cohort's positive MOE through its known share while retaining uncertainty for its unknown share", async () => {
    const p = pack();
    p.units[0].education.B15003_001 = cell(0, 10);
    const routed = await run(p);
    routed.rows[1] = {
      ...routed.rows[1],
      status: "unsnappable",
      seconds: null,
      distanceMeters: null,
      snapMeters: null,
    };
    const r = await resolveWorkforce(p, routed);
    expect(total(r)).toMatchObject({
      estimate: 0,
      knownSubtotal: 0,
      marginOfError90: null,
      knownSubtotalMarginOfError90: 2,
      missingMoeUnitGeoids: [],
      unresolvedAllocationMoeUnitGeoids: [p.units[0].geoid],
    });
  });
  it("keeps a genuinely absent source MOE separate from unknown allocation", async () => {
    const p = pack(),
      zero = structuredClone(p.units[0]);
    zero.geoid = "040130002001";
    zero.allocationStatus = "unavailable";
    zero.education.B15003_001 = cell(0, 14);
    p.units.push(zero);
    p.units[0].education.B15003_001.marginOfError = {
      value: null,
      raw: "-222222222",
      annotation: null,
      status: "uncomputable",
    };
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: 20,
      marginOfError90: null,
      knownSubtotalMarginOfError90: null,
      missingMoeUnitGeoids: [p.units[0].geoid],
      unresolvedAllocationMoeUnitGeoids: [zero.geoid],
    });
  });
  it("preserves a genuine zero and its positive sampling MOE", async () => {
    const p = pack();
    p.units[0].education.B15003_001 = cell(0, 10);
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: 0,
      knownSubtotal: 0,
      marginOfError90: 2,
      status: "complete",
    });
  });
  it("does not turn positive ACS populations with zero 2020 allocation population into zero", async () => {
    const p = pack();
    p.units[0].allocationStatus = "unavailable";
    p.origins.forEach((o) => {
      o.population2020 = 0;
      o.weight = 0;
    });
    const r = await resolveWorkforce(p, await run(p));
    expect(total(r)).toMatchObject({
      estimate: null,
      knownSubtotal: null,
      status: "unavailable",
      unresolvedAllocationUnitGeoids: [p.units[0].geoid],
    });
    expect(r.coverage.allocationUnavailableUnits).toBe(1);
  });
  it("does not require irrelevant cohort values for a proven empty shed", async () => {
    const p = pack();
    p.units[0].education.B15003_001.estimate = {
      value: null,
      raw: null,
      annotation: null,
      status: "missing",
    };
    const r = await resolveWorkforce(p, await run(p, [3000, 3001]));
    expect(total(r)).toMatchObject({
      estimate: 0,
      marginOfError90: 0,
      status: "complete",
      missingUnitGeoids: [],
    });
  });
  it("does not round a genuine tiny reachable or unreachable weight away", async () => {
    const p = pack();
    p.origins[0].population2020 = 1;
    p.origins[1].population2020 = 1e12 - 1;
    p.origins[0].weight = 1e-12;
    p.origins[1].weight = 1 - 1e-12;
    const r = await resolveWorkforce(p, await run(p, [100, 3000]));
    expect(total(r).estimate).toBeCloseTo(1e-10, 20);
    expect(total(r).geographicallyPartialUnitCount).toBe(1);
    const r2 = await resolveWorkforce(p, await run(p, [3000, 100]));
    expect(total(r2).estimate).toBeLessThan(100);
    expect(total(r2).geographicallyPartialUnitCount).toBe(1);
  });
  it("counts fully reached native units by origin membership despite one-ulp weight drift", async () => {
    const p = pack();
    p.origins[0].population2020 = 10;
    p.origins[0].weight = 0.1;
    p.origins[1].population2020 = 90;
    p.origins[1].weight = 0.8999999999999999;
    expect(p.origins[0].weight + p.origins[1].weight).toBeLessThan(1);
    const r = await resolveWorkforce(p, await run(p, [100, 100]));
    expect(r.methodVersion).toBe("workforce-1.0.2");
    for (const panel of r.panels)
      for (const threshold of panel.thresholds) {
        expect(threshold.total.geographicallyPartialUnitCount).toBe(0);
        expect(
          threshold.categories.every(
            (category) => category.geographicallyPartialUnitCount === 0,
          ),
        ).toBe(true);
      }
    // Correct only the diagnostic, not the captured allocation or numerical sum.
    expect(total(r).estimate).toBe(
      (p.origins[0].weight + p.origins[1].weight) * 100,
    );
    expect(total(r).estimate).toBeLessThan(100);
  });
  it("does not label an incomplete allocation fully reached just because its known origins are reached", async () => {
    const p = pack();
    p.units[0].allocationStatus = "incomplete";
    const r = await resolveWorkforce(p, await run(p, [100, 100]));
    expect(total(r)).toMatchObject({
      estimate: null,
      knownSubtotal: 100,
      geographicallyPartialUnitCount: 1,
      unresolvedAllocationUnitGeoids: [p.units[0].geoid],
    });
  });
  it("is order stable, monotone and deterministic without mutating inputs", async () => {
    const p = pack(),
      route = await run(p),
      before = JSON.stringify({ p, route });
    const a = await resolveWorkforce(p, route),
      b = await resolveWorkforce(p, route);
    expect(a).toEqual(b);
    expect(JSON.stringify({ p, route })).toBe(before);
    p.origins.reverse();
    const reversed = await run(p, [1800, 900]);
    const c = await resolveWorkforce(p, reversed);
    expect(c.panels).toEqual(a.panels);
    expect(c.cohortPackHash).not.toBe(a.cohortPackHash);
    expect(a.panels[0].thresholds.map((t) => t.total.estimate)).toEqual([
      20, 100, 100,
    ]);
  });
  it("captures inputs before asynchronous verification so later caller mutation cannot alter the result", async () => {
    const p = pack(),
      route = await run(p),
      promise = resolveWorkforce(p, route);
    p.units[0].education.B15003_001.estimate.value = 999999;
    route.rows[0].seconds = 99999;
    const r = await promise;
    expect(total(r).estimate).toBe(20);
  });
  it("rejects mismatched hashes rather than labeling arbitrary evidence as a captured run", async () => {
    const p = pack(),
      route = await run(p);
    route.request.site = [-112.1, 33];
    await expect(resolveWorkforce(p, route)).rejects.toThrow("input hash");
    const route2 = await run(p);
    route2.rows.pop();
    await expect(resolveWorkforce(p, route2)).rejects.toThrow(
      "every cohort origin",
    );
  });
});
