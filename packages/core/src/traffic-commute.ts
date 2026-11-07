import { z } from "zod";
import type { Position, Source } from "./index";
import type { TrafficPeriod } from "./traffic";
import {
  workforceCellSchema,
  workforceContentHash,
  type WorkforceCell,
} from "./workforce";
import {
  trafficPeriodSchema,
  validateTrafficClock,
} from "./traffic-validation";
import {
  sourceImportMetadataSchema,
  sourceRightsSchema,
} from "./import-metadata";

/** Standalone source-derived prior, independent of the live impact-model version. */
export const TRAFFIC_COMMUTE_METHOD_VERSION = "1.0.0";
export const TRAFFIC_COMMUTE_METHOD =
  "acs-drive-alone-allocated-by-lodes-primary-destinations" as const;

export const TRAFFIC_COMMUTE_DEPARTURE_BINS = [
  [17, 0, 18000],
  [18, 18000, 19800],
  [19, 19800, 21600],
  [20, 21600, 23400],
  [21, 23400, 25200],
  [22, 25200, 27000],
  [23, 27000, 28800],
  [24, 28800, 30600],
  [25, 30600, 32400],
  [26, 32400, 36000],
  [27, 36000, 39600],
  [28, 39600, 43200],
  [29, 43200, 57600],
  [30, 57600, 86400],
].map(([cell, beginSeconds, endSeconds]) => ({
  cellId: `B08132_${String(cell).padStart(3, "0")}`,
  beginSeconds,
  endSeconds,
}));

export interface TrafficCommuteSourceFile {
  role:
    | "lodes-main"
    | "lodes-aux"
    | "lodes-rac"
    | "lodes-wac"
    | "lodes-crosswalk"
    | "acs"
    | "geography"
    | "block-points"
    | "reconciliation";
  sourceId: string;
  url: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
  /** Raw row createdate and release metadata are different, retained facts. */
  createdate?: string;
  metadata?: Record<string, string>;
}
export type TrafficCommuteTractJoin =
  | { status: "verified"; tractGeoid: string; evidenceFileSha256: string }
  | {
      status: "unresolved";
      candidateTractGeoids: string[];
      reason: "split-geography" | "missing-geography";
      evidenceFileSha256: string;
    };
export interface TrafficCommuteBlock {
  geoid: string;
  /** A Census internal point, never an observed entrance or population weight. */
  position: Position | null;
  pointFileSha256: string;
  tractJoin: TrafficCommuteTractJoin;
}
export interface TrafficCommuteJobRow {
  blockGeoid: string;
  jobs: number;
  sourceFileSha256: string;
  sourceRow: number;
  /** Original published CSV cells, including C000 and createdate. */
  raw: Record<string, string>;
}
export interface TrafficCommuteFlow {
  id: string;
  homeBlockGeoid: string;
  workBlockGeoid: string;
  part: "main" | "aux";
  jobs: number;
  sourceFileSha256: string;
  sourceRow: number;
  /** Original S000 and all other published cells retained without reclassification. */
  raw: Record<string, string>;
}
export interface TrafficCommuteTract {
  geoid: string;
  name: string;
  sourceFileSha256: string;
  /** All 90 native B08132 estimate/MOE cells, including explicit unknown values. */
  cells: Record<string, WorkforceCell>;
}
export interface TrafficCommuteSourcePack {
  version: 1;
  id: string;
  lodes: {
    dataYear: 2023;
    jobType: "JT01";
    blockVintage: "2020";
    /** Actual captured metadata; do not infer release version from the data year. */
    formatVersion: string;
    dataVintage: string;
  };
  acs: {
    dataset: "acs/acs5";
    vintage: 2024;
    period: { start: 2020; end: 2024 };
    table: "B08132";
    geography: "tract";
    boundaryVintage: "2024";
    confidenceLevel: 90;
  };
  coverage: {
    stateFips: string;
    label: string;
    /** Bounded source cohort, not a claim that every trip through the local graph is covered. */
    residentTractGeoids: string[];
    rac: "complete-for-declared-tracts" | "partial";
    odMain: "complete-for-declared-tracts" | "partial";
    notes: string[];
  };
  /** Statewide audit against retained original files; these jobs are not all compiled. */
  reconciliation: {
    evidenceFileSha256: string;
    residentJobs: number;
    mainJobs: number;
    auxiliaryJobs: number;
    workplaceJobs: number;
    unresolvedOutboundJobs: number;
    auxiliaryFlowCount: number;
    negativeResidenceResidualBlocks: number;
    workplaceMismatchBlocks: number;
  };
  sources: Source[];
  files: TrafficCommuteSourceFile[];
  blocks: TrafficCommuteBlock[];
  residences: TrafficCommuteJobRow[];
  workplaces: TrafficCommuteJobRow[];
  flows: TrafficCommuteFlow[];
  tracts: TrafficCommuteTract[];
  notes: string[];
}
export interface TrafficCommuteRecipe {
  version: 1;
  method: typeof TRAFFIC_COMMUTE_METHOD;
  originTractGeoids: string[];
  departureCellIds: string[];
  period: TrafficPeriod;
  /** Explicit home clock per selected tract; never assume all Arizona uses one clock. */
  homeClocks: {
    tractGeoid: string;
    timeZone: string;
    utcOffsetMinutes: number;
  }[];
  withinBin: "uniform";
  sourceIds: string[];
  notes: string[];
}

export interface TrafficCommuteFlowMass {
  id: string;
  flowId: string;
  tractGeoid: string;
  cellId: string;
  homeBlockGeoid: string;
  workBlockGeoid: string;
  primaryJobs: number;
  residentPrimaryJobs: number;
  destinationShare: number;
  expectedVehicles: number;
  homeBeginSeconds: number;
  homeEndSeconds: number;
  /** Seconds to add to home-clock time to express it in the local simulation clock. */
  localClockShiftSeconds: number;
}
export interface TrafficCommutePriorCell {
  tractGeoid: string;
  cellId: string;
  estimate: WorkforceCell["estimate"];
  marginOfError: WorkforceCell["marginOfError"];
  status: "allocated" | "unresolved" | "unavailable";
  residentPrimaryJobs: number | null;
  knownDestinationJobs: number | null;
  unresolvedDestinationJobs: number | null;
  allocatedVehicles: number | null;
  unresolvedVehicles: number | null;
  reason: string | null;
}
export interface TrafficCommutePrior {
  version: 1;
  methodVersion: typeof TRAFFIC_COMMUTE_METHOD_VERSION;
  recipe: TrafficCommuteRecipe;
  cells: TrafficCommutePriorCell[];
  flows: TrafficCommuteFlowMass[];
  coverage: {
    selectedTracts: number;
    unknownEstimateCells: number;
    unavailableMoeCells: number;
    unresolvedAllocationCells: number;
    /** Jobs, not vehicles: non-AZ origins need their own resident denominator and ACS. */
    externalOriginPrimaryJobs: number;
    externalOriginFlowCount: number;
    unselectedResidentPrimaryJobs: number;
    ambiguousResidentPrimaryJobs: number;
  };
  totals: {
    sourceVehicles: number | null;
    knownSourceVehicles: number | null;
    allocatedVehicles: number;
    unresolvedVehicles: number | null;
  };
  notes: string[];
}

/** Contract for a later regional route stage; source prior contains no invented route. */
export interface TrafficCommuteRouteAttachment {
  flowId: string;
  status:
    | "routed"
    | "no-local-intersection"
    | "unreachable"
    | "unsnappable"
    | "outside-coverage"
    | "unmatched-local-network"
    | "reentry-unsupported";
  regionalRouteHash: string | null;
  regionalSeconds: number | null;
  /** Exact local path, already verified against the local directed graph. */
  local: null | {
    edges: string[];
    prefixSeconds: number;
    suffixSeconds: number;
    classification: "internal" | "inbound" | "outbound" | "through";
    bindingHash: string;
    departLaneId: string;
    departPositionMeters: number;
    arrivalLaneId: string;
    arrivalPositionMeters: number;
  };
  notes: string[];
}
export interface TrafficCommuteRouteSet {
  version: 1;
  sourcePackHash: string;
  priorHash: string;
  regionalGraphHash: string;
  regionalSettingsHash: string;
  localNetworkHash: string;
  localInventoryHash: string;
  attachments: TrafficCommuteRouteAttachment[];
  notes: string[];
}

// Validation below deliberately retains unknown evidence instead of assigning zero.
const text = z.string().min(1).max(4000);
const id = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^\s<>"'&\u0000-\u001f]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().finite().nonnegative();
const geoid = (length: number) =>
  z.string().regex(new RegExp(`^\\d{${length}}$`));
const tract = geoid(11),
  block = geoid(15);
const notes = z.array(z.string().max(4000)).max(1000);
const raw = z
  .record(z.string().min(1).max(100), z.string().max(500))
  .refine(
    (v) => Object.keys(v).length <= 100,
    "Native CSV records have bounded columns",
  );
const source = z
  .object({
    id,
    name: z.string().min(1).max(240),
    url: z.string().max(4000),
    vintage: z.string().max(100),
    license: z.string().max(2000),
    kind: z.enum([
      "observed",
      "published-estimate",
      "inferred",
      "user-supplied",
    ]),
    description: z.string().max(5000).optional(),
    import: sourceImportMetadataSchema.optional(),
    rights: sourceRightsSchema.optional(),
  })
  .strict();
const file = z
  .object({
    role: z.enum([
      "lodes-main",
      "lodes-aux",
      "lodes-rac",
      "lodes-wac",
      "lodes-crosswalk",
      "acs",
      "geography",
      "block-points",
      "reconciliation",
    ]),
    sourceId: id,
    url: z.string().max(4000),
    sha256: hash,
    bytes: count,
    retrievedAt: z.iso.datetime({ offset: true }),
    createdate: z.string().max(100).optional(),
    metadata: raw.optional(),
  })
  .strict();
export {
  source as trafficCommuteSourceSchema,
  file as trafficCommuteSourceFileSchema,
};
const cellIds = Array.from(
  { length: 90 },
  (_, i) => `B08132_${String(i + 1).padStart(3, "0")}`,
);
const cells = z
  .record(z.string().regex(/^B08132_\d{3}$/), workforceCellSchema)
  .refine(
    (v) =>
      Object.keys(v).length === 90 && cellIds.every((k) => Object.hasOwn(v, k)),
    "Retain all 90 original B08132 estimate/MOE cells",
  );
const jobRow = z
  .object({
    blockGeoid: block,
    jobs: count,
    sourceFileSha256: hash,
    sourceRow: count.min(2),
    raw,
  })
  .strict();
export const trafficCommuteSourcePackSchema: z.ZodType<TrafficCommuteSourcePack> =
  z
    .object({
      version: z.literal(1),
      id,
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
          stateFips: geoid(2),
          label: text,
          residentTractGeoids: z.array(tract).min(1).max(500),
          rac: z.enum(["complete-for-declared-tracts", "partial"]),
          odMain: z.enum(["complete-for-declared-tracts", "partial"]),
          notes,
        })
        .strict(),
      reconciliation: z
        .object({
          evidenceFileSha256: hash,
          residentJobs: count,
          mainJobs: count,
          auxiliaryJobs: count,
          workplaceJobs: count,
          unresolvedOutboundJobs: count,
          auxiliaryFlowCount: count,
          negativeResidenceResidualBlocks: count,
          workplaceMismatchBlocks: count,
        })
        .strict(),
      sources: z.array(source).min(1).max(100),
      files: z.array(file).min(1).max(100),
      blocks: z
        .array(
          z
            .object({
              geoid: block,
              position: z
                .tuple([
                  z.number().finite().min(-180).max(180),
                  z.number().finite().min(-90).max(90),
                ])
                .nullable(),
              pointFileSha256: hash,
              tractJoin: z.discriminatedUnion("status", [
                z
                  .object({
                    status: z.literal("verified"),
                    tractGeoid: tract,
                    evidenceFileSha256: hash,
                  })
                  .strict(),
                z
                  .object({
                    status: z.literal("unresolved"),
                    candidateTractGeoids: z.array(tract).max(100),
                    reason: z.enum(["split-geography", "missing-geography"]),
                    evidenceFileSha256: hash,
                  })
                  .strict(),
              ]),
            })
            .strict(),
        )
        .max(100000),
      residences: z.array(jobRow).max(100000),
      workplaces: z.array(jobRow).max(100000),
      flows: z
        .array(
          z
            .object({
              id,
              homeBlockGeoid: block,
              workBlockGeoid: block,
              part: z.enum(["main", "aux"]),
              jobs: count,
              sourceFileSha256: hash,
              sourceRow: count.min(2),
              raw,
            })
            .strict(),
        )
        .max(250000),
      tracts: z
        .array(
          z
            .object({ geoid: tract, name: text, sourceFileSha256: hash, cells })
            .strict(),
        )
        .max(500),
      notes,
    })
    .strict();
export const trafficCommuteRecipeSchema: z.ZodType<TrafficCommuteRecipe> = z
  .object({
    version: z.literal(1),
    method: z.literal(TRAFFIC_COMMUTE_METHOD),
    originTractGeoids: z.array(tract).min(1).max(500),
    departureCellIds: z
      .array(
        z
          .string()
          .refine(
            (v) => TRAFFIC_COMMUTE_DEPARTURE_BINS.some((b) => b.cellId === v),
            "Select an original B08132 drive-alone departure cell",
          ),
      )
      .min(1)
      .max(14),
    period: trafficPeriodSchema,
    homeClocks: z
      .array(
        z
          .object({
            tractGeoid: tract,
            timeZone: text,
            utcOffsetMinutes: z.number().int().min(-840).max(840),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    withinBin: z.literal("uniform"),
    sourceIds: z.array(id).min(1).max(100),
    notes,
  })
  .strict();

function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must be unique.`);
}
/** Native row and inventory integrity, not a claim that a client supplied pack is official. */
export function validateTrafficCommuteSourcePack(
  pack: TrafficCommuteSourcePack,
): void {
  trafficCommuteSourcePackSchema.parse(pack);
  unique(
    pack.sources.map((s) => s.id),
    "Commute source IDs",
  );
  unique(
    pack.files.map((f) => f.sha256),
    "Commute file hashes",
  );
  unique(
    pack.blocks.map((b) => b.geoid),
    "Commute block IDs",
  );
  unique(
    pack.residences.map((r) => r.blockGeoid),
    "RAC home blocks",
  );
  unique(
    pack.workplaces.map((r) => r.blockGeoid),
    "WAC work blocks",
  );
  unique(
    pack.flows.map((f) => f.id),
    "Commute flow IDs",
  );
  unique(
    pack.flows.map((f) => `${f.homeBlockGeoid}:${f.workBlockGeoid}`),
    "Home/work pairs",
  );
  unique(
    pack.tracts.map((t) => t.geoid),
    "Native ACS tract IDs",
  );
  unique(pack.coverage.residentTractGeoids, "Declared resident tracts");
  const sources = new Set(pack.sources.map((s) => s.id));
  const files = new Map(pack.files.map((f) => [f.sha256, f]));
  const blocks = new Set(pack.blocks.map((b) => b.geoid));
  const tracts = new Set(pack.tracts.map((t) => t.geoid));
  const assertFile = (
    sha: string,
    roles: TrafficCommuteSourceFile["role"][],
  ) => {
    const f = files.get(sha);
    if (!f || !roles.includes(f.role))
      throw new Error(
        "Commute evidence refers to a missing or wrong-role retained file.",
      );
  };
  for (const f of pack.files)
    if (!sources.has(f.sourceId))
      throw new Error("A commute file must retain its source citation.");
  for (const t of pack.coverage.residentTractGeoids) {
    if (!tracts.has(t) || !t.startsWith(pack.coverage.stateFips))
      throw new Error(
        "Declared resident tracts need native ACS evidence in the declared state.",
      );
  }
  assertFile(pack.reconciliation.evidenceFileSha256, ["reconciliation"]);
  const r = pack.reconciliation;
  if (
    r.negativeResidenceResidualBlocks === 0 &&
    r.residentJobs !== r.mainJobs + r.unresolvedOutboundJobs
  )
    throw new Error(
      "Statewide resident jobs do not reconcile with known and unresolved destinations.",
    );
  if (
    r.workplaceMismatchBlocks === 0 &&
    r.workplaceJobs !== r.mainJobs + r.auxiliaryJobs
  )
    throw new Error(
      "Statewide workplace jobs do not reconcile with main and auxiliary jobs.",
    );
  for (const b of pack.blocks) {
    assertFile(b.pointFileSha256, ["block-points", "lodes-crosswalk"]);
    assertFile(b.tractJoin.evidenceFileSha256, ["geography"]);
    if (b.tractJoin.status === "unresolved")
      unique(b.tractJoin.candidateTractGeoids, "Candidate tract IDs");
  }
  for (const [rows, role, field] of [
    [pack.residences, "lodes-rac", "h_geocode"],
    [pack.workplaces, "lodes-wac", "w_geocode"],
  ] as const) {
    for (const row of rows) {
      assertFile(row.sourceFileSha256, [role]);
      if (!blocks.has(row.blockGeoid))
        throw new Error(
          "Native job rows need a retained block, including explicit unavailable points/joins.",
        );
      if (
        row.raw[field] !== row.blockGeoid ||
        !/^\d+$/.test(row.raw.C000 ?? "") ||
        Number(row.raw.C000) !== row.jobs
      )
        throw new Error(
          "Native C000 and block identity must equal the parsed job row.",
        );
    }
  }
  for (const f of pack.flows) {
    assertFile(f.sourceFileSha256, [
      f.part === "main" ? "lodes-main" : "lodes-aux",
    ]);
    if (
      f.raw.h_geocode !== f.homeBlockGeoid ||
      f.raw.w_geocode !== f.workBlockGeoid ||
      !/^\d+$/.test(f.raw.S000 ?? "") ||
      Number(f.raw.S000) !== f.jobs
    )
      throw new Error(
        "Native S000 and OD identities must equal the parsed flow.",
      );
    if (
      f.part === "main" &&
      (!blocks.has(f.homeBlockGeoid) || !blocks.has(f.workBlockGeoid))
    )
      throw new Error("Main OD pairs require both retained block endpoints.");
    const inState = f.homeBlockGeoid.startsWith(pack.coverage.stateFips);
    if (
      !f.workBlockGeoid.startsWith(pack.coverage.stateFips) ||
      inState !== (f.part === "main")
    )
      throw new Error(
        "LODES main/aux membership must match workplace-state semantics.",
      );
  }
  for (const t of pack.tracts) assertFile(t.sourceFileSha256, ["acs"]);
}

export function validateTrafficCommuteRecipe(
  recipe: TrafficCommuteRecipe,
  pack?: TrafficCommuteSourcePack,
): void {
  trafficCommuteRecipeSchema.parse(recipe);
  unique(recipe.originTractGeoids, "Selected origin tracts");
  unique(recipe.departureCellIds, "Selected departure cells");
  unique(
    recipe.homeClocks.map((c) => c.tractGeoid),
    "Home clocks",
  );
  unique(recipe.sourceIds, "Recipe source IDs");
  if (
    recipe.homeClocks.length !== recipe.originTractGeoids.length ||
    recipe.homeClocks.some(
      (c) => !recipe.originTractGeoids.includes(c.tractGeoid),
    )
  )
    throw new Error(
      "Each selected tract needs exactly one explicit home clock.",
    );
  for (const clock of recipe.homeClocks)
    validateTrafficClock({
      date: recipe.period.date,
      timeZone: clock.timeZone,
      utcOffsetMinutes: clock.utcOffsetMinutes,
      beginSeconds: 0,
      endSeconds: 86400,
    });
  if (pack) {
    if (
      recipe.originTractGeoids.some(
        (t) => !pack.coverage.residentTractGeoids.includes(t),
      )
    )
      throw new Error(
        "Recipe origin tracts must belong to the retained source cohort.",
      );
    if (recipe.sourceIds.some((id) => !pack.sources.some((s) => s.id === id)))
      throw new Error("Recipe source IDs must resolve in the retained pack.");
  }
}

export const trafficCommuteContentHash = workforceContentHash;

export const trafficCommuteRouteSetSchema: z.ZodType<TrafficCommuteRouteSet> = z
  .object({
    version: z.literal(1),
    sourcePackHash: hash,
    priorHash: hash,
    regionalGraphHash: hash,
    regionalSettingsHash: hash,
    localNetworkHash: hash,
    localInventoryHash: hash,
    attachments: z
      .array(
        z
          .object({
            flowId: id,
            status: z.enum([
              "routed",
              "no-local-intersection",
              "unreachable",
              "unsnappable",
              "outside-coverage",
              "unmatched-local-network",
              "reentry-unsupported",
            ]),
            regionalRouteHash: hash.nullable(),
            regionalSeconds: seconds.nullable(),
            local: z
              .object({
                edges: z.array(id).min(1).max(100000),
                prefixSeconds: seconds,
                suffixSeconds: seconds,
                classification: z.enum([
                  "internal",
                  "inbound",
                  "outbound",
                  "through",
                ]),
                bindingHash: hash,
                departLaneId: id,
                departPositionMeters: seconds,
                arrivalLaneId: id,
                arrivalPositionMeters: seconds,
              })
              .strict()
              .nullable(),
            notes,
          })
          .strict()
          .superRefine((row, c) => {
            if ((row.status === "routed") !== (row.local !== null))
              c.addIssue({
                code: "custom",
                message: "Only successfully routed flows have a local path.",
              });
            if (
              (row.status === "routed" ||
                row.status === "no-local-intersection") &&
              (row.regionalRouteHash === null || row.regionalSeconds === null)
            )
              c.addIssue({
                code: "custom",
                message:
                  "A routed or nonintersecting flow requires retained regional path evidence.",
              });
            if (
              row.local &&
              row.regionalSeconds !== null &&
              row.local.prefixSeconds + row.local.suffixSeconds >=
                row.regionalSeconds
            )
              c.addIssue({
                code: "custom",
                message:
                  "A local route needs positive regional travel time between its prefix and suffix.",
              });
          }),
      )
      .max(250000),
    notes,
  })
  .strict();

/** Every selected source pair is retained, including rows whose ACS estimate is unavailable. */
export function trafficCommuteRoutingFlows(
  pack: TrafficCommuteSourcePack,
  recipe: TrafficCommuteRecipe,
): TrafficCommuteFlow[] {
  const selected = new Set(recipe.originTractGeoids);
  const blocks = new Map(pack.blocks.map((b) => [b.geoid, b]));
  return pack.flows
    .filter((f) => {
      if (f.part !== "main") return false;
      const join = blocks.get(f.homeBlockGeoid)?.tractJoin;
      return join?.status === "verified"
        ? selected.has(join.tractGeoid)
        : !!join &&
            (!join.candidateTractGeoids.length ||
              join.candidateTractGeoids.some((t) => selected.has(t)));
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export function validateTrafficCommuteRouteSet(
  routes: TrafficCommuteRouteSet,
  expectedFlowIds?: readonly string[],
): void {
  trafficCommuteRouteSetSchema.parse(routes);
  unique(
    routes.attachments.map((r) => r.flowId),
    "Commute route source-flow IDs",
  );
  if (expectedFlowIds) {
    const expected = new Set(expectedFlowIds);
    if (
      routes.attachments.length !== expected.size ||
      routes.attachments.some((r) => !expected.has(r.flowId))
    )
      throw new Error(
        "Every selected native OD flow needs exactly one explicit route outcome; missing routes are not zero.",
      );
  }
}
