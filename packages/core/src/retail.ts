import { z } from "zod";
import type { Place, Project, Scenario, Source } from "./index";
import { isSafeFeatureIdentifier } from "./identifiers";
import { projectWithActivityVersion } from "./activity";

export const MAX_RETAIL_CATEGORIES = 64;
export interface RetailMeasure {
  status: "available" | "missing" | "suppressed";
  value: number | null;
  sourceId?: string;
  note?: string;
}
export interface RetailCategory {
  id: string;
  name: string;
  code: string;
  baselineDemand: RetailMeasure;
  baselineSales: RetailMeasure;
  salesPerEstablishment: RetailMeasure;
  /** Null explicitly keeps the reference annual demand; no automatic growth. */
  scenarioDemand: number | null;
  /** Additional prospective gross annual sales capacity, not floor area or observed sales. */
  annualSalesCapacity: number;
  captureShare: number;
  displacementShare: number;
  assumptionSourceId: string;
}
export interface RetailSourceRights {
  sourceId: string;
  authorizedPrivateUse: boolean;
  publicRedistribution: boolean;
  statement: string;
}
export interface RetailScenario {
  version: 1;
  context: {
    geography: string;
    relationshipToStudyArea: "same-area" | "context-only";
    referenceYear: number;
    dollarYear: number;
    currency: "USD";
    classification: { system: "NAICS" | "custom"; version: string };
    horizon: Scenario["horizon"];
    comparabilityConfirmed: boolean;
    disjointCategoriesConfirmed: boolean;
  };
  categories: RetailCategory[];
  sourceRights: RetailSourceRights[];
}
export const USER_RETAIL_SOURCE: Source = {
  id: "user-retail-analysis",
  name: "User retail analysis",
  url: "",
  vintage: "Scenario edit",
  license:
    "User-authored inputs; redistribution subject to the study's source-rights declarations",
  kind: "user-supplied",
  description:
    "Entered category demand, establishment sales, annual capacity and capture/displacement assumptions. No independent source verification, observed spending leakage or forecast of business openings is implied.",
};
const id = z
  .string()
  .refine(
    isSafeFeatureIdentifier,
    "Use a safe identifier of at most 160 characters.",
  );
const amount = z.number().finite().min(0).max(1e12);
const text = (max: number) => z.string().trim().min(1).max(max);
export const retailMeasureSchema = z
  .object({
    status: z.enum(["available", "missing", "suppressed"]),
    value: amount.nullable(),
    sourceId: id.optional(),
    note: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((m, c) => {
    if ((m.status === "available") !== (m.value !== null))
      c.addIssue({
        code: "custom",
        message:
          "Available amounts need a number; missing/suppressed amounts must remain null.",
      });
    if (m.status !== "missing" && !m.sourceId)
      c.addIssue({
        code: "custom",
        message: "Available and suppressed measures need a retained source.",
      });
  });
export const retailCategorySchema = z
  .object({
    id,
    name: text(160),
    code: text(80),
    baselineDemand: retailMeasureSchema,
    baselineSales: retailMeasureSchema,
    salesPerEstablishment: retailMeasureSchema,
    scenarioDemand: amount.nullable(),
    annualSalesCapacity: amount,
    captureShare: z.number().finite().min(0).max(1),
    displacementShare: z.number().finite().min(0).max(1),
    assumptionSourceId: id,
  })
  .strict()
  .superRefine((r, c) => {
    if (
      r.salesPerEstablishment.status === "available" &&
      r.salesPerEstablishment.value === 0
    )
      c.addIssue({
        code: "custom",
        message:
          "An available sales-per-establishment benchmark must be positive.",
      });
  });
export const retailScenarioSchema = z
  .object({
    version: z.literal(1),
    context: z
      .object({
        geography: text(500),
        relationshipToStudyArea: z.enum(["same-area", "context-only"]),
        referenceYear: z.number().int().min(1900).max(2200),
        dollarYear: z.number().int().min(1900).max(2200),
        currency: z.literal("USD"),
        classification: z
          .object({ system: z.enum(["NAICS", "custom"]), version: text(100) })
          .strict(),
        horizon: z.union([
          z.literal(0),
          z.literal(5),
          z.literal(10),
          z.literal(20),
        ]),
        comparabilityConfirmed: z.boolean(),
        disjointCategoriesConfirmed: z.boolean(),
      })
      .strict(),
    categories: z.array(retailCategorySchema).min(1).max(MAX_RETAIL_CATEGORIES),
    sourceRights: z
      .array(
        z
          .object({
            sourceId: id,
            authorizedPrivateUse: z.boolean(),
            publicRedistribution: z.boolean(),
            statement: text(2000),
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .superRefine((r, c) => {
    if (new Set(r.categories.map((v) => v.id)).size !== r.categories.length)
      c.addIssue({
        code: "custom",
        message: "Retail category identifiers must be unique.",
      });
    const codes = r.categories.map((v) => v.code.trim().toLowerCase());
    if (new Set(codes).size !== codes.length)
      c.addIssue({
        code: "custom",
        message: "Retail category codes cannot be duplicated.",
      });
    if (r.context.classification.system === "NAICS") {
      if (codes.some((v) => !/^\d{2,6}$/.test(v)))
        c.addIssue({
          code: "custom",
          message:
            "Use a 2–6 digit NAICS code; use separate disjoint categories instead of ranges.",
        });
      if (
        codes.some((a, i) => codes.some((b, j) => i !== j && a.startsWith(b)))
      )
        c.addIssue({
          code: "custom",
          message:
            "NAICS parent and child categories overlap and cannot both contribute to the study.",
        });
    }
    if (
      new Set(r.sourceRights.map((v) => v.sourceId)).size !==
      r.sourceRights.length
    )
      c.addIssue({
        code: "custom",
        message: "Source-rights declarations must be unique per source.",
      });
  });
export function assertRetailScenario(
  input: unknown,
): asserts input is RetailScenario {
  const result = retailScenarioSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid retail analysis: ${result.error.issues[0]?.message ?? "unsupported input"}`,
    );
}
export function retailSourceIds(retail: RetailScenario): string[] {
  return [
    ...new Set(
      retail.categories.flatMap((c) => [
        c.assumptionSourceId,
        ...[c.baselineDemand, c.baselineSales, c.salesPerEstablishment].flatMap(
          (m) => (m.sourceId ? [m.sourceId] : []),
        ),
      ]),
    ),
  ];
}
export function retailPubliclyRedistributable(retail: RetailScenario): boolean {
  if (!retailScenarioSchema.safeParse(retail).success) return false;
  if (
    retail.sourceRights.some(
      (r) => !r.authorizedPrivateUse || !r.publicRedistribution,
    )
  )
    return false;
  return retailSourceIds(retail).every((id) =>
    retail.sourceRights.some(
      (r) =>
        r.sourceId === id && r.authorizedPrivateUse && r.publicRedistribution,
    ),
  );
}
export function validateRetailScenario(
  retail: RetailScenario,
  place: Place,
  sources: readonly Source[] = [],
): void {
  assertRetailScenario(retail);
  if (!retail.context.comparabilityConfirmed)
    throw new Error(
      "Confirm that annual demand, local sales and benchmarks share the declared geography, reference year, dollar basis and category definitions.",
    );
  if (!retail.context.disjointCategoriesConfirmed)
    throw new Error(
      "Confirm categories are mutually exclusive; industry totals and commodity expenditure totals must not be mixed without a documented compatible mapping.",
    );
  const known = new Map<string, string>();
  const referenced = new Set(retailSourceIds(retail));
  for (const source of [...place.sources, ...sources, USER_RETAIL_SOURCE]) {
    if (!referenced.has(source.id)) continue;
    const signature = JSON.stringify(
      Object.fromEntries(
        Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    if (known.has(source.id) && known.get(source.id) !== signature)
      throw new Error(
        `Conflicting metadata for retail source ${source.id}; retain distinct source IDs.`,
      );
    known.set(source.id, signature);
  }
  for (const id of retailSourceIds(retail)) {
    if (!known.has(id))
      throw new Error(`Retail source ${id} has no retained source record.`);
    if (
      !retail.sourceRights.some(
        (r) => r.sourceId === id && r.authorizedPrivateUse,
      )
    )
      throw new Error(
        `Confirm rights for storage, analysis, authorized-team sharing and private export of retail source ${id}.`,
      );
  }
}
export function createRetailCategory(name = "New category"): RetailCategory {
  const missing = (): RetailMeasure => ({ status: "missing", value: null });
  const categoryId = `retail-${crypto.randomUUID()}`;
  return {
    id: categoryId,
    name,
    code: categoryId,
    baselineDemand: missing(),
    baselineSales: missing(),
    salesPerEstablishment: missing(),
    scenarioDemand: null,
    annualSalesCapacity: 0,
    captureShare: 0,
    displacementShare: 0,
    assumptionSourceId: USER_RETAIL_SOURCE.id,
  };
}
export function createRetailScenario(
  place: Place,
  horizon: Scenario["horizon"],
): RetailScenario {
  const year = new Date().getUTCFullYear();
  return {
    version: 1,
    context: {
      geography: place.extentLabel,
      relationshipToStudyArea: "same-area",
      referenceYear: year,
      dollarYear: year,
      currency: "USD",
      classification: { system: "custom", version: "User-defined categories" },
      horizon,
      comparabilityConfirmed: false,
      disjointCategoriesConfirmed: false,
    },
    categories: [createRetailCategory()],
    sourceRights: [
      {
        sourceId: USER_RETAIL_SOURCE.id,
        authorizedPrivateUse: true,
        publicRedistribution: false,
        statement:
          "User-authored inputs for authorized project use; public redistribution has not been confirmed.",
      },
    ],
  };
}
export function projectWithRetailVersion(
  project: Project,
  place?: Place,
): Project {
  const upgraded = projectWithActivityVersion(project, place);
  if (upgraded.schemaVersion >= 6) return upgraded;
  const snapshots = [
    ...project.scenarios,
    ...project.history.flatMap((e) => [e.before, e.after]),
    ...project.undone.flatMap((e) => [e.before, e.after]),
  ];
  return snapshots.some((s) => s.retail !== undefined) ||
    [...project.history, ...project.undone].some(
      (e) => e.command.type === "scenario.retail",
    )
    ? { ...upgraded, schemaVersion: 6 }
    : upgraded;
}
