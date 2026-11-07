import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CircleHelp,
  LockKeyhole,
  MapPin,
  RefreshCw,
  Send,
  ThumbsUp,
  TriangleAlert,
  X,
} from "lucide-react";
import { pointInStudyArea, type Place, type Position } from "@urban/core";
import type {
  PublicEngagement as EngagementState,
  OwnEngagementResponse,
  EngagementSubmissionResponse,
} from "../../../../../packages/core/src/engagement";
import { ApiError, api, type Session } from "../../lib/api";
import {
  SubmissionAttempts,
  answerFor,
  validateSurvey,
  type SubmissionDraft,
} from "./state";
import "./engagement-public.css";

type Draft = {
  owner: string | null;
  text: string;
  vote: "support" | "concern" | "neutral" | null;
  answers: Record<string, string>;
};
const emptyDraft = (owner: string | null): Draft => ({
  owner,
  text: "",
  vote: null,
  answers: {},
});
export function PublicEngagement({
  snapshotId,
  engagement,
  metadataReady,
  metadataError,
  place,
  session,
  sessionUnavailable,
  location,
  onLocationChange,
  onPickLocation,
  onRequireAuth,
  onSessionExpired,
  onRefresh,
  onUnavailable,
}: {
  snapshotId: string;
  engagement: EngagementState;
  metadataReady: boolean;
  metadataError?: boolean;
  place: Place;
  session: Session;
  sessionUnavailable: boolean;
  location: Position | null;
  onLocationChange: (position: Position | null) => void;
  onPickLocation: () => void;
  onRequireAuth: () => void;
  onSessionExpired: () => void;
  onRefresh: () => void;
  onUnavailable: () => void;
}) {
  const userId = session.user?.id ?? null;
  const [draftState, setDraft] = useState<Draft>(() => emptyDraft(userId));
  const draft =
    draftState.owner === userId || (draftState.owner === null && userId)
      ? draftState
      : emptyDraft(userId);
  const [busy, setBusy] = useState<
    "comment" | "vote" | "survey" | "sign-out" | null
  >(null);
  const busyRef = useRef(false),
    attempts = useRef(new SubmissionAttempts());
  const [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [coordinatesOpen, setCoordinatesOpen] = useState(false),
    [latitude, setLatitude] = useState(""),
    [longitude, setLongitude] = useState("");
  const own = useQuery({
    queryKey: ["own-engagement", snapshotId, userId],
    queryFn: async ({ signal }) => {
      const result = await api<OwnEngagementResponse>(
        `/published/${encodeURIComponent(snapshotId)}/feedback/mine`,
        { signal },
      );
      if (result.userId !== userId)
        throw new ApiError(
          "Your account changed while loading responses. Checking your current session…",
          401,
          "ACCOUNT_CHANGED",
        );
      return result;
    },
    enabled: !!userId,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const config = engagement.config;
  const open = engagement.collection.status === "open";
  const history = userId ? (own.data?.responses ?? []) : [];
  const activeVote = history.find((r) => r.kind === "vote" && r.current);
  const activeSurvey = history.find((r) => r.kind === "survey" && r.current);
  const currentScope = `${snapshotId}:${userId ?? "guest"}`;
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  const hydrationKey = useRef("");
  useEffect(() => {
    setDraft((old) =>
      old.owner === userId
        ? old
        : old.owner === null && userId
          ? { ...old, owner: userId }
          : emptyDraft(userId),
    );
    attempts.current.clear();
    setError("");
    setSuccess("");
    hydrationKey.current = "";
    setCoordinatesOpen(false);
    setLatitude("");
    setLongitude("");
  }, [userId, snapshotId]);
  useEffect(() => {
    if (
      !userId ||
      !own.data ||
      hydrationKey.current === `${snapshotId}:${userId}`
    )
      return;
    hydrationKey.current = `${snapshotId}:${userId}`;
    const records = own.data.responses;
    setDraft((old) => ({
      ...old,
      owner: userId,
      vote:
        old.vote ??
        records.find((r) => r.kind === "vote" && r.current)?.vote ??
        null,
      answers: {
        ...records.find((r) => r.kind === "survey" && r.current)?.answers,
        ...old.answers,
      },
    }));
  }, [own.data, userId, snapshotId]);
  useEffect(() => {
    if (own.error instanceof ApiError && own.error.status === 401)
      onSessionExpired();
    if (own.error instanceof ApiError && own.error.status === 404)
      onUnavailable();
  }, [own.error, onSessionExpired, onUnavailable]);
  const updateDraft = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch, owner: userId });
    setSuccess("");
  };
  const unavailable =
    !metadataReady || !open || (!!userId && !own.isSuccess) || !!busy;

  async function submit(kind: "comment" | "vote" | "survey") {
    if (busyRef.current) return;
    if (!userId) {
      onRequireAuth();
      return;
    }
    if (unavailable) return;
    setError("");
    setSuccess("");
    let payload: SubmissionDraft;
    const expectedCollectionVersion = engagement.collection.version;
    if (kind === "comment") {
      if (!draft.text.trim()) {
        setError("Add a comment before sending.");
        return;
      }
      if (!config.comments && !location) {
        setError(
          "This snapshot collects map comments. Choose a location first.",
        );
        return;
      }
      if (location && (!config.pins || !pointInStudyArea(location, place))) {
        setError("Choose a location inside this published study area.");
        return;
      }
      payload = {
        kind,
        text: draft.text.trim(),
        ...(location ? { position: location } : {}),
        expectedCollectionVersion,
      };
    } else if (kind === "vote") {
      if (!draft.vote) {
        setError("Choose a response first.");
        return;
      }
      payload = { kind, vote: draft.vote, expectedCollectionVersion };
    } else {
      const invalid = validateSurvey(config.questions, draft.answers);
      if (invalid) {
        setError(invalid);
        return;
      }
      payload = {
        kind,
        answers: Object.fromEntries(
          config.questions
            .map((q) => [q.id, answerFor(draft.answers, q.id).trim()])
            .filter(([, value]) => value),
        ),
        expectedCollectionVersion,
      };
    }
    const body = attempts.current.for(payload);
    const requestScope = currentScope;
    busyRef.current = true;
    setBusy(kind);
    try {
      const response = await api<EngagementSubmissionResponse>(
        `/published/${encodeURIComponent(snapshotId)}/feedback`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (scopeRef.current !== requestScope) return;
      attempts.current.complete(kind);
      if (kind === "comment") {
        setDraft((old) => ({ ...old, text: "" }));
        onLocationChange(null);
      }
      setSuccess(
        response.alreadySubmitted
          ? "This response was already received. No duplicate was added."
          : kind === "comment"
            ? "Your comment was sent to the project team. Thank you for contributing."
            : kind === "survey"
              ? "Your survey was saved. A later submission replaces your active survey response."
              : "Your response was saved. Submitting another response replaces your earlier vote.",
      );
      await own.refetch();
    } catch (failure) {
      if (scopeRef.current !== requestScope) return;
      if (
        failure instanceof ApiError &&
        (failure.status === 401 || failure.code === "CSRF_REQUIRED")
      ) {
        onSessionExpired();
        setError("Your session ended. Sign in again to send this response.");
      } else if (failure instanceof ApiError && failure.status === 404)
        onUnavailable();
      else {
        setError(
          failure instanceof ApiError && failure.status < 500
            ? failure.message
            : "We couldn't confirm this submission. Use Send again to retry safely without adding a duplicate.",
        );
      }
      if (failure instanceof ApiError && failure.status === 409) {
        // These checks run after the server's idempotency lookup, so this attempt
        // is known not to have committed. A later retry may use refreshed metadata.
        if (
          ["COLLECTION_CONFLICT", "COLLECTION_CLOSED"].includes(
            failure.code ?? "",
          )
        )
          attempts.current.reject(kind);
        onRefresh();
      }
      // Keep the exact request/key after an uncertain network result; clicking Send again retries safely.
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }
  async function signOut() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("sign-out");
    try {
      await api("/auth/logout", { method: "POST" });
      onSessionExpired();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401)
        onSessionExpired();
      else setError((failure as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }
  function useCoordinates() {
    const position: Position = [Number(longitude), Number(latitude)];
    if (
      !latitude.trim() ||
      !longitude.trim() ||
      !position.every(Number.isFinite) ||
      !pointInStudyArea(position, place)
    ) {
      setError(
        "Enter valid latitude and longitude inside the published study area.",
      );
      return;
    }
    onLocationChange(position);
    setError("");
    setCoordinatesOpen(false);
  }
  return (
    <div className="engagement-public">
      <div className="shared-eyebrow">Better places, together</div>
      <h2>Your perspective matters.</h2>
      {config.introduction ? (
        <p className="engagement-introduction">{config.introduction}</p>
      ) : (
        <p>
          Help the project team understand what works for you and what deserves
          another look.
        </p>
      )}
      <div
        className={`engagement-collection ${open ? "is-open" : "is-closed"}`}
        role="status"
      >
        <strong>
          {metadataReady
            ? open
              ? "Open for feedback"
              : "Feedback collection is closed"
            : "Checking feedback availability…"}
        </strong>
        <span>
          {open
            ? "The published proposal and questions stay fixed."
            : "You can still explore the proposal and read your own prior responses."}
        </span>
        <button type="button" className="text-button" onClick={onRefresh}>
          <RefreshCw size={13} /> Refresh availability
        </button>
      </div>
      {metadataError && (
        <p className="error-message" role="alert">
          Feedback availability could not be checked. Refresh availability
          before sending a response.
        </p>
      )}
      {!session.user ? (
        <div className="shared-signin-note">
          <LockKeyhole size={18} />
          <div>
            <strong>A free account to add your voice</strong>
            <p>
              You can explore everything without signing in. An account is
              needed to submit feedback.
            </p>
            <button className="button primary" onClick={onRequireAuth}>
              Sign in or join free <ArrowRight size={14} />
            </button>
            {sessionUnavailable && (
              <small>
                We couldn’t check your sign-in status. Signing in will retry the
                connection.
              </small>
            )}
          </div>
        </div>
      ) : (
        <p className="shared-signed-in">
          <Check size={14} /> Responding as {session.user.name}
          <button
            type="button"
            className="text-button"
            disabled={!!busy}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </p>
      )}
      {userId && own.isPending && (
        <p role="status">Checking your previous responses…</p>
      )}
      {userId && own.isError && (
        <div className="error-message" role="alert">
          We couldn’t load your previous responses.{" "}
          <button className="text-button" onClick={() => void own.refetch()}>
            Retry previous responses
          </button>
        </div>
      )}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="shared-feedback-success" role="status">
          <Check size={17} />
          <p>{success}</p>
        </div>
      )}
      {config.votes && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit("vote");
          }}
        >
          <fieldset className="shared-vote" disabled={!open || !!busy}>
            <legend>How do you feel about this proposal?</legend>
            {(
              [
                ["support", "I see promise here", ThumbsUp],
                ["concern", "I have concerns", TriangleAlert],
                ["neutral", "I need more information", CircleHelp],
              ] as const
            ).map(([value, label, Icon]) => (
              <label
                key={value}
                className={draft.vote === value ? "selected" : ""}
              >
                <input
                  type="radio"
                  name="public-response"
                  value={value}
                  checked={draft.vote === value}
                  onChange={() => updateDraft({ vote: value })}
                />
                <Icon size={16} />
                <span>{label}</span>
              </label>
            ))}
            {activeVote && (
              <p className="muted small">
                One active response per account. Sending again replaces your
                previous vote.
              </p>
            )}
            <button
              className="button full-width"
              disabled={!draft.vote || unavailable}
            >
              {busy === "vote" ? "Sending…" : "Send response"}
            </button>
          </fieldset>
        </form>
      )}
      {(config.comments || config.pins) && (
        <form
          className="shared-comment"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("comment");
          }}
        >
          <label htmlFor="public-comment">
            What would you like the team to know?
          </label>
          <textarea
            id="public-comment"
            value={draft.text}
            onChange={(event) => updateDraft({ text: event.target.value })}
            maxLength={5000}
            rows={5}
            placeholder="Share an idea, concern, or local perspective…"
            required
            disabled={!open || !!busy}
          />
          <div className="shared-comment-count">
            {draft.text.length.toLocaleString()} / 5,000
          </div>
          {config.pins && (
            <div className="engagement-pin-controls">
              <div>
                <button
                  type="button"
                  className="button compact"
                  onClick={onPickLocation}
                  disabled={!open || !!busy}
                >
                  <MapPin size={14} /> Pick a map location
                </button>
                <button
                  type="button"
                  className="button compact"
                  onClick={() => setCoordinatesOpen((v) => !v)}
                  disabled={!open || !!busy}
                >
                  Enter coordinates
                </button>
              </div>
              {location && (
                <div className="public-engagement-location" role="status">
                  <MapPin size={15} />
                  <span>
                    Comment location: {location[1].toFixed(5)},{" "}
                    {location[0].toFixed(5)}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remove comment location"
                    onClick={() => onLocationChange(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {coordinatesOpen && draftState.owner === userId && (
                <fieldset
                  className="engagement-coordinates"
                  disabled={!open || !!busy}
                >
                  <legend>Location in the published study area</legend>
                  <label className="field">
                    <span>Latitude</span>
                    <input
                      inputMode="decimal"
                      value={latitude}
                      onChange={(event) => setLatitude(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Longitude</span>
                    <input
                      inputMode="decimal"
                      value={longitude}
                      onChange={(event) => setLongitude(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="button compact"
                    onClick={useCoordinates}
                  >
                    Use coordinates
                  </button>
                </fieldset>
              )}
            </div>
          )}
          {!config.comments && (
            <p className="muted small">
              Attach a location to this map comment.
            </p>
          )}
          <button
            className="button primary full-width"
            disabled={
              !draft.text.trim() ||
              (!config.comments && !location) ||
              unavailable
            }
          >
            {busy === "comment" ? "Sending…" : "Send comment"}
            <Send size={14} />
          </button>
        </form>
      )}
      {config.questions.length > 0 && (
        <form
          className="engagement-survey"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("survey");
          }}
          noValidate
        >
          <h3>A few focused questions</h3>
          <p className="muted small">
            {activeSurvey
              ? "Your active survey is shown below. Sending again replaces it."
              : "One active survey per account. Required questions are marked."}
          </p>
          <fieldset disabled={!open || !!busy}>
            <legend className="sr-only">Published survey</legend>
            {config.questions.map((question, index) => (
              <fieldset
                className="engagement-survey-question"
                key={question.id}
              >
                <legend>
                  {index + 1}. {question.prompt}
                  {question.required && <span> (required)</span>}
                </legend>
                {question.type === "text" ? (
                  <textarea
                    aria-label={question.prompt}
                    required={question.required}
                    maxLength={2000}
                    rows={3}
                    value={answerFor(draft.answers, question.id)}
                    onChange={(event) =>
                      updateDraft({
                        answers: {
                          ...draft.answers,
                          [question.id]: event.target.value,
                        },
                      })
                    }
                  />
                ) : (
                  question.options?.map((option) => (
                    <label key={option}>
                      <input
                        type="radio"
                        name={`survey-${question.id}`}
                        value={option}
                        checked={
                          answerFor(draft.answers, question.id) === option
                        }
                        onChange={() =>
                          updateDraft({
                            answers: {
                              ...draft.answers,
                              [question.id]: option,
                            },
                          })
                        }
                      />
                      {option}
                    </label>
                  ))
                )}
              </fieldset>
            ))}
          </fieldset>
          <button className="button primary full-width" disabled={unavailable}>
            {busy === "survey" ? "Sending…" : "Send survey"}
            <Send size={14} />
          </button>
        </form>
      )}
      {history.length > 0 && (
        <details className="engagement-own-history">
          <summary>Your submitted responses ({history.length})</summary>
          <p>
            Only your responses appear here. Other participants’ feedback is
            private.
          </p>
          {history.map((response) => (
            <article key={response.id}>
              <strong>
                {response.kind === "comment"
                  ? "Comment"
                  : response.kind === "vote"
                    ? "Proposal response"
                    : "Survey"}
                {response.current ? " · Current" : " · Replaced"}
              </strong>
              <time dateTime={response.createdAt}>
                {new Date(response.createdAt).toLocaleString()}
              </time>
              {response.text && <p>{response.text}</p>}
              {response.vote && (
                <p>
                  {response.vote === "support"
                    ? "I see promise here"
                    : response.vote === "concern"
                      ? "I have concerns"
                      : "I need more information"}
                </p>
              )}
              {response.answers && (
                <dl>
                  {config.questions
                    .filter((q) => response.answers?.[q.id])
                    .map((q) => (
                      <div key={q.id}>
                        <dt>{q.prompt}</dt>
                        <dd>{response.answers![q.id]}</dd>
                      </div>
                    ))}
                </dl>
              )}
              {response.position && (
                <small>
                  Location: {response.position[1].toFixed(5)},{" "}
                  {response.position[0].toFixed(5)}
                </small>
              )}
            </article>
          ))}
        </details>
      )}
      <p className="shared-feedback-privacy">
        Feedback is delivered to the project team and may appear in project
        records or an exported engagement report. Your account details are not
        displayed on this public map. Avoid sensitive personal information. One
        account is not proof of one resident, and responses are not a
        representative survey.
      </p>
    </div>
  );
}
