import {
  canonicalJSON,
  mergeTrafficPlanningOverlays,
  reviewTrafficPlanningRoads,
  trafficPlanningOverlays,
  verifyTrafficPlanningRoads,
  type Place,
  type Scenario,
  type TrafficNetwork,
  type TrafficPlanningRoadReviewInput,
  type TrafficPlanningRoadMapping,
  type TrafficOverlay,
  type TrafficPlanningSourceDeclaration,
} from "@urban/core";
import { ApiError } from "../errors.js";
import type { TrafficExperimentRequest } from "./experiment.js";

export interface PlanningSourceDeclarationInput {
  sourceId: string;
  privateUseConfirmed: true;
  publicRedistribution: boolean;
}
export const TRAFFIC_PLANNING_CAPTURE_BYTES = 96 * 1024;
export function planningProposalMetadata(
  request: Pick<TrafficExperimentRequest, "planningRoads" | "overlays">,
  scenario: Scenario,
) {
  const mapping = request.planningRoads;
  if (!mapping)
    return {
      status: "unmapped" as const,
      reviewedLinks: [],
      unrepresentedRoadIds: Object.keys(scenario.roadEdits).sort(),
      notes: [
        "Native edge controls were entered for this independent experiment. No reviewed planning-road to directed-edge/property correspondence was supplied.",
      ],
    };
  const represented = new Set(mapping.reviews.map((review) => review.roadId));
  return {
    status: mapping.reviews.length
      ? ("explicitly-reviewed" as const)
      : ("unmapped" as const),
    reviewedLinks: mapping.reviews.map((review) => ({
      roadId: review.roadId,
      roadEditHash: review.roadEditHash,
      edgeIds: review.directions.flatMap((direction) => direction.edgeIds),
      representedProperties: review.properties,
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
    })),
    unrepresentedRoadIds: [
      ...new Set(mapping.exclusions.map((exclusion) => exclusion.roadId)),
    ]
      .filter((id) => !represented.has(id))
      .sort(),
    notes: [
      "Only retained reviewed properties on the selected whole native edges are represented. The per-property exclusion ledger also lists omissions on partially represented roads.",
    ],
    correspondence: mapping,
  };
}
export function assertPlanningCaptureBudget(
  request: TrafficExperimentRequest,
  scenario: Scenario,
): void {
  if (
    request.planningRoads &&
    Buffer.byteLength(
      JSON.stringify({
        overlays: request.overlays,
        planningRoadMapping: planningProposalMetadata(request, scenario),
      }),
    ) > TRAFFIC_PLANNING_CAPTURE_BYTES
  )
    throw new ApiError(
      413,
      "TRAFFIC_PLANNING_CAPTURE_LIMIT",
      "Planning correspondence, controls and citations exceed the 96 KiB capture allowance. Reduce the reviewed extent or independent controls; no review or exclusion was omitted and no native work started.",
    );
}
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
function reject(message: string): never {
  throw new ApiError(422, "TRAFFIC_PLANNING_REVIEW_REQUIRED", message);
}
/** A receipt cannot claim controls that are absent, altered or assigned to a closed edge. */
export function assertPlanningControls(
  overlays: readonly TrafficOverlay[],
  mapping: TrafficPlanningRoadMapping,
): void {
  const effective = new Map(
    overlays.map((overlay) => [overlay.edgeId, overlay]),
  );
  if (effective.size !== overlays.length)
    reject("Native controls repeat a directed edge.");
  for (const generated of trafficPlanningOverlays(mapping)) {
    const actual = effective.get(generated.edgeId);
    for (const property of ["closed", "lanes", "speedMps"] as const)
      if (
        generated[property] !== undefined &&
        actual?.[property] !== generated[property]
      )
        reject(
          "Retained mapped controls were changed or removed. Explicitly review or unlink the planning correspondence before editing those native properties.",
        );
    if (
      actual?.closed === true &&
      (actual.lanes !== undefined || actual.speedMps !== undefined)
    )
      reject(
        "A removed native edge cannot represent simultaneous lane or speed changes.",
      );
  }
}
/** Full saved planning context is checked before native admission and again at capture. */
export async function verifyPlanningRequest(
  request: TrafficExperimentRequest,
  context: { place: Place; scenario: Scenario; network: TrafficNetwork },
): Promise<void> {
  if (!request.planningRoads) return;
  try {
    await verifyTrafficPlanningRoads({
      ...context,
      planningRoads: request.planningRoads,
    });
    assertPlanningControls(request.overlays, request.planningRoads);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    reject((error as Error).message);
  }
}
/** Only fresh review intents or an exact prior server receipt can become authoritative metadata.
 * Explicit reviews make candidate.overlays the independently authored controls; without reviews it
 * retains the existing effective-overlay convention for backward-compatible configuration edits. */
export async function reviewPlanningRequest(
  candidate: TrafficExperimentRequest,
  reviews: TrafficPlanningRoadReviewInput[] | undefined,
  declarations: PlanningSourceDeclarationInput[] | undefined,
  context: {
    place?: Place;
    scenario?: Scenario;
    network: TrafficNetwork;
    previous: TrafficExperimentRequest | null;
    userId: string;
    now: string;
  },
): Promise<void> {
  const previous = context.previous?.planningRoads;
  if (
    candidate.planningRoads &&
    (!previous || !same(candidate.planningRoads, previous))
  )
    reject(
      "Planning-road reviewer identities, timestamps, controls and bindings are recorded by the server. Supply review inputs, not a caller-created receipt.",
    );
  if (reviews !== undefined) {
    if (!context.place || !context.scenario)
      reject(
        "Saved planning context is required to review road correspondence.",
      );
    try {
      const reviewed = await reviewTrafficPlanningRoads({
        place: context.place,
        scenario: context.scenario,
        network: context.network,
        reviews,
        reviewedBy: context.userId,
        reviewedAt: context.now,
      });
      candidate.overlays = mergeTrafficPlanningOverlays(
        candidate.overlays,
        reviewed.planningRoads,
      );
      candidate.planningRoads = reviewed.planningRoads;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      reject((error as Error).message);
    }
  } else if (previous) {
    if (!candidate.planningRoads)
      reject(
        "Explicitly unlink planning-road controls before removing their retained review metadata.",
      );
    if (!context.place || !context.scenario)
      reject(
        "Saved planning context is required to retain road correspondence.",
      );
    await verifyPlanningRequest(candidate, {
      place: context.place,
      scenario: context.scenario,
      network: context.network,
    });
  }
  const mapping = candidate.planningRoads;
  if (!mapping) {
    if (declarations?.length)
      reject(
        "Planning-source declarations require retained planning-road correspondence.",
      );
    return;
  }
  const supplied = new Map(
    (declarations ?? []).map((declaration) => [
      declaration.sourceId,
      declaration,
    ]),
  );
  if (
    supplied.size !== (declarations ?? []).length ||
    [...supplied.keys()].some(
      (id) => !mapping.sources.some((source) => source.id === id),
    )
  )
    reject(
      "Planning-source declarations must identify each retained planning citation at most once.",
    );
  mapping.sourceDeclarations = mapping.sources.map((source) => {
    const declaration = supplied.get(source.id);
    if (declaration)
      return {
        ...declaration,
        declaredBy: context.userId,
        declaredAt: context.now,
      };
    const prior = previous?.sourceDeclarations.find(
      (declaration) => declaration.sourceId === source.id,
    );
    if (
      prior &&
      same(
        source,
        previous?.sources.find(
          (previousSource) => previousSource.id === source.id,
        ),
      )
    )
      return structuredClone(prior);
    return reject(
      `Confirm private processing and retention rights for planning source ${source.id}; public redistribution is a separate explicit choice.`,
    );
  }) satisfies TrafficPlanningSourceDeclaration[];
  assertPlanningCaptureBudget(candidate, context.scenario!);
}
