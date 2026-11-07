import { describe, expect, it } from "vitest";
import { trafficCalibrationFixture } from "../../../../packages/core/src/traffic-fixture";
import {
  assignTrafficCalibrationGroup,
  newTrafficCalibrationDraft,
  readTrafficCalibrationDraft,
  trafficCalibrationDraft,
} from "./traffic-calibration-draft";

describe("baseline count-check drafts", () => {
  it("keeps no-plan and exact saved criteria, including percentage precision", () => {
    expect(trafficCalibrationDraft(null)).toBeNull();
    expect(readTrafficCalibrationDraft(null)).toBeNull();
    const plan = trafficCalibrationFixture();
    plan.criteria.relativeErrorMaximum = 0.0000001234567891234567;
    plan.description = "  An exact saved study protocol.  ";
    expect(readTrafficCalibrationDraft(trafficCalibrationDraft(plan))).toEqual(
      plan,
    );
    for (const value of [1e-12, 1e21]) {
      plan.criteria.gehMaximum = value;
      plan.criteria.relativeErrorMaximum = value;
      expect(
        readTrafficCalibrationDraft(trafficCalibrationDraft(plan)),
      ).toEqual(plan);
    }
  });
  it("starts without invented agency thresholds and preserves invalid input", () => {
    const draft = newTrafficCalibrationDraft();
    expect(Object.values(draft.criteria).every((value) => value === "")).toBe(
      true,
    );
    expect(() => readTrafficCalibrationDraft(draft)).toThrow("Maximum GEH");
    const valid = trafficCalibrationDraft(trafficCalibrationFixture())!;
    for (const value of ["", "-1", "Infinity", "1e9", "0x10", "a"]) {
      valid.criteria.gehMaximum = value;
      expect(() => readTrafficCalibrationDraft(valid)).toThrow();
      expect(valid.criteria.gehMaximum).toBe(value);
    }
  });
  it("requires meaningful minima, rationale and retained source selection", () => {
    const draft = trafficCalibrationDraft(trafficCalibrationFixture())!;
    for (const value of ["0", "1.5", "9007199254740992"]) {
      draft.criteria.minimumHoldoutCounts = value;
      expect(() => readTrafficCalibrationDraft(draft)).toThrow(
        "positive whole",
      );
    }
    draft.criteria.minimumHoldoutCounts = "1";
    draft.description = " ";
    expect(() => readTrafficCalibrationDraft(draft)).toThrow("rationale");
    draft.description = "Reviewed criteria";
    draft.sourceIds = [];
    expect(() => readTrafficCalibrationDraft(draft)).toThrow("citation");
  });
  it("converts changed percentages once and rejects impossible passing fractions", () => {
    const draft = trafficCalibrationDraft(trafficCalibrationFixture())!;
    draft.criteria.relativeErrorMaximum = "12.5";
    draft.criteria.requiredPassingFraction = "85";
    expect(readTrafficCalibrationDraft(draft)?.criteria).toMatchObject({
      relativeErrorMaximum: 0.125,
      requiredPassingFraction: 0.85,
    });
    draft.criteria.requiredPassingFraction = "100.01";
    expect(() => readTrafficCalibrationDraft(draft)).toThrow("0 to 100");
  });
  it("moves an entire group between roles without changing other selections or source fields", () => {
    const draft = trafficCalibrationDraft(trafficCalibrationFixture())!;
    draft.calibrationCountIds.push("lane-2", "another-station");
    const frozen = structuredClone(draft);
    const moved = assignTrafficCalibrationGroup(
      draft,
      ["count-0", "lane-2"],
      "holdout",
    );
    expect(moved.calibrationCountIds).toEqual(["another-station"]);
    expect(moved.holdoutCountIds).toEqual(["count-1", "count-0", "lane-2"]);
    expect(
      assignTrafficCalibrationGroup(moved, ["count-0", "lane-2"], "context")
        .holdoutCountIds,
    ).toEqual(["count-1"]);
    expect(draft).toEqual(frozen);
    expect(moved.criteria).toEqual(draft.criteria);
    expect(moved.sourceIds).toEqual(draft.sourceIds);
  });
});
