import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  applyCommand,
  baselineIdentity,
  floodStudyAreaHash,
  projectWithFloodVersion,
  canonicalJSON,
  FLOOD_METHOD_VERSION,
  type Command,
} from "@urban/core";
import {
  addAudit,
  findProject,
  type Store,
  type DataState,
  type authorize,
} from "./store";
import { requestScope } from "./store-scope";
import { projectAccess } from "./project-access";
import { ApiError } from "./errors";
import { FloodCatalog } from "./flood-catalog";
import {
  validateFloodAuthority,
  validateFloodProject,
} from "./flood-validation";
import type { FloodAdoptResponse } from "./flood-types";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export function registerFloodRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    catalog: FloodCatalog;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
  },
) {
  const { store, catalog, auth } = options;
  app.get("/api/v1/flood/catalog", async (request) => {
    const q = z.object({ studyAreaHash: sha }).strict().parse(request.query);
    return { datasets: await catalog.list(q.studyAreaHash) };
  });
  app.get("/api/v1/flood/datasets/:hash", async (request, reply) => {
    const { hash } = z.object({ hash: sha }).parse(request.params);
    const entry = await catalog.get(hash);
    reply.header("X-Dataset-SHA256", entry.datasetHash);
    return { datasetHash: entry.datasetHash, dataset: entry.dataset };
  });
  app.post(
    "/api/v1/projects/:projectId/flood/adopt",
    async (request): Promise<FloodAdoptResponse> => {
      const { projectId } = z
        .object({ projectId: z.string().min(1).max(160) })
        .parse(request.params);
      const input = z
        .object({
          scenarioId: z.string().min(1).max(160),
          expectedVersion: z.number().int().positive(),
          expectedRevision: z.number().int().nonnegative(),
          datasetHash: sha,
        })
        .strict()
        .parse(request.body);
      const scope = requestScope(request, {
        projects: {
          where: [
            { id: projectId, organizationId: { auth: "organizationId" } },
          ],
        },
        floodSources: { where: [{ id: input.datasetHash }] },
        audit: { append: true },
      });
      const previous = await store.read((state) => {
        const identity = auth(state, request);
        return findProject(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
          ["owner", "editor"],
        );
      }, scope);
      const entry = await catalog.get(input.datasetHash);
      if ((await floodStudyAreaHash(previous.baseline)) !== entry.studyAreaHash)
        throw new ApiError(
          422,
          "FLOOD_STUDY_AREA_MISMATCH",
          "This flood dataset belongs to a different captured study boundary.",
        );
      const installed = projectWithFloodVersion(
        {
          ...previous.project,
          floodDatasets: {
            ...previous.project.floodDatasets,
            [entry.datasetHash]: structuredClone(entry.dataset),
          },
        },
        previous.baseline,
      );
      await validateFloodProject(installed, previous.baseline);
      const saved = await store.transaction((state) => {
        const identity = auth(state, request),
          record = findProject(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            ["owner", "editor"],
          );
        const before = record.project.scenarios.find(
          (s) => s.id === input.scenarioId,
        );
        if (!before || input.scenarioId === "baseline")
          throw new ApiError(
            400,
            "BASELINE_IMMUTABLE",
            "Select an editable scenario.",
          );
        if (
          record.version !== input.expectedVersion ||
          record.version !== previous.version ||
          before.revision !== input.expectedRevision
        )
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "The saved scenario changed. Refresh before adopting flood evidence.",
          );
        const command: Command = {
            type: "scenario.flood",
            flood: {
              version: 1,
              datasetHash: input.datasetHash,
              origin: "server-catalog",
              methodVersion: FLOOD_METHOD_VERSION,
            },
          },
          after = applyCommand(before, command);
        const next = {
          ...installed,
          scenarios: record.project.scenarios.map((s) =>
            s.id === before.id ? after : s,
          ),
          history: record.project.history
            .map((e) =>
              record.project.undone.some(
                (u) => u.id === e.id && u.after.id === before.id,
              )
                ? { ...e, superseded: true }
                : e,
            )
            .concat({
              id: randomUUID(),
              at: new Date().toISOString(),
              actor: identity.user.name,
              label: "Adopt FEMA flood evidence",
              command,
              before: structuredClone(before),
              after: structuredClone(after),
            }),
          undone: record.project.undone.filter((e) => e.after.id !== before.id),
          updatedAt: new Date().toISOString(),
        };
        validateFloodAuthority(
          next,
          record.baseline,
          state.floodSources,
          record.project,
        );
        record.project = projectWithFloodVersion(next, record.baseline);
        record.version++;
        addAudit(state, {
          organizationId: record.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "scenario.flood",
          details: {
            scenarioId: before.id,
            datasetHash: input.datasetHash,
            methodVersion: FLOOD_METHOD_VERSION,
            revision: after.revision,
          },
        });
        return {
          project: record.project,
          baseline: record.baseline,
          version: record.version,
          organizationId: record.organizationId,
          access: projectAccess(record, identity.user.id, identity.membership)!,
        };
      }, scope);
      return {
        ...saved,
        baselineIdentity: await baselineIdentity(saved.baseline),
      };
    },
  );
}
