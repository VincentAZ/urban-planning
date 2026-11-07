/** Synthetic queue/authority fixture. No source download or native routing occurs. */
import {
  ACCESSIBILITY_CELLS,
  accessibilityContentHash,
  accessibilityRoutingInputHash,
  type AccessibilityDestinationPack,
  type AccessibilityRequest,
  type AccessibilityRoutingRun,
  type CapturedAccessibilityResult,
} from "@urban/core";
import {
  resolveAccessibility,
  createAccessibilityModeEvidence,
} from "@urban/models";
import { workforceScenarioFixture } from "../../../tests/fixtures/workforce.js";
import type { AccessibilityExecutor } from "./accessibility-executor.js";
import type { AccessibilitySourceIdentity } from "./accessibility-jobs-types.js";
export async function accessibilityJobsFixture(request?: AccessibilityRequest) {
  const f = await workforceScenarioFixture();
  const cells = Object.fromEntries(ACCESSIBILITY_CELLS.map((k) => [k, 0]));
  cells.C000 = 50;
  cells.CE01 = 50;
  cells.CNS01 = 50;
  const pack: AccessibilityDestinationPack = {
    version: 1,
    id: "accessibility-fixture",
    lodes: {
      year: 2023,
      jobType: "JT01",
      segment: "S000",
      blockGeographyVintage: 2020,
      formatVersion: "synthetic",
      dataVintage: "synthetic-test-only",
      createdates: ["20251203"],
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
        name: "Synthetic primary-job fixture",
        kind: "inferred",
        vintage: "2023",
        url: "",
        license: "test-only",
      },
    ],
    files: [
      {
        sourceId: "accessibility-fixture",
        url: "",
        sha256: "1".repeat(64),
        bytes: 1,
        retrievedAt: "2026-01-01T00:00:00Z",
      },
    ],
    destinations: ["040130001001001", "040130001001002"].map((id, i) => ({
      id,
      position: [...f.run.request.site],
      sourceRow: i + 2,
      cells: { ...cells },
      raw: {
        w_geocode: id,
        createdate: "20251203",
        ...Object.fromEntries(
          Object.entries(cells).map(([k, v]) => [k, String(v)]),
        ),
      },
    })),
    notes: ["Synthetic jobs; not actual Census data."],
  };
  const query: AccessibilityRequest = request ?? {
    ...f.run.request,
    direction: "outbound",
  };
  const network = {
    ...f.run.network,
    profileHash: await accessibilityContentHash({
      fixture: "outbound",
      mode: query.mode,
    }),
  };
  const run: AccessibilityRoutingRun = {
    version: 1,
    jobsPackHash: await accessibilityContentHash(pack),
    createdAt: new Date().toISOString(),
    request: query,
    network,
    sourceCoverage: f.run.cohortCoverage,
    inputHash: "0".repeat(64),
    rows: pack.destinations.map((d) => ({
      id: d.id,
      status: "reachable",
      seconds: 600,
      distanceMeters: 1000,
      snapMeters: 12.5,
    })),
  };
  run.inputHash = await accessibilityRoutingInputHash(
    run.jobsPackHash,
    query,
    network,
    run.sourceCoverage,
  );
  const artifact: CapturedAccessibilityResult = {
    version: 1,
    run,
    result: await resolveAccessibility(pack, run),
    contour: {
      ...f.artifact.contour,
      direction: "outbound",
      site: query.site,
      mode: query.mode,
    },
    provider: {
      inputHash: "d".repeat(64),
      manifestId: network.id,
      siteSnapMeters: 12.5,
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
  };
  return { pack, run, artifact };
}
export class FixtureAccessibilityExecutor implements AccessibilityExecutor {
  calls = 0;
  preflightCalls = 0;
  fail = false;
  blocker?: Promise<void>;
  async describe() {
    return {
      id: "synthetic-model-fixture",
      name: "Synthetic test region",
      extent: [-113, 32, -111, 34] as [number, number, number, number],
    };
  }
  async preflight(
    request: AccessibilityRequest,
  ): Promise<AccessibilitySourceIdentity> {
    this.preflightCalls++;
    if (request.site[0] > -111)
      throw Object.assign(new Error("Synthetic coverage rejection."), {
        code: "ROUTING_COVERAGE",
        statusCode: 422,
      });
    const f = await accessibilityJobsFixture(request);
    return {
      jobsPackHash: f.run.jobsPackHash,
      boundaryHash: f.run.sourceCoverage.boundaryHash!,
      manifestId: f.run.network.id,
      graphHash: f.run.network.graphHash,
      profileHash: f.run.network.profileHash,
      methodVersion: "accessibility-1.0.0",
    };
  }
  async execute(options: Parameters<AccessibilityExecutor["execute"]>[0]) {
    this.calls++;
    options.progress("routing");
    if (this.blocker)
      await Promise.race([
        this.blocker,
        new Promise<never>((_, reject) => {
          if (options.signal.aborted) reject(new Error("Cancelled fixture"));
          else
            options.signal.addEventListener(
              "abort",
              () => reject(new Error("Cancelled fixture")),
              { once: true },
            );
        }),
      ]);
    if (this.fail) throw new Error("Synthetic retryable failure.");
    const f = await accessibilityJobsFixture(options.request);
    const accessibility = await createAccessibilityModeEvidence({
      binding: options.binding,
      receipt: options.receipt,
      pack: f.pack,
      artifact: f.artifact,
    });
    return { artifact: f.artifact, accessibility };
  }
}
