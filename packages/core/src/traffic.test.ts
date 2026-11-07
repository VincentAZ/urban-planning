import { describe, it, expect } from "vitest";
import {
  validateTrafficNetwork,
  validateTrafficDemand,
  validateTrafficCountPack,
  trafficCountPackSchema,
  trafficPeriodSchema,
  trafficOverlaySchema,
  trafficContentHash,
  trafficPairRecipeHash,
} from "./index";
import {
  trafficNetworkFixture,
  trafficDemandFixture,
  trafficCountFixture,
  trafficFixturePeriod,
  trafficRecipeFixture,
} from "./traffic-fixture";

describe("standalone traffic contracts", () => {
  it("preserves multiple movements per signal index and validates actual lane/junction references", () => {
    const network = trafficNetworkFixture();
    expect(() => validateTrafficNetwork(network)).not.toThrow();
    network.connections[1].toLane = "top_0";
    expect(() => validateTrafficNetwork(network)).toThrow(
      /incident edges and lanes/,
    );
  });
  it("rejects duplicate graph identities and signal phase/index mismatches", () => {
    const n = trafficNetworkFixture();
    n.edges.push(structuredClone(n.edges[0]));
    expect(() => validateTrafficNetwork(n)).toThrow(/Duplicate edge/);
    const s = trafficNetworkFixture();
    s.signals[0].phases[0].state = "GG";
    expect(() => validateTrafficNetwork(s)).toThrow(/phase length/);
    const c = trafficNetworkFixture();
    c.connections[0].signalIndex = 2;
    expect(() => validateTrafficNetwork(c)).toThrow(/signal index/);
  });
  it("rejects paths that cross geometric neighbors without a permitted lane connection", () => {
    const n = trafficNetworkFixture(),
      d = trafficDemandFixture();
    expect(() =>
      validateTrafficDemand(d, n, trafficFixturePeriod),
    ).not.toThrow();
    n.connections = n.connections.filter((c) => c.fromEdge !== "top");
    expect(() => validateTrafficDemand(d, n, trafficFixturePeriod)).toThrow(
      /absent or prohibited connection/,
    );
  });
  it("does not infer class permission from a different lane on the same edge", () => {
    const n = trafficNetworkFixture(),
      d = trafficDemandFixture();
    n.edges[1].lanes[0].allowedClasses = ["truck"];
    n.edges[1].lanes.push({
      ...n.edges[1].lanes[0],
      id: "top_1",
      index: 1,
      allowedClasses: ["passenger"],
    });
    expect(() => validateTrafficDemand(d, n)).toThrow(
      /absent or prohibited connection/,
    );
  });
  it("preserves observed zeros and missing values separately, and requires reviewed graph-bound count targets", () => {
    const p = trafficCountFixture();
    p.counts[0].value = 0;
    expect(() =>
      validateTrafficCountPack(p, trafficNetworkFixture()),
    ).not.toThrow();
    p.counts[0].status = "missing";
    expect(() => trafficCountPackSchema.parse(p)).toThrow(
      /missing counts require null/,
    );
    p.counts[0].value = null;
    expect(() =>
      validateTrafficCountPack(p, trafficNetworkFixture()),
    ).not.toThrow();
    p.counts[1].mapping!.networkFileSha256 = "b".repeat(64);
    expect(() => validateTrafficCountPack(p, trafficNetworkFixture())).toThrow(
      /different network/,
    );
    delete p.counts[1].mapping;
    expect(() => trafficCountPackSchema.parse(p)).toThrow(
      /reviewed network binding/,
    );
  });
  it("retains unmapped source records and separate annual averages without manufacturing hourly assignments", () => {
    const p = trafficCountFixture();
    p.counts[0].target = null;
    delete p.counts[0].mapping;
    p.counts[0].vehicleClasses = null;
    p.annualCounts = [
      {
        id: "aadt",
        stationId: "fixture",
        position: null,
        year: 2025,
        value: 12345,
        status: "available",
        direction: "both",
        sourceIds: p.counts[0].sourceIds,
        notes: [],
      },
    ];
    expect(trafficCountPackSchema.parse(p)).toEqual(p);
    expect(() =>
      validateTrafficCountPack(p, trafficNetworkFixture()),
    ).not.toThrow();
  });
  it("requires correct fixed-offset civil time and rejects DST crossings instead of inventing an hour", () => {
    expect(() => trafficPeriodSchema.parse(trafficFixturePeriod)).not.toThrow();
    expect(() =>
      trafficPeriodSchema.parse({
        ...trafficFixturePeriod,
        utcOffsetMinutes: 0,
      }),
    ).toThrow(/UTC offset/);
    expect(() =>
      trafficPeriodSchema.parse({
        ...trafficFixturePeriod,
        date: "2026-03-08",
        timeZone: "America/New_York",
        utcOffsetMinutes: -300,
        beginSeconds: 3600,
        endSeconds: 14400,
        warmupSeconds: 0,
        cooldownSeconds: 0,
      }),
    ).toThrow(/offset change/);
    expect(() =>
      trafficPeriodSchema.parse({
        ...trafficFixturePeriod,
        date: "2026-02-31",
      }),
    ).toThrow();
  });
  it("rejects unsupported edits rather than silently dropping topology changes", () => {
    expect(() =>
      trafficOverlaySchema.parse({ edgeId: "in", closed: true }),
    ).not.toThrow();
    expect(() =>
      trafficOverlaySchema.parse({ edgeId: "in", turns: [] }),
    ).toThrow();
    expect(() =>
      trafficOverlaySchema.parse({ edgeId: "in", lanes: 0 }),
    ).toThrow();
  });
  it("binds paired hashes to network, period, seed, counts and settings while ignoring object property order", async () => {
    const r = trafficRecipeFixture(),
      h = await trafficPairRecipeHash(r);
    for (const changed of [
      { ...r, seed: 43 },
      { ...r, countPackHash: "0".repeat(64) },
      { ...r, period: { ...r.period, endSeconds: 33000 } },
      { ...r, settingsHash: "9".repeat(64) },
    ])
      expect(await trafficPairRecipeHash(changed)).not.toBe(h);
    expect(await trafficContentHash({ a: 1, b: 2 })).toBe(
      await trafficContentHash({ b: 2, a: 1 }),
    );
  });
});
