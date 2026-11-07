import { describe, expect, it } from "vitest";
import {
  trafficPairRecipeHash,
  type TrafficCountPrediction,
} from "@urban/core";
import {
  trafficNetworkFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
  trafficCountFixture,
  trafficCalibrationFixture,
  trafficResultFixture,
  trafficRecipeFixture,
} from "../../core/src/traffic-fixture";
import {
  allocateTrafficVehicles,
  evaluateTrafficCalibration,
  summarizeTrafficRun,
  compareTrafficRuns,
} from "./traffic";

const predictions = (
  a: number | null = 3,
  b: number | null = 4,
): TrafficCountPrediction[] =>
  [a, b].map((vehicles, i) => ({
    countId: `count-${i}`,
    vehicles,
    status: vehicles === null ? "unavailable" : "available",
  }));

describe("explicit traffic demand", () => {
  it("conserves integer OD demand and deterministic route/departure draws across input ordering", () => {
    const demand = trafficDemandFixture(),
      before = structuredClone(demand),
      network = trafficNetworkFixture();
    const first = allocateTrafficVehicles(
      demand,
      network,
      42,
      trafficFixturePeriod,
    );
    demand.candidateRoutes.reverse();
    expect(
      allocateTrafficVehicles(demand, network, 42, trafficFixturePeriod),
    ).toEqual(first);
    expect(first.vehicles).toHaveLength(7);
    expect(first.routeCounts).toEqual([
      { odId: "commute", routeId: "lower", vehicles: 3 },
      { odId: "commute", routeId: "upper", vehicles: 4 },
    ]);
    expect(new Set(first.vehicles.map((v) => v.id)).size).toBe(7);
    expect(
      first.vehicles.every(
        (v) => v.departSeconds >= 28800 && v.departSeconds < 32400,
      ),
    ).toBe(true);
    expect(
      first.vehicles.every(
        (v) => v.edges[0] === "in" && v.edges.at(-1) === "out",
      ),
    ).toBe(true);
    expect(allocateTrafficVehicles(before, network, 43).vehicles).not.toEqual(
      first.vehicles,
    );
    demand.candidateRoutes.reverse();
    expect(demand).toEqual(before);
  });
  it("retains warmup demand and separate classes without converting daily trip ends", () => {
    const d = trafficDemandFixture();
    d.rows.push({
      ...d.rows[0],
      id: "freight",
      vehicleClass: "truck",
      vehicles: 2,
      beginSeconds: 28000,
      endSeconds: 28800,
    });
    d.candidateRoutes.push({
      ...d.candidateRoutes[0],
      id: "freight-route",
      odId: "freight",
      weight: 1,
    });
    const r = allocateTrafficVehicles(
      d,
      trafficNetworkFixture(),
      0,
      trafficFixturePeriod,
    );
    expect(r.vehicles).toHaveLength(9);
    expect(r.vehicles.filter((v) => v.vehicleClass === "truck")).toHaveLength(
      2,
    );
    expect(
      r.vehicles
        .filter((v) => v.odId === "freight")
        .every((v) => v.departSeconds < 28800),
    ).toBe(true);
  });
  it("preserves true zero demand, rejects fractional or unsupported routed demand instead of rounding/dropping", () => {
    const d = trafficDemandFixture();
    d.rows[0].vehicles = 0;
    d.candidateRoutes = [];
    expect(
      allocateTrafficVehicles(d, trafficNetworkFixture(), 1).vehicles,
    ).toEqual([]);
    d.rows[0].vehicles = 0.5;
    expect(() =>
      allocateTrafficVehicles(d, trafficNetworkFixture(), 1),
    ).toThrow();
    d.rows[0].vehicles = 1;
    expect(() =>
      allocateTrafficVehicles(d, trafficNetworkFixture(), 1),
    ).toThrow(/positive candidate-route weight/);
  });
  it("bounds total vehicles and preserves deterministic equal-weight tie handling", () => {
    const d = trafficDemandFixture();
    d.rows[0].vehicles = 1;
    d.candidateRoutes.forEach((r) => (r.weight = 1));
    expect(
      allocateTrafficVehicles(d, trafficNetworkFixture(), 3).routeCounts.map(
        (r) => r.vehicles,
      ),
    ).toEqual([1, 0]);
    d.rows[0].vehicles = 250001;
    expect(() =>
      allocateTrafficVehicles(d, trafficNetworkFixture(), 3),
    ).toThrow();
  });
});

describe("interval-count calibration and independent evaluation", () => {
  it("normalizes the actual quarter-hour interval and computes known GEH without treating AADT as an observation", () => {
    const p = trafficCountFixture();
    p.annualCounts = [
      {
        id: "annual",
        stationId: "fixture",
        position: null,
        year: 2025,
        value: 100000,
        status: "available",
        direction: "both",
        sourceIds: p.counts[0].sourceIds,
        notes: [],
      },
    ];
    const r = evaluateTrafficCalibration(
      p,
      predictions(6, 4),
      trafficCalibrationFixture(),
      trafficNetworkFixture(),
      trafficFixturePeriod,
    );
    expect(r.rows[0]).toMatchObject({
      observed: 3,
      modeled: 6,
      observedHourly: 12,
      modeledHourly: 24,
      absoluteHourlyError: 12,
      relativeError: 1,
      passed: true,
    });
    expect(r.rows[0].geh).toBeCloseTo(Math.sqrt(8), 12);
    expect(r.status).toBe("passed");
    expect(r.scope).toBe("interval-count-fit");
  });
  it("distinguishes measured zero from missing and does not invent percentage errors over zero", () => {
    const p = trafficCountFixture();
    p.counts[0].value = 0;
    const zero = evaluateTrafficCalibration(
      p,
      predictions(0),
      trafficCalibrationFixture(),
      trafficNetworkFixture(),
      trafficFixturePeriod,
    );
    expect(zero.rows[0]).toMatchObject({
      geh: 0,
      relativeError: 0,
      observedHourly: 0,
      modeledHourly: 0,
    });
    const positive = evaluateTrafficCalibration(
      p,
      predictions(1),
      trafficCalibrationFixture(),
      trafficNetworkFixture(),
      trafficFixturePeriod,
    );
    expect(positive.rows[0].relativeError).toBeNull();
    expect(positive.rows[0].geh).toBeCloseTo(Math.sqrt(8));
    p.counts[0].status = "missing";
    p.counts[0].value = null;
    const missing = evaluateTrafficCalibration(
      p,
      predictions(0),
      trafficCalibrationFixture(),
      trafficNetworkFixture(),
      trafficFixturePeriod,
    );
    expect(missing.rows[0].passed).toBeNull();
    expect(missing.calibration).toMatchObject({
      evaluated: 0,
      unavailable: 1,
      status: "incomplete",
    });
  });
  it.each(["factored", "unmapped", "classes", "date", "prediction"] as const)(
    "withholds calibration for %s evidence",
    (kind) => {
      const p = trafficCountFixture(),
        pred = predictions();
      if (kind === "factored") p.counts[0].kind = "factored";
      if (kind === "unmapped") {
        p.counts[0].target = null;
        delete p.counts[0].mapping;
      }
      if (kind === "classes") p.counts[0].vehicleClasses = null;
      if (kind === "date") p.counts[0].date = "2026-01-13";
      if (kind === "prediction") {
        pred[0].vehicles = null;
        pred[0].status = "unavailable";
      }
      const r = evaluateTrafficCalibration(
        p,
        pred,
        trafficCalibrationFixture(),
        trafficNetworkFixture(),
        trafficFixturePeriod,
      );
      expect(r.status).toBe("incomplete");
      expect(r.rows[0].passed).toBeNull();
      expect(r.rows[0].reason).toBeTruthy();
    },
  );
  it("does not certify a fit from training data when held-out evidence fails or is absent", () => {
    const p = trafficCountFixture(),
      plan = trafficCalibrationFixture();
    const r = evaluateTrafficCalibration(
      p,
      predictions(3, 100),
      plan,
      trafficNetworkFixture(),
      trafficFixturePeriod,
    );
    expect(r.calibration.status).toBe("passed");
    expect(r.holdout.status).toBe("failed");
    expect(r.status).toBe("failed");
    plan.holdoutCountIds = [];
    expect(
      evaluateTrafficCalibration(
        p,
        predictions(),
        plan,
        trafficNetworkFixture(),
        trafficFixturePeriod,
      ).status,
    ).toBe("incomplete");
  });
  it("rejects held-out duplicates and overlapping total/class/lane constraints", () => {
    const p = trafficCountFixture(),
      plan = trafficCalibrationFixture();
    plan.holdoutCountIds = ["count-0"];
    expect(() =>
      evaluateTrafficCalibration(
        p,
        predictions(),
        plan,
        trafficNetworkFixture(),
        trafficFixturePeriod,
      ),
    ).toThrow(/unique and disjoint/);
    plan.holdoutCountIds = ["count-1"];
    p.counts[1] = {
      ...p.counts[0],
      id: "count-1",
      target: {
        kind: "edge",
        edgeId: "in",
        positionFraction: 0.5,
        laneIds: ["in_0"],
      },
    };
    expect(() =>
      evaluateTrafficCalibration(
        p,
        predictions(),
        plan,
        trafficNetworkFixture(),
        trafficFixturePeriod,
      ),
    ).toThrow(/overlap/);
    p.counts[1].beginSeconds = 29700;
    p.counts[1].endSeconds = 30600;
    expect(() =>
      evaluateTrafficCalibration(
        p,
        predictions(),
        plan,
        trafficNetworkFixture(),
        trafficFixturePeriod,
      ),
    ).not.toThrow();
  });
});

describe("simulation completeness and paired comparisons", () => {
  it("computes complete cohort measures from actual trip records and excludes warmup trips", () => {
    const r = trafficResultFixture();
    r.trips[0].requestedDepartSeconds = 28799;
    r.trips[0].departSeconds = 28799;
    r.trips[0].arrivalSeconds = 28899;
    r.trips[0].durationSeconds = 100;
    r.trips[0].routeLengthMeters = 900;
    const result = summarizeTrafficRun(r);
    expect(result).toMatchObject({
      status: "complete",
      requested: 2,
      completed: 2,
      measurementRequested: 1,
      measurementCompleted: 1,
      meanTravelTimeSeconds: 40,
      vehicleKilometers: 0.4,
    });
    expect(result.vehicleHours).toBeCloseTo(40 / 3600);
    expect(
      Object.keys(result).some((k) =>
        /^(los|commute|intersectionLos)$/i.test(k),
      ),
    ).toBe(false);
  });
  it("keeps incomplete vehicles and censored subtotals rather than reporting a fast completed-only average", () => {
    const r = trafficResultFixture();
    r.diagnostics.arrived = 1;
    r.diagnostics.running = 1;
    Object.assign(r.trips[1], {
      arrived: false,
      arrivalSeconds: null,
      durationSeconds: null,
      routeLengthMeters: null,
      timeLossSeconds: null,
      departDelaySeconds: null,
    });
    const summary = summarizeTrafficRun(r);
    expect(summary).toMatchObject({
      status: "incomplete",
      completionFraction: 0.5,
      meanTravelTimeSeconds: null,
      vehicleKilometers: null,
      completedSubtotal: { meanTravelTimeSeconds: 40, vehicleKilometers: 0.4 },
    });
    r.trips.splice(1);
    expect(summarizeTrafficRun(r).status).toBe("failed");
  });
  it.each(["teleports", "collisions", "routeErrors"] as const)(
    "invalidates complete forecasts when %s occur",
    (key) => {
      const r = trafficResultFixture();
      r.diagnostics[key] = 1;
      expect(summarizeTrafficRun(r)).toMatchObject({
        status: "failed",
        meanTravelTimeSeconds: null,
        vehicleHours: null,
      });
    },
  );
  it("requires conserved admission/completion diagnostics and consistent trip duration", () => {
    const r = trafficResultFixture();
    r.diagnostics.loaded = 1;
    expect(summarizeTrafficRun(r).status).toBe("failed");
    r.diagnostics.loaded = 2;
    r.trips[0].durationSeconds = 39;
    expect(() => summarizeTrafficRun(r)).toThrow(/inconsistent/);
    r.trips[0].durationSeconds = 40;
    r.trips[1].id = r.trips[0].id;
    expect(() => summarizeTrafficRun(r)).toThrow(/Duplicate/);
  });
  it("reports real empty-cohort totals as zero with undefined averages", () => {
    const r = trafficResultFixture();
    r.trips = [];
    for (const key of Object.keys(
      r.diagnostics,
    ) as (keyof typeof r.diagnostics)[])
      r.diagnostics[key] = 0;
    expect(summarizeTrafficRun(r)).toMatchObject({
      status: "complete",
      requested: 0,
      completionFraction: null,
      meanTravelTimeSeconds: null,
      vehicleKilometers: 0,
      vehicleHours: 0,
    });
  });
  it("binds comparisons to paired inputs, permits declared reroutes, and withholds censored deltas", async () => {
    const recipe = trafficRecipeFixture(),
      baseline = trafficResultFixture(),
      proposal = trafficResultFixture("proposal"),
      hash = await trafficPairRecipeHash(recipe);
    baseline.recipeHash = proposal.recipeHash = hash;
    proposal.assignedRoutesHash = "2".repeat(64);
    proposal.trips.forEach((t) => {
      t.arrivalSeconds! += 10;
      t.durationSeconds! += 10;
      t.timeLossSeconds = 10;
    });
    const r = await compareTrafficRuns(baseline, proposal, recipe);
    expect(r.delta.meanTravelTimeSeconds).toBe(10);
    expect(r.delta.meanTimeLossSeconds).toBe(10);
    proposal.trips[0].requestedDepartSeconds++;
    await expect(
      compareTrafficRuns(baseline, proposal, recipe),
    ).rejects.toThrow(/same requested vehicle identities/);
    proposal.trips[0].requestedDepartSeconds--;
    proposal.diagnostics.teleports = 1;
    expect(
      (await compareTrafficRuns(baseline, proposal, recipe)).delta
        .meanTravelTimeSeconds,
    ).toBeNull();
    proposal.seed = 43;
    await expect(
      compareTrafficRuns(baseline, proposal, recipe),
    ).rejects.toThrow(/exact paired/);
  });
});
