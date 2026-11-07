import { describe, expect, it } from "vitest";
import {
  assertWorkforceCohortPack,
  assertWorkforceRoutingRun,
  verifyWorkforceRun,
  workforceContentHash,
  workforceRoutingInputHash,
  workforceCohortPackSchema,
  workforceTravelTimeLowerBound,
  WORKFORCE_PANELS,
  type WorkforceCell,
  type WorkforceCohortPack,
  type WorkforceRoutingRun,
} from "./workforce";

const cell = (value = 10): WorkforceCell => ({
  estimate: {
    value,
    raw: String(value),
    annotation: null,
    status: "available",
  },
  marginOfError: { value: 2, raw: "2", annotation: null, status: "available" },
});
function pack(): WorkforceCohortPack {
  return {
    version: 1,
    id: "synthetic-test-pack",
    acs: {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      confidenceLevel: 90,
      boundaryVintage: "2024",
    },
    region: {
      label: "Synthetic fixture",
      countyGeoids: ["04013"],
      complete: true,
    },
    sources: [
      {
        id: "fixture",
        name: "Synthetic test only",
        url: "",
        vintage: "2024",
        license: "Test",
        kind: "user-supplied",
      },
    ],
    files: [
      {
        sourceId: "fixture",
        url: "https://example.org/fixture",
        sha256: "a".repeat(64),
        retrievedAt: "2026-11-06T00:00:00Z",
      },
    ],
    allocation: {
      method: "2020-block-population",
      sourceId: "fixture",
      vintage: 2020,
      geographyMatch: "verified",
      notes: ["Synthetic membership for unit tests only."],
    },
    units: [
      {
        geoid: "040130001001",
        name: "Synthetic BG",
        allocationStatus: "complete",
        education: Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [
            `B15003_${String(i + 1).padStart(3, "0")}`,
            cell(),
          ]),
        ),
        occupation: Object.fromEntries(
          Array.from({ length: 73 }, (_, i) => [
            `C24010_${String(i + 1).padStart(3, "0")}`,
            cell(),
          ]),
        ),
      },
    ],
    unallocatedOrigins: [],
    origins: [
      {
        id: "040130001001001",
        unitGeoid: "040130001001",
        position: [-112, 33],
        population2020: 10,
        weight: 1,
      },
    ],
  };
}
async function run(p: WorkforceCohortPack): Promise<WorkforceRoutingRun> {
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
      id: "fixture",
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
    rows: p.origins.map((o) => ({
      id: o.id,
      status: "reachable",
      seconds: 0,
      distanceMeters: 0,
      snapMeters: 0,
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
describe("immutable workforce evidence contracts", () => {
  it("retains ambiguous blocks once and invalidates every positively affected native allocation", () => {
    const p = pack(),
      second = structuredClone(p.units[0]);
    second.geoid = "040130002001";
    second.allocationStatus = "unavailable";
    p.units.push(second);
    p.unallocatedOrigins.push({
      id: "040130003001001",
      position: [-112, 33],
      population2020: 5,
      candidateUnitGeoids: p.units.map((u) => u.geoid),
      reason: "split-current-geography",
    });
    expect(() => assertWorkforceCohortPack(p)).toThrow(
      "Positive ambiguous population",
    );
    p.units[0].allocationStatus = "unavailable";
    expect(() => assertWorkforceCohortPack(p)).toThrow(
      "must not invent weights",
    );
    p.origins[0].weight = 0;
    expect(() => assertWorkforceCohortPack(p)).not.toThrow();
    p.unallocatedOrigins[0].id = p.origins[0].id;
    expect(() => assertWorkforceCohortPack(p)).toThrow(
      "overlapping unallocated",
    );
    p.unallocatedOrigins[0].id = "040130003001001";
    p.unallocatedOrigins[0].candidateUnitGeoids[1] = "040130009001";
    expect(() => assertWorkforceCohortPack(p)).toThrow("absent native unit");
  });
  it("retains zero-population ambiguity without manufacturing weights or invalidating positive complete units", () => {
    const p = pack(),
      second = structuredClone(p.units[0]);
    second.geoid = "040130002001";
    second.allocationStatus = "unavailable";
    p.units.push(second);
    p.unallocatedOrigins.push({
      id: "040130003001001",
      position: [-112, 33],
      population2020: 0,
      candidateUnitGeoids: p.units.map((u) => u.geoid),
      reason: "split-current-geography",
    });
    expect(() => assertWorkforceCohortPack(p)).not.toThrow();
    expect(p.units[0].allocationStatus).toBe("complete");
    p.unallocatedOrigins[0].candidateUnitGeoids = [
      p.units[0].geoid,
      p.units[0].geoid,
    ];
    expect(() => assertWorkforceCohortPack(p)).toThrow("distinct candidate");
  });
  it("retains every raw cell and verifies both cohort and routing identities", async () => {
    const p = pack(),
      r = await run(p);
    await expect(verifyWorkforceRun(p, r)).resolves.toBeUndefined();
    expect(Object.keys(p.units[0].education)).toHaveLength(25);
    expect(Object.keys(p.units[0].occupation)).toHaveLength(73);
    const changed = structuredClone(p);
    changed.units[0].education.B15003_001.estimate.value = 11;
    await expect(verifyWorkforceRun(changed, r)).rejects.toThrow("cohort hash");
    r.network.profileHash = "4".repeat(64);
    await expect(verifyWorkforceRun(p, r)).rejects.toThrow("input hash");
  });
  it("requires complete native rows, unique units/origins and explicit raw missing state", () => {
    const p = pack();
    delete p.units[0].education.B15003_025;
    expect(() => assertWorkforceCohortPack(p)).toThrow("25 native");
    const duplicate = pack();
    duplicate.units.push(structuredClone(duplicate.units[0]));
    expect(() => assertWorkforceCohortPack(duplicate)).toThrow("exactly once");
    const duplicateOrigin = pack();
    duplicateOrigin.origins.push(structuredClone(duplicateOrigin.origins[0]));
    expect(() => assertWorkforceCohortPack(duplicateOrigin)).toThrow(
      "Duplicate origin",
    );
    const sentinel = pack();
    sentinel.units[0].education.B15003_001.estimate = {
      value: null,
      raw: "-666666666",
      annotation: "***",
      status: "suppressed",
    };
    expect(() => assertWorkforceCohortPack(sentinel)).not.toThrow();
    sentinel.units[0].education.B15003_001.estimate.value = 0;
    expect(() => assertWorkforceCohortPack(sentinel)).toThrow("Only available");
  });
  it("rejects incomplete or invented normalization and permits explicit unallocated source units", () => {
    const p = pack();
    p.origins[0].weight = 0.9;
    expect(() => assertWorkforceCohortPack(p)).toThrow("normalized");
    p.units[0].allocationStatus = "incomplete";
    expect(() => assertWorkforceCohortPack(p)).not.toThrow();
    p.units[0].allocationStatus = "unavailable";
    expect(() => assertWorkforceCohortPack(p)).toThrow("invent weights");
    p.origins[0].weight = 0;
    p.origins[0].population2020 = 0;
    expect(() => assertWorkforceCohortPack(p)).not.toThrow();
    p.units[0].allocationStatus = "complete";
    expect(() => assertWorkforceCohortPack(p)).toThrow("positive population");
  });
  it("checks every weight against its captured population rather than only checking their sum", () => {
    const p = pack();
    p.origins[0].weight = 0.5;
    p.origins.push({
      ...p.origins[0],
      id: "040130001001002",
      population2020: 30,
    });
    expect(() => assertWorkforceCohortPack(p)).toThrow("Weights do not match");
  });
  it("does not silently infer source membership or accept undeclared county/source links", () => {
    const p = pack();
    p.origins[0].unitGeoid = "040130002001";
    expect(() => assertWorkforceCohortPack(p)).toThrow(
      "no retained native unit",
    );
    const p2 = pack();
    p2.region.countyGeoids = ["04021"];
    expect(() => assertWorkforceCohortPack(p2)).toThrow("declared region");
    const p3 = pack();
    p3.allocation.sourceId = "missing";
    expect(() => assertWorkforceCohortPack(p3)).toThrow(
      "source must be retained",
    );
  });
  it("retains exactly one route for every origin and distinguishes no path from unavailable time", async () => {
    const p = pack(),
      r = await run(p);
    r.rows.push(structuredClone(r.rows[0]));
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow("exactly once");
    r.rows = [];
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow(
      "every cohort origin",
    );
    r.rows = [
      {
        id: p.origins[0].id,
        status: "unsnappable",
        seconds: 0,
        distanceMeters: null,
        snapMeters: null,
      },
    ];
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow(
      "elapsed travel time",
    );
    r.rows[0].seconds = null;
    expect(() => assertWorkforceRoutingRun(r, p)).not.toThrow();
    r.request.direction = "outbound" as "inbound";
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow();
  });
  it("validates fixed thresholds, finite positions and ordered network extent", async () => {
    const p = pack(),
      r = await run(p);
    r.request.thresholdsMinutes = [10, 30, 45] as unknown as [15, 30, 45];
    expect(() => assertWorkforceRoutingRun(r)).toThrow();
    const r2 = await run(p);
    r2.network.extent = [-111, 32, -113, 34];
    expect(() => assertWorkforceRoutingRun(r2)).toThrow("ordered");
    r2.network.extent = [-113, 32, -111, 34];
    r2.request.site = [-100, 33];
    expect(() => assertWorkforceRoutingRun(r2)).toThrow("outside");
    p.origins[0].position[0] = NaN;
    expect(workforceCohortPackSchema.safeParse(p).success).toBe(false);
  });
  it("canonicalizes object keys without erasing source array order or raw annotations", async () => {
    expect(await workforceContentHash({ b: 2, a: 1 })).toBe(
      await workforceContentHash({ a: 1, b: 2 }),
    );
    expect(await workforceContentHash([1, 2])).not.toBe(
      await workforceContentHash([2, 1]),
    );
    const p = pack(),
      before = JSON.stringify(p);
    await run(p);
    expect(JSON.stringify(p)).toBe(before);
  });
  it("requires a separate retained cohort coverage proof and does not confuse it with graph coverage", async () => {
    const p = pack(),
      r = await run(p);
    r.cohortCoverage.boundaryHash = null;
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow("boundary hash");
    r.cohortCoverage.status = "bounded";
    expect(() => assertWorkforceRoutingRun(r, p)).not.toThrow();
    r.cohortCoverage.status = "complete";
    r.cohortCoverage.boundaryHash = "a".repeat(64);
    r.cohortCoverage.notes = [];
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow("proof notes");
    const before = await run(p);
    before.cohortCoverage = {
      status: "bounded",
      boundaryHash: "a".repeat(64),
      notes: ["A different retained region boundary."],
    };
    await expect(verifyWorkforceRun(p, before)).rejects.toThrow("input hash");
    const changedHash = await workforceRoutingInputHash(
      before.cohortPackHash,
      before.request,
      before.network,
      before.cohortCoverage,
    );
    expect(changedHash).not.toBe(before.inputHash);
    before.inputHash = changedHash;
    await expect(verifyWorkforceRun(p, before)).resolves.toBeUndefined();
  });
  it("verifies analytical exclusions from actual origin coordinates and the enforced speed/snap ceiling", async () => {
    const p = pack();
    p.origins[0].position = [-114, 33];
    const r = await run(p);
    r.network.exclusionProof = {
      method: "conservative-great-circle",
      maximumSpeedKph: 140,
      snapAllowanceMeters: 500,
    };
    const seconds = workforceTravelTimeLowerBound(
      p.origins[0].position,
      r.request.site,
      r.network.exclusionProof,
    );
    expect(seconds).toBeGreaterThan(2700);
    r.rows[0] = {
      id: p.origins[0].id,
      status: "outside-threshold",
      seconds: null,
      distanceMeters: null,
      snapMeters: null,
      lowerBoundSeconds: seconds,
    };
    expect(() => assertWorkforceRoutingRun(r, p)).not.toThrow();
    r.rows[0].lowerBoundSeconds = seconds + 100;
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow("lower bound");
    r.rows[0].lowerBoundSeconds = seconds;
    p.origins[0].position = r.request.site;
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow("lower bound");
    delete r.network.exclusionProof;
    expect(() => assertWorkforceRoutingRun(r, p)).toThrow("speed/snap proof");
  });
  it("keeps educational and occupational universes separate with nonoverlapping source categories", () => {
    expect(WORKFORCE_PANELS.education.universe).not.toBe(
      WORKFORCE_PANELS.occupation.universe,
    );
    for (const panel of Object.values(WORKFORCE_PANELS)) {
      const cells = panel.categories.flatMap((c) => [...c.cells]);
      expect(new Set(cells).size).toBe(cells.length);
      expect(cells).not.toContain(panel.totalCell);
    }
  });
});
