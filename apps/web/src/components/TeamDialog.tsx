import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, ShieldCheck, Users, X } from "lucide-react";
import type {
  ProjectAccess,
  ProjectMember,
  ProjectMembersResponse,
  ProjectRole,
} from "@urban/core";
import { api, type Session } from "../lib/api";
import { Modal } from "./Modal";
import { ProjectInvitations } from "./identity/ProjectInvitations";
import {
  CollaborationError,
  CollaborationGate,
  CollaborationLoading,
  ROLE_DETAILS,
  useCollaborationResource,
} from "./collaboration/shared";
import "./collaboration/collaboration.css";

export interface TeamDialogProps {
  projectId: string | null;
  projectName: string;
  session: Session;
  savedVersion?: number | null;
  onClose: () => void;
  onRequireAccount?: () => void;
  onRequireSave?: () => void | Promise<void>;
  onAccessChanged?: (access: ProjectAccess | null) => void;
  onAccountSecurity?: () => void;
}
function MemberRow({
  member,
  currentUserId,
  lastOwner,
  canManage,
  busy,
  onRole,
  onRemove,
}: {
  member: ProjectMember;
  currentUserId?: string;
  lastOwner: boolean;
  canManage: boolean;
  busy: boolean;
  onRole: (role: ProjectRole) => void;
  onRemove: () => void;
}) {
  const [role, setRole] = useState(member.role);
  const [confirm, setConfirm] = useState(false);
  const own = member.userId === currentUserId;
  const protectedOwner = lastOwner && member.role === "owner";
  return (
    <li className="collab-member">
      <div className="collab-avatar" aria-hidden="true">
        {member.name.trim().slice(0, 1).toUpperCase() || "?"}
      </div>
      <div className="collab-member-person">
        <strong>
          {member.name}
          {own && <span className="collab-you">You</span>}
        </strong>
        <span>{member.email}</span>
        {protectedOwner && (
          <small>Last project owner · keep at least one owner</small>
        )}
      </div>
      {canManage ? (
        <div className="collab-member-actions">
          <label>
            <span className="sr-only">Role for {member.name}</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as ProjectRole)}
              disabled={busy || protectedOwner}
            >
              {Object.entries(ROLE_DETAILS).map(([value, detail]) => (
                <option value={value} key={value}>
                  {detail.label}
                </option>
              ))}
            </select>
          </label>
          {role !== member.role && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => onRole(role)}
              aria-label={`Save role for ${member.name}`}
            >
              <Check size={13} aria-hidden="true" /> Save
            </button>
          )}
          <button
            className="icon-button"
            disabled={busy || protectedOwner}
            onClick={() => setConfirm(true)}
            aria-label={`Remove ${member.name} from project`}
            title="Remove project access"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <span className="collab-role">{ROLE_DETAILS[member.role].label}</span>
      )}
      {confirm && (
        <div className="collab-remove-confirm">
          <p>
            Remove {member.name}’s access to this project? Their existing review
            history stays in the record.
          </p>
          <div>
            <button
              className="button danger"
              disabled={busy}
              onClick={onRemove}
            >
              Remove access
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Keep access
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function TeamDialog(props: TeamDialogProps) {
  return (
    <TeamContents
      key={`${props.session.user?.id}:${props.session.organization?.id}:${props.projectId}`}
      {...props}
    />
  );
}
function TeamContents({
  projectId,
  projectName,
  session,
  onClose,
  onRequireAccount,
  onRequireSave,
  onAccessChanged,
  onAccountSecurity,
}: TeamDialogProps) {
  const path =
    session.user && projectId
      ? `/projects/${encodeURIComponent(projectId)}/members`
      : null;
  const resource = useCollaborationResource<ProjectMembersResponse>(path);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const data = resource.data;
  const currentPath = useRef(path);
  currentPath.current = path;
  const changing = useRef(false);
  const mounted = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutation.current?.abort();
    };
  }, []);
  const canManage = data?.access?.canManageMembers ?? false;
  const ownerCount =
    data?.members.filter((member) => member.role === "owner").length ?? 0;
  async function change(
    method: "PATCH" | "DELETE",
    memberId?: string,
    nextRole?: ProjectRole,
  ) {
    if (!path || !data?.access?.canManageMembers || changing.current) return;
    changing.current = true;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(memberId ?? "add");
    setError("");
    setMessage("");
    try {
      const updated = await api<ProjectMembersResponse>(
        `${path}${memberId ? `/${encodeURIComponent(memberId)}` : ""}`,
        {
          method,
          signal: controller.signal,
          body: JSON.stringify({
            expectedAclVersion: data.access.aclVersion,
            ...(method === "PATCH" ? { role: nextRole } : {}),
          }),
        },
      );
      if (
        !mounted.current ||
        controller.signal.aborted ||
        currentPath.current !== path
      )
        return;
      resource.replace(updated);
      onAccessChanged?.(updated.access);
      setMessage(
        updated.accessRevoked
          ? "Your access to this project was removed. Review history was retained."
          : method === "PATCH"
            ? "Project role updated."
            : "Project access removed. Review history was retained.",
      );
    } catch (failure) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        currentPath.current === path
      )
        setError((failure as Error).message);
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  return (
    <Modal
      title="Project team"
      description={`Access to ${projectName} · Free accounts, shared work.`}
      wide
      open
      onClose={onClose}
    >
      <div className="collab-dialog">
        <CollaborationGate
          session={session}
          projectId={projectId}
          onRequireAccount={onRequireAccount}
          onRequireSave={onRequireSave}
        />
        {path && (
          <>
            {resource.loading && !data && (
              <CollaborationLoading label="Loading project access…" />
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
            {data?.access && (
              <>
                <div className="collab-intro">
                  <div className="collab-intro-icon">
                    <Users size={22} aria-hidden="true" />
                  </div>
                  <div>
                    <h3>Good decisions take a few perspectives.</h3>
                    <p>
                      Give each person the right access to this saved project.
                      Sharing here does not grant access to your other private
                      projects.
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => void resource.reload()}
                    disabled={!!busy || resource.loading}
                    aria-label="Refresh project team"
                  >
                    <RefreshCw
                      size={16}
                      className={resource.loading ? "spin" : ""}
                    />
                  </button>
                </div>
                <div className="collab-access-line">
                  <span className="collab-role">
                    <ShieldCheck size={13} aria-hidden="true" /> Your access:{" "}
                    {ROLE_DETAILS[data.access.role].label}
                  </span>
                  <span>
                    {data.access.mode === "private"
                      ? "Project-specific access"
                      : "Existing workspace access"}
                  </span>
                </div>
                <p className="collab-disclosure">{data.disclosure}</p>
                {data.access.mode === "workspace" && (
                  <div className="collab-notice">
                    <strong>
                      This project currently inherits workspace access.
                    </strong>
                    <p>
                      The first membership change preserves the current
                      workspace members as explicit project grants. Future
                      workspace members will not inherit access; owners can then
                      remove individual grants.
                    </p>
                  </div>
                )}
                <section
                  className="collab-section"
                  aria-labelledby="project-team-members"
                >
                  <h3 id="project-team-members">
                    People with project access{" "}
                    <span>{data.members.length}</span>
                  </h3>
                  {data.members.length ? (
                    <ul className="collab-members">
                      {data.members.map((member) => (
                        <MemberRow
                          key={`${member.userId}-${member.role}`}
                          member={member}
                          currentUserId={session.user?.id}
                          lastOwner={ownerCount <= 1}
                          canManage={canManage}
                          busy={!!busy || resource.loading}
                          onRole={(nextRole) =>
                            void change("PATCH", member.userId, nextRole)
                          }
                          onRemove={() => void change("DELETE", member.userId)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="collab-muted">
                      No explicit grants are listed. Review the workspace-access
                      disclosure above.
                    </p>
                  )}
                </section>
                {data.access.canManageMembers ? (
                  <ProjectInvitations
                    projectId={projectId!}
                    session={session}
                    aclVersion={data.access.aclVersion}
                    onAccountSecurity={onAccountSecurity}
                    onTeamRefresh={() => {
                      void resource.reload();
                    }}
                  />
                ) : (
                  <p className="collab-notice">
                    Only project owners and organization administrators can
                    change access. Your current role is{" "}
                    {ROLE_DETAILS[data.access.role].label.toLowerCase()}.
                  </p>
                )}
                {data.organizationAdmins.length > 0 && (
                  <p className="collab-admin-disclosure">
                    <ShieldCheck size={14} aria-hidden="true" /> Organization
                    administrators retain oversight access:{" "}
                    {data.organizationAdmins
                      .map((admin) => admin.name)
                      .join(", ")}
                    .
                  </p>
                )}
                <div className="collab-role-guide">
                  {Object.entries(ROLE_DETAILS).map(([value, detail]) => (
                    <div key={value}>
                      <strong>{detail.label}</strong>
                      <p>{detail.description}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
