import { trafficSignalTimingEligibility } from "./signal-effects.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  applyCommand,
  baselineIdentity,
  canonicalJSON,
  projectWithTrafficVersion,
  trafficContentHash,
  trafficRoadEditsHash,
  trafficPlanningSources,
  verifyTrafficScenario,
  type Command,
} from "@urban/core";
import { ApiError } from "../errors.js";
import { trafficCommutePresetView } from "./commute-evidence.js";
import { validateScenarioExtent } from "../geography.js";
import { findProjectHeader, projectAccess } from "../project-access.js";
import { requestScope, type StoreScope } from "../store-scope.js";
import {
  addAudit,
  findProject,
  type DataState,
  type Store,
  type authorize,
} from "../store.js";
import { scenarioSchema } from "../validation.js";
import {
  latestTrafficConfiguration,
  trafficScenario,
  trafficWriterRoles,
} from "./configurations.js";
import {
  TrafficJobService,
  TRAFFIC_JOB_LIMITS,
  publicTrafficJob,
  trafficStartSchema,
} from "./jobs.js";
import type { CapturedTrafficExperiment } from "./experiment.js";
import type { TrafficAdoptResponse, TrafficContext } from "./jobs-types.js";
import {
  trafficConfigurationSubmissionSchema,
  TRAFFIC_CONFIGURATION_BYTES,
} from "./source-review.js";

const id = z.string().min(1).max(160);
const key = z.string().min(8).max(160);
const querySchema = z.object({ scenarioId: id }).strict();
const contextQuerySchema = querySchema.extend({ preparedId: id.optional() });
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const resultUnavailable = () =>
  new ApiError(
    503,
    "TRAFFIC_ARTIFACT_UNAVAILABLE",
    "The exact private traffic evidence is unavailable or differs from its retained identity. Saved summary tables remain intact.",
  );
const privateResponse = (reply: FastifyReply) =>
  reply.header("Cache-Control", "private, no-store");

/** All routes use the actual account and saved project; no request can supply a filesystem path. */
export function registerTrafficRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    service: TrafficJobService;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
  },
) {
  const { store, service, auth } = options;
  const base = "/api/v1/projects/:projectId/traffic";
  const params = (request: FastifyRequest) =>
    request.params as {
      projectId: string;
      jobId: string;
      uploadId: string;
      name: string;
      presetId: string;
    };
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
      edit ? [...trafficWriterRoles] : undefined,
    );
    return identity;
  };
  const scope = (request: FastifyRequest, extra: StoreScope = {}) =>
    requestScope(request, {
      projectId: params(request).projectId,
      projectHeaders: {
        where: [
          {
            id: params(request).projectId,
            organizationId: { auth: "organizationId" },
          },
        ],
      },
      ...extra,
    });
  const preflight = (request: FastifyRequest, edit = false) =>
    store.read(
      (state) => authorizeProject(state, request, edit),
      scope(request),
    );
  const jobScope = (request: FastifyRequest, singular = false) =>
    scope(request, {
      trafficJobs: {
        where: [
          {
            projectId: params(request).projectId,
            organizationId: { auth: "organizationId" },
            ...(singular ? { id: params(request).jobId } : {}),
          },
        ],
      },
    });
  app.addHook("onReady", async () => service.start());
  app.addHook("preClose", async () => service.close());

  app.get(`${base}/capabilities`, async (request, reply) => {
    privateResponse(reply);
    const identity = await preflight(request),
      { scenarioId, preparedId } = contextQuerySchema.parse(request.query);
    const { record } = await service.readProject(
      params(request).projectId,
      (state) => auth(state, request),
      identity.session.hash,
    );
    if (!record.project.scenarios.some((s) => s.id === scenarioId))
      throw new ApiError(404, "NOT_FOUND", "The saved scenario was not found.");
    const selectedId =
      preparedId ??
      (await store.read(
        (state) => {
          authorizeProject(state, request);
          return latestTrafficConfiguration(
            state,
            params(request).projectId,
            scenarioId,
          )?.prepared.id;
        },
        scope(request, {
          trafficConfigHeaders: {
            where: [{ projectId: params(request).projectId }],
          },
        }),
      ));
    const capabilities = await service.capabilities(
      record.baseline,
      selectedId,
    );
    await preflight(request);
    return capabilities;
  });
  app.get(
    `${base}/context`,
    async (request, reply): Promise<TrafficContext> => {
      privateResponse(reply);
      const identity = await preflight(request),
        { scenarioId, preparedId } = contextQuerySchema.parse(request.query);
      const { record, configuration: latestConfiguration } =
        await service.contextInputs(
          params(request).projectId,
          scenarioId,
          (state) => auth(state, request),
          identity.session.hash,
        );
      const selectedId = preparedId ?? latestConfiguration?.prepared.id;
      const capabilities = await service.capabilities(
        record.baseline,
        selectedId,
      );
      const configuration =
        latestConfiguration &&
        (!selectedId || latestConfiguration.prepared.id === selectedId) &&
        (!capabilities.prepared ||
          latestConfiguration.prepared.networkHash ===
            capabilities.prepared.networkHash)
          ? latestConfiguration
          : null;
      let preparedChoices: TrafficContext["preparedChoices"] = [];
      let commutePresets: TrafficContext["commutePresets"];
      let signalTimingEligibility: TrafficContext["signalTimingEligibility"];
      let network: TrafficContext["network"] = null,
        initialRequest: TrafficContext["initialRequest"] = null;
      if (service.options.catalog && capabilities.prepared) {
        try {
          const retained = (
            await service.options.catalog.forPlace(record.baseline, selectedId)
          ).network;
          preparedChoices = service.options.catalog.choices
            ? await service.options.catalog.choices(record.baseline)
            : [
                {
                  id: capabilities.prepared.id,
                  label: capabilities.prepared.id,
                  networkHash: capabilities.prepared.networkHash,
                },
              ];
          network = retained.network;
          if (service.options.catalog.commutePresets)
            commutePresets = (
              await service.options.catalog.commutePresets(
                record.baseline,
                selectedId,
              )
            ).map(trafficCommutePresetView);
          signalTimingEligibility =
            await trafficSignalTimingEligibility(retained);
          if (!configuration)
            initialRequest = await service.options.catalog.initialRequest(
              record.baseline,
              params(request).projectId,
              selectedId,
            );
        } catch (error) {
          if (!(error instanceof ApiError) || error.statusCode !== 503)
            throw error;
          capabilities.enabled = false;
          capabilities.reason = error.message;
        }
      }
      await preflight(request);
      return {
        capabilities,
        preparedChoices,
        latestConfigurationId: latestConfiguration?.id ?? null,
        configuration,
        network,
        initialRequest,
        ...(signalTimingEligibility ? { signalTimingEligibility } : {}),
        ...(commutePresets ? { commutePresets } : {}),
      };
    },
  );
  app.get(`${base}/commute/:presetId/evidence`, async (request, reply) => {
    privateResponse(reply);
    const identity = await preflight(request);
    const query = z.object({ preparedId: id }).strict().parse(request.query);
    const { record } = await service.readProject(
      params(request).projectId,
      (state) => auth(state, request),
      identity.session.hash,
    );
    const preset = (
      (await service.options.catalog?.commutePresets?.(
        record.baseline,
        query.preparedId,
        true,
      )) ?? []
    ).find((p) => p.id === params(request).presetId);
    if (!preset)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "The selected prepared commute evidence is unavailable for this study and graph.",
      );
    await preflight(request);
    return reply
      .header("Content-Type", "application/json")
      .header("Content-Length", preset.evidenceFile.bytes)
      .header("X-Content-SHA256", preset.evidenceFile.sha256)
      .header(
        "Content-Disposition",
        'attachment; filename="urban-planning-commute-evidence.json"',
      )
      .send(preset.evidenceBytes);
  });
  app.get(`${base}/configurations`, async (request, reply) => {
    privateResponse(reply);
    const { scenarioId } = querySchema.parse(request.query);
    return store.read(
      (state) => {
        const identity = authorizeProject(state, request);
        const header = findProjectHeader(
          state,
          identity.organization.id,
          params(request).projectId,
          identity.user.id,
        );
        if (!header.project.scenarios.some((s) => s.id === scenarioId))
          throw new ApiError(
            404,
            "NOT_FOUND",
            "The saved scenario was not found.",
          );
        return {
          configurations: state.trafficConfigHeaders
            .filter(
              (c) =>
                c.projectId === params(request).projectId &&
                c.scenarioId === scenarioId,
            )
            .slice(-100)
            .reverse(),
        };
      },
      scope(request, {
        trafficConfigHeaders: {
          where: [
            {
              projectId: params(request).projectId,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
  });
  app.post(
    `${base}/configurations`,
    {
      bodyLimit: TRAFFIC_CONFIGURATION_BYTES,
      onRequest: async (request) => {
        await preflight(request, true);
      },
    },
    async (request, reply) => {
      privateResponse(reply);
      const identity = await preflight(request, true);
      const configuration = await service.saveConfiguration(
        params(request).projectId,
        trafficConfigurationSubmissionSchema.parse(request.body),
        (state) => auth(state, request),
        identity.session.hash,
      );
      return reply.code(201).send({ configuration });
    },
  );
  app.post(
    `${base}/uploads`,
    {
      bodyLimit: TRAFFIC_JOB_LIMITS.uploadBytes + 16384,
      onRequest: async (request) => {
        await preflight(request, true);
      },
    },
    async (request, reply) => {
      privateResponse(reply);
      const identity = await preflight(request, true);
      let filename: string | undefined,
        raw: Buffer | undefined,
        idempotencyKey: string | undefined;
      for await (const part of request.parts({
        limits: {
          files: 1,
          fields: 1,
          parts: 2,
          fileSize: TRAFFIC_JOB_LIMITS.uploadBytes,
          fieldSize: 160,
        },
      })) {
        if (part.type === "field") {
          if (
            part.fieldname !== "idempotencyKey" ||
            idempotencyKey !== undefined ||
            typeof part.value !== "string" ||
            part.valueTruncated
          )
            throw new ApiError(
              400,
              "TRAFFIC_UPLOAD_INVALID",
              "Supply one stable upload request key and one CSV file.",
            );
          idempotencyKey = key.parse(part.value);
        } else {
          if (part.fieldname !== "file" || filename !== undefined) {
            part.file.resume();
            throw new ApiError(
              400,
              "TRAFFIC_UPLOAD_INVALID",
              "Supply exactly one CSV file.",
            );
          }
          filename = part.filename;
          raw = await part.toBuffer();
          if (
            part.file.truncated ||
            raw.length > TRAFFIC_JOB_LIMITS.uploadBytes
          )
            throw new ApiError(
              413,
              "TRAFFIC_UPLOAD_TOO_LARGE",
              "CSV uploads are limited to 5 MiB. No file was retained.",
            );
        }
      }
      if (!filename || !raw || !idempotencyKey)
        throw new ApiError(
          400,
          "TRAFFIC_UPLOAD_INVALID",
          "Supply one stable upload request key and one nonempty CSV file.",
        );
      const upload = await service.upload(
        params(request).projectId,
        filename,
        raw,
        idempotencyKey,
        (state) => auth(state, request),
        identity.session.hash,
      );
      return reply.code(201).send({
        upload: {
          id: upload.id,
          filename: upload.filename,
          sourceId: upload.sourceId,
          sha256: upload.sha256,
          bytes: upload.bytes,
          rows: upload.rows,
        },
      });
    },
  );
  app.get(
    `${base}/uploads/:uploadId/file`,
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const upload = await store.read(
        (state) => {
          authorizeProject(state, request);
          const value = state.trafficUploads.find(
            (v) =>
              v.id === params(request).uploadId &&
              v.projectId === params(request).projectId,
          );
          if (!value)
            throw new ApiError(
              404,
              "NOT_FOUND",
              "The retained traffic source file was not found.",
            );
          return value;
        },
        scope(request, {
          trafficUploads: {
            where: [
              {
                id: params(request).uploadId,
                projectId: params(request).projectId,
                organizationId: { auth: "organizationId" },
              },
            ],
          },
        }),
      );
      const raw = await service.archive.read(
        upload,
        upload.archive,
        "counts.csv",
      );
      const manifest = await service.archive.verify(upload, upload.archive);
      const file = manifest.files.find((f) => f.name === "counts.csv");
      if (!file || file.sha256 !== upload.sha256 || file.bytes !== upload.bytes)
        throw resultUnavailable();
      await preflight(request);
      return privateResponse(reply)
        .type("text/csv; charset=utf-8")
        .header("X-Content-SHA256", upload.sha256)
        .header(
          "Content-Disposition",
          `attachment; filename="traffic-counts-${upload.id}.csv"`,
        )
        .send(raw);
    },
  );

  app.get(`${base}/jobs`, async (request, reply) => {
    privateResponse(reply);
    return store.read((state) => {
      authorizeProject(state, request);
      return {
        jobs: state.trafficJobs
          .filter((j) => j.projectId === params(request).projectId)
          .slice(-100)
          .reverse()
          .map(publicTrafficJob),
      };
    }, jobScope(request));
  });
  app.get(`${base}/jobs/:jobId`, async (request, reply) => {
    privateResponse(reply);
    return store.read(
      (state) => {
        authorizeProject(state, request);
        const job = state.trafficJobs.find(
          (j) =>
            j.id === params(request).jobId &&
            j.projectId === params(request).projectId,
        );
        if (!job)
          throw new ApiError(404, "NOT_FOUND", "Traffic job not found.");
        return { job: publicTrafficJob(job) };
      },
      jobScope(request, true),
    );
  });
  app.post(`${base}/jobs`, async (request, reply) => {
    privateResponse(reply);
    const identity = await preflight(request, true);
    return reply.code(201).send({
      job: await service.enqueue(
        params(request).projectId,
        trafficStartSchema.parse(request.body),
        (state) => auth(state, request),
        identity.session.hash,
      ),
    });
  });
  app.post(`${base}/jobs/:jobId/cancel`, async (request, reply) => {
    privateResponse(reply);
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
  app.post(`${base}/jobs/:jobId/retry`, async (request, reply) => {
    privateResponse(reply);
    const identity = await preflight(request, true);
    const { expectedJobVersion, idempotencyKey } = z
      .object({
        expectedJobVersion: z.number().int().positive(),
        idempotencyKey: key,
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
    const job = await store.read(
      (state) => {
        authorizeProject(state, request);
        const value = state.trafficJobs.find(
          (j) =>
            j.id === params(request).jobId &&
            j.projectId === params(request).projectId,
        );
        if (!value)
          throw new ApiError(404, "NOT_FOUND", "Traffic job not found.");
        if (value.status !== "completed" || !value.result)
          throw new ApiError(
            409,
            "TRAFFIC_RESULT_NOT_READY",
            "This traffic job has no complete captured result.",
          );
        return value;
      },
      jobScope(request, true),
    );
    const artifact = await store.read(
      (state) => {
        authorizeProject(state, request);
        const value = state.trafficArtifactHeaders.find(
          (a) =>
            a.id === job.result!.artifactId &&
            a.projectId === job.projectId &&
            a.jobId === job.id,
        );
        if (
          !value ||
          value.organizationId !== job.organizationId ||
          value.configurationId !== job.configurationId ||
          value.scenarioId !== job.scenarioId ||
          value.traffic.origin !== "server-run" ||
          value.traffic.captureHash !== job.result!.captureHash ||
          value.traffic.receipt.projectId !== job.projectId ||
          value.traffic.receipt.jobId !== job.id ||
          value.traffic.receipt.captureId !== value.id ||
          value.traffic.binding.baselineHash !== job.baselineHash ||
          value.traffic.binding.roadEditsHash !== job.roadEditsHash ||
          !same(value.traffic.capture.privateArchive, job.result!.archive)
        )
          throw resultUnavailable();
        return value;
      },
      scope(request, {
        trafficArtifactHeaders: {
          where: [
            {
              id: job.result!.artifactId,
              projectId: job.projectId,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
    if (
      (await trafficContentHash(artifact.traffic.capture)) !==
      artifact.traffic.captureHash
    )
      throw resultUnavailable();
    return { job, artifact };
  };
  const verified = async (request: FastifyRequest) => {
    const captured = await completed(request);
    const manifest = await service.archive.verify(
      captured.job,
      captured.job.result!.archive,
    );
    const recorded = captured.artifact.traffic.capture.files;
    if (
      recorded.length !== manifest.files.length ||
      manifest.files.some(
        (file) =>
          !recorded.some(
            (ref) =>
              ref.url ===
                `urn:urban:traffic:archive:${captured.job.result!.archive.sha256}:${file.name}` &&
              ref.sha256 === file.sha256 &&
              ref.bytes === file.bytes,
          ),
      )
    )
      throw resultUnavailable();
    return { ...captured, manifest };
  };
  app.get(`${base}/jobs/:jobId/result`, async (request, reply) => {
    const { job, artifact } = await verified(request);
    let experiment: CapturedTrafficExperiment;
    try {
      experiment = JSON.parse(
        (
          await service.archive.read(
            job,
            job.result!.archive,
            "experiment.json",
          )
        ).toString("utf8"),
      );
      if (
        experiment.requestHash !== job.requestHash ||
        (await trafficContentHash(experiment.request)) !== job.requestHash ||
        !same(experiment.recipe, artifact.traffic.capture.recipe) ||
        !same(experiment.comparison, artifact.traffic.capture.comparison)
      )
        throw resultUnavailable();
    } catch {
      throw resultUnavailable();
    }
    await preflight(request);
    return privateResponse(reply).send({
      job: publicTrafficJob(job),
      traffic: artifact.traffic,
      experiment,
    });
  });
  app.get(
    `${base}/jobs/:jobId/files`,
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { manifest } = await verified(request);
      await preflight(request);
      return privateResponse(reply).send({ files: manifest.files });
    },
  );
  app.get(
    `${base}/jobs/:jobId/files/:name`,
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { job, manifest } = await verified(request);
      const file = manifest.files.find((f) => f.name === params(request).name);
      if (!file)
        throw new ApiError(
          404,
          "NOT_FOUND",
          "The requested retained traffic file was not found.",
        );
      const raw = await service.archive.read(
        job,
        job.result!.archive,
        file.name,
      );
      await preflight(request);
      return privateResponse(reply)
        .type("application/octet-stream")
        .header("X-Content-SHA256", file.sha256)
        .header("Content-Disposition", `attachment; filename="${file.name}"`)
        .send(raw);
    },
  );
  app.post(
    `${base}/jobs/:jobId/adopt`,
    async (request, reply): Promise<TrafficAdoptResponse> => {
      privateResponse(reply);
      const identity = await preflight(request, true);
      const input = z
        .object({
          scenarioId: id,
          expectedVersion: z.number().int().positive(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict()
        .parse(request.body);
      const { job: capturedJob, artifact } = await verified(request);
      const { record: capturedRecord } = await service.readProject(
        params(request).projectId,
        (state) => auth(state, request),
        identity.session.hash,
        true,
      );
      const before = trafficScenario(capturedRecord, input);
      const [baseline, roadHash] = await Promise.all([
        baselineIdentity(capturedRecord.baseline),
        trafficRoadEditsHash(capturedRecord.baseline, before),
      ]);
      await verifyTrafficScenario(
        artifact.traffic,
        capturedRecord.baseline,
        baseline.sha256,
      );
      if (
        capturedJob.scenarioId !== input.scenarioId ||
        capturedJob.baselineHash !== baseline.sha256 ||
        capturedJob.roadEditsHash !== roadHash
      )
        throw new ApiError(
          409,
          "TRAFFIC_RESULT_STALE",
          "The result belongs to a different proposal, baseline or planning-road context. Review and run the current traffic configuration before adopting.",
        );
      const correspondence =
        artifact.traffic.capture.proposal.planningRoadMapping.correspondence;
      if (correspondence) {
        let citationsMatch = false;
        try {
          citationsMatch = same(
            correspondence.sources,
            trafficPlanningSources(capturedRecord.baseline, before),
          );
        } catch {
          /* Conflicting or missing citations require a new review. */
        }
        if (!citationsMatch)
          throw new ApiError(
            409,
            "TRAFFIC_RESULT_STALE",
            "Planning source citations changed after this reviewed experiment. Review the current sources and run a current configuration before adopting.",
          );
      }
      const saved = await store.transaction(
        (state) => {
          const actor = auth(state, request),
            { projectId, jobId } = params(request);
          const record = findProject(
            state,
            actor.organization.id,
            projectId,
            actor.user.id,
            [...trafficWriterRoles],
          );
          const currentBefore = trafficScenario(record, input);
          const job = state.trafficJobs.find(
            (j) =>
              j.id === jobId &&
              j.projectId === projectId &&
              j.status === "completed",
          );
          const authoritative = state.trafficArtifactHeaders.find(
            (a) =>
              a.id === job?.result?.artifactId &&
              a.jobId === jobId &&
              a.projectId === projectId,
          );
          const latest = latestTrafficConfiguration(
            state,
            projectId,
            input.scenarioId,
          );
          if (
            !job ||
            !authoritative ||
            !same(job, capturedJob) ||
            !same(authoritative, artifact)
          )
            throw new ApiError(
              409,
              "TRAFFIC_RESULT_CHANGED",
              "The completed traffic evidence changed while it was being verified. Refresh the saved project and result.",
            );
          if (
            !latest ||
            latest.id !== job.configurationId ||
            latest.requestHash !== job.requestHash
          )
            throw new ApiError(
              409,
              "TRAFFIC_CONFIGURATION_STALE",
              "A different traffic configuration is now selected. Only the latest reviewed configuration can be adopted.",
            );
          // The exact current saved version/revision is checked again after all asynchronous hashing/I/O.
          if (
            record.version !== capturedRecord.version ||
            !same(currentBefore, before) ||
            !same(record.baseline, capturedRecord.baseline)
          )
            throw new ApiError(
              409,
              "REVISION_CONFLICT",
              "The project changed while traffic evidence was verified. Reopen the saved project before adopting.",
            );
          const command: Command = {
            type: "scenario.traffic",
            traffic: structuredClone(authoritative.traffic),
          };
          const after = scenarioSchema.parse(
            applyCommand(currentBefore, command),
          );
          validateScenarioExtent(after, record.baseline);
          record.project.scenarios = record.project.scenarios.map((s) =>
            s.id === currentBefore.id ? after : s,
          );
          const abandoned = new Set(
            record.project.undone
              .filter((e) => e.after.id === currentBefore.id)
              .map((e) => e.id),
          );
          record.project.history = record.project.history.map((e) =>
            abandoned.has(e.id) ? { ...e, superseded: true } : e,
          );
          const at = new Date().toISOString();
          record.project.history.push({
            id: randomUUID(),
            at,
            actor: actor.user.name,
            label: "Adopt captured traffic experiment",
            command,
            before: structuredClone(currentBefore),
            after: structuredClone(after),
          });
          record.project.undone = record.project.undone.filter(
            (e) => e.after.id !== currentBefore.id,
          );
          record.project = projectWithTrafficVersion(
            record.project,
            record.baseline,
          );
          record.project.updatedAt = at;
          record.version++;
          addAudit(state, {
            organizationId: record.organizationId,
            projectId,
            actorId: actor.user.id,
            action: "traffic.adopted",
            details: {
              jobId,
              configurationId: job.configurationId,
              scenarioId: after.id,
              revision: after.revision,
              projectVersion: record.version,
              captureHash: authoritative.traffic.captureHash,
              requestHash: job.requestHash,
            },
          });
          return {
            project: record.project,
            baseline: record.baseline,
            version: record.version,
            organizationId: record.organizationId,
            access: projectAccess(record, actor.user.id, actor.membership)!,
          };
        },
        scope(request, {
          projects: {
            where: [
              {
                id: params(request).projectId,
                organizationId: { auth: "organizationId" },
              },
            ],
          },
          trafficJobs: {
            where: [
              {
                id: params(request).jobId,
                projectId: params(request).projectId,
              },
            ],
          },
          trafficArtifactHeaders: {
            where: [{ id: artifact.id, projectId: params(request).projectId }],
          },
          trafficConfigHeaders: {
            where: [
              {
                projectId: params(request).projectId,
                organizationId: { auth: "organizationId" },
              },
            ],
          },
          audit: { append: true },
        }),
      );
      return { ...saved, baselineIdentity: baseline };
    },
  );
}
