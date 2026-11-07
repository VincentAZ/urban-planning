/** Explicit zero-external-cost evidence for isolated tests only; never imported by application runtime. */
import { randomUUID } from "node:crypto";
import type {
  BudgetCostReviewInput,
  BudgetState,
} from "../../../packages/core/src/budget.js";
import { budgetDashboard, recordBudgetCostReview } from "./budget.js";

export function budgetReviewFixtureInput(
  state: BudgetState,
  now = new Date(),
): BudgetCostReviewInput {
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return {
    idempotencyKey: `fixture-review-${randomUUID()}`,
    expectedBasisHash: budgetDashboard(state, now).outlook!.basisHash,
    coveredThrough: now.toISOString(),
    expiresAt: new Date(
      Math.min(now.getTime() + 86_400_000, monthEnd),
    ).toISOString(),
    estimatedUnreportedCents: 0,
    futureVariable: { lowCents: 0, expectedCents: 0, highCents: 0 },
    scopeStatement:
      "Isolated test services and synthetic fixtures only. No paid external provider is called. Existing fixture reservations remain separately accounted; no unresolved unmetered cost is assumed.",
    replacesReviewId: state.costReviews?.at(-1)?.id ?? null,
    includesPriorUnreported: true,
  };
}
export function reviewBudgetForFixture(state: BudgetState, now = new Date()) {
  return recordBudgetCostReview(
    state,
    budgetReviewFixtureInput(state, now),
    "fixture-budget-admin",
    now,
  );
}
export function enableReviewedBudgetForFixture(
  state: BudgetState,
  now = new Date(),
) {
  state.policy.paidOperationsPaused = false;
  return reviewBudgetForFixture(state, now);
}

export const preparationCapacityFixture = {
  mode: "fixed-capacity" as const,
  environment: "local-development" as const,
  statement:
    "Isolated synthetic preparation fixture uses existing local capacity and no paid external provider.",
};
