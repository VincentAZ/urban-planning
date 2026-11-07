import type { Position, Source } from "./index";
import type { ProjectAccess } from "./collaboration";

export interface EngagementQuestion {
  id: string;
  prompt: string;
  type: "single-choice" | "text";
  required: boolean;
  options?: string[];
}
/** Captured once at publication; later changes require a new publication. */
export interface EngagementConfig {
  introduction: string;
  comments: boolean;
  votes: boolean;
  pins: boolean;
  questions: EngagementQuestion[];
}
export interface EngagementCollection {
  status: "open" | "closed";
  version: number;
  updatedAt: string;
}
export interface PublicEngagement {
  config: EngagementConfig;
  collection: EngagementCollection;
}
export type EngagementSubmission = {
  idempotencyKey: string;
  expectedCollectionVersion: number;
} & (
  | { kind: "comment"; text: string; position?: Position }
  | { kind: "vote"; vote: "support" | "concern" | "neutral" }
  | { kind: "survey"; answers: Record<string, string> }
);
export interface EngagementModeration {
  status: "pending" | "included" | "excluded";
  version: number;
  reason?: string;
  updatedAt?: string;
}
export interface EngagementResponseRecord {
  id: string;
  snapshotId: string;
  kind: "comment" | "vote" | "survey";
  text?: string;
  position?: Position;
  vote?: "support" | "concern" | "neutral";
  answers?: Record<string, string>;
  createdAt: string;
  /** Authoritative latest-record status; false can also describe a legacy logical replacement without a recorded timestamp. */
  current: boolean;
  supersededAt?: string;
  moderation: EngagementModeration;
}
export interface OwnEngagementResponse {
  userId: string;
  snapshotId: string;
  engagement: PublicEngagement;
  responses: EngagementResponseRecord[];
}
export interface EngagementSubmissionResponse {
  id: string;
  createdAt: string;
  alreadySubmitted: boolean;
  collection: EngagementCollection;
  response: EngagementResponseRecord;
}
export interface EngagementQuestionAggregate {
  id: string;
  prompt: string;
  type: "single-choice" | "text";
  answeredAccounts: number;
  skippedAccounts: number;
  options?: { option: string; count: number }[];
  textResponses?: { text: string }[];
}
export interface EngagementAggregate {
  /** Each account counts once here, regardless of how many response kinds it submitted. */
  participatingAccounts: number;
  includedRecords: number;
  pendingIncludedRecords: number;
  excludedCurrentRecords: number;
  supersededRecords: number;
  totalHistoricalRecords: number;
  comments: { count: number; accounts: number; pinnedCount: number };
  votes: {
    accounts: number;
    support: number;
    concern: number;
    neutral: number;
  };
  survey: { accounts: number; questions: EngagementQuestionAggregate[] };
  notes: string[];
}
export interface EngagementSnapshotSummary {
  id: string;
  url: string;
  projectName: string;
  placeName: string;
  extentLabel: string;
  scenarioId: string;
  scenarioName: string;
  scenarioRevision: number;
  createdAt: string;
  revokedAt?: string;
  engagement: PublicEngagement;
  aggregate: EngagementAggregate;
}
export interface EngagementDashboard {
  projectId: string;
  access: ProjectAccess;
  snapshots: EngagementSnapshotSummary[];
}
/** Private project response; never included in the public snapshot. */
export interface EngagementPrivateRecord extends EngagementResponseRecord {
  respondentLabel: string;
}
export interface EngagementAuditEvent {
  id: string;
  actorId: string;
  action: string;
  at: string;
  details: Record<string, unknown>;
}
export interface EngagementSnapshotDetail {
  projectId: string;
  access: ProjectAccess;
  snapshot: EngagementSnapshotSummary;
  records: EngagementPrivateRecord[];
  audit: EngagementAuditEvent[];
}
/** Captured in one authorized store read, including aggregation and its source records. */
export interface EngagementReport {
  schemaVersion: 1;
  generatedAt: string;
  snapshot: EngagementSnapshotSummary;
  aggregate: EngagementAggregate;
  comments: {
    respondentLabel: string;
    text: string;
    position?: Position;
    createdAt: string;
    moderation: "pending" | "included";
  }[];
  responses: {
    kind: "vote" | "survey";
    respondentLabel: string;
    createdAt: string;
    moderation: "pending" | "included";
    vote?: "support" | "concern" | "neutral";
    answers?: Record<string, string>;
  }[];
  sources: Source[];
  notes: string[];
}
