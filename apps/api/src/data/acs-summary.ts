import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  communityDemographicsSchema,
  type CensusValue,
  type CommunityDemographics,
  type CommunityMeasure,
} from "@urban/core";
import {
  ACS_MEASURES,
  ACS_VINTAGE,
  CensusDataError,
  parseCensusValue,
} from "./acs";

export const ACS_SUMMARY_BASE = `https://www2.census.gov/programs-surveys/acs/summary_file/${ACS_VINTAGE}/table-based-SF/data/5YRData/`;
export const ACS_MOE_GUIDANCE =
  "https://www.census.gov/content/dam/Census/library/publications/2020/acs/acs_general_handbook_2020_ch08.pdf";
/** Six selected tables total about 235 MB; never download the 12 GB all-tables archive. */
export const ACS_SUMMARY_TABLES: Record<string, string[]> = {
  B01003: ["001"],
  B11001: ["001"],
  B25001: ["001"],
  B19013: ["001"],
  C17002: ["001", "002", "003"],
  B15003: ["001", "022", "023", "024", "025"],
};
export const ACS_SUMMARY_COLUMNS = Object.entries(ACS_SUMMARY_TABLES).flatMap(
  ([table, cells]) =>
    cells.flatMap((cell) => [`${table}_E${cell}`, `${table}_M${cell}`]),
);
export interface AcsSummaryCache {
  schemaVersion: 1;
  vintage: 2024;
  retrievedAt: string;
  sourceFiles: NonNullable<CommunityDemographics["sourceFiles"]>;
  columns: string[];
  rows: Record<string, (string | null)[]>;
}
const unavailable = (): CensusValue => ({
  value: null,
  raw: null,
  annotation: null,
  status: "missing",
});
const calculated = (value: number): CensusValue => ({
  value,
  raw: null,
  annotation: null,
  status: "available",
});

/** Census handbook ch.8: component-sum MOE, then subset proportion MOE (ratio fallback if radicand < 0). */
export function derivePercentage(
  numerators: { estimate: CensusValue; marginOfError: CensusValue }[],
  denominator: { estimate: CensusValue; marginOfError: CensusValue },
) {
  const total = denominator.estimate.value;
  if (
    total === null ||
    total <= 0 ||
    numerators.some((item) => item.estimate.value === null)
  )
    return { estimate: unavailable(), marginOfError: unavailable() };
  const numerator = numerators.reduce(
    (sum, item) => sum + item.estimate.value!,
    0,
  );
  if (numerator > total)
    return { estimate: unavailable(), marginOfError: unavailable() };
  const proportion = numerator / total;
  const estimate = calculated(100 * proportion);
  if (
    denominator.marginOfError.value === null ||
    numerators.some((item) => item.marginOfError.value === null)
  )
    return { estimate, marginOfError: unavailable() };
  const numeratorVariance = numerators.reduce(
    (sum, item) => sum + item.marginOfError.value! ** 2,
    0,
  );
  const denominatorTerm =
    proportion ** 2 * denominator.marginOfError.value ** 2;
  const difference = numeratorVariance - denominatorTerm;
  const margin =
    (100 / total) *
    Math.sqrt(
      difference < 0 ? numeratorVariance + denominatorTerm : difference,
    );
  return { estimate, marginOfError: calculated(margin) };
}

export function summaryCommunityProfile(
  cache: AcsSummaryCache,
  zip: string,
  sameStudyArea = false,
): CommunityDemographics {
  if (!/^\d{5}$/.test(zip))
    throw new RangeError("A five-digit ZCTA identifier is required.");
  if (
    cache.schemaVersion !== 1 ||
    cache.vintage !== ACS_VINTAGE ||
    cache.columns.join("|") !== ACS_SUMMARY_COLUMNS.join("|")
  )
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The prepared Census cache has an unsupported vintage or column contract.",
    );
  const row = cache.rows[zip];
  if (!row)
    throw new CensusDataError(
      "CENSUS_GEOGRAPHY_MISSING",
      `The published ACS summary files contain no ZCTA ${zip} record in this cache.`,
    );
  if (row.length !== cache.columns.length)
    throw new CensusDataError(
      "CENSUS_INVALID_RESPONSE",
      "The prepared Census cache row is incomplete.",
    );
  const values = Object.fromEntries(
    cache.columns.map((column, index) => [column, row[index]]),
  );
  const cell = (table: string, line: string) => ({
    estimate: parseCensusValue(values[`${table}_E${line}`], null, "estimate"),
    marginOfError: parseCensusValue(values[`${table}_M${line}`], null, "moe"),
  });
  const published = (
    key: keyof CommunityDemographics["measures"],
    table: string,
  ): CommunityMeasure => {
    const { variable, ...definition } = ACS_MEASURES[key];
    void variable;
    const estimate = cell(table, "001");
    if (
      key === "medianHouseholdIncome" &&
      estimate.marginOfError.raw === "-333333333"
    )
      estimate.estimate = {
        ...estimate.estimate,
        value: null,
        status: "bounded",
        annotation: "Open-ended median",
      };
    return {
      ...definition,
      ...estimate,
      variables: {
        estimate: `${table}_E001`,
        marginOfError: `${table}_M001`,
        estimateAnnotation: "Summary-file jam values",
        marginOfErrorAnnotation: "Summary-file jam values",
      },
    };
  };
  const derived = (
    key: "povertyPercent" | "bachelorsOrHigherPercent",
    table: string,
    lines: string[],
  ): CommunityMeasure => {
    const { variable, ...definition } = ACS_MEASURES[key];
    void variable;
    return {
      ...definition,
      ...derivePercentage(
        lines.map((line) => cell(table, line)),
        cell(table, "001"),
      ),
      variables: {
        estimate: `${table} derived percentage`,
        marginOfError: `${table} approximate MOE`,
        estimateAnnotation: "Derived; source jam values retained in cache",
        marginOfErrorAnnotation: "Derived; source jam values retained in cache",
      },
      method: {
        kind: "derived",
        description: `Sum ${table} cells ${lines.join(", ")} and divide by total cell 001. These approximate margins omit component covariance and can differ from published Data Profile margins.`,
        formula:
          "P = sum(component estimates) / total; MOE = 100 / total × √(sum(component MOE²) − P² × total MOE²). Use + if the radicand is negative.",
        sourceUrl: ACS_MOE_GUIDANCE,
      },
    };
  };
  return communityDemographicsSchema.parse({
    dataset: "acs/acs5",
    vintage: ACS_VINTAGE,
    period: { start: ACS_VINTAGE - 4, end: ACS_VINTAGE },
    confidenceLevel: 90,
    retrievedAt: cache.retrievedAt,
    geography: {
      kind: "zcta",
      id: zip,
      name: `ZCTA5 ${zip}`,
      relationshipToStudyArea: sameStudyArea ? "same-area" : "context-only",
    },
    source: {
      id: `census-acs5-summary-${ACS_VINTAGE}-zcta-${zip}`,
      name: `U.S. Census Bureau · ${ACS_VINTAGE - 4}–${ACS_VINTAGE} ACS Detailed Tables`,
      url: `https://www.census.gov/programs-surveys/acs/data/summary-file.${ACS_VINTAGE}.html`,
      vintage: `${ACS_VINTAGE - 4}–${ACS_VINTAGE}`,
      kind: "published-estimate",
      license: "U.S. Census Bureau public data; attribution retained",
      description:
        "Official table-based Summary File, downloaded once and filtered to whole ZCTAs. Published count/income estimates and margins; poverty and degree percentages derived with explicitly approximate 90% margins.",
    },
    sourceFiles: cache.sourceFiles,
    measures: {
      population: published("population", "B01003"),
      households: published("households", "B11001"),
      housingUnits: published("housingUnits", "B25001"),
      medianHouseholdIncome: published("medianHouseholdIncome", "B19013"),
      povertyPercent: derived("povertyPercent", "C17002", ["002", "003"]),
      bachelorsOrHigherPercent: derived("bachelorsOrHigherPercent", "B15003", [
        "022",
        "023",
        "024",
        "025",
      ]),
    },
    notes: [
      "Five-year survey estimates describe 2020–2024, not a current-year count or forecast.",
      "A ZCTA is a statistical approximation of a postal ZIP. Published whole-area counts are not scaled to mapped buildings.",
      "Population, household, housing-unit, and median-income estimates and margins come directly from Detailed Tables.",
      "Poverty and bachelor’s-or-higher percentages are derived from published counts. Their 90% margins are approximate, following Census handbook chapter 8; component covariance is unavailable.",
      "A missing estimate or margin remains unavailable. Open-ended medians are not treated as exact values.",
      ...(!sameStudyArea
        ? [
            "These figures are wider-area context only, not totals for the smaller displayed study area.",
          ]
        : []),
    ],
  });
}

const loaded = new Map<string, { mtime: number; cache: AcsSummaryCache }>();
export async function readSummaryCommunityProfile(
  zip: string,
  options: { filename?: string; sameStudyArea?: boolean } = {},
) {
  const filename =
    options.filename ??
    process.env.ACS_SUMMARY_PATH ??
    resolve("public/data/acs-2024-zcta.json");
  try {
    const info = await stat(filename);
    if (info.size > 30_000_000)
      throw new CensusDataError(
        "CENSUS_INVALID_RESPONSE",
        "The Census subset cache exceeds its expected size.",
      );
    let item = loaded.get(filename);
    if (!item || item.mtime !== info.mtimeMs) {
      item = {
        mtime: info.mtimeMs,
        cache: JSON.parse(await readFile(filename, "utf8")) as AcsSummaryCache,
      };
      loaded.set(filename, item);
    }
    return summaryCommunityProfile(item.cache, zip, options.sameStudyArea);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new CensusDataError(
        "CENSUS_CACHE_MISSING",
        "Community estimates have not been prepared. The operator can build the public Census cache or configure a free Census API key.",
      );
    throw error;
  }
}
