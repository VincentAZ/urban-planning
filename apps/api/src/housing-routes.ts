import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  applyCommand,
  baselineIdentity,
  housingAffordabilityScenarioSchema,
  housingAffordabilityReviewInputHash,
  installHousingIncomeLimitPack,
  projectWithHousingVersion,
  type Command,
} from "@urban/core";
import {
  addAudit,
  findProject,
  type DataState,
  type Store,
  type authorize,
} from "./store";
import { requestScope } from "./store-scope";
import { projectAccess } from "./project-access";
import { ApiError } from "./errors";
import { HousingCatalog, housingCatalogQuery } from "./housing-catalog";
import {
  housingGroups,
  projectHousingHashes,
  validateHousingAuthority,
  validateHousingProject,
} from "./housing-validation";
import type { HousingAdoptResponse } from "./housing-types";
const identifier = z.string().min(1).max(160),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export function registerHousingRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    catalog: HousingCatalog;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
  },
) {
  const { store, catalog, auth } = options;
  app.get("/api/v1/housing/catalog", async (request) =>
    catalog.list(housingCatalogQuery.parse(request.query)),
  );
  app.get("/api/v1/housing/packs/:hash", async (request, reply) => {
    const input = z.object({ hash }).parse(request.params),
      entry = await catalog.get(input.hash);
    reply.header("X-Dataset-SHA256", entry.id);
    return { packHash: entry.id, pack: entry.pack };
  });
  app.post(
    "/api/v1/projects/:projectId/housing/adopt",
    async (request): Promise<HousingAdoptResponse> => {
      const { projectId } = z
        .object({ projectId: identifier })
        .parse(request.params);
      const input = z
        .object({
          scenarioId: identifier,
          expectedVersion: z.number().int().positive(),
          expectedRevision: z.number().int().nonnegative(),
          affordability: housingAffordabilityScenarioSchema,
        })
        .strict()
        .parse(request.body);
      const hashes = [
        ...new Set(
          housingGroups(input.affordability)
            .filter((g) => g.areaOrigin === "server-catalog")
            .map((g) => g.areaHash),
        ),
      ];
      const scope = requestScope(request, {
        projects: {
          where: [
            { id: projectId, organizationId: { auth: "organizationId" } },
          ],
        },
        housingSources: hashes.length
          ? { where: [{ id: hashes }] }
          : { append: true },
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
      const scenario = previous.project.scenarios.find(
        (s) => s.id === input.scenarioId,
      );
      if (!scenario || scenario.id === "baseline")
        throw new ApiError(
          400,
          "BASELINE_IMMUTABLE",
          "Select an editable housing scenario.",
        );
      if (
        housingAffordabilityReviewInputHash(
          previous.baseline,
          scenario,
          input.affordability,
        ) !== input.affordability.review.inputHash
      )
        throw new ApiError(
          409,
          "HOUSING_REVIEW_STALE",
          "Building, unit or cost inputs changed. Review geographic applicability and costs again.",
        );
      let prepared = structuredClone(previous.project);
      const retainedTrusted = new Set(projectHousingHashes(previous.project));
      for (const key of hashes)
        if (!retainedTrusted.has(key))
          prepared = installHousingIncomeLimitPack(
            prepared,
            (await catalog.get(key)).pack,
          );
      validateHousingProject({
        ...prepared,
        scenarios: prepared.scenarios.map((s) =>
          s.id === scenario.id
            ? { ...s, affordability: input.affordability }
            : s,
        ),
      });
      const saved = await store.transaction((state) => {
        const identity = auth(state, request),
          record = findProject(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            ["owner", "editor"],
          ),
          before = record.project.scenarios.find(
            (s) => s.id === input.scenarioId,
          );
        if (
          !before ||
          record.version !== input.expectedVersion ||
          record.version !== previous.version ||
          before.revision !== input.expectedRevision
        )
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "The saved scenario changed. Refresh before applying housing affordability evidence.",
          );
        const now = new Date().toISOString(),
          command: Command = {
            type: "scenario.affordability",
            affordability: {
              ...structuredClone(input.affordability),
              review: {
                ...input.affordability.review,
                reviewedBy: identity.user.name,
                reviewedAt: now,
              },
            },
          },
          after = applyCommand(before, command);
        const next = projectWithHousingVersion(
          {
            ...prepared,
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
                at: now,
                actor: identity.user.name,
                label: "Review housing affordability",
                command,
                before: structuredClone(before),
                after: structuredClone(after),
              }),
            undone: record.project.undone.filter(
              (e) => e.after.id !== before.id,
            ),
            updatedAt: now,
          },
          record.baseline,
        );
        validateHousingAuthority(next, state.housingSources, record.project);
        record.project = next;
        record.version++;
        addAudit(state, {
          organizationId: record.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "scenario.affordability",
          details: {
            scenarioId: before.id,
            revision: after.revision,
            packHashes: hashes,
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
