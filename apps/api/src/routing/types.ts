import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

export type RoutingPosition = [number, number];
export type RoutingMode = "car" | "walk";
export type RoutingDirection = "inbound" | "outbound";
export interface RoutingSource {
  url: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
  lastModified?: string;
}
export interface RoutingRegionManifest {
  version: 1;
  id: string;
  engine: {
    name: "valhalla";
    version: "3.9.1";
    image: string;
    imageDigest: string;
  };
  sources: RoutingSource[];
  graph: { sha256: string; bytes: number; files: number };
  config: { sha256: string };
  profile: {
    carTopSpeedKph: 140;
    walkingSpeedKph: 5.1;
    walkingBoundKph: 10;
    excludeWalkingFerries: true;
  };
  coverage: {
    geometry: Polygon | MultiPolygon;
    maximumMinutes: 45;
    maximumSpeedKph: 252;
    maximumSnapMeters: 250;
    safetyMarginMeters: 1000;
  };
  build: {
    startedAt: string;
    completedAt: string;
    wallSeconds: number;
    peakMemoryBytes: number;
    cpuLimit: number;
    memoryLimitBytes: number;
    diskLimitBytes: number;
  };
  limitations: string[];
  credits: string[];
}
export interface RoutingOrigin {
  id: string;
  position: RoutingPosition;
}
export interface RoutingRow {
  id: string;
  status:
    | "reachable"
    | "unreachable"
    | "unsnappable"
    | "outside-coverage"
    | "outside-threshold";
  seconds: number | null;
  distanceMeters: number | null;
  snapMeters: number | null;
  lowerBoundSeconds?: number;
}
export interface RoutingMatrixRequest {
  site: RoutingPosition;
  origins: RoutingOrigin[];
  mode: RoutingMode;
  signal?: AbortSignal;
}
export interface RoutingOutboundMatrixRequest {
  site: RoutingPosition;
  destinations: RoutingOrigin[];
  mode: RoutingMode;
  signal?: AbortSignal;
}
export interface RoutingMatrixResult<D extends RoutingDirection = "inbound"> {
  manifestId: string;
  inputHash: string;
  mode: RoutingMode;
  direction: D;
  siteSnapMeters: number;
  rows: RoutingRow[];
  coverage: {
    status: "complete";
    boundaryDistanceMeters: number;
    requiredRadiusMeters: number;
  };
  search: RoutingSearchDiagnostics;
  notes: string[];
}
export interface RoutingSearchDiagnostics {
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
export interface RoutingIsochroneResult<
  D extends RoutingDirection = "inbound",
> {
  manifestId: string;
  inputHash: string;
  site: RoutingPosition;
  mode: RoutingMode;
  direction: D;
  minutes: [15, 30, 45];
  geometry: FeatureCollection<Polygon | MultiPolygon>;
  notes: string[];
}
export class RoutingError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 422,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}
