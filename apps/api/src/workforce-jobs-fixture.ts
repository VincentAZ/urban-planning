/** Synthetic queue/API fixture only. Never connected to a native routing server. */
import {
  workforceContentHash,
  workforceRoutingInputHash,
  type WorkforceRequest,
} from "@urban/core";
import { resolveWorkforce, createWorkforceScenario } from "@urban/models";
import { workforceScenarioFixture } from "../../../tests/fixtures/workforce.js";
import type { WorkforceExecutor } from "./workforce-executor.js";
import type { CapturedWorkforceResult } from "./workforce-runner.js";
import type { WorkforceSourceIdentity } from "./workforce-jobs-types.js";

export class FixtureWorkforceExecutor implements WorkforceExecutor {
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
  async preflight(request: WorkforceRequest): Promise<WorkforceSourceIdentity> {
    this.preflightCalls++;
    if (request.site[0] > -111)
      throw Object.assign(new Error("Synthetic coverage rejection."), {
        code: "ROUTING_COVERAGE",
        statusCode: 422,
      });
    const f = await workforceScenarioFixture();
    return {
      cohortPackHash: f.run.cohortPackHash,
      boundaryHash: f.run.cohortCoverage.boundaryHash!,
      manifestId: f.run.network.id,
      graphHash: f.run.network.graphHash,
      profileHash: f.run.network.profileHash,
      methodVersion: "workforce-1.0.2",
    };
  }
  async execute(options: Parameters<WorkforceExecutor["execute"]>[0]) {
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
    const f = await workforceScenarioFixture();
    f.run.request = structuredClone(options.request);
    f.run.createdAt = new Date().toISOString();
    f.run.inputHash = await workforceRoutingInputHash(
      f.run.cohortPackHash,
      f.run.request,
      f.run.network,
      f.run.cohortCoverage,
    );
    const contour = {
      ...f.artifact.contour,
      site: options.request.site,
      mode: options.request.mode,
    };
    const artifact: CapturedWorkforceResult = {
      version: 1,
      run: f.run,
      result: await resolveWorkforce(f.pack, f.run),
      contour,
      provider: {
        inputHash: "d".repeat(64),
        manifestId: f.run.network.id,
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
      metrics: {
        elapsedMilliseconds: 10,
        routedInputOrigins: 2,
        zeroWeightOrigins: 0,
      },
    };
    const workforce = await createWorkforceScenario({
      binding: options.binding,
      receipt: options.receipt,
      pack: f.pack,
      artifact,
    });
    if (
      (await workforceContentHash(artifact)) !== workforce.capture.artifactHash
    )
      throw new Error("Fixture hash disagreement");
    return { artifact, workforce };
  }
}
