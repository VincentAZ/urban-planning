import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { floodFixture, floodRectangle } from "../../../../tests/fixtures/flood";
import { canonicalJSON, floodDatasetHash } from "@urban/core";
import {
  FLOOD_LAYERS,
  loadPreparedFloodDataset,
  prepareFloodDataset,
} from "./flood";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(change?: (url: URL, body: any, n: number) => unknown) {
  const { place } = await floodFixture();
  const root = await mkdtemp(join(tmpdir(), "flood-source-"));
  roots.push(root);
  const calls = new Map<string, number>();
  const fetcher = async (input: RequestInfo | URL) => {
    const u = new URL(String(input)),
      key = u.href,
      n = (calls.get(key) ?? 0) + 1;
    calls.set(key, n);
    const parts = u.pathname.split("/"),
      layer = Number(parts.at(-1) === "query" ? parts.at(-2) : parts.at(-1));
    let body: any;
    if (!u.pathname.endsWith("/query"))
      body = {
        id: layer,
        name:
          layer === 41
            ? "Study_Info"
            : FLOOD_LAYERS.find((l) => l.id === layer)!.name,
        geometryType: "esriGeometryPolygon",
        supportedQueryFormats: "JSON, geoJSON",
      };
    else if (u.searchParams.has("returnIdsOnly"))
      body = { objectIds: layer === 0 || layer === 28 ? [layer + 1] : [] };
    else if (layer === 41)
      body = {
        features: [
          {
            attributes: {
              OBJECTID: 900,
              DFIRM_ID: "04013C",
              DBREV_DT: 1700000000000,
            },
          },
        ],
      };
    else
      body = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: floodRectangle(-112.09, 33.43, -112.05, 33.47),
            properties:
              layer === 28
                ? {
                    OBJECTID: 29,
                    DFIRM_ID: "04013C",
                    FLD_AR_ID: "04013C_1",
                    FLD_ZONE: "AE",
                    SFHA_TF: "T",
                    ZONE_SUBTY: null,
                    SOURCE_CIT: "STUDY1",
                  }
                : { OBJECTID: 1, STUDY_ID: "04013C" },
          },
        ],
      };
    return new Response(JSON.stringify(change?.(u, body, n) ?? body), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    place,
    directory: join(root, "capture"),
    fetcher: fetcher as typeof fetch,
    calls,
  };
}
describe("bounded effective NFHL source capture", () => {
  it("retains before/after source receipts and reproduces exact clipped polygons from raw bytes", async () => {
    const f = await fixture();
    const captured = await prepareFloodDataset(f.place, f.directory, f.fetcher);
    const loaded = await loadPreparedFloodDataset(f.directory);
    expect(loaded.datasetHash).toBe(captured.datasetHash);
    expect(await floodDatasetHash(loaded.dataset)).toBe(captured.datasetHash);
    expect(loaded.dataset.zones[0].geometry).toEqual(f.place.studyArea);
    expect(loaded.dataset.availability).toHaveLength(1);
    expect(loaded.dataset.panels).toEqual([]);
    expect(loaded.dataset.capture.layerReceipts.map((r) => r.layerId)).toEqual([
      0, 1, 3, 28, 29, 41,
    ]);
    expect(loaded.dataset.capture.studyInfo[0].DBREV_DT).toBe(1700000000000);
    const manifest = JSON.parse(
      await readFile(join(f.directory, "manifest.json"), "utf8"),
    );
    expect(manifest.receipts.some((r: any) => r.role === "after-records")).toBe(
      true,
    );
    await expect(
      prepareFloodDataset(f.place, f.directory, f.fetcher),
    ).rejects.toThrow();
    await writeFile(
      join(f.directory, "pack.json"),
      canonicalJSON({ ...loaded.dataset, notes: ["tampered"] }),
    );
    await expect(loadPreparedFloodDataset(f.directory)).rejects.toThrow(
      "digest",
    );
  }, 30000);
  it.each([
    "inventory",
    "record",
    "study",
    "truncation",
    "missing-id",
  ] as const)(
    "rejects %s inconsistency without a prepared pack",
    async (kind) => {
      const f = await fixture((u, b, n) => {
        if (
          kind === "inventory" &&
          u.pathname.includes("/28/") &&
          u.searchParams.has("returnIdsOnly") &&
          n === 2
        )
          return { objectIds: [29, 30] };
        if (
          kind === "record" &&
          u.pathname.includes("/28/") &&
          u.searchParams.has("objectIds") &&
          n === 2
        )
          b.features[0].properties.FLD_ZONE = "A";
        if (kind === "study" && u.pathname.includes("/41/query") && n === 2)
          b.features[0].attributes.DBREV_DT++;
        if (
          kind === "truncation" &&
          u.pathname.includes("/28/") &&
          u.searchParams.has("objectIds")
        )
          b.exceededTransferLimit = true;
        if (
          kind === "missing-id" &&
          u.pathname.includes("/28/") &&
          u.searchParams.has("objectIds")
        )
          b.features = [];
        return b;
      });
      await expect(
        prepareFloodDataset(f.place, f.directory, f.fetcher),
      ).rejects.toThrow();
      await expect(readFile(join(f.directory, "pack.json"))).rejects.toThrow();
    },
    30000,
  );
  it("retains undetermined zones and rejects raw source-byte substitution on reload", async () => {
    const f = await fixture((u, b) => {
      if (u.pathname.includes("/28/") && u.searchParams.has("objectIds")) {
        b.features[0].properties.FLD_ZONE = "D";
        b.features[0].properties.SFHA_TF = "F";
      }
      return b;
    });
    await prepareFloodDataset(f.place, f.directory, f.fetcher);
    const loaded = await loadPreparedFloodDataset(f.directory);
    expect(loaded.dataset.zones[0].classification).toBe("undetermined");
    const m = JSON.parse(
      await readFile(join(f.directory, "manifest.json"), "utf8"),
    );
    await writeFile(
      join(f.directory, "raw", `${m.receipts[0].sha256}.json`),
      "{}",
    );
    await expect(loadPreparedFloodDataset(f.directory)).rejects.toThrow(
      "digest",
    );
  }, 30000);
});
