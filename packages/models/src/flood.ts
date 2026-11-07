import {
  buildingGeometry,
  canonicalJSON,
  floodDatasetHashSync,
  floodReferenceSchema,
  FLOOD_METHOD_VERSION,
  FLOOD_LEGACY_METHOD_VERSION,
  floodMethodVersion,
  floodHasArealComponent,
  floodVertexCount,
  materializeBuildings,
  validateFloodDataset,
  studyAreaBounds,
  studyAreaFeature,
  isValidStudyArea,
  type Building,
  type FloodDataset,
  type FloodZoneFeature,
  type Place,
  type Scenario,
  type FloodDatasetCatalog,
  studyAreaGeometry,
  type StudyAreaGeometry,
  type FloodMethodVersion,
} from "@urban/core";
import {
  area,
  difference,
  featureCollection,
  intersect,
  union,
} from "@turf/turf";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import {
  prepareFloodShape,
  strictFloodRelation,
  type PreparedFloodShape,
} from "./flood-geometry";

export interface ModelContext {
  housingIncomeLimits?: import("@urban/core").HousingIncomeLimitCatalog;
  floodDatasets?: FloodDatasetCatalog;
  fiscalStudy?: import("@urban/core").FiscalStudy;
}
export interface FloodBuildingExposure {
  buildingId: string;
  status: "intersects-sfha" | "no-sfha-intersection" | "undetermined";
  units: number | null;
  exposedUnits: number | null;
  /** Union intersection area; never used to allocate dwelling counts. */
  intersectionAreaSqm: number | null;
  unclassifiedAreaSqm: number | null;
  zoneIds: string[];
  notes: string[];
}
export interface FloodExposureSide {
  value: number | null;
  knownSubtotal: number | null;
  missingUnitBuildingIds: string[];
  unclassifiedBuildingIds: string[];
  buildings: FloodBuildingExposure[];
}
export interface FloodResolution {
  datasetHash: string | null;
  methodVersion: string;
  status: "ready" | "incomplete" | "unavailable";
  delta: number | null;
  error?: string;
  baseline: FloodExposureSide;
  scenario: FloodExposureSide;
  warnings: string[];
}

type Shape = Feature<Polygon | MultiPolygon>;
type Bounds = [number, number, number, number];
interface Indexed {
  geometry: StudyAreaGeometry;
  bounds: Bounds;
  id: string;
  classification?: FloodZoneFeature["classification"];
  strict?: PreparedFloodShape;
}
interface Node {
  bounds: Bounds;
  items?: Indexed[];
  left?: Node;
  right?: Node;
}
const overlaps = (a: Bounds, b: Bounds) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function tree(items: Indexed[]): Node | undefined {
  if (!items.length) return undefined;
  const bounds: Bounds = [
    Math.min(...items.map((i) => i.bounds[0])),
    Math.min(...items.map((i) => i.bounds[1])),
    Math.max(...items.map((i) => i.bounds[2])),
    Math.max(...items.map((i) => i.bounds[3])),
  ];
  if (items.length <= 8) return { bounds, items };
  const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1,
    sorted = [...items].sort(
      (a, b) =>
        a.bounds[axis] +
        a.bounds[axis + 2] -
        (b.bounds[axis] + b.bounds[axis + 2]),
    ),
    mid = Math.floor(sorted.length / 2);
  return {
    bounds,
    left: tree(sorted.slice(0, mid)),
    right: tree(sorted.slice(mid)),
  };
}
function query(
  node: Node | undefined,
  bounds: Bounds,
  result: Indexed[] = [],
): Indexed[] {
  if (!node || !overlaps(node.bounds, bounds)) return result;
  if (node.items)
    result.push(...node.items.filter((i) => overlaps(i.bounds, bounds)));
  else {
    query(node.left, bounds, result);
    query(node.right, bounds, result);
  }
  return result;
}
type GeometryResult = Omit<
  FloodBuildingExposure,
  "buildingId" | "units" | "exposedUnits"
>;
interface Prepared {
  canonical: string;
  hash: string;
  zones?: Node;
  availability?: Node;
  seclusions?: Node;
  geometries: Map<string, GeometryResult>;
  current?: PreparedMasks;
}
interface PreparedMask {
  shape: Shape;
  strict: PreparedFloodShape;
}
interface PreparedMasks {
  hazard: PreparedMask | null;
  covered: PreparedMask | null;
  geometries: Map<string, GeometryResult>;
}
/** Computational admission bounds, not geometric tolerances or simplification. */
export const FLOOD_MASK_LIMITS = {
  verticesPerMask: 100_000,
  totalVertices: 500_000,
  polygonsPerMask: 5_000,
  edgePairWork: 100_000_000,
} as const;
const cache = new WeakMap<FloodDataset, Prepared>();
function prepare(
  dataset: FloodDataset,
  place: Place,
  expectedHash: string,
): Prepared {
  const canonical = canonicalJSON(dataset),
    previous = cache.get(dataset);
  let p = previous?.canonical === canonical ? previous : undefined;
  if (!p) {
    const hash = floodDatasetHashSync(dataset);
    if (hash !== expectedHash)
      throw new Error(
        "Flood dataset content hash does not match its selected reference.",
      );
    validateFloodDataset(dataset, place);
    const indexed = (
      rows: typeof dataset.zones | typeof dataset.availability,
    ) =>
      rows.map((f) => {
        const geometry = structuredClone(f.geometry);
        return { ...f, geometry, bounds: studyAreaBounds(geometry) };
      });
    p = {
      canonical,
      hash,
      zones: tree(indexed(dataset.zones)),
      availability: tree(indexed(dataset.availability)),
      seclusions: tree(indexed(dataset.seclusions)),
      geometries: new Map(),
    };
    cache.set(dataset, p);
  }
  if (
    p.hash !== expectedHash ||
    canonicalJSON(dataset.studyArea) !== canonicalJSON(studyAreaGeometry(place))
  )
    throw new Error(
      "Flood evidence does not match the selected hash and exact study area.",
    );
  return p;
}
function combine(shapes: Shape[]): Shape | null {
  if (!shapes.length) return null;
  return shapes.length === 1 ? shapes[0] : union(featureCollection(shapes));
}
type ExactDecimal = { coefficient: bigint; exponent: number };
function decimalCoordinate(value: number): ExactDecimal {
  const [mantissa, power = "0"] = value.toString().split("e");
  return {
    coefficient: BigInt(mantissa.replace(".", "")),
    exponent:
      Number(power) -
      (mantissa.includes(".")
        ? mantissa.length - mantissa.indexOf(".") - 1
        : 0),
  };
}
/** Strict positive planar area in the overlay library's canonical-decimal domain. */
function positiveArea(shape: Shape | null): boolean {
  if (!shape) return false;
  const polygons =
    shape.geometry.type === "Polygon"
      ? [shape.geometry.coordinates]
      : shape.geometry.coordinates;
  return polygons.some((polygon) => {
    const rings = polygon.map((ring) =>
      ring.map(
        ([x, y]) => [decimalCoordinate(x), decimalCoordinate(y)] as const,
      ),
    );
    let exponent = 0;
    for (const ring of rings)
      for (const point of ring)
        for (const value of point)
          exponent = Math.min(exponent, value.exponent);
    const integer = (value: ExactDecimal) =>
      value.coefficient * 10n ** BigInt(value.exponent - exponent);
    const areas = rings.map((ring) => {
      let twice = 0n;
      const points = ring.map(([x, y]) => [integer(x), integer(y)] as const);
      for (let i = 0; i < points.length; i++) {
        const a = points[i],
          b = points[(i + 1) % points.length];
        twice += a[0] * b[1] - b[0] * a[1];
      }
      return twice < 0n ? -twice : twice;
    });
    return (
      areas.length > 0 && areas[0] > areas.slice(1).reduce((a, b) => a + b, 0n)
    );
  });
}
function prepareMasks(
  dataset: FloodDataset,
  prepared: Prepared,
): PreparedMasks {
  if (prepared.current) return prepared.current;
  let work = 0,
    totalVertices = 0;
  const bounded = (shape: Shape | null): Shape | null => {
    if (!shape) return null;
    const count = floodVertexCount(shape.geometry as StudyAreaGeometry);
    const polygons =
      shape.geometry.type === "Polygon" ? 1 : shape.geometry.coordinates.length;
    if (
      count > FLOOD_MASK_LIMITS.verticesPerMask ||
      polygons > FLOOD_MASK_LIMITS.polygonsPerMask
    )
      throw new Error(
        "Flood union masks exceed the complete geometry computation bound; no features were omitted.",
      );
    return shape;
  };
  const operation = (
    a: Shape,
    b: Shape,
    kind: "union" | "intersection" | "difference",
  ) => {
    work +=
      floodVertexCount(a.geometry as StudyAreaGeometry) *
      floodVertexCount(b.geometry as StudyAreaGeometry);
    if (work > FLOOD_MASK_LIMITS.edgePairWork)
      throw new Error(
        "Flood union masks exceed the complete overlay work bound; no geometry was truncated.",
      );
    const inputs = featureCollection([a, b]);
    return bounded(
      kind === "union"
        ? union(inputs)
        : kind === "intersection"
          ? intersect(inputs)
          : difference(inputs),
    );
  };
  const united = (geometries: StudyAreaGeometry[]): Shape | null => {
    let level: Shape[] = geometries.map((g) => bounded(studyAreaFeature(g))!);
    while (level.length > 1) {
      const next: Shape[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const merged =
          i + 1 < level.length
            ? operation(level[i], level[i + 1], "union")
            : level[i];
        if (merged) next.push(merged);
      }
      level = next;
    }
    return level[0] ?? null;
  };
  const hazard = united(
    dataset.zones
      .filter((z) => z.classification === "sfha")
      .map((z) => z.geometry),
  );
  const known = united(
    dataset.zones
      .filter((z) => z.classification !== "undetermined")
      .map((z) => z.geometry),
  );
  const availability = united(dataset.availability.map((z) => z.geometry));
  const unknown = united(
    dataset.zones
      .filter((z) => z.classification === "undetermined")
      .map((z) => z.geometry),
  );
  let covered =
    known && availability
      ? operation(known, availability, "intersection")
      : null;
  if (covered && unknown) covered = operation(covered, unknown, "difference");
  for (const mask of [hazard, known, availability, unknown, covered]) {
    if (!mask) continue;
    totalVertices += floodVertexCount(mask.geometry as StudyAreaGeometry);
    if (totalVertices > FLOOD_MASK_LIMITS.totalVertices)
      throw new Error(
        "Flood union masks exceed the aggregate geometry bound; no partial masks were accepted.",
      );
    if (!isValidStudyArea(mask.geometry as StudyAreaGeometry))
      throw new Error(
        "A complete flood union mask has invalid polygon topology.",
      );
  }
  const retain = (shape: Shape | null): PreparedMask | null =>
    shape
      ? {
          shape,
          strict: prepareFloodShape(shape.geometry as StudyAreaGeometry),
        }
      : null;
  prepared.current = {
    hazard: retain(hazard),
    covered: retain(covered),
    geometries: new Map(),
  };
  return prepared.current;
}
function geometryExposureCurrent(
  g: StudyAreaGeometry,
  p: Prepared,
): GeometryResult {
  const masks = p.current!;
  const key = canonicalJSON(g),
    cached = masks.geometries.get(key);
  if (cached) return cached;
  g = structuredClone(g);
  if (!isValidStudyArea(g))
    throw new Error("The complete building footprint has invalid topology.");
  const footprint = studyAreaFeature(g),
    bounds = studyAreaBounds(g);
  const clipMask = (mask: PreparedMask | null): Shape | null => {
    const relation = strictFloodRelation(g, mask?.strict ?? null);
    return relation === "outside"
      ? null
      : relation === "inside"
        ? footprint
        : intersect(featureCollection([footprint, mask!.shape]));
  };
  const sfha = clipMask(masks.hazard),
    hasSfha = positiveArea(sfha);
  const relation = strictFloodRelation(g, masks.covered?.strict ?? null);
  const remainder =
    relation === "inside"
      ? null
      : relation === "outside"
        ? footprint
        : difference(featureCollection([footprint, masks.covered!.shape]));
  const hasRemainder = positiveArea(remainder),
    zoneIds: string[] = [],
    notes: string[] = [];
  for (const z of query(p.zones, bounds)) {
    z.strict ??= prepareFloodShape(z.geometry);
    const relation = strictFloodRelation(g, z.strict);
    if (
      relation === "inside" ||
      (relation === "boundary" &&
        positiveArea(
          intersect(
            featureCollection([footprint, studyAreaFeature(z.geometry)]),
          ),
        ))
    )
      zoneIds.push(z.id);
  }
  if (
    query(p.seclusions, bounds).some(
      (z) =>
        intersect(
          featureCollection([footprint, studyAreaFeature(z.geometry)]),
        ) !== null,
    )
  )
    notes.push(
      "A retained seclusion intersects this building. Seclusion context does not erase the effective mapped hazard; consult the original study and revisions.",
    );
  const result: GeometryResult = {
    status: hasSfha
      ? "intersects-sfha"
      : hasRemainder
        ? "undetermined"
        : "no-sfha-intersection",
    intersectionAreaSqm: sfha ? area(sfha) : 0,
    unclassifiedAreaSqm: hasRemainder && remainder ? area(remainder) : 0,
    zoneIds: zoneIds.sort(),
    notes,
  };
  if (masks.geometries.size >= 20_000)
    masks.geometries.delete(masks.geometries.keys().next().value!);
  masks.geometries.set(key, result);
  return result;
}
function geometryExposure(g: StudyAreaGeometry, p: Prepared): GeometryResult {
  const key = canonicalJSON(g),
    cached = p.geometries.get(key);
  if (cached) return cached;
  g = structuredClone(g);
  if (!isValidStudyArea(g))
    throw new Error("The complete building footprint has invalid topology.");
  const bounds = studyAreaBounds(g),
    footprint = studyAreaFeature(g),
    hazards: Shape[] = [],
    classified: Shape[] = [],
    unknown: Shape[] = [],
    zoneIds: string[] = [];
  for (const z of query(p.zones, bounds)) {
    const clip = intersect(
      featureCollection([footprint, studyAreaFeature(z.geometry)]),
    );
    if (!clip || area(clip) <= 0) continue;
    zoneIds.push(z.id);
    if (z.classification === "sfha") hazards.push(clip);
    if (z.classification === "undetermined") unknown.push(clip);
    else classified.push(clip);
  }
  const sfha = combine(hazards),
    known = combine(classified),
    unclassified = combine(unknown),
    availability = combine(
      query(p.availability, bounds).flatMap((z) => {
        const clip = intersect(
          featureCollection([footprint, studyAreaFeature(z.geometry)]),
        );
        return clip && floodHasArealComponent(clip.geometry) ? [clip] : [];
      }),
    );
  let covered =
    known && availability
      ? intersect(featureCollection([known, availability]))
      : null;
  if (covered && unclassified)
    covered = difference(featureCollection([covered, unclassified]));
  const remainder = covered
    ? difference(featureCollection([footprint, covered]))
    : footprint;
  const hasRemainder = floodHasArealComponent(remainder?.geometry ?? null);
  const intersectionAreaSqm = sfha ? area(sfha) : 0,
    notes: string[] = [];
  if (
    query(p.seclusions, bounds).some(
      (z) =>
        intersect(
          featureCollection([footprint, studyAreaFeature(z.geometry)]),
        ) !== null,
    )
  )
    notes.push(
      "A retained seclusion intersects this building. Seclusion context does not erase the effective mapped hazard; consult the original study and revisions.",
    );
  const result: GeometryResult = {
    status:
      intersectionAreaSqm > 0
        ? "intersects-sfha"
        : !hasRemainder
          ? "no-sfha-intersection"
          : "undetermined",
    intersectionAreaSqm,
    unclassifiedAreaSqm: hasRemainder && remainder ? area(remainder) : 0,
    zoneIds: zoneIds.sort(),
    notes,
  };
  // A bounded cache reuses unchanged footprints across quantity/name/road edits.
  if (p.geometries.size >= 20_000)
    p.geometries.delete(p.geometries.keys().next().value!);
  p.geometries.set(key, result);
  return result;
}
function side(
  buildings: Building[],
  prepared?: Prepared,
  error?: string,
  methodVersion: FloodMethodVersion = FLOOD_LEGACY_METHOD_VERSION,
): FloodExposureSide {
  const rows: FloodBuildingExposure[] = [],
    missingUnitBuildingIds: string[] = [],
    unclassifiedBuildingIds: string[] = [];
  let known = 0,
    resolved = 0;
  for (const b of buildings) {
    let g: GeometryResult;
    try {
      if (!prepared) throw new Error(error ?? "Flood dataset is unavailable.");
      g =
        methodVersion === FLOOD_METHOD_VERSION
          ? geometryExposureCurrent(buildingGeometry(b), prepared)
          : geometryExposure(buildingGeometry(b), prepared);
    } catch (e) {
      g = {
        status: "undetermined",
        intersectionAreaSqm: null,
        unclassifiedAreaSqm: null,
        zoneIds: [],
        notes: [e instanceof Error ? e.message : "Geometry evaluation failed."],
      };
    }
    const exposedUnits =
      b.units === 0 || g.status === "no-sfha-intersection"
        ? 0
        : g.status === "intersects-sfha"
          ? b.units
          : null;
    rows.push({
      ...structuredClone(g),
      buildingId: b.id,
      units: b.units,
      exposedUnits,
    });
    if (b.units === 0 || g.status === "no-sfha-intersection") {
      resolved++;
      continue;
    }
    if (g.status === "undetermined") unclassifiedBuildingIds.push(b.id);
    if (b.units === null) missingUnitBuildingIds.push(b.id);
    if (g.status === "intersects-sfha" && b.units !== null) {
      known += b.units;
      resolved++;
    }
  }
  const complete =
    !missingUnitBuildingIds.length && !unclassifiedBuildingIds.length;
  return {
    value: complete ? known : null,
    knownSubtotal: resolved || !buildings.length ? known : null,
    missingUnitBuildingIds: missingUnitBuildingIds.sort(),
    unclassifiedBuildingIds: unclassifiedBuildingIds.sort(),
    buildings: rows,
  };
}
export function resolveFloodExposure(
  place: Place,
  scenario: Scenario,
  context: ModelContext = {},
): FloodResolution {
  let prepared: Prepared | undefined, error: string | undefined;
  let methodVersion: FloodMethodVersion = FLOOD_LEGACY_METHOD_VERSION;
  try {
    if (!scenario.flood)
      throw new Error(
        "Select a retained effective flood dataset to calculate exposure.",
      );
    floodReferenceSchema.parse(scenario.flood);
    methodVersion = floodMethodVersion(scenario.flood);
    const dataset = context.floodDatasets?.[scenario.flood.datasetHash];
    if (!dataset)
      throw new Error(
        "The selected flood dataset is not available in this project context.",
      );
    prepared = prepare(dataset, place, scenario.flood.datasetHash);
    if (methodVersion === FLOOD_METHOD_VERSION) prepareMasks(dataset, prepared);
  } catch (e) {
    error = e instanceof Error ? e.message : "Flood dataset validation failed.";
  }
  const baseline = side(
      place.buildings,
      error ? undefined : prepared,
      error,
      methodVersion,
    ),
    proposal = side(
      materializeBuildings(place, scenario),
      error ? undefined : prepared,
      error,
      methodVersion,
    );
  // Absent/invalid datasets never yield a full metric, even for a zero-home scene.
  if (error) {
    baseline.value = null;
    proposal.value = null;
  }
  return {
    datasetHash: scenario.flood?.datasetHash ?? null,
    methodVersion,
    status:
      error ||
      (baseline.knownSubtotal === null && proposal.knownSubtotal === null)
        ? "unavailable"
        : baseline.value === null || proposal.value === null
          ? "incomplete"
          : "ready",
    ...(error ? { error } : {}),
    baseline,
    scenario: proposal,
    delta:
      baseline.value === null || proposal.value === null
        ? null
        : proposal.value - baseline.value,
    warnings: [
      "Counts are homes recorded in buildings with any positive-area SFHA footprint intersection, not located dwelling entrances, observed flooding, damage or insurance determinations. Counts are never area-prorated.",
      "The same captured effective hazard geometry is held fixed for baseline, proposal and every horizon. Missing mapped coverage does not establish safety; the building inventory and home quantities may themselves be incomplete or estimated.",
      ...(methodVersion === FLOOD_METHOD_VERSION
        ? [
            "Method 1.1 combines adjacent mapped zones before screening each building. Real gaps in map coverage remain unknown; shared zone boundaries do not create artificial gaps.",
          ]
        : []),
      ...(error ? [error] : []),
    ],
  };
}
