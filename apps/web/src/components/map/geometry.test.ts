import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Place } from "@urban/core";
import { buildingGeometry } from "@urban/core";
import { clipLineToBounds, inBounds } from "./geometry";
describe("reference geography boundaries", () => {
  it("clips a crossing road to its exact entry and exit points", () => {
    expect(
      clipLineToBounds(
        [
          [-1, 0.5],
          [2, 0.5],
        ],
        [0, 0, 1, 1],
      ),
    ).toEqual([
      [
        [0, 0.5],
        [1, 0.5],
      ],
    ]);
  });
  it("does not join disconnected excursions across the reference extent", () => {
    const paths = clipLineToBounds(
      [
        [0.2, 0.2],
        [2, 0.2],
        [2, 0.8],
        [0.2, 0.8],
      ],
      [0, 0, 1, 1],
    );
    expect(paths).toHaveLength(2);
    expect(paths[0]).toEqual([
      [0.2, 0.2],
      [1, 0.2],
    ]);
    expect(paths[1][0]).toEqual([1, 0.8]);
    expect(paths[1][1][0]).toBeCloseTo(0.2, 12);
    expect(paths[1][1][1]).toBeCloseTo(0.8, 12);
  });
  it("drops exterior and zero-length paths", () => {
    expect(
      clipLineToBounds(
        [
          [-1, -1],
          [-2, -2],
        ],
        [0, 0, 1, 1],
      ),
    ).toEqual([]);
    expect(
      clipLineToBounds(
        [
          [0.2, 0.2],
          [0.2, 0.2],
        ],
        [0, 0, 1, 1],
      ),
    ).toEqual([]);
  });
  it("ships a source-backed bundle whose geometry is inside the declared extent", () => {
    const place: Place = JSON.parse(
      readFileSync("public/data/phoenix.json", "utf8"),
    );
    expect(place.buildings.length).toBeGreaterThan(1000);
    expect(place.roads.length).toBeGreaterThan(1000);
    expect(place.extentLabel).toContain("reference area");
    expect(place.sources.find((s) => s.id === "osm-phoenix")?.license).toBe(
      "ODbL 1.0",
    );
    for (const b of place.buildings) {
      const geometry = buildingGeometry(b);
      const parts =
        geometry.type === "Polygon"
          ? [geometry.coordinates]
          : geometry.coordinates;
      for (const rings of parts)
        for (const ring of rings) {
          expect(ring.every((point) => inBounds(point, place.bounds))).toBe(
            true,
          );
          expect(ring[0]).toEqual(ring.at(-1));
        }
      expect(b.areaSqm).toBeGreaterThan(0);
      expect(Number.isFinite(b.height)).toBe(true);
      expect(b.attributeSourceId).toBe("inference-phoenix");
    }
    for (const r of place.roads)
      expect(
        r.coordinates.every((point) => inBounds(point, place.bounds)),
      ).toBe(true);
  });
});
