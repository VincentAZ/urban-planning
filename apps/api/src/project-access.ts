import type {
  ProjectAccess,
  ProjectRole,
} from "../../../packages/core/src/collaboration.js";
import type {
  DataState,
  MembershipRecord,
  ProjectRecord,
  Role,
} from "./store.js";
import { ApiError, notFound } from "./errors.js";

export interface ProjectGrant {
  userId: string;
  role: ProjectRole;
  addedAt: string;
  addedBy: string;
}
export interface ProjectAcl {
  version: number;
  members: ProjectGrant[];
}
export function initialProjectAcl(userId: string, at: string): ProjectAcl {
  return {
    version: 1,
    members: [{ userId, role: "owner", addedAt: at, addedBy: userId }],
  };
}
/** Project access never follows the role of a project-only workspace membership. */
export function projectAccess(
  record: Pick<ProjectRecord, "organizationId" | "acl">,
  userId: string,
  membership: MembershipRecord,
): ProjectAccess | null {
  if (
    membership.userId !== userId ||
    membership.organizationId !== record.organizationId
  )
    return null;
  let role: ProjectRole | undefined;
  let reason: ProjectAccess["reason"];
  if (membership.scope !== "project-only" && membership.role === "owner") {
    role = "owner";
    reason = "organization-admin";
  } else if (record.acl) {
    role = record.acl.members.find((member) => member.userId === userId)?.role;
    reason = "project-member";
  } else if (membership.scope !== "project-only") {
    role = membership.role;
    reason = "legacy-workspace";
  } else return null;
  if (!role) return null;
  return {
    role,
    mode: record.acl ? "private" : "workspace",
    reason,
    aclVersion: record.acl?.version ?? 0,
    canEdit: role === "owner" || role === "editor",
    canComment: role !== "viewer",
    canManageMembers: role === "owner",
    canPublish: role === "owner",
  };
}

/** Identical authorization semantics to findProject, without loading geographic or scenario payloads. */
export function findProjectHeader(
  state: DataState,
  organizationId: string,
  projectId: string,
  userId: string,
  roles?: Role[],
) {
  const record = state.projectHeaders.find(
    (p) => p.project.id === projectId && p.organizationId === organizationId,
  );
  const membership = state.memberships.find(
    (m) => m.organizationId === organizationId && m.userId === userId,
  );
  const access =
    record && membership ? projectAccess(record, userId, membership) : null;
  if (!record || !access) throw notFound();
  if (roles && !roles.includes(access.role))
    throw new ApiError(
      403,
      "PROJECT_ROLE_REQUIRED",
      "Your role on this project does not permit this action.",
    );
  return record;
}
