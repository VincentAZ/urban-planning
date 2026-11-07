import type { ProjectRole } from "@urban/core";
import type { DataState } from "./store.js";

export type IdentityChallengePurpose = "verify-email" | "password-reset";
export interface IdentityChallengeRecord {
  id: string;
  userId: string;
  email: string;
  purpose: IdentityChallengePurpose;
  credentialVersion: number;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}
export interface IdentityInvitationRecord {
  id: string;
  organizationId: string;
  projectId?: string;
  scope: "project" | "workspace";
  email: string;
  role: ProjectRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  version: number;
  tokenHash: string;
  idempotencyKey: string;
  submissionHash: string;
  status: "pending" | "accepted" | "revoked";
  acceptedBy?: string;
  acceptedAt?: string;
  revokedBy?: string;
  revokedAt?: string;
}
export type IdentityMailKind =
  | IdentityChallengePurpose
  | "password-changed"
  | "invitation";
export interface IdentitySealedMail {
  version: 1;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
export interface IdentityOutboxRecord {
  id: string;
  kind: IdentityMailKind;
  userId?: string;
  organizationId?: string;
  challengeId?: string;
  invitationId?: string;
  invitationVersion?: number;
  recipientKey: string;
  sealed: IdentitySealedMail;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number;
  nextAttemptAt: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  sentAt?: string;
  lastFailure?: "temporary" | "permanent" | "expired" | "cancelled";
  costReservationId?: string;
}
export interface IdentityMailInput {
  id: string;
  kind: IdentityMailKind;
  to: string;
  subject: string;
  text: string;
  html?: string;
  userId?: string;
  organizationId?: string;
  challengeId?: string;
  invitationId?: string;
  invitationVersion?: number;
  expiresAt: string;
}
export interface IdentityDeliveryCapability {
  available: boolean;
  mode: "disabled" | "local-test" | "smtp";
  message: string;
}
export interface IdentityMailRuntime {
  capability(): IdentityDeliveryCapability;
  prepare(input: IdentityMailInput): Promise<IdentityOutboxRecord>;
  assertAdmission(state: DataState, record: IdentityOutboxRecord): void;
}
export interface IdentitySecurityResponse {
  userId: string;
  email: string;
  emailVerified: boolean;
  emailVerifiedAt?: string;
  delivery: IdentityDeliveryCapability;
}
export interface IdentityAcceptedResponse {
  accepted: true;
  message: string;
}
export interface IdentityPasswordResponse {
  ok: true;
  requireLogin: true;
}
export interface IdentityVerificationResponse {
  ok: true;
  emailVerified: true;
  emailVerifiedAt: string;
}
/** Only owner-authorized rosters contain the destination address. Tokens and sealed mail never do. */
export interface IdentityInvitationView {
  id: string;
  scope: "project" | "workspace";
  organizationId: string;
  projectId?: string;
  email: string;
  role: ProjectRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  version: number;
  status: "pending" | "accepted" | "revoked" | "expired";
  acceptedAt?: string;
  revokedAt?: string;
}
export interface IdentityInvitationsResponse {
  invitations: IdentityInvitationView[];
  delivery: IdentityDeliveryCapability;
  aclVersion?: number;
}
export interface IdentityInvitationPreview {
  invitation: IdentityInvitationView;
  organization: { id: string; name: string };
  project?: { id: string; name: string };
  aclVersion?: number;
}
export interface IdentityInvitationAccepted {
  accepted: true;
  organizationId: string;
  projectId?: string;
  role: ProjectRole;
  aclVersion?: number;
  alreadyAccepted: boolean;
}
