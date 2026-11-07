import { canonicalJSON } from "@urban/core";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  BudgetState,
  BudgetDashboard,
  BudgetPolicyUpdate,
  BudgetAdjustmentInput,
  BudgetReservation,
  BudgetCostReviewInput,
  BudgetCostReviewStatus,
} from "../../../packages/core/src/budget.js";
import {
  budgetOutlook,
  budgetKnownAccounting,
  budgetUnreportedReserve,
  inspectBudgetCostReview,
  createBudgetCostReview,
  BudgetReviewError,
} from "../../../packages/core/src/budget-outlook.js";
import { ApiError } from "./errors.js";
import type { Store } from "./store.js";

// Bounded integers make every aggregate exact while rejecting NaN, infinity, and sub-cent costs.
const cents = z.number().int().min(0).max(100_000_000);
const key = z.string().trim().min(8).max(160);
const label = z.string().trim().min(1).max(240);
export const policyUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    monthlyLimitCents: cents,
    safetyMarginCents: cents,
    fixedCostReserveCents: cents,
    paidOperationsPaused: z.boolean(),
  })
  .strict()
  .refine((p) => p.safetyMarginCents <= p.monthlyLimitCents, {
    message: "The safety margin cannot exceed the monthly ceiling.",
    path: ["safetyMarginCents"],
  });
export const adjustmentSchema = z
  .object({
    idempotencyKey: key,
    amountCents: z
      .number()
      .int()
      .min(-100_000_000)
      .max(100_000_000)
      .refine((n) => n !== 0),
    category: z.enum(["fixed", "variable"]),
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export const costReviewSchema = z
  .object({
    idempotencyKey: key,
    expectedBasisHash: z.string().regex(/^[a-f0-9]{64}$/),
    coveredThrough: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    estimatedUnreportedCents: cents,
    futureVariable: z
      .object({ lowCents: cents, expectedCents: cents, highCents: cents })
      .strict(),
    scopeStatement: z.string().trim().min(12).max(2000),
    replacesReviewId: z.string().uuid().nullable(),
    includesPriorUnreported: z.literal(true),
  })
  .strict();

/** Shared discretionary-work gate; no private ledger or estimate is exposed to callers. */
export function assertBudgetCostEvidence(
  state: BudgetState,
  now = new Date(),
): BudgetCostReviewStatus {
  const status = inspectBudgetCostReview(state, now);
  if (status.status !== "fresh")
    throw new ApiError(
      503,
      "OPERATING_COST_REVIEW_REQUIRED",
      "Discretionary work is paused until the platform administrator reviews current operating costs.",
      { reason: status.status },
    );
  return status;
}

export function recordBudgetCostReview(
  state: BudgetState,
  input: BudgetCostReviewInput,
  actorId: string,
  now = new Date(),
) {
  const values = costReviewSchema.parse(input);
  const previous = (state.costReviews ?? []).find(
    (r) => r.idempotencyKey === values.idempotencyKey,
  );
  if (previous) {
    const submitted = {
      idempotencyKey: previous.idempotencyKey,
      expectedBasisHash: previous.basisHash,
      coveredThrough: previous.coveredThrough,
      expiresAt: previous.expiresAt,
      estimatedUnreportedCents: previous.estimatedUnreportedCents,
      futureVariable: previous.futureVariable,
      scopeStatement: previous.scopeStatement,
      replacesReviewId: previous.replacesReviewId,
      includesPriorUnreported: previous.includesPriorUnreported,
    };
    if (
      previous.actorId !== actorId ||
      canonicalJSON(submitted) !== canonicalJSON(values)
    )
      throw new ApiError(
        409,
        "BUDGET_REVIEW_IDEMPOTENCY_CONFLICT",
        "This review request key was already used for different evidence.",
      );
    return budgetDashboard(state, now);
  }
  try {
    const review = createBudgetCostReview(state, values, {
      id: randomUUID(),
      actorId,
      now,
    });
    if (!(state.costReviews ?? []).some((r) => r.id === review.id)) {
      (state.costReviews ??= []).push(review);
      audit(
        state,
        actorId,
        "cost-review.recorded",
        {
          reviewId: review.id,
          period: review.period,
          replacesReviewId: review.replacesReviewId,
        },
        now,
      );
    }
  } catch (error) {
    if (error instanceof BudgetReviewError)
      throw new ApiError(
        /CONFLICT|CHANGED/.test(error.code) ? 409 : 400,
        error.code,
        error.message,
      );
    throw error;
  }
  return budgetDashboard(state, now);
}

const reserveSchema = z
  .object({
    idempotencyKey: key,
    provider: label,
    operation: label,
    actorId: label,
    maximumCents: cents.positive(),
    ttlSeconds: z.number().int().min(1).max(3600).default(300),
  })
  .strict();
export type ReserveCostInput = z.input<typeof reserveSchema>;

export function defaultBudgetState(): BudgetState {
  return {
    schemaVersion: 1,
    policy: {
      version: 1,
      currency: "USD",
      monthlyLimitCents: 30_000,
      safetyMarginCents: 3_000,
      fixedCostReserveCents: 0,
      paidOperationsPaused: true,
      updatedAt: null,
      updatedBy: null,
    },
    adjustments: [],
    reservations: [],
    audit: [],
  };
}
export function budgetPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}
function audit(
  state: BudgetState,
  actorId: string,
  action: string,
  details: Record<string, unknown>,
  now: Date,
) {
  state.audit.push({
    id: randomUUID(),
    actorId,
    action,
    details,
    at: now.toISOString(),
  });
}
function open(reservation: BudgetReservation) {
  return reservation.status === "reserved" || reservation.status === "running";
}
/** Only undispatched reservations can expire. Running work remains held across month boundaries. */
export function expireReservations(state: BudgetState, now: Date) {
  for (const reservation of state.reservations) {
    if (
      reservation.status === "reserved" &&
      new Date(reservation.expiresAt).getTime() <= now.getTime()
    ) {
      reservation.status = "expired";
      reservation.releasedAt = now.toISOString();
      reservation.releaseReason = "Expired before dispatch.";
      audit(
        state,
        "system",
        "reservation.expired",
        { reservationId: reservation.id },
        now,
      );
    }
  }
}
export function budgetDashboard(
  state: BudgetState,
  now = new Date(),
): BudgetDashboard {
  const period = budgetPeriod(now);
  const adjustments = state.adjustments.filter((a) => a.period === period);
  const {
    recordedFixedCents,
    recordedVariableCents,
    recordedSpendCents,
    unspentFixedReserveCents,
    reservedCents,
  } = budgetKnownAccounting(state, now);
  const estimatedUnreportedCents = budgetUnreportedReserve(state);
  const outlook = budgetOutlook(state, now);
  const accountedCents = outlook.accountedFloorCents;
  const operatingLimitCents =
    state.policy.monthlyLimitCents - state.policy.safetyMarginCents;
  const availableCents = Math.max(0, operatingLimitCents - accountedCents);
  const reason = state.policy.paidOperationsPaused
    ? "paused"
    : outlook.review.status !== "fresh"
      ? "cost_review_required"
      : availableCents === 0
        ? "budget_exhausted"
        : "available";
  return {
    policy: structuredClone(state.policy),
    period,
    totals: {
      limitCents: state.policy.monthlyLimitCents,
      safetyMarginCents: state.policy.safetyMarginCents,
      operatingLimitCents,
      recordedFixedCents,
      recordedVariableCents,
      recordedSpendCents,
      unspentFixedReserveCents,
      reservedCents,
      accountedCents,
      estimatedUnreportedCents,
      availableCents,
      overLimitCents: Math.max(
        0,
        accountedCents - state.policy.monthlyLimitCents,
      ),
    },
    outlook,
    admission: { allowed: reason === "available", reason },
    coverage: {
      mode: "manual",
      paidProviders: [
        ...new Set(state.reservations.map((r) => r.provider)),
      ].sort(),
      billingSync: false,
      externalChargesCapped: false,
      externalSpendKnown: false,
      notes: [
        "No automatic billing feeds are connected. The provider list reflects retained cost reservations, not a complete configuration inventory. Recorded spend is a manual ledger, not your total external bill.",
        "The ceiling governs admitted operations only after their provider adapter uses reservations. No paid operation is enabled by changing this policy.",
        "Reserve expected hosting, database, storage, egress, taxes, and other fixed charges; record their actual bills as fixed costs to avoid counting them twice.",
        "Configure provider hard limits and reconcile invoices before relying on a total operating ceiling. Hosting and external charges are not stopped by this control.",
        "The default $30 safety margin is 10% of the initial $300 ceiling. It stays a fixed amount when you change the ceiling.",
      ],
    },
    adjustments: structuredClone(adjustments.slice(-100).reverse()),
    reservations: structuredClone(
      state.reservations
        .filter(
          (r) => open(r) || r.period === period || r.settledPeriod === period,
        )
        .slice(-100)
        .reverse(),
    ),
    audit: structuredClone(state.audit.slice(-100).reverse()),
  };
}
export function updateBudgetPolicy(
  state: BudgetState,
  input: BudgetPolicyUpdate,
  actorId: string,
  now = new Date(),
) {
  const values = policyUpdateSchema.parse(input);
  if (state.policy.version !== values.expectedVersion)
    throw new ApiError(
      409,
      "BUDGET_VERSION_CONFLICT",
      "The budget policy changed. Refresh before saving.",
      { currentVersion: state.policy.version },
    );
  const before = structuredClone(state.policy);
  const { expectedVersion, ...patch } = values;
  state.policy = {
    ...state.policy,
    ...patch,
    version: expectedVersion + 1,
    updatedAt: now.toISOString(),
    updatedBy: actorId,
  };
  audit(
    state,
    actorId,
    "policy.updated",
    { before, after: structuredClone(state.policy) },
    now,
  );
  return budgetDashboard(state, now);
}
export function recordBudgetAdjustment(
  state: BudgetState,
  input: BudgetAdjustmentInput,
  actorId: string,
  now = new Date(),
) {
  const values = adjustmentSchema.parse(input);
  const existing = state.adjustments.find(
    (a) => a.idempotencyKey === values.idempotencyKey,
  );
  if (existing) {
    if (
      existing.actorId !== actorId ||
      existing.amountCents !== values.amountCents ||
      existing.category !== values.category ||
      existing.reason !== values.reason
    )
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This cost-entry key was already used for different values.",
      );
    return budgetDashboard(state, now);
  }
  const totals = budgetDashboard(state, now).totals;
  const previous =
    values.category === "fixed"
      ? totals.recordedFixedCents
      : totals.recordedVariableCents;
  if (previous + values.amountCents < 0)
    throw new ApiError(
      422,
      "NEGATIVE_RECORDED_SPEND",
      "A correction cannot reduce this month’s recorded cost category below zero.",
    );
  const entry = {
    ...values,
    id: randomUUID(),
    actorId,
    period: budgetPeriod(now),
    createdAt: now.toISOString(),
  };
  state.adjustments.push(entry);
  audit(
    state,
    actorId,
    "cost.recorded",
    {
      adjustmentId: entry.id,
      amountCents: entry.amountCents,
      category: entry.category,
      reason: entry.reason,
      period: entry.period,
    },
    now,
  );
  return budgetDashboard(state, now);
}
function reservationById(state: BudgetState, id: string) {
  const reservation = state.reservations.find((r) => r.id === id);
  if (!reservation)
    throw new ApiError(
      404,
      "RESERVATION_NOT_FOUND",
      "The cost reservation was not found.",
    );
  return reservation;
}
function requireAdmission(
  state: BudgetState,
  requestedCents: number,
  now: Date,
) {
  const dashboard = budgetDashboard(state, now);
  if (state.policy.paidOperationsPaused)
    throw new ApiError(
      503,
      "PAID_OPERATIONS_PAUSED",
      "Paid operations are paused by the platform administrator.",
    );
  assertBudgetCostEvidence(state, now);
  if (requestedCents > dashboard.totals.availableCents)
    throw new ApiError(
      429,
      "OPERATING_BUDGET_EXCEEDED",
      "This operation would exceed the platform’s available monthly operating budget.",
      {
        availableCents: dashboard.totals.availableCents,
        requestedCents,
        period: dashboard.period,
      },
    );
}

/** Trusted server adapter only. Never accept estimates or settlement amounts from an ordinary browser request. */
export class BudgetService {
  constructor(
    private store: Store,
    private clock: () => Date = () => new Date(),
  ) {}
  reserve(input: ReserveCostInput): Promise<BudgetReservation> {
    const values = reserveSchema.parse(input);
    const now = this.clock();
    return this.store.transaction(
      (data) => {
        const state = data.budget;
        expireReservations(state, now);
        const existing = state.reservations.find(
          (r) => r.idempotencyKey === values.idempotencyKey,
        );
        if (existing) {
          if (
            existing.provider !== values.provider ||
            existing.operation !== values.operation ||
            existing.actorId !== values.actorId ||
            existing.maximumCents !== values.maximumCents
          )
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This reservation key was already used for a different operation.",
            );
          return existing;
        }
        requireAdmission(state, values.maximumCents, now);
        const { ttlSeconds, ...cost } = values;
        const reservation: BudgetReservation = {
          ...cost,
          id: randomUUID(),
          period: budgetPeriod(now),
          status: "reserved",
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        };
        state.reservations.push(reservation);
        audit(
          state,
          values.actorId,
          "reservation.created",
          {
            reservationId: reservation.id,
            maximumCents: values.maximumCents,
            provider: values.provider,
            operation: values.operation,
          },
          now,
        );
        return reservation;
      },
      { security: { mode: "worker", purpose: "budget" }, budget: true },
    );
  }
  /** Call once, immediately before external dispatch. A second start is rejected to prevent duplicate external work. */
  start(id: string): Promise<BudgetReservation> {
    const now = this.clock();
    return this.store.transaction(
      (data) => {
        const state = data.budget;
        expireReservations(state, now);
        const reservation = reservationById(state, id);
        if (reservation.status !== "reserved")
          throw new ApiError(
            409,
            "RESERVATION_NOT_DISPATCHABLE",
            "This reservation has already started, finished, or expired. Do not dispatch it again.",
          );
        assertBudgetCostEvidence(state, now);
        // Existing hold counts in available funds. A newly lowered ceiling may invalidate an unstarted job.
        const dashboard = budgetDashboard(state, now);
        if (
          state.policy.paidOperationsPaused ||
          dashboard.totals.accountedCents > dashboard.totals.operatingLimitCents
        )
          throw new ApiError(
            503,
            "RESERVATION_PAUSED",
            "This operation cannot start under the current budget policy.",
          );
        reservation.status = "running";
        reservation.startedAt = now.toISOString();
        audit(
          state,
          reservation.actorId,
          "reservation.started",
          { reservationId: id },
          now,
        );
        return reservation;
      },
      { security: { mode: "worker", purpose: "budget" }, budget: true },
    );
  }
  /** Reconcile the actual provider charge, including overruns. Settlement never hides debt or rejects real spend. */
  settle(id: string, actualCents: number): Promise<BudgetReservation> {
    cents.parse(actualCents);
    const now = this.clock();
    return this.store.transaction(
      (data) => {
        const state = data.budget;
        const reservation = reservationById(state, id);
        if (reservation.status === "settled") {
          if (reservation.actualCents !== actualCents)
            throw new ApiError(
              409,
              "SETTLEMENT_CONFLICT",
              "This reservation was settled with a different actual charge. Record an audited correction instead.",
            );
          return reservation;
        }
        if (reservation.status !== "running")
          throw new ApiError(
            409,
            "RESERVATION_NOT_RUNNING",
            "Only dispatched work may be settled.",
          );
        reservation.status = "settled";
        reservation.actualCents = actualCents;
        reservation.settledAt = now.toISOString();
        reservation.settledPeriod = budgetPeriod(now);
        const overrun = actualCents > reservation.maximumCents;
        // A broken upper-bound estimate disables further paid dispatch until an administrator reviews it.
        if (overrun && !state.policy.paidOperationsPaused) {
          state.policy = {
            ...state.policy,
            paidOperationsPaused: true,
            version: state.policy.version + 1,
            updatedAt: now.toISOString(),
            updatedBy: "system",
          };
        }
        audit(
          state,
          reservation.actorId,
          "reservation.settled",
          {
            reservationId: id,
            actualCents,
            maximumCents: reservation.maximumCents,
            period: reservation.settledPeriod,
            overrun,
          },
          now,
        );
        return reservation;
      },
      { security: { mode: "worker", purpose: "budget" }, budget: true },
    );
  }
  /** For running work, call only after confirming the provider will not charge; otherwise settle the charge. */
  release(
    id: string,
    reason: string,
    actorId = "system",
  ): Promise<BudgetReservation> {
    label.parse(reason);
    label.parse(actorId);
    const now = this.clock();
    return this.store.transaction(
      (data) => {
        const state = data.budget;
        const reservation = reservationById(state, id);
        if (
          reservation.status === "released" ||
          reservation.status === "expired"
        )
          return reservation;
        if (reservation.status === "settled")
          throw new ApiError(
            409,
            "RESERVATION_SETTLED",
            "A settled charge cannot be released. Record an audited correction instead.",
          );
        reservation.status = "released";
        reservation.releasedAt = now.toISOString();
        reservation.releaseReason = reason;
        audit(
          state,
          actorId,
          "reservation.released",
          { reservationId: id, reason },
          now,
        );
        return reservation;
      },
      { security: { mode: "worker", purpose: "budget" }, budget: true },
    );
  }
}
