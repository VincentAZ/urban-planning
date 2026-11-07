import { z } from "zod";
import { fiscalProfileSubmissionSchema } from "./fiscal-library.js";
import { fiscalStudySubmissionSchema } from "./fiscal-routes.js";
const security = [{ session: [] }];
const csrf = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  schema: { type: "string" },
};
const id = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});
const cursor = { name: "cursor", in: "query", schema: { type: "string" } };
const errors = {
  401: { description: "Authentication required" },
  403: {
    description:
      "Workspace membership, source editor permission, CSRF or origin required",
  },
  404: { description: "Scoped profile or project unavailable" },
  409: {
    description:
      "Immutable profile, source revision, latest version or idempotency conflict",
  },
  422: {
    description: "Invalid profile, cursor, source permissions or copy evidence",
  },
  429: { description: "Retained immutable library capacity reached" },
};
const body = (schema: z.ZodType) => ({
  required: true,
  content: {
    "application/json": { schema: z.toJSONSchema(schema, { io: "input" }) },
  },
});
export const fiscalOpenApiPaths = {
  "/fiscal-profiles": {
    get: {
      summary: "List current immutable profile versions in this workspace",
      security,
      parameters: [cursor],
      responses: {
        200: {
          description:
            "At most 50 compact headers and nextCursor; full profile fetched separately",
        },
        ...errors,
      },
    },
    post: {
      summary:
        "Append an immutable fiscal profile version with latest-version CAS",
      description:
        "Source attestations are stamped with the authenticated submitter and receipt time, not independently verified. Exact request-key replay returns the original stamped version. Existing versions never change.",
      security,
      parameters: [csrf],
      requestBody: body(fiscalProfileSubmissionSchema),
      responses: {
        201: {
          description:
            "Exact server-stamped profile and immutable version header",
        },
        ...errors,
      },
    },
  },
  "/fiscal-profiles/{profileId}/versions": {
    get: {
      summary: "Page all retained versions of a scoped fiscal profile",
      security,
      parameters: [id("profileId"), cursor],
      responses: {
        200: { description: "At most 50 version headers and nextCursor" },
        ...errors,
      },
    },
  },
  "/fiscal-profiles/{profileId}/versions/{versionId}": {
    get: {
      summary: "Read one exact immutable profile snapshot",
      security,
      parameters: [id("profileId"), id("versionId")],
      responses: {
        200: { description: "Exact profile and header with content hash" },
        ...errors,
      },
    },
  },
  "/projects/{projectId}/fiscal-studies": {
    post: {
      summary:
        "Create a separate fiscal study from one saved current alternative",
      description:
        "Requires exact project version and alternative revision. Retains current planning edits and numerical captures, marks copied project-owned captures imported, starts fresh history, and records original lineage. The original baseline, project and history stay unchanged. Select one exact libraryVersionId or an inline profile; profile snapshot travels with the new study. Request-key replay requires current source and target access.",
      security,
      parameters: [id("projectId"), csrf],
      requestBody: body(fiscalStudySubmissionSchema),
      responses: {
        201: {
          description:
            "New project, current version, baseline identity and access; replay returns the same study",
        },
        ...errors,
      },
    },
  },
};
