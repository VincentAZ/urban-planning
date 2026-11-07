import { describe, it, expect } from "vitest";
import { trafficScenarioFixture } from "../../../tests/fixtures/traffic";
import { trafficNetworkFixture } from "./traffic-fixture";
import { createScenario } from "@urban/models";
import {
  applyCommand,
  baselineIdentity,
  canonicalJSON,
  createTrafficScenario,
  trafficScenarioSchema,
  verifyTrafficScenario,
  trafficScenarioStatus,
  trafficContentHash,
  trafficRoadEditsHash,
  trafficPlanningRoadHash,
  projectWithTrafficVersion,
  projectWithImportVersion,
  projectWithImportedTraffic,
  validateProjectSnapshot,
  type HistoryEntry,
  reviewTrafficPlanningRoads,
  applyTrafficSignalTiming,
  trafficSignalProgramHash,
  TRAFFIC_SIGNAL_SCOPE_NOTES,
  type TrafficSignalTiming,
} from "./index";
import { commandSchema, projectSchema } from "./validation";
function entry(
  before: HistoryEntry["before"],
  after: HistoryEntry["after"],
): HistoryEntry {
  return {
    id: "traffic-history",
    at: "2026-01-12T10:00:00Z",
    actor: "fixture",
    label: "Adopt experiment",
    command: { type: "scenario.traffic", traffic: after.traffic! },
    before,
    after,
  };
}
describe("compact reversible traffic evidence", () => {
  it("retains selected unmapped observations as incomplete while rejecting impossible requested or evaluated totals", async () => {
    const { place, scenario, capture, traffic } =
      await trafficScenarioFixture();
    capture.countEvidence.mappedCountCount = 0;
    capture.countEvidence.unmappedCountCount = 2;
    capture.calibration!.status = "incomplete";
    for (const group of [
      capture.calibration!.calibration,
      capture.calibration!.holdout,
    ]) {
      Object.assign(group, {
        requested: 1,
        evaluated: 0,
        unavailable: 1,
        passed: 0,
        passingFraction: null,
        status: "incomplete",
      });
    }
    const saved = await createTrafficScenario({
      place,
      scenario,
      capture,
      receipt: traffic.receipt,
    });
    await expect(verifyTrafficScenario(saved, place)).resolves.toBeUndefined();
    expect(saved.capture.calibration?.status).toBe("incomplete");
    expect(saved.capture.calibration?.calibration.unavailable).toBe(1);

    const tooManySelected = structuredClone(saved);
    tooManySelected.capture.countEvidence.unmappedCountCount = 1;
    expect(trafficScenarioSchema.safeParse(tooManySelected).success).toBe(
      false,
    );

    const falselyEvaluated = structuredClone(saved);
    falselyEvaluated.capture.calibration!.status = "passed";
    for (const group of [
      falselyEvaluated.capture.calibration!.calibration,
      falselyEvaluated.capture.calibration!.holdout,
    ]) {
      Object.assign(group, {
        evaluated: 1,
        unavailable: 0,
        passed: 1,
        passingFraction: 1,
        status: "passed",
      });
    }
    const evaluated = trafficScenarioSchema.safeParse(falselyEvaluated);
    expect(evaluated.success).toBe(false);
    if (!evaluated.success)
      expect(
        evaluated.error.issues.some((issue) =>
          issue.message.includes("Evaluated count evidence"),
        ),
      ).toBe(true);

    const falsePass = structuredClone(saved);
    falsePass.capture.calibration!.status = "passed";
    falsePass.capture.calibration!.calibration.status = "passed";
    falsePass.capture.calibration!.holdout.status = "passed";
    expect(trafficScenarioSchema.safeParse(falsePass).success).toBe(false);
  });

  it("retains optional exact signal inputs and both programs through format9 history while legacy capture bytes remain unchanged", async () => {
    const { place, project, scenario, capture, traffic } =
      await trafficScenarioFixture();
    const originalBytes = canonicalJSON(traffic),
      originalHash = traffic.captureHash;
    expect(canonicalJSON(trafficScenarioSchema.parse(traffic))).toBe(
      originalBytes,
    );
    expect(traffic.captureHash).toBe(originalHash);
    expect(traffic.capture.proposal).not.toHaveProperty("signalTimings");
    const baseline = trafficNetworkFixture().signals[0];
    baseline.quality = "inferred";
    const control: TrafficSignalTiming = {
      signalId: baseline.id,
      programId: baseline.programId,
      baselineProgramHash: await trafficSignalProgramHash(baseline),
      phaseDurationsSeconds: [40, 30],
      offsetSeconds: 5,
      rationale: "Synthetic authored green hold; no calibration claimed.",
    };
    capture.calibration = null;
    capture.countEvidence.selectionHash = null;
    capture.proposal.signalTimings = [
      {
        control,
        baseline,
        proposal: applyTrafficSignalTiming(baseline, control),
      },
    ];
    const saved = await createTrafficScenario({
      place,
      scenario,
      capture,
      receipt: traffic.receipt,
    });
    expect(saved.capture.calibration).toBeNull();
    expect(saved.capture.proposal.signalTimings![0].baseline.quality).toBe(
      "inferred",
    );
    expect(saved.capture.proposal.signalTimings![0].proposal.quality).toBe(
      "authored",
    );
    expect(
      TRAFFIC_SIGNAL_SCOPE_NOTES.every((note) =>
        saved.capture.notes.includes(note),
      ),
    ).toBe(true);
    const after = applyCommand(scenario, {
      type: "scenario.traffic",
      traffic: saved,
    });
    const withHistory = projectWithTrafficVersion(
      {
        ...project,
        scenarios: [project.scenarios[0], after],
        history: [entry(scenario, after)],
      },
      place,
    );
    await expect(
      validateProjectSnapshot({ place, project: withHistory }),
    ).resolves.toBeDefined();
    expect(projectSchema.parse(withHistory).history[0].after.traffic).toEqual(
      saved,
    );
    const imported = projectWithImportedTraffic(withHistory);
    expect(imported.history[0].after.traffic!.origin).toBe("imported");
    expect(imported.history[0].after.traffic!.captureHash).toBe(
      saved.captureHash,
    );
    expect(
      imported.history[0].after.traffic!.capture.proposal.signalTimings,
    ).toEqual(saved.capture.proposal.signalTimings);
    expect(canonicalJSON(traffic)).toBe(originalBytes);
  });
  it("rejects invented signal programs, altered timing hashes and absent citation inventory even after capture rehashing", async () => {
    const { place, scenario, capture, traffic } =
      await trafficScenarioFixture();
    const baseline = trafficNetworkFixture().signals[0];
    const control: TrafficSignalTiming = {
      signalId: baseline.id,
      programId: baseline.programId,
      baselineProgramHash: await trafficSignalProgramHash(baseline),
      phaseDurationsSeconds: [40, 30],
      offsetSeconds: 5,
      rationale: "Synthetic fixture.",
    };
    capture.proposal.signalTimings = [
      {
        control,
        baseline,
        proposal: applyTrafficSignalTiming(baseline, control),
      },
    ];
    const saved = await createTrafficScenario({
      place,
      scenario,
      capture,
      receipt: traffic.receipt,
    });
    const altered = structuredClone(saved);
    altered.capture.proposal.signalTimings![0].control.baselineProgramHash =
      "0".repeat(64);
    altered.captureHash = await trafficContentHash(altered.capture);
    await expect(verifyTrafficScenario(altered, place)).rejects.toThrow(
      /program hash/,
    );
    const missing = structuredClone(saved);
    missing.capture.proposal.signalTimings![0].baseline.sourceIds = ["absent"];
    missing.capture.proposal.signalTimings![0].proposal.sourceIds = ["absent"];
    expect(trafficScenarioSchema.safeParse(missing).success).toBe(false);
    const changed = structuredClone(saved);
    changed.capture.proposal.signalTimings![0].proposal.phases[0].state = "r";
    expect(trafficScenarioSchema.safeParse(changed).success).toBe(false);
    const duplicate = structuredClone(saved);
    duplicate.capture.proposal.signalTimings!.push(
      structuredClone(duplicate.capture.proposal.signalTimings![0]),
    );
    expect(trafficScenarioSchema.safeParse(duplicate).success).toBe(false);
  });
  it("retains optional per-property correspondence without changing old captures or their hashes", async () => {
    const { place, scenario, capture, traffic } =
      await trafficScenarioFixture();
    const network = trafficNetworkFixture();
    const oldBytes = canonicalJSON(traffic);
    expect(trafficScenarioSchema.parse(traffic)).toEqual(traffic);
    expect(canonicalJSON(traffic)).toBe(oldBytes);
    expect(traffic.capture.proposal.planningRoadMapping).not.toHaveProperty(
      "correspondence",
    );
    const edited = applyCommand(scenario, {
      type: "road.upsert",
      road: { ...place.roads[0], speedMph: 30, signal: true },
    });
    const { overlays, planningRoads } = await reviewTrafficPlanningRoads({
      place,
      scenario: edited,
      network,
      reviewedBy: "fixture-reviewer",
      reviewedAt: "2026-01-12T10:00:00Z",
      reviews: [
        {
          roadId: place.roads[0].id,
          properties: ["speed"],
          directions: [{ direction: "with-road", edgeIds: ["in"] }],
          extent: "partial-road",
          nativeExtensionAcknowledged: true,
          rationale:
            "Synthetic partial correspondence; other street properties remain unrepresented.",
        },
      ],
    });
    capture.proposal.overlays = overlays;
    capture.proposal.planningRoadMapping = {
      status: "explicitly-reviewed",
      correspondence: planningRoads,
      unrepresentedRoadIds: [],
      notes: [],
      reviewedLinks: planningRoads.reviews.map((r) => ({
        roadId: r.roadId,
        roadEditHash: r.roadEditHash,
        edgeIds: r.directions.flatMap((d) => d.edgeIds),
        representedProperties: r.properties,
        reviewedBy: r.reviewedBy,
        reviewedAt: r.reviewedAt,
      })),
    };
    const saved = await createTrafficScenario({
      place,
      scenario: edited,
      capture,
      receipt: traffic.receipt,
    });
    await expect(verifyTrafficScenario(saved, place)).resolves.toBeUndefined();
    expect(
      saved.capture.proposal.planningRoadMapping.correspondence!.exclusions.map(
        (e) => [e.property, e.reason],
      ),
    ).toEqual([
      ["speed", "partial-extent"],
      ["signal", "unsupported"],
    ]);
    const tampered = structuredClone(saved);
    tampered.capture.proposal.overlays[0].speedMps = 99;
    expect(trafficScenarioSchema.safeParse(tampered).success).toBe(false);
    tampered.capture.proposal.overlays[0].speedMps = overlays[0].speedMps;
    tampered.capture.proposal.planningRoadMapping.reviewedLinks[0].representedProperties =
      ["lanes"];
    expect(trafficScenarioSchema.safeParse(tampered).success).toBe(false);
    const stale = structuredClone(capture);
    stale.proposal.planningRoadMapping.correspondence!.roadEditsHash =
      "0".repeat(64);
    await expect(
      createTrafficScenario({
        place,
        scenario: edited,
        capture: stale,
        receipt: traffic.receipt,
      }),
    ).rejects.toThrow(/stale/);
  });
  it("retains exact summaries, separate source inventory and private archive identity within the bounded capture", async () => {
    const { place, traffic } = await trafficScenarioFixture();
    await expect(
      verifyTrafficScenario(traffic, place),
    ).resolves.toBeUndefined();
    expect(traffic.capture.analysisScope).toBe("explicit-network-experiment");
    expect(traffic.capture.comparison.baseline.meanTravelTimeSeconds).toBe(40);
    expect(traffic.capture).not.toHaveProperty("trips");
    expect(traffic.capture.network).not.toHaveProperty("edges");
    expect(traffic.capture.calibration).not.toHaveProperty("rows");
    expect(JSON.stringify(traffic).length).toBeLessThan(256 * 1024);
    expect(
      traffic.capture.notes.some((n) =>
        n.includes("not a simulation of every planning edit"),
      ),
    ).toBe(true);
  });
  it("upgrades only traffic-bearing projects, preserves old baseline bytes, and keeps version9 through removal and undo", async () => {
    const { place, project, scenario, traffic } =
        await trafficScenarioFixture(),
      original = canonicalJSON(project),
      hash = await baselineIdentity(place);
    expect(projectWithTrafficVersion(project, place)).toBe(project);
    expect(canonicalJSON(project)).toBe(original);
    const after = applyCommand(scenario, { type: "scenario.traffic", traffic }),
      history = entry(scenario, after);
    const upgraded = projectWithTrafficVersion(
      {
        ...project,
        scenarios: [project.scenarios[0], after],
        history: [history],
      },
      place,
    );
    expect(upgraded.schemaVersion).toBe(9);
    expect(
      projectSchema.safeParse({ ...upgraded, schemaVersion: 8 }).success,
    ).toBe(false);
    const removed = applyCommand(after, {
      type: "scenario.traffic",
      traffic: null,
    });
    expect(removed.traffic).toBeUndefined();
    expect(removed.revision).toBe(after.revision + 1);
    const undone = {
      ...upgraded,
      scenarios: [project.scenarios[0], scenario],
      history: [],
      undone: [history],
    };
    expect(projectWithTrafficVersion(undone).schemaVersion).toBe(9);
    expect(projectWithImportVersion(undone).schemaVersion).toBe(9);
    expect(await baselineIdentity(place)).toEqual(hash);
    await expect(
      validateProjectSnapshot({ project: undone, place }),
    ).resolves.toBeDefined();
  });
  it("deep-clones branches and command history without mutating baseline or passed evidence", async () => {
    const { scenario, traffic, project } = await trafficScenarioFixture(),
      before = canonicalJSON(traffic),
      after = applyCommand(scenario, { type: "scenario.traffic", traffic }),
      branch = createScenario("Another option", after);
    branch.traffic!.capture.notes.push("branch only");
    expect(after.traffic!.capture.notes).not.toContain("branch only");
    expect(canonicalJSON(traffic)).toBe(before);
    expect(scenario.traffic).toBeUndefined();
    expect(() =>
      applyCommand(project.scenarios[0], { type: "scenario.traffic", traffic }),
    ).toThrow(/baseline/);
  });
  it("detects additions, removals, geometry and control changes while unrelated edits retain explicit-demand scope", async () => {
    const { place, scenario, traffic } = await trafficScenarioFixture();
    expect((await trafficScenarioStatus(traffic, place, scenario)).stale).toBe(
      false,
    );
    for (const changed of [
      applyCommand(scenario, { type: "road.remove", id: place.roads[0].id }),
      applyCommand(scenario, {
        type: "road.upsert",
        road: {
          ...place.roads[0],
          signal: true,
          cycleSeconds: 90,
          greenSplit: 0.5,
        },
      }),
      applyCommand(scenario, {
        type: "road.upsert",
        road: { ...place.roads[0], id: "new-road" },
      }),
    ])
      expect((await trafficScenarioStatus(traffic, place, changed)).stale).toBe(
        true,
      );
    const details = applyCommand(scenario, {
      type: "scenario.details",
      name: "New name",
      description: "New text",
    });
    details.horizon = 10;
    expect(await trafficRoadEditsHash(place, details)).toBe(
      traffic.binding.roadEditsHash,
    );
    expect(
      (await trafficScenarioStatus(traffic, place, details)).notes.some((n) =>
        n.includes("horizon changes do not automatically"),
      ),
    ).toBe(true);
  });
  it("requires exact reviewed road content and allows explicit removed-road closure mapping", async () => {
    const { place, scenario, capture, traffic } =
      await trafficScenarioFixture();
    capture.proposal.planningRoadMapping = {
      status: "explicitly-reviewed",
      reviewedLinks: [
        {
          roadId: place.roads[0].id,
          roadEditHash: "0".repeat(64),
          edgeIds: ["in"],
          representedProperties: ["speed"],
          reviewedBy: "fixture",
          reviewedAt: "2026-01-12T10:00:00Z",
        },
      ],
      unrepresentedRoadIds: [],
      notes: [],
    };
    await expect(
      createTrafficScenario({
        place,
        scenario,
        capture,
        receipt: traffic.receipt,
      }),
    ).rejects.toThrow(/correspondence/);
    const removed = applyCommand(scenario, {
      type: "road.remove",
      id: place.roads[0].id,
    });
    capture.proposal.planningRoadMapping.reviewedLinks[0].roadEditHash =
      await trafficPlanningRoadHash(place, removed, place.roads[0].id);
    capture.proposal.planningRoadMapping.reviewedLinks[0].representedProperties =
      ["closure"];
    capture.proposal.overlays = [{ edgeId: "in", closed: true }];
    await expect(
      createTrafficScenario({
        place,
        scenario: removed,
        capture,
        receipt: traffic.receipt,
      }),
    ).resolves.toBeDefined();
  });
  it("rejects fabricated summary completeness, deltas, criteria and private path disclosure", async () => {
    const { traffic } = await trafficScenarioFixture();
    for (const change of [
      (v: typeof traffic) => {
        v.capture.comparison.baseline.status = "incomplete";
      },
      (v: typeof traffic) => {
        v.capture.comparison.delta.meanTravelTimeSeconds = 999;
      },
      (v: typeof traffic) => {
        v.capture.runs.proposal.diagnostics.teleports = 1;
      },
      (v: typeof traffic) => {
        v.capture.calibration!.holdout.status = "failed";
      },
      (v: typeof traffic) => {
        v.capture.files[0].url = "/private/server/result.json";
      },
      (v: typeof traffic) => {
        v.capture.sources = [];
      },
      (v: typeof traffic) => {
        v.capture.notes = Array.from({ length: 40 }, () => "x".repeat(9000));
      },
    ]) {
      const bad = structuredClone(traffic);
      change(bad);
      expect(trafficScenarioSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("retains execution-only experiments without fabricating calibration criteria or held-out evidence", async () => {
    const { place, scenario, capture, traffic } =
      await trafficScenarioFixture();
    capture.calibration = null;
    capture.countEvidence.selectionHash = null;
    capture.countEvidence.mappedCountCount = 0;
    capture.countEvidence.unmappedCountCount = 456;
    const unassessed = await createTrafficScenario({
      place,
      scenario,
      capture,
      receipt: traffic.receipt,
    });
    expect(unassessed.capture.calibration).toBeNull();
    expect(unassessed.capture.countEvidence.selectionHash).toBeNull();
    expect(unassessed.capture.comparison.baseline.status).toBe("complete");
    const inconsistent = structuredClone(unassessed);
    inconsistent.capture.countEvidence.selectionHash = "1".repeat(64);
    expect(trafficScenarioSchema.safeParse(inconsistent).success).toBe(false);
  });
  it("verifies every historical, undone and command-only capture; stale geometry alone does not corrupt history", async () => {
    const { place, project, scenario, traffic } =
        await trafficScenarioFixture(),
      after = applyCommand(scenario, { type: "scenario.traffic", traffic }),
      history = entry(scenario, after);
    const p = projectWithTrafficVersion({ ...project, history: [history] });
    await expect(
      validateProjectSnapshot({ project: p, place }),
    ).resolves.toBeDefined();
    const bad = structuredClone(p);
    if (bad.history[0].command.type !== "scenario.traffic")
      throw new Error("fixture");
    bad.history[0].command.traffic!.capture.privateArchive.bytes++;
    await expect(
      validateProjectSnapshot({ project: bad, place }),
    ).rejects.toThrow(/content.*hash/);
    const mismatched = structuredClone(traffic);
    mismatched.binding.baselineHash = "0".repeat(64);
    await expect(verifyTrafficScenario(mismatched, place)).rejects.toThrow(
      /baseline/,
    );
    const updated = applyCommand(after, {
      type: "road.remove",
      id: place.roads[0].id,
    });
    await expect(
      validateProjectSnapshot({
        project: projectWithTrafficVersion({
          ...project,
          scenarios: [project.scenarios[0], updated],
        }),
        place,
      }),
    ).resolves.toBeDefined();
  });
  it("marks all copied evidence imported without changing exact capture numbers or hashes", async () => {
    const { project, scenario, traffic } = await trafficScenarioFixture(),
      after = applyCommand(scenario, { type: "scenario.traffic", traffic }),
      history = entry(scenario, after),
      p = projectWithTrafficVersion({
        ...project,
        scenarios: [project.scenarios[0], after],
        history: [history],
        undone: [history],
      });
    const copy = projectWithImportedTraffic(p);
    expect(copy).not.toBe(p);
    expect(copy.scenarios[1].traffic!.origin).toBe("imported");
    expect(copy.history[0].after.traffic!.origin).toBe("imported");
    expect(
      copy.undone[0].command.type === "scenario.traffic" &&
        copy.undone[0].command.traffic!.origin,
    ).toBe("imported");
    expect(copy.scenarios[1].traffic!.captureHash).toBe(traffic.captureHash);
    expect(await trafficContentHash(copy.scenarios[1].traffic!.capture)).toBe(
      traffic.captureHash,
    );
    expect(p.scenarios[1].traffic!.origin).toBe("server-run");
    expect(
      commandSchema.safeParse({ type: "scenario.traffic", traffic: null })
        .success,
    ).toBe(true);
  });
});
