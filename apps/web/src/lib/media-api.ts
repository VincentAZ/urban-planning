import type { MediaExportRecipe } from "@urban/core";
import type {
  MediaContext,
  MediaJob,
  MediaFile,
  MediaJobsPage,
} from "../../../api/src/media-types";
import { api, ApiError } from "./api";
export type { MediaContext, MediaJob, MediaFile, MediaJobsPage };
const base = (id: string) => `/projects/${encodeURIComponent(id)}/media`;
const jobPath = (id: string, jobId: string) =>
  `${base(id)}/jobs/${encodeURIComponent(jobId)}`;
export interface MediaStartBody {
  scenarioId: string;
  expectedVersion: number;
  expectedRevision: number;
  sceneHash: string;
  recipe: MediaExportRecipe;
  idempotencyKey: string;
}
export const mediaApi = {
  context: (id: string, scenarioId: string, signal?: AbortSignal) =>
    api<MediaContext>(
      `${base(id)}/context?scenarioId=${encodeURIComponent(scenarioId)}`,
      { signal, cache: "no-store" },
    ),
  jobs: (
    id: string,
    filter: { scenarioId: string; cursor?: string },
    signal?: AbortSignal,
  ) =>
    api<MediaJobsPage>(`${base(id)}/jobs?${new URLSearchParams(filter)}`, {
      signal,
      cache: "no-store",
    }),
  job: (id: string, jobId: string, signal?: AbortSignal) =>
    api<{ job: MediaJob }>(jobPath(id, jobId), { signal, cache: "no-store" }),
  start: (id: string, body: MediaStartBody, signal?: AbortSignal) =>
    api<{ job: MediaJob }>(`${base(id)}/jobs`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  cancel: (id: string, job: MediaJob, signal?: AbortSignal) =>
    api<{ job: MediaJob }>(`${jobPath(id, job.id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ expectedJobVersion: job.version }),
      signal,
    }),
  retry: (
    id: string,
    job: MediaJob,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) =>
    api<{ job: MediaJob }>(`${jobPath(id, job.id)}/retry`, {
      method: "POST",
      body: JSON.stringify({ expectedJobVersion: job.version, idempotencyKey }),
      signal,
    }),
};
export async function downloadMediaFile(
  projectId: string,
  jobId: string,
  file: MediaFile,
  signal?: AbortSignal,
) {
  const limit = 256 * 1024 * 1024;
  if (
    ![
      "output.png",
      "output.mp4",
      "manifest.json",
      "transcript.txt",
      "captions.vtt",
      "thumbnail.png",
      "frames.json",
    ].includes(file.name) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 1 ||
    file.bytes > limit ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw new Error("This media artifact has an invalid file identity.");
  const response = await fetch(
    `/api/v1${jobPath(projectId, jobId)}/artifacts/${encodeURIComponent(file.name)}`,
    { credentials: "include", cache: "no-store", signal },
  );
  signal?.throwIfAborted();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    signal?.throwIfAborted();
    throw new ApiError(
      data.error?.message ?? "The retained media download is unavailable.",
      response.status,
      data.error?.code,
    );
  }
  const headerHash = response.headers.get("X-Content-SHA256"),
    length = response.headers.get("Content-Length");
  if (
    headerHash !== file.sha256 ||
    (length !== null && Number(length) !== file.bytes) ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("The download does not match the retained file manifest.");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > file.bytes)
        throw new Error("The media response exceeds its retained size.");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const part of chunks) {
    buffer.set(part, offset);
    offset += part.byteLength;
  }
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  signal?.throwIfAborted();
  if (bytes !== file.bytes || hash !== file.sha256)
    throw new Error(
      "The downloaded media failed its retained size or SHA-256 check.",
    );
  return {
    blob: new Blob([buffer], { type: file.contentType }),
    filename: `urban-${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${file.name}`,
  };
}
