import {
  MAX_AUTHORED_ROAD_POINTS,
  pointInStudyArea,
  type Place,
  type Position,
  type Road,
} from "@urban/core";

export interface MapRoadDraft {
  id: string;
  mode: "draw" | "reshape";
  roadId?: string;
  coordinates: readonly Position[];
  selectedVertexIndex: number | null;
  snapToRoads: boolean;
}
export interface MapRoadDraftChange {
  kind: "append" | "move";
  vertexIndex: number;
  snap?: { roadId: string; vertexIndex: number };
}
export type MapRoadDraftCommand = "finish" | "cancel" | "delete-vertex";
export interface RoadDrawingProps {
  roadDraft?: MapRoadDraft | null;
  roadEditingEnabled?: boolean;
  onRoadDraftChange?: (
    coordinates: Position[],
    detail: MapRoadDraftChange,
  ) => void;
  onRoadVertexSelect?: (index: number) => void;
  onRoadDraftCommand?: (command: MapRoadDraftCommand) => void;
}
export interface RoadDrawingContext extends RoadDrawingProps {
  view: "2d" | "3d" | "satellite";
  buildingDraft?: unknown;
  parcelDraft?: unknown;
  neighborhoodDraft?: unknown;
  revealScenario?: unknown;
  selectingCommentLocation?: boolean;
}
export function canEditRoadDraft(context: RoadDrawingContext): boolean {
  return (
    !!context.roadDraft &&
    context.roadEditingEnabled === true &&
    context.view === "2d" &&
    !context.buildingDraft &&
    !context.parcelDraft &&
    !context.neighborhoodDraft &&
    !context.revealScenario &&
    !context.selectingCommentLocation
  );
}

const radians = Math.PI / 180;
export function roadPointDistance(a: Position, b: Position): number {
  const lat = (b[1] - a[1]) * radians,
    lon = (b[0] - a[0]) * radians;
  const chord =
    Math.sin(lat / 2) ** 2 +
    Math.cos(a[1] * radians) *
      Math.cos(b[1] * radians) *
      Math.sin(lon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, chord))));
}
type Pixel = { x: number; y: number };
export interface RoadSnap {
  roadId: string;
  vertexIndex: number;
  position: Position;
  name: string;
}
type SnapVertex = RoadSnap & Pixel;
export type RoadSnapIndex = ReadonlyMap<string, readonly SnapVertex[]>;
export interface RoadDraftCandidate {
  position: Position;
  snap?: RoadSnap;
  inside: boolean;
}
const SNAP_PIXELS = 12;
const SNAP_METERS = 25;
const bucket = (x: number, y: number) => `${x},${y}`;

/** Rebuild on source/camera changes, never scan/project a city's vertices per pointer event. */
export function createRoadSnapIndex(
  roads: readonly Road[],
  project: (position: Position) => Pixel,
  excludedRoadId?: string,
): RoadSnapIndex {
  const index = new Map<string, SnapVertex[]>();
  for (const road of roads) {
    if (road.id === excludedRoadId) continue;
    road.coordinates.forEach((position, vertexIndex) => {
      if (!position.every(Number.isFinite)) return;
      const pixel = project(position);
      if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) return;
      const key = bucket(
        Math.floor(pixel.x / SNAP_PIXELS),
        Math.floor(pixel.y / SNAP_PIXELS),
      );
      const values = index.get(key) ?? [];
      values.push({
        ...pixel,
        roadId: road.id,
        vertexIndex,
        position,
        name: road.name,
      });
      index.set(key, values);
    });
  }
  return index;
}

/** Alignment only: a shared coordinate does not infer routing/intersection topology. */
export function nearestRoadVertex(
  index: RoadSnapIndex,
  position: Position,
  pixel: Pixel,
): RoadSnap | undefined {
  let closest: SnapVertex | undefined,
    closestPixels = SNAP_PIXELS;
  const x = Math.floor(pixel.x / SNAP_PIXELS),
    y = Math.floor(pixel.y / SNAP_PIXELS);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      for (const candidate of index.get(bucket(x + dx, y + dy)) ?? []) {
        const pixels = Math.hypot(candidate.x - pixel.x, candidate.y - pixel.y);
        if (
          pixels <= closestPixels &&
          roadPointDistance(position, candidate.position) <= SNAP_METERS
        ) {
          closest = candidate;
          closestPixels = pixels;
        }
      }
    }
  return closest;
}

export function roadDraftCandidate(
  position: Position,
  place: Place,
  snap?: RoadSnap,
): RoadDraftCandidate {
  const result = snap ? snap.position : position;
  return { position: result, snap, inside: pointInStudyArea(result, place) };
}

export function changeRoadDraftPoint(
  draft: MapRoadDraft,
  position: Position,
  movedVertex?: number,
): { coordinates: Position[]; detail: MapRoadDraftChange } | null {
  if (
    !position.every(Number.isFinite) ||
    Math.abs(position[0]) > 180 ||
    Math.abs(position[1]) > 90
  )
    return null;
  const moving = movedVertex !== undefined || draft.mode === "reshape";
  const vertexIndex =
    movedVertex ??
    (moving ? draft.selectedVertexIndex : draft.coordinates.length);
  if (
    vertexIndex === null ||
    !Number.isInteger(vertexIndex) ||
    vertexIndex < 0 ||
    (moving && vertexIndex >= draft.coordinates.length)
  )
    return null;
  if (!moving && draft.coordinates.length >= MAX_AUTHORED_ROAD_POINTS)
    return null;
  if (
    !moving &&
    draft.coordinates.length &&
    roadPointDistance(draft.coordinates.at(-1)!, position) < 0.05
  )
    return null;
  const coordinates = draft.coordinates.map((point): Position => [...point]);
  coordinates[vertexIndex] = [...position];
  return {
    coordinates,
    detail: { kind: moving ? "move" : "append", vertexIndex },
  };
}

export function roadDraftCommandForKey(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing"
  >,
  mapFocused: boolean,
): MapRoadDraftCommand | undefined {
  if (
    !mapFocused ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing
  )
    return;
  if (event.key === "Enter") return "finish";
  if (event.key === "Escape") return "cancel";
  if (event.key === "Delete" || event.key === "Backspace")
    return "delete-vertex";
}

export function assertRoadDraftCaptureAllowed(
  draft?: MapRoadDraft | null,
): void {
  if (draft)
    throw new Error(
      "Finish or discard street drawing before exporting the map.",
    );
}
