import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSON } from "../../../packages/core/src/canonical.js";
import type { BudgetState } from "../../../packages/core/src/budget.js";
import type { BudgetRecordPage } from "../../../packages/core/src/budget-records.js";
import { ApiError } from "./errors.js";

const collection = z.enum([
  "adjustments",
  "reservations",
  "audit",
  "costReviews",
]);
export const budgetRecordQuery = z
  .object({
    collection,
    cursor: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    collection,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z
      .number()
      .int()
      .min(50)
      .max(Number.MAX_SAFE_INTEGER)
      .refine((v) => v % 50 === 0),
  })
  .strict();

export function budgetRecordPage(
  state: BudgetState,
  query: z.infer<typeof budgetRecordQuery>,
): BudgetRecordPage {
  const parsed = budgetRecordQuery.parse(query);
  const records = state[parsed.collection] ?? [];
  const snapshotHash = createHash("sha256")
    .update(canonicalJSON(records))
    .digest("hex");
  let offset = 0;
  if (parsed.cursor) {
    let cursor: z.infer<typeof cursorSchema>;
    try {
      const bytes = Buffer.from(parsed.cursor, "base64url");
      if (bytes.toString("base64url") !== parsed.cursor)
        throw new Error("Noncanonical cursor");
      cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new ApiError(
        422,
        "BUDGET_CURSOR_INVALID",
        "This budget history cursor is invalid. Return to the latest records.",
      );
    }
    if (cursor.collection !== parsed.collection)
      throw new ApiError(
        422,
        "BUDGET_CURSOR_INVALID",
        "This cursor belongs to another budget history collection.",
      );
    if (cursor.hash !== snapshotHash)
      throw new ApiError(
        409,
        "BUDGET_RECORDS_CHANGED",
        "These budget records changed while you were paging. Refresh the history to view a consistent set.",
      );
    if (cursor.offset >= records.length)
      throw new ApiError(
        422,
        "BUDGET_CURSOR_INVALID",
        "This cursor is beyond the budget history. Return to the latest records.",
      );
    offset = cursor.offset;
  }
  const end = Math.min(records.length, offset + 50);
  const items = structuredClone(
    records.slice(records.length - end, records.length - offset).reverse(),
  );
  const nextCursor =
    end < records.length
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            collection: parsed.collection,
            hash: snapshotHash,
            offset: end,
          }),
        ).toString("base64url")
      : null;
  return {
    collection: parsed.collection,
    items,
    total: records.length,
    offset,
    pageSize: 50,
    snapshotHash,
    nextCursor,
  };
}
