import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { area, featureCollection, intersect } from "@turf/turf";
import {
  canonicalJSON,
  floodDatasetHash,
  pointInStudyArea,
  studyAreaFeature,
  type FloodDataset,
} from "@urban/core";
import { resolveFloodExposure } from "@urban/models";
import {
  floodFixture,
  floodRectangle,
  floodZone,
} from "../../../tests/fixtures/flood";
import {
  buildReportMapPairSvg,
  projectReportPosition,
  reportFloodUnknownGeometry,
} from "./report-maps";
async function input(dataset?: FloodDataset) {
  const f = await floodFixture();
  const selected = dataset ?? f.dataset;
  const datasetHash = await floodDatasetHash(selected);
  return {
    ...f,
    scenario: { ...f.scenario, flood: { ...f.scenario.flood!, datasetHash } },
    context: { floodDatasets: { [datasetHash]: selected } },
    map: {
      place: f.place,
      baselineScenario: f.project.scenarios[0],
      proposalScenario: {
        ...f.scenario,
        flood: { ...f.scenario.flood!, datasetHash },
      },
      flood: { datasetHash, dataset: selected },
    },
  };
}
describe("flood map source classifications and coverage", () => {
  it("retains unknown availability even under classified X and leaves source SFHA visible below transparent hatching", async () => {
    const original = await floodFixture(),
      dataset = { ...original.dataset, availability: [] };
    const f = await input(dataset);
    const before = canonicalJSON(dataset);
    const geometry = reportFloodUnknownGeometry(dataset)!;
    expect(pointInStudyArea([-112.068, 33.45], geometry)).toBe(true);
    const resolution = resolveFloodExposure(f.place, f.scenario, f.context);
    expect(
      resolution.scenario.buildings.find((b) => b.buildingId === "clear")
        ?.status,
    ).toBe("undetermined");
    expect(
      resolution.scenario.buildings.find((b) => b.buildingId === "wet")?.status,
    ).toBe("intersects-sfha");
    const pair = buildReportMapPairSvg(f.map);
    expect(pair.proposal.svg).toContain(
      'data-flood-unresolved-coverage="true"',
    );
    expect(pair.proposal.svg).toContain("Imported flood evidence");
    const raster = new Resvg(pair.proposal.svg).render(),
      pixels = raster.pixels;
    const [x, y] = projectReportPosition(
      [-112.075, 33.45],
      pair.metadata.projection,
    );
    let blue = 0,
      amber = 0;
    for (let row = Math.round(y) - 12; row < Math.round(y) + 12; row++)
      for (let col = Math.round(x) - 12; col < Math.round(x) + 12; col++) {
        const offset = (row * raster.width + col) * 4;
        const rgb = pixels.subarray(offset, offset + 3);
        if (rgb[0] === 146 && rgb[1] === 207 && rgb[2] === 223) blue++;
        if (rgb[0] === 160 && rgb[1] === 120 && rgb[2] === 64) amber++;
      }
    expect(blue).toBeGreaterThan(30);
    expect(amber).toBeGreaterThan(3);
    expect(canonicalJSON(dataset)).toBe(before);
  });
  it("subtracts a Zone D overlap from known coverage and agrees with the model remainder area", async () => {
    const f = await floodFixture();
    const d = floodRectangle(-112.079, 33.441, -112.078, 33.443);
    const dataset = {
      ...f.dataset,
      zones: [
        floodZone("all-x", f.dataset.studyArea, "other-mapped"),
        floodZone("d", d, "undetermined"),
      ],
    };
    const test = await input(dataset);
    const unknown = reportFloodUnknownGeometry(dataset)!;
    expect(pointInStudyArea([-112.0785, 33.442], unknown)).toBe(true);
    expect(pointInStudyArea([-112.068, 33.45], unknown)).toBe(false);
    const model = resolveFloodExposure(
      test.place,
      test.scenario,
      test.context,
    ).scenario.buildings.find((b) => b.buildingId === "wet")!;
    const footprint = test.place.buildings[0].geometry!;
    const clipped = intersect(
      featureCollection([
        studyAreaFeature(unknown),
        studyAreaFeature(footprint),
      ]),
    );
    expect(model.unclassifiedAreaSqm).toBeCloseTo(area(clipped!), 6);
  });
  it("draws floodway after overlapping ordinary AE regardless of source identifier order", async () => {
    const f = await floodFixture();
    const floodway = {
      ...f.dataset.zones[0],
      id: "aaa-floodway",
      attributes: {
        ...f.dataset.zones[0].attributes,
        FLD_AR_ID: "aaa-floodway",
        ZONE_SUBTY: "FLOODWAY",
      },
    };
    const ae = {
      ...f.dataset.zones[0],
      id: "zzz-ae",
      attributes: { ...f.dataset.zones[0].attributes, FLD_AR_ID: "zzz-ae" },
    };
    const dataset = { ...f.dataset, zones: [floodway, ae, f.dataset.zones[1]] };
    const test = await input(dataset);
    const pair = buildReportMapPairSvg(test.map);
    expect(
      pair.proposal.svg.indexOf('data-flood-zone="aaa-floodway"'),
    ).toBeGreaterThan(pair.proposal.svg.indexOf('data-flood-zone="zzz-ae"'));
    expect(reportFloodUnknownGeometry(dataset)).toBeNull();
    expect(pair.proposal.svg).not.toContain(
      'data-flood-unresolved-coverage="true"',
    );
  });
  it("retains a classification hole as unknown without mutating source rings", async () => {
    const f = await floodFixture(),
      hole = floodRectangle(-112.075, 33.447, -112.073, 33.449);
    if (f.dataset.studyArea.type !== "Polygon" || hole.type !== "Polygon")
      throw Error("fixture");
    const known = {
      type: "Polygon" as const,
      coordinates: [f.dataset.studyArea.coordinates[0], hole.coordinates[0]],
    };
    const dataset = {
      ...f.dataset,
      zones: [floodZone("x-with-hole", known, "other-mapped")],
    };
    const before = canonicalJSON(dataset);
    const unknown = reportFloodUnknownGeometry(dataset)!;
    expect(pointInStudyArea([-112.074, 33.448], unknown)).toBe(true);
    expect(pointInStudyArea([-112.068, 33.45], unknown)).toBe(false);
    expect(canonicalJSON(dataset)).toBe(before);
  });
});
