import { z } from "zod";
import {
  materializeRoads,
  type Place,
  type Road,
  type Scenario,
  type Source,
} from "./index";
import { isSafeFeatureIdentifier } from "./identifiers";
import {
  trafficContentHash,
  trafficOverlaySchema,
  trafficSourceSchema,
} from "./traffic-validation";
import type { TrafficNetwork, TrafficOverlay } from "./traffic";

export type TrafficPlanningSupportedProperty = "lanes" | "speed" | "closure";
export type TrafficPlanningProperty =
  | TrafficPlanningSupportedProperty
  | "addition"
  | "removal"
  | "geometry"
  | "direction"
  | "bikeLane"
  | "busLane"
  | "signal"
  | "cycleSeconds"
  | "greenSplit"
  | "aadt"
  | "name"
  | "kind"
  | "source";
export interface TrafficPlanningRoadDirection {
  /** Relative to the unchanged planning centerline's coordinate order. */
  direction: "with-road" | "against-road";
  /** Ordered serial directed edges, not parallel lane or branch alternatives. */
  edgeIds: string[];
  /** Per directed edge, counted once for this direction, never once per serial edge. */
  lanes?: number;
}
export interface TrafficPlanningRoadReviewInput {
  roadId: string;
  properties: TrafficPlanningSupportedProperty[];
  directions: TrafficPlanningRoadDirection[];
  extent: "full-road" | "partial-road";
  nativeExtensionAcknowledged: boolean;
  deletionAsClosure?: boolean;
  rationale: string;
}
export interface TrafficPlanningRoadReview
  extends TrafficPlanningRoadReviewInput {
  baselineRoadHash: string;
  roadEditHash: string;
  reviewedBy: string;
  reviewedAt: string;
  /** Exact generated controls. Other independent controls remain separately attributed. */
  overlays: TrafficOverlay[];
  notes: string[];
}
export interface TrafficPlanningExclusion {
  roadId: string;
  property: TrafficPlanningProperty;
  reason:
    | "not-reviewed"
    | "unsupported"
    | "partial-extent"
    | "cosmetic"
    | "inactive-while-closed";
  detail: string;
}
export interface TrafficPlanningRoadMapping {
  version: 1;
  baselineHash: string;
  roadEditsHash: string;
  networkHash: string;
  inventoryHash: string;
  /** Exact planning citations, isolated from identically named native/count sources. */
  sources: Source[];
  /** Reviewed permission attestations; never rewrite original source metadata. API admission requires all used sources. */
  sourceDeclarations: TrafficPlanningSourceDeclaration[];
  reviews: TrafficPlanningRoadReview[];
  exclusions: TrafficPlanningExclusion[];
}
export interface TrafficPlanningSourceDeclaration {
  sourceId: string;
  privateUseConfirmed: true;
  publicRedistribution: boolean;
  declaredBy: string;
  declaredAt: string;
}
export interface TrafficPlanningRoadChange {
  roadId: string;
  baseline: Road | null;
  proposal: Road | null;
  properties: TrafficPlanningProperty[];
  mappingEligible: boolean;
  blocker: string | null;
}

const id = z.string().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const supported = z.enum(["lanes", "speed", "closure"]);
const property = z.enum([
  "lanes",
  "speed",
  "closure",
  "addition",
  "removal",
  "geometry",
  "direction",
  "bikeLane",
  "busLane",
  "signal",
  "cycleSeconds",
  "greenSplit",
  "aadt",
  "name",
  "kind",
  "source",
]);
const inputShape = {
  roadId: id.refine(
    isSafeFeatureIdentifier,
    "Use an ordinary planning feature ID.",
  ),
  properties: z.array(supported).min(1).max(3),
  directions: z
    .array(
      z
        .object({
          direction: z.enum(["with-road", "against-road"]),
          edgeIds: z.array(id).min(1).max(1000),
          lanes: z.number().int().min(1).max(20).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(2),
  extent: z.enum(["full-road", "partial-road"]),
  nativeExtensionAcknowledged: z.boolean(),
  deletionAsClosure: z.boolean().optional(),
  rationale: z.string().trim().min(12).max(2000),
};
export const trafficPlanningRoadReviewInputSchema: z.ZodType<TrafficPlanningRoadReviewInput> =
  z
    .object(inputShape)
    .strict()
    .superRefine((v, c) => {
      const fail = (message: string) => c.addIssue({ code: "custom", message });
      if (
        new Set(v.properties).size !== v.properties.length ||
        new Set(v.directions.map((d) => d.direction)).size !==
          v.directions.length
      )
        fail("Repeat neither a reviewed property nor a direction group.");
      const edges = v.directions.flatMap((d) => d.edgeIds);
      if (new Set(edges).size !== edges.length)
        fail("A reviewed road cannot repeat native edges.");
      if (
        v.directions.some(
          (d) => (d.lanes !== undefined) !== v.properties.includes("lanes"),
        )
      )
        fail("Supply directional lane targets exactly when reviewing lanes.");
    });
const reviewSchema = z
  .object({
    ...inputShape,
    baselineRoadHash: hash,
    roadEditHash: hash,
    reviewedBy: z.string().min(1).max(240),
    reviewedAt: z.iso.datetime({ offset: true }),
    overlays: z.array(trafficOverlaySchema).min(1).max(2000),
    notes: z.array(z.string().max(4000)).max(30),
  })
  .strict();
export const trafficPlanningRoadMappingSchema: z.ZodType<TrafficPlanningRoadMapping> =
  z
    .object({
      version: z.literal(1),
      baselineHash: hash,
      roadEditsHash: hash,
      networkHash: hash,
      inventoryHash: hash,
      sources: z.array(trafficSourceSchema).max(5000),
      sourceDeclarations: z
        .array(
          z
            .object({
              sourceId: id,
              privateUseConfirmed: z.literal(true),
              publicRedistribution: z.boolean(),
              declaredBy: z.string().min(1).max(240),
              declaredAt: z.iso.datetime({ offset: true }),
            })
            .strict(),
        )
        .max(5000),
      reviews: z.array(reviewSchema).max(5000),
      exclusions: z
        .array(
          z
            .object({
              roadId: id.refine(isSafeFeatureIdentifier),
              property,
              reason: z.enum([
                "not-reviewed",
                "unsupported",
                "partial-extent",
                "cosmetic",
                "inactive-while-closed",
              ]),
              detail: z.string().min(1).max(2000),
            })
            .strict(),
        )
        .max(100000),
    })
    .strict()
    .superRefine((v, c) => {
      const fail = (message: string) => c.addIssue({ code: "custom", message });
      const sourceIds = v.sources.map((s) => s.id),
        declarations = v.sourceDeclarations.map((d) => d.sourceId);
      if (
        new Set(sourceIds).size !== sourceIds.length ||
        new Set(declarations).size !== declarations.length ||
        declarations.some((id) => !sourceIds.includes(id))
      )
        fail(
          "Planning citations and their permission declarations must have unique matching identities.",
        );
      if (new Set(v.reviews.map((r) => r.roadId)).size !== v.reviews.length)
        fail("Each road can have only one reviewed correspondence.");
      const edges = v.reviews.flatMap((r) =>
        r.directions.flatMap((d) => d.edgeIds),
      );
      if (edges.length > 30000)
        fail("Correspondence exceeds 30,000 directed edges.");
      if (new Set(edges).size !== edges.length)
        fail("Native edges cannot belong to multiple planning-road reviews.");
      const exclusions = v.exclusions.map((e) => `${e.roadId}\0${e.property}`);
      if (new Set(exclusions).size !== exclusions.length)
        fail("Each excluded road property must have one reason.");
      for (const r of v.reviews) {
        if (!r.nativeExtensionAcknowledged)
          fail(
            "Retained correspondence requires whole-native-edge extent acknowledgement.",
          );
        if (
          !trafficPlanningRoadReviewInputSchema.safeParse(reviewInput(r))
            .success
        )
          fail(
            "A retained road review has invalid directional/property declarations.",
          );
        const ids = r.directions.flatMap((d) => d.edgeIds);
        if (
          r.overlays.length !== ids.length ||
          new Set(r.overlays.map((o) => o.edgeId)).size !== ids.length ||
          r.overlays.some((o) => !ids.includes(o.edgeId))
        )
          fail(
            "Generated controls must cover each reviewed directed edge exactly once.",
          );
        for (const o of r.overlays) {
          const keys = Object.keys(o)
            .filter((k) => k !== "edgeId")
            .sort();
          const expected = r.properties
            .map((p) =>
              p === "speed" ? "speedMps" : p === "closure" ? "closed" : p,
            )
            .sort();
          if (
            !same(keys, expected) ||
            (o.closed !== undefined && o.closed !== true)
          )
            fail(
              "Generated controls must contain exactly the reviewed properties; reopening is unsupported.",
            );
          if (
            o.closed === true &&
            (o.lanes !== undefined || o.speedMps !== undefined)
          )
            fail("A closure cannot claim simultaneous lane or speed changes.");
          const direction = r.directions.find((d) =>
            d.edgeIds.includes(o.edgeId),
          );
          if (o.lanes !== undefined && o.lanes !== direction?.lanes)
            fail(
              "Serial edges must retain their declared directional lane target.",
            );
        }
      }
    });
// Keep this schema dependency independent of snapshots/validation initialization.
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sortedRoads = (place: Place, scenario: Scenario) =>
  [...materializeRoads(place, scenario)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
function reviewInput(
  review: TrafficPlanningRoadReview,
): TrafficPlanningRoadReviewInput {
  const {
    baselineRoadHash: _b,
    roadEditHash: _r,
    reviewedBy: _u,
    reviewedAt: _t,
    overlays: _o,
    notes: _n,
    ...input
  } = review;
  return input;
}
const bool = (value: boolean | undefined) => value === true;
const sourceFields = (road: Road) => [
  road.sourceId,
  road.attributeSourceId ?? null,
  road.geometrySourceId ?? null,
  road.estimated ?? null,
];
/** Semantic differences from the fixed planning baseline, not a list of commands or source-way guesses. */
export function trafficPlanningRoadChanges(
  place: Place,
  scenario: Scenario,
): TrafficPlanningRoadChange[] {
  const baseline = new Map(place.roads.map((r) => [r.id, r]));
  const proposal = new Map(
    materializeRoads(place, scenario).map((r) => [r.id, r]),
  );
  const result: TrafficPlanningRoadChange[] = [];
  for (const roadId of Object.keys(scenario.roadEdits).sort()) {
    if (!isSafeFeatureIdentifier(roadId))
      throw new Error("Invalid planning road identifier.");
    const before = baseline.get(roadId) ?? null,
      after = proposal.get(roadId) ?? null;
    if (!before && !after) continue;
    const properties: TrafficPlanningProperty[] = [];
    if (!before) {
      properties.push(
        "addition",
        "geometry",
        "lanes",
        "speed",
        "direction",
        "name",
        "kind",
        "source",
      );
      for (const p of [
        "closed",
        "bikeLane",
        "busLane",
        "signal",
        "cycleSeconds",
        "greenSplit",
        "aadt",
      ] as const)
        if (after![p] !== undefined)
          properties.push(p === "closed" ? "closure" : p);
    } else if (!after) properties.push("removal", "closure");
    else {
      if (!same(before.coordinates, after.coordinates))
        properties.push("geometry");
      if (before.oneWay !== after.oneWay) properties.push("direction");
      if (before.lanes !== after.lanes) properties.push("lanes");
      if (before.speedMph !== after.speedMph) properties.push("speed");
      if (bool(before.closed) !== bool(after.closed))
        properties.push("closure");
      for (const p of ["bikeLane", "busLane", "signal"] as const)
        if (bool(before[p]) !== bool(after[p])) properties.push(p);
      for (const p of [
        "cycleSeconds",
        "greenSplit",
        "aadt",
        "name",
        "kind",
      ] as const)
        if (before[p] !== after[p]) properties.push(p);
      if (!same(sourceFields(before), sourceFields(after)))
        properties.push("source");
    }
    if (!properties.length) continue;
    const blocker = !before
      ? "New streets need native network topology construction before correspondence is possible."
      : properties.includes("geometry")
        ? "Reshaped streets need a rebuilt native network; old edge geometry cannot represent the new path."
        : properties.includes("direction")
          ? "One-way/direction changes need native network topology conversion and are not supported by this mapping."
          : null;
    result.push({
      roadId,
      baseline: before,
      proposal: after,
      properties,
      mappingEligible: blocker === null,
      blocker,
    });
  }
  return result;
}

type NetworkIndex = {
  edges: Map<string, TrafficNetwork["edges"][number]>;
  connections: Set<string>;
};
function networkIndex(network: TrafficNetwork): NetworkIndex {
  return {
    edges: new Map(network.edges.map((e) => [e.id, e])),
    connections: new Set(
      network.connections.map((c) => `${c.fromEdge}\0${c.toEdge}`),
    ),
  };
}
function checkChain(
  index: NetworkIndex,
  direction: TrafficPlanningRoadDirection,
) {
  const selected = direction.edgeIds.map((id) => {
    const edge = index.edges.get(id);
    if (!edge)
      throw new Error(
        `Native directed edge ${id} is absent from the reviewed graph.`,
      );
    return edge;
  });
  for (let i = 1; i < selected.length; i++)
    if (
      selected[i - 1].to !== selected[i].from ||
      !index.connections.has(`${selected[i - 1].id}\0${selected[i].id}`)
    )
      throw new Error(
        "Each direction must be one ordered connected serial edge chain, not parallel edges or disconnected pieces.",
      );
  return selected;
}
function assertGeneralLanes(edges: TrafficNetwork["edges"]) {
  let classes: string | undefined;
  for (const edge of edges) {
    if (!edge.lanes.length)
      throw new Error("A mapped edge has no native lane inventory.");
    for (const lane of edge.lanes) {
      const key = [...lane.allowedClasses].sort().join(",");
      if (
        !lane.allowedClasses.includes("passenger") ||
        lane.allowedClasses.includes("pedestrian") ||
        (classes !== undefined && key !== classes)
      )
        throw new Error(
          "Lane translation requires uniform reviewed motor lanes. Mixed, pedestrian, bicycle-only, bus-only or otherwise ambiguous lane permissions need separate native lane design.",
        );
      classes = key;
    }
  }
}
async function translateReview(
  change: TrafficPlanningRoadChange,
  index: NetworkIndex,
  value: TrafficPlanningRoadReviewInput,
  reviewedBy: string,
  reviewedAt: string,
): Promise<TrafficPlanningRoadReview> {
  const input = trafficPlanningRoadReviewInputSchema.parse(value);
  if (!change.mappingEligible || !change.baseline)
    throw new Error(change.blocker!);
  if (input.properties.some((p) => !change.properties.includes(p)))
    throw new Error(
      "Review only actual changed planning-road properties; native-only experiments belong in independent controls.",
    );
  if (!input.nativeExtensionAcknowledged)
    throw new Error(
      "Acknowledge that controls apply to each whole native edge, including any extent beyond the planning centerline.",
    );
  const original = change.baseline,
    proposed = change.proposal;
  if (!proposed !== (input.deletionAsClosure === true))
    throw new Error(
      "A removed planning road requires an explicit deletion-as-closure review; this flag is not valid for a retained road.",
    );
  if (input.properties.includes("closure")) {
    if (
      input.properties.length !== 1 ||
      (proposed && !proposed.closed) ||
      original.closed
    )
      throw new Error(
        "Only a new closure is supported; it cannot reopen a baseline-absent edge or simultaneously apply lanes/speed.",
      );
  } else if (!proposed || proposed.closed)
    throw new Error(
      "Lane/speed settings on a closed or removed road cannot be claimed as applied.",
    );
  const directions = new Set(input.directions.map((d) => d.direction));
  if (
    original.oneWay
      ? directions.size !== 1 || !directions.has("with-road")
      : directions.size !== 2 ||
        !directions.has("with-road") ||
        !directions.has("against-road")
  )
    throw new Error(
      "An unchanged one-way street requires its with-road chain; a two-way street requires both directional chains.",
    );
  if (
    input.properties.includes("lanes") &&
    input.directions.reduce((sum, d) => sum + d.lanes!, 0) !== proposed!.lanes
  )
    throw new Error(
      "Directional lane targets must sum once to the planning road's total; do not sum serial edges or silently divide lanes.",
    );
  const overlays: TrafficOverlay[] = [];
  const notes = [
    "Direction and extent are human-reviewed correspondence, not an automatic source-way or geometric proof. Each control affects the full selected native edges.",
    "The prepared native baseline is retained unchanged. Its lane counts, speeds and inferred controls may differ from planning-source assumptions.",
  ];
  for (const direction of input.directions) {
    const edges = checkChain(index, direction);
    if (input.properties.includes("lanes")) assertGeneralLanes(edges);
    for (const edge of edges) {
      overlays.push({
        edgeId: edge.id,
        ...(input.properties.includes("lanes")
          ? { lanes: direction.lanes! }
          : {}),
        ...(input.properties.includes("speed")
          ? { speedMps: proposed!.speedMph * 0.44704 }
          : {}),
        ...(input.properties.includes("closure") ? { closed: true } : {}),
      });
    }
  }
  if (input.properties.includes("lanes"))
    notes.push(
      "Lane targets are whole directed-edge lane counts, repeated on serial edges. Connections and signal programs after lane conversion remain inferred, not reviewed intersection designs.",
    );
  if (input.properties.includes("speed"))
    notes.push(
      "The entered mph value is converted exactly by multiplying by 0.44704 and applies to every native lane on each selected edge.",
    );
  if (input.deletionAsClosure)
    notes.push(
      "Planning deletion is represented only as a traffic closure; demolition and reconstructed topology are not simulated.",
    );
  return reviewSchema.parse({
    ...input,
    baselineRoadHash: await trafficContentHash(original),
    roadEditHash: await trafficContentHash(proposed),
    reviewedBy,
    reviewedAt,
    overlays,
    notes,
  });
}
function exclusions(
  changes: TrafficPlanningRoadChange[],
  reviews: TrafficPlanningRoadReview[],
): TrafficPlanningExclusion[] {
  const result: TrafficPlanningExclusion[] = [];
  for (const change of changes) {
    const review = reviews.find((r) => r.roadId === change.roadId);
    for (const property of change.properties) {
      if (
        review?.properties.includes(
          property as TrafficPlanningSupportedProperty,
        )
      ) {
        if (review.extent === "partial-road")
          result.push({
            roadId: change.roadId,
            property,
            reason: "partial-extent",
            detail:
              "Only the reviewed native edge extent represents this property; the remainder of the planning road is unrepresented.",
          });
        continue;
      }
      const cosmetic = property === "name" || property === "source";
      const supportedProperty = ["lanes", "speed", "closure"].includes(
        property,
      );
      const inactive =
        (property === "lanes" || property === "speed") &&
        (!change.proposal || change.proposal.closed);
      result.push({
        roadId: change.roadId,
        property,
        reason: cosmetic
          ? "cosmetic"
          : inactive
            ? "inactive-while-closed"
            : supportedProperty && change.mappingEligible
              ? "not-reviewed"
              : "unsupported",
        detail: cosmetic
          ? "Metadata attribution or naming changes do not alter native traffic behavior."
          : inactive
            ? "The road is closed or removed; its lane/speed settings are not applied to the native experiment."
            : property === "removal"
              ? "Physical road removal is not native topology construction. An explicitly reviewed traffic closure may be represented separately."
              : (change.blocker ??
                (supportedProperty
                  ? "This changed property has no reviewed road-to-native correspondence."
                  : "This planning property is not translated by the lanes/speed/closure correspondence runtime.")),
      });
    }
  }
  return result;
}
type PlanningContext = {
  place: Place;
  scenario: Scenario;
  network: TrafficNetwork;
};
/** Cheap exact citation projection for adoption/source-freshness checks; no native graph is loaded. */
export function trafficPlanningSources(
  place: Place,
  scenario: Scenario,
): Source[] {
  const ids = new Set(
    trafficPlanningRoadChanges(place, scenario).flatMap((c) =>
      [c.baseline, c.proposal]
        .filter((r): r is Road => r !== null)
        .flatMap((r) =>
          [r.sourceId, r.attributeSourceId, r.geometrySourceId].filter(
            (id): id is string => !!id,
          ),
        ),
    ),
  );
  const sources = new Map<string, Source>();
  for (const source of [...place.sources, ...(scenario.sources ?? [])]) {
    if (!ids.has(source.id)) continue;
    const previous = sources.get(source.id);
    if (previous && !same(previous, source))
      throw new Error(
        "A referenced planning source ID has conflicting metadata; preserve distinct source identities.",
      );
    sources.set(source.id, source);
  }
  if ([...ids].some((id) => !sources.has(id)))
    throw new Error(
      "A changed planning road references an absent source citation.",
    );
  return [...sources.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => structuredClone(s));
}
async function mappingFor(
  context: PlanningContext,
  reviews: TrafficPlanningRoadReview[],
  sourceDeclarations: TrafficPlanningSourceDeclaration[],
): Promise<TrafficPlanningRoadMapping> {
  return trafficPlanningRoadMappingSchema.parse({
    version: 1,
    baselineHash: await trafficContentHash(context.place),
    roadEditsHash: await trafficContentHash(
      sortedRoads(context.place, context.scenario),
    ),
    networkHash: context.network.manifest.networkFileSha256,
    inventoryHash: await trafficContentHash(context.network),
    sources: trafficPlanningSources(context.place, context.scenario),
    sourceDeclarations,
    reviews,
    exclusions: exclusions(
      trafficPlanningRoadChanges(context.place, context.scenario),
      reviews,
    ),
  });
}
/** Creates a new reviewed receipt. Only the server may supply authoritative actor/time. */
export async function reviewTrafficPlanningRoads(
  input: PlanningContext & {
    reviews: TrafficPlanningRoadReviewInput[];
    reviewedBy: string;
    reviewedAt: string;
    sourceDeclarations?: TrafficPlanningSourceDeclaration[];
  },
): Promise<{
  overlays: TrafficOverlay[];
  planningRoads: TrafficPlanningRoadMapping;
}> {
  if (input.scenario.id === "baseline")
    throw new Error(
      "The immutable baseline cannot receive planning-road correspondence.",
    );
  if (input.reviews.length > 5000)
    throw new Error("Too many planning-road reviews.");
  const parsedReviews = z
    .array(trafficPlanningRoadReviewInputSchema)
    .max(5000)
    .parse(input.reviews);
  const edgeIds = parsedReviews.flatMap((r) =>
    r.directions.flatMap((d) => d.edgeIds),
  );
  if (edgeIds.length > 30000 || new Set(edgeIds).size !== edgeIds.length)
    throw new Error(
      "At most 30,000 distinct edges may be reviewed; native edges cannot belong to multiple planning-road reviews.",
    );
  const index = networkIndex(input.network);
  const changes = new Map(
    trafficPlanningRoadChanges(input.place, input.scenario).map((c) => [
      c.roadId,
      c,
    ]),
  );
  const reviews: TrafficPlanningRoadReview[] = [];
  for (const review of parsedReviews) {
    const change = changes.get(review.roadId);
    if (!change)
      throw new Error(
        "A correspondence must identify an actual planning-road change.",
      );
    reviews.push(
      await translateReview(
        change,
        index,
        review,
        input.reviewedBy,
        input.reviewedAt,
      ),
    );
  }
  const planningRoads = await mappingFor(
    input,
    reviews,
    input.sourceDeclarations ?? [],
  );
  return { planningRoads, overlays: trafficPlanningOverlays(planningRoads) };
}
/** Verifies retained identity, exact derived controls and the complete exclusion ledger; does not confer server authority. */
export async function verifyTrafficPlanningRoads(
  input: PlanningContext & { planningRoads: TrafficPlanningRoadMapping },
): Promise<void> {
  const stored = trafficPlanningRoadMappingSchema.parse(input.planningRoads);
  const index = networkIndex(input.network);
  const changes = new Map(
    trafficPlanningRoadChanges(input.place, input.scenario).map((c) => [
      c.roadId,
      c,
    ]),
  );
  const reviews: TrafficPlanningRoadReview[] = [];
  for (const review of stored.reviews) {
    const change = changes.get(review.roadId);
    if (!change)
      throw new Error(
        "A retained correspondence no longer matches an edited road.",
      );
    reviews.push(
      await translateReview(
        change,
        index,
        reviewInput(review),
        review.reviewedBy,
        review.reviewedAt,
      ),
    );
  }
  if (
    !same(stored, await mappingFor(input, reviews, stored.sourceDeclarations))
  )
    throw new Error(
      "Planning-road correspondence differs from the current baseline, road edits, graph, controls or exclusion ledger.",
    );
}
export function trafficPlanningOverlays(
  mapping: TrafficPlanningRoadMapping,
): TrafficOverlay[] {
  return trafficPlanningRoadMappingSchema
    .parse(mapping)
    .reviews.flatMap((r) => r.overlays.map((o) => ({ ...o })));
}
/** Independent controls may share an edge only when their property ownership is disjoint. */
export function mergeTrafficPlanningOverlays(
  manual: readonly TrafficOverlay[],
  mapping: TrafficPlanningRoadMapping,
): TrafficOverlay[] {
  const combined = new Map<string, TrafficOverlay>();
  for (const overlay of manual) {
    const parsed = trafficOverlaySchema.parse(overlay);
    if (combined.has(parsed.edgeId))
      throw new Error("Independent controls cannot repeat an edge.");
    combined.set(parsed.edgeId, { ...parsed });
  }
  for (const overlay of trafficPlanningOverlays(mapping)) {
    const current = combined.get(overlay.edgeId) ?? { edgeId: overlay.edgeId };
    for (const key of ["lanes", "speedMps", "closed"] as const)
      if (current[key] !== undefined && overlay[key] !== undefined)
        throw new Error(
          "Independent and planning-derived controls cannot own the same native edge property; remove one explicitly.",
        );
    combined.set(overlay.edgeId, { ...current, ...overlay });
  }
  for (const overlay of combined.values())
    if (
      overlay.closed === true &&
      (overlay.lanes !== undefined || overlay.speedMps !== undefined)
    )
      throw new Error(
        "A native closure cannot silently discard lane or speed controls.",
      );
  return [...combined.values()].sort((a, b) =>
    a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0,
  );
}
