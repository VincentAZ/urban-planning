import { z } from "zod";
import type { Source } from "./index";

export type CensusValueStatus =
  | "available"
  | "missing"
  | "suppressed"
  | "not-applicable"
  | "uncomputable"
  | "controlled"
  | "bounded";
/** Raw sentinels and annotations are retained; only usable estimates have a numeric value. */
export interface CensusValue {
  value: number | null;
  raw: string | null;
  annotation: string | null;
  status: CensusValueStatus;
}
export interface CommunityMeasure {
  label: string;
  unit:
    "people" | "households" | "housing units" | "vehicles" | "USD" | "percent";
  universe: string;
  estimate: CensusValue;
  marginOfError: CensusValue;
  variables: {
    estimate: string;
    marginOfError: string;
    estimateAnnotation: string;
    marginOfErrorAnnotation: string;
  };
  method?: {
    kind: "derived";
    description: string;
    formula: string;
    sourceUrl: string;
  };
}
export interface CommunityDemographics {
  dataset: "acs/acs5/profile" | "acs/acs5";
  vintage: number;
  period: { start: number; end: number };
  geography: {
    kind: "zcta";
    id: string;
    name: string;
    relationshipToStudyArea: "same-area" | "context-only";
  };
  retrievedAt: string;
  confidenceLevel: 90;
  source: Source;
  sourceFiles?: {
    table: string;
    url: string;
    sha256: string;
    retrievedAt: string;
  }[];
  measures: Record<
    | "population"
    | "households"
    | "housingUnits"
    | "medianHouseholdIncome"
    | "povertyPercent"
    | "bachelorsOrHigherPercent",
    CommunityMeasure
  >;
  notes: string[];
}

const censusValueSchema = z
  .object({
    value: z.number().finite().min(0).nullable(),
    raw: z.string().max(100).nullable(),
    annotation: z.string().max(100).nullable(),
    status: z.enum([
      "available",
      "missing",
      "suppressed",
      "not-applicable",
      "uncomputable",
      "controlled",
      "bounded",
    ]),
  })
  .superRefine((cell, context) => {
    if (
      (cell.status === "available" || cell.status === "controlled") !==
      (cell.value !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Only available or controlled Census values may be numeric.",
      });
    if (cell.status === "controlled" && cell.value !== 0)
      context.addIssue({
        code: "custom",
        message: "Controlled Census margins use an explicit zero.",
      });
  });
const measureSchema = z
  .object({
    label: z.string().min(1).max(200),
    unit: z.enum([
      "people",
      "households",
      "housing units",
      "vehicles",
      "USD",
      "percent",
    ]),
    universe: z.string().min(1).max(500),
    estimate: censusValueSchema,
    marginOfError: censusValueSchema,
    variables: z.object({
      estimate: z.string().max(50),
      marginOfError: z.string().max(50),
      estimateAnnotation: z.string().max(50),
      marginOfErrorAnnotation: z.string().max(50),
    }),
    method: z
      .object({
        kind: z.literal("derived"),
        description: z.string().max(2000),
        formula: z.string().max(2000),
        sourceUrl: z.string().url().max(4000),
      })
      .optional(),
  })
  .superRefine((measure, context) => {
    if (measure.estimate.status === "controlled")
      context.addIssue({
        code: "custom",
        message:
          "The controlled sentinel applies to margins of error, not estimates.",
      });
    if (
      measure.unit === "percent" &&
      measure.estimate.value !== null &&
      measure.estimate.value > 100
    )
      context.addIssue({
        code: "custom",
        message: "Published percentages must lie between zero and one hundred.",
      });
  });

/** A separate optional supplement; never backfilled into a captured demographic baseline. */
export interface VehicleAvailability {
  version: 1;
  dataset: "acs/acs5";
  vintage: number;
  period: { start: number; end: number };
  geography: {
    kind: "zcta";
    id: string;
    name: string;
    boundaryVintage: "2020";
    relationshipToStudyArea: "same-area" | "context-only";
  };
  retrievedAt: string;
  confidenceLevel: 90;
  source: Source;
  measure: CommunityMeasure;
  sourceFile?: {
    table: "B25046";
    url: string;
    sha256: string;
    retrievedAt: string;
    bytes: number;
  };
  notes: string[];
}

export const vehicleAvailabilitySchema = z
  .object({
    version: z.literal(1),
    dataset: z.literal("acs/acs5"),
    vintage: z.number().int().min(2009).max(2100),
    period: z.object({ start: z.number().int(), end: z.number().int() }),
    geography: z.object({
      kind: z.literal("zcta"),
      id: z.string().regex(/^\d{5}$/),
      name: z.string().min(1).max(240),
      boundaryVintage: z.literal("2020"),
      relationshipToStudyArea: z.enum(["same-area", "context-only"]),
    }),
    retrievedAt: z.string().datetime(),
    confidenceLevel: z.literal(90),
    source: z.object({
      id: z.string().min(1).max(160),
      name: z.string().min(1).max(240),
      url: z.string().url().max(4000),
      vintage: z.string().max(100),
      license: z.string().max(2000),
      kind: z.literal("published-estimate"),
      description: z.string().max(5000).optional(),
    }),
    measure: measureSchema,
    sourceFile: z
      .object({
        table: z.literal("B25046"),
        url: z.string().url().max(4000),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        retrievedAt: z.string().datetime(),
        bytes: z.number().int().positive(),
      })
      .optional(),
    notes: z.array(z.string().max(2000)).max(50),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      profile.period.end !== profile.vintage ||
      profile.period.start !== profile.vintage - 4
    )
      context.addIssue({
        code: "custom",
        message:
          "Vehicle availability must retain its explicit ACS five-year period.",
      });
    const v = profile.measure.variables;
    if (
      profile.measure.unit !== "vehicles" ||
      v.estimate !== "B25046_001E" ||
      v.marginOfError !== "B25046_001M" ||
      v.estimateAnnotation !== "B25046_001EA" ||
      v.marginOfErrorAnnotation !== "B25046_001MA"
    )
      context.addIssue({
        code: "custom",
        message:
          "Household vehicle availability uses the direct B25046 aggregate and its published margin/annotations.",
      });
  });
export const communityDemographicsSchema = z
  .object({
    dataset: z.enum(["acs/acs5/profile", "acs/acs5"]),
    vintage: z.number().int().min(2009).max(2100),
    period: z.object({ start: z.number().int(), end: z.number().int() }),
    geography: z.object({
      kind: z.literal("zcta"),
      id: z.string().regex(/^\d{5}$/),
      name: z.string().min(1).max(240),
      relationshipToStudyArea: z.enum(["same-area", "context-only"]),
    }),
    retrievedAt: z.string().datetime(),
    confidenceLevel: z.literal(90),
    source: z.object({
      id: z.string().min(1).max(160),
      name: z.string().min(1).max(240),
      url: z.string().url().max(4000),
      vintage: z.string().max(100),
      license: z.string().max(2000),
      kind: z.literal("published-estimate"),
      description: z.string().max(5000).optional(),
    }),
    sourceFiles: z
      .array(
        z.object({
          table: z.string().max(50),
          url: z.string().url().max(4000),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          retrievedAt: z.string().datetime(),
        }),
      )
      .max(20)
      .optional(),
    measures: z.object({
      population: measureSchema,
      households: measureSchema,
      housingUnits: measureSchema,
      medianHouseholdIncome: measureSchema,
      povertyPercent: measureSchema,
      bachelorsOrHigherPercent: measureSchema,
    }),
    notes: z.array(z.string().max(2000)).max(50),
  })
  .superRefine((profile, context) => {
    if (
      profile.period.end !== profile.vintage ||
      profile.period.start !== profile.vintage - 4
    )
      context.addIssue({
        code: "custom",
        message: "ACS five-year period must match its explicit vintage.",
      });
  });
