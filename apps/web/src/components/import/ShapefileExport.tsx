import { useEffect, useRef, useState } from "react";
import {
  Download,
  Layers,
  LoaderCircle,
  RefreshCw,
  Square,
} from "lucide-react";
import type { Scenario } from "@urban/core";
import { ApiError, download } from "../../lib/api";
import {
  importApi,
  ImportAttempts,
  shapefileDownload,
  type GisCapabilities,
  type GisJob,
} from "../../lib/import-api";
import type { ImportSavedProject } from "./ImportWorkbench";
import "./import.css";
const active = (job: GisJob | null) =>
  job?.status === "queued" || job?.status === "running";
export function ShapefileExport({
  scenario,
  accountScope = "",
  canProcess = false,
  onSave,
  onRequireAccount,
  onAccessError,
}: {
  scenario: Scenario;
  accountScope?: string;
  canProcess?: boolean;
  onSave: () => Promise<ImportSavedProject | null>;
  onRequireAccount?: () => void;
  onAccessError?: () => void;
}) {
  const scope = `${accountScope}:${scenario.id}`,
    [dataScope, setDataScope] = useState(scope);
  const [saved, setSaved] = useState<ImportSavedProject | null>(null),
    [capabilities, setCapabilities] = useState<GisCapabilities | null>(null),
    [job, setJob] = useState<GisJob | null>(null),
    [jobs, setJobs] = useState<GisJob[]>([]);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [pollKey, setPollKey] = useState(0),
    [denied, setDenied] = useState(false);
  const mounted = useRef(true),
    controller = useRef<AbortController | null>(null),
    live = useRef({ scope, canProcess });
  live.current = { scope, canProcess };
  const attempts = useRef(
      new ImportAttempts<{
        scenarioId: string;
        expectedVersion: number;
        expectedRevision: number;
        idempotencyKey: string;
      }>(),
    ),
    retries = useRef(new Map<string, { key: string; version: number }>());
  const valid = (captured: string) =>
    mounted.current &&
    live.current.scope === captured &&
    live.current.canProcess;
  const allowed = canProcess && !denied,
    pending = !!busy || active(job);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (dataScope === scope) return;
    controller.current?.abort();
    attempts.current.clear();
    retries.current.clear();
    setDataScope(scope);
    setSaved(null);
    setJob(null);
    setJobs([]);
    setCapabilities(null);
    setError("");
    setBusy("");
    setDenied(false);
  }, [scope, dataScope]);
  useEffect(() => {
    if (!canProcess) {
      controller.current?.abort();
      setBusy("");
      setJob(null);
      setJobs([]);
      attempts.current.clear();
      retries.current.clear();
    }
  }, [canProcess]);
  function failure(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    setError(
      error instanceof Error
        ? error.message
        : "The export could not be completed.",
    );
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      setDenied(true);
      setJobs([]);
      setJob(null);
      onAccessError?.();
    }
  }
  async function start(listOnly: boolean) {
    if (!allowed || pending) return;
    const captured = scope,
      request = new AbortController();
    controller.current = request;
    setBusy(
      listOnly ? "Finding retained exports" : "Saving and queuing export",
    );
    setError("");
    try {
      const snapshot = await onSave();
      if (!snapshot)
        throw new Error(
          "A free account and saved project with edit access are required for queued GIS exports.",
        );
      if (!valid(captured) || request.signal.aborted) return;
      const [caps, recent] = await Promise.all([
        importApi.capabilities(snapshot.projectId, request.signal),
        importApi.jobs(snapshot.projectId, request.signal),
      ]);
      if (!valid(captured) || request.signal.aborted) return;
      setSaved(snapshot);
      setCapabilities(caps);
      setJobs(
        recent.jobs.filter(
          (entry) =>
            entry.kind === "export-shapefile" &&
            entry.scenarioId === scenario.id,
        ),
      );
      if (listOnly) return;
      if (!caps.enabled || !caps.configured)
        throw new Error(
          caps.reason ??
            "The GIS converter is unavailable. Retained exports can still be downloaded.",
        );
      const body = attempts.current.for(
        `${captured}:${scenario.revision}`,
        () => ({
          scenarioId: scenario.id,
          expectedVersion: snapshot.version,
          expectedRevision: scenario.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      const result = await importApi.exportShapefile(
        snapshot.projectId,
        body,
        request.signal,
      );
      if (valid(captured)) {
        attempts.current.clear();
        setJob(result.job);
        setPollKey((n) => n + 1);
      }
    } catch (error) {
      if (valid(captured)) {
        if (error instanceof ApiError && error.status < 500)
          attempts.current.clear();
        failure(error);
      }
    } finally {
      if (valid(captured)) setBusy("");
    }
  }
  useEffect(() => {
    if (!job || !saved || !allowed || !active(job) || dataScope !== scope)
      return;
    const captured = scope,
      request = new AbortController(),
      id = job.id,
      projectId = saved.projectId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await importApi.job(projectId, id, request.signal);
        if (!valid(captured) || request.signal.aborted) return;
        setJob(result.job);
        if (active(result.job)) timer = setTimeout(poll, 1500);
      } catch (error) {
        if (!request.signal.aborted && valid(captured)) failure(error);
      }
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [job?.id, saved?.projectId, pollKey, allowed, scope, dataScope]);
  async function action(kind: "cancel" | "retry" | "download") {
    if (!job || !saved || !allowed || busy) return;
    const captured = scope,
      request = new AbortController();
    controller.current = request;
    setBusy(kind);
    setError("");
    try {
      if (kind === "download") {
        const result = await shapefileDownload(
          saved.projectId,
          job,
          request.signal,
        );
        if (valid(captured)) download(result.filename, result.blob);
      } else {
        let attempt = retries.current.get(job.id);
        if (!attempt) {
          attempt = { key: crypto.randomUUID(), version: job.version };
          retries.current.set(job.id, attempt);
        }
        const result =
          kind === "cancel"
            ? await importApi.cancel(saved.projectId, job)
            : await importApi.retry(
                saved.projectId,
                { ...job, version: attempt.version },
                attempt.key,
              );
        if (valid(captured)) {
          retries.current.delete(job.id);
          setJob(result.job);
          setPollKey((n) => n + 1);
        }
      }
    } catch (error) {
      if (valid(captured)) {
        if (error instanceof ApiError && error.status < 500)
          retries.current.delete(job.id);
        failure(error);
      }
    } finally {
      if (valid(captured)) setBusy("");
    }
  }
  if (dataScope !== scope) return null;
  return (
    <details className="import-shapefile-export">
      <summary>
        <Layers size={17} /> Scenario geometry · Shapefile ZIP
      </summary>
      <p>
        Exact saved geometry, separate layers, CRS and field mapping manifest.
        Shapefile field-name limits are documented in the ZIP; source data is
        not silently simplified.
      </p>
      {!allowed ? (
        <>
          <p>
            A free account and project edit access are required. Saved GeoJSON
            remains available above.
          </p>
          {onRequireAccount && (
            <button type="button" className="button" onClick={onRequireAccount}>
              Sign in free for GIS processing
            </button>
          )}
        </>
      ) : (
        <>
          <div className="import-inline-actions">
            <button
              type="button"
              className="button primary"
              disabled={pending}
              onClick={() => void start(false)}
            >
              {busy && <LoaderCircle size={14} className="spin" />} Prepare
              shapefile ZIP
            </button>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => void start(true)}
            >
              Find retained GIS exports
            </button>
          </div>
          {capabilities?.reason && (
            <p className="notice">
              {capabilities.reason} Retained downloads remain available.
            </p>
          )}
          {job && (
            <div className="import-job">
              <strong>
                {active(job)
                  ? "Preparing your saved geometry…"
                  : job.status === "completed"
                    ? "Shapefile ZIP ready"
                    : job.status === "cancelled"
                      ? "Export cancelled"
                      : "Export needs attention"}
              </strong>
              <p>
                Captured revision {job.scenarioRevision} · project version{" "}
                {job.projectVersion} · {job.stage} · attempt {job.attempt}
              </p>
              {job.scenarioRevision !== scenario.revision && (
                <p>
                  This export contains an earlier revision. It does not include
                  your current changes.
                </p>
              )}
              {job.error && <p>{job.error.message}</p>}
              {job.cancelRequested && (
                <p>Cancellation requested; waiting for the worker to stop.</p>
              )}
              <div className="import-inline-actions">
                {active(job) && (
                  <button
                    type="button"
                    className="button"
                    disabled={!!busy || job.cancelRequested}
                    onClick={() => void action("cancel")}
                  >
                    <Square size={13} /> Cancel export
                  </button>
                )}
                {job.error?.retryable && (
                  <button
                    type="button"
                    className="button"
                    disabled={pending}
                    onClick={() => void action("retry")}
                  >
                    Retry export
                  </button>
                )}
                {job.status === "completed" && (
                  <button
                    type="button"
                    className="button primary"
                    disabled={!!busy}
                    onClick={() => void action("download")}
                  >
                    <Download size={14} /> Download shapefile ZIP
                  </button>
                )}
                {active(job) && error && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => setPollKey((n) => n + 1)}
                  >
                    <RefreshCw size={13} /> Refresh export progress
                  </button>
                )}
              </div>
            </div>
          )}
          {!!jobs.length && (
            <details className="import-recent">
              <summary>{jobs.length} retained export jobs</summary>
              {jobs.map((entry) => (
                <button
                  type="button"
                  className="import-recent-row"
                  disabled={pending}
                  key={entry.id}
                  onClick={() => {
                    setJob(entry);
                    setError("");
                    setPollKey((n) => n + 1);
                  }}
                >
                  <strong>
                    Revision {entry.scenarioRevision} · {entry.status}
                  </strong>
                  <span>
                    {new Date(entry.createdAt).toLocaleString()} · project
                    version {entry.projectVersion}
                  </span>
                </button>
              ))}
            </details>
          )}
        </>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
