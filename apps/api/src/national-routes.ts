import { requestScope } from "./store-scope.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DataState, Store, authorize } from "./store.js";
import { ApiError } from "./errors.js";
import type { PlaceSearchResponse } from "../../../packages/core/src/national.js";
import {
  NationalPreparationService,
  preparationCapabilities,
  publicPreparation,
  type WritableCatalog,
  type PreparationCapacityDeclaration,
} from "./national-preparation.js";

export function registerNationalRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    catalog: WritableCatalog;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
    enabled: boolean;
    service?: NationalPreparationService;
    capacity?: PreparationCapacityDeclaration;
  },
) {
  const { store, catalog, auth } = options;
  const service =
    options.service ??
    new NationalPreparationService(
      store,
      catalog,
      undefined,
      options.enabled,
      undefined,
      undefined,
      options.capacity,
    );
  const enabled =
    options.enabled && Boolean(catalog.put) && service.capacityConfigured;
  app.addHook("onReady", async () => service.start());
  app.addHook("preClose", async () => service.close());
  const annotate = async (response: PlaceSearchResponse) => {
    const available = new Set((await catalog.list()).map((p) => p.id));
    return {
      ...response,
      candidates: response.candidates.map((c) => ({
        ...c,
        prepared: Boolean(c.placeId && available.has(c.placeId)),
      })),
    };
  };
  const limit = {
    rateLimit: {
      max: 20,
      timeWindow: "1 minute",
      keyGenerator: () => "national-search-all-visitors",
    },
  };
  app.get("/api/v1/places/preparation-capabilities", async () =>
    preparationCapabilities(enabled),
  );
  app.get("/api/v1/places/search", { config: limit }, async (request) => {
    const { q } = z
      .object({ q: z.string().trim().min(2).max(240) })
      .parse(request.query);
    return annotate(await service.census.search(q));
  });
  app.get("/api/v1/places/locate", { config: limit }, async (request) => {
    const { lon, lat } = z
      .object({
        lon: z.coerce.number().finite().min(-180).max(180),
        lat: z.coerce.number().finite().min(-90).max(90),
      })
      .parse(request.query);
    return annotate(await service.census.locate([lon, lat]));
  });
  app.get("/api/v1/places/preparations", async (request) =>
    store.read(
      (state) => {
        const identity = auth(state, request);
        return {
          jobs: state.preparationJobs
            .filter((j) => j.userId === identity.user.id)
            .slice(-30)
            .reverse()
            .map(publicPreparation),
        };
      },
      requestScope(request, {
        preparationJobs: { where: [{ userId: { auth: "userId" } }] },
      }),
    ),
  );
  app.get("/api/v1/places/preparations/:id", async (request) =>
    store.read(
      (state) => {
        const identity = auth(state, request);
        const { id } = request.params as { id: string };
        const job = state.preparationJobs.find(
          (j) => j.id === id && j.userId === identity.user.id,
        );
        if (!job)
          throw new ApiError(404, "NOT_FOUND", "Preparation not found.");
        return { job: publicPreparation(job) };
      },
      requestScope(request, {
        preparationJobs: { where: [{ userId: { auth: "userId" } }] },
      }),
    ),
  );
  const key = z.string().trim().min(8).max(160);
  app.post(
    "/api/v1/places/preparations",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const identity = await store.read(
        (state) => auth(state, request),
        requestScope(request),
      );
      const { zip, idempotencyKey } = z
        .object({ zip: z.string().regex(/^\d{5}$/), idempotencyKey: key })
        .strict()
        .parse(request.body);
      const job = await service.enqueue(
        zip,
        idempotencyKey,
        identity.user.id,
        identity.organization.id,
        identity.session.hash,
      );
      return reply.code(job.status === "completed" ? 200 : 202).send({ job });
    },
  );
  app.post("/api/v1/places/preparations/:id/cancel", async (request) => {
    const identity = await store.read(
      (state) => auth(state, request),
      requestScope(request),
    );
    return {
      job: await service.cancel(
        (request.params as { id: string }).id,
        identity.user.id,
        identity.session.hash,
      ),
    };
  });
  app.post("/api/v1/places/preparations/:id/retry", async (request, reply) => {
    const identity = await store.read(
      (state) => auth(state, request),
      requestScope(request),
    );
    const { idempotencyKey } = z
      .object({ idempotencyKey: key })
      .strict()
      .parse(request.body);
    const job = await service.retry(
      (request.params as { id: string }).id,
      idempotencyKey,
      identity.user.id,
      identity.session.hash,
    );
    return reply.code(202).send({ job });
  });
  return service;
}
