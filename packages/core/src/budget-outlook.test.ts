import { describe, expect, it } from "vitest";
import type {
  BudgetCostReviewInput,
  BudgetReservation,
  BudgetState,
} from "./budget";
import {
  BUDGET_REVIEW_MAX_AGE_MS,
  MAX_BUDGET_COST_REVIEWS,
  budgetKnownAccounting,
  budgetOutlook,
  budgetReviewBasisHash,
  budgetReviewCoverageHash,
  budgetUnreportedReserve,
  createBudgetCostReview,
  inspectBudgetCostReview,
} from "./budget-outlook";

const NOW = new Date("2026-11-06T12:00:00.000Z");
function state(): BudgetState {
  return {
    schemaVersion: 1,
    policy: {
      version: 1,
      currency: "USD",
      monthlyLimitCents: 30_000,
      safetyMarginCents: 3_000,
      fixedCostReserveCents: 5_000,
      paidOperationsPaused: false,
      updatedAt: null,
      updatedBy: null,
    },
    adjustments: [
      {
        id: "fixed",
        idempotencyKey: "fixed-key",
        period: "2026-11",
        amountCents: 2_000,
        category: "fixed",
        reason: "Recorded hosting invoice",
        actorId: "admin",
        createdAt: NOW.toISOString(),
      },
      {
        id: "variable",
        idempotencyKey: "variable-key",
        period: "2026-11",
        amountCents: 1_000,
        category: "variable",
        reason: "Recorded variable cost",
        actorId: "admin",
        createdAt: NOW.toISOString(),
      },
    ],
    reservations: [reservation("initial", 2_000)],
    audit: [],
  };
}
function reservation(id: string, maximumCents: number): BudgetReservation {
  return {
    id,
    idempotencyKey: `${id}-request`,
    provider: "test-only-provider",
    operation: "test-only-operation",
    actorId: "worker",
    period: "2026-11",
    maximumCents,
    status: "reserved",
    createdAt: NOW.toISOString(),
    expiresAt: "2026-11-06T13:00:00.000Z",
  };
}
function input(
  s: BudgetState,
  now = NOW,
  patch: Partial<BudgetCostReviewInput> = {},
): BudgetCostReviewInput {
  return {
    idempotencyKey: "review-request",
    expectedBasisHash: budgetReviewBasisHash(s, now),
    coveredThrough: now.toISOString(),
    expiresAt: new Date(
      Math.min(
        now.getTime() + 86_400_000,
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      ),
    ).toISOString(),
    estimatedUnreportedCents: 500,
    futureVariable: { lowCents: 1_000, expectedCents: 2_000, highCents: 5_000 },
    scopeStatement:
      "Manual test assumptions cover unmetered cost through submission and all prior estimates; no provider verification.",
    replacesReviewId: s.costReviews?.at(-1)?.id ?? null,
    includesPriorUnreported: true,
    ...patch,
  };
}
function review(
  s: BudgetState,
  now = NOW,
  patch: Partial<BudgetCostReviewInput> = {},
) {
  const r = createBudgetCostReview(s, input(s, now, patch), {
    id: `review-${s.costReviews?.length ?? 0}`,
    actorId: "admin",
    now,
  });
  (s.costReviews ??= []).push(r);
  return r;
}

describe("administrator-authored budget outlook", () => {
  it("keeps legacy state untouched and an absent review unknown, not a zero forecast", () => {
    const s = state(),
      before = JSON.stringify(s),
      outlook = budgetOutlook(s, NOW);
    expect(outlook.review.status).toBe("missing");
    expect(outlook.forecast).toBeNull();
    expect(outlook.pacing.remainingDailyAllowanceCents).toBeNull();
    expect(outlook.accountedFloorCents).toBe(8_000);
    expect(outlook.estimatedUnreportedCents).toBe(0);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("counts fixed allowance, open maxima and additional assumptions once", () => {
    const s = state();
    review(s);
    expect(budgetKnownAccounting(s, NOW)).toEqual({
      recordedFixedCents: 2_000,
      recordedVariableCents: 1_000,
      recordedSpendCents: 3_000,
      unspentFixedReserveCents: 3_000,
      reservedCents: 2_000,
      accountedCents: 8_000,
    });
    expect(budgetOutlook(s, NOW).forecast).toEqual({
      lowCents: 9_500,
      expectedCents: 10_500,
      highCents: 13_500,
    });
    expect(budgetOutlook(s, NOW).accountedFloorCents).toBe(8_500);
  });

  it("new integrated holds floor the anchored plan instead of adding its remaining allowance twice", () => {
    const s = state();
    review(s);
    s.reservations.push(reservation("new", 3_000));
    let out = budgetOutlook(s, NOW);
    expect(out.review.status).toBe("fresh");
    expect(out.forecast).toEqual({
      lowCents: 11_500,
      expectedCents: 11_500,
      highCents: 13_500,
    });
    s.reservations[1].status = "running";
    s.reservations[1].startedAt = NOW.toISOString();
    expect(budgetOutlook(s, NOW).forecast).toEqual(out.forecast);
    s.reservations[0] = {
      ...s.reservations[0],
      status: "settled",
      actualCents: 1_500,
      settledAt: NOW.toISOString(),
      settledPeriod: "2026-11",
    };
    out = budgetOutlook(s, NOW);
    expect(out.review.status).toBe("fresh");
    expect(out.accountedFloorCents).toBe(11_000);
    expect(out.forecast).toEqual({
      lowCents: 11_000,
      expectedCents: 11_000,
      highCents: 13_500,
    });
    s.reservations[1] = {
      ...s.reservations[1],
      status: "released",
      releasedAt: NOW.toISOString(),
      releaseReason: "Confirmed no charge",
    };
    expect(budgetOutlook(s, NOW).forecast).toEqual({
      lowCents: 9_500,
      expectedCents: 10_500,
      highCents: 13_500,
    });
  });

  it("does not infer zero actual charges from a settled record missing its amount", () => {
    const s = state();
    s.reservations[0].status = "settled";
    s.reservations[0].settledPeriod = "2026-11";
    expect(() => budgetKnownAccounting(s, NOW)).toThrow(/integer cents/);
    s.reservations[0].actualCents = 0;
    expect(budgetKnownAccounting(s, NOW).recordedVariableCents).toBe(1_000);
  });

  it("preserves valid legacy reservation timestamps without milliseconds while rejecting invalid expiry", () => {
    const s = state();
    s.reservations[0].expiresAt = "2026-11-06T13:00:00Z";
    expect(budgetKnownAccounting(s, NOW).reservedCents).toBe(2_000);
    s.reservations[0].expiresAt = "not-a-time";
    expect(() => budgetKnownAccounting(s, NOW)).toThrow(/reservation expiry/);
    s.reservations[0].status = "running";
    expect(budgetKnownAccounting(s, NOW).reservedCents).toBe(2_000);
  });

  it("requires re-review after manual entries, including net-zero corrections", () => {
    const s = state();
    review(s);
    s.adjustments.push(
      { ...s.adjustments[1], id: "plus", amountCents: 100 },
      { ...s.adjustments[1], id: "minus", amountCents: -100 },
    );
    expect(inspectBudgetCostReview(s, NOW).status).toBe("evidence-changed");
    expect(budgetOutlook(s, NOW).forecast).toBeNull();
    expect(budgetUnreportedReserve(s)).toBe(500);
  });

  it("changes ceiling comparisons without silently changing forecast assumptions; changed fixed allowance requires review", () => {
    const s = state();
    review(s);
    const forecast = budgetOutlook(s, NOW).forecast;
    s.policy.monthlyLimitCents = 10_000;
    s.policy.safetyMarginCents = 2_000;
    s.policy.version++;
    expect(budgetOutlook(s, NOW).forecast).toEqual(forecast);
    expect(budgetOutlook(s, NOW).alerts).toEqual(
      expect.arrayContaining([
        "operating-limit-reached",
        "expected-above-operating-limit",
        "high-above-monthly-limit",
      ]),
    );
    s.policy.fixedCostReserveCents++;
    expect(inspectBudgetCostReview(s, NOW).status).toBe("evidence-changed");
  });

  it("an overrun invalidates evidence even if someone subsequently resumes the policy", () => {
    const s = state();
    review(s);
    s.reservations[0] = {
      ...s.reservations[0],
      status: "settled",
      actualCents: 2_001,
      settledAt: NOW.toISOString(),
      settledPeriod: "2026-11",
    };
    s.policy.paidOperationsPaused = false;
    expect(inspectBudgetCostReview(s, NOW).status).toBe("evidence-changed");
    expect(budgetOutlook(s, NOW).forecast).toBeNull();
    review(s, NOW, { idempotencyKey: "review-overrun" });
    expect(inspectBudgetCostReview(s, NOW).status).toBe("fresh");
  });

  it("expired and prior-month reviews retain the unresolved estimate until explicit replacement", () => {
    const s = state(),
      old = review(s);
    expect(inspectBudgetCostReview(s, new Date(old.expiresAt)).status).toBe(
      "expired",
    );
    expect(
      budgetOutlook(s, new Date(old.expiresAt)).estimatedUnreportedCents,
    ).toBe(500);
    const december = new Date("2026-12-01T00:00:00.000Z");
    s.reservations[0].status = "running";
    const out = budgetOutlook(s, december);
    expect(out.review.status).toBe("period-changed");
    expect(out.forecast).toBeNull();
    expect(out.accountedFloorCents).toBe(7_500);
    expect(out.estimateCarriedFromPriorPeriod).toBe(true);
    expect(() =>
      createBudgetCostReview(
        s,
        input(s, december, { replacesReviewId: null }),
        { id: "replacement", actorId: "admin", now: december },
      ),
    ).toThrow(/acknowledge/);
    review(s, december, { estimatedUnreportedCents: 800 });
    expect(budgetOutlook(s, december).accountedFloorCents).toBe(7_800);
    expect(s.costReviews?.[0].estimatedUnreportedCents).toBe(500);
    expect(budgetUnreportedReserve(s)).toBe(800);
  });

  it("rejects an unacknowledged earlier estimate and does not add both replacement estimates", () => {
    const s = state();
    review(s);
    expect(() =>
      review(s, NOW, { includesPriorUnreported: false as true }),
    ).toThrow(/prior unreported/);
    review(s, NOW, { estimatedUnreportedCents: 0 });
    expect(budgetUnreportedReserve(s)).toBe(0);
    expect(budgetOutlook(s, NOW).accountedFloorCents).toBe(8_000);
  });

  it("full basis detects intervening holds and elapsed expiry; stable coverage tolerates known hold transitions", () => {
    const s = state(),
      originalInput = input(s),
      coverage = budgetReviewCoverageHash(s, NOW);
    s.reservations.push(reservation("next", 100));
    expect(budgetReviewCoverageHash(s, NOW)).toBe(coverage);
    expect(() =>
      createBudgetCostReview(s, originalInput, {
        id: "r",
        actorId: "admin",
        now: NOW,
      }),
    ).toThrow(/accounting changed/);
    const before = budgetReviewBasisHash(s, NOW);
    const later = new Date("2026-11-06T13:00:00.000Z");
    expect(budgetReviewBasisHash(s, later)).not.toBe(before);
    expect(budgetReviewCoverageHash(s, later)).toBe(coverage);
  });

  it("hashes complete relevant evidence rather than the 100-row dashboard tail", () => {
    const s = state();
    s.adjustments = Array.from({ length: 150 }, (_, i) => ({
      ...s.adjustments[1],
      id: `a-${i}`,
      amountCents: 1,
    }));
    const a = budgetReviewCoverageHash(s, NOW);
    review(s);
    expect(budgetKnownAccounting(s, NOW).recordedVariableCents).toBe(150);
    s.adjustments.reverse();
    s.reservations.reverse();
    expect(budgetReviewCoverageHash(s, NOW)).toBe(a);
    s.adjustments[149].amountCents = 2;
    expect(inspectBudgetCostReview(s, NOW).status).toBe("evidence-changed");
  });

  it("enforces explicit UTC coverage and bounded expiry without treating elapsed time as cost", () => {
    const s = state();
    for (const patch of [
      { coveredThrough: "2026-10-31T23:59:59.999Z" },
      { coveredThrough: "2026-11-06T12:00:00.001Z" },
      { expiresAt: NOW.toISOString() },
      {
        expiresAt: new Date(
          NOW.getTime() + BUDGET_REVIEW_MAX_AGE_MS + 1,
        ).toISOString(),
      },
      {
        coveredThrough: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-11-08T00:00:00.001Z",
      },
      { coveredThrough: "2026-11-06T12:00:00+00:00" },
    ])
      expect(() => review(s, NOW, patch)).toThrow();
    const end = new Date("2026-11-30T23:59:59.000Z");
    review(s, end);
    const out = budgetOutlook(s, end);
    expect(out.pacing.remainingMilliseconds).toBe(1_000);
    expect(out.pacing.remainingUtcDays).toBe(1);
    expect(out.pacing.remainingDailyAllowanceCents).toBe(20_500);
  });

  it("uses actual UTC month lengths at month start and leap February with no divide-by-zero", () => {
    for (const [date, days] of [
      ["2024-02-01T00:00:00.000Z", 29],
      ["2025-02-01T00:00:00.000Z", 28],
    ] as const) {
      const now = new Date(date),
        s = state();
      s.adjustments = [];
      s.reservations = [];
      review(s, now, {
        estimatedUnreportedCents: 0,
        futureVariable: { lowCents: 0, expectedCents: 0, highCents: 0 },
      });
      const out = budgetOutlook(s, now);
      expect(out.pacing.elapsedFraction).toBe(0);
      expect(out.pacing.remainingUtcDays).toBe(days);
      expect(out.forecast).toEqual({
        lowCents: 5_000,
        expectedCents: 5_000,
        highCents: 5_000,
      });
      expect(out.pacing.remainingDailyAllowanceCents).toBe(
        Math.floor(22_000 / days),
      );
    }
  });

  it("rejects unsafe cents, unordered scenarios and complete-history overflow without truncation", () => {
    const s = state();
    for (const value of [NaN, Infinity, -1, 0.5, 100_000_001])
      expect(() =>
        review(s, NOW, { estimatedUnreportedCents: value }),
      ).toThrow();
    expect(() =>
      review(s, NOW, {
        futureVariable: { lowCents: 10, expectedCents: 9, highCents: 20 },
      }),
    ).toThrow(/ordered/);
    const r = review(s);
    s.costReviews = Array.from({ length: MAX_BUDGET_COST_REVIEWS }, (_, i) => ({
      ...r,
      id: `review-${i}`,
    }));
    expect(() => review(s)).toThrow(/history is full/);
    expect(s.costReviews).toHaveLength(MAX_BUDGET_COST_REVIEWS);
    s.reservations = [
      reservation("large", Number.MAX_SAFE_INTEGER),
      reservation("extra", 1),
    ];
    expect(() => budgetKnownAccounting(s, NOW)).toThrow(/integer bounds/);
  });
});
