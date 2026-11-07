import { z } from "zod";
import type { Place, Project, Scenario, Source } from "./index";
import { materializeRoads } from "./index";
import { projectWithImportVersion } from "./import-metadata";
import {
  TRAFFIC_METHOD_VERSION,
  type TrafficPairRecipe,
  type TrafficComparison,
  type TrafficCalibrationPlan,
  type TrafficCalibrationGroup,
  type TrafficRunDiagnostics,
  type TrafficOverlay,
  type TrafficFileReference,
  type TrafficNetwork,
  type TrafficRunSummary,
} from "./traffic";
import {
  trafficContentHash,
  trafficPairRecipeHash,
  trafficPairRecipeSchema,
  trafficOverlaySchema,
  trafficSourceSchema,
  trafficFileReferenceSchema,
} from "./traffic-validation";
import {
  trafficPlanningRoadMappingSchema,
  type TrafficPlanningRoadMapping,
} from "./traffic-planning";
import {
  MAX_TRAFFIC_SIGNAL_TIMINGS,
  TRAFFIC_SIGNAL_SCOPE_NOTES,
  trafficCapturedSignalTimingSchema,
  verifyTrafficCapturedSignalTiming,
  type TrafficCapturedSignalTiming,
} from "./traffic-signals";
import {
  trafficCommuteSummarySchema,
  verifyTrafficCommuteSummary,
  type TrafficCommuteSummary,
} from "./traffic-commute-evidence";

export const MAX_TRAFFIC_CAPTURE_BYTES = 256 * 1024;
export interface TrafficCapturedCalibration {
  status: "passed" | "failed" | "incomplete";
  scope: "interval-count-fit";
  calibration: TrafficCalibrationGroup;
  holdout: TrafficCalibrationGroup;
  criteria: TrafficCalibrationPlan["criteria"];
  criteriaSourceIds: string[];
  criteriaDescription: string;
  /** Hash of exact ordered calibration and holdout observation IDs; detailed rows remain archived. */
  selectionHash: string;
  notes: string[];
}
export interface TrafficReviewedRoadLink {
  roadId: string;
  /** Canonical hash of the complete materialized road, or its explicit null removal tombstone. */
  roadEditHash: string;
  edgeIds: string[];
  representedProperties: ("lanes" | "speed" | "closure")[];
  reviewedBy: string;
  reviewedAt: string;
}
export interface TrafficCapture {
  capturedAt: string;
  methodVersion: typeof TRAFFIC_METHOD_VERSION;
  analysisScope: "explicit-network-experiment";
  privateArchive: { sha256: string; bytes: number; fileCount: number };
  recipe: TrafficPairRecipe;
  comparison: TrafficComparison;
  /** Null means not assessed; no acceptance criteria or held-out evidence were supplied. */
  calibration: TrafficCapturedCalibration | null;
  runs: Record<
    "baseline" | "proposal",
    {
      diagnostics: TrafficRunDiagnostics;
      assignedRoutesHash: string;
    }
  >;
  network: {
    id: string;
    engine: TrafficNetwork["manifest"]["engine"];
    baselineFileSha256: string;
    proposalFileSha256: string;
    bounds: [number, number, number, number];
    sourceFiles: TrafficFileReference[];
    conversion: TrafficNetwork["manifest"]["conversion"];
    notes: string[];
  };
  originalDemand: {
    hash: string;
    vehicleCount: number;
    description: string;
    sourceIds: string[];
    /** Exact source-derived compilation; absent for authored/explicitly detached demand. */
    commute?: TrafficCommuteSummary;
  };
  countEvidence: {
    packHash: string;
    mappedCountCount: number;
    unmappedCountCount: number;
    selectionHash: string | null;
    sourceIds: string[];
  };
  proposal: {
    overlays: TrafficOverlay[];
    /** Optional native timing evidence; never backfilled into legacy captures. */
    signalTimings?: TrafficCapturedSignalTiming[];
    planningRoadMapping: {
      status: "explicitly-reviewed" | "unmapped";
      reviewedLinks: TrafficReviewedRoadLink[];
      unrepresentedRoadIds: string[];
      notes: string[];
      /** Optional richer per-property/extent review. Absent on legacy captures; never backfilled. */
      correspondence?: TrafficPlanningRoadMapping;
    };
  };
  /** Self-contained citations, never merged into the planning source namespace. */
  sources: Source[];
  files: TrafficFileReference[];
  notes: string[];
}
export interface TrafficScenario {
  version: 1;
  origin: "server-run" | "imported";
  binding: { placeId: string; baselineHash: string; roadEditsHash: string };
  /** A lookup reference, not proof that caller-supplied output was executed or verified. */
  receipt: { projectId: string; jobId: string; captureId: string };
  captureHash: string;
  capture: TrafficCapture;
}
export const TRAFFIC_CAPTURE_SCOPE_NOTES = [
  "This is an explicit network experiment with entered vehicle demand and native edge controls, not a simulation of every planning edit.",
  "Building, population, employment and horizon changes do not automatically alter the captured traffic demand.",
  "Planning roads affect this run only through the retained reviewed road-to-native-edge/property correspondences. Unmapped geometry, turns and signals are not represented.",
  "Simulation time loss is not intersection control delay or a level-of-service grade. Count fit alone does not validate travel times or queues.",
] as const;
const id = z
    .string()
    .min(1)
    .max(240)
    .regex(/^[^\s<>"'&\u0000-\u001f]+$/u),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().max(10000),
  notes = z.array(text).max(1000),
  amount = z.number().finite().nonnegative(),
  count = amount.int().max(Number.MAX_SAFE_INTEGER),
  date = z.iso.datetime({ offset: true }),
  sourceIds = z.array(id).min(1).max(5000),
  nullable = amount.nullable();
const measures = {
  meanTravelTimeSeconds: nullable,
  meanTimeLossSeconds: nullable,
  meanDepartureDelaySeconds: nullable,
  vehicleKilometers: nullable,
  vehicleHours: nullable,
};
const measureKeys = Object.keys(measures) as (keyof typeof measures)[];
export const trafficRunSummarySchema: z.ZodType<TrafficRunSummary> = z
  .object({
    status: z.enum(["complete", "incomplete", "failed"]),
    requested: count,
    completed: count,
    incomplete: count,
    completionFraction: z.number().min(0).max(1).nullable(),
    measurementRequested: count.nullable(),
    measurementCompleted: count,
    ...measures,
    completedSubtotal: z.object(measures).strict(),
    reasons: notes,
    notes,
  })
  .strict()
  .superRefine((v, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    if (
      v.completed > v.requested ||
      v.incomplete !== v.requested - v.completed ||
      v.completionFraction !== (v.requested ? v.completed / v.requested : null)
    )
      fail("Traffic completion counts and fraction disagree.");
    if (
      v.measurementCompleted > v.completed ||
      (v.measurementRequested !== null &&
        (v.measurementCompleted > v.measurementRequested ||
          v.measurementRequested > v.requested))
    )
      fail("Traffic measurement cohort exceeds admitted vehicles.");
    if (
      v.status === "complete" &&
      (v.incomplete !== 0 ||
        v.measurementRequested === null ||
        v.measurementRequested !== v.measurementCompleted)
    )
      fail("A complete run cannot omit requested measurement trips.");
    for (const key of measureKeys)
      if (
        v[key] !== (v.status === "complete" ? v.completedSubtotal[key] : null)
      )
        fail(
          "Incomplete traffic runs must withhold full metrics and preserve separately labeled completed subtotals.",
        );
    if (
      v.measurementCompleted === 0 &&
      [
        v.completedSubtotal.meanTravelTimeSeconds,
        v.completedSubtotal.meanTimeLossSeconds,
        v.completedSubtotal.meanDepartureDelaySeconds,
      ].some((n) => n !== null)
    )
      fail("An empty completed cohort cannot have an average.");
  });
const calibrationGroup = z
  .object({
    requested: count,
    evaluated: count,
    unavailable: count,
    passed: count,
    passingFraction: z.number().min(0).max(1).nullable(),
    status: z.enum(["passed", "failed", "incomplete"]),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.evaluated > v.requested ||
      v.unavailable !== v.requested - v.evaluated ||
      v.passed > v.evaluated ||
      v.passingFraction !== (v.evaluated ? v.passed / v.evaluated : null)
    )
      c.addIssue({
        code: "custom",
        message: "Calibration group totals and fractions disagree.",
      });
  });
const criteria = z
  .object({
    gehMaximum: amount,
    absoluteHourlyErrorMaximum: amount,
    relativeErrorMaximum: amount,
    requiredPassingFraction: z.number().min(0).max(1),
    minimumCalibrationCounts: count.min(1),
    minimumHoldoutCounts: count.min(1),
  })
  .strict();
const calibrationSchema = z
  .object({
    status: z.enum(["passed", "failed", "incomplete"]),
    scope: z.literal("interval-count-fit"),
    calibration: calibrationGroup,
    holdout: calibrationGroup,
    criteria,
    criteriaSourceIds: sourceIds,
    criteriaDescription: text,
    selectionHash: sha,
    notes,
  })
  .strict()
  .superRefine((v, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    for (const [group, minimum] of [
      [v.calibration, v.criteria.minimumCalibrationCounts],
      [v.holdout, v.criteria.minimumHoldoutCounts],
    ] as const) {
      const expected =
        group.evaluated < minimum || group.unavailable > 0
          ? "incomplete"
          : group.passingFraction! >= v.criteria.requiredPassingFraction
            ? "passed"
            : "failed";
      if (group.status !== expected)
        fail(
          "Calibration status does not match retained count coverage and acceptance criteria.",
        );
    }
    const expected =
      v.calibration.status === "failed" || v.holdout.status === "failed"
        ? "failed"
        : v.calibration.status === "passed" && v.holdout.status === "passed"
          ? "passed"
          : "incomplete";
    if (v.status !== expected)
      fail(
        "Combined calibration status disagrees with training and held-out evidence.",
      );
  });
const diagnostics = z
  .object({
    requested: count,
    loaded: count,
    inserted: count,
    arrived: count,
    running: count,
    waiting: count,
    discarded: count,
    teleports: count,
    collisions: count,
    routeErrors: count,
  })
  .strict();
const comparisonSchema = z
  .object({
    methodVersion: z.literal(TRAFFIC_METHOD_VERSION),
    recipeHash: sha,
    baseline: trafficRunSummarySchema,
    proposal: trafficRunSummarySchema,
    delta: z
      .object(
        Object.fromEntries(
          measureKeys.map((k) => [k, z.number().finite().nullable()]),
        ) as Record<keyof typeof measures, z.ZodNullable<z.ZodNumber>>,
      )
      .strict(),
    notes,
  })
  .strict()
  .superRefine((v, c) => {
    for (const key of measureKeys) {
      const expected =
        v.baseline[key] === null || v.proposal[key] === null
          ? null
          : v.proposal[key]! - v.baseline[key]!;
      if (v.delta[key] !== expected)
        c.addIssue({
          code: "custom",
          message:
            "Traffic deltas must use the retained complete paired values, not partial subtotals.",
        });
    }
  });
const link = z
  .object({
    roadId: id,
    roadEditHash: sha,
    edgeIds: z.array(id).min(1).max(1000),
    representedProperties: z
      .array(z.enum(["lanes", "speed", "closure"]))
      .min(1)
      .max(3),
    reviewedBy: z.string().min(1).max(240),
    reviewedAt: date,
  })
  .strict();
const archiveFile = trafficFileReferenceSchema.refine(
  (v) => /^(https?:\/\/|urn:)/.test(v.url),
  "Traffic file references must be public HTTP(S) citations or opaque URNs, never filesystem paths.",
);
export const trafficCaptureSchema: z.ZodType<TrafficCapture> = z
  .object({
    capturedAt: date,
    methodVersion: z.literal(TRAFFIC_METHOD_VERSION),
    analysisScope: z.literal("explicit-network-experiment"),
    privateArchive: z
      .object({
        sha256: sha,
        bytes: count.positive(),
        fileCount: count.positive(),
      })
      .strict(),
    recipe: trafficPairRecipeSchema,
    comparison: comparisonSchema,
    calibration: calibrationSchema.nullable(),
    runs: z
      .object({
        baseline: z.object({ diagnostics, assignedRoutesHash: sha }).strict(),
        proposal: z.object({ diagnostics, assignedRoutesHash: sha }).strict(),
      })
      .strict(),
    network: z
      .object({
        id,
        engine: z
          .object({
            name: z.literal("sumo"),
            version: z.string().min(1).max(100),
            imageDigest: z.string().min(1).max(500),
          })
          .strict(),
        baselineFileSha256: sha,
        proposalFileSha256: sha,
        bounds: z.tuple([
          z.number().min(-180).max(180),
          z.number().min(-90).max(90),
          z.number().min(-180).max(180),
          z.number().min(-90).max(90),
        ]),
        sourceFiles: z.array(archiveFile).max(1000),
        conversion: z
          .object({
            version: z.string().min(1).max(100),
            options: z.array(text).max(1000),
            warnings: notes,
          })
          .strict(),
        notes,
      })
      .strict(),
    originalDemand: z
      .object({
        hash: sha,
        vehicleCount: count,
        description: text,
        sourceIds,
        commute: trafficCommuteSummarySchema.optional(),
      })
      .strict(),
    countEvidence: z
      .object({
        packHash: sha,
        mappedCountCount: count,
        unmappedCountCount: count,
        selectionHash: sha.nullable(),
        sourceIds,
      })
      .strict(),
    proposal: z
      .object({
        overlays: z.array(trafficOverlaySchema).max(10000),
        signalTimings: z
          .array(trafficCapturedSignalTimingSchema)
          .max(MAX_TRAFFIC_SIGNAL_TIMINGS)
          .optional(),
        planningRoadMapping: z
          .object({
            status: z.enum(["explicitly-reviewed", "unmapped"]),
            reviewedLinks: z.array(link).max(5000),
            unrepresentedRoadIds: z.array(id).max(10000),
            notes,
            correspondence: trafficPlanningRoadMappingSchema.optional(),
          })
          .strict(),
      })
      .strict(),
    sources: z.array(trafficSourceSchema).min(1).max(5000),
    files: z.array(archiveFile).max(5000),
    notes,
  })
  .strict()
  .superRefine((v, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    if (
      v.recipe.methodVersion !== TRAFFIC_METHOD_VERSION ||
      v.network.baselineFileSha256 !== v.recipe.baselineNetworkHash ||
      v.network.proposalFileSha256 !== v.recipe.proposalNetworkHash ||
      v.originalDemand.hash !== v.recipe.demandHash ||
      v.countEvidence.packHash !== v.recipe.countPackHash ||
      v.countEvidence.selectionHash !== (v.calibration?.selectionHash ?? null)
    )
      fail(
        "Captured traffic inputs do not match the paired recipe identities.",
      );
    if (
      v.network.bounds[0] >= v.network.bounds[2] ||
      v.network.bounds[1] >= v.network.bounds[3]
    )
      fail("Traffic network extent must have positive area.");
    const allIds = v.sources.map((s) => s.id),
      inventory = new Set(allIds);
    if (inventory.size !== allIds.length)
      fail("Traffic source identities must be unique inside the capture.");
    const references = [
      ...v.originalDemand.sourceIds,
      ...v.countEvidence.sourceIds,
      ...(v.calibration?.criteriaSourceIds ?? []),
      ...v.files.map((f) => f.sourceId),
      ...v.network.sourceFiles.map((f) => f.sourceId),
      ...(v.proposal.signalTimings ?? []).flatMap((t) => [
        ...t.baseline.sourceIds,
        ...t.proposal.sourceIds,
      ]),
    ];
    if (references.some((s) => !inventory.has(s)))
      fail("Traffic evidence references an absent captured source.");
    const commute = v.originalDemand.commute;
    if (
      commute &&
      (commute.binding.demandHash !== v.originalDemand.hash ||
        commute.binding.networkHash !== v.network.baselineFileSha256 ||
        commute.totals.vehicles !== v.originalDemand.vehicleCount ||
        JSON.stringify(commute.recipe.period) !==
          JSON.stringify(v.recipe.period))
    )
      fail(
        "Source-derived commute evidence differs from the actual paired demand, period or baseline graph.",
      );
    if (
      commute &&
      commute.sources.some((source) => {
        const captured = v.sources.find((s) => s.id === source.id);
        // Both objects were parsed through the same ordered Source fields. No same-ID overwrite is allowed.
        return !captured || JSON.stringify(captured) !== JSON.stringify(source);
      })
    )
      fail(
        "Original commute source citations and permissions must remain exact in the captured demand inventory.",
      );
    if (v.proposal.signalTimings?.length) {
      if (
        new Set(v.proposal.signalTimings.map((t) => t.control.signalId))
          .size !== v.proposal.signalTimings.length
      )
        fail(
          "Captured signal timings must identify unique native controllers.",
        );
      if (!TRAFFIC_SIGNAL_SCOPE_NOTES.every((note) => v.notes.includes(note)))
        fail(
          "Saved signal timing evidence must retain its native-program scope and inference disclosures.",
        );
    }
    const mappings = v.proposal.planningRoadMapping,
      roadIds = mappings.reviewedLinks.map((l) => l.roadId);
    if (mappings.correspondence) {
      const correspondence = mappings.correspondence;
      if (correspondence.networkHash !== v.network.baselineFileSha256)
        fail(
          "Planning correspondence must reference the captured baseline native graph.",
        );
      if (correspondence.reviews.length !== mappings.reviewedLinks.length)
        fail(
          "Captured road links must exactly project the retained correspondence reviews.",
        );
      for (const review of correspondence.reviews) {
        const link = mappings.reviewedLinks.find(
          (l) => l.roadId === review.roadId,
        );
        if (
          !link ||
          link.roadEditHash !== review.roadEditHash ||
          link.reviewedBy !== review.reviewedBy ||
          link.reviewedAt !== review.reviewedAt ||
          JSON.stringify(link.edgeIds) !==
            JSON.stringify(review.directions.flatMap((d) => d.edgeIds)) ||
          JSON.stringify(link.representedProperties) !==
            JSON.stringify(review.properties)
        )
          fail(
            "Captured road link metadata differs from its exact reviewed correspondence.",
          );
      }
      for (const generated of correspondence.reviews.flatMap(
        (r) => r.overlays,
      )) {
        const effective = v.proposal.overlays.find(
          (o) => o.edgeId === generated.edgeId,
        );
        if (
          !effective ||
          (["lanes", "speedMps", "closed"] as const).some(
            (key) =>
              generated[key] !== undefined && effective[key] !== generated[key],
          )
        )
          fail(
            "Captured effective controls differ from reviewed planning-derived controls.",
          );
      }
    }
    if (
      new Set(roadIds).size !== roadIds.length ||
      new Set(mappings.unrepresentedRoadIds).size !==
        mappings.unrepresentedRoadIds.length ||
      mappings.unrepresentedRoadIds.some((id) => roadIds.includes(id))
    )
      fail(
        "Each planning road correspondence must have one unambiguous reviewed or unrepresented status.",
      );
    if (
      (mappings.status === "unmapped") !==
      (mappings.reviewedLinks.length === 0)
    )
      fail(
        "Reviewed mapping status requires retained road-to-edge/property correspondence, not a label alone.",
      );
    if (
      new Set(v.proposal.overlays.map((o) => o.edgeId)).size !==
      v.proposal.overlays.length
    )
      fail("Native proposal controls must have unique edge IDs.");
    for (const l of mappings.reviewedLinks) {
      if (
        new Set(l.edgeIds).size !== l.edgeIds.length ||
        new Set(l.representedProperties).size !== l.representedProperties.length
      )
        fail("Road mappings cannot repeat edge or property identities.");
      for (const edgeId of l.edgeIds) {
        const overlay = v.proposal.overlays.find((o) => o.edgeId === edgeId);
        if (
          !overlay ||
          l.representedProperties.some(
            (p) =>
              overlay[
                p === "speed"
                  ? "speedMps"
                  : p === "closure"
                    ? "closed"
                    : "lanes"
              ] === undefined,
          )
        )
          fail(
            "A reviewed road correspondence must identify actual retained native edge/property controls.",
          );
      }
    }
    for (const side of ["baseline", "proposal"] as const) {
      const d = v.runs[side].diagnostics,
        s = v.comparison[side];
      if (
        d.requested !== v.originalDemand.vehicleCount ||
        d.requested !== s.requested ||
        d.arrived !== s.completed
      )
        fail(
          "Retained native diagnostics and paired summary demand/completion disagree.",
        );
      const invalid =
        d.loaded !== d.requested ||
        d.loaded !== d.inserted + d.waiting ||
        d.inserted !== d.arrived + d.running + d.discarded ||
        d.teleports > 0 ||
        d.collisions > 0 ||
        d.routeErrors > 0 ||
        d.discarded > 0;
      if (invalid && s.status !== "failed")
        fail(
          "Broken conservation, teleports, collisions or route failures cannot produce a qualified summary.",
        );
      if ((d.running > 0 || d.waiting > 0) && s.status === "complete")
        fail(
          "Running or uninserted vehicles require incomplete traffic results.",
        );
    }
    if (
      v.calibration &&
      v.calibration.calibration.requested + v.calibration.holdout.requested >
        v.countEvidence.mappedCountCount + v.countEvidence.unmappedCountCount
    )
      fail("Selected count evidence exceeds the retained observations.");
    if (
      v.calibration &&
      v.calibration.calibration.evaluated + v.calibration.holdout.evaluated >
        v.countEvidence.mappedCountCount
    )
      fail(
        "Evaluated count evidence exceeds the retained mapped observations.",
      );
    if (!TRAFFIC_CAPTURE_SCOPE_NOTES.every((note) => v.notes.includes(note)))
      fail(
        "Saved traffic evidence must retain its explicit experiment and interpretation disclosures.",
      );
  });
export const trafficScenarioSchema: z.ZodType<TrafficScenario> = z
  .object({
    version: z.literal(1),
    origin: z.enum(["server-run", "imported"]),
    binding: z
      .object({ placeId: id, baselineHash: sha, roadEditsHash: sha })
      .strict(),
    receipt: z.object({ projectId: id, jobId: id, captureId: id }).strict(),
    captureHash: sha,
    capture: trafficCaptureSchema,
  })
  .strict()
  .superRefine((v, c) => {
    if (
      new TextEncoder().encode(JSON.stringify(v)).byteLength >
      MAX_TRAFFIC_CAPTURE_BYTES
    )
      c.addIssue({
        code: "custom",
        message:
          "Saved traffic evidence exceeds 256 KiB; retain detailed rows in the immutable archive instead of truncating them.",
      });
  });
export function assertTrafficScenario(value: TrafficScenario): void {
  trafficScenarioSchema.parse(value);
}
export async function trafficRoadEditsHash(
  place: Place,
  scenario: Scenario,
): Promise<string> {
  return trafficContentHash(
    [...materializeRoads(place, scenario)].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
  );
}
/** Integrity is distinct from server authority; the API must separately authorize the immutable receipt. */
export async function verifyTrafficScenario(
  value: TrafficScenario,
  place: Place,
  knownBaselineHash?: string,
): Promise<void> {
  assertTrafficScenario(value);
  if (
    value.binding.placeId !== place.id ||
    (knownBaselineHash ?? (await trafficContentHash(place))) !==
      value.binding.baselineHash
  )
    throw new Error(
      "Traffic evidence belongs to a different immutable planning baseline.",
    );
  const correspondence =
    value.capture.proposal.planningRoadMapping.correspondence;
  if (
    correspondence &&
    (correspondence.baselineHash !== value.binding.baselineHash ||
      correspondence.roadEditsHash !== value.binding.roadEditsHash)
  )
    throw new Error(
      "Planning correspondence bindings differ from the retained scenario capture.",
    );
  if ((await trafficContentHash(value.capture)) !== value.captureHash)
    throw new Error(
      "Traffic capture content does not match its retained hash.",
    );
  if (
    (await trafficPairRecipeHash(value.capture.recipe)) !==
    value.capture.comparison.recipeHash
  )
    throw new Error(
      "Traffic comparison does not match the captured paired recipe.",
    );
  for (const timing of value.capture.proposal.signalTimings ?? [])
    await verifyTrafficCapturedSignalTiming(timing);
  if (value.capture.originalDemand.commute)
    await verifyTrafficCommuteSummary(value.capture.originalDemand.commute);
}
export async function trafficPlanningRoadHash(
  place: Place,
  scenario: Scenario,
  roadId: string,
): Promise<string> {
  const road = materializeRoads(place, scenario).find((r) => r.id === roadId);
  if (road) return trafficContentHash(road);
  if (
    Object.hasOwn(scenario.roadEdits, roadId) &&
    scenario.roadEdits[roadId] === null &&
    place.roads.some((r) => r.id === roadId)
  )
    return trafficContentHash(null);
  throw new Error(
    "The reviewed planning road has no captured or proposed identity.",
  );
}
export async function createTrafficScenario(input: {
  place: Place;
  scenario: Scenario;
  receipt: TrafficScenario["receipt"];
  capture: TrafficCapture;
  origin?: TrafficScenario["origin"];
}): Promise<TrafficScenario> {
  if (input.scenario.id === "baseline")
    throw new Error(
      "Traffic experiments cannot replace the immutable baseline.",
    );
  const capture = structuredClone(input.capture);
  capture.notes = [
    ...new Set([
      ...capture.notes,
      ...TRAFFIC_CAPTURE_SCOPE_NOTES,
      ...(capture.proposal.signalTimings?.length
        ? TRAFFIC_SIGNAL_SCOPE_NOTES
        : []),
    ]),
  ];
  const correspondence = capture.proposal.planningRoadMapping.correspondence;
  if (
    correspondence &&
    (correspondence.baselineHash !== (await trafficContentHash(input.place)) ||
      correspondence.roadEditsHash !==
        (await trafficRoadEditsHash(input.place, input.scenario)))
  )
    throw new Error(
      "Planning correspondence is stale for the current baseline or planning roads.",
    );
  for (const l of capture.proposal.planningRoadMapping.reviewedLinks) {
    if (
      (await trafficPlanningRoadHash(input.place, input.scenario, l.roadId)) !==
      l.roadEditHash
    )
      throw new Error(
        "A reviewed traffic correspondence does not match the current complete planning road.",
      );
    if (
      input.scenario.roadEdits[l.roadId] === null &&
      (l.representedProperties.some((p) => p !== "closure") ||
        l.edgeIds.some(
          (id) =>
            capture.proposal.overlays.find((o) => o.edgeId === id)?.closed !==
            true,
        ))
    )
      throw new Error(
        "A removed planning road can map only to an explicit native closure.",
      );
  }
  const value: TrafficScenario = {
    version: 1,
    origin: input.origin ?? "server-run",
    binding: {
      placeId: input.place.id,
      baselineHash: await trafficContentHash(input.place),
      roadEditsHash: await trafficRoadEditsHash(input.place, input.scenario),
    },
    receipt: structuredClone(input.receipt),
    captureHash: await trafficContentHash(capture),
    capture,
  };
  await verifyTrafficScenario(value, input.place);
  return value;
}
export async function trafficScenarioStatus(
  value: TrafficScenario,
  place: Place,
  scenario: Scenario,
): Promise<{
  stale: boolean;
  origin: TrafficScenario["origin"];
  notes: string[];
}> {
  await verifyTrafficScenario(value, place);
  const stale =
    (await trafficRoadEditsHash(place, scenario)) !==
    value.binding.roadEditsHash;
  return {
    stale,
    origin: value.origin,
    notes: [
      ...(stale
        ? [
            "Planning roads or controls changed after this experiment. Retained results describe the captured inputs, not the current road scenario.",
          ]
        : []),
      ...(value.origin === "imported"
        ? [
            "Imported capture; its receipt and hashes are retained evidence, not server verification.",
          ]
        : []),
      ...TRAFFIC_CAPTURE_SCOPE_NOTES,
    ],
  };
}
export function projectWithTrafficVersion(
  project: Project,
  place?: Place,
): Project {
  const upgraded = projectWithImportVersion(project, place);
  if (upgraded.schemaVersion >= 9) return upgraded;
  const entries = [...project.history, ...project.undone];
  return [
    ...project.scenarios,
    ...entries.flatMap((e) => [e.before, e.after]),
  ].some((s) => s.traffic !== undefined) ||
    entries.some((e) => e.command.type === "scenario.traffic")
    ? { ...upgraded, schemaVersion: 9 }
    : upgraded;
}
export function projectWithImportedTraffic(project: Project): Project {
  const has =
    [
      ...project.scenarios,
      ...[...project.history, ...project.undone].flatMap((e) => [
        e.before,
        e.after,
      ]),
    ].some((s) => s.traffic !== undefined) ||
    [...project.history, ...project.undone].some(
      (e) =>
        e.command.type === "scenario.traffic" && e.command.traffic !== null,
    );
  if (!has) return project;
  const copy = structuredClone(project);
  for (const s of [
    ...copy.scenarios,
    ...[...copy.history, ...copy.undone].flatMap((e) => [e.before, e.after]),
  ])
    if (s.traffic) s.traffic.origin = "imported";
  for (const e of [...copy.history, ...copy.undone])
    if (e.command.type === "scenario.traffic" && e.command.traffic)
      e.command.traffic.origin = "imported";
  return copy;
}
