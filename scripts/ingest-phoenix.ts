/** Download a bounded, reproducible OSM reference area. Never call Overpass from every viewer. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  Building,
  LandUse,
  Place,
  Polygon,
  Position,
  Road,
} from "../packages/core/src/index.ts";

import {
  clipLineToBounds,
  inBounds,
} from "../apps/web/src/components/map/geometry.ts";
import { archivePlace } from "./snapshot-archive";
import { inferOsmAttributes } from "../apps/api/src/data/osm-inference";

type OSMElement = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
};
const bounds: [number, number, number, number] = [
  -112.081, 33.446, -112.059, 33.465,
];
const [west, south, east, north] = bounds;
const query = `[out:json][timeout:45];(way[building](${south},${west},${north},${east});way[highway](${south},${west},${north},${east});way[leisure=park](${south},${west},${north},${east}););out tags geom;`;
const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
let data:
  | { elements: OSMElement[]; osm3s?: { timestamp_osm_base: string } }
  | undefined;
let endpoint = "";
let retrievedAt = new Date().toISOString();
if (process.argv.includes("--from-cache")) {
  const cached = JSON.parse(
    await readFile("public/data/phoenix-source.json", "utf8"),
  );
  data = cached;
  endpoint = cached.endpoint;
  retrievedAt = cached.retrievedAt;
}
for (const candidate of data ? [] : endpoints) {
  try {
    const response = await fetch(candidate, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(60000),
      headers: {
        "User-Agent":
          "UrbanPlanningReferenceIngest/0.1 (bounded one-time reference data)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = (await response.json()) as typeof data;
    if (!data?.elements?.length) throw new Error("No OSM elements returned");
    endpoint = candidate;
    break;
  } catch (error) {
    console.warn(`${candidate}: ${String(error)}`);
  }
}
if (!data)
  throw new Error("No source downloaded. Existing data was not replaced.");
const rounded = (n: number) => Math.round(n * 1e7) / 1e7;
const polygon = (e: OSMElement): Polygon =>
  (e.geometry ?? []).map((p) => [rounded(p.lon), rounded(p.lat)] as Position);
function area(p: Polygon): number {
  const latitude = p.reduce((s, v) => s + v[1], 0) / p.length;
  const mx = 111320 * Math.cos((latitude * Math.PI) / 180),
    my = 110574;
  const origin = p[0];
  let twice = 0;
  for (let i = 0; i < p.length - 1; i++)
    twice +=
      (p[i][0] - origin[0]) * mx * (p[i + 1][1] - origin[1]) * my -
      (p[i + 1][0] - origin[0]) * mx * (p[i][1] - origin[1]) * my;
  return Math.round(Math.abs(twice) / 2);
}
const buildings: Building[] = [];
const roads: Road[] = [];
for (const e of data.elements) {
  const tags = e.tags ?? {};
  const shape = polygon(e);
  if (shape.length < 2) continue;
  if (tags.building || tags.leisure === "park") {
    if (shape.length < 4 || !shape.every((point) => inBounds(point, bounds)))
      continue;
    const a = area(shape);
    if (a < 18) continue;
    const inferred = inferOsmAttributes(tags, a);
    const { use, floors, height, units } = inferred;
    const address = [tags["addr:housenumber"], tags["addr:street"]]
      .filter(Boolean)
      .join(" ");
    buildings.push({
      id: `osm-way-${e.id}`,
      name:
        tags.name ||
        address ||
        `${use === "park" ? "Park" : use === "residential" ? "Residence" : use === "multifamily" ? "Apartments" : "Building"} ${e.id}`,
      use,
      footprint: shape,
      height: Math.round(height * 10) / 10,
      floors,
      areaSqm: a,
      units,
      jobs: inferred.jobs,
      parkingSpaces: inferred.parkingSpaces,
      sourceId: "osm-phoenix",
      attributeSourceId: "inference-phoenix",
      estimated: true,
      ...(address ? { address } : {}),
    });
  }
  if (
    tags.highway &&
    !["construction", "proposed", "steps"].includes(tags.highway)
  ) {
    const isFoot = [
      "footway",
      "path",
      "pedestrian",
      "cycleway",
      "track",
    ].includes(tags.highway);
    const parsedSpeed = Number.parseFloat(tags.maxspeed ?? "");
    const clippedPaths = clipLineToBounds(shape, bounds);
    for (const [pieceIndex, clippedShape] of clippedPaths.entries()) {
      roads.push({
        id: `osm-way-${e.id}${clippedPaths.length > 1 ? `-part-${pieceIndex}` : ""}`,
        name: tags.name || (isFoot ? "Pedestrian path" : "Local access"),
        coordinates:
          tags.oneway === "-1" ? [...clippedShape].reverse() : clippedShape,
        lanes:
          Number.parseInt(tags.lanes ?? "", 10) ||
          (isFoot
            ? 1
            : ["primary", "secondary"].includes(tags.highway)
              ? 3
              : 2),
        speedMph: Number.isFinite(parsedSpeed)
          ? Math.round(
              parsedSpeed * (tags.maxspeed.includes("mph") ? 1 : 0.621371),
            )
          : isFoot
            ? 3
            : tags.highway === "service"
              ? 15
              : 25,
        oneWay:
          tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "-1",
        kind: tags.highway,
        sourceId: "osm-phoenix",
        estimated: !tags.lanes || !tags.maxspeed,
        attributeSourceId:
          !tags.lanes || !tags.maxspeed ? "inference-phoenix" : "osm-phoenix",
        bikeLane: Boolean(tags.cycleway && tags.cycleway !== "no"),
      });
    }
  }
}
const date =
  data.osm3s?.timestamp_osm_base?.slice(0, 10) ??
  new Date().toISOString().slice(0, 10);
const place: Place = {
  id: "phoenix-roosevelt",
  name: "Roosevelt Row",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.0707, 33.4575],
  bounds,
  boundary: [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ],
  buildings,
  roads,
  sources: [
    {
      id: "osm-phoenix",
      name: "OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
      vintage: date,
      license: "ODbL 1.0",
      kind: "observed",
      description: `Real mapped footprints and road geometry downloaded from ${endpoint}. OSM completeness varies. Roads are clipped to the reference extent; crossing-boundary buildings are excluded rather than modeled as partial buildings. This rectangular reference extent is not a ZIP boundary.`,
    },
    {
      id: "inference-phoenix",
      name: "Urban Planning reference inference v1",
      url: "https://www.openstreetmap.org",
      vintage: date,
      license: "Application-derived estimates",
      kind: "inferred",
      description:
        "Missing heights use levels × 3.5 m; missing levels use documented use/footprint heuristics (1–5 floors). Uses follow OSM tags where available, otherwise small buildings are assumed residential and larger buildings office. Dwelling counts use mapped flats or 100 m² gross floor area per apartment. Job counts are unvalidated capacity estimates using gross floor area × illustrative jobs per 1,000 ft²: office 4, retail/school 2, industrial 1.5, warehouse 0.5, healthcare/civic 3. Apartment counts can overstate capacity where tower/podium floorplates differ. Parking structures use 30 m² per space; surface and on-street parking have not been inventoried. These are not observed population, employment, or parking counts. All building attributes remain marked estimated.",
    },
  ],
  coverage: [
    {
      layer: "Building footprints",
      status: "available",
      description: `${buildings.filter((b) => b.use !== "park").length} real OSM footprints in the reference extent. Source completeness varies.`,
    },
    {
      layer: "Street network",
      status: "available",
      description: `${roads.length} real OSM street/path segments. Missing lane and speed attributes use labeled defaults.`,
    },
    {
      layer: "Building heights & use",
      status: "estimated",
      description:
        "Mapped tags where available, otherwise inferred defaults. Review the assumptions before using results.",
    },
    {
      layer: "Parcels & zoning",
      status: "unavailable",
      description:
        "No authoritative parcel boundaries or zoning rules are included in this reference bundle.",
    },
    {
      layer: "Traffic counts",
      status: "unavailable",
      description:
        "Vehicle animation is illustrative. No calibrated count or intersection LOS dataset is loaded.",
    },
    {
      layer: "Population & employment",
      status: "estimated",
      description:
        "Scenario density estimates only. ACS/LODES have not yet been joined to this reference bundle.",
    },
    {
      layer: "Hazards & transit",
      status: "unavailable",
      description:
        "Flood maps and scheduled GTFS transit are not included in this reference bundle.",
    },
  ],
  loadedAt: new Date().toISOString(),
  extentLabel: "Roosevelt Row & downtown reference area · near 85004",
};
await mkdir("public/data", { recursive: true });
const bundle = JSON.stringify(place);
const rawSource = JSON.stringify({
  retrievedAt,
  endpoint,
  query,
  osm3s: data.osm3s,
  elements: data.elements,
});
try {
  await archivePlace(
    JSON.parse(await readFile("public/data/phoenix.json", "utf8")) as Place,
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const snapshot = await archivePlace(place);
await writeFile("public/data/phoenix.json", bundle);
await writeFile("public/data/phoenix-source.json", rawSource);
await writeFile(
  "public/data/manifest.json",
  JSON.stringify(
    {
      schemaVersion: 1,
      datasets: [
        {
          id: place.id,
          file: "/data/phoenix.json",
          snapshotFile: snapshot.file,
          baselineIdentity: snapshot.identity,
          sourceFile: "/data/phoenix-source.json",
          sha256: createHash("sha256").update(bundle).digest("hex"),
          sourceSha256: createHash("sha256").update(rawSource).digest("hex"),
          vintage: date,
          preparedAt: place.loadedAt,
          retrievedAt,
          bounds,
          extentLabel: place.extentLabel,
          attribution: "© OpenStreetMap contributors",
          license: "ODbL 1.0",
        },
      ],
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    output: "public/data/phoenix.json",
    buildings: buildings.length,
    roads: roads.length,
    vintage: date,
  }),
);
