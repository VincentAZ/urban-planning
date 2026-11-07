import { fiscalOpenApiPaths } from "./fiscal-openapi.js";
import { mediaOpenApiPaths } from "./media-openapi.js";
import { budgetOpenApiPaths } from "./budget-openapi.js";
import { accessibilitySubmissionSchema } from "./accessibility-jobs.js";
import { z } from "zod";
import { floodOpenApiPaths } from "./flood-openapi.js";
import { identityOpenApiPaths } from "./identity-openapi.js";
import { workforceSubmissionSchema } from "./workforce-jobs.js";
import {
  gisPreviewRequestSchema,
  gisSubmissionSchema,
} from "./gis-import-mapping.js";
import {
  engagementConfigSchema,
  engagementSubmissionSchema,
  engagementCollectionSchema,
  engagementModerationSchema,
} from "./engagement.js";
import {
  commandSchema,
  loginSchema,
  projectSchema,
  registerSchema,
  scenarioSchema,
} from "./validation.js";

const json = (schema: unknown) => ({
  content: { "application/json": { schema } },
});
const success = {
  description: "Successful response",
  ...json({ type: "object" }),
};
const errors = {
  400: { description: "Invalid request" },
  401: { description: "Free account sign-in required" },
  403: { description: "Role, CSRF, or origin rejected" },
  404: { description: "Record not found in this workspace" },
  409: { description: "Revision conflict" },
  429: { description: "Fair-use rate limit" },
};
const workforceErrors = {
  ...errors,
  413: {
    description:
      "Complete request exceeds a bounded processing or artifact limit",
  },
  422: { description: "Invalid or unverified evidence" },
  503: {
    description:
      "Required source, capacity, budget headroom, or evidence archive unavailable",
  },
};
const body = (schema: unknown) => ({ required: true, ...json(schema) });
const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
};
const csrf = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  schema: { type: "string" },
  description:
    "Token returned by /auth/session. Required for cookie-authenticated mutations.",
};
const projectRef = { $ref: "#/components/schemas/Project" };

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Urban Planning API",
    version: "0.1.0",
    description:
      "Free planning workspace API. Public baseline discovery and published snapshots require no account. Saved work is isolated by organization. The local password provider supports explicit email verification, generation-bound recovery and accepted invitations. Outbound delivery is disabled until fully configured. Existing memberships remain; new email-based access requires verified recipient acceptance. Cognito/enterprise SSO is not yet integrated.",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "urban_session" },
    },
    schemas: {
      Project: z.toJSONSchema(projectSchema, { io: "input" }),
      Scenario: z.toJSONSchema(scenarioSchema, { io: "input" }),
      Command: z.toJSONSchema(commandSchema, { io: "input" }),
      EngagementConfig: z.toJSONSchema(engagementConfigSchema),
      EngagementSubmission: z.toJSONSchema(engagementSubmissionSchema),
    },
  },
  paths: {
    ...mediaOpenApiPaths,
    ...budgetOpenApiPaths,
    ...fiscalOpenApiPaths,
    ...identityOpenApiPaths,
    ...floodOpenApiPaths,
    "/projects/{projectId}/imports/capabilities": {
      get: {
        summary:
          "Read configured private GIS formats, processing bounds and fixed-capacity declaration",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/uploads": {
      post: {
        summary:
          "Stream a private GeoJSON, shapefile ZIP or DXF and queue inspection",
        description:
          "Free account with current project edit access required before file consumption. Send a JSON metadata field before one file. At most 20 MiB; no project changes occur during inspection.",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }, csrf],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["metadata", "file"],
                properties: {
                  metadata: {
                    type: "string",
                    description:
                      "JSON: scenarioId, expectedVersion, expectedRevision, idempotencyKey",
                  },
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: { 202: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/uploads/{uploadId}": {
      get: {
        summary:
          "Read retained layer/field/CRS inspection for an upload owned by the current editor",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "uploadId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/uploads/{uploadId}/preview": {
      post: {
        summary:
          "Queue exact normalization, field mapping, rights and append/match preview",
        description:
          "Strict declarative recipe; no client paths, SQL, arbitrary pipelines or command arguments. Complete preview is immutable, bound to project/scenario revisions and baseline hash, and expires after 24 hours if unapplied.",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "uploadId" },
          csrf,
        ],
        requestBody: body(
          z.toJSONSchema(gisPreviewRequestSchema, { io: "input" }),
        ),
        responses: { 202: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/jobs": {
      get: {
        summary: "Recover the current editor's latest 100 private GIS jobs",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/jobs/{jobId}": {
      get: {
        summary: "Read private GIS progress and retained attempt history",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/jobs/{jobId}/preview": {
      get: {
        summary:
          "Read the exact prepared geometry, attributes, provenance and review hash",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: {
          200: success,
          410: { description: "Unapplied preview expired" },
          ...workforceErrors,
        },
      },
    },
    "/projects/{projectId}/imports/jobs/{jobId}/cancel": {
      post: {
        summary:
          "Cancel a queued or running private GIS job without applying partial geometry",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["expectedJobVersion"],
          properties: { expectedJobVersion: { type: "integer", minimum: 1 } },
          additionalProperties: false,
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/jobs/{jobId}/retry": {
      post: {
        summary:
          "Explicitly retry an eligible GIS job with a stable request key",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["expectedJobVersion", "idempotencyKey"],
          properties: {
            expectedJobVersion: { type: "integer", minimum: 1 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 160 },
          },
          additionalProperties: false,
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/exports/shapefile": {
      post: {
        summary:
          "Freeze a saved scenario and queue a complete shapefile ZIP export",
        description:
          "Separate geometry layers, DBF null/status flags, field dictionary, CRS, source manifest and exact JSON sidecars. Subsequent project edits do not change the queued snapshot.",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }, csrf],
        requestBody: body(z.toJSONSchema(gisSubmissionSchema)),
        responses: { 202: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/imports/jobs/{jobId}/download": {
      get: {
        summary:
          "Download a completed private shapefile ZIP after current edit-access and content-hash checks",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: {
          200: {
            description: "Complete ZIP; SHA-256 ETag; private no-store",
            content: {
              "application/zip": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...workforceErrors,
        },
      },
    },
    "/projects/{projectId}/imports/uploads/{uploadId}/file": {
      get: {
        summary:
          "Download exact retained original upload bytes as their authorized creator",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "uploadId" },
        ],
        responses: {
          200: {
            description:
              "Verified original file; SHA-256 ETag; private no-store",
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...workforceErrors,
        },
      },
    },
    "/projects/{projectId}/workforce/capabilities": {
      get: {
        summary:
          "Read configured regional workforce capacity for an authorized saved project",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/workforce/jobs": {
      get: {
        summary:
          "List the latest 100 project-owned workforce jobs without raw route rows",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }],
        responses: { 200: success, ...workforceErrors },
      },
      post: {
        summary: "Explicitly queue a captured regional run as a project editor",
        description:
          "Idempotent, version-bound request. Requires verified server source configuration, fixed-capacity declaration and budget headroom. No visitor download of a source pack and no automatic run on opening a workbench.",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }, csrf],
        requestBody: body(z.toJSONSchema(workforceSubmissionSchema)),
        responses: { 201: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/workforce/jobs/{jobId}": {
      get: {
        summary:
          "Read project-authorized job progress and retained attempt history",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/workforce/jobs/{jobId}/cancel": {
      post: {
        summary:
          "Cancel a queued or running attempt without deleting consumed capacity history",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["expectedJobVersion"],
          additionalProperties: false,
          properties: { expectedJobVersion: { type: "integer", minimum: 1 } },
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/workforce/jobs/{jobId}/retry": {
      post: {
        summary:
          "Explicitly retry failed work with a new admission and idempotency key",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["expectedJobVersion", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            expectedJobVersion: { type: "integer", minimum: 1 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 160 },
          },
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/workforce/jobs/{jobId}/result": {
      get: {
        summary:
          "Return compact frozen workforce evidence and separate exact contours",
        description:
          "Returns job, workforce, contour and numeric siteSnapMeters. No cohort pack or origin route rows. Missing/corrupt raw evidence returns an explicit unavailable response, not fabricated contours.",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/workforce/jobs/{jobId}/artifact": {
      get: {
        summary: "Explicitly download verified private full routing evidence",
        description:
          "Bounded 64 MiB JSON with raw route rows, aggregation and contours; no source cohort pack. Three downloads per minute, X-Content-SHA256, private no-store. Authorization is checked again after archive verification.",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/workforce/jobs/{jobId}/adopt": {
      post: {
        summary:
          "Atomically adopt server-owned evidence into the exact saved scenario",
        description:
          "Requires scenarioId, expectedVersion, expectedRevision, inputHash and resultHash. Applies one reversible scenario.workforce command and returns project, baseline, baselineIdentity, version, organizationId and access. Client-provided counts are never accepted as server-produced evidence.",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: [
            "scenarioId",
            "expectedVersion",
            "expectedRevision",
            "inputHash",
            "resultHash",
          ],
          additionalProperties: false,
          properties: {
            scenarioId: { type: "string" },
            expectedVersion: { type: "integer", minimum: 1 },
            expectedRevision: { type: "integer", minimum: 0 },
            inputHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            resultHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/capabilities": {
      get: {
        summary:
          "Read configured outbound primary-job accessibility capacity for an authorized saved project",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/jobs": {
      get: {
        summary:
          "List the latest 100 project-owned accessibility jobs without raw route rows",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }],
        responses: { 200: success, ...workforceErrors },
      },
      post: {
        summary: "Explicitly queue a captured regional run as a project editor",
        description:
          "Idempotent, version-bound request. Requires verified server source configuration, fixed-capacity declaration and budget headroom. No visitor download of a source pack and no automatic run on opening a workbench.",
        security: [{ session: [] }],
        parameters: [{ ...idParameter, name: "projectId" }, csrf],
        requestBody: body(z.toJSONSchema(accessibilitySubmissionSchema)),
        responses: { 201: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/jobs/{jobId}": {
      get: {
        summary:
          "Read project-authorized job progress and retained attempt history",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/jobs/{jobId}/cancel": {
      post: {
        summary:
          "Cancel a queued or running attempt without deleting consumed capacity history",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["expectedJobVersion"],
          additionalProperties: false,
          properties: { expectedJobVersion: { type: "integer", minimum: 1 } },
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/jobs/{jobId}/retry": {
      post: {
        summary:
          "Explicitly retry failed work with a new admission and idempotency key",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["expectedJobVersion", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            expectedJobVersion: { type: "integer", minimum: 1 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 160 },
          },
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/jobs/{jobId}/result": {
      get: {
        summary:
          "Return compact frozen accessibility evidence and separate exact contours",
        description:
          "Returns job, accessibility, contour and numeric siteSnapMeters. No workplace source pack or destination route rows. Missing/corrupt raw evidence returns an explicit unavailable response, not fabricated contours.",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/jobs/{jobId}/artifact": {
      get: {
        summary: "Explicitly download verified private full routing evidence",
        description:
          "Bounded 64 MiB JSON with raw route rows, aggregation and contours; no source cohort pack. Three downloads per minute, X-Content-SHA256, private no-store. Authorization is checked again after archive verification.",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
        ],
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{projectId}/accessibility/jobs/{jobId}/adopt": {
      post: {
        summary:
          "Atomically adopt server-owned evidence into the exact saved scenario",
        description:
          "Requires scenarioId, expectedVersion, expectedRevision, inputHash and resultHash. Applies one reversible selected-mode scenario.accessibility command, preserving the other mode and returns project, baseline, baselineIdentity, version, organizationId and access. Client-provided counts are never accepted as server-produced evidence.",
        security: [{ session: [] }],
        parameters: [
          { ...idParameter, name: "projectId" },
          { ...idParameter, name: "jobId" },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: [
            "scenarioId",
            "expectedVersion",
            "expectedRevision",
            "inputHash",
            "resultHash",
          ],
          additionalProperties: false,
          properties: {
            scenarioId: { type: "string" },
            expectedVersion: { type: "integer", minimum: 1 },
            expectedRevision: { type: "integer", minimum: 0 },
            inputHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            resultHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        }),
        responses: { 200: success, ...workforceErrors },
      },
    },
    "/projects/{id}/vehicle-reference": {
      get: {
        summary:
          "Read a prepared whole-ZCTA household-vehicle reference without modifying the project",
        security: [{ session: [] }],
        parameters: [idParameter],
        responses: { 200: success, ...errors },
        description:
          "Returns projectVersion, baselineHash, status available/unavailable, reference or null, and reason. Local prepared Census cache only; adoption is an explicit scenario.activity command subject to edit permission and optimistic versions.",
      },
    },
    "/health": {
      get: {
        summary: "Service and configured storage status",
        responses: { 200: success },
      },
    },
    "/places": {
      get: {
        summary: "List prepared geographic datasets",
        parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
        responses: { 200: success },
      },
    },
    "/places/{id}": {
      get: {
        summary: "Load a prepared baseline",
        parameters: [idParameter],
        responses: { 200: success, 404: errors[404] },
      },
    },
    "/auth/register": {
      post: {
        summary: "Create a free account and workspace",
        requestBody: body(z.toJSONSchema(registerSchema)),
        responses: { 201: success, ...errors },
      },
    },
    "/auth/login": {
      post: {
        summary: "Sign in and set a secure session cookie",
        requestBody: body(z.toJSONSchema(loginSchema)),
        responses: { 200: success, ...errors },
      },
    },
    "/auth/session": {
      get: {
        summary: "Current identity and CSRF token, or user null",
        responses: { 200: success },
      },
    },
    "/auth/logout": {
      post: {
        summary: "Revoke the current session",
        security: [{ session: [] }],
        parameters: [csrf],
        responses: { 200: success, ...errors },
      },
    },
    "/projects": {
      get: {
        summary: "List projects in the current workspace",
        security: [{ session: [] }],
        responses: { 200: success, ...errors },
      },
      post: {
        summary: "Save a project with a frozen geographic baseline",
        security: [{ session: [] }],
        parameters: [csrf],
        requestBody: body({
          oneOf: [
            {
              type: "object",
              required: ["project"],
              properties: { project: projectRef },
            },
            {
              type: "object",
              required: ["placeId"],
              properties: {
                placeId: { type: "string" },
                name: { type: "string" },
              },
            },
          ],
        }),
        responses: { 201: success, ...errors },
      },
    },
    "/projects/{id}": {
      get: {
        summary: "Read a project and its storage version",
        security: [{ session: [] }],
        parameters: [idParameter],
        responses: { 200: success, ...errors },
      },
      put: {
        summary: "Save a scenario workspace with optimistic concurrency",
        security: [{ session: [] }],
        parameters: [idParameter, csrf],
        requestBody: body({
          type: "object",
          required: ["project", "expectedVersion"],
          properties: {
            project: projectRef,
            expectedVersion: { type: "integer", minimum: 1 },
          },
        }),
        responses: { 200: success, ...errors },
      },
      delete: {
        summary: "Delete a project and revoke its public snapshots",
        security: [{ session: [] }],
        parameters: [idParameter, csrf],
        requestBody: body({
          type: "object",
          required: ["expectedVersion"],
          properties: { expectedVersion: { type: "integer", minimum: 1 } },
        }),
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/scenarios/{scenarioId}/commands": {
      post: {
        summary:
          "Apply one reversible scenario edit at an expected saved revision",
        description:
          "Requires project owner/editor access. scenario.presentation accepts an authored presentation object or null to remove it, advances the scenario revision, and permanently upgrades the project to format 4. The baseline is immutable. Metric references are preserved even if absent from current model results; narration is text only.",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          {
            name: "scenarioId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["command", "expectedVersion", "expectedRevision"],
          properties: {
            command: { $ref: "#/components/schemas/Command" },
            expectedVersion: { type: "integer", minimum: 1 },
            expectedRevision: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        }),
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/metrics": {
      get: {
        summary: "Compute metrics for a frozen baseline and selected revision",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          { name: "scenarioId", in: "query", schema: { type: "string" } },
          { name: "revision", in: "query", schema: { type: "integer" } },
          {
            name: "version",
            in: "query",
            description:
              "Expected saved project version; stale requests return 409.",
            schema: { type: "integer", minimum: 1 },
          },
        ],
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/exports": {
      get: {
        summary: "Download a revision-bound report, data, or records package",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          {
            name: "format",
            in: "query",
            required: true,
            schema: {
              enum: [
                "pdf",
                "docx",
                "csv",
                "retail-csv",
                "workforce-csv",
                "traffic-csv",
                "accessibility-csv",
                "fiscal-csv",
                "flood-csv",
                "xlsx",
                "geojson",
                "records",
              ],
            },
          },
          { name: "scenarioId", in: "query", schema: { type: "string" } },
          { name: "revision", in: "query", schema: { type: "integer" } },
          {
            name: "version",
            in: "query",
            description:
              "Expected saved project version; stale requests return 409.",
            schema: { type: "integer", minimum: 1 },
          },
        ],
        responses: {
          200: {
            description:
              "Attachment from one authorized saved snapshot. PDF/Word contain deterministic before/after maps from its captured geometry and, when present, a labeled authored presentation outline. XLSX includes ordered presentation rows. Complete records retain presentation history; GeoJSON contains geometry rather than tour state. Optional retail analysis is retained in records/GeoJSON, PDF/Word appendices and XLSX category/input/evidence sheets; retail-csv exports every category, entered measure state, result, source and rights declaration. Private-authorized exports do not grant public redistribution permission.",
            headers: {
              "X-Scenario-Revision": { schema: { type: "integer" } },
              "X-Project-Version": { schema: { type: "integer" } },
              "X-Report-Renderer": {
                description: "PDF/Word map renderer version",
                schema: { type: "string" },
              },
              "X-Report-Map-Input": {
                description: "PDF/Word geometry pair input SHA-256",
                schema: { type: "string" },
              },
              "X-Report-Baseline-Image": {
                description: "PDF/Word embedded baseline PNG SHA-256",
                schema: { type: "string" },
              },
              "X-Report-Proposal-Image": {
                description: "PDF/Word embedded proposal PNG SHA-256",
                schema: { type: "string" },
              },
            },
            content: {
              "application/pdf": {
                schema: { type: "string", format: "binary" },
              },
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
                { schema: { type: "string", format: "binary" } },
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
                { schema: { type: "string", format: "binary" } },
              "text/csv": { schema: { type: "string" } },
              "application/geo+json": { schema: { type: "object" } },
              "application/json": { schema: { type: "object" } },
            },
          },
          ...errors,
          422: {
            description:
              "Captured report geometry exceeds explicit rendering limits, has no valid baseline, or retail-csv was requested without a saved retail study",
          },
          413: {
            description:
              "Retail PDF/Word evidence appendix exceeds 120,000 serialized characters; use CSV, XLSX or full records",
          },
          503: {
            description:
              "The bounded report rendering queue timed out; retry shortly",
          },
        },
      },
    },
    "/capabilities": {
      get: {
        summary:
          "Discover implemented formats and configured services without implying unconfigured adapters are live",
        responses: { 200: success },
      },
    },
    "/imports/geojson/preview": {
      post: {
        summary:
          "Stage and validate user-supplied building footprints, parcel or block boundaries",
        security: [{ session: [] }],
        parameters: [csrf],
        requestBody: body({
          type: "object",
          required: ["sourceName", "geojson"],
          properties: {
            projectId: { type: "string" },
            scenarioId: { type: "string" },
            layer: {
              enum: ["buildings", "parcels", "blocks"],
              default: "buildings",
              description:
                "Parcel/block previews require a saved project and editable alternative; Polygon/MultiPolygon holes are preserved. Omitted layer selects buildings. Building geometry retains Polygon/MultiPolygon holes and components; explicit programs and rate bases are validated.",
            },
            sourceName: { type: "string" },
            sourceUrl: {
              type: "string",
              description:
                "Optional http(s) source URL for any imported layer; never fetched by the importer.",
            },
            sourceVintage: { type: "string" },
            sourceLicense: { type: "string" },
            geojson: { type: "object" },
          },
        }),
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/imports/{importId}/commit": {
      post: {
        summary: "Apply a staged layer as one reversible scenario command",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          {
            name: "importId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          csrf,
        ],
        requestBody: body({
          type: "object",
          required: ["scenarioId", "expectedRevision", "expectedVersion"],
          properties: {
            scenarioId: { type: "string" },
            expectedRevision: { type: "integer" },
            expectedVersion: { type: "integer" },
            acknowledgeWarnings: { type: "boolean" },
            previewHash: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
              description:
                "Required for prepared GIS jobs; must match the exact reviewed preview.",
            },
          },
        }),
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/publish": {
      post: {
        summary:
          "Publish a frozen scenario and optional immutable engagement definition; project owner only",
        security: [{ session: [] }],
        parameters: [idParameter, csrf],
        requestBody: body({
          type: "object",
          required: ["scenarioId", "expectedRevision"],
          properties: {
            scenarioId: { type: "string" },
            expectedRevision: { type: "integer", minimum: 0 },
            feedbackEnabled: {
              type: "boolean",
              description:
                "Legacy defaults: comments, votes and pins; no survey questions",
            },
            engagement: { $ref: "#/components/schemas/EngagementConfig" },
          },
        }),
        responses: { 201: success, ...errors },
      },
    },
    "/published/{id}/engagement": {
      get: {
        summary:
          "Lightweight public frozen configuration and current collection status/version; never response data",
        parameters: [idParameter],
        responses: { 200: success, 404: errors[404] },
      },
    },
    "/published/{id}/feedback/mine": {
      get: {
        summary:
          "Authenticated account's own response history, authoritative current flags and configuration; moderation reasons are private",
        security: [{ session: [] }],
        parameters: [idParameter],
        responses: { 200: success, ...errors },
      },
    },
    "/published/{id}/feedback": {
      post: {
        summary:
          "Submit an account-bound comment/pin, vote or configured survey; version and idempotency key required for explicit-config publications",
        security: [{ session: [] }],
        parameters: [idParameter, csrf],
        requestBody: body({
          $ref: "#/components/schemas/EngagementSubmission",
        }),
        responses: {
          200: { description: "Same submission already accepted" },
          201: success,
          422: { description: "Pin lies outside the exact frozen study area" },
          ...errors,
        },
      },
    },
    "/projects/{id}/engagement": {
      get: {
        summary:
          "Private project-authorized publication list with per-snapshot aggregates, including closed and revoked snapshots",
        security: [{ session: [] }],
        parameters: [idParameter],
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/engagement/{snapshotId}": {
      get: {
        summary:
          "Private atomic snapshot summary, pseudonymous response history and moderation audit",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          {
            name: "snapshotId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/engagement/{snapshotId}/collection": {
      patch: {
        summary:
          "Owner-only open/close collection using its independent optimistic version; survey definition remains frozen",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          {
            name: "snapshotId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          csrf,
        ],
        requestBody: body(z.toJSONSchema(engagementCollectionSchema)),
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/engagement/{snapshotId}/feedback/{feedbackId}": {
      patch: {
        summary:
          "Owner-only include/exclude a response with mandatory reason and moderation version; no deletion",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          {
            name: "snapshotId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "feedbackId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          csrf,
        ],
        requestBody: body(z.toJSONSchema(engagementModerationSchema)),
        responses: { 200: success, ...errors },
      },
    },
    "/projects/{id}/engagement/{snapshotId}/export": {
      get: {
        summary:
          "Project-authorized atomic engagement report; current included/pending responses and account denominators, no account identities",
        security: [{ session: [] }],
        parameters: [
          idParameter,
          {
            name: "snapshotId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "format",
            in: "query",
            required: true,
            schema: { enum: ["pdf", "csv", "json"] },
          },
        ],
        responses: {
          200: success,
          413: {
            description:
              "Report generation limit exceeded without truncation; use data/full records export",
          },
          503: {
            description: "Report worker busy; retry after indicated delay",
          },
          ...errors,
        },
      },
    },
    "/published/{id}": {
      delete: {
        summary:
          "Owner-only revoke public link and close collection; history is retained",
        security: [{ session: [] }],
        parameters: [idParameter, csrf],
        responses: { 200: success, ...errors },
      },
      get: {
        summary:
          "Read an immutable published scenario, baseline, and result bundle",
        parameters: [idParameter],
        responses: { 200: success, 404: errors[404] },
      },
    },
  },
};
