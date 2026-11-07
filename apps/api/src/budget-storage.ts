import {
  canonicalJSON,
  type BudgetState,
  createBudgetCostReview,
  budgetKnownAccounting,
} from "@urban/core";
import type { StoreChanges } from "./storage-core.js";
import type { StoreScope } from "./store-scope.js";
import { assertBudgetCostEvidence, budgetDashboard } from "./budget.js";

/** SQLite parity. Operator migrations are explicit; scoped requests cannot rewrite cost history. */
export function assertBudgetStorageChanges(
  changes: StoreChanges,
  scope: StoreScope | undefined,
  previous: () => BudgetState,
) {
  if (!scope) return;
  const row = changes.upserts.find((r) => r.collection === "budget");
  if (!row) return;
  const old = previous(),
    next = row.header as unknown as BudgetState;
  const same = (a: unknown, b: unknown) =>
    canonicalJSON(a ?? null) === canonicalJSON(b ?? null);
  const without = (value: object, keys: string[]) =>
    Object.fromEntries(
      Object.entries(value).filter(([k]) => !keys.includes(k)),
    );
  function fail(message: string): never {
    throw new Error(`Budget storage: ${message}`);
  }
  const prior = old.costReviews ?? [],
    reviews = next.costReviews ?? [];
  if (
    !Array.isArray(reviews) ||
    reviews.length < prior.length ||
    reviews.length > prior.length + 1 ||
    !same(reviews.slice(0, prior.length), prior)
  )
    fail("cost reviews are immutable and append-only");
  if (!same(next.audit.slice(0, old.audit.length), old.audit))
    fail("existing audit entries are immutable");
  if (
    !same(next.adjustments.slice(0, old.adjustments.length), old.adjustments) ||
    next.adjustments.length > old.adjustments.length + 1
  )
    fail("manual ledger entries are immutable and append-only");
  if (next.adjustments.length > old.adjustments.length) {
    const entry = next.adjustments.at(-1)!;
    if (
      ![entry.id, entry.idempotencyKey, entry.actorId, entry.createdAt].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 240,
      ) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        entry.id,
      ) ||
      !Number.isFinite(Date.parse(entry.createdAt))
    )
      fail("manual cost identity and creation time are required");
    if (
      old.adjustments.some(
        (a) => a.id === entry.id || a.idempotencyKey === entry.idempotencyKey,
      ) ||
      !Number.isSafeInteger(entry.amountCents) ||
      entry.amountCents === 0 ||
      Math.abs(entry.amountCents) > 100_000_000 ||
      !["fixed", "variable"].includes(entry.category) ||
      entry.period !== new Date().toISOString().slice(0, 7) ||
      !entry.reason ||
      entry.reason.trim().length < 5
    )
      fail("invalid manual cost correction");
    budgetKnownAccounting(next);
  }
  if (scope.security && !same(next.costReviews, old.costReviews))
    fail("workers and auth capabilities cannot create or replace cost reviews");
  if (reviews.length > prior.length) {
    const review = reviews.at(-1)!;
    if (
      prior.some(
        (r) => r.id === review.id || r.idempotencyKey === review.idempotencyKey,
      )
    )
      fail("cost review identities are unique");
    const expected = createBudgetCostReview(
      { ...next, costReviews: prior },
      {
        idempotencyKey: review.idempotencyKey,
        expectedBasisHash: review.basisHash,
        coveredThrough: review.coveredThrough,
        expiresAt: review.expiresAt,
        estimatedUnreportedCents: review.estimatedUnreportedCents,
        futureVariable: review.futureVariable,
        scopeStatement: review.scopeStatement,
        replacesReviewId: review.replacesReviewId,
        includesPriorUnreported: review.includesPriorUnreported,
      },
      {
        id: review.id,
        actorId: review.actorId,
        now: new Date(review.createdAt),
      },
    );
    if (
      Math.abs(Date.now() - Date.parse(review.createdAt)) > 60_000 ||
      Date.parse(review.expiresAt) <= Date.now() ||
      !same(expected, review)
    )
      fail("review must bind the exact current accounting basis");
  }
  const worker =
    scope.security?.mode === "worker" &&
    ["budget", "identity-mail"].includes(scope.security.purpose);
  if (scope.security && !worker)
    fail("this capability cannot mutate the budget");
  if (worker) {
    if (
      !same(
        without(next, ["reservations", "audit", "policy"]),
        without(old, ["reservations", "audit", "policy"]),
      )
    )
      fail("workers cannot change manual ledger or budget metadata");
    if (!same(next.policy, old.policy)) {
      const {
        paidOperationsPaused: oldPause,
        version: oldVersion,
        updatedAt: _oldAt,
        updatedBy: _oldBy,
        ...oldPolicy
      } = old.policy;
      const {
        paidOperationsPaused: nextPause,
        version: nextVersion,
        updatedAt: _nextAt,
        updatedBy: nextBy,
        ...nextPolicy
      } = next.policy;
      if (
        scope.security?.purpose !== "budget" ||
        !same(oldPolicy, nextPolicy) ||
        oldPause ||
        !nextPause ||
        nextVersion !== oldVersion + 1 ||
        nextBy !== "system" ||
        !next.reservations.some(
          (r) =>
            r.status === "settled" &&
            r.actualCents! > r.maximumCents &&
            old.reservations.some(
              (p) => p.id === r.id && p.status === "running",
            ),
        )
      )
        fail("workers may only pause policy after an actual overrun");
    }
    if (
      next.audit
        .slice(old.audit.length)
        .some((a) =>
          ["cost-review.recorded", "budget.alerts.observed"].includes(a.action),
        )
    )
      fail("workers cannot author administrator review or alert observations");
  }
  if (
    new Set(next.reservations.map((r) => r.id)).size !==
      next.reservations.length ||
    !same(
      next.reservations.slice(0, old.reservations.length).map((r) => r.id),
      old.reservations.map((r) => r.id),
    ) ||
    next.reservations.length > old.reservations.length + 1
  )
    fail("reservation identities cannot be erased, reordered or duplicated");
  let admitting = false;
  for (const r of next.reservations) {
    const p = old.reservations.find((p) => p.id === r.id);
    if (same(p, r)) continue;
    if (!p) {
      if (
        !worker ||
        r.status !== "reserved" ||
        !Number.isSafeInteger(r.maximumCents) ||
        r.maximumCents <= 0 ||
        r.maximumCents > 100_000_000 ||
        r.period !== new Date().toISOString().slice(0, 7) ||
        !Number.isFinite(Date.parse(r.createdAt)) ||
        Math.abs(Date.now() - Date.parse(r.createdAt)) > 60_000 ||
        Date.parse(r.expiresAt) <= Date.now() ||
        Date.parse(r.expiresAt) > Date.parse(r.createdAt) + 3600000 ||
        [
          r.startedAt,
          r.settledAt,
          r.settledPeriod,
          r.actualCents,
          r.releasedAt,
          r.releaseReason,
        ].some((v) => v !== undefined)
      )
        fail("new costs require a bounded undispatched reservation");
    } else {
      const fields =
        r.status === "running"
          ? ["status", "startedAt"]
          : r.status === "settled"
            ? ["status", "settledAt", "settledPeriod", "actualCents"]
            : ["status", "releasedAt", "releaseReason"];
      if (
        !same(without(p, fields), without(r, fields)) ||
        !["reserved", "running"].includes(p.status)
      )
        fail("reservation evidence and terminal costs are immutable");
      if (r.status === "running") {
        if (
          !worker ||
          p.status !== "reserved" ||
          Date.parse(p.expiresAt) <= Date.now() ||
          !Number.isFinite(Date.parse(r.startedAt!))
        )
          fail("only an unexpired reservation may start");
      } else if (r.status === "settled") {
        if (
          scope.security?.purpose !== "budget" ||
          p.status !== "running" ||
          !Number.isSafeInteger(r.actualCents) ||
          r.actualCents! < 0 ||
          r.actualCents! > 100_000_000 ||
          r.settledPeriod !== new Date().toISOString().slice(0, 7) ||
          !Number.isFinite(Date.parse(r.settledAt!)) ||
          (r.actualCents! > r.maximumCents && !next.policy.paidOperationsPaused)
        )
          fail("settlement must retain actual costs and pause on overruns");
      } else if (r.status === "expired") {
        if (
          p.status !== "reserved" ||
          Date.parse(p.expiresAt) > Date.now() ||
          !r.releaseReason ||
          !Number.isFinite(Date.parse(r.releasedAt!))
        )
          fail("only undispatched expired holds may expire");
      } else if (r.status === "released") {
        if (
          !worker ||
          !r.releaseReason ||
          !Number.isFinite(Date.parse(r.releasedAt!))
        )
          fail("release requires trusted no-charge confirmation");
      } else fail("invalid reservation transition");
    }
    admitting ||= r.status === "reserved" || r.status === "running";
  }
  if (admitting) {
    assertBudgetCostEvidence(next);
    const dashboard = budgetDashboard(next);
    if (
      next.policy.paidOperationsPaused ||
      dashboard.totals.accountedCents > dashboard.totals.operatingLimitCents
    )
      fail("admission exceeds reviewed operating headroom");
  }
}
