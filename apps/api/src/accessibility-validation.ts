import {
  canonicalJSON,
  verifyAccessibilityScenarioIntegrity,
  type Project,
  type Place,
  type AccessibilityModeEvidence,
  type AccessibilityScenario,
  type Command,
} from "@urban/core";
import type { AccessibilityArtifactHeader } from "./store-scope.js";
import { ApiError } from "./errors.js";

export function accessibilityReferences(
  value?: AccessibilityScenario,
): AccessibilityModeEvidence[] {
  return value
    ? Object.values(value.captures).filter(
        (v): v is AccessibilityModeEvidence => Boolean(v),
      )
    : [];
}
export function projectAccessibilityReferences(
  project: Project,
): AccessibilityModeEvidence[] {
  const refs = project.scenarios.flatMap((s) =>
    accessibilityReferences(s.accessibility),
  );
  for (const entry of [...project.history, ...project.undone]) {
    refs.push(
      ...accessibilityReferences(entry.before.accessibility),
      ...accessibilityReferences(entry.after.accessibility),
      ...commandAccessibilityReferences(entry.command),
    );
  }
  return refs;
}
/** A client-supplied receipt is not authority. Compare every retained mode against its immutable project artifact. */
export function validateAccessibilityReferences(
  refs: AccessibilityModeEvidence[],
  projectId: string,
  artifacts: AccessibilityArtifactHeader[],
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
      canonicalJSON(record.accessibility) !== json
    )
      throw new ApiError(
        422,
        "ACCESSIBILITY_EVIDENCE_UNVERIFIED",
        "Server-verified accessibility evidence must exactly match a completed run owned by this project. Restore a copy explicitly as imported evidence to preserve its history without claiming server verification.",
      );
  }
}
export async function verifyAccessibilityReferenceIntegrity(
  refs: AccessibilityModeEvidence[],
  place: Place,
  baselineHash: string,
) {
  const checked = new Set<string>();
  for (const value of refs) {
    const json = canonicalJSON(value);
    if (checked.has(json)) continue;
    checked.add(json);
    try {
      await verifyAccessibilityScenarioIntegrity(
        { version: 1, captures: { [value.capture.request.mode]: value } },
        place,
        baselineHash,
      );
    } catch (error) {
      throw new ApiError(
        422,
        "ACCESSIBILITY_EVIDENCE_INVALID",
        (error as Error).message,
      );
    }
  }
}
export function commandAccessibilityReferences(
  command: Command,
): AccessibilityModeEvidence[] {
  return command.type === "scenario.accessibility" && command.evidence
    ? [command.evidence]
    : [];
}

/** Legacy feature artifacts may lack scenarioId metadata; only their authoritative completed job can supply it. */
export function validateAccessibilityContext(
  refs: AccessibilityModeEvidence[],
  projectId: string,
  _scenarioId: string,
  artifacts: AccessibilityArtifactHeader[],
  jobs: import("./accessibility-jobs-types.js").AccessibilityJobRecord[],
): void {
  validateAccessibilityReferences(refs, projectId, artifacts);
  const records = new Map(
    artifacts.filter((a) => a.projectId === projectId).map((a) => [a.jobId, a]),
  );
  const capturedJobs = new Map(
    jobs.filter((j) => j.projectId === projectId).map((j) => [j.id, j]),
  );
  for (const evidence of refs) {
    if (evidence.origin === "imported") continue;
    const artifact = records.get(evidence.receipt.jobId),
      job = capturedJobs.get(evidence.receipt.jobId);
    if (
      !artifact ||
      !job ||
      job.status !== "completed" ||
      job.result?.artifactId !== artifact.id ||
      job.result.captureHash !== evidence.captureHash ||
      (artifact.scenarioId !== undefined &&
        artifact.scenarioId !== job.scenarioId)
    )
      throw new ApiError(
        422,
        "ACCESSIBILITY_SCENARIO_MISMATCH",
        "Server-run accessibility evidence must retain its exact original completed project job and producer metadata.",
      );
  }
}
export function validateProjectAccessibilityContexts(
  project: Project,
  artifacts: AccessibilityArtifactHeader[],
  jobs: import("./accessibility-jobs-types.js").AccessibilityJobRecord[],
): void {
  // Captured-network context can be reused within the same immutable project;
  // build indexes once even when undo history repeats the same mode evidence.
  validateAccessibilityContext(
    projectAccessibilityReferences(project),
    project.id,
    "",
    artifacts,
    jobs,
  );
}
