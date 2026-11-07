import { z } from "zod";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type {
  CensusValueStatus,
  Place,
  Project,
  Scenario,
  Source,
} from "./index";
import { isSafeFeatureIdentifier } from "./identifiers";
import { projectWithRetailVersion } from "./retail";
import {
  WORKFORCE_PANELS,
  workforceContentHash,
  workforceRequestSchema,
  workforceNetworkSchema,
  workforceCohortCoverageSchema,
  workforceRoutingInputHash,
  type WorkforceCohortPack,
  type WorkforceCohortCoverage,
  type WorkforceNetwork,
  type WorkforceRequest,
  type WorkforceRouteStatus,
  type WorkforceSourceFile,
} from "./workforce";

export const MAX_WORKFORCE_CAPTURE_BYTES = 256 * 1024;
export const WORKFORCE_CAPTURE_METHOD_VERSION = "workforce-1.0.2";
export interface WorkforceCapturedCount {
  estimate: number | null;
  knownSubtotal: number | null;
  marginOfError90: number | null;
  knownSubtotalMarginOfError90: number | null;
  status: "complete" | "partial" | "unavailable";
  missingUnitCount: number;
  suppressedUnitCount: number;
  unresolvedAllocationUnitCount: number;
  unresolvedAllocationMoeUnitCount: number;
  missingMoeUnitCount: number;
  geographicallyPartialUnitCount: number;
  /** Cell issue counts, not unique people or units. Native row identities stay in the archive. */
  sourceIssueCellCounts: Record<CensusValueStatus, number>;
}
export interface WorkforceCapturedPanel {
  id: "education" | "occupation";
  label: string;
  universe: string;
  table: "B15003" | "C24010";
  thresholds: {
    minutes: 15 | 30 | 45;
    total: WorkforceCapturedCount;
    categories: (WorkforceCapturedCount & {
      id: string;
      label: string;
      sourceCells: string[];
    })[];
  }[];
}
export interface WorkforceCapturedCoverage {
  regionDataComplete: boolean;
  network: WorkforceNetwork["coverage"];
  cohort: WorkforceCohortCoverage;
  nativeUnits: number;
  allocationCompleteUnits: number;
  allocationIncompleteUnits: number;
  allocationUnavailableUnits: number;
  origins: number;
  unallocatedOriginCount: number;
  unallocatedPopulation2020: number;
  ambiguousAffectedUnitCount: number;
  routeStatusCounts: Record<WorkforceRouteStatus, number>;
  allocationPopulation2020: number;
  unroutedAllocationPopulation2020: number;
}
export interface WorkforceContourReference {
  /** Hash of the complete separately retained contour envelope, not simplified geometry. */
  sha256: string;
  inputHash: string;
  manifestId: string;
  minutes: [15, 30, 45];
  featureCount: number;
  vertexCount: number;
}
/** Returned separately from saved scenario history by an authorized artifact endpoint. */
export interface WorkforceContour {
  manifestId: string;
  inputHash: string;
  site: WorkforceRequest["site"];
  mode: WorkforceRequest["mode"];
  direction: "inbound";
  minutes: [15, 30, 45];
  geometry: FeatureCollection<Polygon | MultiPolygon>;
  notes: string[];
}
export interface WorkforceCapture {
  artifactHash: string;
  resultHash: string;
  routingRunHash: string;
  inputHash: string;
  cohortPackHash: string;
  capturedAt: string;
  /** Distance to the matched network edge; not a verified building entrance. */
  siteSnapMeters: number;
  methodVersion: typeof WORKFORCE_CAPTURE_METHOD_VERSION;
  request: WorkforceRequest;
  network: WorkforceNetwork;
  cohort: Pick<WorkforceCohortPack, "id" | "acs" | "region" | "allocation">;
  /** Self-contained citations; these never overwrite place/scenario sources. */
  sources: Source[];
  files: WorkforceSourceFile[];
  coverage: WorkforceCapturedCoverage;
  uncertainty: {
    sampling: "approximate-90-percent-conditional";
    formula: string;
    includesSpatialAllocationError: false;
    includesRoutingError: false;
  };
  notes: string[];
  panels: WorkforceCapturedPanel[];
  contour: WorkforceContourReference;
}
export interface WorkforceScenario {
  version: 1;
  /** Imported evidence is retained for review, never represented as server-verified. */
  origin: "server-run" | "imported";
  binding: { placeId: string; baselineHash: string };
  /** A lookup reference only. Caller-supplied receipts and hashes are not verification. */
  receipt: { jobId: string; projectId: string };
  captureHash: string;
  capture: WorkforceCapture;
}

const id = z
  .string()
  .refine(isSafeFeatureIdentifier, "Use a safe internal identifier.");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max = 10000) => z.string().min(1).max(max);
const amount = z.number().finite().min(0).max(1e12);
const count = amount.int();
const date = z.iso.datetime({ offset: true });
const statuses = [
  "available",
  "missing",
  "suppressed",
  "not-applicable",
  "uncomputable",
  "controlled",
  "bounded",
] as const;
const issueCounts = z
  .object(
    Object.fromEntries(statuses.map((status) => [status, count])) as Record<
      CensusValueStatus,
      typeof count
    >,
  )
  .strict();
const routeCounts = z
  .object({
    reachable: count,
    unreachable: count,
    "outside-threshold": count,
    unsnappable: count,
    "outside-coverage": count,
    unavailable: count,
  })
  .strict();
const countFields = {
  estimate: amount.nullable(),
  knownSubtotal: amount.nullable(),
  marginOfError90: amount.nullable(),
  knownSubtotalMarginOfError90: amount.nullable(),
  status: z.enum(["complete", "partial", "unavailable"]),
  missingUnitCount: count,
  suppressedUnitCount: count,
  unresolvedAllocationUnitCount: count,
  unresolvedAllocationMoeUnitCount: count,
  missingMoeUnitCount: count,
  geographicallyPartialUnitCount: count,
  sourceIssueCellCounts: issueCounts,
} as const;
function countIssues(v: WorkforceCapturedCount, c: z.RefinementCtx) {
  const fail = (message: string) => c.addIssue({ code: "custom", message });
  const expected =
    v.estimate !== null
      ? "complete"
      : v.knownSubtotal !== null
        ? "partial"
        : "unavailable";
  if (v.status !== expected)
    fail(
      "Complete, partial and unavailable counts must preserve their null semantics.",
    );
  if (
    v.estimate !== null &&
    (v.estimate !== v.knownSubtotal ||
      v.missingUnitCount > 0 ||
      v.suppressedUnitCount > 0)
  )
    fail(
      "A complete estimate must equal its known subtotal and have no missing or suppressed source units.",
    );
  if (v.knownSubtotal === null && v.knownSubtotalMarginOfError90 !== null)
    fail("An unavailable subtotal cannot have a sampling margin.");
  if (v.missingMoeUnitCount > 0 && v.knownSubtotalMarginOfError90 !== null)
    fail("Missing source margins must not be replaced with precision.");
  if (
    v.knownSubtotal !== null &&
    v.missingMoeUnitCount === 0 &&
    v.knownSubtotalMarginOfError90 === null
  )
    fail(
      "Retain the known subtotal's conditional margin when its source margins are available.",
    );
  const expectedMoe =
    v.estimate !== null && v.unresolvedAllocationMoeUnitCount === 0
      ? v.knownSubtotalMarginOfError90
      : null;
  if (v.marginOfError90 !== expectedMoe)
    fail(
      "Full sampling margins must be withheld for unresolved spatial allocation.",
    );
  if (
    v.sourceIssueCellCounts.available !== 0 ||
    v.sourceIssueCellCounts.controlled !== 0
  )
    fail("Usable source cells are not missing-data issues.");
}
export const workforceCapturedCountSchema: z.ZodType<WorkforceCapturedCount> = z
  .object(countFields)
  .strict()
  .superRefine(countIssues);
const category = z
  .object({
    ...countFields,
    id,
    label: text(500),
    sourceCells: z
      .array(z.string().regex(/^(B15003|C24010)_\d{3}$/))
      .min(1)
      .max(25),
  })
  .strict()
  .superRefine(countIssues);
const panel = z
  .object({
    id: z.enum(["education", "occupation"]),
    label: text(500),
    universe: text(500),
    table: z.enum(["B15003", "C24010"]),
    thresholds: z
      .array(
        z
          .object({
            minutes: z.union([z.literal(15), z.literal(30), z.literal(45)]),
            total: workforceCapturedCountSchema,
            categories: z.array(category).min(1).max(6),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();
const source = z
  .object({
    id: text(500),
    name: text(500),
    url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
    vintage: text(500),
    license: text(500),
    kind: z.enum([
      "observed",
      "published-estimate",
      "inferred",
      "user-supplied",
    ]),
    description: z.string().max(10000).optional(),
  })
  .strict();
const files = z
  .array(
    z
      .object({
        sourceId: text(500),
        url: z.url({ protocol: /^https?$/ }),
        sha256: sha,
        retrievedAt: date,
        table: text(500).optional(),
        bytes: count.optional(),
      })
      .strict(),
  )
  .min(1)
  .max(1000);
const coverage = z
  .object({
    regionDataComplete: z.boolean(),
    network: z.enum(["complete", "bounded", "unknown"]),
    cohort: workforceCohortCoverageSchema,
    nativeUnits: count,
    allocationCompleteUnits: count,
    allocationIncompleteUnits: count,
    allocationUnavailableUnits: count,
    origins: count,
    unallocatedOriginCount: count,
    unallocatedPopulation2020: count,
    ambiguousAffectedUnitCount: count,
    routeStatusCounts: routeCounts,
    allocationPopulation2020: count,
    unroutedAllocationPopulation2020: count,
  })
  .strict();
export const workforceCaptureSchema: z.ZodType<WorkforceCapture> = z
  .object({
    artifactHash: sha,
    resultHash: sha,
    routingRunHash: sha,
    inputHash: sha,
    cohortPackHash: sha,
    capturedAt: date,
    siteSnapMeters: z.number().finite().min(0).max(250.1),
    methodVersion: z.literal(WORKFORCE_CAPTURE_METHOD_VERSION),
    request: workforceRequestSchema,
    network: workforceNetworkSchema,
    cohort: z
      .object({
        id: text(500),
        acs: z
          .object({
            dataset: z.literal("acs/acs5"),
            vintage: z.literal(2024),
            period: z
              .object({ start: z.literal(2020), end: z.literal(2024) })
              .strict(),
            confidenceLevel: z.literal(90),
            boundaryVintage: text(500),
          })
          .strict(),
        region: z
          .object({
            label: text(500),
            countyGeoids: z
              .array(z.string().regex(/^\d{5}$/))
              .min(1)
              .max(4000),
            complete: z.boolean(),
          })
          .strict(),
        allocation: z
          .object({
            method: z.literal("2020-block-population"),
            sourceId: text(500),
            vintage: z.literal(2020),
            geographyMatch: z.literal("verified"),
            notes: z.array(text()).max(100),
          })
          .strict(),
      })
      .strict(),
    sources: z.array(source).min(1).max(1000),
    files,
    coverage,
    uncertainty: z
      .object({
        sampling: z.literal("approximate-90-percent-conditional"),
        formula: text(),
        includesSpatialAllocationError: z.literal(false),
        includesRoutingError: z.literal(false),
      })
      .strict(),
    notes: z.array(text()).max(300),
    panels: z.array(panel).length(2),
    contour: z
      .object({
        sha256: sha,
        inputHash: sha,
        manifestId: text(500),
        minutes: z.tuple([z.literal(15), z.literal(30), z.literal(45)]),
        featureCount: count.min(3).max(1000),
        vertexCount: count.min(12).max(100000),
      })
      .strict(),
  })
  .strict()
  .superRefine((capture, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    if (
      new TextEncoder().encode(JSON.stringify(capture)).byteLength >
      MAX_WORKFORCE_CAPTURE_BYTES
    )
      fail(
        "The saved workforce capture exceeds 256 KiB; retain the large archive separately.",
      );
    const sourceIds = new Set(capture.sources.map((s) => s.id));
    if (sourceIds.size !== capture.sources.length)
      fail("Captured workforce source IDs must be unique.");
    if (
      !sourceIds.has(capture.cohort.allocation.sourceId) ||
      capture.files.some((f) => !sourceIds.has(f.sourceId))
    )
      fail(
        "Every captured source file and allocation method needs an embedded citation.",
      );
    if (
      new Set(capture.cohort.region.countyGeoids).size !==
      capture.cohort.region.countyGeoids.length
    )
      fail("Captured county inventory cannot contain duplicates.");
    const cv = capture.coverage;
    if (
      cv.nativeUnits !==
        cv.allocationCompleteUnits +
          cv.allocationIncompleteUnits +
          cv.allocationUnavailableUnits ||
      cv.origins !==
        Object.values(cv.routeStatusCounts).reduce((n, v) => n + v, 0)
    )
      fail(
        "Workforce coverage counts must reconcile with retained native units and origin statuses.",
      );
    if (
      cv.network !== capture.network.coverage ||
      cv.regionDataComplete !== capture.cohort.region.complete
    )
      fail("Captured source/network coverage fields disagree.");
    if (
      cv.ambiguousAffectedUnitCount > cv.allocationUnavailableUnits ||
      cv.unroutedAllocationPopulation2020 + cv.unallocatedPopulation2020 >
        cv.allocationPopulation2020
    )
      fail(
        "Unresolved coverage cannot exceed retained source population or units.",
      );
    if (capture.contour.manifestId !== capture.network.id)
      fail("The contour reference must use the captured network.");
    const [w, s, e, n] = capture.network.extent,
      [x, y] = capture.request.site;
    if (x < w || x > e || y < s || y > n)
      fail("The captured site lies outside its network extent.");
    for (const [pi, p] of capture.panels.entries()) {
      const expectedId = pi === 0 ? "education" : "occupation",
        def = WORKFORCE_PANELS[expectedId];
      if (
        p.id !== expectedId ||
        p.table !== def.table ||
        p.label !== def.label ||
        p.universe !== def.universe
      )
        fail(
          "Keep the published education and occupation panels and their distinct universes.",
        );
      for (const [ti, t] of p.thresholds.entries()) {
        if (t.minutes !== [15, 30, 45][ti])
          fail("Capture each fixed 15/30/45-minute threshold once in order.");
        if (t.categories.length !== def.categories.length)
          fail("Retain every defined source category.");
        for (const [ci, cat] of t.categories.entries()) {
          const expected = def.categories[ci];
          if (
            !expected ||
            cat.id !== expected.id ||
            cat.label !== expected.label ||
            JSON.stringify(cat.sourceCells) !== JSON.stringify(expected.cells)
          )
            fail(
              "Captured category definitions must match the native ACS panel.",
            );
        }
        for (const value of [t.total, ...t.categories]) {
          if (
            [
              value.missingUnitCount,
              value.suppressedUnitCount,
              value.unresolvedAllocationUnitCount,
              value.unresolvedAllocationMoeUnitCount,
              value.missingMoeUnitCount,
              value.geographicallyPartialUnitCount,
            ].some((v) => v > cv.nativeUnits)
          )
            fail("A per-metric unit count cannot exceed the source inventory.");
          if (
            Object.values(value.sourceIssueCellCounts).some(
              (v) => v > cv.nativeUnits * (p.id === "education" ? 25 : 73),
            )
          )
            fail("Source cell issue counts exceed the retained panel.");
          if (
            (!cv.regionDataComplete ||
              cv.network !== "complete" ||
              cv.cohort.status !== "complete") &&
            value.estimate !== null
          )
            fail(
              "Incomplete region or graph coverage cannot produce a complete shed total.",
            );
        }
      }
    }
  });
export const workforceScenarioSchema: z.ZodType<WorkforceScenario> = z
  .object({
    version: z.literal(1),
    origin: z.enum(["server-run", "imported"]),
    binding: z.object({ placeId: id, baselineHash: sha }).strict(),
    receipt: z.object({ jobId: id, projectId: id }).strict(),
    captureHash: sha,
    capture: workforceCaptureSchema,
  })
  .strict();
export function assertWorkforceScenario(
  input: unknown,
): asserts input is WorkforceScenario {
  const parsed = workforceScenarioSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `Invalid workforce capture: ${parsed.error.issues[0]?.message ?? "unsupported evidence"}`,
    );
}
/** Shape and place identity only. Neither client hashes nor receipts establish server authority. */
export function validateWorkforceScenario(
  workforce: WorkforceScenario,
  place: Place,
): void {
  assertWorkforceScenario(workforce);
  if (workforce.binding.placeId !== place.id)
    throw new Error("The workforce capture belongs to a different place.");
}
/** Integrity checks only; authoritative adoption separately requires the owning server artifact. */
export async function verifyWorkforceScenario(
  workforce: WorkforceScenario,
  place: Place,
  knownBaselineHash?: string,
): Promise<void> {
  validateWorkforceScenario(workforce, place);
  if ((await workforceContentHash(workforce.capture)) !== workforce.captureHash)
    throw new Error("The workforce capture does not match its content hash.");
  if (
    (knownBaselineHash ?? (await workforceContentHash(place))) !==
    workforce.binding.baselineHash
  )
    throw new Error(
      "The workforce capture does not match this immutable baseline.",
    );
  const capture = workforce.capture;
  if (
    (await workforceRoutingInputHash(
      capture.cohortPackHash,
      capture.request,
      capture.network,
      capture.coverage.cohort,
    )) !== capture.inputHash
  )
    throw new Error(
      "The workforce capture input hash does not match its query and coverage.",
    );
}
export function projectWithWorkforceVersion(
  project: Project,
  place?: Place,
): Project {
  const upgraded = projectWithRetailVersion(project, place);
  if (upgraded.schemaVersion >= 7) return upgraded;
  const entries = [...project.history, ...project.undone];
  return [
    ...project.scenarios,
    ...entries.flatMap((e) => [e.before, e.after]),
  ].some((s) => s.workforce !== undefined) ||
    entries.some((e) => e.command.type === "scenario.workforce")
    ? { ...upgraded, schemaVersion: 7 }
    : upgraded;
}

/** A restored copy retains exact captured values/history but cannot inherit another project's server authority. */
export function projectWithImportedWorkforce(project: Project): Project {
  const entries = [...project.history, ...project.undone];
  if (
    ![
      ...project.scenarios,
      ...entries.flatMap((e) => [e.before, e.after]),
    ].some((s) => s.workforce !== undefined) &&
    !entries.some(
      (e) =>
        e.command.type === "scenario.workforce" && e.command.workforce !== null,
    )
  )
    return project;
  const copy = structuredClone(project);
  for (const scenario of [
    ...copy.scenarios,
    ...[...copy.history, ...copy.undone].flatMap((e) => [e.before, e.after]),
  ])
    if (scenario.workforce) scenario.workforce.origin = "imported";
  for (const entry of [...copy.history, ...copy.undone])
    if (entry.command.type === "scenario.workforce" && entry.command.workforce)
      entry.command.workforce.origin = "imported";
  return copy;
}
