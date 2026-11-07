import { useEffect, useState } from "react";
import {
  identityApi,
  identityError,
  type IdentitySecurityResponse,
} from "../../lib/identity-api";
export function useAccountSecurity(userId?: string) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    userId?: string;
    data: IdentitySecurityResponse | null;
    error: string;
    loading: boolean;
  }>({ userId, data: null, error: "", loading: !!userId });
  useEffect(() => {
    const controller = new AbortController();
    if (!userId) {
      setState({ userId, data: null, error: "", loading: false });
      return;
    }
    setState({ userId, data: null, error: "", loading: true });
    void identityApi
      .security(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.userId !== userId) throw new Error("Account changed");
        setState({ userId, data, error: "", loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            userId,
            data: null,
            error: identityError(error),
            loading: false,
          });
      });
    return () => controller.abort();
  }, [userId, version]);
  return {
    data: state.userId === userId ? state.data : null,
    error: state.userId === userId ? state.error : "",
    loading: state.userId !== userId || state.loading,
    refresh: () => setVersion((value) => value + 1),
  };
}
