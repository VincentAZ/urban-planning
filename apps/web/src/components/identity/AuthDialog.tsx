import { useRef, useState } from "react";
import { ArrowRight, Globe2, Loader2, ShieldCheck } from "lucide-react";
import { api, type Session } from "../../lib/api";
import { identityApi } from "../../lib/identity-api";
import { Modal } from "../Modal";
import { useIdentityTask } from "./useIdentityTask";
import "./identity.css";

export interface AuthDialogProps {
  onClose: () => void;
  onSession: (session: Session) => void;
  initialMode?: "register" | "login";
  initialEmail?: string;
}
export function AuthDialog({
  onClose,
  onSession,
  initialMode = "register",
  initialEmail = "",
}: AuthDialogProps) {
  const [mode, setMode] = useState<"register" | "login" | "forgot">(
    initialMode,
  );
  const [email, setEmail] = useState(initialEmail);
  const [notice, setNotice] = useState("");
  const task = useIdentityTask(mode);
  const status = useRef<HTMLParagraphElement>(null);
  const requestClose = () => {
    if (!task.busy) onClose();
  };
  const changeMode = (next: typeof mode) => {
    if (task.busy) return;
    setMode(next);
    setNotice("");
    task.setError("");
  };
  return (
    <Modal
      title={
        mode === "register"
          ? "Make room for your ideas."
          : mode === "login"
            ? "Welcome back."
            : "Find your way back."
      }
      description="Free accounts. Private projects. No payment details."
      open
      onClose={requestClose}
    >
      <div className="identity-panel">
        <div className="auth-mark">
          <Globe2 size={34} aria-hidden="true" />
        </div>
        {mode === "forgot" && (
          <p>
            Enter your account email to request a password-reset link. Your
            saved projects and browser draft are kept.
          </p>
        )}
        <form
          key={mode}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            if (mode === "forgot") {
              void task.run(
                (signal) => identityApi.requestReset(email.trim(), signal),
                () => {
                  setNotice(
                    "If this address belongs to an eligible account, a password-reset link will be queued. This confirmation does not identify an account or confirm delivery. Use the link if it arrives; otherwise try again later.",
                  );
                  requestAnimationFrame(() => status.current?.focus());
                },
              );
            } else {
              void task.run(
                (signal) =>
                  api<Session>(`/auth/${mode}`, {
                    method: "POST",
                    signal,
                    body: JSON.stringify({
                      email: email.trim(),
                      password: form.get("password"),
                      ...(mode === "register"
                        ? { name: form.get("name") }
                        : {}),
                    }),
                  }),
                (result) => {
                  onSession(result);
                  onClose();
                },
              );
            }
          }}
        >
          {mode === "register" && (
            <label className="field">
              <span>Your name</span>
              <input
                name="name"
                autoComplete="name"
                required
                minLength={2}
                maxLength={240}
                disabled={task.busy}
              />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setNotice("");
              }}
              disabled={task.busy}
            />
          </label>
          {mode !== "forgot" && (
            <label className="field">
              <span>Password</span>
              <input
                name="password"
                aria-label="Password"
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                minLength={mode === "register" ? 12 : 1}
                maxLength={256}
                required
                disabled={task.busy}
              />
              <small>
                {mode === "register"
                  ? "At least 12 characters."
                  : "Use your current account password."}
              </small>
            </label>
          )}
          {task.error && (
            <p className="identity-error" role="alert">
              {task.error}
            </p>
          )}
          {notice && (
            <p
              className="identity-notice identity-focus-target"
              role="status"
              tabIndex={-1}
              ref={status}
            >
              {notice}
            </p>
          )}
          <button
            type="submit"
            className="button primary full-width"
            disabled={task.busy}
          >
            {task.busy && (
              <Loader2 size={16} className="spin" aria-hidden="true" />
            )}
            {mode === "register"
              ? "Create free account"
              : mode === "login"
                ? "Sign in"
                : "Request password reset"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </form>
        {mode === "login" && (
          <button
            type="button"
            className="text-button"
            disabled={task.busy}
            onClick={() => changeMode("forgot")}
          >
            Forgot password?
          </button>
        )}
        <p className="auth-switch">
          {mode === "register"
            ? "Already have an account?"
            : mode === "login"
              ? "New to Urban Planning?"
              : "Ready to sign in?"}{" "}
          <button
            type="button"
            className="text-button"
            disabled={task.busy}
            onClick={() => changeMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
        <div className="tip">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Your browser draft stays with you when you sign in.</span>
        </div>
      </div>
    </Modal>
  );
}
