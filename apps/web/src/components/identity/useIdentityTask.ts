import { useEffect, useRef, useState } from "react";
import { identityError } from "../../lib/identity-api";

/** Keep a response bound to the exact mounted account/token review that requested it. */
export function useIdentityTask(scope: string) {
  const live = useRef(scope);
  live.current = scope;
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState({ scope, busy: false, error: "" });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setState({ scope, busy: false, error: "" });
  }, [scope]);
  const current = state.scope === scope;
  async function run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    apply: (result: T) => void,
    onFailure?: (error: unknown) => void,
  ) {
    if (controller.current && !controller.current.signal.aborted) return;
    const request = new AbortController();
    controller.current = request;
    const valid = () =>
      mounted.current && !request.signal.aborted && live.current === scope;
    setState({ scope, busy: true, error: "" });
    try {
      const result = await work(request.signal);
      if (valid()) apply(result);
    } catch (error) {
      if (valid()) {
        setState({ scope, busy: true, error: identityError(error) });
        onFailure?.(error);
      }
    } finally {
      if (controller.current === request) controller.current = null;
      if (valid()) setState((old) => ({ ...old, busy: false }));
    }
  }
  return {
    busy: current && state.busy,
    error: current ? state.error : "",
    setError: (error: string) => setState({ scope, busy: false, error }),
    run,
  };
}
