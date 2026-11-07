import type { AccessibilityRequest } from "@urban/core";
import type {
  AccessibilityAdoptResponse,
  AccessibilityCapabilities,
  AccessibilityJob,
  AccessibilityJobResult,
} from "../../../api/src/accessibility-jobs-types";
import { api, ApiError } from "./api";

export type {
  AccessibilityAdoptResponse,
  AccessibilityCapabilities,
  AccessibilityJob,
  AccessibilityJobResult,
};
export interface AccessibilityStartBody {
  scenarioId: string;
  expectedVersion: number;
  expectedRevision: number;
  idempotencyKey: string;
  request: AccessibilityRequest;
}
const path = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/accessibility`;
const jobPath = (projectId: string, jobId: string) =>
  `${path(projectId)}/jobs/${encodeURIComponent(jobId)}`;
export const accessibilityApi = {
  capabilities: (projectId: string, signal?: AbortSignal) =>
    api<AccessibilityCapabilities>(`${path(projectId)}/capabilities`, {
      signal,
      cache: "no-store",
    }),
  jobs: (projectId: string, signal?: AbortSignal) =>
    api<{ jobs: AccessibilityJob[] }>(`${path(projectId)}/jobs`, {
      signal,
      cache: "no-store",
    }),
  job: (projectId: string, jobId: string, signal?: AbortSignal) =>
    api<{ job: AccessibilityJob }>(jobPath(projectId, jobId), {
      signal,
      cache: "no-store",
    }),
  result: (projectId: string, jobId: string, signal?: AbortSignal) =>
    api<AccessibilityJobResult>(`${jobPath(projectId, jobId)}/result`, {
      signal,
      cache: "no-store",
    }),
  start: (
    projectId: string,
    body: AccessibilityStartBody,
    signal?: AbortSignal,
  ) =>
    api<{ job: AccessibilityJob }>(`${path(projectId)}/jobs`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  cancel: (projectId: string, job: AccessibilityJob, signal?: AbortSignal) =>
    api<{ job: AccessibilityJob }>(`${jobPath(projectId, job.id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ expectedJobVersion: job.version }),
      signal,
    }),
  retry: (
    projectId: string,
    job: AccessibilityJob,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) =>
    api<{ job: AccessibilityJob }>(`${jobPath(projectId, job.id)}/retry`, {
      method: "POST",
      body: JSON.stringify({ expectedJobVersion: job.version, idempotencyKey }),
      signal,
    }),
  adopt: (
    projectId: string,
    job: AccessibilityJob,
    body: {
      scenarioId: string;
      expectedVersion: number;
      expectedRevision: number;
      inputHash: string;
      resultHash: string;
    },
    signal?: AbortSignal,
  ) =>
    api<AccessibilityAdoptResponse>(`${jobPath(projectId, job.id)}/adopt`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
};

/** Explicit user download only. The workplace source pack is never requested by the workbench. */
export async function accessibilityArtifact(
  projectId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; sha256: string }> {
  const response = await fetch(`/api/v1${jobPath(projectId, jobId)}/artifact`, {
    credentials: "include",
    signal,
    cache: "no-store",
  });
  signal?.throwIfAborted();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error?.message ??
        data.message ??
        "The full routing evidence is unavailable. The saved summary is unchanged.",
      response.status,
      data.error?.code ?? data.code,
    );
  }
  const cap = 64 * 1024 * 1024;
  const sha256 = response.headers.get("X-Content-SHA256");
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    await response.body?.cancel();
    throw new Error(
      "The routing evidence response has no valid content identity. No file was downloaded.",
    );
  }
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    throw new Error("The routing evidence exceeds the 64 MiB download limit.");
  }
  if (!response.body)
    throw new Error("The routing evidence response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal?.aborted)
        throw new DOMException("The download was cancelled.", "AbortError");
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > cap)
        throw new Error(
          "The routing evidence exceeds the 64 MiB download limit.",
        );
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const actual = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  signal?.throwIfAborted();
  if (actual !== sha256)
    throw new Error(
      "The routing evidence does not match its declared content identity. No file was downloaded.",
    );
  return {
    blob: new Blob([content], { type: "application/json" }),
    filename: `accessibility-${jobId.replace(/[^A-Za-z0-9_-]/g, "_")}-routing-evidence.json`,
    sha256,
  };
}
