import { useCallback, useEffect, useState } from "react";
import type { ProjectAccessResponse } from "../../../../packages/core/src/collaboration";
import { api, ApiError, type Session } from "./api";
import type { CloudProjectLink } from "./cloud-workspace";

/** Permission state is ephemeral. A downloaded source snapshot is never an authorization grant. */
export function useProjectAccess(
  link: CloudProjectLink | null,
  session: Session,
) {
  const key = `${link?.projectId ?? "local"}:${link?.organizationId ?? ""}:${session.user?.id ?? "guest"}:${session.organization?.id ?? ""}`;
  const [state, setState] = useState<{
    key: string;
    response?: ProjectAccessResponse;
    error?: string;
    status?: number;
  }>({ key: "" });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  /** Accept only a fresh authenticated save response, never restored browser data.
   * The caller commits this before attaching the new cloud link so the dialog
   * stays mounted across the local-to-saved transition. Normal rechecks continue.
   */
  const acceptVerifiedSave = useCallback(
    (response: ProjectAccessResponse) => {
      if (!session.user || response.organizationId !== session.organization?.id)
        throw new Error(
          "The saved project belongs to a different account workspace. Reopen it from project home.",
        );
      setState({
        key: `${response.projectId}:${response.organizationId}:${session.user.id}:${session.organization.id}`,
        response,
      });
    },
    [session.user?.id, session.organization?.id],
  );
  useEffect(() => {
    if (!link) {
      setState({ key });
      return;
    }
    if (!session.user) {
      setState({
        key,
        error:
          "Sign in to check access to this saved project. Your captured browser draft is retained.",
      });
      return;
    }
    if (session.organization?.id !== link.organizationId) {
      setState({
        key,
        error:
          "This draft belongs to another workspace. Switch workspaces in project home to check access.",
      });
      return;
    }
    let closed = false,
      busy = false;
    const controller = new AbortController();
    const read = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const response = await api<ProjectAccessResponse>(
          `/projects/${encodeURIComponent(link.projectId)}/access`,
          { signal: controller.signal },
        );
        if (!closed) setState({ key, response });
      } catch (error) {
        if (!closed && (error as Error).name !== "AbortError")
          setState({
            key,
            error: `Saved-project access could not be verified. ${(error as Error).message}`,
            status: error instanceof ApiError ? error.status : undefined,
          });
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 30000);
    const focus = () => void read();
    window.addEventListener("focus", focus);
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [key, revision]);
  const current = state.key === key ? state : undefined;
  const response = current?.response;
  const remoteChanged = !!(
    link &&
    response &&
    response.version !== link.version
  );
  const readOnly = !!link && (!response?.access.canEdit || remoteChanged);
  const reason = !link
    ? ""
    : (current?.error ??
      (!response
        ? "Checking your saved-project permissions…"
        : remoteChanged
          ? "A newer saved version is available. Keep a copy of this draft and reopen the saved version before editing or commenting."
          : !response.access.canEdit
            ? `You have ${response.access.role} access. You can inspect this proposal${response.access.canComment ? " and join the review" : ""}.`
            : ""));
  return {
    access: response?.access ?? null,
    response,
    readOnly,
    reason,
    remoteChanged,
    refresh,
    acceptVerifiedSave,
    error: current?.error,
    status: current?.status,
    loading: !!link && !current,
  };
}
