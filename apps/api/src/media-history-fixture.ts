/** TEST ONLY: duplicated historical metadata for pagination QA, not additional
 * native executions. Reuses one actual completed archive without modifying it.
 * Invoke only with the isolated harness operator store, never through HTTP. */
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";

export async function seedMediaHistoryFixture(
  store: Store,
  completedJobId: string,
  count = 105,
): Promise<{ projectId: string; scenarioId: string; appended: number }> {
  if (!Number.isSafeInteger(count) || count < 101 || count > 200)
    throw new Error("Media history fixture requires 101–200 metadata rows.");
  return store.transaction((state) => {
    const job = state.mediaJobs.find((j) => j.id === completedJobId);
    const artifact = state.mediaArtifacts.find(
      (a) => a.id === job?.result?.artifactId,
    );
    if (
      !job ||
      job.status !== "completed" ||
      !job.result ||
      !artifact ||
      artifact.jobId !== job.id
    )
      throw new Error(
        "Media history fixture requires one completed job and its exact artifact.",
      );
    if (state.mediaJobs.length + count > 10000)
      throw new Error(
        "Media history fixture would exceed retained job capacity.",
      );
    for (let index = 0; index < count; index++) {
      const jobId = randomUUID(),
        artifactId = randomUUID();
      const copy = structuredClone(job);
      copy.id = jobId;
      copy.createdAt = new Date(
        Date.parse(job.createdAt) - (index + 1) * 1000,
      ).toISOString();
      copy.idempotencyKey = `test-only-history-metadata-${jobId}`;
      copy.requestKeys = [copy.idempotencyKey];
      copy.result = { ...copy.result!, artifactId };
      state.mediaJobs.push(copy);
      state.mediaArtifacts.push({
        ...structuredClone(artifact),
        id: artifactId,
        jobId,
      });
    }
    return {
      projectId: job.projectId,
      scenarioId: job.scenarioId,
      appended: count,
    };
  });
}
