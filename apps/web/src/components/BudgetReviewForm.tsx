import { useState, type FormEvent } from "react";
import type { BudgetCostReviewInput, BudgetDashboard } from "@urban/core";
import {
  budgetReviewBasisChanged,
  createBudgetReviewDraft,
  readBudgetReviewDraft,
  reviewCurrentBudgetBasis,
  type BudgetReviewDraft,
} from "../lib/budget-review";
import { budgetMoney, budgetTime } from "./BudgetOutlook";

export function BudgetReviewForm({
  data,
  busy,
  snapshotStale = false,
  onSubmit,
}: {
  data: BudgetDashboard;
  busy: boolean;
  snapshotStale?: boolean;
  onSubmit: (
    review: Omit<BudgetCostReviewInput, "idempotencyKey">,
  ) => Promise<BudgetDashboard | null>;
}) {
  const [draft, setDraft] = useState(() => createBudgetReviewDraft(data));
  const [error, setError] = useState("");
  const [open, setOpen] = useState(data.outlook?.review.status !== "fresh");
  const changed = budgetReviewBasisChanged(draft, data);
  const edit = <K extends keyof BudgetReviewDraft>(
    key: K,
    value: BudgetReviewDraft[K],
  ) => setDraft((old) => ({ ...old, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || snapshotStale) return;
    setError("");
    try {
      const updated = await onSubmit(readBudgetReviewDraft(draft, data));
      if (updated) setDraft(createBudgetReviewDraft(updated));
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The cost review could not be submitted.",
      );
    }
  }
  return (
    <section className="budget-section">
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="budget-review-summary">
          Review costs and spending assumptions
        </summary>
        <p>
          A review records your evidence and assumptions. It does not connect
          billing, purchase services, or automatically unpause work.
        </p>
        <p>
          Estimate all incurred but unreported costs through this review,
          including costs since the covered-through time and unresolved amounts
          from prior reviews. Exclude recorded costs, the remaining fixed
          allowance, and every integrated job reservation or charge. Enter
          future spending separately, without repeating those amounts.
        </p>
        {error && (
          <p role="alert" className="budget-error">
            {error}
          </p>
        )}
        {changed && (
          <div className="budget-conflict" role="status">
            <strong>Accounting changed since this draft began.</strong>
            <p>
              Your values are preserved. Review the latest totals and held
              estimate, then acknowledge the current accounting before
              submitting.
            </p>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft((old) => reviewCurrentBudgetBasis(old, data));
                setError("");
              }}
            >
              Review current accounting
            </button>
          </div>
        )}
        <form onSubmit={submit}>
          <fieldset className="budget-form-fields" disabled={busy}>
            <legend className="sr-only">Cost evidence review</legend>
            <div className="budget-review-fields">
              <label className="field">
                Costs covered through · UTC
                <input
                  aria-label="Costs covered through · UTC"
                  type="datetime-local"
                  step="1"
                  required
                  value={draft.coveredThrough}
                  onChange={(event) =>
                    edit("coveredThrough", event.currentTarget.value)
                  }
                />
              </label>
              <label className="field">
                Review expires · UTC
                <input
                  aria-label="Review expires · UTC"
                  aria-describedby="budget-review-expiry-hint"
                  type="datetime-local"
                  step="1"
                  required
                  value={draft.expiresAt}
                  onChange={(event) =>
                    edit("expiresAt", event.currentTarget.value)
                  }
                />
                <small id="budget-review-expiry-hint">
                  Default 24 hours; at most 7 days after coverage and no later
                  than month-end.
                </small>
              </label>
            </div>
            <label className="field">
              Estimated unreported costs · USD
              <input
                aria-label="Estimated unreported costs · USD"
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                required
                value={draft.unreported}
                onChange={(event) =>
                  edit("unreported", event.currentTarget.value)
                }
              />
            </label>
            <div className="budget-fields">
              {(
                [
                  ["low", "Low future spending · USD"],
                  ["expected", "Expected future spending · USD"],
                  ["high", "High future spending · USD"],
                ] as const
              ).map(([key, label]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    aria-label={label}
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.01"
                    required
                    value={draft[key]}
                    onChange={(event) => edit(key, event.currentTarget.value)}
                  />
                </label>
              ))}
            </div>
            <p>
              Future amounts are additional variable spending after this review
              through month-end. They are your low, expected and high scenarios,
              not measured probabilities. Blank is unknown; enter 0 only when
              supported by your review.
            </p>
            <label className="field">
              Evidence and assumptions
              <textarea
                aria-label="Evidence and assumptions"
                required
                minLength={12}
                maxLength={2000}
                rows={4}
                value={draft.scope}
                onChange={(event) => edit("scope", event.currentTarget.value)}
                placeholder="Identify invoices or usage records reviewed, remaining unreported costs, and the basis for future spending."
              />
            </label>
            <label className="budget-toggle">
              <input
                type="checkbox"
                required
                checked={draft.includesPrior}
                onChange={(event) =>
                  edit("includesPrior", event.currentTarget.checked)
                }
              />
              <span>
                My estimate includes or reconciles all prior unresolved costs.
                <small>
                  {data.outlook?.review.reviewId
                    ? `The previous review still holds ${budgetMoney(data.outlook.estimatedUnreportedCents)}. A replacement must explicitly account for it, even if it has expired.`
                    : "This is the first review. Include all known unresolved costs; no earlier estimate is assumed to be zero."}
                </small>
              </span>
            </label>
            <p className="budget-snapshot-note">
              Accounting snapshot:{" "}
              {data.outlook && budgetTime(data.outlook.asOf)}. Server validation
              rechecks the exact accounting before saving.
            </p>
            <button
              className="button primary"
              type="submit"
              disabled={busy || changed || snapshotStale}
            >
              Save cost review
            </button>
          </fieldset>
        </form>
      </details>
    </section>
  );
}
