import { afterEach, describe, expect, it, vi } from "vitest";
import { housingFixture } from "../../../../packages/models/src/housing-fixture";
import { fetchHousingPack } from "./housing-api";
afterEach(() => vi.unstubAllGlobals());
describe("bounded public housing evidence reader", () => {
  it("accepts only the exact schema and content identity requested", async () => {
    const f = housingFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ packHash: f.areaHash, pack: f.pack })),
      ),
    );
    expect(
      await fetchHousingPack(f.areaHash, new AbortController().signal),
    ).toEqual(f.pack);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              packHash: f.areaHash,
              pack: { ...f.pack, notes: ["different citation"] },
            }),
          ),
      ),
    );
    await expect(
      fetchHousingPack(f.areaHash, new AbortController().signal),
    ).rejects.toThrow(/identity/);
  });
  it("rejects declared and streamed oversize evidence without reading an unbounded body", async () => {
    const f = housingFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            headers: { "Content-Length": String(1024 * 1024) },
          }),
      ),
    );
    await expect(
      fetchHousingPack(f.areaHash, new AbortController().signal),
    ).rejects.toThrow(/size/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(600 * 1024))),
    );
    await expect(
      fetchHousingPack(f.areaHash, new AbortController().signal),
    ).rejects.toThrow(/size/);
  });
  it("rejects a late body after cancellation even when transport resolves successfully", async () => {
    const f = housingFixture(),
      controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        return new Response(
          JSON.stringify({ packHash: f.areaHash, pack: f.pack }),
        );
      }),
    );
    await expect(
      fetchHousingPack(f.areaHash, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
