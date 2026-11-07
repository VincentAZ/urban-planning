import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  materializeBuildings,
  buildingAnchor,
  pointInStudyArea,
  studyAreaAnchor,
  type Position,
  type Scenario,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import type {
  ProjectMembersResponse,
  ProjectRole,
  ReviewComment,
  ReviewTarget,
} from "../../../packages/core/src/collaboration.js";
import {
  addAudit,
  findProject,
  type Store,
  type DataState,
  type CommentRecord,
  type ProjectRecord,
  type authorize,
} from "./store.js";
import {
  projectAccess,
  findProjectHeader,
  type ProjectGrant,
} from "./project-access.js";
import {
  requestScope,
  type ProjectHeader,
  type StoreScope,
} from "./store-scope.js";
import { ApiError, notFound } from "./errors.js";

type Identity = ReturnType<typeof authorize>;
type ReviewProject = ProjectRecord | ProjectHeader;
type ScenarioHeader = Pick<Scenario, "id" | "name" | "revision">;
const roles = z.enum(["owner", "editor", "commenter", "viewer"]);
const expectedAclVersion = z.number().int().min(0);
const text = z.string().trim().min(1).max(10000);
const id = z.string().min(1).max(240);
const key = z.string().trim().min(8).max(160);
export const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("building"), id }).strict(),
  z.object({ kind: z.literal("metric"), id }).strict(),
  z
    .object({
      kind: z.literal("location"),
      position: z.tuple([
        z.number().finite().min(-180).max(180),
        z.number().finite().min(-90).max(90),
      ]),
    })
    .strict(),
]);
const revisionInput = {
  expectedRevision: z.number().int().min(0),
  expectedVersion: z.number().int().positive(),
};
function currentGrants(
  state: DataState,
  record: ReviewProject,
): ProjectGrant[] {
  return (
    record.acl?.members ??
    state.memberships
      .filter(
        (m) =>
          m.organizationId === record.organizationId &&
          m.scope !== "project-only",
      )
      .map((m) => ({
        userId: m.userId,
        role: m.role,
        addedAt: record.createdAt,
        addedBy: record.createdBy,
      }))
  );
}
export function membersResponse(
  state: DataState,
  record: ReviewProject,
  identity: Identity,
): ProjectMembersResponse {
  if (!projectAccess(record, identity.user.id, identity.membership))
    return {
      access: null,
      accessRevoked: true,
      members: [],
      organizationAdmins: [],
      disclosure:
        "Your access to this project was removed. Your other workspaces and projects are unchanged.",
    };
  return {
    access: projectAccess(record, identity.user.id, identity.membership)!,
    members: currentGrants(state, record).flatMap((grant) => {
      const user = state.users.find((u) => u.id === grant.userId);
      return user ? [{ ...grant, name: user.name, email: user.email }] : [];
    }),
    organizationAdmins: state.memberships
      .filter(
        (m) =>
          m.organizationId === record.organizationId &&
          m.role === "owner" &&
          m.scope !== "project-only",
      )
      .map((m) => ({
        userId: m.userId,
        name:
          state.users.find((u) => u.id === m.userId)?.name ??
          "Workspace administrator",
      })),
    disclosure: record.acl
      ? "This project is limited to its explicit members. Workspace owners retain administrative access. New email-based access requires verified invitation acceptance and creates no access to other projects."
      : "This older project still uses workspace access. The first membership change converts current workspace members into explicit project grants; no current member is silently removed. Workspace owners retain administrative access.",
  };
}
function requireAclVersion(record: ReviewProject, expected: number) {
  if ((record.acl?.version ?? 0) !== expected)
    throw new ApiError(
      409,
      "PROJECT_ACCESS_CONFLICT",
      "Project sharing changed. Refresh the member list before editing it.",
      { aclVersion: record.acl?.version ?? 0 },
    );
}
export function materializeAcl(state: DataState, record: ReviewProject) {
  if (!record.acl)
    record.acl = { version: 0, members: currentGrants(state, record) };
  return record.acl;
}
function ensureOwner(members: ProjectGrant[]) {
  if (!members.some((member) => member.role === "owner"))
    throw new ApiError(
      409,
      "LAST_PROJECT_OWNER",
      "A project must retain at least one explicit owner. Add or promote another owner first.",
    );
}
function pruneProjectOnlyMembership(
  state: DataState,
  organizationId: string,
  userId: string,
) {
  if (
    !state.memberships.some(
      (m) =>
        m.organizationId === organizationId &&
        m.userId === userId &&
        m.scope === "project-only",
    )
  )
    return;
  if (
    state.projectHeaders.some(
      (p) =>
        p.organizationId === organizationId &&
        p.acl?.members.some((m) => m.userId === userId),
    )
  )
    return;
  state.memberships = state.memberships.filter(
    (m) =>
      !(
        m.organizationId === organizationId &&
        m.userId === userId &&
        m.scope === "project-only"
      ),
  );
  const fallback =
    state.memberships.find(
      (m) => m.userId === userId && m.scope !== "project-only",
    ) ?? state.memberships.find((m) => m.userId === userId);
  for (const session of state.sessions.filter(
    (s) => s.userId === userId && s.organizationId === organizationId,
  )) {
    if (fallback) session.organizationId = fallback.organizationId;
    else session.expiresAt = new Date().toISOString();
  }
}
function scenarioFor(record: ReviewProject, scenarioId: string) {
  const scenario = record.project.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw notFound();
  return scenario;
}
function assertSavedRevision(
  record: ReviewProject,
  scenario: ScenarioHeader,
  input: { expectedRevision: number; expectedVersion: number },
) {
  if (
    record.version !== input.expectedVersion ||
    scenario.revision !== input.expectedRevision
  )
    throw new ApiError(
      409,
      "REVIEW_REVISION_CONFLICT",
      "The saved project changed. Reopen the latest saved revision before posting this review.",
      { projectVersion: record.version, scenarioRevision: scenario.revision },
    );
}
function validateTarget(
  record: ReviewProject,
  scenario: ScenarioHeader,
  target: ReviewTarget,
): { targetLabel: string; targetPosition?: Position } {
  if (target.kind === "project")
    return { targetLabel: `General review · ${scenario.name}` };
  if (!("baseline" in record))
    throw new Error(
      "A geometric review target requires the captured project source scope.",
    );
  const fullScenario = record.project.scenarios.find(
    (value) => value.id === scenario.id,
  );
  if (!fullScenario) throw notFound();
  if (target.kind === "location") {
    if (!pointInStudyArea(target.position, record.baseline))
      throw new ApiError(
        422,
        "REVIEW_TARGET_OUTSIDE",
        "Choose a location inside the exact saved study area.",
      );
    return {
      targetLabel: `Location ${target.position[1].toFixed(5)}, ${target.position[0].toFixed(5)}`,
      targetPosition: target.position,
    };
  }
  if (target.kind === "building") {
    const building = materializeBuildings(record.baseline, fullScenario).find(
      (b) => b.id === target.id,
    );
    if (!building)
      throw new ApiError(
        422,
        "REVIEW_TARGET_MISSING",
        "This building is not present in the saved scenario. Save or reopen the scenario before commenting.",
      );
    return {
      targetLabel: building.name,
      targetPosition: buildingAnchor(building),
    };
  }
  const metric = calculateImpact(record.baseline, fullScenario).metrics.find(
    (m) => m.id === target.id,
  );
  if (!metric)
    throw new ApiError(
      422,
      "REVIEW_TARGET_MISSING",
      "This metric is not part of the saved scenario results.",
    );
  return { targetLabel: metric.label };
}
function presentComment(
  record: ReviewProject,
  comment: CommentRecord,
  identity: Identity,
): ReviewComment {
  const access = projectAccess(record, identity.user.id, identity.membership)!;
  const currentRevision =
    record.project.scenarios.find((s) => s.id === comment.scenarioId)
      ?.revision ?? null;
  const verified = comment.scenarioRevision !== undefined;
  const target = verified
    ? reviewTargetSchema.safeParse(comment.target ?? { kind: "project" })
    : null;
  return {
    id: comment.id,
    scenarioId: comment.scenarioId,
    scenarioRevision: comment.scenarioRevision ?? null,
    ...(target?.success ? { target: target.data } : {}),
    targetLabel:
      comment.targetLabel ??
      "Legacy comment · original target and revision unverified",
    ...(verified && comment.targetPosition
      ? { targetPosition: comment.targetPosition }
      : {}),
    text: comment.text,
    author: comment.author,
    actorId: comment.actorId,
    createdAt: comment.createdAt,
    resolved: comment.resolved ?? false,
    ...(comment.resolvedAt ? { resolvedAt: comment.resolvedAt } : {}),
    ...(comment.resolvedBy ? { resolvedBy: comment.resolvedBy } : {}),
    threadVersion: comment.threadVersion ?? 1,
    replies: (comment.replies ?? []).map(
      ({ id, text, author, actorId, createdAt, scenarioRevision }) => ({
        id,
        text,
        author,
        actorId,
        createdAt,
        scenarioRevision,
      }),
    ),
    stale: !verified || currentRevision !== comment.scenarioRevision,
    currentRevision,
    canResolve:
      access.canComment &&
      (access.canEdit || comment.actorId === identity.user.id),
  };
}

function geometricTarget(request: FastifyRequest) {
  const kind = (request.body as { target?: { kind?: unknown } } | undefined)
    ?.target?.kind;
  return typeof kind === "string" && kind !== "project";
}
function projectScope(
  request: FastifyRequest,
  extra: StoreScope = {},
  full = false,
) {
  const where = [
    {
      id: (request.params as { id: string }).id,
      organizationId: { auth: "organizationId" as const },
    },
  ];
  return requestScope(request, {
    ...(full ? { projects: { where } } : { projectHeaders: { where } }),
    ...extra,
  });
}
function rosterScope(request: FastifyRequest, write = false, prune = false) {
  const { id, userId } = request.params as { id: string; userId?: string };
  const organizationId = { auth: "organizationId" as const };
  const rawEmail = (request.body as { email?: unknown } | undefined)?.email;
  return requestScope(request, {
    projectId: id,
    ...(typeof rawEmail === "string"
      ? { memberLookupEmail: rawEmail.trim().toLowerCase() }
      : {}),
    projectHeaders: {
      where: [prune ? { organizationId } : { id, organizationId }],
    },
    memberships: {
      where: [{ organizationId }, ...(prune && userId ? [{ userId }] : [])],
    },
    users: {
      where: [
        { id: { from: "memberships", field: "userId" } },
        { id: { from: "projectHeaders", field: "grantUserIds" } },
        ...(typeof rawEmail === "string"
          ? [{ email: rawEmail.trim().toLowerCase() }]
          : []),
      ],
    },
    ...(prune && userId
      ? { sessions: { where: [{ userId, organizationId }] } }
      : {}),
    ...(write ? { audit: { append: true as const } } : {}),
  });
}
function commentsScope(
  request: FastifyRequest,
  write = false,
  exactThread = false,
  full = false,
) {
  const { id, commentId } = request.params as {
    id: string;
    commentId?: string;
  };
  return projectScope(
    request,
    {
      comments: {
        where: [
          {
            projectId: id,
            organizationId: { auth: "organizationId" },
            ...(exactThread && commentId ? { id: commentId } : {}),
          },
        ],
      },
      ...(write ? { audit: { append: true } } : {}),
    },
    full,
  );
}

export function registerProjectCollaboration(
  app: FastifyInstance,
  options: {
    store: Store;
    auth: (state: DataState, request: FastifyRequest) => Identity;
  },
) {
  const { store, auth } = options;
  const project = (
    state: DataState,
    request: FastifyRequest,
    allowed?: ProjectRole[],
    full = false,
  ) => {
    const identity = auth(state, request);
    const record = (full ? findProject : findProjectHeader)(
      state,
      identity.organization.id,
      (request.params as { id: string }).id,
      identity.user.id,
      allowed,
    );
    return { identity, record };
  };
  app.get("/api/v1/projects/:id/access", async (request) =>
    store.read((state) => {
      const { identity, record } = project(state, request);
      return {
        projectId: record.project.id,
        organizationId: record.organizationId,
        version: record.version,
        access: projectAccess(record, identity.user.id, identity.membership)!,
      };
    }, projectScope(request)),
  );
  app.get("/api/v1/projects/:id/members", async (request) =>
    store.read((state) => {
      const { identity, record } = project(state, request);
      return membersResponse(state, record, identity);
    }, rosterScope(request)),
  );
  app.post("/api/v1/projects/:id/members", async (request) =>
    store.transaction(
      (state) => {
        const { identity, record } = project(state, request, ["owner"]);
        const input = z
          .object({
            email: z.email().trim().toLowerCase(),
            role: roles,
            expectedAclVersion,
          })
          .strict()
          .parse(request.body);
        requireAclVersion(record, input.expectedAclVersion);
        const user = state.users.find((u) => u.email === input.email);
        if (!user)
          throw new ApiError(
            409,
            "INVITATION_REQUIRED",
            "New project access requires a verified recipient to accept an invitation.",
          );
        const acl = materializeAcl(state, record);
        const existing = acl.members.find((m) => m.userId === user.id);
        if (!existing)
          throw new ApiError(
            409,
            "INVITATION_REQUIRED",
            "New project access requires a verified recipient to accept an invitation.",
          );
        const before = existing?.role ?? null;
        if (existing) existing.role = input.role;
        else
          acl.members.push({
            userId: user.id,
            role: input.role,
            addedAt: new Date().toISOString(),
            addedBy: identity.user.id,
          });
        ensureOwner(acl.members);
        if (
          !state.memberships.some(
            (m) =>
              m.userId === user.id &&
              m.organizationId === record.organizationId,
          )
        )
          state.memberships.push({
            userId: user.id,
            organizationId: record.organizationId,
            role: "viewer",
            scope: "project-only",
          });
        acl.version++;
        addAudit(state, {
          organizationId: record.organizationId,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "project.member.updated",
          details: {
            userId: user.id,
            before,
            after: input.role,
            aclVersion: acl.version,
          },
        });
        return membersResponse(state, record, identity);
      },
      rosterScope(request, true),
    ),
  );
  app.patch("/api/v1/projects/:id/members/:userId", async (request) =>
    store.transaction(
      (state) => {
        const { identity, record } = project(state, request, ["owner"]);
        const input = z
          .object({ role: roles, expectedAclVersion })
          .strict()
          .parse(request.body);
        requireAclVersion(record, input.expectedAclVersion);
        const acl = materializeAcl(state, record);
        const member = acl.members.find(
          (m) => m.userId === (request.params as { userId: string }).userId,
        );
        if (!member) throw notFound();
        const before = member.role;
        member.role = input.role;
        ensureOwner(acl.members);
        acl.version++;
        addAudit(state, {
          organizationId: record.organizationId,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "project.member.updated",
          details: {
            userId: member.userId,
            before,
            after: member.role,
            aclVersion: acl.version,
          },
        });
        return membersResponse(state, record, identity);
      },
      rosterScope(request, true),
    ),
  );
  app.delete("/api/v1/projects/:id/members/:userId", async (request) =>
    store.transaction(
      (state) => {
        const { identity, record } = project(state, request, ["owner"]);
        const input = z
          .object({ expectedAclVersion })
          .strict()
          .parse(request.body);
        requireAclVersion(record, input.expectedAclVersion);
        const userId = (request.params as { userId: string }).userId;
        const acl = materializeAcl(state, record);
        const member = acl.members.find((m) => m.userId === userId);
        if (!member) throw notFound();
        acl.members = acl.members.filter((m) => m.userId !== userId);
        ensureOwner(acl.members);
        acl.version++;
        if (!store.managesMembershipPruning)
          pruneProjectOnlyMembership(state, record.organizationId, userId);
        addAudit(state, {
          organizationId: record.organizationId,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "project.member.removed",
          details: { userId, before: member.role, aclVersion: acl.version },
        });
        // An owner may remove their own explicit grant. Return the final roster; subsequent reads reauthorize.
        return membersResponse(state, record, identity);
      },
      rosterScope(request, true, !store.managesMembershipPruning),
    ),
  );
  app.get("/api/v1/projects/:id/comments", async (request) =>
    store.read((state) => {
      const { identity, record } = project(state, request);
      const query = z
        .object({ scenarioId: id.optional() })
        .parse(request.query);
      const scenario = scenarioFor(
        record,
        query.scenarioId ?? record.project.activeScenarioId,
      );
      return {
        access: projectAccess(record, identity.user.id, identity.membership)!,
        projectVersion: record.version,
        scenarioId: scenario.id,
        scenarioRevision: scenario.revision,
        comments: state.comments
          .filter(
            (c) =>
              c.projectId === record.project.id &&
              c.organizationId === record.organizationId &&
              c.scenarioId === scenario.id,
          )
          .map((c) => presentComment(record, c, identity)),
      };
    }, commentsScope(request)),
  );
  app.post("/api/v1/projects/:id/comments", async (request, reply) => {
    const result = await store.transaction(
      (state) => {
        const { identity, record } = project(
          state,
          request,
          ["owner", "editor", "commenter"],
          geometricTarget(request),
        );
        const input = z
          .object({
            scenarioId: id,
            text,
            target: reviewTargetSchema.default({ kind: "project" }),
            ...revisionInput,
            idempotencyKey: key,
          })
          .strict()
          .parse(request.body);
        const existing = state.comments.find(
          (c) =>
            c.projectId === record.project.id &&
            c.actorId === identity.user.id &&
            c.idempotencyKey === input.idempotencyKey,
        );
        if (existing) {
          if (
            existing.text !== input.text ||
            existing.scenarioId !== input.scenarioId ||
            existing.scenarioRevision !== input.expectedRevision ||
            existing.projectVersion !== input.expectedVersion ||
            JSON.stringify(existing.target) !== JSON.stringify(input.target)
          )
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This comment key was already used for different content.",
            );
          return {
            comment: presentComment(record, existing, identity),
            projectVersion: record.version,
            access: projectAccess(
              record,
              identity.user.id,
              identity.membership,
            )!,
          };
        }
        const scenario = scenarioFor(record, input.scenarioId);
        assertSavedRevision(record, scenario, input);
        const target = validateTarget(record, scenario, input.target);
        const comment: CommentRecord = {
          id: randomUUID(),
          projectId: record.project.id,
          organizationId: record.organizationId,
          actorId: identity.user.id,
          author: identity.user.name,
          text: input.text,
          scenarioId: scenario.id,
          scenarioRevision: scenario.revision,
          projectVersion: record.version,
          target: input.target,
          ...target,
          createdAt: new Date().toISOString(),
          resolved: false,
          threadVersion: 1,
          replies: [],
          idempotencyKey: input.idempotencyKey,
        };
        state.comments.push(comment);
        addAudit(state, {
          organizationId: record.organizationId,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "comment.created",
          details: {
            commentId: comment.id,
            scenarioId: scenario.id,
            scenarioRevision: scenario.revision,
            projectVersion: record.version,
            target: input.target,
          },
        });
        return {
          comment: presentComment(record, comment, identity),
          projectVersion: record.version,
          access: projectAccess(record, identity.user.id, identity.membership)!,
        };
      },
      commentsScope(request, true, false, geometricTarget(request)),
    );
    return reply.code(201).send(result);
  });
  app.post(
    "/api/v1/projects/:id/comments/:commentId/replies",
    async (request, reply) => {
      const result = await store.transaction(
        (state) => {
          const { identity, record } = project(state, request, [
            "owner",
            "editor",
            "commenter",
          ]);
          const input = z
            .object({ text, ...revisionInput, idempotencyKey: key })
            .strict()
            .parse(request.body);
          const comment = state.comments.find(
            (c) =>
              c.id === (request.params as { commentId: string }).commentId &&
              c.projectId === record.project.id &&
              c.organizationId === record.organizationId,
          );
          if (!comment) throw notFound();
          const previous = state.comments
            .filter((c) => c.projectId === record.project.id)
            .flatMap((c) =>
              (c.replies ?? []).map((r) => ({ commentId: c.id, reply: r })),
            )
            .find(
              (r) =>
                r.reply.actorId === identity.user.id &&
                r.reply.idempotencyKey === input.idempotencyKey,
            );
          if (previous) {
            if (
              previous.commentId !== comment.id ||
              previous.reply.text !== input.text ||
              previous.reply.scenarioRevision !== input.expectedRevision ||
              previous.reply.projectVersion !== input.expectedVersion
            )
              throw new ApiError(
                409,
                "IDEMPOTENCY_CONFLICT",
                "This reply key was already used for different content.",
              );
            return {
              comment: presentComment(record, comment, identity),
              projectVersion: record.version,
              access: projectAccess(
                record,
                identity.user.id,
                identity.membership,
              )!,
            };
          }
          const scenario = scenarioFor(record, comment.scenarioId);
          assertSavedRevision(record, scenario, input);
          if (comment.resolved)
            throw new ApiError(
              409,
              "THREAD_RESOLVED",
              "Reopen the thread before adding another reply.",
            );
          const entry = {
            id: randomUUID(),
            text: input.text,
            author: identity.user.name,
            actorId: identity.user.id,
            createdAt: new Date().toISOString(),
            scenarioRevision: scenario.revision,
            projectVersion: record.version,
            idempotencyKey: input.idempotencyKey,
          };
          (comment.replies ??= []).push(entry);
          comment.threadVersion = (comment.threadVersion ?? 1) + 1;
          addAudit(state, {
            organizationId: record.organizationId,
            projectId: record.project.id,
            actorId: identity.user.id,
            action: "comment.replied",
            details: {
              commentId: comment.id,
              replyId: entry.id,
              scenarioRevision: scenario.revision,
              threadVersion: comment.threadVersion,
            },
          });
          return {
            comment: presentComment(record, comment, identity),
            projectVersion: record.version,
            access: projectAccess(
              record,
              identity.user.id,
              identity.membership,
            )!,
          };
        },
        commentsScope(request, true),
      );
      return reply.code(201).send(result);
    },
  );
  app.patch("/api/v1/projects/:id/comments/:commentId", async (request) =>
    store.transaction(
      (state) => {
        const { identity, record } = project(state, request, [
          "owner",
          "editor",
          "commenter",
        ]);
        const input = z
          .object({
            resolved: z.boolean(),
            expectedThreadVersion: z.number().int().positive(),
          })
          .strict()
          .parse(request.body);
        const comment = state.comments.find(
          (c) =>
            c.id === (request.params as { commentId: string }).commentId &&
            c.projectId === record.project.id &&
            c.organizationId === record.organizationId,
        );
        if (!comment) throw notFound();
        if (!presentComment(record, comment, identity).canResolve)
          throw new ApiError(
            403,
            "THREAD_AUTHOR_REQUIRED",
            "Only this thread’s author or a project editor/owner may resolve it.",
          );
        if ((comment.threadVersion ?? 1) !== input.expectedThreadVersion)
          throw new ApiError(
            409,
            "THREAD_VERSION_CONFLICT",
            "The thread changed. Refresh it before changing its resolution.",
          );
        comment.resolved = input.resolved;
        comment.threadVersion = (comment.threadVersion ?? 1) + 1;
        if (input.resolved) {
          comment.resolvedAt = new Date().toISOString();
          comment.resolvedBy = identity.user.id;
        } else {
          delete comment.resolvedAt;
          delete comment.resolvedBy;
        }
        addAudit(state, {
          organizationId: record.organizationId,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: input.resolved ? "comment.resolved" : "comment.reopened",
          details: {
            commentId: comment.id,
            threadVersion: comment.threadVersion,
            scenarioRevision: comment.scenarioRevision ?? null,
          },
        });
        return {
          comment: presentComment(record, comment, identity),
          projectVersion: record.version,
          access: projectAccess(record, identity.user.id, identity.membership)!,
        };
      },
      commentsScope(request, true, true),
    ),
  );
}
