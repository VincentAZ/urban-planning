import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Place, Road } from "@urban/core";
import { buildingGeometry } from "@urban/core";
import { clipLineToBounds, inBounds } from "./geometry";
import {
  distance,
  createAgents,
  sampleAgents,
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
  it("respects one-way direction and avoids outlets with no legal return", () => {
    const loop = road({ oneWay: true, coordinates: [
      [-112.07, 33.45], [-112.069, 33.45], [-112.069, 33.451], [-112.07, 33.45],
    ] });
    const agents = createAgents([loop], 2);
    expect(agents.length).toBeGreaterThan(1);
    const buffers = createVehicleBuffers(agents);
    updateVehicleBuffers(buffers, agents, 0);
    for (let seconds = 1; seconds <= 120; seconds++) {
      updateVehicleBuffers(buffers, agents, seconds);
      expect(agents.every((agent) => !agent.edge.reverse)).toBe(true);
    }
    expect(createAgents([road({ oneWay: true })], 1)).toEqual([]);
  });
  it("stays on the road centerline and turns around at dead ends without teleporting", () => {
    const agents = createAgents([road({ coordinates: [
      [-112.07, 33.45], [-112.068, 33.45],
    ] })], 1);
    const agent = agents[0];
    agent.offset = agent.edge.length - 1;
    const buffers = createVehicleBuffers(agents);
    updateVehicleBuffers(buffers, agents, 0);
    expect(buffers.angles[0]).toBeCloseTo(-90);
    expect(buffers.positions[1]).toBe(33.45);
    const before = buffers.positions[0];
    updateVehicleBuffers(buffers, agents, 0.2);
    expect(agent.edge.reverse).toBe(true);
    expect(buffers.angles[0]).toBeCloseTo(90);
    expect(buffers.positions[1]).toBe(33.45);
    expect(Math.abs(buffers.positions[0] - before)).toBeLessThan(0.00002);
  });
  it("roams connected streets through interior junctions without losing cars or jumping", () => {
    const west: [number, number] = [-112.071, 33.45];
    const junction: [number, number] = [-112.07, 33.45];
    const east: [number, number] = [-112.069, 33.45];
    const north: [number, number] = [-112.07, 33.451];
    const streets = [
      road({ id: "through", coordinates: [west, junction, east] }),
      road({ id: "branch", coordinates: [junction, north] }),
      road({ id: "closed", closed: true, coordinates: [junction, [-112.07, 33.449]] }),
    ];
    const agents = createAgents(streets, 2);
    const identities = [...agents];
    const buffers = createVehicleBuffers(agents);
    updateVehicleBuffers(buffers, agents, 0);
    const visited = new Set<string>();
    for (let tick = 1; tick <= 2400; tick++) {
      const before = [...buffers.positions];
      updateVehicleBuffers(buffers, agents, tick / 10);
      expect(agents.every((agent, i) => agent === identities[i])).toBe(true);
      expect(buffers.count).toBe(identities.length);
      for (let i = 0; i < agents.length; i++) {
        const { edge, offset } = agents[i];
        visited.add(edge.road.id);
        expect(edge.road.closed).not.toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThanOrEqual(edge.length);
        const pos: [number, number] = [buffers.positions[i * 3], buffers.positions[i * 3 + 1]];
        expect(distance([before[i * 3], before[i * 3 + 1]], pos)).toBeLessThanOrEqual(1.11);
        // Both streets are axis-aligned, so a car must be on one centerline.
        expect(pos[0] === junction[0] || pos[1] === junction[1]).toBe(true);
      }
    }
    expect(visited).toEqual(new Set(["through", "branch"]));
  });
  it("scales the sample with demand and enforces the display caps", () => {
    const roads = [road()];
    expect(createAgents(roads, 0.5).length).toBeLessThan(createAgents(roads, 1).length);
    expect(createAgents(roads, 2).length).toBeGreaterThan(createAgents(roads, 1).length);
    expect(createAgents(roads, 100).length).toBe(createAgents(roads, 3).length);
    const network = Array.from({ length: 100 }, (_, i) => road({ id: String(i) }));
    expect(createAgents(network, 0.5)).toHaveLength(109);
    expect(createAgents(network, 1)).toHaveLength(217);
    expect(createAgents(network, 2)).toHaveLength(434);
    expect(createAgents(network, 3)).toHaveLength(650);
    const sampledRoads = createAgents(network, 1).map((agent) => Number(agent.edge.road.id));
    expect(Math.min(...sampledRoads)).toBe(0);
    expect(Math.max(...sampledRoads)).toBe(99);
    const pool = createAgents(network, 3);
    const current = sampleAgents(pool, 1);
    const buffers = createVehicleBuffers(current);
    updateVehicleBuffers(buffers, current, 0);
    updateVehicleBuffers(buffers, current, 5);
    const position = current[0].offset;
    const increased = sampleAgents(pool, 2);
    expect(increased.slice(0, current.length)).toEqual(current);
    expect(increased[0]).toBe(current[0]);
    expect(increased[0].offset).toBe(position);
  });
  it("keeps typed geometry buffers stable between ticks and follows the actual road", () => {
    const agents = createAgents([road()], 1),
      buffers = createVehicleBuffers(agents);
    const positions = buffers.positions,
      angles = buffers.angles;
    updateVehicleBuffers(buffers, agents, 0);
    const before = [...positions];
    updateVehicleBuffers(buffers, agents, 3);
    expect(buffers.positions).toBe(positions);
    expect(buffers.angles).toBe(angles);
    expect([...positions]).not.toEqual(before);
    expect([...positions].every(Number.isFinite)).toBe(true);
    expect(buffers.positions.length).toBe(buffers.count * 3);
    expect([...angles].every(Number.isFinite)).toBe(true);
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]).toBeGreaterThan(-112.0701);
      expect(positions[i]).toBeLessThan(-112.0679);
    }
  });
});
