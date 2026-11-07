import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createFiscalScenarioReview } from "@urban/core";
import { createFiscalStudy } from "@urban/models";
import { fiscalFixture } from "../../../../packages/models/src/fiscal-fixture";
import { useWorkspace } from "./workspace";
import { flushWorkspaceWrites, readWorkspaceDraft } from "./workspace-storage";
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
  });
});
afterEach(async () => {
  await flushWorkspaceWrites();
  vi.unstubAllGlobals();
});
it("keeps the original browser study and applies offer/cases atomically through undo and redo", async () => {
  const f = fiscalFixture();
  await useWorkspace.getState().initialize(f.place);
  const original = structuredClone(useWorkspace.getState().project!);
  const next = createFiscalStudy({
    place: f.place,
    project: original,
    scenarioId: original.activeScenarioId,
    profile: f.profile,
    review: {
      reviewedBy: "Unit reviewer",
      reviewedAt: "2026-11-06T00:00:00.000Z",
      applicabilityNotes: "Synthetic local profile review.",
    },
  });
  await useWorkspace.getState().replace(next, f.place);
  const scenario = next.scenarios.find(
    (value) => value.id === next.activeScenarioId,
  )!;
  const fiscal = createFiscalScenarioReview(
    scenario,
    next.fiscalStudy!.profileHash,
    {
      reviewedBy: "Unit reviewer",
      reviewedAt: "2026-11-06T00:00:00.000Z",
      notes: "Review paired synthetic variants.",
    },
    [
      {
        id: "zero",
        name: "Zero growth",
        description: "Explicit zero baseline and proposal growth.",
        baseline: { annualGrowthRate: 0 },
        proposal: { annualGrowthRate: 0 },
        sourceIds: [f.profile.sources[0].id],
      },
    ],
  );
  useWorkspace.getState().dispatch(
    {
      type: "scenario.fiscal",
      fiscal,
      offer: {
        incentiveGrant: 1200,
        abatementPercent: 0.2,
        abatementYears: 3,
      },
    },
    "Apply fiscal offer and cases",
  );
  const applied = useWorkspace.getState().project!;
  expect(applied.history).toHaveLength(1);
  expect(
    applied.scenarios.find((value) => value.id === applied.activeScenarioId),
  ).toMatchObject({
    fiscal,
    assumptions: {
      incentiveGrant: 1200,
      abatementPercent: 0.2,
      abatementYears: 3,
    },
  });
  useWorkspace.getState().undo();
  expect(
    useWorkspace
      .getState()
      .project!.scenarios.find((value) => value.id === next.activeScenarioId)
      ?.assumptions.incentiveGrant,
  ).toBe(scenario.assumptions.incentiveGrant);
  useWorkspace.getState().redo();
  expect(
    useWorkspace
      .getState()
      .project!.scenarios.find((value) => value.id === next.activeScenarioId)
      ?.fiscal,
  ).toEqual(fiscal);
  expect(useWorkspace.getState().project!.scenarios[0]).toEqual(
    next.scenarios[0],
  );
  await flushWorkspaceWrites();
  expect((await readWorkspaceDraft(original.id)).project).toEqual(original);
  expect((await readWorkspaceDraft(next.id)).project.schemaVersion).toBe(12);
});
