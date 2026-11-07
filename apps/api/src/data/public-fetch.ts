import { ApiError } from "../errors.js";

export const PUBLIC_SOURCE_AGENT =
  "UrbanPlanning/0.1 (bounded user-requested research; source attribution retained)";
export async function boundedJson(
  url: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    method?: string;
    body?: URLSearchParams;
    fetcher?: typeof fetch;
  } = {},
): Promise<unknown> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 20_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      method: options.method ?? "GET",
      body: options.body,
      signal,
      redirect: "error",
      headers: {
        "User-Agent": PUBLIC_SOURCE_AGENT,
        Accept: "application/json",
      },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      502,
      "SOURCE_UNAVAILABLE",
      "The public data service is temporarily unreachable or timed out. Try again later.",
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status === 429 ? 429 : 502,
      "SOURCE_UNAVAILABLE",
      `The public data service returned HTTP ${response.status}. Try again later.`,
    );
  const limit = options.maxBytes ?? 5_000_000;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new ApiError(
      422,
      "SOURCE_TOO_LARGE",
      "The source response exceeds this worker’s safe size limit. A regional ingestion worker is required.",
    );
  }
  if (!response.body)
    throw new ApiError(
      502,
      "SOURCE_EMPTY",
      "The source returned no response body.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ApiError(
          422,
          "SOURCE_TOO_LARGE",
          "The source response exceeds this worker’s safe size limit. No partial place was saved.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(
      502,
      "SOURCE_INVALID",
      "The source response was not complete valid JSON. No partial place was saved.",
    );
  }
}
