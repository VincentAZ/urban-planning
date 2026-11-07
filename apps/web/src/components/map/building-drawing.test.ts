import { describe, expect, it } from "vitest";
import type { Building, Place, Position, StudyAreaGeometry } from "@urban/core";
import {
  buildingGeometryAreaSqm,
  transformBuildingGeometry,
} from "@urban/core";
import {
  activeBuildingRing,
  assertBuildingDraftCaptureAllowed,
  buildingDraftCandidate,
  buildingDraftCommandForKey,
  buildingDraftPivot,
  buildingMapParts,
  buildingMapRings,
  buildingOutlineRings,
  buildingRoofPath,
  buildingSurfaceRings,
  buildingRotationHandle,
  buildingTransformAt,
  canDisplayBuildingDraft,
  canEditBuildingDraft,
  changeBuildingDraftPoint,
  createBuildingSnapIndex,
  draftBuildingGeometry,
  nearestBuildingVertex,
  safeDraftHeight,
  transformedBuildingDraft,
  type MapBuildingDraft,
} from "./building-drawing";
import { canEditRoadDraft } from "./road-drawing";
import { canEditParcelDraft, canSelectParcel } from "./parcel-drawing";
import { dispatchMapClick } from "./review";

const square = (x: number, y: number, w: number): Position[] => [
  [x, y],
  [x + w, y],
  [x + w, y + w],
  [x, y + w],
  [x, y],
];
const geometry: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [square(-112.07, 33.45, 0.001), square(-112.0697, 33.4503, 0.0002)],
    [square(-112.068, 33.45, 0.0005)],
  ],
};
const base = {
  id: "building-a",
  name: "Courtyard and annex",
  use: "office" as const,
  height: 18,
  floors: 5,
  areaSqm: 1,
  units: 0,
  jobs: 20,
  parkingSpaces: 10,
  sourceId: "captured-source",
  estimated: false,
};
const building: Building = { ...base, geometry };
const legacy: Building = {
  ...base,
  id: "legacy",
  footprint: square(-112.065, 33.45, 0.001),
};
const place = { boundary: square(-112.08, 33.44, 0.03) } as Place;
const draft: MapBuildingDraft = {
  id: "draft-a",
  buildingId: building.id,
  rings: geometry.coordinates.flatMap((part, partIndex) =>
    part.map((ring, ringIndex) => ({
      id: `ring-${partIndex}-${ringIndex}`,
      partIndex,
      ringIndex,
      coordinates: ring.slice(0, -1),
    })),
  ),
  activeRingId: "ring-0-1",
  mode: "reshape",
  selectedVertexIndex: 1,
  pivot: [-112.07, 33.45],
  previewGeometry: geometry,
  height: 18,
  snapToVertices: true,
};

describe("complete building rendering", () => {
  it("renders unknown height as a flat outlined footprint while retaining all source coordinates and unknowns", () => {
    const unknown: Building = { ...building, height: null };
    const before = JSON.stringify(unknown);
    const parts = buildingMapParts([unknown]);
    expect(parts).toHaveLength(2);
    expect(safeDraftHeight(unknown.height)).toBe(0);
    for (const part of parts) {
      const display = buildingSurfaceRings(part);
      expect(display.map((ring) => ring.map(([x, y]) => [x, y]))).toEqual(
        part.rings,
      );
      expect(display.flat().every((p) => p[2] === 0.16)).toBe(true);
    }
    expect(
      buildingMapRings(parts)
        .flatMap((ring) => buildingRoofPath(ring, false))
        .every((p) => p[2] === 0.25),
    ).toBe(true);
    expect(JSON.stringify(unknown)).toBe(before);
  });
  it("retains every polygon, courtyard roof ring and original picking identity without altering either source format", () => {
    const before = JSON.stringify([building, legacy]);
    const parts = buildingMapParts([building, legacy]);
    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.id)).toEqual([
      building.id,
      building.id,
      legacy.id,
    ]);
    expect(parts[0].rings).toBe(geometry.coordinates[0]);
    expect(parts[0].building).toBe(building);
    const rings = buildingMapRings(parts);
    expect(rings).toHaveLength(4);
    expect(
      rings
        .filter((ring) => ring.id === building.id)
        .map((ring) => [ring.partIndex, ring.ringIndex]),
    ).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    for (const ring of rings) {
      for (const flat of [true, false]) {
        const roof = buildingRoofPath(ring, flat);
        expect(roof.map(([x, y]) => [x, y])).toEqual(ring.coordinates);
        expect(roof.every((point) => point[2] === (flat ? 0.5 : 18.25))).toBe(
          true,
        );
      }
    }
    expect(
      buildingOutlineRings(parts[0]).map((ring) =>
        ring.map(([x, y]) => [x, y]),
      ),
    ).toEqual(geometry.coordinates[0]);
    const selected: (string | null)[] = [];
    dispatchMapClick([-112.068, 33.45], parts[1].id, {
      onSelect: (id) => selected.push(id),
    });
    expect(selected).toEqual([building.id]);
    expect(JSON.stringify([building, legacy])).toBe(before);
  });
  it("handles invalid transient height without passing nonfinite values to the GPU", () => {
    expect([NaN, Infinity, -5, 0, 18, 2000].map(safeDraftHeight)).toEqual([
      0, 0, 0, 0, 18, 1500,
    ]);
  });
});

describe("building drafting and gesture geometry", () => {
  it("preserves holes, disconnected parts, single-component MultiPolygon, and pending-ring ownership", () => {
    expect(draftBuildingGeometry(draft)).toEqual(geometry);
    expect(
      draftBuildingGeometry({ ...draft, rings: draft.rings.slice(0, 2) }),
    ).toEqual({ type: "MultiPolygon", coordinates: [geometry.coordinates[0]] });
    expect(
      draftBuildingGeometry({
        ...draft,
        rings: [
          ...draft.rings,
          { id: "pending", partIndex: 1, ringIndex: 1, coordinates: [] },
        ],
      }),
    ).toBeNull();
    expect(
      draftBuildingGeometry({
        ...draft,
        rings: draft.rings.filter((ring) => ring.id === "ring-0-1"),
      }),
    ).toBeNull();
    expect(
      activeBuildingRing({ ...draft, activeRingId: "missing" }),
    ).toBeNull();
  });
  it("changes only the selected courtyard point and bounds append/closure gestures", () => {
    const before = JSON.stringify(draft);
    const change = changeBuildingDraftPoint(draft, [-112.0694, 33.4503], 500);
    expect(change?.detail).toEqual({
      ringId: "ring-0-1",
      kind: "move",
      vertexIndex: 1,
    });
    expect(change?.coordinates[0]).toEqual(draft.rings[1].coordinates[0]);
    const draw = { ...draft, mode: "draw" as const };
    expect(
      changeBuildingDraftPoint(draw, draft.rings[1].coordinates[0], 500),
    ).toBeNull();
    expect(changeBuildingDraftPoint(draw, [-112.0694, 33.4503], 4)).toBeNull();
    expect(
      changeBuildingDraftPoint(draw, [-112.0694, 33.4503], 4, 0)?.detail.kind,
    ).toBe("move");
    expect(
      changeBuildingDraftPoint(
        { ...draft, selectedVertexIndex: 10 },
        [0, 0],
        500,
      ),
    ).toBeNull();
    expect(
      changeBuildingDraftPoint({ ...draft, mode: "move" }, [0, 0], 500),
    ).toBeNull();
    expect(changeBuildingDraftPoint(draft, [181, 0], 500)).toBeNull();
    expect(JSON.stringify(draft)).toBe(before);
  });
  it("moves and rotates every component about the same pivot without rewriting source coordinates", () => {
    const before = JSON.stringify(draft);
    const moving = { ...draft, mode: "move" as const };
    const destination: Position = [-112.069, 33.451];
    const transform = buildingTransformAt(moving, destination)!;
    expect(transform.translateMeters![0]).toBeGreaterThan(90);
    expect(transform.translateMeters![1]).toBeGreaterThan(110);
    const moved = transformedBuildingDraft(moving, transform)!;
    expect(moved.type).toBe("MultiPolygon");
    if (moved.type !== "MultiPolygon")
      throw Error("Expected multipart geometry");
    expect(moved.coordinates[0][0][0][0]).toBeCloseTo(destination[0], 12);
    expect(moved.coordinates[0][0][0][1]).toBeCloseTo(destination[1], 12);
    expect(moved.coordinates.map((part) => part.length)).toEqual([2, 1]);
    const rotating = { ...draft, mode: "rotate" as const };
    const rotation = buildingTransformAt(rotating, [-112.069, 33.45])!;
    expect(rotation.rotationDegrees).toBeCloseTo(90, 10);
    const rotated = transformedBuildingDraft(rotating, rotation)!;
    const restored = transformBuildingGeometry(rotated, {
      anchor: rotation.anchor,
      rotationDegrees: -90,
    });
    expect(
      buildingGeometryAreaSqm({ ...base, geometry: restored }),
    ).toBeCloseTo(buildingGeometryAreaSqm(building), 5);
    expect(buildingDraftPivot(draft)).toEqual(draft.pivot);
    expect(buildingRotationHandle(draft)![0]).toBe(draft.pivot![0]);
    expect(buildingRotationHandle(draft)![1]).toBeGreaterThan(draft.pivot![1]);
    expect(buildingTransformAt(rotating, draft.pivot!)).toBeNull();
    expect(buildingTransformAt(moving, [NaN, 0])).toBeNull();
    expect(JSON.stringify(draft)).toBe(before);
  });
  it("snaps only to actual other-building vertices within both 12 pixels and 25 meters", () => {
    const project = (point: Position) => ({
      x: (point[0] + 112.07) * 100000,
      y: (point[1] - 33.45) * 100000,
    });
    const index = createBuildingSnapIndex(
      [building, legacy],
      project,
      legacy.id,
    );
    const position: Position = [-112.06968, 33.4503];
    const snap = nearestBuildingVertex(index, position, project(position));
    expect(snap).toMatchObject({
      buildingId: building.id,
      partIndex: 0,
      ringIndex: 1,
      vertexIndex: 0,
    });
    expect([...index.values()].flat()).toHaveLength(12);
    expect(createBuildingSnapIndex([building], project, building.id).size).toBe(
      0,
    );
    expect(
      nearestBuildingVertex(index, position, { x: 10000, y: 10000 }),
    ).toBeUndefined();
    const collapsed = createBuildingSnapIndex([building], () => ({
      x: 0,
      y: 0,
    }));
    expect(
      nearestBuildingVertex(collapsed, [-112.08, 33.45], { x: 0, y: 0 }),
    ).toBeUndefined();
    expect(buildingDraftCandidate(position, place, snap).position).toEqual(
      snap!.position,
    );
    expect(buildingDraftCandidate([-113, 34], place).inside).toBe(false);
  });
  it("isolates active modes and keeps Program previews visible while preventing editing and capture", () => {
    const context = {
      buildingDraft: draft,
      buildingEditingEnabled: true,
      view: "2d" as const,
    };
    expect(canEditBuildingDraft(context)).toBe(true);
    expect(
      canDisplayBuildingDraft({
        ...context,
        view: "3d",
        buildingEditingEnabled: false,
      }),
    ).toBe(true);
    expect(canEditBuildingDraft({ ...context, view: "3d" })).toBe(false);
    expect(
      canEditBuildingDraft({ ...context, buildingEditingEnabled: false }),
    ).toBe(false);
    for (const blocker of [
      { roadDraft: {} },
      { parcelDraft: {} },
      { revealScenario: {} },
      { selectingCommentLocation: true },
      { placingBuilding: true },
    ]) {
      expect(canEditBuildingDraft({ ...context, ...blocker })).toBe(false);
      expect(canDisplayBuildingDraft({ ...context, ...blocker })).toBe(false);
    }
    expect(
      canEditRoadDraft({
        view: "2d",
        roadDraft: {} as never,
        roadEditingEnabled: true,
        buildingDraft: draft,
      }),
    ).toBe(false);
    expect(
      canEditParcelDraft({
        view: "2d",
        parcelDraft: {} as never,
        parcelEditingEnabled: true,
        buildingDraft: draft,
      }),
    ).toBe(false);
    expect(
      canSelectParcel({
        view: "2d",
        parcelSelectionEnabled: true,
        buildingDraft: draft,
      }),
    ).toBe(false);
    expect(() => assertBuildingDraftCaptureAllowed(draft)).toThrow(
      /Apply or discard the building draft/,
    );
    expect(() => assertBuildingDraftCaptureAllowed(null)).not.toThrow();
    const key = {
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
    };
    expect(buildingDraftCommandForKey({ ...key, key: "Enter" }, true)).toBe(
      "finish",
    );
    expect(
      buildingDraftCommandForKey({ ...key, key: "Escape" }, false),
    ).toBeUndefined();
    expect(
      buildingDraftCommandForKey(
        { ...key, key: "Delete", ctrlKey: true },
        true,
      ),
    ).toBeUndefined();
  });
});
