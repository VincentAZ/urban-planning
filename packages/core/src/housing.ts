import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJSON } from "./canonical";
import { accessibilitySourceSchema } from "./accessibility";
import type { Building, Place, Project, Scenario, Source } from "./index";
import { projectWithFiscalVersion } from "./fiscal";

export const HOUSING_AFFORDABILITY_METHOD_VERSION =
  "housing-affordability-1.0.0";
export const HOUSING_INCOME_LIMIT_KEYS = [
  "extremelyLow",
  "veryLow",
  "low",
] as const;
export type HousingIncomeLimitKey = (typeof HOUSING_INCOME_LIMIT_KEYS)[number];
export type HousingHouseholdSize = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface HousingIncomeLimitPack {
  version: 1;
  program: "hud-section8";
  fiscalYear: number;
  effectiveDate: string;
  currency: "USD";
  area: {
    id: string;
    name: string;
    geographies: {
      stateFips: string;
      countyFips: string;
      countySubdivisionFips?: string;
      name: string;
    }[];
  };
  limits: ({ householdSize: HousingHouseholdSize } & Record<
    HousingIncomeLimitKey,
    number
  >)[];
  sources: Source[];
  files: { sourceId: string; url: string; sha256: string; bytes: number }[];
  sourceRows: {
    fileSha256: string;
    sheet: string;
    row: number;
    cells: Record<string, string | number | null>;
  }[];
  notes: string[];
}
export type HousingIncomeLimitCatalog = Record<string, HousingIncomeLimitPack>;
export const HOUSING_RENT_COST_KINDS = [
  "rent",
  "utilities",
  "mandatory-fees",
] as const;
export const HOUSING_OWNER_COST_KINDS = [
  "loan-payment",
  "property-tax",
  "property-insurance",
  "flood-insurance",
  "mortgage-insurance",
  "utilities",
  "association-fees",
  "ground-rent",
  "mandatory-fees",
] as const;
export type HousingCostKind =
  | (typeof HOUSING_RENT_COST_KINDS)[number]
  | (typeof HOUSING_OWNER_COST_KINDS)[number];
export interface HousingCostProvenance {
  kind: "published" | "derived" | "authored";
  sourceIds: string[];
  description: string;
}
export type HousingCostItem = {
  id: string;
  kind: HousingCostKind;
  provenance: HousingCostProvenance;
} & (
  | { state: "separate"; monthlyCents: number }
  | { state: "included"; includedIn: string }
  | { state: "not-applicable" | "unknown" }
);
export interface HousingCostGroup {
  id: string;
  buildingId: string;
  componentId?: string;
  units: number;
  tenure: "rent" | "own";
  householdSize: HousingHouseholdSize;
  /** Descriptive only. Never converted to an assumed household size. */
  bedrooms?: number;
  areaHash: string;
  areaOrigin: "server-catalog" | "imported";
  costYear: number;
  costs: HousingCostItem[];
  notes: string;
}
export interface HousingAffordabilityScenario {
  version: 1;
  methodVersion: typeof HOUSING_AFFORDABILITY_METHOD_VERSION;
  baselineGroups: HousingCostGroup[];
  proposalGroups: HousingCostGroup[];
  sources: Source[];
  review: {
    inputHash: string;
    reviewedBy: string;
    reviewedAt: string;
    notes: string;
  };
}
export interface HousingCapacity {
  buildingId: string;
  units: number | null;
  components: { componentId: string; units: number }[];
}
export interface HousingAffordabilityRow {
  groupId: string;
  buildingId: string;
  componentId?: string;
  units: number;
  tenure: "rent" | "own";
  householdSize: HousingHouseholdSize;
  areaHash: string;
  areaOrigin: "server-catalog" | "imported";
  areaName: string | null;
  fiscalYear: number | null;
  costYear: number;
  status: "ready" | "incomplete" | "stale";
  grossMonthlyCents: number | null;
  /** Sum of separately paid known components; a lower bound, not a complete cost. */
  knownMonthlyCents: number;
  requiredAnnualIncome: number | null;
  limits: Record<HousingIncomeLimitKey, number> | null;
  affordableAt: Record<HousingIncomeLimitKey, boolean | null>;
  minimumBand: HousingIncomeLimitKey | "above-low" | null;
  missingCostKinds: HousingCostKind[];
  reasons: string[];
  sourceIds: string[];
}
export interface HousingCount {
  estimate: number | null;
  knownSubtotal: number;
}
export interface HousingAffordabilitySide {
  totalUnits: number | null;
  knownUnits: number;
  assignedUnits: number;
  evaluatedUnits: number;
  unassignedUnits: number;
  unresolvedAssignedUnits: number;
  unknownUnitBuildingIds: string[];
  staleGroupIds: string[];
  cumulative: Record<HousingIncomeLimitKey, HousingCount>;
  bands: Record<HousingIncomeLimitKey | "above-low", HousingCount>;
  rows: HousingAffordabilityRow[];
}
export interface HousingAffordabilityResolution {
  methodVersion: typeof HOUSING_AFFORDABILITY_METHOD_VERSION;
  scenarioId: string;
  scenarioRevision: number;
  inputHash: string;
  status: "ready" | "incomplete" | "stale" | "unavailable";
  reviewState: "current" | "stale" | "missing" | "invalid";
  baseline: HousingAffordabilitySide;
  proposal: HousingAffordabilitySide;
  delta: Record<HousingIncomeLimitKey, number | null>;
  notes: string[];
}

const id = z.string().trim().min(1).max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(4000);
const year = z.number().int().min(1900).max(2200);
const size = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
]);
const cents = z.number().int().min(0).max(1_000_000_000);
const units = z.number().int().min(0).max(1_000_000);
const sourceIds = z
  .array(id)
  .max(100)
  .refine((a) => new Set(a).size === a.length, "Duplicate source identifiers.");
const provenance = z
  .object({
    kind: z.enum(["published", "derived", "authored"]),
    sourceIds,
    description: text,
  })
  .strict()
  .refine(
    (p) => p.kind === "authored" || p.sourceIds.length > 0,
    "Published or derived costs require retained sources.",
  );
const kind = z.enum(["rent", ...HOUSING_OWNER_COST_KINDS]);
const costBase = { id, kind, provenance };
export const housingCostItemSchema: z.ZodType<HousingCostItem> =
  z.discriminatedUnion("state", [
    z
      .object({
        ...costBase,
        state: z.literal("separate"),
        monthlyCents: cents,
      })
      .strict(),
    z
      .object({ ...costBase, state: z.literal("included"), includedIn: id })
      .strict(),
    z.object({ ...costBase, state: z.literal("not-applicable") }).strict(),
    z.object({ ...costBase, state: z.literal("unknown") }).strict(),
  ]);
export const housingCostGroupSchema: z.ZodType<HousingCostGroup> = z
  .object({
    id,
    buildingId: id,
    componentId: id.optional(),
    units: units.min(1),
    tenure: z.enum(["rent", "own"]),
    householdSize: size,
    bedrooms: z.number().int().min(0).max(30).optional(),
    areaHash: hash,
    areaOrigin: z.enum(["server-catalog", "imported"]),
    costYear: year,
    costs: z.array(housingCostItemSchema).min(1).max(16),
    notes: z.string().max(4000),
  })
  .strict()
  .superRefine((g, ctx) => {
    const expected: readonly string[] =
      g.tenure === "rent" ? HOUSING_RENT_COST_KINDS : HOUSING_OWNER_COST_KINDS;
    if (
      new Set(g.costs.map((c) => c.id)).size !== g.costs.length ||
      new Set(g.costs.map((c) => c.kind)).size !== g.costs.length ||
      g.costs.length !== expected.length ||
      g.costs.some((c) => !expected.includes(c.kind))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Every required cost kind must appear exactly once for this tenure.",
      });
    for (const c of g.costs)
      if (
        c.state === "included" &&
        !g.costs.some(
          (target) =>
            target.id === c.includedIn &&
            target.id !== c.id &&
            target.state === "separate",
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Included costs must reference a different, separately paid known component; chains and cycles are not allowed.",
        });
  });
export const housingIncomeLimitPackSchema: z.ZodType<HousingIncomeLimitPack> = z
  .object({
    version: z.literal(1),
    program: z.literal("hud-section8"),
    fiscalYear: year,
    effectiveDate: z.iso.date(),
    currency: z.literal("USD"),
    area: z
      .object({
        id,
        name: id,
        geographies: z
          .array(
            z
              .object({
                stateFips: z.string().regex(/^\d{2}$/u),
                countyFips: z.string().regex(/^\d{5}$/u),
                countySubdivisionFips: z
                  .string()
                  .regex(/^\d{5}$/u)
                  .optional(),
                name: id,
              })
              .strict(),
          )
          .min(1)
          .max(1000),
      })
      .strict(),
    limits: z
      .array(
        z
          .object({
            householdSize: size,
            extremelyLow: z.number().int().min(0).max(100_000_000),
            veryLow: z.number().int().min(0).max(100_000_000),
            low: z.number().int().min(0).max(100_000_000),
          })
          .strict(),
      )
      .length(8),
    sources: z.array(accessibilitySourceSchema).min(1).max(32),
    files: z
      .array(
        z
          .object({
            sourceId: id,
            url: z.string().max(2048),
            sha256: hash,
            bytes: z
              .number()
              .int()
              .positive()
              .max(256 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    sourceRows: z
      .array(
        z
          .object({
            fileSha256: hash,
            sheet: id,
            row: z.number().int().positive(),
            cells: z.record(
              z.string().max(100),
              z.union([z.string().max(4000), z.number().finite(), z.null()]),
            ),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    notes: z.array(text).max(100),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.limits.map((l) => l.householdSize)).size !== 8)
      ctx.addIssue({
        code: "custom",
        message: "All eight household sizes must occur exactly once.",
      });
    if (p.limits.some((l) => l.extremelyLow > l.veryLow || l.veryLow > l.low))
      ctx.addIssue({
        code: "custom",
        message: "Published income limits must be ordered.",
      });
    const ids = new Set(p.sources.map((s) => s.id));
    if (
      ids.size !== p.sources.length ||
      p.files.some((f) => !ids.has(f.sourceId)) ||
      p.sourceRows.some((r) => !p.files.some((f) => f.sha256 === r.fileSha256))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Income-limit source/file/row references are incomplete or duplicated.",
      });
    if (
      new Set(p.sourceRows.map((r) => `${r.fileSha256}/${r.sheet}/${r.row}`))
        .size !== p.sourceRows.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate source rows." });
    if (
      p.area.geographies.some((g) => !g.countyFips.startsWith(g.stateFips)) ||
      new Set(
        p.area.geographies.map(
          (g) => `${g.countyFips}/${g.countySubdivisionFips ?? ""}`,
        ),
      ).size !== p.area.geographies.length
    )
      ctx.addIssue({
        code: "custom",
        message:
          "HUD area components must be unique and retain matching state/county codes.",
      });
    if (new TextEncoder().encode(JSON.stringify(p)).byteLength > 512 * 1024)
      ctx.addIssue({
        code: "custom",
        message:
          "An income-limit pack exceeds 512 KiB; do not truncate evidence.",
      });
  });
export const housingAffordabilityScenarioSchema: z.ZodType<HousingAffordabilityScenario> =
  z
    .object({
      version: z.literal(1),
      methodVersion: z.literal(HOUSING_AFFORDABILITY_METHOD_VERSION),
      baselineGroups: z.array(housingCostGroupSchema).max(5000),
      proposalGroups: z.array(housingCostGroupSchema).max(5000),
      sources: z.array(accessibilitySourceSchema).max(256),
      review: z
        .object({
          inputHash: hash,
          reviewedBy: id,
          reviewedAt: z.iso.datetime({ offset: false }),
          notes: text,
        })
        .strict(),
    })
    .strict()
    .superRefine((a, ctx) => {
      const ids = new Set(a.sources.map((s) => s.id));
      if (ids.size !== a.sources.length)
        ctx.addIssue({
          code: "custom",
          message: "Duplicate housing cost sources.",
        });
      for (const groups of [a.baselineGroups, a.proposalGroups]) {
        if (new Set(groups.map((g) => g.id)).size !== groups.length)
          ctx.addIssue({
            code: "custom",
            message: "Duplicate housing group identifiers on one side.",
          });
        if (
          groups.some((g) =>
            g.costs.some((c) =>
              c.provenance.sourceIds.some((s) => !ids.has(s)),
            ),
          )
        )
          ctx.addIssue({
            code: "custom",
            message:
              "Housing cost citations need their complete retained sources.",
          });
      }
    });
export function housingContentHash(value: unknown): string {
  return Array.from(
    sha256(new TextEncoder().encode(canonicalJSON(value))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export function housingIncomeLimitPackHash(
  pack: HousingIncomeLimitPack,
): string {
  housingIncomeLimitPackSchema.parse(pack);
  return housingContentHash(pack);
}
export function validateHousingIncomeLimitPack(
  input: unknown,
): HousingIncomeLimitPack {
  return housingIncomeLimitPackSchema.parse(input);
}
export const housingIncomeLimitCatalogSchema: z.ZodType<HousingIncomeLimitCatalog> =
  z.record(hash, housingIncomeLimitPackSchema).superRefine((catalog, ctx) => {
    if (
      Object.keys(catalog).length > 32 ||
      new TextEncoder().encode(JSON.stringify(catalog)).byteLength >
        8 * 1024 * 1024
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Housing income-limit catalog exceeds 32 packs or 8 MiB; evidence cannot be truncated.",
      });
    for (const [key, pack] of Object.entries(catalog))
      if (housingContentHash(pack) !== key)
        ctx.addIssue({
          code: "custom",
          message:
            "Housing income-limit catalog content does not match its hash.",
        });
  });
export function housingCapacities(
  buildings: readonly Building[],
): HousingCapacity[] {
  return buildings.map((b) => ({
    buildingId: b.id,
    units: b.units,
    components:
      b.program?.components.map((c) => ({
        componentId: c.id,
        units: c.units,
      })) ?? [],
  }));
}
function buildingsFor(place: Place, scenario: Scenario): Building[] {
  const map = new Map(place.buildings.map((b) => [b.id, b]));
  for (const [id, b] of Object.entries(scenario.buildingEdits))
    if (b === null) map.delete(id);
    else map.set(id, b);
  return [...map.values()];
}
/** The reviewed spatial/program/cost assignment, independent of display names and unrelated assumptions. */
export function housingAffordabilityReviewInputHash(
  place: Place,
  scenario: Scenario,
  a: Pick<
    HousingAffordabilityScenario,
    "baselineGroups" | "proposalGroups" | "sources"
  >,
): string {
  const inventory = (buildings: Building[]) =>
    buildings
      .map((b) => ({
        id: b.id,
        units: b.units,
        geometry: b.geometry ?? b.footprint,
        program: b.program ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Origin is an authority label, not a user-authored physical/cost assumption. A restored copy keeps its review but loses server authority.
  const groups = (rows: HousingCostGroup[]) =>
    rows.map(({ areaOrigin: _origin, ...g }) => g);
  return housingContentHash({
    placeId: place.id,
    baseline: inventory(place.buildings),
    proposal: inventory(buildingsFor(place, scenario)),
    baselineGroups: groups(a.baselineGroups),
    proposalGroups: groups(a.proposalGroups),
    sources: a.sources,
  });
}
export function createHousingAffordabilityScenario(
  place: Place,
  scenario: Scenario,
  input: Pick<
    HousingAffordabilityScenario,
    "baselineGroups" | "proposalGroups" | "sources"
  >,
  review: { reviewedBy: string; reviewedAt: string; notes: string },
): HousingAffordabilityScenario {
  return housingAffordabilityScenarioSchema.parse({
    version: 1,
    methodVersion: HOUSING_AFFORDABILITY_METHOD_VERSION,
    ...structuredClone(input),
    review: {
      ...review,
      inputHash: housingAffordabilityReviewInputHash(place, scenario, input),
    },
  });
}
export function housingAffordabilityResolutionInputHash(
  place: Place,
  scenario: Scenario,
  catalog?: HousingIncomeLimitCatalog,
): string {
  const refs = [
    ...new Set(
      [
        ...(scenario.affordability?.baselineGroups ?? []),
        ...(scenario.affordability?.proposalGroups ?? []),
      ].map((g) => g.areaHash),
    ),
  ].sort();
  return housingContentHash({
    methodVersion: HOUSING_AFFORDABILITY_METHOD_VERSION,
    place,
    scenario,
    packs: refs.map((key) => [key, catalog?.[key] ?? null]),
  });
}
export function housingAffordabilityReferences(
  project: Project,
): HousingAffordabilityScenario[] {
  const entries = [...project.history, ...project.undone];
  return [...project.scenarios, ...entries.flatMap((e) => [e.before, e.after])]
    .flatMap((s) => (s.affordability ? [s.affordability] : []))
    .concat(
      entries.flatMap((e) =>
        e.command.type === "scenario.affordability" && e.command.affordability
          ? [e.command.affordability]
          : [],
      ),
    );
}
export function housingProjectIssues(project: Project): string[] {
  const references = housingAffordabilityReferences(project),
    issues: string[] = [];
  const has =
    project.housingIncomeLimits !== undefined ||
    references.length ||
    [...project.history, ...project.undone].some(
      (e) => e.command.type === "scenario.affordability",
    );
  if (has && project.schemaVersion < 13)
    issues.push("Housing affordability requires project format 13.");
  for (const ref of references)
    for (const g of [...ref.baselineGroups, ...ref.proposalGroups])
      if (!Object.hasOwn(project.housingIncomeLimits ?? {}, g.areaHash))
        issues.push(
          "Every current/historical housing group requires its retained income-limit pack.",
        );
  return [...new Set(issues)];
}
export function projectWithHousingVersion(
  project: Project,
  place?: Place,
): Project {
  const p = projectWithFiscalVersion(project, place);
  const has =
    p.housingIncomeLimits !== undefined ||
    housingAffordabilityReferences(p).length ||
    [...p.history, ...p.undone].some(
      (e) => e.command.type === "scenario.affordability",
    );
  return has && p.schemaVersion < 13 ? { ...p, schemaVersion: 13 } : p;
}
export function installHousingIncomeLimitPack(
  project: Project,
  pack: HousingIncomeLimitPack,
): Project {
  const key = housingIncomeLimitPackHash(pack),
    catalog = { ...project.housingIncomeLimits, [key]: structuredClone(pack) };
  housingIncomeLimitCatalogSchema.parse(catalog);
  return {
    ...projectWithHousingVersion(project),
    housingIncomeLimits: catalog,
    schemaVersion: 13,
  };
}
/** Importing a saved copy never transfers server catalog authority. The review remains an authored attestation. */
export function projectWithImportedHousing(project: Project): Project {
  if (
    !housingAffordabilityReferences(project).some((a) =>
      [...a.baselineGroups, ...a.proposalGroups].some(
        (g) => g.areaOrigin === "server-catalog",
      ),
    )
  )
    return project;
  const copy = structuredClone(project);
  for (const a of housingAffordabilityReferences(copy))
    for (const g of [...a.baselineGroups, ...a.proposalGroups])
      g.areaOrigin = "imported";
  return copy;
}
export function housingSourcePermissionIssues(
  sources: readonly Source[],
  permission: "private" | "export" | "publicRedistribution",
): string[] {
  return sources
    .filter(
      (s) =>
        !s.rights ||
        !s.rights.privateUse ||
        !s.rights.cache ||
        !s.rights.analyze ||
        !s.rights.privateDisplay ||
        !s.rights.historicalRetention ||
        (permission === "export" && !s.rights.export) ||
        (permission === "publicRedistribution" &&
          !s.rights.publicRedistribution),
    )
    .map(
      (s) =>
        `Housing source ${s.id} lacks an explicit ${permission} permission.`,
    );
}
export function validateHousingCatalogTransition(
  previous: Project,
  next: Project,
): void {
  housingIncomeLimitCatalogSchema.parse(next.housingIncomeLimits ?? {});
  for (const [key, pack] of Object.entries(previous.housingIncomeLimits ?? {}))
    if (
      !next.housingIncomeLimits?.[key] ||
      canonicalJSON(pack) !== canonicalJSON(next.housingIncomeLimits[key])
    )
      throw new Error(
        "Retained housing income-limit packs are immutable and cannot be removed.",
      );
  const issues = housingProjectIssues(next);
  if (issues.length) throw new Error(issues.join(" "));
}

const nullableCount = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const countSchema = z
  .object({ estimate: nullableCount, knownSubtotal: nullableCount.unwrap() })
  .strict();
const limitRecord = <T extends z.ZodType>(value: T) =>
  z.object({ extremelyLow: value, veryLow: value, low: value }).strict();
const rowSchema = z
  .object({
    groupId: id,
    buildingId: id,
    componentId: id.optional(),
    units,
    tenure: z.enum(["rent", "own"]),
    householdSize: size,
    areaHash: hash,
    areaOrigin: z.enum(["server-catalog", "imported"]),
    areaName: id.nullable(),
    fiscalYear: year.nullable(),
    costYear: year,
    status: z.enum(["ready", "incomplete", "stale"]),
    grossMonthlyCents: z.number().int().nonnegative().max(16e9).nullable(),
    knownMonthlyCents: z.number().int().nonnegative().max(16e9),
    requiredAnnualIncome: z.number().finite().nonnegative().nullable(),
    limits: limitRecord(z.number().int().nonnegative()).nullable(),
    affordableAt: limitRecord(z.boolean().nullable()),
    minimumBand: z
      .enum(["extremelyLow", "veryLow", "low", "above-low"])
      .nullable(),
    missingCostKinds: z.array(kind).max(16),
    reasons: z.array(text).max(30),
    sourceIds,
  })
  .strict();
const sideSchema = z
  .object({
    totalUnits: nullableCount,
    knownUnits: nullableCount.unwrap(),
    assignedUnits: nullableCount.unwrap(),
    evaluatedUnits: nullableCount.unwrap(),
    unassignedUnits: nullableCount.unwrap(),
    unresolvedAssignedUnits: nullableCount.unwrap(),
    unknownUnitBuildingIds: z.array(id).max(200000),
    staleGroupIds: z.array(id).max(5000),
    cumulative: limitRecord(countSchema),
    bands: z
      .object({
        extremelyLow: countSchema,
        veryLow: countSchema,
        low: countSchema,
        "above-low": countSchema,
      })
      .strict(),
    rows: z.array(rowSchema).max(5000),
  })
  .strict();
export const housingAffordabilityResolutionSchema: z.ZodType<HousingAffordabilityResolution> =
  z
    .object({
      methodVersion: z.literal(HOUSING_AFFORDABILITY_METHOD_VERSION),
      scenarioId: id,
      scenarioRevision: z.number().int().nonnegative(),
      inputHash: hash,
      status: z.enum(["ready", "incomplete", "stale", "unavailable"]),
      reviewState: z.enum(["current", "stale", "missing", "invalid"]),
      baseline: sideSchema,
      proposal: sideSchema,
      delta: limitRecord(z.number().int().nullable()),
      notes: z.array(text).max(100),
    })
    .strict();
