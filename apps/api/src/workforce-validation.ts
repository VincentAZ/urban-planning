import {
  canonicalJSON,
  verifyWorkforceScenario,
  type Project,
  type Place,
  type WorkforceScenario,
  type Command,
} from "@urban/core";
import type { WorkforceArtifactHeader } from "./store-scope.js";
import { ApiError } from "./errors.js";

export function projectWorkforceReferences(
  project: Project,
): WorkforceScenario[] {
  const refs = project.scenarios.flatMap((s) =>
    s.workforce ? [s.workforce] : [],
  );
  for (const entry of [...project.history, ...project.undone]) {
    for (const scenario of [entry.before, entry.after])
      if (scenario.workforce) refs.push(scenario.workforce);
    if (entry.command.type === "scenario.workforce" && entry.command.workforce)
      refs.push(entry.command.workforce);
  }
  return refs;
}
/** Hashes alone are not authority: compare the entire compact evidence to a project-owned immutable server record. */
export function validateWorkforceReferences(
  refs: WorkforceScenario[],
  projectId: string,
  artifacts: WorkforceArtifactHeader[],
) {
  const byJob = new Map(
    artifacts.filter((a) => a.projectId === projectId).map((a) => [a.jobId, a]),
  );
  const seen = new Set<string>();
  for (const value of refs) {
    if (value.origin === "imported") continue;
    const json = canonicalJSON(value);
    if (seen.has(json)) continue;
    seen.add(json);
    const record = byJob.get(value.receipt.jobId);
    if (
      value.receipt.projectId !== projectId ||
      !record ||
      canonicalJSON(record.workforce) !== json
    )
      throw new ApiError(
        422,
        "WORKFORCE_EVIDENCE_UNVERIFIED",
        "Server-verified workforce evidence must exactly match a completed run owned by this project. Restore a copy explicitly as imported evidence to preserve its history without claiming server verification.",
      );
  }
}
export async function verifyWorkforceReferenceIntegrity(
  refs: WorkforceScenario[],
  place: Place,
  baselineHash: string,
) {
  const checked = new Set<string>();
  for (const value of refs) {
    const json = canonicalJSON(value);
    if (checked.has(json)) continue;
    checked.add(json);
    try {
      await verifyWorkforceScenario(value, place, baselineHash);
    } catch (error) {
      throw new ApiError(
        422,
        "WORKFORCE_EVIDENCE_INVALID",
        (error as Error).message,
      );
    }
  }
}
export function commandWorkforceReferences(command: Command) {
  return command.type === "scenario.workforce" && command.workforce
    ? [command.workforce]
    : [];
}
