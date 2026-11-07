import { describe, it, expect, vi } from "vitest";
import type { Polygon } from "geojson";
import {
  verifyAccessibilityRun,
  accessibilityContentHash,
  type AccessibilityRequest,
} from "@urban/core";
import { accessibilityPackFixture } from "../../../tests/fixtures/accessibility.js";
import {
  assertRoutingCoverage,
  routingOutboundMatrixInputHash,
  routingIsochroneInputHash,
  VALHALLA_IMAGE,
  type RoutingMatrixResult,
  type RoutingIsochroneResult,
  type RoutingRegionManifest,
} from "./routing/index.js";
import {
  workforceBoundaryUrls,
  type WorkforceRegionBoundary,
  type WorkforceBoundarySourceKind,
} from "./data/workforce-boundary.js";
import { runCapturedAccessibility } from "./accessibility-runner.js";
const retrievedAt = "2026-11-06T00:00:00.000Z";
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
function fixture() {
  const pack = accessibilityPackFixture();
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

  const request: AccessibilityRequest = {
    site: [-112.07, 33.45],
    mode: "car",
    direction: "outbound",
    thresholdsMinutes: [15, 30, 45],
  };
  const hooks: {
    matrix?: (r: RoutingMatrixResult<"outbound">) => void;
    contour?: (r: RoutingIsochroneResult<"outbound">) => void;
  } = {};
  const router = {
    manifest,
    outboundMatrix: vi.fn(
      async (input: {
        site: [number, number];
        destinations: { id: string; position: [number, number] }[];
        mode: "car" | "walk";
        signal?: AbortSignal;
      }): Promise<RoutingMatrixResult<"outbound">> => {
        const r: RoutingMatrixResult<"outbound"> = {
          manifestId: manifest.id,
          inputHash: routingOutboundMatrixInputHash(manifest, input),
          mode: input.mode,
          direction: "outbound",
          siteSnapMeters: 1,
          rows: input.destinations.map((d, i) => ({
            id: d.id,
            status: "reachable",
            seconds: [900, 1800][i],
            distanceMeters: 1000,
            snapMeters: 1,
          })),
          coverage: assertRoutingCoverage(input.site, manifest, input.mode),
          search: {
            algorithm: "timedistancematrix",
            baseExpansionMeters: 105000,
            terminalEdgePaddingPolicy: "maximum-correlated-edge-length",
            batches: [],
          },
          notes: ["Synthetic only"],
        };
        hooks.matrix?.(r);
        return r;
      },
    ),
    outboundIsochrone: vi.fn(
      async (input: {
        site: [number, number];
        mode: "car" | "walk";
        signal?: AbortSignal;
      }): Promise<RoutingIsochroneResult<"outbound">> => {
        const r: RoutingIsochroneResult<"outbound"> = {
          manifestId: manifest.id,
          inputHash: routingIsochroneInputHash(manifest, input, "outbound"),
          site: input.site,
          mode: input.mode,
          direction: "outbound",
          minutes: [15, 30, 45],
          geometry: {
            type: "FeatureCollection",
            features: [15, 30, 45].map((contour) => ({
              type: "Feature",
              properties: { contour },
              geometry: rectangle(-112.08, 33.44, -112.06, 33.46),
            })),
          },
          notes: ["Synthetic only"],
        };
        hooks.contour?.(r);
        return r;
      },
    ),
  };
  return { pack, boundary, request, router, hooks };
}
describe("outbound complete workplace runner", () => {
  it("routes every positive workplace once and retains zero jobs, exact sources and native search diagnostics", async () => {
    const f = fixture(),
      r = await runCapturedAccessibility(f);
    await verifyAccessibilityRun(f.pack, r.run);
    expect(r.run.rows).toHaveLength(3);
    expect(r.run.rows[2].status).toBe("zero-jobs");
    expect(f.router.outboundMatrix.mock.calls[0][0].destinations).toHaveLength(
      2,
    );
    expect(r.result.thresholds.map((t) => t.total.estimate)).toEqual([
      10, 30, 30,
    ]);
    expect(r.run.sourceCoverage.boundaryHash).toBe(
      await accessibilityContentHash(f.boundary),
    );
    expect(r.provider.search).toEqual({
      algorithm: "timedistancematrix",
      baseExpansionMeters: 105000,
      terminalEdgePaddingPolicy: "maximum-correlated-edge-length",
      batches: [],
    });
  });
  it.each(["inputHash", "manifestId", "direction"] as const)(
    "rejects wrong matrix %s",
    async (key) => {
      const f = fixture();
      f.hooks.matrix = (r) => Object.assign(r, { [key]: "mismatch" });
      await expect(runCapturedAccessibility(f)).rejects.toThrow(
        /does not match/,
      );
    },
  );
  it("rejects duplicate and missing destinations", async () => {
    const f = fixture();
    f.hooks.matrix = (r) => {
      r.rows[1] = { ...r.rows[0] };
    };
    await expect(runCapturedAccessibility(f)).rejects.toThrow(/does not match/);
  });
  it("retains a null native route as unresolved primary jobs", async () => {
    const f = fixture();
    f.hooks.matrix = (r) => {
      r.rows[0] = {
        id: r.rows[0].id,
        status: "unreachable",
        seconds: null,
        distanceMeters: null,
        snapMeters: 1,
      };
    };
    const r = await runCapturedAccessibility(f);
    expect(r.result.thresholds[2].total).toMatchObject({
      estimate: null,
      knownSubtotal: 20,
      unresolvedJobs: 10,
      upperBound: 30,
      status: "partial",
    });
  });
  it("rejects wrong contour query identity", async () => {
    const f = fixture();
    f.hooks.contour = (r) => {
      r.inputHash = "a".repeat(64);
    };
    await expect(runCapturedAccessibility(f)).rejects.toThrow(/contour/);
  });
  it("rejects missing county coverage before native dispatch", async () => {
    const f = fixture();
    f.boundary.countyGeoids.push("04001");
    await expect(runCapturedAccessibility(f)).rejects.toThrow();
    expect(f.router.outboundMatrix).not.toHaveBeenCalled();
  });
  it("honors cancellation before any native call", async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      runCapturedAccessibility({ ...f, signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.router.outboundMatrix).not.toHaveBeenCalled();
  });
});
