import type { Position } from "./index";

export type ProjectRole = "owner" | "editor" | "commenter" | "viewer";
export interface ProjectAccess {
  role: ProjectRole;
  mode: "private" | "workspace";
  reason: "project-member" | "organization-admin" | "legacy-workspace";
  aclVersion: number;
  canEdit: boolean;
  canComment: boolean;
  canManageMembers: boolean;
  canPublish: boolean;
}
export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  addedAt: string;
  addedBy: string;
}
export interface ProjectMembersResponse {
  access: ProjectAccess | null;
  accessRevoked?: true;
  members: ProjectMember[];
  organizationAdmins: { userId: string; name: string }[];
  disclosure: string;
}
export interface ProjectAccessResponse {
  projectId: string;
  organizationId: string;
  version: number;
  access: ProjectAccess;
}
export type ReviewTarget =
  | { kind: "project" }
  | { kind: "building"; id: string }
  | { kind: "metric"; id: string }
  | { kind: "location"; position: Position };
export interface ReviewReply {
  id: string;
  text: string;
  author: string;
  actorId: string;
  createdAt: string;
  scenarioRevision: number;
}
export interface ReviewComment {
  id: string;
  scenarioId: string;
  /** Null means an old comment was not bound to a verified revision. */
  scenarioRevision: number | null;
  target?: ReviewTarget;
  targetLabel: string;
  targetPosition?: Position;
  text: string;
  author: string;
  actorId: string;
  createdAt: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  threadVersion: number;
  replies: ReviewReply[];
  stale: boolean;
  currentRevision: number | null;
  canResolve: boolean;
}
export interface ReviewCommentsResponse {
  access: ProjectAccess;
  projectVersion: number;
  scenarioId: string;
  scenarioRevision: number;
  comments: ReviewComment[];
}
