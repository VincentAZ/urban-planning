import { createHash, randomUUID } from "node:crypto";
import {
  baselineIdentity,
  canonicalJSON,
  parseTrafficCSV,
  trafficContentHash,
  trafficRoadEditsHash,
  type Place,
} from "@urban/core";
import { ApiError } from "../errors.js";
import {
  addAudit,
  findProject,
  type DataState,
  type Store,
  type authorize,
  type ProjectRecord,
} from "../store.js";
import { findProjectHeader } from "../project-access.js";
import type { StoreScope } from "../store-scope.js";
import { TrafficArchive } from "./archive.js";
import type { TrafficCatalog } from "./catalog.js";
import type { TrafficRuntime } from "./runtime.js";
import type {
  TrafficCapacityDeclaration,
  TrafficConfigurationRecord,
  TrafficUploadRecord,
} from "./jobs-types.js";
import {
  reviewTrafficSubmission,
  type TrafficConfigurationSubmission,
} from "./source-review.js";

export type TrafficAuthenticate = (
  state: DataState,
) => ReturnType<typeof authorize>;
export interface TrafficServiceOptions {
  enabled: boolean;
  catalog?: Pick<TrafficCatalog, "forPlace" | "initialRequest"> &
    Partial<Pick<TrafficCatalog, "choices" | "commutePresets">>;
  runtime?: Pick<TrafficRuntime, "runPair" | "available">;
  archiveDirectory: string;
  capacity?: TrafficCapacityDeclaration;
  automaticWorker?: boolean;
}
export const trafficWriterRoles = ["owner", "editor"] as const;
export function trafficCallerScope(
  projectId: string,
  sessionHash: string,
): StoreScope {
  return {
    auth: { sessionHash },
    projectId,
    projectHeaders: {
      where: [{ id: projectId, organizationId: { auth: "organizationId" } }],
    },
    audit: { append: true },
  };
}
export function trafficScenario<S extends { id: string; revision: number }>(
  record: { version: number; project: { scenarios: S[] } },
  input: {
    scenarioId: string;
    expectedVersion: number;
    expectedRevision: number;
  },
) {
  const scenario = record.project.scenarios.find(
    (s) => s.id === input.scenarioId,
  );
  if (!scenario || scenario.id === "baseline")
    throw new ApiError(
      400,
      "TRAFFIC_SCENARIO_REQUIRED",
      "Choose a saved editable proposal scenario.",
    );
  if (
    record.version !== input.expectedVersion ||
    scenario.revision !== input.expectedRevision
  )
    throw new ApiError(
      409,
      "REVISION_CONFLICT",
      "The saved project or scenario changed. Save or reopen it before continuing with traffic analysis.",
    );
  return scenario;
}
export function latestTrafficConfiguration(
  state: DataState,
  projectId: string,
  scenarioId: string,
) {
  return (
    state.trafficConfigHeaders
      .filter((c) => c.projectId === projectId && c.scenarioId === scenarioId)
      .at(-1) ?? null
  );
}
export class TrafficConfigurations {
  readonly archive: TrafficArchive;
  constructor(
    readonly store: Store,
    readonly options: TrafficServiceOptions,
  ) {
    this.archive = new TrafficArchive(options.archiveDirectory);
  }
  protected configured() {
    if (!this.options.catalog)
      throw new ApiError(
        503,
        "TRAFFIC_SOURCES_UNAVAILABLE",
        "No verified traffic network is configured for this saved study area.",
      );
    return this.options.catalog;
  }
  async readProject(
    projectId: string,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
    edit = false,
  ) {
    return this.store.read(
      (state) => {
        const identity = authenticate(state),
          record = findProject(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            edit ? [...trafficWriterRoles] : undefined,
          );
        return { identity, record };
      },
      {
        ...trafficCallerScope(projectId, sessionHash),
        projects: {
          where: [
            { id: projectId, organizationId: { auth: "organizationId" } },
          ],
        },
      },
    );
  }
  async checkAccess(
    projectId: string,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
    edit = false,
  ) {
    return this.store.read(
      (state) => {
        const identity = authenticate(state);
        findProjectHeader(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
          edit ? [...trafficWriterRoles] : undefined,
        );
        return identity;
      },
      trafficCallerScope(projectId, sessionHash),
    );
  }
  async contextInputs(
    projectId: string,
    scenarioId: string,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
  ) {
    const saved = await this.store.read(
      (state) => {
        const identity = authenticate(state),
          record = findProject(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
          );
        if (!record.project.scenarios.some((s) => s.id === scenarioId))
          throw new ApiError(
            404,
            "NOT_FOUND",
            "The saved scenario was not found.",
          );
        return {
          record,
          configuration: latestTrafficConfiguration(
            state,
            projectId,
            scenarioId,
          ),
        };
      },
      {
        ...trafficCallerScope(projectId, sessionHash),
        projects: {
          where: [
            { id: projectId, organizationId: { auth: "organizationId" } },
          ],
        },
        trafficConfigHeaders: { where: [{ projectId }] },
      },
    );
    return {
      ...saved,
      configuration: saved.configuration
        ? await this.configurationById(
            projectId,
            saved.configuration.id,
            authenticate,
            sessionHash,
          )
        : null,
    };
  }
  async configurationById(
    projectId: string,
    id: string,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
  ) {
    return this.store.read(
      (state) => {
        const identity = authenticate(state);
        findProjectHeader(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
        );
        const configuration = state.trafficConfigs.find(
          (c) => c.id === id && c.projectId === projectId,
        );
        if (!configuration)
          throw new ApiError(
            404,
            "NOT_FOUND",
            "The saved traffic configuration was not found.",
          );
        return configuration;
      },
      {
        ...trafficCallerScope(projectId, sessionHash),
        trafficConfigs: { where: [{ id, projectId }] },
      },
    );
  }
  async upload(
    projectId: string,
    filename: string,
    raw: Buffer,
    idempotencyKey: string,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
  ) {
    if (
      !/^[^\\/\x00-\x1f]{1,160}\.csv$/i.test(filename) ||
      raw.length > 5 * 1024 ** 2 ||
      raw.length === 0
    )
      throw new ApiError(
        400,
        "TRAFFIC_UPLOAD_INVALID",
        "Supply one nonempty CSV file up to 5 MiB with a plain .csv filename.",
      );
    if (idempotencyKey.length < 8 || idempotencyKey.length > 160)
      throw new ApiError(
        400,
        "TRAFFIC_REQUEST_KEY",
        "Supply a stable upload request key.",
      );
    let rows: number;
    try {
      rows = parseTrafficCSV(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      ).rows.length;
    } catch (error) {
      throw new ApiError(
        422,
        "TRAFFIC_CSV_INVALID",
        error instanceof Error ? error.message : "The CSV could not be read.",
      );
    }
    const sha256 = createHash("sha256").update(raw).digest("hex"),
      scope = {
        ...trafficCallerScope(projectId, sessionHash),
        trafficUploads: { where: [{ projectId }] },
      } satisfies StoreScope;
    const existingOrIdentity = (state: DataState) => {
      const identity = authenticate(state);
      findProjectHeader(
        state,
        identity.organization.id,
        projectId,
        identity.user.id,
        [...trafficWriterRoles],
      );
      const existing = state.trafficUploads.find(
        (u) =>
          u.projectId === projectId &&
          u.userId === identity.user.id &&
          u.idempotencyKey === idempotencyKey,
      );
      if (
        existing &&
        (existing.sha256 !== sha256 ||
          existing.filename !== filename ||
          existing.bytes !== raw.length)
      )
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This upload request key belongs to a different original file.",
        );
      return { existing, identity };
    };
    const initial = await this.store.read(existingOrIdentity, scope);
    if (initial.existing) {
      await this.archive.verify(initial.existing, initial.existing.archive);
      await this.checkAccess(projectId, authenticate, sessionHash, true);
      return initial.existing;
    }
    const staged = await this.archive.stage(
      { organizationId: initial.identity.organization.id, projectId },
      { "counts.csv": raw },
    );
    let retain = true;
    try {
      const result = await this.store.transaction(
        (state) => {
          const { existing, identity } = existingOrIdentity(state);
          if (existing) return existing;
          if (state.trafficUploads.length >= 256)
            throw new ApiError(
              429,
              "TRAFFIC_UPLOAD_LIMIT",
              "This project's retained traffic-upload inventory is full. No original file was deleted.",
            );
          const id = randomUUID(),
            upload: TrafficUploadRecord = {
              id,
              projectId,
              organizationId: identity.organization.id,
              userId: identity.user.id,
              createdAt: new Date().toISOString(),
              filename,
              sourceId: `traffic-csv-${id}`,
              sha256,
              bytes: raw.length,
              rows,
              idempotencyKey,
              archive: staged.reference,
            };
          state.trafficUploads.push(upload);
          addAudit(state, {
            organizationId: upload.organizationId,
            projectId,
            actorId: identity.user.id,
            action: "traffic.uploaded",
            details: { uploadId: id, sha256, bytes: raw.length, rows },
          });
          return upload;
        },
        { ...scope, security: { mode: "worker", purpose: "traffic" } },
      );
      retain =
        canonicalJSON(result.archive) === canonicalJSON(staged.reference);
      return result;
    } catch (error) {
      // A lost database reply may follow a commit. Resolve durable reference before rollback; uncertainty retains evidence.
      try {
        retain = await this.store.read(
          (state) =>
            state.trafficUploads.some(
              (u) =>
                canonicalJSON(u.archive) === canonicalJSON(staged.reference),
            ),
          scope,
        );
      } catch {
        retain = true;
      }
      throw error;
    } finally {
      await staged.settle(retain);
    }
  }
  async saveConfiguration(
    projectId: string,
    input: TrafficConfigurationSubmission,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
  ) {
    const submissionHash = await trafficContentHash(input),
      scope = {
        ...trafficCallerScope(projectId, sessionHash),
        projects: {
          where: [
            {
              id: projectId,
              organizationId: { auth: "organizationId" as const },
            },
          ],
        },
        trafficConfigHeaders: { where: [{ projectId }] },
        trafficUploads: { where: [{ projectId }] },
      } satisfies StoreScope;
    const inspect = (state: DataState) => {
      const identity = authenticate(state),
        record = findProjectHeader(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
          [...trafficWriterRoles],
        );
      const existing = state.trafficConfigHeaders.find(
        (c) =>
          c.userId === identity.user.id &&
          c.projectId === projectId &&
          c.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        if (existing.submissionHash !== submissionHash)
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This save key belongs to different traffic inputs.",
          );
        return { existing, identity, record, previous: null };
      }
      trafficScenario(record, input);
      const previous = latestTrafficConfiguration(
        state,
        projectId,
        input.scenarioId,
      );
      if ((previous?.id ?? null) !== input.expectedConfigurationId)
        throw new ApiError(
          409,
          "TRAFFIC_CONFIGURATION_CHANGED",
          "A collaborator saved a newer traffic configuration. Reopen it before saving these edits.",
        );
      if (state.trafficConfigHeaders.length >= 1000)
        throw new ApiError(
          429,
          "TRAFFIC_CONFIGURATION_LIMIT",
          "This project's retained traffic configuration history needs operator archival.",
        );
      return { existing: undefined, identity, record, previous };
    };
    const captured = await this.store.read((state) => {
      const checked = inspect(state);
      return {
        ...checked,
        record: findProject(
          state,
          checked.identity.organization.id,
          projectId,
          checked.identity.user.id,
          [...trafficWriterRoles],
        ),
        uploads: state.trafficUploads,
      };
    }, scope);
    if (captured.existing)
      return this.configurationById(
        projectId,
        captured.existing.id,
        authenticate,
        sessionHash,
      );
    const previous = captured.previous
      ? await this.configurationById(
          projectId,
          captured.previous.id,
          authenticate,
          sessionHash,
        )
      : null;
    const catalog = this.configured(),
      preparedId = input.preparedId ?? previous?.prepared.id,
      prepared = await catalog.forPlace(captured.record.baseline, preparedId),
      original = await catalog.initialRequest(
        captured.record.baseline,
        projectId,
        prepared.identity.id,
      ),
      now = new Date().toISOString();
    const commutePresets =
      (await catalog.commutePresets?.(
        captured.record.baseline,
        prepared.identity.id,
        true,
      )) ?? [];
    const reviewed = await reviewTrafficSubmission(input, {
      organizationId: captured.identity.organization.id,
      projectId,
      userId: captured.identity.user.id,
      now,
      network: prepared.network.network,
      place: captured.record.baseline,
      scenario: trafficScenario(captured.record, input),
      original,
      previous,
      uploads: captured.uploads,
      archive: this.archive,
      commutePresets,
    });
    const scenario = trafficScenario(captured.record, input),
      binding = {
        baselineHash: (await baselineIdentity(captured.record.baseline)).sha256,
        roadEditsHash: await trafficRoadEditsHash(
          captured.record.baseline,
          scenario,
        ),
      },
      requestHash = await trafficContentHash(reviewed.request);
    const admitted = await this.store.transaction(
      (state) => {
        const checked = inspect(state);
        if (checked.existing) return checked.existing;
        const configuration: TrafficConfigurationRecord = {
          id: randomUUID(),
          projectId,
          organizationId: checked.identity.organization.id,
          scenarioId: input.scenarioId,
          userId: checked.identity.user.id,
          createdAt: now,
          projectVersion: input.expectedVersion,
          scenarioRevision: input.expectedRevision,
          ...binding,
          prepared: prepared.identity,
          request: reviewed.request,
          requestHash,
          uploadIds: reviewed.uploadBindings.map((b) => b.uploadId),
          uploadBindings: reviewed.uploadBindings,
          idempotencyKey: input.idempotencyKey,
          submissionHash,
          scopeAcknowledged: true,
        };
        state.trafficConfigs.push(configuration);
        addAudit(state, {
          organizationId: configuration.organizationId,
          projectId,
          actorId: checked.identity.user.id,
          action: "traffic.configured",
          details: {
            configurationId: configuration.id,
            scenarioId: input.scenarioId,
            requestHash,
          },
        });
        return configuration;
      },
      {
        ...trafficCallerScope(projectId, sessionHash),
        security: { mode: "worker", purpose: "traffic" },
        trafficConfigHeaders: { where: [{ projectId }] },
        trafficConfigs: { append: true },
      },
    );
    return this.configurationById(
      projectId,
      admitted.id,
      authenticate,
      sessionHash,
    );
  }
}
