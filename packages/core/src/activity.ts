import { z } from "zod";
import type { Place, Project, Source } from "./index";
import type { StudyAreaGeometry } from "./study-area";
import {
  vehicleAvailabilitySchema,
  type VehicleAvailability,
} from "./demographics";
import { isSafeFeatureIdentifier } from "./identifiers";
import { projectWithPresentationVersion } from "./presentation";
import { validateActivityNeighborhoods } from "./activity-geometry";

export type CountTarget =
  | { mode: "absolute"; value: number }
  | { mode: "baseline-percent"; percent: number };
export type ActivityReferenceChoice =
  | { kind: "published" }
  | { kind: "building-derived" }
  | {
      kind: "entered";
      value: number;
      sourceId: string;
      asOfYear: number;
      universe: string;
    };
export type ActivityAllocation =
  "building-weighted" | "uniform-area" | "unallocated";
export interface ActivityNeighborhood {
  id: string;
  name: string;
  geometry: StudyAreaGeometry;
  population?: CountTarget;
  employment?: CountTarget;
  sourceId: string;
}
export interface ActivityDemandResponse {
  population: "none" | "proportional-residential";
  employment: "none" | "proportional-employment";
  vehicles: "none" | "replace-residential-with-stock";
  reviewed: boolean;
  sourceId: string;
}
export interface ActivityForecast {
  sourceId: string;
  geography: string;
  baseYear: number;
  targetYear: number;
  application: "matching-area-totals" | "regional-ratio";
  population?: { baseline: number; target: number };
  employment?: { baseline: number; target: number };
  householdVehicles?: { baseline: number; target: number };
}
export interface ActivityPresetProvenance {
  kind: "population-plus-25" | "regional-forecast-10" | "plant-closure";
  appliedAt: string;
  sourceId: string;
  neighborhoodId?: string;
  jobsRemoved?: number;
}
export interface ActivityScenario {
  version: 1;
  reference: {
    population: ActivityReferenceChoice;
    employment: ActivityReferenceChoice;
    vehicles?: ActivityReferenceChoice;
  };
  allocation: {
    population: ActivityAllocation;
    employment: ActivityAllocation;
  };
  global: {
    population?: CountTarget;
    employment?: CountTarget;
    householdVehicles?: CountTarget;
  };
  neighborhoods: ActivityNeighborhood[];
  demandResponse: ActivityDemandResponse;
  /** Explicitly adopted frozen supplement; the source Place remains unchanged. */
  vehicleReference?: VehicleAvailability;
  forecast?: ActivityForecast;
  preset?: ActivityPresetProvenance;
}
export const USER_ACTIVITY_SOURCE: Source = {
  id: "user-activity-scenario",
  name: "User activity scenario",
  url: "",
  vintage: "Scenario edit",
  license: "User-authored planning assumptions",
  kind: "user-supplied",
  description:
    "Entered population, workplace employment and household-vehicle targets, spatial allocation and proportional demand sensitivities. Not observed occupancy, a traffic count, a calibrated forecast or a verified regional projection.",
};
const id = z
  .string()
  .refine(
    isSafeFeatureIdentifier,
    "Use a safe identifier of at most 160 characters.",
  );
const count = z.number().finite().min(0).max(1e9);
export const countTargetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("absolute"), value: count }).strict(),
  z
    .object({
      mode: z.literal("baseline-percent"),
      percent: z.number().finite().min(0).max(10000),
    })
    .strict(),
]);
export const activityReferenceChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("published") }).strict(),
  z.object({ kind: z.literal("building-derived") }).strict(),
  z
    .object({
      kind: z.literal("entered"),
      value: count,
      sourceId: id,
      asOfYear: z.number().int().min(1900).max(2200),
      universe: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
const point = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-85).max(85),
]);
const ring = z.array(point).min(4).max(501);
const polygon = z.array(ring).min(1).max(1000);
const geometry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: polygon }).strict(),
  z
    .object({
      type: z.literal("MultiPolygon"),
      coordinates: z.array(polygon).min(1).max(1000),
    })
    .strict(),
]);
export const activityNeighborhoodSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(240),
    geometry,
    population: countTargetSchema.optional(),
    employment: countTargetSchema.optional(),
    sourceId: id,
  })
  .strict();
const allocation = z.enum(["building-weighted", "uniform-area", "unallocated"]);
const forecastCounts = z.object({ baseline: count, target: count }).strict();
export const activityForecastSchema = z
  .object({
    sourceId: id,
    geography: z.string().trim().min(1).max(500),
    baseYear: z.number().int().min(1900).max(2200),
    targetYear: z.number().int().min(1900).max(2200),
    application: z.enum(["matching-area-totals", "regional-ratio"]),
    population: forecastCounts.optional(),
    employment: forecastCounts.optional(),
    householdVehicles: forecastCounts.optional(),
  })
  .strict()
  .superRefine((f, c) => {
    if (f.targetYear <= f.baseYear)
      c.addIssue({
        code: "custom",
        message: "Forecast target year must follow its stated base year.",
      });
    if (!f.population && !f.employment && !f.householdVehicles)
      c.addIssue({
        code: "custom",
        message: "Supply at least one sourced forecast quantity.",
      });
    if (
      f.application === "regional-ratio" &&
      [f.population, f.employment, f.householdVehicles].some(
        (v) => v && v.baseline === 0,
      )
    )
      c.addIssue({
        code: "custom",
        message: "A regional growth ratio needs a positive source baseline.",
      });
  });
export const activityScenarioSchema = z
  .object({
    version: z.literal(1),
    reference: z
      .object({
        population: activityReferenceChoiceSchema,
        employment: activityReferenceChoiceSchema,
        vehicles: activityReferenceChoiceSchema.optional(),
      })
      .strict(),
    allocation: z
      .object({ population: allocation, employment: allocation })
      .strict(),
    global: z
      .object({
        population: countTargetSchema.optional(),
        employment: countTargetSchema.optional(),
        householdVehicles: countTargetSchema.optional(),
      })
      .strict(),
    neighborhoods: z.array(activityNeighborhoodSchema).max(100),
    demandResponse: z
      .object({
        population: z.enum(["none", "proportional-residential"]),
        employment: z.enum(["none", "proportional-employment"]),
        vehicles: z.enum(["none", "replace-residential-with-stock"]),
        reviewed: z.boolean(),
        sourceId: id,
      })
      .strict(),
    vehicleReference: vehicleAvailabilitySchema.optional(),
    forecast: activityForecastSchema.optional(),
    preset: z
      .object({
        kind: z.enum([
          "population-plus-25",
          "regional-forecast-10",
          "plant-closure",
        ]),
        appliedAt: z.string().datetime(),
        sourceId: id,
        neighborhoodId: id.optional(),
        jobsRemoved: count.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((a, c) => {
    if (
      new Set(a.neighborhoods.map((n) => n.id)).size !== a.neighborhoods.length
    )
      c.addIssue({
        code: "custom",
        message: "Neighborhood identifiers must be unique.",
      });
    if (a.reference.employment.kind === "published")
      c.addIssue({
        code: "custom",
        message:
          "No published workplace-employment adapter is connected; use entered or building-derived employment.",
      });
    if (a.reference.vehicles?.kind === "building-derived")
      c.addIssue({
        code: "custom",
        message:
          "Building quantities do not establish a household vehicle stock.",
      });
    if (
      !a.demandResponse.reviewed &&
      [
        a.demandResponse.population,
        a.demandResponse.employment,
        a.demandResponse.vehicles,
      ].some((v) => v !== "none")
    )
      c.addIssue({
        code: "custom",
        message:
          "Review the proportional activity-demand method before enabling a response.",
      });
    try {
      validateActivityNeighborhoods(a.neighborhoods);
    } catch (e) {
      c.addIssue({ code: "custom", message: (e as Error).message });
    }
  });
export function assertActivityScenario(
  value: unknown,
): asserts value is ActivityScenario {
  const result = activityScenarioSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid activity scenario: ${result.error.issues[0]?.message ?? "unsupported data"}`,
    );
}
export function validateActivityScenario(
  activity: ActivityScenario,
  place: Place,
  sources?: readonly Source[],
): void {
  assertActivityScenario(activity);
  validateActivityNeighborhoods(activity.neighborhoods, place);
  if (activity.vehicleReference) {
    const g = activity.vehicleReference.geography;
    if (
      place.geography?.type !== "zcta" ||
      place.geography.code !== g.id ||
      place.geography.boundaryVintage !== g.boundaryVintage ||
      place.zip !== g.id ||
      g.relationshipToStudyArea !== "same-area"
    )
      throw new Error(
        "An adopted vehicle reference must match the complete captured ZCTA boundary.",
      );
  }
  if (sources) {
    const known = new Set(
      [
        ...place.sources,
        ...sources,
        USER_ACTIVITY_SOURCE,
        ...(activity.vehicleReference
          ? [activity.vehicleReference.source]
          : []),
      ].map((s) => s.id),
    );
    const refs = [
      ...Object.values(activity.reference).flatMap((r) =>
        r?.kind === "entered" ? [r.sourceId] : [],
      ),
      ...activity.neighborhoods.map((n) => n.sourceId),
      activity.demandResponse.sourceId,
      ...(activity.forecast ? [activity.forecast.sourceId] : []),
      ...(activity.preset ? [activity.preset.sourceId] : []),
    ];
    if (refs.some((r) => !known.has(r)))
      throw new Error("Every activity input must retain a source record.");
  }
}
export function projectWithActivityVersion(
  project: Project,
  place?: Place,
): Project {
  const upgraded = projectWithPresentationVersion(project, place);
  if (upgraded.schemaVersion >= 5) return upgraded;
  const snapshots = [
    ...project.scenarios,
    ...project.history.flatMap((e) => [e.before, e.after]),
    ...project.undone.flatMap((e) => [e.before, e.after]),
  ];
  return place?.vehicleAvailability !== undefined ||
    snapshots.some((s) => s.activity !== undefined) ||
    [...project.history, ...project.undone].some(
      (e) => e.command.type === "scenario.activity",
    )
    ? { ...upgraded, schemaVersion: 5 }
    : upgraded;
}
