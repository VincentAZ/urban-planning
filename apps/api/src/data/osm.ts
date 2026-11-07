import { area, kinks, polygon } from "@turf/turf";
import {
  buildingWithinStudyArea,
  clipLineToStudyArea,
  type Building,
  type Place,
  type Position,
  type Road,
} from "@urban/core";
import { ApiError } from "../errors.js";
import { boundedJson } from "./public-fetch.js";
import { inferOsmAttributes } from "./osm-inference.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";

export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
export interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
export interface OsmResponse {
  elements: OsmElement[];
  osm3s: { timestamp_osm_base: string };
  remark?: string;
}
export function validateOsmResponse(input: unknown): OsmResponse {
  const data = input as OsmResponse;
  if (
    !data ||
    data.remark ||
    !Array.isArray(data.elements) ||
    !data.osm3s?.timestamp_osm_base ||
    !Number.isFinite(Date.parse(data.osm3s.timestamp_osm_base))
  )
    throw new ApiError(
      502,
      "OSM_INCOMPLETE",
      "OpenStreetMap returned an incomplete or interrupted result. No partial place was saved.",
    );
  const count = data.elements.find((e) => e.type === "count");
  const features = data.elements.filter((e) => e.type !== "count");
  if (!count || Number(count.tags?.total) !== features.length)
    throw new ApiError(
      502,
      "OSM_COUNT_MISMATCH",
      "The OpenStreetMap result is missing its completion count. No partial place was saved.",
    );
  if (features.length > 40_000)
    throw new ApiError(
      422,
      "OSM_FEATURE_LIMIT",
      "This ZIP area exceeds the initial worker’s 40,000-feature limit. It needs regional preprocessing.",
    );
  if (!features.length)
    throw new ApiError(
      422,
      "OSM_NO_COVERAGE",
      "No mapped buildings or streets were returned. An empty result is not evidence that this area has none.",
    );
  let vertices = 0;
  for (const feature of features) {
    if (feature.type !== "way") continue;
    if (
      !Array.isArray(feature.geometry) ||
      feature.geometry.length < 2 ||
      feature.geometry.some(
        (p) =>
          !p ||
          !Number.isFinite(p.lat) ||
          !Number.isFinite(p.lon) ||
          Math.abs(p.lat) > 90 ||
          Math.abs(p.lon) > 180,
      )
    )
      throw new ApiError(
        502,
        "OSM_GEOMETRY_INCOMPLETE",
        "A mapped feature lacks complete valid geometry. No partial place was saved.",
      );
    vertices += feature.geometry.length;
  }
  if (vertices > 500_000)
    throw new ApiError(
      422,
      "OSM_VERTEX_LIMIT",
      "This area exceeds the initial geometry processing limit. It needs regional preprocessing.",
    );
  return data;
}
export async function fetchOsm(
  bounds: [number, number, number, number],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const [west, south, east, north] = bounds;
  const box = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:60][maxsize:67108864];(way[building](${box});way[highway](${box});way[leisure=park](${box});relation[building](${box});relation[leisure=park](${box}););out tags geom;out count;`;
  const directory = resolve(
    process.env.PUBLIC_SOURCE_CACHE_PATH ?? ".local/public-source-cache",
  );
  const cacheFile = resolve(
    directory,
    `${createHash("sha256").update(query).digest("hex")}.json`,
  );
  if (fetcher === fetch) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8")) as {
        endpoint: string;
        query: string;
        retrievedAt: string;
        data: OsmResponse;
      };
      if (
        cached.endpoint === OVERPASS_ENDPOINT &&
        cached.query === query &&
        Date.now() - Date.parse(cached.retrievedAt) < 86_400_000
      )
        return { ...cached, data: validateOsmResponse(cached.data) };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !(error instanceof ApiError)
      )
        throw error;
    }
  }
  const retrievedAt = new Date().toISOString();
  const data = validateOsmResponse(
    await boundedJson(OVERPASS_ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal,
      timeoutMs: 75_000,
      maxBytes: 25_000_000,
      fetcher,
    }),
  );
  const result = { endpoint: OVERPASS_ENDPOINT, query, retrievedAt, data };
  if (fetcher === fetch) {
    await mkdir(directory, { recursive: true });
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(result));
    await rename(temporary, cacheFile);
  }
  return result;
}
export function convertOsm(
  data: OsmResponse,
  place: Place,
  geometrySourceId: string,
  attributeSourceId: string,
) {
  const buildings: Building[] = [];
  const roads: Road[] = [];
  let omittedRelations = 0,
    excludedBuildings = 0,
    invalidPolygons = 0;
  for (const element of data.elements) {
    if (element.type === "count") continue;
    if (element.type !== "way") {
      omittedRelations++;
      continue;
    }
    const tags = element.tags ?? {};
    const shape: Position[] = element.geometry!.map((p) => [p.lon, p.lat]);
    if (tags.building || tags.leisure === "park") {
      if (
        shape.length < 4 ||
        shape[0][0] !== shape.at(-1)![0] ||
        shape[0][1] !== shape.at(-1)![1]
      ) {
        invalidPolygons++;
        continue;
      }
      const geometry = polygon([shape]);
      const areaSqm = Math.round(area(geometry));
      if (kinks(geometry).features.length || areaSqm < 1) {
        invalidPolygons++;
        continue;
      }
      if (!buildingWithinStudyArea(shape, place)) {
        excludedBuildings++;
        continue;
      }
      const inferred = inferOsmAttributes(tags, areaSqm);
      const address = [tags["addr:housenumber"], tags["addr:street"]]
        .filter(Boolean)
        .join(" ");
      buildings.push({
        id: `osm-way-${element.id}`,
        name:
          tags.name ||
          address ||
          `${inferred.use === "park" ? "Park" : "Building"} ${element.id}`,
        footprint: shape,
        areaSqm,
        ...inferred,
        sourceId: geometrySourceId,
        attributeSourceId,
        estimated: true,
        ...(address ? { address } : {}),
      });
    }
    if (
      tags.highway &&
      !["construction", "proposed", "steps"].includes(tags.highway)
    ) {
      const foot = [
        "footway",
        "path",
        "pedestrian",
        "cycleway",
        "track",
      ].includes(tags.highway);
      const rawSpeed = Number.parseFloat(tags.maxspeed ?? "");
      const rawLanes = Number.parseInt(tags.lanes ?? "", 10);
      const validSpeed = Number.isFinite(rawSpeed) && rawSpeed > 0;
      const validLanes = Number.isFinite(rawLanes) && rawLanes > 0;
      const pieces = clipLineToStudyArea(shape, place);
      for (const [i, coordinates] of pieces.entries())
        roads.push({
          id: `osm-way-${element.id}${pieces.length > 1 ? `-part-${i}` : ""}`,
          name: tags.name || (foot ? "Pedestrian path" : "Local access"),
          coordinates:
            tags.oneway === "-1" ? [...coordinates].reverse() : coordinates,
          lanes: Math.min(
            20,
            validLanes
              ? rawLanes
              : foot
                ? 1
                : ["primary", "secondary"].includes(tags.highway)
                  ? 3
                  : 2,
          ),
          speedMph: Math.min(
            120,
            validSpeed
              ? Math.round(
                  rawSpeed * (tags.maxspeed.includes("mph") ? 1 : 0.621371),
                )
              : foot
                ? 3
                : tags.highway === "service"
                  ? 15
                  : 25,
          ),
          oneWay: ["yes", "1", "-1"].includes(tags.oneway),
          kind: tags.highway,
          sourceId: geometrySourceId,
          attributeSourceId:
            validSpeed && validLanes ? geometrySourceId : attributeSourceId,
          estimated: !validSpeed || !validLanes,
          bikeLane: Boolean(tags.cycleway && tags.cycleway !== "no"),
        });
    }
  }
  if (!buildings.length || !roads.length)
    throw new ApiError(
      422,
      "INSUFFICIENT_OSM_COVERAGE",
      "This area does not have enough supported mapped buildings and streets for the initial planning workspace. No empty baseline was published.",
    );
  const warnings = [
    "OpenStreetMap is a contributed map, not an exhaustive inventory. Unmapped buildings and roads remain unknown.",
    ...(omittedRelations
      ? [
          `${omittedRelations} complex relation features were not imported; multipolygon building/park support is still required for a complete inventory.`,
        ]
      : []),
    ...(excludedBuildings
      ? [
          `${excludedBuildings} fetched footprints outside or crossing the exact ZCTA boundary were excluded; partial buildings are not modeled.`,
        ]
      : []),
    ...(invalidPolygons
      ? [
          `${invalidPolygons} invalid or open building/park outlines were excluded and remain a coverage gap.`,
        ]
      : []),
  ];
  return { buildings, roads, warnings };
}
