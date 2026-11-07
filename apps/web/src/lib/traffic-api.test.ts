import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trafficApi, trafficFile, trafficCommuteFile } from "./traffic-api";

afterEach(() => vi.unstubAllGlobals());
describe("authorized traffic evidence client", () => {
  it("binds commute downloads to the reviewed context bytes and bounds them before fetching", async () => {
    const content = '{"ledger":[{"unresolved":3.5}]}';
    const identity = {
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const fetcher = vi.fn(
      async () =>
        new Response(content, {
          headers: {
            "X-Content-SHA256": identity.sha256,
            "Content-Length": String(identity.bytes),
          },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await (
        await trafficCommuteFile(
          "project",
          "network&alternate",
          "cohort/example",
          identity,
        )
      ).text(),
    ).toBe(content);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(
      "/api/v1/projects/project/traffic/commute/cohort%2Fexample/evidence?preparedId=network%26alternate",
    );
    await expect(
      trafficCommuteFile("project", "network", "cohort", {
        ...identity,
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("retained identity");
    fetcher.mockClear();
    await expect(
      trafficCommuteFile("project", "network", "cohort", {
        ...identity,
        bytes: 16 * 1024 ** 2 + 1,
      }),
    ).rejects.toThrow("16 MiB");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uploads the original File as multipart without imposing a JSON content type", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ upload: { id: "retained" } }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["station,count\n01,0"], "counts.csv", {
      type: "text/csv",
    });
    await trafficApi.upload("project", file, "stable-key");
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/projects/project/traffic/uploads");
    expect(options.credentials).toBe("include");
    expect(new Headers(options.headers).has("Content-Type")).toBe(false);
    const body = options.body as FormData;
    expect(body.get("idempotencyKey")).toBe("stable-key");
    expect(await (body.get("file") as File).text()).toBe(await file.text());
  });
  it("checks exact bytes and hash before creating a native evidence download", async () => {
    const content = "<native>retained</native>",
      sha256 = createHash("sha256").update(content).digest("hex"),
      bytes = Buffer.byteLength(content),
      file = { name: "network.net.xml", sha256, bytes };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(content, {
            headers: {
              "X-Content-SHA256": sha256,
              "Content-Length": String(bytes),
            },
          }),
      ),
    );
    expect(await (await trafficFile("project", "job", file)).text()).toBe(
      content,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(bytes), {
            headers: {
              "X-Content-SHA256": sha256,
              "Content-Length": String(bytes),
            },
          }),
      ),
    );
    await expect(trafficFile("project", "job", file)).rejects.toThrow(
      "integrity check",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(content + "extra", {
            headers: { "X-Content-SHA256": sha256 },
          }),
      ),
    );
    await expect(trafficFile("project", "job", file)).rejects.toThrow(
      "declared byte count",
    );
  });
  it("rejects unsafe identities before requesting a private archive", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const file of [
      { name: "../private", bytes: 1, sha256: "a".repeat(64) },
      { name: "network.xml", bytes: 257 * 1024 ** 2, sha256: "a".repeat(64) },
      { name: "network.xml", bytes: 1, sha256: "invalid" },
    ])
      await expect(trafficFile("project", "job", file)).rejects.toThrow(
        "invalid",
      );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
