import type { Position, Source } from "./index";

/** Standalone traffic evidence. No Scenario or legacy model defaults are changed. */
export const TRAFFIC_METHOD_VERSION = "1.0.0";
export type TrafficVehicleClass =
  | "passenger"
  | "truck"
  | "bus"
  | "motorcycle"
  | "bicycle"
  | "pedestrian";
export type TrafficEvidenceQuality = "source" | "authored" | "inferred";
export interface TrafficFileReference {
  sourceId: string;
  url: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
}
export interface TrafficNetwork {
  version: 1;
  id: string;
  manifest: {
    engine: { name: "sumo"; version: string; imageDigest: string };
    networkFileSha256: string;
    sourceFiles: TrafficFileReference[];
    sources: Source[];
    conversion: { version: string; options: string[]; warnings: string[] };
    /** Full simulated region, including explicitly retained external ports. */
    bounds: [number, number, number, number];
    notes: string[];
  };
  nodes: TrafficNode[];
  edges: TrafficEdge[];
  connections: TrafficConnection[];
  signals: TrafficSignal[];
}
export interface TrafficNode {
  id: string;
  position: Position;
  type:
    | "priority"
    | "traffic_light"
    | "allway_stop"
    | "right_before_left"
    | "dead_end"
    | "unknown";
  external: boolean;
  quality: TrafficEvidenceQuality;
  sourceIds: string[];
}
export interface TrafficLane {
  id: string;
  index: number;
  shape: Position[];
  lengthMeters: number;
  speedMps: number;
  allowedClasses: TrafficVehicleClass[];
  quality: TrafficEvidenceQuality;
  sourceIds: string[];
}
export interface TrafficEdge {
  id: string;
  from: string;
  to: string;
  roadId?: string;
  sourceWayIds: string[];
  lanes: TrafficLane[];
  quality: TrafficEvidenceQuality;
  sourceIds: string[];
}
export interface TrafficConnection {
  id: string;
  fromEdge: string;
  toEdge: string;
  fromLane: string;
  toLane: string;
  viaLaneIds: string[];
  direction: "left" | "right" | "straight" | "uturn" | "unknown";
  signalId?: string;
  signalIndex?: number;
  quality: TrafficEvidenceQuality;
  sourceIds: string[];
}
export interface TrafficSignal {
  id: string;
  nodeIds: string[];
  programId: string;
  offsetSeconds: number;
  /** Connection IDs in SUMO signal-state character order. */
  connectionIds: string[][];
  phases: { durationSeconds: number; state: string }[];
  quality: TrafficEvidenceQuality;
  sourceIds: string[];
}
/** A fixed-offset local-day window. DST-changing windows must be split explicitly. */
export interface TrafficPeriod {
  date: string;
  timeZone: string;
  utcOffsetMinutes: number;
  beginSeconds: number;
  endSeconds: number;
  warmupSeconds: number;
  cooldownSeconds: number;
}
export type TrafficCountTarget =
  | {
      kind: "edge";
      edgeId: string;
      positionFraction: number;
      laneIds?: string[];
    }
  | { kind: "turn"; connectionId: string };
export interface TrafficCount {
  id: string;
  stationId: string;
  position: Position | null;
  date: string;
  timeZone: string;
  utcOffsetMinutes: number;
  beginSeconds: number;
  endSeconds: number;
  value: number | null;
  status: "available" | "missing" | "excluded";
  kind: "observed" | "factored";
  target: TrafficCountTarget | null;
  mapping?: {
    networkFileSha256: string;
    method: "manual" | "source-id" | "spatial-reviewed";
    snapMeters: number | null;
    directionAgreement: "confirmed" | "not-applicable";
    reviewedBy: string;
    reviewedAt: string;
  };
  /** Null means the vehicle-class mapping has not been established. */
  vehicleClasses: TrafficVehicleClass[] | null;
  raw: {
    directionCode: string;
    laneCode: string;
    classCode: string;
    recordId: string;
    value: string | null;
  };
  sourceIds: string[];
  notes: string[];
}
/** Annual averages are retained as context, never silently turned into hourly counts. */
export interface TrafficAADT {
  id: string;
  stationId: string;
  position: Position | null;
  year: number;
  value: number | null;
  status: "available" | "missing";
  direction: "both" | "forward" | "reverse" | "unknown";
  sourceIds: string[];
  notes: string[];
}
export interface TrafficCountPack {
  version: 1;
  id: string;
  sources: Source[];
  files: TrafficFileReference[];
  counts: TrafficCount[];
  annualCounts: TrafficAADT[];
  notes: string[];
}
export interface TrafficOD {
  id: string;
  originEdge: string;
  destinationEdge: string;
  /** Optional exact native lane attachments. Omission retains legacy whole-edge routing. */
  endpoints?: TrafficRouteEndpoints;
  beginSeconds: number;
  endSeconds: number;
  vehicleClass: TrafficVehicleClass;
  /** Entered one-way vehicle trips, not building trip ends or worker counts. */
  vehicles: number;
  purpose:
    | "commute"
    | "shopping"
    | "school"
    | "freight"
    | "other"
    | "unspecified";
  quality: TrafficEvidenceQuality;
  sourceIds: string[];
}
export interface TrafficRouteEndpoints {
  departLaneId: string;
  /** Native lane coordinates in metres; SUMO locates the vehicle's front here. */
  departPositionMeters: number;
  arrivalLaneId: string;
  arrivalPositionMeters: number;
}
export interface TrafficCandidateRoute {
  id: string;
  odId: string;
  edges: string[];
  weight: number;
  sourceIds: string[];
}
export interface TrafficDemand {
  version: 1;
  rows: TrafficOD[];
  candidateRoutes: TrafficCandidateRoute[];
  sources: Source[];
  notes: string[];
}
export interface TrafficVehicle {
  id: string;
  odId: string;
  routeId: string;
  departSeconds: number;
  edges: string[];
  vehicleClass: TrafficVehicleClass;
  endpoints?: TrafficRouteEndpoints;
}
export interface TrafficOverlay {
  edgeId: string;
  closed?: boolean;
  lanes?: number;
  speedMps?: number;
}
export interface TrafficPairRecipe {
  version: 1;
  baselineNetworkHash: string;
  proposalNetworkHash: string;
  demandHash: string;
  countPackHash: string;
  settingsHash: string;
  period: TrafficPeriod;
  seed: number;
  methodVersion: string;
}
export interface TrafficCountPrediction {
  countId: string;
  vehicles: number | null;
  status: "available" | "unavailable";
  reason?: string;
}
export interface TrafficCalibrationPlan {
  calibrationCountIds: string[];
  holdoutCountIds: string[];
  /** User/agency acceptance criteria; these are not universal regulatory thresholds. */
  criteria: {
    gehMaximum: number;
    absoluteHourlyErrorMaximum: number;
    relativeErrorMaximum: number;
    requiredPassingFraction: number;
    minimumCalibrationCounts: number;
    minimumHoldoutCounts: number;
  };
  sourceIds: string[];
  description: string;
}
export interface TrafficTripResult {
  id: string;
  requestedDepartSeconds: number;
  arrived: boolean;
  departSeconds: number | null;
  arrivalSeconds: number | null;
  durationSeconds: number | null;
  routeLengthMeters: number | null;
  waitingSeconds: number | null;
  timeLossSeconds: number | null;
  departDelaySeconds: number | null;
}
export interface TrafficRunDiagnostics {
  requested: number;
  loaded: number;
  inserted: number;
  arrived: number;
  running: number;
  waiting: number;
  discarded: number;
  teleports: number;
  collisions: number;
  routeErrors: number;
}
export interface TrafficEdgeResult {
  edgeId: string;
  beginSeconds: number;
  endSeconds: number;
  entered: number;
  left: number;
  meanSpeedMps: number | null;
  meanTravelTimeSeconds: number | null;
  sampledSeconds: number;
}
export interface TrafficSimulationResult {
  version: 1;
  side: "baseline" | "proposal";
  recipeHash: string;
  networkHash: string;
  demandHash: string;
  seed: number;
  period: TrafficPeriod;
  assignedRoutesHash: string;
  diagnostics: TrafficRunDiagnostics;
  trips: TrafficTripResult[];
  predictions: TrafficCountPrediction[];
  edges: TrafficEdgeResult[];
  files: TrafficFileReference[];
  notes: string[];
}

// Bounds apply to normalized run inputs, not the retained original source archive.
export const MAX_TRAFFIC_EDGES = 100000;
export const MAX_TRAFFIC_VEHICLES = 250000;
export const MAX_TRAFFIC_COUNTS = 100000;
export const MAX_TRAFFIC_ROUTE_SEGMENTS = 5000000;

export interface TrafficCalibrationRow {
  countId: string;
  role: "calibration" | "holdout";
  observed: number | null;
  modeled: number | null;
  observedHourly: number | null;
  modeledHourly: number | null;
  absoluteHourlyError: number | null;
  relativeError: number | null;
  geh: number | null;
  passed: boolean | null;
  reason: string | null;
}
export interface TrafficCalibrationGroup {
  requested: number;
  evaluated: number;
  unavailable: number;
  passed: number;
  passingFraction: number | null;
  status: "passed" | "failed" | "incomplete";
}
export interface TrafficCalibrationResult {
  methodVersion: string;
  rows: TrafficCalibrationRow[];
  calibration: TrafficCalibrationGroup;
  holdout: TrafficCalibrationGroup;
  status: "passed" | "failed" | "incomplete";
  /** This count-fit check alone is never full traffic-model validation. */
  scope: "interval-count-fit";
  notes: string[];
}
export interface TrafficRunSummary {
  status: "complete" | "incomplete" | "failed";
  requested: number;
  completed: number;
  incomplete: number;
  completionFraction: number | null;
  measurementRequested: number | null;
  measurementCompleted: number;
  meanTravelTimeSeconds: number | null;
  meanTimeLossSeconds: number | null;
  meanDepartureDelaySeconds: number | null;
  vehicleKilometers: number | null;
  vehicleHours: number | null;
  completedSubtotal: {
    vehicleKilometers: number | null;
    vehicleHours: number | null;
    meanTravelTimeSeconds: number | null;
    meanTimeLossSeconds: number | null;
    meanDepartureDelaySeconds: number | null;
  };
  reasons: string[];
  notes: string[];
}
export interface TrafficComparison {
  methodVersion: string;
  recipeHash: string;
  baseline: TrafficRunSummary;
  proposal: TrafficRunSummary;
  delta: {
    meanTravelTimeSeconds: number | null;
    meanTimeLossSeconds: number | null;
    meanDepartureDelaySeconds: number | null;
    vehicleKilometers: number | null;
    vehicleHours: number | null;
  };
  notes: string[];
}
