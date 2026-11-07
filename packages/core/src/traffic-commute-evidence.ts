import { z } from "zod";
import type { Source } from "./index";
import type { TrafficDemand, TrafficNetwork, TrafficPeriod } from "./traffic";
import { trafficContentHash, validateTrafficClock } from "./traffic-validation";
import {
  TRAFFIC_COMMUTE_METHOD_VERSION,
  trafficCommuteRecipeSchema,
  trafficCommuteSourceSchema,
  trafficCommuteSourceFileSchema,
  validateTrafficCommuteRecipe,
  type TrafficCommutePrior,
  type TrafficCommuteRecipe,
  type TrafficCommuteSourcePack,
  type TrafficCommuteSourceFile,
  type TrafficCommuteRouteAttachment,
} from "./traffic-commute";

/** Immutable preset identity. These hashes establish integrity, not server authority. */
export interface TrafficCommuteBinding {
  version: 1;
  presetId: string;
  /** SHA-256 of the retained exact operator manifest bytes, not its reserialized JSON. */
  assetHash: string;
  sourcePackHash: string;
  priorHash: string;
  routesHash: string;
  compilationHash: string;
  demandHash: string;
  periodHash: string;
  networkHash: string;
  inventoryHash: string;
}
export interface TrafficCommuteCoverage {
  status: "complete-for-declared-cohort" | "partial";
  selectedNativeFlows: number;
  routeStatusCounts: Record<TrafficCommuteRouteAttachment["status"], number>;
  unknownEstimateCells: number;
  unresolvedAllocationCells: number;
  externalOriginPrimaryJobs: number;
}
export interface TrafficCommuteTotals {
  sourceVehicles: number | null;
  knownSourceVehicles: number | null;
  knownUnresolvedSourceVehicles: number;
  unresolvedRouteVehicles: number;
  noLocalIntersectionVehicles: number;
  beforeWindowVehicles: number;
  afterWindowVehicles: number;
  admittedExpectedVehicles: number;
  warmupExpectedVehicles: number;
  measurementExpectedVehicles: number;
  vehicles: number;
  roundingDelta: number;
  conservationResidual: number | null;
}
export interface TrafficCommuteSampling {
  knownEstimateSubtotal: number | null;
  estimate: number | null;
  conditionalSamplingMoe: number | null;
  missingEstimateCells: string[];
  missingMoeCells: string[];
  notes: string[];
}
/** Compact projection only; the complete fractional ledger remains in the private archive. */
export interface TrafficCommuteSummary {
  version: 1;
  methodVersion: typeof TRAFFIC_COMMUTE_METHOD_VERSION;
  binding: TrafficCommuteBinding;
  routing: {
    regionalGraphHash: string;
    regionalSettingsHash: string;
    localNetworkHash: string;
    localInventoryHash: string;
  };
  recipe: TrafficCommuteRecipe;
  sourceScope: Pick<TrafficCommuteSourcePack, "lodes" | "acs" | "coverage">;
  priorCoverage: TrafficCommutePrior["coverage"];
  coverage: TrafficCommuteCoverage;
  totals: TrafficCommuteTotals;
  conditionalAcsSampling: TrafficCommuteSampling;
  /** This namespace retains the original citations and rights without planning-source merges. */
  sources: Source[];
  files: TrafficCommuteSourceFile[];
  notes: string[];
}

export const MAX_TRAFFIC_COMMUTE_SUMMARY_BYTES = 64 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^\s<>"'&\u0000-\u001f]+$/u);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
const text = z.string().max(4000);
const notes = z.array(text).max(1000);
const tract = z.string().regex(/^\d{11}$/);
const cell = z.string().regex(/^\d{11}:B08132_\d{3}$/);
const safeUrl = (value: string) =>
  value === "" || /^(https?:\/\/|urn:)/.test(value);
const close = (a: number, b: number) =>
  Math.abs(a - b) <=
  64 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

export const trafficCommuteBindingSchema: z.ZodType<TrafficCommuteBinding> = z
  .object({
    version: z.literal(1),
    presetId: id,
    assetHash: sha,
    sourcePackHash: sha,
    priorHash: sha,
    routesHash: sha,
    compilationHash: sha,
    demandHash: sha,
    periodHash: sha,
    networkHash: sha,
    inventoryHash: sha,
  })
  .strict();
export const trafficCommuteSummarySchema: z.ZodType<TrafficCommuteSummary> = z
  .object({
    version: z.literal(1),
    methodVersion: z.literal(TRAFFIC_COMMUTE_METHOD_VERSION),
    binding: trafficCommuteBindingSchema,
    routing: z
      .object({
        regionalGraphHash: sha,
        regionalSettingsHash: sha,
        localNetworkHash: sha,
        localInventoryHash: sha,
      })
      .strict(),
    recipe: trafficCommuteRecipeSchema,
    sourceScope: z
      .object({
        lodes: z
          .object({
            dataYear: z.literal(2023),
            jobType: z.literal("JT01"),
            blockVintage: z.literal("2020"),
            formatVersion: text,
            dataVintage: text,
          })
          .strict(),
        acs: z
          .object({
            dataset: z.literal("acs/acs5"),
            vintage: z.literal(2024),
            period: z
              .object({ start: z.literal(2020), end: z.literal(2024) })
              .strict(),
            table: z.literal("B08132"),
            geography: z.literal("tract"),
            boundaryVintage: z.literal("2024"),
            confidenceLevel: z.literal(90),
          })
          .strict(),
        coverage: z
          .object({
            stateFips: z.string().regex(/^\d{2}$/),
            label: text,
            residentTractGeoids: z.array(tract).min(1).max(500),
            rac: z.enum(["complete-for-declared-tracts", "partial"]),
            odMain: z.enum(["complete-for-declared-tracts", "partial"]),
            notes,
          })
          .strict(),
      })
      .strict(),
    priorCoverage: z
      .object({
        selectedTracts: count,
        unknownEstimateCells: count,
        unavailableMoeCells: count,
        unresolvedAllocationCells: count,
        externalOriginPrimaryJobs: count,
        externalOriginFlowCount: count,
        unselectedResidentPrimaryJobs: count,
        ambiguousResidentPrimaryJobs: count,
      })
      .strict(),
    coverage: z
      .object({
        status: z.enum(["complete-for-declared-cohort", "partial"]),
        selectedNativeFlows: count,
        routeStatusCounts: z
          .object({
            routed: count,
            "no-local-intersection": count,
            unreachable: count,
            unsnappable: count,
            "outside-coverage": count,
            "unmatched-local-network": count,
            "reentry-unsupported": count,
          })
          .strict(),
        unknownEstimateCells: count,
        unresolvedAllocationCells: count,
        externalOriginPrimaryJobs: count,
      })
      .strict(),
    totals: z
      .object({
        sourceVehicles: amount.nullable(),
        knownSourceVehicles: amount.nullable(),
        knownUnresolvedSourceVehicles: amount,
        unresolvedRouteVehicles: amount,
        noLocalIntersectionVehicles: amount,
        beforeWindowVehicles: amount,
        afterWindowVehicles: amount,
        admittedExpectedVehicles: amount,
        warmupExpectedVehicles: amount,
        measurementExpectedVehicles: amount,
        vehicles: count.max(30000),
        roundingDelta: z.number().finite(),
        conservationResidual: z.number().finite().nullable(),
      })
      .strict(),
    conditionalAcsSampling: z
      .object({
        knownEstimateSubtotal: amount.nullable(),
        estimate: amount.nullable(),
        conditionalSamplingMoe: amount.nullable(),
        missingEstimateCells: z.array(cell).max(7000),
        missingMoeCells: z.array(cell).max(7000),
        notes,
      })
      .strict(),
    sources: z
      .array(
        trafficCommuteSourceSchema.refine(
          (s) => safeUrl(s.url),
          "Use a public citation or opaque URN, never a private path",
        ),
      )
      .min(1)
      .max(100),
    files: z
      .array(
        trafficCommuteSourceFileSchema.refine(
          (f) => safeUrl(f.url),
          "Use a public citation or opaque URN, never a private path",
        ),
      )
      .min(1)
      .max(100),
    notes,
  })
  .strict()
  .superRefine((v, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    const {
      totals: t,
      coverage: k,
      priorCoverage: p,
      conditionalAcsSampling: m,
    } = v;
    if (
      v.routing.localNetworkHash !== v.binding.networkHash ||
      v.routing.localInventoryHash !== v.binding.inventoryHash
    )
      fail(
        "Retained regional-to-local routing evidence differs from the compilation network binding.",
      );
    if (
      new TextEncoder().encode(JSON.stringify(v)).byteLength >
      MAX_TRAFFIC_COMMUTE_SUMMARY_BYTES
    )
      fail(
        "Compact commute evidence exceeds 64 KiB. Reduce the declared cohort; never truncate its ledger or citations.",
      );
    if (
      !unique(v.sources.map((s) => s.id)) ||
      !unique(v.files.map((f) => f.sha256))
    )
      fail("Commute sources and original files must have unique identities.");
    const sourceIds = new Set(v.sources.map((s) => s.id));
    if (
      [...v.recipe.sourceIds, ...v.files.map((f) => f.sourceId)].some(
        (id) => !sourceIds.has(id),
      )
    )
      fail("Commute evidence references an absent original source.");
    if (
      !unique(v.recipe.originTractGeoids) ||
      !unique(v.recipe.departureCellIds) ||
      !unique(v.recipe.homeClocks.map((h) => h.tractGeoid)) ||
      !unique(v.sourceScope.coverage.residentTractGeoids) ||
      v.recipe.homeClocks.length !== v.recipe.originTractGeoids.length ||
      v.recipe.homeClocks.some(
        (h) => !v.recipe.originTractGeoids.includes(h.tractGeoid),
      ) ||
      v.recipe.originTractGeoids.some(
        (g) => !v.sourceScope.coverage.residentTractGeoids.includes(g),
      ) ||
      p.selectedTracts !== v.recipe.originTractGeoids.length
    )
      fail(
        "Commute scope, selected tracts and home clocks must agree exactly.",
      );
    try {
      validateTrafficCommuteRecipe(v.recipe);
      validateTrafficClock(v.recipe.period);
    } catch {
      fail("Commute clocks must retain the validated fixed-offset source day.");
    }
    if (
      Object.values(k.routeStatusCounts).reduce((a, b) => a + b, 0) !==
        k.selectedNativeFlows ||
      k.unknownEstimateCells !== p.unknownEstimateCells ||
      k.unresolvedAllocationCells !== p.unresolvedAllocationCells ||
      k.externalOriginPrimaryJobs !== p.externalOriginPrimaryJobs
    )
      fail(
        "Commute coverage counters do not reconcile with retained native flows and source coverage.",
      );
    const nativeCells =
      v.recipe.originTractGeoids.length * v.recipe.departureCellIds.length;
    if (
      p.unknownEstimateCells + p.unresolvedAllocationCells > nativeCells ||
      p.unavailableMoeCells > nativeCells
    )
      fail(
        "Commute source coverage cannot exceed the selected native ACS cells.",
      );
    const partial = !!(
      k.unknownEstimateCells ||
      k.unresolvedAllocationCells ||
      t.unresolvedRouteVehicles > 0
    );
    if (k.status !== (partial ? "partial" : "complete-for-declared-cohort"))
      fail("Unresolved commute evidence cannot be labeled complete.");
    if (
      k.unknownEstimateCells > 0 !== (t.sourceVehicles === null) ||
      (t.sourceVehicles !== null && t.sourceVehicles !== t.knownSourceVehicles)
    )
      fail(
        "Unknown source estimates must withhold the full count, retaining only the known subtotal.",
      );
    const accounted =
      t.knownUnresolvedSourceVehicles +
      t.unresolvedRouteVehicles +
      t.noLocalIntersectionVehicles +
      t.beforeWindowVehicles +
      t.afterWindowVehicles +
      t.admittedExpectedVehicles;
    if (
      t.knownSourceVehicles === null
        ? t.conservationResidual !== null || accounted !== 0
        : t.conservationResidual === null ||
          !close(t.knownSourceVehicles, accounted) ||
          !close(t.conservationResidual, 0)
    )
      fail(
        "The commute source subtotal must conserve across unresolved, out-of-window and admitted outcomes.",
      );
    if (
      !close(
        t.warmupExpectedVehicles + t.measurementExpectedVehicles,
        t.admittedExpectedVehicles,
      ) ||
      t.vehicles !== Math.round(t.admittedExpectedVehicles) ||
      !close(t.roundingDelta, t.vehicles - t.admittedExpectedVehicles)
    )
      fail(
        "Commute warm-up, measured mass and integer realization do not reconcile.",
      );
    if (
      !unique(m.missingEstimateCells) ||
      !unique(m.missingMoeCells) ||
      [...m.missingEstimateCells, ...m.missingMoeCells].some((key) => {
        const [geoid, cellId] = key.split(":");
        return (
          !v.recipe.originTractGeoids.includes(geoid) ||
          !v.recipe.departureCellIds.includes(cellId)
        );
      }) ||
      (m.missingEstimateCells.length > 0
        ? m.estimate !== null
        : m.estimate === null || m.estimate !== m.knownEstimateSubtotal) ||
      (m.missingEstimateCells.length > 0 || m.missingMoeCells.length > 0) !==
        (m.conditionalSamplingMoe === null)
    )
      fail(
        "Conditional ACS uncertainty must preserve missing estimates and margins separately.",
      );
  });

/** Cheap request identity checks; the private server registry must separately verify the preset. */
export async function verifyTrafficCommuteBinding(
  binding: TrafficCommuteBinding,
  input: {
    demand: TrafficDemand;
    period: TrafficPeriod;
    network: TrafficNetwork;
  },
): Promise<void> {
  trafficCommuteBindingSchema.parse(binding);
  const [demandHash, periodHash, inventoryHash] = await Promise.all([
    trafficContentHash(input.demand),
    trafficContentHash(input.period),
    trafficContentHash(input.network),
  ]);
  if (
    binding.demandHash !== demandHash ||
    binding.periodHash !== periodHash ||
    binding.networkHash !== input.network.manifest.networkFileSha256 ||
    binding.inventoryHash !== inventoryHash
  )
    throw new Error(
      "The prepared commute demand, clock or network changed. Explicitly detach it before authoring different assumptions.",
    );
}
export async function verifyTrafficCommuteSummary(
  value: TrafficCommuteSummary,
): Promise<void> {
  trafficCommuteSummarySchema.parse(value);
  if (
    (await trafficContentHash(value.recipe.period)) !== value.binding.periodHash
  )
    throw new Error(
      "The captured commute clock differs from its immutable binding.",
    );
}
