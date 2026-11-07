import type { BudgetPolicy, BudgetPolicyUpdate } from "@urban/core";

export function budgetAdministratorScope(session: {
  user: { id: string } | null;
  platformAdmin?: boolean;
}) {
  return session.user && session.platformAdmin ? session.user.id : null;
}

export interface BudgetPolicyFields {
  limit: string;
  margin: string;
  fixed: string;
  paused: boolean;
}
export interface BudgetPolicyDraft {
  base: BudgetPolicy;
  latest: BudgetPolicy;
  fields: BudgetPolicyFields;
}
function policyFields(policy: BudgetPolicy): BudgetPolicyFields {
  return {
    limit: (policy.monthlyLimitCents / 100).toFixed(2),
    margin: (policy.safetyMarginCents / 100).toFixed(2),
    fixed: (policy.fixedCostReserveCents / 100).toFixed(2),
    paused: policy.paidOperationsPaused,
  };
}
export function createBudgetPolicyDraft(
  policy: BudgetPolicy,
): BudgetPolicyDraft {
  return { base: policy, latest: policy, fields: policyFields(policy) };
}
export function budgetPolicyDirty(draft: BudgetPolicyDraft) {
  const base = policyFields(draft.base);
  return (Object.keys(base) as (keyof BudgetPolicyFields)[]).some(
    (key) => draft.fields[key] !== base[key],
  );
}
export function budgetPolicyConflict(draft: BudgetPolicyDraft) {
  return draft.base.version !== draft.latest.version;
}
/** A ledger refresh must never erase raw, possibly invalid policy input. */
export function receiveBudgetPolicy(
  draft: BudgetPolicyDraft | null,
  policy: BudgetPolicy,
): BudgetPolicyDraft {
  if (!draft) return createBudgetPolicyDraft(policy);
  if (policy.version < draft.latest.version) return draft;
  if (!budgetPolicyDirty(draft)) return createBudgetPolicyDraft(policy);
  return { ...draft, latest: policy };
}
/** Explicit review acknowledges the latest saved version; it does not save. */
export function keepBudgetPolicyEdits(
  draft: BudgetPolicyDraft,
): BudgetPolicyDraft {
  return { ...draft, base: draft.latest };
}
export function budgetCents(rawValue: string, label: string) {
  const raw = rawValue.trim();
  const amount = Number(raw);
  const rounded = Math.round(amount * 100);
  if (
    !raw ||
    !Number.isFinite(amount) ||
    !Number.isSafeInteger(rounded) ||
    Math.abs(amount * 100 - rounded) > 0.00001
  )
    throw new Error(
      `${label} must be a dollar amount with at most two decimal places.`,
    );
  return rounded;
}
export function readBudgetPolicyDraft(
  draft: BudgetPolicyDraft,
): BudgetPolicyUpdate {
  if (budgetPolicyConflict(draft))
    throw new Error(
      "Review the current saved settings before saving your changes.",
    );
  return {
    expectedVersion: draft.base.version,
    monthlyLimitCents: budgetCents(draft.fields.limit, "Monthly ceiling"),
    safetyMarginCents: budgetCents(draft.fields.margin, "Safety buffer"),
    fixedCostReserveCents: budgetCents(
      draft.fields.fixed,
      "Fixed cost reserve",
    ),
    paidOperationsPaused: draft.fields.paused,
  };
}

/** One request at a time, with all completion callbacks bound to this mount. */
export function createBudgetRequestScope() {
  let disposed = false;
  let active: AbortController | null = null;
  return {
    get pending() {
      return active !== null;
    },
    dispose() {
      disposed = true;
      active?.abort();
      active = null;
    },
    async run<T>(
      request: (signal: AbortSignal) => Promise<T>,
      apply: (value: T) => void,
      fail: (error: unknown) => void,
      finish: () => void,
    ) {
      if (disposed || active) return false;
      const controller = new AbortController();
      active = controller;
      const current = () =>
        !disposed && active === controller && !controller.signal.aborted;
      try {
        const value = await request(controller.signal);
        if (current()) apply(value);
      } catch (error) {
        if (current()) fail(error);
      } finally {
        if (current()) {
          active = null;
          finish();
        }
      }
      return true;
    },
  };
}
