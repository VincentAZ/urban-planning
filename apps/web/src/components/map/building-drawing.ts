import {
  BUILDING_EARTH_RADIUS_METERS,
  buildingGeometry,
  pointInStudyArea,
  studyAreaAnchor,
  transformBuildingGeometry,
  type Building,
  type Place,
  type Polygon,
  type Position,
  type StudyAreaGeometry,
} from "@urban/core";
import { draftParcelGeometry, type MapParcelRing } from "./parcel-drawing";
import { roadDraftCommandForKey, roadPointDistance } from "./road-drawing";

export type MapBuildingRing = MapParcelRing;
export interface MapBuildingDraft {
  id: string;
  buildingId?: string;
  rings: readonly MapBuildingRing[];
  activeRingId: string | null;
  mode: "draw" | "reshape" | "move" | "rotate";
  selectedVertexIndex: number | null;
  pivot?: Position;
  previewGeometry?: StudyAreaGeometry;
  height: number | null;
  snapToVertices: boolean;
}
export interface MapBuildingTransform {
  translateMeters?: [number, number];
  rotationDegrees?: number;
  anchor: Position;
}
export interface MapBuildingDraftChange {
  ringId: string;
  kind: "append" | "move";
  vertexIndex: number;
  snap?: {
    buildingId: string;
    partIndex: number;
    ringIndex: number;
    vertexIndex: number;
  };
}
export interface BuildingDrawingProps {
  buildingDraft?: MapBuildingDraft | null;
  buildingEditingEnabled?: boolean;
  onBuildingDraftPathChange?: (
    coordinates: Position[],
    detail: MapBuildingDraftChange,
  ) => void;
  onBuildingVertexSelect?: (ringId: string, index: number) => void;
  onBuildingDraftTransform?: (transform: MapBuildingTransform) => void;
  onBuildingDraftCommand?: (
    command: "finish" | "cancel" | "delete-vertex",
  ) => void;
}
export interface BuildingDrawingContext extends BuildingDrawingProps {
  view: "2d" | "3d" | "satellite";
  roadDraft?: unknown;
  parcelDraft?: unknown;
  neighborhoodDraft?: unknown;
  revealScenario?: unknown;
  selectingCommentLocation?: boolean;
  placingBuilding?: boolean;
}
export function canDisplayBuildingDraft(
  context: BuildingDrawingContext,
): boolean {
  return (
    !!context.buildingDraft &&
    !context.roadDraft &&
    !context.parcelDraft &&
    !context.neighborhoodDraft &&
    !context.revealScenario &&
    !context.selectingCommentLocation &&
    !context.placingBuilding
  );
}
export function canEditBuildingDraft(context: BuildingDrawingContext): boolean {
  return (
    canDisplayBuildingDraft(context) &&
    context.buildingEditingEnabled === true &&
    context.view === "2d"
  );
}
export function activeBuildingRing(
  draft: MapBuildingDraft,
): MapBuildingRing | null {
  return draft.rings.find((ring) => ring.id === draft.activeRingId) ?? null;
}
export function draftBuildingGeometry(
  draft: MapBuildingDraft,
): StudyAreaGeometry | null {
  const geometry = draftParcelGeometry(draft.rings);
  // Preserve a source MultiPolygon with a single component, just as the editor does.
  return geometry?.type === "Polygon" &&
    draft.previewGeometry?.type === "MultiPolygon"
    ? { type: "MultiPolygon", coordinates: [geometry.coordinates] }
    : geometry;
}
export function changeBuildingDraftPoint(
  draft: MapBuildingDraft,
  position: Position,
  maxRingPoints: number,
  movedVertex?: number,
): { coordinates: Position[]; detail: MapBuildingDraftChange } | null {
  const ring = activeBuildingRing(draft);
  if (
    !ring ||
    !["draw", "reshape"].includes(draft.mode) ||
    !position.every(Number.isFinite) ||
    Math.abs(position[0]) > 180 ||
    Math.abs(position[1]) > 90
  )
    return null;
  const moving = movedVertex !== undefined || draft.mode === "reshape";
  const index =
    movedVertex ??
    (moving ? draft.selectedVertexIndex : ring.coordinates.length);
  if (
    index === null ||
    !Number.isInteger(index) ||
    index < 0 ||
    (moving && index >= ring.coordinates.length) ||
    (!moving && ring.coordinates.length >= maxRingPoints)
  )
    return null;
  if (
    !moving &&
    ring.coordinates.length &&
    (roadPointDistance(ring.coordinates.at(-1)!, position) < 0.05 ||
      (ring.coordinates.length > 2 &&
        roadPointDistance(ring.coordinates[0], position) < 0.05))
  )
    return null;
  const coordinates = ring.coordinates.map((point): Position => [...point]);
  coordinates[index] = [...position];
  return {
    coordinates,
    detail: {
      ringId: ring.id,
      kind: moving ? "move" : "append",
      vertexIndex: index,
    },
  };
}

/** Each GPU part retains the actual building identity; no feature/program duplication. */
export interface BuildingMapPart {
  id: string;
  building: Building;
  partIndex: number;
  rings: Polygon[];
}
export function buildingMapParts(
  buildings: readonly Building[],
): BuildingMapPart[] {
  return buildings.flatMap((building) => {
    const geometry = buildingGeometry(building);
    return (
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates
    ).map((rings, partIndex) => ({
      id: building.id,
      building,
      partIndex,
      rings,
    }));
  });
}
export interface BuildingMapRing extends BuildingMapPart {
  ringIndex: number;
  coordinates: Polygon;
}
export function buildingMapRings(
  parts: readonly BuildingMapPart[],
): BuildingMapRing[] {
  return parts.flatMap((part) =>
    part.rings.map((coordinates, ringIndex) => ({
      ...part,
      ringIndex,
      coordinates,
    })),
  );
}
export function buildingRoofPath(
  ring: BuildingMapRing,
  flat: boolean,
): [number, number, number][] {
  return ring.coordinates.map(([x, y]) => [
    x,
    y,
    flat ? 0.5 : safeDraftHeight(ring.building.height) + 0.25,
  ]);
}
export function buildingOutlineRings(
  part: BuildingMapPart,
): [number, number, number][][] {
  return part.rings.map((ring) => ring.map(([x, y]) => [x, y, 0.15]));
}
/** A display-only ground offset prevents unknown-height footprints z-fighting.
 * It is never written back as an observed or assumed physical height. */
export function buildingSurfaceRings(
  part: BuildingMapPart,
): (Position | [number, number, number])[][] {
  return part.building.height === null
    ? part.rings.map((ring) =>
        ring.map(([x, y]): [number, number, number] => [x, y, 0.16]),
      )
    : part.rings;
}
export function safeDraftHeight(height: number | null): number {
  return height !== null && Number.isFinite(height)
    ? Math.max(0, Math.min(1500, height))
    : 0;
}

const metersPerDegree = (BUILDING_EARTH_RADIUS_METERS * Math.PI) / 180;
export function buildingDraftPivot(draft: MapBuildingDraft): Position | null {
  if (
    draft.pivot?.every(Number.isFinite) &&
    Math.abs(draft.pivot[1]) < 90 &&
    Math.abs(draft.pivot[0]) <= 180
  )
    return [...draft.pivot];
  const geometry = draftBuildingGeometry(draft);
  if (!geometry) return null;
  try {
    return studyAreaAnchor(geometry);
  } catch {
    return null;
  }
}
export function buildingTransformAt(
  draft: MapBuildingDraft,
  destination: Position,
): MapBuildingTransform | null {
  const anchor = buildingDraftPivot(draft);
  if (
    !anchor ||
    !destination.every(Number.isFinite) ||
    Math.abs(destination[0]) > 180 ||
    Math.abs(destination[1]) > 90
  )
    return null;
  const east =
    (destination[0] - anchor[0]) *
    metersPerDegree *
    Math.cos((anchor[1] * Math.PI) / 180);
  const north = (destination[1] - anchor[1]) * metersPerDegree;
  if (draft.mode === "move") return { anchor, translateMeters: [east, north] };
  if (draft.mode === "rotate" && Math.hypot(east, north) > 0.05)
    return {
      anchor,
      rotationDegrees: (Math.atan2(east, north) * 180) / Math.PI,
    };
  return null;
}
export function transformedBuildingDraft(
  draft: MapBuildingDraft,
  transform: MapBuildingTransform,
): StudyAreaGeometry | null {
  const geometry = draftBuildingGeometry(draft);
  if (!geometry) return null;
  try {
    return transformBuildingGeometry(geometry, transform);
  } catch {
    return null;
  }
}
export function buildingRotationHandle(
  draft: MapBuildingDraft,
): Position | null {
  const pivot = buildingDraftPivot(draft);
  if (!pivot) return null;
  const radius =
    Math.max(
      20,
      ...draft.rings.flatMap((ring) =>
        ring.coordinates.map((point) => roadPointDistance(pivot, point)),
      ),
    ) * 1.15;
  return [pivot[0], pivot[1] + radius / metersPerDegree];
}

interface Pixel {
  x: number;
  y: number;
}
export interface BuildingSnap {
  buildingId: string;
  partIndex: number;
  ringIndex: number;
  vertexIndex: number;
  position: Position;
  name: string;
}
export type BuildingSnapIndex = ReadonlyMap<
  string,
  readonly (BuildingSnap & Pixel)[]
>;
export function createBuildingSnapIndex(
  buildings: readonly Building[],
  project: (point: Position) => Pixel,
  excludeId?: string,
): BuildingSnapIndex {
  const result = new Map<string, (BuildingSnap & Pixel)[]>();
  for (const part of buildingMapParts(buildings)) {
    if (part.id === excludeId) continue;
    part.rings.forEach((ring, ringIndex) =>
      ring.slice(0, -1).forEach((position, vertexIndex) => {
        const pixel = project(position);
        if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) return;
        const key = `${Math.floor(pixel.x / 12)},${Math.floor(pixel.y / 12)}`;
        const bucket = result.get(key) ?? [];
        bucket.push({
          ...pixel,
          buildingId: part.id,
          partIndex: part.partIndex,
          ringIndex,
          vertexIndex,
          position,
          name: part.building.name,
        });
        result.set(key, bucket);
      }),
    );
  }
  return result;
}
export function nearestBuildingVertex(
  index: BuildingSnapIndex,
  position: Position,
  pixel: Pixel,
): BuildingSnap | undefined {
  let found: BuildingSnap | undefined,
    closest = 12;
  const x = Math.floor(pixel.x / 12),
    y = Math.floor(pixel.y / 12);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      for (const point of index.get(`${x + dx},${y + dy}`) ?? []) {
        const distance = Math.hypot(point.x - pixel.x, point.y - pixel.y);
        if (
          distance <= closest &&
          roadPointDistance(position, point.position) <= 25
        ) {
          closest = distance;
          found = point;
        }
      }
    }
  return found;
}
export function buildingDraftCandidate(
  position: Position,
  place: Place,
  snap?: BuildingSnap,
) {
  const selected = snap?.position ?? position;
  return {
    position: [...selected] as Position,
    inside: pointInStudyArea(selected, place),
    ...(snap ? { snap } : {}),
  };
}
export const buildingDraftCommandForKey = roadDraftCommandForKey;
export function assertBuildingDraftCaptureAllowed(draft: unknown): void {
  if (draft)
    throw new Error(
      "Apply or discard the building draft before capturing the map.",
    );
}
