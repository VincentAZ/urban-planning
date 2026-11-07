import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requestScope } from "./store-scope.js";
import { findProjectHeader } from "./project-access.js";
import type { Store, DataState, authorize } from "./store.js";
import { ApiError } from "./errors.js";
import { mediaJobPage } from "./media-pagination.js";
import {
  MediaJobService,
  mediaSubmissionSchema,
  publicMediaJob,
  type MediaSubmission,
} from "./media-jobs.js";
export function registerMediaRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    service: MediaJobService;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
  },
) {
  const { store, service, auth } = options;
  const base = "/api/v1/projects/:projectId/media";
  const params = (r: FastifyRequest) =>
    r.params as { projectId: string; jobId: string; name: string };
  const scope = (r: FastifyRequest) =>
    requestScope(r, {
      projectHeaders: {
        where: [
          {
            id: params(r).projectId,
            organizationId: { auth: "organizationId" },
          },
        ],
      },
    });
  const access = (s: DataState, r: FastifyRequest, edit = false) => {
    const i = auth(s, r);
    findProjectHeader(
      s,
      i.organization.id,
      params(r).projectId,
      i.user.id,
      edit ? ["owner", "editor"] : undefined,
    );
    return i;
  };
  const jobScope = (r: FastifyRequest) => ({
    ...scope(r),
    mediaJobs: {
      where: [
        {
          projectId: params(r).projectId,
          ...(params(r).jobId ? { id: params(r).jobId } : {}),
        },
      ],
    },
  });
  app.addHook("onReady", async () => service.start());
  app.addHook("preClose", async () => service.close());
  app.get(`${base}/capabilities`, async (r) => {
    await store.read((s) => access(s, r), scope(r));
    return service.capabilities();
  });
  app.get(`${base}/context`, async (r) => {
    const i = await store.read((s) => access(s, r, true), scope(r));
    const q = z
      .object({ scenarioId: z.string().min(1).max(160) })
      .strict()
      .parse(r.query);
    return service.context(
      params(r).projectId,
      q.scenarioId,
      (s) => auth(s, r),
      i.session.hash,
    );
  });
  app.get(`${base}/jobs`, async (r) =>
    store.read((s) => {
      access(s, r);
      return mediaJobPage(s.mediaJobs, params(r).projectId, r.query);
    }, jobScope(r)),
  );
  app.get(`${base}/jobs/:jobId`, async (r) =>
    store.read((s) => {
      access(s, r);
      const j = s.mediaJobs.find(
        (j) => j.id === params(r).jobId && j.projectId === params(r).projectId,
      );
      if (!j) throw new ApiError(404, "NOT_FOUND", "Media job not found.");
      return { job: publicMediaJob(j) };
    }, jobScope(r)),
  );
  app.post(`${base}/jobs`, { bodyLimit: 64 * 1024 }, async (r, reply) => {
    const i = await store.read((s) => access(s, r, true), scope(r));
    const input = mediaSubmissionSchema.parse(r.body) as MediaSubmission;
    return reply.code(202).send({
      job: await service.enqueue(
        params(r).projectId,
        input,
        (s) => auth(s, r),
        i.session.hash,
      ),
    });
  });
  app.post(`${base}/jobs/:jobId/cancel`, { bodyLimit: 8 * 1024 }, async (r) => {
    const i = await store.read((s) => access(s, r, true), scope(r));
    const input = z
      .object({ expectedJobVersion: z.number().int().positive() })
      .strict()
      .parse(r.body);
    return {
      job: await service.cancel(
        params(r).projectId,
        params(r).jobId,
        input.expectedJobVersion,
        (s) => auth(s, r),
        i.session.hash,
      ),
    };
  });
  app.post(`${base}/jobs/:jobId/retry`, { bodyLimit: 8 * 1024 }, async (r) => {
    const i = await store.read((s) => access(s, r, true), scope(r));
    const input = z
      .object({
        expectedJobVersion: z.number().int().positive(),
        idempotencyKey: z.string().min(8).max(160),
      })
      .strict()
      .parse(r.body);
    return {
      job: await service.retry(
        params(r).projectId,
        params(r).jobId,
        input.expectedJobVersion,
        input.idempotencyKey,
        (s) => auth(s, r),
        i.session.hash,
      ),
    };
  });
  app.get(`${base}/jobs/:jobId/artifacts/:name`, async (r, reply) => {
    const selected = await store.read((s) => {
      access(s, r);
      const j = s.mediaJobs.find(
        (j) => j.id === params(r).jobId && j.projectId === params(r).projectId,
      );
      if (!j) throw new ApiError(404, "NOT_FOUND", "Media job not found.");
      if (j.status !== "completed" || !j.result)
        throw new ApiError(
          409,
          "MEDIA_NOT_COMPLETE",
          "No verified media artifact is available.",
        );
      return j;
    }, jobScope(r));
    const a = await store.read(
      (s) => {
        access(s, r);
        const a = s.mediaArtifacts.find(
          (a) =>
            a.id === selected.result!.artifactId &&
            a.jobId === selected.id &&
            a.projectId === selected.projectId,
        );
        if (!a || a.archive.sha256 !== selected.result!.archiveHash)
          throw new ApiError(
            503,
            "MEDIA_ARTIFACT_UNAVAILABLE",
            "The retained media artifact is unavailable.",
          );
        return a;
      },
      {
        ...scope(r),
        mediaArtifacts: {
          where: [
            { id: selected.result!.artifactId, projectId: selected.projectId },
          ],
        },
      },
    );
    const file = a.files.find((f) => f.name === params(r).name);
    if (!file)
      throw new ApiError(404, "NOT_FOUND", "Media artifact file not found.");
    const body = await service.archive.read(a, a.archive, file.name);
    await store.read((s) => access(s, r), scope(r));
    return reply
      .header("Content-Type", file.contentType)
      .header("Content-Length", body.length)
      .header("X-Content-SHA256", file.sha256)
      .header("Content-Disposition", `attachment; filename="${file.name}"`)
      .header("Cache-Control", "private, no-store")
      .send(body);
  });
}
