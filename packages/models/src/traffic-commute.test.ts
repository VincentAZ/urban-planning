import { describe, expect, it } from "vitest";
import { trafficCommuteFixture } from "../../core/src/traffic-commute-fixture";
import { trafficNetworkFixture } from "../../core/src/traffic-fixture";
import {
  trafficCommuteContentHash,
  trafficContentHash,
  type TrafficCommuteRouteSet,
} from "@urban/core";
import {
  buildTrafficCommutePrior,
  compileTrafficCommuteDemand,
  roundTrafficCommuteMass,
  trafficCommuteSamplingMoe,
} from "./traffic-commute";

describe("ACS/LODES drive-alone commute prior", () => {
  it("conserves each joint ACS bin including destinations absent from main OD, without a second mode factor", () => {
    const { pack, recipe } = trafficCommuteFixture();
    const before = structuredClone(pack);
    const result = buildTrafficCommutePrior(pack, recipe);
    expect(
      result.cells.map((c) => [
        c.estimate.value,
        c.allocatedVehicles,
        c.unresolvedVehicles,
      ]),
    ).toEqual([
      [10, 8, 2],
      [20, 16, 4],
    ]);
    expect(result.flows.map((f) => f.expectedVehicles)).toEqual([4, 4, 8, 8]);
    expect(result.totals).toEqual({
      sourceVehicles: 30,
      knownSourceVehicles: 30,
      allocatedVehicles: 24,
      unresolvedVehicles: 6,
    });
    expect(result.coverage.externalOriginPrimaryJobs).toBe(7);
    expect(result.coverage.externalOriginFlowCount).toBe(2);
    expect(pack).toEqual(before);
  });
  it("is invariant to row order and retains absolute zero rather than multiplying physical jobs", () => {
    const { pack, recipe } = trafficCommuteFixture();
    const first = buildTrafficCommutePrior(pack, recipe);
    pack.residences.reverse();
    pack.flows.reverse();
    pack.blocks.reverse();
    recipe.departureCellIds.reverse();
    const second = buildTrafficCommutePrior(pack, recipe);
    expect(second.flows).toEqual(first.flows);
    expect(second.cells).toEqual(first.cells);
    for (const id of recipe.departureCellIds)
      pack.tracts[0].cells[id].estimate = {
        value: 0,
        status: "available",
        raw: "0",
        annotation: null,
      };
    const zero = buildTrafficCommutePrior(pack, recipe);
    expect(zero.totals.sourceVehicles).toBe(0);
    expect(zero.flows.every((f) => f.expectedVehicles === 0)).toBe(true);
  });
  it("withholds missing ACS values while keeping suppressed/raw cells and known subtotal explicit", () => {
    const { pack, recipe } = trafficCommuteFixture();
    pack.tracts[0].cells.B08132_022.estimate = {
      value: null,
      status: "suppressed",
      raw: "-666666666",
      annotation: "**",
    };
    const result = buildTrafficCommutePrior(pack, recipe);
    expect(result.totals).toEqual({
      sourceVehicles: null,
      knownSourceVehicles: 20,
      allocatedVehicles: 16,
      unresolvedVehicles: null,
    });
    expect(result.cells[0]).toMatchObject({
      status: "unavailable",
      reason: "acs-suppressed",
      allocatedVehicles: null,
      estimate: { raw: "-666666666" },
    });
    expect(result.coverage.unknownEstimateCells).toBe(1);
  });
  it("does not partly normalize affected tracts when a positive native block has an ambiguous ACS join", () => {
    const { pack, recipe } = trafficCommuteFixture();
    pack.blocks[0].tractJoin = {
      status: "unresolved",
      candidateTractGeoids: [pack.tracts[0].geoid, "04013000300"],
      reason: "split-geography",
      evidenceFileSha256: pack.files.find((f) => f.role === "geography")!
        .sha256,
    };
    const result = buildTrafficCommutePrior(pack, recipe);
    expect(result.flows).toEqual([]);
    expect(result.totals).toEqual({
      sourceVehicles: 30,
      knownSourceVehicles: 30,
      allocatedVehicles: 0,
      unresolvedVehicles: 30,
    });
    expect(result.cells.every((c) => c.residentPrimaryJobs === null)).toBe(
      true,
    );
    expect(result.coverage.ambiguousResidentPrimaryJobs).toBe(50);
  });
  it("preserves zero-population/zero-job geography and rejects source deficits as unresolved rather than clipping", () => {
    const { pack, recipe } = trafficCommuteFixture();
    pack.residences[0].jobs = 20;
    pack.residences[0].raw.C000 = "20";
    const result = buildTrafficCommutePrior(pack, recipe);
    expect(result.cells[0].reason).toBe(
      "known-od-exceeds-resident-primary-jobs",
    );
    expect(result.flows).toEqual([]);
    expect(result.totals.unresolvedVehicles).toBe(30);
    pack.flows = [];
    pack.residences = [];
    const empty = buildTrafficCommutePrior(pack, recipe);
    expect(empty.cells[0].reason).toBe(
      "positive-acs-with-zero-resident-primary-jobs",
    );
    expect(empty.totals.unresolvedVehicles).toBe(30);
  });
  it("holds the entire source estimate unresolved for incomplete cohort coverage", () => {
    const { pack, recipe } = trafficCommuteFixture();
    pack.coverage.rac = "partial";
    const result = buildTrafficCommutePrior(pack, recipe);
    expect(result.totals.allocatedVehicles).toBe(0);
    expect(result.totals.unresolvedVehicles).toBe(30);
    expect(result.cells[0].reason).toMatch(/incomplete/);
  });
  it("keeps home clock distinct from local entry clock, with exact shift direction", () => {
    const { pack, recipe } = trafficCommuteFixture();
    recipe.period.date = "2026-07-01";
    recipe.homeClocks[0].timeZone = "America/Denver";
    recipe.homeClocks[0].utcOffsetMinutes = -360;
    const result = buildTrafficCommutePrior(pack, recipe);
    expect(result.flows[0]).toMatchObject({
      homeBeginSeconds: 25200,
      homeEndSeconds: 27000,
      localClockShiftSeconds: -3600,
    });
  });
  it("groups all shares of one native cell before applying MOE and distinguishes missing MOE from allocation uncertainty", () => {
    const { pack, recipe } = trafficCommuteFixture();
    let prior = buildTrafficCommutePrior(pack, recipe);
    const weights = prior.flows
      .filter((f) => f.cellId === "B08132_022")
      .map((f) => ({
        tractGeoid: f.tractGeoid,
        cellId: f.cellId,
        weight: f.destinationShare,
      }));
    const grouped = trafficCommuteSamplingMoe(prior, weights);
    expect(grouped.estimate).toBe(8);
    expect(grouped.conditionalSamplingMoe).toBeCloseTo(3.2, 12);
    expect(grouped.missingMoeCells).toEqual([]); // unresolved20% does not invent missing ACS MOE.
    pack.tracts[0].cells.B08132_022.marginOfError = {
      value: null,
      raw: "-222222222",
      annotation: null,
      status: "uncomputable",
    };
    prior = buildTrafficCommutePrior(pack, recipe);
    expect(trafficCommuteSamplingMoe(prior, weights)).toMatchObject({
      estimate: 8,
      conditionalSamplingMoe: null,
      missingMoeCells: ["04013000100:B08132_022"],
    });
    expect(() =>
      trafficCommuteSamplingMoe(prior, [...weights, ...weights]),
    ).toThrow(/more than once/);
  });
  it("rounds one admitted total with deterministic ties, preserving tiny masses and refusing capacity truncation", () => {
    const rows = [
      { id: "b", expectedVehicles: 0.6 },
      { id: "a", expectedVehicles: 0.6 },
      { id: "c", expectedVehicles: 0.6 },
    ];
    const result = roundTrafficCommuteMass(rows, 2);
    expect(result.vehicles).toBe(2);
    expect(result.rows.map((r) => r.vehicles)).toEqual([1, 1, 0]);
    expect(result.rows.reduce((n, r) => n + r.roundingDelta, 0)).toBeCloseTo(
      result.roundingDelta,
      12,
    );
    expect(roundTrafficCommuteMass([...rows].reverse(), 2)).toEqual(result);
    expect(
      roundTrafficCommuteMass([{ id: "a", expectedVehicles: 1e-12 }], 0),
    ).toMatchObject({
      expectedVehicles: 1e-12,
      vehicles: 0,
      roundingDelta: -1e-12,
    });
    expect(() => roundTrafficCommuteMass(rows, 1)).toThrow(/COMMUTE_CAPACITY/);
    expect(() =>
      roundTrafficCommuteMass([{ id: "a", expectedVehicles: NaN }], 10),
    ).toThrow();
  });
});

async function routedFixture() {
  const { pack, recipe } = trafficCommuteFixture();
  recipe.period.beginSeconds = 28800;
  recipe.period.endSeconds = 32400;
  recipe.period.warmupSeconds = 1800;
  const prior = buildTrafficCommutePrior(pack, recipe),
    network = trafficNetworkFixture();
  const routes: TrafficCommuteRouteSet = {
    version: 1,
    sourcePackHash: await trafficCommuteContentHash(pack),
    priorHash: await trafficCommuteContentHash(prior),
    regionalGraphHash: "a".repeat(64),
    regionalSettingsHash: "b".repeat(64),
    localNetworkHash: network.manifest.networkFileSha256,
    localInventoryHash: await trafficContentHash(network),
    attachments: pack.flows.map((f) => ({
      flowId: f.id,
      status: "routed",
      regionalRouteHash: "c".repeat(64),
      regionalSeconds: 1200.5,
      local: {
        edges: ["in", "top", "topjoin", "out"],
        prefixSeconds: 900.25,
        suffixSeconds: 100.125,
        classification: "through",
        bindingHash: "d".repeat(64),
        departLaneId: "in_0",
        departPositionMeters: 12.5,
        arrivalLaneId: "out_0",
        arrivalPositionMeters: 87.75,
      },
      notes: ["Synthetic route proof."],
    })),
    notes: [],
  };
  return { pack, recipe, prior, network, routes };
}

describe("regional route to local commute demand compiler", () => {
  it("accounts for routes arriving after the entire local period without moving departures to a boundary", async () => {
    const f = await routedFixture();
    for (const route of f.routes.attachments) {
      route.regionalSeconds = 21000;
      route.local!.prefixSeconds = 20000.125;
    }
    const result = await compileTrafficCommuteDemand(
      f.prior,
      f.routes,
      f.network,
      { sourcePack: f.pack },
    );
    expect(result.demand.rows).toEqual([]);
    expect(result.totals).toMatchObject({
      sourceVehicles: 30,
      admittedExpectedVehicles: 0,
      afterWindowVehicles: 24,
      beforeWindowVehicles: 0,
      knownUnresolvedSourceVehicles: 6,
      conservationResidual: 0,
    });
    expect(result.ledger[0].entryBeginSeconds).toBe(45200.125);
    expect(
      result.ledger.every(
        (row) => row.admittedBeginSeconds === null && row.demandRowId === null,
      ),
    ).toBe(true);
  });
  it("shifts home departures by exact fractional prefix time, conserves window losses and retains lane endpoints", async () => {
    const f = await routedFixture();
    const result = await compileTrafficCommuteDemand(
      f.prior,
      f.routes,
      f.network,
      { sourcePack: f.pack },
    );
    const expected = 16 + (8 * 900.25) / 1800;
    expect(result.totals.admittedExpectedVehicles).toBeCloseTo(expected, 12);
    expect(result.totals.beforeWindowVehicles).toBeCloseTo(24 - expected, 12);
    expect(result.totals.afterWindowVehicles).toBe(0);
    expect(result.totals.knownUnresolvedSourceVehicles).toBe(6);
    expect(result.totals.conservationResidual).toBeCloseTo(0, 12);
    expect(
      result.totals.warmupExpectedVehicles +
        result.totals.measurementExpectedVehicles,
    ).toBeCloseTo(expected, 12);
    expect(result.totals.vehicles).toBe(20);
    expect(result.demand.rows.map((r) => r.vehicles)).toEqual([2, 8, 2, 8]);
    expect(result.demand.rows[1].beginSeconds).toBe(27900.25);
    expect(result.demand.rows[1].endpoints).toEqual({
      departLaneId: "in_0",
      departPositionMeters: 12.5,
      arrivalLaneId: "out_0",
      arrivalPositionMeters: 87.75,
    });
    expect(result.ledger).toHaveLength(4);
    expect(result.coverage.status).toBe("partial");
    expect(
      result.demand.rows.every(
        (r) => r.purpose === "commute" && r.quality === "inferred",
      ),
    ).toBe(true);
  });
  it("separates proven no-local intersection from unresolved routing and preserves every source pair", async () => {
    const f = await routedFixture();
    f.routes.attachments[0].status = "no-local-intersection";
    f.routes.attachments[0].local = null;
    f.routes.attachments[1].status = "unmatched-local-network";
    f.routes.attachments[1].local = null;
    const result = await compileTrafficCommuteDemand(
      f.prior,
      f.routes,
      f.network,
      { sourcePack: f.pack },
    );
    expect(result.totals).toMatchObject({
      admittedExpectedVehicles: 0,
      vehicles: 0,
      noLocalIntersectionVehicles: 12,
      unresolvedRouteVehicles: 12,
      knownUnresolvedSourceVehicles: 6,
      conservationResidual: 0,
    });
    expect(result.demand.rows).toEqual([]);
    expect(result.ledger).toHaveLength(4);
    expect(result.coverage.routeStatusCounts["unmatched-local-network"]).toBe(
      1,
    );
    f.routes.attachments.pop();
    await expect(
      compileTrafficCommuteDemand(f.prior, f.routes, f.network, {
        sourcePack: f.pack,
      }),
    ).rejects.toThrow(/exactly one/);
  });
  it("refuses forged prior values, stale source/network identities, duplicate outcomes and invalid endpoint paths", async () => {
    const f = await routedFixture();
    const forged = structuredClone(f.prior);
    forged.flows[0].expectedVehicles++;
    await expect(
      compileTrafficCommuteDemand(
        forged,
        { ...f.routes, priorHash: await trafficCommuteContentHash(forged) },
        f.network,
        { sourcePack: f.pack },
      ),
    ).rejects.toThrow(/reproduce/);
    await expect(
      compileTrafficCommuteDemand(
        f.prior,
        { ...f.routes, sourcePackHash: "e".repeat(64) },
        f.network,
        { sourcePack: f.pack },
      ),
    ).rejects.toThrow(/identity/);
    await expect(
      compileTrafficCommuteDemand(
        f.prior,
        { ...f.routes, localInventoryHash: "e".repeat(64) },
        f.network,
        { sourcePack: f.pack },
      ),
    ).rejects.toThrow(/identity/);
    const duplicate = structuredClone(f.routes);
    duplicate.attachments[1] = structuredClone(duplicate.attachments[0]);
    await expect(
      compileTrafficCommuteDemand(f.prior, duplicate, f.network, {
        sourcePack: f.pack,
      }),
    ).rejects.toThrow(/unique/);
    const bad = structuredClone(f.routes);
    bad.attachments[0].local!.departPositionMeters = 100;
    await expect(
      compileTrafficCommuteDemand(f.prior, bad, f.network, {
        sourcePack: f.pack,
      }),
    ).rejects.toThrow(/lane lengths/);
    bad.attachments[0].local!.departPositionMeters = 10;
    bad.attachments[0].local!.edges = ["in", "out"];
    await expect(
      compileTrafficCommuteDemand(f.prior, bad, f.network, {
        sourcePack: f.pack,
      }),
    ).rejects.toThrow(/connection/);
  });
  it("retains rounded-zero contributions and rejects native-cap excess without changing fractional data", async () => {
    const f = await routedFixture();
    f.pack.tracts[0].cells.B08132_022.estimate = {
      value: 1,
      raw: "1",
      annotation: null,
      status: "available",
    };
    f.pack.tracts[0].cells.B08132_023.estimate = {
      value: 0,
      raw: "0",
      annotation: null,
      status: "available",
    };
    f.prior = buildTrafficCommutePrior(f.pack, f.recipe);
    f.routes.priorHash = await trafficCommuteContentHash(f.prior);
    f.routes.sourcePackHash = await trafficCommuteContentHash(f.pack);
    const result = await compileTrafficCommuteDemand(
      f.prior,
      f.routes,
      f.network,
      { sourcePack: f.pack },
    );
    expect(result.demand.rows).toEqual([]);
    expect(result.ledger).toHaveLength(4);
    expect(result.totals.admittedExpectedVehicles).toBeGreaterThan(0);
    expect(result.ledger.every((r) => r.demandRowId === null)).toBe(true);
    const large = await routedFixture();
    await expect(
      compileTrafficCommuteDemand(large.prior, large.routes, large.network, {
        sourcePack: large.pack,
        maximumVehicles: 19,
      }),
    ).rejects.toThrow(/COMMUTE_CAPACITY/);
    await expect(
      compileTrafficCommuteDemand(large.prior, large.routes, large.network, {
        sourcePack: large.pack,
        maximumVehicles: 30001,
      }),
    ).rejects.toThrow(/30,000/);
  });
  it("requires explicit route outcomes even when ACS cells are missing and never claims zero total demand", async () => {
    const f = await routedFixture();
    for (const id of f.recipe.departureCellIds)
      f.pack.tracts[0].cells[id].estimate = {
        value: null,
        raw: "",
        annotation: null,
        status: "missing",
      };
    f.prior = buildTrafficCommutePrior(f.pack, f.recipe);
    f.routes.priorHash = await trafficCommuteContentHash(f.prior);
    f.routes.sourcePackHash = await trafficCommuteContentHash(f.pack);
    const result = await compileTrafficCommuteDemand(
      f.prior,
      f.routes,
      f.network,
      { sourcePack: f.pack },
    );
    expect(result.totals.sourceVehicles).toBeNull();
    expect(result.totals.knownSourceVehicles).toBeNull();
    expect(result.coverage).toMatchObject({
      selectedNativeFlows: 2,
      unknownEstimateCells: 2,
      status: "partial",
    });
    f.routes.attachments = [];
    await expect(
      compileTrafficCommuteDemand(f.prior, f.routes, f.network, {
        sourcePack: f.pack,
      }),
    ).rejects.toThrow(/exactly one/);
  });
  it("hashes deterministic output across route input order while retaining route artifact identity", async () => {
    const f = await routedFixture();
    const first = await compileTrafficCommuteDemand(
      f.prior,
      f.routes,
      f.network,
      { sourcePack: f.pack },
    );
    f.routes.attachments.reverse();
    const reversed = await compileTrafficCommuteDemand(
      f.prior,
      f.routes,
      f.network,
      { sourcePack: f.pack },
    );
    expect(reversed.demand).toEqual(first.demand);
    expect(reversed.ledger).toEqual(first.ledger);
    expect(reversed.demandHash).toBe(first.demandHash);
    expect(reversed.routesHash).not.toBe(first.routesHash); // Captured artifact order remains part of its own identity.
  });
});
