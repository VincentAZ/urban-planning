import { reviewBudgetForFixture } from "./budget-test-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./store.js";
import { BudgetService, budgetDashboard } from "./budget.js";
import {
  createIdentityMailRuntime,
  identityMailFromEnvironment,
  openIdentityMail,
  PermanentIdentityMailError,
  type IdentityMailConfig,
  type IdentityMailContent,
  type IdentityMailTransport,
  type ManagedIdentityMail,
} from "./identity-mail.js";
import type { IdentityMailInput } from "./identity-types.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
async function fixture(
  overrides: Partial<IdentityMailConfig> = {},
  transport?: IdentityMailTransport,
) {
  const directory = await mkdtemp(join(tmpdir(), "urban-identity-mail-")),
    store = new FileStore(join(directory, "state.json"));
  cleanup.push(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  let now = new Date(),
    messages: IdentityMailContent[] = [];
  const config: IdentityMailConfig = {
    mode: "smtp",
    keyId: "test",
    keys: { test: randomBytes(32) },
    recipientHashKey: randomBytes(32),
    maximumAttemptCents: 3,
    recipientCooldownSeconds: 0,
    ...overrides,
  };
  const runtime = createIdentityMailRuntime({
    store,
    config,
    clock: () => now,
    transport: transport ?? {
      send: async (mail) => {
        messages.push(mail);
      },
    },
  });
  cleanup.push(() => runtime.close());
  const userId = randomUUID(),
    challengeId = randomUUID(),
    email = "owner@example.test";
  await store.transaction((state) => {
    state.budget.policy.paidOperationsPaused = false;
    reviewBudgetForFixture(state.budget, now);
    state.users.push({
      id: userId,
      email,
      name: "Test",
      createdAt: now.toISOString(),
    });
    state.identityChallenges.push({
      id: challengeId,
      userId,
      email,
      purpose: "password-reset",
      credentialVersion: 0,
      tokenHash: "hash-only",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    });
  });
  async function enqueue(
    patch: Partial<IdentityMailInput> = {},
    worker: ManagedIdentityMail = runtime,
  ) {
    const record = await worker.prepare({
      id: randomUUID(),
      kind: "password-reset",
      to: email,
      userId,
      challengeId,
      subject: "Reset your password",
      text: "Secret test link: #identity=password-reset&token=never-log-this-test-token",
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      ...patch,
    });
    // Trusted fixture seeding; dispatch below uses the actual restricted worker scopes.
    // The endpoint suite independently exercises challenge-issue authorization and queue admission.
    await store.transaction((state) => {
      worker.assertAdmission(state, record);
      state.identityOutbox.push(record);
    });
    return record;
  }
  const state = () => store.read((s) => structuredClone(s));
  return {
    store,
    runtime,
    config,
    enqueue,
    state,
    messages,
    userId,
    challengeId,
    email,
    clock: () => now,
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
      vi.setSystemTime(now);
    },
  };
}

describe("durable private identity mail", () => {
  it("is disabled unless explicitly configured and rejects incomplete enabled configuration", async () => {
    const f = await fixture();
    expect(
      identityMailFromEnvironment(f.store, {}).capability().available,
    ).toBe(false);
    expect(() =>
      identityMailFromEnvironment(f.store, { IDENTITY_EMAIL_ENABLED: "true" }),
    ).toThrow();
  });
  it("encrypts bodies, authenticates routing metadata, and supports key rotation", async () => {
    const f = await fixture(),
      record = await f.enqueue();
    expect(JSON.stringify(record)).not.toContain(f.email);
    expect(JSON.stringify(record)).not.toContain("never-log-this-test-token");
    expect(openIdentityMail(record, f.config).to).toBe(f.email);
    for (const patch of [
      { id: randomUUID() },
      { recipientKey: "different" },
      { expiresAt: "2099-01-01T00:00:00Z" },
      { challengeId: randomUUID() },
    ])
      expect(() =>
        openIdentityMail({ ...record, ...patch }, f.config),
      ).toThrow();
    expect(() =>
      openIdentityMail(
        {
          ...record,
          sealed: { ...record.sealed, tag: randomBytes(16).toString("base64") },
        },
        f.config,
      ),
    ).toThrow();
    expect(
      openIdentityMail(record, {
        ...f.config,
        keyId: "new",
        keys: { ...f.config.keys, new: randomBytes(32) },
      }).to,
    ).toBe(f.email);
    expect(() =>
      openIdentityMail(record, { ...f.config, keys: { new: randomBytes(32) } }),
    ).toThrow();
  });
  it("delivers through the real scoped SQLite claim path, retaining cost until invoice settlement", async () => {
    const f = await fixture(),
      record = await f.enqueue();
    expect(await f.runtime.runOnce()).toBe(true);
    const state = await f.state(),
      mail = state.identityOutbox[0],
      cost = state.budget.reservations[0];
    expect(mail.status).toBe("sent");
    expect(f.messages).toHaveLength(1);
    expect(cost).toMatchObject({
      status: "running",
      maximumCents: 3,
      idempotencyKey: `identity-mail:${record.id}:1`,
    });
    expect(cost.actualCents).toBeUndefined();
    expect(budgetDashboard(state.budget, f.clock()).totals.reservedCents).toBe(
      3,
    );
    await new BudgetService(f.store, f.clock).settle(cost.id, 1);
    const settled = await f.state();
    expect(settled.budget.reservations[0]).toMatchObject({
      status: "settled",
      actualCents: 1,
    });
    expect(await f.runtime.runOnce()).toBe(false);
  });
  it("does not enqueue when paused, over budget, or above recipient/queue limits", async () => {
    const f = await fixture({ recipientDailyLimit: 1 });
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    await expect(f.enqueue()).rejects.toMatchObject({
      code: "IDENTITY_DELIVERY_PAUSED",
    });
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
      s.budget.policy.monthlyLimitCents = 1;
      s.budget.policy.safetyMarginCents = 0;
    });
    await expect(f.enqueue()).rejects.toMatchObject({
      code: "IDENTITY_DELIVERY_BUDGET",
    });
    await f.store.transaction((s) => {
      s.budget.policy.monthlyLimitCents = 30000;
    });
    await f.enqueue();
    await expect(f.enqueue()).rejects.toMatchObject({
      code: "IDENTITY_DELIVERY_LIMIT",
    });
    expect((await f.state()).identityOutbox).toHaveLength(1);
  });
  it("rechecks the admin pause after enqueue without sending or reserving", async () => {
    const f = await fixture();
    await f.enqueue();
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    expect(await f.runtime.runOnce()).toBe(false);
    expect(f.messages).toHaveLength(0);
    expect((await f.state()).budget.reservations).toHaveLength(0);
  });
  it.each(["generation", "revoked", "consumed", "recipient"])(
    "cancels a stale %s challenge before dispatch and releases only its undispatched hold",
    async (kind) => {
      const f = await fixture();
      await f.enqueue();
      await f.store.transaction((s) => {
        if (kind === "generation") s.users[0].credentialVersion = 1;
        if (kind === "recipient") s.users[0].email = "changed@example.test";
        if (kind === "revoked")
          s.identityChallenges[0].revokedAt = f.clock().toISOString();
        if (kind === "consumed")
          s.identityChallenges[0].consumedAt = f.clock().toISOString();
      });
      await f.runtime.runOnce();
      const state = await f.state();
      expect(state.identityOutbox[0].status).toBe("cancelled");
      expect(f.messages).toHaveLength(0);
      expect(state.budget.reservations[0].status).toBe("released");
    },
  );
  it("fails closed on unreadable ciphertext", async () => {
    const f = await fixture();
    await f.enqueue();
    await f.store.transaction((s) => {
      s.identityOutbox[0].sealed.tag = randomBytes(16).toString("base64");
    });
    await f.runtime.runOnce();
    expect(f.messages).toHaveLength(0);
    expect((await f.state()).identityOutbox[0]).toMatchObject({
      status: "failed",
      lastFailure: "permanent",
    });
  });
  it("bounds retry attempts and retains a separate cost hold for every uncertain dispatch", async () => {
    const f = await fixture(
      {},
      {
        send: async () => {
          throw new Error(
            "Provider error with secret details must not persist",
          );
        },
      },
    );
    await f.enqueue();
    for (let n = 0; n < 4; n++) {
      await f.runtime.runOnce();
      f.advance(180000);
    }
    const state = await f.state();
    expect(state.identityOutbox[0]).toMatchObject({
      status: "failed",
      attempts: 3,
      lastFailure: "temporary",
    });
    expect(state.budget.reservations.map((r) => r.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
    expect(JSON.stringify(state)).not.toContain("secret details");
  });
  it("does not retry permanent rejection", async () => {
    const f = await fixture(
      {},
      {
        send: async () => {
          throw new PermanentIdentityMailError();
        },
      },
    );
    await f.enqueue();
    await f.runtime.runOnce();
    f.advance(180000);
    expect(await f.runtime.runOnce()).toBe(false);
    expect((await f.state()).identityOutbox[0]).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  });
  it("serializes workers using a shared durable lease", async () => {
    let release!: () => void, started!: () => void;
    const start = new Promise<void>((resolve) => {
        started = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    let sends = 0;
    const transport = {
      send: async () => {
        sends++;
        started();
        await hold;
      },
    };
    const f = await fixture({}, transport);
    await f.enqueue();
    await f.enqueue();
    const other = createIdentityMailRuntime({
      store: f.store,
      config: f.config,
      transport,
      clock: f.clock,
    });
    cleanup.push(() => other.close());
    const first = f.runtime.runOnce();
    await start;
    expect(await other.runOnce()).toBe(false);
    expect(sends).toBe(1);
    release();
    await first;
    await other.runOnce();
    expect(sends).toBe(2);
  });
  it("recovers expired claims without releasing unknown dispatched charges", async () => {
    const f = await fixture();
    await f.enqueue();
    await f.store.transaction((s) => {
      const r = s.identityOutbox[0];
      r.status = "sending";
      r.attempts = 3;
      r.leaseToken = randomUUID();
      r.leaseExpiresAt = new Date(f.clock().getTime() - 1000).toISOString();
      r.costReservationId = randomUUID();
      s.budget.reservations.push({
        id: r.costReservationId,
        provider: "configured-smtp",
        operation: "identity-email",
        actorId: "identity-mail-worker",
        idempotencyKey: `identity-mail:${r.id}:3`,
        period: f.clock().toISOString().slice(0, 7),
        status: "running",
        maximumCents: 3,
        createdAt: r.createdAt,
        expiresAt: r.leaseExpiresAt,
        startedAt: r.createdAt,
      });
    });
    expect(await f.runtime.runOnce()).toBe(false);
    const state = await f.state();
    expect(state.identityOutbox[0].status).toBe("cancelled");
    expect(state.budget.reservations[0].status).toBe("running");
  });
  it("keeps explicit local test delivery separate from external SMTP costs", async () => {
    const f = await fixture({ mode: "local-test" });
    await f.store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    await f.enqueue();
    await f.runtime.runOnce();
    expect(f.messages).toHaveLength(1);
    expect((await f.state()).budget.reservations).toHaveLength(0);
  });
});
