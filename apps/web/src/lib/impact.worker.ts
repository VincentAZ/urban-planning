import {
  calculateImpact,
  resolveFloodExposure,
  type ModelContext,
} from "@urban/models";
import type { Place, Scenario } from "@urban/core";
let place: Place | null = null;
let context: ModelContext = {};
self.onmessage = (
  event: MessageEvent<
    | { type: "place"; place: Place }
    | { type: "context"; context?: ModelContext }
    | { type: "calculate"; scenarios: Scenario[]; requestId: number }
  >,
) => {
  const message = event.data;
  if (message.type === "place") {
    place = message.place;
    return;
  }
  if (message.type === "context") {
    context = message.context ?? {};
    return;
  }
  if (!place) return;
  try {
    if (!message.scenarios.length || message.scenarios.length > 4)
      throw new Error("Choose one to four scenarios to calculate.");
    const currentPlace = place;
    self.postMessage({
      requestId: message.requestId,
      values: message.scenarios.map((scenario) => ({
        results: calculateImpact(currentPlace, scenario, undefined, context),
        flood: resolveFloodExposure(currentPlace, scenario, context),
      })),
    });
  } catch (error) {
    self.postMessage({
      requestId: message.requestId,
      error: error instanceof Error ? error.message : "Calculation failed",
    });
  }
};
