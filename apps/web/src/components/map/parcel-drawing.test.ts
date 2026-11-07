import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUTHORED_PARCEL_RING_POINTS,
  type Parcel,
  type Place,
  type Position,
  type StudyAreaGeometry,
} from "@urban/core";
import {
  activeParcelPath,
  assertParcelDraftCaptureAllowed,
  canEditParcelDraft,
  canSelectParcel,
  changeParcelDraftPoint,
  createParcelSnapIndex,
  draftParcelGeometry,
  extendedParcelCut,
  nearestParcelVertex,
  parcelDraftCandidate,
  parcelMapParts,
  parcelSurfaceRings,
  previewParcelParts,
  type MapParcelDraft,
} from "./parcel-drawing";

const square = (x: number, y: number, width: number): Position[] => [
  [x, y],
  [x + width, y],
  [x + width, y + width],
  [x, y + width],
];
const close = (ring: Position[]) => [...ring, [...ring[0]] as Position];
const geometry: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [close(square(0, 0, 0.01)), close(square(0.003, 0.003, 0.002))],
    [close(square(0.02, 0, 0.01))],
  ],
};
const parcel: Parcel = {
  id: "parcel-a",
  name: "Proposal area",
  kind: "parcel",
  sourceId: "qa",
  geometry,
};
const place = {
  boundary: close(square(0, 0, 0.04)),
  studyArea: geometry,
} as Place;
const draft: MapParcelDraft = {
  id: "draft-a",
  operation: "reshape",
  rings: [
    {
      id: "outer-a",
      partIndex: 0,
      ringIndex: 0,
      coordinates: square(0, 0, 0.01),
    },
    {
      id: "hole-a",
      partIndex: 0,
      ringIndex: 1,
      coordinates: square(0.003, 0.003, 0.002),
    },
    {
      id: "outer-b",
      partIndex: 1,
      ringIndex: 0,
      coordinates: square(0.02, 0, 0.01),
    },
  ],
  activeRingId: "hole-a",
  mode: "reshape",
  selectedVertexIndex: 1,
  splitLine: [],
  sourceParcelIds: [parcel.id],
  snapToParcels: true,
};

describe("full parcel map geometry", () => {
  it("closes open edit rings without mutating them or dropping a hole/disconnected part", () => {
    const before = JSON.stringify(draft);
    expect(draftParcelGeometry(draft.rings)).toEqual(geometry);
    expect(JSON.stringify(draft)).toBe(before);
    expect(draftParcelGeometry(draft.rings.slice(0, 2))).toEqual({
      type: "Polygon",
      coordinates: geometry.coordinates[0],
    });
    expect(draft.rings.every((ring) => ring.coordinates.length === 4)).toBe(
      true,
    );
  });

  it("does not fill an unfinished hole or fabricate a missing shell", () => {
    expect(
      draftParcelGeometry([
        ...draft.rings,
        { id: "pending", partIndex: 1, ringIndex: 1, coordinates: [] },
      ]),
    ).toBeNull();
    expect(
      draftParcelGeometry(draft.rings.filter((ring) => ring.id === "hole-a")),
    ).toBeNull();
    expect(
      draftParcelGeometry([
        draft.rings[0],
        { ...draft.rings[1], ringIndex: 0 },
      ]),
    ).toBeNull();
    expect(draftParcelGeometry([])).toBeNull();
  });

  it("retains source rings and output identity when rendering multipart lots and a partition", () => {
    const before = JSON.stringify(parcel),
      parts = parcelMapParts([parcel]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      parcelId: "parcel-a",
      partIndex: 0,
      kind: "parcel",
    });
    expect(parts[0].rings).toBe(geometry.coordinates[0]);
    expect(parts[0].rings).toHaveLength(2);
    const preview = previewParcelParts([
      geometry,
      { type: "Polygon", coordinates: [close(square(0.04, 0, 0.01))] },
    ]);
    expect(preview.map((part) => part.outputIndex)).toEqual([0, 0, 1]);
    expect(JSON.stringify(parcel)).toBe(before);
  });

  it("lifts every rendered shell and hole above ground without changing captured geometry", () => {
    const before = JSON.stringify(parcel);
    const parts = parcelMapParts([parcel]);
    const surfaces = parts.map(parcelSurfaceRings);
    expect(
      surfaces.map((rings) =>
        rings.map((ring) =>
          ring.map(([longitude, latitude]) => [longitude, latitude]),
        ),
      ),
    ).toEqual(geometry.coordinates);
    for (const rings of surfaces) {
      for (const ring of rings) {
        expect(ring[0]).toEqual(ring.at(-1));
        for (const [, , elevation] of ring) {
          expect(elevation).toBeGreaterThan(0);
          expect(elevation).toBeLessThan(0.12);
        }
      }
    }
    // Selection reuses the same display plane; neither path writes altitude
    // back into the snapshot, the source geometry, or exported coordinates.
    expect(parcelSurfaceRings(parts[0])).toEqual(surfaces[0]);
    expect(JSON.stringify(parcel)).toBe(before);
  });

  it("moves only the active hole's selected point; switching stable ring IDs changes the edit target", () => {
    const before = JSON.stringify(draft);
    const change = changeParcelDraftPoint(
      draft,
      [0.006, 0.003],
      MAX_AUTHORED_PARCEL_RING_POINTS,
    );
    expect(change?.detail).toEqual({
      ringId: "hole-a",
      kind: "move",
      vertexIndex: 1,
    });
    expect(change?.coordinates).toEqual([
      [0.003, 0.003],
      [0.006, 0.003],
      [0.005, 0.005],
      [0.003, 0.005],
    ]);
    expect(
      activeParcelPath({ ...draft, activeRingId: "outer-b" })?.coordinates,
    ).toBe(draft.rings[2].coordinates);
    expect(
      activeParcelPath({ ...draft, activeRingId: "deleted-ring" }),
    ).toBeNull();
    expect(JSON.stringify(draft)).toBe(before);
  });

  it("bounds open rings and split lines; closure clicks cannot add a duplicate vertex", () => {
    const drawing = { ...draft, mode: "draw" as const };
    expect(
      changeParcelDraftPoint(drawing, draft.rings[1].coordinates[0], 500),
    ).toBeNull();
    expect(changeParcelDraftPoint(drawing, [0.002, 0.002], 4)).toBeNull();
    expect(
      changeParcelDraftPoint(drawing, [0.002, 0.002], 4, 0)?.detail.kind,
    ).toBe("move");
    const split: MapParcelDraft = {
      ...draft,
      operation: "split",
      mode: "draw",
      splitLine: [
        [0, 0],
        [0.01, 0.01],
      ],
    };
    expect(changeParcelDraftPoint(split, [0.02, 0.02], 500)).toBeNull();
    expect(changeParcelDraftPoint(split, [0.02, 0.02], 500, 1)).toMatchObject({
      detail: { ringId: null, kind: "move", vertexIndex: 1 },
    });
    expect(
      changeParcelDraftPoint({ ...draft, operation: "assemble" }, [0, 0], 500),
    ).toBeNull();
  });

  it("shows an extended straight cut guide without performing or buffering a geometry operation", () => {
    const line: Position[] = [
      [0.005, 0.002],
      [0.005, 0.008],
    ];
    expect(extendedParcelCut(line, place)).toEqual([
      [0.005, 0],
      [0.005, 0.01],
    ]);
    expect(
      extendedParcelCut(
        [
          [0.001, 0.005],
          [0.002, 0.005],
        ],
        place,
      ),
    ).toEqual([
      [0, 0.005],
      [0.03, 0.005],
    ]);
    expect(line).toEqual([
      [0.005, 0.002],
      [0.005, 0.008],
    ]);
    expect(
      extendedParcelCut(
        [
          [0, 0],
          [0, 0],
        ],
        place,
      ),
    ).toEqual([]);
  });
});

describe("parcel interaction isolation", () => {
  const context = {
    parcelDraft: draft,
    parcelEditingEnabled: true,
    parcelSelectionEnabled: true,
    view: "2d" as const,
  };
  it("requires explicit edit permission and fails closed if another drawing/placement/reveal tool owns the map", () => {
    expect(canEditParcelDraft(context)).toBe(true);
    for (const blocked of [
      { parcelEditingEnabled: undefined },
      { parcelEditingEnabled: false },
      { roadDraft: {} },
      { revealScenario: {} },
      { selectingCommentLocation: true },
      { placingBuilding: true },
      { view: "3d" as const },
      { view: "satellite" as const },
    ])
      expect(canEditParcelDraft({ ...context, ...blocked })).toBe(false);
  });

  it("permits lot selection only during explicit inspection/assembly, preserving placement and ordinary feature clicks", () => {
    expect(canSelectParcel({ ...context, parcelDraft: null })).toBe(true);
    expect(canSelectParcel(context)).toBe(false);
    expect(
      canSelectParcel({
        ...context,
        parcelDraft: { ...draft, operation: "split" },
      }),
    ).toBe(false);
    expect(
      canSelectParcel({
        ...context,
        parcelDraft: { ...draft, operation: "assemble" },
      }),
    ).toBe(true);
    for (const blocked of [
      { parcelSelectionEnabled: false },
      { roadDraft: {} },
      { revealScenario: {} },
      { selectingCommentLocation: true },
      { placingBuilding: true },
    ])
      expect(
        canSelectParcel({ ...context, parcelDraft: null, ...blocked }),
      ).toBe(false);
    expect(
      canSelectParcel({
        ...context,
        parcelDraft: { ...draft, operation: "assemble" },
        parcelEditingEnabled: false,
      }),
    ).toBe(false);
  });

  it("blocks revision-labeled PNGs for every unapplied operation, including empty drafts", () => {
    for (const operation of ["draw", "reshape", "split", "assemble"] as const)
      expect(() =>
        assertParcelDraftCaptureAllowed({ ...draft, operation, rings: [] }),
      ).toThrow("Apply or discard parcel editing");
    expect(() => assertParcelDraftCaptureAllowed(null)).not.toThrow();
  });

  it("uses the exact study boundary for pointer/snapped targets, excluding holes and gaps", () => {
    expect(parcelDraftCandidate([0.001, 0.001], place).inside).toBe(true);
    expect(parcelDraftCandidate([0.025, 0.005], place).inside).toBe(true);
    expect(parcelDraftCandidate([0.004, 0.004], place).inside).toBe(false);
    expect(parcelDraftCandidate([0.015, 0.005], place).inside).toBe(false);
  });
});

describe("parcel vertex alignment", () => {
  it("indexes hole/island vertices once, omits duplicate closures, and excludes edited source parcels", () => {
    const project = vi.fn((point: Position) => ({
      x: point[0] * 100000,
      y: point[1] * 100000,
    }));
    const index = createParcelSnapIndex([parcel], project, []);
    expect(
      nearestParcelVertex(index, [0.00301, 0.003], { x: 301, y: 300 }),
    ).toMatchObject({
      parcelId: "parcel-a",
      partIndex: 0,
      ringIndex: 1,
      vertexIndex: 0,
    });
    expect(
      nearestParcelVertex(index, [0.02001, 0], { x: 2001, y: 0 }),
    ).toMatchObject({ partIndex: 1, ringIndex: 0, vertexIndex: 0 });
    expect(project).toHaveBeenCalledTimes(12);
    expect(createParcelSnapIndex([parcel], project, [parcel.id]).size).toBe(0);
    expect(project).toHaveBeenCalledTimes(12);
  });

  it("requires both the 12px and 25m bounds, and never invents an edge-interior target", () => {
    const index = createParcelSnapIndex(
      [parcel],
      (point) => ({ x: point[0] * 100000, y: point[1] * 100000 }),
      [],
    );
    expect(
      nearestParcelVertex(index, [0.0001, 0], { x: 12, y: 0 }),
    ).toBeDefined();
    expect(
      nearestParcelVertex(index, [0.0001, 0], { x: 12.1, y: 0 }),
    ).toBeUndefined();
    expect(
      nearestParcelVertex(index, [0.001, 0], { x: 1, y: 0 }),
    ).toBeUndefined();
    expect(
      nearestParcelVertex(index, [0.005, 0], { x: 500, y: 0 }),
    ).toBeUndefined();
  });
});
