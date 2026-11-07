import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "./errors.js";
import type { DataState, Store, authorize } from "./store.js";
import { findProjectHeader } from "./project-access.js";
import { requestScope, type StoreScope } from "./store-scope.js";
import { GisJobService, publicGisJob, stagedGisPreview } from "./gis-jobs.js";
import {
  gisPreviewRequestSchema,
  gisSubmissionSchema,
} from "./gis-import-mapping.js";
import { GIS_LIMITS, type GisFormat } from "./gis-types.js";
import type { GisJobRecord } from "./gis-jobs-types.js";
import type { StagedGisFile, GisArchivePublication } from "./gis-archive.js";

export function registerGisRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    service: GisJobService;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
  },
) {
  const { store, service, auth } = options,
    base = "/api/v1/projects/:projectId/imports";
  const params = (request: FastifyRequest) =>
    request.params as { projectId: string; jobId?: string; uploadId?: string };
  const scope = (request: FastifyRequest, full = false): StoreScope =>
    requestScope(request, {
      projectHeaders: {
        where: [
          {
            id: params(request).projectId,
            organizationId: { auth: "organizationId" },
          },
        ],
      },
      [full ? "gisJobs" : "gisJobHeaders"]: {
        where: [
          {
            ...(params(request).jobId || params(request).uploadId
              ? { id: params(request).jobId ?? params(request).uploadId }
              : {}),
            projectId: params(request).projectId,
            userId: { auth: "userId" },
            organizationId: { auth: "organizationId" },
          },
        ],
      },
    });
  const authorizeProject = (state: DataState, request: FastifyRequest) => {
    const identity = auth(state, request);
    findProjectHeader(
      state,
      identity.organization.id,
      params(request).projectId,
      identity.user.id,
      ["owner", "editor"],
    );
    return identity;
  };
  const preflight = (request: FastifyRequest) =>
    store.read((state) => authorizeProject(state, request), scope(request));
  const getJob = (
    state: DataState,
    request: FastifyRequest,
    id: string | undefined,
    full = false,
  ) => {
    const identity = authorizeProject(state, request),
      job = (full ? state.gisJobs : state.gisJobHeaders).find(
        (j) =>
          j.id === id &&
          j.projectId === params(request).projectId &&
          j.userId === identity.user.id &&
          j.organizationId === identity.organization.id,
      );
    if (!job) throw new ApiError(404, "NOT_FOUND", "GIS job not found.");
    return job;
  };
  app.addHook("onReady", async () => service.start());
  app.addHook("preClose", async () => service.close());
  app.get(`${base}/capabilities`, async (request) => {
    await preflight(request);
    return service.capabilities();
  });
  app.get(`${base}/jobs`, async (request) =>
    store.read((state) => {
      const identity = authorizeProject(state, request);
      return {
        jobs: state.gisJobHeaders
          .filter(
            (j) =>
              j.projectId === params(request).projectId &&
              j.userId === identity.user.id &&
              j.organizationId === identity.organization.id,
          )
          .slice(-100)
          .reverse()
          .map(publicGisJob),
      };
    }, scope(request)),
  );
  app.get(`${base}/jobs/:jobId`, async (request) =>
    store.read(
      (state) => ({
        job: publicGisJob(getJob(state, request, params(request).jobId)),
      }),
      scope(request),
    ),
  );
  app.post(
    `${base}/uploads`,
    {
      onRequest: async (request) => {
        await preflight(request);
      },
    },
    async (request, reply) => {
      const identity = await preflight(request),
        capabilities = await service.capabilities();
      if (!capabilities.enabled)
        throw new ApiError(
          503,
          "GIS_DISABLED",
          capabilities.reason ?? "GIS uploads are disabled.",
        );
      let metadata: z.infer<typeof gisSubmissionSchema> | undefined,
        upload: GisJobRecord["upload"] | undefined;
      let staged: StagedGisFile | undefined,
        publication: GisArchivePublication | undefined;
      let accepted = false;
      try {
        for await (const part of request.parts({
          limits: {
            files: 1,
            fields: 1,
            parts: 2,
            fileSize: GIS_LIMITS.inputBytes,
            fieldSize: 16384,
          },
        })) {
          if (part.type === "field") {
            if (
              part.fieldname !== "metadata" ||
              metadata ||
              typeof part.value !== "string"
            )
              throw new ApiError(
                400,
                "GIS_UPLOAD_METADATA",
                "Provide one metadata field before the file.",
              );
            let parsed: unknown;
            try {
              parsed = JSON.parse(part.value);
            } catch {
              throw new ApiError(
                400,
                "GIS_UPLOAD_METADATA",
                "Upload metadata must be valid JSON.",
              );
            }
            metadata = gisSubmissionSchema.parse(parsed);
            await service.preflightUpload(
              params(request).projectId,
              metadata,
              (state) => auth(state, request),
              identity.session.hash,
            );
          } else {
            if (part.fieldname !== "file" || !metadata || upload) {
              part.file.resume();
              throw new ApiError(
                400,
                "GIS_UPLOAD_METADATA",
                "Provide request metadata before one file.",
              );
            }
            const filename = part.filename;
            if (!/^[^/\\\x00:]{1,240}$/.test(filename))
              throw new ApiError(
                422,
                "GIS_FILENAME",
                "Use a display filename without a path.",
              );
            const format: GisFormat | undefined = /\.(?:geojson|json)$/i.test(
              filename,
            )
              ? "geojson"
              : /\.zip$/i.test(filename)
                ? "shapefile"
                : /\.dxf$/i.test(filename)
                  ? "dxf"
                  : undefined;
            if (!format)
              throw new ApiError(
                422,
                "GIS_FORMAT",
                "Choose GeoJSON, a shapefile ZIP, or DXF.",
              );
            staged = await service.archive.receiveTemporary(
              identity.organization.id,
              params(request).projectId,
              part.file,
            );
            upload = {
              filename,
              format,
              ...staged.reference,
            };
          }
        }
        if (!metadata || !upload || !staged)
          throw new ApiError(
            400,
            "GIS_UPLOAD_REQUIRED",
            "Upload metadata and one file are required.",
          );
        publication = await staged.finalize();
        const job = await service.enqueue(
          params(request).projectId,
          "inspect",
          metadata,
          { upload },
          (state) => auth(state, request),
          identity.session.hash,
        );
        accepted = true;
        await publication.settle(true);
        await staged.discard();
        return reply.code(202).send({ job });
      } finally {
        try {
          if (publication)
            await publication.settle(
              accepted ||
                (await service.uploadReferenced(
                  identity.organization.id,
                  params(request).projectId,
                  publication.reference.sha256,
                )),
            );
        } finally {
          await staged?.discard();
        }
      }
    },
  );
  app.get(`${base}/uploads/:uploadId`, async (request) =>
    store.read(
      (state) => {
        getJob(state, request, params(request).uploadId, true);
        const job = state.gisJobs.find(
          (j) => j.id === params(request).uploadId,
        )!;
        if (job.kind !== "inspect")
          throw new ApiError(404, "NOT_FOUND", "Inspected upload not found.");
        return {
          job: publicGisJob(job),
          ...(job.status === "completed" && job.inspection
            ? { inspection: job.inspection }
            : {}),
        };
      },
      scope(request, true),
    ),
  );
  app.post(`${base}/uploads/:uploadId/preview`, async (request, reply) => {
    const identity = await preflight(request),
      input = gisPreviewRequestSchema.parse(request.body);
    const job = await service.enqueue(
      params(request).projectId,
      "prepare",
      {
        scenarioId: input.scenarioId,
        expectedVersion: input.expectedVersion,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
      },
      { uploadId: params(request).uploadId, recipe: input },
      (state) => auth(state, request),
      identity.session.hash,
    );
    return reply.code(202).send({ job });
  });
  app.get(`${base}/jobs/:jobId/preview`, async (request) => {
    const captured = await store.read(
      (state) => getJob(state, request, params(request).jobId),
      scope(request),
    );
    if (!captured.result?.importId)
      throw new ApiError(
        409,
        "GIS_PREVIEW_NOT_READY",
        "The GIS preview is not complete.",
      );
    return store.read(
      (state) => {
        const job = getJob(state, request, params(request).jobId);
        if (
          job.kind !== "prepare" ||
          job.status !== "completed" ||
          !job.result?.importId
        )
          throw new ApiError(
            409,
            "GIS_PREVIEW_NOT_READY",
            "The GIS preview is not complete.",
          );
        const staged = state.imports.find(
          (i) =>
            i.id === job.result!.importId &&
            i.projectId === job.projectId &&
            i.createdBy === job.userId &&
            i.organizationId === job.organizationId,
        );
        if (!staged)
          throw new ApiError(404, "NOT_FOUND", "GIS preview not found.");
        if (Date.parse(staged.expiresAt) < Date.now() && !staged.committed)
          throw new ApiError(
            410,
            "IMPORT_EXPIRED",
            "This preview expired. Prepare it again from the retained upload.",
          );
        const preview = stagedGisPreview(staged);
        if (preview.previewHash !== job.result.previewHash)
          throw new ApiError(
            503,
            "GIS_PREVIEW_CHANGED",
            "The preview identity does not match the completed job.",
          );
        return preview;
      },
      {
        ...scope(request),
        imports: {
          where: [
            {
              id: captured.result.importId,
              projectId: params(request).projectId,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      },
    );
  });
  app.post(`${base}/jobs/:jobId/cancel`, async (request) => {
    const identity = await preflight(request),
      input = z
        .object({ expectedJobVersion: z.number().int().positive() })
        .strict()
        .parse(request.body);
    return {
      job: await service.cancel(
        params(request).projectId,
        params(request).jobId!,
        input.expectedJobVersion,
        (state) => auth(state, request),
        identity.session.hash,
      ),
    };
  });
  app.post(`${base}/jobs/:jobId/retry`, async (request) => {
    const identity = await preflight(request),
      input = z
        .object({
          expectedJobVersion: z.number().int().positive(),
          idempotencyKey: z.string().min(8).max(160),
        })
        .strict()
        .parse(request.body);
    return {
      job: await service.retry(
        params(request).projectId,
        params(request).jobId!,
        input.expectedJobVersion,
        input.idempotencyKey,
        (state) => auth(state, request),
        identity.session.hash,
      ),
    };
  });
  app.post(`${base}/exports/shapefile`, async (request, reply) => {
    const identity = await preflight(request),
      input = gisSubmissionSchema.parse(request.body);
    const job = await service.enqueue(
      params(request).projectId,
      "export-shapefile",
      input,
      {},
      (state) => auth(state, request),
      identity.session.hash,
    );
    return reply.code(202).send({ job });
  });
  const download = async (request: FastifyRequest, original: boolean) => {
    const job = await store.read(
      (state) =>
        getJob(
          state,
          request,
          original ? params(request).uploadId : params(request).jobId,
        ),
      scope(request),
    );
    const reference =
      original && job.kind === "inspect"
        ? job.upload
        : !original &&
            job.kind === "export-shapefile" &&
            job.status === "completed" &&
            job.result?.downloadHash &&
            job.result.downloadBytes
          ? { sha256: job.result.downloadHash, bytes: job.result.downloadBytes }
          : undefined;
    if (!reference)
      throw new ApiError(404, "NOT_FOUND", "GIS file is not available.");
    const bytes = await service.archive.read(
      job.organizationId,
      job.projectId,
      reference,
    );
    await store.read((state) => getJob(state, request, job.id), scope(request));
    return {
      bytes,
      sha256: reference.sha256,
      filename: original
        ? job.upload!.filename
        : `scenario-${job.scenarioId}-r${job.scenarioRevision}.zip`,
    };
  };
  app.get(`${base}/jobs/:jobId/download`, async (request, reply) => {
    const file = await download(request, false);
    return reply
      .header("Cache-Control", "private, no-store")
      .header("ETag", `"${file.sha256}"`)
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .type("application/zip")
      .send(file.bytes);
  });
  app.get(`${base}/uploads/:uploadId/file`, async (request, reply) => {
    const file = await download(request, true);
    return reply
      .header("Cache-Control", "private, no-store")
      .header("ETag", `"${file.sha256}"`)
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .type("application/octet-stream")
      .send(file.bytes);
  });
}
