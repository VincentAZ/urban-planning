import {
  area,
  difference,
  featureCollection,
  intersect,
  polygon,
  union,
} from "@turf/turf";
import type {
  Feature,
  MultiPolygon as GeoMultiPolygon,
  Polygon as GeoPolygon,
} from "geojson";
import type {
  Command,
  Place,
  Position,
  Project,
  Scenario,
  Source,
} from "./index";
import {
  isValidStudyArea,
  studyAreaBounds,
  studyAreaFeature,
  type StudyAreaGeometry,
  type StudyAreaInput,
} from "./study-area";

const reservedParcelIdentifiers = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);
export function isSafeParcelIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[a-zA-Z0-9_.:-]+$/.test(value) &&
    !reservedParcelIdentifiers.has(value)
  );
}
function assertParcelIdentifier(value: unknown) {
  if (!isSafeParcelIdentifier(value))
    throw new Error(
      "Parcel identifiers must be ordinary feature IDs, not reserved object-property names.",
    );
}
/** Also used by direct command application: no parser bypass may write a prototype key. */
export function assertParcelCommandIdentifiers(command: Command): void {
  if (command.type === "parcel.upsert")
    assertParcelIdentifier(command.parcel.id);
  if (command.type === "parcel.remove") assertParcelIdentifier(command.id);
  if (command.type === "parcels.import" || command.type === "parcels.replace")
    for (const parcel of command.parcels) assertParcelIdentifier(parcel.id);
  if (command.type === "parcels.replace")
    for (const id of command.removeIds) assertParcelIdentifier(id);
}
export type ParcelKind = "parcel" | "block";
export interface Parcel {
  id: string;
  name: string;
  kind: ParcelKind;
  geometry: StudyAreaGeometry;
  sourceId: string;
  geometrySourceId?: string;
  sourceFeatureId?: string;
  lineage?: {
    operation: "draw" | "reshape" | "split" | "assemble" | "import";
    parentIds: string[];
    sourceIds: string[];
  };
}
export interface ParcelValidation {
  valid: boolean;
  error: string | null;
  areaSqm: number;
}
export const MAX_AUTHORED_PARCEL_RING_POINTS = 500;
export const MAX_PARCEL_VERTICES = 5000;
export const MAX_SCENARIO_PARCELS = 5000;
export const MAX_PARCEL_OVERLAP_CHECKS = 50000;
export const MIN_PARCEL_AREA_SQM = 1;
export const USER_PARCEL_SOURCE: Source = {
  id: "user-parcel-proposal",
  name: "User parcel proposal",
  url: "",
  vintage: "Scenario edit",
  license: "User-authored proposal",
  kind: "user-supplied",
  description:
    "Planning parcel or block boundaries drawn, reshaped, subdivided, or assembled by a user. These are proposal geometry, not a cadastral survey, recorded subdivision, ownership record, or zoning approval. Building matches are geometric associations, not verified legal assignments.",
};
type Shape = Feature<GeoPolygon | GeoMultiPolygon>;
const shape = (geometry: StudyAreaGeometry): Shape => ({
  type: "Feature",
  properties: {},
  geometry,
});
const parts = (geometry: StudyAreaGeometry) =>
  geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
const clipped = (a: StudyAreaGeometry, b: StudyAreaGeometry) =>
  intersect(featureCollection([shape(a), shape(b)]));
const residual = (a: StudyAreaGeometry, b: StudyAreaGeometry) =>
  difference(featureCollection([shape(a), shape(b)]));
const size = (feature: Shape | null) => (feature ? area(feature) : 0);
/** Polygon clipping treats longitude/latitude edges as straight planar segments.
 * Turf's spherical area is intentionally retained for displayed land measures,
 * but is not an area oracle for near-collinear clipping residues: inserting a
 * point into a sloped edge changes its spherical integration approximation.
 * Translate before the shoelace sum to avoid cancellation at large coordinates;
 * one common local metric scale preserves area comparisons across all operands.
 */
function topologyArea(
  feature: Shape | null,
  reference: StudyAreaGeometry,
): number {
  if (!feature) return 0;
  const bounds = studyAreaBounds(reference);
  const origin: Position = [
    (bounds[0] + bounds[2]) / 2,
    (bounds[1] + bounds[3]) / 2,
  ];
  const metersPerDegree = (6371008.8 * Math.PI) / 180;
  const xScale = metersPerDegree * Math.cos((origin[1] * Math.PI) / 180);
  const ringArea = (ring: readonly Position[]) => {
    let sum = 0,
      correction = 0;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1],
        b = ring[i];
      const term =
        (a[0] - origin[0]) * (b[1] - origin[1]) -
        (b[0] - origin[0]) * (a[1] - origin[1]);
      const adjusted = term - correction,
        next = sum + adjusted;
      correction = next - sum - adjusted;
      sum = next;
    }
    return (Math.abs(sum) * xScale * metersPerDegree) / 2;
  };
  return parts(feature.geometry as StudyAreaGeometry).reduce(
    (sum, rings) =>
      sum +
      Math.max(
        0,
        ringArea(rings[0]) -
          rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0),
      ),
    0,
  );
}
/** Local planar topology measures for clipping residuals, not displayed geodesic land area. */
export function geometryDifferenceAreaSqm(
  a: StudyAreaGeometry,
  b: StudyAreaGeometry,
): number {
  return topologyArea(residual(a, b), a);
}
export function geometryIntersectionAreaSqm(
  a: StudyAreaGeometry,
  b: StudyAreaGeometry,
): number {
  return topologyArea(clipped(a, b), a);
}
const tolerance = (sqm: number) => Math.max(0.001, sqm * 1e-9);
const ids = (items: readonly string[]) => [...new Set(items)].sort();
const sameBoundsOverlap = (a: readonly number[], b: readonly number[]) =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** Derived from all polygon components minus holes; never read from a client area cache. */
export function parcelAreaSqm(parcel: Parcel | StudyAreaGeometry): number {
  return area(shape("geometry" in parcel ? parcel.geometry : parcel));
}
export function validateParcelGeometry(
  geometry: StudyAreaGeometry,
  studyArea?: StudyAreaInput,
): ParcelValidation {
  const fail = (error: string): ParcelValidation => ({
    valid: false,
    error,
    areaSqm: 0,
  });
  try {
    if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type))
      return fail("Use a Polygon or MultiPolygon parcel boundary.");
    const polygons = parts(geometry);
    if (!polygons.length || polygons.length > 128)
      return fail("Use between 1 and 128 parcel components.");
    let vertices = 0;
    for (const rings of polygons) {
      if (!Array.isArray(rings) || !rings.length || rings.length > 128)
        return fail(
          "A parcel component needs an outer ring and at most 127 holes.",
        );
      for (const ring of rings) {
        vertices += ring.length;
        if (
          ring.length < 4 ||
          ring.length > MAX_AUTHORED_PARCEL_RING_POINTS + 1
        )
          return fail(
            `Use 3 to ${MAX_AUTHORED_PARCEL_RING_POINTS} points per parcel ring, plus its closing point.`,
          );
        if (
          !ring.every(
            (p) =>
              Array.isArray(p) &&
              p.length === 2 &&
              p.every(Number.isFinite) &&
              Math.abs(p[0]) <= 180 &&
              Math.abs(p[1]) <= 90,
          )
        )
          return fail(
            "Parcel coordinates must be finite WGS84 longitude and latitude.",
          );
        if (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1])
          return fail("Close every parcel ring by repeating its first point.");
        if (
          ring
            .slice(1)
            .some((p, i) => p[0] === ring[i][0] && p[1] === ring[i][1])
        )
          return fail("Remove consecutive duplicate parcel points.");
      }
    }
    if (vertices > MAX_PARCEL_VERTICES)
      return fail(
        `A parcel may contain at most ${MAX_PARCEL_VERTICES} vertices including ring closures.`,
      );
    if (!isValidStudyArea(geometry))
      return fail(
        "Parcel boundaries must not self-cross, overlap their own components, or contain invalid holes.",
      );
    const sqm = parcelAreaSqm(geometry);
    if (!Number.isFinite(sqm) || sqm < MIN_PARCEL_AREA_SQM)
      return fail(
        `A parcel must contain at least ${MIN_PARCEL_AREA_SQM} m² of land.`,
      );
    if (polygons.some((rings) => area(polygon(rings)) < MIN_PARCEL_AREA_SQM))
      return fail(
        "Every separate parcel component must contain at least 1 m²; no slivers are discarded automatically.",
      );
    if (
      studyArea &&
      topologyArea(
        difference(
          featureCollection([shape(geometry), studyAreaFeature(studyArea)]),
        ),
        geometry,
      ) > tolerance(topologyArea(shape(geometry), geometry))
    )
      return fail(
        "Keep the entire parcel inside the study area, including its holes and separate components.",
      );
    return { valid: true, error: null, areaSqm: sqm };
  } catch {
    return fail(
      "The parcel boundary could not be evaluated. Check its rings, holes, and coordinate complexity.",
    );
  }
}
function assertGeometry(
  geometry: StudyAreaGeometry,
  studyArea?: StudyAreaInput,
) {
  const check = validateParcelGeometry(geometry, studyArea);
  if (!check.valid) throw new Error(check.error!);
}
export function materializeParcels(place: Place, scenario: Scenario): Parcel[] {
  const records = new Map(
    (place.parcels ?? []).map((parcel) => [parcel.id, parcel]),
  );
  for (const [id, parcel] of Object.entries(scenario.parcelEdits ?? {})) {
    if (parcel === null) records.delete(id);
    else records.set(id, parcel);
  }
  return [...records.values()];
}
function assertCollection(parcels: readonly Parcel[], place?: Place) {
  if (parcels.length > MAX_SCENARIO_PARCELS)
    throw new Error(
      `Use at most ${MAX_SCENARIO_PARCELS} parcel/block features in one scenario.`,
    );
  for (const parcel of parcels) assertParcelIdentifier(parcel.id);
  if (new Set(parcels.map((p) => p.id)).size !== parcels.length)
    throw new Error("Parcel identifiers must be unique.");
  const indexed = parcels
    .map((parcel) => {
      assertGeometry(parcel.geometry, place);
      return { parcel, bounds: studyAreaBounds(parcel.geometry) };
    })
    .sort((a, b) => a.bounds[0] - b.bounds[0]);
  let overlapChecks = 0;
  for (let i = 0; i < indexed.length; i++) {
    const a = indexed[i];
    for (
      let j = i + 1;
      j < indexed.length && indexed[j].bounds[0] < a.bounds[2];
      j++
    ) {
      const b = indexed[j];
      if (
        a.parcel.kind !== b.parcel.kind ||
        !sameBoundsOverlap(a.bounds, b.bounds)
      )
        continue;
      if (++overlapChecks > MAX_PARCEL_OVERLAP_CHECKS)
        throw new Error(
          "This parcel collection exceeds the bounded overlap-check budget. Reduce overlapping feature extents or divide the import; no geometry has been changed.",
        );
      if (
        topologyArea(
          clipped(a.parcel.geometry, b.parcel.geometry),
          a.parcel.geometry,
        ) >
        tolerance(Math.min(parcelAreaSqm(a.parcel), parcelAreaSqm(b.parcel)))
      )
        throw new Error(
          `${a.parcel.name} overlaps ${b.parcel.name}. Features of the same kind may share an edge, but cannot share land area.`,
        );
    }
  }
}
export function validateParcelEdits(place: Place, scenario: Scenario): void {
  for (const id of Object.keys(scenario.parcelEdits ?? {}))
    assertParcelIdentifier(id);
  for (const [id, parcel] of Object.entries(scenario.parcelEdits ?? {}))
    if (parcel && parcel.id !== id)
      throw new Error("Parcel edit key must match its identifier.");
  assertCollection(materializeParcels(place, scenario), place);
}
export function parcelPreset(
  geometry: StudyAreaGeometry,
  name = "Proposed parcel",
  kind: ParcelKind = "parcel",
): Parcel {
  assertGeometry(geometry);
  return {
    id: `parcel-${globalThis.crypto.randomUUID()}`,
    name: name.trim() || `Proposed ${kind}`,
    kind,
    geometry: structuredClone(geometry),
    sourceId: USER_PARCEL_SOURCE.id,
    geometrySourceId: USER_PARCEL_SOURCE.id,
    lineage: {
      operation: "draw",
      parentIds: [],
      sourceIds: [USER_PARCEL_SOURCE.id],
    },
  };
}
function lineage(
  parcels: readonly Parcel[],
  operation: "split" | "assemble",
): Parcel["lineage"] {
  return {
    operation,
    parentIds: parcels.map((p) => p.id),
    sourceIds: ids(
      parcels.flatMap((p) => [
        p.sourceId,
        ...(p.geometrySourceId ? [p.geometrySourceId] : []),
        ...(p.lineage?.sourceIds ?? []),
      ]),
    ),
  };
}
function geometryUnion(parcels: readonly Parcel[]): StudyAreaGeometry {
  if (!parcels.length) throw new Error("Choose at least one parcel.");
  if (parcels.length === 1) return structuredClone(parcels[0].geometry);
  const result = union(
    featureCollection(parcels.map((p) => shape(p.geometry))),
  );
  if (!result)
    throw new Error("The selected parcels do not contain any land area.");
  return result.geometry as StudyAreaGeometry;
}
function assertSameLand(before: readonly Parcel[], after: readonly Parcel[]) {
  const old = geometryUnion(before),
    next = geometryUnion(after),
    oldArea = topologyArea(shape(old), old),
    allowed = tolerance(oldArea);
  if (
    topologyArea(residual(old, next), old) > allowed ||
    topologyArea(residual(next, old), old) > allowed ||
    Math.abs(
      oldArea -
        after.reduce((sum, p) => sum + topologyArea(shape(p.geometry), old), 0),
    ) > allowed
  )
    throw new Error(
      "Split and assembly must preserve all original land area and holes without overlaps, gaps, or discarded slivers.",
    );
}
export function assembleParcels(
  parcels: readonly Parcel[],
  name = "Assembled parcel",
): Parcel {
  if (parcels.length < 2 || parcels.length > 100)
    throw new Error("Choose between 2 and 100 parcels or blocks to assemble.");
  if (!parcels.every((p) => p.kind === parcels[0].kind))
    throw new Error("Assemble parcels with parcels, or blocks with blocks.");
  assertCollection(parcels);
  const result = parcelPreset(geometryUnion(parcels), name, parcels[0].kind);
  result.lineage = lineage(parcels, "assemble");
  assertSameLand(parcels, [result]);
  return result;
}
/** Intersect with two complementary halfplanes; no buffered knife, snapping, or land loss. */
export function splitParcel(
  parcel: Parcel,
  cut: [Position, Position],
): Parcel[] {
  assertGeometry(parcel.geometry);
  if (
    cut.length !== 2 ||
    !cut.every(
      (p) =>
        p.length === 2 &&
        p.every(Number.isFinite) &&
        Math.abs(p[0]) <= 180 &&
        Math.abs(p[1]) <= 90,
    ) ||
    (cut[0][0] === cut[1][0] && cut[0][1] === cut[1][1])
  )
    throw new Error(
      "Choose two different valid points to define a straight division line.",
    );
  const [a, b] = cut,
    bounds = studyAreaBounds(parcel.geometry);
  const pad = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 0.001);
  const rectangle: Position[] = [
    [Math.max(-180, bounds[0] - pad), Math.max(-90, bounds[1] - pad)],
    [Math.min(180, bounds[2] + pad), Math.max(-90, bounds[1] - pad)],
    [Math.min(180, bounds[2] + pad), Math.min(90, bounds[3] + pad)],
    [Math.max(-180, bounds[0] - pad), Math.min(90, bounds[3] + pad)],
  ];
  const cross = (p: Position) =>
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const halfplanes = [1, -1].map((sign) => {
    const output: Position[] = [];
    for (let i = 0; i < rectangle.length; i++) {
      const from = rectangle[i],
        to = rectangle[(i + 1) % rectangle.length],
        d1 = sign * cross(from),
        d2 = sign * cross(to);
      if (d1 >= 0) output.push([...from]);
      if ((d1 < 0 && d2 > 0) || (d1 > 0 && d2 < 0)) {
        const t = d1 / (d1 - d2);
        output.push([
          from[0] + t * (to[0] - from[0]),
          from[1] + t * (to[1] - from[1]),
        ]);
      }
    }
    if (output.length < 3) return null;
    output.push([...output[0]]);
    return { type: "Polygon", coordinates: [output] } as StudyAreaGeometry;
  });
  if (!halfplanes[0] || !halfplanes[1])
    throw new Error("The division line must cross the parcel interior.");
  const halves = halfplanes as [StudyAreaGeometry, StudyAreaGeometry];
  const cutsInterior = parts(parcel.geometry).some((rings) =>
    halves.every(
      (half) =>
        size(clipped({ type: "Polygon", coordinates: rings }, half)) >
        tolerance(area(polygon(rings))),
    ),
  );
  if (!cutsInterior)
    throw new Error(
      "The division line must cross a parcel interior; touching an edge or passing between islands does not subdivide it.",
    );
  const geometries = halves
    .flatMap((half) => {
      const result = clipped(parcel.geometry, half);
      return result
        ? parts(result.geometry as StudyAreaGeometry).map(
            (coordinates): StudyAreaGeometry => ({
              type: "Polygon",
              coordinates,
            }),
          )
        : [];
    })
    .sort((x, y) => {
      const a = studyAreaBounds(x),
        b = studyAreaBounds(y);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
    });
  if (geometries.length < 2 || geometries.length > 100)
    throw new Error("A division must produce between 2 and 100 valid lots.");
  const result = geometries.map((geometry, index) => ({
    ...parcelPreset(geometry, `${parcel.name} · ${index + 1}`, parcel.kind),
    lineage: lineage([parcel], "split"),
  }));
  assertCollection(result);
  assertSameLand([parcel], result);
  return result;
}
export function validateParcelCommand(
  place: Place,
  scenario: Scenario,
  command: Command,
): void {
  assertParcelCommandIdentifiers(command);
  if (
    !command.type.startsWith("parcel.") &&
    !command.type.startsWith("parcels.")
  )
    return;
  const current = materializeParcels(place, scenario),
    byId = new Map(current.map((p) => [p.id, p])),
    edits = { ...scenario.parcelEdits };
  if (command.type === "parcel.remove") {
    if (!byId.has(command.id))
      throw new Error(
        "The parcel to remove no longer exists in this scenario.",
      );
    edits[command.id] = null;
  }
  if (command.type === "parcel.upsert")
    edits[command.parcel.id] = command.parcel;
  if (command.type === "parcels.import") {
    if (!command.parcels.length)
      throw new Error("The import contains no parcels.");
    for (const parcel of command.parcels) {
      if (command.mode === "match") {
        const existing = byId.get(parcel.id);
        if (!existing || existing.kind !== parcel.kind)
          throw new Error(
            "Matched parcels must already exist and retain the same parcel/block kind.",
          );
      } else if (byId.has(parcel.id))
        throw new Error("Imported parcels must use new identifiers.");
      edits[parcel.id] = parcel;
    }
    if (
      new Set(command.parcels.map((p) => p.id)).size !== command.parcels.length
    )
      throw new Error("Imported parcel identifiers must be unique.");
  }
  if (command.type === "parcels.replace") {
    if (
      new Set(command.removeIds).size !== command.removeIds.length ||
      new Set(command.parcels.map((p) => p.id)).size !== command.parcels.length
    )
      throw new Error("Replacement identifiers must be unique.");
    const before = command.removeIds.map((id) => {
      const parcel = byId.get(id);
      if (!parcel)
        throw new Error("A selected parcel no longer exists in this scenario.");
      return parcel;
    });
    if (
      command.operation === "split"
        ? before.length !== 1 || command.parcels.length < 2
        : before.length < 2 || command.parcels.length !== 1
    )
      throw new Error(
        "A split replaces one parcel with multiple lots; assembly replaces multiple parcels with one feature.",
      );
    const kind = before[0]?.kind;
    if (!kind || ![...before, ...command.parcels].every((p) => p.kind === kind))
      throw new Error("Parcel replacement must preserve the feature kind.");
    for (const parcel of command.parcels) {
      if (
        byId.has(parcel.id) ||
        Object.hasOwn(scenario.parcelEdits ?? {}, parcel.id) ||
        (place.parcels ?? []).some((p) => p.id === parcel.id)
      )
        throw new Error(
          "Split and assembly outputs require new parcel identifiers.",
        );
      if (
        parcel.lineage?.operation !== command.operation ||
        ids(parcel.lineage.parentIds).join("|") !==
          ids(command.removeIds).join("|")
      )
        throw new Error(
          "Replacement provenance must identify its operation and original parcels.",
        );
    }
    assertCollection(before);
    assertCollection(command.parcels);
    assertSameLand(before, command.parcels);
    for (const id of command.removeIds) edits[id] = null;
    for (const parcel of command.parcels) edits[parcel.id] = parcel;
  }
  validateParcelEdits(place, { ...scenario, parcelEdits: edits });
}
/** V2 makes older clients reject parcel-bearing projects instead of stripping unknown fields. */
export function projectWithParcelVersion(
  project: Project,
  place?: Place,
): Project {
  const snapshots = [
    ...project.scenarios,
    ...project.history.flatMap((e) => [e.before, e.after]),
    ...project.undone.flatMap((e) => [e.before, e.after]),
  ];
  const hasParcels =
    place?.parcels !== undefined ||
    snapshots.some((s) => s.parcelEdits !== undefined) ||
    [...project.history, ...project.undone].some(
      (e) =>
        e.command.type.startsWith("parcel.") ||
        e.command.type.startsWith("parcels."),
    );
  return project.schemaVersion >= 2 || !hasParcels
    ? project
    : { ...project, schemaVersion: 2 };
}
