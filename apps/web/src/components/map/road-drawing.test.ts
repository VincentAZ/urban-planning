import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUTHORED_ROAD_POINTS,
  type Place,
  type Position,
  type Road,
} from "@urban/core";
import {
  assertRoadDraftCaptureAllowed,
  canEditRoadDraft,
  changeRoadDraftPoint,
  createRoadSnapIndex,
  nearestRoadVertex,
  roadDraftCandidate,
  roadDraftCommandForKey,
  type MapRoadDraft,
} from "./road-drawing";

const road = (id: string, coordinates: Position[]): Road => ({
  id,
  name: `Street ${id}`,
  coordinates,
  lanes: 2,
  speedMph: 25,
  oneWay: false,
  kind: "residential",
  sourceId: "qa",
});
const draft: MapRoadDraft = {
  id: "draft-a",
  mode: "draw",
  coordinates: [
    [0, 0],
    [0.001, 0],
  ],
  selectedVertexIndex: 0,
  snapToRoads: true,
};
const square = (x: number, y: number, size: number): Position[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];
const place = {
  boundary: square(0, 0, 10),
  studyArea: {
    type: "MultiPolygon",
    coordinates: [[square(0, 0, 6), square(2, 2, 2)], [square(8, 0, 2)]],
  },
} as Place;

describe("controlled street drawing", () => {
  it("requires explicit editing permission and 2D; reveal and review selection always block changes", () => {
    const context = {
      roadDraft: draft,
      roadEditingEnabled: true,
      view: "2d" as const,
    };
    expect(canEditRoadDraft(context)).toBe(true);
    for (const blocked of [
      { roadEditingEnabled: false },
      { roadEditingEnabled: undefined },
      { roadDraft: null },
      { view: "3d" as const },
      { view: "satellite" as const },
      { revealScenario: {} },
      { selectingCommentLocation: true },
    ])
      expect(canEditRoadDraft({ ...context, ...blocked })).toBe(false);
  });

  it("appends on draw, moves only the selected vertex on reshape, and lets a drag explicitly move either mode without mutating the source", () => {
    const added = changeRoadDraftPoint(draft, [0.002, 0]);
    expect(added).toEqual({
      coordinates: [
        [0, 0],
        [0.001, 0],
        [0.002, 0],
      ],
      detail: { kind: "append", vertexIndex: 2 },
    });
    const moved = changeRoadDraftPoint(
      { ...draft, mode: "reshape" },
      [0, 0.001],
    );
    expect(moved?.coordinates).toEqual([
      [0, 0.001],
      [0.001, 0],
    ]);
    expect(moved?.detail).toEqual({ kind: "move", vertexIndex: 0 });
    expect(changeRoadDraftPoint(draft, [0, 0.001], 1)?.coordinates).toEqual([
      [0, 0],
      [0, 0.001],
    ]);
    expect(draft.coordinates).toEqual([
      [0, 0],
      [0.001, 0],
    ]);
    expect(moved?.coordinates[1]).not.toBe(draft.coordinates[1]);
  });

  it("does not manufacture an append when reshape selection is missing/stale, or duplicate a double-click point", () => {
    expect(
      changeRoadDraftPoint(
        { ...draft, mode: "reshape", selectedVertexIndex: null },
        [1, 1],
      ),
    ).toBeNull();
    expect(
      changeRoadDraftPoint(
        { ...draft, mode: "reshape", selectedVertexIndex: 99 },
        [1, 1],
      ),
    ).toBeNull();
    expect(changeRoadDraftPoint(draft, [1, 1], -1)).toBeNull();
    expect(changeRoadDraftPoint(draft, [NaN, 1])).toBeNull();
    expect(changeRoadDraftPoint(draft, [0.001, 0])).toBeNull();
    expect(changeRoadDraftPoint(draft, [0.00100001, 0])).toBeNull();
  });

  it("caps click-appended vertices while permitting corrections to a path at the limit", () => {
    const coordinates = Array.from(
      { length: MAX_AUTHORED_ROAD_POINTS },
      (_, i): Position => [i / 1000, 0],
    );
    expect(changeRoadDraftPoint({ ...draft, coordinates }, [1, 1])).toBeNull();
    expect(
      changeRoadDraftPoint({ ...draft, coordinates }, [1, 1], 0)?.coordinates,
    ).toHaveLength(MAX_AUTHORED_ROAD_POINTS);
  });

  it("uses exact coverage for clicked and snapped vertices, including holes and multiple islands", () => {
    expect(roadDraftCandidate([1, 1], place).inside).toBe(true);
    expect(roadDraftCandidate([9, 1], place).inside).toBe(true);
    expect(roadDraftCandidate([3, 3], place).inside).toBe(false);
    expect(roadDraftCandidate([7, 1], place).inside).toBe(false);
    expect(roadDraftCandidate([NaN, 1], place).inside).toBe(false);
    expect(
      roadDraftCandidate([1, 1], place, {
        roadId: "outside",
        vertexIndex: 0,
        position: [3, 3],
        name: "Outside",
      }).inside,
    ).toBe(false);
  });

  it("only handles commands for the focused map, preserving form input, modifier shortcuts, and composition", () => {
    const event = {
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
    };
    expect(roadDraftCommandForKey(event, true)).toBe("finish");
    expect(roadDraftCommandForKey({ ...event, key: "Escape" }, true)).toBe(
      "cancel",
    );
    expect(roadDraftCommandForKey({ ...event, key: "Delete" }, true)).toBe(
      "delete-vertex",
    );
    expect(roadDraftCommandForKey({ ...event, key: "Backspace" }, true)).toBe(
      "delete-vertex",
    );
    expect(roadDraftCommandForKey(event, false)).toBeUndefined();
    for (const blocked of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
      { key: "a" },
    ])
      expect(
        roadDraftCommandForKey({ ...event, ...blocked }, true),
      ).toBeUndefined();
  });

  it("refuses revision-labeled capture even for an empty draft, then allows capture after explicit discard/apply", () => {
    expect(() =>
      assertRoadDraftCaptureAllowed({ ...draft, coordinates: [] }),
    ).toThrow("Finish or discard street drawing before exporting the map.");
    expect(() => assertRoadDraftCaptureAllowed(draft)).toThrow();
    expect(() => assertRoadDraftCaptureAllowed(null)).not.toThrow();
    expect(() => assertRoadDraftCaptureAllowed()).not.toThrow();
  });
});

describe("bounded street-vertex alignment", () => {
  it("snaps to existing vertices rather than an invented point on a segment, without reprojecting on pointer movement", () => {
    const source = road("a", [
        [0, 0],
        [0.001, 0],
      ]),
      project = vi.fn((p: Position) => ({
        x: p[0] * 100000,
        y: p[1] * 100000,
      }));
    const index = createRoadSnapIndex([source], project);
    expect(
      nearestRoadVertex(index, [0.00005, 0], { x: 5, y: 0 }),
    ).toMatchObject({ roadId: "a", vertexIndex: 0, position: [0, 0] });
    expect(
      nearestRoadVertex(index, [0.0005, 0], { x: 50, y: 0 }),
    ).toBeUndefined();
    expect(
      nearestRoadVertex(index, [0.00095, 0], { x: 95, y: 0 }),
    ).toMatchObject({ vertexIndex: 1 });
    expect(project).toHaveBeenCalledTimes(2);
    expect(source.coordinates).toEqual([
      [0, 0],
      [0.001, 0],
    ]);
  });

  it("enforces BOTH 12 CSS pixels and 25 meters, including when zoomed far out", () => {
    const index = createRoadSnapIndex([road("a", [[0, 0]])], () => ({
      x: 0,
      y: 0,
    }));
    expect(
      nearestRoadVertex(index, [0.0001, 0], { x: 12, y: 0 }),
    ).toBeDefined();
    expect(
      nearestRoadVertex(index, [0.0001, 0], { x: 12.01, y: 0 }),
    ).toBeUndefined();
    expect(
      nearestRoadVertex(index, [0.001, 0], { x: 1, y: 0 }),
    ).toBeUndefined();
    expect(
      nearestRoadVertex(index, [-0.0001, 0], { x: -10, y: 0 }),
    ).toBeDefined();
  });

  it("excludes the road being reshaped, and searches neighboring buckets for the closest permitted vertex", () => {
    const index = createRoadSnapIndex(
      [
        road("self", [[0.00011, 0]]),
        road("other", [
          [0.00012, 0],
          [0.0002, 0],
        ]),
      ],
      (p) => ({ x: p[0] * 100000, y: 0 }),
      "self",
    );
    expect(
      nearestRoadVertex(index, [0.00011, 0], { x: 11, y: 0 }),
    ).toMatchObject({ roadId: "other", vertexIndex: 0 });
    expect(
      nearestRoadVertex(
        createRoadSnapIndex(
          [road("self", [[0, 0]])],
          () => ({ x: 0, y: 0 }),
          "self",
        ),
        [0, 0],
        { x: 0, y: 0 },
      ),
    ).toBeUndefined();
  });
});
