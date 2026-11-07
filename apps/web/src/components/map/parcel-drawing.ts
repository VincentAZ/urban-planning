import {
  pointInStudyArea,
  studyAreaBounds,
  type Parcel,
  type Place,
  type Polygon,
  type Position,
  type StudyAreaGeometry,
} from "@urban/core";
import { roadPointDistance, roadDraftCommandForKey } from "./road-drawing";

export interface MapParcelRing {
  id: string;
  partIndex: number;
  ringIndex: number;
  /** Open editing ring; the repeated closing coordinate is never an editable vertex. */
  coordinates: readonly Position[];
}
export interface MapParcelDraft {
  id: string;
  operation: "draw" | "reshape" | "split" | "assemble";
  rings: readonly MapParcelRing[];
  activeRingId: string | null;
  mode: "draw" | "reshape";
  selectedVertexIndex: number | null;
  splitLine: readonly Position[];
  sourceParcelIds: readonly string[];
  previewGeometries?: readonly StudyAreaGeometry[];
  snapToParcels: boolean;
}
export interface MapParcelDraftChange {
  ringId: string | null;
  kind: "append" | "move";
  vertexIndex: number;
  snap?: {
    parcelId: string;
    partIndex: number;
    ringIndex: number;
    vertexIndex: number;
  };
}
export type MapParcelDraftPathChange = MapParcelDraftChange;
export interface ParcelDrawingProps {
  parcelDraft?: MapParcelDraft | null;
  parcelEditingEnabled?: boolean;
  onParcelDraftPathChange?: (
    coordinates: Position[],
    detail: MapParcelDraftChange,
  ) => void;
  onParcelVertexSelect?: (ringId: string | null, index: number) => void;
  onParcelDraftCommand?: (
    command: "finish" | "cancel" | "delete-vertex",
  ) => void;
  selectedParcelIds?: readonly string[];
  parcelSelectionEnabled?: boolean;
  onParcelSelect?: (id: string | null) => void;
}
export interface ParcelDrawingContext extends ParcelDrawingProps {
  view: "2d" | "3d" | "satellite";
  roadDraft?: unknown;
  buildingDraft?: unknown;
  neighborhoodDraft?: unknown;
  revealScenario?: unknown;
  selectingCommentLocation?: boolean;
  placingBuilding?: boolean;
}
export function canEditParcelDraft(context: ParcelDrawingContext): boolean {
  return (
    !!context.parcelDraft &&
    context.parcelEditingEnabled === true &&
    context.view === "2d" &&
    !context.roadDraft &&
    !context.buildingDraft &&
    !context.neighborhoodDraft &&
    !context.revealScenario &&
    !context.selectingCommentLocation &&
    !context.placingBuilding
  );
}
export function canSelectParcel(context: ParcelDrawingContext): boolean {
  return (
    context.parcelSelectionEnabled === true &&
    !context.roadDraft &&
    !context.buildingDraft &&
    !context.neighborhoodDraft &&
    !context.revealScenario &&
    !context.selectingCommentLocation &&
    !context.placingBuilding &&
    (!context.parcelDraft ||
      (context.parcelDraft.operation === "assemble" &&
        canEditParcelDraft(context)))
  );
}
export function activeParcelPath(
  draft: MapParcelDraft,
): { ringId: string | null; coordinates: readonly Position[] } | null {
  if (draft.operation === "assemble") return null;
  if (draft.operation === "split")
    return { ringId: null, coordinates: draft.splitLine };
  const ring = draft.rings.find((item) => item.id === draft.activeRingId);
  return ring ? { ringId: ring.id, coordinates: ring.coordinates } : null;
}
export function changeParcelDraftPoint(
  draft: MapParcelDraft,
  position: Position,
  maxRingPoints: number,
  movedVertex?: number,
): { coordinates: Position[]; detail: MapParcelDraftChange } | null {
  const path = activeParcelPath(draft);
  if (
    !path ||
    !position.every(Number.isFinite) ||
    Math.abs(position[0]) > 180 ||
    Math.abs(position[1]) > 90
  )
    return null;
  const moving = movedVertex !== undefined || draft.mode === "reshape";
  const vertexIndex =
    movedVertex ??
    (moving ? draft.selectedVertexIndex : path.coordinates.length);
  if (
    vertexIndex === null ||
    !Number.isInteger(vertexIndex) ||
    vertexIndex < 0 ||
    (moving && vertexIndex >= path.coordinates.length)
  )
    return null;
  if (
    !moving &&
    path.coordinates.length >= (draft.operation === "split" ? 2 : maxRingPoints)
  )
    return null;
  if (
    !moving &&
    path.coordinates.length &&
    roadPointDistance(path.coordinates.at(-1)!, position) < 0.05
  )
    return null;
  // Clicking the first point is not an implicit commit/duplicate closing vertex.
  if (
    !moving &&
    draft.operation !== "split" &&
    path.coordinates.length > 2 &&
    roadPointDistance(path.coordinates[0], position) < 0.05
  )
    return null;
  const coordinates = path.coordinates.map((point): Position => [...point]);
  coordinates[vertexIndex] = [...position];
  return {
    coordinates,
    detail: {
      ringId: path.ringId,
      kind: moving ? "move" : "append",
      vertexIndex,
    },
  };
}
export function closedParcelRing(points: readonly Position[]): Polygon {
  if (!points.length) return [];
  const result = points.map((point): Position => [...point]);
  if (result[0][0] !== result.at(-1)![0] || result[0][1] !== result.at(-1)![1])
    result.push([...result[0]]);
  return result;
}
/** Returns no fill while ANY ring is incomplete: never silently fills a pending hole. */
export function draftParcelGeometry(
  rings: readonly MapParcelRing[],
): StudyAreaGeometry | null {
  if (!rings.length || rings.some((ring) => ring.coordinates.length < 3))
    return null;
  const grouped = new Map<number, MapParcelRing[]>();
  for (const ring of rings) {
    if (
      !Number.isInteger(ring.partIndex) ||
      ring.partIndex < 0 ||
      !Number.isInteger(ring.ringIndex) ||
      ring.ringIndex < 0
    )
      return null;
    grouped.set(ring.partIndex, [...(grouped.get(ring.partIndex) ?? []), ring]);
  }
  const polygons: Polygon[][] = [];
  for (const [, part] of [...grouped].sort(([a], [b]) => a - b)) {
    const sorted = [...part].sort((a, b) => a.ringIndex - b.ringIndex);
    if (sorted.some((ring, index) => ring.ringIndex !== index)) return null;
    polygons.push(sorted.map((ring) => closedParcelRing(ring.coordinates)));
  }
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}
export interface ParcelMapPart {
  parcelId: string;
  partIndex: number;
  kind: Parcel["kind"];
  name: string;
  rings: Polygon[];
}
/** A display-only lift above the study-area ground, below the 12 cm park surface. */
export const PARCEL_SURFACE_HEIGHT_METERS = 0.04;
export function parcelSurfaceRings(
  part: ParcelMapPart,
): [number, number, number][][] {
  return part.rings.map((ring) =>
    ring.map(([longitude, latitude]) => [
      longitude,
      latitude,
      PARCEL_SURFACE_HEIGHT_METERS,
    ]),
  );
}
export function parcelMapParts(parcels: readonly Parcel[]): ParcelMapPart[] {
  return parcels.flatMap((parcel) =>
    (parcel.geometry.type === "Polygon"
      ? [parcel.geometry.coordinates]
      : parcel.geometry.coordinates
    ).map((rings, partIndex) => ({
      parcelId: parcel.id,
      kind: parcel.kind,
      name: parcel.name,
      partIndex,
      rings,
    })),
  );
}
export function previewParcelParts(
  geometries: readonly StudyAreaGeometry[],
): { rings: Polygon[]; outputIndex: number }[] {
  return geometries.flatMap((geometry, outputIndex) =>
    (geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates
    ).map((rings) => ({ rings, outputIndex })),
  );
}

interface Pixel {
  x: number;
  y: number;
}
export interface ParcelSnap {
  parcelId: string;
  partIndex: number;
  ringIndex: number;
  vertexIndex: number;
  position: Position;
  name: string;
}
type SnapVertex = ParcelSnap & Pixel;
export type ParcelSnapIndex = ReadonlyMap<string, readonly SnapVertex[]>;
export function createParcelSnapIndex(
  parcels: readonly Parcel[],
  project: (point: Position) => Pixel,
  excluded: readonly string[],
): ParcelSnapIndex {
  const index = new Map<string, SnapVertex[]>(),
    excludedIds = new Set(excluded);
  for (const part of parcelMapParts(parcels)) {
    if (excludedIds.has(part.parcelId)) continue;
    part.rings.forEach((ring, ringIndex) =>
      ring.forEach((position, vertexIndex) => {
        if (
          vertexIndex === ring.length - 1 &&
          position[0] === ring[0][0] &&
          position[1] === ring[0][1]
        )
          return;
        const pixel = project(position);
        if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) return;
        const key = `${Math.floor(pixel.x / 12)},${Math.floor(pixel.y / 12)}`;
        const values = index.get(key) ?? [];
        values.push({
          ...pixel,
          position,
          parcelId: part.parcelId,
          partIndex: part.partIndex,
          ringIndex,
          vertexIndex,
          name: part.name,
        });
        index.set(key, values);
      }),
    );
  }
  return index;
}
export function nearestParcelVertex(
  index: ParcelSnapIndex,
  position: Position,
  pixel: Pixel,
): ParcelSnap | undefined {
  let closest: SnapVertex | undefined,
    pixels = 12;
  const x = Math.floor(pixel.x / 12),
    y = Math.floor(pixel.y / 12);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const candidate of index.get(`${x + dx},${y + dy}`) ?? []) {
        const distance = Math.hypot(
          candidate.x - pixel.x,
          candidate.y - pixel.y,
        );
        if (
          distance <= pixels &&
          roadPointDistance(position, candidate.position) <= 25
        ) {
          closest = candidate;
          pixels = distance;
        }
      }
  return closest;
}
export function parcelDraftCandidate(
  position: Position,
  place: Place,
  snap?: ParcelSnap,
) {
  const result = snap?.position ?? position;
  return { position: result, snap, inside: pointInStudyArea(result, place) };
}
/** Only a visual guide clipped to study bounds, not an area-buffering/splitting operation. */
export function extendedParcelCut(
  line: readonly Position[],
  place: Place,
): Position[] {
  if (line.length !== 2) return line.map((point): Position => [...point]);
  const [a, b] = line,
    dx = b[0] - a[0],
    dy = b[1] - a[1];
  if (Math.abs(dx) + Math.abs(dy) < 1e-12) return [];
  const [west, south, east, north] = studyAreaBounds(place);
  let lo = -Infinity,
    hi = Infinity;
  for (const [origin, delta, min, max] of [
    [a[0], dx, west, east],
    [a[1], dy, south, north],
  ]) {
    if (Math.abs(delta) < 1e-15) {
      if (origin < min || origin > max) return [];
      continue;
    }
    const first = (min - origin) / delta,
      second = (max - origin) / delta;
    lo = Math.max(lo, Math.min(first, second));
    hi = Math.min(hi, Math.max(first, second));
  }
  return lo <= hi
    ? [
        [a[0] + lo * dx, a[1] + lo * dy],
        [a[0] + hi * dx, a[1] + hi * dy],
      ]
    : [];
}
export const parcelDraftCommandForKey = roadDraftCommandForKey;
export function assertParcelDraftCaptureAllowed(
  draft?: MapParcelDraft | null,
): void {
  if (draft)
    throw new Error(
      "Apply or discard parcel editing before exporting the map.",
    );
}
