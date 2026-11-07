import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "./errors.js";
import {
  addAudit,
  authorize,
  type DataState,
  type Store,
  type UserRecord,
} from "./store.js";
import { requestScope, type StoreScope } from "./store-scope.js";
import {
  hashPassword,
  newToken,
  safeEqual,
  tokenHash,
  verifyPassword,
} from "./security.js";
import type {
  IdentityAcceptedResponse,
  IdentityChallengeRecord,
  IdentityMailRuntime,
  IdentityOutboxRecord,
} from "./identity-types.js";

export const identityEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);
export const identityPasswordSchema = z.string().min(12).max(256);
export const identityTokenSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
  );
export const credentialVersion = (user: { credentialVersion?: number }) =>
  user.credentialVersion ?? 0;
export const unavailableMail: IdentityMailRuntime = {
  capability: () => ({
    available: false,
    mode: "disabled",
    message: "Email delivery is not configured. No email has been sent.",
  }),
  prepare: async () => {
    throw new ApiError(
      503,
      "IDENTITY_DELIVERY_UNAVAILABLE",
      "Email delivery is not configured. No email has been sent.",
    );
  },
  assertAdmission: () => {
    throw new ApiError(
      503,
      "IDENTITY_DELIVERY_UNAVAILABLE",
      "Email delivery is not configured. No email has been sent.",
    );
  },
};
export interface IdentityContext {
  store: Store;
  auth: (
    state: DataState,
    request: FastifyRequest,
    roles?: ("owner" | "editor" | "commenter" | "viewer")[],
  ) => ReturnType<typeof authorize>;
  mail: IdentityMailRuntime;
  origin: string;
}
export const mailAdmissionScope: StoreScope = {
  identityOutboxHeaders: { all: true },
  identityOutbox: { append: true },
  budget: true,
  audit: { append: true },
};
export function requireVerified(user: UserRecord) {
  if (!user.emailVerifiedAt)
    throw new ApiError(
      403,
      "EMAIL_VERIFICATION_REQUIRED",
      "Verify your email before inviting or accepting access.",
    );
}
export function requireDelivery(context: IdentityContext) {
  if (!context.mail.capability().available)
    throw new ApiError(
      503,
      "IDENTITY_DELIVERY_UNAVAILABLE",
      context.mail.capability().message,
    );
}
export function identityToken() {
  const id = randomUUID(),
    token = `${id}.${newToken()}`;
  return { id, token, tokenHash: tokenHash(token) };
}
export function identityLink(
  context: IdentityContext,
  kind: "verify-email" | "password-reset" | "invitation",
  token: string,
) {
  return `${context.origin.replace(/\/$/, "")}/#identity=${kind}&token=${token}`;
}
export function recordIdentityAudit(
  state: DataState,
  userId: string,
  action: string,
  details: Record<string, unknown>,
  organizationId?: string,
  projectId?: string,
) {
  const organization =
    organizationId ??
    state.memberships.find((m) => m.userId === userId)?.organizationId;
  if (organization)
    addAudit(state, {
      organizationId: organization,
      actorId: userId,
      action,
      details,
      ...(projectId ? { projectId } : {}),
    });
}
export function queueIdentityMail(
  context: IdentityContext,
  state: DataState,
  mail: IdentityOutboxRecord,
) {
  context.mail.assertAdmission(state, mail);
  state.identityOutbox.push(mail);
}
const accepted = (): IdentityAcceptedResponse => ({
  accepted: true,
  message:
    "If the account is eligible, an email has been queued. Check your inbox; delivery may take a few minutes.",
});
const invalidChallenge = (): never => {
  throw new ApiError(
    400,
    "IDENTITY_LINK_INVALID",
    "This link is invalid, expired, or already used. Request a new link.",
  );
};
function validChallenge(
  state: DataState,
  id: string,
  hash: string,
  purpose: IdentityChallengeRecord["purpose"],
  userId?: string,
) {
  const challenge = state.identityChallenges.find((c) => c.id === id);
  if (
    !challenge ||
    challenge.purpose !== purpose ||
    challenge.consumedAt ||
    challenge.revokedAt ||
    Date.parse(challenge.expiresAt) <= Date.now() ||
    !safeEqual(challenge.tokenHash, hash) ||
    (userId && challenge.userId !== userId)
  )
    return invalidChallenge();
  const user = state.users.find((u) => u.id === challenge.userId);
  if (
    !user ||
    user.email !== challenge.email ||
    credentialVersion(user) !== challenge.credentialVersion
  )
    return invalidChallenge();
  return { challenge, user };
}
function revokeChallengesAndSessions(
  state: DataState,
  userId: string,
  at: string,
  consumedId?: string,
) {
  for (const item of state.identityChallenges) {
    if (item.userId !== userId || item.consumedAt || item.revokedAt) continue;
    if (item.id === consumedId) item.consumedAt = at;
    else item.revokedAt = at;
  }
  state.sessions = state.sessions.filter((s) => s.userId !== userId);
}
export class IdentityService {
  constructor(readonly context: IdentityContext) {}
  async security(request: FastifyRequest) {
    return this.context.store.read((state) => {
      const { user } = this.context.auth(state, request);
      return {
        userId: user.id,
        email: user.email,
        emailVerified: !!user.emailVerifiedAt,
        ...(user.emailVerifiedAt
          ? { emailVerifiedAt: user.emailVerifiedAt }
          : {}),
        delivery: this.context.mail.capability(),
      };
    }, requestScope(request));
  }
  async requestChallenge(
    request: FastifyRequest,
    purpose: IdentityChallengeRecord["purpose"],
    email?: string,
  ) {
    requireDelivery(this.context);
    try {
      return await this.requestChallengeActive(request, purpose, email);
    } catch (error) {
      if (purpose === "password-reset") {
        // Queue, crypto and storage failures must not distinguish a registered
        // mailbox. Never log the exception: it may contain the prepared link.
        if (
          !(error instanceof ApiError && [429, 503].includes(error.statusCode))
        )
          request.log.error(
            { code: "IDENTITY_RECOVERY_REQUEST_UNCONFIRMED" },
            "Recovery email admission could not be confirmed.",
          );
        return accepted();
      }
      throw error;
    }
  }
  private async requestChallengeActive(
    request: FastifyRequest,
    purpose: IdentityChallengeRecord["purpose"],
    email?: string,
  ) {
    const user =
      purpose === "verify-email"
        ? await this.context.store.read(
            (state) => this.context.auth(state, request).user,
            requestScope(request),
          )
        : await this.context.store.read(
            (state) => state.users.find((u) => u.email === email),
            {
              security: { mode: "auth", purpose: "lookup", email: email! },
              users: { where: [{ email: email! }] },
            },
          );
    if (!user || (purpose === "verify-email" && user.emailVerifiedAt))
      return accepted();
    const secret = identityToken(),
      now = new Date(),
      at = now.toISOString();
    const challenge: IdentityChallengeRecord = {
      id: secret.id,
      userId: user.id,
      email: user.email,
      purpose,
      credentialVersion: credentialVersion(user),
      tokenHash: secret.tokenHash,
      createdAt: at,
      expiresAt: new Date(
        now.getTime() +
          (purpose === "verify-email" ? 24 * 3600000 : 30 * 60000),
      ).toISOString(),
    };
    const mail = await this.context.mail.prepare({
      id: randomUUID(),
      kind: purpose,
      to: user.email,
      userId: user.id,
      challengeId: challenge.id,
      subject:
        purpose === "verify-email"
          ? "Verify your Urban Planning email"
          : "Reset your Urban Planning password",
      text: `${purpose === "verify-email" ? "Confirm this email while signed in to the same account." : "Choose a new password. Existing sessions will be signed out."}\n\n${identityLink(this.context, purpose, secret.token)}\n\nIf you did not request this, you can ignore this message.`,
      expiresAt: challenge.expiresAt,
    });
    return this.context.store.transaction(
      (state) => {
        if (
          purpose === "verify-email" &&
          this.context.auth(state, request).user.id !== user.id
        )
          return invalidChallenge();
        const current = state.users.find((u) => u.id === user.id);
        if (
          !current ||
          current.email !== user.email ||
          credentialVersion(current) !== challenge.credentialVersion
        )
          return accepted();
        const recent = state.identityChallenges.filter(
          (c) =>
            c.userId === user.id &&
            c.purpose === purpose &&
            Date.parse(c.createdAt) > Date.now() - 86400000,
        );
        if (
          recent.some((c) => Date.parse(c.createdAt) > Date.now() - 60000) ||
          recent.filter((c) => Date.parse(c.createdAt) > Date.now() - 3600000)
            .length >= 5 ||
          recent.length >= 20
        )
          return accepted();
        for (const c of state.identityChallenges)
          if (
            c.userId === user.id &&
            c.purpose === purpose &&
            !c.consumedAt &&
            !c.revokedAt
          )
            c.revokedAt = at;
        state.identityChallenges.push(challenge);
        queueIdentityMail(this.context, state, mail);
        recordIdentityAudit(
          state,
          user.id,
          purpose === "verify-email"
            ? "identity.verification.requested"
            : "identity.password-reset.requested",
          { challengeId: challenge.id },
        );
        return accepted();
      },
      {
        ...mailAdmissionScope,
        ...(purpose === "verify-email" ? requestScope(request) : {}),
        security: {
          mode: "auth",
          purpose: "challenge-issue",
          email: user.email,
          userId: user.id,
          credentialVersion: challenge.credentialVersion,
          challengeId: challenge.id,
        },
        users: { where: [{ id: user.id }] },
        memberships: { where: [{ userId: user.id }] },
        identityChallenges: { where: [{ userId: user.id }] },
      },
    );
  }
  async verify(request: FastifyRequest, token: string) {
    const hash = tokenHash(token),
      id = token.split(".")[0];
    const current = await this.context.store.read(
      (state) => this.context.auth(state, request).user,
      requestScope(request),
    );
    return this.context.store.transaction(
      (state) => {
        const { user } = this.context.auth(state, request);
        const result = validChallenge(state, id, hash, "verify-email", user.id),
          at = new Date().toISOString();
        result.challenge.consumedAt = at;
        result.user.emailVerifiedAt ??= at;
        recordIdentityAudit(state, user.id, "identity.verification.completed", {
          challengeId: id,
        });
        return {
          ok: true as const,
          emailVerified: true as const,
          emailVerifiedAt: result.user.emailVerifiedAt,
        };
      },
      requestScope(request, {
        security: {
          mode: "auth",
          purpose: "challenge-consume",
          email: current.email,
          userId: current.id,
          credentialVersion: credentialVersion(current),
          challengeId: id,
          tokenHash: hash,
        },
        identityChallenges: { where: [{ id }] },
        audit: { append: true },
      }),
    );
  }
  private async notification(user: UserRecord) {
    try {
      return await this.context.mail.prepare({
        id: randomUUID(),
        kind: "password-changed",
        to: user.email,
        userId: user.id,
        subject: "Your Urban Planning password changed",
        text: "Your password has changed and all previous sessions have been signed out. If you did not make this change, use password recovery on the Urban Planning sign-in page.",
        expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      });
    } catch {
      return undefined;
    }
  }
  private queueNotification(state: DataState, mail?: IdentityOutboxRecord) {
    if (!mail) return false;
    const budget = structuredClone(state.budget),
      outbox = [...state.identityOutbox],
      headers = [...state.identityOutboxHeaders];
    try {
      queueIdentityMail(this.context, state, mail);
      return true;
    } catch {
      state.budget = budget;
      state.identityOutbox = outbox;
      state.identityOutboxHeaders = headers;
      return false;
    }
  }
  async reset(token: string, password: string) {
    const hash = tokenHash(token),
      id = token.split(".")[0];
    const before = await this.context.store.read(
      (state) => validChallenge(state, id, hash, "password-reset"),
      {
        security: {
          mode: "auth",
          purpose: "challenge-lookup",
          challengeId: id,
          tokenHash: hash,
        },
        identityChallenges: { where: [{ id }] },
        users: {
          where: [{ id: { from: "identityChallenges", field: "userId" } }],
        },
      },
    );
    const passwordHash = await hashPassword(password),
      notification = await this.notification(before.user);
    await this.context.store.transaction(
      (state) => {
        const { user, challenge } = validChallenge(
            state,
            id,
            hash,
            "password-reset",
          ),
          at = new Date().toISOString();
        if (credentialVersion(user) !== before.challenge.credentialVersion)
          return invalidChallenge();
        user.passwordHash = passwordHash;
        user.credentialVersion = credentialVersion(user) + 1;
        user.emailVerifiedAt ??= at;
        revokeChallengesAndSessions(state, user.id, at, challenge.id);
        const notificationQueued = this.queueNotification(state, notification);
        recordIdentityAudit(
          state,
          user.id,
          "identity.password-reset.completed",
          { challengeId: id, notificationQueued },
        );
      },
      {
        ...mailAdmissionScope,
        security: {
          mode: "auth",
          purpose: "challenge-consume",
          email: before.user.email,
          userId: before.user.id,
          credentialVersion: before.challenge.credentialVersion,
          challengeId: id,
          tokenHash: hash,
        },
        users: { where: [{ id: before.user.id }] },
        memberships: { where: [{ userId: before.user.id }] },
        identityChallenges: { where: [{ userId: before.user.id }] },
        sessions: { where: [{ userId: before.user.id }] },
      },
    );
    return { ok: true as const, requireLogin: true as const };
  }
  async changePassword(
    request: FastifyRequest,
    currentPassword: string,
    password: string,
  ) {
    const current = await this.context.store.read(
      (state) => this.context.auth(state, request).user,
      requestScope(request),
    );
    const credentials = await this.context.store.read(
      (state) => state.users.find((u) => u.id === current.id),
      {
        security: { mode: "auth", purpose: "lookup", email: current.email },
        users: { where: [{ id: current.id }] },
      },
    );
    if (
      !credentials?.passwordHash ||
      !(await verifyPassword(currentPassword, credentials.passwordHash))
    )
      throw new ApiError(
        401,
        "INVALID_CREDENTIALS",
        "Your current password is incorrect.",
      );
    const expectedPasswordHash = credentials.passwordHash,
      passwordHash = await hashPassword(password),
      notification = await this.notification(current);
    await this.context.store.transaction(
      (state) => {
        const { user } = this.context.auth(state, request);
        if (
          user.id !== current.id ||
          credentialVersion(user) !== credentialVersion(credentials)
        )
          throw new ApiError(
            409,
            "IDENTITY_CHANGED",
            "Your credentials changed. Sign in again.",
          );
        user.passwordHash = passwordHash;
        user.credentialVersion = credentialVersion(user) + 1;
        const at = new Date().toISOString();
        revokeChallengesAndSessions(state, user.id, at);
        const notificationQueued = this.queueNotification(state, notification);
        recordIdentityAudit(state, user.id, "identity.password.changed", {
          notificationQueued,
        });
      },
      requestScope(request, {
        ...mailAdmissionScope,
        security: {
          mode: "auth",
          purpose: "password-change",
          email: current.email,
          userId: current.id,
          credentialVersion: credentialVersion(credentials),
          expectedPasswordHash,
        },
        identityChallenges: { where: [{ userId: current.id }] },
        sessions: { where: [{ userId: current.id }] },
      }),
    );
    return { ok: true as const, requireLogin: true as const };
  }
}
