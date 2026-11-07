import { useState } from "react";
import { ArrowRight, Building2, Check, Loader2, LogOut } from "lucide-react";
import type { ProjectRole } from "@urban/core";
import { api, ApiError, type Session } from "../lib/api";
import { Modal } from "./Modal";
import {
  CollaborationError,
  CollaborationLoading,
  ROLE_DETAILS,
  useCollaborationResource,
} from "./collaboration/shared";
import "./collaboration/collaboration.css";

interface Workspace {
  id: string;
  name: string;
  role: ProjectRole;
  membershipScope?: "workspace" | "project-only";
}
export interface WorkspaceSwitcherProps {
  session: Session;
  onSession: (session: Session) => void;
  onSwitched?: () => void;
}

export function WorkspaceSwitcher({
  session,
  onSession,
  onSwitched,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const resource = useCollaborationResource<{ organizations: Workspace[] }>(
    session.user ? "/organizations" : null,
    open,
  );
  async function switchWorkspace(workspace: Workspace) {
    if (busy || workspace.id === session.organization?.id) return;
    setBusy(workspace.id);
    setError("");
    try {
      const updated = await api<Session>("/auth/organization", {
        method: "POST",
        body: JSON.stringify({ organizationId: workspace.id }),
      });
      onSession(updated);
      onSwitched?.();
      setOpen(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function signOut() {
    if (busy) return;
    setBusy("sign-out");
    setError("");
    try {
      await api("/auth/logout", { method: "POST" });
      onSession({ user: null });
      setOpen(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        // An expired or already-ended session is signed out; allow sign-in again.
        onSession({ user: null });
        setOpen(false);
      } else setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }
  if (!session.user) return null;
  return (
    <>
      <button
        className="button collab-workspace-trigger"
        onClick={() => setOpen(true)}
        aria-label="Switch workspace"
      >
        <Building2 size={15} aria-hidden="true" />
        <span>{session.organization?.name ?? "Your workspaces"}</span>
        <ArrowRight size={13} aria-hidden="true" />
      </button>
      <Modal
        title="Your workspaces"
        description="Open your own projects or projects shared with your free account."
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
      >
        <div className="collab-dialog">
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
          {resource.loading && !resource.data && (
            <CollaborationLoading label="Loading your workspaces…" />
          )}
          {resource.data && (
            <>
              <ul className="collab-workspaces">
                {resource.data.organizations.map((workspace) => (
                  <li key={workspace.id}>
                    <button
                      aria-label={`Open ${workspace.name} workspace`}
                      className={
                        workspace.id === session.organization?.id
                          ? "is-current"
                          : ""
                      }
                      disabled={
                        !!busy || workspace.id === session.organization?.id
                      }
                      onClick={() => void switchWorkspace(workspace)}
                    >
                      <div className="collab-intro-icon">
                        <Building2 size={20} aria-hidden="true" />
                      </div>
                      <div>
                        <strong>{workspace.name}</strong>
                        <span>
                          {workspace.membershipScope === "project-only"
                            ? "Shared projects only · Project roles apply"
                            : `${ROLE_DETAILS[workspace.role].label} · Workspace membership`}
                        </span>
                      </div>
                      {workspace.id === session.organization?.id ? (
                        <span className="collab-current">
                          <Check size={14} aria-hidden="true" />
                          Current
                        </span>
                      ) : busy === workspace.id ? (
                        <Loader2
                          size={16}
                          className="spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <ArrowRight size={16} aria-hidden="true" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {!resource.data.organizations.length && (
                <p className="collab-empty">
                  No workspaces are available for this account.
                </p>
              )}
              <p className="collab-disclosure">
                “Shared projects only” gives access to the projects you were
                added to. Other private projects in that workspace remain
                private. Switching workspaces does not delete browser drafts.
              </p>
            </>
          )}
          <div className="collab-signout">
            <p>
              Signed in as <strong>{session.user.email}</strong>. Signing out
              keeps browser drafts on this device; it does not delete your
              account.
            </p>
            <button
              className="button"
              disabled={!!busy}
              onClick={() => void signOut()}
            >
              {busy === "sign-out" ? (
                <Loader2 size={14} className="spin" aria-hidden="true" />
              ) : (
                <LogOut size={14} aria-hidden="true" />
              )}{" "}
              Sign out
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
