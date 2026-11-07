import type { BaselineIdentity } from "./snapshots";
import type { Position } from "./index";
export interface PlaceCandidate {
  id: string;
  label: string;
  kind: "zcta" | "address" | "city";
  coordinates: Position;
  zip?: string;
  placeId?: string;
  prepared: boolean;
  detail: string;
  sourceName: string;
}
export interface PlaceSearchResponse {
  candidates: PlaceCandidate[];
  warnings: string[];
  mode: "zip" | "address" | "city" | "point";
  attribution: string[];
}
export interface PreparationJob {
  id: string;
  zip: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: "queued" | "boundary" | "osm" | "demographics" | "saving" | "complete";
  progress: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  placeId?: string;
  baselineIdentity?: BaselineIdentity;
  error?: { code: string; message: string; retryable: boolean };
  warnings: string[];
}
export interface NationalPreparationCapabilities {
  enabled: boolean;
  mode: "bounded-public-preview";
  reason: string;
  search: {
    zip: true;
    city: true;
    address: true;
    mapPoint: true;
    autocomplete: false;
  };
  limits: {
    maxStudyAreaKm2: number;
    maxFetchBoundsKm2: number;
    maxElements: number;
    maxResponseBytes: number;
    jobsPerUserPerDay: number;
    sourceRequestsPerDay: number;
    concurrency: 1;
  };
  nationalCoverageComplete: false;
  paidProviders: [];
}
