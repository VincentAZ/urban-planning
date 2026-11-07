import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  applyCommand,
  baselineIdentity,
  canonicalJSON,
  projectWithImportVersion,
  type Command,
} from "@urban/core";
import {
  addAudit,
  findProject,
  type Store,
  type DataState,
  type authorize,
} from "./store.js";
import { requestScope } from "./store-scope.js";
import { findProjectHeader, projectAccess } from "./project-access.js";
import {
  WorkforceJobService,
  publicWorkforceJob,
  workforceSubmissionSchema,
} from "./workforce-jobs.js";
import { ApiError } from "./errors.js";
import { scenarioSchema } from "./validation.js";
import { validateScenarioExtent } from "./geography.js";
import type { WorkforceAdoptResponse } from "./workforce-jobs-types.js";

export function registerWorkforceRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    service: WorkforceJobService;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
  },
) {
  const { store, service, auth } = options;
  const base = "/api/v1/projects/:projectId/workforce";
  const params = (request: FastifyRequest) =>
    request.params as { projectId: string; jobId: string };
  const authorizeProject = (
    state: DataState,
    request: FastifyRequest,
    edit = false,
  ) => {
    const identity = auth(state, request);
    findProjectHeader(
      state,
      identity.organization.id,
      params(request).projectId,
      identity.user.id,
      edit ? ["owner", "editor"] : undefined,
    );
    return identity;
  };
  const projectScope = (request: FastifyRequest) =>
    requestScope(request, {
      projectHeaders: {
        where: [
          {
            id: params(request).projectId,
            organizationId: { auth: "organizationId" },
          },
        ],
      },
    });
  const preflight = (request: FastifyRequest, edit = false) =>
    store.read(
      (state) => authorizeProject(state, request, edit),
      projectScope(request),
    );
  const jobScope = (request: FastifyRequest) => ({
    ...projectScope(request),
    workforceJobs: {
      where: [
        {
          projectId: params(request).projectId,
          organizationId: { auth: "organizationId" as const },
        },
      ],
    },
  });
  app.addHook("onReady", async () => service.start());
  app.addHook("preClose", async () => service.close());
  app.get(`${base}/capabilities`, async (request) => {
    await preflight(request);
    return service.capabilities();
  });
  app.get(`${base}/jobs`, async (request) =>
    store.read((state) => {
      authorizeProject(state, request);
      return {
        jobs: state.workforceJobs
          .filter((j) => j.projectId === params(request).projectId)
          .slice(-100)
          .reverse()
          .map(publicWorkforceJob),
      };
    }, jobScope(request)),
  );
  app.get(`${base}/jobs/:jobId`, async (request) =>
    store.read((state) => {
      authorizeProject(state, request);
      const job = state.workforceJobs.find(
        (j) =>
          j.id === params(request).jobId &&
          j.projectId === params(request).projectId,
      );
      if (!job)
        throw new ApiError(404, "NOT_FOUND", "Workforce job not found.");
      return { job: publicWorkforceJob(job) };
    }, jobScope(request)),
  );
  app.post(`${base}/jobs`, async (request, reply) => {
    const identity = await preflight(request, true);
    const input = workforceSubmissionSchema.parse(request.body);
    const job = await service.enqueue(
      params(request).projectId,
      input,
      (state) => auth(state, request),
      identity.session.hash,
    );
    return reply.code(201).send({ job });
  });
  app.post(`${base}/jobs/:jobId/cancel`, async (request) => {
    const identity = await preflight(request, true);
    const { expectedJobVersion } = z
      .object({ expectedJobVersion: z.number().int().positive() })
      .strict()
      .parse(request.body);
    return {
      job: await service.cancel(
        params(request).projectId,
        params(request).jobId,
        expectedJobVersion,
        (state) => auth(state, request),
        identity.session.hash,
      ),
    };
  });
  app.post(`${base}/jobs/:jobId/retry`, async (request) => {
    const identity = await preflight(request, true);
    const { expectedJobVersion, idempotencyKey } = z
      .object({
        expectedJobVersion: z.number().int().positive(),
        idempotencyKey: z.string().min(8).max(160),
      })
      .strict()
      .parse(request.body);
    return {
      job: await service.retry(
        params(request).projectId,
        params(request).jobId,
        expectedJobVersion,
        idempotencyKey,
        (state) => auth(state, request),
        identity.session.hash,
      ),
    };
  });
  const completed = async (request: FastifyRequest) => {
    const selected = await store.read((state) => {
      authorizeProject(state, request);
      const job = state.workforceJobs.find(
        (j) =>
          j.id === params(request).jobId &&
          j.projectId === params(request).projectId,
      );
      if (!job)
        throw new ApiError(404, "NOT_FOUND", "Workforce job not found.");
      if (job.status !== "completed" || !job.result)
        throw new ApiError(
          409,
          "WORKFORCE_RESULT_NOT_READY",
          "This job has no complete captured result.",
        );
      return job;
    }, jobScope(request));
    return store.read(
      (state) => {
        authorizeProject(state, request);
        const artifact = state.workforceArtifacts.find(
          (a) =>
            a.id === selected.result!.artifactId &&
            a.projectId === selected.projectId &&
            a.jobId === selected.id,
        );
        if (!artifact)
          throw new ApiError(
            503,
            "WORKFORCE_ARTIFACT_UNAVAILABLE",
            "The complete captured result is unavailable. Saved summary tables remain intact.",
          );
        return { job: selected, artifact };
      },
      {
        ...projectScope(request),
        workforceArtifacts: {
          where: [
            { id: selected.result!.artifactId, projectId: selected.projectId },
          ],
        },
      },
    );
  };
  app.get(`${base}/jobs/:jobId/result`, async (request) => {
    const { job, artifact } = await completed(request);
    await service.archive.verify(artifact.rawFileHash, artifact.rawFileBytes);
    // Recheck authorization after disk verification; a grant can be revoked while awaiting I/O.
    await preflight(request);
    return {
      job: publicWorkforceJob(job),
      workforce: artifact.workforce,
      contour: artifact.contour,
      siteSnapMeters: artifact.siteSnapMeters,
    };
  });
  app.get(
    `${base}/jobs/:jobId/artifact`,
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { artifact } = await completed(request);
      const raw = await service.archive.readVerified(
        artifact.rawFileHash,
        artifact.rawFileBytes,
      );
      await preflight(request);
      return reply
        .type("application/json; charset=utf-8")
        .header("Cache-Control", "private, no-store")
        .header("X-Content-SHA256", artifact.rawFileHash)
        .header(
          "Content-Disposition",
          `attachment; filename="workforce-${artifact.rawFileHash}.json"`,
        )
        .send(raw);
    },
  );
  app.post(
    `${base}/jobs/:jobId/adopt`,
    async (request): Promise<WorkforceAdoptResponse> => {
      await preflight(request, true);
      const input = z
        .object({
          scenarioId: z.string().min(1).max(160),
          expectedVersion: z.number().int().positive(),
          expectedRevision: z.number().int().nonnegative(),
          inputHash: z.string().regex(/^[a-f0-9]{64}$/),
          resultHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(request.body);
      const { job: capturedJob, artifact } = await completed(request);
      await service.archive.verify(artifact.rawFileHash, artifact.rawFileBytes);
      const saved = await store.transaction(
        (state) => {
          const identity = auth(state, request),
            { projectId, jobId } = params(request);
          const record = findProject(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            ["owner", "editor"],
          );
          const job = state.workforceJobs.find(
            (j) =>
              j.id === jobId &&
              j.projectId === projectId &&
              j.status === "completed",
          );
          const authoritative = state.workforceArtifactHeaders.find(
            (a) =>
              a.id === job?.result?.artifactId &&
              a.jobId === jobId &&
              a.projectId === projectId,
          );
          if (
            !job ||
            !authoritative ||
            job.id !== capturedJob.id ||
            canonicalJSON(authoritative.workforce) !==
              canonicalJSON(artifact.workforce)
          )
            throw new ApiError(
              409,
              "WORKFORCE_RESULT_CHANGED",
              "The captured job evidence is no longer available for adoption.",
            );
          if (
            input.scenarioId !== job.scenarioId ||
            input.inputHash !== authoritative.workforce.capture.inputHash ||
            input.resultHash !== authoritative.workforce.capture.resultHash
          )
            throw new ApiError(
              409,
              "WORKFORCE_INPUT_MISMATCH",
              "The result does not match the selected scenario and exact captured request.",
            );
          const before = record.project.scenarios.find(
            (s) => s.id === input.scenarioId,
          );
          if (!before || before.id === "baseline")
            throw new ApiError(
              404,
              "NOT_FOUND",
              "The saved proposal scenario was not found.",
            );
          if (
            record.version !== input.expectedVersion ||
            before.revision !== input.expectedRevision
          )
            throw new ApiError(
              409,
              "REVISION_CONFLICT",
              "The project changed while routing. Reopen the saved project before adopting this result.",
            );
          const command: Command = {
            type: "scenario.workforce",
            workforce: structuredClone(authoritative.workforce),
          };
          const after = scenarioSchema.parse(applyCommand(before, command));
          validateScenarioExtent(after, record.baseline);
          record.project.scenarios = record.project.scenarios.map((s) =>
            s.id === before.id ? after : s,
          );
          const abandoned = new Set(
            record.project.undone
              .filter((e) => e.after.id === before.id)
              .map((e) => e.id),
          );
          record.project.history = record.project.history.map((e) =>
            abandoned.has(e.id) ? { ...e, superseded: true } : e,
          );
          const at = new Date().toISOString();
          record.project.history.push({
            id: randomUUID(),
            at,
            actor: identity.user.name,
            label: "Adopt captured workforce evidence",
            command,
            before: structuredClone(before),
            after: structuredClone(after),
          });
          record.project.undone = record.project.undone.filter(
            (e) => e.after.id !== before.id,
          );
          record.project = projectWithImportVersion(
            record.project,
            record.baseline,
          );
          record.project.updatedAt = at;
          record.version++;
          addAudit(state, {
            organizationId: record.organizationId,
            projectId,
            actorId: identity.user.id,
            action: "workforce.adopted",
            details: {
              jobId,
              scenarioId: before.id,
              revision: after.revision,
              projectVersion: record.version,
              inputHash: input.inputHash,
              resultHash: input.resultHash,
              captureHash: authoritative.workforce.captureHash,
            },
          });
          return {
            project: record.project,
            baseline: record.baseline,
            version: record.version,
            organizationId: record.organizationId,
            access: projectAccess(
              record,
              identity.user.id,
              identity.membership,
            )!,
          };
        },
        requestScope(request, {
          projects: {
            where: [
              {
                id: params(request).projectId,
                organizationId: { auth: "organizationId" },
              },
            ],
          },
          workforceJobs: {
            where: [
              {
                id: params(request).jobId,
                projectId: params(request).projectId,
              },
            ],
          },
          workforceArtifactHeaders: {
            where: [{ id: artifact.id, projectId: params(request).projectId }],
          },
          audit: { append: true },
        }),
      );
      return {
        ...saved,
        baselineIdentity: await baselineIdentity(saved.baseline),
      };
    },
  );
}
