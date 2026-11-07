import {
  CheckCircle2,
  CornerDownRight,
  MapPin,
  RotateCcw,
  Send,
} from "lucide-react";
import type { ReviewComment } from "@urban/core";
import { reviewDate } from "./shared";

interface ReviewThreadProps {
  comment: ReviewComment;
  selected: boolean;
  canReply: boolean;
  busy: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onReply: () => void;
  onResolve: () => void;
  onNavigate?: (comment: ReviewComment) => void;
}

export function ReviewThread({
  comment,
  selected,
  canReply,
  busy,
  draft,
  onDraft,
  onReply,
  onResolve,
  onNavigate,
}: ReviewThreadProps) {
  const targetAvailable =
    comment.target?.kind !== "project" && !!comment.target;
  return (
    <article
      id={`review-thread-${comment.id}`}
      tabIndex={-1}
      className={`collab-thread ${selected ? "is-selected" : ""} ${comment.resolved ? "is-resolved" : ""}`}
      aria-label={`${comment.author}: ${comment.targetLabel}`}
    >
      <header className="collab-thread-heading">
        <div className="collab-avatar" aria-hidden="true">
          {comment.author.trim().slice(0, 1).toUpperCase() || "?"}
        </div>
        <div className="collab-thread-author">
          <strong>{comment.author}</strong>
          <span>
            <time dateTime={comment.createdAt}>
              {reviewDate(comment.createdAt)}
            </time>{" "}
            ·{" "}
            {comment.scenarioRevision === null
              ? "Original revision unavailable"
              : `Revision ${comment.scenarioRevision}`}
          </span>
        </div>
        <span
          className={`collab-thread-status ${comment.resolved ? "resolved" : ""}`}
        >
          {comment.resolved ? (
            <>
              <CheckCircle2 size={12} aria-hidden="true" /> Resolved
            </>
          ) : (
            "Open"
          )}
        </span>
      </header>
      {targetAvailable && onNavigate ? (
        <button
          className="collab-target-link"
          onClick={() => onNavigate(comment)}
        >
          <MapPin size={13} aria-hidden="true" />
          {comment.targetLabel}
          <span className="sr-only"> — Show review target</span>
        </button>
      ) : (
        <div className="collab-target-label">
          <MapPin size={13} aria-hidden="true" />
          {comment.targetLabel}
        </div>
      )}
      {comment.stale && (
        <p className="collab-stale">
          {comment.scenarioRevision === null
            ? "This older note has no verified original revision."
            : "The scenario has changed since this note was posted."}
          {comment.currentRevision !== null
            ? ` Current saved revision: ${comment.currentRevision}.`
            : " Its original scenario is no longer available."}{" "}
          Check the current design before acting on it.
        </p>
      )}
      <p className="collab-comment-text">{comment.text}</p>
      {comment.replies.length > 0 && (
        <ol className="collab-replies" aria-label="Thread replies">
          {comment.replies.map((reply) => (
            <li key={reply.id}>
              <CornerDownRight size={14} aria-hidden="true" />
              <div>
                <div className="collab-reply-meta">
                  <strong>{reply.author}</strong>
                  <span>
                    <time dateTime={reply.createdAt}>
                      {reviewDate(reply.createdAt)}
                    </time>{" "}
                    · Revision {reply.scenarioRevision}
                  </span>
                </div>
                <p className="collab-comment-text">{reply.text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {comment.resolvedAt && (
        <p className="collab-resolution">
          Resolved {reviewDate(comment.resolvedAt)}. The discussion remains in
          the project record.
        </p>
      )}
      <footer className="collab-thread-footer">
        {comment.canResolve && (
          <button className="button small" disabled={busy} onClick={onResolve}>
            {comment.resolved ? (
              <RotateCcw size={13} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={13} aria-hidden="true" />
            )}
            {comment.resolved ? "Reopen thread" : "Resolve thread"}
          </button>
        )}
        <span>
          {comment.replies.length}{" "}
          {comment.replies.length === 1 ? "reply" : "replies"}
        </span>
      </footer>
      {canReply && (
        <form
          className="collab-reply-form"
          onSubmit={(event) => {
            event.preventDefault();
            onReply();
          }}
        >
          <label className="field">
            Reply to {comment.author}
            <textarea
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder="Add context, a question, or a next step…"
              maxLength={5000}
              rows={2}
              disabled={busy}
            />
          </label>
          <button
            className="button small"
            type="submit"
            disabled={busy || !draft.trim()}
          >
            <Send size={13} aria-hidden="true" /> Post reply
          </button>
        </form>
      )}
    </article>
  );
}
