import { z } from "zod";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { Position, Source } from "./index";
import {
  sourceImportMetadataSchema,
  sourceRightsSchema,
} from "./import-metadata";
import {
  workforceContentHash,
  workforceNetworkSchema,
  workforceTravelTimeLowerBound,
} from "./workforce";

export const ACCESSIBILITY_METHOD_VERSION = "accessibility-1.0.0" as const;
export const ACCESSIBILITY_THRESHOLDS = [15, 30, 45] as const;
export const ACCESSIBILITY_EARNINGS = [
  { id: "CE01", label: "Monthly earnings $1,250 or less" },
  { id: "CE02", label: "Monthly earnings $1,251–$3,333" },
  { id: "CE03", label: "Monthly earnings above $3,333" },
] as const;
export const ACCESSIBILITY_INDUSTRIES = [
  "Agriculture, forestry, fishing and hunting",
  "Mining, quarrying, and oil and gas extraction",
  "Utilities",
  "Construction",
  "Manufacturing",
  "Wholesale trade",
  "Retail trade",
  "Transportation and warehousing",
  "Information",
  "Finance and insurance",
  "Real estate and rental and leasing",
  "Professional, scientific and technical services",
  "Management of companies and enterprises",
  "Administrative/support and waste management/remediation",
  "Educational services",
  "Health care and social assistance",
  "Arts, entertainment and recreation",
  "Accommodation and food services",
  "Other services (except public administration)",
  "Public administration",
].map((label, i) => ({ id: `CNS${String(i + 1).padStart(2, "0")}`, label }));
export const ACCESSIBILITY_CELLS = [
  "C000",
  ...ACCESSIBILITY_EARNINGS.map((c) => c.id),
  ...ACCESSIBILITY_INDUSTRIES.map((c) => c.id),
];
export interface AccessibilitySourceFile {
  sourceId: string;
  url: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
  table?: string;
}
export interface AccessibilityDestination {
  id: string;
  /** Exact Census INTPTLON20/INTPTLAT20. Not a measured workplace entrance. */
  position: Position;
  /** Physical CSV line, including the header. */
  sourceRow: number;
  cells: Record<string, number>;
  /** Complete original row, including cells not used by this method. */
  raw: Record<string, string>;
}
export interface AccessibilityDestinationPack {
  version: 1;
  id: string;
  lodes: {
    year: 2023;
    jobType: "JT01";
    segment: "S000";
    blockGeographyVintage: 2020;
    formatVersion: string;
    dataVintage: string;
    createdates: string[];
  };
  region: {
    stateFips: string;
    label: string;
    countyGeoids: string[];
    complete: true;
  };
  pointMethod: "census-native-block-internal-point";
  sources: Source[];
  files: AccessibilitySourceFile[];
  destinations: AccessibilityDestination[];
  notes: string[];
}
export interface AccessibilityRequest {
  site: Position;
  mode: "car" | "walk";
  direction: "outbound";
  thresholdsMinutes: [15, 30, 45];
}
export interface AccessibilityNetwork {
  id: string;
  engine: string;
  engineVersion: string;
  graphHash: string;
  profileHash: string;
  sourceHashes: string[];
  extent: [number, number, number, number];
  coverage: "complete" | "bounded" | "unknown";
  costing: "static" | "time-dependent";
  notes: string[];
  exclusionProof?: {
    method: "conservative-great-circle";
    maximumSpeedKph: number;
    snapAllowanceMeters: number;
  };
}
export interface AccessibilitySourceCoverage {
  status: "complete" | "bounded" | "unknown";
  boundaryHash: string | null;
  notes: string[];
}
export type AccessibilityRouteStatus =
  | "reachable"
  | "unreachable"
  | "outside-threshold"
  | "unsnappable"
  | "outside-coverage"
  | "unavailable"
  | "zero-jobs";
export interface AccessibilityRouteRow {
  id: string;
  status: AccessibilityRouteStatus;
  seconds: number | null;
  distanceMeters: number | null;
  snapMeters: number | null;
  lowerBoundSeconds?: number;
}
export interface AccessibilityRoutingRun {
  version: 1;
  jobsPackHash: string;
  inputHash: string;
  createdAt: string;
  request: AccessibilityRequest;
  network: AccessibilityNetwork;
  sourceCoverage: AccessibilitySourceCoverage;
  rows: AccessibilityRouteRow[];
}
export interface AccessibilityCount {
  estimate: number | null;
  knownSubtotal: number | null;
  status: "complete" | "partial" | "unavailable";
  unresolvedDestinationCount: number;
  unresolvedJobs: number;
  upperBound: number | null;
}
export interface AccessibilityCategoryCount extends AccessibilityCount {
  id: string;
  label: string;
  sourceCells: string[];
}
export interface AccessibilityThreshold {
  minutes: 15 | 30 | 45;
  total: AccessibilityCount;
  earnings: AccessibilityCategoryCount[];
  industries: AccessibilityCategoryCount[];
}
export interface AccessibilityCoverage {
  regionDataComplete: boolean;
  network: AccessibilityNetwork["coverage"];
  destinations: AccessibilitySourceCoverage;
  destinationCount: number;
  zeroJobDestinationCount: number;
  sourceJobs: number;
  routeStatusCounts: Record<AccessibilityRouteStatus, number>;
}
export interface AccessibilityResolution {
  methodVersion: typeof ACCESSIBILITY_METHOD_VERSION;
  jobsPackHash: string;
  routingRunHash: string;
  inputHash: string;
  capturedAt: string;
  request: AccessibilityRequest;
  network: AccessibilityNetwork;
  coverage: AccessibilityCoverage;
  thresholds: AccessibilityThreshold[];
  uncertainty: {
    sampling: "not-provided";
    spatial: "block-representative-point";
    routing: "static-captured-network";
  };
  notes: string[];
}
export interface AccessibilitySearchDiagnostics {
  algorithm: "timedistancematrix";
  baseExpansionMeters: number;
  terminalEdgePaddingPolicy: "maximum-correlated-edge-length";
  batches: {
    firstInputIndex: number;
    inputCount: number;
    routedCount: number;
    maximumCorrelatedEdgeMeters: number;
    expansionMaxDistanceMeters: number;
  }[];
}
export interface AccessibilityContour {
  manifestId: string;
  inputHash: string;
  site: Position;
  mode: "car" | "walk";
  direction: "outbound";
  minutes: [15, 30, 45];
  geometry: FeatureCollection<Polygon | MultiPolygon>;
  notes: string[];
}
export interface CapturedAccessibilityResult {
  version: 1;
  run: AccessibilityRoutingRun;
  result: AccessibilityResolution;
  contour: AccessibilityContour;
  provider: {
    inputHash: string;
    manifestId: string;
    siteSnapMeters: number;
    search: AccessibilitySearchDiagnostics;
  };
}

export const accessibilityShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(10000),
  count = z.number().finite().int().min(0).max(1e12);
const position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export const accessibilitySourceSchema: z.ZodType<Source> = z
  .object({
    id: text,
    name: text,
    url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
    vintage: text,
    license: text,
    kind: z.enum([
      "observed",
      "published-estimate",
      "inferred",
      "user-supplied",
    ]),
    description: z.string().max(10000).optional(),
    import: sourceImportMetadataSchema.optional(),
    rights: sourceRightsSchema.optional(),
  })
  .strict();
export const accessibilityFileSchema: z.ZodType<AccessibilitySourceFile> = z
  .object({
    sourceId: text,
    url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
    sha256: accessibilityShaSchema,
    bytes: count,
    retrievedAt: z.iso.datetime({ offset: true }),
    table: text.optional(),
  })
  .strict();
export const accessibilitySourceMetadataSchema = z
  .object({
    id: text,
    lodes: z
      .object({
        year: z.literal(2023),
        jobType: z.literal("JT01"),
        segment: z.literal("S000"),
        blockGeographyVintage: z.literal(2020),
        formatVersion: text,
        dataVintage: text,
        createdates: z
          .array(z.string().regex(/^\d{8}$/))
          .min(1)
          .max(100),
      })
      .strict(),
    region: z
      .object({
        stateFips: z.string().regex(/^\d{2}$/),
        label: text,
        countyGeoids: z
          .array(z.string().regex(/^\d{5}$/))
          .min(1)
          .max(4000),
        complete: z.literal(true),
      })
      .strict(),
    pointMethod: z.literal("census-native-block-internal-point"),
  })
  .strict();
export const accessibilityDestinationPackSchema: z.ZodType<AccessibilityDestinationPack> =
  accessibilitySourceMetadataSchema
    .extend({
      version: z.literal(1),
      sources: z.array(accessibilitySourceSchema).min(1).max(100),
      files: z.array(accessibilityFileSchema).min(1).max(100),
      destinations: z
        .array(
          z
            .object({
              id: z.string().regex(/^\d{15}$/),
              position,
              sourceRow: count.min(2),
              cells: z.record(z.string(), count),
              raw: z.record(z.string().max(100), z.string().max(1000)),
            })
            .strict(),
        )
        .min(1)
        .max(500000),
      notes: z.array(text).max(100),
    })
    .strict()
    .superRefine((pack, ctx) => {
      const fail = (message: string) =>
        ctx.addIssue({ code: "custom", message });
      const ids = new Set<string>(),
        lines = new Set<number>(),
        counties = new Set(pack.region.countyGeoids),
        sources = new Set(pack.sources.map((s) => s.id));
      if (
        counties.size !== pack.region.countyGeoids.length ||
        [...counties].some((c) => !c.startsWith(pack.region.stateFips))
      )
        fail(
          "Source county inventory must be unique and within the declared state.",
        );
      if (
        sources.size !== pack.sources.length ||
        pack.files.some((f) => !sources.has(f.sourceId))
      )
        fail("File provenance must resolve to unique retained sources.");
      for (const row of pack.destinations) {
        if (ids.has(row.id) || lines.has(row.sourceRow))
          fail("Every source workplace row must be retained once.");
        ids.add(row.id);
        lines.add(row.sourceRow);
        if (!counties.has(row.id.slice(0, 5)))
          fail("Workplace geography is outside the declared source inventory.");
        if (
          Object.keys(row.cells).length !== ACCESSIBILITY_CELLS.length ||
          ACCESSIBILITY_CELLS.some(
            (k) =>
              row.cells[k] === undefined ||
              !/^\d+$/.test(row.raw[k] ?? "") ||
              Number(row.raw[k]) !== row.cells[k],
          )
        )
          fail(
            "Source counts must retain every expected numeric cell; missing is never zero.",
          );
        if (
          row.raw.w_geocode !== row.id ||
          !pack.lodes.createdates.includes(row.raw.createdate)
        )
          fail(
            "Source row identity and createdate must match the retained raw row.",
          );
        if (
          [ACCESSIBILITY_EARNINGS, ACCESSIBILITY_INDUSTRIES].some(
            (family) =>
              family.reduce((sum, c) => sum + row.cells[c.id], 0) !==
              row.cells.C000,
          )
        )
          fail(
            "Each earnings and industry family must separately reconcile to total primary jobs.",
          );
      }
    });
export const accessibilityRequestSchema: z.ZodType<AccessibilityRequest> = z
  .object({
    site: position,
    mode: z.enum(["car", "walk"]),
    direction: z.literal("outbound"),
    thresholdsMinutes: z.tuple([z.literal(15), z.literal(30), z.literal(45)]),
  })
  .strict();
export const accessibilityNetworkSchema: z.ZodType<AccessibilityNetwork> =
  workforceNetworkSchema;
export const accessibilitySourceCoverageSchema: z.ZodType<AccessibilitySourceCoverage> =
  z
    .object({
      status: z.enum(["complete", "bounded", "unknown"]),
      boundaryHash: accessibilityShaSchema.nullable(),
      notes: z.array(text).max(100),
    })
    .strict()
    .refine(
      (v) => v.status !== "complete" || v.boundaryHash !== null,
      "Complete source coverage requires a captured boundary hash.",
    );
export const ACCESSIBILITY_ROUTE_STATUSES: AccessibilityRouteStatus[] = [
  "reachable",
  "unreachable",
  "outside-threshold",
  "unsnappable",
  "outside-coverage",
  "unavailable",
  "zero-jobs",
];
export const accessibilityRouteRowSchema: z.ZodType<AccessibilityRouteRow> = z
  .object({
    id: z.string().regex(/^\d{15}$/),
    status: z.enum(
      ACCESSIBILITY_ROUTE_STATUSES as [
        AccessibilityRouteStatus,
        ...AccessibilityRouteStatus[],
      ],
    ),
    seconds: z.number().finite().min(0).nullable(),
    distanceMeters: z.number().finite().min(0).nullable(),
    snapMeters: z.number().finite().min(0).max(250.1).nullable(),
    lowerBoundSeconds: z.number().finite().min(0).optional(),
  })
  .strict()
  .superRefine((r, c) => {
    if (
      (r.status === "reachable") !== (r.seconds !== null) ||
      (r.status !== "reachable" && r.distanceMeters !== null)
    )
      c.addIssue({
        code: "custom",
        message:
          "Only a reachable destination has a travel time/distance; zero time is valid.",
      });
    if (
      (r.status === "outside-threshold") !==
        (r.lowerBoundSeconds !== undefined) ||
      (r.status === "outside-threshold" && !(r.lowerBoundSeconds! > 2700))
    )
      c.addIssue({
        code: "custom",
        message:
          "Outside-threshold requires its retained proof strictly beyond 45 minutes.",
      });
  });
export const accessibilityRoutingRunSchema: z.ZodType<AccessibilityRoutingRun> =
  z
    .object({
      version: z.literal(1),
      jobsPackHash: accessibilityShaSchema,
      inputHash: accessibilityShaSchema,
      createdAt: z.iso.datetime({ offset: true }),
      request: accessibilityRequestSchema,
      network: accessibilityNetworkSchema,
      sourceCoverage: accessibilitySourceCoverageSchema,
      rows: z.array(accessibilityRouteRowSchema).min(1).max(500000),
    })
    .strict();
export const accessibilityContentHash = workforceContentHash;
export function accessibilityTravelTimeLowerBound(
  destination: Position,
  site: Position,
  network: AccessibilityNetwork,
): number | null {
  return network.exclusionProof
    ? workforceTravelTimeLowerBound(destination, site, network.exclusionProof)
    : null;
}
export function assertAccessibilityDestinationPack(
  input: unknown,
): asserts input is AccessibilityDestinationPack {
  accessibilityDestinationPackSchema.parse(input);
}
export async function accessibilityRoutingInputHash(
  jobsPackHash: string,
  request: AccessibilityRequest,
  network: AccessibilityNetwork,
  sourceCoverage: AccessibilitySourceCoverage,
): Promise<string> {
  accessibilityShaSchema.parse(jobsPackHash);
  accessibilityRequestSchema.parse(request);
  accessibilityNetworkSchema.parse(network);
  accessibilitySourceCoverageSchema.parse(sourceCoverage);
  return accessibilityContentHash({
    jobsPackHash,
    request,
    network,
    sourceCoverage,
  });
}
export async function verifyAccessibilityRun(
  pack: AccessibilityDestinationPack,
  run: AccessibilityRoutingRun,
): Promise<void> {
  assertAccessibilityDestinationPack(pack);
  accessibilityRoutingRunSchema.parse(run);
  if (
    (await accessibilityContentHash(pack)) !== run.jobsPackHash ||
    (await accessibilityRoutingInputHash(
      run.jobsPackHash,
      run.request,
      run.network,
      run.sourceCoverage,
    )) !== run.inputHash
  )
    throw new Error("Accessibility query, source or network hash mismatch.");
  const rows = new Map(run.rows.map((r) => [r.id, r]));
  if (rows.size !== run.rows.length || rows.size !== pack.destinations.length)
    throw new Error(
      "Retain exactly one route ledger row per workplace source row.",
    );
  for (const d of pack.destinations) {
    const r = rows.get(d.id);
    if (!r)
      throw new Error(
        "A workplace destination is missing from the route ledger.",
      );
    if (r.status === "zero-jobs" && d.cells.C000 !== 0)
      throw new Error(
        "A positive-job workplace cannot be excluded as zero jobs.",
      );
    const lower = accessibilityTravelTimeLowerBound(
      d.position,
      run.request.site,
      run.network,
    );
    if (
      r.status === "outside-threshold" &&
      (lower === null ||
        lower <= 2700 ||
        Math.abs(lower - r.lowerBoundSeconds!) > 1e-6)
    )
      throw new Error(
        "An excluded workplace does not satisfy its retained conservative bound.",
      );
    if (r.seconds !== null && lower !== null && r.seconds + 1 < lower)
      throw new Error("The route violates its captured maximum-speed bound.");
  }
}
