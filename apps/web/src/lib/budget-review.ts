import type { BudgetCostReviewInput, BudgetDashboard } from "@urban/core";
import { budgetCents } from "./budget-dialog";

export interface BudgetReviewDraft {
  basisHash: string;
  replacesReviewId: string | null;
  coveredThrough: string;
  expiresAt: string;
  unreported: string;
  low: string;
  expected: string;
  high: string;
  scope: string;
  includesPrior: boolean;
}
export const budgetUtcInput = (iso: string) =>
  new Date(iso).toISOString().slice(0, 19);
export function createBudgetReviewDraft(
  data: BudgetDashboard,
): BudgetReviewDraft {
  if (!data.outlook)
    throw new Error("A current accounting snapshot is required.");
  const now = new Date(data.outlook.asOf);
  const monthEnd =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1000;
  return {
    basisHash: data.outlook.basisHash,
    replacesReviewId: data.outlook.review.reviewId,
    coveredThrough: budgetUtcInput(data.outlook.asOf),
    expiresAt: budgetUtcInput(
      new Date(Math.min(now.getTime() + 86400000, monthEnd)).toISOString(),
    ),
    unreported: "",
    low: "",
    expected: "",
    high: "",
    scope: "",
    includesPrior: false,
  };
}
export function budgetReviewBasisChanged(
  draft: BudgetReviewDraft,
  data: BudgetDashboard,
) {
  return (
    !data.outlook ||
    draft.basisHash !== data.outlook.basisHash ||
    draft.replacesReviewId !== data.outlook.review.reviewId
  );
}
export function reviewCurrentBudgetBasis(
  draft: BudgetReviewDraft,
  data: BudgetDashboard,
): BudgetReviewDraft {
  if (!data.outlook)
    throw new Error("A current accounting snapshot is required.");
  return {
    ...draft,
    basisHash: data.outlook.basisHash,
    replacesReviewId: data.outlook.review.reviewId,
    includesPrior: false,
  };
}
function readUtc(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
    throw new Error(`Enter ${label} in UTC.`);
  const date = new Date(`${value}Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, value.length) !== value
  )
    throw new Error(`Enter a valid ${label} in UTC.`);
  return date.toISOString();
}
export function readBudgetReviewDraft(
  draft: BudgetReviewDraft,
  data: BudgetDashboard,
): Omit<BudgetCostReviewInput, "idempotencyKey"> {
  if (budgetReviewBasisChanged(draft, data))
    throw new Error(
      "Accounting changed. Review the current accounting before submitting.",
    );
  if (!draft.includesPrior)
    throw new Error(
      "Confirm that the estimate includes or reconciles all prior unresolved costs.",
    );
  const amount = (raw: string, label: string) => {
    const value = budgetCents(raw, label);
    if (value < 0 || value > 100000000)
      throw new Error(`${label} must be between $0 and $1,000,000.`);
    return value;
  };
  const futureVariable = {
    lowCents: amount(draft.low, "Low future spending"),
    expectedCents: amount(draft.expected, "Expected future spending"),
    highCents: amount(draft.high, "High future spending"),
  };
  if (
    futureVariable.lowCents > futureVariable.expectedCents ||
    futureVariable.expectedCents > futureVariable.highCents
  )
    throw new Error("Future spending must follow low ≤ expected ≤ high.");
  const coveredThrough = readUtc(draft.coveredThrough, "covered-through time");
  const expiresAt = readUtc(draft.expiresAt, "review expiry");
  const asOf = new Date(data.outlook!.asOf);
  if (
    coveredThrough.slice(0, 7) !== data.period ||
    Date.parse(coveredThrough) > asOf.getTime()
  )
    throw new Error(
      "Covered-through time must be in the current UTC month and no later than the accounting snapshot.",
    );
  const monthEnd = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 1);
  if (
    Date.parse(expiresAt) <= asOf.getTime() ||
    Date.parse(expiresAt) >
      Math.min(Date.parse(coveredThrough) + 7 * 86400000, monthEnd)
  )
    throw new Error(
      "Expiry must follow the accounting snapshot and be within seven days of coverage and the current UTC month.",
    );
  const scopeStatement = draft.scope.trim();
  if (scopeStatement.length < 12 || scopeStatement.length > 2000)
    throw new Error(
      "Describe the reviewed costs and assumptions in 12–2,000 characters.",
    );
  return {
    expectedBasisHash: draft.basisHash,
    replacesReviewId: draft.replacesReviewId,
    coveredThrough,
    expiresAt,
    estimatedUnreportedCents: amount(
      draft.unreported,
      "Estimated unreported cost",
    ),
    futureVariable,
    scopeStatement,
    includesPriorUnreported: true,
  };
}
