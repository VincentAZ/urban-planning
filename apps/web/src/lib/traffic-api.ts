import type { TrafficExperimentRequest } from "../../../api/src/traffic/experiment";
import type {
  TrafficAdoptResponse,
  TrafficCapabilities,
  TrafficConfigurationHeader,
  TrafficConfigurationRecord,
  TrafficContext,
  TrafficJob,
  TrafficJobResult,
  TrafficUploadBinding,
} from "../../../api/src/traffic/jobs-types";
import type {
  TrafficDraftValue,
  TrafficSourceDeclaration,
} from "./traffic-draft";
import type { TrafficCSVMapping } from "@urban/core";
import { api, ApiError } from "./api";

export type {
  TrafficAdoptResponse,
  TrafficCapabilities,
  TrafficConfigurationHeader,
  TrafficConfigurationRecord,
  TrafficContext,
  TrafficJob,
  TrafficJobResult,
  TrafficExperimentRequest,
};
export interface TrafficUpload {
  id: string;
  filename: string;
  sourceId: string;
  sha256: string;
  bytes: number;
  rows: number;
}
export interface TrafficSaveBody {
  scenarioId: string;
  preparedId?: string;
  expectedVersion: number;
  expectedRevision: number;
  expectedConfigurationId: string | null;
  idempotencyKey: string;
  request: TrafficExperimentRequest;
  sourceDeclarations: TrafficSourceDeclaration[];
  uploadBindings: (Omit<TrafficUploadBinding, "period"> & {
    period?: TrafficUploadBinding["period"];
  })[];
  mappingReviews: TrafficDraftValue["mappingReviews"];
  planningRoadReviews?: TrafficDraftValue["planningRoadReviews"];
  planningSourceDeclarations?: TrafficDraftValue["planningSourceDeclarations"];
  scopeAcknowledged: true;
}
export interface TrafficStartBody {
  configurationId: string;
  expectedVersion: number;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface TrafficFile {
  name: string;
  sha256: string;
  bytes: number;
}
const path = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/traffic`;
const jobPath = (projectId: string, jobId: string) =>
  `${path(projectId)}/jobs/${encodeURIComponent(jobId)}`;
const scenarioQuery = (scenarioId: string) =>
  `?scenarioId=${encodeURIComponent(scenarioId)}`;
export const trafficApi = {
  capabilities: (projectId: string, scenarioId: string, signal?: AbortSignal) =>
    api<TrafficCapabilities>(
      `${path(projectId)}/capabilities${scenarioQuery(scenarioId)}`,
      { signal },
    ),
  context: (
    projectId: string,
    scenarioId: string,
    signal?: AbortSignal,
    preparedId?: string,
  ) =>
    api<TrafficContext>(
      `${path(projectId)}/context${scenarioQuery(scenarioId)}${preparedId ? `&preparedId=${encodeURIComponent(preparedId)}` : ""}`,
      { signal },
    ),
  configurations: (
    projectId: string,
    scenarioId: string,
    signal?: AbortSignal,
  ) =>
    api<{ configurations: TrafficConfigurationHeader[] }>(
      `${path(projectId)}/configurations${scenarioQuery(scenarioId)}`,
      { signal },
    ),
  save: (projectId: string, body: TrafficSaveBody, signal?: AbortSignal) =>
    api<{ configuration: TrafficConfigurationRecord }>(
      `${path(projectId)}/configurations`,
      { method: "POST", body: JSON.stringify(body), signal },
    ),
  upload: (
    projectId: string,
    file: File,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => {
    const body = new FormData();
    body.append("idempotencyKey", idempotencyKey);
    body.append("file", file, file.name);
    return api<{ upload: TrafficUpload }>(`${path(projectId)}/uploads`, {
      method: "POST",
      body,
      signal,
    });
  },
  jobs: (projectId: string, signal?: AbortSignal) =>
    api<{ jobs: TrafficJob[] }>(`${path(projectId)}/jobs`, { signal }),
  job: (projectId: string, jobId: string, signal?: AbortSignal) =>
    api<{ job: TrafficJob }>(jobPath(projectId, jobId), { signal }),
  start: (projectId: string, body: TrafficStartBody, signal?: AbortSignal) =>
    api<{ job: TrafficJob }>(`${path(projectId)}/jobs`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  cancel: (projectId: string, job: TrafficJob, signal?: AbortSignal) =>
    api<{ job: TrafficJob }>(`${jobPath(projectId, job.id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ expectedJobVersion: job.version }),
      signal,
    }),
  retry: (
    projectId: string,
    jobId: string,
    body: { expectedJobVersion: number; idempotencyKey: string },
    signal?: AbortSignal,
  ) =>
    api<{ job: TrafficJob }>(`${jobPath(projectId, jobId)}/retry`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  result: (projectId: string, jobId: string, signal?: AbortSignal) =>
    api<TrafficJobResult>(`${jobPath(projectId, jobId)}/result`, { signal }),
  adopt: (
    projectId: string,
    jobId: string,
    body: {
      scenarioId: string;
      expectedVersion: number;
      expectedRevision: number;
    },
    signal?: AbortSignal,
  ) =>
    api<TrafficAdoptResponse>(`${jobPath(projectId, jobId)}/adopt`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  files: (projectId: string, jobId: string, signal?: AbortSignal) =>
    api<{ files: TrafficFile[] }>(`${jobPath(projectId, jobId)}/files`, {
      signal,
    }),
};

/** Explicit, bounded download from a server-verified manifest, without parsing large native files. */
export async function trafficFile(
  projectId: string,
  jobId: string,
  file: TrafficFile,
  signal?: AbortSignal,
): Promise<Blob> {
  return verifiedTrafficFile(
    `/api/v1${jobPath(projectId, jobId)}/files/${encodeURIComponent(file.name)}`,
    file,
    256 * 1024 ** 2,
    signal,
  );
}

export async function trafficCommuteFile(
  projectId: string,
  preparedId: string,
  presetId: string,
  file: { sha256: string; bytes: number },
  signal?: AbortSignal,
): Promise<Blob> {
  return verifiedTrafficFile(
    `/api/v1${path(projectId)}/commute/${encodeURIComponent(presetId)}/evidence?preparedId=${encodeURIComponent(preparedId)}`,
    { ...file, name: "commute-evidence.json" },
    16 * 1024 ** 2,
    signal,
  );
}

async function verifiedTrafficFile(
  url: string,
  file: { name: string; sha256: string; bytes: number },
  cap: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(file.name) ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.bytes > cap
  )
    throw new Error(
      `The retained file identity is invalid or exceeds the ${cap / 1024 ** 2} MiB limit.`,
    );
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error?.message ??
        data.message ??
        "The retained traffic file is unavailable.",
      response.status,
      data.error?.code ?? data.code,
    );
  }
  const header = response.headers.get("X-Content-SHA256");
  if (
    header !== file.sha256 ||
    (response.headers.has("Content-Length") &&
      Number(response.headers.get("Content-Length")) !== file.bytes)
  ) {
    await response.body?.cancel();
    throw new Error(
      "The file response does not match its retained identity. No download was created.",
    );
  }
  if (!response.body) throw new Error("The traffic file response is empty.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      if (signal?.aborted)
        throw new DOMException("Download cancelled", "AbortError");
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > file.bytes || length > cap)
        throw new Error("The traffic file exceeds its declared byte count.");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (length !== file.bytes)
    throw new Error(
      "The traffic file was incomplete. No download was created.",
    );
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== file.sha256)
    throw new Error(
      "The traffic file failed its integrity check. No download was created.",
    );
  return new Blob([content], {
    type: file.name.endsWith(".json")
      ? "application/json"
      : file.name.endsWith(".xml")
        ? "application/xml"
        : "application/octet-stream",
  });
}
