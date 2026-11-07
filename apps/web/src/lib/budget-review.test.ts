import { describe, expect, it } from "vitest";
import type { BudgetDashboard } from "@urban/core";
import {
  budgetReviewBasisChanged,
  createBudgetReviewDraft,
  readBudgetReviewDraft,
  reviewCurrentBudgetBasis,
} from "./budget-review";

function dashboard(asOf = "2026-11-06T12:00:00.000Z"): BudgetDashboard {
  return {
    policy: {
      version: 1,
      currency: "USD",
      monthlyLimitCents: 30000,
      safetyMarginCents: 3000,
      fixedCostReserveCents: 5000,
      paidOperationsPaused: true,
      updatedAt: null,
      updatedBy: null,
    },
    period: asOf.slice(0, 7),
    totals: {
      limitCents: 30000,
      safetyMarginCents: 3000,
      operatingLimitCents: 27000,
      recordedFixedCents: 2000,
      recordedVariableCents: 0,
      recordedSpendCents: 2000,
      unspentFixedReserveCents: 3000,
      reservedCents: 0,
      accountedCents: 5000,
      availableCents: 22000,
      overLimitCents: 0,
    },
    admission: { allowed: false, reason: "paused" },
    coverage: {
      mode: "manual",
      paidProviders: [],
      billingSync: false,
      externalChargesCapped: false,
      externalSpendKnown: false,
      notes: [],
    },
    adjustments: [],
    reservations: [],
    audit: [],
    outlook: {
      methodVersion: "budget-outlook-1.0.0",
      asOf,
      period: asOf.slice(0, 7),
      basisHash: "a".repeat(64),
      review: {
        status: "missing",
        reviewId: null,
        reviewPeriod: null,
        coveredThrough: null,
        expiresAt: null,
        reason: "Review required",
      },
      estimatedUnreportedCents: 0,
      estimateCarriedFromPriorPeriod: false,
      accountedFloorCents: 5000,
      forecast: null,
      pacing: {
        elapsedFraction: 0.2,
        remainingMilliseconds: 2000000,
        remainingUtcDays: 25,
        remainingDailyAllowanceCents: null,
      },
      alerts: ["review-required"],
      notes: [],
    },
  };
}
function valid(data = dashboard()) {
  return {
    ...createBudgetReviewDraft(data),
    unreported: "0",
    low: "0",
    expected: "10.25",
    high: "20",
    scope:
      "Reviewed hosting invoice and remaining explicitly planned processing.",
    includesPrior: true,
  };
}
describe("budget cost review draft", () => {
  it("starts unknown amounts blank, with an explicit24-hour UTC expiry", () => {
    const draft = createBudgetReviewDraft(dashboard());
    expect([draft.unreported, draft.low, draft.expected, draft.high]).toEqual([
      "",
      "",
      "",
      "",
    ]);
    expect(draft.coveredThrough).toBe("2026-11-06T12:00:00");
    expect(draft.expiresAt).toBe("2026-11-07T12:00:00");
    expect(draft.includesPrior).toBe(false);
  });
  it("bounds default expiry to the current UTC month", () => {
    expect(
      createBudgetReviewDraft(dashboard("2026-11-30T18:00:00.000Z")).expiresAt,
    ).toBe("2026-11-30T23:59:59");
  });
  it("preserves known zero and exact cents instead of filling blank amounts with zero", () => {
    const data = dashboard();
    const input = readBudgetReviewDraft(valid(data), data);
    expect(input.estimatedUnreportedCents).toBe(0);
    expect(input.futureVariable).toEqual({
      lowCents: 0,
      expectedCents: 1025,
      highCents: 2000,
    });
    expect(input.coveredThrough).toBe("2026-11-06T12:00:00.000Z");
    expect(() =>
      readBudgetReviewDraft({ ...valid(data), unreported: "" }, data),
    ).toThrow("Estimated unreported cost must");
    expect(() =>
      readBudgetReviewDraft({ ...valid(data), high: "0.001" }, data),
    ).toThrow("two decimal places");
  });
  it("requires ordered nonnegative authored scenarios and prior-cost acknowledgement", () => {
    const data = dashboard();
    expect(() =>
      readBudgetReviewDraft({ ...valid(data), low: "15" }, data),
    ).toThrow("low ≤ expected ≤ high");
    expect(() =>
      readBudgetReviewDraft({ ...valid(data), high: "-20" }, data),
    ).toThrow("between $0");
    expect(() =>
      readBudgetReviewDraft({ ...valid(data), includesPrior: false }, data),
    ).toThrow("Confirm");
  });
  it("preserves input but requires a new acknowledgement when the accounting basis or prior review changes", () => {
    const data = dashboard(),
      draft = valid(data),
      next = structuredClone(data);
    next.outlook!.basisHash = "b".repeat(64);
    next.outlook!.review.reviewId = "new-review";
    expect(budgetReviewBasisChanged(draft, next)).toBe(true);
    expect(() => readBudgetReviewDraft(draft, next)).toThrow(
      "Accounting changed",
    );
    const reviewed = reviewCurrentBudgetBasis(draft, next);
    expect(reviewed.unreported).toBe(draft.unreported);
    expect(reviewed.scope).toBe(draft.scope);
    expect(reviewed.includesPrior).toBe(false);
    expect(reviewed.replacesReviewId).toBe("new-review");
    expect(
      readBudgetReviewDraft({ ...reviewed, includesPrior: true }, next)
        .expectedBasisHash,
    ).toBe("b".repeat(64));
  });
  it("rejects impossible dates, future evidence and expiry outside source-time bounds", () => {
    const data = dashboard();
    for (const coveredThrough of [
      "2026-02-30T12:00:00",
      "2026-10-31T23:59:59",
      "2026-11-06T12:00:01",
    ])
      expect(() =>
        readBudgetReviewDraft({ ...valid(data), coveredThrough }, data),
      ).toThrow();
    for (const expiresAt of [
      "2026-11-06T12:00:00",
      "2026-11-14T00:00:00",
      "2026-12-01T00:00:01",
    ])
      expect(() =>
        readBudgetReviewDraft({ ...valid(data), expiresAt }, data),
      ).toThrow("Expiry");
  });
});
