import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertRoutingCoverage,
  routingHash,
  VALHALLA_IMAGE,
  loadRoutingManifest,
} from "./manifest.js";
import {
  ValhallaRouter,
  outsideRoutingThreshold,
  routingTravelTimeLowerBound,
  routingMatrixInputHash,
  routingIsochroneInputHash,
  routingProfileHash,
  routingOutboundMatrixInputHash,
} from "./valhalla.js";
import type { RoutingPosition, RoutingRegionManifest } from "./types.js";

const site: RoutingPosition = [-112, 33];
const manifest: RoutingRegionManifest = {
  version: 1,
  id: "az-0123456789abcdef",
  engine: {
    name: "valhalla",
    version: "3.9.1",
    image: VALHALLA_IMAGE,
    imageDigest: VALHALLA_IMAGE.split("@")[1],
  },
  sources: [
    {
      url: "https://example.test/az.pbf",
      sha256: "1".repeat(64),
      bytes: 1,
      retrievedAt: "2026-11-05T00:00:00Z",
    },
    {
      url: "https://example.test/az.poly",
      sha256: "2".repeat(64),
      bytes: 1,
      retrievedAt: "2026-11-05T00:00:00Z",
    },
  ],
  graph: { sha256: "3".repeat(64), bytes: 1, files: 1 },
  config: { sha256: "4".repeat(64) },
  profile: {
    carTopSpeedKph: 140,
    walkingSpeedKph: 5.1,
    walkingBoundKph: 10,
    excludeWalkingFerries: true,
  },
  coverage: {
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-120, 25],
          [-100, 25],
          [-100, 40],
          [-120, 40],
          [-120, 25],
        ],
      ],
    },
    maximumMinutes: 45,
    maximumSpeedKph: 252,
    maximumSnapMeters: 250,
    safetyMarginMeters: 1000,
  },
  build: {
    startedAt: "2026-11-05T00:00:00Z",
    completedAt: "2026-11-05T00:00:01Z",
    wallSeconds: 1,
    peakMemoryBytes: 1,
    cpuLimit: 2,
    memoryLimitBytes: 8e9,
    diskLimitBytes: 20e9,
  },
  limitations: [],
  credits: ["OpenStreetMap contributors"],
};
type Call = { action: string; body: any };
function fixture(change?: (call: Call, response: any) => any) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const call = {
      action: new URL(String(url)).pathname.slice(1),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    let response: any;
    if (call.action === "locate")
      response = call.body.locations.map((p: any) => ({
        input_lon: p.lon,
        input_lat: p.lat,
        edges:
          p.lon === -112.02
            ? []
            : [
                {
                  correlated_lon: p.lon,
                  correlated_lat: p.lat,
                  edge: { geo_attributes: { length: 100 } },
                },
              ],
      }));
    else if (call.action === "sources_to_targets")
      response = {
        algorithm: "timedistancematrix",
        units: "kilometers",
        sources_to_targets: call.body.sources.map((p: any, i: number) => ({
          from_index: i,
          to_index: 0,
          time: p.lon === -112.03 ? null : 300 + i,
          distance: p.lon === -112.03 ? null : 1,
          begin_lon: p.lon,
          begin_lat: p.lat,
          end_lon: site[0],
          end_lat: site[1],
        })),
      };
    else
      response = {
        type: "FeatureCollection",
        features: [15, 30, 45].map((contour) => ({
          type: "Feature",
          properties: { contour, metric: "time" },
          geometry: {
            type: "Polygon",
            coordinates: [[site, [-112.1, 33], [-112.1, 33.1], site]],
          },
        })),
      };
    return Response.json(change ? change(call, response) : response);
  };
  return {
    router: new ValhallaRouter({
      baseUrl: "http://127.0.0.1:8002",
      manifest,
      fetcher,
    }),
    calls,
  };
}
describe("bounded native routing adapter", () => {
  function outward(change?: (call: Call, response: any) => any) {
    return fixture((call, response) => {
      if (call.action === "sources_to_targets") {
        const source = call.body.sources[0];
        response = {
          algorithm: "timedistancematrix",
          units: "kilometers",
          sources: call.body.sources,
          targets: call.body.targets,
          sources_to_targets: [
            call.body.targets.map((p: any, index: number) => ({
              from_index: 0,
              to_index: index,
              time: p.lon === -112.03 ? null : 300 + index,
              distance: p.lon === -112.03 ? null : 1,
              begin_lon: source.lon,
              begin_lat: source.lat,
              end_lon: p.lon,
              end_lat: p.lat,
            })),
          ],
        };
      }
      return change ? change(call, response) : response;
    });
  }
  const destinations = [
    { id: "workplace", position: [-112.01, 33] as RoutingPosition },
    { id: "no-edge", position: [-112.02, 33] as RoutingPosition },
    { id: "disconnected", position: [-112.03, 33] as RoutingPosition },
    { id: "far", position: [-115, 33] as RoutingPosition },
  ];
  it("routes outward with one source and every destination, preserving unresolved identities", async () => {
    const { router, calls } = outward();
    const result = await router.outboundMatrix({
      site,
      mode: "car",
      destinations,
    });
    expect(result.direction).toBe("outbound");
    expect(result.inputHash).toBe(
      routingOutboundMatrixInputHash(manifest, {
        site,
        mode: "car",
        destinations,
      }),
    );
    expect(result.rows.map((row) => [row.id, row.status])).toEqual([
      ["workplace", "reachable"],
      ["no-edge", "unsnappable"],
      ["disconnected", "unreachable"],
      ["far", "outside-threshold"],
    ]);
    expect(result.rows[0]).toMatchObject({
      seconds: 300,
      distanceMeters: 1000,
      snapMeters: 0,
    });
    const body = calls.find(
      (call) => call.action === "sources_to_targets",
    )!.body;
    expect(body.sources.map((p: any) => [p.lon, p.lat])).toEqual([site]);
    expect(body.targets.map((p: any) => p.lon)).toEqual([-112.01, -112.03]);
    expect(body.expansion_max_distance).toBe(105100);
    expect(result.search.batches[0].routedCount).toBe(2);
  });
  it.each(["car", "walk"] as const)(
    "binds outward %s profiles and contour direction without changing legacy defaults",
    async (mode) => {
      const { router, calls } = outward();
      const contours = await router.outboundIsochrone({ site, mode });
      expect(contours.direction).toBe("outbound");
      expect(calls[0].body.reverse).toBe(false);
      expect(contours.inputHash).toBe(
        routingIsochroneInputHash(manifest, { site, mode }, "outbound"),
      );
      expect(routingIsochroneInputHash(manifest, { site, mode })).toBe(
        routingIsochroneInputHash(manifest, { site, mode }, "inbound"),
      );
      expect(contours.inputHash).not.toBe(
        routingIsochroneInputHash(manifest, { site, mode }),
      );
      expect(routingProfileHash(manifest, mode, "outbound")).not.toBe(
        routingProfileHash(manifest, mode),
      );
      expect(
        routingMatrixInputHash(manifest, { site, mode, origins: destinations }),
      ).not.toBe(
        routingOutboundMatrixInputHash(manifest, { site, mode, destinations }),
      );
    },
  );
  it.each([
    "transposed",
    "duplicate",
    "site-snap",
    "destination-snap",
    "missing",
    "warning",
  ])(
    "rejects outward %s response instead of reporting zero jobs",
    async (defect) => {
      const { router } = outward((call, response) => {
        if (call.action !== "sources_to_targets") return response;
        const rows = response.sources_to_targets[0];
        if (defect === "transposed") rows[1].from_index = 1;
        if (defect === "duplicate") rows[1].to_index = 0;
        if (defect === "site-snap") rows[0].begin_lon = -110;
        if (defect === "destination-snap") rows[0].end_lon = -110;
        if (defect === "missing") rows.pop();
        if (defect === "warning") response.warnings = [{ code: 1 }];
        return response;
      });
      await expect(
        router.outboundMatrix({ site, mode: "car", destinations }),
      ).rejects.toMatchObject({ code: "ROUTING_INVALID_RESPONSE" });
    },
  );
  it("rejects malformed outward destination inputs before native work", async () => {
    const { router, calls } = outward();
    await expect(
      router.outboundMatrix({
        site,
        mode: "car",
        destinations: [destinations[0], destinations[0]],
      }),
    ).rejects.toMatchObject({ code: "ROUTING_INVALID_REQUEST" });
    expect(calls).toHaveLength(0);
  });
  it("routes origins into the site and retains every status in input order", async () => {
    const { router, calls } = fixture();
    const result = await router.inboundMatrix({
      site,
      mode: "car",
      origins: [
        { id: "yes", position: [-112.01, 33] },
        { id: "no-edge", position: [-112.02, 33] },
        { id: "disconnected", position: [-112.03, 33] },
        { id: "too-far", position: [-115, 33] },
      ],
    });
    expect(result.rows.map((r) => [r.id, r.status])).toEqual([
      ["yes", "reachable"],
      ["no-edge", "unsnappable"],
      ["disconnected", "unreachable"],
      ["too-far", "outside-threshold"],
    ]);
    expect(result.rows[3].lowerBoundSeconds).toBeGreaterThan(2700);
    const matrix = calls.find((c) => c.action === "sources_to_targets")!.body;
    expect(matrix.sources.map((p: any) => p.lon)).toEqual([-112.01, -112.03]);
    expect(matrix.targets).toHaveLength(1);
    expect(matrix.targets[0].lon).toBe(site[0]);
    expect(matrix.matrix_locations).toBeUndefined();
    expect(result.rows[0]).toMatchObject({
      seconds: 300,
      distanceMeters: 1000,
      snapMeters: 0,
    });
  });
  it("rejects insufficient source coverage including interior holes", () => {
    expect(() => assertRoutingCoverage([-119.9, 33], manifest)).toThrow(
      /catchment/,
    );
    const hole = structuredClone(manifest);
    (hole.coverage.geometry as GeoJSON.Polygon).coordinates.push([
      [-112.1, 32.9],
      [-111.9, 32.9],
      [-111.9, 33.1],
      [-112.1, 33.1],
      [-112.1, 32.9],
    ]);
    expect(() => assertRoutingCoverage(site, hole)).toThrow(/outside/);
    expect(
      assertRoutingCoverage(site, manifest, "car").requiredRadiusMeters,
    ).toBe(106500);
    expect(
      assertRoutingCoverage(site, manifest, "walk").requiredRadiusMeters,
    ).toBe(9000);
  });
  it("uses conservative threshold exclusion without inventing a path", () => {
    expect(routingTravelTimeLowerBound(site, site, "car")).toBe(0);
    expect(outsideRoutingThreshold([-112.01, 33], site, "walk")).toBe(false);
    expect(outsideRoutingThreshold([-112.2, 33], site, "walk")).toBe(true);
  });
  it("forces walking ferry exclusion and genuinely reverse contours", async () => {
    const { router, calls } = fixture();
    const result = await router.inboundIsochrone({ site, mode: "walk" });
    const body = calls.at(-1)!.body;
    expect(body.reverse).toBe(true);
    expect(body.costing_options.pedestrian.exclude_ferries).toBe(true);
    expect(body.locations[0].search_filter.exclude_ferry).toBe(true);
    expect(result.direction).toBe("inbound");
  });
  it("bounds pedestrian search distance and serial batches without dropping IDs", async () => {
    const { router, calls } = fixture();
    const origins = Array.from({ length: 76 }, (_, i) => ({
      id: `walk-${i}`,
      position: [-112.001, 33] as RoutingPosition,
    }));
    const result = await router.inboundMatrix({ site, mode: "walk", origins });
    expect(result.rows.map((r) => r.id)).toEqual(origins.map((o) => o.id));
    const matrices = calls.filter((c) => c.action === "sources_to_targets");
    expect(matrices.map((c) => c.body.sources.length)).toEqual([25, 25, 25, 1]);
    for (const call of matrices) {
      expect(call.body.expansion_max_distance).toBe(7600);
      expect(call.body.costing_options.pedestrian.max_distance).toBe(7600);
      expect(call.body.costing_options.pedestrian.exclude_ferries).toBe(true);
    }
  });
  it.each(["car", "walk"] as const)(
    "pads %s terminal edges before pruning and retains the exact search proof",
    async (mode) => {
      const base = mode === "car" ? 105000 : 7500;
      const { router, calls } = fixture((call, response) => {
        if (call.action === "locate")
          for (const location of response)
            for (const edge of location.edges)
              edge.edge.geo_attributes.length = 20000;
        // A destination near the beginning of a long edge is valid, but the native
        // expansion checks its entire edge length before resolving its partial cost.
        if (
          call.action === "sources_to_targets" &&
          call.body.expansion_max_distance < base + 20000
        ) {
          response.sources_to_targets[0].time = null;
          response.sources_to_targets[0].distance = null;
        }
        return response;
      });
      const result = await router.inboundMatrix({
        site,
        mode,
        origins: [{ id: "partial-terminal", position: [-112.001, 33] }],
      });
      expect(result.rows[0].status).toBe("reachable");
      expect(result.search.batches).toEqual([
        {
          firstInputIndex: 0,
          inputCount: 1,
          routedCount: 1,
          maximumCorrelatedEdgeMeters: 20000,
          expansionMaxDistanceMeters: base + 20000,
        },
      ]);
      if (mode === "walk")
        expect(
          calls.find((c) => c.action === "sources_to_targets")!.body
            .costing_options.pedestrian.max_distance,
        ).toBe(base + 20000);
    },
  );
  it("rejects an unsupported terminal edge instead of silently cutting off its route", async () => {
    const { router, calls } = fixture((call, response) => {
      if (call.action === "locate")
        for (const location of response)
          for (const edge of location.edges)
            edge.edge.geo_attributes.length = 50001;
      return response;
    });
    await expect(
      router.inboundMatrix({
        site,
        mode: "walk",
        origins: [{ id: "too-long", position: site }],
      }),
    ).rejects.toMatchObject({ code: "ROUTING_COMPLEXITY" });
    expect(calls.some((c) => c.action === "sources_to_targets")).toBe(false);
  });
  it.each(["missing", "duplicate", "negative", "partial-null", "warning"])(
    "rejects %s matrix responses as failures",
    async (kind) => {
      const { router } = fixture((call, result) => {
        if (call.action !== "sources_to_targets") return result;
        if (kind === "missing") result.sources_to_targets = [];
        if (kind === "duplicate")
          result.sources_to_targets.push(result.sources_to_targets[0]);
        if (kind === "negative") result.sources_to_targets[0].time = -1;
        if (kind === "partial-null")
          result.sources_to_targets[0].distance = null;
        if (kind === "warning") result.warnings = [{ code: 1 }];
        return result;
      });
      await expect(
        router.inboundMatrix({
          site,
          mode: "car",
          origins: [{ id: "a", position: [-112.01, 33] }],
        }),
      ).rejects.toMatchObject({ code: "ROUTING_INVALID_RESPONSE" });
    },
  );
  it("rejects actual matrix snaps beyond the limit", async () => {
    const { router } = fixture((call, result) => {
      if (call.action === "sources_to_targets")
        result.sources_to_targets[0].begin_lon = -113;
      return result;
    });
    await expect(
      router.inboundMatrix({
        site,
        mode: "car",
        origins: [{ id: "a", position: [-112.01, 33] }],
      }),
    ).rejects.toThrow(/snap/);
  });
  it("does not turn HTTP failure into unreachable or zeros", async () => {
    const router = new ValhallaRouter({
      baseUrl: "http://127.0.0.1:8002",
      manifest,
      fetcher: async () => new Response("fail", { status: 500 }),
    });
    await expect(
      router.inboundMatrix({
        site,
        mode: "car",
        origins: [{ id: "a", position: site }],
      }),
    ).rejects.toMatchObject({ code: "ROUTING_ENGINE_FAILURE" });
  });
  it("rejects duplicate IDs, excessive native work, and cancelled jobs before issuing requests", async () => {
    const { router, calls } = fixture();
    await expect(
      router.inboundMatrix({
        site,
        mode: "car",
        origins: [
          { id: "a", position: site },
          { id: "a", position: site },
        ],
      }),
    ).rejects.toMatchObject({ code: "ROUTING_INVALID_REQUEST" });
    await expect(
      router.inboundMatrix({
        site,
        mode: "car",
        origins: Array.from({ length: 60001 }, (_, i) => ({
          id: String(i),
          position: site,
        })),
      }),
    ).rejects.toMatchObject({ code: "ROUTING_COMPLEXITY" });
    await expect(
      router.inboundMatrix({
        site,
        mode: "car",
        origins: [{ id: "a", position: site }],
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "ROUTING_CANCELLED" });
    expect(calls).toHaveLength(0);
  });
  it("rejects redirects/external endpoint configuration and hashes all inputs", () => {
    for (const baseUrl of [
      "https://127.0.0.1:8002",
      "http://example.com",
      "http://127.0.0.1:8002/path",
      "http://user@127.0.0.1:8002",
    ])
      expect(() => new ValhallaRouter({ baseUrl, manifest })).toThrow(
        /loopback/,
      );
    expect(routingHash({ site, mode: "car" })).not.toBe(
      routingHash({ site, mode: "walk" }),
    );
  });
  it("binds matrix and contour identity to exact site, mode, origins, and native profile", async () => {
    const { router } = fixture();
    const query = {
      site,
      mode: "car" as const,
      origins: [{ id: "a", position: [-112.01, 33] as RoutingPosition }],
    };
    const result = await router.inboundMatrix(query);
    expect(result.inputHash).toBe(routingMatrixInputHash(manifest, query));
    expect(
      routingMatrixInputHash(manifest, {
        mode: "car",
        origins: query.origins,
        site,
      }),
    ).toBe(result.inputHash);
    expect(
      routingMatrixInputHash(manifest, { ...query, site: [-112.1, 33] }),
    ).not.toBe(result.inputHash);
    expect(
      routingMatrixInputHash(manifest, {
        ...query,
        origins: [{ id: "different-id", position: query.origins[0].position }],
      }),
    ).not.toBe(result.inputHash);
    expect(routingProfileHash(manifest, "walk")).not.toBe(
      routingProfileHash(manifest, "car"),
    );
    const changed = structuredClone(manifest);
    changed.config.sha256 = "9".repeat(64);
    expect(routingProfileHash(changed, "car")).not.toBe(
      routingProfileHash(manifest, "car"),
    );
    const iso = await router.inboundIsochrone(query);
    expect(iso.inputHash).toBe(routingIsochroneInputHash(manifest, query));
    expect(iso.site).toEqual(site);
    expect(
      routingIsochroneInputHash(manifest, { site: [-112.1, 33], mode: "car" }),
    ).not.toBe(iso.inputHash);
  });
  it("verifies captured graph bytes and fails safely on corruption or oversized metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-routing-"));
    try {
      const config = JSON.stringify({
        service_limits: { allow_hard_exclusions: true },
        loki: { service_defaults: { search_cutoff: 250 } },
        thor: {
          source_to_target_algorithm: "timedistancematrix",
          clear_reserved_memory: true,
        },
        mjolnir: {
          use_lru_mem_cache: true,
          lru_mem_cache_hard_control: true,
          global_synchronized_cache: true,
          max_cache_size: 256 * 1024 ** 2,
        },
      });
      const checksum = (text: string) =>
        createHash("sha256").update(text).digest("hex");
      const inventory = [
        { bytes: 4, path: "tiles.tar", sha256: checksum("tile") },
      ];
      const capture = structuredClone(manifest);
      capture.config.sha256 = checksum(config);
      capture.graph = { bytes: 4, files: 1, sha256: routingHash(inventory) };
      await writeFile(join(directory, "valhalla.json"), config);
      await writeFile(
        join(directory, "graph-files.json"),
        JSON.stringify(inventory),
      );
      await writeFile(join(directory, "tiles.tar"), "tile");
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify(capture),
      );
      expect(
        (await loadRoutingManifest(join(directory, "manifest.json"))).graph
          .sha256,
      ).toBe(capture.graph.sha256);
      await writeFile(join(directory, "tiles.tar"), "oops");
      await expect(
        loadRoutingManifest(join(directory, "manifest.json")),
      ).rejects.toMatchObject({ code: "ROUTING_MANIFEST_INVALID" });
      await writeFile(join(directory, "tiles.tar"), "tile");
      await truncate(join(directory, "valhalla.json"), 2_000_001);
      await expect(
        loadRoutingManifest(join(directory, "manifest.json")),
      ).rejects.toMatchObject({ code: "ROUTING_MANIFEST_INVALID" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("operator cache rejects orphan sources and forged or over-budget receipts without network access", () => {
    const output = execFileSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util,pathlib,tempfile,json,hashlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('prepare',${JSON.stringify(resolve("scripts/prepare-routing.py"))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def forbidden(*a,**k):raise AssertionError('Network access forbidden in cache test')
m.urllib.request.urlopen=forbidden
with tempfile.TemporaryDirectory() as d:
 m.DATA=pathlib.Path(d);(m.DATA/'sources').mkdir()
 p=m.DATA/'sources/arizona.poly';receipt=p.with_suffix('.poly.json');p.write_bytes(b'original')
 try:m.download('arizona.poly',100)
 except RuntimeError:pass
 else:raise AssertionError('Orphan bytes replaced')
 assert p.read_bytes()==b'original'
 good={'url':m.BASE+'arizona.poly','sha256':hashlib.sha256(b'original').hexdigest(),'bytes':8,'retrievedAt':'2026-11-05T00:00:00Z'}
 for change in [{'url':'https://untrusted.invalid/input'}, {'bytes':101}, {'retrievedAt':'not-a-timestamp'}]:
  receipt.write_text(json.dumps(dict(good,**change)))
  try:m.download('arizona.poly',100)
  except (RuntimeError,ValueError):pass
  else:raise AssertionError('Forged receipt accepted')
  assert p.read_bytes()==b'original'
 receipt.write_text(json.dumps(good));assert m.download('arizona.poly',100)==good
 print('cache-guards-pass')
`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(output).toContain("cache-guards-pass");
  });
});
