import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Place } from "@urban/core";
import { readSummaryCommunityProfile } from "../../../api/src/data/acs-summary";
import { CommunityContext } from "./CommunityContext";

const area = (): Place => ({
  id: "context-test",
  name: "Context test",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112, 33],
  bounds: [-112, 33, -111.9, 33.1],
  boundary: [
    [-112, 33],
    [-111.9, 33],
    [-111.9, 33.1],
    [-112, 33],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Small test study area",
});
describe("community context disclosure", () => {
  it("renders real cached estimates with geography, period, margins, and derived-method labels", async () => {
    const demographics = await readSummaryCommunityProfile("85004");
    const html = renderToStaticMarkup(
      createElement(CommunityContext, { place: { ...area(), demographics } }),
    );
    expect(html).toContain("12,408");
    expect(html).toContain("1,173");
    expect(html).toContain("2020–2024");
    expect(html).toContain("90% MOE");
    expect(html).toContain("Approx.");
    expect(html).toContain("Whole-ZCTA context");
    expect(html).toContain("not totals for the smaller displayed area");
    expect(html).toContain("Source, coverage &amp; uncertainty");
    expect(html).toContain("B01003_E001");
    expect(html).toContain("Census calculation guidance");
    expect(html).not.toContain("/profile/variables.html"); // This source is Detailed Tables.
  });
  it("shows explicit absence and never renders missing data as a zero or an upgrade", () => {
    const place = {
      ...area(),
      coverage: [
        {
          layer: "Census community context",
          status: "unavailable" as const,
          description: "Census preparation is unavailable for this geography.",
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(CommunityContext, { place }),
    );
    expect(html).toContain("Census preparation is unavailable");
    expect(html).not.toContain("community-measure");
    expect(html).not.toContain("$0");
    expect(html.toLowerCase()).not.toContain("upgrade");
  });
});
