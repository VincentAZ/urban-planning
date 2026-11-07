import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { feature, featureCollection, intersect } from "@turf/turf";
import { z } from "zod";
import { normalizeFloodInWorker } from "../flood-normalization-worker";
import {
  canonicalJSON,
  classifyFloodZone,
  floodDatasetHash,
  floodDatasetSchema,
  floodGeometrySchema,
  floodStudyAreaHash,
  studyAreaGeometry,
  studyAreaBounds,
  isValidStudyArea,
  validateFloodDataset,
  type FloodDataset,
  type FloodFeature,
  type FloodAttributes,
  type FloodSourceFile,
  type Place,
  type StudyAreaGeometry,
} from "@urban/core";

export const FLOOD_SERVICE =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer";
export const FLOOD_PREPARATION_VERSION = "fema-nfhl-clipped-1.0.0";
export const FLOOD_SOURCE_ID = "fema-effective-nfhl";
export const FLOOD_PREPARATION_LIMITS = {
  responseBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  files: 256,
  rawVertices: 200_000,
  features: 5_000,
  batch: 100,
  requestMs: 30_000,
  totalMs: 600_000,
} as const;
export const FLOOD_LAYERS = [
  { id: 0, name: "NFHL Availability", field: "availability" },
  { id: 1, name: "LOMRs", field: "revisions" },
  { id: 3, name: "FIRM Panels", field: "panels" },
  { id: 28, name: "Flood Hazard Zones", field: "zones" },
  { id: 29, name: "Seclusion Boundaries", field: "seclusions" },
] as const;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hashJSON = (value: unknown) => digest(canonicalJSON(value));
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z
  .object({
    role: z.enum([
      "metadata",
      "before-ids",
      "after-ids",
      "before-records",
      "after-records",
      "before-study",
      "after-study",
    ]),
    layerId: z.number().int(),
    batch: z.number().int().nonnegative(),
    url: z.string().url(),
    sha256: sha,
    bytes: z
      .number()
      .int()
      .positive()
      .max(FLOOD_PREPARATION_LIMITS.responseBytes),
    retrievedAt: z.string().datetime(),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
export interface FloodPreparationManifest {
  version: 1;
  methodVersion: typeof FLOOD_PREPARATION_VERSION;
  studyArea: StudyAreaGeometry;
  capturedAt: string;
  datasetHash: string;
  packSha256: string;
  packBytes: number;
  receipts: Receipt[];
}
export type FloodResponse = { receipt: Receipt; body: Buffer };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid FEMA response object.");
  const result = value as Record<string, any>;
  if (result.error || result.exceededTransferLimit)
    throw new Error(
      "FEMA returned an error or truncated response; no partial dataset is accepted.",
    );
  return result;
}
function parsed(response: FloodResponse) {
  if (
    response.body.length !== response.receipt.bytes ||
    digest(response.body) !== response.receipt.sha256
  )
    throw new Error("FEMA raw response digest mismatch.");
  return object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)),
  );
}
function ids(response: FloodResponse): number[] {
  const d = parsed(response);
  if (!Object.hasOwn(d, "objectIds"))
    throw new Error("FEMA omitted its object ID inventory.");
  const values = z
    .array(z.number().int().nonnegative())
    .max(FLOOD_PREPARATION_LIMITS.features)
    .parse(d.objectIds ?? []);
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate FEMA object IDs.");
  return values.sort((a, b) => a - b);
}
function attributes(value: unknown): FloodAttributes {
  return z
    .record(
      z.string().max(100),
      z.union([z.string().max(20_000), z.number().finite(), z.null()]),
    )
    .parse(value);
}
function vertexCount(geometry: StudyAreaGeometry): number {
  return (
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates
  ).reduce((s, p) => s + p.reduce((n, r) => n + r.length, 0), 0);
}
function structuralGeometry(g: StudyAreaGeometry) {
  try {
    const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    return (
      polygons.length > 0 &&
      polygons.length <= 10000 &&
      polygons.every(
        (p) =>
          p.length > 0 &&
          p.length <= 10000 &&
          p.every(
            (r) =>
              r.length >= 4 &&
              r.every(
                (v) =>
                  v.length === 2 &&
                  Number.isFinite(v[0]) &&
                  Number.isFinite(v[1]) &&
                  Math.abs(v[0]) <= 180 &&
                  Math.abs(v[1]) <= 90,
              ) &&
              r[0][0] === r.at(-1)![0] &&
              r[0][1] === r.at(-1)![1],
          ),
      )
    );
  } catch {
    return false;
  }
}
function records(
  responses: FloodResponse[],
  geometry = true,
): { id: number; properties: FloodAttributes; geometry?: StudyAreaGeometry }[] {
  const result: {
    id: number;
    properties: FloodAttributes;
    geometry?: StudyAreaGeometry;
  }[] = [];
  let vertices = 0;
  for (const response of responses) {
    const d = parsed(response);
    if (!Array.isArray(d.features))
      throw new Error("FEMA omitted feature records.");
    if (geometry && d.type !== "FeatureCollection")
      throw new Error("Expected FEMA GeoJSON with explicit WGS84 output.");
    for (const f of d.features) {
      const props = attributes(geometry ? f.properties : f.attributes);
      const id = z.number().int().nonnegative().parse(props.OBJECTID);
      if (geometry) {
        if (
          !f.geometry ||
          !["Polygon", "MultiPolygon"].includes(f.geometry.type)
        )
          throw new Error("FEMA polygon geometry is missing or unsupported.");
        const g = f.geometry as StudyAreaGeometry;
        vertices += vertexCount(g);
        if (
          vertices > FLOOD_PREPARATION_LIMITS.rawVertices ||
          !structuralGeometry(g)
        )
          throw new Error(
            "FEMA source geometry is invalid or exceeds the raw vertex limit; no repair or simplification was applied.",
          );
        result.push({ id, properties: props, geometry: g });
      } else result.push({ id, properties: props });
    }
  }
  if (
    result.length > FLOOD_PREPARATION_LIMITS.features ||
    new Set(result.map((f) => f.id)).size !== result.length
  )
    throw new Error(
      "FEMA feature inventory exceeds limits or contains duplicates.",
    );
  return result.sort((a, b) => a.id - b.id);
}
export function floodQuery(
  layer: number,
  params: Record<string, string>,
): string {
  return `${FLOOD_SERVICE}/${layer}/query?${new URLSearchParams(params)}`;
}
function envelope(area: StudyAreaGeometry) {
  return studyAreaBounds(area).join(",");
}
function idsUrl(layer: number, area: StudyAreaGeometry) {
  return floodQuery(layer, {
    f: "pjson",
    geometry: envelope(area),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnIdsOnly: "true",
  });
}
function recordsUrl(layer: number, values: number[]) {
  return floodQuery(layer, {
    f: "geojson",
    objectIds: values.join(","),
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
  });
}
function studyUrl(values: string[]) {
  if (values.some((v) => !/^[A-Z0-9]{6}$/.test(v)))
    throw new Error("Invalid FEMA study identifier.");
  return floodQuery(41, {
    f: "pjson",
    where: values.length
      ? `DFIRM_ID IN (${values.map((v) => `'${v}'`).join(",")})`
      : "1=0",
    outFields: "*",
    returnGeometry: "false",
  });
}
function select(
  responses: FloodResponse[],
  role: Receipt["role"],
  layerId: number,
) {
  return responses
    .filter((r) => r.receipt.role === role && r.receipt.layerId === layerId)
    .sort((a, b) => a.receipt.batch - b.receipt.batch);
}
function one(responses: FloodResponse[], role: Receipt["role"], layer: number) {
  const rows = select(responses, role, layer);
  if (rows.length !== 1 || rows[0].receipt.batch !== 0)
    throw new Error(
      "FEMA capture is missing or duplicates a required receipt.",
    );
  return rows[0];
}
function checkUrl(response: FloodResponse, expected: string) {
  if (response.receipt.url !== expected)
    throw new Error(
      "FEMA raw receipt query does not match the declared capture.",
    );
}
/** Rebuilds the complete normalized dataset from retained official response bytes. */
export async function deriveFloodDataset(
  area: StudyAreaGeometry,
  capturedAt: string,
  responses: FloodResponse[],
): Promise<FloodDataset> {
  if (!isValidStudyArea(area)) throw new Error("Invalid exact study boundary.");
  if (
    responses.length > FLOOD_PREPARATION_LIMITS.files ||
    responses.reduce((s, r) => s + r.body.length, 0) >
      FLOOD_PREPARATION_LIMITS.totalBytes
  )
    throw new Error("FEMA capture exceeds its bounded raw inventory.");
  const seen = new Set<string>();
  for (const r of responses) {
    receiptSchema.parse(r.receipt);
    parsed(r);
    const key = `${r.receipt.role}/${r.receipt.layerId}/${r.receipt.batch}`;
    if (seen.has(key)) throw new Error("Duplicate FEMA receipt identity.");
    seen.add(key);
  }
  const output = {
    zones: [],
    availability: [],
    panels: [],
    revisions: [],
    seclusions: [],
  } as Pick<
    FloodDataset,
    "zones" | "availability" | "panels" | "revisions" | "seclusions"
  >;
  const receipts: FloodDataset["capture"]["layerReceipts"] = [],
    studies = new Set<string>();
  const used = new Set<FloodResponse>();
  let totalRawVertices = 0,
    totalRawFeatures = 0;
  for (const layer of FLOOD_LAYERS) {
    const metadata = one(responses, "metadata", layer.id);
    used.add(metadata);
    checkUrl(metadata, `${FLOOD_SERVICE}/${layer.id}?f=pjson`);
    const m = parsed(metadata);
    if (
      m.id !== layer.id ||
      m.name !== layer.name ||
      m.geometryType !== "esriGeometryPolygon" ||
      !String(m.supportedQueryFormats).toLowerCase().includes("geojson")
    )
      throw new Error(
        "FEMA layer metadata changed or does not support lossless polygon queries.",
      );
    const before = one(responses, "before-ids", layer.id),
      after = one(responses, "after-ids", layer.id);
    for (const r of [before, after]) {
      used.add(r);
      checkUrl(r, idsUrl(layer.id, area));
    }
    const inventory = ids(before);
    if (canonicalJSON(inventory) !== canonicalJSON(ids(after)))
      throw new Error(
        "FEMA changed its feature inventory during capture; start a new capture.",
      );
    const phases = ["before-records", "after-records"] as const;
    const phaseRows = phases.map((role) => {
      const batches = select(responses, role, layer.id),
        expected = Math.ceil(inventory.length / FLOOD_PREPARATION_LIMITS.batch);
      if (batches.length !== expected)
        throw new Error("FEMA capture does not contain every expected batch.");
      batches.forEach((r, i) => {
        used.add(r);
        if (r.receipt.batch !== i)
          throw new Error("Nonconsecutive FEMA batch.");
        checkUrl(
          r,
          recordsUrl(
            layer.id,
            inventory.slice(
              i * FLOOD_PREPARATION_LIMITS.batch,
              (i + 1) * FLOOD_PREPARATION_LIMITS.batch,
            ),
          ),
        );
      });
      const rows = records(batches);
      if (canonicalJSON(rows.map((r) => r.id)) !== canonicalJSON(inventory))
        throw new Error("FEMA returned missing or unexpected feature IDs.");
      return rows;
    });
    if (canonicalJSON(phaseRows[0]) !== canonicalJSON(phaseRows[1]))
      throw new Error(
        "FEMA changed feature geometry or attributes during capture; start a new capture.",
      );
    totalRawFeatures += phaseRows[0].length;
    totalRawVertices += phaseRows[0].reduce(
      (n, r) => n + vertexCount(r.geometry!),
      0,
    );
    if (
      totalRawFeatures > FLOOD_PREPARATION_LIMITS.features ||
      totalRawVertices > FLOOD_PREPARATION_LIMITS.rawVertices
    )
      throw new Error("FEMA total raw geometry inventory exceeds limits.");
    for (const r of phaseRows[0]) {
      const study = r.properties.DFIRM_ID ?? r.properties.STUDY_ID;
      if (typeof study === "string") studies.add(study);
      const clipped = intersect(
        featureCollection([feature(area), feature(r.geometry!)]),
      );
      if (!clipped) continue;
      const row: FloodFeature = {
        id: `${layer.id}:${r.id}`,
        geometry: clipped.geometry as StudyAreaGeometry,
        attributes: r.properties,
      };
      if (layer.id === 28) {
        const classification = classifyFloodZone(
          r.properties as FloodDataset["zones"][number]["attributes"],
        );
        output.zones.push({
          ...row,
          attributes:
            r.properties as FloodDataset["zones"][number]["attributes"],
          classification,
        });
      } else (output[layer.field] as FloodFeature[]).push(row);
    }
    receipts.push({
      layerId: layer.id,
      name: layer.name,
      objectIds: inventory,
      beforeIdsHash: hashJSON(inventory),
      afterIdsHash: hashJSON(ids(after)),
      beforeRecordsHash: hashJSON(phaseRows[0]),
      afterRecordsHash: hashJSON(phaseRows[1]),
      fileHashes: responses
        .filter((r) => r.receipt.layerId === layer.id)
        .map((r) => r.receipt.sha256),
    });
  }
  const studyMetadata = one(responses, "metadata", 41);
  used.add(studyMetadata);
  checkUrl(studyMetadata, `${FLOOD_SERVICE}/41?f=pjson`);
  if (parsed(studyMetadata).name !== "Study_Info")
    throw new Error("FEMA study metadata changed.");
  const studyResponses = [
    one(responses, "before-study", 41),
    one(responses, "after-study", 41),
  ];
  for (const r of studyResponses) {
    used.add(r);
    checkUrl(r, studyUrl([...studies].sort()));
  }
  const info = studyResponses.map((r) => records([r], false));
  if (
    canonicalJSON(info[0]) !== canonicalJSON(info[1]) ||
    [...studies].some(
      (id) => !info[0].some((r) => r.properties.DFIRM_ID === id),
    )
  )
    throw new Error(
      "FEMA study revision changed or is missing; no complete capture was produced.",
    );
  receipts.push({
    layerId: 41,
    name: "Study_Info",
    objectIds: info[0].map((r) => r.id),
    beforeIdsHash: hashJSON(info[0].map((r) => r.id)),
    afterIdsHash: hashJSON(info[1].map((r) => r.id)),
    beforeRecordsHash: hashJSON(info[0]),
    afterRecordsHash: hashJSON(info[1]),
    fileHashes: [studyMetadata, ...studyResponses].map((r) => r.receipt.sha256),
  });
  if (used.size !== responses.length)
    throw new Error("Unexpected FEMA capture receipts.");
  const files: FloodSourceFile[] = responses.map((r) => ({
    sourceId: FLOOD_SOURCE_ID,
    url: r.receipt.url,
    sha256: r.receipt.sha256,
    bytes: r.receipt.bytes,
    retrievedAt: r.receipt.retrievedAt,
  }));
  const dataset: FloodDataset = {
    version: 1,
    kind: "fema-effective-nfhl",
    studyArea: area,
    studyAreaHash: await floodStudyAreaHash(area),
    capturedAt,
    sources: [
      {
        id: FLOOD_SOURCE_ID,
        name: "FEMA effective National Flood Hazard Layer",
        url: FLOOD_SERVICE,
        vintage: `Captured ${capturedAt}; individual panel, map revision and database dates retained`,
        license:
          "U.S. government public flood-mapping data; source attribution retained",
        kind: "published-estimate",
        description:
          "Effective mapped hazard screening. Not a prediction of flooding, damage, insurance requirements or regulatory determinations.",
      },
    ],
    files,
    capture: {
      serviceUrl: FLOOD_SERVICE,
      queryGeometryHash: hashJSON({
        geometry: envelope(area),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
      }),
      complete: true,
      layerReceipts: receipts,
      studyInfo: info[0].map((r) => r.properties),
      normalization: {
        methodVersion: FLOOD_PREPARATION_VERSION,
        crs: "OGC:CRS84",
        clipped: true,
      },
    },
    ...output,
    notes: [
      "Sequential repeated ID, record and Study_Info comparisons establish observed capture consistency; the NFHL service offers no transactional or historical snapshot guarantee.",
      "Exact official GeoJSON responses requested in WGS84 and clipped to the captured study polygon without simplification or geometry repair. Raw full source polygons remain in the preparation archive.",
      "Availability and panel polygons do not establish that every location has a determinate hazard classification. Gaps, undetermined zones and seclusions remain explicit.",
      "Panel effective dates, LOMR dates, study database revision dates and capture time are separate. A captured version never refreshes an earlier saved result.",
      "NFHL mapped exposure is not flood probability, depth, expected loss, protection, or a legal flood determination. Property-specific letters of map amendment are not applied by this screening model.",
    ],
  };
  validateFloodDataset(dataset);
  return dataset;
}
async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const s = await stat(path);
  if (!s.isFile() || s.size > limit)
    throw new Error("Flood source file exceeds limit.");
  const b = await readFile(path);
  if (b.length > limit || b.length !== s.size)
    throw new Error("Flood source file changed while reading.");
  return b;
}
async function exclusiveWrite(path: string, body: Buffer) {
  const f = await open(path, "wx");
  try {
    await f.writeFile(body);
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function prepareFloodDataset(
  place: Place,
  directory: string,
  fetcher: typeof fetch = fetch,
) {
  const area = studyAreaGeometry(place),
    start = Date.now(),
    responses: FloodResponse[] = [];
  await mkdir(directory, { recursive: false });
  await mkdir(resolve(directory, "raw"));
  let totalBytes = 0;
  const obtain = async (
    role: Receipt["role"],
    layerId: number,
    batch: number,
    url: string,
  ) => {
    if (Date.now() - start > FLOOD_PREPARATION_LIMITS.totalMs)
      throw new Error("FEMA capture deadline exceeded.");
    let body: Buffer | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetcher(url, {
          signal: AbortSignal.timeout(
            Math.min(
              FLOOD_PREPARATION_LIMITS.requestMs,
              FLOOD_PREPARATION_LIMITS.totalMs - (Date.now() - start),
            ),
          ),
          redirect: "error",
          headers: {
            Accept: "application/json",
            "User-Agent": "UrbanPlanning/0.1 bounded official source capture",
          },
        });
        if (!r.ok || !r.body)
          throw new Error(`FEMA download failed (${r.status}).`);
        if (
          Number(r.headers.get("content-length")) >
          FLOOD_PREPARATION_LIMITS.responseBytes
        ) {
          await r.body.cancel();
          throw new Error("FEMA response exceeds byte limit.");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = r.body.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            totalBytes += value.length;
            if (
              size > FLOOD_PREPARATION_LIMITS.responseBytes ||
              totalBytes > FLOOD_PREPARATION_LIMITS.totalBytes
            ) {
              await reader.cancel();
              throw new Error("FEMA capture exceeds byte limits.");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        body = Buffer.concat(chunks);
        object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
        );
        break;
      } catch (e) {
        if (attempt === 2 || totalBytes > FLOOD_PREPARATION_LIMITS.totalBytes)
          throw e;
      }
    }
    const receipt: Receipt = {
      role,
      layerId,
      batch,
      url,
      sha256: digest(body!),
      bytes: body!.length,
      retrievedAt: new Date().toISOString(),
    };
    const item = { receipt, body: body! };
    responses.push(item);
    if (responses.length > FLOOD_PREPARATION_LIMITS.files)
      throw new Error("FEMA receipt limit exceeded.");
    const raw = resolve(directory, "raw", `${receipt.sha256}.json`);
    try {
      await exclusiveWrite(raw, body!);
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(
          await boundedRead(raw, FLOOD_PREPARATION_LIMITS.responseBytes)
        ).equals(body!)
      )
        throw e;
    }
    return item;
  };
  for (const layer of [...FLOOD_LAYERS, { id: 41 }])
    await obtain(
      "metadata",
      layer.id,
      0,
      `${FLOOD_SERVICE}/${layer.id}?f=pjson`,
    );
  const inventories = new Map<number, number[]>();
  for (const layer of FLOOD_LAYERS)
    inventories.set(
      layer.id,
      ids(await obtain("before-ids", layer.id, 0, idsUrl(layer.id, area))),
    );
  const getRecords = async (role: "before-records" | "after-records") => {
    for (const layer of FLOOD_LAYERS) {
      const values = inventories.get(layer.id)!;
      for (let i = 0; i < values.length; i += FLOOD_PREPARATION_LIMITS.batch)
        await obtain(
          role,
          layer.id,
          i / FLOOD_PREPARATION_LIMITS.batch,
          recordsUrl(
            layer.id,
            values.slice(i, i + FLOOD_PREPARATION_LIMITS.batch),
          ),
        );
    }
  };
  await getRecords("before-records");
  const studyIds = [
    ...new Set(
      FLOOD_LAYERS.flatMap((layer) =>
        records(select(responses, "before-records", layer.id)),
      ).flatMap((r) => {
        const id = r.properties.DFIRM_ID ?? r.properties.STUDY_ID;
        return typeof id === "string" ? [id] : [];
      }),
    ),
  ].sort();
  await obtain("before-study", 41, 0, studyUrl(studyIds));
  await getRecords("after-records");
  for (const layer of FLOOD_LAYERS)
    await obtain("after-ids", layer.id, 0, idsUrl(layer.id, area));
  await obtain("after-study", 41, 0, studyUrl(studyIds));
  const capturedAt = new Date().toISOString();
  // Preserve the fenced capture even when later geometric normalization fails. This is not a validated source pack.
  await exclusiveWrite(
    resolve(directory, "capture.json"),
    Buffer.from(
      canonicalJSON({
        version: 1,
        methodVersion: FLOOD_PREPARATION_VERSION,
        studyArea: area,
        capturedAt,
        receipts: responses.map((r) => r.receipt),
      }),
    ),
  );
  const dataset = await normalizeFloodInWorker(area, capturedAt, responses),
    pack = Buffer.from(canonicalJSON(dataset));
  const manifest: FloodPreparationManifest = {
    version: 1,
    methodVersion: FLOOD_PREPARATION_VERSION,
    studyArea: area,
    capturedAt,
    datasetHash: await floodDatasetHash(dataset),
    packSha256: digest(pack),
    packBytes: pack.length,
    receipts: responses.map((r) => r.receipt),
  };
  await exclusiveWrite(resolve(directory, "pack.json"), pack);
  await exclusiveWrite(
    resolve(directory, "manifest.json"),
    Buffer.from(canonicalJSON(manifest)),
  );
  return {
    directory,
    datasetHash: manifest.datasetHash,
    packSha256: manifest.packSha256,
    packBytes: pack.length,
    rawBytes: totalBytes,
    sourceFiles: responses.length,
    seconds: (Date.now() - start) / 1000,
  };
}
export async function loadPreparedFloodDataset(directory: string) {
  const manifestBytes = await boundedRead(
    resolve(directory, "manifest.json"),
    2 * 1024 * 1024,
  );
  const m = object(
    JSON.parse(manifestBytes.toString("utf8")),
  ) as unknown as FloodPreparationManifest;
  if (
    m.version !== 1 ||
    m.methodVersion !== FLOOD_PREPARATION_VERSION ||
    !floodGeometrySchema.safeParse(m.studyArea).success ||
    !Array.isArray(m.receipts) ||
    m.receipts.length > FLOOD_PREPARATION_LIMITS.files
  )
    throw new Error("Unsupported flood preparation manifest.");
  const pack = await boundedRead(
    resolve(directory, "pack.json"),
    8 * 1024 * 1024,
  );
  if (digest(pack) !== m.packSha256 || pack.length !== m.packBytes)
    throw new Error("Flood pack raw digest mismatch.");
  let total = 0;
  const responses: FloodResponse[] = [];
  for (const raw of m.receipts) {
    const receipt = receiptSchema.parse(raw);
    total += receipt.bytes;
    if (total > FLOOD_PREPARATION_LIMITS.totalBytes)
      throw new Error("Flood raw archive exceeds limit.");
    const body = await boundedRead(
      resolve(directory, "raw", `${receipt.sha256}.json`),
      FLOOD_PREPARATION_LIMITS.responseBytes,
    );
    responses.push({ receipt, body });
  }
  const rebuilt = await normalizeFloodInWorker(
      m.studyArea,
      m.capturedAt,
      responses,
    ),
    dataset = JSON.parse(pack.toString("utf8")) as FloodDataset;
  if (
    canonicalJSON(rebuilt) !== canonicalJSON(dataset) ||
    (await floodDatasetHash(dataset)) !== m.datasetHash
  )
    throw new Error(
      "Flood pack does not reproduce from exact retained official source bytes.",
    );
  return {
    dataset,
    datasetHash: m.datasetHash,
    sourceManifestHash: digest(manifestBytes),
    bytes: pack.length,
  };
}
