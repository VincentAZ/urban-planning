import type {
  TrafficNetwork,
  TrafficSignalTiming,
  TrafficPeriod,
  TrafficVehicle,
  TrafficCount,
  TrafficOverlay,
  TrafficSimulationResult,
  TrafficPairRecipe,
  TrafficFileReference,
  Source,
} from "@urban/core";

export const SUMO_IMAGE =
  "ghcr.io/eclipse-sumo/sumo@sha256:1691f722ac2e5a2619c683af457db88de4b68511092e9b6da0affb855d6365cb";
export const SUMO_VERSION = "1.26.0";
export const TRAFFIC_NATIVE_LIMITS = Object.freeze({
  sourceBytes: 100 * 1024 ** 2,
  networkBytes: 64 * 1024 ** 2,
  outputBytes: 256 * 1024 ** 2,
  inputBytes: 64 * 1024 ** 2,
  edges: 30000,
  lanes: 50000,
  connections: 100000,
  vertices: 500000,
  vehicles: 30000,
  counts: 1000,
  detectorBins: 250000,
  simulationSeconds: 10800,
  wallMilliseconds: 180000,
  memoryBytes: 2 * 1024 ** 3,
  concurrency: 1,
});

export interface TrafficNetworkInput {
  /** Trusted source file, confined to the configured input root. */
  osmXmlPath: string;
  osmXmlSha256: string;
  bounds: [number, number, number, number];
  sourceFiles: TrafficFileReference[];
  sources: Source[];
  notes?: string[];
  /** Explicit operator opt-in; preserves original source and records conservative access inference. */
  serviceRoadPolicy?: "infer-unrestricted-service-passenger";
}
export interface PreparedTrafficNetwork {
  network: TrafficNetwork;
  /** Exact immutable native graph; never send this as inline project history. */
  networkXml: Buffer;
  files: Record<string, Buffer>;
  resources: TrafficNativeResources;
}
export interface TrafficNativeResources {
  wallMilliseconds: number;
  peakMemoryBytes: number;
  cpuLimit: number;
  memoryLimitBytes: number;
  outputBytes: number;
}
export interface TrafficNativePairRequest {
  network: PreparedTrafficNetwork;
  period: TrafficPeriod;
  seed: number;
  vehicles: TrafficVehicle[];
  counts: TrafficCount[];
  overlays: TrafficOverlay[];
  signalTimings?: TrafficSignalTiming[];
  demandHash: string;
  countPackHash: string;
  /** Unsupported geometry/control changes must be declared and rejected, not ignored. */
  unsupportedChanges?: string[];
  signal?: AbortSignal;
}
export interface TrafficNativePair {
  recipe: TrafficPairRecipe;
  recipeHash: string;
  baselineNetwork: TrafficNetwork;
  proposalNetwork: TrafficNetwork;
  baseline: TrafficSimulationResult;
  proposal: TrafficSimulationResult;
  files: Record<string, Buffer>;
  resources: TrafficNativeResources;
  notes: string[];
}
