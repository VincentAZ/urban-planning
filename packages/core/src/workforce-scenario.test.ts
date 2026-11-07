import { describe, expect, it } from "vitest";
import { workforceScenarioFixture } from "../../../tests/fixtures/workforce";
import { createProject, createScenario } from "@urban/models";
import {
  applyCommand,
  baselineIdentity,
  canonicalJSON,
  projectWithWorkforceVersion,
  projectWithImportedWorkforce,
  projectWithRetailVersion,
  validateProjectSnapshot,
  workforceContentHash,
  workforceScenarioSchema,
  verifyWorkforceScenario,
  type HistoryEntry,
} from "./index";
import { commandSchema, projectSchema } from "./validation";

describe("compact persisted workforce evidence", () => {
  it("preserves exact compact counts, self-contained sources and contour identity without native rows or geometry", async () => {
    const { place, artifact, workforce } = await workforceScenarioFixture({
      partial: true,
    });
    expect(workforceScenarioSchema.safeParse(workforce).success).toBe(true);
    await expect(
      verifyWorkforceScenario(workforce, place),
    ).resolves.toBeUndefined();
    const value = workforce.capture.panels[0].thresholds[0].total;
    expect(value).toMatchObject({
      estimate: null,
      knownSubtotal: 20,
      status: "partial",
      knownSubtotalMarginOfError90: 2,
      marginOfError90: null,
      unresolvedAllocationUnitCount: 1,
      unresolvedAllocationMoeUnitCount: 1,
      missingMoeUnitCount: 0,
    });
    expect(workforce.capture.contour.sha256).toBe(
      await workforceContentHash(artifact.contour),
    );
    expect(workforce.capture.siteSnapMeters).toBe(12.5);
    expect(workforce.capture).not.toHaveProperty("origins");
    expect(workforce.capture).not.toHaveProperty("units");
    expect(workforce.capture.contour).not.toHaveProperty("geometry");
    expect(value).not.toHaveProperty("unresolvedAllocationUnitGeoids");
    expect(
      new TextEncoder().encode(JSON.stringify(workforce)).byteLength,
    ).toBeLessThan(256 * 1024);
  });
  it("rejects fabricated null/status/precision combinations and missing categorical definitions", async () => {
    const { workforce } = await workforceScenarioFixture({ partial: true });
    for (const patch of [
      { status: "complete" },
      { estimate: 0, status: "complete" },
      { marginOfError90: 0 },
      { knownSubtotal: null },
      { missingMoeUnitCount: 1 },
    ]) {
      const bad = structuredClone(workforce);
      Object.assign(bad.capture.panels[0].thresholds[0].total, patch);
      expect(workforceScenarioSchema.safeParse(bad).success).toBe(false);
    }
    const wrongUniverse = structuredClone(workforce);
    wrongUniverse.capture.panels[0].universe = "Available job applicants";
    expect(workforceScenarioSchema.safeParse(wrongUniverse).success).toBe(
      false,
    );
    const missing = structuredClone(workforce);
    missing.capture.panels[1].thresholds[0].categories.pop();
    expect(workforceScenarioSchema.safeParse(missing).success).toBe(false);
    const repeated = structuredClone(workforce);
    repeated.capture.panels[0].thresholds[1].minutes = 15;
    expect(workforceScenarioSchema.safeParse(repeated).success).toBe(false);
  });
  it("rejects coverage/source disagreements and oversized evidence instead of truncating", async () => {
    const { workforce } = await workforceScenarioFixture();
    const bad = structuredClone(workforce);
    bad.capture.coverage.routeStatusCounts.reachable++;
    expect(workforceScenarioSchema.safeParse(bad).success).toBe(false);
    const source = structuredClone(workforce);
    source.capture.sources = [];
    expect(workforceScenarioSchema.safeParse(source).success).toBe(false);
    const oversize = structuredClone(workforce);
    oversize.capture.notes = Array.from({ length: 30 }, () =>
      "x".repeat(10000),
    );
    expect(workforceScenarioSchema.safeParse(oversize).success).toBe(false);
    const inline = structuredClone(workforce) as any;
    inline.capture.contour.geometry = {
      type: "FeatureCollection",
      features: [],
    };
    expect(workforceScenarioSchema.safeParse(inline).success).toBe(false);
  });
  it("checks content, request and baseline hashes without interpreting a receipt as authority", async () => {
    const { place, workforce } = await workforceScenarioFixture();
    const wrong = structuredClone(workforce);
    wrong.capture.siteSnapMeters = 10;
    await expect(verifyWorkforceScenario(wrong, place)).rejects.toThrow(
      "content hash",
    );
    wrong.captureHash = await workforceContentHash(wrong.capture);
    wrong.capture.inputHash = "0".repeat(64);
    wrong.captureHash = await workforceContentHash(wrong.capture);
    await expect(verifyWorkforceScenario(wrong, place)).rejects.toThrow(
      "input hash",
    );
    await expect(
      verifyWorkforceScenario(workforce, {
        ...place,
        name: "Other baseline bytes",
      }),
    ).rejects.toThrow("immutable baseline");
    const receipt = structuredClone(workforce);
    receipt.receipt.projectId = "different-project";
    // Shared integrity is deliberately not authorization; the server must compare ownership.
    await expect(
      verifyWorkforceScenario(receipt, place),
    ).resolves.toBeUndefined();
  });
  it("adopts/removes once, clones without aliasing and keeps existing source IDs untouched", async () => {
    const { place, workforce } = await workforceScenarioFixture();
    const original = createProject(place).scenarios[1];
    original.sources = [
      {
        ...workforce.capture.sources[0],
        name: "Existing independent namespace",
      },
    ];
    const next = applyCommand(original, {
      type: "scenario.workforce",
      workforce,
    });
    expect(next.revision).toBe(original.revision + 1);
    expect(next.sources).toEqual(original.sources);
    const branch = createScenario("Branch", next);
    branch.workforce!.capture.notes.push("Branch note");
    expect(next.workforce!.capture.notes).not.toContain("Branch note");
    workforce.capture.notes.push("Caller mutation");
    expect(next.workforce!.capture.notes).not.toContain("Caller mutation");
    const removed = applyCommand(next, {
      type: "scenario.workforce",
      workforce: null,
    });
    expect(removed.workforce).toBeUndefined();
    expect(next.workforce).toBeDefined();
    expect(() =>
      applyCommand(
        { ...original, id: "baseline" },
        { type: "scenario.workforce", workforce: null },
      ),
    ).toThrow("baseline");
  });
  it("preserves legacy version/bytes and makes format7 monotonic through undone command history", async () => {
    const { place, workforce } = await workforceScenarioFixture();
    const project = createProject(place),
      before = canonicalJSON(project),
      identity = await baselineIdentity(place);
    expect(projectWithWorkforceVersion(project, place)).toBe(project);
    expect(canonicalJSON(project)).toBe(before);
    const initial = project.scenarios[1],
      after = applyCommand(initial, { type: "scenario.workforce", workforce });
    const entry: HistoryEntry = {
      id: "entry",
      at: "2026-11-06T00:00:00Z",
      actor: "Test",
      label: "Adopt capture",
      command: { type: "scenario.workforce", workforce },
      before: initial,
      after,
    };
    project.undone = [entry];
    expect(projectSchema.safeParse(project).success).toBe(false);
    const upgraded = projectWithWorkforceVersion(project, place);
    expect(upgraded.schemaVersion).toBe(7);
    expect(projectWithRetailVersion(upgraded, place).schemaVersion).toBe(7);
    expect(projectSchema.safeParse(upgraded).success).toBe(true);
    const valid = await validateProjectSnapshot({
      project: upgraded,
      place,
      baselineIdentity: identity,
    });
    expect(valid.baselineIdentity).toEqual(identity);
    const invalid = structuredClone(upgraded);
    invalid.undone[0].command = {
      type: "scenario.workforce",
      workforce: { ...workforce, captureHash: "f".repeat(64) },
    };
    await expect(
      validateProjectSnapshot({
        project: invalid,
        place,
        baselineIdentity: identity,
      }),
    ).rejects.toThrow("content hash");
  });
  it("rejects unsafe receipt IDs and workforce on immutable baseline snapshots", async () => {
    const { place, workforce } = await workforceScenarioFixture();
    for (const id of ["__proto__", "constructor", "toString"]) {
      const bad = structuredClone(workforce);
      bad.receipt.jobId = id;
      expect(
        commandSchema.safeParse({ type: "scenario.workforce", workforce: bad })
          .success,
      ).toBe(false);
    }
    const project = projectWithWorkforceVersion(
      { ...createProject(place), schemaVersion: 7 },
      place,
    );
    project.scenarios[0].workforce = workforce;
    expect(projectSchema.safeParse(project).success).toBe(false);
  });
  it("marks copied current and historical captures as imported without changing captured evidence or the source project", async () => {
    const { place, workforce } = await workforceScenarioFixture();
    const initial = createProject(place);
    expect(projectWithImportedWorkforce(initial)).toBe(initial);
    const before = initial.scenarios[1];
    const after = applyCommand(before, {
      type: "scenario.workforce",
      workforce,
    });
    const entry: HistoryEntry = {
      id: "capture-entry",
      at: "2026-11-06T00:00:00Z",
      actor: "Test",
      label: "Adopt capture",
      command: { type: "scenario.workforce", workforce },
      before,
      after,
    };
    initial.scenarios[1] = after;
    initial.history = [entry];
    initial.undone = [structuredClone(entry)];
    const project = projectWithWorkforceVersion(initial, place);
    const original = canonicalJSON(project);
    const copy = projectWithImportedWorkforce(project);
    const captures = [
      copy.scenarios[1].workforce,
      ...[...copy.history, ...copy.undone].flatMap((e) => [
        e.before.workforce,
        e.after.workforce,
        e.command.type === "scenario.workforce" ? e.command.workforce : null,
      ]),
    ].filter((w) => w != null);
    expect(captures).toHaveLength(5);
    for (const capture of captures) {
      expect(capture.origin).toBe("imported");
      expect(capture.captureHash).toBe(workforce.captureHash);
      expect(capture.capture).toEqual(workforce.capture);
      expect(capture.receipt).toEqual(workforce.receipt);
    }
    expect(canonicalJSON(project)).toBe(original);
    await expect(
      validateProjectSnapshot({
        project: copy,
        place,
        baselineIdentity: await baselineIdentity(place),
      }),
    ).resolves.toBeTruthy();
    copy.scenarios[1].workforce!.capture.notes.push("Copy-only note");
    expect(project.scenarios[1].workforce!.capture.notes).not.toContain(
      "Copy-only note",
    );
  });
});
