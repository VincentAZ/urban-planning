import {
  MAX_ACTIVITY_RING_POINTS,
  MAX_BRUSH_STROKE_POINTS,
  type Position,
  type StudyAreaGeometry,
  type NeighborhoodBrushStroke,
} from "@urban/core";
import { changeBuildingDraftPoint } from "./building-drawing";
import type { MapParcelRing } from "./parcel-drawing";
import { roadPointDistance, roadDraftCommandForKey } from "./road-drawing";
export type MapNeighborhoodRing = MapParcelRing;
export interface MapNeighborhoodDraft {
  id: string;
  revision: number;
  neighborhoodId?: string;
  mode: "paint" | "erase" | "draw" | "reshape" | "pan";
  rings: readonly MapNeighborhoodRing[];
  activeRingId: string | null;
  selectedVertexIndex: number | null;
  previewGeometry: StudyAreaGeometry | null;
  excludedGeometry?: StudyAreaGeometry | null;
  brushRadiusMeters: number;
  busy?: boolean;
}
export interface MapNeighborhoodStroke extends NeighborhoodBrushStroke {
  draftId: string;
  draftRevision: number;
}
export interface MapNeighborhoodDraftChange {
  ringId: string;
  kind: "append" | "move";
  vertexIndex: number;
}
export interface MapNeighborhoodSummary {
  id: string;
  populationLabel: string;
  employmentLabel: string;
  statusLabel: string;
}
export interface NeighborhoodDrawingProps {
  neighborhoodDraft?: MapNeighborhoodDraft | null;
  neighborhoodEditingEnabled?: boolean;
  onNeighborhoodBrushStroke?: (stroke: MapNeighborhoodStroke) => void;
  onNeighborhoodDraftPathChange?: (
    coordinates: Position[],
    detail: MapNeighborhoodDraftChange,
  ) => void;
  onNeighborhoodVertexSelect?: (ringId: string, index: number) => void;
  onNeighborhoodDraftCommand?: (
    command: "finish" | "cancel" | "delete-vertex",
  ) => void;
  neighborhoodSelectionEnabled?: boolean;
  selectedNeighborhoodId?: string | null;
  onNeighborhoodSelect?: (id: string | null) => void;
  neighborhoodSummaries?: readonly MapNeighborhoodSummary[];
}
export interface NeighborhoodDrawingContext extends NeighborhoodDrawingProps {
  view: "2d" | "3d" | "satellite";
  roadDraft?: unknown;
  parcelDraft?: unknown;
  buildingDraft?: unknown;
  revealScenario?: unknown;
  placingBuilding?: boolean;
  selectingCommentLocation?: boolean;
}
export function canDisplayNeighborhoodDraft(value: NeighborhoodDrawingContext) {
  return (
    !!value.neighborhoodDraft &&
    !value.roadDraft &&
    !value.parcelDraft &&
    !value.buildingDraft &&
    !value.revealScenario &&
    !value.placingBuilding &&
    !value.selectingCommentLocation
  );
}
export function canEditNeighborhoodDraft(value: NeighborhoodDrawingContext) {
  return (
    canDisplayNeighborhoodDraft(value) &&
    value.neighborhoodEditingEnabled === true &&
    value.view === "2d" &&
    !value.neighborhoodDraft?.busy
  );
}
export function canSelectNeighborhood(value: NeighborhoodDrawingContext) {
  return (
    value.neighborhoodSelectionEnabled === true &&
    !value.neighborhoodDraft &&
    !value.roadDraft &&
    !value.parcelDraft &&
    !value.buildingDraft &&
    !value.revealScenario &&
    !value.placingBuilding &&
    !value.selectingCommentLocation
  );
}
export function changeNeighborhoodDraftPoint(
  draft: MapNeighborhoodDraft,
  position: Position,
  movedVertex?: number,
) {
  if (draft.mode !== "draw" && draft.mode !== "reshape") return null;
  return changeBuildingDraftPoint(
    {
      ...draft,
      previewGeometry: draft.previewGeometry ?? undefined,
      mode: draft.mode,
      height: 0,
      snapToVertices: false,
    },
    position,
    MAX_ACTIVITY_RING_POINTS,
    movedVertex,
  );
}
export function neighborhoodStrokeCurrent(
  stroke: Pick<
    MapNeighborhoodStroke,
    "draftId" | "draftRevision" | "operation"
  >,
  context: NeighborhoodDrawingContext,
) {
  const draft = context.neighborhoodDraft;
  return (
    canEditNeighborhoodDraft(context) &&
    draft?.id === stroke.draftId &&
    draft.revision === stroke.draftRevision &&
    draft.mode === (stroke.operation === "add" ? "paint" : "erase")
  );
}
/** Pointer sampling is bounded, while buffered segments fill between accepted samples. No end truncation. */
export function appendNeighborhoodStrokePoint(
  path: readonly Position[],
  position: Position,
  radius: number,
  final = false,
): Position[] {
  if (
    !position.every(Number.isFinite) ||
    Math.abs(position[0]) > 180 ||
    Math.abs(position[1]) > 85
  )
    throw new Error("Keep the brush within the map.");
  const last = path.at(-1),
    distance = last ? roadPointDistance(last, position) : Infinity;
  if (distance < 0.01 || (!final && distance < Math.max(0.25, radius / 12)))
    return path as Position[];
  if (path.length >= MAX_BRUSH_STROKE_POINTS)
    throw new Error(
      `This stroke reached ${MAX_BRUSH_STROKE_POINTS} points. Use a shorter stroke; your previous boundary is unchanged.`,
    );
  return [...path, [...position]];
}
export const neighborhoodDraftCommandForKey = roadDraftCommandForKey;
export function assertNeighborhoodDraftCaptureAllowed(
  draft?: MapNeighborhoodDraft | null,
) {
  if (draft)
    throw new Error(
      "Finish or discard the neighborhood draft before exporting a map image.",
    );
}
export interface NeighborhoodMapPart {
  neighborhoodId: string;
  name: string;
  partIndex: number;
  rings: Position[][];
}
export function neighborhoodMapParts(
  areas: readonly { id: string; name: string; geometry: StudyAreaGeometry }[],
): NeighborhoodMapPart[] {
  return areas.flatMap((area) =>
    (area.geometry.type === "Polygon"
      ? [area.geometry.coordinates]
      : area.geometry.coordinates
    ).map((rings, partIndex) => ({
      neighborhoodId: area.id,
      name: area.name,
      partIndex,
      rings,
    })),
  );
}
/** Annotation only; ordinary depth testing keeps buildings and network visible. */
export function neighborhoodSurfaceRings(
  part: NeighborhoodMapPart,
): [number, number, number][][] {
  return part.rings.map((ring) => ring.map(([lng, lat]) => [lng, lat, 0.025]));
}
