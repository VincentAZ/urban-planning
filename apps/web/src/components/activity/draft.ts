import type {
  ActivityScenario,
  CountTarget,
  Position,
  Source,
  StudyAreaGeometry,
  Scenario,
} from "@urban/core";
import { parcelDraftGeometry, parcelDraftRings } from "../../lib/parcel-draft";
import type {
  MapNeighborhoodDraft,
  MapNeighborhoodRing,
} from "../map/neighborhood-drawing";

export interface AreaDraft {
  id: string;
  name: string;
  rings: MapNeighborhoodRing[];
  originalType?: StudyAreaGeometry["type"];
  population?: CountTarget;
  employment?: CountTarget;
  activeRingId: string | null;
  selectedVertexIndex: number | null;
  mode: MapNeighborhoodDraft["mode"];
  brushRadiusMeters: number;
  coordinateText: string;
}
export interface ActivityDraftValue {
  activity: ActivityScenario;
  horizon: Scenario["horizon"];
  sources: Source[];
  area: AreaDraft | null;
}
export interface ActivityDraft extends ActivityDraftValue {
  id: string;
  scope: string;
  revision: number;
  past: ActivityDraftValue[];
  future: ActivityDraftValue[];
}
export const areaRings = parcelDraftRings;
export const areaGeometry = parcelDraftGeometry;
export function activeAreaPath(area: AreaDraft): readonly Position[] {
  return (
    area.rings.find((ring) => ring.id === area.activeRingId)?.coordinates ?? []
  );
}
export function draftValue(draft: ActivityDraft): ActivityDraftValue {
  return {
    activity: draft.activity,
    horizon: draft.horizon,
    sources: draft.sources,
    area: draft.area,
  };
}
function historyValue(draft: ActivityDraft): ActivityDraftValue {
  const value = draftValue(draft);
  return {
    ...value,
    area: value.area ? { ...value.area, coordinateText: "" } : null,
  };
}
export function changeActivityDraft(
  draft: ActivityDraft,
  value: ActivityDraftValue,
): ActivityDraft {
  return {
    ...draft,
    ...value,
    revision: draft.revision + 1,
    past: [...draft.past, historyValue(draft)],
    future: [],
  };
}
export function travelActivityDraft(
  draft: ActivityDraft,
  direction: "undo" | "redo",
): ActivityDraft {
  if (draft.area?.coordinateText.trim()) return draft;
  const value = direction === "undo" ? draft.past.at(-1) : draft.future[0];
  if (!value) return draft;
  return {
    ...draft,
    ...value,
    revision: draft.revision + 1,
    past:
      direction === "undo"
        ? draft.past.slice(0, -1)
        : [...draft.past, historyValue(draft)],
    future:
      direction === "undo"
        ? [historyValue(draft), ...draft.future]
        : draft.future.slice(1),
  };
}
export function replaceAreaGeometry(
  area: AreaDraft,
  geometry: StudyAreaGeometry | null,
): AreaDraft {
  const rings = areaRings(geometry ?? undefined);
  return {
    ...area,
    rings,
    originalType: geometry?.type ?? area.originalType,
    activeRingId: rings[0]?.id ?? null,
    selectedVertexIndex: null,
  };
}
export function parseAreaCoordinates(text: string): Position[] {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length > 500)
    throw new Error(
      "Use at most 500 points in one ring. No points were discarded.",
    );
  const coordinates = lines.map((line, index): Position => {
    const values = line.trim().split(/[\s,]+/);
    if (
      values.length !== 2 ||
      values.some((value) => !value.trim() || !Number.isFinite(Number(value)))
    )
      throw new Error(`Line ${index + 1}: enter longitude, latitude.`);
    const [longitude, latitude] = values.map(Number);
    if (Math.abs(longitude) > 180 || Math.abs(latitude) > 85)
      throw new Error(
        `Line ${index + 1}: coordinate is outside the supported map.`,
      );
    return [longitude, latitude];
  });
  if (
    coordinates.length > 1 &&
    coordinates[0].every((n, i) => n === coordinates.at(-1)![i])
  )
    coordinates.pop();
  return coordinates;
}
