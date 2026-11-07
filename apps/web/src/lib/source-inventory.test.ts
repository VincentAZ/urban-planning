import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateImpact } from "@urban/models";
import { housingFixture } from "../../../../packages/models/src/housing-fixture";
import { MetricDetail } from "../components/MetricDetail";
import { housingSourceInventory, housingSources } from "./source-inventory";

describe("housing source namespaces", () => {
  it("retains colliding cost and income-limit IDs with stable separate identities", () => {
    const f = housingFixture();
    const cost = { ...f.source, name: "Authored cost citation" };
    f.scenario.affordability!.sources = [cost];
    const inventory = housingSourceInventory(
      f.scenario,
      f.project.housingIncomeLimits,
    );
    expect(inventory).toHaveLength(2);
    expect(new Set(inventory.map((record) => record.key)).size).toBe(2);
    expect(inventory.map((record) => record.source)).toEqual([
      cost,
      f.pack.sources[0],
    ]);
    expect(housingSources(f.scenario, f.project.housingIncomeLimits)).toEqual([
      cost,
      f.pack.sources[0],
    ]);
    expect(inventory[0].namespace).toBe("Housing cost citation");
    expect(inventory[1].namespace).toContain(
      "Income limits · Synthetic income-limit area",
    );
    // Both baseline and proposal refer to the same pack; its citation appears once.
    expect(
      housingSourceInventory(f.scenario, f.project.housingIncomeLimits),
    ).toEqual(inventory);
  });

  it("renders every namespaced match in metric details without overwriting original names", () => {
    const f = housingFixture();
    f.scenario.affordability!.sources = [
      { ...f.source, name: "Authored cost citation" },
    ];
    const metric = calculateImpact(f.place, f.scenario).metrics[0];
    const html = renderToStaticMarkup(
      createElement(MetricDetail, {
        metric: { ...metric, sourceIds: [f.source.id, f.source.id] },
        place: f.place,
        sourceInventory: housingSourceInventory(
          f.scenario,
          f.project.housingIncomeLimits,
        ),
        onAssumptions: () => undefined,
      }),
    );
    expect(html.match(/Authored cost citation/g)).toHaveLength(1);
    expect(
      html.match(/Synthetic housing limit and cost test data/g),
    ).toHaveLength(1);
    expect(html).toContain("Housing cost citation");
    expect(html).toContain("Income limits · Synthetic income-limit area");
  });
});
