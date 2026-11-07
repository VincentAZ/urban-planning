import { z } from "zod";
import type { Place, Project } from "./index";
import { isSafeFeatureIdentifier } from "./identifiers";
import { projectWithTrafficVersion } from "./traffic-scenario";
import {
  ACCESSIBILITY_METHOD_VERSION,
  ACCESSIBILITY_EARNINGS,
  ACCESSIBILITY_INDUSTRIES,
  ACCESSIBILITY_ROUTE_STATUSES,
  accessibilityContentHash,
  accessibilityRoutingInputHash,
  accessibilityShaSchema,
  accessibilityRequestSchema,
  accessibilityNetworkSchema,
  accessibilitySourceCoverageSchema,
  accessibilitySourceMetadataSchema,
  accessibilitySourceSchema,
  accessibilityFileSchema,
  type AccessibilityDestinationPack,
  type AccessibilityResolution,
  type AccessibilityRequest,
  type AccessibilityCount,
  type AccessibilityThreshold,
  type AccessibilityCoverage,
} from "./accessibility";

export const MAX_ACCESSIBILITY_CAPTURE_BYTES = 256 * 1024;
export interface AccessibilityCapture extends AccessibilityResolution {
  artifactHash: string;
  resultHash: string;
  siteSnapMeters: number;
  source: Pick<
    AccessibilityDestinationPack,
    "id" | "lodes" | "region" | "pointMethod"
  >;
  sources: AccessibilityDestinationPack["sources"];
  files: AccessibilityDestinationPack["files"];
  contour: {
    sha256: string;
    inputHash: string;
    manifestId: string;
    minutes: [15, 30, 45];
    featureCount: number;
    vertexCount: number;
  };
}
export interface AccessibilityModeEvidence {
  version: 1;
  origin: "server-run" | "imported";
  binding: { placeId: string; baselineHash: string };
  /** Reference only. A client-supplied hash/receipt is not server authority. */
  receipt: { jobId: string; projectId: string };
  captureHash: string;
  capture: AccessibilityCapture;
}
export interface AccessibilityScenario {
  version: 1;
  captures: {
    car?: AccessibilityModeEvidence;
    walk?: AccessibilityModeEvidence;
  };
}
const id = z
  .string()
  .refine(isSafeFeatureIdentifier, "Use a safe internal identifier.");
const sha = accessibilityShaSchema,
  amount = z.number().finite().int().min(0).max(1e12),
  text = z.string().min(1).max(10000);
const countFields = {
  estimate: amount.nullable(),
  knownSubtotal: amount.nullable(),
  status: z.enum(["complete", "partial", "unavailable"]),
  unresolvedDestinationCount: amount,
  unresolvedJobs: amount,
  upperBound: amount.nullable(),
};
function countIssue(c: AccessibilityCount): string | undefined {
  if (
    c.status === "complete"
      ? c.estimate === null ||
        c.knownSubtotal !== c.estimate ||
        c.upperBound !== c.estimate ||
        c.unresolvedJobs !== 0 ||
        c.unresolvedDestinationCount !== 0
      : c.estimate !== null
  )
    return "A complete estimate must reconcile exactly; an incomplete estimate must be null.";
  if ((c.status === "unavailable") !== (c.knownSubtotal === null))
    return "Unavailable and known-subtotal states must remain distinct.";
  if (
    c.upperBound !== null &&
    c.upperBound !== (c.knownSubtotal ?? 0) + c.unresolvedJobs
  )
    return "The upper bound must retain all unresolved destination jobs.";
  if ((c.unresolvedDestinationCount === 0) !== (c.unresolvedJobs === 0))
    return "Only positive jobs contribute unresolved destination counts.";
}
export const accessibilityCountSchema: z.ZodType<AccessibilityCount> = z
  .object(countFields)
  .strict()
  .superRefine((v, c) => {
    const message = countIssue(v);
    if (message) c.addIssue({ code: "custom", message });
  });
const category = z
  .object({
    ...countFields,
    id: text,
    label: text,
    sourceCells: z.array(text).length(1),
  })
  .strict()
  .superRefine((v, c) => {
    const message = countIssue(v);
    if (message) c.addIssue({ code: "custom", message });
  });
export const accessibilityThresholdSchema: z.ZodType<AccessibilityThreshold> = z
  .object({
    minutes: z.union([z.literal(15), z.literal(30), z.literal(45)]),
    total: accessibilityCountSchema,
    earnings: z.array(category).length(3),
    industries: z.array(category).length(20),
  })
  .strict()
  .superRefine((v, c) => {
    for (const [rows, definitions] of [
      [v.earnings, ACCESSIBILITY_EARNINGS],
      [v.industries, ACCESSIBILITY_INDUSTRIES],
    ] as const) {
      if (
        rows.some(
          (row, i) =>
            row.id !== definitions[i].id ||
            row.label !== definitions[i].label ||
            row.sourceCells[0] !== row.id,
        )
      )
        c.addIssue({
          code: "custom",
          message:
            "Captured category definitions must match their native WAC source cells.",
        });
      for (const field of [
        "estimate",
        "knownSubtotal",
        "unresolvedJobs",
        "upperBound",
      ] as const) {
        if (
          v.total[field] !== null &&
          rows.every((r) => r[field] !== null) &&
          rows.reduce((s, r) => s + r[field]!, 0) !== v.total[field]
        )
          c.addIssue({
            code: "custom",
            message: `Each category family must reconcile separately to the total ${field}.`,
          });
      }
    }
  });
export const accessibilityCoverageSchema: z.ZodType<AccessibilityCoverage> = z
  .object({
    regionDataComplete: z.boolean(),
    network: z.enum(["complete", "bounded", "unknown"]),
    destinations: accessibilitySourceCoverageSchema,
    destinationCount: amount.min(1),
    zeroJobDestinationCount: amount,
    sourceJobs: amount,
    routeStatusCounts: z
      .object(
        Object.fromEntries(
          ACCESSIBILITY_ROUTE_STATUSES.map((s) => [s, amount]),
        ) as Record<
          (typeof ACCESSIBILITY_ROUTE_STATUSES)[number],
          typeof amount
        >,
      )
      .strict(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      Object.values(v.routeStatusCounts).reduce((s, n) => s + n, 0) !==
        v.destinationCount ||
      v.zeroJobDestinationCount > v.destinationCount ||
      v.routeStatusCounts["zero-jobs"] > v.zeroJobDestinationCount
    )
      c.addIssue({
        code: "custom",
        message:
          "Destination coverage must reconcile to every retained source row, including true zeros.",
      });
  });
export const accessibilityResolutionSchema: z.ZodType<AccessibilityResolution> =
  z
    .object({
      methodVersion: z.literal(ACCESSIBILITY_METHOD_VERSION),
      jobsPackHash: sha,
      routingRunHash: sha,
      inputHash: sha,
      capturedAt: z.iso.datetime({ offset: true }),
      request: accessibilityRequestSchema,
      network: accessibilityNetworkSchema,
      coverage: accessibilityCoverageSchema,
      thresholds: z.array(accessibilityThresholdSchema).length(3),
      uncertainty: z
        .object({
          sampling: z.literal("not-provided"),
          spatial: z.literal("block-representative-point"),
          routing: z.literal("static-captured-network"),
        })
        .strict(),
      notes: z.array(text).max(100),
    })
    .strict()
    .superRefine((v, c) => {
      const complete =
        v.coverage.regionDataComplete &&
        v.coverage.network === "complete" &&
        v.coverage.destinations.status === "complete";
      if (v.network.coverage !== v.coverage.network)
        c.addIssue({
          code: "custom",
          message: "Captured network coverage is inconsistent.",
        });
      for (const [i, t] of v.thresholds.entries()) {
        if (t.minutes !== [15, 30, 45][i])
          c.addIssue({
            code: "custom",
            message: "Retain ordered 15/30/45-minute thresholds.",
          });
        for (const n of [t.total, ...t.earnings, ...t.industries]) {
          if (!complete && (n.estimate !== null || n.upperBound !== null))
            c.addIssue({
              code: "custom",
              message:
                "Incomplete regional coverage cannot provide a full estimate or bounded total.",
            });
          if (
            (n.upperBound ?? n.knownSubtotal ?? 0) > v.coverage.sourceJobs ||
            n.unresolvedJobs > v.coverage.sourceJobs ||
            n.unresolvedDestinationCount > v.coverage.destinationCount
          )
            c.addIssue({
              code: "custom",
              message: "Counts cannot exceed their retained source inventory.",
            });
        }
        if (i) {
          const previous = v.thresholds[i - 1];
          for (const [a, b] of [
            [previous.total, t.total],
            ...previous.earnings.map((r, j) => [r, t.earnings[j]]),
            ...previous.industries.map((r, j) => [r, t.industries[j]]),
          ])
            if (
              a.knownSubtotal !== null &&
              b.knownSubtotal !== null &&
              a.knownSubtotal > b.knownSubtotal
            )
              c.addIssue({
                code: "custom",
                message:
                  "Cumulative reachable jobs cannot decline as the time budget increases.",
              });
        }
      }
    });
// Keep the base object representable in OpenAPI; all semantic refinements run below.
const captureObject = z
  .object({
    artifactHash: sha,
    resultHash: sha,
    siteSnapMeters: z.number().finite().min(0).max(250.1),
    methodVersion: z.literal(ACCESSIBILITY_METHOD_VERSION),
    jobsPackHash: sha,
    routingRunHash: sha,
    inputHash: sha,
    capturedAt: z.iso.datetime({ offset: true }),
    request: accessibilityRequestSchema,
    network: accessibilityNetworkSchema,
    coverage: accessibilityCoverageSchema,
    thresholds: z.array(accessibilityThresholdSchema).length(3),
    uncertainty: z
      .object({
        sampling: z.literal("not-provided"),
        spatial: z.literal("block-representative-point"),
        routing: z.literal("static-captured-network"),
      })
      .strict(),
    notes: z.array(text).max(100),
    source: accessibilitySourceMetadataSchema,
    sources: z.array(accessibilitySourceSchema).min(1).max(100),
    files: z.array(accessibilityFileSchema).min(1).max(100),
    contour: z
      .object({
        sha256: sha,
        inputHash: sha,
        manifestId: id,
        minutes: z.tuple([z.literal(15), z.literal(30), z.literal(45)]),
        featureCount: amount.min(3).max(1000),
        vertexCount: amount.min(12).max(100000),
      })
      .strict(),
  })
  .strict();
export function accessibilityResultFromCapture(
  capture: AccessibilityCapture,
): AccessibilityResolution {
  const {
    methodVersion,
    jobsPackHash,
    routingRunHash,
    inputHash,
    capturedAt,
    request,
    network,
    coverage,
    thresholds,
    uncertainty,
    notes,
  } = capture;
  return {
    methodVersion,
    jobsPackHash,
    routingRunHash,
    inputHash,
    capturedAt,
    request,
    network,
    coverage,
    thresholds,
    uncertainty,
    notes,
  };
}
export const accessibilityCaptureSchema: z.ZodType<AccessibilityCapture> =
  captureObject.superRefine((v, c) => {
    const result = accessibilityResolutionSchema.safeParse(
      accessibilityResultFromCapture(v),
    );
    if (!result.success)
      for (const issue of result.error.issues)
        c.addIssue({ code: "custom", message: issue.message });
    if (
      new TextEncoder().encode(JSON.stringify(v)).byteLength >
      MAX_ACCESSIBILITY_CAPTURE_BYTES
    )
      c.addIssue({
        code: "custom",
        message:
          "Accessibility capture exceeds 256 KiB; retain the full archive separately.",
      });
    if (v.contour.manifestId !== v.network.id)
      c.addIssue({
        code: "custom",
        message:
          "The contour and numerical evidence must use the same network.",
      });
    const ids = new Set(v.sources.map((s) => s.id));
    if (
      ids.size !== v.sources.length ||
      v.files.some((f) => !ids.has(f.sourceId))
    )
      c.addIssue({
        code: "custom",
        message: "Retain unique source citations for every captured file.",
      });
  });
export const accessibilityModeEvidenceSchema: z.ZodType<AccessibilityModeEvidence> =
  z
    .object({
      version: z.literal(1),
      origin: z.enum(["server-run", "imported"]),
      binding: z.object({ placeId: id, baselineHash: sha }).strict(),
      receipt: z.object({ jobId: id, projectId: id }).strict(),
      captureHash: sha,
      capture: accessibilityCaptureSchema,
    })
    .strict();
export const accessibilityScenarioSchema: z.ZodType<AccessibilityScenario> = z
  .object({
    version: z.literal(1),
    captures: z
      .object({
        car: accessibilityModeEvidenceSchema.optional(),
        walk: accessibilityModeEvidenceSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, c) => {
    if (!v.captures.car && !v.captures.walk)
      c.addIssue({
        code: "custom",
        message: "Remove an empty accessibility container.",
      });
    for (const mode of ["car", "walk"] as const)
      if (v.captures[mode] && v.captures[mode]!.capture.request.mode !== mode)
        c.addIssue({
          code: "custom",
          message: "A saved mode must match its captured outbound request.",
        });
  });
export function assertAccessibilityModeEvidence(
  value: unknown,
): asserts value is AccessibilityModeEvidence {
  accessibilityModeEvidenceSchema.parse(value);
}
export function assertAccessibilityScenario(
  value: unknown,
): asserts value is AccessibilityScenario {
  accessibilityScenarioSchema.parse(value);
}
export function validateAccessibilityScenario(
  value: AccessibilityScenario,
  place: Pick<Place, "id">,
): void {
  assertAccessibilityScenario(value);
  for (const e of Object.values(value.captures))
    if (e.binding.placeId !== place.id)
      throw new Error("Accessibility evidence belongs to a different place.");
}
export async function verifyAccessibilityModeEvidence(
  e: AccessibilityModeEvidence,
  place?: Pick<Place, "id">,
  baselineHash?: string,
): Promise<void> {
  assertAccessibilityModeEvidence(e);
  if (
    (place && place.id !== e.binding.placeId) ||
    (baselineHash && baselineHash !== e.binding.baselineHash)
  )
    throw new Error(
      "Accessibility evidence does not match its immutable baseline binding.",
    );
  if (
    (await accessibilityContentHash(e.capture)) !== e.captureHash ||
    (await accessibilityContentHash(
      accessibilityResultFromCapture(e.capture),
    )) !== e.capture.resultHash
  )
    throw new Error("Accessibility evidence content/result hash mismatch.");
  if (
    (await accessibilityRoutingInputHash(
      e.capture.jobsPackHash,
      e.capture.request,
      e.capture.network,
      e.capture.coverage.destinations,
    )) !== e.capture.inputHash
  )
    throw new Error(
      "Accessibility evidence query/source/network binding mismatch.",
    );
}
export async function verifyAccessibilityScenarioIntegrity(
  value: AccessibilityScenario,
  place?: Place,
  knownBaselineHash?: string,
): Promise<void> {
  assertAccessibilityScenario(value);
  const baselineHash =
    knownBaselineHash ??
    (place ? await accessibilityContentHash(place) : undefined);
  for (const e of Object.values(value.captures))
    await verifyAccessibilityModeEvidence(e, place, baselineHash);
}
export function projectWithAccessibilityVersion(
  project: Project,
  place?: Place,
): Project {
  const p = projectWithTrafficVersion(project, place);
  if (p.schemaVersion >= 10) return p;
  const entries = [...p.history, ...p.undone];
  return [...p.scenarios, ...entries.flatMap((e) => [e.before, e.after])].some(
    (s) => s.accessibility !== undefined,
  ) || entries.some((e) => e.command.type === "scenario.accessibility")
    ? { ...p, schemaVersion: 10 }
    : p;
}
export function projectWithImportedAccessibility(project: Project): Project {
  const entries = [...project.history, ...project.undone];
  if (
    ![
      ...project.scenarios,
      ...entries.flatMap((e) => [e.before, e.after]),
    ].some((s) => s.accessibility) &&
    !entries.some(
      (e) => e.command.type === "scenario.accessibility" && e.command.evidence,
    )
  )
    return project;
  const p = structuredClone(project);
  for (const s of [
    ...p.scenarios,
    ...[...p.history, ...p.undone].flatMap((e) => [e.before, e.after]),
  ])
    if (s.accessibility)
      for (const e of Object.values(s.accessibility.captures))
        e.origin = "imported";
  for (const e of [...p.history, ...p.undone])
    if (e.command.type === "scenario.accessibility" && e.command.evidence)
      e.command.evidence.origin = "imported";
  return p;
}
