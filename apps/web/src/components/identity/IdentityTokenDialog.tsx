import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Mail,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import type { IdentityInvitationPreview } from "../../../../../apps/api/src/identity-types";
import { api, type Session } from "../../lib/api";
import {
  identityApi,
  passwordIssue,
  type IdentityIntent,
  type IdentityInvitationAccepted,
} from "../../lib/identity-api";
import { Modal } from "../Modal";
import { ROLE_DETAILS, reviewDate } from "../collaboration/shared";
import { PasswordFields } from "./IdentityFields";
import { useAccountSecurity } from "./useAccountSecurity";
import { useIdentityTask } from "./useIdentityTask";
import "./identity.css";
export interface IdentityTokenDialogProps {
  intent: IdentityIntent;
  session: Session;
  onSession: (session: Session) => void;
  onRequireSignIn: (email?: string) => void;
  onAccountSecurity?: () => void;
  onAccepted?: (result: IdentityInvitationAccepted) => void;
  onClose: () => void;
}
export function IdentityTokenDialog(props: IdentityTokenDialogProps) {
  const account =
    props.intent.kind === "password-reset"
      ? "reset"
      : (props.session.user?.id ?? "guest");
  const instance = useMemo(
    () => crypto.randomUUID(),
    [props.intent.kind, props.intent.token, account],
  );
  return <IdentityTokenContents key={instance} {...props} />;
}
function IdentityTokenContents(props: IdentityTokenDialogProps) {
  const {
    intent,
    session,
    onSession,
    onRequireSignIn,
    onAccountSecurity,
    onAccepted,
    onClose,
  } = props;
  const task = useIdentityTask(
    `${intent.kind}:${intent.token}:${intent.kind === "password-reset" ? "reset" : (session.user?.id ?? "guest")}`,
  );
  const security = useAccountSecurity(
    intent.kind === "password-reset" ? undefined : session.user?.id,
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [complete, setComplete] = useState(false);
  const [preview, setPreview] = useState<IdentityInvitationPreview | null>(
    null,
  );
  const focus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview || complete) focus.current?.focus();
  }, [preview, complete]);
  const signIn = (switchAccount = false) => {
    // Root owns sign-out/account switching and retains the token only in memory.
    onRequireSignIn(switchAccount ? undefined : session.user?.email);
  };
  const title =
    intent.kind === "password-reset"
      ? "Choose a fresh password."
      : intent.kind === "verify-email"
        ? "Confirm your email."
        : "An invitation to work together.";
  return (
    <Modal
      title={title}
      description="Opening this link does not change your account or project access."
      open
      onClose={() => {
        if (!task.busy) onClose();
      }}
    >
      <div className="identity-panel">
        <div className="auth-mark">
          {intent.kind === "invitation" ? (
            <UserCheck size={32} aria-hidden="true" />
          ) : (
            <ShieldCheck size={32} aria-hidden="true" />
          )}
        </div>
        {intent.kind === "password-reset" ? (
          complete ? (
            <div
              className="identity-panel identity-focus-target"
              tabIndex={-1}
              ref={focus}
              role="group"
              aria-label="Password reset complete"
            >
              <p role="status">
                Password reset. All account sessions have been signed out. Your
                projects are retained.
              </p>
              <button
                type="button"
                className="button primary"
                onClick={() => onRequireSignIn()}
              >
                Sign in with your new password
              </button>
            </div>
          ) : (
            <>
              <p>
                Set a new password for the account that requested this link.
                This signs out all its sessions. It does not sign you in
                automatically.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const issue = passwordIssue(password, confirmation);
                  if (issue) {
                    task.setError(issue);
                    return;
                  }
                  void task.run(
                    (signal) =>
                      identityApi.resetPassword(intent.token, password, signal),
                    () => {
                      setPassword("");
                      setConfirmation("");
                      setComplete(true);
                      onSession({ user: null });
                    },
                  );
                }}
              >
                <PasswordFields
                  password={password}
                  confirmation={confirmation}
                  onPassword={setPassword}
                  onConfirmation={setConfirmation}
                  disabled={task.busy}
                />
                <button
                  type="submit"
                  className="button primary"
                  disabled={task.busy}
                >
                  {task.busy && (
                    <Loader2 size={15} className="spin" aria-hidden="true" />
                  )}
                  Reset password
                </button>
              </form>
            </>
          )
        ) : !session.user ? (
          <>
            <p>
              Sign in to the account that received this link. Invitation details
              stay private until the recipient is verified.
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => onRequireSignIn()}
            >
              Sign in to continue
            </button>
          </>
        ) : (
          <>
            <div className="identity-card">
              <span className="identity-muted">Signed in as</span>
              <strong className="identity-email">{session.user.email}</strong>
              <button
                type="button"
                className="text-button"
                disabled={task.busy}
                onClick={() => signIn(true)}
              >
                Use a different account
              </button>
            </div>
            {security.loading && <p role="status">Checking this account…</p>}
            {security.error && (
              <>
                <p role="alert" className="identity-error">
                  {security.error}
                </p>
                <button
                  type="button"
                  className="button"
                  onClick={security.refresh}
                >
                  Refresh account status
                </button>
              </>
            )}
            {intent.kind === "verify-email" ? (
              complete ? (
                <div
                  ref={focus}
                  tabIndex={-1}
                  className="identity-panel identity-focus-target"
                  role="group"
                  aria-label="Email verification complete"
                >
                  <p role="status">
                    <CheckCircle2 size={18} aria-hidden="true" /> Your email is
                    verified.
                  </p>
                  <button
                    type="button"
                    className="button primary"
                    onClick={onClose}
                  >
                    Continue
                  </button>
                </div>
              ) : (
                <>
                  <p>
                    Verify the email on this signed-in account. A link issued to
                    another account cannot verify this one.
                  </p>
                  <button
                    type="button"
                    className="button primary"
                    disabled={task.busy || security.loading || !security.data}
                    onClick={() =>
                      void task.run(
                        async (signal) => {
                          await identityApi.verifyEmail(intent.token, signal);
                          // The token operation succeeded even if a subsequent session refresh is offline.
                          return api<Session>("/auth/session", {
                            signal,
                          }).catch(() => null);
                        },
                        (next) => {
                          setComplete(true);
                          if (next?.user && next.user.id === session.user?.id)
                            onSession(next);
                          security.refresh();
                        },
                      )
                    }
                  >
                    {task.busy && (
                      <Loader2 size={15} className="spin" aria-hidden="true" />
                    )}
                    Verify this email
                  </button>
                </>
              )
            ) : complete ? (
              <div
                ref={focus}
                tabIndex={-1}
                className="identity-panel identity-focus-target"
                role="group"
                aria-label="Invitation accepted"
              >
                <p role="status">
                  Invitation accepted. Your existing browser draft is still
                  here.
                </p>
                <button
                  type="button"
                  className="button primary"
                  onClick={onClose}
                >
                  Continue
                </button>
              </div>
            ) : security.data && !security.data.emailVerified ? (
              <>
                <p className="identity-notice">
                  <Mail size={16} aria-hidden="true" /> Verify this account’s
                  email before reviewing an invitation. The invitation remains
                  pending.
                </p>
                {onAccountSecurity && (
                  <button
                    type="button"
                    className="button primary"
                    onClick={onAccountSecurity}
                  >
                    Open account security
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  onClick={security.refresh}
                >
                  Refresh verification status
                </button>
              </>
            ) : (
              security.data?.emailVerified && (
                <>
                  {!preview ? (
                    <>
                      <p>
                        Review the destination and role before accepting. The
                        account must match the invited email address; an
                        unavailable link does not reveal project details.
                      </p>
                      <button
                        type="button"
                        className="button primary"
                        disabled={task.busy}
                        onClick={() =>
                          void task.run(
                            (signal) =>
                              identityApi.previewInvitation(
                                intent.token,
                                signal,
                              ),
                            setPreview,
                          )
                        }
                      >
                        {task.busy && (
                          <Loader2
                            size={15}
                            className="spin"
                            aria-hidden="true"
                          />
                        )}
                        Review invitation
                      </button>
                    </>
                  ) : (
                    <section
                      ref={focus}
                      tabIndex={-1}
                      className="identity-card identity-focus-target"
                      aria-label="Invitation details"
                    >
                      <h3>Review your access</h3>
                      <dl className="identity-summary">
                        <div>
                          <dt>Invited email</dt>
                          <dd>{preview.invitation.email}</dd>
                        </div>
                        <div>
                          <dt>Workspace</dt>
                          <dd>{preview.organization.name}</dd>
                        </div>
                        <div>
                          <dt>Access applies to</dt>
                          <dd>
                            {preview.invitation.scope === "project"
                              ? (preview.project?.name ?? "This saved project")
                              : "Workspace membership"}
                          </dd>
                        </div>
                        <div>
                          <dt>Role</dt>
                          <dd>{ROLE_DETAILS[preview.invitation.role].label}</dd>
                        </div>
                        <div>
                          <dt>Link expires</dt>
                          <dd>{reviewDate(preview.invitation.expiresAt)}</dd>
                        </div>
                      </dl>
                      <p>
                        {preview.invitation.scope === "project"
                          ? ROLE_DETAILS[preview.invitation.role].description
                          : `You will join this workspace as ${ROLE_DETAILS[preview.invitation.role].label.toLowerCase()}. This membership can apply to more than one saved project.`}
                      </p>
                      <p className="identity-muted">
                        {preview.invitation.scope === "project"
                          ? "This invitation grants access to this project. It does not add workspace-wide membership."
                          : "Workspace membership may provide access to projects that inherit workspace permissions. Project-specific access rules still apply."}
                      </p>
                      <div className="identity-actions">
                        <button
                          type="button"
                          className="button primary"
                          disabled={task.busy}
                          onClick={() =>
                            void task.run(
                              (signal) =>
                                identityApi.acceptInvitation(
                                  intent.token,
                                  preview.invitation.version,
                                  preview.aclVersion,
                                  signal,
                                ),
                              (result) => {
                                setComplete(true);
                                onAccepted?.(result);
                              },
                            )
                          }
                        >
                          {task.busy && (
                            <Loader2
                              size={15}
                              className="spin"
                              aria-hidden="true"
                            />
                          )}
                          Accept invitation
                        </button>
                        <button
                          type="button"
                          className="button"
                          disabled={task.busy}
                          onClick={() => {
                            setPreview(null);
                            task.setError("");
                          }}
                        >
                          Review again
                        </button>
                      </div>
                    </section>
                  )}
                </>
              )
            )}
          </>
        )}
        {task.error && (
          <p className="identity-error" role="alert">
            {task.error}
          </p>
        )}
        {intent.kind === "password-reset" && !complete && (
          <button
            type="button"
            className="text-button"
            disabled={task.busy}
            onClick={() => onRequireSignIn()}
          >
            Return to sign in or request a new reset link
          </button>
        )}
      </div>
    </Modal>
  );
}
