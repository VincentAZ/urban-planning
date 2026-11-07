import { useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Mail,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { type Session } from "../../lib/api";
import { identityApi, passwordIssue } from "../../lib/identity-api";
import { Modal } from "../Modal";
import { PasswordFields, DeliveryNotice } from "./IdentityFields";
import { useAccountSecurity } from "./useAccountSecurity";
import { useIdentityTask } from "./useIdentityTask";
import "./identity.css";
export interface AccountSecurityDialogProps {
  session: Session;
  onSession: (session: Session) => void;
  onClose: () => void;
  onRequireSignIn?: () => void;
}
export function AccountSecurityDialog(props: AccountSecurityDialogProps) {
  const [passwordChanged, setPasswordChanged] = useState(false);
  if (passwordChanged && !props.session.user)
    return (
      <Modal
        title="Password changed."
        description="All account sessions have been signed out."
        open
        onClose={props.onClose}
      >
        <div className="identity-panel">
          <p role="status">
            Your projects are retained. Sign in with your new password to
            continue.
          </p>
          {props.onRequireSignIn && (
            <button
              type="button"
              className="button primary"
              onClick={props.onRequireSignIn}
            >
              Sign in
            </button>
          )}
        </div>
      </Modal>
    );
  return (
    <AccountSecurityContents
      key={props.session.user?.id ?? "guest"}
      {...props}
      onPasswordChanged={() => setPasswordChanged(true)}
    />
  );
}
function AccountSecurityContents({
  session,
  onSession,
  onClose,
  onRequireSignIn,
  onPasswordChanged,
}: AccountSecurityDialogProps & { onPasswordChanged: () => void }) {
  const security = useAccountSecurity(session.user?.id);
  const task = useIdentityTask(session.user?.id ?? "guest");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState("");
  const [changed, setChanged] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  const announce = (value: string) => {
    setNotice(value);
    requestAnimationFrame(() => status.current?.focus());
  };
  return (
    <Modal
      title="Your account, protected."
      description="Free account security and email verification."
      open
      onClose={() => {
        if (!task.busy) onClose();
      }}
    >
      <div className="identity-panel">
        {!session.user || changed ? (
          <>
            <p className="identity-notice" role="status">
              {changed
                ? "Password changed. All account sessions have been signed out. Your projects are retained; sign in with your new password."
                : "Sign in to review account security."}
            </p>
            {onRequireSignIn && (
              <button
                type="button"
                className="button primary"
                onClick={onRequireSignIn}
              >
                Sign in
              </button>
            )}
          </>
        ) : (
          <>
            <section className="identity-card" aria-label="Email verification">
              <div className="identity-card-heading">
                <ShieldCheck size={21} aria-hidden="true" />
                <h3>Your email</h3>
              </div>
              <p className="identity-email">{session.user.email}</p>
              {security.loading && (
                <p role="status">Checking verification and delivery…</p>
              )}
              {security.error && (
                <p role="alert" className="identity-error">
                  {security.error}
                </p>
              )}
              {security.data && (
                <>
                  <span
                    className={`identity-badge${security.data.emailVerified ? "" : " pending"}`}
                  >
                    {security.data.emailVerified ? (
                      <CheckCircle2 size={14} aria-hidden="true" />
                    ) : (
                      <Mail size={14} aria-hidden="true" />
                    )}
                    {security.data.emailVerified
                      ? "Email verified"
                      : "Email not yet verified"}
                  </span>
                  <p className="identity-muted">
                    Your private projects and existing access remain usable.
                    Verification is required to invite someone or accept a new
                    invitation.
                  </p>
                  {!security.data.emailVerified && (
                    <>
                      <DeliveryNotice delivery={security.data.delivery} />
                      <button
                        type="button"
                        className="button primary"
                        disabled={
                          task.busy || !security.data.delivery.available
                        }
                        onClick={() =>
                          void task.run(
                            (signal) => identityApi.requestVerification(signal),
                            () =>
                              announce(
                                "Verification request accepted. If delivery succeeds, open the link while signed in to this account and choose Verify this email. This screen does not confirm delivery.",
                              ),
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
                        Request verification email
                      </button>
                    </>
                  )}
                </>
              )}
              <button
                type="button"
                className="button"
                disabled={task.busy || security.loading}
                onClick={security.refresh}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Refresh account status
              </button>
            </section>
            {notice && (
              <p
                ref={status}
                tabIndex={-1}
                role="status"
                className="identity-notice identity-focus-target"
              >
                {notice}
              </p>
            )}
            <details className="identity-card">
              <summary>Change password</summary>
              <p className="identity-muted">
                Changing your password signs out every session. You will sign in
                again normally; your saved projects and browser draft stay in
                place.
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
                      identityApi.changePassword(
                        currentPassword,
                        password,
                        signal,
                      ),
                    () => {
                      setCurrentPassword("");
                      setPassword("");
                      setConfirmation("");
                      setChanged(true);
                      onPasswordChanged();
                      onSession({ user: null });
                    },
                  );
                }}
              >
                <label className="field">
                  <span>Current password</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={256}
                    value={currentPassword}
                    disabled={task.busy}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </label>
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
                  Change password and sign out
                </button>
              </form>
            </details>
          </>
        )}
        {task.error && (
          <p className="identity-error" role="alert">
            {task.error}
          </p>
        )}
      </div>
    </Modal>
  );
}
