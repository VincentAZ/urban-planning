import { z } from "zod";
import {
  sourceImportMetadataSchema,
  sourceRightsSchema,
} from "./import-metadata";
import {
  MAX_TRAFFIC_COUNTS,
  MAX_TRAFFIC_EDGES,
  MAX_TRAFFIC_ROUTE_SEGMENTS,
  MAX_TRAFFIC_VEHICLES,
  type TrafficNetwork,
  type TrafficCountPack,
  type TrafficDemand,
  type TrafficPeriod,
  type TrafficPairRecipe,
  type TrafficSimulationResult,
  type TrafficCalibrationPlan,
  type TrafficCount,
  type TrafficOverlay,
  type TrafficSignal,
  type TrafficRouteEndpoints,
  type TrafficVehicleClass,
} from "./traffic";

const id = z
    .string()
    .min(1)
    .max(240)
    .regex(/^[^\s<>"'&\u0000-\u001f]+$/u),
  text = z.string().max(4000),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  nonnegative = z.number().finite().nonnegative(),
  integer = nonnegative.int().max(Number.MAX_SAFE_INTEGER),
  ids = z.array(id).max(1000),
  notes = z.array(text).max(1000),
  position = z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
  ]),
  date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (v) =>
        Number.isFinite(Date.parse(v)) &&
        new Date(v).toISOString().slice(0, 10) === v,
      "Invalid calendar date",
    ),
  timeZone = z
    .string()
    .min(1)
    .max(100)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Use a recognized IANA time zone"),
  timestamp = z.string().datetime({ offset: true }),
  quality = z.enum(["source", "authored", "inferred"]),
  vehicleClass = z.enum([
    "passenger",
    "truck",
    "bus",
    "motorcycle",
    "bicycle",
    "pedestrian",
  ]),
  classes = z
    .array(vehicleClass)
    .min(1)
    .max(6)
    .refine(
      (v) => new Set(v).size === v.length,
      "Vehicle classes must be unique",
    ),
  sourceIds = z
    .array(id)
    .min(1)
    .max(256)
    .refine((v) => new Set(v).size === v.length, "Source IDs must be unique"),
  source = z
    .object({
      id,
      name: z.string().min(1).max(240),
      url: text,
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
    .strict()
    .refine(
      (v) =>
        !v.import ||
        (!!v.rights &&
          [
            v.rights.privateUse,
            v.rights.cache,
            v.rights.analyze,
            v.rights.privateDisplay,
            v.rights.export,
            v.rights.historicalRetention,
          ].every(Boolean)),
      "Imported traffic sources require explicit private-use rights",
    ),
  sources = z.array(source).max(5000),
  file = z
    .object({
      sourceId: id,
      url: text,
      sha256: hash,
      bytes: integer,
      retrievedAt: timestamp,
    })
    .strict();
const clock = {
  date,
  timeZone,
  utcOffsetMinutes: z.number().int().min(-840).max(840),
  beginSeconds: integer.max(86400),
  endSeconds: integer.max(86400),
};

/** Check both ends: a repeated/missing civil-time hour cannot silently become 3600 seconds. */
export function validateTrafficClock(
  value: Pick<
    TrafficPeriod,
    "date" | "timeZone" | "utcOffsetMinutes" | "beginSeconds" | "endSeconds"
  >,
): void {
  if (value.endSeconds <= value.beginSeconds)
    throw new Error("Traffic intervals must have positive duration.");
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: value.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const origin = Date.parse(`${value.date}T00:00:00Z`);
  // Check every hour as well as the endpoints, including unusual offset transitions.
  const times = [value.beginSeconds, value.endSeconds - 1];
  for (let t = value.beginSeconds + 3600; t < value.endSeconds; t += 3600)
    times.push(t);
  for (const seconds of times) {
    const actual = Object.fromEntries(
      format
        .formatToParts(
          new Date(origin + (seconds - value.utcOffsetMinutes * 60) * 1000),
        )
        .map((p) => [p.type, p.value]),
    );
    const expected = new Date(origin + seconds * 1000).toISOString();
    if (
      `${actual.year}-${actual.month}-${actual.day}T${actual.hour}:${actual.minute}:${actual.second}` !==
      expected.slice(0, 19)
    )
      throw new Error(
        "Traffic local time and UTC offset disagree or cross an offset change. Resolve or split the interval explicitly.",
      );
  }
}
export const trafficPeriodSchema: z.ZodType<TrafficPeriod> = z
  .object({
    ...clock,
    warmupSeconds: integer.max(86400),
    cooldownSeconds: integer.max(86400),
  })
  .strict()
  .superRefine((v, c) => {
    try {
      validateTrafficClock({
        ...v,
        beginSeconds: v.beginSeconds - v.warmupSeconds,
        endSeconds: v.endSeconds + v.cooldownSeconds,
      });
    } catch (e) {
      c.addIssue({ code: "custom", message: (e as Error).message });
    }
    if (
      v.warmupSeconds > v.beginSeconds ||
      v.endSeconds + v.cooldownSeconds > 86400
    )
      c.addIssue({
        code: "custom",
        message:
          "Warmup and cooldown must remain inside the declared local day.",
      });
  });
const lane = z
  .object({
    id,
    index: integer.max(99),
    shape: z.array(position).min(2).max(10000),
    lengthMeters: z.number().finite().positive().max(1e7),
    speedMps: z.number().finite().positive().max(150),
    allowedClasses: classes,
    quality,
    sourceIds,
  })
  .strict();
export const trafficSignalSchema: z.ZodType<TrafficSignal> = z
  .object({
    id,
    nodeIds: ids,
    programId: id,
    offsetSeconds: nonnegative,
    connectionIds: z.array(z.array(id).min(1).max(1000)).min(1).max(1000),
    phases: z
      .array(
        z
          .object({
            durationSeconds: z.number().finite().positive().max(86400),
            state: z
              .string()
              .min(1)
              .max(1000)
              .regex(/^[rRyYgGoOuUs]+$/),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    quality,
    sourceIds,
  })
  .strict();
export const trafficNetworkSchema: z.ZodType<TrafficNetwork> = z
  .object({
    version: z.literal(1),
    id,
    manifest: z
      .object({
        engine: z
          .object({
            name: z.literal("sumo"),
            version: z.string().min(1).max(100),
            imageDigest: z.string().min(1).max(256),
          })
          .strict(),
        networkFileSha256: hash,
        sourceFiles: z.array(file).max(10000),
        sources,
        conversion: z
          .object({
            version: z.string().min(1).max(100),
            options: z.array(text).max(1000),
            warnings: notes,
          })
          .strict(),
        bounds: z.tuple([
          z.number().finite().min(-180).max(180),
          z.number().finite().min(-90).max(90),
          z.number().finite().min(-180).max(180),
          z.number().finite().min(-90).max(90),
        ]),
        notes,
      })
      .strict(),
    nodes: z
      .array(
        z
          .object({
            id,
            position,
            type: z.enum([
              "priority",
              "traffic_light",
              "allway_stop",
              "right_before_left",
              "dead_end",
              "unknown",
            ]),
            external: z.boolean(),
            quality,
            sourceIds,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TRAFFIC_EDGES * 2),
    edges: z
      .array(
        z
          .object({
            id,
            from: id,
            to: id,
            roadId: id.optional(),
            sourceWayIds: ids,
            lanes: z.array(lane).min(1).max(100),
            quality,
            sourceIds,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TRAFFIC_EDGES),
    connections: z
      .array(
        z
          .object({
            id,
            fromEdge: id,
            toEdge: id,
            fromLane: id,
            toLane: id,
            viaLaneIds: ids,
            direction: z.enum([
              "left",
              "right",
              "straight",
              "uturn",
              "unknown",
            ]),
            signalId: id.optional(),
            signalIndex: integer.max(999).optional(),
            quality,
            sourceIds,
          })
          .strict(),
      )
      .max(MAX_TRAFFIC_EDGES * 20),
    signals: z.array(trafficSignalSchema).max(MAX_TRAFFIC_EDGES),
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
export const trafficCountSchema: z.ZodType<TrafficCount> = z
  .object({
    id,
    stationId: z.string().min(1).max(240),
    position: position.nullable(),
    ...clock,
    value: nonnegative.nullable(),
    status: z.enum(["available", "missing", "excluded"]),
    kind: z.enum(["observed", "factored"]),
    target: target.nullable(),
    mapping: z
      .object({
        networkFileSha256: hash,
        method: z.enum(["manual", "source-id", "spatial-reviewed"]),
        snapMeters: nonnegative.nullable(),
        directionAgreement: z.enum(["confirmed", "not-applicable"]),
        reviewedBy: z.string().min(1).max(240),
        reviewedAt: timestamp,
      })
      .strict()
      .optional(),
    vehicleClasses: classes.nullable(),
    raw: z
      .object({
        directionCode: z.string().max(100),
        laneCode: z.string().max(100),
        classCode: z.string().max(100),
        recordId: z.string().min(1).max(1000),
        value: text.nullable(),
      })
      .strict(),
    sourceIds,
    notes,
  })
  .strict()
  .superRefine((v, c) => {
    try {
      validateTrafficClock(v);
    } catch (e) {
      c.addIssue({ code: "custom", message: (e as Error).message });
    }
    if (
      (v.status === "available" && v.value === null) ||
      (v.status === "missing" && v.value !== null)
    )
      c.addIssue({
        code: "custom",
        message:
          "Available counts require a value; missing counts require null.",
      });
    if (
      v.kind === "observed" &&
      v.value !== null &&
      !Number.isSafeInteger(v.value)
    )
      c.addIssue({
        code: "custom",
        message: "Observed interval counts must be whole vehicles.",
      });
    if (!!v.target !== !!v.mapping)
      c.addIssue({
        code: "custom",
        message:
          "A mapped count requires its reviewed network binding; an unmapped count cannot retain a mapping.",
      });
  });
export const trafficCountPackSchema: z.ZodType<TrafficCountPack> = z
  .object({
    version: z.literal(1),
    id,
    sources,
    files: z.array(file).max(10000),
    counts: z.array(trafficCountSchema).max(MAX_TRAFFIC_COUNTS),
    annualCounts: z
      .array(
        z
          .object({
            id,
            stationId: z.string().min(1).max(240),
            position: position.nullable(),
            year: z.number().int().min(1900).max(2200),
            value: nonnegative.nullable(),
            status: z.enum(["available", "missing"]),
            direction: z.enum(["both", "forward", "reverse", "unknown"]),
            sourceIds,
            notes,
          })
          .strict()
          .refine(
            (v) => (v.status === "available") === (v.value !== null),
            "Annual count status and value disagree",
          ),
      )
      .max(MAX_TRAFFIC_COUNTS),
    notes,
  })
  .strict();
export const trafficRouteEndpointsSchema: z.ZodType<TrafficRouteEndpoints> = z
  .object({
    departLaneId: id,
    departPositionMeters: nonnegative,
    arrivalLaneId: id,
    arrivalPositionMeters: nonnegative,
  })
  .strict();

/** Validate explicit attachments without replacing invalid positions with edge ends. */
export function validateTrafficRouteEndpoints(
  endpoints: TrafficRouteEndpoints,
  edges: ReadonlyMap<string, TrafficNetwork["edges"][number]>,
  originEdge: string,
  destinationEdge: string,
  vehicleClass: TrafficVehicleClass,
  singleEdge = false,
): void {
  trafficRouteEndpointsSchema.parse(endpoints);
  const depart = edges
    .get(originEdge)
    ?.lanes.find((lane) => lane.id === endpoints.departLaneId);
  const arrival = edges
    .get(destinationEdge)
    ?.lanes.find((lane) => lane.id === endpoints.arrivalLaneId);
  if (
    !depart ||
    !arrival ||
    !depart.allowedClasses.includes(vehicleClass) ||
    !arrival.allowedClasses.includes(vehicleClass)
  )
    throw new Error(
      "Traffic route attachments require permitted lanes on their exact directed endpoint edges.",
    );
  if (
    endpoints.departPositionMeters >= depart.lengthMeters ||
    endpoints.arrivalPositionMeters > arrival.lengthMeters
  )
    throw new Error(
      "Traffic route attachments exceed native lane lengths; no endpoint was relocated.",
    );
  if (
    singleEdge &&
    (depart.id !== arrival.id ||
      endpoints.arrivalPositionMeters <= endpoints.departPositionMeters)
  )
    throw new Error(
      "A single-edge attachment requires forward travel on the same native lane.",
    );
}

export const trafficDemandSchema: z.ZodType<TrafficDemand> = z
  .object({
    version: z.literal(1),
    rows: z
      .array(
        z
          .object({
            id,
            originEdge: id,
            destinationEdge: id,
            endpoints: trafficRouteEndpointsSchema.optional(),
            beginSeconds: nonnegative.max(86400),
            endSeconds: nonnegative.max(86400),
            vehicleClass,
            vehicles: integer.max(MAX_TRAFFIC_VEHICLES),
            purpose: z.enum([
              "commute",
              "shopping",
              "school",
              "freight",
              "other",
              "unspecified",
            ]),
            quality,
            sourceIds,
          })
          .strict()
          .refine(
            (v) => v.endSeconds > v.beginSeconds,
            "Demand intervals must have positive duration",
          ),
      )
      .max(MAX_TRAFFIC_VEHICLES),
    candidateRoutes: z
      .array(
        z
          .object({
            id,
            odId: id,
            edges: z.array(id).min(1).max(100000),
            weight: nonnegative,
            sourceIds,
          })
          .strict(),
      )
      .max(MAX_TRAFFIC_VEHICLES),
    sources,
    notes,
  })
  .strict();
export const trafficPairRecipeSchema: z.ZodType<TrafficPairRecipe> = z
  .object({
    version: z.literal(1),
    baselineNetworkHash: hash,
    proposalNetworkHash: hash,
    demandHash: hash,
    countPackHash: hash,
    settingsHash: hash,
    period: trafficPeriodSchema,
    seed: integer.max(0xffffffff),
    methodVersion: z.string().min(1).max(100),
  })
  .strict();
export const trafficCalibrationPlanSchema: z.ZodType<TrafficCalibrationPlan> = z
  .object({
    calibrationCountIds: z.array(id).max(MAX_TRAFFIC_COUNTS),
    holdoutCountIds: z.array(id).max(MAX_TRAFFIC_COUNTS),
    criteria: z
      .object({
        gehMaximum: nonnegative,
        absoluteHourlyErrorMaximum: nonnegative,
        relativeErrorMaximum: nonnegative,
        requiredPassingFraction: z.number().min(0).max(1),
        minimumCalibrationCounts: integer.min(1),
        minimumHoldoutCounts: integer.min(1),
      })
      .strict(),
    sourceIds,
    description: text,
  })
  .strict();
export const trafficOverlaySchema: z.ZodType<TrafficOverlay> = z
  .object({
    edgeId: id,
    closed: z.boolean().optional(),
    lanes: integer.min(1).max(100).optional(),
    speedMps: z.number().finite().positive().max(150).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.closed !== undefined ||
      v.lanes !== undefined ||
      v.speedMps !== undefined,
    "An overlay must change a supported property",
  );
export const trafficSimulationResultSchema: z.ZodType<TrafficSimulationResult> =
  z
    .object({
      version: z.literal(1),
      side: z.enum(["baseline", "proposal"]),
      recipeHash: hash,
      networkHash: hash,
      demandHash: hash,
      assignedRoutesHash: hash,
      seed: integer.max(0xffffffff),
      period: trafficPeriodSchema,
      diagnostics: z
        .object({
          requested: integer,
          loaded: integer,
          inserted: integer,
          arrived: integer,
          running: integer,
          waiting: integer,
          discarded: integer,
          teleports: integer,
          collisions: integer,
          routeErrors: integer,
        })
        .strict(),
      trips: z
        .array(
          z
            .object({
              id,
              requestedDepartSeconds: nonnegative,
              arrived: z.boolean(),
              departSeconds: nonnegative.nullable(),
              arrivalSeconds: nonnegative.nullable(),
              durationSeconds: nonnegative.nullable(),
              routeLengthMeters: nonnegative.nullable(),
              waitingSeconds: nonnegative.nullable(),
              timeLossSeconds: nonnegative.nullable(),
              departDelaySeconds: nonnegative.nullable(),
            })
            .strict(),
        )
        .max(MAX_TRAFFIC_VEHICLES),
      predictions: z
        .array(
          z
            .object({
              countId: id,
              vehicles: integer.nullable(),
              status: z.enum(["available", "unavailable"]),
              reason: text.optional(),
            })
            .strict()
            .refine(
              (v) => (v.status === "available") === (v.vehicles !== null),
              "Prediction status and value disagree",
            ),
        )
        .max(MAX_TRAFFIC_COUNTS),
      edges: z
        .array(
          z
            .object({
              edgeId: id,
              beginSeconds: nonnegative,
              endSeconds: nonnegative,
              entered: integer,
              left: integer,
              meanSpeedMps: nonnegative.nullable(),
              meanTravelTimeSeconds: nonnegative.nullable(),
              sampledSeconds: nonnegative,
            })
            .strict(),
        )
        .max(MAX_TRAFFIC_EDGES * 100),
      files: z.array(file).max(10000),
      notes,
    })
    .strict();

function unique<T>(
  values: readonly T[],
  key: (v: T) => string,
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const v of values) {
    const k = key(v);
    if (map.has(k)) throw new Error(`Duplicate ${label}: ${k}`);
    map.set(k, v);
  }
  return map;
}
function sourceInventory(sources: readonly { id: string }[]) {
  return unique(sources, (s) => s.id, "source");
}
function requireSources(
  ids: readonly string[],
  inventory: Map<string, unknown>,
) {
  for (const id of ids)
    if (!inventory.has(id))
      throw new Error(`Missing traffic source attribution: ${id}`);
}
export function validateTrafficNetwork(network: TrafficNetwork): void {
  trafficNetworkSchema.parse(network);
  const nodes = unique(network.nodes, (v) => v.id, "node"),
    edges = unique(network.edges, (v) => v.id, "edge"),
    lanes = unique(
      network.edges.flatMap((e) => e.lanes.map((l) => ({ ...l, edge: e }))),
      (v) => v.id,
      "lane",
    ),
    connections = unique(network.connections, (v) => v.id, "connection"),
    signals = unique(network.signals, (v) => v.id, "signal"),
    sources = sourceInventory(network.manifest.sources);
  const [w, s, e, n] = network.manifest.bounds;
  if (w >= e || s >= n)
    throw new Error("Traffic network bounds must have positive extent.");
  if (lanes.size > MAX_TRAFFIC_EDGES * 4)
    throw new Error("Traffic lane budget exceeded.");
  for (const f of network.manifest.sourceFiles)
    requireSources([f.sourceId], sources);
  for (const node of nodes.values()) {
    requireSources(node.sourceIds, sources);
    if (
      node.position[0] < w ||
      node.position[0] > e ||
      node.position[1] < s ||
      node.position[1] > n
    )
      throw new Error(`Node ${node.id} lies outside network coverage.`);
  }
  for (const edge of edges.values()) {
    requireSources(edge.sourceIds, sources);
    if (!nodes.has(edge.from) || !nodes.has(edge.to))
      throw new Error(`Edge ${edge.id} references an absent node.`);
    unique(edge.lanes, (l) => String(l.index), "lane index");
    for (const lane of edge.lanes) requireSources(lane.sourceIds, sources);
  }
  for (const c of connections.values()) {
    requireSources(c.sourceIds, sources);
    const from = edges.get(c.fromEdge),
      to = edges.get(c.toEdge);
    if (
      !from ||
      !to ||
      from.to !== to.from ||
      lanes.get(c.fromLane)?.edge.id !== from.id ||
      lanes.get(c.toLane)?.edge.id !== to.id
    )
      throw new Error(
        `Connection ${c.id} does not join the named incident edges and lanes.`,
      );
    if ((c.signalId === undefined) !== (c.signalIndex === undefined))
      throw new Error(`Connection ${c.id} has an incomplete signal binding.`);
    if (
      c.signalId !== undefined &&
      !signals.get(c.signalId)?.connectionIds[c.signalIndex!]?.includes(c.id)
    )
      throw new Error(`Connection ${c.id} has an invalid signal index.`);
  }
  for (const signal of signals.values()) {
    requireSources(signal.sourceIds, sources);
    if (!signal.nodeIds.length || signal.nodeIds.some((id) => !nodes.has(id)))
      throw new Error(`Signal ${signal.id} references absent nodes.`);
    unique(signal.connectionIds.flat(), (id) => id, "controlled connection");
    signal.connectionIds.forEach((group, index) =>
      group.forEach((id) => {
        const c = connections.get(id);
        if (
          !c ||
          c.signalId !== signal.id ||
          c.signalIndex !== index ||
          !signal.nodeIds.includes(edges.get(c.fromEdge)!.to)
        )
          throw new Error(
            `Signal ${signal.id} has an inconsistent controlled movement.`,
          );
      }),
    );
    if (
      signal.phases.some((p) => p.state.length !== signal.connectionIds.length)
    )
      throw new Error(
        `Signal ${signal.id} phase length differs from its controlled signal indices.`,
      );
  }
}
export function validateTrafficCountPack(
  pack: TrafficCountPack,
  network?: TrafficNetwork,
): void {
  trafficCountPackSchema.parse(pack);
  unique(pack.counts, (v) => v.id, "count");
  unique(pack.annualCounts, (v) => v.id, "annual count");
  const sources = sourceInventory(pack.sources);
  for (const f of pack.files) requireSources([f.sourceId], sources);
  const edges = network
      ? new Map(network.edges.map((e) => [e.id, e]))
      : undefined,
    connections = network
      ? new Set(network.connections.map((c) => c.id))
      : undefined;
  for (const c of [...pack.counts, ...pack.annualCounts])
    requireSources(c.sourceIds, sources);
  for (const c of pack.counts) {
    if (!c.target || !network) continue;
    if (c.mapping?.networkFileSha256 !== network.manifest.networkFileSha256)
      throw new Error(`Count ${c.id} was mapped to a different network.`);
    if (c.target.kind === "turn") {
      if (!connections!.has(c.target.connectionId))
        throw new Error(`Count ${c.id} references an absent movement.`);
    } else {
      const edge = edges!.get(c.target.edgeId);
      if (!edge) throw new Error(`Count ${c.id} references an absent edge.`);
      if (c.target.laneIds) {
        unique(c.target.laneIds, (id) => id, "count lane");
        if (c.target.laneIds.some((id) => !edge.lanes.some((l) => l.id === id)))
          throw new Error(`Count ${c.id} references lanes outside its edge.`);
      }
    }
  }
}
export function validateTrafficDemand(
  demand: TrafficDemand,
  network: TrafficNetwork,
  period?: TrafficPeriod,
): void {
  trafficDemandSchema.parse(demand);
  const rows = unique(demand.rows, (v) => v.id, "OD row"),
    routes = unique(demand.candidateRoutes, (v) => v.id, "candidate route"),
    edges = new Map(network.edges.map((e) => [e.id, e])),
    sources = sourceInventory(demand.sources);
  const laneClasses = new Map(
    network.edges.flatMap((e) =>
      e.lanes.map((l) => [l.id, l.allowedClasses] as const),
    ),
  );
  const allowed = new Set(
    network.connections.flatMap((c) =>
      (laneClasses.get(c.fromLane) ?? [])
        .filter((v) => laneClasses.get(c.toLane)?.includes(v))
        .map((v) => `${c.fromEdge}\0${c.toEdge}\0${v}`),
    ),
  );
  let vehicles = 0,
    segments = 0;
  const weights = new Map<string, number>();
  for (const r of rows.values()) {
    requireSources(r.sourceIds, sources);
    vehicles += r.vehicles;
    if (!edges.has(r.originEdge) || !edges.has(r.destinationEdge))
      throw new Error(`OD row ${r.id} references absent endpoints.`);
    if (r.endpoints)
      validateTrafficRouteEndpoints(
        r.endpoints,
        edges,
        r.originEdge,
        r.destinationEdge,
        r.vehicleClass,
      );
    if (
      period &&
      (r.beginSeconds < period.beginSeconds - period.warmupSeconds ||
        r.endSeconds > period.endSeconds)
    )
      throw new Error(
        `OD row ${r.id} lies outside the admitted departure period.`,
      );
  }
  if (vehicles > MAX_TRAFFIC_VEHICLES)
    throw new Error(
      "Traffic demand exceeds the vehicle budget; no rows were dropped.",
    );
  for (const route of routes.values()) {
    requireSources(route.sourceIds, sources);
    const row = rows.get(route.odId);
    if (!row) throw new Error(`Route ${route.id} references an absent OD row.`);
    segments += route.edges.length;
    if (
      route.edges[0] !== row.originEdge ||
      route.edges.at(-1) !== row.destinationEdge
    )
      throw new Error(`Route ${route.id} changes its OD endpoints.`);
    if (row.endpoints)
      validateTrafficRouteEndpoints(
        row.endpoints,
        edges,
        row.originEdge,
        row.destinationEdge,
        row.vehicleClass,
        route.edges.length === 1,
      );
    for (let i = 0; i < route.edges.length; i++) {
      const edge = edges.get(route.edges[i]);
      if (
        !edge ||
        !edge.lanes.some((l) => l.allowedClasses.includes(row.vehicleClass))
      )
        throw new Error(
          `Route ${route.id} is unavailable to its vehicle class.`,
        );
      if (
        i &&
        !allowed.has(
          `${route.edges[i - 1]}\0${route.edges[i]}\0${row.vehicleClass}`,
        )
      )
        throw new Error(
          `Route ${route.id} crosses an absent or prohibited connection.`,
        );
    }
    weights.set(row.id, (weights.get(row.id) ?? 0) + route.weight);
  }
  if (segments > MAX_TRAFFIC_ROUTE_SEGMENTS)
    throw new Error("Traffic route-segment budget exceeded.");
  for (const row of rows.values())
    if (row.vehicles > 0 && !(weights.get(row.id)! > 0))
      throw new Error(
        `OD row ${row.id} has vehicles but no positive candidate-route weight.`,
      );
}
/** Canonical immutable identity; raw file hashes remain separate evidence. */
export async function trafficContentHash(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
  if (canonical === undefined)
    throw new Error("Traffic hash input must be JSON data.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function trafficPairRecipeHash(
  recipe: TrafficPairRecipe,
): Promise<string> {
  trafficPairRecipeSchema.parse(recipe);
  return trafficContentHash(recipe);
}

export const trafficSourceSchema = source;
export const trafficFileReferenceSchema = file;
