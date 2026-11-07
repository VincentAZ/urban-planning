import { z } from "zod";
import {
  adjustmentSchema,
  costReviewSchema,
  policyUpdateSchema,
} from "./budget.js";
const security = [{ session: [] }];
const csrf = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  schema: { type: "string" },
};
const responses = {
  200: {
    description: "Private administrator dashboard or complete record page",
  },
  400: {
    description:
      "Invalid review, costs or dates (including BUDGET_REVIEW_INVALID)",
  },
  401: { description: "Authentication required" },
  403: { description: "Platform administrator, CSRF or origin required" },
  422: {
    description:
      "BUDGET_CURSOR_INVALID: malformed, mismatched or out-of-range cursor",
  },
  409: {
    description:
      "Accounting basis, request key or record-page snapshot changed",
  },
};
const requestBody = (schema: z.ZodType) => ({
  required: true,
  content: {
    "application/json": { schema: z.toJSONSchema(schema, { io: "input" }) },
  },
});
export const budgetOpenApiPaths = {
  "/admin/budget": {
    get: {
      summary:
        "Observe private operating-cost outlook and durable alert transitions",
      security,
      responses,
    },
    patch: {
      summary:
        "Update operating ceiling, margin, fixed allowance and pause policy",
      security,
      parameters: [csrf],
      requestBody: requestBody(policyUpdateSchema),
      responses,
    },
  },
  "/admin/budget/adjustments": {
    post: {
      summary: "Append an idempotent manual invoice or correction",
      security,
      parameters: [csrf],
      requestBody: requestBody(adjustmentSchema),
      responses,
    },
  },
  "/admin/budget/reviews": {
    post: {
      summary:
        "Append an administrator-authored current cost review bound to the exact accounting basis",
      description:
        "No provider verification or spend authorization is implied. Stale estimates remain held until explicitly replaced. Forecast bands are authored scenarios, not confidence intervals. Idempotent replay retains the original record.",
      security,
      parameters: [csrf],
      requestBody: requestBody(costReviewSchema),
      responses,
    },
  },
  "/admin/budget/records": {
    get: {
      summary:
        "Read complete immutable accounting history in snapshot-bound pages",
      security,
      parameters: [
        {
          name: "collection",
          in: "query",
          required: true,
          schema: {
            type: "string",
            enum: ["adjustments", "reservations", "audit", "costReviews"],
          },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
      ],
      responses,
    },
  },
};
