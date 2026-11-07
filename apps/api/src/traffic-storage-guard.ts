import { canonicalJSON } from "@urban/core";
import type { StoredRow } from "./storage-core.js";
const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
/** Resolve server authority from an immutable project-owned completed job. Operator migrations bypass explicitly. */
export function assertStoredTrafficAdmission(
  row: Pick<StoredRow, "collection" | "payload"> &
    Partial<Pick<StoredRow, "id" | "header" | "baselineHash" | "indexes">>,
  resolve?: (
    captureId: string,
    jobId: string,
  ) => { artifact?: Record<string, unknown>; job?: Record<string, unknown> },
): void {
  if (row.payload === undefined) return; // Header-only patches cannot introduce captured content.
  let values: unknown[] = [];
  if (row.collection === "projects") {
    const project = field(row.payload, "project");
    values = array(field(project, "scenarios")).map((s) => field(s, "traffic"));
    for (const entry of [
      ...array(field(project, "history")),
      ...array(field(project, "undone")),
    ])
      for (const key of ["before", "after", "command"])
        values.push(field(field(entry, key), "traffic"));
  } else if (row.collection === "published")
    values = [field(field(row.payload, "scenario"), "traffic")];
  for (const value of values)
    if (
      value !== undefined &&
      value !== null &&
      field(value, "origin") !== "imported"
    ) {
      const receipt = field(value, "receipt"),
        projectId =
          row.collection === "projects"
            ? row.id
            : field(row.header, "projectId");
      const captureId = field(receipt, "captureId"),
        jobId = field(receipt, "jobId");
      const authority =
        typeof captureId === "string" && typeof jobId === "string"
          ? resolve?.(captureId, jobId)
          : undefined;
      const artifact = authority?.artifact,
        job = authority?.job;
      if (
        field(value, "origin") === "server-run" &&
        artifact &&
        job &&
        artifact.projectId === projectId &&
        artifact.organizationId === row.indexes?.organizationId &&
        artifact.jobId === jobId &&
        job.projectId === projectId &&
        job.organizationId === artifact.organizationId &&
        job.status === "completed" &&
        field(job.result, "artifactId") === captureId &&
        field(job.result, "captureHash") === field(value, "captureHash") &&
        field(receipt, "projectId") === projectId &&
        field(field(value, "binding"), "baselineHash") === row.baselineHash &&
        canonicalJSON(artifact.traffic) === canonicalJSON(value)
      )
        continue;
      throw new Error(
        "Traffic server-run admission requires a completed immutable authority registry; retain external evidence as imported.",
      );
    }
}
