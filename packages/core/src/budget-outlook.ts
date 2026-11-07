import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJSON } from "./canonical";
import type {
  BudgetCostBand,
  BudgetCostReview,
  BudgetCostReviewInput,
  BudgetCostReviewStatus,
  BudgetOutlook,
  BudgetState,
} from "./budget";

export const BUDGET_OUTLOOK_METHOD_VERSION = "budget-outlook-1.0.0" as const;
export const BUDGET_REVIEW_DEFAULT_AGE_MS = 24 * 60 * 60 * 1000;
export const BUDGET_REVIEW_MAX_AGE_MS = 7 * BUDGET_REVIEW_DEFAULT_AGE_MS;
export const BUDGET_REVIEW_MAX_INPUT_CENTS = 100_000_000;
export const MAX_BUDGET_COST_REVIEWS = 10_000;

export class BudgetReviewError extends Error {
  constructor(
    readonly code: "BUDGET_REVIEW_INVALID" | "BUDGET_REVIEW_BASIS_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "BudgetReviewError";
  }
}
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new BudgetReviewError("BUDGET_REVIEW_INVALID", message);
}
function integer(value: number, signed = false) {
  requireValue(
    Number.isSafeInteger(value) && (signed || value >= 0),
    "Costs must be exact safe integer cents.",
  );
  return BigInt(value);
}
function exact(value: bigint) {
  requireValue(
    value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
    "Cost accounting exceeds exact nonnegative integer bounds.",
  );
  return Number(value);
}
function sum(values: number[], signed = false) {
  return exact(
    values.reduce((total, value) => total + integer(value, signed), 0n),
  );
}
function timestamp(value: string) {
  const result = Date.parse(value);
  requireValue(
    Number.isFinite(result) && new Date(result).toISOString() === value,
    "Review timestamps must be canonical UTC instants with milliseconds.",
  );
  return result;
}
function accountingTimestamp(value: string) {
  const result = Date.parse(value);
  requireValue(Number.isFinite(result), "Invalid retained reservation expiry.");
  return result;
}
function month(now: Date) {
  requireValue(Number.isFinite(now.getTime()), "Invalid accounting time.");
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { period: now.toISOString().slice(0, 7), start, end };
}
function hash(value: unknown) {
  return Array.from(
    sha256(new TextEncoder().encode(canonicalJSON(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function ordered<T extends { id: string }>(rows: T[]): T[] {
  requireValue(
    new Set(rows.map((row) => row.id)).size === rows.length,
    "Duplicate budget evidence IDs are not allowed.",
  );
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function latest(state: BudgetState): BudgetCostReview | undefined {
  requireValue(
    (state.costReviews?.length ?? 0) <= MAX_BUDGET_COST_REVIEWS,
    "Cost-review history exceeds its complete retention bound; no records were dropped.",
  );
  return state.costReviews?.at(-1);
}

/** Legacy accounting before the separately retained unreported-cost safety hold. */
export function budgetKnownAccounting(state: BudgetState, now = new Date()) {
  const { period } = month(now);
  const adjustments = state.adjustments.filter((a) => a.period === period);
  const settled = state.reservations.filter(
    (r) => r.status === "settled" && r.settledPeriod === period,
  );
  const recordedFixedCents = sum(
    adjustments.filter((a) => a.category === "fixed").map((a) => a.amountCents),
    true,
  );
  // A correction may offset a settled charge. Sum the complete category before
  // checking nonnegativity, never a partial/truncated dashboard list.
  const recordedVariableCents = sum(
    [
      ...adjustments
        .filter((a) => a.category === "variable")
        .map((a) => a.amountCents),
      ...settled.map((r) => {
        integer(r.actualCents as number);
        return r.actualCents!;
      }),
    ],
    true,
  );
  integer(state.policy.fixedCostReserveCents);
  const recordedSpendCents = sum([recordedFixedCents, recordedVariableCents]);
  const unspentFixedReserveCents = Math.max(
    0,
    state.policy.fixedCostReserveCents - recordedFixedCents,
  );
  const reservedCents = sum(
    state.reservations
      .filter(
        (r) =>
          r.status === "running" ||
          (r.status === "reserved" &&
            accountingTimestamp(r.expiresAt) > now.getTime()),
      )
      .map((r) => r.maximumCents),
  );
  return {
    recordedFixedCents,
    recordedVariableCents,
    recordedSpendCents,
    unspentFixedReserveCents,
    reservedCents,
    accountedCents: sum([
      recordedSpendCents,
      unspentFixedReserveCents,
      reservedCents,
    ]),
  };
}

/** Fixed array order is shared with storage guards; array order of source rows is immaterial. */
export function budgetReviewCoverageProjection(
  state: BudgetState,
  now = new Date(),
) {
  const { period } = month(now);
  return [
    BUDGET_OUTLOOK_METHOD_VERSION,
    period,
    state.policy.fixedCostReserveCents,
    ordered(state.adjustments.filter((a) => a.period === period)).map((a) => [
      a.id,
      a.idempotencyKey,
      a.period,
      a.amountCents,
      a.category,
      a.reason,
      a.actorId,
      a.createdAt,
    ]),
    ordered(
      state.reservations.filter(
        (r) =>
          r.status === "settled" &&
          r.actualCents != null &&
          r.actualCents > r.maximumCents,
      ),
    ).map((r) => [
      r.id,
      r.maximumCents,
      r.actualCents!,
      r.settledAt ?? null,
      r.settledPeriod ?? null,
    ]),
  ];
}
export function budgetReviewCoverageHash(state: BudgetState, now = new Date()) {
  return hash(budgetReviewCoverageProjection(state, now));
}
/** Compare-and-swap identity for review submission, not its later freshness test. */
export function budgetReviewBasisProjection(
  state: BudgetState,
  now = new Date(),
) {
  const prior = latest(state);
  const accounting = budgetKnownAccounting(state, now);
  return [
    budgetReviewCoverageProjection(state, now),
    [
      state.policy.version,
      state.policy.monthlyLimitCents,
      state.policy.safetyMarginCents,
      state.policy.paidOperationsPaused,
    ],
    [
      accounting.recordedFixedCents,
      accounting.recordedVariableCents,
      accounting.unspentFixedReserveCents,
      accounting.reservedCents,
      accounting.accountedCents,
    ],
    ordered(state.reservations).map((r) => [
      r.id,
      r.idempotencyKey,
      r.provider,
      r.operation,
      r.actorId,
      r.period,
      r.maximumCents,
      r.status,
      r.createdAt,
      r.expiresAt,
      r.startedAt ?? null,
      r.settledAt ?? null,
      r.settledPeriod ?? null,
      r.actualCents ?? null,
      r.releasedAt ?? null,
      r.releaseReason ?? null,
    ]),
    prior ? [prior.id, prior.estimatedUnreportedCents] : null,
  ];
}
export function budgetReviewBasisHash(state: BudgetState, now = new Date()) {
  return hash(budgetReviewBasisProjection(state, now));
}

/** Expiry, a stale forecast and a month boundary never release this obligation. */
export function budgetUnreportedReserve(state: BudgetState): number {
  const value = latest(state)?.estimatedUnreportedCents ?? 0;
  integer(value);
  return value;
}
function validateBand(band: BudgetCostBand) {
  for (const value of [band.lowCents, band.expectedCents, band.highCents]) {
    integer(value);
    requireValue(
      value <= BUDGET_REVIEW_MAX_INPUT_CENTS,
      "Review scenario exceeds the bounded input amount.",
    );
  }
  requireValue(
    band.lowCents <= band.expectedCents && band.expectedCents <= band.highCents,
    "Spending scenarios must be ordered low, expected, high.",
  );
}
function validateReview(review: BudgetCostReview) {
  requireValue(
    review.version === 1 &&
      review.methodVersion === BUDGET_OUTLOOK_METHOD_VERSION,
    "Unsupported cost review method.",
  );
  requireValue(
    typeof review.id === "string" &&
      review.id.length > 0 &&
      typeof review.actorId === "string" &&
      review.actorId.length > 0,
    "Cost review identity is missing.",
  );
  requireValue(
    /^[0-9a-f]{64}$/.test(review.basisHash) &&
      /^[0-9a-f]{64}$/.test(review.coverageHash),
    "Review evidence hashes are invalid.",
  );
  const created = timestamp(review.createdAt),
    covered = timestamp(review.coveredThrough),
    expiry = timestamp(review.expiresAt);
  const dates = month(new Date(created));
  requireValue(
    review.period === dates.period &&
      covered >= dates.start &&
      covered <= created,
    "Cost coverage must be in the review's UTC month and not in the future.",
  );
  requireValue(
    expiry > created &&
      expiry <= dates.end &&
      expiry <= covered + BUDGET_REVIEW_MAX_AGE_MS,
    "Review expiry must follow creation and remain within seven days of coverage and the UTC month end.",
  );
  requireValue(
    review.includesPriorUnreported === true,
    "Review must explicitly include or reconcile prior unreported costs.",
  );
  integer(review.accountedAtReviewCents);
  integer(review.estimatedUnreportedCents);
  requireValue(
    review.estimatedUnreportedCents <= BUDGET_REVIEW_MAX_INPUT_CENTS,
    "Unreported estimate exceeds the input bound.",
  );
  validateBand(review.futureVariable);
  requireValue(
    typeof review.scopeStatement === "string" &&
      review.scopeStatement.trim().length >= 10 &&
      review.scopeStatement.length <= 4000,
    "Describe the scope and assumptions of the cost review.",
  );
  sum([
    review.accountedAtReviewCents,
    review.estimatedUnreportedCents,
    review.futureVariable.highCents,
  ]);
}

export function createBudgetCostReview(
  state: BudgetState,
  input: BudgetCostReviewInput,
  options: { id: string; actorId: string; now?: Date },
): BudgetCostReview {
  const now = options.now ?? new Date();
  requireValue(
    (state.costReviews?.length ?? 0) < MAX_BUDGET_COST_REVIEWS,
    "Cost-review history is full; no records may be silently dropped.",
  );
  const basisHash = budgetReviewBasisHash(state, now);
  if (input.expectedBasisHash !== basisHash)
    throw new BudgetReviewError(
      "BUDGET_REVIEW_BASIS_CHANGED",
      "Cost accounting changed. Refresh the basis before recording a review.",
    );
  requireValue(
    input.replacesReviewId === (latest(state)?.id ?? null),
    "Replacement must acknowledge the latest unresolved estimate.",
  );
  requireValue(
    typeof input.idempotencyKey === "string" &&
      input.idempotencyKey.length >= 8 &&
      input.idempotencyKey.length <= 160,
    "Invalid review request identity.",
  );
  const review: BudgetCostReview = {
    version: 1,
    methodVersion: BUDGET_OUTLOOK_METHOD_VERSION,
    id: options.id,
    idempotencyKey: input.idempotencyKey,
    actorId: options.actorId,
    createdAt: now.toISOString(),
    period: month(now).period,
    coveredThrough: input.coveredThrough,
    expiresAt: input.expiresAt,
    replacesReviewId: input.replacesReviewId,
    includesPriorUnreported: input.includesPriorUnreported,
    basisHash,
    coverageHash: budgetReviewCoverageHash(state, now),
    accountedAtReviewCents: budgetKnownAccounting(state, now).accountedCents,
    estimatedUnreportedCents: input.estimatedUnreportedCents,
    futureVariable: { ...input.futureVariable },
    scopeStatement: input.scopeStatement.trim(),
  };
  validateReview(review);
  return review;
}

export function inspectBudgetCostReview(
  state: BudgetState,
  now = new Date(),
): BudgetCostReviewStatus {
  const review = latest(state);
  const base = {
    reviewId: review?.id ?? null,
    reviewPeriod: review?.period ?? null,
    coveredThrough: review?.coveredThrough ?? null,
    expiresAt: review?.expiresAt ?? null,
  };
  if (!review)
    return {
      ...base,
      status: "missing",
      reason:
        "An administrator cost review is required; external spending is unknown.",
    };
  try {
    validateReview(review);
    requireValue(
      timestamp(review.createdAt) <= now.getTime(),
      "Review creation is in the future.",
    );
    if (review.period !== month(now).period)
      return {
        ...base,
        status: "period-changed",
        reason:
          "A new UTC month requires a new review. The prior unreported estimate remains held.",
      };
    if (timestamp(review.expiresAt) <= now.getTime())
      return {
        ...base,
        status: "expired",
        reason:
          "The manual cost review expired. Its unreported estimate remains held.",
      };
    if (review.coverageHash !== budgetReviewCoverageHash(state, now))
      return {
        ...base,
        status: "evidence-changed",
        reason:
          "Manual costs, fixed allowance or cost overruns changed after the review.",
      };
    return {
      ...base,
      status: "fresh",
      reason:
        "Current administrator-authored cost assumptions; provider bills are not independently verified.",
    };
  } catch (error) {
    return {
      ...base,
      status: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "Invalid cost-review evidence.",
    };
  }
}

export function budgetOutlook(
  state: BudgetState,
  now = new Date(),
): BudgetOutlook {
  const dates = month(now),
    review = inspectBudgetCostReview(state, now),
    captured = latest(state);
  const estimatedUnreportedCents = budgetUnreportedReserve(state);
  const accountedFloorCents = sum([
    budgetKnownAccounting(state, now).accountedCents,
    estimatedUnreportedCents,
  ]);
  integer(state.policy.monthlyLimitCents);
  integer(state.policy.safetyMarginCents);
  requireValue(
    state.policy.safetyMarginCents <= state.policy.monthlyLimitCents,
    "Safety margin exceeds the monthly limit.",
  );
  const operatingLimit =
    state.policy.monthlyLimitCents - state.policy.safetyMarginCents;
  const forecast =
    review.status === "fresh" && captured
      ? (Object.fromEntries(
          (["lowCents", "expectedCents", "highCents"] as const).map((key) => [
            key,
            Math.max(
              accountedFloorCents,
              sum([
                captured.accountedAtReviewCents,
                estimatedUnreportedCents,
                captured.futureVariable[key],
              ]),
            ),
          ]),
        ) as unknown as BudgetCostBand)
      : null;
  const remainingMilliseconds = dates.end - now.getTime();
  const remainingUtcDays = Math.ceil(
    remainingMilliseconds / BUDGET_REVIEW_DEFAULT_AGE_MS,
  );
  const estimateCarriedFromPriorPeriod =
    estimatedUnreportedCents > 0 && captured?.period !== dates.period;
  const alerts: BudgetOutlook["alerts"] = [];
  if (review.status !== "fresh") alerts.push("review-required");
  if (estimateCarriedFromPriorPeriod) alerts.push("estimate-carried");
  if (accountedFloorCents >= operatingLimit)
    alerts.push("operating-limit-reached");
  if (forecast && forecast.expectedCents > operatingLimit)
    alerts.push("expected-above-operating-limit");
  if (forecast && forecast.highCents > state.policy.monthlyLimitCents)
    alerts.push("high-above-monthly-limit");
  return {
    methodVersion: BUDGET_OUTLOOK_METHOD_VERSION,
    asOf: now.toISOString(),
    period: dates.period,
    basisHash: budgetReviewBasisHash(state, now),
    review,
    estimatedUnreportedCents,
    estimateCarriedFromPriorPeriod,
    accountedFloorCents,
    forecast,
    pacing: {
      elapsedFraction:
        (now.getTime() - dates.start) / (dates.end - dates.start),
      remainingMilliseconds,
      remainingUtcDays,
      remainingDailyAllowanceCents: forecast
        ? Math.floor(
            Math.max(0, operatingLimit - accountedFloorCents) /
              remainingUtcDays,
          )
        : null,
    },
    alerts,
    notes: [
      "Low, expected and high are administrator-authored spending scenarios, not probabilities or verified provider-bill bounds.",
      "The captured plan counts fixed allowance and open reservations at their recorded maxima. New integrated costs floor the plan rather than adding the original future allowance again.",
      "The unreported estimate covers unresolved unmetered costs through review submission, including reporting lag and earlier months. It excludes recorded costs, fixed allowance and all integrated job costs/holds.",
      "The remaining daily allowance is an even share of internal headroom across remaining UTC dates, counting today once; it is not an extrapolated burn rate or authorization to spend.",
      "Review expiry is an explicit conservative manual policy (at most seven days from coverage), not statistical certainty. Missing, expired or changed evidence withholds forecasts without releasing unreported obligations.",
      "External charges, billing latency and overruns are not capped by these calculations. No provider charge, deployment or paid operation is enabled by recording a review.",
    ],
  };
}
