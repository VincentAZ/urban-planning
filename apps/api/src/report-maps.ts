import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Resvg, renderAsync } from "@resvg/resvg-js";
import {
  featureCollection,
  intersect,
  polygon,
  difference,
  union,
} from "@turf/turf";
import type {
  Feature as GeoFeature,
  Polygon as GeoPolygon,
  MultiPolygon as GeoMultiPolygon,
} from "geojson";
import {
  canonicalJSON,
  materializeBuildings,
  buildingGeometry,
  materializeRoads,
  materializeParcels,
  studyAreaBounds,
  studyAreaFeature,
  studyAreaPolygons,
  studyAreaGeometry,
  floodHasArealComponent,
  type StudyAreaGeometry,
  type FloodDataset,
  type Building,
  type Place,
  type Position,
  type Road,
  type Parcel,
  type Scenario,
  type Source,
} from "@urban/core";
import { ApiError } from "./errors.js";

export const REPORT_MAP_LIMITS = Object.freeze({
  width: 1400,
  height: 900,
  floodHeight: 1000,
  featuresPerPanel: 60_000,
  vertices: 750_000,
  svgBytes: 24 * 1024 * 1024,
  sourceRecords: 200,
  waitingPairs: 2,
  queueTimeoutMs: 15_000,
});
const RENDERER_VERSION = "urban-plan-3";
const EARTH_RADIUS = 6_371_008.8;
const RAD = Math.PI / 180;
const fontFiles = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((name) =>
  fileURLToPath(new URL(`../assets/fonts/${name}`, import.meta.url)),
);
const hash = (input: string | Buffer) =>
  createHash("sha256").update(input).digest("hex");
const limit = (message: string): never => {
  throw new ApiError(422, "REPORT_MAP_LIMIT", message);
};
const xml = (input: string) =>
  input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
const number = (value: number) => value.toFixed(2);
const label = (value: string, max = 88) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
function fittedLabel(value: string, width: number, fontSize: number): string {
  const measured = (text: string) =>
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="60"><text x="0" y="40" font-family="DejaVu Sans" font-size="${fontSize}">${xml(text)}</text></svg>`,
      { font: { fontFiles, loadSystemFonts: false } },
    ).innerBBox()?.width ?? 0;
  if (measured(value) <= width) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measured(`${value.slice(0, middle)}…`) <= width) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}…`;
}

export interface ReportMapProjection {
  kind: "local-equirectangular";
  origin: Position;
  metersPerPixel: number;
  viewport: { left: number; top: number; width: number; height: number };
}
export interface ReportMapInput {
  place: Place;
  baselineScenario: Scenario;
  proposalScenario: Scenario;
  /** One frozen map screens both baseline and proposal geometry. */
  flood?: { datasetHash: string; dataset: FloodDataset };
}
export interface ReportMapImage {
  png: Buffer;
  sha256: string;
  scenarioId: string;
  revision: number;
  alt: string;
}
export interface ReportMapMetadata {
  rendererVersion: string;
  kind: "plan-view";
  width: number;
  height: number;
  /** Displayed frame, including shared padding; analytical study boundary is unchanged. */
  extent: [number, number, number, number];
  studyAreaExtent: [number, number, number, number];
  projection: ReportMapProjection;
  focus: { mode: "study-area" | "changes"; reason: string };
  baselineHash: string;
  inputHash: string;
  floodDatasetHash?: string;
  credits: Source[];
  changes: {
    buildings: ChangeCounts;
    roads: ChangeCounts;
    parcels?: ChangeCounts;
    blocks?: ChangeCounts;
  };
  notes: string[];
}
export interface ReportMapPair {
  baseline: ReportMapImage;
  proposal: ReportMapImage;
  metadata: ReportMapMetadata;
}
export interface ChangeCounts {
  added: number;
  modified: number;
  removed: number;
}
export interface ReportMapSvgPair {
  baseline: { svg: string; scenarioId: string; revision: number; alt: string };
  proposal: { svg: string; scenarioId: string; revision: number; alt: string };
  metadata: ReportMapMetadata;
}
type Change = "unchanged" | "added" | "modified" | "removed";
type Feature = Building | Road | Parcel;
interface Compared<T extends Feature> {
  before: T[];
  after: T[];
  status: Map<string, Change>;
  removed: T[];
  counts: ChangeCounts;
}

/** One projection for both panels. No camera state or browser pixels enter this module. */
export function createReportMapProjection(
  place: Place,
  focusedBounds?: [number, number, number, number],
): ReportMapProjection {
  const [west, south, east, north] = focusedBounds ?? studyAreaBounds(place);
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west >= east ||
    south >= north ||
    west < -180 ||
    east > 180 ||
    south <= -85 ||
    north >= 85
  )
    limit(
      "The saved boundary has an unsupported map extent. A finite, non-polar local study area is required.",
    );
  const origin: Position = [(west + east) / 2, (south + north) / 2];
  const widthMeters =
    (east - west) * RAD * EARTH_RADIUS * Math.cos(origin[1] * RAD);
  const heightMeters = (north - south) * RAD * EARTH_RADIUS;
  if (Math.max(widthMeters, heightMeters) > 200_000)
    limit(
      "This study area exceeds the 200 km static-map span limit. Regional report rendering is required.",
    );
  return {
    kind: "local-equirectangular",
    origin,
    metersPerPixel: Math.max(
      widthMeters / (focusedBounds ? 950 : 1240),
      heightMeters / 440,
    ),
    viewport: {
      left: 40,
      top: 122,
      width: focusedBounds ? 1030 : 1320,
      height: 500,
    },
  };
}
export function projectReportPosition(
  position: Position,
  projection: ReportMapProjection,
): Position {
  const { origin, metersPerPixel, viewport } = projection;
  return [
    viewport.left +
      viewport.width / 2 +
      ((position[0] - origin[0]) *
        RAD *
        EARTH_RADIUS *
        Math.cos(origin[1] * RAD)) /
        metersPerPixel,
    viewport.top +
      viewport.height / 2 -
      ((position[1] - origin[1]) * RAD * EARTH_RADIUS) / metersPerPixel,
  ];
}
function displayExtent(
  projection: ReportMapProjection,
): [number, number, number, number] {
  const { origin, metersPerPixel, viewport } = projection;
  const dx =
    ((viewport.width / 2) * metersPerPixel) /
    (RAD * EARTH_RADIUS * Math.cos(origin[1] * RAD));
  const dy = ((viewport.height / 2) * metersPerPixel) / (RAD * EARTH_RADIUS);
  return [origin[0] - dx, origin[1] - dy, origin[0] + dx, origin[1] + dy];
}
function compare<T extends Feature>(before: T[], after: T[]): Compared<T> {
  const original = new Map(before.map((feature) => [feature.id, feature]));
  const current = new Map(after.map((feature) => [feature.id, feature]));
  const status = new Map<string, Change>();
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const feature of after) {
    const old = original.get(feature.id);
    const change = !old
      ? "added"
      : canonicalJSON(old) === canonicalJSON(feature)
        ? "unchanged"
        : "modified";
    status.set(feature.id, change);
    if (change !== "unchanged") counts[change]++;
  }
  const removed = before.filter((feature) => !current.has(feature.id));
  for (const feature of removed) {
    status.set(feature.id, "removed");
    counts.removed++;
  }
  return { before, after, status, removed, counts };
}
function comparisonProjection(
  place: Place,
  buildings: Compared<Building>,
  roads: Compared<Road>,
  parcels: Compared<Parcel>,
): { projection: ReportMapProjection; focus: ReportMapMetadata["focus"] } {
  const whole = createReportMapProjection(place);
  const changed: Feature[] = [
    ...[...buildings.before, ...buildings.after].filter(
      (feature) => buildings.status.get(feature.id) !== "unchanged",
    ),
    ...[...roads.before, ...roads.after].filter(
      (feature) => roads.status.get(feature.id) !== "unchanged",
    ),
    ...[...parcels.before, ...parcels.after].filter(
      (feature) => parcels.status.get(feature.id) !== "unchanged",
    ),
  ];
  const full = (reason: string) => ({
    projection: whole,
    focus: { mode: "study-area" as const, reason },
  });
  if (!changed.length)
    return full(
      "No mapped geometry or attributes changed; both images show the whole study area.",
    );
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const ring of coordinates(changed))
    for (const [x, y] of ring) {
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    }
  if (![west, south, east, north].every(Number.isFinite))
    return full(
      "Changes contain no displayable geometry; both images show the whole study area.",
    );
  const center: Position = [(west + east) / 2, (south + north) / 2];
  const metersPerDegreeX = RAD * EARTH_RADIUS * Math.cos(center[1] * RAD),
    metersPerDegreeY = RAD * EARTH_RADIUS;
  const width = Math.max(400, (east - west) * metersPerDegreeX * 1.6),
    height = Math.max(400, (north - south) * metersPerDegreeY * 1.6);
  const projection = createReportMapProjection(place, [
    center[0] - width / (2 * metersPerDegreeX),
    center[1] - height / (2 * metersPerDegreeY),
    center[0] + width / (2 * metersPerDegreeX),
    center[1] + height / (2 * metersPerDegreeY),
  ]);
  if (projection.metersPerPixel >= whole.metersPerPixel * 0.75)
    return full(
      "Edits are widespread relative to this study area; both images show the whole study area.",
    );
  const broad = displayExtent(whole);
  for (let pass = 0; pass < 2; pass++) {
    const frame = displayExtent(projection),
      dx = (frame[2] - frame[0]) / 2,
      dy = (frame[3] - frame[1]) / 2;
    projection.origin = [
      Math.max(broad[0] + dx, Math.min(broad[2] - dx, projection.origin[0])),
      Math.max(broad[1] + dy, Math.min(broad[3] - dy, projection.origin[1])),
    ];
  }
  return {
    projection,
    focus: {
      mode: "changes",
      reason:
        "Focused comparison of localized edits, with at least 400 m of context. The overview box shows this shared frame; analysis still covers the whole study area.",
    },
  };
}
function coordinates(features: Feature[]): Position[][] {
  return features.flatMap((feature) =>
    "use" in feature
      ? studyAreaPolygons(buildingGeometry(feature)).flat()
      : "geometry" in feature
        ? studyAreaPolygons(feature.geometry).flat()
        : [feature.coordinates],
  );
}

function assertBounds(
  input: ReportMapInput,
  before: Feature[],
  after: Feature[],
  rings: Position[][],
) {
  if (
    input.baselineScenario.id !== "baseline" ||
    Object.keys(input.baselineScenario.buildingEdits).length ||
    Object.keys(input.baselineScenario.roadEdits).length ||
    Object.keys(input.baselineScenario.parcelEdits ?? {}).length
  )
    throw new ApiError(
      422,
      "REPORT_BASELINE_INVALID",
      "Report images require the original immutable baseline scenario.",
    );
  if (
    before.length > REPORT_MAP_LIMITS.featuresPerPanel ||
    after.length > REPORT_MAP_LIMITS.featuresPerPanel
  )
    limit(
      "The saved scenario exceeds the static-map feature limit. No geometry was omitted; use a smaller study area or a regional report worker.",
    );
  let count = 0;
  for (const ring of [
    ...rings,
    ...coordinates(before),
    ...coordinates(after),
  ]) {
    count += ring.length;
    if (count > REPORT_MAP_LIMITS.vertices)
      limit(
        "The saved geometry exceeds the static-map vertex limit. No geometry was simplified or omitted.",
      );
    for (const point of ring)
      if (
        point.length !== 2 ||
        !point.every(Number.isFinite) ||
        Math.abs(point[0]) > 180 ||
        Math.abs(point[1]) > 90
      )
        throw new ApiError(
          422,
          "REPORT_GEOMETRY_INVALID",
          "The captured map contains an invalid coordinate.",
        );
  }
}
function path(
  points: Position[],
  projection: ReportMapProjection,
  close = false,
) {
  return (
    points
      .map((point, index) => {
        const [x, y] = projectReportPosition(point, projection);
        return `${index ? "L" : "M"}${number(x)} ${number(y)}`;
      })
      .join("") + (close ? "Z" : "")
  );
}
function stroke(change: Change) {
  return change === "added"
    ? "#087c72"
    : change === "modified"
      ? "#a55b08"
      : change === "removed"
        ? "#aa3e59"
        : "#81948c";
}
function buildingSvg(
  building: Building,
  change: Change,
  projection: ReportMapProjection,
  ghost = false,
) {
  const fill = ghost
    ? "url(#removed-hatch)"
    : change === "added"
      ? "#afe0d1"
      : change === "modified"
        ? "#f1d49d"
        : change === "removed"
          ? "#f0cbd0"
          : building.use === "park"
            ? "#d9e5c7"
            : "#bac8c1";
  const dash =
    change === "removed" ? "3 5" : change === "modified" ? "8 3" : undefined;
  return `<path d="${studyAreaPolygons(buildingGeometry(building))
    .flat()
    .map((ring) => path(ring, projection, true))
    .join(
      " ",
    )}" fill="${fill}" fill-rule="evenodd" stroke="${stroke(change)}" stroke-width="${change === "unchanged" ? 0.7 : 2.7}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linejoin="round"/>`;
}
function roadSvg(road: Road, change: Change, projection: ReportMapProjection) {
  const width =
    change === "unchanged"
      ? Math.min(4.4, Math.max(1.3, road.lanes * 0.55))
      : 3.5;
  const dash =
    change === "removed" || road.closed
      ? "3 5"
      : change === "modified"
        ? "10 4"
        : undefined;
  return `<path d="${path(road.coordinates, projection)}" fill="none" stroke="${change === "unchanged" ? "#ffffff" : stroke(change)}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linecap="round" stroke-linejoin="round"/>`;
}
function parcelSvg(
  parcel: Parcel,
  change: Change,
  projection: ReportMapProjection,
  ghost = false,
) {
  const geometry = studyAreaPolygons(parcel.geometry)
    .map((rings) => rings.map((ring) => path(ring, projection, true)).join(""))
    .join("");
  const dash =
    change === "removed"
      ? "3 5"
      : change === "modified"
        ? "8 3"
        : parcel.kind === "block"
          ? "14 5 2 5"
          : undefined;
  const fill = ghost
    ? "url(#removed-hatch)"
    : change === "unchanged"
      ? "none"
      : stroke(change);
  return `<path data-boundary-kind="${parcel.kind}" d="${geometry}" fill="${fill}" fill-opacity="${ghost ? ".3" : ".08"}" fill-rule="evenodd" stroke="${stroke(change)}" stroke-width="${parcel.kind === "block" ? 3 : 2}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linejoin="round"/>`;
}
/** Coverage is the same intersection/subtraction used by the exposure resolver.
 * Source SFHA remains visible even where a separate coverage flag is unresolved. */
export function reportFloodUnknownGeometry(
  dataset: FloodDataset,
): StudyAreaGeometry | null {
  type Shape = GeoFeature<GeoPolygon | GeoMultiPolygon>;
  const combine = (shapes: Shape[]): Shape | null =>
    shapes.length === 0
      ? null
      : shapes.length === 1
        ? shapes[0]
        : union(featureCollection(shapes));
  const known = combine(
    dataset.zones
      .filter((z) => z.classification !== "undetermined")
      .map((z) => studyAreaFeature(z.geometry)),
  );
  const availability = combine(
    dataset.availability.map((z) => studyAreaFeature(z.geometry)),
  );
  const undetermined = combine(
    dataset.zones
      .filter((z) => z.classification === "undetermined")
      .map((z) => studyAreaFeature(z.geometry)),
  );
  let covered =
    known && availability
      ? intersect(featureCollection([known, availability]))
      : null;
  if (covered && undetermined)
    covered = difference(featureCollection([covered, undetermined]));
  const remaining = covered
    ? difference(
        featureCollection([studyAreaFeature(dataset.studyArea), covered]),
      )
    : studyAreaFeature(dataset.studyArea);
  return remaining && floodHasArealComponent(remaining.geometry)
    ? (remaining.geometry as StudyAreaGeometry)
    : null;
}
function floodSvg(
  input: ReportMapInput,
  projection: ReportMapProjection,
  boundaryPath: string,
) {
  if (!input.flood) return "";
  const floodway = (zone: FloodDataset["zones"][number]) =>
    zone.classification === "sfha" &&
    /FLOODWAY/i.test(zone.attributes.ZONE_SUBTY ?? "");
  const rank = (zone: FloodDataset["zones"][number]) =>
    floodway(zone)
      ? 3
      : zone.classification === "sfha"
        ? 2
        : zone.classification === "undetermined"
          ? 1
          : 0;
  const zones = [...input.flood.dataset.zones].sort(
    (a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, "en"),
  );
  const shapePath = (geometry: StudyAreaGeometry) =>
    studyAreaPolygons(geometry)
      .flat()
      .map((ring) => path(ring, projection, true))
      .join(" ");
  const unknown = reportFloodUnknownGeometry(input.flood.dataset);
  return `<g data-flood-dataset="${input.flood.datasetHash}"><path d="${boundaryPath}" fill="#f4ead7" fill-rule="evenodd"/>${zones
    .map((zone) => {
      const subtype = zone.attributes.ZONE_SUBTY ?? "";
      const fill = floodway(zone)
        ? "url(#floodway-hatch)"
        : zone.classification === "sfha"
          ? "#92cfdf"
          : zone.classification === "undetermined"
            ? "#f4ead7"
            : /0[.]2/.test(subtype)
              ? "#d5e5ef"
              : "#eef2e9";
      return `<path data-flood-zone="${xml(zone.id)}" d="${shapePath(zone.geometry)}" fill="${fill}" fill-rule="evenodd" stroke="${zone.classification === "sfha" ? "#377c94" : "#a4b7b3"}" stroke-width=".6"><title>${xml(`${zone.attributes.FLD_ZONE ?? "Unclassified"} · ${subtype} · ${zone.id}`)}</title></path>`;
    })
    .join(
      "",
    )}${unknown ? `<path data-flood-unresolved-coverage="true" d="${shapePath(unknown)}" fill="url(#flood-unknown)" fill-rule="evenodd"><title>Coverage or classification unresolved; retained SFHA beneath remains source evidence.</title></path>` : ""}</g>`;
}
function scaleSvg(projection: ReportMapProjection) {
  const target = 170 * projection.metersPerPixel;
  const power = 10 ** Math.floor(Math.log10(target));
  const meters =
    [5, 2, 1].map((n) => n * power).find((n) => n <= target) ?? power / 2;
  const width = meters / projection.metersPerPixel;
  const text = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  const y = 660;
  return `<g><rect x="1082" y="${y - 34}" width="250" height="49" rx="5" fill="#fffdf8"/><path d="M1100 ${y}h${number(width)}m-${number(width)} -6v12m${number(width)} -12v12" stroke="#25443b" stroke-width="2" fill="none"/><text x="1100" y="${y - 11}" font-size="24">${text} · approx.</text></g>`;
}
function creditLines(credits: Source[]) {
  // Full unchanged source records are returned in metadata for the report's citations.
  const entries = credits.map(
    (source) =>
      `${/OpenStreetMap/i.test(source.name) ? "© " : ""}${source.name} · ${source.vintage}${/OpenStreetMap/i.test(source.name) ? ` · ${source.license}` : ""}`,
  );
  const lines: string[] = [];
  let line = "";
  for (const entry of entries) {
    if ((line ? line + "  |  " : "").length + entry.length > 110 && line) {
      lines.push(line);
      line = "";
    }
    line += (line ? "  |  " : "") + entry;
  }
  if (line) lines.push(line);
  const visible = lines
    .slice(0, 3)
    .map((value) => fittedLabel(label(value, 110), 1320, 22));
  if (
    lines.length > 3 ||
    visible.some((value, index) => value !== lines[index])
  )
    visible.push(
      "Full source names, vintages, licenses and URLs accompany this image in the report.",
    );
  return visible;
}
function overviewSvg(place: Place, metadata: ReportMapMetadata): string {
  if (metadata.focus.mode !== "changes") return "";
  const [w, s, e, n] = studyAreaBounds(place);
  const projection: ReportMapProjection = {
    ...createReportMapProjection(place),
    viewport: { left: 1110, top: 166, width: 230, height: 140 },
    metersPerPixel: Math.max(
      ((e - w) * RAD * EARTH_RADIUS * Math.cos(((s + n) / 2) * RAD)) / 210,
      ((n - s) * RAD * EARTH_RADIUS) / 120,
    ),
  };
  const geometry = studyAreaPolygons(place)
    .map((polygon) =>
      polygon.map((ring) => path(ring, projection, true)).join(""),
    )
    .join("");
  const frame = metadata.extent;
  const [x1, y1] = projectReportPosition([frame[0], frame[3]], projection),
    [x2, y2] = projectReportPosition([frame[2], frame[1]], projection);
  return `<g><rect x="1090" y="122" width="270" height="250" rx="9" fill="#e8eeea"/><text x="1110" y="149" font-size="24" font-weight="bold">Study overview</text><clipPath id="overview-frame"><rect x="1110" y="166" width="230" height="140"/></clipPath><g clip-path="url(#overview-frame)"><path d="${geometry}" fill="#f5f4eb" fill-rule="evenodd" stroke="#557669" stroke-width="1.4"/><rect x="${number(x1)}" y="${number(y1)}" width="${number(x2 - x1)}" height="${number(y2 - y1)}" fill="#087c72" fill-opacity=".1" stroke="#087c72" stroke-width="2.5"/></g><text x="1110" y="335" font-size="22">Box = detail frame</text><text x="1110" y="359" font-size="22">Whole-area analysis</text></g>`;
}
function draw(
  input: ReportMapInput,
  side: "baseline" | "proposal",
  projection: ReportMapProjection,
  boundaryPath: string,
  clipBoundaryPath: string,
  buildings: Compared<Building>,
  roads: Compared<Road>,
  parcels: Compared<Parcel>,
  metadata: ReportMapMetadata,
  floodMarkup: string,
) {
  const scenario =
    side === "baseline" ? input.baselineScenario : input.proposalScenario;
  const title =
    side === "baseline"
      ? "Before · saved baseline"
      : "After · proposed scenario";
  const currentBuildings =
    side === "baseline" ? buildings.before : buildings.after;
  const currentRoads = side === "baseline" ? roads.before : roads.after;
  const currentParcels = side === "baseline" ? parcels.before : parcels.after;
  const svgParcels = currentParcels
    .map((parcel) =>
      parcelSvg(
        parcel,
        parcels.status.get(parcel.id) ?? "unchanged",
        projection,
      ),
    )
    .join("");
  const svgBuildings = currentBuildings
    .map((building) =>
      buildingSvg(
        building,
        buildings.status.get(building.id) ?? "unchanged",
        projection,
      ),
    )
    .join("");
  const svgRoads = currentRoads
    .map((road) =>
      roadSvg(road, roads.status.get(road.id) ?? "unchanged", projection),
    )
    .join("");
  const ghosts =
    side === "proposal"
      ? buildings.removed
          .map((building) => buildingSvg(building, "removed", projection, true))
          .join("") +
        roads.removed
          .map((road) => roadSvg(road, "removed", projection))
          .join("") +
        parcels.removed
          .map((parcel) => parcelSvg(parcel, "removed", projection, true))
          .join("")
      : "";
  const credits = creditLines(metadata.credits);
  const changes = metadata.changes;
  const areaCounts =
    changes.parcels && changes.blocks
      ? `Parcels: +${changes.parcels.added} · changed ${changes.parcels.modified} · −${changes.parcels.removed}    Blocks: +${changes.blocks.added} · changed ${changes.blocks.modified} · −${changes.blocks.removed}`
      : "";
  const areaDisclosure = areaCounts
    ? " Parcel and block boundaries are planning references, not verified title or subdivision approval; holes and detached components are retained."
    : "";
  const floodDisclosure = input.flood
    ? " Both panels show the same frozen FEMA classification: blue SFHA, blue hatching floodway, pale blue 0.2-percent context, pale green other mapped classes and transparent amber hatching undetermined classification or missing availability/zone coverage. Amber hatching may overlap retained SFHA; it does not erase the mapped hazard. No mapped SFHA intersection does not establish safety. Complete tables and source dates accompany the map."
    : "";
  const alt = `${title} for ${input.place.name}, ${scenario.name} revision ${scenario.revision}. North-up plan of saved footprints and schematic roads at the same extent and scale as the other panel. Study-area holes and disconnected components are retained. ${changes.buildings.added} added, ${changes.buildings.modified} modified and ${changes.buildings.removed} removed buildings or land-use footprints; ${changes.roads.added} added, ${changes.roads.modified} modified and ${changes.roads.removed} removed road segments. ${areaCounts}${areaDisclosure} Removed outlines in the after view are reference-only. This is a geometry illustration, not an aerial photograph or traffic simulation. ${metadata.focus.reason}${floodDisclosure}`;
  const imageCredits =
    areaCounts && credits.length > 3
      ? [
          ...credits.slice(0, 2),
          "Full source names, dates, licenses and URLs accompany this image in the report.",
        ]
      : credits;
  const floodPatterns = input.flood
    ? `<pattern id="flood-unknown" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8" stroke="#a07840" stroke-width="1.2"/></pattern><pattern id="floodway-hatch" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#92cfdf"/><path d="M0 8L8 0" stroke="#377c94" stroke-width="1.2"/></pattern>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="${metadata.height}" viewBox="0 0 1400 ${metadata.height}">
<title>${xml(alt)}</title><desc>Source baseline SHA-256: ${metadata.baselineHash}. Pair input SHA-256: ${metadata.inputHash}.</desc>
<defs><clipPath id="map-frame"><rect x="${projection.viewport.left}" y="${projection.viewport.top}" width="${projection.viewport.width}" height="${projection.viewport.height}" rx="9"/></clipPath><clipPath id="study-area"><path d="${clipBoundaryPath}" fill-rule="evenodd" clip-rule="evenodd"/></clipPath><pattern id="removed-hatch" width="9" height="9" patternUnits="userSpaceOnUse"><path d="M0 0L9 9M9 0L0 9" stroke="#aa3e59" stroke-width=".7" opacity=".55"/></pattern>${floodPatterns}</defs>
<rect width="1400" height="${metadata.height}" fill="#fffdf8"/>
<g font-family="DejaVu Sans" fill="#25443b"><text x="40" y="49" font-size="32" font-weight="bold">${xml(title)}</text><text x="40" y="85" font-size="24">${xml(fittedLabel(label(`${input.place.name} · ${scenario.name} · revision ${scenario.revision}`, 100), 1200, 24))}</text>
<rect x="40" y="122" width="${projection.viewport.width}" height="500" rx="9" fill="#e8eeea"/>
<g clip-path="url(#map-frame)"><path d="${boundaryPath}" fill="#f5f4eb" fill-rule="evenodd" stroke="#557669" stroke-width="1.4"/></g>
<g clip-path="url(#study-area)">${floodMarkup}${svgParcels}${svgBuildings}${svgRoads}${ghosts}</g>
<g clip-path="url(#map-frame)"><path d="${boundaryPath}" fill="none" stroke="#557669" stroke-width="1.4"/></g>
${overviewSvg(input.place, metadata)}
<g transform="translate(1310,44)"><rect x="-23" y="-17" width="47" height="79" rx="5" fill="#fffdf8" opacity=".96"/><text text-anchor="middle" font-size="24">N</text><path d="M0 12L-9 40L0 34L9 40Z" fill="#25443b"/></g>${scaleSvg(projection)}
<g font-size="24"><path d="M45 655h35" stroke="#81948c" stroke-width="3"/><text x="90" y="663">Unchanged</text><path d="M300 655h35" stroke="#087c72" stroke-width="5"/><text x="345" y="663">+ Added</text><path d="M520 655h35" stroke="#a55b08" stroke-width="4" stroke-dasharray="8 3"/><text x="565" y="663">Modified</text><path d="M775 655h35" stroke="#aa3e59" stroke-width="4" stroke-dasharray="3 5"/><text x="820" y="663">× Removed</text></g>
<text x="40" y="700" font-size="24">Footprints: +${changes.buildings.added} · changed ${changes.buildings.modified} · −${changes.buildings.removed}    Roads: +${changes.roads.added} · changed ${changes.roads.modified} · −${changes.roads.removed}</text>
${areaCounts ? `<text x="40" y="730" font-size="24">${xml(areaCounts)}</text>` : ""}
<text x="40" y="${areaCounts ? 760 : 734}" font-size="22">${xml(fittedLabel(`${metadata.focus.mode === "changes" ? "Focused comparison · whole-area analysis" : "Whole study area · 2D geometry"} · ${areaCounts ? "planning boundaries; no legal subdivision approval" : "removed outlines in after are reference-only"}`, 1320, 22))}</text>
${imageCredits.map((line, index) => `<text x="40" y="${(areaCounts ? 794 : 768) + index * 25}" font-size="22">${xml(line)}</text>`).join("")}
${input.flood ? `<g font-size="21"><rect x="40" y="891" width="28" height="20" fill="#92cfdf"/><text x="78" y="909">SFHA</text><rect x="190" y="891" width="28" height="20" fill="url(#floodway-hatch)"/><text x="228" y="909">Floodway</text><rect x="405" y="891" width="28" height="20" fill="#d5e5ef"/><text x="443" y="909">0.2% context</text><rect x="650" y="891" width="28" height="20" fill="#eef2e9"/><text x="688" y="909">Other mapped</text><rect x="925" y="891" width="28" height="20" fill="#f4ead7"/><rect x="925" y="891" width="28" height="20" fill="url(#flood-unknown)"/><text x="963" y="909">Unknown / missing coverage</text><text x="40" y="943">${input.proposalScenario.flood?.origin === "imported" ? "Imported flood evidence · source claims not server verified" : "Frozen FEMA map · same evidence in both panels"} · mapped screening only</text></g>` : ""}
<text x="40" y="${metadata.height - 15}" font-size="20" fill="#557669">Saved source ${metadata.baselineHash.slice(0, 16)} · ${metadata.rendererVersion} · Full provenance accompanies this image</text></g></svg>`;
  return { svg, scenarioId: scenario.id, revision: scenario.revision, alt };
}

/** Pure SVG stage for inspection/tests; only our geometry and escaped text can create markup. */
export function buildReportMapPairSvg(input: ReportMapInput): ReportMapSvgPair {
  if (
    Boolean(input.proposalScenario.flood) !== Boolean(input.flood) ||
    (input.flood &&
      (input.flood.datasetHash !== input.proposalScenario.flood?.datasetHash ||
        hash(canonicalJSON(input.flood.dataset)) !== input.flood.datasetHash ||
        hash(canonicalJSON(studyAreaGeometry(input.place))) !==
          input.flood.dataset.studyAreaHash))
  )
    throw new ApiError(
      422,
      "REPORT_FLOOD_CONTEXT_INVALID",
      "The comparison map requires the scenario's exact retained flood dataset and study boundary.",
    );
  const beforeBuildings = materializeBuildings(
    input.place,
    input.baselineScenario,
  ).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const afterBuildings = materializeBuildings(
    input.place,
    input.proposalScenario,
  ).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const beforeRoads = materializeRoads(
    input.place,
    input.baselineScenario,
  ).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const afterRoads = materializeRoads(input.place, input.proposalScenario).sort(
    (a, b) => a.id.localeCompare(b.id, "en"),
  );
  const beforeParcels = materializeParcels(
    input.place,
    input.baselineScenario,
  ).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const afterParcels = materializeParcels(
    input.place,
    input.proposalScenario,
  ).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const polygons = studyAreaPolygons(input.place);
  assertBounds(
    input,
    [...beforeBuildings, ...beforeRoads, ...beforeParcels],
    [...afterBuildings, ...afterRoads, ...afterParcels],
    [
      ...polygons.flat(),
      ...(input.flood
        ? [
            ...input.flood.dataset.zones,
            ...input.flood.dataset.availability,
          ].flatMap((feature) => studyAreaPolygons(feature.geometry).flat())
        : []),
    ],
  );
  const buildings = compare(beforeBuildings, afterBuildings),
    roads = compare(beforeRoads, afterRoads),
    parcels = compare(beforeParcels, afterParcels);
  const { projection, focus } = comparisonProjection(
    input.place,
    buildings,
    roads,
    parcels,
  );
  const boundaryPath = polygons
    .map((polygon) =>
      polygon.map((ring) => path(ring, projection, true)).join(""),
    )
    .join("");
  const [west, south, east, north] = displayExtent(projection);
  // A single geometric mask avoids native nested-clip failures for off-frame rings.
  // Intersection clips only the displayed frame; it neither simplifies the source nor fills holes.
  const clipped = intersect(
    featureCollection([
      studyAreaFeature(input.place),
      polygon([
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ]),
    ]),
  );
  if (!clipped)
    throw new ApiError(
      422,
      "REPORT_GEOMETRY_INVALID",
      "The comparison frame does not intersect the saved study area.",
    );
  const clipPolygons =
    clipped.geometry.type === "Polygon"
      ? [clipped.geometry.coordinates]
      : clipped.geometry.coordinates;
  const clipBoundaryPath = clipPolygons
    .map((rings) =>
      rings
        .map((ring) =>
          path(
            ring.map(([x, y]) => [x, y] as Position),
            projection,
            true,
          ),
        )
        .join(""),
    )
    .join("");
  const geometrySourceIds = new Set(
    [
      ...beforeBuildings,
      ...afterBuildings,
      ...beforeRoads,
      ...afterRoads,
      ...beforeParcels,
      ...afterParcels,
    ].flatMap((feature) =>
      [
        feature.sourceId,
        "attributeSourceId" in feature ? feature.attributeSourceId : undefined,
        "geometrySourceId" in feature ? feature.geometrySourceId : undefined,
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const credits = [
    ...new Map(
      [
        ...input.place.sources,
        ...(input.baselineScenario.sources ?? []),
        ...(input.proposalScenario.sources ?? []),
        ...(input.flood?.dataset.sources ?? []),
      ].map((source) => [canonicalJSON(source), structuredClone(source)]),
    ).values(),
  ].sort((a, b) => {
    const rank = (source: Source) =>
      /OpenStreetMap/i.test(source.name)
        ? 0
        : geometrySourceIds.has(source.id)
          ? 1
          : 2;
    return rank(a) - rank(b);
  });
  if (credits.length > REPORT_MAP_LIMITS.sourceRecords)
    limit(
      "This report exceeds the static-map source-record limit. No attribution was omitted.",
    );
  const baselineHash = hash(canonicalJSON(input.place));
  const rendererVersion = input.flood
    ? "urban-plan-5-flood-coverage"
    : RENDERER_VERSION;
  const metadata: ReportMapMetadata = {
    rendererVersion,
    kind: "plan-view",
    width: 1400,
    height: input.flood
      ? REPORT_MAP_LIMITS.floodHeight
      : REPORT_MAP_LIMITS.height,
    extent: displayExtent(projection),
    studyAreaExtent: studyAreaBounds(input.place),
    projection,
    focus,
    baselineHash,
    ...(input.flood ? { floodDatasetHash: input.flood.datasetHash } : {}),
    inputHash: hash(
      canonicalJSON({
        rendererVersion,
        baselineHash,
        baselineScenario: input.baselineScenario,
        proposalScenario: input.proposalScenario,
        projection,
        ...(input.flood ? { floodDatasetHash: input.flood.datasetHash } : {}),
      }),
    ),
    credits,
    changes: {
      buildings: buildings.counts,
      roads: roads.counts,
      ...(beforeParcels.length || afterParcels.length
        ? {
            parcels: compare(
              beforeParcels.filter((parcel) => parcel.kind === "parcel"),
              afterParcels.filter((parcel) => parcel.kind === "parcel"),
            ).counts,
            blocks: compare(
              beforeParcels.filter((parcel) => parcel.kind === "block"),
              afterParcels.filter((parcel) => parcel.kind === "block"),
            ).counts,
          }
        : {}),
    },
    notes: [
      ...(input.flood
        ? [
            "The same captured FEMA map is drawn beneath baseline and proposal geometry. Colored polygons and hatched gaps are source classification context, not predicted flooding or individual dwelling locations. Complete exposure tables and source dates accompany this image.",
          ]
        : []),
      focus.reason,
      "Both panels use the exact same north-up local projection, display extent, and scale; they are generated from the captured server baseline and saved scenario.",
      "Study-area holes and disconnected components are retained. Geometry is clipped to that exact study boundary; the display padding does not enlarge the analytical area.",
      "A 2D plan shows saved footprints and schematic road centerlines, not building height, a photograph, surveyed conditions, or simulated traffic. Land-use polygons are included in footprint counts.",
      "Modified means an attribute or geometry changed. Removed geometry appears only as reference outlines in the after panel; it is absent from scenario calculations.",
      ...(beforeParcels.length || afterParcels.length
        ? [
            "Parcel and block outlines preserve supplied holes and disconnected parts. Block outlines use a long-short dash. Imported boundaries and scenario changes are planning references, not title verification, a legal subdivision, or zoning approval.",
          ]
        : []),
      "Scale is approximate at the shared projection origin. Consult the complete source names, vintages, licenses, URLs, coverage gaps and estimated attributes in the accompanying report.",
    ],
  };
  const floodMarkup = floodSvg(input, projection, boundaryPath);
  const result = {
    baseline: draw(
      input,
      "baseline",
      projection,
      boundaryPath,
      clipBoundaryPath,
      buildings,
      roads,
      parcels,
      metadata,
      floodMarkup,
    ),
    proposal: draw(
      input,
      "proposal",
      projection,
      boundaryPath,
      clipBoundaryPath,
      buildings,
      roads,
      parcels,
      metadata,
      floodMarkup,
    ),
    metadata,
  };
  if (
    Buffer.byteLength(result.baseline.svg) +
      Buffer.byteLength(result.proposal.svg) >
    REPORT_MAP_LIMITS.svgBytes
  )
    limit(
      "The generated map exceeds the bounded rasterization input limit. No geometry was silently dropped.",
    );
  return result;
}

let active = false;
interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
}
const waiting: Waiter[] = [];
const cancelled = () =>
  new ApiError(
    408,
    "REPORT_MAP_CANCELLED",
    "Report map generation was cancelled.",
  );
function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  if (!active) {
    active = true;
    return Promise.resolve();
  }
  if (waiting.length >= REPORT_MAP_LIMITS.waitingPairs)
    return Promise.reject(
      new ApiError(
        429,
        "REPORT_MAP_BUSY",
        "Report image generation is busy. Retry shortly; no report was created.",
      ),
    );
  return new Promise((resolve, reject) => {
    const remove = () => {
      const index = waiting.indexOf(waiter);
      if (index >= 0) waiting.splice(index, 1);
      clearTimeout(waiter.timer);
      signal?.removeEventListener("abort", waiter.abort);
    };
    const waiter: Waiter = {
      resolve: () => {
        remove();
        resolve();
      },
      reject,
      timer: setTimeout(() => {
        remove();
        reject(
          new ApiError(
            503,
            "REPORT_MAP_QUEUE_TIMEOUT",
            "Report image generation is busy. Retry shortly.",
          ),
        );
      }, REPORT_MAP_LIMITS.queueTimeoutMs),
      signal,
      abort: () => {
        remove();
        reject(cancelled());
      },
    };
    waiting.push(waiter);
    signal?.addEventListener("abort", waiter.abort, { once: true });
  });
}
function release() {
  const next = waiting[0];
  if (next) next.resolve();
  else active = false;
}
/** At most one pair is rasterized per process; dimensions and scene complexity are bounded. */
export async function renderReportMapPair(
  input: ReportMapInput,
  options: { signal?: AbortSignal } = {},
): Promise<ReportMapPair> {
  await acquire(options.signal);
  try {
    if (options.signal?.aborted) throw cancelled();
    const prepared = buildReportMapPairSvg(input);
    const rasterize = async (
      scene: ReportMapSvgPair["baseline"],
    ): Promise<ReportMapImage> => {
      if (options.signal?.aborted) throw cancelled();
      const rendered = await renderAsync(
        scene.svg,
        {
          font: {
            fontFiles,
            loadSystemFonts: false,
            defaultFontFamily: "DejaVu Sans",
          },
          logLevel: "off",
        },
        options.signal,
      );
      const png = rendered.asPng();
      return {
        png,
        sha256: hash(png),
        scenarioId: scene.scenarioId,
        revision: scene.revision,
        alt: scene.alt,
      };
    };
    const baseline = await rasterize(prepared.baseline);
    const proposal = await rasterize(prepared.proposal);
    return { baseline, proposal, metadata: prepared.metadata };
  } catch (error) {
    if (options.signal?.aborted) throw cancelled();
    throw error;
  } finally {
    release();
  }
}
