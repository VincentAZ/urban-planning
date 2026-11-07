import { describe, it, expect } from "vitest";
import {
  USER_ACTIVITY_SOURCE,
  type ActivityScenario,
  type StudyAreaGeometry,
} from "@urban/core";
import {
  areaGeometry,
  areaRings,
  changeActivityDraft,
  draftValue,
  replaceAreaGeometry,
  travelActivityDraft,
  type ActivityDraft,
  type AreaDraft,
} from "./draft";
const activity: ActivityScenario = {
  version: 1,
  reference: {
    population: { kind: "building-derived" },
    employment: { kind: "building-derived" },
  },
  allocation: {
    population: "building-weighted",
    employment: "building-weighted",
  },
  global: {},
  neighborhoods: [],
  demandResponse: {
    population: "none",
    employment: "none",
    vehicles: "none",
    reviewed: false,
    sourceId: USER_ACTIVITY_SOURCE.id,
  },
};
const create = (): ActivityDraft => ({
  id: "draft",
  scope: "project:scenario:0",
  revision: 0,
  horizon: 0,
  activity,
  sources: [USER_ACTIVITY_SOURCE],
  area: null,
  past: [],
  future: [],
});
const geometry: StudyAreaGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0],
    ],
  ],
};
function area(): AreaDraft {
  const rings = areaRings(geometry);
  return {
    id: "a",
    name: "Neighborhood",
    rings,
    activeRingId: rings[0].id,
    selectedVertexIndex: null,
    mode: "draw",
    brushRadiusMeters: 50,
    coordinateText: "",
  };
}
describe("People draft history and precise geometry", () => {
  it("records forecast horizon changes with the draft and restores them on Undo", () => {
    const draft = create();
    const forecast = changeActivityDraft(draft, {
      ...draftValue(draft),
      horizon: 10,
    });
    expect(forecast.horizon).toBe(10);
    const undone = travelActivityDraft(forecast, "undo");
    expect(undone.horizon).toBe(0);
    expect(travelActivityDraft(undone, "redo").horizon).toBe(10);
  });

  it("keeps more than 100 completed edits undoable and never changes captured activity", () => {
    let draft = create();
    const captured = JSON.stringify(activity);
    for (let i = 1; i <= 120; i++)
      draft = changeActivityDraft(draft, {
        ...draftValue(draft),
        activity: {
          ...draft.activity,
          global: { population: { mode: "absolute", value: i } },
        },
      });
    expect(draft.past).toHaveLength(120);
    for (let i = 0; i < 120; i++) draft = travelActivityDraft(draft, "undo");
    expect(draft.activity).toBe(activity);
    expect(draft.future).toHaveLength(120);
    expect(JSON.stringify(activity)).toBe(captured);
  });
  it("consumed coordinate text does not return as a pending buffer after Undo or block Redo", () => {
    const draft = {
      ...create(),
      area: { ...area(), coordinateText: "0,0\n0.02,0\n0.02,0.02" },
    };
    const changed = changeActivityDraft(draft, {
      ...draftValue(draft),
      area: {
        ...draft.area,
        coordinateText: "",
        rings: draft.area.rings.map((r) => ({
          ...r,
          coordinates: [
            [0, 0],
            [0.02, 0],
            [0.02, 0.02],
          ] as [number, number][],
        })),
      },
    });
    const undone = travelActivityDraft(changed, "undo");
    expect(undone.area?.coordinateText).toBe("");
    const redone = travelActivityDraft(undone, "redo");
    expect(redone.area?.rings[0].coordinates[1]).toEqual([0.02, 0]);
    expect(redone.area?.coordinateText).toBe("");
  });
  it("protects actual pending input and clears the abandoned branch on a new edit", () => {
    const initial = { ...create(), area: area() },
      first = changeActivityDraft(initial, {
        ...draftValue(initial),
        area: { ...initial.area, name: "First" },
      }),
      second = changeActivityDraft(first, {
        ...draftValue(first),
        area: { ...first.area!, name: "Second" },
      });
    const pending = {
      ...second,
      area: { ...second.area!, coordinateText: "-112," },
    };
    expect(travelActivityDraft(pending, "undo")).toBe(pending);
    const undone = travelActivityDraft(second, "undo"),
      branched = changeActivityDraft(undone, {
        ...draftValue(undone),
        area: { ...undone.area!, name: "New branch" },
      });
    expect(branched.future).toHaveLength(0);
    expect(travelActivityDraft(branched, "redo")).toBe(branched);
    expect(first.area?.name).toBe("First");
  });
  it("retains a one-part MultiPolygon and all holes through full geometry replacement", () => {
    const multi: StudyAreaGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          (geometry as Extract<StudyAreaGeometry, { type: "Polygon" }>)
            .coordinates[0],
          [
            [0.002, 0.002],
            [0.003, 0.002],
            [0.003, 0.003],
            [0.002, 0.002],
          ],
        ],
      ],
    };
    const before = JSON.stringify(multi),
      replaced = replaceAreaGeometry(area(), multi);
    expect(areaGeometry(replaced.rings, replaced.originalType)).toEqual(multi);
    expect(JSON.stringify(multi)).toBe(before);
    expect(replaced.selectedVertexIndex).toBeNull();
  });
});
