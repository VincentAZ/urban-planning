import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildingPreset, createScenario } from "@urban/models";
import { roadPreset, type WorkforceRequest } from "@urban/core";
import {
  workforceScenarioFixture,
  workforcePlaceFixture,
} from "../../../../../tests/fixtures/workforce";
import {
  PublishedWorkforce,
  WorkforceMethod,
  WorkforcePanel,
  WorkforceQuickResult,
  WorkforceResults,
} from "./WorkforceOverview";
import {
  sameWorkforceQuery,
  retainedWorkforceJobId,
  workforceCoordinates,
  workforceSubmissionMessage,
  WorkforceStartAttempts,
} from "./query";
import { workforceMapContext } from "./map-context";

const request: WorkforceRequest = {
  site: [-112, 33],
  mode: "car",
  direction: "inbound",
  thresholdsMinutes: [15, 30, 45],
};
describe("workforce UI request integrity", () => {
  it("replaces the queued submission message when work is complete or terminal", () => {
    expect(workforceSubmissionMessage("running")).toContain(
      "while the server finishes",
    );
    expect(workforceSubmissionMessage("completed")).toContain(
      "Captured result ready",
    );
    expect(workforceSubmissionMessage("completed")).not.toContain(
      "while the server finishes",
    );
    expect(workforceSubmissionMessage("failed")).toContain("no partial result");
    expect(workforceSubmissionMessage("cancelled")).toContain("cancelled");
  });
  it("uses exact materialized local context without changing captured geometry or implying a routing graph", () => {
    const place = structuredClone(workforcePlaceFixture);
    const building = buildingPreset("residential", place.center);
    const { footprint: _legacy, ...attributes } = building;
    place.buildings = [
      {
        ...attributes,
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [0, 0],
                [3, 0],
                [3, 3],
                [0, 3],
                [0, 0],
              ],
              [
                [1, 1],
                [1, 2],
                [2, 2],
                [2, 1],
                [1, 1],
              ],
            ],
            [
              [
                [4, 0],
                [5, 0],
                [5, 1],
                [4, 1],
                [4, 0],
              ],
            ],
          ],
        },
      },
    ];
    const road = roadPreset([
      [0, 0],
      [1, 1],
    ]);
    place.roads = [road];
    const scenario = createScenario("Local context");
    scenario.roadEdits[road.id] = {
      ...road,
      coordinates: [
        [0, 0],
        [2, 2],
      ],
    };
    const before = JSON.stringify({ place, scenario });
    const context = workforceMapContext(place, scenario);
    expect(context.buildings.features[0].geometry).toEqual(
      place.buildings[0].geometry,
    );
    expect(context.roads.features[0].geometry.coordinates).toEqual([
      [0, 0],
      [2, 2],
    ]);
    expect(JSON.stringify({ place, scenario })).toBe(before);
    scenario.buildingEdits[building.id] = null;
    expect(
      workforceMapContext(place, scenario).buildings.features,
    ).toHaveLength(0);
  });
  it("keeps blank or invalid coordinate buffers unavailable, while retaining legitimate zero", () => {
    expect(workforceCoordinates("", "33")).toBeNull();
    expect(workforceCoordinates("  ", "0")).toBeNull();
    expect(workforceCoordinates("-", "33")).toBeNull();
    expect(workforceCoordinates("180.1", "33")).toBeNull();
    expect(workforceCoordinates("0", "85.01")).toBeNull();
    expect(workforceCoordinates("Infinity", "0")).toBeNull();
    expect(workforceCoordinates("0", "0")).toEqual([0, 0]);
    expect(workforceCoordinates("-112.1234567", "33.7654321")).toEqual([
      -112.1234567, 33.7654321,
    ]);
  });
  it("marks every exact site or mode change stale without rounding into an apparently matching result", () => {
    expect(sameWorkforceQuery(request, structuredClone(request))).toBe(true);
    expect(
      sameWorkforceQuery(request, { ...request, site: [-112.0000001, 33] }),
    ).toBe(false);
    expect(sameWorkforceQuery(request, { ...request, mode: "walk" })).toBe(
      false,
    );
    expect(sameWorkforceQuery(request, null)).toBe(false);
  });
  it("replays the original body after a lost response, even if a later project save changes versions", () => {
    const attempts = new WorkforceStartAttempts();
    const input = {
      scenarioId: "proposal",
      expectedVersion: 2,
      expectedRevision: 8,
      request: structuredClone(request),
    };
    const first = attempts.for("project-a", input);
    input.request.site[0] = -111;
    const retry = attempts.for("project-a", {
      ...input,
      request,
      expectedVersion: 3,
      expectedRevision: 9,
    });
    expect(retry).toEqual(first);
    expect(retry.expectedVersion).toBe(2);
    expect(retry.expectedRevision).toBe(8);
    expect(retry.request.site).toEqual([-112, 33]);
    expect(
      attempts.for("project-b", { ...input, request }).idempotencyKey,
    ).not.toBe(first.idempotencyKey);
    attempts.complete("project-a", first);
    const fresh = attempts.for("project-a", {
      ...input,
      request,
      expectedVersion: 3,
      expectedRevision: 9,
    });
    expect(fresh.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(fresh.expectedVersion).toBe(3);
    attempts.clear();
    expect(
      attempts.for("project-a", { ...input, request }).idempotencyKey,
    ).not.toBe(fresh.idempotencyKey);
  });
});

describe("frozen workforce evidence presentation", () => {
  it("marks imported evidence in closed overview, results and public summary without treating its copied receipt as authority", async () => {
    const { workforce } = await workforceScenarioFixture();
    const imported = { ...workforce, origin: "imported" as const };
    const scenario = {
      ...createScenario("Imported evidence"),
      workforce: imported,
    };
    const job = {
      id: workforce.receipt.jobId,
      projectId: workforce.receipt.projectId,
      scenarioId: scenario.id,
    };
    const expected = "Imported evidence · not verified by this server";
    const captureBytes = JSON.stringify(imported.capture);
    expect(
      renderToStaticMarkup(
        createElement(WorkforcePanel, { scenario, onOpen: () => {} }),
      ),
    ).toContain(expected);
    expect(
      renderToStaticMarkup(
        createElement(WorkforceResults, { workforce: imported }),
      ),
    ).toContain(expected);
    expect(
      renderToStaticMarkup(createElement(PublishedWorkforce, { scenario })),
    ).toContain(expected);
    expect(retainedWorkforceJobId(imported, [job], scenario.id)).toBe("");
    expect(
      retainedWorkforceJobId(
        { ...workforce, origin: "server-run" },
        [job],
        scenario.id,
      ),
    ).toBe(job.id);
    expect(
      retainedWorkforceJobId(
        { ...workforce, origin: "server-run" },
        [{ ...job, projectId: "other-project" }],
        scenario.id,
      ),
    ).toBe("");
    expect(
      retainedWorkforceJobId(
        { ...workforce, origin: "server-run" },
        [job],
        "other-scenario",
      ),
    ).toBe("");
    expect(JSON.stringify(imported.capture)).toBe(captureBytes);
  });
  it("shows partial known subtotals as incomplete and preserves distinct missing and allocation reasons", async () => {
    const { workforce } = await workforceScenarioFixture({ partial: true });
    const markup = renderToStaticMarkup(
      createElement(WorkforceResults, { workforce, minutes: 30 }),
    );
    expect(markup).toContain("Known subtotal only");
    expect(markup).toContain("full 30-minute total is unavailable");
    expect(markup).toContain("Missing source units");
    expect(markup).toContain("Suppressed source units");
    expect(markup).toContain("Unknown spatial allocation");
    expect(markup).toContain("different Census populations");
    expect(markup).toContain("Conditional 90%");
    expect(markup).not.toContain("NaN");
    expect(markup).toContain(
      '<details class="workforce-source-cells"><summary>Source cells</summary>',
    );
    expect(markup).toContain("B15003_002");
    const glance = renderToStaticMarkup(
      createElement(WorkforceQuickResult, {
        workforce,
        minutes: 30,
        panelId: "education",
        stale: true,
      }),
    );
    expect(glance).toContain("Known subtotal only");
    expect(glance).toContain("Full total unavailable");
    expect(glance).toContain(workforce.capture.panels[0].universe);
    expect(glance).toContain("Previous query");
  });
  it("does not turn a known zero category into unavailable and does not imply sampling margins cover routing error", async () => {
    const { workforce } = await workforceScenarioFixture();
    const markup = renderToStaticMarkup(
      createElement(WorkforceResults, { workforce, minutes: 15 }),
    );
    expect(markup).toContain("<strong>0</strong>");
    expect(markup).toContain("Complete estimate");
    const method = renderToStaticMarkup(
      createElement(WorkforceMethod, { capture: workforce.capture }),
    );
    expect(method).toContain(
      "exclude spatial-allocation error and routing error",
    );
    expect(method).toContain("12.5 m");
    expect(method).toContain("exact connection coordinate unavailable");
    expect(method).toContain(workforce.capture.network.graphHash);
    expect(method).toContain(workforce.capture.sources[0].name);
  });
  it("renders saved and public tables without a private job fetch or substituting a contour", async () => {
    const { workforce } = await workforceScenarioFixture();
    const scenario = { ...createScenario("Saved workforce"), workforce };
    const before = JSON.stringify(workforce);
    const markup = renderToStaticMarkup(
      createElement(PublishedWorkforce, { scenario }),
    );
    expect(markup).toContain(
      "separately stored regional contour is not included",
    );
    expect(markup).toContain("no private job or archive is requested");
    expect(markup).toContain("Synthetic unit test");
    expect(markup).not.toContain("canvas");
    expect(JSON.stringify(workforce)).toBe(before);
    expect(
      renderToStaticMarkup(
        createElement(PublishedWorkforce, {
          scenario: createScenario(workforcePlaceFixture.name),
        }),
      ),
    ).toBe("");
  });
});
