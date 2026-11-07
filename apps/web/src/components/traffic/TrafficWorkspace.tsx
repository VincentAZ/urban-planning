import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, RefreshCw, Save } from "lucide-react";
import {
  trafficRoadEditsHash,
  trafficPlanningSources,
  canonicalJSON,
  type Place,
  type Scenario,
} from "@urban/core";
import type { CloudProjectLink } from "../../lib/cloud-workspace";
import { ApiError, download } from "../../lib/api";
import {
  trafficApi,
  trafficFile,
  trafficCommuteFile,
  type TrafficAdoptResponse,
  type TrafficCapabilities,
  type TrafficConfigurationRecord,
  type TrafficContext,
  type TrafficFile,
  type TrafficJob,
  type TrafficJobResult,
  type TrafficUpload,
} from "../../lib/traffic-api";
import {
  TrafficAttempts,
  admittedTrafficDraft,
  sameTrafficMutationScope,
  trafficUploadKey,
  type TrafficScope,
} from "../../lib/traffic-session";
import type { TrafficDraftValue } from "../../lib/traffic-draft";
import { inspectTrafficCommuteLedger } from "../../lib/traffic-commute-ledger-client";
import { planningSourcesCurrent } from "../../lib/traffic-planning-draft";
import { Modal } from "../Modal";
import { TrafficDialog } from "./TrafficDialog";
import { PublishedTraffic } from "./TrafficOverview";
import type { TrafficResultPair } from "./TrafficResults";
import "./traffic.css";

export interface TrafficWorkspaceProps {
  place: Place;
  scenario: Scenario;
  accountId: string | null;
  accountScope: string;
  connection: CloudProjectLink | null;
  canEdit: boolean;
  hasUnsavedChanges: boolean;
  onSignIn: () => void;
  onSaveProject: () => Promise<void>;
  onAdopt: (response: TrafficAdoptResponse) => Promise<void>;
  onRemove?: () => void;
  onAccessError?: () => void;
  onClose: () => void;
}
const pending = (job: TrafficJob) =>
  job.status === "queued" || job.status === "running";
const stageNames: Record<TrafficJob["stage"], string> = {
  queued: "Waiting for the traffic worker",
  validating: "Checking retained inputs and capacity",
  simulating: "Running the paired traffic experiment",
  evaluating: "Checking completion and count evidence",
  saving: "Retaining immutable traffic evidence",
  complete: "Captured result ready",
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The traffic service could not complete this request.";
const denied = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
const rejected = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

/** Project-scoped orchestration. No worker, result, permission or progress is fabricated in the browser. */
export default function TrafficWorkspace(props: TrafficWorkspaceProps) {
  const { place, scenario, accountId, connection, canEdit, hasUnsavedChanges } =
    props;
  const scope = canonicalJSON([
    props.accountScope,
    connection?.organizationId,
    connection?.projectId,
    scenario.id,
    place.id,
  ]);
  const [dataScope, setDataScope] = useState(scope),
    [storedContext, setContext] = useState<TrafficContext | null>(null),
    [storedCapabilities, setCapabilities] =
      useState<TrafficCapabilities | null>(null),
    [storedJobs, setJobs] = useState<TrafficJob[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [storedResult, setResult] = useState<TrafficJobResult | null>(null),
    [storedFiles, setFiles] = useState<{
      jobId: string;
      files: TrafficFile[];
    } | null>(null);
  const [busy, setBusy] = useState(""),
    [loading, setLoading] = useState(false),
    [resultLoading, setResultLoading] = useState(false),
    [error, setError] = useState(""),
    [pollWarning, setPollWarning] = useState(""),
    [notice, setNotice] = useState(""),
    [accessDenied, setAccessDenied] = useState(false),
    [refreshIndex, setRefreshIndex] = useState(0),
    [reviewDirty, setReviewDirty] = useState(false);
  const [adoptedRevision, setAdoptedRevision] = useState<number | null>(null);
  const [requestedPreparedId, setRequestedPreparedId] = useState<string>();
  const mounted = useRef(true),
    actionController = useRef<AbortController | null>(null),
    contextController = useRef<AbortController | null>(null),
    contextSequence = useRef(0),
    attempts = useRef(new TrafficAttempts()),
    uploadReceipts = useRef(new Map<string, TrafficUpload>()),
    live = useRef({ ...props, scope });
  live.current = { ...props, scope };
  const current = dataScope === scope;
  const context = current && !accessDenied ? storedContext : null,
    capabilities = current && !accessDenied ? storedCapabilities : null,
    jobs = current && !accessDenied ? storedJobs : [];
  const selected = jobs.find((job) => job.id === selectedId);
  const result =
    current && !accessDenied && storedResult?.job.id === selectedId
      ? storedResult
      : null;
  const files =
    current && !accessDenied && storedFiles?.jobId === selectedId
      ? storedFiles.files
      : [];
  const configuration = context?.configuration ?? null;
  const request =
    configuration?.request ??
    context?.initialRequest ??
    result?.experiment.request ??
    null;
  const mutationScope = (): TrafficScope => ({
    accountScope: props.accountScope,
    projectId: connection?.projectId ?? "",
    scenarioId: scenario.id,
    projectVersion: connection?.version ?? 0,
    scenarioRevision: scenario.revision,
  });
  const mutationStillCurrent = (captured: TrafficScope) =>
    sameTrafficMutationScope(
      captured,
      {
        accountScope: live.current.accountScope,
        projectId: live.current.connection?.projectId ?? "",
        scenarioId: live.current.scenario.id,
        projectVersion: live.current.connection?.version ?? 0,
        scenarioRevision: live.current.scenario.revision,
      },
      live.current.canEdit,
      live.current.hasUnsavedChanges,
    );
  const [roadIdentity, setRoadIdentity] = useState<{
    place: Place;
    scenario: Scenario;
    hash: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void trafficRoadEditsHash(place, scenario).then(
      (hash) => {
        if (!cancelled) setRoadIdentity({ place, scenario, hash });
      },
      () => {
        if (!cancelled) setRoadIdentity(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [place, scenario]);
  const canMutate =
    !!accountId &&
    !!connection &&
    canEdit &&
    !hasUnsavedChanges &&
    !loading &&
    !accessDenied;
  const planningSources = useMemo(() => {
    try {
      return trafficPlanningSources(place, scenario);
    } catch {
      // Conflicting or missing source identities cannot authorize reusing a review.
      return null;
    }
  }, [place, scenario]);
  const configurationNeedsReview =
    !!configuration &&
    ((!!capabilities?.prepared &&
      canonicalJSON(configuration.prepared) !==
        canonicalJSON(capabilities.prepared)) ||
      (roadIdentity?.place === place &&
        roadIdentity.scenario === scenario &&
        roadIdentity.hash !== configuration.roadEditsHash) ||
      (!!configuration.request.planningRoads &&
        !planningSourcesCurrent(
          configuration.request.planningRoads,
          planningSources,
        )));
  const resultCurrent =
    !!result &&
    !!configuration &&
    result.job.configurationId === configuration.id &&
    result.job.requestHash === configuration.requestHash &&
    roadIdentity?.place === place &&
    roadIdentity.scenario === scenario &&
    roadIdentity.hash === result.job.roadEditsHash &&
    (!result.experiment.request.planningRoads ||
      planningSourcesCurrent(
        result.experiment.request.planningRoads,
        planningSources,
      ));
  const saved =
    !!result &&
    scenario.traffic?.captureHash === result.traffic.captureHash &&
    scenario.traffic.origin === result.traffic.origin;
  const pair = useMemo<TrafficResultPair | null>(
    () =>
      result
        ? {
            id: result.job.id,
            scenarioRevision: result.job.scenarioRevision,
            recipe: result.experiment.recipe,
            baseline: result.experiment.baseline,
            proposal: result.experiment.proposal,
            countPack: result.experiment.request.countPack,
            calibration: result.experiment.calibration,
            planningRoads: result.experiment.request.planningRoads,
            signalTimings: result.traffic.capture.proposal.signalTimings,
            commute: result.traffic.capture.originalDemand.commute,
          }
        : null,
    [result],
  );
  const selectionRef = useRef({
    configurationId: configuration?.id,
    selectedId,
    reviewDirty,
  });
  selectionRef.current = {
    configurationId: configuration?.id,
    selectedId,
    reviewDirty,
  };
  function accessFailure(failure: unknown) {
    if (!denied(failure)) return;
    setAccessDenied(true);
    setContext(null);
    setCapabilities(null);
    setJobs([]);
    setResult(null);
    setFiles(null);
    attempts.current.clear();
    uploadReceipts.current.clear();
    live.current.onAccessError?.();
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      actionController.current?.abort();
      contextController.current?.abort();
    };
  }, []);
  useEffect(() => {
    actionController.current?.abort();
    contextController.current?.abort();
    contextSequence.current++;
    attempts.current.clear();
    uploadReceipts.current.clear();
    setContext(null);
    setCapabilities(null);
    setJobs([]);
    setSelectedId("");
    setResult(null);
    setFiles(null);
    setAccessDenied(false);
    setError("");
    setPollWarning("");
    setNotice("");
    setBusy("");
    setReviewDirty(false);
    setAdoptedRevision(null);
    setRequestedPreparedId(undefined);
    setDataScope(scope);
  }, [scope]);
  useEffect(() => {
    if (!accountId || !connection) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    contextController.current?.abort();
    contextController.current = controller;
    const sequence = ++contextSequence.current,
      captured = scope;
    const valid = () =>
      !controller.signal.aborted &&
      mounted.current &&
      live.current.scope === captured &&
      contextSequence.current === sequence;
    setLoading(true);
    setError("");
    void trafficApi
      .context(
        connection.projectId,
        scenario.id,
        controller.signal,
        requestedPreparedId,
      )
      .then(
        (next) => {
          if (!valid()) return;
          setContext(next);
          setCapabilities(next.capabilities);
          setAccessDenied(false);
        },
        (failure) => {
          if (valid()) {
            setError(message(failure));
            accessFailure(failure);
          }
        },
      )
      .finally(() => {
        if (valid()) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, refreshIndex, requestedPreparedId]);
  useEffect(() => {
    if (!accountId || !connection) return;
    const controller = new AbortController(),
      captured = scope;
    let timer: ReturnType<typeof setTimeout> | undefined,
      inFlight = false,
      blocked = false,
      failures = 0;
    const valid = () =>
      !controller.signal.aborted &&
      !blocked &&
      mounted.current &&
      live.current.scope === captured;
    const refresh = async () => {
      if (!valid() || inFlight) return;
      if (timer) clearTimeout(timer);
      inFlight = true;
      let nextDelay = 15000;
      try {
        // Poll compact job records only. Context/explicit refresh checks source and
        // runtime capability; repeated graph/baseline reads do not measure progress.
        const next = await trafficApi.jobs(
          connection.projectId,
          controller.signal,
        );
        if (!valid()) return;
        const relevant = next.jobs.filter(
          (job) =>
            job.projectId === connection.projectId &&
            job.scenarioId === scenario.id,
        );
        setJobs(relevant);
        setPollWarning("");
        failures = 0;
        nextDelay = relevant.some(pending) ? 3000 : 15000;
        setSelectedId(
          (previous) =>
            previous ||
            relevant.find(
              (job) => job.id === live.current.scenario.traffic?.receipt.jobId,
            )?.id ||
            relevant[0]?.id ||
            "",
        );
      } catch (failure) {
        if (!valid()) return;
        setPollWarning(message(failure));
        accessFailure(failure);
        if (denied(failure)) blocked = true;
        failures++;
        nextDelay = Math.min(30000, 2000 * 2 ** failures);
      } finally {
        inFlight = false;
        if (valid())
          timer = setTimeout(() => {
            if (document.visibilityState === "visible") void refresh();
            else timer = setTimeout(() => void refresh(), 5000);
          }, nextDelay);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [scope, refreshIndex]);
  useEffect(() => {
    if (
      !connection ||
      !accountId ||
      selected?.status !== "completed" ||
      accessDenied
    ) {
      setResultLoading(false);
      return;
    }
    const controller = new AbortController(),
      captured = scope,
      jobId = selected.id;
    setResultLoading(true);
    setFiles(null);
    const valid = () =>
      !controller.signal.aborted &&
      mounted.current &&
      live.current.scope === captured;
    void trafficApi
      .result(connection.projectId, jobId, controller.signal)
      .then(
        (next) => {
          if (!valid()) return;
          if (
            next.job.id !== jobId ||
            next.job.projectId !== connection.projectId ||
            next.job.scenarioId !== scenario.id
          )
            throw new Error(
              "The returned traffic evidence belongs to a different saved run.",
            );
          setResult(next);
          setError("");
        },
        (failure) => {
          if (valid()) {
            setError(message(failure));
            accessFailure(failure);
          }
        },
      )
      .catch((failure) => {
        if (valid()) setError(message(failure));
      })
      .finally(() => {
        if (valid()) setResultLoading(false);
      });
    return () => controller.abort();
  }, [
    scope,
    selected?.id,
    selected?.status,
    selected?.result?.captureHash,
    accessDenied,
    refreshIndex,
  ]);

  async function perform<T>(
    label: string,
    work: (signal: AbortSignal, valid: () => boolean) => Promise<T>,
  ): Promise<T> {
    if (actionController.current && !actionController.current.signal.aborted)
      throw new Error("Wait for the current traffic action to finish.");
    const controller = new AbortController(),
      captured = scope;
    actionController.current = controller;
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      live.current.scope === captured;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      return await work(controller.signal, valid);
    } catch (failure) {
      if (valid()) {
        setError(message(failure));
        accessFailure(failure);
      }
      throw failure;
    } finally {
      if (actionController.current === controller)
        actionController.current = null;
      if (valid()) setBusy("");
    }
  }
  function upsert(job: TrafficJob) {
    setJobs((previous) => [
      job,
      ...previous.filter((item) => item.id !== job.id),
    ]);
    setSelectedId(job.id);
  }
  async function saveConfiguration(
    draft: TrafficDraftValue,
  ): Promise<TrafficConfigurationRecord> {
    if (!canMutate || !connection || !context || !draft.scopeAcknowledged)
      throw new Error(
        "Save the project and acknowledge the explicit traffic experiment before saving its configuration.",
      );
    const captured = mutationScope(),
      priorConfiguration = configuration;
    return perform("save", async (signal, valid) => {
      const uploads = new Map<string, TrafficUpload>();
      for (const staged of draft.stagedFiles) {
        if (staged.bytes > (capabilities?.limits.uploadBytes ?? 5 * 1024 ** 2))
          throw new Error("The staged CSV exceeds the service upload limit.");
        const key = await trafficUploadKey(staged.file, staged.sha256);
        let upload = uploadReceipts.current.get(key);
        if (!upload) {
          const response = await trafficApi.upload(
            connection.projectId,
            staged.file,
            key,
            signal,
          );
          if (!valid())
            throw new Error(
              "The workspace changed while the CSV was retained. Reopen this project to continue.",
            );
          upload = response.upload;
          uploadReceipts.current.set(key, upload);
        }
        if (upload.sha256 !== staged.sha256 || upload.bytes !== staged.bytes)
          throw new Error("Uploaded CSV bytes do not match the reviewed file.");
        uploads.set(staged.sourceId, upload);
      }
      const admitted = admittedTrafficDraft(draft, uploads);
      const uploadBindings = [
        ...(priorConfiguration?.uploadBindings ?? []),
        ...admitted.uploadBindings,
      ].filter(
        (binding, index, all) =>
          all.findIndex(
            (other) =>
              other.uploadId === binding.uploadId &&
              other.batchId === binding.batchId,
          ) === index,
      );
      const logicalKey = canonicalJSON([
        "save",
        scope,
        context.capabilities.prepared,
        admitted.request,
        admitted.sourceDeclarations,
        admitted.mappingReviews,
        admitted.planningRoadReviews,
        admitted.planningSourceDeclarations,
        uploadBindings,
      ]);
      const body = attempts.current.for(logicalKey, {
        ...admitted,
        preparedId: context.capabilities.prepared?.id,
        uploadBindings,
        scenarioId: scenario.id,
        expectedVersion: connection.version,
        expectedRevision: scenario.revision,
        expectedConfigurationId:
          context.latestConfigurationId ?? priorConfiguration?.id ?? null,
        scopeAcknowledged: true as const,
      });
      try {
        const response = await trafficApi.save(
          connection.projectId,
          body,
          signal,
        );
        if (!valid() || !mutationStillCurrent(captured))
          throw new Error(
            "The traffic configuration was retained, but your project changed. Reload saved traffic inputs to review it; local changes were preserved.",
          );
        const next = response.configuration;
        if (
          next.projectId !== connection.projectId ||
          next.scenarioId !== scenario.id ||
          next.projectVersion !== body.expectedVersion ||
          next.scenarioRevision !== body.expectedRevision ||
          canonicalJSON(next.prepared) !==
            canonicalJSON(context.capabilities.prepared)
        )
          throw new Error(
            "The saved configuration response has a different project or revision. Reload its recorded inputs before continuing.",
          );
        attempts.current.complete(logicalKey);
        contextSequence.current++;
        contextController.current?.abort();
        setLoading(false);
        setContext((previous) =>
          previous
            ? {
                ...previous,
                configuration: next,
                latestConfigurationId: next.id,
              }
            : previous,
        );
        setNotice(
          "Configuration retained. Run explicitly when you are ready; the planning scenario has not changed.",
        );
        return next;
      } catch (failure) {
        if (rejected(failure)) attempts.current.complete(logicalKey);
        throw failure;
      }
    });
  }
  async function run() {
    if (
      !canMutate ||
      !connection ||
      !configuration ||
      !capabilities?.enabled ||
      !capabilities.configured
    )
      throw new Error(
        capabilities?.reason ??
          "Save an authorized traffic configuration before requesting a run.",
      );
    if (!configuration.request.demand.rows.some((row) => row.vehicles > 0))
      throw new Error(
        "Enter and save nonzero explicit one-way vehicle demand and reviewed routes before running.",
      );
    const key = canonicalJSON(["run", scope, configuration.id]);
    return perform("run", async (signal, valid) => {
      const body = attempts.current.for(key, {
        configurationId: configuration.id,
        expectedVersion: connection.version,
        expectedRevision: scenario.revision,
      });
      try {
        const response = await trafficApi.start(
          connection.projectId,
          body,
          signal,
        );
        if (!valid()) return;
        attempts.current.complete(key);
        upsert(response.job);
        setNotice(
          "Request retained. You can close this workbench while the worker processes the captured inputs.",
        );
      } catch (failure) {
        if (rejected(failure)) attempts.current.complete(key);
        throw failure;
      }
    });
  }
  async function cancel() {
    if (!canMutate || !connection || !selected) return;
    await perform("cancel", async (signal, valid) => {
      const response = await trafficApi.cancel(
        connection.projectId,
        selected,
        signal,
      );
      if (valid()) {
        upsert(response.job);
        setNotice(
          "Cancellation requested. Retained earlier evidence is unchanged.",
        );
      }
    });
  }
  async function retry() {
    if (!canMutate || !connection || !selected) return;
    const key = canonicalJSON(["retry", scope, selected.id]);
    await perform("retry", async (signal, valid) => {
      const body = attempts.current.for(key, {
        expectedJobVersion: selected.version,
      });
      try {
        const response = await trafficApi.retry(
          connection.projectId,
          selected.id,
          body,
          signal,
        );
        if (valid()) {
          attempts.current.complete(key);
          upsert(response.job);
        }
      } catch (failure) {
        if (rejected(failure)) attempts.current.complete(key);
        throw failure;
      }
    });
  }
  async function adopt() {
    if (
      !canMutate ||
      !connection ||
      !result ||
      !resultCurrent ||
      reviewDirty ||
      saved
    )
      return;
    const captured = mutationScope(),
      accept = props.onAdopt,
      configurationId = configuration?.id,
      captureHash = result.traffic.captureHash;
    await perform("adopt", async (signal, valid) => {
      const response = await trafficApi.adopt(
        connection.projectId,
        result.job.id,
        {
          scenarioId: scenario.id,
          expectedVersion: connection.version,
          expectedRevision: scenario.revision,
        },
        signal,
      );
      if (!valid() || !mutationStillCurrent(captured))
        throw new Error(
          "The capture was retained on the server, but the current project or access changed. Reopen the saved project; local edits were preserved.",
        );
      const capturedScenario = response.project.scenarios.find(
        (value) => value.id === scenario.id,
      );
      if (
        response.version !== connection.version + 1 ||
        capturedScenario?.revision !== scenario.revision + 1 ||
        capturedScenario.traffic?.captureHash !== captureHash ||
        result.job.configurationId !== configurationId ||
        selectionRef.current.configurationId !== configurationId ||
        selectionRef.current.selectedId !== result.job.id ||
        selectionRef.current.reviewDirty
      )
        throw new Error(
          "The adoption response differs from the reviewed capture or expected revision. Reopen the saved project to inspect it.",
        );
      await accept(response);
      if (valid()) setAdoptedRevision(capturedScenario.revision);
      if (valid())
        setNotice(
          "Traffic evidence saved to this scenario. Its archived inputs remain immutable.",
        );
    });
  }
  async function listFiles() {
    if (!connection || !selected || selected.status !== "completed") return;
    await perform("files", async (signal, valid) => {
      const response = await trafficApi.files(
        connection.projectId,
        selected.id,
        signal,
      );
      if (valid()) setFiles({ jobId: selected.id, files: response.files });
    });
  }
  async function downloadFile(file: TrafficFile) {
    if (!connection || !selected) return;
    await perform("download", async (signal, valid) => {
      const blob = await trafficFile(
        connection.projectId,
        selected.id,
        file,
        signal,
      );
      if (valid()) download(`traffic-${selected.id}-${file.name}`, blob);
    });
  }
  function invoke(action: () => Promise<unknown>) {
    void action().catch(() => {});
  }
  const controls = (
    <div className="traffic-operational-controls">
      {(context?.preparedChoices?.length ?? 0) > 1 && (
        <label className="traffic-job-selector">
          Prepared traffic network
          <select
            value={context?.capabilities.prepared?.id ?? ""}
            disabled={!!busy || loading || reviewDirty}
            onChange={(event) => setRequestedPreparedId(event.target.value)}
          >
            {context!.preparedChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <small>
            {reviewDirty
              ? "Save or reload the current traffic draft before switching networks."
              : "Select a retained network explicitly. Earlier configurations and runs keep their original network."}
          </small>
        </label>
      )}
      <div className="traffic-actions">
        <button
          type="button"
          className="button"
          disabled={!!busy || loading}
          onClick={() => setRefreshIndex((value) => value + 1)}
        >
          <RefreshCw size={14} />
          Refresh traffic records
        </button>
        {hasUnsavedChanges && canEdit && (
          <button
            type="button"
            className="button"
            disabled={!!busy}
            onClick={() =>
              invoke(() =>
                perform("project", async () => props.onSaveProject()),
              )
            }
          >
            <Save size={14} />
            Save project changes
          </button>
        )}
      </div>
      {configuration && (
        <p className="traffic-muted">
          Retained configuration {configuration.id.slice(0, 8)} · saved{" "}
          {new Date(configuration.createdAt).toLocaleString()} · captured
          scenario r{configuration.scenarioRevision}. Configuration saves do not
          change the planning scenario.
        </p>
      )}
      {capabilities?.prepared && (
        <details className="traffic-source-details">
          <summary>Prepared network coverage and limits</summary>
          <p>
            Study {capabilities.prepared.placeId} · recorded external buffer{" "}
            {capabilities.prepared.bufferMeters.toLocaleString()} m. This
            identity does not change your planning baseline.
          </p>
          <p>
            Closures, directional lane counts and speed controls are supported.
            {capabilities.supported.signalTiming
              ? "Existing eligible static signal timing is also supported. "
              : "Signal timing is unavailable. "}
            Geometry, turn restrictions and pedestrian simulation are
            unavailable in this worker.
          </p>
          <p>
            One native worker · up to {capabilities.limits.attempts} attempts
            per job · {capabilities.limits.runSeconds} seconds per bounded run.
          </p>
          <ul>
            {capabilities.cost.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      {jobs.length > 0 && (
        <label className="traffic-job-selector">
          Retained traffic runs
          <select
            value={selectedId}
            disabled={!!busy}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setError("");
              setNotice("");
              setFiles(null);
            }}
          >
            <option value="">Choose a retained run</option>
            {jobs.map((job) => (
              <option value={job.id} key={job.id}>
                {new Date(job.createdAt).toLocaleString()} · {job.status} ·
                scenario r{job.scenarioRevision} · {job.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {loading && (
        <p role="status">
          {requestedPreparedId &&
          requestedPreparedId !== context?.capabilities.prepared?.id
            ? "Verifying the selected preparation and its retained source evidence…"
            : "Loading retained traffic inputs…"}
        </p>
      )}
      {resultLoading && (
        <p role="status">Loading the selected captured result…</p>
      )}
      {pollWarning && (
        <p className="traffic-warning" role="status">
          Traffic status could not be refreshed: {pollWarning}
        </p>
      )}
      {error && (
        <p className="traffic-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="traffic-muted">
          {selected?.status === "completed" &&
          notice.startsWith("Request retained")
            ? "Captured result ready. Review it before saving it to the scenario."
            : notice}
        </p>
      )}
    </div>
  );
  const resultActions = (
    <section className="traffic-card">
      <h4>
        {saved
          ? "Saved with this scenario"
          : "Keep this evidence with the proposal"}
      </h4>
      <p className="traffic-muted">
        Only explicit adoption adds the frozen summary to scenario history,
        exports and public snapshots. Raw native files remain in the private
        project archive.
      </p>
      {result && !saved && (
        <button
          type="button"
          className="button primary"
          disabled={
            !canMutate ||
            !resultCurrent ||
            reviewDirty ||
            !!busy ||
            resultLoading
          }
          onClick={() => invoke(adopt)}
        >
          <Check size={14} />
          Save traffic capture to scenario
        </button>
      )}
      {result && !resultCurrent && (
        <p className="traffic-warning">
          This result describes a different saved configuration or project
          revision. Reopen or run the reviewed current inputs before adopting
          it.
        </p>
      )}
      {selected?.status === "completed" && (
        <div className="traffic-actions">
          <button
            type="button"
            className="button"
            disabled={!!busy}
            onClick={() => invoke(listFiles)}
          >
            <Download size={14} />
            List retained evidence files
          </button>
        </div>
      )}
      {files.length > 0 && (
        <ul className="traffic-file-list">
          {files.map((file) => (
            <li key={file.name}>
              <span>
                {file.name} ·{" "}
                {(file.bytes / 1024).toLocaleString(undefined, {
                  maximumFractionDigits: 1,
                })}{" "}
                KiB
              </span>
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => invoke(() => downloadFile(file))}
              >
                Download {file.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {scenario.traffic && canEdit && props.onRemove && (
        <button
          type="button"
          className="button"
          disabled={!!busy || reviewDirty}
          onClick={props.onRemove}
        >
          Remove saved traffic capture
        </button>
      )}
    </section>
  );
  if (accessDenied && current)
    return (
      <Modal title="Traffic access changed" open onClose={props.onClose}>
        <p role="alert">
          Private traffic records are hidden until project access is verified
          again.
        </p>
        <button
          type="button"
          className="button"
          onClick={() => {
            props.onAccessError?.();
            setRefreshIndex((value) => value + 1);
          }}
        >
          Refresh project access
        </button>
      </Modal>
    );
  if (!accountId || !connection || !current || !request)
    return (
      <Modal
        title="Traffic analysis"
        description="Actual source-backed traffic processing, with a free account and an explicitly saved project."
        wide
        open
        onClose={props.onClose}
      >
        <div className="traffic-workbench">
          {!accountId ? (
            <>
              <p>
                Explore saved evidence below. A free account is needed to upload
                counts, retain configurations and request bounded traffic runs.
              </p>
              <button
                type="button"
                className="button primary"
                onClick={props.onSignIn}
              >
                Sign in with a free account
              </button>
            </>
          ) : !connection ? (
            <>
              <p>
                Save this project to your private workspace before retaining
                traffic evidence. The planning study area will remain unchanged.
              </p>
              <button
                type="button"
                className="button primary"
                disabled={!canEdit || !!busy}
                onClick={() =>
                  invoke(() =>
                    perform("project", async () => props.onSaveProject()),
                  )
                }
              >
                Save project for traffic analysis
              </button>
            </>
          ) : (
            <>
              <p className="traffic-warning">
                {capabilities?.reason ??
                  (loading
                    ? "Checking the prepared traffic network for this exact study area…"
                    : "No prepared traffic network is available for this exact study area.")}
              </p>
              {controls}
            </>
          )}
          {scenario.traffic && (
            <PublishedTraffic place={place} scenario={scenario} />
          )}
        </div>
      </Modal>
    );
  return (
    <TrafficDialog
      place={place}
      scenario={scenario}
      accountScope={`${props.accountScope}:${connection.projectId}`}
      canEdit={canEdit}
      network={context?.network ?? null}
      countPack={request.countPack}
      demand={request.demand}
      commute={request.commute}
      commutePresets={context?.commutePresets}
      onDownloadCommute={async (presetId) => {
        const prepared = context?.capabilities.prepared;
        const preset = context?.commutePresets?.find(
          (item) => item.id === presetId,
        );
        if (!connection || !prepared || !preset)
          throw new Error(
            "Reload the retained Census commute preparation before downloading its evidence.",
          );
        await perform("commute-evidence", async (signal, valid) => {
          const file = await trafficCommuteFile(
            connection.projectId,
            prepared.id,
            preset.id,
            preset.evidenceFile,
            signal,
          );
          if (!valid())
            throw new Error(
              "The workspace changed before the evidence download completed.",
            );
          download(
            `commute-evidence-${preset.summary.binding.compilationHash.slice(0, 12)}.json`,
            file,
          );
        });
      }}
      onInspectCommute={async (presetId) => {
        const prepared = context?.capabilities.prepared;
        const preset = context?.commutePresets?.find(
          (item) => item.id === presetId,
        );
        if (!connection || !prepared || !preset)
          throw new Error(
            "Reload this commute preparation before inspecting its ledger.",
          );
        return perform("commute-ledger", async (signal, valid) => {
          const blob = await trafficCommuteFile(
            connection.projectId,
            prepared.id,
            preset.id,
            preset.evidenceFile,
            signal,
          );
          if (!valid())
            throw new Error(
              "The workspace changed before ledger inspection completed.",
            );
          const view = await inspectTrafficCommuteLedger(
            blob,
            preset.summary,
            preset.evidenceFile,
            signal,
          );
          if (!valid())
            throw new Error(
              "The workspace changed before ledger inspection completed.",
            );
          return view;
        });
      }}
      period={request.period}
      seed={request.seed}
      calibrationPlan={request.calibrationPlan}
      overlays={request.overlays}
      planningRoads={request.planningRoads}
      signalTimings={request.signalTimings}
      signalEligibility={context?.signalTimingEligibility}
      configuration={configuration}
      result={pair}
      resultCurrent={resultCurrent}
      resultStaleReason="This captured run belongs to earlier saved inputs. Its original configuration and results are retained unchanged."
      job={
        selected
          ? {
              id: selected.id,
              status: selected.status,
              stage: stageNames[selected.stage],
              progress: selected.progress,
              canCancel: pending(selected) && !selected.cancelRequested,
              canRetry:
                (selected.status === "failed" && !!selected.error?.retryable) ||
                selected.status === "cancelled",
              error: selected.error?.message,
            }
          : null
      }
      onApply={canMutate && context?.network ? saveConfiguration : undefined}
      onRun={
        canMutate &&
        configuration &&
        capabilities?.enabled &&
        capabilities.configured &&
        !configurationNeedsReview
          ? run
          : undefined
      }
      onCancel={canMutate ? cancel : undefined}
      onRetry={canMutate ? retry : undefined}
      onDirtyChange={setReviewDirty}
      externalBusy={!!busy || loading}
      controls={controls}
      resultActions={resultActions}
      acknowledgedScenarioRevision={adoptedRevision}
      configurationNeedsReview={configurationNeedsReview}
      mutationBlockedReason={
        hasUnsavedChanges
          ? "Save the current planning project before retaining or running traffic inputs."
          : undefined
      }
      capabilityReason={capabilities?.reason ?? undefined}
      onClose={props.onClose}
    />
  );
}
