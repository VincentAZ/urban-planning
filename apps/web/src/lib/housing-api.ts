import {
  housingIncomeLimitPackHash,
  validateHousingIncomeLimitPack,
  type HousingIncomeLimitPack,
} from "@urban/core";
import { api } from "./api";
import type { HousingCatalogResponse } from "../../../api/src/housing-types";
export type {
  HousingCatalogChoice,
  HousingCatalogResponse,
} from "../../../api/src/housing-types";
export function fetchHousingCatalog(
  filters: { q: string; state: string; county: string },
  cursor: string | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value.trim()) query.set(key, value.trim());
  if (cursor) query.set("cursor", cursor);
  return api<HousingCatalogResponse>(`/housing/catalog?${query}`, { signal });
}
export async function fetchHousingPack(
  hash: string,
  signal: AbortSignal,
): Promise<HousingIncomeLimitPack> {
  const response = await fetch(
    `/api/v1/housing/packs/${encodeURIComponent(hash)}`,
    { signal, credentials: "include" },
  );
  if (!response.ok)
    throw new Error(
      "This published income-limit area is unavailable. Your draft is unchanged.",
    );
  const limit = 512 * 1024 + 512;
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body?.cancel();
    throw new Error("The income-limit pack exceeds the supported size.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The income-limit pack response was empty.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > limit)
        throw new Error("The income-limit pack exceeds the supported size.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  const envelope = JSON.parse(new TextDecoder().decode(data)) as {
    packHash: string;
    pack: unknown;
  };
  const pack = validateHousingIncomeLimitPack(envelope.pack);
  if (envelope.packHash !== hash || housingIncomeLimitPackHash(pack) !== hash)
    throw new Error(
      "The published income-limit pack does not match its requested identity.",
    );
  signal.throwIfAborted();
  return pack;
}
