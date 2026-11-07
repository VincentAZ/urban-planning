import { useEffect, useMemo, useState } from "react";
import type { Place, Scenario } from "@urban/core";
import type { ModelContext } from "@urban/models";
import { ImpactClient, type ImpactOutcome } from "./impact-client";

interface Outcome {
  place: Place;
  scenarios: Scenario[];
  context: ModelContext | undefined;
  values?: ImpactOutcome[];
  error?: string;
}

export function useImpactComparison(
  place: Place | null,
  scenarios: Scenario[],
  context?: ModelContext,
) {
  const [client] = useState(() => new ImpactClient());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => {
    if (!place || !scenarios.length) return;
    const controller = new AbortController();
    void client
      .calculate(place, scenarios, context, controller.signal)
      .then((values) => {
        if (!controller.signal.aborted)
          setOutcome({ place, scenarios, context, values });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setOutcome({
            place,
            scenarios,
            context,
            error:
              error instanceof Error ? error.message : "Calculation failed.",
          });
      });
    return () => controller.abort();
  }, [client, place, scenarios, context]);
  // Mask stale revisions/catalogs synchronously, including before the next effect.
  const current =
    outcome?.place === place &&
    outcome.scenarios === scenarios &&
    outcome.context === context
      ? outcome
      : null;
  return {
    values: current?.values ?? null,
    error: current?.error ?? null,
    updating: !!place && !!scenarios.length && !current,
  };
}

export function useImpact(
  place: Place | null,
  scenario: Scenario | undefined,
  context?: ModelContext,
) {
  const scenarios = useMemo(() => (scenario ? [scenario] : []), [scenario]);
  const result = useImpactComparison(place, scenarios, context);
  return {
    results: result.values?.[0]?.results ?? null,
    flood: result.values?.[0]?.flood ?? null,
    error: result.error,
    updating: result.updating,
  };
}
