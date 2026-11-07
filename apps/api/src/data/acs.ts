import {
  communityDemographicsSchema,
  type CensusValue,
  type CommunityDemographics,
  type CommunityMeasure,
  type Place,
} from "@urban/core";

/** Latest published five-year ACS vintage verified in Census release metadata on 2026-11-05. */
export const ACS_VINTAGE = 2024;
export const ACS_DATASET_URL = `https://api.census.gov/data/${ACS_VINTAGE}/acs/acs5/profile`;
export const ACS_DOCUMENTATION_URL =
  "https://www.census.gov/data/developers/data-sets/acs-5year.html";
export const ACS_ANNOTATIONS_URL =
  "https://www.census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html";

type MeasureDefinition = Pick<
  CommunityMeasure,
  "label" | "unit" | "universe"
> & { variable: string };
export const ACS_MEASURES: Record<
  keyof CommunityDemographics["measures"],
  MeasureDefinition
> = {
  population: {
    variable: "DP05_0001E",
    label: "Population",
    unit: "people",
    universe: "Total population",
  },
  households: {
    variable: "DP02_0001E",
    label: "Households",
    unit: "households",
    universe: "Total households",
  },
  housingUnits: {
    variable: "DP04_0001E",
    label: "Housing units",
    unit: "housing units",
    universe: "Total housing units, occupied and vacant",
  },
  medianHouseholdIncome: {
    variable: "DP03_0062E",
    label: "Median household income",
    unit: "USD",
    universe: `Households; ${ACS_VINTAGE} inflation-adjusted dollars`,
  },
  povertyPercent: {
    variable: "DP03_0128PE",
    label: "People below poverty level",
    unit: "percent",
    universe: "People for whom poverty status is determined",
  },
  bachelorsOrHigherPercent: {
    variable: "DP02_0068PE",
    label: "Bachelor’s degree or higher",
    unit: "percent",
    universe: "Population age 25 and over",
  },
};
function variables(estimate: string): CommunityMeasure["variables"] {
  const marginOfError = estimate.replace(/E$/, "M");
  return {
    estimate,
    marginOfError,
    estimateAnnotation: `${estimate}A`,
    marginOfErrorAnnotation: `${marginOfError}A`,
  };
}
export const ACS_VARIABLES = [
  "NAME",
  ...Object.values(ACS_MEASURES).flatMap((measure) =>
    Object.values(variables(measure.variable)),
  ),
];

/** Official Census sentinel interpretation; zero is a real estimate only when published as zero. */
export function parseCensusValue(
  raw: unknown,
  annotation: unknown,
  kind: "estimate" | "moe",
): CensusValue {
  const original =
    raw === null || raw === undefined ? null : String(raw).trim();
  const code =
    original && Number.isFinite(Number(original))
      ? String(Number(original))
      : original;
  const note =
    annotation === null ||
    annotation === undefined ||
    annotation === "" ||
    annotation === "null"
      ? null
      : String(annotation).trim();
  const cell: CensusValue = {
    value: null,
    raw: original,
    annotation: note,
    status: "missing",
  };
  if (code === "-999999999" || note === "N")
    return { ...cell, status: "suppressed" };
  if (code === "-888888888" || note === "(X)")
    return { ...cell, status: "not-applicable" };
  if (
    ["-666666666", "-222222222", "-333333333"].includes(code ?? "") ||
    ["-", "**", "***"].includes(note ?? "")
  )
    return { ...cell, status: "uncomputable" };
  if (code === "-555555555" || note === "*****")
    return kind === "moe" ? { ...cell, status: "controlled", value: 0 } : cell;
  if (note && /^[\d,.$\s]+[+-]$/.test(note))
    return { ...cell, status: "bounded" };
  if (!original || original === "null" || !/^\d+(\.\d+)?$/.test(original))
    return cell;
  const value = Number(original);
  return Number.isFinite(value)
    ? { ...cell, value, status: "available" }
    : cell;
}

export class CensusDataError extends Error {
  constructor(
    public code:
      | "CENSUS_KEY_REQUIRED"
      | "CENSUS_UNAVAILABLE"
      | "CENSUS_INVALID_RESPONSE"
      | "CENSUS_GEOGRAPHY_MISSING"
      | "CENSUS_CACHE_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "CensusDataError";
  }
}
export interface CensusOptions {
  apiKey?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  sameStudyArea?: boolean;
  summaryCachePath?: string;
}

export function parseCommunityProfile(
  payload: unknown,
  zip: string,
  retrievedAt = new Date().toISOString(),
  sameStudyArea = false,
): CommunityDemographics {
  if (!/^\d{5}$/.test(zip))
    throw new RangeError("A five-digit ZCTA identifier is required.");
  if (
    !Array.isArray(payload) ||
    !Array.isArray(payload[0]) ||
    payload.length !== 2 ||
    !Array.isArray(payload[1])
  )
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The Census response did not contain one identified ZCTA record.",
    );
  const [header, row] = payload as unknown[][];
  if (
    header.some((column) => typeof column !== "string") ||
    new Set(header).size !== header.length ||
    row.length !== header.length
  )
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The Census response has an invalid column structure.",
    );
  const record = Object.fromEntries(
    header.map((column, index) => [column as string, row[index]]),
  );
  if (
    record["zip code tabulation area"] !== zip ||
    typeof record.NAME !== "string"
  )
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The Census response does not match the requested ZCTA.",
    );
  if (ACS_VARIABLES.some((variable) => !(variable in record)))
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The Census response omitted required estimates, margins, or annotations.",
    );
  const measures = Object.fromEntries(
    Object.entries(ACS_MEASURES).map(([key, definition]) => {
      const fields = variables(definition.variable);
      const { variable, ...metadata } = definition;
      void variable;
      return [
        key,
        {
          ...metadata,
          variables: fields,
          estimate: parseCensusValue(
            record[fields.estimate],
            record[fields.estimateAnnotation],
            "estimate",
          ),
          marginOfError: parseCensusValue(
            record[fields.marginOfError],
            record[fields.marginOfErrorAnnotation],
            "moe",
          ),
        },
      ];
    }),
  ) as CommunityDemographics["measures"];
  return communityDemographicsSchema.parse({
    dataset: "acs/acs5/profile",
    vintage: ACS_VINTAGE,
    period: { start: ACS_VINTAGE - 4, end: ACS_VINTAGE },
    geography: {
      kind: "zcta",
      id: zip,
      name: record.NAME,
      relationshipToStudyArea: sameStudyArea ? "same-area" : "context-only",
    },
    retrievedAt,
    confidenceLevel: 90,
    source: {
      id: `census-acs5-${ACS_VINTAGE}-zcta-${zip}`,
      name: `U.S. Census Bureau · ${ACS_VINTAGE - 4}–${ACS_VINTAGE} ACS five-year estimates`,
      url: `https://data.census.gov/profile/ZCTA5_${zip}?g=860XX00US${zip}`,
      vintage: `${ACS_VINTAGE - 4}–${ACS_VINTAGE}`,
      license: "U.S. Census Bureau public data; attribution retained",
      kind: "published-estimate",
      description: `Published survey estimates for the whole ZCTA ${zip}; 90% margins of error. Source variables: ${Object.values(
        ACS_MEASURES,
      )
        .map((m) => m.variable)
        .join(", ")}. ${ACS_DATASET_URL}`,
    },
    measures,
    notes: [
      "Five-year survey estimates describe the collection period, not a current-year census count or forecast.",
      "A ZCTA is a Census statistical approximation of a postal ZIP; not every postal ZIP has a ZCTA.",
      "Housing units and population describe the whole ZCTA and are not reconciled to mapped building attributes.",
      "Percentage margins are percentage points; all margins use the Census 90% confidence level.",
      ...(!sameStudyArea
        ? [
            "These figures are wider-area context only. They are not scaled to or substituted for the displayed study area.",
          ]
        : []),
    ],
  });
}

export async function fetchZctaCommunityProfile(
  zip: string,
  options: CensusOptions = {},
): Promise<CommunityDemographics> {
  if (!/^\d{5}$/.test(zip))
    throw new RangeError("A five-digit ZCTA identifier is required.");
  const key = options.apiKey ?? process.env.CENSUS_API_KEY;
  if (!key?.trim())
    throw new CensusDataError(
      "CENSUS_KEY_REQUIRED",
      "Community estimates are unavailable until the operator configures a free Census API key.",
    );
  const url = new URL(ACS_DATASET_URL);
  url.searchParams.set("get", ACS_VARIABLES.join(","));
  url.searchParams.set("for", `zip code tabulation area:${zip}`);
  url.searchParams.set("key", key.trim());
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new CensusDataError(
      "CENSUS_UNAVAILABLE",
      "The Census service could not be reached. Community estimates are unavailable for this preparation.",
    );
  }
  if (response.status === 204)
    throw new CensusDataError(
      "CENSUS_GEOGRAPHY_MISSING",
      "The Census dataset has no record for this ZCTA.",
    );
  if (!response.ok)
    throw new CensusDataError(
      "CENSUS_UNAVAILABLE",
      `The Census service returned HTTP ${response.status}. Community estimates were not substituted.`,
    );
  const body = await response.text();
  if (/missing key|invalid key|invalid_key/i.test(body))
    throw new CensusDataError(
      "CENSUS_KEY_REQUIRED",
      "The Census service rejected the configured API key. Ask the operator to check it.",
    );
  if (body.length > 100_000)
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The Census response exceeded the expected single-geography size.",
    );
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The Census service returned non-JSON content instead of community estimates.",
    );
  }
  try {
    return parseCommunityProfile(
      payload,
      zip,
      new Date().toISOString(),
      options.sameStudyArea,
    );
  } catch (error) {
    if (error instanceof CensusDataError) throw error;
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The Census response did not pass the published-estimate validation rules.",
    );
  }
}

/** Caller may assert sameStudyArea only after preparing the exact authoritative ZCTA boundary. */
export async function enrichPlaceDemographics(
  place: Place,
  signal?: AbortSignal,
  options: Omit<CensusOptions, "signal"> = {},
): Promise<Place> {
  const coverage = place.coverage.filter(
    (item) => item.layer !== "Census community context",
  );
  const sameStudyArea =
    place.geography?.type === "zcta" && place.geography.code === place.zip;
  try {
    let demographics: CommunityDemographics;
    const fromCache = async () =>
      (await import("./acs-summary")).readSummaryCommunityProfile(place.zip, {
        sameStudyArea,
        filename: options.summaryCachePath,
      });
    if ((options.apiKey ?? process.env.CENSUS_API_KEY)?.trim()) {
      try {
        demographics = await fetchZctaCommunityProfile(place.zip, {
          ...options,
          signal,
          sameStudyArea,
        });
      } catch (error) {
        if (signal?.aborted || !(error instanceof CensusDataError)) throw error;
        try {
          demographics = await fromCache();
        } catch {
          throw error;
        }
        demographics.notes.unshift(
          "The Data Profiles API was unavailable during preparation. This snapshot uses the validated official Detailed Tables cache instead; derived percentage margins are marked approximate.",
        );
      }
    } else demographics = await fromCache();
    return {
      ...place,
      demographics,
      sources: [
        ...place.sources.filter(
          (source) => source.id !== demographics.source.id,
        ),
        demographics.source,
      ],
      coverage: [
        ...coverage,
        {
          layer: "Census community context",
          status: "available",
          description: `${demographics.period.start}–${demographics.period.end} ACS five-year estimates for ZCTA ${place.zip}, with 90% margins. ${sameStudyArea ? "Whole study geography." : "Wider-area context only."}`,
        },
      ],
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!(error instanceof CensusDataError)) throw error;
    const { demographics: omitted, ...unchanged } = place;
    void omitted;
    return {
      ...unchanged,
      coverage: [
        ...coverage,
        {
          layer: "Census community context",
          status: "unavailable",
          description: error.message,
        },
      ],
    };
  }
}
