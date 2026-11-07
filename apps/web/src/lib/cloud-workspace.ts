import type { Project } from "@urban/core";

/** A connection to saved work, never a stored permission grant. Access is rechecked with the server. */
export interface CloudProjectLink {
  projectId: string;
  organizationId: string;
  version: number;
  savedRevision: string;
}

/** View-only scenario selection does not make the saved proposal dirty. All edit commands advance revisions. */
export function projectRevisionKey(project: Project): string {
  return JSON.stringify({
    name: project.name,
    updatedAt: project.updatedAt,
    scenarios: project.scenarios.map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      revision: scenario.revision,
      updatedAt: scenario.updatedAt,
    })),
    history: project.history.length,
    undone: project.undone.map((entry) => entry.id),
  });
}

export function readCloudProjectLink(
  value: unknown,
  projectId: string,
): CloudProjectLink | undefined {
  if (value === undefined || value === null) return undefined;
  const link = value as Partial<CloudProjectLink>;
  if (
    typeof link !== "object" ||
    link.projectId !== projectId ||
    typeof link.organizationId !== "string" ||
    !link.organizationId ||
    link.organizationId.length > 200 ||
    !Number.isSafeInteger(link.version) ||
    Number(link.version) < 1 ||
    typeof link.savedRevision !== "string" ||
    link.savedRevision.length > 100000
  ) {
    throw new Error(
      "The saved account connection is invalid. Existing browser records have been preserved.",
    );
  }
  return {
    projectId,
    organizationId: link.organizationId,
    version: link.version!,
    savedRevision: link.savedRevision,
  };
}
