import { describe, expect, it } from "vitest";
import { workforceScenarioFixture } from "../../../tests/fixtures/workforce";
import {
  createWorkforceScenario,
  resolveScenarioWorkforce,
} from "./workforce-scenario";
import { createScenario } from "./helpers";
import { workforceContentHash } from "@urban/core";

describe("workforce adoption and scenario context", () => {
  it("compacts every numeric field unchanged and supports admitted immutable binding without a place payload", async () => {
    const { pack, artifact, workforce } = await workforceScenarioFixture();
    const bound = await createWorkforceScenario({
      binding: workforce.binding,
      pack,
      artifact,
      receipt: workforce.receipt,
    });
    expect(bound).toEqual(workforce);
    for (const [pi, p] of artifact.result.panels.entries())
      for (const [ti, t] of p.thresholds.entries()) {
        const saved = bound.capture.panels[pi].thresholds[ti];
        for (const key of [
          "estimate",
          "knownSubtotal",
          "marginOfError90",
          "knownSubtotalMarginOfError90",
          "status",
        ] as const) {
          expect(saved.total[key]).toBe(t.total[key]);
          t.categories.forEach((c, ci) =>
            expect(saved.categories[ci][key]).toBe(c[key]),
          );
        }
      }
    expect(bound.capture.artifactHash).toBe(
      await workforceContentHash(artifact),
    );
  });
  it("rejects forged result amounts and mismatched contour queries", async () => {
    const { pack, artifact, place, workforce } =
      await workforceScenarioFixture();
    const fake = structuredClone(artifact);
    fake.result.panels[0].thresholds[0].total.estimate = 100000;
    await expect(
      createWorkforceScenario({
        place,
        pack,
        artifact: fake,
        receipt: workforce.receipt,
      }),
    ).rejects.toThrow("retained native evidence");
    const other = structuredClone(artifact);
    other.contour.site[0] += 0.1;
    await expect(
      createWorkforceScenario({
        place,
        pack,
        artifact: other,
        receipt: workforce.receipt,
      }),
    ).rejects.toThrow("same inbound query");
  });
  it("preserves exact contour holes/multipart identity in the separate archive reference", async () => {
    const { pack, artifact, place, workforce } =
      await workforceScenarioFixture();
    const ring = artifact.contour.geometry.features[0].geometry
      .coordinates as number[][][];
    artifact.contour.geometry.features[0].geometry = {
      type: "MultiPolygon",
      coordinates: [
        ring,
        [
          [
            [-112.003, 33],
            [-112.002, 33],
            [-112.002, 33.001],
            [-112.003, 33.001],
            [-112.003, 33],
          ],
        ],
      ],
    };
    const saved = await createWorkforceScenario({
      place,
      pack,
      artifact,
      receipt: workforce.receipt,
    });
    expect(saved.capture.contour.vertexCount).toBe(20);
    expect(saved.capture.contour.sha256).toBe(
      await workforceContentHash(artifact.contour),
    );
    expect(saved.capture.contour).not.toHaveProperty("geometry");
  });
  it("keeps saved results unchanged under unrelated edits and labels source-network context without claiming verification", async () => {
    const { place, workforce } = await workforceScenarioFixture();
    const scenario = createScenario("Proposal");
    expect(resolveScenarioWorkforce(place, scenario)).toBeNull();
    scenario.workforce = workforce;
    scenario.horizon = 20;
    scenario.roadEdits.removed = null;
    scenario.buildingEdits.removed = null;
    const before = JSON.stringify(workforce),
      result = resolveScenarioWorkforce(place, scenario)!;
    expect(result.verification).toBe("not-established");
    expect(result.capture).toEqual(workforce.capture);
    expect(result.warnings.join(" ")).toContain("not a workforce forecast");
    expect(result.warnings.join(" ")).toContain("street changes");
    result.capture.notes.push("Mutation");
    expect(JSON.stringify(workforce)).toBe(before);
  });
  it("rejects citation namespace conflicts instead of overwriting captured sources", async () => {
    const { place, pack, artifact, workforce } =
      await workforceScenarioFixture();
    await expect(
      createWorkforceScenario({
        place,
        pack,
        artifact,
        receipt: workforce.receipt,
        extraSources: [
          { ...pack.sources[0], name: "Different source same ID" },
        ],
      }),
    ).rejects.toThrow("Conflicting captured workforce source");
  });
});
