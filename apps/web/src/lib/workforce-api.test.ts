import { afterEach, describe, expect, it, vi } from "vitest";
import { workforceArtifact } from "./workforce-api";

afterEach(() => vi.unstubAllGlobals());
const hash = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
describe("explicit workforce artifact download", () => {
  it("keeps exact bytes, authenticates the GET and verifies their declared hash without reparsing the document", async () => {
    const content = '{ "notes": "Frozen café evidence", "rows": [] }\n';
    const sha256 = await hash(content);
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(content, { headers: { "X-Content-SHA256": sha256 } }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await workforceArtifact("project-a", "job-a");
    expect(await result.blob.text()).toBe(content);
    expect(result.sha256).toBe(sha256);
    expect(result.filename).toBe("workforce-job-a-routing-evidence.json");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/projects/project-a/workforce/jobs/job-a/artifact",
      expect.objectContaining({ credentials: "include" }),
    );
  });
  it("rejects tampered bytes and a response without a declared content identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("changed", {
            headers: { "X-Content-SHA256": await hash("original") },
          }),
        ),
    );
    await expect(workforceArtifact("p", "j")).rejects.toThrow("does not match");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await expect(workforceArtifact("p", "j")).rejects.toThrow(
      "no valid content identity",
    );
  });
  it("rejects oversized declared content before reading and preserves account-required errors", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({ cancel: cancelled });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, {
            headers: {
              "X-Content-SHA256": "a".repeat(64),
              "Content-Length": String(64 * 1024 * 1024 + 1),
            },
          }),
        ),
    );
    await expect(workforceArtifact("p", "j")).rejects.toThrow("64 MiB");
    expect(cancelled).toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code: "AUTH_REQUIRED", message: "Sign in again." },
            }),
            { status: 401 },
          ),
        ),
    );
    await expect(workforceArtifact("p", "j")).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
      message: "Sign in again.",
    });
  });
});
