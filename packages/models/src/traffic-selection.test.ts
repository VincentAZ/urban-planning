import { describe, expect, it } from "vitest";
import type {
  TrafficCalibrationPlan,
  TrafficCount,
  TrafficPeriod,
} from "@urban/core";
import {
  trafficCalibrationFixture,
  trafficCountFixture,
  trafficFixturePeriod,
  trafficNetworkFixture,
} from "../../core/src/traffic-fixture";
import {
  inspectTrafficCalibrationSelection,
  trafficCalibrationGroupKey,
  trafficCalibrationSelectionGroups,
  trafficCountInPeriod,
} from "./traffic-selection";
import { evaluateTrafficCalibration } from "./traffic";

const inspect = (
  pack = trafficCountFixture(),
  plan = trafficCalibrationFixture(),
  period = trafficFixturePeriod,
) =>
  inspectTrafficCalibrationSelection(
    pack,
    plan,
    trafficNetworkFixture(),
    period,
  );

describe("new baseline count-check plan selection", () => {
  it("accepts separate eligible groups without inventing predictions or mutating evidence", () => {
    const pack = trafficCountFixture(),
      plan = trafficCalibrationFixture();
    pack.counts[0].value = 0;
    const before = structuredClone({ pack, plan });
    const report = inspect(pack, plan);
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.rows.map((row) => [row.role, row.eligible])).toEqual([
      ["calibration", true],
      ["holdout", true],
    ]);
    expect(report.groups.map((group) => group.selectedCountIds)).toEqual([
      ["count-0"],
      ["count-1"],
    ]);
    expect(report.warnings.join(" ")).toMatch(
      /not proof of statistical independence/,
    );
    expect(report.warnings.join(" ")).toMatch(/no automatic fitting/);
    expect({ pack, plan }).toEqual(before);
    // Native detector evidence is still required by the unchanged legacy evaluator.
    expect(
      evaluateTrafficCalibration(
        pack,
        [],
        plan,
        trafficNetworkFixture(),
        trafficFixturePeriod,
      ).status,
    ).toBe("incomplete");
  });

  it("blocks adjacent hours at one station across source aliases, lanes and disjoint vehicle classes", () => {
    const pack = trafficCountFixture();
    const first = pack.counts[0],
      second = pack.counts[1];
    first.stationId = " Station-A ";
    second.stationId = "station-a";
    second.beginSeconds = first.endSeconds;
    second.endSeconds = trafficFixturePeriod.endSeconds;
    second.raw.laneCode = "7";
    second.vehicleClasses = ["truck"];
    pack.sources.push({ ...pack.sources[0], id: "alias-source" });
    second.sourceIds = ["alias-source"];
    const result = inspect(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cannot be split/);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      countIds: ["count-0", "count-1"],
      role: "conflict",
    });
    expect(trafficCalibrationGroupKey(first)).toBe(
      trafficCalibrationGroupKey(second),
    );
  });

  it("merges reviewed physical aliases while preserving distinct raw station identifiers", () => {
    const pack = trafficCountFixture();
    pack.counts[1].target = {
      kind: "edge",
      edgeId: "in",
      positionFraction: 0.9,
    };
    pack.counts[1].beginSeconds = pack.counts[0].endSeconds;
    pack.counts[1].endSeconds = trafficFixturePeriod.endSeconds;
    expect(inspect(pack).errors.join(" ")).toMatch(/cannot be split/);
    const group = trafficCalibrationSelectionGroups(
      pack,
      trafficNetworkFixture(),
      trafficFixturePeriod,
    )[0];
    expect(group.stationIds).toEqual(["fixture-0", "fixture-1"]);
    // A stale or still-unreviewed target is not evidence that differently named stations are aliases.
    delete pack.counts[1].mapping;
    expect(inspect(pack).groups).toHaveLength(2);
    expect(inspect(pack).rows[1]).toMatchObject({ eligible: false });
  });

  it("does not guess that nearby similarly named stations are aliases", () => {
    const pack = trafficCountFixture();
    pack.counts[0].stationId = "0F0085";
    pack.counts[1].stationId = "F0085n";
    pack.counts.forEach((count) => {
      count.position = [-112, 33];
    });
    expect(inspect(pack).valid).toBe(true);
    expect(inspect(pack).groups).toHaveLength(2);
  });

  it("groups explicitly locally reviewed aliases without inventing mapping stamps or eligibility", () => {
    const pack = trafficCountFixture();
    pack.counts.forEach((count) => {
      delete count.mapping;
    });
    pack.counts[1].target = {
      kind: "edge",
      edgeId: "in",
      positionFraction: 0.9,
    };
    pack.counts[1].beginSeconds = pack.counts[0].endSeconds;
    pack.counts[1].endSeconds = trafficFixturePeriod.endSeconds;
    const before = structuredClone(pack);
    expect(inspect(pack).valid).toBe(true);
    expect(inspect(pack).groups).toHaveLength(2);
    const context = { pendingMappingCountIds: ["count-0", "count-1"] };
    const report = inspectTrafficCalibrationSelection(
      pack,
      trafficCalibrationFixture(),
      trafficNetworkFixture(),
      trafficFixturePeriod,
      context,
    );
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/cannot be split/);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].eligibleCountIds).toEqual([]);
    expect(
      report.rows.every(
        (row) =>
          !row.eligible &&
          row.reasons.includes("Network mapping review is pending."),
      ),
    ).toBe(true);
    expect(
      trafficCalibrationSelectionGroups(
        pack,
        trafficNetworkFixture(),
        trafficFixturePeriod,
        context,
      )[0].countIds,
    ).toEqual(["count-0", "count-1"]);
    expect(pack).toEqual(before);
    pack.counts[1].target = {
      kind: "edge",
      edgeId: "absent",
      positionFraction: 0.5,
    };
    expect(
      trafficCalibrationSelectionGroups(
        pack,
        trafficNetworkFixture(),
        trafficFixturePeriod,
        context,
      ),
    ).toHaveLength(2);
  });

  it("keeps FHWA combined direction 9 with individually directed station observations", () => {
    const pack = trafficCountFixture();
    pack.counts[1].stationId = pack.counts[0].stationId;
    pack.counts[1].raw.directionCode = "9";
    const report = inspect(pack);
    expect(report.groups).toHaveLength(1);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/cannot be split/);
    expect(pack.counts[1].raw.directionCode).toBe("9");
  });

  it("joins unknown direction with all station directions but keeps distinct known directions separate", () => {
    const pack = trafficCountFixture();
    pack.counts[1].stationId = pack.counts[0].stationId;
    pack.counts[1].raw.directionCode = "5";
    expect(inspect(pack).groups).toHaveLength(2);
    const unknown = structuredClone(pack.counts[0]);
    unknown.id = "unknown-direction";
    unknown.raw.directionCode = "";
    unknown.target = null;
    delete unknown.mapping;
    pack.counts.push(unknown);
    const report = inspect(pack);
    expect(report.groups).toHaveLength(1);
    expect(report.errors.join(" ")).toMatch(/cannot be split/);
    expect(report.groups[0].countIds).toContain("unknown-direction");
  });

  it.each(["duplicate", "both", "unknown", "duplicate-pack"] as const)(
    "blocks %s count identity ambiguity",
    (kind) => {
      const pack = trafficCountFixture(),
        plan = trafficCalibrationFixture();
      if (kind === "duplicate") plan.calibrationCountIds.push("count-0");
      if (kind === "both") plan.holdoutCountIds.push("count-0");
      if (kind === "unknown") plan.holdoutCountIds = ["nonexistent"];
      if (kind === "duplicate-pack")
        pack.counts.push(structuredClone(pack.counts[0]));
      expect(inspect(pack, plan).valid).toBe(false);
      expect(inspect(pack, plan).errors.length).toBeGreaterThan(0);
    },
  );

  it.each(["date", "zone", "offset", "partial", "infinite"] as const)(
    "rejects selected %s clock/window mismatches without clipping",
    (kind) => {
      const pack = trafficCountFixture(),
        count = pack.counts[0];
      if (kind === "date") count.date = "2026-01-13";
      if (kind === "zone") count.timeZone = "US/Arizona";
      if (kind === "offset") count.utcOffsetMinutes = -360;
      if (kind === "partial")
        count.beginSeconds = trafficFixturePeriod.beginSeconds - 1;
      if (kind === "infinite") count.endSeconds = Infinity;
      expect(trafficCountInPeriod(count, trafficFixturePeriod)).toBe(false);
      const result = inspect(pack);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/exact date/);
      expect(
        result.rows.find((row) => row.countId === count.id)?.eligible,
      ).toBe(false);
    },
  );

  it("rejects a period spanning an actual IANA offset transition", () => {
    const period: TrafficPeriod = {
      ...trafficFixturePeriod,
      date: "2026-03-08",
      timeZone: "America/Denver",
      beginSeconds: 3600,
      endSeconds: 14400,
      warmupSeconds: 0,
      cooldownSeconds: 0,
    };
    const pack = trafficCountFixture();
    pack.counts.forEach((count) =>
      Object.assign(count, {
        date: period.date,
        timeZone: period.timeZone,
        beginSeconds: 3600,
        endSeconds: 7200,
      }),
    );
    expect(inspect(pack, trafficCalibrationFixture(), period).valid).toBe(
      false,
    );
  });

  it.each([
    "missing",
    "excluded",
    "factored",
    "classes",
    "pending",
    "stale",
    "absent-edge",
  ] as const)(
    "allows incomplete %s evidence with explicit ineligibility",
    (kind) => {
      const pack = trafficCountFixture(),
        count = pack.counts[0];
      if (kind === "missing") {
        count.status = "missing";
        count.value = null;
      }
      if (kind === "excluded") count.status = "excluded";
      if (kind === "factored") count.kind = "factored";
      if (kind === "classes") count.vehicleClasses = null;
      if (kind === "pending") delete count.mapping;
      if (kind === "stale") count.mapping!.networkFileSha256 = "f".repeat(64);
      if (kind === "absent-edge")
        count.target = {
          kind: "edge",
          edgeId: "absent",
          positionFraction: 0.5,
        };
      const report = inspect(pack);
      expect(report.valid).toBe(true);
      expect(report.rows[0].eligible).toBe(false);
      expect(report.rows[0].reasons.length).toBeGreaterThan(0);
      expect(report.warnings.join(" ")).toMatch(
        /Incomplete evidence cannot yield a passing/,
      );
    },
  );

  it.each(["absent", "duplicate", "blank", "invalid-criteria"] as const)(
    "requires retained unambiguous criteria and explanation: %s",
    (kind) => {
      const pack = trafficCountFixture(),
        plan = trafficCalibrationFixture();
      if (kind === "absent") plan.sourceIds = ["not-retained"];
      if (kind === "duplicate") pack.sources.push({ ...pack.sources[0] });
      if (kind === "blank") plan.description = " \n ";
      if (kind === "invalid-criteria")
        plan.criteria.requiredPassingFraction = 1.01;
      expect(inspect(pack, plan).valid).toBe(false);
    },
  );

  it("blocks overlapping physical count constraints inside one role, but permits nonoverlapping classes", () => {
    const pack = trafficCountFixture(),
      plan = trafficCalibrationFixture();
    const extra: TrafficCount = {
      ...structuredClone(pack.counts[0]),
      id: "copy",
      stationId: "alias",
    };
    pack.counts.push(extra);
    plan.calibrationCountIds.push(extra.id);
    expect(inspect(pack, plan).errors.join(" ")).toMatch(/overlap in time/);
    extra.vehicleClasses = ["truck"];
    expect(inspect(pack, plan).valid).toBe(true);
  });

  it("keeps group keys/membership stable across row ordering and selects only the exact period", () => {
    const pack = trafficCountFixture();
    pack.counts.push({
      ...structuredClone(pack.counts[0]),
      id: "later",
      beginSeconds: 32400,
      endSeconds: 36000,
    });
    const first = inspect(pack);
    pack.counts.reverse();
    expect(inspect(pack)).toEqual(first);
    expect(first.rows.some((row) => row.countId === "later")).toBe(false);
    expect(first.groups.flatMap((group) => group.countIds)).not.toContain(
      "later",
    );
    const empty: TrafficCalibrationPlan = {
      ...trafficCalibrationFixture(),
      calibrationCountIds: [],
      holdoutCountIds: [],
    };
    const unassigned = inspect(pack, empty);
    expect(unassigned.valid).toBe(true);
    expect(
      unassigned.groups.every((group) => group.role === "unassigned"),
    ).toBe(true);
    expect(unassigned.warnings.join(" ")).toMatch(/minimum 1/);
  });
});
