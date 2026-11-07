import type {
  IdentityAcceptedResponse,
  IdentityInvitationAccepted,
  IdentityInvitationPreview,
  IdentityInvitationsResponse,
  IdentityPasswordResponse,
  IdentitySecurityResponse,
  IdentityVerificationResponse,
} from "../../../../apps/api/src/identity-types";
import type { ProjectRole } from "@urban/core";
import { api, ApiError } from "./api";

export type IdentityIntent = {
  kind: "verify-email" | "password-reset" | "invitation";
  token: string;
};
export type { IdentityInvitationAccepted, IdentitySecurityResponse };
const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body), signal });
const invitationPath = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/invitations`;
export interface InvitationInput {
  email: string;
  role: ProjectRole;
  expectedAclVersion: number;
  idempotencyKey: string;
}
export const identityApi = {
  security: (signal?: AbortSignal) =>
    api<IdentitySecurityResponse>("/auth/security", {
      signal,
      cache: "no-store",
    }),
  requestVerification: (signal?: AbortSignal) =>
    post<IdentityAcceptedResponse>(
      "/auth/email-verification/request",
      {},
      signal,
    ),
  verifyEmail: (token: string, signal?: AbortSignal) =>
    post<IdentityVerificationResponse>(
      "/auth/email-verification/confirm",
      { token },
      signal,
    ),
  requestReset: (email: string, signal?: AbortSignal) =>
    post<IdentityAcceptedResponse>(
      "/auth/password-reset/request",
      { email },
      signal,
    ),
  resetPassword: (token: string, password: string, signal?: AbortSignal) =>
    post<IdentityPasswordResponse>(
      "/auth/password-reset/confirm",
      { token, password },
      signal,
    ),
  changePassword: (
    currentPassword: string,
    password: string,
    signal?: AbortSignal,
  ) =>
    post<IdentityPasswordResponse>(
      "/auth/password/change",
      { currentPassword, password },
      signal,
    ),
  invitations: (projectId: string, signal?: AbortSignal) =>
    api<IdentityInvitationsResponse>(invitationPath(projectId), {
      signal,
      cache: "no-store",
    }),
  invite: (projectId: string, body: InvitationInput, signal?: AbortSignal) =>
    post<IdentityInvitationsResponse>(invitationPath(projectId), body, signal),
  resend: (
    projectId: string,
    id: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ) =>
    post<IdentityInvitationsResponse>(
      `${invitationPath(projectId)}/${encodeURIComponent(id)}/resend`,
      { expectedVersion },
      signal,
    ),
  revoke: (
    projectId: string,
    id: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ) =>
    post<IdentityInvitationsResponse>(
      `${invitationPath(projectId)}/${encodeURIComponent(id)}/revoke`,
      { expectedVersion },
      signal,
    ),
  previewInvitation: (token: string, signal?: AbortSignal) =>
    post<IdentityInvitationPreview>("/invitations/preview", { token }, signal),
  acceptInvitation: (
    token: string,
    expectedVersion: number,
    expectedAclVersion?: number,
    signal?: AbortSignal,
  ) =>
    post<IdentityInvitationAccepted>(
      "/invitations/accept",
      {
        token,
        expectedVersion,
        ...(expectedAclVersion === undefined ? {} : { expectedAclVersion }),
      },
      signal,
    ),
};

/** Never echo raw failures: a token or password may occur in transport/validation diagnostics. */
export function identityError(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The request could not be completed. Check your connection and try again.";
  const code = error.code ?? "";
  if (code === "INVITATION_PENDING")
    return "A pending invitation already exists for this address. Refresh the list, then resend or revoke that invitation.";
  if (code === "INVITATION_ALREADY_MEMBER")
    return "This account already has access. An owner can review its current role in the member list.";
  if (/EMAIL.*(EXIST|REGISTER)|ACCOUNT.*EXIST/.test(code))
    return "An account could not be created with these details. Try signing in or requesting password recovery.";
  if (
    /DELIVERY|MAIL_UNAVAILABLE|IDENTITY_DISABLED/.test(code) ||
    error.status === 503
  )
    return "Email delivery is unavailable on this server. No delivery has been confirmed. Your existing private work remains available.";
  if (/RECIPIENT|EMAIL_MISMATCH|WRONG_ACCOUNT/.test(code))
    return "This link belongs to a different email address. Sign in with the account that received it.";
  if (/VERIF/.test(code) && error.status === 403)
    return "Verify the email address on this account before sharing or reviewing an invitation.";
  if (
    /EXPIRED|TOKEN|LINK_INVALID|CHALLENGE|INVITATION_UNAVAILABLE/.test(code) ||
    error.status === 410
  )
    return "This link is unavailable, expired, or has already been used. Request a new link and try again.";
  if (error.status === 401)
    return "Your sign-in has expired or the supplied credentials could not be confirmed. Sign in again or check your current password.";
  if (error.status === 403)
    return "This account cannot perform that action. Check the recipient email and your current access.";
  if (error.status === 409)
    return "The account or project access changed. Refresh this review before trying again.";
  if (error.status === 429)
    return "Too many requests were made. Wait a little before trying again.";
  if (error.status === 400 || error.status === 422)
    return "Check the entered details. Use a valid email address and a password of at least 12 characters.";
  return "The request could not be completed. Refresh and try again.";
}
export function passwordIssue(
  password: string,
  confirmation: string,
): string | null {
  if (password.length < 12) return "Use a password of at least 12 characters.";
  if (password.length > 256) return "Use a password of at most 256 characters.";
  return password === confirmation ? null : "The passwords do not match.";
}
export class InvitationAttempts {
  private pending: { signature: string; body: InvitationInput } | null = null;
  for(
    projectId: string,
    email: string,
    role: ProjectRole,
    expectedAclVersion: number,
  ): InvitationInput {
    const normalized = email.trim();
    const signature = JSON.stringify([projectId, normalized, role]);
    if (this.pending?.signature !== signature)
      this.pending = {
        signature,
        body: {
          email: normalized,
          role,
          expectedAclVersion,
          idempotencyKey: crypto.randomUUID(),
        },
      };
    return this.pending.body;
  }
  clear() {
    this.pending = null;
  }
}
