import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  downloadMediaFile,
  mediaApi,
  type MediaFile,
  type MediaJob,
  type MediaStartBody,
} from "./media-api";
const fetchMock = vi.fn<typeof fetch>();
const data = new TextEncoder().encode("retained frame evidence");
const sha256 = createHash("sha256").update(data).digest("hex");
const file: MediaFile = {
  name: "frames.json",
  sha256,
  bytes: data.length,
  contentType: "application/json",
};
function response(
  bytes: Uint8Array = data,
  headers: Record<string, string> = {},
) {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "X-Content-SHA256": sha256,
      "Content-Length": String(file.bytes),
      ...headers,
    },
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it("keeps scenario and opaque cursor on every private history page and forwards cancellation", async () => {
  const signal = new AbortController().signal;
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ jobs: [], nextCursor: "opaque/+=" })),
  );
  await mediaApi.jobs("project/id", { scenarioId: "scenario/id" }, signal);
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ jobs: [], nextCursor: null })),
  );
  await mediaApi.jobs(
    "project/id",
    { scenarioId: "scenario/id", cursor: "opaque/+=" },
    signal,
  );
  const paths = fetchMock.mock.calls.map(
    ([path]) => new URL(String(path), "http://test"),
  );
  expect(paths[0].pathname).toBe("/api/v1/projects/project%2Fid/media/jobs");
  expect(paths.map((path) => path.searchParams.get("scenarioId"))).toEqual([
    "scenario/id",
    "scenario/id",
  ]);
  expect(paths[1].searchParams.get("cursor")).toBe("opaque/+=");
  for (const [, init] of fetchMock.mock.calls)
    expect(init).toMatchObject({
      credentials: "include",
      cache: "no-store",
      signal,
    });
});
it("downloads only the exact authorized manifest file, retaining credentials, cancellation and no-store", async () => {
  fetchMock.mockResolvedValue(response());
  const controller = new AbortController();
  const result = await downloadMediaFile(
    "project/id",
    "job/id",
    file,
    controller.signal,
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/projects/project%2Fid/media/jobs/job%2Fid/artifacts/frames.json",
    { credentials: "include", cache: "no-store", signal: controller.signal },
  );
  expect(await result.blob.text()).toBe("retained frame evidence");
  expect(result.filename).toBe("urban-job_id-frames.json");
});
it("rejects input scene/private paths and unreasonable declared sizes before requesting bytes", async () => {
  for (const name of ["scene.json", "recipe.json", "../output.png"])
    await expect(
      downloadMediaFile("p", "j", { ...file, name }),
    ).rejects.toThrow("invalid file identity");
  await expect(
    downloadMediaFile("p", "j", { ...file, bytes: 256 * 1024 ** 2 + 1 }),
  ).rejects.toThrow("invalid file identity");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("rejects changed header, exact-size tampering and missing bytes without making a downloadable blob", async () => {
  fetchMock.mockResolvedValueOnce(
    response(data, { "X-Content-SHA256": "0".repeat(64) }),
  );
  await expect(downloadMediaFile("p", "j", file)).rejects.toThrow(
    "retained file manifest",
  );
  fetchMock.mockResolvedValueOnce(
    response(new Uint8Array(data.length).fill(1)),
  );
  await expect(downloadMediaFile("p", "j", file)).rejects.toThrow(
    "SHA-256 check",
  );
  fetchMock.mockResolvedValueOnce(response(data.slice(1)));
  await expect(downloadMediaFile("p", "j", file)).rejects.toThrow(
    "retained size",
  );
});
it("cancels a stream immediately when it exceeds the declared retained size", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(file.bytes + 1));
    },
    cancel,
  });
  fetchMock.mockResolvedValue(
    new Response(stream, { headers: { "X-Content-SHA256": sha256 } }),
  );
  await expect(downloadMediaFile("p", "j", file)).rejects.toThrow(
    "exceeds its retained size",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
it("does not accept a late successful body or authentication error after scope cancellation", async () => {
  const controller = new AbortController();
  fetchMock.mockImplementationOnce(async () => {
    controller.abort();
    return response();
  });
  await expect(
    downloadMediaFile("p", "j", file, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const late = new AbortController();
  const error = new Response("{}", { status: 403 });
  vi.spyOn(error, "json").mockImplementation(async () => {
    late.abort();
    return { error: { message: "private old scope", code: "FORBIDDEN" } };
  });
  fetchMock.mockResolvedValueOnce(error);
  await expect(
    downloadMediaFile("p", "j", file, late.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});
it("keeps immutable scene/version and explicit retry guards in mutation bodies without automatic replays", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ job: {} }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  const body = {
    scenarioId: "s",
    expectedVersion: 4,
    expectedRevision: 9,
    sceneHash: "a".repeat(64),
    recipe: {},
    idempotencyKey: "attempt",
  } as MediaStartBody;
  await mediaApi.start("p", body);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ job: {} })));
  await mediaApi.cancel("p", { id: "j", version: 3 } as MediaJob);
  fetchMock.mockRejectedValue(new TypeError("connection lost"));
  await expect(
    mediaApi.retry("p", { id: "j", version: 4 } as MediaJob, "same-attempt"),
  ).rejects.toThrow("connection lost");
  expect(
    fetchMock.mock.calls.map(([path, init]) => [
      path,
      JSON.parse(init!.body as string),
    ]),
  ).toEqual([
    ["/api/v1/projects/p/media/jobs", body],
    ["/api/v1/projects/p/media/jobs/j/cancel", { expectedJobVersion: 3 }],
    [
      "/api/v1/projects/p/media/jobs/j/retry",
      { expectedJobVersion: 4, idempotencyKey: "same-attempt" },
    ],
  ]);
});
