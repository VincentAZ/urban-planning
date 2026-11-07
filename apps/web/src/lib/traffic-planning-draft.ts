import {
  canonicalJSON,
  type Source,
  type TrafficNetwork,
  type TrafficOverlay,
  type TrafficPlanningRoadChange,
  type TrafficPlanningRoadMapping,
  type TrafficPlanningRoadReviewInput,
} from "@urban/core";

/** Browser-only binding; never sent as a server permission or reviewer stamp. */
export interface TrafficPlanningSourceDraft {
  sourceId: string;
  sourceBinding: string;
  privateUseConfirmed: boolean;
  publicRedistribution: boolean;
}

export function planningSourceDraft(
  source: Source,
  declaration: Pick<
    TrafficPlanningSourceDraft,
    "privateUseConfirmed" | "publicRedistribution"
  >,
): TrafficPlanningSourceDraft {
  return {
    sourceId: source.id,
    sourceBinding: canonicalJSON(source),
    privateUseConfirmed: declaration.privateUseConfirmed,
    publicRedistribution: declaration.publicRedistribution,
  };
}

export function currentPlanningSourceDeclaration(
  source: Source,
  declarations: readonly TrafficPlanningSourceDraft[],
): TrafficPlanningSourceDraft | undefined {
  return declarations.find(
    (declaration) =>
      declaration.sourceId === source.id &&
      declaration.sourceBinding === canonicalJSON(source),
  );
}

/** A fresh action starts from unchecked permissions when the citation changed. */
export function updatePlanningSourceDeclaration(
  source: Source,
  declarations: readonly TrafficPlanningSourceDraft[],
  patch: Partial<
    Pick<
      TrafficPlanningSourceDraft,
      "privateUseConfirmed" | "publicRedistribution"
    >
  >,
): TrafficPlanningSourceDraft[] {
  const current = currentPlanningSourceDeclaration(source, declarations);
  return [
    ...declarations.filter((declaration) => declaration.sourceId !== source.id),
    planningSourceDraft(source, {
      privateUseConfirmed: current?.privateUseConfirmed ?? false,
      publicRedistribution: current?.publicRedistribution ?? false,
      ...patch,
    }),
  ];
}

export function readPlanningSourceDeclarations(
  sources: readonly Source[],
  declarations: readonly TrafficPlanningSourceDraft[],
) {
  return sources.map((source) => {
    const declaration = currentPlanningSourceDeclaration(source, declarations);
    if (!declaration?.privateUseConfirmed)
      throw new Error(
        `Review private processing permission for the current planning source citation: ${source.name}.`,
      );
    return {
      sourceId: source.id,
      privateUseConfirmed: true as const,
      publicRedistribution: declaration.publicRedistribution,
    };
  });
}

export function planningSourcesCurrent(
  mapping: TrafficPlanningRoadMapping,
  currentSources: readonly Source[] | null,
): boolean {
  return (
    currentSources !== null &&
    canonicalJSON(mapping.sources) === canonicalJSON(currentSources)
  );
}

export interface TrafficPlanningReviewDraft
  extends Omit<TrafficPlanningRoadReviewInput, "directions"> {
  directions: {
    direction: "with-road" | "against-road";
    edgeIds: string[];
    lanes: string;
  }[];
  confirmed: boolean;
  confirmedFor?: string;
}

export function planningReviewDraft(
  value: TrafficPlanningRoadReviewInput,
  confirmed = true,
  mapping?: TrafficPlanningRoadMapping,
): TrafficPlanningReviewDraft {
  return {
    roadId: value.roadId,
    properties: [...value.properties],
    directions: value.directions.map((direction) => ({
      ...direction,
      edgeIds: [...direction.edgeIds],
      lanes: direction.lanes === undefined ? "" : String(direction.lanes),
    })),
    extent: value.extent,
    nativeExtensionAcknowledged: value.nativeExtensionAcknowledged,
    ...(value.deletionAsClosure === undefined
      ? {}
      : { deletionAsClosure: value.deletionAsClosure }),
    rationale: value.rationale,
    confirmed,
    ...(mapping ? { confirmedFor: planningReviewBinding(mapping) } : {}),
  };
}

/** No property, direction, candidate edge or lane allocation is silently reviewed. */
export function newPlanningReview(
  change: TrafficPlanningRoadChange,
): TrafficPlanningReviewDraft {
  return {
    roadId: change.roadId,
    properties: [],
    directions: [
      { direction: "with-road", edgeIds: [], lanes: "" },
      ...((change.proposal ?? change.baseline)?.oneWay
        ? []
        : [{ direction: "against-road" as const, edgeIds: [], lanes: "" }]),
    ],
    extent: "full-road",
    nativeExtensionAcknowledged: false,
    ...(change.proposal === null ? { deletionAsClosure: false } : {}),
    rationale: "",
    confirmed: false,
  };
}

export function readPlanningReviews(
  drafts: readonly TrafficPlanningReviewDraft[],
  requireConfirmation = true,
  mapping?: TrafficPlanningRoadMapping | null,
): TrafficPlanningRoadReviewInput[] {
  return drafts.map((draft) => {
    if (
      requireConfirmation &&
      (!draft.confirmed ||
        (mapping && draft.confirmedFor !== planningReviewBinding(mapping)))
    )
      throw new Error(
        "Confirm or discard each planning-street review before saving.",
      );
    return {
      roadId: draft.roadId,
      properties: [...draft.properties],
      directions: draft.directions.map(({ lanes, ...direction }) => {
        if (!draft.properties.includes("lanes"))
          return { ...direction, edgeIds: [...direction.edgeIds] };
        const count = Number(lanes);
        if (
          !/^\d+$/.test(lanes.trim()) ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 20
        )
          throw new Error(
            "Enter a whole directional lane count from 1 to 20. Blank is not zero.",
          );
        return { ...direction, edgeIds: [...direction.edgeIds], lanes: count };
      }),
      extent: draft.extent,
      nativeExtensionAcknowledged: draft.nativeExtensionAcknowledged,
      ...(draft.deletionAsClosure === undefined
        ? {}
        : { deletionAsClosure: draft.deletionAsClosure }),
      rationale: draft.rationale.trim(),
    };
  });
}
export function planningReviewBinding(
  mapping: TrafficPlanningRoadMapping,
): string {
  return canonicalJSON([
    mapping.baselineHash,
    mapping.roadEditsHash,
    mapping.networkHash,
    mapping.inventoryHash,
    mapping.sources,
  ]);
}

/** Remove only exact server-attributed generated properties; never demote them into manual controls. */
export function manualTrafficOverlays(
  effective: readonly TrafficOverlay[],
  mapping?: TrafficPlanningRoadMapping,
): TrafficOverlay[] {
  const result = effective.map((overlay) => ({ ...overlay }));
  for (const review of mapping?.reviews ?? []) {
    for (const generated of review.overlays) {
      const target = result.find(
        (overlay) => overlay.edgeId === generated.edgeId,
      );
      for (const property of ["closed", "lanes", "speedMps"] as const) {
        if (generated[property] === undefined) continue;
        if (!target || target[property] !== generated[property])
          throw new Error(
            "Saved planning links do not match the retained native controls. Reload the server configuration before editing.",
          );
        delete target[property];
      }
    }
  }
  return result.filter((overlay) => Object.keys(overlay).length > 1);
}

/** A retained OSM source-way identifier is a candidate hint, never correspondence proof. */
export function planningRoadCandidateIds(
  change: TrafficPlanningRoadChange,
  network: TrafficNetwork,
): string[] {
  const match = /^osm-way-(\d+)(?:-part-\d+)?$/.exec(change.baseline?.id ?? "");
  if (!match) return [];
  return network.edges
    .filter((edge) => edge.sourceWayIds.includes(match[1]))
    .map((edge) => edge.id);
}

/** Order is meaningful: serial edges are a chain, not an unordered set. */
export function movePlanningEdge(
  ids: readonly string[],
  index: number,
  offset: -1 | 1,
): string[] {
  const next = [...ids];
  if (
    index < 0 ||
    index >= next.length ||
    index + offset < 0 ||
    index + offset >= next.length
  )
    return next;
  [next[index], next[index + offset]] = [next[index + offset], next[index]];
  return next;
}

export function planningReviewsEqual(
  a: readonly TrafficPlanningReviewDraft[],
  b: readonly TrafficPlanningReviewDraft[],
) {
  return canonicalJSON(a) === canonicalJSON(b);
}
