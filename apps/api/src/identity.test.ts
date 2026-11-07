import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { FileStore } from "./store.js";
import { ApiError } from "./errors.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trafficPlaceFixture } from "../../../tests/fixtures/traffic.js";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  verifyIdentityTestAccount,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const password = "correct horse account password";
async function setup(store = new FileStore()) {
  const mail = new FixtureIdentityMail();
  const app = await buildApp({
    store,
    identityMail: mail,
    catalog: {
      list: async () => [trafficPlaceFixture],
      get: async () => structuredClone(trafficPlaceFixture),
    },
  });
  attachIdentityTestMail(app, mail);
  apps.push(app);
  return { app, store, mail };
}
async function account(app: FastifyInstance, name: string) {
  const email = `${name}@example.com`,
    r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name },
    });
  expect(r.statusCode).toBe(201);
  return {
    email,
    id: r.json().user.id,
    organizationId: r.json().organization.id,
    headers: {
      cookie: `urban_session=${r.cookies[0].value}`,
      "x-csrf-token": r.json().csrfToken,
    },
  };
}
async function project(
  app: FastifyInstance,
  user: Awaited<ReturnType<typeof account>>,
) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: user.headers,
    payload: {
      placeId: trafficPlaceFixture.id,
      name: "Private invitation project",
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json().project.id as string;
}
describe("Verified identity and invitation lifecycle", () => {
  it("preserves private work for unverified accounts, verifies only the same authenticated account, and consumes links once", async () => {
    const { app, store, mail } = await setup(),
      owner = await account(app, "owner"),
      other = await account(app, "other");
    await project(app, owner);
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/security",
          headers: owner.headers,
        })
      ).json().emailVerified,
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/email-verification/request",
          headers: owner.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(202);
    const token = mail.token("verify-email", owner.email);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/email-verification/confirm",
          headers: other.headers,
          payload: { token },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/email-verification/confirm",
          headers: { cookie: owner.headers.cookie },
          payload: { token },
        })
      ).statusCode,
    ).toBe(403);
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/email-verification/confirm",
          headers: owner.headers,
          payload: { token },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/session",
          headers: owner.headers,
        })
      ).json().user.emailVerified,
    ).toBe(true);
    const state = await store.read((s) => s);
    expect(JSON.stringify(state)).not.toContain(token);
    expect(state.identityOutbox[0].sealed.ciphertext).toBeTruthy();
  });
  it("returns generic reset requests, revokes every session/challenge atomically, and keeps recovery available if notification admission fails", async () => {
    const { app, store, mail } = await setup(),
      user = await account(app, "recovery");
    const known = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset/request",
      payload: { email: user.email },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset/request",
      payload: { email: "unknown@example.com" },
    });
    expect(known.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    const token = mail.token("password-reset", user.email);
    mail.failAdmission = true;
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset/confirm",
      payload: { token, password: "the replacement password is long" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ ok: true, requireLogin: true });
    expect(
      (
        await app.inject({ url: "/api/v1/auth/session", headers: user.headers })
      ).json().user,
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: user.email, password },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: {
            email: user.email,
            password: "the replacement password is long",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset/confirm",
          payload: { token, password },
        })
      ).statusCode,
    ).toBe(400);
    const state = await store.read((s) => s);
    expect(state.users[0].credentialVersion).toBe(1);
    expect(state.users[0].emailVerifiedAt).toBeTruthy();
    expect(
      state.audit.find((e) => e.action === "identity.password-reset.completed")
        ?.details.notificationQueued,
    ).toBe(false);
  });
  it("requires the old password for changes and invalidates old sessions without upgrading unverified email", async () => {
    const { app, store } = await setup(),
      user = await account(app, "changing");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/password/change",
          headers: user.headers,
          payload: {
            currentPassword: "wrong",
            password: "new password long enough",
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/password/change",
          headers: user.headers,
          payload: {
            currentPassword: password,
            password: "new password long enough",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ url: "/api/v1/auth/session", headers: user.headers })
      ).json().user,
    ).toBeNull();
    expect(
      (await store.read((s) => s.users[0])).emailVerifiedAt,
    ).toBeUndefined();
  });
  it("creates no grant before verified recipient acceptance, rejects address substitution, and preserves project-only isolation and idempotent acceptance", async () => {
    const { app, store, mail } = await setup(),
      owner = await account(app, "inviter"),
      recipient = await account(app, "recipient"),
      outsider = await account(app, "outsider");
    const id = await project(app, owner),
      sibling = await project(app, owner);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${id}/members`,
          headers: owner.headers,
          payload: {
            email: recipient.email,
            role: "editor",
            expectedAclVersion: 1,
          },
        })
      ).json().error.code,
    ).toBe("INVITATION_REQUIRED");
    await verifyIdentityTestAccount(app, owner.headers, owner.email);
    const input = {
      email: recipient.email,
      role: "editor",
      expectedAclVersion: 1,
      idempotencyKey: "invite-recipient-once",
    };
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${id}/invitations`,
      headers: owner.headers,
      payload: input,
    });
    expect(created.statusCode).toBe(201);
    const token = mail.token("invitation", recipient.email);
    expect((await store.read((s) => s.projects[0].acl!.members)).length).toBe(
      1,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/preview",
          headers: recipient.headers,
          payload: { token },
        })
      ).json().error.code,
    ).toBe("EMAIL_VERIFICATION_REQUIRED");
    await verifyIdentityTestAccount(app, recipient.headers, recipient.email);
    await verifyIdentityTestAccount(app, outsider.headers, outsider.email);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/preview",
      headers: outsider.headers,
      payload: { token },
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.body).not.toContain("Private invitation project");
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/preview",
      headers: recipient.headers,
      payload: { token },
    });
    expect(preview.statusCode).toBe(200);
    const accept = { token, expectedVersion: 1, expectedAclVersion: 1 };
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: recipient.headers,
      payload: accept,
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: recipient.headers,
          payload: accept,
        })
      ).json().alreadyAccepted,
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${id}/invitations`,
          headers: owner.headers,
          payload: input,
        })
      ).statusCode,
    ).toBe(201);
    expect(mail.messages.filter((m) => m.kind === "invitation")).toHaveLength(
      1,
    );
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: recipient.headers,
      payload: { organizationId: owner.organizationId },
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${id}`,
          headers: recipient.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${sibling}`,
          headers: recipient.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/organization/members",
          headers: recipient.headers,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("refuses expired, revoked and stale-ACL invitations and rechecks the inviter before acceptance", async () => {
    const { app, store, mail } = await setup(),
      owner = await account(app, "owner-guard"),
      recipient = await account(app, "recipient-guard");
    await verifyIdentityTestAccount(app, owner.headers, owner.email);
    await verifyIdentityTestAccount(app, recipient.headers, recipient.email);
    const id = await project(app, owner);
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${id}/invitations`,
      headers: owner.headers,
      payload: {
        email: recipient.email,
        role: "viewer",
        expectedAclVersion: 1,
        idempotencyKey: "guard-invitation",
      },
    });
    expect(create.statusCode).toBe(201);
    const token = mail.token("invitation", recipient.email),
      inviteId = create.json().invitations[0].id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: recipient.headers,
          payload: { token, expectedVersion: 1, expectedAclVersion: 0 },
        })
      ).statusCode,
    ).toBe(409);
    await store.transaction((s) => {
      s.users.find((u) => u.id === owner.id)!.emailVerifiedAt = undefined;
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/preview",
          headers: recipient.headers,
          payload: { token },
        })
      ).statusCode,
    ).toBe(404);
    await store.transaction((s) => {
      s.users.find((u) => u.id === owner.id)!.emailVerifiedAt =
        new Date().toISOString();
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${id}/invitations/${inviteId}/revoke`,
          headers: owner.headers,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: recipient.headers,
          payload: { token, expectedVersion: 1, expectedAclVersion: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("rotates expired invitation links, binds optimistic versions, and never resurrects a removed grant", async () => {
    const { app, store, mail } = await setup(),
      owner = await account(app, "rotation-owner"),
      recipient = await account(app, "rotation-recipient");
    await verifyIdentityTestAccount(app, owner.headers, owner.email);
    await verifyIdentityTestAccount(app, recipient.headers, recipient.email);
    const id = await project(app, owner),
      path = `/api/v1/projects/${id}/invitations`;
    const created = await app.inject({
      method: "POST",
      url: path,
      headers: owner.headers,
      payload: {
        email: recipient.email,
        role: "viewer",
        idempotencyKey: "rotation-test-invite",
        expectedAclVersion: 1,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const oldToken = mail.token("invitation", recipient.email),
      inviteId = created.json().invitations[0].id;
    await store.transaction((s) => {
      s.identityInvitations[0].expiresAt = "2001-01-01T00:00:00Z";
      for (const m of s.identityOutbox)
        if (m.invitationId === inviteId) m.createdAt = "2001-01-01T00:00:00Z";
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/preview",
          headers: recipient.headers,
          payload: { token: oldToken },
        })
      ).statusCode,
    ).toBe(404);
    const resend = await app.inject({
      method: "POST",
      url: `${path}/${inviteId}/resend`,
      headers: owner.headers,
      payload: { expectedVersion: 1 },
    });
    expect(resend.statusCode, resend.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/${inviteId}/revoke`,
          headers: owner.headers,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
    const token = mail.token("invitation", recipient.email);
    expect(token).not.toBe(oldToken);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: recipient.headers,
          payload: {
            token: oldToken,
            expectedVersion: 1,
            expectedAclVersion: 1,
          },
        })
      ).statusCode,
    ).toBe(404);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: recipient.headers,
      payload: { token, expectedVersion: 2, expectedAclVersion: 1 },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/projects/${id}/members/${recipient.id}`,
          headers: owner.headers,
          payload: { expectedAclVersion: 2 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: recipient.headers,
          payload: { token, expectedVersion: 2, expectedAclVersion: 1 },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await store.read((s) => s.projects[0].acl!.members)).map(
        (m) => m.userId,
      ),
    ).toEqual([owner.id]);
  });
  it("requires explicit workspace acceptance without changing existing project grants", async () => {
    const { app, store } = await setup(),
      owner = await account(app, "workspace-owner"),
      recipient = await account(app, "workspace-recipient");
    const id = await project(app, owner);
    await acceptIdentityTestInvitation(app, owner, recipient, "viewer", id);
    const acl = await store.read((s) => s.projects[0].acl);
    await acceptIdentityTestInvitation(app, owner, recipient, "editor");
    const state = await store.read((s) => s);
    expect(
      state.memberships.find(
        (m) =>
          m.userId === recipient.id &&
          m.organizationId === owner.organizationId,
      ),
    ).toMatchObject({ role: "editor", scope: "workspace" });
    expect(state.projects[0].acl).toEqual(acl);
    expect(state.identityInvitations.map((i) => i.status)).toEqual([
      "accepted",
      "accepted",
    ]);
  });
  it("does not disclose recipient-specific queue refusal and keeps disabled delivery honest", async () => {
    const { app, store, mail } = await setup(),
      user = await account(app, "quota");
    mail.assertAdmission = () => {
      throw new ApiError(
        429,
        "IDENTITY_RECIPIENT_LIMIT",
        "Recipient quota exhausted",
      );
    };
    const known = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/request",
        payload: { email: user.email },
      }),
      unknown = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/request",
        payload: { email: "nobody@example.com" },
      });
    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(
      await store.read(
        (s) => s.identityChallenges.length + s.identityOutbox.length,
      ),
    ).toBe(0);
    mail.unavailable = true;
    for (const email of [user.email, "nobody@example.com"])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/auth/password-reset/request",
            payload: { email },
          })
        ).statusCode,
      ).toBe(503);
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/security",
          headers: user.headers,
        })
      ).json().delivery.available,
    ).toBe(false);
    await project(app, user);
  });
  it("keeps unexpected recovery failures generic and logs no prepared link or password diagnostic", async () => {
    const { app, mail } = await setup();
    const logged: unknown[] = [];
    app.addHook("onRequest", async (request) => {
      request.log.error = ((...values: unknown[]) => {
        logged.push(values);
      }) as typeof request.log.error;
    });
    const user = await account(app, "opaque-failure");
    mail.prepare = async (input) => {
      throw new Error(`private-mail-diagnostic ${input.to} ${input.text}`);
    };
    const known = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset/request",
      payload: { email: user.email },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset/request",
      payload: { email: "unknown@example.com" },
    });
    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    const verification = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-verification/request",
      headers: user.headers,
      payload: {},
    });
    expect(verification.statusCode).toBe(500);
    const diagnostics = JSON.stringify(logged);
    expect(diagnostics).toContain("IDENTITY_RECOVERY_REQUEST_UNCONFIRMED");
    expect(diagnostics).toContain("IDENTITY_OPERATION_FAILED");
    for (const value of [
      "private-mail-diagnostic",
      user.email,
      "token=",
      password,
    ]) {
      expect(diagnostics).not.toContain(value);
      expect(known.body + verification.body).not.toContain(value);
    }
  });
  it("preserves one-use recovery across a SQLite restart without persisting plaintext links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-identity-restart-"));
    try {
      const path = join(directory, "state.sqlite"),
        initial = await setup(new FileStore(path)),
        user = await account(initial.app, "durable");
      expect(
        (
          await initial.app.inject({
            method: "POST",
            url: "/api/v1/auth/password-reset/request",
            payload: { email: user.email },
          })
        ).statusCode,
      ).toBe(202);
      const token = initial.mail.token("password-reset", user.email);
      await initial.app.close();
      apps.splice(apps.indexOf(initial.app), 1);
      const reopened = await setup(new FileStore(path));
      expect(JSON.stringify(await reopened.store.read((s) => s))).not.toContain(
        token,
      );
      const result = await reopened.app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/confirm",
        payload: { token, password: "durable replacement password" },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(
        (
          await reopened.app.inject({
            method: "POST",
            url: "/api/v1/auth/password-reset/confirm",
            payload: { token, password },
          })
        ).statusCode,
      ).toBe(400);
      await reopened.app.close();
      apps.splice(apps.indexOf(reopened.app), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects a login whose old password was verified before a concurrent recovery commits", async () => {
    const store = new FileStore(),
      { app, mail } = await setup(store),
      user = await account(app, "race");
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset/request",
      payload: { email: user.email },
    });
    const original = store.transaction.bind(store);
    let reached!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => {
        reached = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    store.transaction = async (operation, scope) => {
      if (
        scope?.security?.mode === "auth" &&
        scope.security.purpose === "login"
      ) {
        reached();
        await gate;
      }
      return original(operation, scope);
    };
    const login = app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password },
    });
    await waiting;
    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset/confirm",
      payload: {
        token: mail.token("password-reset", user.email),
        password: "recovered password protects account",
      },
    });
    expect(reset.statusCode).toBe(200);
    release();
    expect((await login).statusCode).toBe(401);
    expect(await store.read((s) => s.sessions.length)).toBe(0);
  });
});
