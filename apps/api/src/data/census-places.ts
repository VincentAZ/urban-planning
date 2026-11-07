import { createHash } from "node:crypto";
import type { Position } from "@urban/core";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import type {
  PlaceCandidate,
  PlaceSearchResponse,
} from "../../../../packages/core/src/national.js";
import { ApiError } from "../errors.js";
import { boundedJson } from "./public-fetch.js";

export const ZCTA_LAYER =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1";
const PLACES =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer";
const GEOCODER =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const ZCTA_NOTE =
  "Census 2020 ZCTAs approximate ZIP delivery areas; not every postal ZIP has a ZCTA. This is not a USPS delivery boundary.";
const states: Record<string, string> = {
  AL: "01",
  AK: "02",
  AZ: "04",
  AR: "05",
  CA: "06",
  CO: "08",
  CT: "09",
  DE: "10",
  DC: "11",
  FL: "12",
  GA: "13",
  HI: "15",
  ID: "16",
  IL: "17",
  IN: "18",
  IA: "19",
  KS: "20",
  KY: "21",
  LA: "22",
  ME: "23",
  MD: "24",
  MA: "25",
  MI: "26",
  MN: "27",
  MS: "28",
  MO: "29",
  MT: "30",
  NE: "31",
  NV: "32",
  NH: "33",
  NJ: "34",
  NM: "35",
  NY: "36",
  NC: "37",
  ND: "38",
  OH: "39",
  OK: "40",
  OR: "41",
  PA: "42",
  RI: "44",
  SC: "45",
  SD: "46",
  TN: "47",
  TX: "48",
  UT: "49",
  VT: "50",
  VA: "51",
  WA: "53",
  WV: "54",
  WI: "55",
  WY: "56",
  AS: "60",
  GU: "66",
  MP: "69",
  PR: "72",
  VI: "78",
};
export type ZctaFeature = Feature<
  Polygon | MultiPolygon,
  Record<string, unknown>
>;
const queryUrl = (base: string, parameters: Record<string, string>) =>
  `${base}/query?${new URLSearchParams(parameters)}`;
function collection(value: unknown) {
  const data = value as {
    features?: {
      properties?: Record<string, unknown>;
      attributes?: Record<string, unknown>;
      geometry?: Polygon | MultiPolygon;
    }[];
    error?: unknown;
    exceededTransferLimit?: boolean;
  };
  if (!data || data.error || !Array.isArray(data.features))
    throw new ApiError(
      502,
      "CENSUS_RESPONSE_INVALID",
      "Census did not return a valid feature collection.",
    );
  if (data.exceededTransferLimit)
    throw new ApiError(
      422,
      "CENSUS_RESULT_TRUNCATED",
      "This Census query exceeded its result limit. Refine the search.",
    );
  return data.features;
}
function position(properties: Record<string, unknown>): Position {
  if (
    properties.INTPTLON == null ||
    properties.INTPTLAT == null ||
    properties.INTPTLON === "" ||
    properties.INTPTLAT === ""
  )
    throw new ApiError(
      502,
      "CENSUS_COORDINATES_INVALID",
      "Census returned missing reference coordinates.",
    );
  const point: Position = [
    Number(properties.INTPTLON),
    Number(properties.INTPTLAT),
  ];
  if (
    !point.every(Number.isFinite) ||
    Math.abs(point[0]) > 180 ||
    Math.abs(point[1]) > 90
  )
    throw new ApiError(
      502,
      "CENSUS_COORDINATES_INVALID",
      "Census returned invalid reference coordinates.",
    );
  return point;
}
function zipCandidate(properties: Record<string, unknown>): PlaceCandidate {
  const zip = String(properties.ZCTA5 ?? properties.GEOID);
  if (!/^\d{5}$/.test(zip))
    throw new ApiError(
      502,
      "CENSUS_ZCTA_INVALID",
      "Census returned an invalid ZIP Code Tabulation Area.",
    );
  return {
    id: `zcta:${zip}`,
    label: `ZIP area ${zip}`,
    kind: "zcta",
    coordinates: position(properties),
    zip,
    placeId: `zcta-${zip}-2020`,
    prepared: false,
    detail: ZCTA_NOTE,
    sourceName: "U.S. Census Bureau — TIGERweb",
  };
}

export class CensusPlaces {
  private cache = new Map<
    string,
    { expires: number; value: unknown; bytes: number }
  >();
  private cacheBytes = 0;
  private pendingRequests = 0;
  private pending: Promise<void> = Promise.resolve();
  private nextRequest = 0;
  constructor(
    private fetcher: typeof fetch = fetch,
    private spacingMs = 1000,
    private limits: {
      cacheBytes?: number;
      pendingRequests?: number;
      queueWaitMs?: number;
    } = {},
  ) {}
  private remember(url: string, value: unknown) {
    const now = Date.now();
    for (const [key, entry] of this.cache)
      if (entry.expires <= now) {
        this.cache.delete(key);
        this.cacheBytes -= entry.bytes;
      }
    const bytes =
      Buffer.byteLength(JSON.stringify(value), "utf8") +
      Buffer.byteLength(url, "utf8");
    const maximum = this.limits.cacheBytes ?? 16_000_000;
    if (bytes > maximum) return;
    while (this.cache.size >= 200 || this.cacheBytes + bytes > maximum) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(url, { expires: now + 3600_000, value, bytes });
    this.cacheBytes += bytes;
  }
  private async request(url: string, signal?: AbortSignal, maxBytes = 250_000) {
    signal?.throwIfAborted();
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now())
      return structuredClone(cached.value);
    if (this.pendingRequests >= (this.limits.pendingRequests ?? 8))
      throw new ApiError(
        503,
        "CENSUS_BUSY",
        "The Census lookup queue is busy. Wait a moment and try again.",
      );
    this.pendingRequests++;
    const waiting = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, waiting.signal])
      : waiting.signal;
    let started = false;
    const deadline = setTimeout(() => {
      if (!started)
        waiting.abort(
          new ApiError(
            503,
            "CENSUS_BUSY",
            "The Census lookup queue took too long. Try again shortly.",
          ),
        );
    }, this.limits.queueWaitMs ?? 15_000);
    deadline.unref();
    let removeAbortListener = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(requestSignal.reason);
      requestSignal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () =>
        requestSignal.removeEventListener("abort", abort);
      if (requestSignal.aborted) abort();
    });
    // One shared application queue, not one request stream per visitor. No keystroke autocomplete.
    const request = this.pending
      .then(async () => {
        requestSignal.throwIfAborted();
        started = true;
        clearTimeout(deadline);
        const refreshed = this.cache.get(url);
        if (refreshed && refreshed.expires > Date.now())
          return structuredClone(refreshed.value);
        const delay = Math.max(0, this.nextRequest - Date.now());
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        requestSignal.throwIfAborted();
        this.nextRequest = Date.now() + this.spacingMs;
        const value = await boundedJson(url, {
          signal: requestSignal,
          fetcher: this.fetcher,
          maxBytes,
        });
        this.remember(url, value);
        return value;
      })
      .finally(() => {
        this.pendingRequests--;
        clearTimeout(deadline);
      });
    this.pending = request.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await Promise.race([request, cancelled]);
    } finally {
      removeAbortListener();
    }
  }
  async zcta(zip: string, signal?: AbortSignal): Promise<ZctaFeature> {
    if (!/^\d{5}$/.test(zip))
      throw new ApiError(400, "INVALID_ZIP", "Enter a five-digit US ZIP code.");
    const data = await this.request(
      queryUrl(ZCTA_LAYER, {
        where: `ZCTA5='${zip}'`,
        outFields: "GEOID,ZCTA5,NAME,AREALAND,AREAWATER,INTPTLAT,INTPTLON",
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson",
      }),
      signal,
      12_000_000,
    );
    const features = collection(data);
    if (features.length !== 1)
      throw new ApiError(
        404,
        "ZCTA_NOT_FOUND",
        "No Census 2020 ZCTA matches this postal ZIP. PO-box and unique ZIP codes may not have an area.",
      );
    const feature = features[0];
    const properties = feature.properties ?? feature.attributes ?? {};
    if (String(properties.ZCTA5 ?? properties.GEOID) !== zip)
      throw new ApiError(
        502,
        "CENSUS_ZCTA_MISMATCH",
        "The returned Census boundary did not match the requested ZCTA.",
      );
    if (
      !feature.geometry ||
      !["Polygon", "MultiPolygon"].includes(feature.geometry.type)
    )
      throw new ApiError(
        502,
        "CENSUS_GEOMETRY_INVALID",
        "Census did not return the complete ZCTA boundary.",
      );
    return { type: "Feature", properties, geometry: feature.geometry };
  }
  async locate(point: Position): Promise<PlaceSearchResponse> {
    const data = await this.request(
      queryUrl(ZCTA_LAYER, {
        geometry: point.join(","),
        geometryType: "esriGeometryPoint",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "GEOID,ZCTA5,INTPTLAT,INTPTLON",
        returnGeometry: "false",
        f: "json",
      }),
    );
    return {
      mode: "point",
      candidates: collection(data).map((f) =>
        zipCandidate(f.attributes ?? f.properties ?? {}),
      ),
      warnings: [ZCTA_NOTE],
      attribution: ["U.S. Census Bureau"],
    };
  }
  async search(query: string): Promise<PlaceSearchResponse> {
    const q = query.trim();
    if (/^\d{5}(?:-\d{4})?$/.test(q)) {
      const zip = q.slice(0, 5);
      // Anonymous lookup needs only a label and reference point. Full geometry is requested by preparation.
      const data = await this.request(
        queryUrl(ZCTA_LAYER, {
          where: `ZCTA5='${zip}'`,
          outFields: "GEOID,ZCTA5,INTPTLAT,INTPTLON",
          returnGeometry: "false",
          f: "json",
        }),
      );
      const candidates = collection(data).map((feature) =>
        zipCandidate(feature.attributes ?? feature.properties ?? {}),
      );
      if (candidates.some((candidate) => candidate.zip !== zip))
        throw new ApiError(
          502,
          "CENSUS_ZCTA_MISMATCH",
          "The returned Census area did not match the requested ZCTA.",
        );
      return {
        mode: "zip",
        candidates,
        warnings: [
          ...(!candidates.length
            ? [
                "No Census 2020 ZCTA matches this postal ZIP. PO-box and unique ZIP codes may not have an area.",
              ]
            : []),
          ZCTA_NOTE,
        ],
        attribution: ["U.S. Census Bureau"],
      };
    }
    if (/^\d+\s/.test(q)) {
      const data = (await this.request(
        `${GEOCODER}?${new URLSearchParams({ address: q, benchmark: "Public_AR_Current", format: "json" })}`,
      )) as {
        result?: {
          addressMatches?: {
            matchedAddress: string;
            coordinates: { x: number; y: number };
          }[];
        };
      };
      if (!Array.isArray(data.result?.addressMatches))
        throw new ApiError(
          502,
          "GEOCODER_UNAVAILABLE",
          "The Census address lookup did not return valid results.",
        );
      return {
        mode: "address",
        candidates: data.result.addressMatches
          .slice(0, 8)
          .map((match) => ({
            id: `census-address:${createHash("sha256").update(match.matchedAddress).digest("hex").slice(0, 16)}`,
            kind: "address",
            label: match.matchedAddress,
            coordinates: [match.coordinates.x, match.coordinates.y],
            prepared: false,
            detail:
              "Approximate Census address-range location. Select to find its containing Census ZIP area.",
            sourceName: "U.S. Census Geocoder",
          })),
        warnings: [
          "Address locations are interpolated along Census address ranges; they do not verify a building or postal address.",
        ],
        attribution: ["U.S. Census Bureau"],
      };
    }
    const parts = q.split(",").map((s) => s.trim());
    const possibleState = parts.at(-1)?.toUpperCase();
    const state = possibleState && states[possibleState];
    const name = (state ? parts.slice(0, -1).join(",") : q).toUpperCase();
    if (name.length < 2 || !/^[\p{L}\p{M}\s.'-]+$/u.test(name))
      throw new ApiError(
        400,
        "CITY_SEARCH_INVALID",
        "Search a city name, optionally followed by a state abbreviation, or enter a complete street address.",
      );
    const where = `UPPER(BASENAME) LIKE '${name.replaceAll("'", "''")}%'${state ? ` AND STATE='${state}'` : ""}`;
    const candidates: PlaceCandidate[] = [];
    for (const layer of [4, 5, 1]) {
      const data = await this.request(
        queryUrl(`${PLACES}/${layer}`, {
          where,
          outFields: "GEOID,NAME,STATE,INTPTLAT,INTPTLON",
          returnGeometry: "false",
          resultRecordCount: "20",
          orderByFields: "NAME",
          f: "json",
        }),
      );
      // A broad city-name query is a candidate list, never an analytical geography. Explicitly limit its display.
      const result = data as {
        features?: { attributes: Record<string, unknown> }[];
        error?: unknown;
      };
      if (result.error || !Array.isArray(result.features))
        throw new ApiError(
          502,
          "CENSUS_RESPONSE_INVALID",
          "Census city search is temporarily unavailable.",
        );
      for (const f of result.features) {
        const p = f.attributes;
        const abbreviation =
          Object.entries(states).find(([, code]) => code === p.STATE)?.[0] ??
          String(p.STATE);
        candidates.push({
          id: `census-place:${p.GEOID}`,
          kind: "city",
          label: `${p.NAME}, ${abbreviation}`,
          coordinates: position(p),
          prepared: false,
          detail: `${layer === 1 ? "Borough or county-subdivision" : "City"} reference point. Select to find its containing Census ZIP area; this does not prepare the entire municipality.`,
          sourceName: "U.S. Census Bureau — TIGERweb",
        });
      }
    }
    return {
      mode: "city",
      candidates: candidates.slice(0, 12),
      warnings: [
        candidates.length >= 12
          ? "Showing the first 12 matches. Add a state abbreviation to narrow the search."
          : "City searches locate a reference point; choose a ZIP area for preparation.",
      ],
      attribution: ["U.S. Census Bureau"],
    };
  }
}
