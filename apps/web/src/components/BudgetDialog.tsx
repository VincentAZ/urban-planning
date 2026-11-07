import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  CirclePause,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { BudgetCostReviewInput, BudgetDashboard } from "@urban/core";
import { api, ApiError } from "../lib/api";
import {
  budgetCents,
  budgetPolicyConflict,
  budgetPolicyDirty,
  createBudgetPolicyDraft,
  createBudgetRequestScope,
  keepBudgetPolicyEdits,
  readBudgetPolicyDraft,
  receiveBudgetPolicy,
  type BudgetPolicyDraft,
  type BudgetPolicyFields,
} from "../lib/budget-dialog";
import { Modal } from "./Modal";
import { BudgetOutlook } from "./BudgetOutlook";
import { BudgetReviewForm } from "./BudgetReviewForm";
import { BudgetRecords } from "./BudgetRecords";
import "./budget-dialog.css";

const currencyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const money = (cents: number) => currencyFormat.format(cents / 100);
export function BudgetDialog({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const [{ data, draft }, setState] = useState<{
    data: BudgetDashboard | null;
    draft: BudgetPolicyDraft | null;
  }>({ data: null, draft: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"policy" | "cost" | "review" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [policyConflict, setPolicyConflict] = useState(false);
  const [reviewExpired, setReviewExpired] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const requestScope = useRef<ReturnType<
    typeof createBudgetRequestScope
  > | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const reviewAttempt = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  const costAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const receive = useCallback((data: BudgetDashboard) => {
    setState((current) => ({
      data,
      draft: receiveBudgetPolicy(current.draft, data.policy),
    }));
  }, []);
  const requestFailed = useCallback((error: unknown) => {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      requestScope.current?.dispose();
      setState({ data: null, draft: null });
      costAttempt.current = null;
      reviewAttempt.current = null;
      closeRef.current();
      return;
    }
    if (error instanceof ApiError && error.code === "BUDGET_VERSION_CONFLICT")
      setPolicyConflict(true);
    setError(
      error instanceof Error
        ? error.message
        : "The budget request could not be completed.",
    );
  }, []);
  useEffect(() => {
    const scope = createBudgetRequestScope();
    requestScope.current = scope;
    setState({ data: null, draft: null });
    setLoading(true);
    setBusy(null);
    setPolicyConflict(false);
    costAttempt.current = null;
    reviewAttempt.current = null;
    void scope.run(
      (signal) =>
        api<BudgetDashboard>("/admin/budget", { signal, cache: "no-store" }),
      receive,
      requestFailed,
      () => setLoading(false),
    );
    return () => {
      scope.dispose();
      if (requestScope.current === scope) requestScope.current = null;
    };
  }, [accountId, receive, requestFailed]);

  function close() {
    requestScope.current?.dispose();
    onClose();
  }
  async function refresh() {
    const scope = requestScope.current;
    if (!scope || scope.pending) return;
    setLoading(true);
    setError("");
    setMessage("");
    await scope.run(
      (signal) =>
        api<BudgetDashboard>("/admin/budget", { signal, cache: "no-store" }),
      (next) => {
        receive(next);
        setPolicyConflict(false);
      },
      requestFailed,
      () => setLoading(false),
    );
  }
  refreshRef.current = () => {
    void refresh();
  };
  useEffect(() => {
    const focus = () => {
      if (document.visibilityState !== "hidden") refreshRef.current();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, []);
  useEffect(() => {
    setReviewExpired(false);
    if (
      data?.outlook?.review.status !== "fresh" ||
      !data.outlook.review.expiresAt
    )
      return;
    // Use the server's time delta, not a potentially skewed browser wall clock.
    const remaining = Math.max(
      0,
      Date.parse(data.outlook.review.expiresAt) - Date.parse(data.outlook.asOf),
    );
    const timer = setTimeout(() => {
      setReviewExpired(true);
      refreshRef.current();
    }, remaining);
    return () => clearTimeout(timer);
  }, [
    data?.outlook?.asOf,
    data?.outlook?.review.status,
    data?.outlook?.review.expiresAt,
  ]);
  function editPolicy<K extends keyof BudgetPolicyFields>(
    key: K,
    value: BudgetPolicyFields[K],
  ) {
    setState((current) =>
      current.draft
        ? {
            ...current,
            draft: {
              ...current.draft,
              fields: { ...current.draft.fields, [key]: value },
            },
          }
        : current,
    );
  }
  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = requestScope.current;
    if (!draft || !scope || scope.pending || policyConflict) return;
    setError("");
    setMessage("");
    let payload;
    try {
      payload = readBudgetPolicyDraft(draft);
    } catch (error) {
      requestFailed(error);
      return;
    }
    setBusy("policy");
    await scope.run(
      (signal) =>
        api<BudgetDashboard>("/admin/budget", {
          method: "PATCH",
          body: JSON.stringify(payload),
          signal,
        }),
      (updated) => {
        setState({
          data: updated,
          draft: createBudgetPolicyDraft(updated.policy),
        });
        setPolicyConflict(false);
        setMessage(
          `Operating budget saved at ${money(updated.policy.monthlyLimitCents)} per month.`,
        );
      },
      requestFailed,
      () => setBusy(null),
    );
  }
  async function recordCost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = requestScope.current;
    if (!scope || scope.pending) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setError("");
    setMessage("");
    let payload;
    try {
      payload = {
        amountCents: budgetCents(
          String(fields.get("amount") ?? ""),
          "Recorded cost",
        ),
        category: fields.get("category"),
        reason: String(fields.get("reason") ?? "").trim(),
      };
      if (payload.amountCents === 0)
        throw new Error("Enter a nonzero cost or correction amount.");
    } catch (error) {
      requestFailed(error);
      return;
    }
    const fingerprint = JSON.stringify(payload);
    if (costAttempt.current?.fingerprint !== fingerprint)
      costAttempt.current = { fingerprint, key: crypto.randomUUID() };
    const idempotencyKey = costAttempt.current.key;
    setBusy("cost");
    await scope.run(
      (signal) =>
        api<BudgetDashboard>("/admin/budget/adjustments", {
          method: "POST",
          body: JSON.stringify({ ...payload, idempotencyKey }),
          signal,
        }),
      (updated) => {
        receive(updated);
        costAttempt.current = null;
        form.reset();
        setMessage(
          "Cost entry recorded. The available job budget has been updated.",
        );
      },
      requestFailed,
      () => setBusy(null),
    );
  }

  async function saveCostReview(
    input: Omit<BudgetCostReviewInput, "idempotencyKey">,
  ): Promise<BudgetDashboard | null> {
    const scope = requestScope.current;
    if (!scope || scope.pending) return null;
    const fingerprint = JSON.stringify(input);
    if (reviewAttempt.current?.fingerprint !== fingerprint)
      reviewAttempt.current = { fingerprint, key: crypto.randomUUID() };
    const idempotencyKey = reviewAttempt.current.key;
    setBusy("review");
    setError("");
    setMessage("");
    let result: BudgetDashboard | null = null;
    await scope.run(
      (signal) =>
        api<BudgetDashboard>("/admin/budget/reviews", {
          method: "POST",
          body: JSON.stringify({ ...input, idempotencyKey }),
          signal,
        }),
      (updated) => {
        receive(updated);
        result = updated;
        reviewAttempt.current = null;
        setMessage(
          "Cost review saved. The outlook and held estimate now use this review.",
        );
      },
      requestFailed,
      () => setBusy(null),
    );
    return result;
  }

  const totals = data?.totals;
  const usedFraction =
    totals && totals.operatingLimitCents > 0
      ? totals.accountedCents / totals.operatingLimitCents
      : 1;
  const reviewRequired =
    reviewExpired || !data?.outlook || data.outlook.review.status !== "fresh";
  const historyRevision = data
    ? [
        data.policy.version,
        data.outlook?.basisHash,
        data.outlook?.review.reviewId,
        data.audit[0]?.id,
      ].join(":")
    : "";
  return (
    <Modal
      title="Operating budget"
      description="Private platform administrator controls · All user features remain free."
      wide
      open
      onClose={close}
    >
      <div className="budget-dialog" aria-busy={loading || !!busy}>
        {loading && !data ? (
          <div className="budget-loading" role="status">
            <Loader2 className="spin" size={20} /> Loading budget controls…
          </div>
        ) : null}
        {error && (
          <p className="budget-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="budget-message" role="status">
            {message}
          </p>
        )}
        {data && totals && draft && (
          <>
            <div className="budget-intro">
              <div>
                <h3>Free for everyone. Sustainable for you.</h3>
                <p>
                  Control the service-wide operating allowance for {data.period}{" "}
                  (UTC). A new ceiling applies immediately and continues in
                  future months.
                </p>
              </div>
              <span
                className={`budget-state ${data.admission.allowed && !reviewRequired ? "ready" : ""}`}
              >
                {data.admission.allowed && !reviewRequired ? (
                  <Wallet size={15} />
                ) : (
                  <CirclePause size={15} />
                )}
                {data.admission.reason === "paused"
                  ? "Paid work paused"
                  : data.admission.reason === "budget_exhausted"
                    ? "New paid work on hold"
                    : reviewRequired
                      ? "Cost review required"
                      : data.admission.allowed
                        ? "Budget capacity available"
                        : "New paid work on hold"}
              </span>
            </div>
            <div className="budget-stats">
              <div className="budget-stat">
                <span>Monthly ceiling</span>
                <strong>{money(totals.limitCents)}</strong>
                <small>Hosting, data, AI & processing</small>
              </div>
              <div className="budget-stat">
                <span>Recorded costs</span>
                <strong>{money(totals.recordedSpendCents)}</strong>
                <small>Ledger entries, not a live provider bill</small>
              </div>
              <div className="budget-stat">
                <span>Reserved & committed</span>
                <strong>
                  {money(
                    totals.unspentFixedReserveCents + totals.reservedCents,
                  )}
                </strong>
                <small>Fixed allowance + in-flight work</small>
              </div>
              <div className="budget-stat highlight">
                <span>Available after buffer</span>
                <strong>{money(totals.availableCents)}</strong>
                <small>
                  {reviewRequired
                    ? "Headroom; a current cost review is also required"
                    : "Capacity for metered jobs"}
                </small>
              </div>
            </div>
            <progress
              className="budget-meter"
              aria-label="Accounted costs against the monthly operating allowance"
              max={Math.max(1, totals.operatingLimitCents)}
              value={Math.min(
                totals.accountedCents,
                Math.max(1, totals.operatingLimitCents),
              )}
            />
            <p className="budget-meter-label">
              {money(totals.accountedCents)} accounted for within a{" "}
              {money(totals.operatingLimitCents)} operating allowance.{" "}
              {money(totals.safetyMarginCents)} is held as a safety buffer.
            </p>
            {totals.overLimitCents > 0 ? (
              <div className="budget-alert" role="alert">
                <AlertTriangle size={17} />
                <span>
                  Recorded costs and commitments exceed the monthly ceiling by{" "}
                  {money(totals.overLimitCents)}. New paid work stays on hold;
                  reducing the ceiling does not erase charges already incurred.
                </span>
              </div>
            ) : usedFraction >= 0.7 ? (
              <div className="budget-alert" role="status">
                <AlertTriangle size={17} />
                <span>
                  {usedFraction >= 0.85
                    ? "The operating allowance is nearly committed."
                    : "More than 70% of the operating allowance is committed."}{" "}
                  Review fixed costs and reservations before enabling more paid
                  work.
                </span>
              </div>
            ) : null}
            <div className="budget-coverage">
              <strong>Provider billing is not connected.</strong>
              <p>
                Actual external spending is unknown. This dashboard tracks
                manually recorded costs and integrated job reservations; it
                cannot stop charges made outside those integrations. Basic
                exploration and local calculations remain available.
              </p>
              <p>
                Billing can arrive late. Keep a buffer and configure provider
                limits before enabling paid services.
              </p>
              <dl className="budget-breakdown">
                <div>
                  <dt>Recorded fixed costs</dt>
                  <dd>{money(totals.recordedFixedCents)}</dd>
                </div>
                <div>
                  <dt>Recorded variable costs</dt>
                  <dd>{money(totals.recordedVariableCents)}</dd>
                </div>
                <div>
                  <dt>Open job reservations</dt>
                  <dd>{money(totals.reservedCents)}</dd>
                </div>
              </dl>
            </div>
            <BudgetOutlook data={data} expiredSinceSnapshot={reviewExpired} />
            {data.outlook && (
              <BudgetReviewForm
                data={data}
                busy={!!busy || loading}
                snapshotStale={reviewExpired}
                onSubmit={saveCostReview}
              />
            )}
            <section
              className="budget-section"
              aria-labelledby="budget-settings-heading"
            >
              <h3 id="budget-settings-heading">Your monthly guardrails</h3>
              <p>
                Only platform administrators can change these settings. Every
                change is retained in the budget audit history.
              </p>
              {(policyConflict || budgetPolicyConflict(draft)) && (
                <div className="budget-conflict" role="status">
                  <strong>
                    Budget settings changed while you were editing.
                  </strong>
                  <p>
                    Your entered values are preserved.{" "}
                    {budgetPolicyConflict(draft)
                      ? "Review the current saved settings below before choosing which values to save."
                      : "Refresh to review the current saved settings before saving."}
                  </p>
                  {budgetPolicyConflict(draft) && (
                    <>
                      <p>
                        Current saved version {draft.latest.version}: ceiling{" "}
                        {money(draft.latest.monthlyLimitCents)}, buffer{" "}
                        {money(draft.latest.safetyMarginCents)}, fixed reserve{" "}
                        {money(draft.latest.fixedCostReserveCents)}; paid
                        operations{" "}
                        {draft.latest.paidOperationsPaused
                          ? "paused"
                          : "not paused"}
                        .
                      </p>
                      <div className="budget-actions">
                        <button
                          className="button"
                          type="button"
                          disabled={!!busy || loading}
                          onClick={() => {
                            setState((current) =>
                              current.draft
                                ? {
                                    ...current,
                                    draft: keepBudgetPolicyEdits(current.draft),
                                  }
                                : current,
                            );
                            setPolicyConflict(false);
                            setError("");
                            setMessage(
                              "Your values are ready for review against the current settings. Save when ready.",
                            );
                          }}
                        >
                          Keep my values for review
                        </button>
                        <button
                          className="button"
                          type="button"
                          disabled={!!busy || loading}
                          onClick={() => {
                            setState((current) =>
                              current.draft
                                ? {
                                    ...current,
                                    draft: createBudgetPolicyDraft(
                                      current.draft.latest,
                                    ),
                                  }
                                : current,
                            );
                            setPolicyConflict(false);
                            setError("");
                            setMessage(
                              "Current saved settings loaded. Your previous edits were discarded.",
                            );
                          }}
                        >
                          Load current settings
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              <form onSubmit={savePolicy}>
                <fieldset
                  className="budget-form-fields"
                  disabled={!!busy || loading}
                >
                  <legend className="sr-only">Monthly budget settings</legend>
                  <div className="budget-fields">
                    <label className="field">
                      Monthly ceiling · USD
                      <input
                        name="limit"
                        aria-label="Monthly ceiling · USD"
                        aria-describedby="budget-limit-hint"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        value={draft.fields.limit}
                        onChange={(event) =>
                          editPolicy("limit", event.currentTarget.value)
                        }
                      />
                      <small id="budget-limit-hint">
                        Starts at $300; adjust as your operating budget changes.
                      </small>
                    </label>
                    <label className="field">
                      Safety buffer · USD
                      <input
                        name="margin"
                        aria-label="Safety buffer · USD"
                        aria-describedby="budget-margin-hint"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        value={draft.fields.margin}
                        onChange={(event) =>
                          editPolicy("margin", event.currentTarget.value)
                        }
                      />
                      <small id="budget-margin-hint">
                        Held outside the job allowance. This dollar amount stays
                        fixed when you change the ceiling.
                      </small>
                    </label>
                    <label className="field">
                      Fixed monthly reserve · USD
                      <input
                        name="fixed"
                        aria-label="Fixed monthly reserve · USD"
                        aria-describedby="budget-fixed-hint"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        value={draft.fields.fixed}
                        onChange={(event) =>
                          editPolicy("fixed", event.currentTarget.value)
                        }
                      />
                      <small id="budget-fixed-hint">
                        Expected hosting and license bills. Enter known
                        commitments; $0 does not mean hosting is free.
                      </small>
                    </label>
                  </div>
                  <label className="budget-toggle">
                    <input
                      type="checkbox"
                      name="paused"
                      checked={draft.fields.paused}
                      onChange={(event) =>
                        editPolicy("paused", event.currentTarget.checked)
                      }
                    />
                    <span>
                      Pause new paid operations
                      <small>
                        Existing commitments remain accounted for. Unpausing
                        grants budget capacity only; it does not configure or
                        purchase a service.
                      </small>
                    </span>
                  </label>
                  <div className="budget-actions">
                    <button
                      className="button primary"
                      disabled={
                        !!busy ||
                        loading ||
                        policyConflict ||
                        budgetPolicyConflict(draft) ||
                        !budgetPolicyDirty(draft)
                      }
                      type="submit"
                    >
                      {busy === "policy" ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Save size={15} />
                      )}{" "}
                      Save budget settings
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={!!busy || loading}
                      onClick={refresh}
                    >
                      <RefreshCw size={14} /> Refresh ledger
                    </button>
                  </div>
                </fieldset>
              </form>
            </section>
            <section
              className="budget-section"
              aria-labelledby="budget-cost-heading"
            >
              <h3 id="budget-cost-heading">Record a known cost</h3>
              <p>
                Add a bill already incurred this UTC month. Fixed-cost entries
                replace that portion of the fixed reserve, so it is not counted
                twice. Use a negative entry only to correct an earlier amount;
                explain the correction.
              </p>
              <form onSubmit={recordCost}>
                <fieldset
                  className="budget-form-fields"
                  disabled={!!busy || loading}
                >
                  <legend className="sr-only">Record a known cost</legend>
                  <div className="budget-cost-fields">
                    <label className="field">
                      Amount · USD
                      <input
                        name="amount"
                        type="number"
                        step="0.01"
                        required
                        placeholder="0.00"
                      />
                    </label>
                    <label className="field">
                      Cost category
                      <select name="category" defaultValue="fixed">
                        <option value="fixed">Fixed cost</option>
                        <option value="variable">Variable cost</option>
                      </select>
                    </label>
                    <label className="field">
                      Reason or bill reference
                      <input
                        name="reason"
                        required
                        minLength={5}
                        maxLength={500}
                        placeholder="November hosting invoice"
                      />
                    </label>
                  </div>
                  <div className="budget-actions">
                    <button
                      className="button"
                      type="submit"
                      disabled={!!busy || loading}
                    >
                      {busy === "cost" ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Wallet size={15} />
                      )}{" "}
                      Record cost entry
                    </button>
                  </div>
                </fieldset>
              </form>
            </section>
            <BudgetRecords
              key={`${accountId}:${historyRevision}`}
              accountId={accountId}
              disabled={!!busy || loading}
              onAccessError={requestFailed}
            />
            <p className="budget-footer">
              <ShieldCheck size={15} /> Platform administration is separate from
              project ownership. These controls never create a paid user tier.
            </p>
          </>
        )}
        {!loading && !data && (
          <button className="button" onClick={refresh}>
            <RefreshCw size={15} /> Retry
          </button>
        )}
      </div>
    </Modal>
  );
}
