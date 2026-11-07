/** Test-only in-memory mailbox. No transport, filesystem sink, or public token endpoint. */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DataState } from "./store.js";
import type {
  IdentityMailInput,
  IdentityMailRuntime,
  IdentityOutboxRecord,
} from "./identity-types.js";
import { tokenHash } from "./security.js";
export class FixtureIdentityMail implements IdentityMailRuntime {
  messages: IdentityMailInput[] = [];
  unavailable = false;
  failAdmission = false;
  capability() {
    return {
      available: !this.unavailable,
      mode: "local-test" as const,
      message: "Isolated test mailbox; no external message is sent.",
    };
  }
  async prepare(input: IdentityMailInput): Promise<IdentityOutboxRecord> {
    if (this.unavailable) throw new Error("Test delivery disabled");
    this.messages.push(structuredClone(input));
    const createdAt = new Date().toISOString();
    const {
      id,
      kind,
      userId,
      organizationId,
      challengeId,
      invitationId,
      invitationVersion,
      expiresAt,
    } = input;
    return {
      id,
      kind,
      ...(userId ? { userId } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(challengeId ? { challengeId } : {}),
      ...(invitationId ? { invitationId } : {}),
      ...(invitationVersion ? { invitationVersion } : {}),
      recipientKey: tokenHash(input.to),
      sealed: {
        version: 1,
        keyId: "test-fixture",
        iv: randomBytes(12).toString("base64url"),
        tag: randomBytes(16).toString("base64url"),
        ciphertext: randomBytes(48).toString("base64url"),
      },
      createdAt,
      expiresAt,
      status: "pending",
      attempts: 0,
      nextAttemptAt: createdAt,
    };
  }
  assertAdmission(_state: DataState, _record: IdentityOutboxRecord) {
    if (this.failAdmission) throw new Error("Test queue full");
  }
  token(kind: IdentityMailInput["kind"], email: string) {
    const message = [...this.messages]
      .reverse()
      .find((m) => m.kind === kind && m.to === email);
    const value = message?.text.match(
      /token=([0-9a-f-]+\.[A-Za-z0-9_-]{43})/,
    )?.[1];
    if (!value) throw new Error(`Test mailbox has no ${kind} token`);
    return value;
  }
}
const mailboxes = new WeakMap<FastifyInstance, FixtureIdentityMail>();
export function attachIdentityTestMail(
  app: FastifyInstance,
  mail: FixtureIdentityMail,
) {
  mailboxes.set(app, mail);
}
export function identityTestMail(app: FastifyInstance) {
  const mail = mailboxes.get(app);
  if (!mail) throw new Error("Missing test mailbox");
  return mail;
}
export async function verifyIdentityTestAccount(
  app: FastifyInstance,
  headers: Record<string, string>,
  email: string,
) {
  const security = await app.inject({ url: "/api/v1/auth/security", headers });
  if (security.json().emailVerified) return;
  const request = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email-verification/request",
    headers,
    payload: {},
  });
  if (request.statusCode !== 202)
    throw new Error(`Verification request failed: ${request.body}`);
  const verified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email-verification/confirm",
    headers,
    payload: { token: identityTestMail(app).token("verify-email", email) },
  });
  if (verified.statusCode !== 200)
    throw new Error(`Verification confirmation failed: ${verified.body}`);
}
export async function acceptIdentityTestInvitation(
  app: FastifyInstance,
  owner: { headers: Record<string, string>; email: string },
  recipient: { headers: Record<string, string>; email: string },
  role: string,
  projectId?: string,
) {
  await verifyIdentityTestAccount(app, owner.headers, owner.email);
  await verifyIdentityTestAccount(app, recipient.headers, recipient.email);
  const prefix = projectId
    ? `/api/v1/projects/${projectId}/invitations`
    : "/api/v1/organization/invitations";
  const current = await app.inject({ url: prefix, headers: owner.headers });
  const created = await app.inject({
    method: "POST",
    url: prefix,
    headers: owner.headers,
    payload: {
      email: recipient.email,
      role,
      idempotencyKey: randomBytes(16).toString("hex"),
      ...(projectId ? { expectedAclVersion: current.json().aclVersion } : {}),
    },
  });
  if (created.statusCode !== 201)
    throw new Error(`Invitation failed: ${created.body}`);
  const token = identityTestMail(app).token("invitation", recipient.email);
  const preview = await app.inject({
    method: "POST",
    url: "/api/v1/invitations/preview",
    headers: recipient.headers,
    payload: { token },
  });
  if (preview.statusCode !== 200)
    throw new Error(`Invitation preview failed: ${preview.body}`);
  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/invitations/accept",
    headers: recipient.headers,
    payload: {
      token,
      expectedVersion: preview.json().invitation.version,
      ...(projectId ? { expectedAclVersion: preview.json().aclVersion } : {}),
    },
  });
  if (accepted.statusCode !== 200)
    throw new Error(`Invitation acceptance failed: ${accepted.body}`);
  return accepted.json();
}
