import {
  canonicalJSON,
  verifyTrafficScenario,
  type Command,
  type Place,
  type Project,
  type Scenario,
  type TrafficScenario,
} from "@urban/core";
import { ApiError } from "../errors.js";

export interface TrafficArtifactAuthority {
  id: string;
  projectId: string;
  jobId: string;
  traffic: TrafficScenario;
}
export function projectTrafficReferences(project: Project): TrafficScenario[] {
  return [
    ...project.scenarios.flatMap((scenario) =>
      scenario.traffic ? [scenario.traffic] : [],
    ),
    ...[...project.history, ...project.undone].flatMap((entry) => [
      ...(entry.before.traffic ? [entry.before.traffic] : []),
      ...(entry.after.traffic ? [entry.after.traffic] : []),
      ...commandTrafficReferences(entry.command),
    ]),
  ];
}
export function commandTrafficReferences(command: Command): TrafficScenario[] {
  return command.type === "scenario.traffic" && command.traffic
    ? [command.traffic]
    : [];
}
/** A client-supplied hash/receipt never establishes that a native run was admitted by this project. */
export function validateTrafficReferences(
  values: TrafficScenario[],
  projectId: string,
  artifacts: TrafficArtifactAuthority[],
) {
  const retained = new Map(
    artifacts
      .filter((artifact) => artifact.projectId === projectId)
      .map((artifact) => [artifact.id, artifact]),
  );
  for (const value of values) {
    if (value.origin === "imported") continue;
    const authority = retained.get(value.receipt.captureId);
    if (
      value.receipt.projectId !== projectId ||
      !authority ||
      authority.jobId !== value.receipt.jobId ||
      canonicalJSON(authority.traffic) !== canonicalJSON(value)
    )
      throw new ApiError(
        422,
        "TRAFFIC_EVIDENCE_UNVERIFIED",
        "Server-run traffic evidence must exactly match a retained completed run owned by this project. Restore external captures as imported evidence to keep their history without claiming server execution.",
      );
  }
}
export async function verifyTrafficReferenceIntegrity(
  values: TrafficScenario[],
  place: Place,
  baselineHash: string,
) {
  const checked = new Set<string>();
  for (const value of values) {
    const identity = canonicalJSON(value);
    if (checked.has(identity)) continue;
    checked.add(identity);
    try {
      await verifyTrafficScenario(value, place, baselineHash);
    } catch (error) {
      throw new ApiError(
        422,
        "TRAFFIC_EVIDENCE_INVALID",
        (error as Error).message,
      );
    }
  }
}
/** Native, commute and planning citations retain separate permission namespaces. */
function sourceDecisions(value: TrafficScenario) {
  const planning = value.capture.proposal.planningRoadMapping.correspondence;
  return [
    ...value.capture.sources.map((source) => ({
      key: `native:${source.id}`,
      source,
      decision: source.rights,
      requiresDeclaration: false,
    })),
    ...(value.capture.originalDemand.commute?.sources ?? []).map((source) => ({
      key: `commute:${source.id}`,
      source,
      decision: source.rights,
      requiresDeclaration: false,
    })),
    ...(planning?.sources ?? []).map((source) => ({
      key: `planning:${source.id}`,
      source,
      decision: planning!.sourceDeclarations.find(
        (declaration) => declaration.sourceId === source.id,
      ),
      requiresDeclaration: true,
    })),
  ];
}
export function validateTrafficRightsTransition(
  previous: Project,
  next: Project,
) {
  const prior = projectTrafficReferences(previous)
    .flatMap(sourceDecisions)
    .filter((entry) => entry.decision);
  const retained = new Set(
    projectTrafficReferences(next)
      .flatMap(sourceDecisions)
      .filter((entry) => entry.decision)
      .map((entry) => canonicalJSON([entry.key, entry.decision])),
  );
  const explicitlyReplaced = new Set(
    next.scenarios
      .flatMap((scenario) =>
        scenario.traffic ? sourceDecisions(scenario.traffic) : [],
      )
      .filter((entry) => entry.decision)
      .map((entry) => entry.key),
  );
  if (
    prior.some(
      (entry) =>
        !retained.has(canonicalJSON([entry.key, entry.decision])) &&
        !explicitlyReplaced.has(entry.key),
    )
  )
    throw new ApiError(
      422,
      "TRAFFIC_SOURCE_RIGHTS_REMOVED",
      "Previously retained traffic or planning-correspondence permissions cannot be erased by a full-project save. Retain their declarations or record an explicit replacement in the same capture source namespace.",
    );
}
export function assertTrafficPublication(
  scenario: Scenario,
  project?: Project,
) {
  const formerlyPrivate = new Set(
    project
      ? projectTrafficReferences(project)
          .flatMap(sourceDecisions)
          .filter(
            (entry) => entry.decision && !entry.decision.publicRedistribution,
          )
          .map((entry) => entry.key)
      : [],
  );
  const restricted = (
    scenario.traffic ? sourceDecisions(scenario.traffic) : []
  ).filter((entry) =>
    entry.decision
      ? !entry.decision.publicRedistribution
      : entry.requiresDeclaration ||
        entry.source.kind === "user-supplied" ||
        !!entry.source.import ||
        formerlyPrivate.has(entry.key),
  );
  if (restricted.length)
    throw new ApiError(
      422,
      "TRAFFIC_PUBLICATION_RESTRICTED",
      "This traffic experiment includes privately supplied traffic or planning-correspondence evidence without a public redistribution declaration. Confirm its source permissions or remove the traffic capture before publishing.",
    );
}
