import { useEffect, useRef, useState } from "react";
import { Loader2, Mail, RefreshCw, UserPlus } from "lucide-react";
import type { ProjectRole } from "@urban/core";
import type {
  IdentityInvitationsResponse,
  IdentityInvitationView,
} from "../../../../../apps/api/src/identity-types";
import { ApiError, type Session } from "../../lib/api";
import {
  identityApi,
  identityError,
  InvitationAttempts,
} from "../../lib/identity-api";
import { ROLE_DETAILS, reviewDate } from "../collaboration/shared";
import { useAccountSecurity } from "./useAccountSecurity";
import { useIdentityTask } from "./useIdentityTask";
import { DeliveryNotice } from "./IdentityFields";
import "./identity.css";
export interface ProjectInvitationsProps {
  projectId: string;
  session: Session;
  aclVersion: number;
  onAccountSecurity?: () => void;
  onTeamRefresh: () => void;
}
export function ProjectInvitations(props: ProjectInvitationsProps) {
  return (
    <ProjectInvitationContents
      key={`${props.session.user?.id}:${props.session.organization?.id}:${props.projectId}`}
      {...props}
    />
  );
}
function ProjectInvitationContents({
  projectId,
  session,
  aclVersion,
  onAccountSecurity,
  onTeamRefresh,
}: ProjectInvitationsProps) {
  const scope = `${session.user?.id}:${session.organization?.id}:${projectId}`;
  const task = useIdentityTask(scope);
  const security = useAccountSecurity(session.user?.id);
  const [data, setData] = useState<IdentityInvitationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [version, setVersion] = useState(0);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("commenter");
  const [notice, setNotice] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const attempts = useRef(new InvitationAttempts());
  const request = useRef<AbortController | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const refresh = () => {
    setVersion((value) => value + 1);
    security.refresh();
    task.setError("");
    onTeamRefresh();
  };
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setReadError("");
    void identityApi
      .invitations(projectId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setData(next);
          setNeedsRefresh(false);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setReadError(identityError(error));
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          setData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, version, aclVersion]);
  const disabled = task.busy || loading;
  const verified = !!security.data?.emailVerified;
  const mayInvite = verified && !!data?.delivery.available;
  const announce = (value: string) => {
    setNotice(value);
    requestAnimationFrame(() => status.current?.focus());
  };
  const acceptList = (next: IdentityInvitationsResponse) => {
    request.current?.abort();
    setData(next);
    setLoading(false);
    setReadError("");
  };
  function invite(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || !mayInvite) return;
    const body = attempts.current.for(
      projectId,
      email,
      role,
      data?.aclVersion ?? aclVersion,
    );
    void task.run(
      async (signal) => {
        try {
          return await identityApi.invite(projectId, body, signal);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          )
            attempts.current.clear();
          throw error;
        }
      },
      (next) => {
        attempts.current.clear();
        acceptList(next);
        setEmail("");
        announce(
          "Invitation retained and queued for delivery. Access is not granted until the recipient signs in, verifies their email and accepts. Delivery has not been confirmed.",
        );
      },
    );
  }
  function changeInvitation(
    invitation: IdentityInvitationView,
    operation: "resend" | "revoke",
  ) {
    if (disabled || needsRefresh || !verified) return;
    void task.run(
      (signal) =>
        identityApi[operation](
          projectId,
          invitation.id,
          invitation.version,
          signal,
        ),
      (next) => {
        acceptList(next);
        setRevokeId(null);
        announce(
          operation === "resend"
            ? "A replacement invitation was queued. The previous link is no longer valid. Delivery has not been confirmed."
            : "Pending invitation revoked. Existing project grants and review history are unchanged.",
        );
      },
      () => setNeedsRefresh(true),
    );
  }
  return (
    <section
      className="collab-section identity-panel"
      aria-label="Project invitations"
    >
      <div className="identity-section-heading">
        <h3>Invite someone to this project</h3>
        <button
          type="button"
          className="icon-button"
          disabled={disabled}
          onClick={refresh}
          aria-label="Refresh invitations"
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="identity-muted">
        A recipient can use an existing free account or create one. They review
        the project and role before accepting; an invitation alone grants no
        access.
      </p>
      {loading && <p role="status">Loading invitations…</p>}
      {readError && (
        <p role="alert" className="identity-error">
          {readError}
        </p>
      )}
      {security.error && (
        <p role="alert" className="identity-error">
          {security.error}
        </p>
      )}
      {data && (
        <>
          <DeliveryNotice delivery={data.delivery} />
          {security.data && !security.data.emailVerified && (
            <div className="identity-card">
              <p>
                Verify your email before sending new invitations. You can still
                manage existing grants above.
              </p>
              {onAccountSecurity && (
                <button
                  type="button"
                  className="button"
                  onClick={onAccountSecurity}
                >
                  Verify your email
                </button>
              )}
            </div>
          )}
          <form className="collab-add-member" onSubmit={invite}>
            <label className="field">
              <span>Invitation email</span>
              <input
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={disabled || !mayInvite}
                placeholder="colleague@example.org"
              />
            </label>
            <label className="field">
              <span>Invitation role</span>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as ProjectRole)}
                disabled={disabled || !mayInvite}
              >
                {Object.entries(ROLE_DETAILS).map(([value, detail]) => (
                  <option key={value} value={value}>
                    {detail.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={disabled || !mayInvite || !email.trim()}
            >
              {task.busy ? (
                <Loader2 size={15} className="spin" aria-hidden="true" />
              ) : (
                <UserPlus size={15} aria-hidden="true" />
              )}{" "}
              Send invitation
            </button>
            <p className="collab-role-help">
              {ROLE_DETAILS[role].description}
              {role === "owner"
                ? " Owners can grant and remove project access."
                : ""}
            </p>
          </form>
          <h4>Pending and recent invitations</h4>
          {data.invitations.length ? (
            <ul className="identity-rows">
              {data.invitations.map((invitation) => (
                <li
                  className="identity-invitation"
                  key={`${invitation.id}:${invitation.version}`}
                >
                  <div>
                    <strong className="identity-email">
                      {invitation.email}
                    </strong>
                    <small>
                      {ROLE_DETAILS[invitation.role].label} ·{" "}
                      {invitation.status === "pending"
                        ? "Pending acceptance"
                        : invitation.status === "accepted"
                          ? "Accepted"
                          : invitation.status === "expired"
                            ? "Expired"
                            : "Revoked"}
                    </small>
                    <small>
                      {invitation.status === "accepted" && invitation.acceptedAt
                        ? `Accepted ${reviewDate(invitation.acceptedAt)}`
                        : `Link expires ${reviewDate(invitation.expiresAt)}`}
                    </small>
                  </div>
                  {(invitation.status === "pending" ||
                    invitation.status === "expired") && (
                    <div className="identity-actions">
                      <button
                        type="button"
                        className="button small"
                        disabled={disabled || !mayInvite || needsRefresh}
                        onClick={() => changeInvitation(invitation, "resend")}
                        aria-label={`Resend invitation to ${invitation.email}`}
                      >
                        <Mail size={14} aria-hidden="true" />
                        Resend
                      </button>
                      <button
                        type="button"
                        className="button small"
                        disabled={disabled || needsRefresh || !verified}
                        onClick={() => setRevokeId(invitation.id)}
                        aria-label={`Revoke invitation to ${invitation.email}`}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                  {revokeId === invitation.id && (
                    <div
                      className="identity-invitation-confirm"
                      role="group"
                      aria-label={`Confirm invitation revocation for ${invitation.email}`}
                    >
                      <p>
                        Revoke this pending invitation? Its link will no longer
                        grant access. Existing membership is unchanged.
                      </p>
                      <div className="identity-actions">
                        <button
                          type="button"
                          className="button danger"
                          disabled={disabled || needsRefresh || !verified}
                          onClick={() => changeInvitation(invitation, "revoke")}
                        >
                          Revoke pending invitation
                        </button>
                        <button
                          type="button"
                          className="button"
                          disabled={disabled}
                          onClick={() => setRevokeId(null)}
                        >
                          Keep invitation
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="identity-muted">
              No invitations have been retained for this project.
            </p>
          )}
        </>
      )}
      {notice && (
        <p
          role="status"
          tabIndex={-1}
          ref={status}
          className="identity-notice identity-focus-target"
        >
          {notice}
        </p>
      )}
      {needsRefresh && (
        <p role="status" className="identity-notice">
          Refresh invitations before another resend or revocation. The previous
          request may already have changed its version.
        </p>
      )}
      {task.error && (
        <div className="identity-panel">
          <p role="alert" className="identity-error">
            {task.error}
          </p>
          <p className="identity-muted">
            If a resend response was lost, refresh invitations to check its
            current version before choosing Resend again.
          </p>
        </div>
      )}
    </section>
  );
}
