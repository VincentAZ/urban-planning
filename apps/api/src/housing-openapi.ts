import { z } from "zod";
import {
  housingAffordabilityScenarioSchema,
  housingIncomeLimitPackSchema,
} from "@urban/core";
const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
const json = (schema: unknown) => ({
  content: { "application/json": { schema } },
});
export const housingOpenApiPaths = {
  "/housing/catalog": {
    get: {
      summary: "Search the immutable public HUD Section 8 area catalog",
      description:
        "Anonymous cached data only. Search uses explicit state/county/town names; it never assigns a ZIP or building to an area. Pages contain at most 50 areas. Cursor binds exact catalog and search filters.",
      parameters: [
        {
          name: "state",
          in: "query",
          schema: { type: "string", pattern: "^[0-9]{2}$" },
        },
        {
          name: "county",
          in: "query",
          schema: { type: "string", pattern: "^[0-9]{5}$" },
        },
        { name: "q", in: "query", schema: { type: "string", maxLength: 160 } },
        {
          name: "cursor",
          in: "query",
          schema: { type: "string", maxLength: 2048 },
        },
      ],
      responses: {
        200: {
          description:
            "version,catalogHash,areas[{packHash,area,fiscalYear,effectiveDate}],nextCursor",
        },
        400: { description: "Invalid filters" },
        409: {
          description: "HOUSING_CURSOR_INVALID: search or catalog changed",
        },
      },
    },
  },
  "/housing/packs/{hash}": {
    get: {
      summary: "Read one exact configured public income-limit pack",
      parameters: [{ name: "hash", in: "path", required: true, schema: sha }],
      responses: {
        200: {
          description: "X-Dataset-SHA256 binds canonical pack content",
          ...json({
            type: "object",
            properties: {
              packHash: sha,
              pack: z.toJSONSchema(housingIncomeLimitPackSchema, {
                io: "input",
              }),
            },
          }),
        },
        404: {
          description:
            "Not configured; private uploads and filesystem paths are never exposed",
        },
      },
    },
  },
  "/projects/{projectId}/housing/adopt": {
    post: {
      summary:
        "Atomically retain selected income-limit packs and a reviewed housing cost comparison",
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
            "affordability",
          ],
          properties: {
            scenarioId: { type: "string" },
            expectedVersion: { type: "integer", minimum: 1 },
            expectedRevision: { type: "integer", minimum: 0 },
            affordability: z.toJSONSchema(housingAffordabilityScenarioSchema, {
              io: "input",
            }),
          },
        }),
      },
      responses: {
        200: {
          description:
            "Authoritative project,baseline,baselineIdentity,version,organizationId,access",
        },
        400: { description: "Invalid body or immutable baseline" },
        401: { description: "Authentication required" },
        403: { description: "CSRF or editor permission denied" },
        404: { description: "Project or configured pack unavailable" },
        409: { description: "Project/revision or reviewed input changed" },
        422: {
          description: "Missing pack, source authority or usage permission",
        },
      },
    },
  },
};
