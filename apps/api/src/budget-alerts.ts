import { randomUUID } from "node:crypto";
import { budgetOutlook, canonicalJSON, type BudgetState } from "@urban/core";

/** Durable observations at administrator interactions; not background monitoring or notification delivery. */
export function observeBudgetAlerts(
  state: BudgetState,
  actorId: string,
  now = new Date(),
): boolean {
  const outlook = budgetOutlook(state, now);
  const observed = {
    period: outlook.period,
    activeAlerts: outlook.alerts,
    reviewStatus: outlook.review.status,
  };
  const signature = canonicalJSON(observed);
  const previous = [...state.audit]
    .reverse()
    .find((entry) => entry.action === "budget.alerts.observed");
  if (previous?.details.signature === signature) return false;
  state.audit.push({
    id: randomUUID(),
    at: now.toISOString(),
    actorId,
    action: "budget.alerts.observed",
    details: {
      ...observed,
      signature,
      reviewId: outlook.review.reviewId,
      methodVersion: outlook.methodVersion,
      accountedCents: outlook.accountedFloorCents,
      forecast: outlook.forecast,
      observation:
        "Observed during a platform-administrator budget interaction. No notification was sent; transitions between observations are unknown.",
    },
  });
  return true;
}
