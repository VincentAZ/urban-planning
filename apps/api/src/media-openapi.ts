import { z } from "zod";
import { mediaExportRecipeSchema } from "@urban/core";
import { mediaSubmissionSchema } from "./media-jobs.js";
const security = [{ session: [] }];
const project = {
  name: "projectId",
  in: "path",
  required: true,
  schema: { type: "string" },
};
const job = {
  name: "jobId",
  in: "path",
  required: true,
  schema: { type: "string" },
};
const csrf = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  schema: { type: "string" },
};
const responses = {
  200: { description: "Authorized private response" },
  202: { description: "Idempotent frozen-scene export accepted" },
  401: { description: "Free account required" },
  403: { description: "Current project role or CSRF rejected" },
  404: { description: "Private project/job/file not found" },
  409: {
    description:
      "Saved version, preparation cache, request key or job transition changed",
  },
  413: { description: "Complete scene or artifact exceeds an explicit bound" },
  422: {
    description:
      "Invalid recipe, unsupported scene or source export permission",
  },
  429: { description: "Shared fair-use, preview or queue limit" },
  503: {
    description: "Runtime, archive, cost review or fixed-capacity unavailable",
  },
};
const body = (schema: z.ZodType) => ({
  required: true,
  content: {
    "application/json": { schema: z.toJSONSchema(schema, { io: "input" }) },
  },
});
const base = "/projects/{projectId}/media";
export const mediaOpenApiPaths = {
  [`${base}/capabilities`]: {
    get: {
      summary:
        "Inspect configured isolated PNG/MP4 capacity without starting a render",
      security,
      parameters: [project],
      responses,
    },
  },
  [`${base}/context`]: {
    get: {
      summary: "Prepare one bounded immutable saved scene for private export",
      description:
        "Requires current edit access. The returned scene hash is scoped to this account and saved version for five minutes. It contains no authentication data, comments or access lists.",
      security,
      parameters: [
        project,
        {
          name: "scenarioId",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses,
    },
  },
  [`${base}/jobs`]: {
    get: {
      summary: "Page through all authorized project media jobs",
      description:
        "Returns jobs and nextCursor (null at the end), at most 100 jobs per page, newest createdAt/id first. The opaque cursor is scoped to the project and optional scenarioId. Every request rechecks current access.",
      security,
      parameters: [
        project,
        {
          name: "scenarioId",
          in: "query",
          schema: { type: "string", maxLength: 160 },
        },
        {
          name: "cursor",
          in: "query",
          schema: { type: "string", maxLength: 1024 },
        },
      ],
      responses,
    },
    post: {
      summary: "Queue exact saved-scene high-resolution PNG or silent MP4",
      description:
        "Requires enabled fixed capacity and fresh operating-cost review. No paid priority tier. Input is an exact server-prepared scene hash; client frames or URLs are never accepted.",
      security,
      parameters: [project, csrf],
      requestBody: body(
        mediaSubmissionSchema.extend({ recipe: mediaExportRecipeSchema }),
      ),
      responses,
    },
  },
  [`${base}/jobs/{jobId}`]: {
    get: {
      summary:
        "Read compact private media progress and immutable output identity",
      security,
      parameters: [project, job],
      responses,
    },
  },
  [`${base}/jobs/{jobId}/cancel`]: {
    post: {
      summary:
        "Request cancellation; native slot releases only after confirmed termination",
      security,
      parameters: [project, job, csrf],
      requestBody: body(
        z.object({ expectedJobVersion: z.number().int().positive() }).strict(),
      ),
      responses,
    },
  },
  [`${base}/jobs/{jobId}/retry`]: {
    post: {
      summary: "Retry the same frozen scene with retained consumed attempts",
      security,
      parameters: [project, job, csrf],
      requestBody: body(
        z
          .object({
            expectedJobVersion: z.number().int().positive(),
            idempotencyKey: z.string().min(8).max(160),
          })
          .strict(),
      ),
      responses,
    },
  },
  [`${base}/jobs/{jobId}/artifacts/{name}`]: {
    get: {
      summary:
        "Download exact verified media or provenance sidecar after current-access recheck",
      security,
      parameters: [
        project,
        job,
        {
          name: "name",
          in: "path",
          required: true,
          schema: {
            type: "string",
            enum: [
              "output.png",
              "output.mp4",
              "manifest.json",
              "frames.json",
              "transcript.txt",
              "captions.vtt",
              "thumbnail.png",
            ],
          },
        },
      ],
      responses: {
        ...responses,
        200: {
          description:
            "Exact private bytes; Content-Length, Content-Type and X-Content-SHA256 bind the retained output. Cache-Control private,no-store.",
        },
      },
    },
  },
};
