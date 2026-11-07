import { z } from "zod";
import { floodDatasetSchema } from "@urban/core";
const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
const json = (schema: unknown) => ({
  content: { "application/json": { schema } },
});
const response = {
  description: "Successful response",
  ...json({ type: "object" }),
};
export const floodOpenApiPaths = {
  "/flood/catalog": {
    get: {
      summary:
        "List configured public cached effective NFHL captures for one exact study boundary",
      description:
        "Anonymous, no provider requests. A complete captured catalog is finite and operator-configured; an empty list does not mean an area has no flood hazard.",
      parameters: [
        { name: "studyAreaHash", in: "query", required: true, schema: sha },
      ],
      responses: {
        200: {
          ...response,
          description:
            "Public choices: id, label, datasetHash, studyAreaHash, capturedAt and normalized bytes",
        },
        400: { description: "Invalid hash" },
        429: { description: "Fair-use limit" },
      },
    },
  },
  "/flood/datasets/{hash}": {
    get: {
      summary: "Read one configured public captured flood dataset",
      parameters: [{ name: "hash", in: "path", required: true, schema: sha }],
      responses: {
        200: {
          description:
            "Exact normalized pack; X-Dataset-SHA256 binds canonical content",
          ...json({
            type: "object",
            required: ["datasetHash", "dataset"],
            properties: {
              datasetHash: sha,
              dataset: z.toJSONSchema(floodDatasetSchema, { io: "input" }),
            },
          }),
        },
        404: {
          description: "Not configured; no filesystem or private-upload lookup",
        },
        429: { description: "Fair-use limit" },
      },
    },
  },
  "/projects/{projectId}/flood/adopt": {
    post: {
      summary:
        "Atomically install a prepared flood dataset and append a scenario reference command",
      description:
        "Current owner/editor and exact project version/scenario revision required. The registered dataset must match this immutable study boundary. New references select flood-footprint-1.1.0; omitted historical methods retain 1.0.0. Existing catalog keys and undo history remain unchanged. A supported method-only change uses the ordinary versioned scenario.flood command. The response is the complete authoritative project, baseline, baselineIdentity, version, organizationId and access.",
      security: [{ session: [] }],
      parameters: [
        {
          name: "projectId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "X-CSRF-Token",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        ...json({
          type: "object",
          additionalProperties: false,
          required: [
            "scenarioId",
            "expectedVersion",
            "expectedRevision",
            "datasetHash",
          ],
          properties: {
            scenarioId: { type: "string" },
            expectedVersion: { type: "integer", minimum: 1 },
            expectedRevision: { type: "integer", minimum: 0 },
            datasetHash: sha,
          },
        }),
      },
      responses: {
        200: response,
        400: { description: "Invalid body or immutable baseline scenario" },
        401: { description: "Sign-in required" },
        403: { description: "Edit role, CSRF or origin denied" },
        404: { description: "Project or configured capture unavailable" },
        409: { description: "Project/scenario changed" },
        422: {
          description:
            "Unregistered source, content hash or exact study-area mismatch",
        },
        429: { description: "Fair-use limit" },
      },
    },
  },
};
