import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJSON,
  trafficPlanningRoadReviewInputSchema,
  type Place,
  type Scenario,
  countsFromCSV,
  parseTrafficCSV,
  trafficSourceSchema,
  trafficCountSchema,
  trafficPeriodSchema,
  validateTrafficCountPack,
  validateTrafficDemand,
  type Source,
  type TrafficCount,
  type TrafficCountPack,
  type TrafficNetwork,
} from "@urban/core";
import { reviewPlanningRequest } from "./planning-review.js";
import { inspectTrafficCalibrationSelection } from "@urban/models";
import { ApiError } from "../errors.js";
import {
  verifyPreparedCommuteRequest,
  type VerifiedTrafficCommutePreset,
} from "./commute-evidence.js";
import {
  trafficExperimentRequestSchema,
  type TrafficExperimentRequest,
} from "./experiment.js";
import type { TrafficArchive } from "./archive.js";
import type {
  TrafficConfigurationRecord,
  TrafficUploadBinding,
  TrafficUploadRecord,
} from "./jobs-types.js";

export const TRAFFIC_CONFIGURATION_BYTES = 8 * 1024 ** 2;
const id = z.string().min(1).max(160),
  key = z.string().min(8).max(160),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const column = z.number().int().min(0).max(63).optional();
const mapping = z
  .object({
    station: column,
    value: column,
    date: column,
    begin: column,
    end: column,
    longitude: column,
    latitude: column,
    direction: column,
    lane: column,
    class: column,
    record: column,
  })
  .strict();
const target = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("edge"),
      edgeId: id,
      positionFraction: z.number().min(0).max(1),
      laneIds: z.array(id).min(1).max(100).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("turn"), connectionId: id }).strict(),
]);
export const trafficConfigurationSubmissionSchema = z
  .object({
    scenarioId: id,
    preparedId: id.optional(),
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    expectedConfigurationId: id.nullable(),
    idempotencyKey: key,
    request: z.unknown(),
    sourceDeclarations: z
      .array(
        z
          .object({
            sourceId: id,
            name: z.string().trim().min(1).max(500),
            url: z.string().max(2000),
            vintage: z.string().trim().min(1).max(240),
            license: z.string().trim().min(1).max(2000),
            privateUseConfirmed: z.literal(true),
            publicRedistribution: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    uploadBindings: z
      .array(
        z
          .object({
            uploadId: id,
            sourceId: id,
            mapping,
            useAnalysisPeriod: z.boolean(),
            kind: z.enum(["observed", "factored"]),
            batchId: id,
            period: trafficPeriodSchema.optional(),
          })
          .strict(),
      )
      .max(64),
    mappingReviews: z
      .array(
        z
          .object({
            countId: id,
            target,
            networkFileSha256: hash,
            directionAgreement: z.literal("confirmed"),
          })
          .strict(),
      )
      .max(10000),
    planningSourceDeclarations: z
      .array(
        z
          .object({
            sourceId: id,
            privateUseConfirmed: z.literal(true),
            publicRedistribution: z.boolean(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    planningRoadReviews: z
      .array(trafficPlanningRoadReviewInputSchema)
      .max(500)
      .optional(),
    scopeAcknowledged: z.literal(true),
  })
  .strict();
export type TrafficConfigurationSubmission = z.infer<
  typeof trafficConfigurationSubmissionSchema
>;
const reject = (message: string): never => {
  throw new ApiError(422, "TRAFFIC_REVIEW_REQUIRED", message);
};
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
function unique<T>(
  values: T[],
  identity: (v: T) => string,
  label: string,
): Map<string, T> {
  const map = new Map(values.map((value) => [identity(value), value]));
  if (map.size !== values.length)
    reject(`Duplicate ${label} identities are not accepted.`);
  return map;
}
function countLineage(count: TrafficCount) {
  return {
    id: count.id,
    stationId: count.stationId,
    date: count.date,
    timeZone: count.timeZone,
    utcOffsetMinutes: count.utcOffsetMinutes,
    beginSeconds: count.beginSeconds,
    endSeconds: count.endSeconds,
    raw: count.raw,
    sourceIds: count.sourceIds,
  };
}
function mappingIdentity(count: TrafficCount) {
  return {
    target: count.target,
    position: count.position,
    vehicleClasses: count.vehicleClasses,
    direction: count.raw.directionCode,
    lane: count.raw.laneCode,
    class: count.raw.classCode,
  };
}
/** Original bytes and provider observations are authoritative. Human interpretations are separate, stamped decisions. */
export async function reviewTrafficSubmission(
  input: TrafficConfigurationSubmission,
  context: {
    organizationId: string;
    projectId: string;
    userId: string;
    now: string;
    network: TrafficNetwork;
    place?: Place;
    scenario?: Scenario;
    original: TrafficExperimentRequest;
    previous: TrafficConfigurationRecord | null;
    uploads: TrafficUploadRecord[];
    archive: TrafficArchive;
    commutePresets?: VerifiedTrafficCommutePreset[];
  },
): Promise<{
  request: TrafficExperimentRequest;
  uploadBindings: TrafficUploadBinding[];
}> {
  if (Buffer.byteLength(JSON.stringify(input)) > TRAFFIC_CONFIGURATION_BYTES)
    throw new ApiError(
      413,
      "TRAFFIC_CONFIGURATION_LIMIT",
      "The complete traffic configuration exceeds 8 MiB. No records were truncated.",
    );
  input = trafficConfigurationSubmissionSchema.parse(input);
  if (
    context.previous &&
    (context.previous.organizationId !== context.organizationId ||
      context.previous.projectId !== context.projectId)
  )
    reject("The previous configuration belongs to another project.");
  // Do not parse the final schema until pending target reviews have server-owned attribution.
  const candidate = structuredClone(input.request) as TrafficExperimentRequest;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !candidate.countPack ||
    !Array.isArray(candidate.countPack.counts) ||
    candidate.countPack.counts.length > 10000 ||
    !Array.isArray(candidate.countPack.sources) ||
    !candidate.demand ||
    !Array.isArray(candidate.demand.sources)
  )
    reject("Supply a complete bounded traffic configuration.");
  for (const count of candidate.countPack.counts)
    trafficCountSchema.parse({ ...count, target: null, mapping: undefined });
  const period = trafficPeriodSchema.parse(candidate.period);
  if (candidate.networkHash !== context.network.manifest.networkFileSha256)
    reject("Review the current native graph before saving this configuration.");
  const declarations = unique(
      input.sourceDeclarations,
      (v) => v.sourceId,
      "source declaration",
    ),
    reviews = unique(input.mappingReviews, (v) => v.countId, "mapping review"),
    uploads = unique(context.uploads, (v) => v.id, "upload"),
    priorBindings = unique(
      context.previous?.uploadBindings ?? [],
      (v) => v.uploadId,
      "prior upload",
    ),
    submittedBindings = unique(
      input.uploadBindings,
      (v) => v.uploadId,
      "upload binding",
    );
  // A later configuration retains the original import recipes even if no new files were staged.
  const bindings = new Map(priorBindings);
  for (const [uploadId, binding] of submittedBindings) {
    const prior = priorBindings.get(uploadId);
    if (prior) {
      if (!same({ ...binding, period: binding.period ?? prior.period }, prior))
        reject(
          "An admitted CSV mapping is immutable. Upload a separately identified source to reinterpret its columns or clock defaults.",
        );
    } else
      bindings.set(uploadId, { ...binding, period: binding.period ?? period });
  }
  if (bindings.size > 64)
    reject("Use at most 64 retained count files in one configuration.");
  unique([...bindings.values()], (v) => v.batchId, "CSV batch");
  unique([...bindings.values()], (v) => v.sourceId, "CSV source");
  const originals: TrafficCount[] = structuredClone(
      context.original.countPack.counts,
    ),
    files = structuredClone(context.original.countPack.files);
  for (const binding of bindings.values()) {
    const upload =
      uploads.get(binding.uploadId) ??
      reject("A retained count upload is unavailable in this project.");
    if (
      upload.sourceId !== binding.sourceId ||
      upload.organizationId !== context.organizationId ||
      upload.projectId !== context.projectId
    )
      reject(
        "A count file is unavailable in this project or its assigned source identity changed.",
      );
    const raw = await context.archive.read(
      upload,
      upload.archive,
      "counts.csv",
    );
    if (
      raw.length !== upload.bytes ||
      createHash("sha256").update(raw).digest("hex") !== upload.sha256
    )
      reject("The retained count file does not match its upload identity.");
    const table = parseTrafficCSV(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    if (table.rows.length !== upload.rows)
      reject(
        "The retained count-file row count differs from its recorded upload.",
      );
    originals.push(
      ...countsFromCSV(
        table,
        binding.mapping,
        binding.period,
        binding.sourceId,
        binding.useAnalysisPeriod,
        binding.kind,
        binding.batchId,
      ),
    );
    files.push({
      sourceId: upload.sourceId,
      url: `urn:urban:traffic-upload:${upload.id}:counts.csv`,
      sha256: upload.sha256,
      bytes: upload.bytes,
      retrievedAt: upload.createdAt,
    });
  }
  const sourceGroups = [
      context.network.manifest.sources,
      context.original.countPack.sources,
      context.original.demand.sources,
      ...(context.commutePresets ?? []).map((p) => p.summary.sources),
    ],
    trusted = new Map(sourceGroups.flat().map((source) => [source.id, source])),
    previousSources = new Map(
      [
        ...(context.previous?.request.countPack.sources ?? []),
        ...(context.previous?.request.demand.sources ?? []),
      ].map((source) => [source.id, source]),
    ),
    submittedSources = new Map<string, Source>();
  for (const raw of [
    ...candidate.countPack.sources,
    ...candidate.demand.sources,
  ]) {
    const source = trafficSourceSchema.parse(raw),
      previous = submittedSources.get(source.id);
    if (previous && !same(previous, source))
      reject(
        `Source ${source.id} has conflicting count and demand declarations.`,
      );
    if (source.id === "sumo-native-evidence")
      reject("The native result source identity is reserved.");
    submittedSources.set(source.id, source);
  }
  for (const [sourceId, source] of submittedSources) {
    const declaration = declarations.get(sourceId),
      original = trusted.get(sourceId),
      previous = previousSources.get(sourceId);
    if (original && original.kind !== "user-supplied") {
      if (declaration || !same(source, original))
        reject(`Preserve the original provider attribution for ${sourceId}.`);
      continue;
    }
    if (declaration) {
      const expected = {
        name: declaration.name,
        url: declaration.url.trim(),
        vintage: declaration.vintage,
        license: declaration.license,
      };
      if (
        !same(
          {
            name: source.name,
            url: source.url,
            vintage: source.vintage,
            license: source.license,
          },
          expected,
        )
      )
        reject(
          `The declared source metadata for ${sourceId} does not match the configuration.`,
        );
      submittedSources.set(
        sourceId,
        trafficSourceSchema.parse({
          ...source,
          ...expected,
          kind: "user-supplied",
          rights: {
            version: 1,
            privateUse: true,
            cache: true,
            analyze: true,
            privateDisplay: true,
            export: true,
            historicalRetention: true,
            publicRedistribution: declaration.publicRedistribution,
            declaredBy: context.userId,
            declaredAt: context.now,
          },
        }),
      );
    } else if (
      previous &&
      same(previous, source) &&
      previous.rights?.privateUse &&
      previous.rights.analyze &&
      previous.rights.historicalRetention
    ) {
      submittedSources.set(sourceId, previous);
    } else
      reject(
        `Declare private processing and retention rights for source ${sourceId} before saving. Public redistribution is a separate choice.`,
      );
  }
  for (const sourceId of declarations.keys())
    if (!submittedSources.has(sourceId))
      reject(
        "A rights declaration refers to a source absent from this configuration.",
      );
  const originalCounts = unique(originals, (v) => v.id, "original count"),
    counts = unique(candidate.countPack.counts, (v) => v.id, "count"),
    previousCounts = new Map(
      (context.previous?.request.countPack.counts ?? []).map((v) => [v.id, v]),
    );
  if (
    counts.size !== originalCounts.size ||
    [...originalCounts.keys()].some((id) => !counts.has(id))
  )
    reject(
      "Retain every original count row. Mark unusable observations Excluded instead of deleting them.",
    );
  for (const [countId, count] of counts) {
    const original = originalCounts.get(countId)!;
    if (!same(countLineage(count), countLineage(original)))
      reject(
        `Count ${countId}: preserve its original station, interval, source IDs and raw fields. Reinterpretation requires a separately identified import.`,
      );
    if (
      count.kind === "observed" &&
      (original.kind !== "observed" || count.value !== original.value)
    )
      reject(
        `Count ${countId}: an adjusted count must be explicitly Factored; it cannot be presented as an observation.`,
      );
    if (count.value !== original.value) {
      if (
        original.value === null ||
        count.value === null ||
        count.kind !== "factored" ||
        !Array.isArray(count.notes) ||
        !count.notes.some(
          (note) =>
            typeof note === "string" &&
            note.trim().length >= 12 &&
            !original.notes.includes(note),
        )
      )
        reject(
          `Count ${countId}: retain missing values and original observations. A factored adjustment needs an explanatory note; use Excluded for unusable evidence.`,
        );
    }
    count.notes = [...new Set([...original.notes, ...count.notes])];
    const review = reviews.get(countId),
      previous = previousCounts.get(countId) ?? original;
    if (!count.target) {
      if (!same(count.position, original.position))
        reject(
          `Count ${countId}: changing a supplied station position requires an explicit mapped-target review.`,
        );
      if (count.mapping || review)
        reject(
          `Count ${countId}: an unbound observation cannot carry a mapping review.`,
        );
    } else if (review) {
      if (
        !same(review.target, count.target) ||
        review.networkFileSha256 !== candidate.networkHash
      )
        reject(
          `Count ${countId}: the mapping review does not match the exact selected native target.`,
        );
      count.mapping = {
        networkFileSha256: candidate.networkHash,
        method: "manual",
        snapMeters: null,
        directionAgreement: "confirmed",
        reviewedBy: context.userId,
        reviewedAt: context.now,
      };
    } else if (
      !previous.mapping ||
      !same(mappingIdentity(count), mappingIdentity(previous)) ||
      !same(count.mapping, previous.mapping)
    )
      reject(
        `Count ${countId}: explicitly review its target, direction, lane and vehicle-class coverage. Reviewer identity and time are recorded by the server.`,
      );
  }
  for (const countId of reviews.keys())
    if (!counts.has(countId))
      reject("A mapping review refers to an absent count.");
  if (
    !same(
      candidate.countPack.annualCounts,
      context.original.countPack.annualCounts,
    )
  )
    reject(
      "Preserve annual counts as original context; they cannot be silently converted to hourly observations.",
    );
  // Browser staging placeholders never become authoritative file locations.
  if (!Array.isArray(candidate.countPack.files))
    reject("Retain the source-file inventory.");
  for (const file of candidate.countPack.files)
    if (
      !files.some(
        (original) =>
          original.sourceId === file.sourceId &&
          original.sha256 === file.sha256 &&
          original.bytes === file.bytes,
      )
    )
      reject(
        "A count-file reference has no retained original in this project.",
      );
  candidate.countPack.files = files;
  const reviewed = (sources: Source[]) =>
    sources.map((source) => submittedSources.get(source.id)!);
  candidate.countPack.sources = reviewed(candidate.countPack.sources);
  candidate.demand.sources = reviewed(candidate.demand.sources);
  await reviewPlanningRequest(
    candidate,
    input.planningRoadReviews,
    input.planningSourceDeclarations,
    {
      place: context.place,
      scenario: context.scenario,
      network: context.network,
      previous: context.previous?.request ?? null,
      userId: context.userId,
      now: context.now,
    },
  );
  const request = trafficExperimentRequestSchema.parse(candidate);
  await verifyPreparedCommuteRequest(
    request,
    context.network,
    context.commutePresets ?? [],
  );
  validateTrafficCountPack(request.countPack, context.network);
  validateTrafficDemand(request.demand, context.network, request.period);
  if (request.calibrationPlan) {
    const selection = inspectTrafficCalibrationSelection(
      request.countPack,
      request.calibrationPlan,
      context.network,
      request.period,
    );
    if (!selection.valid)
      throw new ApiError(
        422,
        "TRAFFIC_CALIBRATION_SELECTION",
        `Review the baseline count-check selection before saving: ${selection.errors.join(" ")}`,
      );
  }
  return { request, uploadBindings: [...bindings.values()] };
}
