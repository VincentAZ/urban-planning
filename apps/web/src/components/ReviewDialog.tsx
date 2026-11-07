import { useEffect, useRef, useState } from "react";
import {
  Compass,
  Loader2,
  MapPin,
  MessageSquare,
  RefreshCw,
  Send,
} from "lucide-react";
import type {
  Place,
  ProjectAccess,
  ReviewComment,
  ReviewCommentsResponse,
  ReviewTarget,
} from "@urban/core";
import { api, type Session } from "../lib/api";
import { Modal } from "./Modal";
import {
  CollaborationError,
  CollaborationGate,
  CollaborationLoading,
  CollaborationSaveButton,
  ROLE_DETAILS,
  reviewTargetLabel,
  useCollaborationResource,
} from "./collaboration/shared";
import {
  coordinateTarget,
  reviewRequestKey,
  reviewWriteBlock,
} from "./collaboration/review-state";
import { ReviewThread } from "./collaboration/ReviewThread";
import "./collaboration/collaboration.css";

export interface ReviewDialogProps {
  open?: boolean;
  projectId: string | null;
  projectName: string;
  scenarioId: string;
  scenarioName: string;
  revision: number;
  savedVersion: number | null;
  hasUnsavedChanges?: boolean;
  session: Session;
  place?: Place;
  target?: ReviewTarget;
  targetLabel?: string;
  selectedCommentId?: string;
  onClose: () => void;
  onRequireAccount?: () => void;
  onRequireSave?: () => void | Promise<void>;
  onReopenSaved?: () => void | Promise<void>;
  onPickLocation?: () => void;
  onNavigateComment?: (comment: ReviewComment) => void;
  onCommentsChange?: (comments: ReviewComment[]) => void;
  onAccessChanged?: (access: ProjectAccess) => void;
}
interface CommentMutation {
  comment: ReviewComment;
  projectVersion: number;
  access: ProjectAccess;
}
interface ReviewDraft {
  text: string;
  replies: Record<string, string>;
}
const EMPTY_DRAFT: ReviewDraft = { text: "", replies: {} };
const GENERAL_TARGET: ReviewTarget = { kind: "project" };

export function ReviewDialog({
  open = true,
  projectId,
  projectName,
  scenarioId,
  scenarioName,
  revision,
  savedVersion,
  hasUnsavedChanges = false,
  session,
  place,
  target,
  targetLabel,
  selectedCommentId,
  onClose,
  onRequireAccount,
  onRequireSave,
  onReopenSaved,
  onPickLocation,
  onNavigateComment,
  onCommentsChange,
  onAccessChanged,
}: ReviewDialogProps) {
  const path =
    session.user && projectId
      ? `/projects/${encodeURIComponent(projectId)}/comments`
      : null;
  const resource = useCollaborationResource<ReviewCommentsResponse>(
    path ? `${path}?scenarioId=${encodeURIComponent(scenarioId)}` : null,
    open,
  );
  const scope = `${projectId ?? "draft"}:${scenarioId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const callbacks = useRef({ onCommentsChange, onAccessChanged });
  callbacks.current = { onCommentsChange, onAccessChanged };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const draft = drafts[scope] ?? EMPTY_DRAFT;
  const setText = (text: string) =>
    setDrafts((all) => ({
      ...all,
      [scope]: { ...(all[scope] ?? EMPTY_DRAFT), text },
    }));
  const setReply = (id: string, text: string) =>
    setDrafts((all) => ({
      ...all,
      [scope]: {
        ...(all[scope] ?? EMPTY_DRAFT),
        replies: { ...all[scope]?.replies, [id]: text },
      },
    }));
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestKeys = useRef<
    Record<string, { fingerprint: string; key: string }>
  >({});
  const [coordinateOpen, setCoordinateOpen] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [coordinateError, setCoordinateError] = useState("");
  const targetKey = `${scope}:${JSON.stringify(target ?? GENERAL_TARGET)}`;
  const [override, setOverride] = useState<{
    key: string;
    target: ReviewTarget;
    label?: string;
  } | null>(null);
  const selectedTarget =
    override?.key === targetKey ? override.target : (target ?? GENERAL_TARGET);
  const selectedLabel =
    override?.key === targetKey ? override.label : targetLabel;
  const data = resource.data;
  const remoteChanged =
    !!data && savedVersion !== null && savedVersion !== data.projectVersion;
  const block = reviewWriteBlock(
    data,
    savedVersion,
    revision,
    hasUnsavedChanges,
  );
  const canWrite = !block && !resource.loading && !resource.error;
  const comments = data?.comments;
  useEffect(() => {
    if (comments) callbacks.current.onCommentsChange?.(comments);
    else if (resource.error) callbacks.current.onCommentsChange?.([]);
    if (data) callbacks.current.onAccessChanged?.(data.access);
  }, [comments, data, resource.error]);
  const focused = useRef("");
  useEffect(() => {
    if (!open) {
      focused.current = "";
      return;
    }
    if (
      !selectedCommentId ||
      !comments?.some((comment) => comment.id === selectedCommentId)
    )
      return;
    const focusKey = `${scope}:${selectedCommentId}`;
    if (focused.current === focusKey) return;
    setStatus("all");
    const handle = requestAnimationFrame(() => {
      const element = document.getElementById(
        `review-thread-${selectedCommentId}`,
      );
      if (element) {
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: "nearest", behavior: "instant" });
        focused.current = focusKey;
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [open, selectedCommentId, comments, scope]);

  function useCoordinates() {
    try {
      const location = coordinateTarget(latitude, longitude, place);
      setOverride({ key: targetKey, target: location });
      setCoordinateError("");
      setCoordinateOpen(false);
    } catch (failure) {
      setCoordinateError((failure as Error).message);
    }
  }
  async function mutate(
    kind: "comment" | "reply" | "resolve",
    comment?: ReviewComment,
  ) {
    if (
      !path ||
      !data ||
      busyRef.current ||
      (kind !== "resolve" && !canWrite) ||
      (kind === "resolve" && !comment?.canResolve)
    )
      return;
    const text = (
      kind === "reply" ? (draft.replies[comment!.id] ?? "") : draft.text
    ).trim();
    if (kind !== "resolve" && !text) return;
    const payload =
      kind === "resolve"
        ? {
            resolved: !comment!.resolved,
            expectedThreadVersion: comment!.threadVersion,
          }
        : {
            ...(kind === "comment"
              ? { scenarioId, target: selectedTarget }
              : {}),
            expectedRevision: revision,
            expectedVersion: savedVersion,
            text,
          };
    const key = `${scope}:${kind}:${comment?.id ?? "new"}`;
    if (kind !== "resolve")
      requestKeys.current[key] = reviewRequestKey(
        requestKeys.current[key],
        payload,
      );
    busyRef.current = true;
    setBusy(comment?.id ?? "new");
    setError("");
    setMessage("");
    try {
      const result = await api<CommentMutation>(
        `${path}${comment ? `/${encodeURIComponent(comment.id)}${kind === "reply" ? "/replies" : ""}` : ""}`,
        {
          method: kind === "resolve" ? "PATCH" : "POST",
          body: JSON.stringify({
            ...payload,
            ...(kind !== "resolve"
              ? { idempotencyKey: requestKeys.current[key].key }
              : {}),
          }),
        },
      );
      delete requestKeys.current[key];
      if (!mounted.current || currentScope.current !== scope) return;
      const updated = data.comments.some(
        (item) => item.id === result.comment.id,
      )
        ? data.comments.map((item) =>
            item.id === result.comment.id ? result.comment : item,
          )
        : [...data.comments, result.comment];
      resource.replace({
        ...data,
        access: result.access,
        projectVersion: result.projectVersion,
        comments: updated,
      });
      if (kind === "comment") {
        setText("");
        setStatus("open");
      }
      if (kind === "reply") setReply(comment!.id, "");
      setMessage(
        kind === "comment"
          ? "Comment added to this saved scenario."
          : kind === "reply"
            ? "Reply added to the thread."
            : result.comment.resolved
              ? "Thread resolved. Its history stays available."
              : "Thread reopened.",
      );
    } catch (failure) {
      if (mounted.current && currentScope.current === scope)
        setError((failure as Error).message);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  const visibleComments =
    comments?.filter(
      (comment) =>
        status === "all" || comment.resolved === (status === "resolved"),
    ) ?? [];
  const openCount =
    comments?.filter((comment) => !comment.resolved).length ?? 0;
  return (
    <Modal
      title="Project review"
      description={`${projectName} · ${scenarioName}`}
      wide
      open={open}
      onClose={onClose}
    >
      <div className="collab-dialog collab-review">
        <CollaborationGate
          session={session}
          projectId={projectId}
          onRequireAccount={onRequireAccount}
          onRequireSave={onRequireSave}
        />
        {path && (
          <>
            <div className="collab-intro">
              <div className="collab-intro-icon">
                <MessageSquare size={22} aria-hidden="true" />
              </div>
              <div>
                <h3>Give the next good idea a place to land.</h3>
                <p>
                  Discuss this scenario, connect notes to the map, and keep
                  decisions with their context.
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setError("");
                  void resource.reload();
                }}
                disabled={!!busy || resource.loading}
                aria-label="Refresh project review"
              >
                <RefreshCw
                  size={16}
                  className={resource.loading ? "spin" : ""}
                />
              </button>
            </div>
            {resource.loading && !data && (
              <CollaborationLoading label="Loading saved scenario review…" />
            )}
            {(error || resource.error) && (
              <CollaborationError
                message={error || resource.error}
                retry={() => {
                  setError("");
                  void resource.reload();
                }}
                disabled={!!busy || resource.loading}
              />
            )}
            {message && (
              <p className="collab-success" role="status">
                {message}
              </p>
            )}
            {data && (
              <>
                <div className="collab-access-line">
                  <span className="collab-role">
                    Your access: {ROLE_DETAILS[data.access.role].label}
                  </span>
                  <span>
                    Saved revision {data.scenarioRevision} · Project version{" "}
                    {data.projectVersion}
                  </span>
                </div>
                {block && (
                  <div className="collab-notice">
                    <p>{block}</p>
                    {remoteChanged && onReopenSaved ? (
                      <CollaborationSaveButton
                        onSave={onReopenSaved}
                        label="Keep a copy & reopen saved"
                        busyLabel="Reopening saved project…"
                      />
                    ) : data.access.canEdit &&
                      hasUnsavedChanges &&
                      onRequireSave ? (
                      <CollaborationSaveButton onSave={onRequireSave} />
                    ) : null}
                  </div>
                )}
                {data.access.canComment && (
                  <section
                    className="collab-composer"
                    aria-label="Add a review comment"
                  >
                    <div className="collab-composer-target">
                      <label className="field">
                        Comment target
                        <select
                          value={
                            selectedTarget.kind === "project"
                              ? "general"
                              : "selected"
                          }
                          onChange={(event) =>
                            setOverride({
                              key: targetKey,
                              target:
                                event.target.value === "general"
                                  ? GENERAL_TARGET
                                  : (target ?? selectedTarget),
                              label:
                                event.target.value === "general"
                                  ? undefined
                                  : targetLabel,
                            })
                          }
                          disabled={!!busy}
                        >
                          <option value="general">
                            General project discussion
                          </option>
                          {((target?.kind && target.kind !== "project") ||
                            selectedTarget.kind !== "project") && (
                            <option value="selected">
                              {reviewTargetLabel(
                                selectedTarget.kind === "project"
                                  ? target
                                  : selectedTarget,
                                selectedTarget.kind === "project"
                                  ? targetLabel
                                  : selectedLabel,
                              )}
                            </option>
                          )}
                        </select>
                      </label>
                      <div className="collab-target-actions">
                        {onPickLocation && (
                          <button
                            className="button small"
                            onClick={onPickLocation}
                            disabled={!!busy}
                          >
                            <MapPin size={13} aria-hidden="true" /> Pick a map
                            location
                          </button>
                        )}
                        <button
                          className="button small"
                          onClick={() => setCoordinateOpen((value) => !value)}
                          aria-expanded={coordinateOpen}
                          disabled={!!busy}
                        >
                          <Compass size={13} aria-hidden="true" /> Enter
                          coordinates
                        </button>
                      </div>
                    </div>
                    {coordinateOpen && (
                      <div className="collab-coordinate-panel">
                        <p>
                          Pin a location using WGS84 decimal degrees. It must be
                          inside this project’s study area.
                        </p>
                        <div className="collab-coordinates">
                          <label className="field">
                            Latitude
                            <input
                              inputMode="decimal"
                              value={latitude}
                              onChange={(event) =>
                                setLatitude(event.target.value)
                              }
                              placeholder="33.4512"
                            />
                          </label>
                          <label className="field">
                            Longitude
                            <input
                              inputMode="decimal"
                              value={longitude}
                              onChange={(event) =>
                                setLongitude(event.target.value)
                              }
                              placeholder="−112.0738"
                            />
                          </label>
                          <button className="button" onClick={useCoordinates}>
                            Use coordinates
                          </button>
                        </div>
                        {coordinateError && (
                          <p className="collab-coordinate-error" role="alert">
                            {coordinateError}
                          </p>
                        )}
                      </div>
                    )}
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void mutate("comment");
                      }}
                    >
                      <label className="field">
                        New comment
                        <textarea
                          value={draft.text}
                          onChange={(event) => setText(event.target.value)}
                          rows={3}
                          maxLength={5000}
                          disabled={!!busy}
                          placeholder="What should the team consider here?"
                        />
                      </label>
                      <div className="collab-composer-footer">
                        <span>
                          Posted to saved revision {data.scenarioRevision}.
                          Comments are part of the project record.
                        </span>
                        <button
                          type="submit"
                          className="button primary"
                          disabled={!canWrite || !!busy || !draft.text.trim()}
                        >
                          {busy === "new" ? (
                            <Loader2
                              className="spin"
                              size={15}
                              aria-hidden="true"
                            />
                          ) : (
                            <Send size={15} aria-hidden="true" />
                          )}{" "}
                          Post comment
                        </button>
                      </div>
                    </form>
                  </section>
                )}
                <section
                  className="collab-discussion"
                  aria-label="Scenario discussion"
                >
                  <div className="collab-discussion-heading">
                    <div>
                      <h3>
                        Discussion <span>{comments?.length ?? 0}</span>
                      </h3>
                      <p>{openCount} open · This scenario only</p>
                    </div>
                    <label className="collab-filter">
                      Review status
                      <select
                        value={status}
                        onChange={(event) =>
                          setStatus(event.target.value as typeof status)
                        }
                      >
                        <option value="open">Open</option>
                        <option value="resolved">Resolved</option>
                        <option value="all">All</option>
                      </select>
                    </label>
                  </div>
                  {visibleComments.length ? (
                    <div className="collab-threads">
                      {visibleComments.map((comment) => (
                        <ReviewThread
                          key={comment.id}
                          comment={comment}
                          selected={comment.id === selectedCommentId}
                          canReply={canWrite}
                          busy={!!busy || resource.loading}
                          draft={draft.replies[comment.id] ?? ""}
                          onDraft={(text) => setReply(comment.id, text)}
                          onReply={() => void mutate("reply", comment)}
                          onResolve={() => void mutate("resolve", comment)}
                          onNavigate={onNavigateComment}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="collab-empty compact">
                      <MessageSquare size={25} aria-hidden="true" />
                      <h3>
                        {status === "resolved"
                          ? "No resolved threads yet."
                          : comments?.length
                            ? "Nothing open. A little breathing room."
                            : "A clear starting point."}
                      </h3>
                      <p>
                        {status === "resolved"
                          ? "Resolved discussions will stay here for future reference."
                          : comments?.length
                            ? "Switch the filter to see previous discussions."
                            : "Start with a question, an observation, or an idea for this scenario. Select a building or metric to give it a precise home."}
                      </p>
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
