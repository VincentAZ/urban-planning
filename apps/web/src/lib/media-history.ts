import type { MediaJob } from "./media-api";

/** Merge immutable keyset pages without downgrading a job updated by live polling. */
export function mergeMediaHistory(
  current: readonly MediaJob[],
  incoming: readonly MediaJob[],
  projectId: string,
  scenarioId: string,
): MediaJob[] {
  const merged = new Map<string, MediaJob>();
  for (const job of [...current, ...incoming]) {
    if (job.projectId !== projectId || job.scenarioId !== scenarioId)
      throw new Error(
        "The returned media history belongs to a different project or scenario. Reload its saved scene.",
      );
    const previous = merged.get(job.id);
    if (!previous || job.version > previous.version) merged.set(job.id, job);
  }
  return [...merged.values()].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id === b.id
        ? 0
        : a.id < b.id
          ? 1
          : -1
      : a.createdAt < b.createdAt
        ? 1
        : -1,
  );
}
