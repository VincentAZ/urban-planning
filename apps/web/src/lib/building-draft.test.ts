import { describe, it, expect } from "vitest";
import { typedBuildingPreset } from "@urban/models";
import { canonicalJSON } from "@urban/core";
import {
  activeBuildingPath,
  changeBuildingDraft,
  redoBuildingDraft,
  undoBuildingDraft,
  type BuildingDraft,
} from "./building-draft";
function fixture(): BuildingDraft {
  const building = typedBuildingPreset("apartments", [-112.07, 33.45]);
  return {
    id: "draft",
    scope: "project:scenario:2",
    original: structuredClone(building),
    value: {
      building,
      rings: [
        {
          id: "outer",
          partIndex: 0,
          ringIndex: 0,
          coordinates: [
            [-112.071, 33.45],
            [-112.069, 33.45],
            [-112.069, 33.452],
          ],
        },
      ],
    },
    section: "footprint",
    activeRingId: "outer",
    mode: "reshape",
    selectedVertexIndex: 2,
    snapToVertices: false,
    coordinateText: "",
    past: [],
    future: [],
  };
}
describe("atomic building draft history", () => {
  it("undoes and redoes program and geometry together without touching the captured original", () => {
    const start = fixture(),
      original = canonicalJSON(start.original),
      value = structuredClone(start.value);
    value.rings[0].coordinates = value.rings[0].coordinates.map(
      (point, index) => (index === 1 ? [-112.0685, 33.45] : point),
    );
    value.building.program!.components[0].units = 60;
    value.building.units = 60;
    const changed = changeBuildingDraft(start, value);
    expect(changed.past).toHaveLength(1);
    expect(start.value.building.units).toBe(48);
    const undone = undoBuildingDraft(changed);
    expect(undone.value).toEqual(start.value);
    expect(undone.selectedVertexIndex).toBeNull();
    const redone = redoBuildingDraft(undone);
    expect(redone.value).toEqual(value);
    expect(redone.future).toHaveLength(0);
    expect(canonicalJSON(redone.original)).toBe(original);
  });
  it("reconciles removed ring selection and never retargets pending coordinate text through undo/redo", () => {
    const start = fixture(),
      withHole = structuredClone(start.value);
    withHole.rings.push({
      id: "hole",
      partIndex: 0,
      ringIndex: 1,
      coordinates: [
        [-112.0705, 33.4505],
        [-112.0701, 33.4505],
        [-112.0701, 33.4508],
      ],
    });
    const selected = {
      ...changeBuildingDraft(start, withHole),
      activeRingId: "hole",
      selectedVertexIndex: 1,
    };
    const pending = { ...selected, coordinateText: "33.4507, -112.0703" };
    expect(undoBuildingDraft(pending)).toBe(pending);
    const undone = undoBuildingDraft(selected);
    expect(undone.activeRingId).toBe("outer");
    expect(undone.selectedVertexIndex).toBeNull();
    expect(activeBuildingPath(undone)).toEqual(
      start.value.rings[0].coordinates,
    );
    const pendingRedo = { ...undone, coordinateText: "33.45, -112.07" };
    expect(redoBuildingDraft(pendingRedo)).toBe(pendingRedo);
  });
  it("clears the future after a divergent edit and clears out-of-range vertex selection", () => {
    const start = fixture(),
      a = structuredClone(start.value);
    a.building.name = "A";
    const step = changeBuildingDraft(start, a),
      back = undoBuildingDraft(step),
      b = structuredClone(back.value);
    b.building.name = "B";
    b.rings[0].coordinates = b.rings[0].coordinates.slice(0, 2);
    const divergent = changeBuildingDraft(
      { ...back, selectedVertexIndex: 2 },
      b,
    );
    expect(divergent.future).toHaveLength(0);
    expect(divergent.selectedVertexIndex).toBeNull();
    expect(redoBuildingDraft(divergent)).toBe(divergent);
  });
  it("does not create a history step when passed the same value and tolerates an empty ring draft", () => {
    const start = fixture();
    expect(changeBuildingDraft(start, start.value)).toBe(start);
    const empty = changeBuildingDraft(start, {
      building: start.value.building,
      rings: [],
    });
    expect(empty.activeRingId).toBeNull();
    expect(activeBuildingPath(empty)).toEqual([]);
    expect(empty.selectedVertexIndex).toBeNull();
  });
});
