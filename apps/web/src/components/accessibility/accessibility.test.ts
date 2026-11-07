import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { createScenario } from "@urban/models";
import type { AccessibilityRequest } from "@urban/core";
import { accessibilityFixture } from "../../../../../tests/fixtures/accessibility";
import {
  AccessibilityPanel,
  AccessibilityResults,
  AccessibilityMethod,
  PublishedAccessibility,
  differentAccessibilityOrigins,
} from "./AccessibilityOverview";
import {
  accessibilityCoordinates,
  accessibilitySourceChanged,
  sameAccessibilityQuery,
  AccessibilityStartAttempts,
  retainedAccessibilityJobId,
  accessibilitySubmissionMessage,
} from "./query";
import {
  accessibilityHTML,
  exportAccessibilityCSV,
} from "../../lib/accessibility-export";
const request: AccessibilityRequest = {
  site: [-112, 33],
  mode: "walk",
  direction: "outbound",
  thresholdsMinutes: [15, 30, 45],
};
describe("outbound accessibility query identity", () => {
  it("preserves blank/invalid coordinates separately from legitimate zero", () => {
    for (const value of ["", " ", "-", "Infinity"])
      expect(accessibilityCoordinates(value, "33")).toBeNull();
    expect(accessibilityCoordinates("0", "0")).toEqual([0, 0]);
    expect(accessibilityCoordinates("181", "33")).toBeNull();
    expect(accessibilityCoordinates("-112.0000001", "33.0000001")).toEqual([
      -112.0000001, 33.0000001,
    ]);
  });
  it("never matches a different exact origin, mode, direction, or missing query", () => {
    expect(sameAccessibilityQuery(request, structuredClone(request))).toBe(
      true,
    );
    expect(
      sameAccessibilityQuery(request, { ...request, site: [-112.0000001, 33] }),
    ).toBe(false);
    expect(sameAccessibilityQuery(request, { ...request, mode: "car" })).toBe(
      false,
    );
    expect(
      sameAccessibilityQuery(request, {
        ...request,
        direction: "inbound" as "outbound",
      }),
    ).toBe(false);
    expect(sameAccessibilityQuery(request, null)).toBe(false);
  });
  it("retains the original submission across an unknown response and later saved versions", () => {
    const attempts = new AccessibilityStartAttempts();
    const body = {
      scenarioId: "s",
      expectedVersion: 2,
      expectedRevision: 4,
      request: structuredClone(request),
    };
    const first = attempts.for("p", body);
    body.request.site[0] = -111;
    expect(
      attempts.for("p", {
        ...body,
        request,
        expectedVersion: 3,
        expectedRevision: 5,
      }),
    ).toBe(first);
    expect(first.request.site).toEqual([-112, 33]);
    expect(first.expectedVersion).toBe(2);
    expect(attempts.for("q", { ...body, request }).idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
    attempts.complete("p", first);
    expect(attempts.for("p", { ...body, request }).idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
  });
  it("compares current source and profile identities without treating missing capabilities as a match", async () => {
    const { evidence } = await accessibilityFixture();
    const c = evidence.capture;
    const identity = {
      jobsPackHash: c.jobsPackHash,
      boundaryHash: c.coverage.destinations.boundaryHash!,
      manifestId: c.network.id,
      graphHash: c.network.graphHash,
      profileHash: c.network.profileHash,
      methodVersion: c.methodVersion,
    };
    expect(accessibilitySourceChanged(evidence, null)).toBeNull();
    expect(accessibilitySourceChanged(evidence, identity)).toBe(false);
    for (const field of Object.keys(identity))
      expect(
        accessibilitySourceChanged(evidence, {
          ...identity,
          [field]: "changed",
        }),
      ).toBe(true);
  });
  it("does not use copied receipts or another project/scenario to request private maps", async () => {
    const { evidence } = await accessibilityFixture();
    const job = {
      id: evidence.receipt.jobId,
      projectId: evidence.receipt.projectId,
      scenarioId: "s",
    };
    expect(retainedAccessibilityJobId(evidence, [job], "s")).toBe(job.id);
    expect(
      retainedAccessibilityJobId(
        { ...evidence, origin: "imported" },
        [job],
        "s",
      ),
    ).toBe("");
    expect(
      retainedAccessibilityJobId(
        evidence,
        [{ ...job, projectId: "other" }],
        "s",
      ),
    ).toBe("");
    expect(retainedAccessibilityJobId(evidence, [job], "other")).toBe("");
    expect(accessibilitySubmissionMessage("completed")).toContain("ready");
    expect(accessibilitySubmissionMessage("failed")).toContain(
      "no partial result",
    );
  });
});
describe("frozen jobs accessibility presentation", () => {
  it("keeps both modes and explicitly distinguishes different origins", async () => {
    const car = (await accessibilityFixture()).evidence,
      walk = (await accessibilityFixture({ mode: "walk" })).evidence;
    const accessibility = { version: 1 as const, captures: { car, walk } },
      scenario = { ...createScenario("Saved jobs"), accessibility };
    expect(differentAccessibilityOrigins(accessibility)).toBe(false);
    const before = JSON.stringify(accessibility);
    const html = renderToStaticMarkup(
      createElement(AccessibilityPanel, { scenario, onOpen: () => {} }),
    );
    expect(html).toContain("Driving");
    expect(html).toContain("Walking");
    expect(html).toContain("proposal effects not modeled");
    expect(JSON.stringify(accessibility)).toBe(before);
    walk.capture.request.site[0] += 0.0000001;
    expect(differentAccessibilityOrigins(accessibility)).toBe(true);
    expect(
      renderToStaticMarkup(createElement(PublishedAccessibility, { scenario })),
    ).toContain("different origins");
  });
  it("retains known zero, null full totals and unresolved jobs without invented confidence intervals", async () => {
    const { evidence } = await accessibilityFixture();
    const threshold = evidence.capture.thresholds[1];
    threshold.total = {
      estimate: null,
      knownSubtotal: 10,
      status: "partial",
      unresolvedDestinationCount: 1,
      unresolvedJobs: 20,
      upperBound: 30,
    };
    const html = renderToStaticMarkup(
      createElement(AccessibilityResults, { accessibility: evidence }),
    );
    expect(html).toContain("Known subtotal only");
    expect(html).toContain("full 30-minute total is unavailable");
    expect(html).toContain("Jobs in unresolved blocks");
    expect(html).toContain("<strong>0</strong>");
    expect(html).toContain("not a forecast or a confidence interval");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("90%");
  });
  it("labels imported evidence and publishes tables without private requests or inferred contours", async () => {
    const { evidence } = await accessibilityFixture();
    evidence.origin = "imported";
    const scenario = {
      ...createScenario("Copied evidence"),
      accessibility: { version: 1 as const, captures: { car: evidence } },
    };
    const html = renderToStaticMarkup(
      createElement(PublishedAccessibility, { scenario }),
    );
    expect(html).toContain("Imported evidence · not verified by this server");
    expect(html).toContain("no private job or archive is requested");
    expect(html).toContain("not included here");
    expect(html).not.toContain("canvas");
    const method = renderToStaticMarkup(
      createElement(AccessibilityMethod, { evidence }),
    );
    expect(method).toContain("Native Census block internal point");
    expect(method).toContain("No returned path · unresolved");
    expect(method).toContain(evidence.capture.network.graphHash);
  });
  it("exports all saved modes/categories/thresholds with formula-safe text and exact source identities", async () => {
    const car = (await accessibilityFixture()).evidence,
      walk = (await accessibilityFixture({ mode: "walk" })).evidence;
    car.capture.sources[0].name = '<script>alert("not executed")</script>';
    const scenario = {
      ...createScenario("=SUM(1,2)"),
      accessibility: { version: 1 as const, captures: { car, walk } },
    };
    const csv = exportAccessibilityCSV(scenario);
    expect(csv.split("\r\n")).toHaveLength(145);
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"0"');
    expect(csv).toContain(car.captureHash);
    expect(csv).toContain('"outbound"');
    expect(csv).toContain("unresolved_workplace_blocks");
    const html = accessibilityHTML(scenario);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("not a baseline-to-proposal effect");
    expect(html).toContain("Driving");
    expect(html).toContain("Walking");
  });
});
