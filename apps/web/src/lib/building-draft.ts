import type { Building, Position } from "@urban/core";
import type {
  MapBuildingDraft,
  MapBuildingRing,
} from "../components/map/building-drawing";

export interface BuildingDraftValue {
  building: Building;
  rings: MapBuildingRing[];
}
export interface BuildingDraft {
  id: string;
  scope: string;
  original: Building | null;
  value: BuildingDraftValue;
  section: "program" | "footprint";
  activeRingId: string | null;
  mode: MapBuildingDraft["mode"];
  selectedVertexIndex: number | null;
  snapToVertices: boolean;
  coordinateText: string;
  past: BuildingDraftValue[];
  future: BuildingDraftValue[];
}
export function activeBuildingPath(draft: BuildingDraft): readonly Position[] {
  return (
    draft.value.rings.find((ring) => ring.id === draft.activeRingId)
      ?.coordinates ?? []
  );
}
function reconcile(draft: BuildingDraft): BuildingDraft {
  const activeRingId = draft.value.rings.some(
    (ring) => ring.id === draft.activeRingId,
  )
    ? draft.activeRingId
    : (draft.value.rings[0]?.id ?? null);
  const next = { ...draft, activeRingId };
  return {
    ...next,
    selectedVertexIndex:
      next.selectedVertexIndex !== null &&
      next.selectedVertexIndex >= 0 &&
      next.selectedVertexIndex < activeBuildingPath(next).length
        ? next.selectedVertexIndex
        : null,
  };
}
export function changeBuildingDraft(
  draft: BuildingDraft,
  value: BuildingDraftValue,
): BuildingDraft {
  if (value === draft.value) return draft;
  return reconcile({
    ...draft,
    value,
    past: [...draft.past, draft.value],
    future: [],
  });
}
export function undoBuildingDraft(draft: BuildingDraft): BuildingDraft {
  if (draft.coordinateText.trim()) return draft;
  const value = draft.past.at(-1);
  return value
    ? reconcile({
        ...draft,
        value,
        selectedVertexIndex: null,
        past: draft.past.slice(0, -1),
        future: [draft.value, ...draft.future],
      })
    : draft;
}
export function redoBuildingDraft(draft: BuildingDraft): BuildingDraft {
  if (draft.coordinateText.trim()) return draft;
  const value = draft.future[0];
  return value
    ? reconcile({
        ...draft,
        value,
        selectedVertexIndex: null,
        past: [...draft.past, draft.value],
        future: draft.future.slice(1),
      })
    : draft;
}
