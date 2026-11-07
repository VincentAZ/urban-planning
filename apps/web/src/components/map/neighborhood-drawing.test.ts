import { describe, it, expect } from "vitest";
import {
  appendNeighborhoodStrokePoint,
  assertNeighborhoodDraftCaptureAllowed,
  canEditNeighborhoodDraft,
  canSelectNeighborhood,
  changeNeighborhoodDraftPoint,
  neighborhoodMapParts,
  neighborhoodStrokeCurrent,
  neighborhoodSurfaceRings,
  neighborhoodDraftCommandForKey,
  type MapNeighborhoodDraft,
} from "./neighborhood-drawing";
import { canEditRoadDraft } from "./road-drawing";
import { canEditParcelDraft } from "./parcel-drawing";
import { canDisplayBuildingDraft } from "./building-drawing";
const draft: MapNeighborhoodDraft = {
  id: "area",
  revision: 3,
  mode: "paint",
  rings: [],
  activeRingId: null,
  selectedVertexIndex: null,
  previewGeometry: null,
  brushRadiusMeters: 50,
};
const context = {
  view: "2d" as const,
  neighborhoodEditingEnabled: true,
  neighborhoodDraft: draft,
};
describe("controlled neighborhood map interactions", () => {
  it("accepts only a completed stroke from the exact current editing generation", () => {
    const stroke = {
      draftId: "area",
      draftRevision: 3,
      operation: "add" as const,
    };
    expect(neighborhoodStrokeCurrent(stroke, context)).toBe(true);
    for (const patch of [
      { neighborhoodDraft: { ...draft, revision: 4 } },
      { neighborhoodDraft: { ...draft, id: "next" } },
      { neighborhoodDraft: { ...draft, mode: "erase" as const } },
      { neighborhoodDraft: { ...draft, busy: true } },
      { neighborhoodEditingEnabled: false },
      { view: "3d" as const },
    ])
      expect(neighborhoodStrokeCurrent(stroke, { ...context, ...patch })).toBe(
        false,
      );
  });
  it("isolates all authoring modes, read-only contexts, and reveal", () => {
    for (const patch of [
      { roadDraft: {} },
      { parcelDraft: {} },
      { buildingDraft: {} },
      { revealScenario: {} },
      { placingBuilding: true },
      { selectingCommentLocation: true },
    ])
      expect(canEditNeighborhoodDraft({ ...context, ...patch })).toBe(false);
    expect(
      canEditRoadDraft({
        view: "2d",
        roadEditingEnabled: true,
        roadDraft: {} as never,
        neighborhoodDraft: draft,
      }),
    ).toBe(false);
    expect(
      canEditParcelDraft({
        view: "2d",
        parcelEditingEnabled: true,
        parcelDraft: {} as never,
        neighborhoodDraft: draft,
      }),
    ).toBe(false);
    expect(
      canDisplayBuildingDraft({
        view: "2d",
        buildingDraft: {} as never,
        neighborhoodDraft: draft,
      }),
    ).toBe(false);
    expect(
      canSelectNeighborhood({ ...context, neighborhoodSelectionEnabled: true }),
    ).toBe(false);
    expect(
      canSelectNeighborhood({ view: "3d", neighborhoodSelectionEnabled: true }),
    ).toBe(true);
  });
  it("bounds stroke samples, keeps the final endpoint, and rejects rather than truncates", () => {
    const path = appendNeighborhoodStrokePoint([], [0, 0], 100);
    expect(appendNeighborhoodStrokePoint(path, [0.000001, 0], 100)).toBe(path);
    expect(
      appendNeighborhoodStrokePoint(path, [0.000001, 0], 100, true),
    ).toHaveLength(2);
    expect(() =>
      appendNeighborhoodStrokePoint(
        Array.from({ length: 500 }, () => [0, 0]),
        [0.01, 0],
        5,
      ),
    ).toThrow(/shorter stroke/);
  });
  it("preserves other rings when a precise vertex is edited", () => {
    const editing = {
      ...draft,
      mode: "reshape" as const,
      activeRingId: "hole",
      selectedVertexIndex: 1,
      rings: [
        {
          id: "outer",
          partIndex: 0,
          ringIndex: 0,
          coordinates: [
            [0, 0],
            [1, 0],
            [1, 1],
          ] as [number, number][],
        },
        {
          id: "hole",
          partIndex: 0,
          ringIndex: 1,
          coordinates: [
            [0.2, 0.2],
            [0.3, 0.2],
            [0.3, 0.3],
          ] as [number, number][],
        },
      ],
    };
    const before = JSON.stringify(editing),
      result = changeNeighborhoodDraftPoint(editing, [0.4, 0.2]);
    expect(result?.detail).toMatchObject({
      ringId: "hole",
      kind: "move",
      vertexIndex: 1,
    });
    expect(result?.coordinates[1]).toEqual([0.4, 0.2]);
    expect(JSON.stringify(editing)).toBe(before);
  });
  it("renders every island and hole with one area identity, never inserting display elevation into source", () => {
    const areas = [
      {
        id: "area",
        name: "A",
        geometry: {
          type: "MultiPolygon" as const,
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
              [
                [0.2, 0.2],
                [0.3, 0.2],
                [0.3, 0.3],
                [0.2, 0.2],
              ],
            ],
            [
              [
                [2, 0],
                [3, 0],
                [3, 1],
                [2, 0],
              ],
            ],
          ] as [number, number][][][],
        },
      },
    ];
    const before = JSON.stringify(areas),
      parts = neighborhoodMapParts(areas);
    expect(parts).toHaveLength(2);
    expect(parts[0].rings).toHaveLength(2);
    expect(parts.map((p) => p.neighborhoodId)).toEqual(["area", "area"]);
    expect(neighborhoodSurfaceRings(parts[0])[0][0]).toEqual([0, 0, 0.025]);
    expect(JSON.stringify(areas)).toBe(before);
  });
  it("guards all unapplied captures and leaves typing shortcuts alone", () => {
    expect(() => assertNeighborhoodDraftCaptureAllowed(draft)).toThrow(
      /Finish or discard/,
    );
    expect(() => assertNeighborhoodDraftCaptureAllowed(null)).not.toThrow();
    const key = {
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
    };
    expect(neighborhoodDraftCommandForKey(key, false)).toBeUndefined();
    expect(neighborhoodDraftCommandForKey(key, true)).toBe("finish");
  });
});
