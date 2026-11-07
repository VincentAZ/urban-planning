import { describe, expect, it } from "vitest";
import type { Place } from "@urban/core";
import {
  answerFor,
  cleanEngagement,
  defaultEngagement,
  parsePublicPin,
  SubmissionAttempts,
  validateEngagement,
  validateSurvey,
} from "./state";

describe("public engagement authoring and retry safety", () => {
  it("requires usable distinct choices and preserves frozen question identifiers when cleaning", () => {
    const config = defaultEngagement();
    config.questions = [
      {
        id: "q_walk",
        prompt: "  What matters? ",
        type: "single-choice",
        required: true,
        options: [" Walking ", " Walking"],
      },
    ];
    expect(validateEngagement(config)).toContain("duplicate");
    config.questions[0].options = [" Walking ", "Shade"];
    expect(cleanEngagement(config).questions[0]).toEqual({
      id: "q_walk",
      prompt: "What matters?",
      type: "single-choice",
      required: true,
      options: ["Walking", "Shade"],
    });
    expect(config.questions[0].options[0]).toBe(" Walking ");
  });
  it("validates required and known survey answers without treating optional blanks as responses", () => {
    const questions = [
      {
        id: "q",
        prompt: "Priority",
        type: "single-choice" as const,
        required: true,
        options: ["Homes", "Parks"],
      },
      {
        id: "text",
        prompt: "Anything else?",
        type: "text" as const,
        required: false,
      },
    ];
    expect(validateSurvey(questions, {})).toContain("Please answer");
    expect(validateSurvey(questions, { q: "Unlisted" })).toContain(
      "listed answer",
    );
    expect(validateSurvey(questions, { q: "Homes", text: "" })).toBeNull();
  });
  it("reads only own string answers, including compatible legacy question IDs", () => {
    expect(answerFor({}, "toString")).toBe("");
    expect(answerFor({ count: 3 }, "count")).toBe("");
    expect(answerFor({ toString: "Keep shade" }, "toString")).toBe(
      "Keep shade",
    );
    expect(
      validateSurvey(
        [
          {
            id: "toString",
            prompt: "Legacy question",
            type: "text",
            required: true,
          },
        ],
        {},
      ),
    ).toContain("Please answer");
    expect(
      validateSurvey(
        [
          {
            id: "toString",
            prompt: "Legacy question",
            type: "text",
            required: true,
          },
        ],
        { toString: "Keep shade" },
      ),
    ).toBeNull();
  });
  it("reuses the exact request after an uncertain response but uses fresh keys for changed or completed submissions", () => {
    const attempts = new SubmissionAttempts(),
      request = {
        kind: "comment" as const,
        text: "Keep this walkable",
        position: [1, 1] as [number, number],
        expectedCollectionVersion: 2,
      };
    const original = attempts.for(request);
    expect(attempts.for({ ...request })).toBe(original);
    const reopened = { ...request, expectedCollectionVersion: 4 };
    expect(attempts.for(reopened)).toBe(original);
    expect(attempts.for(reopened).expectedCollectionVersion).toBe(2);
    attempts.reject("comment");
    const afterKnownRejection = attempts.for(reopened);
    expect(afterKnownRejection.expectedCollectionVersion).toBe(4);
    expect(afterKnownRejection.idempotencyKey).not.toBe(
      original.idempotencyKey,
    );
    attempts.complete("comment");
    const afterConfirmation = attempts.for(reopened);
    expect(afterConfirmation.idempotencyKey).not.toBe(
      afterKnownRejection.idempotencyKey,
    );
    expect(
      attempts.for({ ...reopened, text: "Add shade too" }).idempotencyKey,
    ).not.toBe(afterConfirmation.idempotencyKey);
  });
  it("accepts URL pins on every study island but excludes holes, gaps, malformed values and out-of-area coordinates", () => {
    const ring = (x: number, y: number, n: number) => [
      [x, y],
      [x + n, y],
      [x + n, y + n],
      [x, y + n],
      [x, y],
    ];
    const place = {
      boundary: ring(0, 0, 10),
      studyArea: {
        type: "MultiPolygon",
        coordinates: [[ring(0, 0, 6), ring(2, 2, 2)], [ring(8, 0, 2)]],
      },
    } as unknown as Place;
    expect(parsePublicPin("1,1", place)).toEqual([1, 1]);
    expect(parsePublicPin("9,1", place)).toEqual([9, 1]);
    for (const value of ["3,3", "7,1", "Infinity,1", "1,", "1,2,3", "99,99"])
      expect(parsePublicPin(value, place)).toBeNull();
  });
});
