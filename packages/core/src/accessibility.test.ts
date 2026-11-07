import { describe, expect, it } from "vitest";
import {
  accessibilityFixture,
  accessibilityPackFixture,
} from "../../../tests/fixtures/accessibility";
import { createProject, createScenario } from "@urban/models";
import {
  applyCommand,
  accessibilityContentHash,
  assertAccessibilityDestinationPack,
  accessibilityModeEvidenceSchema,
  accessibilityScenarioSchema,
  verifyAccessibilityModeEvidence,
  projectWithAccessibilityVersion,
  projectWithImportedAccessibility,
  canonicalJSON,
  validateProjectSnapshot,
  baselineIdentity,
  type HistoryEntry,
} from "./index";
import { projectSchema, commandSchema } from "./validation";

describe("complete accessibility evidence and reversible adoption", () => {
  it("rejects missing cells, duplicate native rows and category inconsistencies instead of defaulting to zero", () => {
    const fixture = accessibilityPackFixture();
    expect(() => assertAccessibilityDestinationPack(fixture)).not.toThrow();
    for (const change of [
      (p: typeof fixture) => {
        delete p.destinations[0].cells.CE01;
      },
      (p: typeof fixture) => {
        p.destinations[0].raw.CE01 = "";
      },
      (p: typeof fixture) => {
        p.destinations[0].cells.CE01 = 9;
        p.destinations[0].raw.CE01 = "9";
      },
      (p: typeof fixture) => {
        p.destinations[1] = p.destinations[0];
      },
      (p: typeof fixture) => {
        p.region.countyGeoids = [];
      },
    ]) {
      const pack = structuredClone(fixture);
      change(pack);
      expect(() => assertAccessibilityDestinationPack(pack)).toThrow();
    }
  });
  it("retains exact captures and no full graph, route ledger or contour in saved history", async () => {
    const { evidence, artifact } = await accessibilityFixture();
    await expect(
      verifyAccessibilityModeEvidence(evidence),
    ).resolves.toBeUndefined();
    expect(evidence.capture.artifactHash).toBe(
      await accessibilityContentHash(artifact),
    );
    expect(evidence.capture.thresholds).toEqual(artifact.result.thresholds);
    expect(evidence.capture).not.toHaveProperty("rows");
    expect(evidence.capture.contour).not.toHaveProperty("geometry");
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(
      256 * 1024,
    );
  });
  it("rejects forged completeness, category definitions, coverage and content hashes", async () => {
    const { evidence } = await accessibilityFixture();
    for (const change of [
      (e: typeof evidence) => {
        e.capture.thresholds[0].total.knownSubtotal = null;
      },
      (e: typeof evidence) => {
        e.capture.thresholds[0].total.unresolvedJobs = 1;
      },
      (e: typeof evidence) => {
        e.capture.thresholds[0].earnings[0].id = "available-workers";
      },
      (e: typeof evidence) => {
        e.capture.coverage.destinationCount++;
      },
      (e: typeof evidence) => {
        e.capture.thresholds[2].minutes = 30;
      },
      (e: typeof evidence) => {
        e.capture.coverage.network = "bounded";
      },
    ]) {
      const bad = structuredClone(evidence);
      change(bad);
      expect(accessibilityModeEvidenceSchema.safeParse(bad).success).toBe(
        false,
      );
    }
    const bad = structuredClone(evidence);
    bad.capture.notes.push("Altered");
    await expect(verifyAccessibilityModeEvidence(bad)).rejects.toThrow(
      /hash mismatch/,
    );
  });
  it("adopts/removes one mode without losing the other and rejects baseline/mode confusion", async () => {
    const car = await accessibilityFixture(),
      walk = await accessibilityFixture({ mode: "walk" });
    const scenario = createScenario("Option");
    const withCar = applyCommand(scenario, {
      type: "scenario.accessibility",
      mode: "car",
      evidence: car.evidence,
    });
    const both = applyCommand(withCar, {
      type: "scenario.accessibility",
      mode: "walk",
      evidence: walk.evidence,
    });
    expect(both.accessibility?.captures.car).toEqual(car.evidence);
    expect(createScenario("Clone", both).accessibility).toEqual(
      both.accessibility,
    );
    const removed = applyCommand(both, {
      type: "scenario.accessibility",
      mode: "car",
      evidence: null,
    });
    expect(removed.accessibility?.captures).toEqual({ walk: walk.evidence });
    expect(
      applyCommand(removed, {
        type: "scenario.accessibility",
        mode: "walk",
        evidence: null,
      }),
    ).not.toHaveProperty("accessibility");
    expect(() =>
      applyCommand(
        { ...scenario, id: "baseline" },
        { type: "scenario.accessibility", mode: "car", evidence: car.evidence },
      ),
    ).toThrow(/baseline/);
    expect(() =>
      applyCommand(scenario, {
        type: "scenario.accessibility",
        mode: "walk",
        evidence: car.evidence,
      }),
    ).toThrow(/mode/);
    expect(
      accessibilityScenarioSchema.safeParse({
        version: 1,
        captures: { walk: car.evidence },
      }).success,
    ).toBe(false);
  });
  it("keeps legacy bytes unchanged, upgrades all retained histories monotonically and imports without server authority", async () => {
    const { place, evidence } = await accessibilityFixture();
    const legacy = createProject(place),
      before = canonicalJSON(legacy);
    expect(projectWithAccessibilityVersion(legacy, place)).toBe(legacy);
    expect(canonicalJSON(legacy)).toBe(before);
    const old = legacy.scenarios[1],
      command = {
        type: "scenario.accessibility" as const,
        mode: "car" as const,
        evidence,
      },
      after = applyCommand(old, command);
    const entry: HistoryEntry = {
      id: "entry",
      actor: "Test",
      command,
      before: old,
      after,
      at: "2026-11-06T00:00:00Z",
      label: "Adopt outbound access",
    };
    const project = projectWithAccessibilityVersion(
      { ...legacy, scenarios: [legacy.scenarios[0], after], history: [entry] },
      place,
    );
    expect(project.schemaVersion).toBe(10);
    expect(
      projectSchema.safeParse({ ...project, schemaVersion: 9 }).success,
    ).toBe(false);
    expect(commandSchema.safeParse(command).success).toBe(true);
    await expect(
      validateProjectSnapshot({
        project,
        place,
        baselineIdentity: await baselineIdentity(place),
      }),
    ).resolves.toBeDefined();
    const undone = projectWithAccessibilityVersion(
      { ...legacy, undone: [entry] },
      place,
    );
    expect(undone.schemaVersion).toBe(10);
    expect(
      projectWithAccessibilityVersion(
        { ...project, scenarios: legacy.scenarios, history: [] },
        place,
      ).schemaVersion,
    ).toBe(10);
    const imported = projectWithImportedAccessibility(project);
    expect(
      imported.history[0].command.type === "scenario.accessibility" &&
        imported.history[0].command.evidence?.origin,
    ).toBe("imported");
    expect(imported.scenarios[1].accessibility?.captures.car?.capture).toEqual(
      evidence.capture,
    );
    expect(project.scenarios[1].accessibility?.captures.car?.origin).toBe(
      "server-run",
    );
    const tampered = structuredClone(undone);
    if (tampered.undone[0].command.type === "scenario.accessibility")
      tampered.undone[0].command.evidence!.capture.notes.push(
        "Changed history",
      );
    await expect(
      validateProjectSnapshot({
        project: tampered,
        place,
        baselineIdentity: await baselineIdentity(place),
      }),
    ).rejects.toThrow();
  });
});
