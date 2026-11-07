import { describe, expect, it } from "vitest";
import { observeBudgetAlerts } from "./budget-alerts";
import { defaultBudgetState, recordBudgetAdjustment } from "./budget";
import { reviewBudgetForFixture } from "./budget-test-fixture";

describe("observed administrator cost alerts", () => {
  it("persists missing/fresh/expired transitions once without inventing unseen events or sending messages", () => {
    const state = defaultBudgetState(),
      now = new Date("2026-11-06T12:00:00.000Z");
    expect(observeBudgetAlerts(state, "admin", now)).toBe(true);
    expect(
      observeBudgetAlerts(state, "admin", new Date(now.getTime() + 1000)),
    ).toBe(false);
    const missing = structuredClone(state.audit[0]);
    reviewBudgetForFixture(state, now);
    expect(observeBudgetAlerts(state, "admin", now)).toBe(true);
    expect(
      observeBudgetAlerts(state, "admin", new Date("2026-11-07T12:00:00.000Z")),
    ).toBe(true);
    const events = state.audit.filter(
      (e) => e.action === "budget.alerts.observed",
    );
    expect(events.map((e) => e.details.reviewStatus)).toEqual([
      "missing",
      "fresh",
      "expired",
    ]);
    expect(events[1].details.activeAlerts).toEqual([]);
    expect(state.audit[0]).toEqual(missing);
    expect(
      events.every((e) =>
        String(e.details.observation).includes("No notification was sent"),
      ),
    ).toBe(true);
  });
  it("records changed evidence and crossed allowance, then an explicit reviewed resolution", () => {
    const state = defaultBudgetState(),
      now = new Date("2026-11-06T12:00:00.000Z");
    reviewBudgetForFixture(state, now);
    observeBudgetAlerts(state, "admin", now);
    recordBudgetAdjustment(
      state,
      {
        idempotencyKey: "external-cost-observation",
        amountCents: 28000,
        category: "variable",
        reason: "Recorded fixture charge crosses the operating allowance",
      },
      "admin",
      now,
    );
    observeBudgetAlerts(state, "admin", now);
    expect(state.audit.at(-1)?.details.activeAlerts).toEqual([
      "review-required",
      "operating-limit-reached",
    ]);
    expect(state.audit.at(-1)?.details.accountedCents).toBe(28000);
    state.policy.monthlyLimitCents = 50000;
    reviewBudgetForFixture(state, now);
    observeBudgetAlerts(state, "admin", now);
    expect(state.audit.at(-1)?.details.activeAlerts).toEqual([]);
    expect(state.audit.at(-1)?.details.reviewStatus).toBe("fresh");
  });
});
