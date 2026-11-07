/** Synthetic test evidence only. No provider requests, actual population claims, or test-runner side effects. */
import {
  workforceContentHash,
  workforceRoutingInputHash,
  type Place,
  type WorkforceCell,
  type WorkforceCohortPack,
  type WorkforceRoutingRun,
  type WorkforceContour,
} from "@urban/core";
import { resolveWorkforce, createWorkforceScenario } from "@urban/models";
const cell = (value: number, moe = 0): WorkforceCell => ({
  estimate: {
    value,
    raw: String(value),
    annotation: null,
    status: "available",
  },
  marginOfError: {
    value: moe,
    raw: String(moe),
    annotation: null,
    status: "available",
  },
});
export function workforcePackFixture(): WorkforceCohortPack {
  const education = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `B15003_${String(i + 1).padStart(3, "0")}`,
      cell(0),
    ]),
  );
  const occupation = Object.fromEntries(
    Array.from({ length: 73 }, (_, i) => [
      `C24010_${String(i + 1).padStart(3, "0")}`,
      cell(0),
    ]),
  );
  education.B15003_001 = cell(100, 10);
  education.B15003_022 = cell(100, 10);
  occupation.C24010_001 = cell(100, 10);
  occupation.C24010_003 = cell(60, 6);
  occupation.C24010_039 = cell(40, 8);
  return {
    version: 1,
    id: "synthetic-model-fixture",
    acs: {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      confidenceLevel: 90,
      boundaryVintage: "2024",
    },
    region: {
      label: "Synthetic unit test",
      countyGeoids: ["04013"],
      complete: true,
    },
    sources: [
      {
        id: "fixture",
        name: "Synthetic unit test",
        url: "",
        vintage: "2024",
        license: "Test",
        kind: "user-supplied",
      },
    ],
    files: [
      {
        sourceId: "fixture",
        url: "https://example.org/test",
        sha256: "a".repeat(64),
        retrievedAt: "2026-11-06T00:00:00Z",
      },
    ],
    allocation: {
      method: "2020-block-population",
      sourceId: "fixture",
      vintage: 2020,
      geographyMatch: "verified",
      notes: ["Synthetic evidence only."],
    },
    units: [
      {
        geoid: "040130001001",
        name: "Synthetic BG",
        education,
        occupation,
        allocationStatus: "complete",
      },
    ],
    unallocatedOrigins: [],
    origins: [
      {
        id: "040130001001001",
        unitGeoid: "040130001001",
        position: [-112, 33],
        population2020: 20,
        weight: 0.2,
      },
      {
        id: "040130001001002",
        unitGeoid: "040130001001",
        position: [-112.01, 33],
        population2020: 80,
        weight: 0.8,
      },
    ],
  };
}
export async function workforceRunFixture(
  p: WorkforceCohortPack,
  seconds = [900, 1800],
): Promise<WorkforceRoutingRun> {
  const r: WorkforceRoutingRun = {
    version: 1,
    cohortPackHash: await workforceContentHash(p),
    inputHash: "0".repeat(64),
    createdAt: "2026-11-06T00:00:00Z",
    request: {
      site: [-112, 33],
      mode: "car",
      direction: "inbound",
      thresholdsMinutes: [15, 30, 45],
    },
    network: {
      id: "fixture-network",
      engine: "fixture",
      engineVersion: "1",
      graphHash: "1".repeat(64),
      profileHash: "2".repeat(64),
      sourceHashes: ["3".repeat(64)],
      extent: [-113, 32, -111, 34],
      coverage: "complete",
      costing: "static",
      notes: [],
    },
    cohortCoverage: {
      status: "complete",
      boundaryHash: "b".repeat(64),
      notes: ["Synthetic fixture coverage proof."],
    },
    rows: p.origins.map((o, i) => ({
      id: o.id,
      status: "reachable",
      seconds: seconds[i] ?? 100,
      distanceMeters: 100,
      snapMeters: 1,
    })),
  };
  r.inputHash = await workforceRoutingInputHash(
    r.cohortPackHash,
    r.request,
    r.network,
    r.cohortCoverage,
  );
  return r;
}

export const workforcePlaceFixture: Place = {
  id: "workforce-fixture",
  name: "Synthetic workforce site",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [-112, 33],
  bounds: [-112.02, 32.98, -111.98, 33.02],
  boundary: [
    [-112.02, 32.98],
    [-111.98, 32.98],
    [-111.98, 33.02],
    [-112.02, 33.02],
    [-112.02, 32.98],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Synthetic workforce fixture",
};
export async function workforceScenarioFixture(
  options: {
    place?: Place;
    projectId?: string;
    jobId?: string;
    partial?: boolean;
  } = {},
) {
  const place = structuredClone(options.place ?? workforcePlaceFixture),
    pack = workforcePackFixture(),
    run = await workforceRunFixture(pack);
  run.request.site = [...place.center];
  run.network.extent = [-179, -89, 179, 89];
  if (options.partial)
    run.rows[1] = {
      id: run.rows[1].id,
      status: "unsnappable",
      seconds: null,
      distanceMeters: null,
      snapMeters: null,
    };
  run.inputHash = await workforceRoutingInputHash(
    run.cohortPackHash,
    run.request,
    run.network,
    run.cohortCoverage,
  );
  const [x, y] = run.request.site;
  const contour: WorkforceContour = {
    manifestId: run.network.id,
    inputHash: "c".repeat(64),
    site: [...run.request.site],
    mode: run.request.mode,
    direction: "inbound",
    minutes: [15, 30, 45],
    geometry: {
      type: "FeatureCollection",
      features: [15, 30, 45].map((minutes) => ({
        type: "Feature",
        properties: { contour: minutes, metric: "time" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [x - 0.001, y - 0.001],
              [x + 0.001, y - 0.001],
              [x + 0.001, y + 0.001],
              [x - 0.001, y + 0.001],
              [x - 0.001, y - 0.001],
            ],
          ],
        },
      })),
    },
    notes: ["Synthetic contours only; never real travel-time evidence."],
  };
  const result = await resolveWorkforce(pack, run),
    artifact = {
      version: 1,
      run,
      result,
      contour,
      provider: { siteSnapMeters: 12.5 },
    };
  const workforce = await createWorkforceScenario({
    place,
    pack,
    artifact,
    receipt: {
      projectId: options.projectId ?? "fixture-project",
      jobId: options.jobId ?? "fixture-job",
    },
  });
  return { place, pack, run, artifact, workforce };
}
