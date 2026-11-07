import {
  validateActivityScenario,
  type Place,
  type Scenario,
} from "@urban/core";
import { resolveActivity } from "@urban/models";
let place: Place | null = null;
self.onmessage = (
  event: MessageEvent<
    | { type: "init"; place: Place }
    | { type: "resolve"; id: number; scenario: Scenario }
  >,
) => {
  if (event.data.type === "init") {
    place = event.data.place;
    return;
  }
  const { id, scenario } = event.data;
  try {
    if (!place) throw new Error("The reference geography is still loading.");
    if (scenario.activity)
      validateActivityScenario(scenario.activity, place, scenario.sources);
    self.postMessage({ id, resolution: resolveActivity(place, scenario) });
  } catch (error) {
    self.postMessage({ id, error: (error as Error).message });
  }
};
