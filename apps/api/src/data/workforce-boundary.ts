import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Polygon, MultiPolygon } from "geojson";
import { z } from "zod";

export const WORKFORCE_BOUNDARY_SERVICE =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2024/MapServer";
export const WORKFORCE_BOUNDARY_LIMITS = {
  sourceBytes: 32 * 1024 * 1024,
  vertices: 500_000,
  counties: 500,
} as const;
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const ring = z
  .array(position)
  .min(4)
  .max(WORKFORCE_BOUNDARY_LIMITS.vertices)
  .refine(
    (points) =>
      points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1],
    "Boundary rings must be closed.",
  );
const polygon = z.array(ring).min(1).max(10_000);
const geometrySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("Polygon"), coordinates: polygon }).strict(),
    z
      .object({
        type: z.literal("MultiPolygon"),
        coordinates: z.array(polygon).min(1).max(10_000),
      })
      .strict(),
  ])
  .refine((geometry) => {
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    return (
      polygons.reduce(
        (sum, rings) =>
          sum + rings.reduce((total, points) => total + points.length, 0),
        0,
      ) <= WORKFORCE_BOUNDARY_LIMITS.vertices
    );
  }, "Boundary exceeds the supported vertex count; it must not be silently simplified.");
export type WorkforceBoundarySourceKind =
  | "state-geometry"
  | "county-inventory"
  | "county-count"
  | "state-metadata"
  | "county-metadata";
export interface WorkforceBoundarySource {
  kind: WorkforceBoundarySourceKind;
  url: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
}
export interface WorkforceRegionBoundary {
  version: 1;
  stateFips: string;
  vintage: 2024;
  countyGeoids: string[];
  geometry: Polygon | MultiPolygon;
  sources: WorkforceBoundarySource[];
  notes: string[];
}
export function workforceBoundaryUrls(
  stateFips: string,
): Record<WorkforceBoundarySourceKind, string> {
  if (!/^\d{2}$/.test(stateFips))
    throw new Error("A two-digit state FIPS code is required.");
  const query = (layer: number, parameters: Record<string, string>) =>
    `${WORKFORCE_BOUNDARY_SERVICE}/${layer}/query?${new URLSearchParams(parameters)}`;
  return {
    "state-metadata": `${WORKFORCE_BOUNDARY_SERVICE}/80?f=json`,
    "county-metadata": `${WORKFORCE_BOUNDARY_SERVICE}/82?f=json`,
    "state-geometry": query(80, {
      f: "geojson",
      where: `STATE='${stateFips}'`,
      outFields: "STATE,GEOID,NAME",
      returnGeometry: "true",
      outSR: "4326",
    }),
    "county-inventory": query(82, {
      f: "json",
      where: `STATE='${stateFips}'`,
      outFields: "STATE,GEOID",
      returnGeometry: "false",
      orderByFields: "GEOID",
    }),
    "county-count": query(82, {
      f: "json",
      where: `STATE='${stateFips}'`,
      returnCountOnly: "true",
    }),
  };
}
const sourceSchema = z
  .object({
    kind: z.enum([
      "state-geometry",
      "county-inventory",
      "county-count",
      "state-metadata",
      "county-metadata",
    ]),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .positive()
      .max(WORKFORCE_BOUNDARY_LIMITS.sourceBytes),
    retrievedAt: z.string().datetime(),
  })
  .strict();
export const workforceRegionBoundarySchema = z
  .object({
    version: z.literal(1),
    stateFips: z.string().regex(/^\d{2}$/),
    vintage: z.literal(2024),
    countyGeoids: z
      .array(z.string().regex(/^\d{5}$/))
      .min(1)
      .max(WORKFORCE_BOUNDARY_LIMITS.counties),
    geometry: geometrySchema,
    sources: z.array(sourceSchema).length(5),
    notes: z.array(z.string().max(4000)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.countyGeoids).size !== value.countyGeoids.length ||
      value.countyGeoids.some(
        (id, i) =>
          !id.startsWith(value.stateFips) ||
          (i > 0 && id <= value.countyGeoids[i - 1]),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Boundary county IDs must be unique, sorted and within the source state.",
      });
    const urls = workforceBoundaryUrls(value.stateFips);
    if (
      new Set(value.sources.map((source) => source.kind)).size !== 5 ||
      value.sources.some((source) => urls[source.kind] !== source.url)
    )
      context.addIssue({
        code: "custom",
        message:
          "Boundary sources must identify the five exact same-vintage Census queries.",
      });
  });
export function assertWorkforceRegionBoundary(
  value: unknown,
): asserts value is WorkforceRegionBoundary {
  workforceRegionBoundarySchema.parse(value);
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Census boundary response is not an object.");
  const result = value as Record<string, any>;
  if (result.error || result.exceededTransferLimit)
    throw new Error(
      "Census boundary query failed or returned an incomplete result.",
    );
  return result;
}
export function prepareWorkforceRegionBoundary(
  stateFips: string,
  responses: Record<
    WorkforceBoundarySourceKind,
    { body: Buffer; source: WorkforceBoundarySource }
  >,
): WorkforceRegionBoundary {
  const urls = workforceBoundaryUrls(stateFips);
  const values = {} as Record<WorkforceBoundarySourceKind, Record<string, any>>;
  for (const kind of Object.keys(urls) as WorkforceBoundarySourceKind[]) {
    const response = responses[kind];
    if (
      !response ||
      response.source.kind !== kind ||
      response.source.url !== urls[kind] ||
      response.body.length !== response.source.bytes ||
      hash(response.body) !== response.source.sha256
    )
      throw new Error(
        "Boundary source digest or query identity does not match its raw evidence.",
      );
    values[kind] = object(JSON.parse(response.body.toString("utf8")));
  }
  for (const [kind, id, name] of [
    ["state-metadata", 80, "States"],
    ["county-metadata", 82, "Counties"],
  ] as const) {
    const metadata = values[kind];
    if (
      metadata.id !== id ||
      metadata.name !== name ||
      !String(metadata.description).includes("January 1, 2024") ||
      metadata.geometryType !== "esriGeometryPolygon"
    )
      throw new Error(
        "Census layer metadata does not establish the requested 2024 boundary vintage.",
      );
  }
  const state = values["state-geometry"];
  if (
    state.type !== "FeatureCollection" ||
    !Array.isArray(state.features) ||
    state.features.length !== 1 ||
    state.features[0].type !== "Feature" ||
    state.features[0].properties?.STATE !== stateFips ||
    state.features[0].properties?.GEOID !== stateFips
  )
    throw new Error(
      "Census did not return exactly the requested state boundary.",
    );
  if (
    state.crs &&
    ![
      "urn:ogc:def:crs:OGC:1.3:CRS84",
      "urn:ogc:def:crs:EPSG::4326",
      "EPSG:4326",
    ].includes(state.crs.properties?.name)
  )
    throw new Error(
      "Boundary source coordinates are not the requested WGS84 longitude/latitude.",
    );
  const counties = values["county-inventory"];
  const count = values["county-count"].count;
  if (
    !Array.isArray(counties.features) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > WORKFORCE_BOUNDARY_LIMITS.counties ||
    counties.features.length !== count
  )
    throw new Error(
      "Census county inventory does not match its independent count; no partial boundary artifact was prepared.",
    );
  const countyGeoids = counties.features
    .map((feature: any) => {
      if (
        feature.attributes?.STATE !== stateFips ||
        typeof feature.attributes?.GEOID !== "string"
      )
        throw new Error("County inventory contains unexpected geography.");
      return feature.attributes.GEOID as string;
    })
    .sort();
  const result: WorkforceRegionBoundary = {
    version: 1,
    stateFips,
    vintage: 2024,
    countyGeoids,
    geometry: state.features[0].geometry,
    sources: (Object.keys(urls) as WorkforceBoundarySourceKind[])
      .sort()
      .map((kind) => sourceSchema.parse(responses[kind].source)),
    notes: [
      "Exact Polygon/MultiPolygon coordinates returned by Census TIGERweb ACS2024 in WGS84, with all parts and holes retained. No geometry precision, quantization, offset or simplification parameter was requested; no client geometry simplification was applied.",
      "State and county layer metadata identify January 1, 2024 geography. The county inventory is checked against a separate same-filter source count.",
      "This artifact establishes the geographic boundary and complete county inventory only. Cohort completeness requires a matching complete ACS/block pack; routing coverage must be verified independently against its graph coverage.",
    ],
  };
  assertWorkforceRegionBoundary(result);
  return result;
}

async function sourceResponse(
  url: string,
  kind: WorkforceBoundarySourceKind,
  directory: string,
  fetcher: typeof fetch,
) {
  await mkdir(directory, { recursive: true });
  const pointer = resolve(directory, `${hash(url)}.source.json`);
  try {
    const source = sourceSchema.parse(
      JSON.parse(await readFile(pointer, "utf8")),
    );
    if (source.url !== url || source.kind !== kind)
      throw new Error("Cached boundary source identity is inconsistent.");
    const body = await readFile(resolve(directory, `${source.sha256}.json`));
    if (body.length !== source.bytes || hash(body) !== source.sha256)
      throw new Error("Cached boundary source integrity check failed.");
    return { body, source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(90_000),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error(`Census boundary download failed (${response.status}).`);
  const limit = WORKFORCE_BOUNDARY_LIMITS.sourceBytes;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new Error("Census boundary source exceeds its byte limit.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("Census boundary source exceeds its byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  if (!bytes) throw new Error("Census boundary source is empty.");
  // Parse before storing so an HTTP 200 service error never becomes an immutable usable source.
  object(JSON.parse(body.toString("utf8")));
  const source: WorkforceBoundarySource = {
    kind,
    url,
    bytes,
    sha256: hash(body),
    retrievedAt: new Date().toISOString(),
  };
  await immutableWrite(resolve(directory, `${source.sha256}.json`), body);
  await immutableWrite(pointer, Buffer.from(JSON.stringify(source)));
  return { body, source };
}
async function immutableWrite(filename: string, bytes: Buffer) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    try {
      await link(temporary, filename);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await readFile(filename)).equals(bytes)
      )
        throw error;
    }
  } finally {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
export async function downloadWorkforceRegionBoundary(
  stateFips: string,
  directory: string,
  fetcher: typeof fetch = fetch,
) {
  const urls = workforceBoundaryUrls(stateFips);
  const responses = {} as Parameters<typeof prepareWorkforceRegionBoundary>[1];
  // Sequential bounded public requests; raw source bodies are retained with content hashes.
  for (const kind of Object.keys(urls) as WorkforceBoundarySourceKind[])
    responses[kind] = await sourceResponse(
      urls[kind],
      kind,
      resolve(directory, "sources"),
      fetcher,
    );
  const boundary = prepareWorkforceRegionBoundary(stateFips, responses);
  const bytes = Buffer.from(JSON.stringify(boundary));
  const digest = hash(bytes);
  const filename = resolve(directory, `boundary-${stateFips}-${digest}.json`);
  await mkdir(directory, { recursive: true });
  await immutableWrite(filename, bytes);
  return { boundary, filename, sha256: digest, bytes: bytes.length };
}

/** Cached-only admission: a correctly rehashed derived JSON still must reproduce from its retained raw sources. */
export async function verifyPreparedWorkforceBoundary(
  filename: string,
): Promise<WorkforceRegionBoundary> {
  async function boundedRead(path: string, expectedBytes?: number) {
    const details = await stat(path);
    if (
      !details.isFile() ||
      details.size < 1 ||
      details.size > WORKFORCE_BOUNDARY_LIMITS.sourceBytes ||
      (expectedBytes !== undefined && details.size !== expectedBytes)
    )
      throw new Error(
        "Retained Census boundary evidence has an invalid or excessive file size.",
      );
    const bytes = await readFile(path);
    if (
      bytes.length !== details.size ||
      bytes.length > WORKFORCE_BOUNDARY_LIMITS.sourceBytes
    )
      throw new Error(
        "Retained Census boundary evidence changed while being read.",
      );
    return bytes;
  }
  const path = resolve(filename);
  const bytes = await boundedRead(path);
  const parsed = JSON.parse(bytes.toString("utf8"));
  assertWorkforceRegionBoundary(parsed);
  if (basename(path) !== `boundary-${parsed.stateFips}-${hash(bytes)}.json`)
    throw new Error(
      "Prepared Census boundary content does not match its immutable filename.",
    );
  const responses = {} as Parameters<typeof prepareWorkforceRegionBoundary>[1];
  for (const source of parsed.sources) {
    // source.sha256 has already passed the strict hexadecimal schema; no source URL is requested.
    const body = await boundedRead(
      resolve(dirname(path), "sources", `${source.sha256}.json`),
      source.bytes,
    );
    responses[source.kind] = { body, source };
  }
  const replayed = prepareWorkforceRegionBoundary(parsed.stateFips, responses);
  if (!Buffer.from(JSON.stringify(replayed)).equals(bytes))
    throw new Error(
      "Prepared Census boundary geometry or inventory differs from its retained official sources.",
    );
  return replayed;
}
