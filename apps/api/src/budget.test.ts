import { reviewBudgetForFixture } from "./budget-test-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetService,
  budgetDashboard,
  defaultBudgetState,
  recordBudgetAdjustment,
  updateBudgetPolicy,
} from "./budget.js";
import { emptyState, FileStore } from "./store.js";
import { buildApp } from "./app.js";
import type { FastifyInstance } from "fastify";

const startDate = new Date("2026-11-15T12:00:00.000Z");
const cost = (idempotencyKey = "unique-job-0001", maximumCents = 1_000) => ({
  idempotencyKey,
  maximumCents,
  provider: "test-provider",
  operation: "test-operation",
  actorId: "worker",
});
const policy = (expectedVersion = 1) => ({
  expectedVersion,
  monthlyLimitCents: 10_000,
  safetyMarginCents: 1_000,
  fixedCostReserveCents: 1_000,
  paidOperationsPaused: false,
});
async function enabledStore() {
  const store = new FileStore();
  await store.transaction((s) =>
    updateBudgetPolicy(s.budget, policy(), "admin", startDate),
  );
  await store.transaction((s) => reviewBudgetForFixture(s.budget, startDate));
  return store;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startDate);
});
const apps: FastifyInstance[] = [];
const apiDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
  for (const directory of apiDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("operating budget accounting", () => {
  it("starts with $300 ceiling, $30 safety margin, paused paid work, and unknown external spend", () => {
    const dashboard = budgetDashboard(defaultBudgetState(), startDate);
    expect(dashboard.policy.monthlyLimitCents).toBe(30_000);
    expect(dashboard.totals.availableCents).toBe(27_000);
    expect(dashboard.admission).toEqual({ allowed: false, reason: "paused" });
    expect(dashboard.coverage).toMatchObject({
      paidProviders: [],
      externalChargesCapped: false,
      externalSpendKnown: false,
      billingSync: false,
    });
  });
  it("admits concurrent reservations atomically without exceeding safe headroom", async () => {
    const store = await enabledStore();
    const service = new BudgetService(store, () => startDate);
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        service.reserve(cost(`concurrent-job-${i}`, 2_500)),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(13);
    const dashboard = await store.read((s) =>
      budgetDashboard(s.budget, startDate),
    );
    expect(dashboard.totals.reservedCents).toBe(7_500);
    expect(dashboard.totals.accountedCents).toBe(8_500);
    expect(dashboard.totals.availableCents).toBe(500);
  });
  it("retries reserve and settlement without duplicate charges and dispatches only once", async () => {
    const store = await enabledStore();
    const service = new BudgetService(store, () => startDate);
    const reservation = await service.reserve(cost());
    expect((await service.reserve(cost())).id).toBe(reservation.id);
    await expect(
      service.reserve({ ...cost(), maximumCents: 900 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(service.settle(reservation.id, 600)).rejects.toMatchObject({
      code: "RESERVATION_NOT_RUNNING",
    });
    await service.start(reservation.id);
    await expect(service.start(reservation.id)).rejects.toMatchObject({
      code: "RESERVATION_NOT_DISPATCHABLE",
    });
    await service.settle(reservation.id, 600);
    await service.settle(reservation.id, 600);
    await expect(service.settle(reservation.id, 700)).rejects.toMatchObject({
      code: "SETTLEMENT_CONFLICT",
    });
    await expect(
      service.release(reservation.id, "Cannot erase charge"),
    ).rejects.toMatchObject({ code: "RESERVATION_SETTLED" });
    const dashboard = await store.read((s) =>
      budgetDashboard(s.budget, startDate),
    );
    expect(dashboard.totals).toMatchObject({
      recordedVariableCents: 600,
      reservedCents: 0,
      accountedCents: 1_600,
      availableCents: 7_400,
    });
    expect(
      dashboard.audit.filter((a) => a.action === "reservation.settled"),
    ).toHaveLength(1);
  });
  it("replaces fixed allowance with actual fixed bills and preserves overages", () => {
    const state = defaultBudgetState();
    updateBudgetPolicy(
      state,
      { ...policy(), fixedCostReserveCents: 3_000 },
      "admin",
      startDate,
    );
    recordBudgetAdjustment(
      state,
      {
        idempotencyKey: "hosting-bill-01",
        amountCents: 2_000,
        category: "fixed",
        reason: "Hosting invoice recorded",
      },
      "admin",
      startDate,
    );
    expect(budgetDashboard(state, startDate).totals).toMatchObject({
      recordedFixedCents: 2_000,
      unspentFixedReserveCents: 1_000,
      accountedCents: 3_000,
    });
    recordBudgetAdjustment(
      state,
      {
        idempotencyKey: "storage-bill-01",
        amountCents: 1_500,
        category: "fixed",
        reason: "Storage invoice recorded",
      },
      "admin",
      startDate,
    );
    expect(budgetDashboard(state, startDate).totals).toMatchObject({
      recordedFixedCents: 3_500,
      unspentFixedReserveCents: 0,
      accountedCents: 3_500,
    });
  });
  it("records idempotent corrections without permitting negative category totals", () => {
    const state = defaultBudgetState();
    const input = {
      idempotencyKey: "cost-entry-0001",
      amountCents: 1_000,
      category: "variable" as const,
      reason: "Provider invoice reconciliation",
    };
    recordBudgetAdjustment(state, input, "admin", startDate);
    recordBudgetAdjustment(state, input, "admin", startDate);
    expect(state.adjustments).toHaveLength(1);
    expect(() =>
      recordBudgetAdjustment(
        state,
        { ...input, amountCents: 500 },
        "admin",
        startDate,
      ),
    ).toThrow("already used");
    recordBudgetAdjustment(
      state,
      {
        ...input,
        idempotencyKey: "cost-refund-0001",
        amountCents: -200,
        reason: "Correct duplicated invoice line",
      },
      "admin",
      startDate,
    );
    expect(budgetDashboard(state, startDate).totals.recordedVariableCents).toBe(
      800,
    );
    expect(() =>
      recordBudgetAdjustment(
        state,
        { ...input, idempotencyKey: "cost-refund-0002", amountCents: -900 },
        "admin",
        startDate,
      ),
    ).toThrow("below zero");
  });
  it("records real overruns once and pauses further paid operations", async () => {
    const store = await enabledStore();
    const service = new BudgetService(store, () => startDate);
    const reservation = await service.reserve(cost());
    await service.start(reservation.id);
    await service.settle(reservation.id, 12_000);
    const dashboard = await store.read((s) =>
      budgetDashboard(s.budget, startDate),
    );
    expect(dashboard.totals).toMatchObject({
      recordedSpendCents: 12_000,
      reservedCents: 0,
      accountedCents: 13_000,
      overLimitCents: 3_000,
      availableCents: 0,
    });
    expect(dashboard.policy.paidOperationsPaused).toBe(true);
    await expect(
      service.reserve(cost("another-job-0001")),
    ).rejects.toMatchObject({ code: "PAID_OPERATIONS_PAUSED" });
  });
  it("applies lowered limits immediately without erasing existing obligations", async () => {
    const store = await enabledStore();
    const service = new BudgetService(store, () => startDate);
    const reservation = await service.reserve(cost("lowered-limit-job", 5_000));
    await store.transaction((s) =>
      updateBudgetPolicy(
        s.budget,
        { ...policy(2), monthlyLimitCents: 4_000 },
        "admin",
        startDate,
      ),
    );
    await expect(service.start(reservation.id)).rejects.toMatchObject({
      code: "RESERVATION_PAUSED",
    });
    const dashboard = await store.read((s) =>
      budgetDashboard(s.budget, startDate),
    );
    expect(dashboard.admission.reason).toBe("budget_exhausted");
    expect(dashboard.totals.reservedCents).toBe(5_000);
    await service.release(reservation.id, "Cancelled before dispatch");
    await service.release(reservation.id, "Retry cancellation");
    expect(
      (await store.read((s) => budgetDashboard(s.budget, startDate))).totals
        .reservedCents,
    ).toBe(0);
  });
  it("rolls months in UTC, expires only undispatched holds, and carries running work until settlement", async () => {
    const store = await enabledStore();
    let now = new Date("2026-11-30T23:59:59.000Z");
    const service = new BudgetService(store, () => now);
    await store.transaction((s) =>
      recordBudgetAdjustment(
        s.budget,
        {
          idempotencyKey: "november-cost-01",
          amountCents: 1_500,
          category: "variable",
          reason: "November invoice recorded",
        },
        "admin",
        now,
      ),
    );
    vi.setSystemTime(now);
    await store.transaction((s) => reviewBudgetForFixture(s.budget, now));
    const running = await service.reserve(cost("running-november-job", 3_000));
    await service.start(running.id);
    const pending = await service.reserve({
      ...cost("expiring-november-job", 1_000),
      ttlSeconds: 1,
    });
    now = new Date("2026-12-01T00:10:00.000Z");
    vi.setSystemTime(now);
    expect(
      (
        await service.reserve({
          ...cost("expiring-november-job", 1_000),
          ttlSeconds: 1,
        })
      ).status,
    ).toBe("expired");
    await expect(service.start(pending.id)).rejects.toMatchObject({
      code: "RESERVATION_NOT_DISPATCHABLE",
    });
    let dashboard = await store.read((s) => budgetDashboard(s.budget, now));
    expect(dashboard.period).toBe("2026-12");
    expect(dashboard.totals).toMatchObject({
      recordedSpendCents: 0,
      reservedCents: 3_000,
      unspentFixedReserveCents: 1_000,
      availableCents: 5_000,
    });
    await service.settle(running.id, 2_000);
    dashboard = await store.read((s) => budgetDashboard(s.budget, now));
    expect(dashboard.totals).toMatchObject({
      recordedSpendCents: 2_000,
      reservedCents: 0,
      availableCents: 6_000,
    });
    expect(
      dashboard.reservations.find((r) => r.id === running.id)?.settledPeriod,
    ).toBe("2026-12");
  });
  it("rejects stale policy versions, fractions, and an impossible safety margin", () => {
    const state = defaultBudgetState();
    updateBudgetPolicy(state, policy(), "admin", startDate);
    expect(() =>
      updateBudgetPolicy(state, policy(), "admin", startDate),
    ).toThrow("policy changed");
    expect(() =>
      updateBudgetPolicy(
        state,
        { ...policy(2), monthlyLimitCents: 300.25 },
        "admin",
        startDate,
      ),
    ).toThrow();
    expect(() =>
      updateBudgetPolicy(
        state,
        { ...policy(2), safetyMarginCents: 20_000 },
        "admin",
        startDate,
      ),
    ).toThrow();
    expect(state.policy.version).toBe(2);
  });
  it("migrates existing state without changing saved work and persists the budget across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-budget-"));
    const file = join(directory, "state.json");
    try {
      const { budget: omitted, ...legacy } = emptyState();
      void omitted;
      legacy.organizations.push({
        id: "original-org",
        name: "Existing workspace",
        createdAt: startDate.toISOString(),
      });
      await writeFile(file, JSON.stringify(legacy));
      const store = new FileStore(file);
      expect((await store.read((s) => s.budget.policy)).monthlyLimitCents).toBe(
        30_000,
      );
      await store.transaction((s) =>
        updateBudgetPolicy(
          s.budget,
          { ...policy(), monthlyLimitCents: 45_000 },
          "admin",
          startDate,
        ),
      );
      await store.close();
      const reopened = new FileStore(file);
      expect(await reopened.read((s) => s.organizations)).toEqual(
        legacy.organizations,
      );
      expect(
        (await reopened.read((s) => s.budget.policy)).monthlyLimitCents,
      ).toBe(45_000);
      expect((await reopened.read((s) => s.budget.policy)).version).toBe(2);
      // Migration leaves the original source document available for recovery.
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(legacy);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function register(app: FastifyInstance, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: "secure password for budget tests",
      name: "Budget test",
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id as string,
    headers: {
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      "x-csrf-token": response.json().csrfToken as string,
    },
  };
}
async function adminApp() {
  const directory = await mkdtemp(join(tmpdir(), "urban-budget-admin-"));
  apiDirectories.push(directory);
  const filename = join(directory, "state.json");
  const bootstrap = await buildApp({ store: new FileStore(filename) });
  const admin = await register(bootstrap, "administrator@example.com");
  const ordinary = await register(bootstrap, "ordinary-owner@example.com");
  await bootstrap.close();
  const store = new FileStore(filename);
  const app = await buildApp({ store, platformAdminUserIds: [admin.id] });
  apps.push(app);
  return { app, store, admin, ordinary };
}
describe("private platform budget API", () => {
  it("separates the trusted platform administrator from ordinary workspace owners", async () => {
    const { app, admin, ordinary } = await adminApp();
    expect((await app.inject("/api/v1/admin/budget")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/v1/admin/budget",
          headers: ordinary.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/session",
          headers: ordinary.headers,
        })
      ).json(),
    ).toMatchObject({ role: "owner", platformAdmin: false });
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/session",
          headers: admin.headers,
        })
      ).json().platformAdmin,
    ).toBe(true);
    expect(
      (
        await app.inject({
          url: "/api/v1/admin/budget",
          headers: admin.headers,
        })
      ).json().policy.monthlyLimitCents,
    ).toBe(30_000);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/admin/budget",
          headers: ordinary.headers,
          payload: policy(),
        })
      ).statusCode,
    ).toBe(403);
  });
  it("enforces CSRF, trusted origin, integer costs, and optimistic policy versions", async () => {
    const { app, admin, store } = await adminApp();
    const request = {
      method: "PATCH" as const,
      url: "/api/v1/admin/budget",
      headers: admin.headers,
      payload: policy(),
    };
    expect(
      (
        await app.inject({
          ...request,
          headers: { cookie: admin.headers.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...admin.headers, origin: "https://untrusted.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          payload: { ...policy(), monthlyLimitCents: 300.55 },
        })
      ).statusCode,
    ).toBe(400);
    const concurrent = await Promise.all([
      app.inject(request),
      app.inject({
        ...request,
        payload: { ...policy(), monthlyLimitCents: 20_000 },
      }),
    ]);
    expect(concurrent.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await store.read((s) => s.budget.audit)).filter(
        (a) => a.action === "policy.updated",
      ),
    ).toHaveLength(1);
  });
  it("records manual invoices with actor audit and idempotent request retries", async () => {
    const { app, admin } = await adminApp();
    await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/budget",
      headers: admin.headers,
      payload: { ...policy(), fixedCostReserveCents: 3_000 },
    });
    const request = {
      method: "POST" as const,
      url: "/api/v1/admin/budget/adjustments",
      headers: admin.headers,
      payload: {
        idempotencyKey: "manual-hosting-cost",
        amountCents: 2_000,
        category: "fixed",
        reason: "Hosting invoice for current month",
      },
    };
    expect(
      (
        await app.inject({
          ...request,
          headers: { cookie: admin.headers.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject(request)).statusCode).toBe(200);
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toMatchObject({
      recordedSpendCents: 2_000,
      unspentFixedReserveCents: 1_000,
      accountedCents: 3_000,
    });
    expect(response.json().adjustments).toHaveLength(1);
    expect(response.json().audit[0]).toMatchObject({
      actorId: admin.id,
      action: "cost.recorded",
    });
  });
});
