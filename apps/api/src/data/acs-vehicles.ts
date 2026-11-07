import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  vehicleAvailabilitySchema,
  type Place,
  type VehicleAvailability,
} from "@urban/core";
import { parseCensusValue } from "./acs.js";

export const VEHICLE_SOURCE_URL =
  "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b25046.dat";
export const VEHICLE_DOWNLOAD_LIMIT = 25_000_000;
export const VEHICLE_CACHE_LIMIT = 2_000_000;
export const vehicleCacheSchema = z
  .object({
    schemaVersion: z.literal(1),
    dataset: z.literal("acs/acs5"),
    vintage: z.literal(2024),
    period: z.object({ start: z.literal(2020), end: z.literal(2024) }).strict(),
    retrievedAt: z.string().datetime(),
    sourceFile: z
      .object({
        table: z.literal("B25046"),
        url: z.literal(VEHICLE_SOURCE_URL),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        retrievedAt: z.string().datetime(),
        bytes: z.number().int().min(1).max(VEHICLE_DOWNLOAD_LIMIT),
      })
      .strict(),
    columns: z.tuple([z.literal("B25046_E001"), z.literal("B25046_M001")]),
    rows: z
      .record(
        z.string().regex(/^\d{5}$/),
        z.tuple([
          z.string().max(100).nullable(),
          z.string().max(100).nullable(),
        ]),
      )
      .refine(
        (rows) =>
          Object.keys(rows).length > 0 && Object.keys(rows).length <= 40_000,
        "The vehicle cache must contain a bounded nonempty set of ZCTAs.",
      ),
  })
  .strict();
export type VehicleCache = z.infer<typeof vehicleCacheSchema>;
export class VehicleReferenceError extends Error {
  constructor(
    public code:
      | "VEHICLE_CACHE_MISSING"
      | "VEHICLE_CACHE_INVALID"
      | "VEHICLE_GEOGRAPHY_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "VehicleReferenceError";
  }
}

export function vehicleAvailabilityFromCache(
  cache: VehicleCache,
  zip: string,
  sameStudyArea = false,
): VehicleAvailability {
  if (!/^\d{5}$/.test(zip))
    throw new VehicleReferenceError(
      "VEHICLE_GEOGRAPHY_MISSING",
      "A five-digit Census ZCTA identifier is required.",
    );
  const row = Object.hasOwn(cache.rows, zip) ? cache.rows[zip] : undefined;
  if (!row)
    throw new VehicleReferenceError(
      "VEHICLE_GEOGRAPHY_MISSING",
      "The prepared vehicle table has no record for this ZCTA. Missing data is not a zero vehicle count.",
    );
  return vehicleAvailabilitySchema.parse({
    version: 1,
    dataset: "acs/acs5",
    vintage: 2024,
    period: cache.period,
    geography: {
      kind: "zcta",
      id: zip,
      name: `ZCTA5 ${zip}`,
      boundaryVintage: "2020",
      relationshipToStudyArea: sameStudyArea ? "same-area" : "context-only",
    },
    retrievedAt: cache.retrievedAt,
    confidenceLevel: 90,
    source: {
      id: `census-acs5-2024-vehicles-${zip}-${cache.sourceFile.sha256.slice(0, 12)}`,
      name: "U.S. Census Bureau · 2020–2024 household vehicles available",
      url: "https://api.census.gov/data/2024/acs/acs5/groups/B25046.html",
      vintage: "2020–2024",
      license: "U.S. Census Bureau public data; attribution retained",
      kind: "published-estimate",
      description: `B25046 aggregate vehicles available for occupied housing units in ZCTA ${zip}, with a 90% margin of error. This is a household survey estimate, not traffic volume, trips, a registered fleet, or a vehicle count for a smaller painted area.`,
    },
    measure: {
      label: "Household vehicles available",
      unit: "vehicles",
      universe: "Occupied housing units",
      estimate: parseCensusValue(row[0], null, "estimate"),
      marginOfError: parseCensusValue(row[1], null, "moe"),
      variables: {
        estimate: "B25046_001E",
        marginOfError: "B25046_001M",
        estimateAnnotation: "B25046_001EA",
        marginOfErrorAnnotation: "B25046_001MA",
      },
    },
    sourceFile: cache.sourceFile,
    notes: [
      "Published aggregate B25046 is used directly; capped vehicle categories are not summed to manufacture an exact fleet count. The household questionnaire includes a six-or-more category.",
      "Vehicles available includes eligible cars, vans and light trucks kept at home for household use. Motorcycles, recreational vehicles, immobile vehicles and business-only vehicles are excluded.",
      "The reference is for the whole 2020 ZCTA and the 2020–2024 survey period. It is not a count of vehicles on the road or an official traffic forecast.",
      "Summary-file raw estimates and margins are preserved, including unavailable/suppressed sentinel values. No separate annotations are supplied by this table-based file.",
      "Sampling uncertainty is not automatically propagated into scenario responses. No vehicle-stock-to-trip conversion is implied.",
    ],
  });
}

const loaded = new Map<
  string,
  { mtime: number; size: number; cache: VehicleCache }
>();
export async function readVehicleCache(
  filename = process.env.ACS_VEHICLES_CACHE ??
    resolve("public/data/acs-vehicles-2024.json"),
): Promise<VehicleCache> {
  const path = resolve(filename);
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > VEHICLE_CACHE_LIMIT)
      throw new VehicleReferenceError(
        "VEHICLE_CACHE_INVALID",
        "The prepared household-vehicle cache exceeds its supported size.",
      );
    let item = loaded.get(path);
    if (!item || item.mtime !== details.mtimeMs || item.size !== details.size) {
      let cache: VehicleCache;
      try {
        cache = vehicleCacheSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
      } catch {
        throw new VehicleReferenceError(
          "VEHICLE_CACHE_INVALID",
          "The prepared household-vehicle cache is invalid; no count was substituted.",
        );
      }
      item = { mtime: details.mtimeMs, size: details.size, cache };
      // Server configuration, not request input, supplies paths; bound retained copies anyway.
      if (loaded.size >= 4) loaded.clear();
      loaded.set(path, item);
    }
    return item.cache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new VehicleReferenceError(
        "VEHICLE_CACHE_MISSING",
        "Household vehicle reference data has not been prepared. Enter a sourced local reference or ask the operator to prepare the official supplement.",
      );
    throw error;
  }
}

export function isExactVehicleGeography(place: Place) {
  return (
    place.geography?.type === "zcta" &&
    place.geography.code === place.zip &&
    place.geography.boundaryVintage === "2020"
  );
}
export async function readPlaceVehicleReference(
  place: Place,
  filename?: string,
): Promise<VehicleAvailability> {
  if (!isExactVehicleGeography(place))
    throw new VehicleReferenceError(
      "VEHICLE_GEOGRAPHY_MISSING",
      "This captured study area is not an exact 2020 Census ZCTA. A whole-ZCTA vehicle total cannot be used as its baseline; enter a sourced reference for this area.",
    );
  return vehicleAvailabilityFromCache(
    await readVehicleCache(filename),
    place.zip,
    true,
  );
}

/** Only call while constructing a fresh source snapshot, never when loading saved projects. */
export async function enrichPlaceVehicleAvailability(
  place: Place,
  filename?: string,
): Promise<Place> {
  if (place.vehicleAvailability) return place;
  try {
    const vehicleAvailability = await readPlaceVehicleReference(
      place,
      filename,
    );
    const usable = vehicleAvailability.measure.estimate.status === "available";
    return {
      ...place,
      vehicleAvailability,
      sources: [...place.sources, vehicleAvailability.source],
      coverage: [
        ...place.coverage,
        {
          layer: "Household vehicles available",
          status: usable ? "available" : "unavailable",
          description: usable
            ? "2020–2024 ACS B25046 estimate for the exact ZCTA, with 90% margin of error; not road traffic or registered fleet."
            : "Census did not publish a usable vehicle estimate for this ZCTA. No zero was substituted.",
        },
      ],
    };
  } catch (error) {
    if (!(error instanceof VehicleReferenceError)) throw error;
    return {
      ...place,
      coverage: [
        ...place.coverage,
        {
          layer: "Household vehicles available",
          status: "unavailable",
          description: error.message,
        },
      ],
    };
  }
}

/** Explicit operator preparation; never called by visitor routes or model evaluation. */
export async function downloadVehicleCache(
  fetcher: typeof fetch = fetch,
): Promise<VehicleCache> {
  const response = await fetcher(VEHICLE_SOURCE_URL, {
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error(
      "The official household-vehicle table could not be downloaded.",
    );
  const expected = Number(response.headers.get("content-length") ?? "0");
  if (expected > VEHICLE_DOWNLOAD_LIMIT) {
    await response.body.cancel();
    throw new Error(
      "The household-vehicle table exceeds the 25 MB preparation cap.",
    );
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    digest = createHash("sha256");
  let bytes = 0,
    remainder = "",
    width = 0,
    indices: number[] | undefined;
  const rows: VehicleCache["rows"] = {};
  const line = (value: string) => {
    if (!value.trim()) return;
    const cells = value
      .replace(/^\uFEFF/, "")
      .replace(/\r$/, "")
      .split("|");
    if (!indices) {
      width = cells.length;
      if (cells[0] !== "GEO_ID")
        throw new Error("Unexpected Census vehicle-table header.");
      indices = ["B25046_E001", "B25046_M001"].map((name) =>
        cells.indexOf(name),
      );
      if (indices.some((i) => i < 0))
        throw new Error("Required vehicle-table columns are missing.");
      return;
    }
    if (!cells[0].startsWith("860Z200US")) return;
    const zip = cells[0].slice(9);
    if (
      !/^\d{5}$/.test(zip) ||
      cells.length !== width ||
      Object.hasOwn(rows, zip)
    )
      throw new Error("Invalid or duplicate vehicle-table ZCTA row.");
    rows[zip] = [cells[indices[0]] || null, cells[indices[1]] || null];
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > VEHICLE_DOWNLOAD_LIMIT)
        throw new Error(
          "The household-vehicle table exceeds the 25 MB preparation cap.",
        );
      digest.update(chunk.value);
      remainder += decoder.decode(chunk.value, { stream: true });
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      for (const value of lines) line(value);
      if (remainder.length > 100_000)
        throw new Error("An oversized vehicle-table row was rejected.");
    }
    remainder += decoder.decode();
    if (remainder) line(remainder);
    if (expected && bytes !== expected)
      throw new Error(
        "The official household-vehicle download was incomplete.",
      );
    const retrievedAt = new Date().toISOString();
    return vehicleCacheSchema.parse({
      schemaVersion: 1,
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      retrievedAt,
      sourceFile: {
        table: "B25046",
        url: VEHICLE_SOURCE_URL,
        sha256: digest.digest("hex"),
        retrievedAt,
        bytes,
      },
      columns: ["B25046_E001", "B25046_M001"],
      rows,
    });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
