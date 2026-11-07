import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  evaluateTrafficCalibration,
  summarizeTrafficRun,
  type TrafficComparison,
} from "@urban/models";
import {
  trafficCalibrationFixture,
  trafficCountFixture,
  trafficFixturePeriod,
  trafficNetworkFixture,
  trafficRecipeFixture,
  trafficResultFixture,
} from "../../../../../packages/core/src/traffic-fixture";
import {
  TrafficResults,
  TrafficComparisonTable,
  type TrafficResultPair,
} from "./TrafficResults";

function pair(): TrafficResultPair {
  return {
    id: "synthetic-test-only",
    scenarioRevision: 2,
    recipe: trafficRecipeFixture(),
    baseline: trafficResultFixture("baseline"),
    proposal: trafficResultFixture("proposal"),
    countPack: trafficCountFixture(),
  };
}
describe("traffic evidence result labels", () => {
  it("keeps all three comparison values in each mobile card without converting unavailable changes to zero", () => {
    const comparison: TrafficComparison = {
      methodVersion: "1.0.0",
      recipeHash: "a".repeat(64),
      baseline: summarizeTrafficRun(trafficResultFixture("baseline")),
      proposal: summarizeTrafficRun(trafficResultFixture("proposal")),
      delta: {
        meanTravelTimeSeconds: null,
        meanTimeLossSeconds: 0,
        meanDepartureDelaySeconds: null,
        vehicleKilometers: null,
        vehicleHours: null,
      },
      notes: [],
    };
    const html = renderToStaticMarkup(
      createElement(TrafficComparisonTable, { comparison }),
    );
    const mobile = html.slice(html.indexOf('class="traffic-comparison-cards"'));
    expect(mobile.match(/<dt>Baseline<\/dt>/g)).toHaveLength(5);
    expect(mobile.match(/<dt>Proposal<\/dt>/g)).toHaveLength(5);
    expect(mobile.match(/<dt>Change<\/dt>/g)).toHaveLength(5);
    expect(mobile).toContain("<dt>Change</dt><dd>Unavailable</dd>");
    expect(mobile).toContain("<dt>Change</dt><dd>0</dd>");
    expect(mobile).toContain("seconds/trip");
    expect(html).toContain("traffic-comparison-table");
  });
  it("does not turn absent count-fit criteria into an assessed result", () => {
    const value = pair();
    value.calibration = null;
    value.countPack.counts[0] = {
      ...value.countPack.counts[0],
      status: "excluded",
      value: 153,
    };
    const html = renderToStaticMarkup(
      createElement(TrafficResults, { pair: value, stale: false }),
    );
    expect(html).toContain("Count fit: Not assessed");
    expect(html).toContain("observed");
    expect(html).toContain("excluded");
    expect(html).toContain(">153<");
    expect(html).toContain("Proposal prediction");
    expect(html).toContain(
      "not recalibrated against the historical baseline observations",
    );
  });
  it("labels the single actual fit as baseline-only and keeps future predictions distinct", () => {
    const value = pair();
    value.calibration = evaluateTrafficCalibration(
      value.countPack,
      value.baseline.predictions,
      trafficCalibrationFixture(),
      trafficNetworkFixture(),
      trafficFixturePeriod,
    );
    const html = renderToStaticMarkup(
      createElement(TrafficResults, { pair: value, stale: false }),
    );
    expect(html).toContain("Baseline interval-count fit");
    expect(html).toContain("Baseline count-fit diagnostics");
    expect(html).not.toContain("Proposal interval-count fit");
    expect(html).not.toContain("Count fit: Not assessed");
  });
});
