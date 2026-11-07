/** Platform operating budget. Money is always integer USD cents; months use UTC. */
export interface BudgetPolicy {
  version: number;
  currency: "USD";
  monthlyLimitCents: number;
  safetyMarginCents: number;
  fixedCostReserveCents: number;
  paidOperationsPaused: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface BudgetAdjustment {
  id: string;
  idempotencyKey: string;
  period: string;
  amountCents: number;
  category: "fixed" | "variable";
  reason: string;
  actorId: string;
  createdAt: string;
}
export interface BudgetReservation {
  id: string;
  idempotencyKey: string;
  provider: string;
  operation: string;
  actorId: string;
  period: string;
  maximumCents: number;
  status: "reserved" | "running" | "settled" | "released" | "expired";
  createdAt: string;
  expiresAt: string;
  startedAt?: string;
  settledAt?: string;
  settledPeriod?: string;
  actualCents?: number;
  releasedAt?: string;
  releaseReason?: string;
}
export interface BudgetAudit {
  id: string;
  at: string;
  actorId: string;
  action: string;
  details: Record<string, unknown>;
}
export interface BudgetState {
  schemaVersion: 1;
  policy: BudgetPolicy;
  adjustments: BudgetAdjustment[];
  reservations: BudgetReservation[];
  audit: BudgetAudit[];
  /** Optional append-only administrator reviews; absence preserves legacy state. */
  costReviews?: BudgetCostReview[];
}

/** Authored spending scenarios, not statistical confidence limits. */
export interface BudgetCostBand {
  lowCents: number;
  expectedCents: number;
  highCents: number;
}
export interface BudgetCostReviewInput {
  idempotencyKey: string;
  expectedBasisHash: string;
  coveredThrough: string;
  expiresAt: string;
  /** All unresolved unmetered cost, including earlier reviews; excludes recorded costs, fixed allowance and every integrated reservation/charge. */
  estimatedUnreportedCents: number;
  /** Additional future spending after this review, excluding captured accounting and the unreported estimate. */
  futureVariable: BudgetCostBand;
  scopeStatement: string;
  replacesReviewId: string | null;
  /** Explicit replacement covers/reconciles the preceding estimate; expiry never releases it. */
  includesPriorUnreported: true;
}
export interface BudgetCostReview {
  version: 1;
  methodVersion: "budget-outlook-1.0.0";
  id: string;
  idempotencyKey: string;
  actorId: string;
  createdAt: string;
  period: string;
  coveredThrough: string;
  expiresAt: string;
  replacesReviewId: string | null;
  includesPriorUnreported: true;
  /** Exact accounting snapshot at submission; new integrated work may legitimately change it. */
  basisHash: string;
  /** Freshness identity: manual ledger, fixed allowance and acknowledged overruns. */
  coverageHash: string;
  /** Existing accounted costs/holds, excluding this review's unreported estimate. */
  accountedAtReviewCents: number;
  estimatedUnreportedCents: number;
  futureVariable: BudgetCostBand;
  scopeStatement: string;
}
export interface BudgetCostReviewStatus {
  status:
    | "missing"
    | "fresh"
    | "expired"
    | "period-changed"
    | "evidence-changed"
    | "invalid";
  reviewId: string | null;
  reviewPeriod: string | null;
  coveredThrough: string | null;
  expiresAt: string | null;
  reason: string;
}
export interface BudgetOutlook {
  methodVersion: "budget-outlook-1.0.0";
  asOf: string;
  period: string;
  basisHash: string;
  review: BudgetCostReviewStatus;
  /** Always held until explicit replacement, even when forecast/review is stale. */
  estimatedUnreportedCents: number;
  estimateCarriedFromPriorPeriod: boolean;
  /** Includes current known accounting plus the persistent unreported estimate. */
  accountedFloorCents: number;
  /** Null unless review is fresh. Each authored band is floored by current accounted exposure. */
  forecast: BudgetCostBand | null;
  pacing: {
    elapsedFraction: number;
    remainingMilliseconds: number;
    remainingUtcDays: number;
    /** Even share of internal headroom across remaining UTC dates, including today; not a predicted burn rate. */
    remainingDailyAllowanceCents: number | null;
  };
  alerts: Array<
    | "review-required"
    | "estimate-carried"
    | "operating-limit-reached"
    | "expected-above-operating-limit"
    | "high-above-monthly-limit"
  >;
  notes: string[];
}
export interface BudgetDashboard {
  policy: BudgetPolicy;
  period: string;
  totals: {
    limitCents: number;
    safetyMarginCents: number;
    operatingLimitCents: number;
    recordedFixedCents: number;
    recordedVariableCents: number;
    recordedSpendCents: number;
    unspentFixedReserveCents: number;
    reservedCents: number;
    accountedCents: number;
    estimatedUnreportedCents?: number;
    availableCents: number;
    overLimitCents: number;
  };
  admission: {
    allowed: boolean;
    reason:
      | "paused"
      | "budget_exhausted"
      | "cost_review_required"
      | "available";
  };
  coverage: {
    mode: "manual";
    paidProviders: string[];
    billingSync: false;
    externalChargesCapped: false;
    externalSpendKnown: false;
    notes: string[];
  };
  adjustments: BudgetAdjustment[];
  reservations: BudgetReservation[];
  audit: BudgetAudit[];
  outlook?: BudgetOutlook;
}
export interface BudgetPolicyUpdate {
  expectedVersion: number;
  monthlyLimitCents: number;
  safetyMarginCents: number;
  fixedCostReserveCents: number;
  paidOperationsPaused: boolean;
}
export interface BudgetAdjustmentInput {
  idempotencyKey: string;
  amountCents: number;
  category: "fixed" | "variable";
  reason: string;
}
