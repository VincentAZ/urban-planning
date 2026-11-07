import { describe, it, expect } from "vitest";
import {
  accessibilityFixture,
  accessibilityPlaceFixture,
} from "../../../tests/fixtures/accessibility.js";
import { createProject } from "@urban/models";
import {
  accessibilityContentHash,
  type Project,
  type SourceRights,
} from "@urban/core";
import {
  scenarioForPublication,
  validateSourceRightsTransition,
} from "./retail-publication.js";
import { validateAccessibilityContext } from "./accessibility-validation.js";
import type {
  AccessibilityArtifactRecord,
  AccessibilityJobRecord,
} from "./accessibility-jobs-types.js";
const rights: SourceRights = {
  version: 1,
  privateUse: true,
  cache: true,
  analyze: true,
  privateDisplay: true,
  export: true,
  historicalRetention: true,
  publicRedistribution: false,
  declaredBy: "fixture",
  declaredAt: "2026-11-06T00:00:00Z",
};
async function setup() {
  const f = await accessibilityFixture({
    place: {
      ...accessibilityPlaceFixture,
      sources: [
        {
          id: "accessibility-fixture",
          name: "Original planning citation",
          kind: "inferred",
          vintage: "2020",
          license: "Test only",
          url: "",
        },
      ],
    },
  });
  f.evidence.origin = "imported";
  f.evidence.capture.sources[0].rights = { ...rights };
  f.evidence.captureHash = await accessibilityContentHash(f.evidence.capture);
  const project = createProject(f.place);
  project.scenarios[1].accessibility = {
    version: 1,
    captures: { car: f.evidence },
  };
  return { ...f, project, scenario: project.scenarios[1] };
}
describe("accessibility namespace and authority boundaries", () => {
  it("blocks private captured source metadata in public snapshots without changing planning citations", async () => {
    const f = await setup(),
      before = JSON.stringify(f.project);
    f.evidence.capture.sources[0].id = f.place.sources[0].id;
    expect(() =>
      scenarioForPublication(f.project, f.place, f.scenario),
    ).toThrow(/private source permissions/);
    expect(JSON.stringify(f.project)).not.toContain('"coordinates"');
    expect(f.place.sources[0].rights).toBeUndefined();
    expect(before).toContain("publicRedistribution");
  });
  it("does not let a full save erase a nested source permission declaration", async () => {
    const f = await setup(),
      next = structuredClone(f.project);
    delete next.scenarios[1].accessibility!.captures.car!.capture.sources[0]
      .rights;
    expect(() =>
      validateSourceRightsTransition(f.project, next, f.place),
    ).toThrow(/accessibility source permissions/);
  });
  it("preserves source attribution independently when a planning ID collides", async () => {
    const f = await setup();
    f.evidence.capture.sources[0].id = f.place.sources[0].id;
    f.evidence.capture.sources[0].name = "Distinct job citation";
    f.evidence.capture.sources[0].rights!.publicRedistribution = true;
    const published = scenarioForPublication(f.project, f.place, f.scenario);
    expect(published.accessibility!.captures.car!.capture.sources[0].name).toBe(
      "Distinct job citation",
    );
    expect(f.place.sources[0].name).not.toBe("Distinct job citation");
  });
  it("derives missing producer metadata only from the matching completed owned job", async () => {
    const f = await accessibilityFixture(),
      e = f.evidence;
    const artifact = {
      id: "artifact",
      projectId: e.receipt.projectId,
      jobId: e.receipt.jobId,
      accessibility: e,
    } as AccessibilityArtifactRecord;
    const job = {
      id: e.receipt.jobId,
      projectId: e.receipt.projectId,
      scenarioId: "original",
      status: "completed",
      result: { artifactId: "artifact", captureHash: e.captureHash },
    } as AccessibilityJobRecord;
    expect(() =>
      validateAccessibilityContext(
        [e],
        e.receipt.projectId,
        "same-project-clone",
        [artifact],
        [job],
      ),
    ).not.toThrow();
    expect(() =>
      validateAccessibilityContext(
        [e],
        e.receipt.projectId,
        "original",
        [artifact],
        [],
      ),
    ).toThrow();
    expect(() =>
      validateAccessibilityContext(
        [e],
        e.receipt.projectId,
        "original",
        [{ ...artifact, scenarioId: "forged" }],
        [job],
      ),
    ).toThrow();
    expect(() =>
      validateAccessibilityContext(
        [e],
        "different-project",
        "original",
        [artifact],
        [job],
      ),
    ).toThrow();
  });
});
