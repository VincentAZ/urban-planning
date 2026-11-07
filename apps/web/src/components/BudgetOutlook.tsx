import type { BudgetDashboard } from "@urban/core";

export const budgetMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const budgetTime = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " UTC";
const alerts = {
  "review-required":
    "A current cost review is required before metered work can start.",
  "estimate-carried":
    "Unresolved estimated costs remain held from a previous month.",
  "operating-limit-reached":
    "Accounted costs have reached the operating allowance.",
  "expected-above-operating-limit":
    "The expected spending scenario exceeds the operating allowance.",
  "high-above-monthly-limit":
    "The high spending scenario exceeds the monthly ceiling.",
};
export function BudgetOutlook({
  data,
  expiredSinceSnapshot = false,
}: {
  data: BudgetDashboard;
  expiredSinceSnapshot?: boolean;
}) {
  const outlook = data.outlook;
  if (!outlook)
    return (
      <section className="budget-coverage">
        <strong>Spending outlook unavailable</strong>
        <p>
          The service has not supplied a cost review. Recorded amounts are not a
          complete external bill.
        </p>
      </section>
    );
  const forecast = expiredSinceSnapshot ? null : outlook.forecast;
  const currentAlerts = expiredSinceSnapshot
    ? [
        ...new Set([
          "review-required" as const,
          ...outlook.alerts.filter(
            (alert) =>
              alert !== "expected-above-operating-limit" &&
              alert !== "high-above-monthly-limit",
          ),
        ]),
      ]
    : outlook.alerts;
  return (
    <section
      className="budget-section budget-outlook"
      aria-labelledby="budget-outlook-heading"
    >
      <div className="budget-section-heading">
        <h3 id="budget-outlook-heading">Where this month could land</h3>
        <span
          className={`budget-state ${outlook.review.status === "fresh" && !expiredSinceSnapshot ? "ready" : ""}`}
        >
          {outlook.review.status === "fresh" && !expiredSinceSnapshot
            ? "Current cost review"
            : "Cost review required"}
        </span>
      </div>
      <p>
        Administrator-authored spending scenarios, not a provider bill or
        statistical confidence interval. As of{" "}
        <time dateTime={outlook.asOf}>{budgetTime(outlook.asOf)}</time>.
      </p>
      <div className="budget-forecast-grid">
        {(
          [
            ["Low", forecast?.lowCents],
            ["Expected", forecast?.expectedCents],
            ["High", forecast?.highCents],
          ] as const
        ).map(([label, value]) => (
          <div className="budget-stat" key={label}>
            <span>{label} month-end cost</span>
            <strong>
              {value === undefined ? "Unavailable" : budgetMoney(value)}
            </strong>
          </div>
        ))}
      </div>
      <dl className="budget-breakdown">
        <div>
          <dt>Estimated unreported costs still held</dt>
          <dd>{budgetMoney(outlook.estimatedUnreportedCents)}</dd>
        </div>
        <div>
          <dt>Accounted costs and estimated holds</dt>
          <dd>{budgetMoney(outlook.accountedFloorCents)}</dd>
        </div>
        <div>
          <dt>Remaining daily allowance</dt>
          <dd>
            {expiredSinceSnapshot ||
            outlook.pacing.remainingDailyAllowanceCents === null
              ? "Unavailable"
              : budgetMoney(outlook.pacing.remainingDailyAllowanceCents)}
          </dd>
        </div>
      </dl>
      <p>
        Daily allowance shares remaining internal headroom across{" "}
        {outlook.pacing.remainingUtcDays} remaining UTC dates, including today;
        it is not a predicted spending rate.{" "}
        {Math.round(outlook.pacing.elapsedFraction * 100)}% of the month has
        elapsed.
      </p>
      <div className="budget-review-status">
        <strong>
          {expiredSinceSnapshot
            ? "This review expired after the displayed snapshot. Refresh the ledger for current evidence; the unresolved estimate remains held."
            : outlook.review.reason}
        </strong>
        {outlook.review.coveredThrough && (
          <p>
            Costs reviewed through{" "}
            <time dateTime={outlook.review.coveredThrough}>
              {budgetTime(outlook.review.coveredThrough)}
            </time>
            .{" "}
            {outlook.review.expiresAt && (
              <>
                Review expires{" "}
                <time dateTime={outlook.review.expiresAt}>
                  {budgetTime(outlook.review.expiresAt)}
                </time>
                .
              </>
            )}
          </p>
        )}
        <p>
          Expiry or a new month does not release an unresolved estimate. A new
          review must explicitly include or reconcile it.
        </p>
      </div>
      {currentAlerts.length > 0 && (
        <ul className="budget-alert-list" aria-label="Current budget alerts">
          {currentAlerts.map((alert) => (
            <li key={alert}>{alerts[alert]}</li>
          ))}
        </ul>
      )}
      {outlook.notes.length > 0 && (
        <details>
          <summary>Outlook assumptions and limits</summary>
          {outlook.notes.map((note, index) => (
            <p key={index}>{note}</p>
          ))}
        </details>
      )}
    </section>
  );
}
