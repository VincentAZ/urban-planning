import type { Parcel, Position, StudyAreaGeometry } from "@urban/core";
import type {
  MapParcelDraft,
  MapParcelRing,
} from "../components/map/parcel-drawing";

export interface ParcelDraftValue {
  name: string;
  kind: Parcel["kind"];
  rings: MapParcelRing[];
  splitLine: Position[];
  sourceParcelIds: string[];
}
export interface ParcelDraft {
  id: string;
  scope: string;
  operation: MapParcelDraft["operation"];
  value: ParcelDraftValue;
  activeRingId: string | null;
  mode: MapParcelDraft["mode"];
  selectedVertexIndex: number | null;
  snapToParcels: boolean;
  coordinateText: string;
  past: ParcelDraftValue[];
  future: ParcelDraftValue[];
}
export function parcelDraftRings(
  geometry?: StudyAreaGeometry,
): MapParcelRing[] {
  if (!geometry)
    return [
      { id: crypto.randomUUID(), partIndex: 0, ringIndex: 0, coordinates: [] },
    ];
  const parts =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return parts.flatMap((part, partIndex) =>
    part.map((ring, ringIndex) => ({
      id: crypto.randomUUID(),
      partIndex,
      ringIndex,
      coordinates: ring.slice(0, -1).map((point): Position => [...point]),
    })),
  );
}
export function parcelDraftGeometry(
  rings: readonly MapParcelRing[],
  originalType?: StudyAreaGeometry["type"],
): StudyAreaGeometry {
  const parts: Position[][][] = [];
  for (const ring of rings) {
    const points = ring.coordinates.map((point): Position => [...point]);
    if (points.length) points.push([...points[0]]);
    (parts[ring.partIndex] ??= [])[ring.ringIndex] = points;
  }
  return parts.length === 1 && originalType !== "MultiPolygon"
    ? { type: "Polygon", coordinates: parts[0] }
    : { type: "MultiPolygon", coordinates: parts };
}
export function activeParcelPath(draft: ParcelDraft): readonly Position[] {
  return draft.operation === "split"
    ? draft.value.splitLine
    : (draft.value.rings.find((ring) => ring.id === draft.activeRingId)
        ?.coordinates ?? []);
}
function reconcile(draft: ParcelDraft): ParcelDraft {
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
      next.selectedVertexIndex < activeParcelPath(next).length
        ? next.selectedVertexIndex
        : null,
  };
}
export function changeParcelDraft(
  draft: ParcelDraft,
  value: ParcelDraftValue,
): ParcelDraft {
  if (value === draft.value) return draft;
  return reconcile({
    ...draft,
    value,
    past: [...draft.past, draft.value],
    future: [],
  });
}
export function undoParcelDraft(draft: ParcelDraft): ParcelDraft {
  // Pending text belongs to the active ring. History must not retarget it.
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
export function redoParcelDraft(draft: ParcelDraft): ParcelDraft {
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
