import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleHelp,
  Download,
  LoaderCircle,
  MapPin,
  Play,
  RefreshCw,
  Save,
  Square,
  UsersRound,
} from "lucide-react";
import { studyAreaGeometry } from "@urban/core";
import type { Place, Position, Scenario, WorkforceRequest } from "@urban/core";
import type { CloudProjectLink } from "../../lib/cloud-workspace";
import { ApiError, download } from "../../lib/api";
import {
  workforceApi,
  workforceArtifact,
  type WorkforceAdoptResponse,
  type WorkforceCapabilities,
  type WorkforceJob,
  type WorkforceJobResult,
} from "../../lib/workforce-api";
import { Modal } from "../Modal";
import {
  WorkforceMethod,
  WorkforceResults,
  WorkforceQuickResult,
  workforceMode,
} from "./WorkforceOverview";
import {
  sameWorkforceQuery,
  retainedWorkforceJobId,
  workforceCoordinates,
  workforceSiteChoices,
  WorkforceStartAttempts,
  workforceSubmissionMessage,
} from "./query";
import "./workforce.css";

const RegionalMap = lazy(() => import("./RegionalMap"));
const activeJob = (job: WorkforceJob) =>
  job.status === "queued" || job.status === "running";
const stageNames: Record<WorkforceJob["stage"], string> = {
  queued: "Waiting for the regional worker",
  validating: "Checking source and geographic coverage",
  routing: "Routing origins toward the site",
  aggregating: "Combining source population evidence",
  contours: "Preparing regional contours",
  saving: "Retaining the immutable result",
  complete: "Captured result ready",
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The workforce service could not complete this request.";
export interface WorkforceDialogProps {
  place: Place;
  scenario: Scenario;
  accountId: string | null;
  connection: CloudProjectLink | null;
  canEdit: boolean;
  hasUnsavedChanges: boolean;
  initialSite?: { position: Position; label: string };
  initialRequest?: WorkforceRequest;
  onSignIn: (request: WorkforceRequest | null, siteLabel: string) => void;
  onSaveProject: () => Promise<void>;
  onAdopt: (response: WorkforceAdoptResponse) => Promise<void>;
  onRemove?: () => void;
  onAccessError?: () => void;
  onClose: () => void;
}

export function WorkforceDialog(props: WorkforceDialogProps) {
  const {
    place,
    scenario,
    accountId,
    connection,
    canEdit,
    hasUnsavedChanges,
    initialSite,
    initialRequest,
    onClose,
  } = props;
  const scope = JSON.stringify([
    accountId,
    connection?.organizationId,
    connection?.projectId,
    scenario.id,
  ]);
  const [dataScope, setDataScope] = useState(scope);
  const initial =
    initialRequest?.site ??
    initialSite?.position ??
    scenario.workforce?.capture.request.site ??
    place.center;
  const [latitude, setLatitude] = useState(String(initial[1]));
  const [longitude, setLongitude] = useState(String(initial[0]));
  const [siteLabel, setSiteLabel] = useState(
    initialSite?.label ??
      (scenario.workforce ? "Captured site" : "Study-area reference point"),
  );
  const [mode, setMode] = useState<"car" | "walk">(
    initialRequest?.mode ?? scenario.workforce?.capture.request.mode ?? "car",
  );
  const [featureSearch, setFeatureSearch] = useState("");
  const [featureId, setFeatureId] = useState("");
  const [minutes, setMinutes] = useState<15 | 30 | 45>(30);
  const [panelId, setPanelId] = useState<"education" | "occupation">(
    "education",
  );
  const [storedCapabilities, setCapabilities] =
    useState<WorkforceCapabilities | null>(null);
  const [storedJobs, setJobs] = useState<WorkforceJob[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [storedResult, setResult] = useState<WorkforceJobResult | null>(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [resultLoading, setResultLoading] = useState(false);
  const [error, setError] = useState("");
  const [pollWarning, setPollWarning] = useState("");
  const [notice, setNotice] = useState("");
  const [storedAccessDenied, setAccessDenied] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const attempts = useRef(new WorkforceStartAttempts());
  const retryKeys = useRef(new Map<string, { key: string; version: number }>());
  const requestController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // A changed context must mask private evidence during render, before effects clean it up.
  const capabilities = dataScope === scope ? storedCapabilities : null;
  const jobs = dataScope === scope ? storedJobs : [];
  const result = dataScope === scope ? storedResult : null;
  const accessDenied = dataScope === scope && storedAccessDenied;
  const live = useRef({ ...props, scope });
  live.current = { ...props, scope };
  const features = useMemo(
    () => workforceSiteChoices(place, scenario),
    [place, scenario],
  );
  const filteredFeatures = useMemo(
    () =>
      features.filter((feature) =>
        feature.label
          .toLowerCase()
          .includes(featureSearch.trim().toLowerCase()),
      ),
    [features, featureSearch],
  );
  const position = useMemo(
    () => workforceCoordinates(longitude, latitude),
    [longitude, latitude],
  );
  const request: WorkforceRequest | null = useMemo(
    () =>
      position
        ? {
            site: position,
            mode,
            direction: "inbound",
            thresholdsMinutes: [15, 30, 45],
          }
        : null,
    [position, mode],
  );
  const selected = jobs.find((job) => job.id === selectedId);
  const workforce = result?.workforce ?? scenario.workforce ?? null;
  const sameQuery = workforce
    ? sameWorkforceQuery(request, workforce.capture.request)
    : true;
  const contour =
    result?.workforce.captureHash === workforce?.captureHash
      ? (result?.contour.geometry ?? null)
      : null;
  const saved =
    !!workforce &&
    scenario.workforce?.captureHash === workforce.captureHash &&
    scenario.workforce.origin === workforce.origin;
  const changedSavedVersion =
    !!selected &&
    !!connection &&
    (selected.scenarioRevision !== scenario.revision ||
      selected.projectVersion !== connection.version);
  const canMutate =
    !!accountId &&
    !!connection &&
    canEdit &&
    !hasUnsavedChanges &&
    !accessDenied;
  const canStart =
    canMutate &&
    !!request &&
    !!capabilities?.enabled &&
    !!capabilities.configured &&
    capabilities.modes[mode] &&
    !busy;

  function handleAccessFailure(error: unknown) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      setAccessDenied(true);
      setJobs([]);
      setResult(null);
      setCapabilities(null);
      attempts.current.clear();
      retryKeys.current.clear();
      live.current.onAccessError?.();
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestController.current?.abort();
    };
  }, []);
  useEffect(() => {
    requestController.current?.abort();
    attempts.current.clear();
    retryKeys.current.clear();
    setJobs([]);
    setResult(null);
    setSelectedId("");
    setCapabilities(null);
    setAccessDenied(false);
    setError("");
    setPollWarning("");
    setBusy("");
    setDataScope(scope);
  }, [scope]);
  useEffect(() => {
    if (!accountId || !connection) {
      setLoading(false);
      return;
    }
    setAccessDenied(false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failures = 0;
    let denied = false;
    const currentScope = scope;
    const projectId = connection.projectId;
    const valid = () =>
      !controller.signal.aborted &&
      !denied &&
      live.current.scope === currentScope;
    const refresh = async () => {
      if (inFlight || !valid()) return;
      if (timer) clearTimeout(timer);
      inFlight = true;
      try {
        const [nextCapabilities, nextJobs] = await Promise.all([
          workforceApi.capabilities(projectId, controller.signal),
          workforceApi.jobs(projectId, controller.signal),
        ]);
        if (!valid()) return;
        setCapabilities(nextCapabilities);
        setJobs(
          nextJobs.jobs.filter(
            (job) => job.scenarioId === live.current.scenario.id,
          ),
        );
        setPollWarning("");
        failures = 0;
        setSelectedId(
          (old) =>
            old ||
            retainedWorkforceJobId(
              live.current.scenario.workforce,
              nextJobs.jobs,
              live.current.scenario.id,
            ),
        );
      } catch (failure) {
        if (!valid()) return;
        failures++;
        setPollWarning(message(failure));
        handleAccessFailure(failure);
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        ) {
          denied = true;
          setLoading(false);
          return;
        }
      } finally {
        inFlight = false;
        if (valid()) {
          setLoading(false);
          timer = setTimeout(
            () => {
              if (document.visibilityState === "visible") void refresh();
              else timer = setTimeout(() => void refresh(), 5000);
            },
            Math.min(30000, failures ? 2000 * 2 ** failures : 3000),
          );
        }
      }
    };
    setLoading(true);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [scope, refreshIndex]);
  useEffect(() => {
    if (!selectedId) setResult(null);
    if (
      !accountId ||
      !connection ||
      !selected ||
      selected.status !== "completed" ||
      accessDenied
    ) {
      setResultLoading(false);
      return;
    }
    const controller = new AbortController();
    const expectedScope = scope;
    setResultLoading(true);
    workforceApi
      .result(connection.projectId, selected.id, controller.signal)
      .then((next) => {
        if (
          !controller.signal.aborted &&
          live.current.scope === expectedScope
        ) {
          setResult(next);
          setError("");
        }
      })
      .catch((failure) => {
        if (
          !controller.signal.aborted &&
          live.current.scope === expectedScope
        ) {
          setError(message(failure));
          handleAccessFailure(failure);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && live.current.scope === expectedScope)
          setResultLoading(false);
      });
    return () => controller.abort();
  }, [
    scope,
    selected?.id,
    selected?.status,
    selected?.result?.resultHash,
    accessDenied,
    refreshIndex,
  ]);

  function chooseSite(point: Position, label = "Chosen map location") {
    setLatitude(String(point[1]));
    setLongitude(String(point[0]));
    setSiteLabel(label);
    setFeatureId("");
    setNotice("");
  }
  async function act(
    name: string,
    action: (signal: AbortSignal, valid: () => boolean) => Promise<void>,
  ) {
    if (busy) return;
    const expectedScope = scope;
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      live.current.scope === expectedScope;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await action(controller.signal, valid);
    } catch (failure) {
      if (valid()) {
        setError(message(failure));
        handleAccessFailure(failure);
      }
    } finally {
      if (valid()) setBusy("");
    }
  }
  function upsert(job: WorkforceJob) {
    setJobs((existing) => [
      job,
      ...existing.filter((item) => item.id !== job.id),
    ]);
    setSelectedId(job.id);
  }
  function run() {
    if (!canStart || !connection || !request) return;
    void act("run", async (signal, valid) => {
      const body = attempts.current.for(connection.projectId, {
        scenarioId: scenario.id,
        expectedVersion: connection.version,
        expectedRevision: scenario.revision,
        request,
      });
      try {
        const response = await workforceApi.start(
          connection.projectId,
          body,
          signal,
        );
        if (!valid()) return;
        attempts.current.complete(connection.projectId, body);
        upsert(response.job);
        setNotice("request-retained");
      } catch (failure) {
        if (
          failure instanceof ApiError &&
          failure.status >= 400 &&
          failure.status < 500
        )
          attempts.current.complete(connection.projectId, body);
        throw failure;
      }
    });
  }
  function cancel(job: WorkforceJob) {
    if (!canMutate || !connection) return;
    void act("cancel", async (signal, valid) => {
      const response = await workforceApi.cancel(
        connection.projectId,
        job,
        signal,
      );
      if (valid()) {
        upsert(response.job);
        setNotice(
          "Cancellation requested. The last captured result is retained.",
        );
      }
    });
  }
  function retry(job: WorkforceJob) {
    if (!canMutate || !connection) return;
    void act("retry", async (signal, valid) => {
      const attempt = retryKeys.current.get(job.id) ?? {
        key: crypto.randomUUID(),
        version: job.version,
      };
      retryKeys.current.set(job.id, attempt);
      try {
        const response = await workforceApi.retry(
          connection.projectId,
          { ...job, version: attempt.version },
          attempt.key,
          signal,
        );
        if (valid()) {
          retryKeys.current.delete(job.id);
          upsert(response.job);
        }
      } catch (failure) {
        if (
          failure instanceof ApiError &&
          failure.status >= 400 &&
          failure.status < 500
        )
          retryKeys.current.delete(job.id);
        throw failure;
      }
    });
  }
  function adopt() {
    if (
      !canMutate ||
      !connection ||
      !result ||
      !sameQuery ||
      saved ||
      resultLoading ||
      selectedId !== result.job.id
    )
      return;
    // Keep the parent's request-time version/revision closure. Calling the
    // latest callback could let a delayed response replace a newer clean save
    // of the same project and scenario while this workbench stays mounted.
    const acceptAtRequest = live.current.onAdopt;
    const expectedVersion = connection.version;
    void act("adopt", async (signal, valid) => {
      const response = await workforceApi.adopt(
        connection.projectId,
        result.job,
        {
          scenarioId: scenario.id,
          expectedVersion: connection.version,
          expectedRevision: scenario.revision,
          inputHash: result.workforce.capture.inputHash,
          resultHash: result.workforce.capture.resultHash,
        },
        signal,
      );
      if (!valid() || !live.current.canEdit || live.current.hasUnsavedChanges)
        return;
      if (response.version !== expectedVersion + 1)
        throw new Error(
          "The saved response has an unexpected project version. Reopen the saved project to inspect the retained analysis; your current draft has been preserved.",
        );
      await acceptAtRequest(response);
      if (valid())
        setNotice("Captured workforce evidence saved to this scenario.");
    });
  }
  function downloadArtifact(job: WorkforceJob) {
    if (!connection || !accountId || accessDenied) return;
    void act("download", async (signal, valid) => {
      const artifact = await workforceArtifact(
        connection.projectId,
        job.id,
        signal,
      );
      if (!valid()) return;
      download(artifact.filename, artifact.blob);
      setNotice(
        "Full routing evidence downloaded and its SHA-256 content identity checked. The cohort source pack is retained separately on the server.",
      );
    });
  }

  return (
    <Modal
      title="Who can reach this site?"
      description="A regional workforce workbench. Choose a site, request real inbound routing, and inspect the source evidence."
      open
      onClose={onClose}
      wide
    >
      <div className="workforce-workbench">
        <div className="workforce-topline">
          <span>
            <UsersRound size={17} />
            WORKFORCE SHED
          </span>
          <span>15 · 30 · 45 minutes</span>
        </div>
        {accessDenied ? (
          <div className="workforce-empty" role="alert">
            <h3>Project access needs to be checked.</h3>
            <p>
              Private jobs and results have been cleared from this workbench.
            </p>
            <button
              type="button"
              className="button secondary-button"
              onClick={() => setRefreshIndex((value) => value + 1)}
            >
              Check access again
            </button>
          </div>
        ) : (
          <>
            <div className="workforce-layout">
              <aside
                className="workforce-setup"
                aria-label="Workforce query settings"
              >
                <h3>
                  <MapPin size={18} />
                  1. Choose the site
                </h3>
                <label className="workforce-field">
                  <span>Find a building or parcel</span>
                  <input
                    type="search"
                    value={featureSearch}
                    onChange={(event) => setFeatureSearch(event.target.value)}
                    placeholder="Name in this scenario"
                  />
                </label>
                <label className="workforce-field">
                  <span>Site feature</span>
                  <select
                    value={featureId}
                    onChange={(event) => {
                      const feature = features.find(
                        (item) => item.id === event.target.value,
                      );
                      if (feature) {
                        chooseSite(feature.position, feature.label);
                        setFeatureId(feature.id);
                      } else setFeatureId("");
                    }}
                  >
                    <option value="">Custom coordinates or map location</option>
                    {filteredFeatures.map((feature) => (
                      <option key={feature.id} value={feature.id}>
                        {feature.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="workforce-note">
                  A feature supplies a reference point, not a verified entrance.
                  Adjust the coordinates or choose a map location.
                </p>
                <div className="workforce-coordinate-fields">
                  <label className="workforce-field">
                    <span>Site latitude</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={latitude}
                      aria-invalid={!position}
                      onChange={(event) => {
                        setLatitude(event.target.value);
                        setFeatureId("");
                        setSiteLabel("Entered coordinates");
                      }}
                    />
                  </label>
                  <label className="workforce-field">
                    <span>Site longitude</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={longitude}
                      aria-invalid={!position}
                      onChange={(event) => {
                        setLongitude(event.target.value);
                        setFeatureId("");
                        setSiteLabel("Entered coordinates");
                      }}
                    />
                  </label>
                </div>
                {!position && (
                  <p className="workforce-warning" role="alert">
                    Enter latitude between −85 and 85 and longitude between −180
                    and 180. Blank values are not zero.
                  </p>
                )}
                <p className="workforce-site-label">{siteLabel}</p>
                <h3>2. Travel toward it</h3>
                <label className="workforce-field">
                  <span>Commute mode</span>
                  <select
                    value={mode}
                    onChange={(event) =>
                      setMode(event.target.value as "car" | "walk")
                    }
                  >
                    <option value="car">Driving</option>
                    <option value="walk">Walking</option>
                    <option value="transit" disabled>
                      Transit · unavailable
                    </option>
                  </select>
                </label>
                <p className="workforce-note">
                  All three thresholds are captured in one request. This is
                  travel <strong>to</strong> the site on a regional source
                  graph. It does not use street edits in your proposal.
                </p>
                <p className="workforce-note">
                  Transit is unavailable: this installation has no verified
                  transit service or timetable.
                </p>
                {!accountId ? (
                  <div className="workforce-gate">
                    <h4>A free account to run it</h4>
                    <p>
                      You can inspect saved evidence here. Sign in to retain a
                      new routing job.
                    </p>
                    <button
                      type="button"
                      className="button secondary-button"
                      onClick={() => props.onSignIn(request, siteLabel)}
                    >
                      Sign in or create a free account
                    </button>
                  </div>
                ) : !connection || hasUnsavedChanges ? (
                  <div className="workforce-gate">
                    <h4>Save this scenario first</h4>
                    <p>
                      The job must reference an exact saved project and
                      revision.
                    </p>
                    <button
                      type="button"
                      className="button secondary-button"
                      disabled={!canEdit || !!busy}
                      onClick={() =>
                        void act("save", async () => {
                          await props.onSaveProject();
                        })
                      }
                    >
                      <Save size={15} />
                      {busy === "save" ? "Saving…" : "Save project to run"}
                    </button>
                  </div>
                ) : !canEdit ? (
                  <p className="workforce-warning">
                    Your role can inspect captured evidence. An editor or owner
                    can request or adopt a result.
                  </p>
                ) : null}
                {loading && (
                  <p role="status">Checking regional routing availability…</p>
                )}
                {capabilities &&
                  (!capabilities.enabled ||
                    !capabilities.configured ||
                    !capabilities.modes[mode]) && (
                    <p className="workforce-warning">
                      {capabilities.reason ??
                        `${workforceMode(mode)} routing is not available in this installation.`}
                    </p>
                  )}
                <button
                  type="button"
                  className="button primary primary-button workforce-run"
                  disabled={!canStart}
                  onClick={run}
                >
                  {busy === "run" ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Play size={17} />
                  )}
                  {busy === "run" ? "Requesting…" : "Run workforce shed"}
                </button>
                <p className="workforce-note">
                  A run begins only when you choose Run. Closing the workbench
                  leaves a queued or running job on the server.
                </p>
                {capabilities && (
                  <details className="workforce-capacity">
                    <summary>Availability & run limits</summary>
                    <p>
                      {capabilities.region?.name ??
                        "No prepared region is configured."}
                    </p>
                    <p>
                      {capabilities.limits.pendingPerAccount} pending job(s) per
                      account · {capabilities.limits.startsPerAccountPerDay}{" "}
                      starts per day · {capabilities.limits.attempts} attempts
                      per job.
                    </p>
                    {capabilities.cost.model && (
                      <p>{capabilities.cost.model.statement}</p>
                    )}
                    {capabilities.cost.notes.map((note, index) => (
                      <p key={index}>{note}</p>
                    ))}
                  </details>
                )}
              </aside>
              <div className="workforce-main">
                <Suspense
                  fallback={
                    <div className="workforce-map-loading" role="status">
                      Opening the regional map…
                    </div>
                  }
                >
                  <RegionalMap
                    place={place}
                    scenario={scenario}
                    site={position}
                    capturedSite={workforce?.capture.request.site}
                    studyArea={studyAreaGeometry(place)}
                    contour={contour}
                    minutes={minutes}
                    extent={
                      capabilities?.region?.extent ??
                      workforce?.capture.network.extent ??
                      null
                    }
                    onSiteChange={chooseSite}
                  />
                </Suspense>
                {(error || pollWarning) && (
                  <div className="workforce-warning" role="alert">
                    <p>{error || pollWarning}</p>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setRefreshIndex((value) => value + 1)}
                    >
                      <RefreshCw size={14} />
                      Refresh job status
                    </button>
                  </div>
                )}
                {notice && (
                  <p className="workforce-notice" role="status">
                    <Check size={16} />
                    {notice === "request-retained"
                      ? workforceSubmissionMessage(selected?.status)
                      : notice}
                  </p>
                )}
                {workforce && (
                  <WorkforceQuickResult
                    workforce={workforce}
                    minutes={minutes}
                    panelId={panelId}
                    stale={!sameQuery}
                  />
                )}
                {jobs.length > 0 && (
                  <section
                    className="workforce-jobs"
                    aria-label="Saved workforce jobs"
                  >
                    <div className="workforce-result-heading">
                      <h3>Retained runs</h3>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Refresh workforce jobs"
                        onClick={() => setRefreshIndex((value) => value + 1)}
                      >
                        <RefreshCw size={16} />
                      </button>
                    </div>
                    <label className="workforce-field">
                      <span>Workforce result</span>
                      <select
                        value={selectedId}
                        onChange={(event) => {
                          setSelectedId(event.target.value);
                          setError("");
                          setNotice("");
                        }}
                      >
                        <option value="">Saved scenario evidence</option>
                        {jobs.map((job) => (
                          <option key={job.id} value={job.id}>
                            {workforceMode(job.request.mode)} ·{" "}
                            {new Date(job.createdAt).toLocaleString()} ·{" "}
                            {job.status} · revision {job.scenarioRevision}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selected && (
                      <div className="workforce-job-status">
                        <div>
                          <strong>
                            {activeJob(selected)
                              ? stageNames[selected.stage]
                              : selected.status === "completed"
                                ? "Captured result ready"
                                : selected.status === "cancelled"
                                  ? "Job cancelled"
                                  : "Job failed"}
                          </strong>
                          <small>
                            Saved revision {selected.scenarioRevision} · attempt{" "}
                            {selected.attempt} ·{" "}
                            {workforceMode(selected.request.mode).toLowerCase()}{" "}
                            to {selected.request.site[1].toFixed(5)},{" "}
                            {selected.request.site[0].toFixed(5)}
                          </small>
                        </div>
                        {activeJob(selected) && (
                          <>
                            <progress
                              aria-label="Workforce job stage progress"
                              max={100}
                              value={selected.progress}
                            />
                            <small>
                              Stage progress is approximate, not a
                              completion-time estimate.
                            </small>
                            <button
                              type="button"
                              className="button secondary-button"
                              disabled={
                                !canMutate || !!busy || selected.cancelRequested
                              }
                              onClick={() => cancel(selected)}
                            >
                              <Square size={13} />
                              {selected.cancelRequested
                                ? "Cancellation requested"
                                : "Cancel run"}
                            </button>
                          </>
                        )}
                        {selected.error && (
                          <p className="workforce-warning">
                            {selected.error.message}
                          </p>
                        )}
                        {selected.status === "completed" && (
                          <button
                            type="button"
                            className="button secondary-button"
                            disabled={!!busy}
                            onClick={() => downloadArtifact(selected)}
                          >
                            <Download size={14} />
                            {busy === "download"
                              ? "Checking evidence download…"
                              : "Download full routing evidence"}
                          </button>
                        )}
                        {((selected.status === "failed" &&
                          selected.error?.retryable) ||
                          selected.status === "cancelled") && (
                          <button
                            type="button"
                            className="button secondary-button"
                            disabled={!canMutate || !!busy}
                            onClick={() => retry(selected)}
                          >
                            <RefreshCw size={14} />
                            Retry run
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                )}
                {resultLoading && (
                  <p role="status">Loading the captured result…</p>
                )}
                {workforce ? (
                  <>
                    {!sameQuery && (
                      <div className="workforce-stale" role="status">
                        <strong>Previous result · query changed</strong>
                        <p>
                          The tables and contours still describe{" "}
                          {workforceMode(
                            workforce.capture.request.mode,
                          ).toLowerCase()}{" "}
                          toward {workforce.capture.request.site[1]},{" "}
                          {workforce.capture.request.site[0]}. They have not
                          been recalculated for your current settings.
                        </p>
                        <button
                          type="button"
                          className="button secondary-button"
                          onClick={() => {
                            chooseSite(
                              workforce.capture.request.site,
                              "Captured site",
                            );
                            setMode(workforce.capture.request.mode);
                          }}
                        >
                          Use captured query
                        </button>
                      </div>
                    )}
                    {!contour && (
                      <p className="workforce-note">
                        Regional map unavailable for this saved capture. The
                        frozen tables remain available; no contour has been
                        reconstructed from the counts.
                      </p>
                    )}
                    <p className="workforce-note">
                      The captured site is{" "}
                      {workforce.capture.siteSnapMeters.toFixed(1)} m from the
                      routing connection. The provider did not return its exact
                      coordinate, so the map marks the chosen site only.
                    </p>
                    <WorkforceResults
                      workforce={workforce}
                      minutes={minutes}
                      onMinutesChange={setMinutes}
                      panelId={panelId}
                      onPanelChange={setPanelId}
                    />
                    {changedSavedVersion && (
                      <p className="workforce-note">
                        This job started from an earlier saved revision. Its
                        query and source evidence remain frozen; adopting it
                        adds that capture to the current saved scenario.
                      </p>
                    )}
                    <div className="workforce-adopt">
                      <div>
                        <strong>
                          {saved
                            ? "Saved with this scenario"
                            : result
                              ? "Captured, ready for review"
                              : "Evidence retained in this project"}
                        </strong>
                        <p>
                          {saved
                            ? "This summary stays with project exports and published snapshots."
                            : "Only an explicit adoption changes the scenario. Local building or street edits do not reroute this evidence."}
                        </p>
                      </div>
                      {result && !saved && (
                        <button
                          type="button"
                          className="button primary primary-button"
                          disabled={
                            !canMutate ||
                            !sameQuery ||
                            !!busy ||
                            resultLoading ||
                            selectedId !== result.job.id
                          }
                          onClick={adopt}
                        >
                          <Check size={16} />
                          {busy === "adopt"
                            ? "Saving capture…"
                            : "Save capture to scenario"}
                        </button>
                      )}
                    </div>
                    <WorkforceMethod capture={workforce.capture} />
                  </>
                ) : (
                  <div className="workforce-empty">
                    <CircleHelp size={25} />
                    <h3>A site is a starting point.</h3>
                    <p>
                      Choose a location and request a real routing run. When it
                      finishes, this space will show Census education and
                      occupation evidence, source coverage, and uncertainty.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <footer className="workforce-dialog-footer">
              <p>
                Free to explore. Source-backed evidence for early decisions.
              </p>
              <div>
                {scenario.workforce && canEdit && props.onRemove && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busy}
                    onClick={props.onRemove}
                  >
                    Remove saved capture
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary-button"
                  onClick={onClose}
                >
                  Done
                  <ChevronRight size={15} />
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}
