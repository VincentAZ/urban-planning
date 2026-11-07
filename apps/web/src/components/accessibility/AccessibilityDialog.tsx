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
import type {
  Place,
  Position,
  Scenario,
  AccessibilityRequest,
} from "@urban/core";
import type { CloudProjectLink } from "../../lib/cloud-workspace";
import { ApiError, download } from "../../lib/api";
import {
  accessibilityApi,
  accessibilityArtifact,
  type AccessibilityAdoptResponse,
  type AccessibilityCapabilities,
  type AccessibilityJob,
  type AccessibilityJobResult,
} from "../../lib/accessibility-api";
import { Modal } from "../Modal";
import {
  AccessibilityMethod,
  AccessibilityResults,
  AccessibilityQuickResult,
  accessibilityMode,
  differentAccessibilityOrigins,
} from "./AccessibilityOverview";
import {
  sameAccessibilityQuery,
  accessibilitySourceChanged,
  retainedAccessibilityJobId,
  accessibilityCoordinates,
  accessibilitySiteChoices,
  AccessibilityStartAttempts,
  accessibilitySubmissionMessage,
} from "./query";
import "./accessibility.css";

const AccessibilityMap = lazy(() => import("./AccessibilityMap"));
const activeJob = (job: AccessibilityJob) =>
  job.status === "queued" || job.status === "running";
const stageNames: Record<AccessibilityJob["stage"], string> = {
  queued: "Waiting for the regional worker",
  validating: "Checking source and geographic coverage",
  routing: "Routing from the origin to workplaces",
  aggregating: "Combining workplace job evidence",
  contours: "Preparing regional contours",
  saving: "Retaining the immutable result",
  complete: "Captured result ready",
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The accessibility service could not complete this request.";
export interface AccessibilityDialogProps {
  place: Place;
  scenario: Scenario;
  accountId: string | null;
  connection: CloudProjectLink | null;
  canEdit: boolean;
  hasUnsavedChanges: boolean;
  initialSite?: { position: Position; label: string };
  initialRequest?: AccessibilityRequest;
  onSignIn: (request: AccessibilityRequest | null, siteLabel: string) => void;
  onSaveProject: () => Promise<void>;
  onAdopt: (response: AccessibilityAdoptResponse) => Promise<void>;
  onRemove?: (mode: "car" | "walk") => void;
  onAccessError?: () => void;
  onClose: () => void;
}

export function AccessibilityDialog(props: AccessibilityDialogProps) {
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
  const initialSaved =
    scenario.accessibility?.captures.car ??
    scenario.accessibility?.captures.walk;
  const initial =
    initialRequest?.site ??
    initialSite?.position ??
    initialSaved?.capture.request.site ??
    place.center;
  const [latitude, setLatitude] = useState(String(initial[1]));
  const [longitude, setLongitude] = useState(String(initial[0]));
  const [siteLabel, setSiteLabel] = useState(
    initialSite?.label ??
      (scenario.accessibility
        ? "Captured origin"
        : "Study-area reference point"),
  );
  const [mode, setMode] = useState<"car" | "walk">(
    initialRequest?.mode ?? initialSaved?.capture.request.mode ?? "car",
  );
  const [featureSearch, setFeatureSearch] = useState("");
  const [featureId, setFeatureId] = useState("");
  const [minutes, setMinutes] = useState<15 | 30 | 45>(30);

  const [storedCapabilities, setCapabilities] =
    useState<AccessibilityCapabilities | null>(null);
  const [storedJobs, setJobs] = useState<AccessibilityJob[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [storedResult, setResult] = useState<AccessibilityJobResult | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [resultLoading, setResultLoading] = useState(false);
  const [error, setError] = useState("");
  const [pollWarning, setPollWarning] = useState("");
  const [notice, setNotice] = useState("");
  const [storedAccessDenied, setAccessDenied] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const attempts = useRef(new AccessibilityStartAttempts());
  const retryKeys = useRef(new Map<string, { key: string; version: number }>());
  const requestController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // A changed context must mask private evidence during render, before effects clean it up.
  const capabilities = dataScope === scope ? storedCapabilities : null;
  const jobs = dataScope === scope ? storedJobs : [];
  const result =
    dataScope === scope && storedResult?.job.id === selectedId
      ? storedResult
      : null;
  const accessDenied = dataScope === scope && storedAccessDenied;
  const live = useRef({ ...props, scope });
  live.current = { ...props, scope };
  const features = useMemo(
    () => accessibilitySiteChoices(place, scenario),
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
    () => accessibilityCoordinates(longitude, latitude),
    [longitude, latitude],
  );
  const request: AccessibilityRequest | null = useMemo(
    () =>
      position
        ? {
            site: position,
            mode,
            direction: "outbound",
            thresholdsMinutes: [15, 30, 45],
          }
        : null,
    [position, mode],
  );
  const selected = jobs.find((job) => job.id === selectedId);
  const savedForMode = scenario.accessibility?.captures[mode];
  const accessibility = result?.accessibility ?? savedForMode ?? null;
  const sameQuery = accessibility
    ? sameAccessibilityQuery(request, accessibility.capture.request)
    : true;
  const sourceChanged = accessibility
    ? accessibilitySourceChanged(
        accessibility,
        capabilities?.sourceIdentities?.[accessibility.capture.request.mode],
      )
    : null;
  const contour =
    result?.accessibility.captureHash === accessibility?.captureHash
      ? (result?.contour.geometry ?? null)
      : null;
  const saved =
    !!accessibility &&
    scenario.accessibility?.captures[accessibility.capture.request.mode]
      ?.captureHash === accessibility.captureHash &&
    scenario.accessibility.captures[accessibility.capture.request.mode]
      ?.origin === accessibility.origin;
  const changedSavedVersion =
    !!selected &&
    !!connection &&
    (selected.scenarioRevision !== scenario.revision ||
      selected.projectVersion !== connection.version);
  const canManageJobs = !!accountId && !!connection && canEdit && !accessDenied;
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
    let firstRead = true;
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
          firstRead
            ? accessibilityApi.capabilities(projectId, controller.signal)
            : Promise.resolve(null),
          accessibilityApi.jobs(projectId, controller.signal),
        ]);
        if (!valid()) return;
        if (nextCapabilities) setCapabilities(nextCapabilities);
        firstRead = false;
        setJobs(
          nextJobs.jobs.filter(
            (job) => job.scenarioId === live.current.scenario.id,
          ),
        );
        setPollWarning("");
        failures = 0;
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
    accessibilityApi
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
    if (
      busy ||
      (requestController.current && !requestController.current.signal.aborted)
    )
      return;
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
      if (requestController.current === controller)
        requestController.current = null;
      if (valid()) setBusy("");
    }
  }
  function upsert(job: AccessibilityJob) {
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
        const response = await accessibilityApi.start(
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
  function cancel(job: AccessibilityJob) {
    if (!canManageJobs || !connection) return;
    void act("cancel", async (signal, valid) => {
      const response = await accessibilityApi.cancel(
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
  function retry(job: AccessibilityJob) {
    if (!canManageJobs || !connection) return;
    void act("retry", async (signal, valid) => {
      const attempt = retryKeys.current.get(job.id) ?? {
        key: crypto.randomUUID(),
        version: job.version,
      };
      retryKeys.current.set(job.id, attempt);
      try {
        const response = await accessibilityApi.retry(
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
      const response = await accessibilityApi.adopt(
        connection.projectId,
        result.job,
        {
          scenarioId: scenario.id,
          expectedVersion: connection.version,
          expectedRevision: scenario.revision,
          inputHash: result.accessibility.capture.inputHash,
          resultHash: result.accessibility.capture.resultHash,
        },
        signal,
      );
      if (!valid() || !live.current.canEdit || live.current.hasUnsavedChanges)
        return;
      if (
        response.version !== expectedVersion + 1 ||
        response.project.id !== connection.projectId ||
        response.project.scenarios.find((item) => item.id === scenario.id)
          ?.revision !==
          scenario.revision + 1
      )
        throw new Error(
          "The saved response has an unexpected project version. Reopen the saved project to inspect the retained analysis; your current draft has been preserved.",
        );
      await acceptAtRequest(response);
      if (valid())
        setNotice(
          "Captured jobs accessibility saved for this travel mode. Other saved modes are retained.",
        );
    });
  }
  function downloadArtifact(job: AccessibilityJob) {
    if (!connection || !accountId || accessDenied) return;
    void act("download", async (signal, valid) => {
      const artifact = await accessibilityArtifact(
        connection.projectId,
        job.id,
        signal,
      );
      if (!valid()) return;
      download(artifact.filename, artifact.blob);
      setNotice(
        "Full routing evidence downloaded and its SHA-256 content identity checked. The workplace source pack is retained separately on the server.",
      );
    });
  }

  return (
    <Modal
      title="Where can you get to work?"
      description="A jobs accessibility workbench. Choose an origin, request real outbound routing, and inspect the source evidence."
      open
      onClose={onClose}
      wide
    >
      <div className="accessibility-workbench">
        <div className="accessibility-topline">
          <span>
            <UsersRound size={17} />
            JOBS ACCESSIBILITY
          </span>
          <span>15 · 30 · 45 minutes</span>
        </div>
        {accessDenied ? (
          <div className="accessibility-empty" role="alert">
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
            <div className="accessibility-layout">
              <aside
                className="accessibility-setup"
                aria-label="Accessibility query settings"
              >
                <h3>
                  <MapPin size={18} />
                  1. Choose your origin
                </h3>
                <label className="accessibility-field">
                  <span>Find a building or parcel</span>
                  <input
                    type="search"
                    value={featureSearch}
                    onChange={(event) => setFeatureSearch(event.target.value)}
                    placeholder="Name in this scenario"
                  />
                </label>
                <label className="accessibility-field">
                  <span>Origin feature</span>
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
                <p className="accessibility-note">
                  A feature supplies a reference point, not a verified entrance.
                  Adjust the coordinates or choose a map location.
                </p>
                <div className="accessibility-coordinate-fields">
                  <label className="accessibility-field">
                    <span>Origin latitude</span>
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
                  <label className="accessibility-field">
                    <span>Origin longitude</span>
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
                  <p className="accessibility-warning" role="alert">
                    Enter latitude between −85 and 85 and longitude between −180
                    and 180. Blank values are not zero.
                  </p>
                )}
                <p className="accessibility-site-label">{siteLabel}</p>
                <h3>2. Travel from here</h3>
                <label className="accessibility-field">
                  <span>Travel mode</span>
                  <select
                    aria-label="Travel mode"
                    value={mode}
                    onChange={(event) => {
                      setMode(event.target.value as "car" | "walk");
                      setSelectedId("");
                      setResult(null);
                    }}
                  >
                    <option value="car">Driving</option>
                    <option value="walk">Walking</option>
                    <option value="transit" disabled>
                      Transit · unavailable
                    </option>
                  </select>
                </label>
                <p className="accessibility-note">
                  All three thresholds are captured in one request. This is
                  travel <strong>from</strong> this origin to workplace blocks
                  on a regional source graph. It does not use street edits in
                  your proposal.
                </p>
                <p className="accessibility-note">
                  Transit is unavailable: this installation has no verified
                  transit service or timetable.
                </p>
                {!accountId ? (
                  <div className="accessibility-gate">
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
                  <div className="accessibility-gate">
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
                  <p className="accessibility-warning">
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
                    <p className="accessibility-warning">
                      {capabilities.reason ??
                        `${accessibilityMode(mode)} routing is not available in this installation.`}
                    </p>
                  )}
                {capabilities?.source && (
                  <p className="accessibility-note">
                    Prepared source: {capabilities.source.vintage} LODES primary
                    jobs (JT01) ·{" "}
                    {capabilities.source.primaryJobs.toLocaleString()} jobs
                    across{" "}
                    {capabilities.source.workplaceBlocks.toLocaleString()}{" "}
                    workplace blocks in the prepared region. These are source
                    inventory totals, not jobs reachable from this origin.
                  </p>
                )}
                <button
                  type="button"
                  className="button primary primary-button accessibility-run"
                  disabled={!canStart}
                  onClick={run}
                >
                  {busy === "run" ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Play size={17} />
                  )}
                  {busy === "run" ? "Requesting…" : "Run jobs accessibility"}
                </button>
                <p className="accessibility-note">
                  A run begins only when you choose Run. Closing the workbench
                  leaves a queued or running job on the server.
                </p>
                {capabilities && (
                  <details className="accessibility-capacity">
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
              <div className="accessibility-main">
                <Suspense
                  fallback={
                    <div className="accessibility-map-loading" role="status">
                      Opening the regional map…
                    </div>
                  }
                >
                  <AccessibilityMap
                    place={place}
                    scenario={scenario}
                    site={position}
                    capturedSite={accessibility?.capture.request.site}
                    studyArea={studyAreaGeometry(place)}
                    contour={contour}
                    minutes={minutes}
                    extent={
                      capabilities?.region?.extent ??
                      accessibility?.capture.network.extent ??
                      null
                    }
                    onSiteChange={chooseSite}
                  />
                </Suspense>
                {(error || pollWarning) && (
                  <div className="accessibility-warning" role="alert">
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
                  <p className="accessibility-notice" role="status">
                    <Check size={16} />
                    {notice === "request-retained"
                      ? accessibilitySubmissionMessage(selected?.status)
                      : notice}
                  </p>
                )}
                {differentAccessibilityOrigins(scenario.accessibility) && (
                  <p className="accessibility-warning">
                    Saved driving and walking captures use different origins.
                    They are not a same-origin mode comparison.
                  </p>
                )}
                {accessibility && (
                  <AccessibilityQuickResult
                    accessibility={accessibility}
                    minutes={minutes}
                    stale={!sameQuery}
                  />
                )}
                {jobs.length > 0 && (
                  <section
                    className="accessibility-jobs"
                    aria-label="Saved accessibility jobs"
                  >
                    <div className="accessibility-result-heading">
                      <h3>Retained runs</h3>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Refresh accessibility jobs"
                        onClick={() => setRefreshIndex((value) => value + 1)}
                      >
                        <RefreshCw size={16} />
                      </button>
                    </div>
                    <label className="accessibility-field">
                      <span>Accessibility result</span>
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
                            {accessibilityMode(job.request.mode)} ·{" "}
                            {new Date(job.createdAt).toLocaleString()} ·{" "}
                            {job.status} · revision {job.scenarioRevision}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selected && (
                      <div className="accessibility-job-status">
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
                            {accessibilityMode(
                              selected.request.mode,
                            ).toLowerCase()}{" "}
                            from {selected.request.site[1].toFixed(5)},{" "}
                            {selected.request.site[0].toFixed(5)}
                          </small>
                        </div>
                        {activeJob(selected) && (
                          <>
                            <progress
                              aria-label="Accessibility job stage progress"
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
                                !canManageJobs ||
                                !!busy ||
                                selected.cancelRequested
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
                          <p className="accessibility-warning">
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
                            disabled={!canManageJobs || !!busy}
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
                {accessibility ? (
                  <>
                    {sourceChanged && (
                      <div className="accessibility-stale" role="status">
                        <strong>
                          Previous result · source or routing profile changed
                        </strong>
                        <p>
                          The server now offers different source data,
                          geographic coverage, or routing settings. This frozen
                          capture has not been recalculated. Choose Run to
                          request the current profile.
                        </p>
                      </div>
                    )}
                    {!sameQuery && (
                      <div className="accessibility-stale" role="status">
                        <strong>Previous result · query changed</strong>
                        <p>
                          The tables and contours still describe{" "}
                          {accessibilityMode(
                            accessibility.capture.request.mode,
                          ).toLowerCase()}{" "}
                          from {accessibility.capture.request.site[1]},{" "}
                          {accessibility.capture.request.site[0]}. They have not
                          been recalculated for your current settings.
                        </p>
                        <button
                          type="button"
                          className="button secondary-button"
                          onClick={() => {
                            chooseSite(
                              accessibility.capture.request.site,
                              "Captured origin",
                            );
                            setMode(accessibility.capture.request.mode);
                          }}
                        >
                          Use captured query
                        </button>
                      </div>
                    )}
                    {!result &&
                      savedForMode &&
                      retainedAccessibilityJobId(
                        savedForMode,
                        jobs,
                        scenario.id,
                      ) && (
                        <button
                          type="button"
                          className="button"
                          onClick={() =>
                            setSelectedId(
                              retainedAccessibilityJobId(
                                savedForMode,
                                jobs,
                                scenario.id,
                              ),
                            )
                          }
                        >
                          Load saved regional map
                        </button>
                      )}
                    {!contour && (
                      <p className="accessibility-note">
                        Regional map unavailable for this saved capture. The
                        frozen tables remain available; no contour has been
                        reconstructed from the counts.
                      </p>
                    )}
                    <p className="accessibility-note">
                      The captured site is{" "}
                      {accessibility.capture.siteSnapMeters.toFixed(1)} m from
                      the routing connection. The provider did not return its
                      exact coordinate, so the map marks the chosen site only.
                    </p>
                    <AccessibilityResults
                      accessibility={accessibility}
                      minutes={minutes}
                      onMinutesChange={setMinutes}
                    />
                    {changedSavedVersion && (
                      <p className="accessibility-note">
                        This job started from an earlier saved revision. Its
                        query and source evidence remain frozen; adopting it
                        adds that capture to the current saved scenario.
                      </p>
                    )}
                    <div className="accessibility-adopt">
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
                    <AccessibilityMethod evidence={accessibility} />
                  </>
                ) : (
                  <div className="accessibility-empty">
                    <CircleHelp size={25} />
                    <h3>A little farther. More possibilities.</h3>
                    <p>
                      Choose a location and request a real routing run. When it
                      finishes, this space will show jobs reachable in 15, 30
                      and 45 minutes, source coverage, and unresolved evidence.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <footer className="accessibility-dialog-footer">
              <p>
                Free to explore. Source-backed evidence for early decisions.
              </p>
              <div>
                {savedForMode && canEdit && props.onRemove && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => props.onRemove?.(mode)}
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
