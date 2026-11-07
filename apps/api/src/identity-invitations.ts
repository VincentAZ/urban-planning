import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { canonicalJSON, type ProjectRole } from "@urban/core";
import { ApiError } from "./errors.js";
import type { DataState } from "./store.js";
import { findProjectHeader, projectAccess } from "./project-access.js";
import { materializeAcl } from "./project-collaboration.js";
import { requestScope, type StoreScope } from "./store-scope.js";
import { safeEqual, tokenHash } from "./security.js";
import {
  identityLink,
  identityToken,
  mailAdmissionScope,
  queueIdentityMail,
  recordIdentityAudit,
  requireDelivery,
  requireVerified,
  type IdentityContext,
} from "./identity-service.js";
import type {
  IdentityInvitationRecord,
  IdentityInvitationView,
} from "./identity-types.js";

type Target = { scope: "project"; projectId: string } | { scope: "workspace" };
const unavailable = (): never => {
  throw new ApiError(
    404,
    "INVITATION_UNAVAILABLE",
    "This invitation is unavailable for the current account. It may have expired or been revoked.",
  );
};
const conflict = (): never => {
  throw new ApiError(
    409,
    "INVITATION_CONFLICT",
    "This invitation changed. Refresh its status before continuing.",
  );
};
function view(record: IdentityInvitationRecord): IdentityInvitationView {
  const {
    tokenHash: _token,
    submissionHash: _hash,
    idempotencyKey: _key,
    acceptedBy: _accepted,
    revokedBy: _revoked,
    ...rest
  } = record;
  return {
    ...rest,
    status:
      rest.status === "pending" && Date.parse(rest.expiresAt) <= Date.now()
        ? "expired"
        : rest.status,
  };
}
function sameTarget(
  record: IdentityInvitationRecord,
  target: Target,
  organizationId: string,
) {
  return (
    record.organizationId === organizationId &&
    record.scope === target.scope &&
    record.projectId ===
      (target.scope === "project" ? target.projectId : undefined)
  );
}
export class IdentityInvitations {
  constructor(readonly context: IdentityContext) {}
  private owner(state: DataState, request: FastifyRequest, target: Target) {
    const identity = this.context.auth(
      state,
      request,
      target.scope === "workspace" ? ["owner"] : undefined,
    );
    const project =
      target.scope === "project"
        ? findProjectHeader(
            state,
            identity.organization.id,
            target.projectId,
            identity.user.id,
            ["owner"],
          )
        : undefined;
    return { identity, project };
  }
  private scope(
    request: FastifyRequest,
    target: Target,
    write = false,
    manager?: { id: string; email: string },
  ): StoreScope {
    return requestScope(request, {
      ...(write ? mailAdmissionScope : {}),
      ...(manager
        ? {
            security: {
              mode: "auth" as const,
              purpose: "invitation-manage" as const,
              email: manager.email,
              userId: manager.id,
            },
          }
        : {}),
      ...(target.scope === "project"
        ? {
            projectId: target.projectId,
            projectHeaders: {
              where: [
                {
                  id: target.projectId,
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
          }
        : {}),
      identityInvitations: {
        where: [
          {
            organizationId: { auth: "organizationId" },
            ...(target.scope === "project"
              ? { projectId: target.projectId }
              : {}),
          },
        ],
      },
      memberships: { where: [{ organizationId: { auth: "organizationId" } }] },
    });
  }
  private response(state: DataState, request: FastifyRequest, target: Target) {
    const { identity, project } = this.owner(state, request, target);
    const records = state.identityInvitations.filter((r) =>
      sameTarget(r, target, identity.organization.id),
    );
    if (records.length > 1000)
      throw new ApiError(
        413,
        "IDENTITY_INVITATION_LIMIT",
        "This invitation history exceeds the current roster limit. No records were omitted.",
      );
    return {
      invitations: records.map(view),
      delivery: this.context.mail.capability(),
      ...(project ? { aclVersion: project.acl?.version ?? 0 } : {}),
    };
  }
  async list(request: FastifyRequest, target: Target) {
    return this.context.store.read(
      (state) => this.response(state, request, target),
      this.scope(request, target),
    );
  }
  private async invitationMail(
    record: IdentityInvitationRecord,
    token: string,
    inviter: string,
  ) {
    return this.context.mail.prepare({
      id: randomUUID(),
      kind: "invitation",
      to: record.email,
      organizationId: record.organizationId,
      invitationId: record.id,
      invitationVersion: record.version,
      subject: "An Urban Planning collaboration invitation",
      text: `${inviter} invited you to collaborate with the ${record.role} role. Sign in to the invited email account, verify it, and explicitly accept to receive access.\n\n${identityLink(this.context, "invitation", token)}\n\nNo access is granted until you accept.`,
      expiresAt: record.expiresAt,
    });
  }
  async create(
    request: FastifyRequest,
    target: Target,
    input: {
      email: string;
      role: ProjectRole;
      idempotencyKey: string;
      expectedAclVersion?: number;
    },
  ) {
    requireDelivery(this.context);
    if (target.scope === "workspace" && input.role === "owner")
      throw new ApiError(
        400,
        "OWNER_ROLE",
        "Workspace owner invitations are not supported.",
      );
    const submissionHash = tokenHash(
      canonicalJSON({
        target,
        email: input.email,
        role: input.role,
        expectedAclVersion: input.expectedAclVersion,
      }),
    );
    const before = await this.context.store.read(
      (state) => {
        const { identity, project } = this.owner(state, request, target);
        requireVerified(identity.user);
        const previous = state.identityInvitations.find(
          (r) =>
            sameTarget(r, target, identity.organization.id) &&
            r.createdBy === identity.user.id &&
            r.idempotencyKey === input.idempotencyKey,
        );
        if (previous && previous.submissionHash !== submissionHash)
          return conflict();
        if (
          !previous &&
          project &&
          (project.acl?.version ?? 0) !== input.expectedAclVersion
        )
          throw new ApiError(
            409,
            "PROJECT_ACCESS_CONFLICT",
            "Project sharing changed. Refresh before inviting someone.",
          );
        return { identity, previous };
      },
      this.scope(request, target),
    );
    if (before.previous) return this.list(request, target);
    const secret = identityToken(),
      at = new Date().toISOString();
    const record: IdentityInvitationRecord = {
      id: secret.id,
      organizationId: before.identity.organization.id,
      ...(target.scope === "project" ? { projectId: target.projectId } : {}),
      scope: target.scope,
      email: input.email,
      role: input.role,
      createdBy: before.identity.user.id,
      createdAt: at,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      version: 1,
      tokenHash: secret.tokenHash,
      idempotencyKey: input.idempotencyKey,
      submissionHash,
      status: "pending",
    };
    const mail = await this.invitationMail(
      record,
      secret.token,
      before.identity.user.name,
    );
    return this.context.store.transaction(
      (state) => {
        const { identity, project } = this.owner(state, request, target);
        requireVerified(identity.user);
        const previous = state.identityInvitations.find(
          (r) =>
            sameTarget(r, target, identity.organization.id) &&
            r.createdBy === identity.user.id &&
            r.idempotencyKey === input.idempotencyKey,
        );
        if (previous) {
          if (previous.submissionHash !== submissionHash) return conflict();
          return this.response(state, request, target);
        }
        if (
          identity.user.id !== record.createdBy ||
          identity.organization.id !== record.organizationId
        )
          return conflict();
        if (project && (project.acl?.version ?? 0) !== input.expectedAclVersion)
          throw new ApiError(
            409,
            "PROJECT_ACCESS_CONFLICT",
            "Project sharing changed. Refresh before inviting someone.",
          );
        const history = state.identityInvitations.filter((r) =>
          sameTarget(r, target, record.organizationId),
        );
        if (
          history.some(
            (r) => r.email === input.email && view(r).status === "pending",
          )
        )
          throw new ApiError(
            409,
            "INVITATION_PENDING",
            "A pending invitation already exists for this address. Resend or revoke it first.",
          );
        if (
          history.length >= 1000 ||
          history.filter((r) => view(r).status === "pending").length >= 100 ||
          history.filter(
            (r) =>
              r.createdBy === identity.user.id &&
              Date.parse(r.createdAt) > Date.now() - 86400000,
          ).length >= 20
        )
          throw new ApiError(
            429,
            "IDENTITY_INVITATION_LIMIT",
            "The invitation limit has been reached. Try again later.",
          );
        state.identityInvitations.push(record);
        queueIdentityMail(this.context, state, mail);
        recordIdentityAudit(
          state,
          identity.user.id,
          "identity.invitation.created",
          { invitationId: record.id, role: record.role },
          record.organizationId,
          record.projectId,
        );
        return this.response(state, request, target);
      },
      this.scope(request, target, true, before.identity.user),
    );
  }
  async update(
    request: FastifyRequest,
    target: Target,
    id: string,
    expectedVersion: number,
    action: "resend" | "revoke",
  ) {
    if (action === "resend") requireDelivery(this.context);
    const before = await this.context.store.read(
      (state) => {
        const { identity } = this.owner(state, request, target);
        requireVerified(identity.user);
        const record = state.identityInvitations.find(
          (r) => r.id === id && sameTarget(r, target, identity.organization.id),
        );
        if (!record) return unavailable();
        if (record.version !== expectedVersion || record.status !== "pending")
          return conflict();
        return { identity, record };
      },
      this.scope(request, target),
    );
    const secret = `${id}.${identityToken().token.split(".")[1]}`;
    const next = {
      ...before.record,
      version: before.record.version + 1,
      tokenHash: tokenHash(secret),
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    const mail =
      action === "resend"
        ? await this.invitationMail(next, secret, before.identity.user.name)
        : undefined;
    return this.context.store.transaction(
      (state) => {
        const { identity } = this.owner(state, request, target);
        requireVerified(identity.user);
        const record = state.identityInvitations.find(
          (r) => r.id === id && sameTarget(r, target, identity.organization.id),
        );
        if (!record) return unavailable();
        if (record.version !== expectedVersion || record.status !== "pending")
          return conflict();
        if (action === "resend") {
          if (
            state.identityOutboxHeaders.some(
              (m) =>
                m.invitationId === id &&
                Date.parse(m.createdAt) > Date.now() - 60000,
            )
          )
            throw new ApiError(
              429,
              "IDENTITY_RESEND_LIMIT",
              "Wait a minute before resending this invitation.",
            );
          Object.assign(record, next);
          queueIdentityMail(this.context, state, mail!);
        } else {
          record.status = "revoked";
          record.version++;
          record.revokedAt = new Date().toISOString();
          record.revokedBy = identity.user.id;
        }
        recordIdentityAudit(
          state,
          identity.user.id,
          `identity.invitation.${action === "resend" ? "resent" : "revoked"}`,
          { invitationId: id },
          record.organizationId,
          record.projectId,
        );
        return this.response(state, request, target);
      },
      this.scope(request, target, true, before.identity.user),
    );
  }
  private async recipient(request: FastifyRequest, token: string) {
    const id = token.split(".")[0],
      hash = tokenHash(token);
    return this.context.store.read(
      (state) => {
        const { user } = this.context.auth(state, request);
        requireVerified(user);
        const record = state.identityInvitations.find((r) => r.id === id);
        if (
          !record ||
          record.email !== user.email ||
          !safeEqual(record.tokenHash, hash) ||
          record.status === "revoked" ||
          (record.status === "pending" &&
            Date.parse(record.expiresAt) <= Date.now())
        )
          return unavailable();
        return { user, record, hash };
      },
      requestScope(request, { identityInvitations: { where: [{ id }] } }),
    );
  }
  private recipientScope(
    request: FastifyRequest,
    before: Awaited<ReturnType<IdentityInvitations["recipient"]>>,
    write: boolean,
  ): StoreScope {
    const { record, user, hash } = before;
    return requestScope(request, {
      security: {
        mode: "auth",
        purpose: "invitation-accept",
        email: user.email,
        userId: user.id,
        invitationId: record.id,
        invitationVersion: record.version,
        tokenHash: hash,
      },
      projectId: record.projectId,
      identityInvitations: { where: [{ id: record.id }] },
      organizations: { where: [{ id: record.organizationId }] },
      memberships: { where: [{ organizationId: record.organizationId }] },
      users: { where: [{ id: record.createdBy }] },
      ...(record.projectId
        ? {
            projectHeaders: {
              where: [
                { id: record.projectId, organizationId: record.organizationId },
              ],
            },
          }
        : {}),
      ...(write ? { audit: { append: true } } : {}),
    });
  }
  private checkRecipient(
    state: DataState,
    request: FastifyRequest,
    before: Awaited<ReturnType<IdentityInvitations["recipient"]>>,
  ) {
    const { user } = this.context.auth(state, request);
    requireVerified(user);
    const record = state.identityInvitations.find(
      (r) => r.id === before.record.id,
    );
    if (
      !record ||
      record.email !== user.email ||
      !safeEqual(record.tokenHash, before.hash) ||
      record.status === "revoked" ||
      (record.status === "pending" &&
        Date.parse(record.expiresAt) <= Date.now())
    )
      return unavailable();
    const organization = state.organizations.find(
        (o) => o.id === record.organizationId,
      ),
      creator = state.users.find((u) => u.id === record.createdBy),
      membership = state.memberships.find(
        (m) =>
          m.userId === record.createdBy &&
          m.organizationId === record.organizationId,
      ),
      project = record.projectId
        ? state.projectHeaders.find(
            (p) =>
              p.project.id === record.projectId &&
              p.organizationId === record.organizationId,
          )
        : undefined;
    if (
      !organization ||
      !creator?.emailVerifiedAt ||
      !membership ||
      (record.scope === "project"
        ? !project ||
          projectAccess(project, creator.id, membership)?.canManageMembers !==
            true
        : membership.scope === "project-only" || membership.role !== "owner")
    )
      return unavailable();
    return { user, record, organization, project };
  }
  async preview(request: FastifyRequest, token: string) {
    const before = await this.recipient(request, token);
    return this.context.store.read(
      (state) => {
        const { record, organization, project } = this.checkRecipient(
          state,
          request,
          before,
        );
        return {
          invitation: view(record),
          organization: { id: organization.id, name: organization.name },
          ...(project
            ? {
                project: { id: project.project.id, name: project.project.name },
                aclVersion: project.acl?.version ?? 0,
              }
            : {}),
        };
      },
      this.recipientScope(request, before, false),
    );
  }
  async accept(
    request: FastifyRequest,
    input: {
      token: string;
      expectedVersion: number;
      expectedAclVersion?: number;
    },
  ) {
    const before = await this.recipient(request, input.token);
    return this.context.store.transaction(
      (state) => {
        const { user, record, project } = this.checkRecipient(
          state,
          request,
          before,
        );
        const member = state.memberships.find(
          (m) =>
            m.userId === user.id && m.organizationId === record.organizationId,
        );
        if (record.status === "accepted") {
          if (
            record.acceptedBy !== user.id ||
            !member ||
            (project && !projectAccess(project, user.id, member))
          )
            return unavailable();
          return {
            accepted: true as const,
            organizationId: record.organizationId,
            ...(project
              ? {
                  projectId: project.project.id,
                  aclVersion: project.acl?.version ?? 0,
                }
              : {}),
            role: record.role,
            alreadyAccepted: true,
          };
        }
        if (record.version !== input.expectedVersion) return conflict();
        if (project && (project.acl?.version ?? 0) !== input.expectedAclVersion)
          throw new ApiError(
            409,
            "PROJECT_ACCESS_CONFLICT",
            "Project sharing changed. Review the invitation again before accepting.",
          );
        const at = new Date().toISOString();
        if (project) {
          const acl = materializeAcl(state, project);
          if (acl.members.some((m) => m.userId === user.id))
            throw new ApiError(
              409,
              "INVITATION_ALREADY_MEMBER",
              "You already have access. An owner can change your existing role in the member list.",
            );
          acl.members.push({
            userId: user.id,
            role: record.role,
            addedAt: at,
            addedBy: record.createdBy,
          });
          acl.version++;
          if (!member)
            state.memberships.push({
              userId: user.id,
              organizationId: record.organizationId,
              role: "viewer",
              scope: "project-only",
            });
        } else {
          if (member && member.scope !== "project-only")
            throw new ApiError(
              409,
              "INVITATION_ALREADY_MEMBER",
              "You are already a workspace member. An owner can change your existing role.",
            );
          if (record.role === "owner") return unavailable();
          if (member) {
            member.role = record.role;
            member.scope = "workspace";
          } else
            state.memberships.push({
              userId: user.id,
              organizationId: record.organizationId,
              role: record.role,
            });
        }
        record.status = "accepted";
        record.version++;
        record.acceptedBy = user.id;
        record.acceptedAt = at;
        recordIdentityAudit(
          state,
          user.id,
          "identity.invitation.accepted",
          { invitationId: record.id, role: record.role },
          record.organizationId,
          record.projectId,
        );
        return {
          accepted: true as const,
          organizationId: record.organizationId,
          ...(project
            ? {
                projectId: project.project.id,
                aclVersion: project.acl!.version,
              }
            : {}),
          role: record.role,
          alreadyAccepted: false,
        };
      },
      this.recipientScope(request, before, true),
    );
  }
}
