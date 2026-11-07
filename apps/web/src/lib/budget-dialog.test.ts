import { describe, expect, it, vi } from "vitest";
import type { BudgetPolicy } from "@urban/core";
import {
  budgetAdministratorScope,
  budgetPolicyConflict,
  budgetPolicyDirty,
  createBudgetPolicyDraft,
  createBudgetRequestScope,
  keepBudgetPolicyEdits,
  readBudgetPolicyDraft,
  receiveBudgetPolicy,
} from "./budget-dialog";

const original: BudgetPolicy = {
  version: 1,
  currency: "USD",
  monthlyLimitCents: 30000,
  safetyMarginCents: 3000,
  fixedCostReserveCents: 5000,
  paidOperationsPaused: true,
  updatedAt: null,
  updatedBy: null,
};
const changed: BudgetPolicy = {
  ...original,
  version: 2,
  monthlyLimitCents: 40000,
  fixedCostReserveCents: 7000,
  updatedAt: "2026-11-06T20:00:00.000Z",
  updatedBy: "another-admin",
};

describe("budget policy draft reconciliation", () => {
  it("preserves dirty and invalid raw values when a ledger refresh or cost receipt includes a new policy", () => {
    const draft = createBudgetPolicyDraft(original);
    draft.fields = { limit: "350", margin: "", fixed: "65.999", paused: false };
    const refreshed = receiveBudgetPolicy(draft, changed);
    expect(refreshed.fields).toEqual(draft.fields);
    expect(refreshed.base).toEqual(original);
    expect(refreshed.latest).toEqual(changed);
    expect(budgetPolicyConflict(refreshed)).toBe(true);
    expect(() => readBudgetPolicyDraft(refreshed)).toThrow(
      "Review the current saved settings",
    );
  });

  it("requires explicit review before retaining edits against a new saved version", () => {
    const draft = createBudgetPolicyDraft(original);
    draft.fields.limit = "350.00";
    const received = receiveBudgetPolicy(draft, changed);
    const reviewed = keepBudgetPolicyEdits(received);
    expect(budgetPolicyConflict(reviewed)).toBe(false);
    expect(budgetPolicyDirty(reviewed)).toBe(true);
    expect(readBudgetPolicyDraft(reviewed)).toEqual({
      expectedVersion: 2,
      monthlyLimitCents: 35000,
      safetyMarginCents: 3000,
      fixedCostReserveCents: 5000,
      paidOperationsPaused: true,
    });
    // Choosing the alternative explicitly discards the draft and loads current settings.
    const reloaded = createBudgetPolicyDraft(received.latest);
    expect(reloaded.fields).toEqual({
      limit: "400.00",
      margin: "30.00",
      fixed: "70.00",
      paused: true,
    });
    expect(budgetPolicyDirty(reloaded)).toBe(false);
    expect(draft.base).toEqual(original);
  });

  it("updates untouched settings but retains dirty settings for a same-version cost response", () => {
    expect(
      receiveBudgetPolicy(createBudgetPolicyDraft(original), changed),
    ).toEqual(createBudgetPolicyDraft(changed));
    const draft = createBudgetPolicyDraft(original);
    draft.fields.limit = "";
    const received = receiveBudgetPolicy(draft, { ...original });
    expect(received.fields.limit).toBe("");
    expect(budgetPolicyConflict(received)).toBe(false);
    expect(() => readBudgetPolicyDraft(received)).toThrow(
      "Monthly ceiling must be a dollar amount",
    );
  });

  it("does not downgrade an already reviewed version on a stale response", () => {
    const draft = createBudgetPolicyDraft(changed);
    draft.fields.fixed = "80.00";
    expect(receiveBudgetPolicy(draft, original)).toBe(draft);
    expect(readBudgetPolicyDraft(draft).expectedVersion).toBe(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("private budget account scope", () => {
  it("requires both a live user and platform admin authority, with different users creating different scopes", () => {
    expect(
      budgetAdministratorScope({ user: null, platformAdmin: true }),
    ).toBeNull();
    expect(
      budgetAdministratorScope({ user: { id: "admin" }, platformAdmin: false }),
    ).toBeNull();
    expect(budgetAdministratorScope({ user: { id: "owner" } })).toBeNull();
    expect(
      budgetAdministratorScope({
        user: { id: "admin-a" },
        platformAdmin: true,
      }),
    ).toBe("admin-a");
    expect(
      budgetAdministratorScope({
        user: { id: "admin-b" },
        platformAdmin: true,
      }),
    ).toBe("admin-b");
  });

  it("aborts a deferred private read and ignores all late callbacks after permission loss or unmount", async () => {
    const old = createBudgetRequestScope();
    const body = deferred<string>();
    const apply = vi.fn(),
      fail = vi.fn(),
      finish = vi.fn();
    let oldSignal!: AbortSignal;
    const request = old.run(
      (signal) => {
        oldSignal = signal;
        return body.promise;
      },
      apply,
      fail,
      finish,
    );
    old.dispose();
    expect(oldSignal.aborted).toBe(true);
    const next = createBudgetRequestScope();
    const currentApply = vi.fn();
    await next.run(async () => "new account", currentApply, fail, vi.fn());
    body.resolve("old private ledger");
    await request;
    expect(currentApply).toHaveBeenCalledWith("new account");
    expect(apply).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(await old.run(async () => "reopened", apply, fail, finish)).toBe(
      false,
    );
  });

  it("ignores late mutation failures after close and serializes refresh with a pending save", async () => {
    const scope = createBudgetRequestScope();
    const save = deferred<string>();
    const apply = vi.fn(),
      fail = vi.fn(),
      finish = vi.fn(),
      refresh = vi.fn(async () => "refresh");
    const pending = scope.run(() => save.promise, apply, fail, finish);
    expect(await scope.run(refresh, apply, fail, finish)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    scope.dispose();
    save.reject(new Error("late transport response"));
    await pending;
    expect(apply).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("finishes a live response once and allows a later explicit refresh", async () => {
    const scope = createBudgetRequestScope();
    const apply = vi.fn(),
      fail = vi.fn(),
      finish = vi.fn();
    await scope.run(async () => original, apply, fail, finish);
    expect(scope.pending).toBe(false);
    await scope.run(async () => changed, apply, fail, finish);
    expect(apply.mock.calls).toEqual([[original], [changed]]);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(fail).not.toHaveBeenCalled();
  });
});
