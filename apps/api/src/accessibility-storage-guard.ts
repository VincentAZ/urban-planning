import { canonicalJSON } from "@urban/core";
import type { StoredRow } from "./storage-core.js";
const field = (v: unknown, key: string): unknown =>
  v && typeof v === "object" && Object.hasOwn(v, key)
    ? (v as Record<string, unknown>)[key]
    : undefined;
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const modes = (v: unknown): unknown[] => {
  const c = field(v, "captures");
  return c && typeof c === "object" ? Object.values(c) : [];
};
/** SQLite parity: forged server receipts cannot enter current, undo, command or publication content. */
export function assertStoredAccessibilityAdmission(
  row: StoredRow,
  resolve: (jobId: string) => {
    artifact?: Record<string, unknown>;
    job?: Record<string, unknown>;
  },
): void {
  if (row.payload === undefined) return;
  let values: { value: unknown; scenarioId: unknown }[] = [];
  const captureScenario = (scenario: unknown) =>
    modes(field(scenario, "accessibility")).map((value) => ({
      value,
      scenarioId: field(scenario, "id"),
    }));
  if (row.collection === "projects") {
    const p = field(row.payload, "project");
    values = array(field(p, "scenarios")).flatMap(captureScenario);
    for (const e of [
      ...array(field(p, "history")),
      ...array(field(p, "undone")),
    ]) {
      values.push(
        ...captureScenario(field(e, "before")),
        ...captureScenario(field(e, "after")),
      );
      if (field(field(e, "command"), "type") === "scenario.accessibility")
        values.push({
          value: field(field(e, "command"), "evidence"),
          scenarioId: field(field(e, "after"), "id"),
        });
    }
  } else if (row.collection === "published")
    values = captureScenario(field(row.payload, "scenario"));
  for (const { value, scenarioId } of values) {
    if (value == null) continue;
    if (field(field(value, "binding"), "baselineHash") !== row.baselineHash)
      throw new Error(
        "Accessibility evidence must retain its exact captured baseline.",
      );
    if (field(value, "origin") === "imported") continue;
    const receipt = field(value, "receipt"),
      jobId = field(receipt, "jobId"),
      projectId =
        row.collection === "projects" ? row.id : row.indexes.projectId;
    const a = typeof jobId === "string" ? resolve(jobId) : undefined,
      artifact = a?.artifact,
      job = a?.job;
    if (
      field(value, "origin") === "server-run" &&
      artifact &&
      job &&
      artifact.projectId === projectId &&
      artifact.organizationId === row.indexes.organizationId &&
      artifact.jobId === jobId &&
      job.projectId === projectId &&
      job.organizationId === artifact.organizationId &&
      job.status === "completed" &&
      (artifact.scenarioId === undefined ||
        artifact.scenarioId === job.scenarioId) &&
      field(job.result, "artifactId") === artifact.id &&
      field(job.result, "captureHash") === field(value, "captureHash") &&
      field(receipt, "projectId") === projectId &&
      canonicalJSON(artifact.accessibility) === canonicalJSON(value)
    )
      continue;
    throw new Error(
      "Accessibility server-run evidence requires its exact project-owned immutable completed artifact; imported evidence remains unverified.",
    );
  }
}
