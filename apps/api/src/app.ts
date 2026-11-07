import { HousingCatalog } from "./housing-catalog";
import { registerHousingRoutes } from "./housing-routes";
import {
  projectHousingHashes,
  housingGroups,
  validateHousingProject,
  validateHousingAuthority,
  validateConfiguredHousing,
  selectedHousingPacks,
  assertHousingExport,
} from "./housing-validation";
import { registerFiscalRoutes } from "./fiscal-routes.js";
import {
  assertFiscalPrivateUse,
  assertFiscalExport,
  validateFiscalRightsTransition,
} from "./fiscal-rights.js";
import { MediaJobService } from "./media-jobs.js";
import { registerMediaRoutes } from "./media-routes.js";
import {
  calculateFloodImpactInWorker,
  exportFloodInWorker,
} from "./flood-normalization-worker";
import { assertFloodDocumentLimit } from "./report-flood";
import { FloodCatalog } from "./flood-catalog";
import { registerFloodRoutes } from "./flood-routes";
import {
  projectFloodHashes,
  validateFloodAuthority,
  selectedFloodDataset,
  validateConfiguredFlood,
  validateFloodProject,
  assertFloodExport,
} from "./flood-validation";
import {
  projectWithFloodVersion as beforeHousingVersion,
  projectWithHousingVersion,
} from "@urban/core";
const projectWithFloodVersion = (project: Project, place?: Place) =>
  projectWithHousingVersion(beforeHousingVersion(project, place), place);
import { baselineIdentity } from "@urban/core";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requestScope } from "./store-scope.js";
import type { IdentityMailRuntime } from "./identity-types.js";
import { credentialVersion, unavailableMail } from "./identity-service.js";
import { registerIdentityRoutes } from "./identity-routes.js";
import { z, ZodError } from "zod";
import {
  applyCommand,
  projectWithTrafficVersion,
  canonicalJSON,
  type Command,
  type Project,
  type Place,
  type Scenario,
} from "@urban/core";
import {
  calculateImpact,
  createProject,
  createScenario,
  matchingActivityVehicles,
} from "@urban/models";
import {
  FileStore,
  addAudit,
  authorize,
  findProject,
  type Store,
  type Role,
  type DataState,
  type SessionRecord,
} from "./store.js";
import { PostgresStore } from "./postgres-store.js";
import { ApiError, notFound } from "./errors.js";
import {
  hashPassword,
  verifyPassword,
  newToken,
  safeEqual,
  tokenHash,
} from "./security.js";
import { PlaceCatalog } from "./places.js";
import {
  commandSchema,
  identifier,
  loginSchema,
  projectSchema,
  registerSchema,
  scenarioSchema,
} from "./validation.js";
import {
  exportCsv,
  exportRetailCsv,
  exportWorkforceCsv,
  exportAccessibilityCsv,
  exportFloodCsv,
  exportFiscalCsv,
  exportHousingCsv,
  exportTrafficCsv,
  exportDocx,
  exportGeoJson,
  exportPdf,
  exportRecords,
  exportXlsx,
  type ReportSnapshot,
} from "./exports.js";
import {
  previewGeoJson,
  validateImportExtent,
  validateParcelImportExtent,
} from "./imports.js";
import { openApiDocument } from "./openapi.js";
import { renderReportMapPair } from "./report-maps.js";
import {
  registerEngagementRoutes,
  engagementConfigSchema,
  initialEngagement,
  engagementEnabled,
  publicationEngagement,
  engagementSummary,
} from "./engagement.js";
import {
  validateScenarioExtent,
  validateParcelCommandForApi,
  validateBuildingCommandForApi,
  validateRetailCommandForApi,
  validateProjectExtents,
} from "./geography.js";
import { platformAdminIds, registerBudgetRoutes } from "./budget-routes.js";
import { registerNationalRoutes } from "./national-routes.js";
import {
  projectAccess,
  initialProjectAcl,
  findProjectHeader,
} from "./project-access.js";
import {
  registerProjectCollaboration,
  membersResponse,
} from "./project-collaboration.js";
import type {
  NationalPreparationService,
  PreparationCapacityDeclaration,
} from "./national-preparation.js";
import {
  readPlaceVehicleReference,
  VehicleReferenceError,
} from "./data/acs-vehicles.js";
import {
  projectVehicleReferences,
  validateVehicleReferences,
} from "./activity-references.js";

import { assertRetailDocumentLimit } from "./report-retail.js";
import {
  scenarioForPublication,
  validateSourceRightsTransition,
} from "./retail-publication.js";
import { assertAccessibilityDocumentLimit } from "./report-accessibility.js";
import { AccessibilityJobService } from "./accessibility-jobs.js";
import { NativeAccessibilityExecutor } from "./accessibility-executor.js";
import { registerAccessibilityRoutes } from "./accessibility-routes.js";
import {
  validateAccessibilityContext,
  validateProjectAccessibilityContexts,
  accessibilityReferences,
  projectAccessibilityReferences,
  commandAccessibilityReferences,
  validateAccessibilityReferences,
  verifyAccessibilityReferenceIntegrity,
} from "./accessibility-validation.js";
import { assertWorkforceDocumentLimit } from "./report-workforce.js";
import { assertTrafficDocumentLimit } from "./report-traffic.js";
import { TrafficJobService } from "./traffic/jobs.js";
import { TrafficCatalog } from "./traffic/catalog.js";
import { TrafficRuntime } from "./traffic/runtime.js";
import { registerTrafficRoutes } from "./traffic/routes.js";
import { WorkforceJobService } from "./workforce-jobs.js";
import { NativeWorkforceExecutor } from "./workforce-executor.js";
import { registerWorkforceRoutes } from "./workforce-routes.js";
import { GisJobService, stagedGisPreview } from "./gis-jobs.js";
import { GisRuntime } from "./gis-runtime.js";
import { registerGisRoutes } from "./gis-routes.js";
import {
  projectWorkforceReferences,
  commandWorkforceReferences,
  validateWorkforceReferences,
  verifyWorkforceReferenceIntegrity,
} from "./workforce-validation.js";
import {
  projectTrafficReferences,
  commandTrafficReferences,
  validateTrafficReferences,
  verifyTrafficReferenceIntegrity,
  validateTrafficRightsTransition,
} from "./traffic/references.js";

const PREFIX = "/api/v1";
const COOKIE = "urban_session";
const WRITE_ROLES: Role[] = ["owner", "editor"];
const COMMENT_ROLES: Role[] = ["owner", "editor", "commenter"];
export interface AppOptions {
  mediaService?: MediaJobService;
  mediaServiceFactory?: (store: Store) => MediaJobService;
  floodCatalog?: FloodCatalog;
  housingCatalog?: HousingCatalog;
  identityMail?: IdentityMailRuntime;
  identityMailFactory?: (
    store: Store,
  ) => IdentityMailRuntime & { start?(): void; close?(): Promise<void> };
  store?: Store;
  catalog?: {
    list(): Promise<Place[]>;
    get(id: string): Promise<Place>;
    getSnapshot?(id: string, hash: string): Promise<Place>;
    put?(
      place: Place,
      source: unknown,
    ): Promise<import("@urban/core").BaselineIdentity>;
  };
  logger?: boolean;
  origin?: string;
  production?: boolean;
  platformAdminUserIds?: string[];
  nationalPreparationEnabled?: boolean;
  nationalCapacity?: PreparationCapacityDeclaration;
  nationalService?: NationalPreparationService;
  vehicleCachePath?: string;
  workforceService?: WorkforceJobService;
  accessibilityService?: AccessibilityJobService;
  gisService?: GisJobService;
  trafficService?: TrafficJobService;
}
export async function buildApp(options: AppOptions = {}) {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const origin =
    options.origin ?? process.env.APP_ORIGIN ?? "http://localhost:5173";
  if (production && !origin.startsWith("https://"))
    throw new Error("Production requires an HTTPS APP_ORIGIN.");
  const adminIds = options.platformAdminUserIds
    ? new Set(options.platformAdminUserIds)
    : platformAdminIds();
  let store = options.store;
  if (!store) {
    if (process.env.DATABASE_URL) {
      if (!process.env.DATABASE_AUTH_URL || !process.env.DATABASE_WORKER_URL)
        throw new Error(
          "PostgreSQL runtime requires separate DATABASE_AUTH_URL and DATABASE_WORKER_URL credentials.",
        );
      const postgres = new PostgresStore(process.env.DATABASE_URL, {
        mode: "runtime",
        authConnectionString: process.env.DATABASE_AUTH_URL,
        workerConnectionString: process.env.DATABASE_WORKER_URL,
      });
      try {
        await postgres.initialize([...adminIds]);
      } catch (error) {
        await postgres.close();
        throw error;
      }
      store = postgres;
    } else {
      if (production)
        throw new Error(
          "Production requires DATABASE_URL; local-file storage is development only.",
        );
      store = new FileStore(
        resolve(process.env.LOCAL_STATE_PATH ?? ".local/api-state.json"),
      );
    }
  }
  const repository = store;
  const identityMail =
    options.identityMail ??
    options.identityMailFactory?.(repository) ??
    unavailableMail;
  const catalog = options.catalog ?? new PlaceCatalog();
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024 * 1024,
    requestTimeout: 30000,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { files: 1, fields: 1, parts: 2, fileSize: 20 * 1024 ** 2 },
  });
  const allowedOrigins = [
    origin,
    ...(!production ? ["http://localhost:5173", "http://127.0.0.1:5173"] : []),
  ];
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });
  app.addHook("onReady", async () => {
    if ("start" in identityMail && typeof identityMail.start === "function")
      identityMail.start();
  });
  app.addHook("onClose", async () => {
    if ("close" in identityMail && typeof identityMail.close === "function")
      await identityMail.close();
    await repository.close();
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Cache-Control", "no-store");
    if (production)
      reply.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers.origin &&
      !allowedOrigins.includes(request.headers.origin)
    )
      throw new ApiError(
        403,
        "ORIGIN_REJECTED",
        "This request came from an untrusted origin.",
      );
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Check the submitted values.",
          details: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
    if (error instanceof ApiError) {
      if (
        error.code === "REPORT_MAP_BUSY" ||
        error.code === "REPORT_MAP_QUEUE_TIMEOUT"
      )
        reply.header("Retry-After", "10");
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
    const httpError = error as { statusCode?: number; message?: string };
    const statusCode =
      typeof httpError.statusCode === "number" &&
      httpError.statusCode >= 400 &&
      httpError.statusCode < 500
        ? httpError.statusCode
        : 500;
    if (statusCode >= 500) {
      const sensitiveIdentity =
        /^\/api\/v1\/(?:auth(?:\/|$)|invitations(?:\/|$)|(?:projects\/[^/]+|organization)\/invitations(?:\/|$))/.test(
          request.url.split("?")[0],
        );
      if (sensitiveIdentity)
        request.log.error(
          { code: "IDENTITY_OPERATION_FAILED" },
          "An identity operation failed.",
        );
      else request.log.error(error);
    }
    return reply.code(statusCode).send({
      error: {
        code:
          statusCode === 429
            ? "RATE_LIMITED"
            : statusCode === 500
              ? "INTERNAL_ERROR"
              : "REQUEST_ERROR",
        message:
          statusCode === 500
            ? "The request could not be completed. Your saved work is unchanged."
            : (httpError.message ?? "Invalid request."),
      },
    });
  });
  const sessionHash = (request: FastifyRequest) =>
    request.cookies[COOKIE] ? tokenHash(request.cookies[COOKIE]) : undefined;
  const auth = (state: DataState, request: FastifyRequest, roles?: Role[]) => {
    const identity = authorize(state, sessionHash(request), roles);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !safeEqual(
        String(request.headers["x-csrf-token"] ?? ""),
        identity.session.csrfToken,
      )
    )
      throw new ApiError(
        403,
        "CSRF_REQUIRED",
        "Refresh your session before submitting this change.",
      );
    return identity;
  };
  const preflightProjectWrite = (request: FastifyRequest) =>
    repository.read(
      (state) => {
        const identity = auth(state, request);
        findProjectHeader(
          state,
          identity.organization.id,
          (request.params as { id: string }).id,
          identity.user.id,
          WRITE_ROLES,
        );
      },
      requestScope(request, {
        projectHeaders: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
  const publicIdentity = (identity: ReturnType<typeof authorize>) => ({
    user: {
      id: identity.user.id,
      email: identity.user.email,
      name: identity.user.name,
      emailVerified: !!identity.user.emailVerifiedAt,
      ...(identity.user.emailVerifiedAt
        ? { emailVerifiedAt: identity.user.emailVerifiedAt }
        : {}),
    },
    organization: identity.organization,
    role: identity.membership.role,
    membershipScope: identity.membership.scope ?? "workspace",
    csrfToken: identity.session.csrfToken,
    platformAdmin: adminIds.has(identity.user.id),
  });
  const newSession = (userId: string, organizationId: string, version = 0) => {
    const token = newToken();
    const session: SessionRecord = {
      hash: tokenHash(token),
      csrfToken: newToken(),
      userId,
      organizationId,
      credentialVersion: version,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    return { token, session };
  };
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: production,
    maxAge: 7 * 86400,
  };
  registerIdentityRoutes(app, {
    store: repository,
    auth,
    origin,
    mail: identityMail,
  });
  registerBudgetRoutes(app, { store: repository, auth, adminIds });
  const mediaService =
    options.mediaService ??
    options.mediaServiceFactory?.(repository) ??
    new MediaJobService(repository, {
      enabled: false,
      archiveDirectory: resolve(".local/media/private-archive"),
    });
  registerMediaRoutes(app, { store: repository, service: mediaService, auth });
  const floodCatalog =
    options.floodCatalog ?? new FloodCatalog(process.env.FLOOD_CATALOG);
  registerFloodRoutes(app, { store: repository, catalog: floodCatalog, auth });
  const housingCatalog =
    options.housingCatalog ?? new HousingCatalog(process.env.HOUSING_CATALOG);
  registerHousingRoutes(app, {
    store: repository,
    catalog: housingCatalog,
    auth,
  });
  registerProjectCollaboration(app, { store: repository, auth });
  registerEngagementRoutes(app, { store: repository, auth });
  registerNationalRoutes(app, {
    store: repository,
    catalog,
    auth,
    service: options.nationalService,
    capacity:
      options.nationalCapacity ??
      (process.env.NATIONAL_CAPACITY_STATEMENT &&
      (process.env.NATIONAL_CAPACITY_ENVIRONMENT === "deployment" ||
        (!production &&
          process.env.NATIONAL_CAPACITY_ENVIRONMENT === "local-development"))
        ? {
            mode: "fixed-capacity",
            environment: process.env.NATIONAL_CAPACITY_ENVIRONMENT,
            statement: process.env.NATIONAL_CAPACITY_STATEMENT,
          }
        : undefined),
    enabled:
      options.nationalPreparationEnabled ??
      (process.env.NATIONAL_PUBLIC_PREPARATION_ENABLED === "true" ||
        (!production &&
          process.env.NATIONAL_PUBLIC_PREPARATION_ENABLED !== "false")),
  });

  const workforceCapacityEnvironment =
    process.env.WORKFORCE_CAPACITY_ENVIRONMENT;
  const workforceService =
    options.workforceService ??
    new WorkforceJobService(repository, {
      enabled: process.env.WORKFORCE_ENABLED === "true",
      executor:
        process.env.WORKFORCE_PACK_PATH &&
        process.env.WORKFORCE_BOUNDARY_PATH &&
        process.env.WORKFORCE_MANIFEST_PATH
          ? new NativeWorkforceExecutor({
              packPath: process.env.WORKFORCE_PACK_PATH,
              boundaryPath: process.env.WORKFORCE_BOUNDARY_PATH,
              manifestPath: process.env.WORKFORCE_MANIFEST_PATH,
              baseUrl:
                process.env.WORKFORCE_ROUTER_URL ?? "http://127.0.0.1:8002",
            })
          : undefined,
      archiveDirectory:
        process.env.WORKFORCE_ARCHIVE_DIR ??
        resolve(".local/workforce/private-runs"),
      capacity:
        (workforceCapacityEnvironment === "local-development" ||
          workforceCapacityEnvironment === "deployment") &&
        process.env.WORKFORCE_CAPACITY_STATEMENT
          ? {
              mode: "fixed-capacity",
              environment: workforceCapacityEnvironment,
              statement: process.env.WORKFORCE_CAPACITY_STATEMENT,
            }
          : undefined,
    });
  registerWorkforceRoutes(app, {
    store: repository,
    auth,
    service: workforceService,
  });
  const accessibilityCapacityEnvironment =
    process.env.ACCESSIBILITY_CAPACITY_ENVIRONMENT;
  const accessibilityService =
    options.accessibilityService ??
    new AccessibilityJobService(repository, {
      enabled: process.env.ACCESSIBILITY_ENABLED === "true",
      executor:
        process.env.ACCESSIBILITY_PACK_PATH &&
        process.env.ACCESSIBILITY_BOUNDARY_PATH &&
        process.env.ACCESSIBILITY_MANIFEST_PATH
          ? new NativeAccessibilityExecutor({
              packPath: process.env.ACCESSIBILITY_PACK_PATH,
              boundaryPath: process.env.ACCESSIBILITY_BOUNDARY_PATH,
              manifestPath: process.env.ACCESSIBILITY_MANIFEST_PATH,
              baseUrl:
                process.env.ACCESSIBILITY_ROUTER_URL ?? "http://127.0.0.1:8002",
            })
          : undefined,
      archiveDirectory:
        process.env.ACCESSIBILITY_ARCHIVE_DIR ??
        resolve(".local/accessibility/private-runs"),
      capacity:
        (accessibilityCapacityEnvironment === "local-development" ||
          accessibilityCapacityEnvironment === "deployment") &&
        process.env.ACCESSIBILITY_CAPACITY_STATEMENT
          ? {
              mode: "fixed-capacity",
              environment: accessibilityCapacityEnvironment,
              statement: process.env.ACCESSIBILITY_CAPACITY_STATEMENT,
            }
          : undefined,
    });
  registerAccessibilityRoutes(app, {
    store: repository,
    auth,
    service: accessibilityService,
  });
  const trafficEnvironment = process.env.TRAFFIC_CAPACITY_ENVIRONMENT;
  const trafficRegistry = process.env.TRAFFIC_NETWORK_REGISTRY;
  const trafficService =
    options.trafficService ??
    new TrafficJobService(repository, {
      enabled: process.env.TRAFFIC_ENABLED === "true",
      catalog: trafficRegistry
        ? new TrafficCatalog(resolve(trafficRegistry))
        : undefined,
      runtime:
        process.env.TRAFFIC_ENABLED === "true" && trafficRegistry
          ? new TrafficRuntime({
              workRoot: resolve(
                process.env.TRAFFIC_WORK_DIR ?? ".local/traffic/work",
              ),
              allowedInputRoot: resolve(trafficRegistry, ".."),
            })
          : undefined,
      archiveDirectory: resolve(
        process.env.TRAFFIC_ARCHIVE_DIR ?? ".local/traffic/private-runs",
      ),
      capacity:
        (trafficEnvironment === "local-development" ||
          trafficEnvironment === "deployment") &&
        process.env.TRAFFIC_CAPACITY_STATEMENT
          ? {
              mode: "fixed-capacity",
              environment: trafficEnvironment,
              statement: process.env.TRAFFIC_CAPACITY_STATEMENT,
            }
          : undefined,
    });
  registerTrafficRoutes(app, {
    store: repository,
    auth,
    service: trafficService,
  });
  const gisArchiveDirectory = resolve(
    process.env.GIS_ARCHIVE_DIR ?? ".local/gis/private-artifacts",
  );
  const gisEnvironment = process.env.GIS_CAPACITY_ENVIRONMENT;
  const gisService =
    options.gisService ??
    new GisJobService(repository, {
      enabled: process.env.GIS_ENABLED === "true",
      archiveDirectory: gisArchiveDirectory,
      runtime:
        process.env.GIS_ENABLED === "true"
          ? new GisRuntime({
              workRoot: resolve(process.env.GIS_WORK_DIR ?? ".local/gis/work"),
              allowedInputRoot: gisArchiveDirectory,
            })
          : undefined,
      capacity:
        (gisEnvironment === "local-development" ||
          gisEnvironment === "deployment") &&
        process.env.GIS_CAPACITY_STATEMENT
          ? {
              mode: "fixed-capacity",
              environment: gisEnvironment,
              statement: process.env.GIS_CAPACITY_STATEMENT,
            }
          : undefined,
    });
  registerFiscalRoutes(app, { store: repository, auth });
  registerGisRoutes(app, { store: repository, auth, service: gisService });

  app.get(`${PREFIX}/health`, async () => ({
    status: "ok",
    service: "urban-planning-api",
    storage: repository.kind,
    auth: "local-password",
    ssoConfigured: false,
    free: true,
  }));
  app.get(`${PREFIX}/openapi.json`, async () => openApiDocument);
  app.get(`${PREFIX}/capabilities`, async () => ({
    free: true,
    storage: { adapter: repository.kind, nationalScaleReady: false },
    authentication: {
      password: true,
      emailVerification: false,
      passwordRecovery: false,
      saml: false,
      oidc: false,
    },
    exports: {
      csv: true,
      geojson: true,
      pdf: true,
      docx: true,
      xlsx: true,
      shapefile: Boolean(
        gisService.options.enabled &&
          gisService.options.runtime &&
          gisService.options.capacity,
      ),
      video: false,
    },
    imports: {
      geojson: {
        preview: true,
        commit: true,
        geometryTypes: ["Polygon", "MultiPolygon"],
        maxFeatures: 5000,
        maxVertices: 50000,
      },
      shapefile: Boolean(
        gisService.options.enabled &&
          gisService.options.runtime &&
          gisService.options.capacity,
      ),
      dxf: Boolean(
        gisService.options.enabled &&
          gisService.options.runtime &&
          gisService.options.capacity,
      ),
      processing: {
        kind: "durable-private-jobs",
        capabilitiesPath: "/api/v1/projects/{projectId}/imports/capabilities",
        requiresAccount: true,
        requiresSavedProject: true,
      },
      trafficCounts: false,
    },
    processing: {
      livePlanningEstimates: true,
      highFidelityTraffic: false,
      regionalRouting: Boolean(
        workforceService.options.enabled && workforceService.options.executor,
      ),
      durableWorkerQueue: Boolean(
        workforceService.options.enabled &&
          workforceService.options.executor &&
          workforceService.options.capacity,
      ),
    },
    data: {
      preparedPlaces: (await catalog.list()).map((p) => ({
        id: p.id,
        name: p.name,
        extent: p.extentLabel,
      })),
      nationalCoverage: false,
      premiumAdapters: [],
    },
    ai: { available: false, reason: "No production AI adapter is configured." },
    collaboration: {
      roles: true,
      comments: true,
      projectScopedRoles: true,
      revisionBoundThreads: true,
      immutablePublicSnapshots: true,
      publicFeedback: true,
      realtimeCoediting: false,
    },
  }));
  app.get(`${PREFIX}/places`, async (request) => {
    const { q } = z
      .object({ q: z.string().max(200).optional() })
      .parse(request.query);
    const places = await catalog.list();
    const query = q?.toLowerCase();
    return {
      places: places
        .filter(
          (p) =>
            !query ||
            `${p.name} ${p.city} ${p.state} ${p.zip}`
              .toLowerCase()
              .includes(query),
        )
        .map(({ buildings, roads, ...place }) => ({
          ...place,
          buildingCount: buildings.length,
          roadCount: roads.length,
        })),
      coverage:
        "Prepared reference areas. National preprocessing is not complete.",
    };
  });
  app.get(`${PREFIX}/places/:id`, async (request) =>
    catalog.get(identifier.parse((request.params as { id: string }).id)),
  );
  const resolveBaseline = async (placeId: string, hash: string) => {
    if (catalog.getSnapshot) return catalog.getSnapshot(placeId, hash);
    const place = await catalog.get(placeId);
    if ((await baselineIdentity(place)).sha256 !== hash)
      throw new ApiError(
        409,
        "BASELINE_UNAVAILABLE",
        "The exact baseline snapshot is unavailable. Your project was not saved against newer data.",
      );
    return place;
  };
  app.get(`${PREFIX}/places/:id/snapshots/:hash`, async (request) => {
    const { id, hash } = z
      .object({ id: identifier, hash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.params);
    const place = await resolveBaseline(id, hash);
    return { place, baselineIdentity: await baselineIdentity(place) };
  });

  app.post(
    `${PREFIX}/auth/register`,
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const passwordHash = await hashPassword(input.password);
      const userId = randomUUID(),
        organizationId = randomUUID(),
        createdAt = new Date().toISOString();
      const { token, session } = newSession(userId, organizationId);
      const identity = await repository.transaction(
        (state) => {
          if (state.users.some((u) => u.email === input.email))
            throw new ApiError(
              409,
              "ACCOUNT_EXISTS",
              "An account with that email already exists. Sign in instead.",
            );
          state.users.push({
            id: userId,
            email: input.email,
            name: input.name,
            passwordHash,
            credentialVersion: 0,
            createdAt,
          });
          state.organizations.push({
            id: organizationId,
            name: `${input.name}’s workspace`,
            createdAt,
          });
          state.memberships.push({ userId, organizationId, role: "owner" });
          state.sessions.push(session);
          addAudit(state, {
            organizationId,
            actorId: userId,
            action: "account.created",
            details: {},
          });
          return publicIdentity(authorize(state, session.hash));
        },
        {
          security: {
            mode: "auth",
            purpose: "register",
            email: input.email,
            userId,
            organizationId,
            sessionHash: session.hash,
          },
          users: { where: [{ email: input.email }] },
          organizations: { append: true },
          memberships: { append: true },
          sessions: { append: true },
          audit: { append: true },
        },
      );
      reply.setCookie(COOKIE, token, cookieOptions);
      return reply.code(201).send(identity);
    },
  );
  app.post(
    `${PREFIX}/auth/login`,
    { config: { rateLimit: { max: 15, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const user = await repository.read(
        (state) => state.users.find((u) => u.email === input.email),
        {
          security: { mode: "auth", purpose: "lookup", email: input.email },
          users: { where: [{ email: input.email }] },
        },
      );
      // Perform a password KDF even for an unknown email to avoid a trivial timing oracle.
      const dummy =
        "scrypt:00000000000000000000000000000000:" + "0".repeat(128);
      if (
        !(await verifyPassword(input.password, user?.passwordHash ?? dummy)) ||
        !user?.passwordHash
      )
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect.",
        );
      const token = newToken();
      const identity = await repository.transaction(
        (state) => {
          const current = state.users.find((u) => u.id === user.id);
          if (
            !current ||
            credentialVersion(current) !== credentialVersion(user)
          )
            throw new ApiError(
              401,
              "INVALID_CREDENTIALS",
              "Your credentials changed. Sign in again.",
            );
          const member = state.memberships.find((m) => m.userId === user.id);
          if (!member)
            throw new ApiError(
              403,
              "NO_WORKSPACE",
              "This account has no workspace.",
            );
          const session = {
            ...newSession(
              user.id,
              member.organizationId,
              credentialVersion(current),
            ).session,
            hash: tokenHash(token),
          };
          state.sessions.push(session);
          return publicIdentity(authorize(state, session.hash));
        },
        {
          security: {
            mode: "auth",
            purpose: "login",
            credentialVersion: credentialVersion(user),
            email: user.email,
            userId: user.id,
            sessionHash: tokenHash(token),
          },
          auth: { userId: user.id },
          sessions: { append: true },
        },
      );
      reply.setCookie(COOKIE, token, cookieOptions);
      return identity;
    },
  );
  app.get(`${PREFIX}/auth/session`, async (request) =>
    repository.read((state) => {
      try {
        return publicIdentity(authorize(state, sessionHash(request)));
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401)
          return { user: null };
        throw error;
      }
    }, requestScope(request)),
  );
  app.post(`${PREFIX}/auth/logout`, async (request, reply) => {
    await repository.transaction((state) => {
      const identity = auth(state, request);
      state.sessions = state.sessions.filter(
        (s) => s.hash !== identity.session.hash,
      );
    }, requestScope(request));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });
  app.get(`${PREFIX}/organizations`, async (request) =>
    repository.read((state) => {
      const identity = auth(state, request);
      return {
        organizations: state.memberships
          .filter((m) => m.userId === identity.user.id)
          .map((m) => ({
            ...state.organizations.find((o) => o.id === m.organizationId),
            role: m.role,
            membershipScope: m.scope ?? "workspace",
          })),
      };
    }, requestScope(request)),
  );
  app.post(`${PREFIX}/auth/organization`, async (request) => {
    const { organizationId } = z
      .object({ organizationId: identifier })
      .parse(request.body);
    return repository.transaction((state) => {
      const identity = auth(state, request);
      if (
        !state.memberships.some(
          (m) =>
            m.userId === identity.user.id &&
            m.organizationId === organizationId,
        )
      )
        throw notFound();
      identity.session.organizationId = organizationId;
      return publicIdentity(authorize(state, identity.session.hash));
    }, requestScope(request));
  });
  app.get(`${PREFIX}/organization/members`, async (request) =>
    repository.read(
      (state) => {
        const identity = auth(state, request, [
          "owner",
          "editor",
          "commenter",
          "viewer",
        ]);
        return {
          members: state.memberships
            .filter((m) => m.organizationId === identity.organization.id)
            .map((m) => ({
              userId: m.userId,
              role: m.role,
              membershipScope: m.scope ?? "workspace",
              name: state.users.find((u) => u.id === m.userId)?.name,
              email: state.users.find((u) => u.id === m.userId)?.email,
            })),
        };
      },
      requestScope(request, {
        memberships: {
          where: [{ organizationId: { auth: "organizationId" } }],
        },
        users: { where: [{ id: { from: "memberships", field: "userId" } }] },
      }),
    ),
  );
  app.post(`${PREFIX}/organization/members`, async (request) => {
    const input = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        role: z.enum(["editor", "commenter", "viewer"]),
      })
      .parse(request.body);
    return repository.transaction(
      (state) => {
        const identity = auth(state, request, ["owner"]);
        const user = state.users.find((u) => u.email === input.email);
        if (!user)
          throw new ApiError(
            409,
            "INVITATION_REQUIRED",
            "New workspace access requires a verified recipient to accept an invitation.",
          );
        const existing = state.memberships.find(
          (m) =>
            m.userId === user.id &&
            m.organizationId === identity.organization.id,
        );
        if (!existing || existing.scope === "project-only")
          throw new ApiError(
            409,
            "INVITATION_REQUIRED",
            "New workspace access requires a verified recipient to accept an invitation.",
          );
        if (existing?.role === "owner")
          throw new ApiError(
            400,
            "OWNER_ROLE",
            "The workspace owner role cannot be changed here.",
          );
        if (existing) {
          existing.role = input.role;
          existing.scope = "workspace";
        } else
          state.memberships.push({
            userId: user.id,
            organizationId: identity.organization.id,
            role: input.role,
          });
        addAudit(state, {
          organizationId: identity.organization.id,
          actorId: identity.user.id,
          action: "membership.updated",
          details: { userId: user.id, role: input.role },
        });
        return { ok: true };
      },
      requestScope(request, {
        memberLookupEmail: input.email,
        users: { where: [{ email: input.email }] },
        memberships: {
          where: [
            {
              organizationId: { auth: "organizationId" },
              userId: { from: "users", field: "id" },
            },
          ],
        },
        audit: { append: true },
      }),
    );
  });

  app.get(`${PREFIX}/projects`, async (request) =>
    repository.read(
      (state) => {
        const identity = auth(state, request);
        return {
          projects: state.projectHeaders
            .filter(
              (p) =>
                p.organizationId === identity.organization.id &&
                projectAccess(p, identity.user.id, identity.membership),
            )
            .map((record) => ({
              project: {
                id: record.project.id,
                name: record.project.name,
                placeId: record.project.placeId,
                updatedAt: record.project.updatedAt,
                scenarioCount: record.project.scenarios.length,
              },
              version: record.version,
              organizationId: record.organizationId,
              access: projectAccess(
                record,
                identity.user.id,
                identity.membership,
              )!,
            })),
        };
      },
      requestScope(request, {
        projectHeaders: {
          where: [{ organizationId: { auth: "organizationId" } }],
        },
      }),
    ),
  );
  app.post(`${PREFIX}/projects`, async (request, reply) => {
    // Authentication is checked before fetching baseline data or processing a large snapshot.
    await repository.read(
      (state) => auth(state, request, WRITE_ROLES),
      requestScope(request),
    );
    const isDraft = Boolean(
      request.body &&
        typeof request.body === "object" &&
        "project" in request.body,
    );
    if (isDraft && !(request.body as { baselineHash?: string }).baselineHash)
      throw new ApiError(
        400,
        "BASELINE_REQUIRED",
        "Saving an existing draft requires its captured baseline hash. Reopen or restore a complete project before saving.",
      );
    const input = isDraft
      ? z
          .object({
            project: projectSchema,
            baselineHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(request.body)
      : z
          .object({
            placeId: identifier,
            name: z.string().trim().min(1).max(240).optional(),
          })
          .parse(request.body);
    // A new blank project may intentionally use today's source; an existing draft must identify its captured source.
    const place =
      "project" in input
        ? await resolveBaseline(input.project.placeId, input.baselineHash)
        : await catalog.get(input.placeId);
    const snapshotIdentity = await baselineIdentity(place);
    const project: Project = projectWithFloodVersion(
      "project" in input ? input.project : createProject(place),
      place,
    );
    if (project.fiscalStudy)
      assertFiscalPrivateUse(project.fiscalStudy.profile);
    // Cloud identities are allocated by the server. Restored drafts must never reconnect retained records from a deleted project.
    project.id = randomUUID();
    await verifyTrafficReferenceIntegrity(
      projectTrafficReferences(project),
      place,
      snapshotIdentity.sha256,
    );
    validateTrafficReferences(
      projectTrafficReferences(project),
      project.id,
      [],
    );
    await verifyWorkforceReferenceIntegrity(
      projectWorkforceReferences(project),
      place,
      snapshotIdentity.sha256,
    );
    await verifyAccessibilityReferenceIntegrity(
      projectAccessibilityReferences(project),
      place,
      snapshotIdentity.sha256,
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
    validateProjectExtents(project, place);
    await validateFloodProject(project, place);
    await validateConfiguredFlood(project, floodCatalog);
    validateHousingProject(project);
    await validateConfiguredHousing(project, housingCatalog);
    await validateVehicleReferences(
      projectVehicleReferences(project),
      place,
      [],
      options.vehicleCachePath,
    );
    if ("name" in input && input.name) project.name = input.name;
    const record = await repository.transaction(
      (state) => {
        const identity = auth(state, request, WRITE_ROLES);
        validateFloodAuthority(project, place, state.floodSources);
        validateHousingAuthority(project, state.housingSources);
        const saved = {
          project,
          organizationId: identity.organization.id,
          version: 1,
          baseline: place,
          createdBy: identity.user.id,
          createdAt: new Date().toISOString(),
          acl: initialProjectAcl(identity.user.id, new Date().toISOString()),
        };
        state.projects.push(saved);
        addAudit(state, {
          organizationId: identity.organization.id,
          projectId: project.id,
          actorId: identity.user.id,
          action: "project.created",
          details: {
            version: 1,
            placeId: place.id,
            baselineHash: snapshotIdentity.sha256,
          },
        });
        return {
          project: saved.project,
          version: saved.version,
          baselineIdentity: snapshotIdentity,
          organizationId: saved.organizationId,
          access: projectAccess(saved, identity.user.id, identity.membership)!,
        };
      },
      requestScope(request, {
        housingSources: projectHousingHashes(project).length
          ? { where: [{ id: projectHousingHashes(project) }] }
          : { append: true },
        floodSources: projectFloodHashes(project).length
          ? { where: [{ id: projectFloodHashes(project) }] }
          : { append: true },
        projects: { append: true },
        audit: { append: true },
      }),
    );
    return reply.code(201).send(record);
  });
  app.get(`${PREFIX}/projects/:id`, async (request) => {
    const { record, access } = await repository.read(
      (state) => {
        const identity = auth(state, request);
        const record = findProject(
          state,
          identity.organization.id,
          (request.params as { id: string }).id,
          identity.user.id,
        );
        return {
          record,
          access: projectAccess(record, identity.user.id, identity.membership)!,
        };
      },
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
    return {
      project: record.project,
      version: record.version,
      baseline: record.baseline,
      baselineIdentity: await baselineIdentity(record.baseline),
      organizationId: record.organizationId,
      access,
    };
  });
  app.get(`${PREFIX}/projects/:id/vehicle-reference`, async (request) => {
    const record = await repository.read(
      (state) => {
        const identity = auth(state, request);
        return findProject(
          state,
          identity.organization.id,
          (request.params as { id: string }).id,
          identity.user.id,
        );
      },
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
    const metadata = {
      projectId: record.project.id,
      organizationId: record.organizationId,
      projectVersion: record.version,
      baselineHash: (await baselineIdentity(record.baseline)).sha256,
    };
    try {
      const reference =
        record.baseline.vehicleAvailability ??
        (await readPlaceVehicleReference(
          record.baseline,
          options.vehicleCachePath,
        ));
      const usable = Boolean(
        matchingActivityVehicles(record.baseline, reference),
      );
      return {
        ...metadata,
        status: usable ? "available" : "unavailable",
        reference,
        ...(usable
          ? {}
          : {
              reason:
                "This captured source has no usable whole-study-area vehicle estimate; missing or suppressed values are not zero.",
            }),
      };
    } catch (error) {
      if (!(error instanceof VehicleReferenceError)) throw error;
      return {
        ...metadata,
        status: "unavailable",
        reference: null,
        reason: error.message,
      };
    }
  });
  app.put(`${PREFIX}/projects/:id`, async (request) => {
    await preflightProjectWrite(request);
    const input = z
      .object({
        project: projectSchema,
        expectedVersion: z.number().int().min(1),
        baselineHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(request.body);
    const frozenRecord = await repository.read(
      (state) => {
        const identity = auth(state, request);
        return findProject(
          state,
          identity.organization.id,
          (request.params as { id: string }).id,
          identity.user.id,
          WRITE_ROLES,
        );
      },
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
    const frozen = frozenRecord.baseline;
    const baseline = await baselineIdentity(frozen);
    if (input.baselineHash && input.baselineHash !== baseline.sha256)
      throw new ApiError(
        409,
        "BASELINE_MISMATCH",
        "This draft uses a different baseline from the saved project. Reopen the saved project or save this as a new project.",
      );
    // The captured baseline cannot change. Validate expensive current/undo geometry
    // after authorization, before acquiring the write lock; the transaction rechecks access/version.
    await verifyWorkforceReferenceIntegrity(
      projectWorkforceReferences(input.project),
      frozen,
      baseline.sha256,
    );
    await verifyAccessibilityReferenceIntegrity(
      projectAccessibilityReferences(input.project),
      frozen,
      baseline.sha256,
    );
    await verifyTrafficReferenceIntegrity(
      projectTrafficReferences(input.project),
      frozen,
      baseline.sha256,
    );
    validateProjectExtents(input.project, frozen);
    await validateFloodProject(input.project, frozen);
    validateHousingProject(input.project);
    await validateConfiguredHousing(
      input.project,
      housingCatalog,
      frozenRecord.project,
    );
    await validateConfiguredFlood(
      input.project,
      floodCatalog,
      frozenRecord.project,
    );
    await validateVehicleReferences(
      projectVehicleReferences(input.project),
      frozen,
      projectVehicleReferences(frozenRecord.project),
      options.vehicleCachePath,
    );
    return repository.transaction(
      (state) => {
        const identity = auth(state, request);
        const record = findProject(
          state,
          identity.organization.id,
          (request.params as { id: string }).id,
          identity.user.id,
          WRITE_ROLES,
        );
        if (record.version !== input.expectedVersion)
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "This project changed in another session. Refresh before saving.",
            { currentVersion: record.version },
          );
        if (
          input.project.id !== record.project.id ||
          input.project.placeId !== record.project.placeId
        )
          throw new ApiError(
            400,
            "PROJECT_IDENTITY",
            "Project identity and baseline place cannot be replaced.",
          );
        if (input.project.schemaVersion < record.project.schemaVersion)
          throw new ApiError(
            409,
            "PROJECT_VERSION_DOWNGRADE",
            "This project contains newer authoring records. Reopen it with a compatible version before saving; older project formats cannot replace these records.",
          );
        const oldBaseline = record.project.scenarios.find(
          (s) => s.id === "baseline",
        );
        const newBaseline = input.project.scenarios.find(
          (s) => s.id === "baseline",
        );
        if (!isDeepStrictEqual(oldBaseline, newBaseline))
          throw new ApiError(
            400,
            "BASELINE_IMMUTABLE",
            "The real-world baseline is immutable. Make changes in a scenario.",
          );
        for (const scenario of input.project.scenarios) {
          const previous = record.project.scenarios.find(
            (s) => s.id === scenario.id,
          );
          if (
            !previous &&
            state.comments.some(
              (comment) =>
                comment.organizationId === record.organizationId &&
                comment.projectId === record.project.id &&
                comment.scenarioId === scenario.id,
            )
          )
            throw new ApiError(
              409,
              "SCENARIO_ID_REUSED",
              "This deleted scenario has saved review history. Create a new scenario identifier instead of reusing it.",
            );
          if (previous && scenario.revision < previous.revision)
            throw new ApiError(
              409,
              "SCENARIO_REVISION_CONFLICT",
              "Scenario revisions cannot move backwards. Undo must create a new revision.",
            );
          if (
            previous &&
            scenario.revision === previous.revision &&
            !isDeepStrictEqual(previous, scenario)
          )
            throw new ApiError(
              409,
              "SCENARIO_REVISION_CONFLICT",
              "Changed scenario content must advance its revision so saved reviews remain correctly bound.",
            );
        }
        validateFloodAuthority(
          input.project,
          record.baseline,
          state.floodSources,
          record.project,
        );
        validateHousingAuthority(
          input.project,
          state.housingSources,
          record.project,
        );
        validateFiscalRightsTransition(record.project, input.project);
        validateSourceRightsTransition(
          record.project,
          input.project,
          record.baseline,
        );
        validateWorkforceReferences(
          projectWorkforceReferences(input.project),
          record.project.id,
          state.workforceArtifactHeaders,
        );
        validateAccessibilityReferences(
          projectAccessibilityReferences(input.project),
          record.project.id,
          state.accessibilityArtifactHeaders,
        );
        validateProjectAccessibilityContexts(
          input.project,
          state.accessibilityArtifactHeaders,
          state.accessibilityJobs,
        );
        // Native traffic authority is admitted only by the dedicated completed-run service.
        validateTrafficRightsTransition(record.project, input.project);
        validateTrafficReferences(
          projectTrafficReferences(input.project),
          record.project.id,
          state.trafficArtifactHeaders,
        );
        record.project = projectWithFloodVersion(
          input.project,
          record.baseline,
        );
        record.project.updatedAt = new Date().toISOString();
        record.version++;
        addAudit(state, {
          organizationId: identity.organization.id,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "project.saved",
          details: {
            version: record.version,
            scenarioRevisions: record.project.scenarios.map((s) => ({
              id: s.id,
              revision: s.revision,
            })),
          },
        });
        return {
          project: record.project,
          version: record.version,
          baselineIdentity: baseline,
          organizationId: record.organizationId,
          access: projectAccess(record, identity.user.id, identity.membership)!,
        };
      },
      requestScope(request, {
        housingSources: projectHousingHashes(input.project).length
          ? { where: [{ id: projectHousingHashes(input.project) }] }
          : { append: true },
        floodSources: projectFloodHashes(input.project).length
          ? { where: [{ id: projectFloodHashes(input.project) }] }
          : { append: true },
        workforceArtifactHeaders: {
          where: [{ projectId: (request.params as { id: string }).id }],
        },
        accessibilityArtifactHeaders: {
          where: [{ projectId: (request.params as { id: string }).id }],
        },
        accessibilityJobs: {
          where: [{ projectId: (request.params as { id: string }).id }],
        },
        trafficArtifactHeaders: {
          where: [{ projectId: (request.params as { id: string }).id }],
        },
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        comments: {
          where: [
            {
              projectId: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        audit: { append: true },
      }),
    );
  });
  app.delete(`${PREFIX}/projects/:id`, async (request) => {
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    return repository.transaction(
      (state) => {
        const identity = auth(state, request);
        const record = findProject(
          state,
          identity.organization.id,
          (request.params as { id: string }).id,
          identity.user.id,
          ["owner"],
        );
        if (record.version !== expectedVersion)
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Refresh the project before deleting it.",
          );
        state.projects = state.projects.filter((p) => p !== record);
        for (const snapshot of state.publishedHeaders.filter(
          (p) =>
            p.projectId === record.project.id &&
            p.organizationId === identity.organization.id,
        )) {
          if (snapshot.revokedAt) continue;
          snapshot.revokedAt = new Date().toISOString();
          const engagement = publicationEngagement(snapshot);
          engagement.collection = {
            status: "closed",
            version: engagement.collection.version + 1,
            updatedAt: snapshot.revokedAt,
          };
          snapshot.engagement = engagement;
        }
        addAudit(state, {
          organizationId: identity.organization.id,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "project.deleted",
          details: {},
        });
        return { ok: true };
      },
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        publishedHeaders: {
          where: [
            {
              projectId: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        audit: { append: true },
      }),
    );
  });
  app.post(`${PREFIX}/projects/:id/scenarios`, async (request) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(240),
        parentId: identifier,
        expectedVersion: z.number().int().min(1),
      })
      .parse(request.body);
    return repository.transaction(
      (state) => {
        const identity = auth(state, request);
        const record = findProject(
          state,
          identity.organization.id,
          (request.params as { id: string }).id,
          identity.user.id,
          WRITE_ROLES,
        );
        if (record.version !== input.expectedVersion)
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Refresh before creating a scenario.",
          );
        const parent = record.project.scenarios.find(
          (s) => s.id === input.parentId,
        );
        if (!parent) throw notFound();
        const scenario = createScenario(input.name, parent);
        record.project.scenarios.push(scenario);
        record.project.activeScenarioId = scenario.id;
        record.version++;
        record.project.updatedAt = new Date().toISOString();
        addAudit(state, {
          organizationId: identity.organization.id,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "scenario.created",
          details: { scenarioId: scenario.id, parentId: parent.id },
        });
        return {
          project: record.project,
          version: record.version,
          organizationId: record.organizationId,
          access: projectAccess(record, identity.user.id, identity.membership)!,
        };
      },
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        audit: { append: true },
      }),
    );
  });
  app.post(
    `${PREFIX}/projects/:id/scenarios/:scenarioId/commands`,
    async (request) => {
      await preflightProjectWrite(request);
      const input = z
        .object({
          command: commandSchema,
          expectedRevision: z.number().int().min(0),
          expectedVersion: z.number().int().min(1),
          label: z.string().max(500).optional(),
        })
        .parse(request.body);
      if (
        (input.command.type === "scenario.accessibility" &&
          input.command.evidence) ||
        (input.command.type === "scenario.workforce" &&
          input.command.workforce) ||
        (input.command.type === "scenario.traffic" && input.command.traffic) ||
        (input.command.type === "scenario.flood" && input.command.flood)
      ) {
        const captured = await repository.read(
          (state) => {
            const identity = auth(state, request);
            return findProject(
              state,
              identity.organization.id,
              (request.params as { id: string }).id,
              identity.user.id,
              WRITE_ROLES,
            );
          },
          requestScope(request, {
            projects: {
              where: [
                {
                  id: (request.params as { id: string }).id,
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
          }),
        );
        if (input.command.type === "scenario.flood" && input.command.flood) {
          const scenarioId = (request.params as { scenarioId: string })
            .scenarioId;
          const candidate = {
            ...captured.project,
            scenarios: captured.project.scenarios.map((s) =>
              s.id === scenarioId
                ? {
                    ...s,
                    flood:
                      input.command.type === "scenario.flood"
                        ? input.command.flood!
                        : undefined,
                  }
                : s,
            ),
          };
          await validateConfiguredFlood(
            candidate,
            floodCatalog,
            captured.project,
          );
        }
        const capturedHash = (await baselineIdentity(captured.baseline)).sha256;
        if (
          input.command.type === "scenario.workforce" &&
          input.command.workforce
        )
          await verifyWorkforceReferenceIntegrity(
            [input.command.workforce],
            captured.baseline,
            capturedHash,
          );
        if (
          input.command.type === "scenario.accessibility" &&
          input.command.evidence
        )
          await verifyAccessibilityReferenceIntegrity(
            commandAccessibilityReferences(input.command),
            captured.baseline,
            capturedHash,
          );
        if (input.command.type === "scenario.traffic" && input.command.traffic)
          await verifyTrafficReferenceIntegrity(
            [input.command.traffic],
            captured.baseline,
            capturedHash,
          );
      }
      if (
        input.command.type === "scenario.activity" &&
        input.command.activity?.vehicleReference
      ) {
        const captured = await repository.read(
          (state) => {
            const identity = auth(state, request);
            return findProject(
              state,
              identity.organization.id,
              (request.params as { id: string }).id,
              identity.user.id,
              WRITE_ROLES,
            );
          },
          requestScope(request, {
            projects: {
              where: [
                {
                  id: (request.params as { id: string }).id,
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
          }),
        );
        await validateVehicleReferences(
          [input.command.activity.vehicleReference],
          captured.baseline,
          projectVehicleReferences(captured.project),
          options.vehicleCachePath,
        );
      }
      return repository.transaction(
        (state) => {
          const identity = auth(state, request);
          const { id, scenarioId } = request.params as {
            id: string;
            scenarioId: string;
          };
          const record = findProject(
            state,
            identity.organization.id,
            id,
            identity.user.id,
            WRITE_ROLES,
          );
          if (scenarioId === "baseline")
            throw new ApiError(
              400,
              "BASELINE_IMMUTABLE",
              "Create a scenario before editing.",
            );
          const before = record.project.scenarios.find(
            (s) => s.id === scenarioId,
          );
          if (!before) throw notFound();
          if (
            record.version !== input.expectedVersion ||
            before.revision !== input.expectedRevision
          )
            throw new ApiError(
              409,
              "REVISION_CONFLICT",
              "This scenario changed. Refresh before applying the edit.",
            );
          validateWorkforceReferences(
            commandWorkforceReferences(input.command),
            record.project.id,
            state.workforceArtifactHeaders,
          );
          validateAccessibilityReferences(
            commandAccessibilityReferences(input.command),
            record.project.id,
            state.accessibilityArtifactHeaders,
          );
          validateAccessibilityContext(
            commandAccessibilityReferences(input.command),
            record.project.id,
            (request.params as { scenarioId: string }).scenarioId,
            state.accessibilityArtifactHeaders,
            state.accessibilityJobs,
          );
          validateTrafficReferences(
            commandTrafficReferences(input.command),
            record.project.id,
            state.trafficArtifactHeaders,
          );
          if (input.command.type === "buildings.import")
            validateImportExtent(input.command.buildings, record.baseline);
          validateParcelCommandForApi(record.baseline, before, input.command);
          validateBuildingCommandForApi(record.baseline, before, input.command);
          const after = scenarioSchema.parse(
            applyCommand(before, input.command),
          );
          if (input.command.type === "scenario.flood" && input.command.flood) {
            const hash = input.command.flood.datasetHash;
            if (!record.project.floodDatasets?.[hash])
              throw new ApiError(
                422,
                "FLOOD_DATASET_MISSING",
                "Install a prepared dataset before referencing it.",
              );
            const candidate = {
              ...record.project,
              scenarios: record.project.scenarios.map((s) =>
                s.id === after.id ? after : s,
              ),
            };
            validateFloodAuthority(
              candidate,
              record.baseline,
              state.floodSources,
              record.project,
            );
          }
          if (input.command.type === "scenario.affordability")
            validateHousingAuthority(
              {
                ...record.project,
                scenarios: record.project.scenarios.map((s) =>
                  s.id === after.id ? after : s,
                ),
              },
              state.housingSources,
              record.project,
            );
          validateScenarioExtent(after, record.baseline);
          validateRetailCommandForApi(
            record.baseline,
            before,
            after,
            input.command,
          );
          record.project.scenarios = record.project.scenarios.map((s) =>
            s.id === scenarioId ? after : s,
          );
          const supersededIds = new Set(
            record.project.undone
              .filter((entry) => entry.after.id === scenarioId)
              .map((entry) => entry.id),
          );
          record.project.history = record.project.history.map((entry) =>
            supersededIds.has(entry.id)
              ? { ...entry, superseded: true }
              : entry,
          );
          record.project.history.push({
            id: randomUUID(),
            at: new Date().toISOString(),
            actor: identity.user.name,
            label: input.label ?? input.command.type,
            command: input.command,
            before: structuredClone(before),
            after: structuredClone(after),
          });
          record.project.undone = record.project.undone.filter(
            (entry) => entry.after.id !== scenarioId,
          );
          record.project = projectWithFloodVersion(
            record.project,
            record.baseline,
          );
          record.version++;
          record.project.updatedAt = new Date().toISOString();
          addAudit(state, {
            organizationId: identity.organization.id,
            projectId: id,
            actorId: identity.user.id,
            action: input.command.type,
            details: {
              scenarioId,
              revision: after.revision,
              command: input.command,
            },
          });
          return {
            project: record.project,
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
          housingSources:
            input.command.type === "scenario.affordability" &&
            input.command.affordability &&
            housingGroups(input.command.affordability).some(
              (g) => g.areaOrigin === "server-catalog",
            )
              ? {
                  where: [
                    {
                      id: [
                        ...new Set(
                          housingGroups(input.command.affordability)
                            .filter((g) => g.areaOrigin === "server-catalog")
                            .map((g) => g.areaHash),
                        ),
                      ],
                    },
                  ],
                }
              : { append: true },
          floodSources:
            input.command.type === "scenario.flood" && input.command.flood
              ? { where: [{ id: input.command.flood.datasetHash }] }
              : { append: true },
          workforceArtifactHeaders: {
            where: [{ projectId: (request.params as { id: string }).id }],
          },
          accessibilityArtifactHeaders: {
            where: [{ projectId: (request.params as { id: string }).id }],
          },
          accessibilityJobs: {
            where: [{ projectId: (request.params as { id: string }).id }],
          },
          trafficArtifactHeaders: {
            where: [{ projectId: (request.params as { id: string }).id }],
          },
          projects: {
            where: [
              {
                id: (request.params as { id: string }).id,
                organizationId: { auth: "organizationId" },
              },
            ],
          },
          audit: { append: true },
        }),
      );
    },
  );

  const snapshotFromState = (
    state: DataState,
    request: FastifyRequest,
  ): Omit<ReportSnapshot, "results"> => {
    const params = request.params as { id: string; scenarioId?: string };
    const query = z
      .object({
        scenarioId: identifier.optional(),
        revision: z.coerce.number().int().min(0).optional(),
        version: z.coerce.number().int().positive().optional(),
        format: z.string().optional(),
      })
      .parse(request.query);
    const identity = auth(state, request);
    const record = findProject(
      state,
      identity.organization.id,
      params.id,
      identity.user.id,
    );
    if (query.version !== undefined && query.version !== record.version)
      throw new ApiError(
        409,
        "REVISION_CONFLICT",
        "The saved project version changed. Reopen it before exporting or reviewing its results.",
        { currentVersion: record.version },
      );
    const scenario = record.project.scenarios.find(
      (s) =>
        s.id ===
        (params.scenarioId ??
          query.scenarioId ??
          record.project.activeScenarioId),
    );
    if (!scenario) throw notFound();
    if (query.revision !== undefined && scenario.revision !== query.revision)
      throw new ApiError(
        409,
        "REVISION_CONFLICT",
        "The requested revision is no longer current. Refresh or use a published snapshot.",
      );
    return {
      project: record.project,
      place: record.baseline,
      scenario,
      generatedAt: new Date().toISOString(),
      projectVersion: record.version,
    };
  };
  const getRawSnapshot = (request: FastifyRequest) =>
    repository.read(
      (state) => snapshotFromState(state, request),
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
  const finishSnapshot = async (
    raw: Omit<ReportSnapshot, "results">,
  ): Promise<ReportSnapshot> => ({
    ...raw,
    results: raw.scenario.flood
      ? await calculateFloodImpactInWorker(
          raw.place,
          raw.scenario,
          raw.project.floodDatasets,
          raw.project.fiscalStudy,
          raw.project.housingIncomeLimits,
        )
      : calculateImpact(
          raw.place,
          raw.scenario,
          {},
          {
            floodDatasets: raw.project.floodDatasets,
            fiscalStudy: raw.project.fiscalStudy,
            housingIncomeLimits: raw.project.housingIncomeLimits,
          },
        ),
  });
  const getSnapshot = async (request: FastifyRequest) =>
    finishSnapshot(await getRawSnapshot(request));
  app.get(
    `${PREFIX}/projects/:id/metrics`,
    async (request) => (await getSnapshot(request)).results,
  );
  app.get(
    `${PREFIX}/projects/:id/exports`,
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { format } = z
        .object({
          format: z.enum([
            "csv",
            "retail-csv",
            "workforce-csv",
            "accessibility-csv",
            "flood-csv",
            "fiscal-csv",
            "housing-csv",
            "traffic-csv",
            "geojson",
            "docx",
            "pdf",
            "records",
            "xlsx",
          ]),
        })
        .parse(request.query);
      const exportBase = (snapshot: Pick<ReportSnapshot, "scenario">) =>
        `urban-planning-${snapshot.scenario.id.replace(/[^a-z0-9_-]/gi, "-")}-r${snapshot.scenario.revision}`;
      if (format === "records") {
        const records = await repository.read(
          (state) => {
            const snapshot = snapshotFromState(state, request);
            const identity = auth(state, request);
            const record = findProject(
              state,
              identity.organization.id,
              snapshot.project.id,
              identity.user.id,
            );
            const snapshotIds = new Set(
              state.publishedHeaders
                .filter(
                  (p) =>
                    p.projectId === snapshot.project.id &&
                    p.organizationId === identity.organization.id,
                )
                .map((p) => p.id),
            );
            return {
              snapshot,
              audit: state.audit.filter(
                (a) =>
                  a.projectId === snapshot.project.id &&
                  a.organizationId === identity.organization.id,
              ),
              comments: state.comments.filter(
                (c) =>
                  c.projectId === snapshot.project.id &&
                  c.organizationId === identity.organization.id,
              ),
              publicFeedback: state.publicFeedback.filter((f) =>
                snapshotIds.has(f.snapshotId),
              ),
              sharing: membersResponse(state, record, identity),
              engagement: state.publishedHeaders
                .filter((p) => snapshotIds.has(p.id))
                .map((p) => engagementSummary(state, p)),
            };
          },
          requestScope(request, {
            projects: {
              where: [
                {
                  id: (request.params as { id: string }).id,
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
            comments: {
              where: [
                {
                  projectId: (request.params as { id: string }).id,
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
            audit: {
              where: [
                {
                  projectId: (request.params as { id: string }).id,
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
            publishedHeaders: {
              where: [
                {
                  projectId: (request.params as { id: string }).id,
                  organizationId: { auth: "organizationId" },
                },
              ],
            },
            publicFeedback: {
              where: [
                { snapshotId: { from: "publishedHeaders", field: "id" } },
              ],
            },
            memberships: {
              where: [{ organizationId: { auth: "organizationId" } }],
            },
            users: {
              where: [{ id: { from: "memberships", field: "userId" } }],
            },
          }),
        );
        const snapshot = records.snapshot;
        assertFiscalExport(snapshot.project);
        assertHousingExport(snapshot.project);
        assertFloodExport(snapshot.project);
        if (snapshot.scenario.flood) {
          const result = await exportFloodInWorker(snapshot, "records", {
            audit: records.audit,
            comments: records.comments,
            publicFeedback: records.publicFeedback,
            sharing: records.sharing,
            engagement: records.engagement,
          });
          reply
            .header("X-Scenario-Revision", snapshot.scenario.revision)
            .header("X-Project-Version", snapshot.projectVersion!);
          return reply
            .header(
              "Content-Disposition",
              `attachment; filename="${exportBase(snapshot)}-records.${result.extension}"`,
            )
            .type(result.contentType)
            .send(
              result.body instanceof Uint8Array
                ? Buffer.from(result.body)
                : result.body,
            );
        }
        const calculated = await finishSnapshot(snapshot);
        const base = exportBase(snapshot);
        reply.header("X-Scenario-Revision", snapshot.scenario.revision);
        reply.header("X-Project-Version", snapshot.projectVersion!);
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${base}-records.json"`,
          )
          .send({
            ...exportRecords(
              calculated,
              records.audit,
              records.comments,
              records.publicFeedback,
              records.sharing,
            ),
            engagement: records.engagement,
          });
      }
      const rawSnapshot = await getRawSnapshot(request);
      assertFiscalExport(rawSnapshot.project);
      assertHousingExport(rawSnapshot.project, rawSnapshot.scenario);
      assertFloodExport(rawSnapshot.project, rawSnapshot.scenario);
      if (rawSnapshot.scenario.flood) {
        const result = await exportFloodInWorker(rawSnapshot, format);
        reply
          .header("X-Scenario-Revision", rawSnapshot.scenario.revision)
          .header("X-Project-Version", rawSnapshot.projectVersion!);
        for (const [key, value] of Object.entries(result.mapHeaders ?? {}))
          reply.header(key, value);
        const stem = `urban-planning-${rawSnapshot.scenario.id.replace(/[^a-z0-9_-]/gi, "-")}-r${rawSnapshot.scenario.revision}`;
        const suffix = format.endsWith("-csv") ? `-${format.slice(0, -4)}` : "";
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${stem}${suffix}.${result.extension}"`,
          )
          .type(result.contentType)
          .send(
            result.body instanceof Uint8Array
              ? Buffer.from(result.body)
              : result.body,
          );
      }
      const snapshot = await finishSnapshot(rawSnapshot);
      const base = exportBase(snapshot);
      reply.header("X-Project-Version", snapshot.projectVersion!);
      reply.header("X-Scenario-Revision", snapshot.scenario.revision);
      if (format === "pdf" || format === "docx") {
        assertRetailDocumentLimit(snapshot);
        assertWorkforceDocumentLimit(snapshot);
        assertAccessibilityDocumentLimit(snapshot);
        assertTrafficDocumentLimit(snapshot);
        assertFloodDocumentLimit(snapshot);
        const baselineScenario = snapshot.project.scenarios.find(
          (scenario) => scenario.id === "baseline",
        );
        if (!baselineScenario)
          throw new ApiError(
            422,
            "BASELINE_REQUIRED",
            "This project has no captured baseline scenario for a before-and-after report.",
          );
        snapshot.maps = await renderReportMapPair({
          place: snapshot.place,
          baselineScenario,
          proposalScenario: snapshot.scenario,
          ...(snapshot.scenario.flood
            ? {
                flood: {
                  datasetHash: snapshot.scenario.flood.datasetHash,
                  dataset: selectedFloodDataset(
                    snapshot.project,
                    snapshot.scenario,
                  )!,
                },
              }
            : {}),
        });
        reply.header(
          "X-Report-Renderer",
          snapshot.maps.metadata.rendererVersion,
        );
        reply.header("X-Report-Map-Input", snapshot.maps.metadata.inputHash);
        reply.header("X-Report-Baseline-Image", snapshot.maps.baseline.sha256);
        reply.header("X-Report-Proposal-Image", snapshot.maps.proposal.sha256);
      }
      if (format === "traffic-csv")
        return reply
          .type("text/csv; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="${base}-traffic.csv"`,
          )
          .send(exportTrafficCsv(snapshot));
      if (format === "fiscal-csv")
        return reply
          .type("text/csv; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="${base}-fiscal.csv"`,
          )
          .send(exportFiscalCsv(snapshot));
      if (format === "housing-csv")
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${base}-housing.csv"`,
          )
          .type("text/csv; charset=utf-8")
          .send(exportHousingCsv(snapshot));
      if (format === "flood-csv")
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${base}-flood.csv"`,
          )
          .type("text/csv; charset=utf-8")
          .send(exportFloodCsv(snapshot));
      if (format === "accessibility-csv")
        return reply
          .type("text/csv; charset=utf-8")
          .header(
            "Content-Disposition",
            'attachment; filename="accessibility-evidence.csv"',
          )
          .send(exportAccessibilityCsv(snapshot));
      if (format === "workforce-csv")
        return reply
          .type("text/csv; charset=utf-8")
          .header(
            "Content-Disposition",
            'attachment; filename="workforce-evidence.csv"',
          )
          .send(exportWorkforceCsv(snapshot));
      if (format === "retail-csv")
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${base}-retail.csv"`,
          )
          .type("text/csv; charset=utf-8")
          .send(exportRetailCsv(snapshot));
      if (format === "csv")
        return reply
          .header("Content-Disposition", `attachment; filename="${base}.csv"`)
          .type("text/csv; charset=utf-8")
          .send(exportCsv(snapshot));
      if (format === "geojson")
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${base}.geojson"`,
          )
          .type("application/geo+json")
          .send(exportGeoJson(snapshot));
      if (format === "docx")
        return reply
          .header("Content-Disposition", `attachment; filename="${base}.docx"`)
          .type(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          )
          .send(await exportDocx(snapshot));
      if (format === "pdf")
        return reply
          .header("Content-Disposition", `attachment; filename="${base}.pdf"`)
          .type("application/pdf")
          .send(await exportPdf(snapshot));
      if (format === "xlsx")
        return reply
          .header("Content-Disposition", `attachment; filename="${base}.xlsx"`)
          .type(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .send(await exportXlsx(snapshot));
    },
  );
  app.post(`${PREFIX}/imports/geojson/preview`, async (request) => {
    const { projectId, scenarioId, layer } = z
      .object({
        projectId: identifier.optional(),
        scenarioId: identifier.optional(),
        layer: z.enum(["buildings", "parcels", "blocks"]).default("buildings"),
      })
      .parse(request.body);
    if (layer !== "buildings" && !projectId)
      throw new ApiError(
        400,
        "IMPORT_PROJECT_REQUIRED",
        "Choose and save the target project before previewing parcel or block boundaries.",
      );
    await repository.read(
      (state) => {
        const identity = auth(state, request);
        if (projectId)
          findProjectHeader(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            WRITE_ROLES,
          );
        else auth(state, request, WRITE_ROLES);
      },
      requestScope(
        request,
        projectId
          ? {
              projectHeaders: {
                where: [
                  { id: projectId, organizationId: { auth: "organizationId" } },
                ],
              },
            }
          : {},
      ),
    );
    const preview = previewGeoJson(request.body);
    return repository.transaction(
      (state) => {
        const identity = auth(state, request);
        if (projectId) {
          const record = findProject(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            WRITE_ROLES,
          );
          if (preview.layer === "buildings")
            validateImportExtent(preview.buildings, record.baseline);
          else {
            validateParcelImportExtent(preview.parcels, record.baseline);
            const scenario = record.project.scenarios.find(
              (item) =>
                item.id === (scenarioId ?? record.project.activeScenarioId),
            );
            if (!scenario) throw notFound();
            if (scenario.id === "baseline")
              throw new ApiError(
                400,
                "BASELINE_IMMUTABLE",
                "Preview parcel and block imports in an editable alternative.",
              );
            validateParcelCommandForApi(record.baseline, scenario, {
              type: "parcels.import",
              parcels: preview.parcels,
              source: preview.source,
            });
          }
        } else auth(state, request, WRITE_ROLES);
        // The legacy upload action authorizes private project processing. Public
        // redistribution requires a separate explicit declaration in the request.
        const publicRedistribution = z
          .object({ publicRedistribution: z.boolean().default(false) })
          .parse(request.body).publicRedistribution;
        preview.source.rights = {
          version: 1,
          privateUse: true,
          cache: true,
          analyze: true,
          privateDisplay: true,
          export: true,
          historicalRetention: true,
          publicRedistribution,
          declaredBy: identity.user.id,
          declaredAt: new Date().toISOString(),
        };
        const staged = {
          id: randomUUID(),
          organizationId: identity.organization.id,
          projectId,
          createdBy: identity.user.id,
          source: preview.source,
          ...(preview.layer === "buildings"
            ? { layer: preview.layer, buildings: preview.buildings }
            : { layer: preview.layer, parcels: preview.parcels }),
          warnings: preview.warnings,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        };
        state.imports.push(staged);
        return {
          ...preview,
          importId: staged.id,
          expiresAt: staged.expiresAt,
          extentChecked: Boolean(projectId),
        };
      },
      requestScope(request, {
        ...(projectId
          ? {
              projects: {
                where: [
                  { id: projectId, organizationId: { auth: "organizationId" } },
                ],
              },
            }
          : {}),
        imports: { append: true },
      }),
    );
  });
  app.post(
    `${PREFIX}/projects/:id/imports/:importId/commit`,
    async (request) => {
      const input = z
        .object({
          scenarioId: identifier,
          expectedRevision: z.number().int().min(0),
          expectedVersion: z.number().int().min(1),
          acknowledgeWarnings: z.boolean().default(false),
          previewHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .parse(request.body);
      return repository.transaction(
        (state) => {
          const identity = auth(state, request);
          const { id, importId } = request.params as {
            id: string;
            importId: string;
          };
          const record = findProject(
            state,
            identity.organization.id,
            id,
            identity.user.id,
            WRITE_ROLES,
          );
          const staged = state.imports.find(
            (i) =>
              i.id === importId &&
              i.organizationId === identity.organization.id &&
              i.createdBy === identity.user.id,
          );
          if (!staged) throw notFound();
          if (staged.prepared) {
            const prepared = stagedGisPreview(staged);
            if (
              input.previewHash !== prepared.previewHash ||
              input.scenarioId !== prepared.scenarioId ||
              input.expectedVersion !== prepared.expectedVersion ||
              input.expectedRevision !== prepared.expectedRevision
            )
              throw new ApiError(
                409,
                "GIS_PREVIEW_MISMATCH",
                "Apply the exact reviewed preview to its original scenario and revision. Prepare a new preview if the project changed.",
              );
            if (
              createHash("sha256")
                .update(canonicalJSON(record.baseline))
                .digest("hex") !== prepared.baselineIdentity.sha256
            )
              throw new ApiError(
                409,
                "GIS_BASELINE_CHANGED",
                "The frozen baseline changed after preview. Prepare a new preview before applying.",
              );
          }
          if (staged.projectId && staged.projectId !== id)
            throw new ApiError(
              400,
              "IMPORT_PROJECT_MISMATCH",
              "This preview belongs to a different project. Preview the layer in this project first.",
            );
          if (staged.committed) {
            if (
              staged.committed.projectId === id &&
              staged.committed.scenarioId === input.scenarioId
            )
              return {
                project: record.project,
                version: record.version,
                importId,
                alreadyCommitted: true,
                organizationId: record.organizationId,
                access: projectAccess(
                  record,
                  identity.user.id,
                  identity.membership,
                )!,
              };
            throw new ApiError(
              409,
              "IMPORT_ALREADY_COMMITTED",
              "This import was already applied to another scenario. Create another preview to apply it again.",
            );
          }
          if (new Date(staged.expiresAt).getTime() < Date.now())
            throw new ApiError(
              410,
              "IMPORT_EXPIRED",
              "The import preview expired. Upload the file again.",
            );
          if (staged.warnings.length && !input.acknowledgeWarnings)
            throw new ApiError(
              422,
              "IMPORT_REVIEW_REQUIRED",
              "Review and acknowledge the import warnings before applying the layer.",
              { warnings: staged.warnings },
            );
          if (input.scenarioId === "baseline")
            throw new ApiError(
              400,
              "BASELINE_IMMUTABLE",
              "Import into an editable scenario.",
            );
          const before = record.project.scenarios.find(
            (s) => s.id === input.scenarioId,
          );
          if (!before) throw notFound();
          if (
            record.version !== input.expectedVersion ||
            before.revision !== input.expectedRevision
          )
            throw new ApiError(
              409,
              "REVISION_CONFLICT",
              "The scenario changed after preview. Refresh before applying the layer.",
            );
          const areaImport =
            staged.layer === "parcels" || staged.layer === "blocks";
          const command: Command =
            "parcels" in staged
              ? {
                  type: "parcels.import",
                  parcels: staged.parcels,
                  source: staged.source,
                  ...(staged.prepared ? { mode: staged.prepared.mode } : {}),
                }
              : {
                  type: "buildings.import",
                  buildings: staged.buildings,
                  source: staged.source,
                  ...(staged.prepared ? { mode: staged.prepared.mode } : {}),
                };
          if (command.type === "buildings.import")
            validateImportExtent(command.buildings, record.baseline);
          else if (command.type === "parcels.import")
            validateParcelImportExtent(command.parcels, record.baseline);
          validateParcelCommandForApi(record.baseline, before, command);
          validateBuildingCommandForApi(record.baseline, before, command);
          const after = scenarioSchema.parse(applyCommand(before, command));
          validateScenarioExtent(after, record.baseline);
          record.project.scenarios = record.project.scenarios.map((s) =>
            s.id === after.id ? after : s,
          );
          const undoneIds = new Set(
            record.project.undone
              .filter((history) => history.after.id === after.id)
              .map((h) => h.id),
          );
          for (const history of record.project.history)
            if (undoneIds.has(history.id)) history.superseded = true;
          record.project.undone = record.project.undone.filter(
            (history) => history.after.id !== after.id,
          );
          const featureCount =
            command.type === "buildings.import"
              ? command.buildings.length
              : command.type === "parcels.import"
                ? command.parcels.length
                : 0;
          record.project.history.push({
            id: randomUUID(),
            at: new Date().toISOString(),
            actor: identity.user.name,
            label: `Import ${featureCount} ${areaImport ? staged.layer : "footprints"} from ${staged.source.name}`,
            command,
            before: structuredClone(before),
            after: structuredClone(after),
          });
          record.project.activeScenarioId = after.id;
          record.project = projectWithFloodVersion(
            record.project,
            record.baseline,
          );
          record.project.updatedAt = new Date().toISOString();
          record.version++;
          staged.committed = {
            projectId: id,
            scenarioId: after.id,
            revision: after.revision,
            version: record.version,
            at: new Date().toISOString(),
          };
          addAudit(state, {
            organizationId: identity.organization.id,
            projectId: id,
            actorId: identity.user.id,
            action: command.type,
            details: {
              importId,
              source: staged.source,
              featureCount,
              scenarioId: after.id,
              revision: after.revision,
            },
          });
          return {
            project: record.project,
            version: record.version,
            importId,
            alreadyCommitted: false,
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
                id: (request.params as { id: string }).id,
                organizationId: { auth: "organizationId" },
              },
            ],
          },
          imports: {
            where: [
              {
                id: (request.params as { importId: string }).importId,
                organizationId: { auth: "organizationId" },
              },
            ],
          },
          audit: { append: true },
        }),
      );
    },
  );

  app.get(`${PREFIX}/projects/:id/audit`, async (request) =>
    repository.read(
      (state) => {
        const identity = auth(state, request);
        const { id } = request.params as { id: string };
        findProjectHeader(
          state,
          identity.organization.id,
          id,
          identity.user.id,
        );
        return {
          audit: state.audit.filter(
            (a) =>
              a.projectId === id &&
              a.organizationId === identity.organization.id,
          ),
        };
      },
      requestScope(request, {
        projectHeaders: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        audit: {
          where: [
            {
              projectId: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    ),
  );
  app.post(`${PREFIX}/projects/:id/publish`, async (request, reply) => {
    const input = z
      .object({
        scenarioId: identifier,
        expectedRevision: z.number().int().min(0),
        feedbackEnabled: z.boolean().default(false),
        engagement: engagementConfigSchema.optional(),
      })
      .parse(request.body);
    const capturedPublication = await repository.read(
      (state) => {
        const identity = auth(state, request),
          record = findProject(
            state,
            identity.organization.id,
            (request.params as { id: string }).id,
            identity.user.id,
            ["owner"],
          );
        const scenario = record.project.scenarios.find(
          (s) => s.id === input.scenarioId,
        );
        if (!scenario) throw notFound();
        if (scenario.revision !== input.expectedRevision)
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Refresh the scenario before publishing.",
          );
        scenarioForPublication(record.project, record.baseline, scenario);
        return {
          project: record.project,
          place: record.baseline,
          scenario,
          projectVersion: record.version,
          generatedAt: new Date().toISOString(),
        };
      },
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
      }),
    );
    const publicationResults = (await finishSnapshot(capturedPublication))
      .results;
    const published = await repository.transaction(
      (state) => {
        const identity = auth(state, request);
        const { id } = request.params as { id: string };
        const record = findProject(
          state,
          identity.organization.id,
          id,
          identity.user.id,
          ["owner"],
        );
        const scenario = record.project.scenarios.find(
          (s) => s.id === input.scenarioId,
        );
        if (!scenario) throw notFound();
        if (
          scenario.revision !== input.expectedRevision ||
          record.version !== capturedPublication.projectVersion
        )
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Refresh the scenario before publishing.",
          );
        validateAccessibilityContext(
          accessibilityReferences(scenario.accessibility),
          record.project.id,
          scenario.id,
          state.accessibilityArtifactHeaders,
          state.accessibilityJobs,
        );
        const snapshot = {
          id: newToken(),
          organizationId: identity.organization.id,
          projectId: id,
          projectName: record.project.name,
          placeId: record.project.placeId,
          baseline: structuredClone(record.baseline),
          scenario: scenarioForPublication(
            record.project,
            record.baseline,
            scenario,
          ),
          ...(selectedFloodDataset(record.project, scenario)
            ? {
                floodDataset: structuredClone(
                  selectedFloodDataset(record.project, scenario),
                ),
              }
            : {}),
          ...(scenario.affordability
            ? {
                housingIncomeLimits: structuredClone(
                  selectedHousingPacks(record.project, scenario),
                ),
              }
            : {}),
          ...(record.project.fiscalStudy
            ? { fiscalStudy: structuredClone(record.project.fiscalStudy) }
            : {}),
          results: publicationResults,
          createdAt: new Date().toISOString(),
          feedbackEnabled: input.engagement
            ? engagementEnabled(input.engagement)
            : input.feedbackEnabled,
          engagement: initialEngagement(
            input.engagement,
            input.feedbackEnabled,
            new Date().toISOString(),
          ),
          engagementRequiresVersion: Boolean(input.engagement),
        };
        state.published.push(snapshot);
        addAudit(state, {
          organizationId: identity.organization.id,
          projectId: id,
          actorId: identity.user.id,
          action: "snapshot.published",
          details: {
            snapshotId: snapshot.id,
            scenarioId: scenario.id,
            revision: scenario.revision,
          },
        });
        return snapshot;
      },
      requestScope(request, {
        projects: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        accessibilityArtifactHeaders: {
          where: [{ projectId: (request.params as { id: string }).id }],
        },
        accessibilityJobs: {
          where: [{ projectId: (request.params as { id: string }).id }],
        },
        published: { append: true },
        audit: { append: true },
      }),
    );
    return reply.code(201).send({
      id: published.id,
      url: `/shared/${published.id}`,
      scenarioRevision: published.scenario.revision,
      createdAt: published.createdAt,
      engagement: publicationEngagement(published),
    });
  });
  app.delete(`${PREFIX}/published/:id`, async (request) =>
    repository.transaction(
      (state) => {
        const identity = auth(state, request);
        const snapshot = state.publishedHeaders.find(
          (p) =>
            p.id === (request.params as { id: string }).id &&
            p.organizationId === identity.organization.id,
        );
        if (!snapshot) throw notFound();
        findProjectHeader(
          state,
          identity.organization.id,
          snapshot.projectId,
          identity.user.id,
          ["owner"],
        );
        if (snapshot.revokedAt) return { ok: true };
        snapshot.revokedAt = new Date().toISOString();
        const engagement = publicationEngagement(snapshot);
        engagement.collection = {
          status: "closed",
          version: engagement.collection.version + 1,
          updatedAt: snapshot.revokedAt,
        };
        snapshot.engagement = engagement;
        addAudit(state, {
          organizationId: identity.organization.id,
          projectId: snapshot.projectId,
          actorId: identity.user.id,
          action: "snapshot.revoked",
          details: { snapshotId: snapshot.id },
        });
        return { ok: true };
      },
      requestScope(request, {
        publishedHeaders: {
          where: [
            {
              id: (request.params as { id: string }).id,
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        projectHeaders: {
          where: [
            {
              id: { from: "publishedHeaders", field: "projectId" },
              organizationId: { auth: "organizationId" },
            },
          ],
        },
        audit: { append: true },
      }),
    ),
  );
  app.get(`${PREFIX}/published/:id`, async (request) =>
    repository.read(
      (state) => {
        const snapshot = state.published.find(
          (p) => p.id === (request.params as { id: string }).id && !p.revokedAt,
        );
        if (!snapshot) throw notFound();
        // Explicit allowlist keeps private configuration flags and future stored fields out of public responses.
        return {
          id: snapshot.id,
          projectName: snapshot.projectName,
          placeId: snapshot.placeId,
          scenario: snapshot.scenario,
          results: snapshot.results,
          createdAt: snapshot.createdAt,
          feedbackEnabled: snapshot.feedbackEnabled,
          engagement: publicationEngagement(snapshot),
          place: snapshot.baseline,
          ...(snapshot.housingIncomeLimits
            ? { housingIncomeLimits: snapshot.housingIncomeLimits }
            : {}),
          ...(snapshot.fiscalStudy
            ? { fiscalStudy: snapshot.fiscalStudy }
            : {}),
          ...(snapshot.floodDataset
            ? { floodDataset: snapshot.floodDataset }
            : {}),
        };
      },
      {
        publicSnapshotId: (request.params as { id: string }).id,
        published: { where: [{ id: (request.params as { id: string }).id }] },
      },
    ),
  );

  return app;
}
