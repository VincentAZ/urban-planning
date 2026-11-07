import { z } from "zod";
import { ApiError } from "./errors.js";
import { publicMediaJob } from "./media-jobs.js";
import type { MediaJobRecord, MediaJobsPage } from "./media-types.js";

export const mediaJobsQuery = z
  .object({
    scenarioId: z.string().min(1).max(160).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1).max(160),
    scenarioId: z.string().min(1).max(160).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();
const invalid = () =>
  new ApiError(
    422,
    "MEDIA_CURSOR_INVALID",
    "The media history query or cursor is invalid for this project and scenario.",
  );
export function mediaJobPage(
  jobs: MediaJobRecord[],
  projectId: string,
  input: unknown,
): MediaJobsPage {
  const parsed = mediaJobsQuery.safeParse(input);
  if (!parsed.success) throw invalid();
  const q = parsed.data;
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (q.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(q.cursor)) throw invalid();
      const bytes = Buffer.from(q.cursor, "base64url");
      if (bytes.toString("base64url") !== q.cursor) throw invalid();
      cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (
        cursor.projectId !== projectId ||
        cursor.scenarioId !== (q.scenarioId ?? null)
      )
        throw invalid();
    } catch {
      throw invalid();
    }
  }
  const rows = jobs
    .filter(
      (j) =>
        j.projectId === projectId &&
        (!q.scenarioId || j.scenarioId === q.scenarioId) &&
        (!cursor ||
          j.createdAt < cursor.createdAt ||
          (j.createdAt === cursor.createdAt && j.id < cursor.id)),
    )
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id === b.id
          ? 0
          : a.id > b.id
            ? -1
            : 1
        : a.createdAt > b.createdAt
          ? -1
          : 1,
    );
  const page = rows.slice(0, 100),
    last = page.at(-1);
  return {
    jobs: page.map(publicMediaJob),
    nextCursor:
      rows.length > 100 && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              projectId,
              scenarioId: q.scenarioId ?? null,
              createdAt: last.createdAt,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}
