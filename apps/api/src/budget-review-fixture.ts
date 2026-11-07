import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { emptyState, type Store } from "./store.js";
import { tokenHash } from "./security.js";
import { buildApp } from "./app.js";
import { budgetReviewFixtureInput } from "./budget-test-fixture.js";
import { BudgetService } from "./budget.js";
export function budgetApiState() {
  const state = emptyState();
  const now = new Date().toISOString();
  const headers: Record<string, { cookie: string; "x-csrf-token": string }> =
    {};
  for (const id of ["budget-admin", "ordinary-owner"]) {
    const token = randomUUID(),
      csrfToken = randomUUID();
    state.users.push({
      id,
      email: `${id}@example.test`,
      name: id,
      createdAt: now,
    });
    state.organizations.push({ id: `org-${id}`, name: id, createdAt: now });
    state.memberships.push({
      userId: id,
      organizationId: `org-${id}`,
      role: "owner",
    });
    state.sessions.push({
      hash: tokenHash(token),
      csrfToken,
      userId: id,
      organizationId: `org-${id}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    headers[id] = {
      cookie: `urban_session=${token}`,
      "x-csrf-token": csrfToken,
    };
  }
  state.budget.policy.paidOperationsPaused = false;
  return { state, headers };
}
export async function exerciseBudgetReviewApi(
  store: Store,
  headers: ReturnType<typeof budgetApiState>["headers"],
) {
  const app = await buildApp({ store, platformAdminUserIds: ["budget-admin"] });
  const admin = headers["budget-admin"],
    ordinary = headers["ordinary-owner"];
  try {
    const service = new BudgetService(store);
    await expect(
      service.reserve({
        idempotencyKey: "pre-review-cost",
        provider: "test",
        operation: "test",
        actorId: "worker",
        maximumCents: 100,
      }),
    ).rejects.toMatchObject({ code: "OPERATING_COST_REVIEW_REQUIRED" });
    const get = await app.inject({
      url: "/api/v1/admin/budget",
      headers: admin,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().admission.reason).toBe("cost_review_required");
    const input = {
      ...budgetReviewFixtureInput(
        await store.read((s) => s.budget, {
          auth: {
            sessionHash: tokenHash(admin.cookie.slice("urban_session=".length)),
          },
          budget: true,
        }),
      ),
      estimatedUnreportedCents: 400,
      futureVariable: { lowCents: 100, expectedCents: 300, highCents: 1000 },
    };
    const request = {
      method: "POST" as const,
      url: "/api/v1/admin/budget/reviews",
      headers: admin,
      payload: input,
    };
    expect(
      (await app.inject({ ...request, headers: ordinary })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ ...request, headers: { cookie: admin.cookie } }))
        .statusCode,
    ).toBe(403);
    const saved = await app.inject(request);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().outlook.review.status).toBe("fresh");
    expect(saved.json().totals.estimatedUnreportedCents).toBe(400);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          ...request,
          payload: { ...input, estimatedUnreportedCents: 401 },
        })
      ).statusCode,
    ).toBe(409);
    const hold = await service.reserve({
      idempotencyKey: "reviewed-cost-01",
      provider: "test",
      operation: "test",
      actorId: "worker",
      maximumCents: 100,
    });
    await service.start(hold.id);
    await service.settle(hold.id, 80);
    expect(
      (await app.inject({ url: "/api/v1/admin/budget", headers: admin })).json()
        .outlook.review.status,
    ).toBe("fresh");
    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/budget/adjustments",
      headers: admin,
      payload: {
        idempotencyKey: "manual-cost-review-test",
        amountCents: 100,
        category: "variable",
        reason: "Actual unrelated provider cost",
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().outlook.review.status).toBe("evidence-changed");
    expect(changed.json().totals.estimatedUnreportedCents).toBe(400);
    expect(
      (
        await app.inject({
          ...request,
          payload: { ...input, idempotencyKey: "new-stale-review-key" },
        })
      ).statusCode,
    ).toBe(409);
    const records = await app.inject({
      url: "/api/v1/admin/budget/records?collection=costReviews",
      headers: admin,
    });
    expect(records.statusCode, records.body).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v1/admin/budget/records?collection=costReviews",
          headers: ordinary,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
}
