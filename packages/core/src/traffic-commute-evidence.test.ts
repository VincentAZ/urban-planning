import { describe, it, expect } from "vitest";
import { trafficScenarioFixture } from "../../../tests/fixtures/traffic";
import { trafficCommuteEvidenceFixture } from "../../models/src/traffic-commute-evidence-fixture";
import {
  applyCommand,
  canonicalJSON,
  createTrafficScenario,
  trafficScenarioSchema,
  trafficContentHash,
  trafficPairRecipeHash,
  verifyTrafficScenario,
  projectWithTrafficVersion,
  projectWithImportedTraffic,
  type HistoryEntry,
} from "./index";
import { projectSchema } from "./validation";

async function fixture() {
  const f = await trafficScenarioFixture(),
    e = await trafficCommuteEvidenceFixture();
  f.capture.recipe.demandHash = e.binding.demandHash;
  f.capture.recipe.baselineNetworkHash = e.binding.networkHash;
  f.capture.network.baselineFileSha256 = e.binding.networkHash;
  f.capture.recipe.period = structuredClone(e.prior.recipe.period);
  f.capture.comparison.recipeHash = await trafficPairRecipeHash(
    f.capture.recipe,
  );
  const n = e.summary.totals.vehicles;
  for (const side of ["baseline", "proposal"] as const) {
    Object.assign(f.capture.runs[side].diagnostics, {
      requested: n,
      loaded: n,
      inserted: n,
      arrived: n,
    });
    Object.assign(f.capture.comparison[side], { requested: n, completed: n });
  }
  f.capture.originalDemand = {
    hash: e.binding.demandHash,
    vehicleCount: n,
    description: "Synthetic source-derived fixture",
    sourceIds: e.summary.sources.map((s) => s.id),
    commute: e.summary,
  };
  const saved = await createTrafficScenario({
    place: f.place,
    scenario: f.scenario,
    capture: f.capture,
    receipt: f.traffic.receipt,
  });
  return { ...f, e, saved };
}
describe("saved source-derived commute projection", () => {
  it("preserves absent legacy hashes and exact summary through commands/history/imported copies", async () => {
    const legacy = await trafficScenarioFixture(),
      before = canonicalJSON(legacy.traffic);
    expect(canonicalJSON(trafficScenarioSchema.parse(legacy.traffic))).toBe(
      before,
    );
    expect(legacy.traffic.capture.originalDemand).not.toHaveProperty("commute");
    const f = await fixture();
    const after = applyCommand(f.scenario, {
      type: "scenario.traffic",
      traffic: f.saved,
    });
    const history: HistoryEntry = {
      id: "adopt",
      at: "2026-11-06T00:00:00Z",
      actor: "fixture",
      label: "Adopt source subset",
      before: f.scenario,
      after,
      command: { type: "scenario.traffic", traffic: f.saved },
    };
    const project = projectWithTrafficVersion({
      ...f.project,
      scenarios: [f.project.scenarios[0], after],
      history: [history],
      undone: [history],
    });
    const decoded = projectSchema.parse(JSON.parse(JSON.stringify(project)));
    expect(decoded.schemaVersion).toBe(9);
    expect(
      decoded.history[0].after.traffic!.capture.originalDemand.commute,
    ).toEqual(f.e.summary);
    const imported = projectWithImportedTraffic(decoded);
    expect(imported.scenarios[1].traffic!.origin).toBe("imported");
    expect(imported.undone[0].after.traffic!.captureHash).toBe(
      f.saved.captureHash,
    );
    expect(
      imported.history[0].after.traffic!.capture.originalDemand.commute,
    ).toEqual(f.e.summary);
    await expect(
      verifyTrafficScenario(imported.scenarios[1].traffic!, f.place),
    ).resolves.toBeUndefined();
  });
  it("rejects rehashed captures that attach a valid summary to another demand/graph/clock or rewrite original source rights", async () => {
    const f = await fixture();
    for (const modify of [
      (t: typeof f.saved) => {
        t.capture.originalDemand.commute!.binding.demandHash = "f".repeat(64);
      },
      (t: typeof f.saved) => {
        t.capture.originalDemand.commute!.binding.networkHash = "f".repeat(64);
      },
      (t: typeof f.saved) => {
        t.capture.originalDemand.commute!.recipe.period.cooldownSeconds++;
      },
      (t: typeof f.saved) => {
        t.capture.originalDemand.commute!.sources[0].name =
          "Overwritten citation";
      },
    ]) {
      const bad = structuredClone(f.saved);
      modify(bad);
      bad.captureHash = await trafficContentHash(bad.capture);
      await expect(verifyTrafficScenario(bad, f.place)).rejects.toThrow();
    }
  });
});
