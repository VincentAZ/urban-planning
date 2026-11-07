import type { Position, Road } from "@urban/core";

export interface StreetDraftValue {
  name: string;
  coordinates: Position[];
}
export interface StreetDraft {
  id: string;
  scope: string;
  original: Road | null;
  value: StreetDraftValue;
  mode: "draw" | "reshape";
  selectedVertexIndex: number | null;
  snapToRoads: boolean;
  coordinateText: string;
  past: StreetDraftValue[];
  future: StreetDraftValue[];
}
export function changeStreetDraft(
  draft: StreetDraft,
  value: StreetDraftValue,
): StreetDraft {
  if (
    value.name === draft.value.name &&
    value.coordinates === draft.value.coordinates
  )
    return draft;
  return {
    ...draft,
    value,
    past: [...draft.past, draft.value],
    future: [],
    selectedVertexIndex:
      draft.selectedVertexIndex !== null &&
      draft.selectedVertexIndex < value.coordinates.length
        ? draft.selectedVertexIndex
        : null,
  };
}
export function undoStreetDraft(draft: StreetDraft): StreetDraft {
  const value = draft.past.at(-1);
  if (!value) return draft;
  return {
    ...draft,
    value,
    past: draft.past.slice(0, -1),
    future: [draft.value, ...draft.future],
    selectedVertexIndex: null,
  };
}
export function redoStreetDraft(draft: StreetDraft): StreetDraft {
  const value = draft.future[0];
  if (!value) return draft;
  return {
    ...draft,
    value,
    past: [...draft.past, draft.value],
    future: draft.future.slice(1),
    selectedVertexIndex: null,
  };
}
