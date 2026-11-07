import { useEffect, useRef, useState } from "react";
import type { Place, Scenario } from "@urban/core";
import type { ActivityResolution } from "@urban/models";

/** One place transfer per worker; superseded results never describe the current draft. */
export function useActivityResolution(
  place: Place | null,
  scenario: Scenario | undefined,
) {
  const worker = useRef<Worker | null>(null);
  const failed = useRef(false);
  const [epoch, setEpoch] = useState(0);
  const generation = useRef(0);
  const pending = useRef<{
    id: number;
    place: Place;
    scenario: Scenario;
  } | null>(null);
  const [state, setState] = useState<{
    place: Place;
    scenario: Scenario;
    resolution: ActivityResolution | null;
    error: string | null;
  } | null>(null);
  const current = useRef({ place, scenario });
  current.current = { place, scenario };
  useEffect(() => {
    if (!place) return;
    const instance = new Worker(
      new URL("./activity.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = instance;
    failed.current = false;
    instance.postMessage({ type: "init", place });
    const fail = (event: Event) => {
      event.preventDefault();
      if (worker.current !== instance) return;
      failed.current = true;
      instance.terminate();
      const active = current.current;
      if (worker.current === instance && active.place && active.scenario)
        setState({
          ...(active as { place: Place; scenario: Scenario }),
          resolution: null,
          error:
            "Activity estimates could not be calculated. Retry to restart the calculation worker.",
        });
    };
    instance.onerror = fail;
    instance.onmessageerror = fail;
    instance.onmessage = (event) => {
      if (worker.current !== instance || event.data.id !== generation.current)
        return;
      const active = current.current;
      const request = pending.current;
      if (
        request &&
        request.id === event.data.id &&
        active.place === request.place &&
        active.scenario === request.scenario
      )
        setState({
          place: request.place,
          scenario: request.scenario,
          resolution: event.data.resolution ?? null,
          error: event.data.error ?? null,
        });
    };
    return () => {
      ++generation.current;
      instance.terminate();
      if (worker.current === instance) worker.current = null;
    };
  }, [place, epoch]);
  useEffect(() => {
    const id = ++generation.current;
    if (!place || !scenario || !worker.current) return;
    if (failed.current) {
      setState({
        place,
        scenario,
        resolution: null,
        error:
          "Activity estimates could not be calculated. Retry to restart the calculation worker.",
      });
      return;
    }
    pending.current = { id, place, scenario };
    const timeout = setTimeout(
      () => worker.current?.postMessage({ type: "resolve", id, scenario }),
      120,
    );
    return () => clearTimeout(timeout);
  }, [place, scenario, epoch]);
  const matches = state?.place === place && state?.scenario === scenario;
  return {
    resolution: matches ? state.resolution : null,
    error: matches ? state.error : null,
    updating: !!place && !!scenario && !matches,
    failed: failed.current,
    retry: () => {
      setState(null);
      setEpoch((value) => value + 1);
    },
  };
}
