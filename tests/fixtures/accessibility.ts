/** Entirely synthetic evidence; no provider requests or test-runner side effects. */
import {
  ACCESSIBILITY_CELLS,
  accessibilityContentHash,
  accessibilityRoutingInputHash,
  type Place,
  type AccessibilityDestinationPack,
  type AccessibilityRoutingRun,
  type CapturedAccessibilityResult,
} from "@urban/core";
import {
  createAccessibilityModeEvidence,
  resolveAccessibility,
} from "@urban/models";

export function accessibilityPackFixture(): AccessibilityDestinationPack {
  const destinations = [10, 20, 0].map((jobs, i) => {
    const id = `04013000100100${i}`;
    const cells = Object.fromEntries(ACCESSIBILITY_CELLS.map((k) => [k, 0]));
    cells.C000 = jobs;
    cells.CE01 = jobs;
    cells.CNS01 = jobs;
    return {
      id,
      position: [-112.07 + i * 0.001, 33.45] as [number, number],
      sourceRow: i + 2,
      cells,
      raw: {
        w_geocode: id,
        createdate: "20251202",
        ...Object.fromEntries(
          Object.entries(cells).map(([k, v]) => [k, String(v)]),
        ),
      },
    };
  });
  return {
    version: 1,
    id: "synthetic-accessibility-fixture",
    lodes: {
      year: 2023,
      jobType: "JT01",
      segment: "S000",
      blockGeographyVintage: 2020,
      formatVersion: "8.5",
      dataVintage: "synthetic",
      createdates: ["20251202"],
    },
    region: {
      stateFips: "04",
      label: "Synthetic test region",
      countyGeoids: ["04013"],
      complete: true,
    },
    pointMethod: "census-native-block-internal-point",
    sources: [
      {
        id: "accessibility-fixture",
        name: "Synthetic test evidence",
        url: "",
        vintage: "Test only",
        license: "Test",
        kind: "user-supplied",
      },
    ],
    files: [
      {
        sourceId: "accessibility-fixture",
        url: "",
        sha256: "a".repeat(64),
        bytes: 1,
        retrievedAt: "2026-11-06T00:00:00Z",
      },
    ],
    destinations,
    notes: ["Synthetic fixture; not actual Census data."],
  };
}
export async function accessibilityRunFixture(
  pack = accessibilityPackFixture(),
  mode: "car" | "walk" = "car",
): Promise<AccessibilityRoutingRun> {
  const request = {
    site: [-112.07, 33.45] as [number, number],
    mode,
    direction: "outbound" as const,
    thresholdsMinutes: [15, 30, 45] as [15, 30, 45],
  };
  const network = {
    id: "fixture-network",
    engine: "fixture",
    engineVersion: "1",
    graphHash: "b".repeat(64),
    profileHash: "c".repeat(64),
    sourceHashes: ["a".repeat(64)],
    extent: [-113, 32, -111, 35] as [number, number, number, number],
    coverage: "complete" as const,
    costing: "static" as const,
    notes: ["Synthetic directed routing."],
    exclusionProof: {
      method: "conservative-great-circle" as const,
      maximumSpeedKph: mode === "car" ? 140 : 10,
      snapAllowanceMeters: 500,
    },
  };
  const sourceCoverage = {
    status: "complete" as const,
    boundaryHash: "d".repeat(64),
    notes: ["Synthetic complete boundary."],
  };
  const jobsPackHash = await accessibilityContentHash(pack);
  return {
    version: 1,
    jobsPackHash,
    inputHash: await accessibilityRoutingInputHash(
      jobsPackHash,
      request,
      network,
      sourceCoverage,
    ),
    createdAt: "2026-11-06T00:00:00Z",
    request,
    network,
    sourceCoverage,
    rows: pack.destinations.map((d, i) => ({
      id: d.id,
      status: d.cells.C000 === 0 ? "zero-jobs" : "reachable",
      seconds: d.cells.C000 === 0 ? null : i === 0 ? 900 : 1800,
      distanceMeters: d.cells.C000 === 0 ? null : 100,
      snapMeters: d.cells.C000 === 0 ? null : 0,
    })),
  };
}
export const accessibilityPlaceFixture: Place = {
  id: "accessibility-fixture",
  name: "Synthetic accessibility site",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.45],
  bounds: [-112.08, 33.44, -112.06, 33.46],
  boundary: [
    [-112.08, 33.44],
    [-112.06, 33.44],
    [-112.06, 33.46],
    [-112.08, 33.46],
    [-112.08, 33.44],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-06T00:00:00Z",
  extentLabel: "Synthetic fixture",
};
export async function accessibilityFixture(
  options: {
    mode?: "car" | "walk";
    place?: Place;
    binding?: { placeId: string; baselineHash: string };
    receipt?: { projectId: string; jobId: string };
  } = {},
) {
  const place = structuredClone(options.place ?? accessibilityPlaceFixture),
    pack = accessibilityPackFixture(),
    run = await accessibilityRunFixture(pack, options.mode);
  run.request.site = [...place.center];
  run.inputHash = await accessibilityRoutingInputHash(
    run.jobsPackHash,
    run.request,
    run.network,
    run.sourceCoverage,
  );
  const result = await resolveAccessibility(pack, run);
  const artifact: CapturedAccessibilityResult = {
    version: 1,
    run,
    result,
    provider: {
      inputHash: "e".repeat(64),
      manifestId: run.network.id,
      siteSnapMeters: 0,
      search: {
        algorithm: "timedistancematrix",
        baseExpansionMeters: 105000,
        terminalEdgePaddingPolicy: "maximum-correlated-edge-length",
        batches: [
          {
            firstInputIndex: 0,
            inputCount: 2,
            routedCount: 2,
            maximumCorrelatedEdgeMeters: 100,
            expansionMaxDistanceMeters: 105100,
          },
        ],
      },
    },
    contour: {
      manifestId: run.network.id,
      inputHash: "f".repeat(64),
      site: run.request.site,
      mode: run.request.mode,
      direction: "outbound",
      minutes: [15, 30, 45],
      notes: ["Synthetic display contour."],
      geometry: {
        type: "FeatureCollection",
        features: ([15, 30, 45] as const).map((minutes) => ({
          type: "Feature",
          properties: { contour: minutes },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-112.1, 33.4],
                [-112.0, 33.4],
                [-112.0, 33.5],
                [-112.1, 33.4],
              ],
            ],
          },
        })),
      },
    },
  };
  const evidence = await createAccessibilityModeEvidence({
    binding: options.binding ?? {
      placeId: place.id,
      baselineHash: await accessibilityContentHash(place),
    },
    receipt: options.receipt ?? {
      projectId: "fixture-project",
      jobId: "fixture-job",
    },
    pack,
    artifact,
  });
  return { place, pack, run, artifact, evidence };
}
