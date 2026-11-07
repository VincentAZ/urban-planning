import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fiscalProfileSchema,
  fiscalProfileHash,
  fiscalContentHash,
  fiscalProjectIssues,
  baselineIdentity,
} from "@urban/core";
import { projectSchema } from "./validation.js";
import { createFiscalStudy } from "@urban/models";
import type { Store, DataState, authorize, ProjectRecord } from "./store.js";
import { addAudit, findProject } from "./store.js";
import { initialProjectAcl, projectAccess } from "./project-access.js";
import { requestScope } from "./store-scope.js";
import { ApiError } from "./errors.js";
import {
  appendFiscalProfile,
  fiscalLibraryPage,
  fiscalProfileSubmissionSchema,
  fiscalProfileView,
  requireFiscalWorkspace,
} from "./fiscal-library.js";
import {
  assertFiscalPrivateUse,
  stampFiscalDeclarations,
} from "./fiscal-rights.js";
import { validateFloodProject } from "./flood-validation.js";
import {
  projectTrafficReferences,
  validateTrafficReferences,
} from "./traffic/references.js";
import {
  projectWorkforceReferences,
  validateWorkforceReferences,
} from "./workforce-validation.js";
import {
  projectAccessibilityReferences,
  validateAccessibilityReferences,
} from "./accessibility-validation.js";

export const fiscalStudySubmissionSchema = z
  .object({
    scenarioId: z.string().min(1).max(240),
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(240),
    profile: fiscalProfileSchema.optional(),
    libraryVersionId: z.string().uuid().optional(),
    applicabilityNotes: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(8).max(160),
  })
  .strict()
  .refine(
    (i) => Boolean(i.profile) !== Boolean(i.libraryVersionId),
    "Choose one exact profile snapshot or library version.",
  );
export function registerFiscalRoutes(
  app: FastifyInstance,
  {
    store,
    auth,
  }: {
    store: Store;
    auth: (s: DataState, r: FastifyRequest) => ReturnType<typeof authorize>;
  },
) {
  const base = "/api/v1/fiscal-profiles";
  const params = (r: FastifyRequest) =>
    r.params as { profileId: string; versionId: string; projectId: string };
  const libraryScope = (r: FastifyRequest) =>
    requestScope(r, {
      fiscalProfileHeaders: {
        where: [{ organizationId: { auth: "organizationId" } }],
      },
    });
  app.get(base, async (r) =>
    store.read((s) => {
      const i = auth(s, r);
      requireFiscalWorkspace(i);
      return fiscalLibraryPage(
        s.fiscalProfileHeaders,
        i.organization.id,
        r.query,
      );
    }, libraryScope(r)),
  );
  app.get(`${base}/:profileId/versions`, async (r) =>
    store.read((s) => {
      const i = auth(s, r);
      requireFiscalWorkspace(i);
      const rows = s.fiscalProfileHeaders.filter(
        (p) =>
          p.organizationId === i.organization.id &&
          p.profileId === params(r).profileId,
      );
      if (!rows.length)
        throw new ApiError(
          404,
          "NOT_FOUND",
          "Fiscal profile family not found.",
        );
      return fiscalLibraryPage(
        rows,
        i.organization.id,
        r.query,
        params(r).profileId,
      );
    }, libraryScope(r)),
  );
  app.get(`${base}/:profileId/versions/:versionId`, async (r) =>
    store.read(
      (s) => {
        const i = auth(s, r);
        requireFiscalWorkspace(i);
        const row = s.fiscalProfiles.find(
          (p) =>
            p.id === params(r).versionId &&
            p.profileId === params(r).profileId &&
            p.organizationId === i.organization.id,
        );
        if (!row)
          throw new ApiError(
            404,
            "NOT_FOUND",
            "Fiscal profile version not found.",
          );
        if (fiscalProfileHash(row.profile) !== row.profileHash)
          throw new ApiError(
            503,
            "FISCAL_PROFILE_INVALID",
            "The retained fiscal profile failed its integrity check.",
          );
        return { version: fiscalProfileView(row), profile: row.profile };
      },
      requestScope(r, {
        fiscalProfiles: {
          where: [
            {
              id: params(r).versionId,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    ),
  );
  app.post(base, { bodyLimit: 300 * 1024 }, async (r, reply) => {
    await store.read(
      (s) => requireFiscalWorkspace(auth(s, r), true),
      requestScope(r),
    );
    const input = fiscalProfileSubmissionSchema.parse(r.body);
    const row = await store.transaction(
      (s) => {
        const i = auth(s, r);
        const replay = s.fiscalProfileHeaders.some(
          (p) =>
            p.organizationId === i.organization.id &&
            p.userId === i.user.id &&
            p.idempotencyKey === input.idempotencyKey,
        );
        const saved = appendFiscalProfile(s, input, i);
        if (!replay)
          addAudit(s, {
            organizationId: i.organization.id,
            actorId: i.user.id,
            action: "fiscal.profile.saved",
            details: {
              profileId: saved.profileId,
              versionId: saved.id,
              profileHash: saved.profileHash,
              version: saved.version,
            },
          });
        return saved;
      },
      {
        ...libraryScope(r),
        fiscalProfiles: { append: true },
        audit: { append: true },
      },
    );
    const exact = await store.read(
      (s) => {
        const i = auth(s, r);
        requireFiscalWorkspace(i);
        const record = s.fiscalProfiles.find(
          (p) => p.id === row.id && p.organizationId === i.organization.id,
        );
        if (!record || fiscalProfileHash(record.profile) !== record.profileHash)
          throw new ApiError(
            503,
            "FISCAL_PROFILE_INVALID",
            "The retained profile failed its integrity check.",
          );
        return record;
      },
      requestScope(r, {
        fiscalProfiles: {
          where: [{ id: row.id, organizationId: { auth: "organizationId" } }],
        },
      }),
    );
    return reply
      .code(201)
      .send({ version: fiscalProfileView(exact), profile: exact.profile });
  });
  app.post(
    "/api/v1/projects/:projectId/fiscal-studies",
    { bodyLimit: 300 * 1024 },
    async (r, reply) => {
      await store.read(
        (s) => requireFiscalWorkspace(auth(s, r), true),
        requestScope(r),
      );
      const input = fiscalStudySubmissionSchema.parse(r.body),
        submissionHash = fiscalContentHash(input),
        sourceId = params(r).projectId;
      const selected = await store.read(
        (s) => {
          const i = auth(s, r);
          requireFiscalWorkspace(i, true);
          const source = findProject(
            s,
            i.organization.id,
            sourceId,
            i.user.id,
            ["owner", "editor"],
          );
          const replay = s.fiscalStudyCreations.find(
            (c) =>
              c.organizationId === i.organization.id &&
              c.userId === i.user.id &&
              c.idempotencyKey === input.idempotencyKey,
          );
          if (replay && replay.submissionHash !== submissionHash)
            throw new ApiError(
              409,
              "FISCAL_IDEMPOTENCY_CONFLICT",
              "The request key already belongs to a different fiscal study request.",
            );
          if (replay && replay.sourceProjectId !== sourceId)
            throw new ApiError(
              409,
              "FISCAL_IDEMPOTENCY_CONFLICT",
              "The request key already belongs to another source project.",
            );
          const libraryVersion = s.fiscalProfiles.find(
            (p) =>
              p.id === input.libraryVersionId &&
              p.organizationId === i.organization.id,
          );
          if (
            libraryVersion &&
            fiscalProfileHash(libraryVersion.profile) !==
              libraryVersion.profileHash
          )
            throw new ApiError(
              503,
              "FISCAL_PROFILE_INVALID",
              "The retained fiscal profile failed its integrity check.",
            );
          const profile = input.profile
            ? stampFiscalDeclarations(
                input.profile,
                i.user.id,
                new Date().toISOString(),
              )
            : libraryVersion?.profile;
          if (!profile)
            throw new ApiError(
              404,
              "NOT_FOUND",
              "Fiscal profile version not found.",
            );
          assertFiscalPrivateUse(profile);
          return {
            source,
            profile,
            replay,
            userId: i.user.id,
            organizationId: i.organization.id,
          };
        },
        requestScope(r, {
          projects: {
            where: [
              { id: sourceId, organizationId: { auth: "organizationId" } },
            ],
          },
          fiscalStudyCreations: {
            where: [
              {
                organizationId: { auth: "organizationId" },
                userId: { auth: "userId" },
              },
            ],
          },
          fiscalProfiles: input.libraryVersionId
            ? {
                where: [
                  {
                    id: input.libraryVersionId,
                    organizationId: { auth: "organizationId" },
                  },
                ],
              }
            : { append: true },
        }),
      );
      const response = (s: DataState, record: ProjectRecord) => {
        const i = auth(s, r);
        requireFiscalWorkspace(i, true);
        return {
          project: record.project,
          version: record.version,
          organizationId: record.organizationId,
          access: projectAccess(record, i.user.id, i.membership)!,
        };
      };
      const baseline = await baselineIdentity(selected.source.baseline);
      if (selected.replay) {
        const result = await store.read(
          (s) => {
            const i = auth(s, r);
            findProject(s, i.organization.id, sourceId, i.user.id, [
              "owner",
              "editor",
            ]);
            return response(
              s,
              findProject(
                s,
                i.organization.id,
                selected.replay!.projectId,
                i.user.id,
              ),
            );
          },
          requestScope(r, {
            projects: {
              where: [
                {
                  id: [sourceId, selected.replay.projectId],
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
          }),
        );
        return reply.code(201).send({ ...result, baselineIdentity: baseline });
      }
      const current = selected.source.project.scenarios.find(
        (s) => s.id === input.scenarioId,
      );
      if (
        selected.source.version !== input.expectedVersion ||
        !current ||
        current.revision !== input.expectedRevision
      )
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "The source study or selected alternative changed. Refresh before creating a fiscal study.",
        );
      const project = await createFiscalStudy({
        place: selected.source.baseline,
        project: selected.source.project,
        scenarioId: input.scenarioId,
        profile: selected.profile,
        review: {
          reviewedBy: selected.userId,
          reviewedAt: new Date().toISOString(),
          applicabilityNotes: input.applicabilityNotes,
        },
        name: input.name,
      });
      project.id = randomUUID();
      projectSchema.parse(project);
      const issues = fiscalProjectIssues(project, selected.source.baseline);
      if (issues.length)
        throw new ApiError(422, "FISCAL_STUDY_INVALID", issues.join(" "));
      validateTrafficReferences(
        projectTrafficReferences(project),
        project.id,
        [],
      );
      validateWorkforceReferences(
        projectWorkforceReferences(project),
        project.id,
        [],
      );
      validateAccessibilityReferences(
        projectAccessibilityReferences(project),
        project.id,
        [],
      );
      await validateFloodProject(project, selected.source.baseline);
      const result = await store.transaction(
        (s) => {
          const i = auth(s, r);
          requireFiscalWorkspace(i, true);
          const source = findProject(
            s,
            i.organization.id,
            sourceId,
            i.user.id,
            ["owner", "editor"],
          );
          if (
            source.version !== input.expectedVersion ||
            source.project.scenarios.find((v) => v.id === input.scenarioId)
              ?.revision !== input.expectedRevision ||
            fiscalContentHash(source.project) !==
              fiscalContentHash(selected.source.project)
          )
            throw new ApiError(
              409,
              "VERSION_CONFLICT",
              "The source study changed while the new study was being prepared.",
            );
          const replay = s.fiscalStudyCreations.find(
            (c) =>
              c.userId === i.user.id &&
              c.idempotencyKey === input.idempotencyKey,
          );
          if (replay)
            throw new ApiError(
              409,
              "FISCAL_REQUEST_RETRY",
              "This request completed concurrently. Retry the same key to load its study.",
            );
          const at = new Date().toISOString();
          const saved: ProjectRecord = {
            project,
            organizationId: i.organization.id,
            version: 1,
            baseline: source.baseline,
            createdBy: i.user.id,
            createdAt: at,
            acl: initialProjectAcl(i.user.id, at),
          };
          s.projects.push(saved);
          s.fiscalStudyCreations.push({
            id: randomUUID(),
            organizationId: i.organization.id,
            userId: i.user.id,
            projectId: project.id,
            sourceProjectId: sourceId,
            sourceVersion: input.expectedVersion,
            sourceScenarioId: input.scenarioId,
            sourceRevision: input.expectedRevision,
            idempotencyKey: input.idempotencyKey,
            submissionHash,
            profileHash: fiscalProfileHash(selected.profile),
            ...(input.libraryVersionId
              ? { libraryVersionId: input.libraryVersionId }
              : {}),
            createdAt: at,
          });
          addAudit(s, {
            organizationId: i.organization.id,
            projectId: project.id,
            actorId: i.user.id,
            action: "fiscal.study.created",
            details: {
              sourceProjectId: sourceId,
              sourceVersion: input.expectedVersion,
              profileHash: project.fiscalStudy!.profileHash,
              baselineHash: baseline.sha256,
            },
          });
          return response(s, saved);
        },
        requestScope(r, {
          projects: {
            where: [
              { id: sourceId, organizationId: { auth: "organizationId" } },
            ],
          },
          fiscalStudyCreations: {
            where: [
              {
                organizationId: { auth: "organizationId" },
                userId: { auth: "userId" },
              },
            ],
          },
          audit: { append: true },
        }),
      );
      return reply.code(201).send({ ...result, baselineIdentity: baseline });
    },
  );
}
