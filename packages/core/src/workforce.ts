import { z } from "zod";
import type { CensusValue, Position, Source } from "./index";

export const WORKFORCE_THRESHOLDS = [15, 30, 45] as const;
export const WORKFORCE_ALLOCATION_TOLERANCE = 1e-10;
export type WorkforceTable = "B15003" | "C24010";
export interface WorkforceCell {
  estimate: CensusValue;
  marginOfError: CensusValue;
}
export interface WorkforceNativeUnit {
  /** Native ACS block-group GEOID; not an invented sub-block cohort. */
  geoid: string;
  name: string;
  education: Record<string, WorkforceCell>;
  occupation: Record<string, WorkforceCell>;
  allocationStatus: "complete" | "incomplete" | "unavailable";
}
export interface WorkforceOrigin {
  /** Retained Census block identifier, independently matched to the ACS geography. */
  id: string;
  unitGeoid: string;
  position: Position;
  population2020: number;
  /** Unrounded proportion of the complete native unit's allocation population. */
  weight: number;
}
export interface WorkforceUnallocatedOrigin {
  id: string;
  position: Position;
  population2020: number;
  candidateUnitGeoids: string[];
  reason: "split-current-geography";
}
export interface WorkforceSourceFile {
  sourceId: string;
  url: string;
  sha256: string;
  retrievedAt: string;
  table?: string;
  bytes?: number;
}
export interface WorkforceCohortPack {
  version: 1;
  id: string;
  acs: {
    dataset: "acs/acs5";
    vintage: 2024;
    period: { start: 2020; end: 2024 };
    confidenceLevel: 90;
    boundaryVintage: string;
  };
  /** Completeness of the declared counties, not of every possible commute shed. */
  region: { label: string; countyGeoids: string[]; complete: boolean };
  sources: Source[];
  files: WorkforceSourceFile[];
  allocation: {
    method: "2020-block-population";
    sourceId: string;
    vintage: 2020;
    geographyMatch: "verified";
    notes: string[];
  };
  units: WorkforceNativeUnit[];
  origins: WorkforceOrigin[];
  /** Ambiguous original blocks retained once, never fractionally invented. */
  unallocatedOrigins: WorkforceUnallocatedOrigin[];
}
export interface WorkforceRequest {
  site: Position;
  mode: "car" | "walk";
  direction: "inbound";
  thresholdsMinutes: [15, 30, 45];
}
export interface WorkforceNetwork {
  id: string;
  engine: string;
  engineVersion: string;
  graphHash: string;
  profileHash: string;
  sourceHashes: string[];
  extent: [number, number, number, number];
  /** Complete means the entire potential 45-minute catchment, not just loaded roads. */
  coverage: "complete" | "bounded" | "unknown";
  costing: "static" | "time-dependent";
  notes: string[];
  exclusionProof?: WorkforceExclusionProof;
}
export interface WorkforceExclusionProof {
  method: "conservative-great-circle";
  maximumSpeedKph: number;
  /** Total possible endpoint snapping, not a per-end allowance. */
  snapAllowanceMeters: number;
}
export type WorkforceRouteStatus =
  | "reachable"
  | "unreachable"
  | "outside-threshold"
  | "unsnappable"
  | "outside-coverage"
  | "unavailable";
export interface WorkforceRouteRow {
  id: string;
  status: WorkforceRouteStatus;
  seconds: number | null;
  distanceMeters: number | null;
  snapMeters: number | null;
  lowerBoundSeconds?: number;
}
export interface WorkforceRoutingRun {
  version: 1;
  cohortPackHash: string;
  inputHash: string;
  createdAt: string;
  request: WorkforceRequest;
  network: WorkforceNetwork;
  /** Source-cohort coverage is independent of the extent of the routing graph. */
  cohortCoverage: WorkforceCohortCoverage;
  rows: WorkforceRouteRow[];
}
export interface WorkforceCohortCoverage {
  status: "complete" | "bounded" | "unknown";
  boundaryHash: string | null;
  notes: string[];
}
export interface WorkforceCategoryDefinition {
  id: string;
  label: string;
  cells: readonly string[];
}
const range = (table: WorkforceTable, start: number, end = start) =>
  Array.from(
    { length: end - start + 1 },
    (_, i) => `${table}_${String(i + start).padStart(3, "0")}`,
  );
export const WORKFORCE_PANELS = {
  education: {
    table: "B15003" as const,
    label: "Adult educational attainment",
    universe: "Population 25 years and over",
    totalCell: "B15003_001",
    categories: [
      {
        id: "less-than-high-school",
        label: "Less than high school",
        cells: range("B15003", 2, 16),
      },
      {
        id: "high-school",
        label: "High school graduate or equivalency",
        cells: range("B15003", 17, 18),
      },
      {
        id: "some-college",
        label: "Some college, no degree",
        cells: range("B15003", 19, 20),
      },
      {
        id: "associate",
        label: "Associate's degree",
        cells: range("B15003", 21),
      },
      {
        id: "bachelor",
        label: "Bachelor's degree",
        cells: range("B15003", 22),
      },
      {
        id: "graduate",
        label: "Graduate or professional degree",
        cells: range("B15003", 23, 25),
      },
    ] satisfies WorkforceCategoryDefinition[],
  },
  occupation: {
    table: "C24010" as const,
    label: "Occupations of employed residents",
    universe: "Civilian employed population 16 years and over",
    totalCell: "C24010_001",
    categories: [
      {
        id: "management-science-arts",
        label: "Management, business, science and arts",
        cells: ["C24010_003", "C24010_039"],
      },
      {
        id: "service",
        label: "Service occupations",
        cells: ["C24010_019", "C24010_055"],
      },
      {
        id: "sales-office",
        label: "Sales and office",
        cells: ["C24010_027", "C24010_063"],
      },
      {
        id: "natural-construction-maintenance",
        label: "Natural resources, construction and maintenance",
        cells: ["C24010_030", "C24010_066"],
      },
      {
        id: "production-transport-material",
        label: "Production, transportation and material moving",
        cells: ["C24010_034", "C24010_070"],
      },
    ] satisfies WorkforceCategoryDefinition[],
  },
} as const;

const text = z.string().trim().min(1).max(500);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime({ offset: true });
const count = z.number().finite().int().min(0).max(1e12);
const position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const censusValue = z
  .object({
    value: count.nullable(),
    raw: z.string().max(100).nullable(),
    annotation: z.string().max(100).nullable(),
    status: z.enum([
      "available",
      "missing",
      "suppressed",
      "not-applicable",
      "uncomputable",
      "controlled",
      "bounded",
    ]),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.status === "available" || v.status === "controlled") !==
      (v.value !== null)
    )
      c.addIssue({
        code: "custom",
        message:
          "Only available or controlled Census cells may contain a number.",
      });
    if (v.status === "controlled" && v.value !== 0)
      c.addIssue({
        code: "custom",
        message: "A controlled margin is an explicit zero.",
      });
  });
export const workforceCellSchema: z.ZodType<WorkforceCell> = z
  .object({ estimate: censusValue, marginOfError: censusValue })
  .strict();
const cellRecord = (table: WorkforceTable, length: number) =>
  z
    .record(
      z.string().regex(new RegExp(`^${table}_[0-9]{3}$`)),
      workforceCellSchema,
    )
    .superRefine((rows, c) => {
      const expected = range(table, 1, length);
      if (
        Object.keys(rows).length !== length ||
        expected.some((key) => !Object.hasOwn(rows, key))
      )
        c.addIssue({
          code: "custom",
          message: `Retain all ${length} native ${table} cells, including explicit missing cells.`,
        });
    });
export const workforceNativeUnitSchema: z.ZodType<WorkforceNativeUnit> = z
  .object({
    geoid: z.string().regex(/^\d{12}$/),
    name: text,
    education: cellRecord("B15003", 25),
    occupation: cellRecord("C24010", 73),
    allocationStatus: z.enum(["complete", "incomplete", "unavailable"]),
  })
  .strict();
export const workforceOriginSchema: z.ZodType<WorkforceOrigin> = z
  .object({
    id: z.string().regex(/^\d{15}$/),
    unitGeoid: z.string().regex(/^\d{12}$/),
    position,
    population2020: count,
    weight: z.number().finite().min(0).max(1),
  })
  .strict();
const source = z
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
  })
  .strict();
export const workforceCohortPackSchema: z.ZodType<WorkforceCohortPack> = z
  .object({
    version: z.literal(1),
    id: text,
    acs: z
      .object({
        dataset: z.literal("acs/acs5"),
        vintage: z.literal(2024),
        period: z
          .object({ start: z.literal(2020), end: z.literal(2024) })
          .strict(),
        confidenceLevel: z.literal(90),
        boundaryVintage: text,
      })
      .strict(),
    region: z
      .object({
        label: text,
        countyGeoids: z
          .array(z.string().regex(/^\d{5}$/))
          .min(1)
          .max(4000),
        complete: z.boolean(),
      })
      .strict(),
    sources: z.array(source).min(1).max(1000),
    files: z
      .array(
        z
          .object({
            sourceId: text,
            url: z.url({ protocol: /^https?$/ }),
            sha256: sha,
            retrievedAt: date,
            table: text.optional(),
            bytes: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    allocation: z
      .object({
        method: z.literal("2020-block-population"),
        sourceId: text,
        vintage: z.literal(2020),
        geographyMatch: z.literal("verified"),
        notes: z.array(z.string().max(10000)).max(100),
      })
      .strict(),
    units: z.array(workforceNativeUnitSchema).min(1).max(100000),
    origins: z.array(workforceOriginSchema).max(2000000),
    unallocatedOrigins: z
      .array(
        z
          .object({
            id: z.string().regex(/^\d{15}$/),
            position,
            population2020: count,
            candidateUnitGeoids: z
              .array(z.string().regex(/^\d{12}$/))
              .min(2)
              .max(100),
            reason: z.literal("split-current-geography"),
          })
          .strict(),
      )
      .max(2000000),
  })
  .strict()
  .superRefine((pack, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    const sources = new Set(pack.sources.map((s) => s.id));
    if (sources.size !== pack.sources.length)
      fail("Source IDs must be unique.");
    if (
      !sources.has(pack.allocation.sourceId) ||
      pack.files.some((f) => !sources.has(f.sourceId))
    )
      fail("Every allocation and file source must be retained.");
    const counties = new Set(pack.region.countyGeoids);
    if (counties.size !== pack.region.countyGeoids.length)
      fail("Region counties must be unique.");
    const units = new Map(pack.units.map((u) => [u.geoid, u]));
    if (units.size !== pack.units.length)
      fail("Native Census units must occur exactly once.");
    if (pack.units.some((u) => !counties.has(u.geoid.slice(0, 5))))
      fail("Every native unit must belong to the declared region.");
    const origins = new Set<string>();
    const grouped = new Map<string, WorkforceOrigin[]>();
    for (const o of pack.origins) {
      if (origins.has(o.id)) fail(`Duplicate origin ${o.id}.`);
      origins.add(o.id);
      if (!units.has(o.unitGeoid))
        fail(`Origin ${o.id} has no retained native unit.`);
      const group = grouped.get(o.unitGeoid) ?? [];
      group.push(o);
      grouped.set(o.unitGeoid, group);
      if (o.population2020 === 0 && o.weight !== 0)
        fail("Zero population origins must have zero allocation weight.");
    }
    for (const o of pack.unallocatedOrigins) {
      if (origins.has(o.id))
        fail(`Duplicate or overlapping unallocated origin ${o.id}.`);
      origins.add(o.id);
      if (new Set(o.candidateUnitGeoids).size !== o.candidateUnitGeoids.length)
        fail(
          `Unallocated origin ${o.id} must have distinct candidate native units.`,
        );
      for (const geoid of o.candidateUnitGeoids) {
        const unit = units.get(geoid);
        if (!unit)
          fail(`Unallocated origin ${o.id} references an absent native unit.`);
        else if (
          o.population2020 > 0 &&
          unit.allocationStatus !== "unavailable"
        )
          fail(
            `Positive ambiguous population requires unavailable allocation for ${geoid}.`,
          );
      }
    }
    for (const u of pack.units) {
      const os = grouped.get(u.geoid) ?? [];
      const weight = os.reduce((n, o) => n + o.weight, 0);
      const population = os.reduce((n, o) => n + o.population2020, 0);
      if (weight > 1 + WORKFORCE_ALLOCATION_TOLERANCE)
        fail(`Allocation exceeds one for ${u.geoid}.`);
      if (u.allocationStatus === "unavailable" && weight !== 0)
        fail(`Unavailable allocation must not invent weights for ${u.geoid}.`);
      if (u.allocationStatus === "complete") {
        if (
          !population ||
          Math.abs(weight - 1) > WORKFORCE_ALLOCATION_TOLERANCE
        )
          fail(
            `Complete allocation needs positive population and normalized weights for ${u.geoid}.`,
          );
        if (
          os.some(
            (o) =>
              Math.abs(o.weight - o.population2020 / population) >
              WORKFORCE_ALLOCATION_TOLERANCE,
          )
        )
          fail(`Weights do not match retained population for ${u.geoid}.`);
      }
    }
  });
export const workforceRequestSchema: z.ZodType<WorkforceRequest> = z
  .object({
    site: position,
    mode: z.enum(["car", "walk"]),
    direction: z.literal("inbound"),
    thresholdsMinutes: z.tuple([z.literal(15), z.literal(30), z.literal(45)]),
  })
  .strict();
export const workforceNetworkSchema: z.ZodType<WorkforceNetwork> = z
  .object({
    id: text,
    engine: text,
    engineVersion: text,
    graphHash: sha,
    profileHash: sha,
    sourceHashes: z.array(sha).min(1).max(1000),
    extent: z.tuple([
      z.number().finite().min(-180).max(180),
      z.number().finite().min(-90).max(90),
      z.number().finite().min(-180).max(180),
      z.number().finite().min(-90).max(90),
    ]),
    coverage: z.enum(["complete", "bounded", "unknown"]),
    costing: z.enum(["static", "time-dependent"]),
    notes: z.array(z.string().max(10000)).max(100),
    exclusionProof: z
      .object({
        method: z.literal("conservative-great-circle"),
        maximumSpeedKph: z.number().finite().positive().max(1000),
        snapAllowanceMeters: z.number().finite().min(0).max(100000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((n, c) => {
    if (n.extent[0] >= n.extent[2] || n.extent[1] >= n.extent[3])
      c.addIssue({
        code: "custom",
        message: "Network extent must be ordered west, south, east, north.",
      });
  });
export const workforceRouteRowSchema: z.ZodType<WorkforceRouteRow> = z
  .object({
    id: z.string().regex(/^\d{15}$/),
    status: z.enum([
      "reachable",
      "unreachable",
      "outside-threshold",
      "unsnappable",
      "outside-coverage",
      "unavailable",
    ]),
    seconds: z.number().finite().min(0).nullable(),
    distanceMeters: z.number().finite().min(0).nullable(),
    snapMeters: z.number().finite().min(0).nullable(),
    lowerBoundSeconds: z.number().finite().min(0).optional(),
  })
  .strict()
  .superRefine((r, c) => {
    if ((r.status === "reachable") !== (r.seconds !== null))
      c.addIssue({
        code: "custom",
        message:
          "Only reachable origins have an elapsed travel time; zero is valid.",
      });
    if (r.status !== "reachable" && r.distanceMeters !== null)
      c.addIssue({
        code: "custom",
        message:
          "An unavailable route must not carry an invented route distance.",
      });
    if (
      r.status === "outside-threshold"
        ? !(r.lowerBoundSeconds !== undefined && r.lowerBoundSeconds > 2700)
        : r.lowerBoundSeconds !== undefined
    )
      c.addIssue({
        code: "custom",
        message:
          "Only an analytically excluded origin has a lower bound, strictly greater than 45 minutes.",
      });
  });
export const workforceCohortCoverageSchema: z.ZodType<WorkforceCohortCoverage> =
  z
    .object({
      status: z.enum(["complete", "bounded", "unknown"]),
      boundaryHash: sha.nullable(),
      notes: z.array(z.string().trim().min(1).max(10000)).max(100),
    })
    .strict()
    .superRefine((coverage, c) => {
      if (
        coverage.status === "complete" &&
        (!coverage.boundaryHash || !coverage.notes.length)
      )
        c.addIssue({
          code: "custom",
          message:
            "Complete cohort coverage needs a retained boundary hash and proof notes.",
        });
    });
export const workforceRoutingRunSchema: z.ZodType<WorkforceRoutingRun> = z
  .object({
    version: z.literal(1),
    cohortPackHash: sha,
    inputHash: sha,
    createdAt: date,
    request: workforceRequestSchema,
    network: workforceNetworkSchema,
    cohortCoverage: workforceCohortCoverageSchema,
    rows: z.array(workforceRouteRowSchema).max(2000000),
  })
  .strict();

/** Conservative geometric lower bound, conditional on enforced speed and snap limits.
 * The mean-Earth great-circle distance is reduced 1% before snapping allowances;
 * it is not a road route and never supplies a reported commute time.
 */
export function workforceTravelTimeLowerBound(
  origin: Position,
  site: Position,
  proof: WorkforceExclusionProof,
): number {
  const rad = Math.PI / 180;
  const latitude = (site[1] - origin[1]) * rad,
    longitude = (site[0] - origin[0]) * rad;
  const a =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(origin[1] * rad) *
      Math.cos(site[1] * rad) *
      Math.sin(longitude / 2) ** 2;
  const meters =
    6371008.8 *
    2 *
    Math.atan2(
      Math.sqrt(Math.max(0, Math.min(1, a))),
      Math.sqrt(Math.max(0, 1 - a)),
    );
  return (
    Math.max(0, meters * 0.99 - proof.snapAllowanceMeters) /
    (proof.maximumSpeedKph / 3.6)
  );
}

export function assertWorkforceCohortPack(pack: WorkforceCohortPack): void {
  workforceCohortPackSchema.parse(pack);
}
export function assertWorkforceRoutingRun(
  run: WorkforceRoutingRun,
  pack?: WorkforceCohortPack,
): void {
  workforceRoutingRunSchema.parse(run);
  const ids = new Set(run.rows.map((r) => r.id));
  if (ids.size !== run.rows.length)
    throw new Error("Each routed origin must occur exactly once.");
  if (
    pack &&
    (ids.size !== pack.origins.length ||
      pack.origins.some((o) => !ids.has(o.id)))
  )
    throw new Error(
      "Routing rows must retain every cohort origin exactly once.",
    );
  const [w, s, e, n] = run.network.extent,
    [x, y] = run.request.site;
  if (x < w || x > e || y < s || y > n)
    throw new Error("The site lies outside the captured network extent.");
  const origins = pack
    ? new Map(pack.origins.map((o) => [o.id, o]))
    : undefined;
  for (const row of run.rows)
    if (row.status === "outside-threshold") {
      if (!run.network.exclusionProof)
        throw new Error(
          "Analytical exclusions need an enforced speed/snap proof.",
        );
      if (origins) {
        const bound = workforceTravelTimeLowerBound(
          origins.get(row.id)!.position,
          run.request.site,
          run.network.exclusionProof,
        );
        if (
          bound <= 2700 ||
          Math.abs(bound - row.lowerBoundSeconds!) >
            Math.max(1e-8, bound * 1e-12)
        )
          throw new Error(
            "An excluded origin does not satisfy its captured travel-time lower bound.",
          );
      }
    }
}
/** SHA-256 over canonical JSON; array order is deliberately preserved as captured. */
export async function workforceContentHash(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined)
            .map((k) => [k, v[k]]),
        )
      : v,
  );
  if (canonical === undefined)
    throw new Error("A workforce artifact must be JSON serializable.");
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function workforceRoutingInputHash(
  cohortPackHash: string,
  request: WorkforceRequest,
  network: WorkforceNetwork,
  cohortCoverage: WorkforceCohortCoverage,
): Promise<string> {
  sha.parse(cohortPackHash);
  workforceRequestSchema.parse(request);
  workforceNetworkSchema.parse(network);
  workforceCohortCoverageSchema.parse(cohortCoverage);
  return workforceContentHash({
    cohortPackHash,
    request,
    network,
    cohortCoverage,
  });
}
export async function verifyWorkforceRun(
  pack: WorkforceCohortPack,
  run: WorkforceRoutingRun,
): Promise<void> {
  assertWorkforceCohortPack(pack);
  assertWorkforceRoutingRun(run, pack);
  if ((await workforceContentHash(pack)) !== run.cohortPackHash)
    throw new Error(
      "Workforce cohort hash does not match the retained evidence.",
    );
  if (
    (await workforceRoutingInputHash(
      run.cohortPackHash,
      run.request,
      run.network,
      run.cohortCoverage,
    )) !== run.inputHash
  )
    throw new Error(
      "Workforce routing input hash does not match the captured request, network and cohort coverage.",
    );
}
