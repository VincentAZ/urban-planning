import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Place, ReviewComment, ReviewCommentsResponse } from "@urban/core";
import {
  coordinateTarget,
  reviewRequestKey,
  reviewWriteBlock,
} from "./review-state";
import { ReviewThread } from "./ReviewThread";

const saved: ReviewCommentsResponse = {
  access: {
    role: "commenter",
    mode: "private",
    reason: "project-member",
    aclVersion: 1,
    canEdit: false,
    canComment: true,
    canManageMembers: false,
    canPublish: false,
  },
  projectVersion: 5,
  scenarioId: "option-a",
  scenarioRevision: 2,
  comments: [],
};
const place: Place = {
  id: "review-area",
  name: "Review area",
  city: "Test",
  state: "AZ",
  zip: "85004",
  center: [0.5, 0.5],
  bounds: [0, 0, 8, 4],
  boundary: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0],
  ],
  studyArea: {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [3, 1],
          [3, 3],
          [1, 3],
          [1, 1],
        ],
      ],
      [
        [
          [6, 0],
          [8, 0],
          [8, 2],
          [6, 2],
          [6, 0],
        ],
      ],
    ],
  },
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Test area",
};

describe("review write boundaries", () => {
  it("requires verified current saved content and comment permission", () => {
    expect(reviewWriteBlock(saved, 5, 2, false)).toBeNull();
    expect(reviewWriteBlock(saved, 5, 2, true)).toContain(
      "Save your project changes",
    );
    expect(reviewWriteBlock(saved, null, 2, false)).toContain(
      "Save your project changes",
    );
    expect(reviewWriteBlock(saved, 4, 2, false)).toContain(
      "saved project has changed",
    );
    expect(reviewWriteBlock(saved, 4, 3, true)).toContain(
      "saved project has changed",
    );
    expect(reviewWriteBlock(saved, 5, 1, false)).toContain(
      "saved project has changed",
    );
    expect(
      reviewWriteBlock(
        {
          ...saved,
          access: { ...saved.access, role: "viewer", canComment: false },
        },
        5,
        2,
        false,
      ),
    ).toContain("viewer access");
    expect(reviewWriteBlock(null, 5, 2, false)).toContain(
      "Load the saved review",
    );
  });
  it("keeps uncertain retries idempotent but treats an edited body or new revision as new intent", () => {
    let sequence = 0;
    const makeKey = () => `request-${++sequence}`;
    const payload = {
      text: "Keep the crossing visible.",
      expectedRevision: 2,
      target: { kind: "building", id: "b-1" },
    };
    const first = reviewRequestKey(undefined, payload, makeKey);
    expect(reviewRequestKey(first, { ...payload }, makeKey)).toBe(first);
    const edit = reviewRequestKey(
      first,
      { ...payload, text: "Keep both crossings visible." },
      makeKey,
    );
    expect(edit.key).not.toBe(first.key);
    expect(
      reviewRequestKey(first, { ...payload, expectedRevision: 3 }, makeKey).key,
    ).not.toBe(first.key);
    expect(reviewRequestKey(undefined, payload, makeKey).key).not.toBe(
      first.key,
    );
  });
  it("supports exact coordinate entry on any island and rejects holes, gaps, and invalid numbers", () => {
    expect(coordinateTarget("1", "7", place)).toEqual({
      kind: "location",
      position: [7, 1],
    });
    expect(coordinateTarget("0.5", "0.5", place)).toEqual({
      kind: "location",
      position: [0.5, 0.5],
    });
    expect(() => coordinateTarget("2", "2", place)).toThrow("excluded holes");
    expect(() => coordinateTarget("1", "5", place)).toThrow("study area");
    expect(() => coordinateTarget("", "1", place)).toThrow(
      "both latitude and longitude",
    );
    expect(() => coordinateTarget("NaN", "1", place)).toThrow(
      "latitude between",
    );
    expect(() => coordinateTarget("91", "1", place)).toThrow(
      "latitude between",
    );
    expect(() => coordinateTarget("0", "181", place)).toThrow(
      "longitude between",
    );
  });
});

const thread: ReviewComment = {
  id: "thread-1",
  scenarioId: "option-a",
  scenarioRevision: 1,
  target: { kind: "building", id: "removed-building" },
  targetLabel: "Former corner building",
  targetPosition: [7, 1],
  text: '<script>alert("not executable")</script>\nKeep this question in the record.',
  author: "Maya",
  actorId: "user-maya",
  createdAt: "2026-11-05T12:00:00Z",
  resolved: false,
  threadVersion: 1,
  replies: [],
  stale: true,
  currentRevision: 2,
  canResolve: false,
};
function threadHTML(comment: ReviewComment, canReply = false) {
  return renderToStaticMarkup(
    createElement(ReviewThread, {
      comment,
      selected: false,
      canReply,
      busy: false,
      draft: "",
      onDraft: () => {},
      onReply: () => {},
      onResolve: () => {},
      onNavigate: () => {},
    }),
  );
}
describe("review thread disclosure and capability rendering", () => {
  it("keeps prior revision and target context visible, escapes discussion text, and omits unauthorized actions", () => {
    const html = threadHTML(thread);
    expect(html).toContain("Former corner building");
    expect(html).toContain("Current saved revision: 2");
    expect(html).toContain("Revision 1");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Resolve thread");
    expect(html).not.toContain("Post reply");
    expect(html).toContain("Show review target");
  });
  it("uses server thread capabilities and never invents a legacy original revision", () => {
    const html = threadHTML(
      {
        ...thread,
        scenarioRevision: null,
        resolved: true,
        canResolve: true,
        resolvedAt: "2026-11-05T13:00:00Z",
        replies: [
          {
            id: "reply-1",
            text: "Reviewed at the next revision.",
            author: "Jordan",
            actorId: "user-jordan",
            scenarioRevision: 2,
            createdAt: "2026-11-05T12:30:00Z",
          },
        ],
      },
      true,
    );
    expect(html).toContain("Original revision unavailable");
    expect(html).toContain("Reopen thread");
    expect(html).toContain("Post reply");
    expect(html).toContain("Jordan");
    expect(html).toContain("Revision 2");
    expect(html).toContain("discussion remains in the project record");
    expect(html).not.toContain("Revision 0");
  });
});
