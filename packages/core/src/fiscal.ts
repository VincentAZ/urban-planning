import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Assumptions, Place, Project, Scenario, Source } from "./index";
import { canonicalJSON } from "./canonical";
import { accessibilitySourceSchema } from "./accessibility";
import { projectWithFloodVersion } from "./flood";

export const FISCAL_METHOD_VERSION = "fiscal-study-1.0.0";
export const FISCAL_COEFFICIENT_KEYS = [
  "assessedValuePerSqft",
  "effectivePropertyTaxRate",
  "annualServiceCostPerResident",
  "annualServiceCostPerJob",
  "annualGrowthRate",
  "discountRate",
  "salesPerSqft",
  "localSalesTaxRate",
  "retailCaptureRate",
] as const;
export type FiscalCoefficientKey = (typeof FISCAL_COEFFICIENT_KEYS)[number];
export type FiscalCoefficients = Pick<Assumptions, FiscalCoefficientKey>;
export interface FiscalParameterProvenance {
  kind: "published" | "derived" | "authored";
  sourceIds: string[];
  description: string;
  derivation?: string;
}
export interface FiscalProfile {
  version: 1;
  id: string;
  name: string;
  profileVersion: string;
  methodVersion: typeof FISCAL_METHOD_VERSION;
  jurisdiction: {
    id: string;
    name: string;
    geography: string;
    sourceIds: string[];
  };
  fiscalYear: number;
  dollarYear: number;
  currency: "USD";
  priceBasis: "constant-dollars";
  discountBasis: "real";
  coefficients: FiscalCoefficients;
  provenance: Record<FiscalCoefficientKey, FiscalParameterProvenance>;
  valuation: {
    buildingValueBasis: "taxable-assessed";
    fallbackValueBasis: "taxable-assessed-per-gross-sqft";
    compatibilityNotes: string;
  };
  serviceAllocation: {
    method: "average-cost-allocation" | "authored-case-study";
    notes: string;
    sourceIds: string[];
  };
  sources: Source[];
  files: { sourceId: string; url: string; sha256: string; bytes: number }[];
  notes: string[];
}
export interface FiscalSensitivityCase {
  id: string;
  name: string;
  description: string;
  baseline: Partial<FiscalCoefficients>;
  proposal: Partial<FiscalCoefficients>;
  sourceIds: string[];
}
export interface FiscalScenario {
  version: 1;
  profileHash: string;
  review: {
    inputHash: string;
    reviewedBy: string;
    reviewedAt: string;
    notes: string;
  };
  cases: FiscalSensitivityCase[];
}
export interface FiscalOffer {
  incentiveGrant: number;
  abatementPercent: number;
  abatementYears: number;
}
export interface FiscalStudy {
  version: 1;
  methodVersion: typeof FISCAL_METHOD_VERSION;
  profile: FiscalProfile;
  profileHash: string;
  placeHash: string;
  baselineAssumptionsHash: string;
  applicability: {
    reviewedBy: string;
    reviewedAt: string;
    applicabilityNotes: string;
    /** Explicit user review, not an independently verified jurisdiction boundary. */
    kind: "user-reviewed-study-area";
  };
  lineage: {
    projectId: string;
    scenarioId: string;
    scenarioRevision: number;
    projectHash: string;
    scenarioHash: string;
    historyHash: string;
    copiedAt: string;
    policy: "selected-current-scenario-native-evidence-imported";
  };
}

export type FiscalReviewState = "current" | "stale" | "missing" | "invalid";
export interface FiscalCashFlowRow {
  /** 0 is the up-front grant; 1..20 are year-end recurring flows. */
  year: number;
  fiscalYear: number | null;
  propertyRevenue: number | null;
  salesRevenue: number | null;
  serviceCost: number | null;
  abatementCost: number | null;
  grantCost: number;
  netRevenue: number | null;
  discountedNet: number | null;
}
export interface FiscalTrajectory {
  rows: FiscalCashFlowRow[];
  totals: {
    propertyRevenue: number | null;
    salesRevenue: number | null;
    serviceCost: number | null;
    abatementCost: number | null;
    grantCost: number;
    netRevenue: number | null;
    npv: number | null;
  };
  missingBuildingIds: string[];
}
export interface FiscalIncremental {
  rows: FiscalCashFlowRow[];
  netRevenue: number | null;
  npv: number | null;
}
export interface FiscalCaseResult {
  id: string;
  name: string;
  description: string;
  sourceIds: string[];
  status: "ready" | "incomplete";
  assumptions: { baseline: Assumptions; proposal: Assumptions };
  baseline: FiscalTrajectory;
  withoutOffer: FiscalTrajectory;
  withOffer: FiscalTrajectory;
  incremental: {
    withoutOffer: FiscalIncremental;
    withOffer: FiscalIncremental;
  };
  offerCost: { total: number | null; npv: number | null };
  payback: {
    status: "not-needed" | "reached" | "not-reached" | "unavailable";
    year: number | null;
  };
}
export interface FiscalResolution {
  methodVersion: typeof FISCAL_METHOD_VERSION;
  scenarioId: string;
  scenarioRevision: number;
  status: "ready" | "incomplete" | "stale" | "unavailable";
  reviewState: FiscalReviewState;
  profileHash: string | null;
  profileName: string | null;
  inputHash: string;
  clock: {
    dollarYear: number;
    baseFiscalYear: number;
    horizonYears: number;
    firstOperatingYear: number;
    years: 20;
    valuation: "start-of-selected-horizon";
    currency: "USD";
    priceBasis: "constant-dollars";
    discountBasis: "real";
  } | null;
  deviations: {
    key: FiscalCoefficientKey;
    profileValue: number;
    currentValue: number;
    kind: "authored-override";
  }[];
  base: FiscalCaseResult | null;
  cases: FiscalCaseResult[];
  notes: string[];
}

const id = z.string().min(1).max(240);
const text = z.string().trim().min(1).max(4000);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const stamp = z.iso.datetime({ offset: false });
const amount = z.number().finite().min(0);
const share = amount.max(1);
const coefficientShape = {
  assessedValuePerSqft: amount.max(1e7),
  effectivePropertyTaxRate: share,
  annualServiceCostPerResident: amount.max(1e7),
  annualServiceCostPerJob: amount.max(1e7),
  annualGrowthRate: z.number().finite().min(-0.99).max(1),
  discountRate: share,
  salesPerSqft: amount.max(1e8),
  localSalesTaxRate: share,
  retailCaptureRate: share,
};
export const fiscalCoefficientsSchema = z.object(coefficientShape).strict();
const sourceIds = z
  .array(id)
  .min(1)
  .max(100)
  .refine((a) => new Set(a).size === a.length, "Duplicate source identifiers.");
const provenanceSchema = z
  .object({
    kind: z.enum(["published", "derived", "authored"]),
    sourceIds,
    description: text,
    derivation: text.optional(),
  })
  .strict()
  .refine(
    (p) => p.kind !== "derived" || p.derivation !== undefined,
    "Derived coefficients need their derivation.",
  );
export const fiscalProfileSchema: z.ZodType<FiscalProfile> = z
  .object({
    version: z.literal(1),
    id,
    name: id,
    profileVersion: id,
    methodVersion: z.literal(FISCAL_METHOD_VERSION),
    jurisdiction: z
      .object({ id, name: id, geography: text, sourceIds })
      .strict(),
    fiscalYear: z.number().int().min(1900).max(2200),
    dollarYear: z.number().int().min(1900).max(2200),
    currency: z.literal("USD"),
    priceBasis: z.literal("constant-dollars"),
    discountBasis: z.literal("real"),
    coefficients: fiscalCoefficientsSchema,
    provenance: z
      .object(
        Object.fromEntries(
          FISCAL_COEFFICIENT_KEYS.map((k) => [k, provenanceSchema]),
        ) as Record<FiscalCoefficientKey, typeof provenanceSchema>,
      )
      .strict(),
    valuation: z
      .object({
        buildingValueBasis: z.literal("taxable-assessed"),
        fallbackValueBasis: z.literal("taxable-assessed-per-gross-sqft"),
        compatibilityNotes: text,
      })
      .strict(),
    serviceAllocation: z
      .object({
        method: z.enum(["average-cost-allocation", "authored-case-study"]),
        notes: text,
        sourceIds,
      })
      .strict(),
    sources: z.array(accessibilitySourceSchema).min(1).max(100),
    files: z
      .array(
        z
          .object({
            sourceId: id,
            url: z.string().max(2000),
            sha256: hash,
            bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(100),
    notes: z.array(text).max(100),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = new Set(p.sources.map((s) => s.id));
    if (ids.size !== p.sources.length)
      ctx.addIssue({
        code: "custom",
        message:
          "Fiscal source identifiers must be unique within their profile.",
      });
    const refs = [
      ...p.jurisdiction.sourceIds,
      ...p.serviceAllocation.sourceIds,
      ...Object.values(p.provenance).flatMap((v) => v.sourceIds),
      ...p.files.map((f) => f.sourceId),
    ];
    if (refs.some((ref) => !ids.has(ref)))
      ctx.addIssue({
        code: "custom",
        message: "Every fiscal citation must retain its source.",
      });
    if (new TextEncoder().encode(canonicalJSON(p)).byteLength > 256 * 1024)
      ctx.addIssue({
        code: "custom",
        message:
          "Fiscal profile exceeds 256 KiB; sources must not be truncated.",
      });
  });
export const fiscalSensitivityCaseSchema: z.ZodType<FiscalSensitivityCase> = z
  .object({
    id: id.refine(
      (value) => value !== "reference",
      "The reference case identifier is reserved.",
    ),
    name: id,
    description: text,
    baseline: fiscalCoefficientsSchema.partial(),
    proposal: fiscalCoefficientsSchema.partial(),
    sourceIds,
  })
  .strict();
export const fiscalScenarioSchema: z.ZodType<FiscalScenario> = z
  .object({
    version: z.literal(1),
    profileHash: hash,
    review: z
      .object({
        inputHash: hash,
        reviewedBy: id,
        reviewedAt: stamp,
        notes: text,
      })
      .strict(),
    cases: z.array(fiscalSensitivityCaseSchema).max(12),
  })
  .strict()
  .refine(
    (s) => new Set(s.cases.map((c) => c.id)).size === s.cases.length,
    "Fiscal case identifiers must be unique.",
  );
export const fiscalOfferSchema: z.ZodType<FiscalOffer> = z
  .object({
    incentiveGrant: amount.max(1e12),
    abatementPercent: share,
    abatementYears: amount.int().max(100),
  })
  .strict();
export const fiscalStudySchema: z.ZodType<FiscalStudy> = z
  .object({
    version: z.literal(1),
    methodVersion: z.literal(FISCAL_METHOD_VERSION),
    profile: fiscalProfileSchema,
    profileHash: hash,
    placeHash: hash,
    baselineAssumptionsHash: hash,
    applicability: z
      .object({
        reviewedBy: id,
        reviewedAt: stamp,
        applicabilityNotes: text,
        kind: z.literal("user-reviewed-study-area"),
      })
      .strict(),
    lineage: z
      .object({
        projectId: id,
        scenarioId: id,
        scenarioRevision: amount.int(),
        projectHash: hash,
        scenarioHash: hash,
        historyHash: hash,
        copiedAt: stamp,
        policy: z.literal("selected-current-scenario-native-evidence-imported"),
      })
      .strict(),
  })
  .strict()
  .refine(
    (s) => fiscalContentHash(s.profile) === s.profileHash,
    "Fiscal profile content hash differs.",
  );

export function fiscalContentHash(value: unknown): string {
  return Array.from(
    sha256(new TextEncoder().encode(canonicalJSON(value))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export function fiscalProfileHash(profile: FiscalProfile): string {
  fiscalProfileSchema.parse(profile);
  return fiscalContentHash(profile);
}
/** Exact replay identity; this does not independently certify user assumptions. */
export function fiscalResolutionInputHash(
  place: Place,
  scenario: Scenario,
  study?: FiscalStudy,
): string {
  return fiscalContentHash({
    methodVersion: FISCAL_METHOD_VERSION,
    place,
    scenario,
    study: study ?? null,
  });
}
/** Reviewed monetary/demographic assumptions, not geometry or an incentive offer. */
export function fiscalReviewInputHash(
  scenario: Pick<Scenario, "assumptions">,
): string {
  const a = scenario.assumptions;
  return fiscalContentHash({
    ...Object.fromEntries(FISCAL_COEFFICIENT_KEYS.map((k) => [k, a[k]])),
    jurisdictionName: a.jurisdictionName,
    fiscalInputsConfirmed: a.fiscalInputsConfirmed,
    householdSize: a.householdSize,
    vacancyRate: a.vacancyRate,
    populationMultiplier: a.populationMultiplier,
  });
}
export function createFiscalScenarioReview(
  scenario: Pick<Scenario, "assumptions">,
  profileHash: string,
  review: { reviewedBy: string; reviewedAt: string; notes: string },
  cases: FiscalSensitivityCase[] = [],
): FiscalScenario {
  return fiscalScenarioSchema.parse({
    version: 1,
    profileHash,
    review: {
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
      notes: review.notes,
      inputHash: fiscalReviewInputHash(scenario),
    },
    cases: structuredClone(cases),
  });
}
export function fiscalProjectIssues(project: Project, place?: Place): string[] {
  const entries = [...project.history, ...project.undone];
  const scenarios = [
    ...project.scenarios,
    ...entries.flatMap((e) => [e.before, e.after]),
  ];
  const evidence = [
    ...scenarios.flatMap((s) => (s.fiscal ? [s.fiscal] : [])),
    ...entries.flatMap((e) =>
      e.command.type === "scenario.fiscal" && e.command.fiscal
        ? [e.command.fiscal]
        : [],
    ),
  ];
  const has =
    project.fiscalStudy !== undefined ||
    evidence.length > 0 ||
    entries.some((e) => e.command.type === "scenario.fiscal");
  const issues: string[] = [];
  if (evidence.some((f) => !fiscalScenarioSchema.safeParse(f).success))
    issues.push("Fiscal review or named sensitivity case is invalid.");
  if (has && project.schemaVersion < 12)
    issues.push("Fiscal studies require project format 12.");
  if (evidence.length && !project.fiscalStudy)
    issues.push("Fiscal reviews need their immutable study profile.");
  const study = project.fiscalStudy;
  if (!study) return issues;
  const parsed = fiscalStudySchema.safeParse(study);
  if (!parsed.success)
    return [...issues, "Fiscal study profile or integrity is invalid."];
  const baseline = project.scenarios.find((s) => s.id === "baseline");
  if (
    !baseline ||
    fiscalContentHash(baseline.assumptions) !== study.baselineAssumptionsHash
  )
    issues.push("Fiscal reference assumptions differ from the frozen study.");
  if (place && fiscalContentHash(place) !== study.placeHash)
    issues.push("Fiscal study belongs to a different source baseline.");
  if (
    baseline &&
    (FISCAL_COEFFICIENT_KEYS.some(
      (k) => baseline.assumptions[k] !== study.profile.coefficients[k],
    ) ||
      baseline.assumptions.jurisdictionName !==
        study.profile.jurisdiction.name ||
      !baseline.assumptions.fiscalInputsConfirmed)
  )
    issues.push(
      "Fiscal baseline does not retain the reviewed profile coefficients.",
    );
  const ids = new Set(study.profile.sources.map((s) => s.id));
  if (
    evidence.some(
      (f) =>
        f.profileHash !== study.profileHash ||
        f.cases.some((c) => c.sourceIds.some((id) => !ids.has(id))),
    )
  )
    issues.push(
      "Fiscal review or sensitivity citations do not match the retained profile.",
    );
  return issues;
}
export function projectWithFiscalVersion(
  project: Project,
  place?: Place,
): Project {
  const p = projectWithFloodVersion(project, place);
  const entries = [...p.history, ...p.undone];
  const has =
    p.fiscalStudy !== undefined ||
    [...p.scenarios, ...entries.flatMap((e) => [e.before, e.after])].some(
      (s) => s.fiscal !== undefined,
    ) ||
    entries.some((e) => e.command.type === "scenario.fiscal");
  return has && p.schemaVersion < 12 ? { ...p, schemaVersion: 12 } : p;
}
