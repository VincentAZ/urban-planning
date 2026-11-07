import { trafficCountSchema, type Source } from "@urban/core";
import type {
  TrafficCount,
  TrafficCountPack,
  TrafficCountTarget,
  TrafficDemand,
  TrafficNetwork,
  TrafficOverlay,
  TrafficPeriod,
  TrafficVehicleClass,
  TrafficCalibrationPlan,
} from "../../../../packages/core/src/traffic";
import {
  trafficNumericCell,
  readTrafficClock,
  readTrafficCoordinates,
  type TrafficCSVMapping,
} from "../../../../packages/core/src/traffic-csv";
export {
  trafficCSVFields,
  countsFromCSV,
  readTrafficClock,
  readTrafficCoordinates,
  type TrafficCSVField,
  type TrafficCSVMapping,
} from "../../../../packages/core/src/traffic-csv";

export interface TrafficSourceDeclaration {
  sourceId: string;
  name: string;
  url: string;
  vintage: string;
  license: string;
  privateUseConfirmed: boolean;
  publicRedistribution: boolean;
}

/** Replacing demand must not leave invisible declarations for sources that were removed. */
export function trafficDeclarationsForSources(
  declarations: readonly TrafficSourceDeclaration[],
  sources: readonly Pick<Source, "id">[],
): TrafficSourceDeclaration[] {
  const retained = new Set(sources.map((source) => source.id));
  return declarations.filter((declaration) =>
    retained.has(declaration.sourceId),
  );
}

/** Deliberate detachment keeps the values and exact attachments, while declaring their new authored status. */
export function authoredTrafficCommuteCopy(
  demand: TrafficDemand,
): TrafficDemand {
  const copy = structuredClone(demand);
  copy.rows = copy.rows.map((row) => ({ ...row, quality: "authored" }));
  copy.notes.push(
    "Copied from a Census commute preparation. This editable demand is now an authored assumption; the original recipe verification no longer applies.",
  );
  return copy;
}
export interface TrafficStagedCSV {
  file: File;
  sha256: string;
  bytes: number;
  sourceId: string;
  mapping: TrafficCSVMapping;
  useAnalysisPeriod: boolean;
  kind: TrafficCount["kind"];
  batchId: string;
}
export interface TrafficDraftValue {
  networkHash: string;
  seed: number;
  calibrationPlan: TrafficCalibrationPlan | null;
  scopeAcknowledged: boolean;
  countPack: TrafficCountPack;
  demand: TrafficDemand;
  commute?: import("@urban/core").TrafficCommuteBinding;
  period: TrafficPeriod;
  overlays: TrafficOverlay[];
  signalTimings?: import("@urban/core").TrafficSignalTiming[];
  /** Explicit review input only; native controls and reviewer stamps are produced by the server. */
  planningRoadReviews?: import("@urban/core").TrafficPlanningRoadReviewInput[];
  planningSourceDeclarations?: {
    sourceId: string;
    privateUseConfirmed: true;
    publicRedistribution: boolean;
  }[];
  sourceDeclarations: TrafficSourceDeclaration[];
  stagedFiles: TrafficStagedCSV[];
  mappingReviews: {
    countId: string;
    target: TrafficCountTarget;
    networkFileSha256: string;
    directionAgreement: "confirmed";
  }[];
}
export interface TrafficCountDraft {
  count: TrafficCount;
  value: string;
  longitude: string;
  latitude: string;
  begin: string;
  end: string;
  targetKind: "unmapped" | "edge" | "turn";
  targetId: string;
  positionPercent: string;
  laneIds: string[];
  laneCoverage: "unknown" | "all" | "specific";
  laneCoverageNetworkHash: string | null;
  mappingReviewed: boolean;
  mappingChanged: boolean;
}
const clock = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
export function trafficCountDraft(count: TrafficCount): TrafficCountDraft {
  return {
    count,
    value: count.value === null ? "" : String(count.value),
    longitude: count.position ? String(count.position[0]) : "",
    latitude: count.position ? String(count.position[1]) : "",
    begin: clock(count.beginSeconds),
    end: clock(count.endSeconds),
    targetKind: count.target?.kind ?? "unmapped",
    targetId:
      count.target?.kind === "edge"
        ? count.target.edgeId
        : (count.target?.connectionId ?? ""),
    positionPercent:
      count.target?.kind === "edge"
        ? String(count.target.positionFraction * 100)
        : "",
    laneIds: count.target?.kind === "edge" ? (count.target.laneIds ?? []) : [],
    laneCoverage:
      count.target?.kind === "edge"
        ? count.target.laneIds?.length
          ? "specific"
          : "all"
        : "unknown",
    laneCoverageNetworkHash:
      count.target?.kind === "edge"
        ? (count.mapping?.networkFileSha256 ?? null)
        : null,
    mappingReviewed: !!count.mapping,
    mappingChanged: false,
  };
}
export function createTrafficCountNetworkIndex(network: TrafficNetwork) {
  return {
    network,
    edges: new Map(network.edges.map((edge) => [edge.id, edge])),
    connectionIds: new Set(
      network.connections.map((connection) => connection.id),
    ),
  };
}
export function readTrafficCountDraft(
  draft: TrafficCountDraft,
  network: TrafficNetwork,
  index?: ReturnType<typeof createTrafficCountNetworkIndex>,
): {
  count: TrafficCount;
  review?: TrafficDraftValue["mappingReviews"][number];
} {
  if (index && index.network !== network)
    throw new Error(
      "Count lookup belongs to a different traffic graph; rebuild its index.",
    );
  const value =
    draft.count.status === "missing"
      ? null
      : trafficNumericCell(
          draft.value,
          `${draft.count.stationId || "Count"} value`,
        );
  if (
    draft.count.status === "available" &&
    (value === null ||
      value < 0 ||
      (draft.count.kind === "observed" && !Number.isSafeInteger(value)))
  )
    throw new Error(
      `${draft.count.stationId || "Count"}: an available count needs a nonnegative value (whole vehicles for observations). Select Missing when no count is supplied.`,
    );
  const beginSeconds = readTrafficClock(draft.begin, "Count interval start"),
    endSeconds = readTrafficClock(draft.end, "Count interval end");
  if (endSeconds <= beginSeconds)
    throw new Error(
      "Count interval end must follow its start; split intervals that cross midnight.",
    );
  let target: TrafficCountTarget | null = null;
  if (draft.targetKind === "edge") {
    const edge = index
      ? index.edges.get(draft.targetId)
      : network.edges.find((edge) => edge.id === draft.targetId);
    if (!edge)
      throw new Error("Choose a directed edge from this traffic network.");
    const percent = trafficNumericCell(
      draft.positionPercent,
      "Count position along edge",
    );
    if (percent === null || percent < 0 || percent > 100)
      throw new Error(
        "Enter the reviewed count location from 0% at the directed edge start to 100% at its end.",
      );
    if (draft.laneCoverage === "unknown")
      throw new Error(
        "Choose whether this count covers all lanes or specific reviewed lanes.",
      );
    if (draft.laneCoverageNetworkHash !== network.manifest.networkFileSha256)
      throw new Error(
        "Review lane coverage against the current graph before applying this count mapping.",
      );
    if (draft.laneCoverage === "specific" && !draft.laneIds.length)
      throw new Error(
        "Select at least one reviewed lane for specific lane coverage.",
      );
    if (draft.laneCoverage === "all" && draft.laneIds.length)
      throw new Error(
        "Clear specific lane selections before confirming all-lane coverage.",
      );
    if (draft.laneIds.some((id) => !edge.lanes.some((lane) => lane.id === id)))
      throw new Error(
        "A selected count lane is absent from this directed edge.",
      );
    target = {
      kind: "edge",
      edgeId: edge.id,
      positionFraction: percent / 100,
      ...(draft.laneCoverage === "specific"
        ? { laneIds: [...draft.laneIds] }
        : {}),
    };
  } else if (draft.targetKind === "turn") {
    if (
      !(index
        ? index.connectionIds.has(draft.targetId)
        : network.connections.some(
            (connection) => connection.id === draft.targetId,
          ))
    )
      throw new Error("Choose a turning movement from this traffic network.");
    target = { kind: "turn", connectionId: draft.targetId };
  }
  if (
    target &&
    (!draft.mappingReviewed ||
      (!draft.mappingChanged &&
        draft.count.mapping?.networkFileSha256 !==
          network.manifest.networkFileSha256))
  )
    throw new Error(
      `${draft.count.stationId}: review its direction, lane coverage and network target before applying.`,
    );
  if (
    value !== null &&
    (value < 0 ||
      (draft.count.kind === "observed" && !Number.isSafeInteger(value)))
  )
    throw new Error(
      "Retained counts must be nonnegative; observations require whole vehicles, including excluded observations.",
    );
  if (
    draft.count.notes.some((note) => note.startsWith("CSV source line ")) &&
    value !== null &&
    value !== draft.count.value &&
    (draft.count.kind !== "factored" ||
      !draft.count.notes.some(
        (note) => note.startsWith("User adjustment: ") && note.slice(17).trim(),
      ))
  )
    throw new Error(
      "A changed CSV count must be Factored with an adjustment explanation; its original value remains retained.",
    );
  const count = {
    ...draft.count,
    vehicleClasses: draft.count.vehicleClasses?.length
      ? draft.count.vehicleClasses
      : null,
    position: readTrafficCoordinates(draft.longitude, draft.latitude),
    beginSeconds,
    endSeconds,
    value: draft.count.status === "missing" ? null : value,
    target,
  };
  if (draft.mappingChanged || !target) delete count.mapping;
  const review =
    target && draft.mappingChanged
      ? {
          countId: count.id,
          target,
          networkFileSha256: network.manifest.networkFileSha256,
          directionAgreement: "confirmed" as const,
        }
      : undefined;
  // Validate the captured fields without inventing a server reviewer for a pending binding.
  const { mapping: _mapping, ...unbound } = count;
  trafficCountSchema.parse({ ...unbound, target: null });
  return { count, ...(review ? { review } : {}) };
}
/** Changing a target never carries an old lane interpretation onto a different edge. */
export function changeTrafficCountTarget(
  draft: TrafficCountDraft,
  targetKind: TrafficCountDraft["targetKind"],
  targetId: string,
): TrafficCountDraft {
  return {
    ...draft,
    targetKind,
    targetId,
    laneIds: [],
    laneCoverage: "unknown",
    laneCoverageNetworkHash: null,
    positionPercent: "",
    mappingReviewed: false,
    mappingChanged: true,
  };
}
export const trafficClasses: TrafficVehicleClass[] = [
  "passenger",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
  "pedestrian",
];
export function draftSource(declaration: TrafficSourceDeclaration): Source {
  return {
    id: declaration.sourceId,
    name: declaration.name.trim(),
    url: declaration.url.trim(),
    vintage: declaration.vintage.trim() || "Unknown",
    license: declaration.license.trim(),
    kind: "user-supplied",
    description:
      "Traffic evidence supplied by the user. Source permissions and uploader identity require server admission; no observation accuracy is implied.",
  };
}
export function validateTrafficOverlayDraft(
  network: TrafficNetwork,
  draft: { edgeId: string; closed: boolean; lanes: string; speedMps: string }[],
): TrafficOverlay[] {
  return draft
    .map((value) => {
      const edge = network.edges.find((edge) => edge.id === value.edgeId);
      if (!edge)
        throw new Error(
          `Directed edge ${value.edgeId} is not in this prepared network.`,
        );
      const lanes = trafficNumericCell(value.lanes, `${value.edgeId} lanes`),
        speed = trafficNumericCell(value.speedMps, `${value.edgeId} speed`);
      if (
        lanes !== null &&
        (!Number.isInteger(lanes) || lanes < 1 || lanes > 20)
      )
        throw new Error(
          "Directional lane count must be a whole number from 1 to 20.",
        );
      if (speed !== null && (speed <= 0 || speed > 70))
        throw new Error(
          "Enter a positive traffic speed no greater than 70 m/s; use Close this direction for a closure.",
        );
      return {
        edgeId: value.edgeId,
        ...(value.closed ? { closed: true } : {}),
        ...(lanes !== null ? { lanes } : {}),
        ...(speed !== null ? { speedMps: speed } : {}),
      };
    })
    .filter((value) => Object.keys(value).length > 1);
}
