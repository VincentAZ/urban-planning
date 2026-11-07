import { api, ApiError } from "./api";
import type {
  GisCapabilities,
  GisJob,
  GisPreview,
  GisPreviewRequest,
} from "../../../api/src/gis-jobs-types";
import type { GisInspection } from "../../../api/src/gis-types";
import type { Project } from "@urban/core";
import type { ProjectAccess } from "../../../../packages/core/src/collaboration";
export interface ImportCommitResponse {
  project: Project;
  version: number;
  organizationId: string;
  access: ProjectAccess;
}
export type {
  GisCapabilities,
  GisJob,
  GisPreview,
  GisPreviewRequest,
} from "../../../api/src/gis-jobs-types";
const base = (id: string) => `/projects/${encodeURIComponent(id)}/imports`;
export const importApi = {
  capabilities: (id: string, signal?: AbortSignal) =>
    api<GisCapabilities>(`${base(id)}/capabilities`, { signal }),
  jobs: (id: string, signal?: AbortSignal) =>
    api<{ jobs: GisJob[] }>(`${base(id)}/jobs`, { signal }),
  exportShapefile: (
    id: string,
    body: {
      scenarioId: string;
      expectedVersion: number;
      expectedRevision: number;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ) =>
    api<{ job: GisJob }>(`${base(id)}/exports/shapefile`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  upload: (
    id: string,
    file: File,
    metadata: {
      scenarioId: string;
      expectedVersion: number;
      expectedRevision: number;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ) => {
    const body = new FormData();
    body.append("metadata", JSON.stringify(metadata));
    body.append("file", file);
    return api<{ job: GisJob }>(`${base(id)}/uploads`, {
      method: "POST",
      body,
      signal,
    });
  },
  job: (id: string, jobId: string, signal?: AbortSignal) =>
    api<{ job: GisJob }>(`${base(id)}/jobs/${encodeURIComponent(jobId)}`, {
      signal,
    }),
  inspection: (id: string, uploadId: string, signal?: AbortSignal) =>
    api<{ job: GisJob; inspection?: GisInspection }>(
      `${base(id)}/uploads/${encodeURIComponent(uploadId)}`,
      { signal },
    ),
  prepare: (
    id: string,
    uploadId: string,
    body: GisPreviewRequest,
    signal?: AbortSignal,
  ) =>
    api<{ job: GisJob }>(
      `${base(id)}/uploads/${encodeURIComponent(uploadId)}/preview`,
      { method: "POST", body: JSON.stringify(body), signal },
    ),
  preview: (id: string, jobId: string, signal?: AbortSignal) =>
    api<GisPreview>(`${base(id)}/jobs/${encodeURIComponent(jobId)}/preview`, {
      signal,
    }),
  cancel: (id: string, job: GisJob) =>
    api<{ job: GisJob }>(
      `${base(id)}/jobs/${encodeURIComponent(job.id)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ expectedJobVersion: job.version }),
      },
    ),
  retry: (id: string, job: GisJob, idempotencyKey: string) =>
    api<{ job: GisJob }>(
      `${base(id)}/jobs/${encodeURIComponent(job.id)}/retry`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedJobVersion: job.version,
          idempotencyKey,
        }),
      },
    ),
  commit: (preview: GisPreview, acknowledgeWarnings: boolean) =>
    api<ImportCommitResponse>(
      `${base(preview.projectId)}/${encodeURIComponent(preview.importId)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({
          scenarioId: preview.scenarioId,
          expectedVersion: preview.expectedVersion,
          expectedRevision: preview.expectedRevision,
          previewHash: preview.previewHash,
          acknowledgeWarnings,
        }),
      },
    ),
};

/** Keep the exact body after an uncertain response, including the original
 * revision. Only an authoritative result/rejection may retire an attempt. */
export class ImportAttempts<T> {
  private attempt: { identity: string; body: T } | null = null;
  for(identity: string, create: () => T): T {
    if (this.attempt?.identity !== identity)
      this.attempt = { identity, body: create() };
    return this.attempt.body;
  }
  clear() {
    this.attempt = null;
  }
}

export function assertImportCommitReceipt(
  preview: Pick<
    GisPreview,
    "projectId" | "scenarioId" | "expectedVersion" | "expectedRevision"
  >,
  result: { project: Project; version: number },
): void {
  if (
    result.project.id !== preview.projectId ||
    result.version !== preview.expectedVersion + 1 ||
    result.project.scenarios.find((item) => item.id === preview.scenarioId)
      ?.revision !==
      preview.expectedRevision + 1
  )
    throw new Error(
      "The import may already be committed, but the server now has a different project revision. Your local draft was preserved. Reopen the saved project to review its current state.",
    );
}

export async function shapefileDownload(
  projectId: string,
  job: GisJob,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  const expected = job.result?.downloadHash,
    expectedBytes = job.result?.downloadBytes,
    cap = 100 * 1024 ** 2;
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !expectedBytes ||
    expectedBytes > cap
  )
    throw new Error(
      "The completed export has no valid bounded content identity.",
    );
  const response = await fetch(
    `/api/v1${base(projectId)}/jobs/${encodeURIComponent(job.id)}/download`,
    { credentials: "include", signal },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error?.message ??
        data.message ??
        "The retained export is unavailable.",
      response.status,
      data.error?.code ?? data.code,
    );
  }
  const declared = Number(response.headers.get("Content-Length")),
    etag = response.headers.get("ETag")?.replace(/^"|"$/g, "");
  if (
    etag !== expected ||
    (declared && (declared !== expectedBytes || declared > cap))
  ) {
    await response.body?.cancel();
    throw new Error(
      "The export response does not match the completed job’s identity and size.",
    );
  }
  if (!response.body) throw new Error("The export response is empty.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > cap || bytes > expectedBytes)
        throw new Error("The export exceeded its declared bounded size.");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (bytes !== expectedBytes)
    throw new Error("The export was incomplete; no file was downloaded.");
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
  if (actual !== expected)
    throw new Error(
      "The export failed its content-identity check; no file was downloaded.",
    );
  return {
    blob: new Blob([content], { type: "application/zip" }),
    filename: `scenario-${job.scenarioId.replace(/[^A-Za-z0-9_-]/g, "_")}-r${job.scenarioRevision}-shapefile.zip`,
  };
}
