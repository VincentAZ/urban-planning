import { describe, it, expect } from "vitest";
import { FileStore } from "./store.js";
import {
  budgetApiState,
  exerciseBudgetReviewApi,
} from "./budget-review-fixture.js";
import {
  defaultBudgetState,
  recordBudgetCostReview,
  assertBudgetCostEvidence,
  budgetDashboard,
} from "./budget.js";
import {
  budgetReviewFixtureInput,
  reviewBudgetForFixture,
} from "./budget-test-fixture.js";
describe("manual cost review authority", () => {
  it("requires admin review through SQLite HTTP, retains idempotency and invalidates changed manual evidence", async () => {
    const f = budgetApiState(),
      store = new FileStore();
    await store.transaction((s) => Object.assign(s, f.state));
    await exerciseBudgetReviewApi(store, f.headers);
  });
  it("preserves expired and prior-month unreported obligations until explicit replacement", () => {
    const b = defaultBudgetState(),
      now = new Date("2026-11-30T23:00:00.000Z");
    b.policy.paidOperationsPaused = false;
    recordBudgetCostReview(
      b,
      { ...budgetReviewFixtureInput(b, now), estimatedUnreportedCents: 5000 },
      "admin",
      now,
    );
    const next = new Date("2026-12-01T01:00:00.000Z");
    expect(() => assertBudgetCostEvidence(b, next)).toThrow(/administrator/);
    expect(budgetDashboard(b, next).totals).toMatchObject({
      accountedCents: 5000,
      availableCents: 22000,
    });
    expect(() =>
      recordBudgetCostReview(
        b,
        { ...budgetReviewFixtureInput(b, next), replacesReviewId: null },
        "admin",
        next,
      ),
    ).toThrow(/acknowledge/);
    reviewBudgetForFixture(b, next);
    expect(budgetDashboard(b, next).totals.estimatedUnreportedCents).toBe(0);
  });
  it("rejects worker rewrites of review evidence and permits read-only prep budget access", async () => {
    const store = new FileStore();
    await store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
      reviewBudgetForFixture(s.budget);
    });
    await expect(
      store.transaction(
        (s) => {
          s.budget.costReviews![0].estimatedUnreportedCents = 0;
          s.budget.costReviews![0].scopeStatement = "Changed by worker";
        },
        { budget: true, security: { mode: "worker", purpose: "budget" } },
      ),
    ).rejects.toThrow(/immutable|review/);
    expect(
      await store.read((s) => s.budget.costReviews?.length, {
        budget: true,
        security: { mode: "worker", purpose: "prep" },
      }),
    ).toBe(1);
    await expect(
      store.transaction(
        (s) => {
          s.budget.policy.paidOperationsPaused = true;
        },
        { budget: true, security: { mode: "worker", purpose: "prep" } },
      ),
    ).rejects.toThrow(/cannot mutate/);
    await store.close();
  });
  it("preserves every running/settled obligation and audit entry at the SQLite boundary", async () => {
    const store = new FileStore();
    await store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
      reviewBudgetForFixture(s.budget);
    });
    const service = new (await import("./budget.js")).BudgetService(store);
    const cost = {
      idempotencyKey: "immutable-hold-1",
      provider: "test",
      operation: "test",
      actorId: "worker",
      maximumCents: 100,
    };
    const hold = await service.reserve(cost);
    await service.start(hold.id);
    for (const mutate of [
      (b: any) => {
        b.audit = [];
      },
      (b: any) => {
        b.audit[0].details = { forged: true };
      },
      (b: any) => {
        b.reservations = [];
      },
      (b: any) => {
        b.reservations[0].maximumCents = 1;
      },
      (b: any) => {
        b.policy.monthlyLimitCents++;
      },
      (b: any) => {
        b.adjustments.push({ amountCents: -100 });
      },
    ])
      await expect(
        store.transaction((s) => mutate(s.budget), {
          budget: true,
          security: { mode: "worker", purpose: "budget" },
        }),
      ).rejects.toThrow(/immutable|worker|identit|metadata|manual cost/);
    await service.settle(hold.id, 80);
    await expect(
      store.transaction(
        (s) => {
          s.budget.reservations[0].actualCents = 0;
        },
        { budget: true, security: { mode: "worker", purpose: "budget" } },
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      store.transaction(
        (s) => {
          s.budget.policy.monthlyLimitCents++;
        },
        {
          budget: true,
          security: {
            mode: "auth",
            purpose: "lookup",
            email: "admin@example.test",
          },
        },
      ),
    ).rejects.toThrow(/capability/);
    await store.close();
  });
});
