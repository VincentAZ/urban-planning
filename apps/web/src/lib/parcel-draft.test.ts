import { describe, expect, it } from "vitest";
import type { StudyAreaGeometry } from "@urban/core";
import {
  changeParcelDraft,
  parcelDraftGeometry,
  parcelDraftRings,
  redoParcelDraft,
  undoParcelDraft,
  type ParcelDraft,
} from "./parcel-draft";

const geometry: StudyAreaGeometry = {
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
        [2, 1],
        [2, 2],
        [1, 2],
        [1, 1],
      ],
    ],
  ],
};
const createDraft = (): ParcelDraft => ({
  id: "draft",
  scope: "project:scenario:1",
  operation: "reshape",
  value: {
    name: "Courtyard",
    kind: "parcel",
    rings: parcelDraftRings(geometry),
    splitLine: [],
    sourceParcelIds: ["source-parcel"],
  },
  activeRingId: null,
  mode: "reshape",
  selectedVertexIndex: null,
  snapToParcels: true,
  coordinateText: "",
  past: [],
  future: [],
});

describe("parcel draft identity and coordinate ownership", () => {
  it("preserves a supplied single-component MultiPolygon and its hole when opened for reshape", () => {
    const original = structuredClone(geometry);
    const rings = parcelDraftRings(geometry);
    expect(parcelDraftGeometry(rings, geometry.type)).toEqual(geometry);
    expect(geometry).toEqual(original);
    rings[0].coordinates = rings[0].coordinates.map((point, index) =>
      index === 1 ? [5, 0] : point,
    );
    const reshaped = parcelDraftGeometry(rings, geometry.type);
    expect(reshaped.type).toBe("MultiPolygon");
    expect(reshaped.coordinates[0][1]).toEqual(original.coordinates[0][1]);
    expect(geometry).toEqual(original);
  });

  it("never redirects pending hole coordinates to another ring through undo or redo", () => {
    const initial = createDraft();
    initial.value.rings = initial.value.rings.slice(0, 1);
    initial.activeRingId = initial.value.rings[0].id;
    const hole = parcelDraftRings(geometry)[1];
    const withHole = changeParcelDraft(initial, {
      ...initial.value,
      rings: [...initial.value.rings, hole],
    });
    withHole.activeRingId = hole.id;
    withHole.coordinateText = "1, 1\n2, 1\n2, 2\n1, 2";
    expect(undoParcelDraft(withHole)).toBe(withHole);
    expect(undoParcelDraft(withHole).activeRingId).toBe(hole.id);

    const undone = undoParcelDraft({ ...withHole, coordinateText: "" });
    expect(undone.value.rings).toHaveLength(1);
    const pendingOuter = { ...undone, coordinateText: "0, 0\n5, 0\n5, 5" };
    expect(redoParcelDraft(pendingOuter)).toBe(pendingOuter);
    expect(
      redoParcelDraft({ ...pendingOuter, coordinateText: "" }).value.rings,
    ).toHaveLength(2);
  });
});
