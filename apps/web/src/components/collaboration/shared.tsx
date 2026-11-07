import { useCallback, useEffect, useRef, useState } from "react";
import { FolderLock, Loader2, RefreshCw } from "lucide-react";
import type { ProjectRole, ReviewTarget } from "@urban/core";
import { api, ApiError, type Session } from "../../lib/api";

export const ROLE_DETAILS: Record<
  ProjectRole,
  { label: string; description: string }
> = {
  owner: {
    label: "Owner",
    description: "Manage project access, edit, review, and publish.",
  },
  editor: {
    label: "Editor",
    description: "Edit scenarios, comment, and resolve review threads.",
  },
  commenter: {
    label: "Commenter",
    description: "Read and discuss the project; resolve their own threads.",
  },
  viewer: {
    label: "Viewer",
    description: "Read saved scenarios and review discussions.",
  },
};
const dateFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});
export const reviewDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : dateFormat.format(date);
};
export function reviewTargetLabel(target?: ReviewTarget, label?: string) {
  if (label && target?.kind !== "project") return label;
  if (target?.kind === "location")
    return `Map location · ${target.position[1].toFixed(5)}, ${target.position[0].toFixed(5)}`;
  if (target?.kind === "building") return "Selected building";
  if (target?.kind === "metric") return "Selected metric";
  return "General project discussion";
}
export function CollaborationSaveButton({
  onSave,
  label = "Save project changes",
  busyLabel = "Saving project…",
}: {
  onSave: () => void | Promise<void>;
  label?: string;
  busyLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="collab-inline-action">
      <button
        className="button primary"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
        {busy ? busyLabel : label}
      </button>
      {error && (
        <p className="collab-coordinate-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function CollaborationGate({
  session,
  projectId,
  onRequireAccount,
  onRequireSave,
}: {
  session: Session;
  projectId: string | null;
  onRequireAccount?: () => void;
  onRequireSave?: () => void | Promise<void>;
}) {
  if (session.user && projectId) return null;
  return (
    <div className="collab-empty">
      <FolderLock size={30} aria-hidden="true" />
      <h3>
        {session.user
          ? "Save this project to start collaborating."
          : "Bring your team into the conversation."}
      </h3>
      <p>
        {session.user
          ? "Project access and review threads belong to a saved account project. Your browser draft remains available here."
          : "A free account lets you save a project, give people access, and keep review comments together. No payment details."}
      </p>
      {!session.user && onRequireAccount ? (
        <button className="button primary" onClick={onRequireAccount}>
          Sign in or create a free account
        </button>
      ) : session.user && onRequireSave ? (
        <CollaborationSaveButton
          onSave={onRequireSave}
          label="Save project to account"
        />
      ) : null}
    </div>
  );
}
export function CollaborationLoading({ label }: { label: string }) {
  return (
    <div className="collab-loading" role="status">
      <Loader2 size={20} className="spin" aria-hidden="true" />
      {label}
    </div>
  );
}
export function CollaborationError({
  message,
  retry,
  disabled = false,
}: {
  message: string;
  retry?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="collab-error" role="alert">
      <p>{message}</p>
      {retry && (
        <button className="button" onClick={retry} disabled={disabled}>
          <RefreshCw size={13} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  );
}

/** Cancel stale reads and never expose a previous project's permissions during a project switch. */
export function useCollaborationResource<T>(
  path: string | null,
  enabled = true,
) {
  const [state, setState] = useState<{ path: string | null; data: T | null }>({
    path,
    data: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const currentPath = useRef(path);
  currentPath.current = path;
  const reload = useCallback(async () => {
    if (!path) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const data = await api<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted && currentPath.current === path)
        setState({ path, data });
    } catch (failure) {
      if (!controller.signal.aborted && currentPath.current === path) {
        setError((failure as Error).message);
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        )
          setState({ path, data: null });
      }
    } finally {
      if (!controller.signal.aborted && currentPath.current === path)
        setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    if (enabled && path) void reload();
    else {
      request.current?.abort();
      setLoading(false);
    }
    return () => request.current?.abort();
  }, [enabled, path, reload]);
  const replace = useCallback(
    (data: T) => {
      if (currentPath.current !== path) return;
      request.current?.abort();
      setState({ path, data });
      setLoading(false);
      setError("");
    },
    [path],
  );
  return {
    data: state.path === path ? state.data : null,
    loading,
    error,
    reload,
    replace,
  };
}
