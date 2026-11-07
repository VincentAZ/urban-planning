import { describe, expect, it, vi } from "vitest";
import {
  USER_RETAIL_SOURCE,
  type Place,
  type RetailScenario,
} from "@urban/core";
import { createScenario, MODEL_VERSION } from "@urban/models";
import { retailHTML } from "./retail-export";
import { exportGeoJSON } from "./exports";
import { download } from "./api";

vi.mock("./api", () => ({ download: vi.fn() }));
const place: Place = {
  id: "retail-export",
  name: "Synthetic retail area",
  city: "QA",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.45],
  bounds: [-112.08, 33.44, -112.06, 33.46],
  boundary: [
    [-112.08, 33.44],
    [-112.06, 33.44],
    [-112.06, 33.46],
    [-112.08, 33.46],
    [-112.08, 33.44],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05",
  extentLabel: "Synthetic export fixture",
};
const study: RetailScenario = {
  version: 1,
  context: {
    geography: "QA <trade area>",
    relationshipToStudyArea: "same-area",
    referenceYear: 2024,
    dollarYear: 2024,
    currency: "USD",
    classification: { system: "custom", version: "QA 1" },
    horizon: 0,
    comparabilityConfirmed: true,
    disjointCategoriesConfirmed: true,
  },
  categories: [
    {
      id: "grocery",
      name: "<script>alert('category')</script>",
      code: "GROCERY",
      baselineDemand: {
        status: "available",
        value: 1000000,
        sourceId: USER_RETAIL_SOURCE.id,
      },
      baselineSales: {
        status: "available",
        value: 600000,
        sourceId: USER_RETAIL_SOURCE.id,
      },
      salesPerEstablishment: {
        status: "suppressed",
        value: null,
        sourceId: USER_RETAIL_SOURCE.id,
        note: "QA suppressed benchmark",
      },
      scenarioDemand: null,
      annualSalesCapacity: 150000,
      captureShare: 0.5,
      displacementShare: 0.2,
      assumptionSourceId: USER_RETAIL_SOURCE.id,
    },
  ],
  sourceRights: [
    {
      sourceId: USER_RETAIL_SOURCE.id,
      authorizedPrivateUse: true,
      publicRedistribution: false,
      statement:
        "Synthetic QA data permitted for private project use and export.",
    },
  ],
};
describe("retail export parity", () => {
  it("escapes authored text, retains missing benchmark evidence and computes the same category amounts", () => {
    const scenario = createScenario("Retail QA");
    scenario.retail = structuredClone(study);
    // Canonical user assumptions are valid even when an imported pack does not
    // duplicate that source record in scenario.sources.
    const html = retailHTML(place, scenario, MODEL_VERSION);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("$120,000");
    expect(html).toContain("$280,000");
    expect(html).toContain("QA suppressed benchmark");
    expect(html).toContain("publicRedistribution");
    expect(html).toContain("not measured resident spending leakage");
    exportGeoJSON(place, scenario);
    const exported = JSON.parse(
      vi.mocked(download).mock.calls.at(-1)![1] as string,
    );
    expect(exported.metadata.retail).toEqual(study);
    expect(exported.metadata.sources).toContainEqual(USER_RETAIL_SOURCE);
    expect(exported.features).toEqual([]);
  });
  it("never recalculates an old frozen study with a different model", () => {
    const scenario = createScenario("Frozen retail QA");
    scenario.retail = structuredClone(study);
    const html = retailHTML(place, scenario, "older-retail-model");
    expect(html).toContain("have not been recalculated with a different model");
    expect(html).toContain("older-retail-model");
    expect(html).not.toContain("$120,000");
    expect(html).toContain("Exact retail inputs");
  });
});
