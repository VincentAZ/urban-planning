import { TestFloodValidationWorker } from "./flood-validation.test-helper";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { floodFixture } from "../../../../tests/fixtures/flood";
import { MAX_FLOOD_DATASET_BYTES } from "@urban/core";
import { fetchFloodDataset } from "./flood-api";
beforeEach(() => vi.stubGlobal("Worker", TestFloodValidationWorker));
afterEach(() => vi.unstubAllGlobals());
describe("verified public flood downloads", () => {
  it("accepts exact source bytes and identity for the current study area", async () => {
    const f = await floodFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ datasetHash: f.datasetHash, dataset: f.dataset }),
      ),
    );
    expect(
      await fetchFloodDataset(
        f.datasetHash,
        f.place,
        new AbortController().signal,
      ),
    ).toEqual(f.dataset);
  });
  it("rejects changed metadata under an unchanged content identifier", async () => {
    const f = await floodFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          datasetHash: f.datasetHash,
          dataset: { ...f.dataset, notes: ["tampered"] },
        }),
      ),
    );
    await expect(
      fetchFloodDataset(f.datasetHash, f.place, new AbortController().signal),
    ).rejects.toThrow(/identity/);
  });
  it("cancels an advertised oversize response before consuming it", async () => {
    const f = await floodFixture(),
      cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: {
              "Content-Length": String(MAX_FLOOD_DATASET_BYTES + 1024),
            },
          }),
      ),
    );
    await expect(
      fetchFloodDataset(f.datasetHash, f.place, new AbortController().signal),
    ).rejects.toThrow(/size/);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
