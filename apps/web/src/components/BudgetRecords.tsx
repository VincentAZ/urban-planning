import { useEffect, useRef, useState } from "react";
import type {
  BudgetRecord,
  BudgetRecordCollection,
  BudgetRecordPage,
} from "@urban/core";
import { api, ApiError } from "../lib/api";
import { budgetMoney, budgetTime } from "./BudgetOutlook";

const collections: Record<BudgetRecordCollection, string> = {
  adjustments: "Recorded costs",
  reservations: "Job reservations",
  costReviews: "Cost reviews",
  audit: "Audit history",
};
function describe(record: BudgetRecord) {
  if ("maximumCents" in record)
    return {
      at: record.createdAt,
      title: `${record.provider} / ${record.operation}`,
      state: record.status,
      amount: `Maximum ${budgetMoney(record.maximumCents)}`,
      secondary:
        record.actualCents === undefined
          ? record.status === "running"
            ? "Awaiting cost reconciliation"
            : "No settled charge recorded"
          : `Settled ${budgetMoney(record.actualCents)}`,
    };
  if ("amountCents" in record)
    return {
      at: record.createdAt,
      title: record.reason,
      state: record.category,
      amount: budgetMoney(record.amountCents),
      secondary: `Accounting month ${record.period} UTC`,
    };
  if ("estimatedUnreportedCents" in record)
    return {
      at: record.createdAt,
      title: record.scopeStatement,
      state: "cost review",
      amount: `${budgetMoney(record.estimatedUnreportedCents)} estimated`,
      secondary: `Future ${budgetMoney(record.futureVariable.lowCents)} / ${budgetMoney(record.futureVariable.expectedCents)} / ${budgetMoney(record.futureVariable.highCents)}`,
    };
  return {
    at: record.at,
    title:
      record.action === "budget.alerts.observed"
        ? "Budget alerts observed"
        : record.action.replaceAll(".", " ").replaceAll("_", " "),
    state: "audit event",
    amount: "—",
    secondary: "Inspect the recorded change below",
  };
}
function RecordDetails({ record }: { record: BudgetRecord }) {
  return (
    <details className="budget-record-details">
      <summary>Inspect record</summary>
      <dl>
        <dt>Record ID</dt>
        <dd>{record.id}</dd>
        <dt>Actor</dt>
        <dd>{record.actorId}</dd>
        {"period" in record && (
          <>
            <dt>Original accounting month</dt>
            <dd>{record.period} UTC</dd>
          </>
        )}
        {"maximumCents" in record && (
          <>
            <dt>Created</dt>
            <dd>{budgetTime(record.createdAt)}</dd>
            <dt>Undispatched reservation expiry</dt>
            <dd>{budgetTime(record.expiresAt)}</dd>
            {record.startedAt && (
              <>
                <dt>Started</dt>
                <dd>{budgetTime(record.startedAt)}</dd>
              </>
            )}
            {record.settledAt && (
              <>
                <dt>Settled</dt>
                <dd>
                  {budgetTime(record.settledAt)} ({record.settledPeriod} UTC)
                </dd>
              </>
            )}
            {record.releaseReason && (
              <>
                <dt>Release reason</dt>
                <dd>{record.releaseReason}</dd>
              </>
            )}
          </>
        )}
        {"coveredThrough" in record && (
          <>
            <dt>Evidence covered through</dt>
            <dd>{budgetTime(record.coveredThrough)}</dd>
            <dt>Review expiry</dt>
            <dd>{budgetTime(record.expiresAt)}</dd>
            <dt>Replaces review</dt>
            <dd>{record.replacesReviewId ?? "First review"}</dd>
            <dt>Prior unresolved estimate acknowledged</dt>
            <dd>{record.includesPriorUnreported ? "Yes" : "No"}</dd>
          </>
        )}
      </dl>
      <p>
        Complete retained record, including exact amounts, identities and audit
        details:
      </p>
      <pre tabIndex={0} aria-label="Complete retained budget record">
        {JSON.stringify(record, null, 2)}
      </pre>
    </details>
  );
}
export function BudgetRecords({
  accountId,
  disabled,
  onAccessError,
}: {
  accountId: string;
  disabled: boolean;
  onAccessError: (error: unknown) => void;
}) {
  const [collection, setCollection] =
    useState<BudgetRecordCollection>("adjustments");
  const [page, setPage] = useState<BudgetRecordPage | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [index, setIndex] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const accessError = useRef(onAccessError);
  accessError.current = onAccessError;
  const cursor = cursors[index] ?? null;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setChanged(false);
    setPage(null);
    const params = new URLSearchParams({ collection });
    if (cursor) params.set("cursor", cursor);
    void api<BudgetRecordPage>(`/admin/budget/records?${params}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.collection !== collection)
          throw new Error(
            "The service returned a different budget record collection.",
          );
        setPage(value);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          accessError.current(error);
          return;
        }
        setChanged(
          error instanceof ApiError &&
            (error.code === "BUDGET_RECORDS_CHANGED" ||
              error.code === "BUDGET_CURSOR_INVALID"),
        );
        setError(
          error instanceof Error
            ? error.message
            : "Budget history could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [accountId, collection, cursor, reload]);
  function latest() {
    setCursors([null]);
    setIndex(0);
    setReload((value) => value + 1);
  }
  return (
    <section
      className="budget-section"
      aria-labelledby="budget-history-heading"
    >
      <h3 id="budget-history-heading">Complete ledger and review history</h3>
      <p>
        All UTC months, newest entries first. Running costs stay reserved until
        reconciled; elapsed time does not release them. Alert observations are
        recorded on administrator interaction, not continuously monitored or
        sent as notifications.
      </p>
      <div className="budget-history-controls">
        <label className="field">
          Budget history records
          <select
            value={collection}
            disabled={disabled || loading}
            onChange={(event) => {
              setCollection(
                event.currentTarget.value as BudgetRecordCollection,
              );
              setCursors([null]);
              setIndex(0);
            }}
          >
            {Object.entries(collections).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          type="button"
          disabled={disabled || loading}
          onClick={latest}
        >
          Refresh history
        </button>
      </div>
      <div aria-busy={loading}>
        {loading && <p role="status">Loading budget history…</p>}
        {error && (
          <p role="alert" className="budget-error">
            {error}
            {changed &&
              " Return to the latest records to avoid combining different snapshots."}
          </p>
        )}
        {page && (
          <>
            <p role="status">
              {page.total
                ? `${page.offset + 1}–${page.offset + page.items.length} of ${page.total} ${collections[collection].toLowerCase()}.`
                : `No ${collections[collection].toLowerCase()} have been recorded.`}
            </p>
            {page.items.length > 0 && (
              <>
                <div className="budget-table-wrap budget-records-desktop">
                  <table className="budget-table">
                    <caption className="sr-only">
                      {collections[collection]}, all UTC months
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Date · UTC</th>
                        <th scope="col">Record</th>
                        <th scope="col">Status / category</th>
                        <th scope="col">Amounts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((record) => {
                        const row = describe(record);
                        return (
                          <tr key={record.id}>
                            <td>
                              <time dateTime={row.at}>
                                {budgetTime(row.at)}
                              </time>
                            </td>
                            <td>
                              {row.title}
                              <RecordDetails record={record} />
                            </td>
                            <td>{row.state}</td>
                            <td>
                              {row.amount}
                              <small>{row.secondary}</small>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <ul className="budget-records-mobile">
                  {page.items.map((record) => {
                    const row = describe(record);
                    return (
                      <li key={record.id}>
                        <strong>{row.title}</strong>
                        <time dateTime={row.at}>{budgetTime(row.at)}</time>
                        <dl>
                          <div>
                            <dt>Status / category</dt>
                            <dd>{row.state}</dd>
                          </div>
                          <div>
                            <dt>Amount</dt>
                            <dd>{row.amount}</dd>
                          </div>
                        </dl>
                        <p>{row.secondary}</p>
                        <RecordDetails record={record} />
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <nav className="budget-actions" aria-label="Budget history pages">
              <button
                className="button"
                type="button"
                disabled={disabled || loading || index === 0}
                onClick={() => setIndex((value) => value - 1)}
              >
                Previous records
              </button>
              <button
                className="button"
                type="button"
                disabled={disabled || loading || !page.nextCursor}
                onClick={() => {
                  if (!page.nextCursor) return;
                  setCursors((values) => [
                    ...values.slice(0, index + 1),
                    page.nextCursor,
                  ]);
                  setIndex((value) => value + 1);
                }}
              >
                Next records
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  );
}
