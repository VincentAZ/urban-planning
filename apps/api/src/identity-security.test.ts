import { reviewBudgetForFixture } from "./budget-test-fixture.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { createIdentityMailRuntime } from "./identity-mail";
import { createPostgresSecurityFixture } from "./postgres-security-fixture";
import { PostgresStore } from "./postgres-store";
import { emptyState, type Store } from "./store";
import { reconcileStoredIdentityMailInvoice } from "./identity-mail-reconciliation";
import { encodeRecord } from "./storage-core";
import { hashPassword, tokenHash } from "./security";
import type { IdentityChallengeRecord } from "./identity-types";
const connection = process.env.TEST_DATABASE_URL;
const future = () => new Date(Date.now() + 3600000).toISOString();
describe.skipIf(!connection)("verified identity database boundary", () => {
  let fixture: Awaited<ReturnType<typeof createPostgresSecurityFixture>>,
    store: PostgresStore,
    web: pg.Pool,
    auth: pg.Pool,
    worker: pg.Pool;
  beforeAll(async () => {
    const state = emptyState();
    state.users = [
      {
        id: "alice",
        email: "alice@example.test",
        name: "Alice",
        passwordHash: await hashPassword("old password fixture"),
        createdAt: new Date().toISOString(),
      },
      {
        id: "bob",
        email: "bob@example.test",
        name: "Bob",
        passwordHash: await hashPassword("other password fixture"),
        createdAt: new Date().toISOString(),
        emailVerifiedAt: new Date().toISOString(),
      },
    ];
    state.organizations = [
      { id: "org-a", name: "A", createdAt: new Date().toISOString() },
      { id: "org-b", name: "B", createdAt: new Date().toISOString() },
    ];
    state.memberships = [
      { userId: "alice", organizationId: "org-a", role: "owner" },
      { userId: "bob", organizationId: "org-b", role: "owner" },
    ];
    state.sessions = [
      {
        hash: "alice-session",
        csrfToken: "csrf-a",
        userId: "alice",
        organizationId: "org-a",
        expiresAt: future(),
      },
      {
        hash: "alice-other",
        csrfToken: "csrf-a2",
        userId: "alice",
        organizationId: "org-a",
        expiresAt: future(),
      },
      {
        hash: "bob-session",
        csrfToken: "csrf-b",
        userId: "bob",
        organizationId: "org-b",
        expiresAt: future(),
      },
    ];
    fixture = await createPostgresSecurityFixture(connection!, { state });
    store = new PostgresStore(fixture.webURL, {
      authConnectionString: fixture.authURL,
      workerConnectionString: fixture.workerURL,
    });
    await store.initialize();
    web = new pg.Pool({ connectionString: fixture.webURL });
    auth = new pg.Pool({ connectionString: fixture.authURL });
    worker = new pg.Pool({ connectionString: fixture.workerURL });
  }, 30000);
  afterAll(async () => {
    await Promise.all([store?.close(), web?.end(), auth?.end(), worker?.end()]);
    await fixture?.close();
  });
  async function raw(
    pool: pg.Pool,
    settings: Record<string, string>,
    fn: (c: pg.PoolClient) => Promise<unknown>,
  ) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const [key, value] of Object.entries(settings))
        await c.query("SELECT set_config($1,$2,true)", [key, value]);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  it("keeps legacy verification and generation absent and denies raw web verification", async () => {
    const users = await fixture.operatorStore.read((s) => s.users);
    expect(users.find((u) => u.id === "alice")).not.toHaveProperty(
      "emailVerifiedAt",
    );
    expect(users.find((u) => u.id === "alice")).not.toHaveProperty(
      "credentialVersion",
    );
    const denied = (await raw(
      web,
      { "urban.session_hash": "alice-session" },
      (c) =>
        c.query(
          "UPDATE app_users SET header=header||'{\"emailVerifiedAt\":\"2026-01-01T00:00:00Z\"}'::jsonb WHERE id='alice'",
        ),
    )) as pg.QueryResult;
    expect(denied.rowCount).toBe(0);
  });
  it("refuses new raw membership grants without acceptance and protects the last workspace owner", async () => {
    await expect(
      raw(web, { "urban.session_hash": "alice-session" }, (c) =>
        c.query(
          'INSERT INTO app_memberships(id,user_id,organization_id,header) VALUES(\'["bob","org-a"]\',\'bob\',\'org-a\',\'{"userId":"bob","organizationId":"org-a","role":"viewer"}\')',
        ),
      ),
    ).rejects.toThrow(/invitation/i);
    await expect(
      raw(web, { "urban.session_hash": "alice-session" }, (c) =>
        c.query(
          "DELETE FROM app_memberships WHERE user_id='alice' AND organization_id='org-a'",
        ),
      ),
    ).rejects.toThrow(/Last workspace owner/);
  });
  it("does not expose encrypted mail or general project data to the mail purpose", async () => {
    await expect(
      raw(worker, { "urban.purpose": "worker.identity-mail" }, (c) =>
        c.query("SELECT payload FROM app_identity_outbox"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      raw(worker, { "urban.purpose": "worker.identity-mail" }, (c) =>
        c.query("SELECT payload FROM app_projects"),
      ),
    ).rejects.toThrow(/permission denied/);
    const r = (await raw(
      worker,
      { "urban.purpose": "worker.identity-mail" },
      (c) => c.query("SELECT header FROM app_users"),
    )) as pg.QueryResult;
    expect(r.rows).toEqual([]);
  });
  it("consumes a reset exactly once with atomic generation update and all-session revocation", async () => {
    const ch: IdentityChallengeRecord = {
      id: "reset-a",
      userId: "alice",
      email: "alice@example.test",
      purpose: "password-reset",
      credentialVersion: 0,
      tokenHash: tokenHash("reset proof"),
      createdAt: new Date().toISOString(),
      expiresAt: future(),
    };
    await store.transaction(
      (s) => {
        s.identityChallenges.push(ch);
      },
      {
        security: {
          mode: "auth",
          purpose: "challenge-issue",
          email: ch.email,
          userId: ch.userId,
          credentialVersion: 0,
          challengeId: ch.id,
        },
        identityChallenges: { append: true },
      },
    );
    const settings = {
      "urban.purpose": "auth.challenge-consume",
      "urban.auth_user_id": "alice",
      "urban.auth_email": ch.email,
      "urban.auth_credential_version": "0",
      "urban.identity_challenge_id": ch.id,
      "urban.identity_token_hash": ch.tokenHash,
    };
    const next = await hashPassword("replacement test password");
    await expect(
      raw(auth, settings, async (c) => {
        await c.query(
          "UPDATE app_identity_challenges SET header=header||jsonb_build_object('consumedAt',$1::text) WHERE id=$2",
          [new Date().toISOString(), ch.id],
        );
        await c.query(
          "UPDATE app_users SET header=header||jsonb_build_object('passwordHash',$1::text,'credentialVersion',1,'emailVerifiedAt',$2::text) WHERE id='alice'",
          [next, new Date().toISOString()],
        );
      }),
    ).rejects.toThrow(/every session/);
    await raw(auth, settings, async (c) => {
      const at = new Date().toISOString();
      await c.query(
        "UPDATE app_identity_challenges SET header=header||jsonb_build_object('consumedAt',$1::text) WHERE id=$2",
        [at, ch.id],
      );
      await c.query(
        "UPDATE app_users SET header=header||jsonb_build_object('passwordHash',$1::text,'credentialVersion',1,'emailVerifiedAt',$2::text) WHERE id='alice'",
        [next, at],
      );
      await c.query("DELETE FROM app_sessions WHERE user_id='alice'");
    });
    const result = await fixture.operatorStore.read((s) => ({
      user: s.users.find((u) => u.id === "alice"),
      sessions: s.sessions.filter((s) => s.userId === "alice"),
      challenge: s.identityChallenges.find((c) => c.id === ch.id),
    }));
    expect(result.user?.credentialVersion).toBe(1);
    expect(result.sessions).toEqual([]);
    expect(result.challenge?.consumedAt).toBeTruthy();
    const replay = (await raw(
      auth,
      { ...settings, "urban.purpose": "auth.challenge-lookup" },
      (c) =>
        c.query(
          "SELECT header FROM app_identity_challenges WHERE id='reset-a'",
        ),
    )) as pg.QueryResult;
    expect(replay.rows).toEqual([]);
    const row = encodeRecord("sessions", {
      hash: "stale-session",
      csrfToken: "csrf",
      userId: "alice",
      organizationId: "org-a",
      expiresAt: future(),
    }).row;
    await expect(
      raw(
        auth,
        {
          "urban.purpose": "auth.login",
          "urban.auth_email": ch.email,
          "urban.auth_user_id": "alice",
          "urban.auth_session_hash": "stale-session",
          "urban.auth_credential_version": "0",
        },
        (c) =>
          c.query(
            "INSERT INTO app_sessions(id,user_id,organization_id,header) VALUES($1,$2,$3,$4::jsonb)",
            [
              row.id,
              row.indexes.userId,
              row.indexes.organizationId,
              JSON.stringify(row.header),
            ],
          ),
      ),
    ).rejects.toThrow();
  });
  it("delivers an exact leased encrypted challenge with a retained SMTP cost hold", async () => {
    const id = randomUUID(),
      org = randomUUID(),
      challengeId = randomUUID();
    await fixture.operatorStore.transaction((s) => {
      s.users.push({
        id,
        email: "mail@example.test",
        name: "Mail",
        createdAt: new Date().toISOString(),
      });
      s.organizations.push({
        id: org,
        name: "Mail",
        createdAt: new Date().toISOString(),
      });
      s.memberships.push({ userId: id, organizationId: org, role: "owner" });
      s.budget.policy.paidOperationsPaused = false;
      reviewBudgetForFixture(s.budget);
    });
    const sent: string[] = [];
    const mail = createIdentityMailRuntime({
      store,
      config: {
        mode: "smtp",
        keyId: "fixture",
        keys: { fixture: randomBytes(32) },
        recipientHashKey: randomBytes(32),
        maximumAttemptCents: 2,
      },
      transport: {
        send: async (content) => {
          sent.push(content.text);
        },
      },
    });
    try {
      const ch: IdentityChallengeRecord = {
        id: challengeId,
        userId: id,
        email: "mail@example.test",
        purpose: "password-reset",
        credentialVersion: 0,
        tokenHash: tokenHash("private-mail-token"),
        createdAt: new Date().toISOString(),
        expiresAt: future(),
      };
      const record = await mail.prepare({
        id: randomUUID(),
        kind: "password-reset",
        to: ch.email,
        userId: id,
        challengeId,
        subject: "Test recovery",
        text: "private fixture token",
        expiresAt: ch.expiresAt,
      });
      await store.transaction(
        (s) => {
          s.identityChallenges.push(ch);
          s.identityOutbox.push(record);
        },
        {
          security: {
            mode: "auth",
            purpose: "challenge-issue",
            email: ch.email,
            userId: id,
            credentialVersion: 0,
            challengeId,
          },
          identityChallenges: { append: true },
          identityOutbox: { append: true },
        },
      );
      expect(await mail.runOnce()).toBe(true);
      expect(sent).toEqual(["private fixture token"]);
      const result = await fixture.operatorStore.read((s) => ({
        message: s.identityOutbox.find((m) => m.id === record.id),
        budget: s.budget,
      }));
      expect(result.message).toMatchObject({ status: "sent", attempts: 1 });
      expect(result.budget.reservations).toContainEqual(
        expect.objectContaining({
          provider: "configured-smtp",
          operation: "identity-email",
          status: "running",
          maximumCents: 2,
        }),
      );
      expect(
        result.budget.reservations.every((r) => r.actualCents === undefined),
      ).toBe(true);
      await expect(
        store.read((s) => s.identityOutbox, {
          security: {
            mode: "worker",
            purpose: "identity-mail",
            outboxId: record.id,
            leaseToken: result.message!.leaseToken,
          },
          identityOutbox: { where: [{ id: record.id }] },
        }),
      ).rejects.toThrow(/lease/i);
    } finally {
      await mail.close();
    }
  });

  it("keeps pending invitations powerless and consumes the exact recipient grant atomically", async () => {
    await fixture.operatorStore.transaction((s) => {
      s.sessions.push({
        hash: "alice-current",
        csrfToken: "csrf",
        userId: "alice",
        organizationId: "org-a",
        expiresAt: future(),
        credentialVersion: 1,
      });
    });
    const inv = {
      id: "invite-a",
      organizationId: "org-b",
      scope: "workspace" as const,
      email: "alice@example.test",
      role: "viewer" as const,
      createdBy: "bob",
      createdAt: new Date().toISOString(),
      expiresAt: future(),
      version: 1,
      tokenHash: tokenHash("invitation secret"),
      idempotencyKey: "invite-request-1",
      submissionHash: tokenHash("request"),
      status: "pending" as const,
    };
    await store.transaction(
      (s) => {
        s.identityInvitations.push(inv);
      },
      {
        auth: { sessionHash: "bob-session" },
        security: {
          mode: "auth",
          purpose: "invitation-manage",
          email: "bob@example.test",
          userId: "bob",
        },
        identityInvitations: { append: true },
      },
    );
    expect(
      (await fixture.operatorStore.read((s) => s.memberships)).some(
        (m) => m.userId === "alice" && m.organizationId === "org-b",
      ),
    ).toBe(false);
    const settings = {
      "urban.session_hash": "alice-current",
      "urban.purpose": "auth.invitation-accept",
      "urban.auth_user_id": "alice",
      "urban.auth_email": "alice@example.test",
      "urban.identity_invitation_id": inv.id,
      "urban.identity_invitation_version": "1",
      "urban.identity_token_hash": inv.tokenHash,
    };
    await expect(
      raw(auth, settings, (c) =>
        c.query(
          'INSERT INTO app_memberships(id,user_id,organization_id,header) VALUES(\'["alice","org-b"]\',\'alice\',\'org-b\',\'{"userId":"alice","organizationId":"org-b","role":"viewer"}\')',
        ),
      ),
    ).rejects.toThrow(/consume.*invitation/i);
    await store.transaction(
      (s) => {
        const i = s.identityInvitations[0];
        i.status = "accepted";
        i.version++;
        i.acceptedBy = "alice";
        i.acceptedAt = new Date().toISOString();
        s.memberships.push({
          userId: "alice",
          organizationId: "org-b",
          role: "viewer",
        });
      },
      {
        auth: { sessionHash: "alice-current" },
        security: {
          mode: "auth",
          purpose: "invitation-accept",
          email: inv.email,
          userId: "alice",
          invitationId: inv.id,
          invitationVersion: 1,
          tokenHash: inv.tokenHash,
        },
        identityInvitations: { where: [{ id: inv.id }] },
        memberships: { where: [{ organizationId: "org-b" }] },
      },
    );
    expect(
      (await fixture.operatorStore.read((s) => s.identityInvitations[0]))
        .status,
    ).toBe("accepted");
  });
  it("keeps recovery lookup exact and isolates credential and budget purposes", async () => {
    const lookup = (await raw(
      auth,
      {
        "urban.purpose": "auth.challenge-lookup",
        "urban.identity_challenge_id": "reset-a",
        "urban.identity_token_hash": tokenHash("wrong token"),
      },
      (c) => c.query("SELECT header FROM app_identity_challenges"),
    )) as pg.QueryResult;
    expect(lookup.rows).toEqual([]);
    const workerRows = (await raw(
      worker,
      {
        "urban.purpose": "auth.lookup",
        "urban.auth_email": "bob@example.test",
      },
      (c) => c.query("SELECT header FROM app_users"),
    )) as pg.QueryResult;
    expect(workerRows.rows).toEqual([]);
    await expect(
      raw(worker, { "urban.purpose": "worker.identity-mail" }, (c) =>
        c.query(
          "UPDATE app_budget SET header=jsonb_set(header,'{policy,monthlyLimitCents}','999999')",
        ),
      ),
    ).rejects.toThrow(/policy|history/);
  });
  it("cancels an expired final mail lease without freeing its uncertain running cost", async () => {
    const id = randomUUID(),
      costId = randomUUID(),
      at = new Date().toISOString();
    const config = {
      mode: "smtp" as const,
      keyId: "fixture",
      keys: { fixture: randomBytes(32) },
      recipientHashKey: randomBytes(32),
      maximumAttemptCents: 2,
    };
    let sends = 0;
    const runtime = createIdentityMailRuntime({
      store,
      config,
      transport: {
        send: async () => {
          sends++;
        },
      },
    });
    try {
      const record = await runtime.prepare({
        id,
        kind: "password-changed",
        to: "test@example.test",
        subject: "Fixture",
        text: "private",
        expiresAt: future(),
      });
      await fixture.operatorStore.transaction((s) => {
        s.budget.policy.paidOperationsPaused = false;
        reviewBudgetForFixture(s.budget);
        s.identityOutbox.push({
          ...record,
          status: "sending",
          attempts: 3,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
          costReservationId: costId,
        });
        s.budget.reservations.push({
          id: costId,
          idempotencyKey: `identity-mail:${id}:3`,
          provider: "configured-smtp",
          operation: "identity-email",
          actorId: "identity-mail-worker",
          period: at.slice(0, 7),
          maximumCents: 2,
          status: "running",
          createdAt: at,
          expiresAt: at,
          startedAt: at,
        });
      });
      expect(await runtime.runOnce()).toBe(false);
      expect(sends).toBe(0);
      const result = await fixture.operatorStore.read((s) => ({
        message: s.identityOutbox.find((m) => m.id === id),
        cost: s.budget.reservations.find((r) => r.id === costId),
      }));
      expect(result.message).toMatchObject({
        status: "cancelled",
        attempts: 3,
      });
      expect(result.cost?.status).toBe("running");
      expect(
        (
          await reconcileStoredIdentityMailInvoice(store, {
            reference: "live-pg-cost",
            totalCents: 5,
            entries: [{ reservationId: costId, actualCents: 5 }],
          })
        ).paidOperationsPaused,
      ).toBe(true);
      expect(
        (
          await reconcileStoredIdentityMailInvoice(store, {
            reference: "live-pg-cost",
            totalCents: 5,
            entries: [{ reservationId: costId, actualCents: 5 }],
          })
        ).replayed,
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  });
  it("releases an undispatched hold if policy pauses between claim and dispatch", async () => {
    const id = randomUUID(),
      userId = randomUUID(),
      challengeId = randomUUID(),
      email = "paused@example.test";
    let calls = 0,
      sends = 0;
    await fixture.operatorStore.transaction((s) => {
      s.users.push({
        id: userId,
        email,
        name: "Pause",
        createdAt: new Date().toISOString(),
      });
      s.budget.policy.paidOperationsPaused = false;
      reviewBudgetForFixture(s.budget);
    });
    const wrapped: Store = {
      kind: "postgres",
      read: (fn, scope) => store.read(fn, scope),
      transaction: async (fn, scope) => {
        const result = await store.transaction(fn, scope);
        if (++calls === 1)
          await fixture.operatorStore.transaction((s) => {
            s.budget.policy.paidOperationsPaused = true;
          });
        return result;
      },
      close: async () => {},
    };
    const runtime = createIdentityMailRuntime({
      store: wrapped,
      config: {
        mode: "smtp",
        keyId: "fixture",
        keys: { fixture: randomBytes(32) },
        recipientHashKey: randomBytes(32),
        maximumAttemptCents: 2,
      },
      transport: {
        send: async () => {
          sends++;
        },
      },
    });
    try {
      const ch: IdentityChallengeRecord = {
        id: challengeId,
        userId,
        email,
        purpose: "password-reset",
        credentialVersion: 0,
        tokenHash: tokenHash("pause-token"),
        createdAt: new Date().toISOString(),
        expiresAt: future(),
      };
      const record = await runtime.prepare({
        id,
        kind: "password-reset",
        to: email,
        userId,
        challengeId,
        subject: "Pause fixture",
        text: "private",
        expiresAt: ch.expiresAt,
      });
      await store.transaction(
        (s) => {
          s.identityChallenges.push(ch);
          s.identityOutbox.push(record);
        },
        {
          security: {
            mode: "auth",
            purpose: "challenge-issue",
            email,
            userId,
            credentialVersion: 0,
            challengeId,
          },
          identityChallenges: { append: true },
          identityOutbox: { append: true },
        },
      );
      expect(await runtime.runOnce()).toBe(true);
      expect(sends).toBe(0);
      const result = await fixture.operatorStore.read((s) => ({
        mail: s.identityOutbox.find((m) => m.id === id),
        holds: s.budget.reservations,
      }));
      expect(result.mail?.status).toBe("pending");
      expect(
        result.holds.find((r) => r.id === result.mail?.costReservationId)
          ?.status,
      ).toBe("released");
    } finally {
      await runtime.close();
    }
  });
  it("withholds invitation metadata from unverified email claimants and rechecks manager verification", async () => {
    await fixture.operatorStore.transaction((s) => {
      s.users.push({
        id: "pending-user",
        email: "pending@example.test",
        name: "Unverified",
        createdAt: new Date().toISOString(),
      });
      s.memberships.push({
        userId: "pending-user",
        organizationId: "org-a",
        role: "viewer",
      });
      s.sessions.push({
        hash: "pending-session",
        csrfToken: "csrf",
        userId: "pending-user",
        organizationId: "org-a",
        expiresAt: future(),
      });
    });
    const inv = {
      id: "pending-private",
      organizationId: "org-b",
      scope: "workspace" as const,
      email: "pending@example.test",
      role: "viewer" as const,
      createdBy: "bob",
      createdAt: new Date().toISOString(),
      expiresAt: future(),
      version: 1,
      tokenHash: tokenHash("private pending invitation"),
      idempotencyKey: "pending-private-key",
      submissionHash: tokenHash("private request"),
      status: "pending" as const,
    };
    await store.transaction(
      (s) => {
        s.identityInvitations.push(inv);
      },
      {
        auth: { sessionHash: "bob-session" },
        security: {
          mode: "auth",
          purpose: "invitation-manage",
          email: "bob@example.test",
          userId: "bob",
        },
        identityInvitations: { append: true },
      },
    );
    const rows = (await raw(
      web,
      { "urban.session_hash": "pending-session" },
      (c) =>
        c.query(
          "SELECT header FROM app_identity_invitations WHERE id='pending-private'",
        ),
    )) as pg.QueryResult;
    expect(rows.rows).toEqual([]);
    await fixture.operatorStore.transaction((s) => {
      delete s.users.find((u) => u.id === "bob")!.emailVerifiedAt;
    });
    await expect(
      raw(
        auth,
        {
          "urban.session_hash": "bob-session",
          "urban.purpose": "auth.invitation-manage",
          "urban.auth_email": "bob@example.test",
          "urban.auth_user_id": "bob",
        },
        (c) =>
          c.query(
            "UPDATE app_identity_invitations SET header=header||'{\"version\":2}'::jsonb WHERE id='pending-private'",
          ),
      ),
    ).rejects.toThrow(/management requires/);
  });
  it("refuses a raw project-only membership promotion without workspace acceptance", async () => {
    await fixture.operatorStore.transaction((s) => {
      s.memberships.push({
        userId: "pending-user",
        organizationId: "org-b",
        role: "viewer",
        scope: "project-only",
      });
    });
    await expect(
      raw(web, { "urban.session_hash": "bob-session" }, (c) =>
        c.query(
          "UPDATE app_memberships SET header=header-'scope' WHERE user_id='pending-user' AND organization_id='org-b'",
        ),
      ),
    ).rejects.toThrow(/Workspace expansion/);
  });
  it("recovers a crash before dispatch by releasing only its old reserved attempt and creating one new hold", async () => {
    const userId = randomUUID(),
      challengeId = randomUUID(),
      id = randomUUID(),
      oldCost = randomUUID(),
      email = "recovery@example.test",
      at = new Date().toISOString();
    let sends = 0;
    const runtime = createIdentityMailRuntime({
      store,
      config: {
        mode: "smtp",
        keyId: "fixture",
        keys: { fixture: randomBytes(32) },
        recipientHashKey: randomBytes(32),
        maximumAttemptCents: 2,
      },
      transport: {
        send: async () => {
          sends++;
        },
      },
    });
    try {
      const record = await runtime.prepare({
        id,
        kind: "password-reset",
        to: email,
        userId,
        challengeId,
        subject: "Crash fixture",
        text: "private",
        expiresAt: future(),
      });
      await fixture.operatorStore.transaction((s) => {
        s.budget.policy.paidOperationsPaused = false;
        reviewBudgetForFixture(s.budget);
        s.users.push({ id: userId, email, name: "Recovery", createdAt: at });
        s.identityChallenges.push({
          id: challengeId,
          userId,
          email,
          purpose: "password-reset",
          credentialVersion: 0,
          tokenHash: tokenHash("crash-test"),
          createdAt: at,
          expiresAt: record.expiresAt,
        });
        s.identityOutbox.push({
          ...record,
          status: "sending",
          attempts: 1,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
          costReservationId: oldCost,
        });
        s.budget.reservations.push({
          id: oldCost,
          idempotencyKey: `identity-mail:${id}:1`,
          provider: "configured-smtp",
          operation: "identity-email",
          actorId: "identity-mail-worker",
          period: at.slice(0, 7),
          maximumCents: 2,
          status: "reserved",
          createdAt: at,
          expiresAt: at,
        });
      });
      expect(await runtime.runOnce()).toBe(true);
      expect(sends).toBe(1);
      const data = await fixture.operatorStore.read((s) => ({
        mail: s.identityOutbox.find((m) => m.id === id),
        costs: s.budget.reservations.filter((r) =>
          r.idempotencyKey.startsWith(`identity-mail:${id}:`),
        ),
      }));
      expect(data.mail).toMatchObject({ status: "sent", attempts: 2 });
      expect(data.costs.map((r) => r.status)).toEqual(["released", "running"]);
    } finally {
      await runtime.close();
    }
  });
  it("cleans expired pending mail with its reserved hold without touching running costs", async () => {
    const id = randomUUID(),
      cost = randomUUID(),
      at = new Date().toISOString();
    const runtime = createIdentityMailRuntime({
      store,
      config: {
        mode: "smtp",
        keyId: "fixture",
        keys: { fixture: randomBytes(32) },
        recipientHashKey: randomBytes(32),
        maximumAttemptCents: 2,
      },
      transport: {
        send: async () => {
          throw new Error("must not send expired fixture");
        },
      },
    });
    try {
      const record = await runtime.prepare({
        id,
        kind: "password-changed",
        to: "expired@example.test",
        subject: "Expired fixture",
        text: "private",
        expiresAt: future(),
      });
      await fixture.operatorStore.transaction((s) => {
        s.identityOutbox.push({
          ...record,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          attempts: 1,
          costReservationId: cost,
        });
        s.budget.reservations.push({
          id: cost,
          idempotencyKey: `identity-mail:${id}:1`,
          provider: "configured-smtp",
          operation: "identity-email",
          actorId: "identity-mail-worker",
          period: at.slice(0, 7),
          maximumCents: 2,
          status: "reserved",
          createdAt: at,
          expiresAt: at,
        });
      });
      expect(await runtime.runOnce()).toBe(false);
      const result = await fixture.operatorStore.read((s) => ({
        mail: s.identityOutbox.find((m) => m.id === id),
        cost: s.budget.reservations.find((r) => r.id === cost),
      }));
      expect(result.mail?.status).toBe("cancelled");
      expect(result.cost?.status).toBe("released");
    } finally {
      await runtime.close();
    }
  });
});
