import { describe, expect, it, vi } from "vitest";
import type { Polygon } from "geojson";
import {
  verifyWorkforceRun,
  workforceContentHash,
  type WorkforceCell,
  type WorkforceCohortPack,
  type WorkforceRequest,
} from "@urban/core";
import {
  assertRoutingCoverage,
  routingIsochroneInputHash,
  routingMatrixInputHash,
  routingProfileHash,
  VALHALLA_IMAGE,
  type RoutingIsochroneResult,
  type RoutingMatrixRequest,
  type RoutingMatrixResult,
  type RoutingRegionManifest,
} from "./routing";
import {
  workforceBoundaryUrls,
  type WorkforceBoundarySourceKind,
  type WorkforceRegionBoundary,
} from "./data/workforce-boundary";
import {
  runCapturedWorkforce,
  workforceCohortCoverage,
} from "./workforce-runner";

// Deliberately synthetic geometry/counts. Official-shaped metadata is used only
// to exercise strict contracts; these fixtures make no Census or routing claim.
const retrievedAt = "2026-11-06T00:00:00.000Z";
const site: [number, number] = [-112, 33];
const rectangle = (
  west: number,
  south: number,
  east: number,
  north: number,
): Polygon => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
});
function cell(value = 0, margin = 0): WorkforceCell {
  return {
    estimate: {
      value,
      raw: String(value),
      annotation: null,
      status: "available",
    },
    marginOfError: {
      value: margin,
      raw: String(margin),
      annotation: null,
      status: "available",
    },
  };
}
function fixture() {
  const education = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `B15003_${String(i + 1).padStart(3, "0")}`,
      cell(),
    ]),
  );
  const occupation = Object.fromEntries(
    Array.from({ length: 73 }, (_, i) => [
      `C24010_${String(i + 1).padStart(3, "0")}`,
      cell(),
    ]),
  );
  education.B15003_001 = cell(100, 10);
  education.B15003_022 = cell(100, 10);
  occupation.C24010_001 = cell(80, 8);
  occupation.C24010_003 = cell(80, 8);
  const pack: WorkforceCohortPack = {
    version: 1,
    id: "synthetic-runner-fixture",
    acs: {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      confidenceLevel: 90,
      boundaryVintage: "2024 synthetic test shape",
    },
    region: {
      label: "Synthetic region; not Arizona measurements",
      countyGeoids: ["04013"],
      complete: true,
    },
    sources: [
      {
        id: "synthetic",
        name: "Synthetic runner fixture",
        url: "",
        vintage: "2024",
        license: "Test fixture only",
        kind: "user-supplied",
      },
    ],
    files: [
      {
        sourceId: "synthetic",
        url: "https://example.org/synthetic-fixture",
        sha256: "1".repeat(64),
        retrievedAt,
      },
    ],
    allocation: {
      method: "2020-block-population",
      sourceId: "synthetic",
      vintage: 2020,
      geographyMatch: "verified",
      notes: [
        "Synthetic membership, population and coordinates for this test only.",
      ],
    },
    units: [
      {
        geoid: "040130001001",
        name: "Synthetic block group",
        education,
        occupation,
        allocationStatus: "complete",
      },
    ],
    origins: [
      {
        id: "040130001001001",
        unitGeoid: "040130001001",
        position: [-112.001, 33],
        population2020: 25,
        weight: 0.25,
      },
      {
        id: "040130001001002",
        unitGeoid: "040130001001",
        position: [-112.002, 33],
        population2020: 75,
        weight: 0.75,
      },
      {
        id: "040130001001003",
        unitGeoid: "040130001001",
        position: [-112.003, 33],
        population2020: 0,
        weight: 0,
      },
    ],
    unallocatedOrigins: [],
  };
  const urls = workforceBoundaryUrls("04");
  const boundary: WorkforceRegionBoundary = {
    version: 1,
    stateFips: "04",
    vintage: 2024,
    countyGeoids: ["04013"],
    geometry: rectangle(-120, 25, -100, 40),
    sources: (Object.keys(urls) as WorkforceBoundarySourceKind[]).map(
      (kind) => ({
        kind,
        url: urls[kind],
        sha256: "2".repeat(64),
        bytes: 100,
        retrievedAt,
      }),
    ),
    notes: [
      "Synthetic state shape and inventory; not an actual Census boundary.",
    ],
  };
  const manifest: RoutingRegionManifest = {
    version: 1,
    id: "az-0123456789abcdef",
    engine: {
      name: "valhalla",
      version: "3.9.1",
      image: VALHALLA_IMAGE,
      imageDigest: VALHALLA_IMAGE.split("@")[1],
    },
    sources: ["network", "boundary"].map((label) => ({
      url: `https://example.org/synthetic-${label}`,
      sha256: "3".repeat(64),
      bytes: 100,
      retrievedAt,
    })),
    graph: { sha256: "4".repeat(64), bytes: 100, files: 1 },
    config: { sha256: "5".repeat(64) },
    profile: {
      carTopSpeedKph: 140,
      walkingSpeedKph: 5.1,
      walkingBoundKph: 10,
      excludeWalkingFerries: true,
    },
    coverage: {
      geometry: rectangle(-120, 25, -100, 40),
      maximumMinutes: 45,
      maximumSpeedKph: 252,
      maximumSnapMeters: 250,
      safetyMarginMeters: 1000,
    },
    build: {
      startedAt: retrievedAt,
      completedAt: retrievedAt,
      wallSeconds: 0,
      peakMemoryBytes: 0,
      cpuLimit: 1,
      memoryLimitBytes: 1000,
      diskLimitBytes: 1000,
    },
    limitations: [
      "Synthetic adapter results; no native engine is used by these unit tests.",
    ],
    credits: ["Test fixture only"],
  };
  const request: WorkforceRequest = {
    site: [...site],
    mode: "walk",
    direction: "inbound",
    thresholdsMinutes: [15, 30, 45],
  };
  const hooks: {
    matrix?: (
      response: RoutingMatrixResult,
      input: RoutingMatrixRequest,
    ) => void;
    contour?: (response: RoutingIsochroneResult) => void;
  } = {};
  const router = {
    manifest,
    inboundMatrix: vi.fn(
      async (input: RoutingMatrixRequest): Promise<RoutingMatrixResult> => {
        input.signal?.throwIfAborted();
        const response: RoutingMatrixResult = {
          manifestId: manifest.id,
          inputHash: routingMatrixInputHash(manifest, input),
          mode: input.mode,
          direction: "inbound",
          siteSnapMeters: 1,
          rows: input.origins.map((origin, i) => ({
            id: origin.id,
            status: "reachable",
            seconds: [900, 1800][i],
            distanceMeters: [1000, 2000][i],
            snapMeters: 1,
          })),
          coverage: assertRoutingCoverage(input.site, manifest, input.mode),
          search: {
            algorithm: "timedistancematrix",
            baseExpansionMeters: input.mode === "walk" ? 7500 : 105000,
            terminalEdgePaddingPolicy: "maximum-correlated-edge-length",
            batches: [
              {
                firstInputIndex: 0,
                inputCount: input.origins.length,
                routedCount: input.origins.length,
                maximumCorrelatedEdgeMeters: 125,
                expansionMaxDistanceMeters:
                  (input.mode === "walk" ? 7500 : 105000) + 125,
              },
            ],
          },
          notes: [
            "Synthetic elapsed times; routing identity, aggregation and hashing remain real.",
          ],
        };
        hooks.matrix?.(response, input);
        return response;
      },
    ),
    inboundIsochrone: vi.fn(
      async (input: {
        site: [number, number];
        mode: "car" | "walk";
        signal?: AbortSignal;
      }): Promise<RoutingIsochroneResult> => {
        input.signal?.throwIfAborted();
        const response: RoutingIsochroneResult = {
          manifestId: manifest.id,
          inputHash: routingIsochroneInputHash(manifest, input),
          site: [...input.site],
          mode: input.mode,
          direction: "inbound",
          minutes: [15, 30, 45],
          geometry: {
            type: "FeatureCollection",
            features: [15, 30, 45].map((minutes) => ({
              type: "Feature",
              properties: { contour: minutes },
              geometry: rectangle(
                site[0] - minutes / 1000,
                site[1] - minutes / 1000,
                site[0] + minutes / 1000,
                site[1] + minutes / 1000,
              ),
            })),
          },
          notes: [
            "Synthetic visual contours; counts use actual retained fixture matrix rows.",
          ],
        };
        hooks.contour?.(response);
        return response;
      },
    ),
  };
  return { pack, boundary, request, router, hooks };
}

describe("captured workforce runner", () => {
  it("runs real hash verification and source-unit aggregation, retaining zero-weight IDs without native work", async () => {
    const f = fixture(),
      before = JSON.stringify({
        pack: f.pack,
        boundary: f.boundary,
        request: f.request,
        manifest: f.router.manifest,
      });
    const stages: string[] = [];
    const captured = await runCapturedWorkforce({
      ...f,
      onProgress: (stage) => stages.push(stage),
    });
    expect(stages).toEqual([
      "validating",
      "routing",
      "aggregating",
      "contours",
    ]);
    expect(f.router.inboundMatrix).toHaveBeenCalledOnce();
    expect(f.router.inboundIsochrone).toHaveBeenCalledOnce();
    expect(
      f.router.inboundMatrix.mock.calls[0][0].origins.map((o) => o.id),
    ).toEqual(f.pack.origins.slice(0, 2).map((o) => o.id));
    expect(captured.run.rows.map((o) => o.id)).toEqual(
      f.pack.origins.map((o) => o.id),
    );
    expect(captured.run.rows[2]).toEqual({
      id: f.pack.origins[2].id,
      status: "unavailable",
      seconds: null,
      distanceMeters: null,
      snapMeters: null,
    });
    expect(
      captured.result.panels[0].thresholds.map((r) => r.total.estimate),
    ).toEqual([25, 100, 100]);
    expect(
      captured.result.panels[0].thresholds.map((r) => r.total.marginOfError90),
    ).toEqual([2.5, 10, 10]);
    expect(
      captured.result.panels[1].thresholds.map((r) => r.total.estimate),
    ).toEqual([20, 80, 80]);
    expect(captured.result.coverage.routeStatusCounts.unavailable).toBe(1);
    expect(captured.result.panels[0].thresholds[0].total.status).toBe(
      "complete",
    );
    expect(captured.metrics).toMatchObject({
      routedInputOrigins: 2,
      zeroWeightOrigins: 1,
    });
    expect(captured.provider.search).toEqual({
      algorithm: "timedistancematrix",
      baseExpansionMeters: 7500,
      terminalEdgePaddingPolicy: "maximum-correlated-edge-length",
      batches: [
        {
          firstInputIndex: 0,
          inputCount: 2,
          routedCount: 2,
          maximumCorrelatedEdgeMeters: 125,
          expansionMaxDistanceMeters: 7625,
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(captured)).provider.search).toEqual(
      captured.provider.search,
    );
    expect(captured.run.cohortPackHash).toBe(
      await workforceContentHash(f.pack),
    );
    expect(captured.run.cohortCoverage.boundaryHash).toBe(
      await workforceContentHash(f.boundary),
    );
    expect(captured.run.network.profileHash).toBe(
      routingProfileHash(f.router.manifest, "walk"),
    );
    expect(captured.run.network.profileHash).not.toBe(
      f.router.manifest.config.sha256,
    );
    expect(captured.result.routingRunHash).toBe(
      await workforceContentHash(captured.run),
    );
    await expect(
      verifyWorkforceRun(f.pack, captured.run),
    ).resolves.toBeUndefined();
    expect(
      JSON.stringify({
        pack: f.pack,
        boundary: f.boundary,
        request: f.request,
        manifest: f.router.manifest,
      }),
    ).toBe(before);
  });

  it("requires the full source county inventory independently of a sufficient graph", async () => {
    const f = fixture();
    f.boundary.countyGeoids.push("04021");
    expect(() =>
      assertRoutingCoverage(site, f.router.manifest, "walk"),
    ).not.toThrow();
    await expect(runCapturedWorkforce(f)).rejects.toThrow(
      "complete state cohort inventory",
    );
    expect(f.router.inboundMatrix).not.toHaveBeenCalled();
    expect(f.router.inboundIsochrone).not.toHaveBeenCalled();
    const partial = fixture();
    partial.pack.region.complete = false;
    await expect(runCapturedWorkforce(partial)).rejects.toThrow(
      "complete state cohort inventory",
    );
    expect(partial.router.inboundMatrix).not.toHaveBeenCalled();
  });

  it("checks cohort boundary and road boundary independently before any native call", async () => {
    const sourceEdge = fixture();
    sourceEdge.boundary.geometry = rectangle(-112.01, 32.99, -111.99, 33.01);
    expect(() =>
      assertRoutingCoverage(site, sourceEdge.router.manifest, "walk"),
    ).not.toThrow();
    await expect(runCapturedWorkforce(sourceEdge)).rejects.toThrow(
      "catchment reaches",
    );
    expect(sourceEdge.router.inboundMatrix).not.toHaveBeenCalled();
    const graphEdge = fixture();
    graphEdge.router.manifest.coverage.geometry = rectangle(
      -112.01,
      32.99,
      -111.99,
      33.01,
    );
    expect(() =>
      workforceCohortCoverage(
        graphEdge.pack,
        graphEdge.boundary,
        graphEdge.request,
        graphEdge.router.manifest,
      ),
    ).not.toThrow();
    await expect(runCapturedWorkforce(graphEdge)).rejects.toThrow(
      "catchment reaches",
    );
    expect(graphEdge.router.inboundMatrix).not.toHaveBeenCalled();
  });

  it("rejects a stale site's matrix even with exactly matching origin IDs, mode and manifest", async () => {
    const f = fixture(),
      stages: string[] = [];
    f.hooks.matrix = (response, input) => {
      response.inputHash = routingMatrixInputHash(f.router.manifest, {
        ...input,
        site: [-112.2, 33],
      });
    };
    await expect(
      runCapturedWorkforce({ ...f, onProgress: (stage) => stages.push(stage) }),
    ).rejects.toThrow("complete captured origin request");
    expect(stages).toEqual(["validating", "routing"]);
    expect(f.router.inboundIsochrone).not.toHaveBeenCalled();
  });

  it("rejects changed origin coordinates and duplicate or missing matrix identities", async () => {
    for (const change of ["coordinates", "duplicate", "missing"] as const) {
      const f = fixture();
      f.hooks.matrix = (response, input) => {
        if (change === "coordinates")
          response.inputHash = routingMatrixInputHash(f.router.manifest, {
            ...input,
            origins: input.origins.map((o) => ({
              ...o,
              position: [-112.2, 33],
            })),
          });
        if (change === "duplicate") response.rows[1] = { ...response.rows[0] };
        if (change === "missing") response.rows.pop();
      };
      await expect(runCapturedWorkforce(f)).rejects.toThrow(
        "complete captured origin request",
      );
      expect(f.router.inboundIsochrone).not.toHaveBeenCalled();
    }
  });

  it("rejects a stale-site contour and publishes no captured result even after valid numerical aggregation", async () => {
    const f = fixture(),
      published: unknown[] = [];
    f.hooks.contour = (response) => {
      response.inputHash = routingIsochroneInputHash(f.router.manifest, {
        site: [-112.2, 33],
        mode: "walk",
      });
    };
    await expect(
      runCapturedWorkforce(f).then((result) => published.push(result)),
    ).rejects.toThrow("contour does not match");
    expect(f.router.inboundMatrix).toHaveBeenCalledOnce();
    expect(f.router.inboundIsochrone).toHaveBeenCalledOnce();
    expect(published).toEqual([]);
  });

  it("returns partial known counts for unsnappable origins without mislabeling missing allocation as missing Census data", async () => {
    const f = fixture();
    f.hooks.matrix = (response) => {
      response.rows[1] = {
        ...response.rows[1],
        status: "unsnappable",
        seconds: null,
        distanceMeters: null,
        snapMeters: null,
      };
    };
    const result = await runCapturedWorkforce(f);
    expect(result.result.panels[0].thresholds[0].total).toMatchObject({
      estimate: null,
      knownSubtotal: 25,
      marginOfError90: null,
      knownSubtotalMarginOfError90: 2.5,
      status: "partial",
      missingUnitGeoids: [],
      suppressedUnitGeoids: [],
      unresolvedAllocationUnitGeoids: [f.pack.units[0].geoid],
    });
    expect(result.result.coverage).toMatchObject({
      regionDataComplete: true,
      network: "complete",
      cohort: { status: "complete" },
      unroutedAllocationPopulation2020: 75,
    });
    expect(result.run.rows).toHaveLength(3);
  });

  it("retains suppressed source totals separately from usable occupation and education category counts", async () => {
    const f = fixture();
    f.pack.units[0].education.B15003_001.estimate = {
      status: "suppressed",
      value: null,
      raw: "-999999999",
      annotation: "N",
    };
    const result = await runCapturedWorkforce(f);
    expect(result.result.panels[0].thresholds[0].total).toMatchObject({
      estimate: null,
      knownSubtotal: null,
      status: "unavailable",
      suppressedUnitGeoids: [f.pack.units[0].geoid],
      unresolvedAllocationUnitGeoids: [],
    });
    expect(result.result.panels[1].thresholds[0].total.estimate).toBe(20);
    expect(
      result.result.panels[0].thresholds[0].categories.find(
        (c) => c.id === "bachelor",
      )?.estimate,
    ).toBe(25);
  });

  it("does not reinterpret a provider failure as unreachable or continue into aggregation/contours", async () => {
    const f = fixture(),
      stages: string[] = [],
      published: unknown[] = [];
    const failure = new Error("Synthetic engine timeout");
    f.router.inboundMatrix.mockRejectedValueOnce(failure);
    await expect(
      runCapturedWorkforce({
        ...f,
        onProgress: (stage) => stages.push(stage),
      }).then((result) => published.push(result)),
    ).rejects.toBe(failure);
    expect(stages).toEqual(["validating", "routing"]);
    expect(f.router.inboundIsochrone).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("does not start work for a pre-cancelled request", async () => {
    const f = fixture(),
      stages: string[] = [],
      published: unknown[] = [],
      controller = new AbortController();
    const cancelled = new Error("Synthetic cancellation");
    controller.abort(cancelled);
    await expect(
      runCapturedWorkforce({
        ...f,
        signal: controller.signal,
        onProgress: (stage) => stages.push(stage),
      }).then((result) => published.push(result)),
    ).rejects.toBe(cancelled);
    expect(stages).toEqual([]);
    expect(f.router.inboundMatrix).not.toHaveBeenCalled();
    expect(f.router.inboundIsochrone).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("stops before aggregation when cancelled as the provider finishes, even if it returns valid rows", async () => {
    const f = fixture(),
      stages: string[] = [],
      published: unknown[] = [],
      controller = new AbortController();
    const cancelled = new Error("Cancelled during native matrix");
    f.hooks.matrix = () => controller.abort(cancelled);
    await expect(
      runCapturedWorkforce({
        ...f,
        signal: controller.signal,
        onProgress: (stage) => stages.push(stage),
      }).then((result) => published.push(result)),
    ).rejects.toBe(cancelled);
    expect(stages).toEqual(["validating", "routing"]);
    expect(f.router.inboundIsochrone).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("does not publish a result after contour failure or cancellation", async () => {
    for (const cancelled of [false, true]) {
      const f = fixture(),
        published: unknown[] = [],
        controller = new AbortController();
      const failure = new Error(
        cancelled
          ? "Cancelled during contour"
          : "Synthetic contour provider failure",
      );
      if (cancelled) f.hooks.contour = () => controller.abort(failure);
      else f.router.inboundIsochrone.mockRejectedValueOnce(failure);
      await expect(
        runCapturedWorkforce({ ...f, signal: controller.signal }).then(
          (result) => published.push(result),
        ),
      ).rejects.toBe(failure);
      expect(published).toEqual([]);
    }
  });

  it("rejects packs without usable origins before invoking the router and keeps input evidence unchanged", async () => {
    const f = fixture();
    f.pack.units[0].allocationStatus = "unavailable";
    f.pack.origins.forEach((o) => {
      o.weight = 0;
    });
    const before = JSON.stringify(f.pack);
    await expect(runCapturedWorkforce(f)).rejects.toThrow(
      "no usable allocation origins",
    );
    expect(f.router.inboundMatrix).not.toHaveBeenCalled();
    expect(f.router.inboundIsochrone).not.toHaveBeenCalled();
    expect(JSON.stringify(f.pack)).toBe(before);
  });
});
