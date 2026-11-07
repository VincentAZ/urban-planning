import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Globe2,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ProjectAccess } from "@urban/core";
import type {
  EngagementDashboard,
  EngagementPrivateRecord,
  EngagementQuestion,
  EngagementSnapshotDetail,
} from "../../../../packages/core/src/engagement";
import { api, download, type Session } from "../lib/api";
import { Modal } from "./Modal";
import {
  CollaborationError,
  CollaborationLoading,
  CollaborationSaveButton,
  reviewDate,
  useCollaborationResource,
} from "./collaboration/shared";
import "./engagement-admin.css";

const voteLabels = {
  support: "I see promise here",
  concern: "I have concerns",
  neutral: "I need more information",
};
const percentage = (value: number, denominator: number) =>
  denominator ? `${Math.round((value / denominator) * 100)}%` : "—";

function ResponseCard({
  record,
  questions,
  canManage,
  busy,
  onModerate,
  url,
  revoked,
}: {
  record: EngagementPrivateRecord;
  questions: EngagementQuestion[];
  canManage: boolean;
  busy: boolean;
  onModerate: (
    record: EngagementPrivateRecord,
    status: "included" | "excluded",
    reason: string,
  ) => Promise<void>;
  url: string;
  revoked: boolean;
}) {
  const [action, setAction] = useState<"included" | "excluded" | null>(null);
  const [reason, setReason] = useState("");
  const decisionVersion = useRef(record.moderation.version);
  const current = record.current;
  const status = record.moderation.status;
  const changed =
    !!action && decisionVersion.current !== record.moderation.version;
  return (
    <li
      className={`engagement-response ${status === "excluded" ? "is-excluded" : ""}`}
    >
      <div className="engagement-response-heading">
        <strong>{record.respondentLabel}</strong>
        <span>
          {record.kind === "comment"
            ? "Comment"
            : record.kind === "survey"
              ? "Survey"
              : "Proposal response"}
        </span>
        <time dateTime={record.createdAt}>{reviewDate(record.createdAt)}</time>
      </div>
      <div className="engagement-response-flags">
        <span className={`engagement-badge ${status}`}>
          {status === "pending"
            ? current
              ? "Awaiting review · counted"
              : "Awaiting review"
            : status === "included"
              ? current
                ? "Reviewed · counted"
                : "Reviewed"
              : "Excluded from summary"}
        </span>
        {!current && (
          <span className="engagement-badge">Replaced · not counted</span>
        )}
      </div>
      {record.text && <p className="engagement-response-text">{record.text}</p>}
      {record.vote && (
        <p className="engagement-response-text">{voteLabels[record.vote]}</p>
      )}
      {record.answers && (
        <dl className="engagement-answers">
          {Object.entries(record.answers).map(([id, answer]) => (
            <div key={id}>
              <dt>
                {questions.find((question) => question.id === id)?.prompt ??
                  `Earlier survey question: ${id}`}
              </dt>
              <dd>{answer || "No answer"}</dd>
            </div>
          ))}
        </dl>
      )}
      {record.position && (
        <div className="engagement-location">
          <MapPin size={14} aria-hidden="true" />
          <span>
            {record.position[1].toFixed(5)}, {record.position[0].toFixed(5)}
          </span>
          {!revoked && (
            <a
              href={`${url}?pin=${record.position.join(",")}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View location <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
      {record.moderation.reason && (
        <p className="engagement-moderation-reason">
          <strong>Review reason:</strong> {record.moderation.reason}
        </p>
      )}
      {record.moderation.updatedAt && (
        <p className="muted small">
          Reviewed {reviewDate(record.moderation.updatedAt)}
        </p>
      )}
      {canManage && current && !action && (
        <div className="engagement-actions">
          {status !== "included" && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => {
                decisionVersion.current = record.moderation.version;
                setAction("included");
              }}
            >
              <Check size={13} aria-hidden="true" />{" "}
              {status === "excluded" ? "Restore to summary" : "Mark reviewed"}
            </button>
          )}
          {status !== "excluded" && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => {
                decisionVersion.current = record.moderation.version;
                setAction("excluded");
              }}
            >
              Exclude from summary
            </button>
          )}
        </div>
      )}
      {action && (
        <form
          className="engagement-moderation-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!reason.trim() || busy || changed || !canManage || !current)
              return;
            try {
              await onModerate(record, action, reason.trim());
              setAction(null);
              setReason("");
            } catch {
              /* Parent keeps the error visible and this reason available for retry. */
            }
          }}
        >
          <label className="field">
            <span>
              {action === "excluded" ? "Reason for exclusion" : "Review reason"}
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              maxLength={1000}
              rows={3}
              readOnly={!canManage || !current || changed}
              placeholder={
                action === "excluded"
                  ? "Explain the moderation decision. Disagreement alone is not a reason to remove a response."
                  : "Record why this response is included."
              }
            />
          </label>
          <p className="muted small">
            The original response and this decision stay in the project record.
          </p>
          {changed && (
            <p role="alert" className="error-message">
              This response changed while you were reviewing it. Your reason is
              retained here; cancel and review the latest decision before
              submitting.
            </p>
          )}
          {(!canManage || !current) && (
            <p className="muted small">This response is currently read-only.</p>
          )}
          <div className="engagement-actions">
            <button
              className="button primary small"
              disabled={
                busy || !reason.trim() || changed || !canManage || !current
              }
            >
              {busy ? "Saving…" : "Save review decision"}
            </button>
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function EngagementDetail({
  projectId,
  snapshotId,
  onChanged,
  onAccessChanged,
}: {
  projectId: string;
  snapshotId: string;
  onChanged: () => void;
  onAccessChanged?: (access: ProjectAccess) => void;
}) {
  const path = `/projects/${encodeURIComponent(projectId)}/engagement/${encodeURIComponent(snapshotId)}`;
  const resource = useCollaborationResource<EngagementSnapshotDetail>(path);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [kind, setKind] = useState("all");
  const [review, setReview] = useState("all");
  const [history, setHistory] = useState(false);
  const [limit, setLimit] = useState(30);
  const locked = useRef(false);
  const mounted = useRef(true);
  const callback = useRef(onAccessChanged);
  callback.current = onAccessChanged;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (resource.data) callback.current?.(resource.data.access);
  }, [resource.data?.access]);
  useEffect(() => {
    const refresh = () => {
      if (!locked.current && document.visibilityState === "visible")
        void resource.reload();
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [resource.reload]);
  const data = resource.data;
  async function mutate(
    key: string,
    target: string,
    body?: unknown,
    method: "PATCH" | "DELETE" = "PATCH",
  ) {
    if (locked.current) return;
    locked.current = true;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      await api(target, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!mounted.current) return;
      await resource.reload();
      onChanged();
      setMessage(
        key === "collection"
          ? "Submission status updated. The published proposal is unchanged."
          : key === "revoke"
            ? "Public link revoked. Responses remain in project records."
            : "Review decision saved. Original responses remain in project records.",
      );
      setConfirmRevoke(false);
    } catch (failure) {
      if (mounted.current) {
        setError((failure as Error).message);
        await resource.reload();
      }
      throw failure;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  async function exportFeedback(format: "pdf" | "csv") {
    if (locked.current) return;
    locked.current = true;
    setBusy(format);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/v1${path}/export?format=${format}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          body.error?.message ?? "The feedback report could not be downloaded.",
        );
      }
      const blob = await response.blob();
      if (!mounted.current) return;
      download(`public-feedback-${snapshotId.slice(0, 8)}.${format}`, blob);
      setMessage(
        "Downloaded feedback from one consistent saved snapshot. New submissions can change later reports.",
      );
    } catch (failure) {
      if (mounted.current) {
        setError((failure as Error).message);
        await resource.reload();
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  if (!data)
    return (
      <>
        {resource.loading && (
          <CollaborationLoading label="Loading published feedback…" />
        )}
        {resource.error && (
          <CollaborationError
            message={resource.error}
            retry={() => void resource.reload()}
          />
        )}
      </>
    );
  const { snapshot, records } = data;
  const aggregate = snapshot.aggregate;
  const canManage =
    data.access.canPublish && !resource.error && !resource.loading;
  const enabled =
    snapshot.engagement.config.comments ||
    snapshot.engagement.config.votes ||
    snapshot.engagement.config.pins ||
    snapshot.engagement.config.questions.length > 0;
  const isOpen =
    !snapshot.revokedAt &&
    enabled &&
    snapshot.engagement.collection.status === "open";
  const filtered = records.filter(
    (record) =>
      (history || record.current) &&
      (kind === "all" || record.kind === kind) &&
      (review === "all" || record.moderation.status === review),
  );
  return (
    <div className="engagement-detail">
      {resource.error && (
        <CollaborationError
          message={resource.error}
          retry={() => void resource.reload()}
        />
      )}
      <section
        className="engagement-publication"
        aria-label="Published proposal details"
      >
        <div>
          <span className="engagement-eyebrow">The proposal people saw</span>
          <h3>{snapshot.scenarioName}</h3>
          <p>
            Revision {snapshot.scenarioRevision} · {snapshot.placeName} ·{" "}
            {reviewDate(snapshot.createdAt)}
          </p>
          <p className="small">{snapshot.extentLabel}</p>
        </div>
        <span className={`engagement-badge ${isOpen ? "included" : ""}`}>
          {snapshot.revokedAt
            ? "Link revoked"
            : !enabled
              ? "Feedback not configured"
              : isOpen
                ? "Accepting responses"
                : "Submissions closed"}
        </span>
        <div className="engagement-actions">
          {!snapshot.revokedAt && (
            <>
              <a
                className="button small"
                href={snapshot.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open public view <ExternalLink size={13} aria-hidden="true" />
              </a>
              <button
                className="button small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      new URL(snapshot.url, location.origin).href,
                    );
                    setMessage("Public link copied.");
                  } catch {
                    setError(
                      "The link could not be copied. Open the public view and copy its address.",
                    );
                  }
                }}
              >
                <Copy size={13} aria-hidden="true" /> Copy link
              </button>
            </>
          )}
          {canManage && !snapshot.revokedAt && enabled && (
            <button
              className="button small"
              disabled={!!busy}
              onClick={() =>
                void mutate("collection", `${path}/collection`, {
                  status: isOpen ? "closed" : "open",
                  expectedVersion: snapshot.engagement.collection.version,
                }).catch(() => undefined)
              }
            >
              {isOpen ? "Close submissions" : "Reopen submissions"}
            </button>
          )}
          {canManage && !snapshot.revokedAt && (
            <button
              className="button small"
              disabled={!!busy}
              onClick={() => setConfirmRevoke(true)}
            >
              Revoke public link
            </button>
          )}
        </div>
        {confirmRevoke && canManage && (
          <div className="engagement-confirm">
            <p>
              Revoke this public link? Visitors will no longer be able to view
              the proposal or respond. Its responses and history stay in project
              records.
            </p>
            <div className="engagement-actions">
              <button
                className="button danger small"
                disabled={!!busy}
                onClick={() =>
                  void mutate(
                    "revoke",
                    `/published/${encodeURIComponent(snapshotId)}`,
                    undefined,
                    "DELETE",
                  ).catch(() => undefined)
                }
              >
                Confirm revocation
              </button>
              <button
                className="button small"
                disabled={!!busy}
                onClick={() => setConfirmRevoke(false)}
              >
                Keep link
              </button>
            </div>
          </div>
        )}
        {!data.access.canPublish && (
          <p className="muted small">
            You can read and export feedback. Project owners manage collection
            and review decisions.
          </p>
        )}
      </section>
      <div className="engagement-counts" aria-label="Included feedback totals">
        <div>
          <strong>{aggregate.participatingAccounts}</strong>
          <span>Participating accounts</span>
        </div>
        <div>
          <strong>{aggregate.votes.accounts}</strong>
          <span>Proposal responses</span>
        </div>
        <div>
          <strong>{aggregate.comments.count}</strong>
          <span>Comments · {aggregate.comments.pinnedCount} pinned</span>
        </div>
        <div>
          <strong>{aggregate.survey.accounts}</strong>
          <span>Survey responses</span>
        </div>
      </div>
      <p className="engagement-disclosure">
        These are self-selected account responses, not a representative public
        poll or a count of verified people. One account can contribute to
        several totals. {aggregate.pendingIncludedRecords} current responses
        await review and are counted; {aggregate.excludedCurrentRecords} are
        excluded and {aggregate.supersededRecords} were replaced.
      </p>
      {aggregate.survey.accounts > 0 &&
        snapshot.engagement.config.questions.length === 0 && (
          <p className="notice">
            This older publication has survey responses without a saved question
            definition. They remain in the response history; no configured
            question results are inferred.
          </p>
        )}
      <div className="engagement-actions engagement-export-actions">
        <button
          className="button primary small"
          disabled={!!busy || !!resource.error}
          onClick={() => void exportFeedback("pdf")}
        >
          {busy === "pdf" ? (
            <Loader2 size={14} className="spin" aria-hidden="true" />
          ) : (
            <Download size={14} aria-hidden="true" />
          )}{" "}
          Feedback report · PDF
        </button>
        <button
          className="button small"
          disabled={!!busy || !!resource.error}
          onClick={() => void exportFeedback("csv")}
        >
          <Download size={14} aria-hidden="true" /> Responses · CSV
        </button>
        <button
          className="button small"
          disabled={!!busy || resource.loading}
          onClick={() => void resource.reload()}
        >
          <RefreshCw size={13} aria-hidden="true" /> Refresh responses
        </button>
      </div>
      <p className="muted small">
        Reports include current counted responses. Use Saved records · JSON in
        Export for the complete retained history.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="engagement-message" role="status">
          {message}
        </p>
      )}
      {snapshot.engagement.config.votes && (
        <section className="engagement-results">
          <h3>Proposal responses</h3>
          <p>
            {aggregate.votes.accounts} included accounts · latest response from
            each account
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Response</th>
                  <th scope="col">Accounts</th>
                  <th scope="col">Share of responses</th>
                </tr>
              </thead>
              <tbody>
                {(["support", "concern", "neutral"] as const).map((vote) => (
                  <tr key={vote}>
                    <th scope="row">{voteLabels[vote]}</th>
                    <td>{aggregate.votes[vote]}</td>
                    <td>
                      {percentage(
                        aggregate.votes[vote],
                        aggregate.votes.accounts,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {!!snapshot.engagement.config.questions.length && (
        <section className="engagement-results">
          <h3>Short survey</h3>
          {snapshot.engagement.config.introduction && (
            <p className="engagement-response-text">
              {snapshot.engagement.config.introduction}
            </p>
          )}
          {aggregate.survey.questions.map((question, index) => (
            <div className="engagement-question-result" key={question.id}>
              <h4>
                {index + 1}. {question.prompt}
              </h4>
              <p className="small">
                {question.answeredAccounts} answered ·{" "}
                {question.skippedAccounts} skipped within{" "}
                {aggregate.survey.accounts} included survey responses
              </p>
              {question.options ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Choice</th>
                        <th scope="col">Accounts</th>
                        <th scope="col">Share of answers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {question.options.map(({ option, count }) => (
                        <tr key={option}>
                          <th scope="row">{option}</th>
                          <td>{count}</td>
                          <td>
                            {percentage(count, question.answeredAccounts)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small">
                  Written answers appear in the response list below and in the
                  report.
                </p>
              )}
            </div>
          ))}
        </section>
      )}
      <section className="engagement-results" aria-label="Response review">
        <h3>Read the conversation</h3>
        <p>
          Review responses in context. Account labels are specific to this
          publication; they do not identify residents.
        </p>
        <div className="engagement-filters">
          <label className="field">
            <span>Response type</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setLimit(30);
              }}
            >
              <option value="all">All response types</option>
              <option value="comment">Comments</option>
              <option value="vote">Proposal responses</option>
              <option value="survey">Surveys</option>
            </select>
          </label>
          <label className="field">
            <span>Review status</span>
            <select
              value={review}
              onChange={(event) => {
                setReview(event.target.value);
                setLimit(30);
              }}
            >
              <option value="all">All review states</option>
              <option value="pending">Awaiting review</option>
              <option value="included">Reviewed and included</option>
              <option value="excluded">Excluded from summary</option>
            </select>
          </label>
          <label className="engagement-history-toggle">
            <input
              type="checkbox"
              checked={history}
              onChange={(event) => {
                setHistory(event.target.checked);
                setLimit(30);
              }}
            />{" "}
            Include replaced responses
          </label>
        </div>
        {filtered.length ? (
          <>
            <p className="muted small">
              Showing {Math.min(limit, filtered.length)} of {filtered.length}{" "}
              matching responses.
            </p>
            <ul className="engagement-response-list">
              {filtered.slice(0, limit).map((record) => (
                <ResponseCard
                  key={record.id}
                  record={record}
                  questions={snapshot.engagement.config.questions}
                  canManage={canManage}
                  busy={!!busy}
                  url={snapshot.url}
                  revoked={!!snapshot.revokedAt}
                  onModerate={(item, status, reason) =>
                    mutate(
                      item.id,
                      `${path}/feedback/${encodeURIComponent(item.id)}`,
                      {
                        expectedVersion: item.moderation.version,
                        status,
                        reason,
                      },
                    )
                  }
                />
              ))}
            </ul>
            {limit < filtered.length && (
              <button
                className="button"
                onClick={() => setLimit((value) => value + 30)}
              >
                Show 30 more responses
              </button>
            )}
          </>
        ) : (
          <div className="engagement-empty">
            <Globe2 size={27} aria-hidden="true" />
            <h4>
              {records.length
                ? "No responses match these filters."
                : "A little quiet, for now."}
            </h4>
            <p>
              {records.length
                ? "Try another response type or review state."
                : "Share the published link when you are ready to invite local perspectives."}
            </p>
          </div>
        )}
      </section>
      <details className="engagement-audit">
        <summary>
          <ShieldCheck size={15} aria-hidden="true" /> Collection and review
          history ({data.audit.length})
        </summary>
        <ol>
          {data.audit.map((event) => {
            const moderation = event.details.moderation;
            const reason =
              typeof event.details.reason === "string"
                ? event.details.reason
                : moderation &&
                    typeof moderation === "object" &&
                    "reason" in moderation &&
                    typeof moderation.reason === "string"
                  ? moderation.reason
                  : undefined;
            return (
              <li key={event.id}>
                <strong>
                  {event.action
                    .replace(/^engagement\.|^feedback\.|^snapshot\./, "")
                    .replaceAll(".", " ")}
                </strong>
                <time dateTime={event.at}>{reviewDate(event.at)}</time>
                {reason && <p>{reason}</p>}
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}

export function EngagementDialog({
  projectId,
  projectName,
  session,
  onClose,
  onRequireAccount,
  onRequireSave,
  onPublish,
  onAccessChanged,
}: {
  projectId: string | null;
  projectName: string;
  session: Session;
  onClose: () => void;
  onRequireAccount: () => void;
  onRequireSave: () => Promise<void>;
  onPublish: () => void;
  onAccessChanged?: (access: ProjectAccess) => void;
}) {
  const resource = useCollaborationResource<EngagementDashboard>(
    session.user && projectId
      ? `/projects/${encodeURIComponent(projectId)}/engagement`
      : null,
  );
  const [selection, setSelection] = useState("");
  const data = resource.data;
  const selected =
    data?.snapshots.find((snapshot) => snapshot.id === selection) ??
    data?.snapshots[0];
  return (
    <Modal
      title="Listen to the neighborhood."
      description={`${projectName} · Feedback stays attached to the exact published proposal people saw.`}
      open
      onClose={onClose}
      wide
    >
      {!session.user || !projectId ? (
        <div className="engagement-empty">
          <Globe2 size={32} aria-hidden="true" />
          <h3>Make room for local perspectives.</h3>
          <p>
            Save a project with a free account, publish a proposal, and choose
            the feedback you want to collect.
          </p>
          {!session.user ? (
            <button className="button primary" onClick={onRequireAccount}>
              Sign in or create a free account
            </button>
          ) : (
            <CollaborationSaveButton
              onSave={onRequireSave}
              label="Save project to account"
            />
          )}
        </div>
      ) : (
        <>
          {resource.loading && !data && (
            <CollaborationLoading label="Loading published proposals…" />
          )}
          {resource.error && (
            <CollaborationError
              message={resource.error}
              retry={() => void resource.reload()}
            />
          )}
          {data && !data.snapshots.length && (
            <div className="engagement-empty">
              <Globe2 size={32} aria-hidden="true" />
              <h3>Ready for a wider conversation.</h3>
              <p>
                Publish a read-only proposal with comments, location pins,
                proposal responses, or a short survey. Responses will appear
                here.
              </p>
              {data.access.canPublish ? (
                <button className="button primary" onClick={onPublish}>
                  Publish a proposal
                </button>
              ) : (
                <p>A project owner can publish the first proposal.</p>
              )}
            </div>
          )}
          {data && selected && (
            <>
              <div className="engagement-selection">
                <label className="field">
                  <span>Published proposal</span>
                  <select
                    value={selected.id}
                    onChange={(event) => setSelection(event.target.value)}
                  >
                    {data.snapshots.map((snapshot) => (
                      <option key={snapshot.id} value={snapshot.id}>
                        {snapshot.scenarioName} · r{snapshot.scenarioRevision} ·{" "}
                        {reviewDate(snapshot.createdAt)}
                        {snapshot.revokedAt ? " · revoked" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {data.access.canPublish && (
                  <button className="button small" onClick={onPublish}>
                    Publish another proposal
                  </button>
                )}
              </div>
              <EngagementDetail
                key={`${projectId}:${selected.id}:${session.user.id}:${session.organization?.id}`}
                projectId={projectId}
                snapshotId={selected.id}
                onChanged={() => void resource.reload()}
                onAccessChanged={onAccessChanged}
              />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
