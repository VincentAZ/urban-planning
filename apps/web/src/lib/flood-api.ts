import {
  floodStudyAreaHash,
  MAX_FLOOD_DATASET_BYTES,
  type FloodDataset,
  type Place,
} from "@urban/core";
import { api } from "./api";
import { validateFloodInWorker } from "./flood-validation";
import type { FloodCatalogChoice } from "../../../api/src/flood-types";
export type { FloodCatalogChoice } from "../../../api/src/flood-types";
export async function floodCatalog(
  place: Place,
  signal: AbortSignal,
): Promise<FloodCatalogChoice[]> {
  const hash = await floodStudyAreaHash(place);
  signal.throwIfAborted();
  const result = await api<{ datasets: FloodCatalogChoice[] }>(
    `/flood/catalog?studyAreaHash=${encodeURIComponent(hash)}`,
    { signal },
  );
  return result.datasets;
}
export async function fetchFloodDataset(
  hash: string,
  place: Place,
  signal: AbortSignal,
): Promise<FloodDataset> {
  const response = await fetch(
    `/api/v1/flood/datasets/${encodeURIComponent(hash)}`,
    { signal, credentials: "include" },
  );
  if (!response.ok)
    throw new Error(
      "This captured flood map is unavailable. Your existing project has not changed.",
    );
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > MAX_FLOOD_DATASET_BYTES + 512) {
    await response.body?.cancel();
    throw new Error("The flood map exceeds the supported size.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The flood map response was empty.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_FLOOD_DATASET_BYTES + 512)
        throw new Error("The flood map exceeds the supported size.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  const envelope = JSON.parse(new TextDecoder().decode(body)) as {
    datasetHash: string;
    dataset: FloodDataset;
  };
  if (envelope.datasetHash !== hash)
    throw new Error("The flood map identity does not match the request.");
  const dataset = envelope.dataset;
  signal.throwIfAborted();
  return validateFloodInWorker(
    { type: "dataset", dataset, place, expectedHash: hash },
    signal,
  );
}
