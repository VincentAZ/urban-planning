import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Place, Road } from "@urban/core";
import { buildingGeometry } from "@urban/core";
import { clipLineToBounds, inBounds } from "./geometry";
import {
  createAgents,
  createVehicleBuffers,
  updateVehicleBuffers,
} from "./motion";
const road = (patch: Partial<Road> = {}): Road => ({
  id: "test",
  name: "Test road",
  coordinates: [
    [-112.07, 33.45],
    [-112.069, 33.45],
    [-112.068, 33.451],
  ],
  lanes: 2,
  speedMph: 25,
  oneWay: false,
  kind: "residential",
  sourceId: "test-source",
  ...patch,
});
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
describe("illustrative network animation", () => {
  it("excludes closed roads, pedestrian paths, and zero vehicle demand", () => {
    expect(
      createAgents([road({ closed: true }), road({ kind: "footway" })], 1),
    ).toEqual([]);
    expect(createAgents([road()], 0)).toEqual([]);
    expect(createAgents([road()], Number.NaN)).toEqual([]);
  });
  it("never creates a reversed agent on a one-way road", () => {
    const agents = createAgents([road({ oneWay: true })], 2);
    expect(agents.length).toBeGreaterThan(1);
    expect(agents.every((a) => !a.reverse)).toBe(true);
  });
  it("keeps typed geometry buffers stable between ticks and follows the actual road", () => {
    const agents = createAgents([road()], 1),
      buffers = createVehicleBuffers(agents);
    const positions = buffers.positions,
      colors = buffers.colors;
    updateVehicleBuffers(buffers, agents, 0);
    const before = [...positions];
    updateVehicleBuffers(buffers, agents, 3);
    expect(buffers.positions).toBe(positions);
    expect(buffers.colors).toBe(colors);
    expect([...positions]).not.toEqual(before);
    expect([...positions].every(Number.isFinite)).toBe(true);
    expect(buffers.startIndices[buffers.count]).toBe(buffers.count * 2);
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]).toBeGreaterThan(-112.0701);
      expect(positions[i]).toBeLessThan(-112.0679);
    }
  });
});
