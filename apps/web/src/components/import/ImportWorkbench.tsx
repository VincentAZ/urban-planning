import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  RefreshCw,
  Square,
  Upload,
} from "lucide-react";
import type { Place, Project, Scenario } from "@urban/core";
import type { GisInspection, GisRecipe } from "../../../../api/src/gis-types";
import type {
  ImportLayer,
  ImportMappingRecipe,
  ImportSourceDeclaration,
} from "../../../../api/src/gis-jobs-types";
import { ApiError } from "../../lib/api";
import {
  importApi,
  assertImportCommitReceipt,
  ImportAttempts,
  type GisCapabilities,
  type GisJob,
  type GisPreview,
  type GisPreviewRequest,
  type ImportCommitResponse,
} from "../../lib/import-api";
import {
  initialSpatialDraft,
  sourceLayer,
  spatialRecipe,
  spatialDraftFromRecipe,
  type SpatialDraft,
} from "./spatial-draft";
import {
  initialMapping,
  mappingRecipe,
  mappingDraftFromRecipe,
  type MappingDraft,
} from "./mapping-draft";
import { ImportSpatialStep } from "./ImportSpatialStep";
import { ImportMappingStep } from "./ImportMappingStep";
import { ImportSourceStep } from "./ImportSourceStep";
import { ImportPreview } from "./ImportPreview";

export interface ImportSavedProject {
  projectId: string;
  version: number;
  scenarioRevision?: number;
  baselineHash?: string;
}
export interface ImportWorkbenchProps {
  place: Place;
  project: Project;
  scenario: Scenario;
  canImport?: boolean;
  accountScope?: string;
  onRequireAccount?: () => void;
  onAccessError?: () => void;
  onSave: () => Promise<ImportSavedProject | null>;
  onCommitted: (
    project: Project,
    version: number,
    receipt: Pick<ImportCommitResponse, "organizationId" | "access">,
  ) => Promise<void>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}
const steps = [
  "File",
  "Layer & location",
  "Attributes",
  "Source & rights",
  "Preview",
];
const active = (job: GisJob | null) =>
  job?.status === "queued" || job?.status === "running";
const stageNames: Record<GisJob["stage"], string> = {
  queued: "Waiting for the import worker",
  validating: "Checking file and project scope",
  inspecting: "Inspecting layers and fields",
  converting: "Converting complete geometry",
  mapping: "Validating attributes and matches",
  exporting: "Preparing export",
  saving: "Retaining the immutable preview",
  complete: "Ready for review",
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The import could not be completed.";
const sourceDefault = (): ImportSourceDeclaration => ({
  name: "Local building footprints",
  url: "",
  vintage: "",
  license: "",
  privateUseConfirmed: false,
  publicRedistribution: false,
});

export function ImportWorkbench(props: ImportWorkbenchProps) {
  const {
    place,
    project,
    scenario,
    canImport = true,
    accountScope = "",
    onDirtyChange,
  } = props;
  const scope = `${accountScope}:${place.id}:${scenario.id}`;
  const [dataScope, setDataScope] = useState(scope),
    [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null),
    [fileIdentity, setFileIdentity] = useState("");
  const [layer, setLayer] = useState<ImportLayer>("buildings");
  const [saved, setSaved] = useState<ImportSavedProject | null>(null),
    [capabilities, setCapabilities] = useState<GisCapabilities | null>(null);
  const [job, setJob] = useState<GisJob | null>(null),
    [jobs, setJobs] = useState<GisJob[]>([]),
    [uploadId, setUploadId] = useState("");
  const [inspection, setInspection] = useState<GisInspection | null>(null),
    [spatial, setSpatial] = useState<SpatialDraft | null>(null),
    [mapping, setMapping] = useState<MappingDraft | null>(null);
  const [source, setSource] = useState(sourceDefault),
    [preview, setPreview] = useState<GisPreview | null>(null),
    [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [pollWarning, setPollWarning] = useState(""),
    [pollKey, setPollKey] = useState(0),
    [denied, setDenied] = useState(false);
  const generation = useRef(0),
    mounted = useRef(true),
    controller = useRef<AbortController | null>(null),
    live = useRef({ ...props, scope });
  live.current = { ...props, scope };
  const uploadAttempts = useRef(
      new ImportAttempts<{
        scenarioId: string;
        expectedVersion: number;
        expectedRevision: number;
        idempotencyKey: string;
      }>(),
    ),
    prepareAttempts = useRef(new ImportAttempts<GisPreviewRequest>());
  const retryAttempts = useRef(
    new Map<string, { version: number; key: string }>(),
  );
  const currentJobId = useRef(job?.id);
  currentJobId.current = job?.id;
  const dirty = !!file || !!inspection || !!preview || active(job);
  const pending = !!busy || active(job),
    editable = canImport && !denied && scenario.id !== "baseline";
  const selectedLayer =
    inspection && spatial ? sourceLayer(inspection, spatial) : undefined;
  const sources = useMemo(
    () => [
      ...new Map(
        [...place.sources, ...(scenario.sources ?? [])].map((entry) => [
          entry.id,
          entry,
        ]),
      ).values(),
    ],
    [place, scenario.sources],
  );
  const previewStale =
    !!preview &&
    (preview.scenarioId !== scenario.id ||
      preview.expectedRevision !== scenario.revision ||
      (saved && preview.expectedVersion !== saved.version));
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (dataScope === scope) return;
    generation.current++;
    controller.current?.abort();
    uploadAttempts.current.clear();
    prepareAttempts.current.clear();
    retryAttempts.current.clear();
    setDataScope(scope);
    setFile(null);
    setInspection(null);
    setSpatial(null);
    setMapping(null);
    setPreview(null);
    setJob(null);
    setJobs([]);
    setSaved(null);
    setCapabilities(null);
    setUploadId("");
    setSource(sourceDefault());
    setStep(0);
    setBusy("");
    setDenied(false);
    setError(
      "Import inputs were cleared because the account, workspace, or alternative changed.",
    );
  }, [scope, dataScope]);
  useEffect(() => {
    if (canImport) return;
    generation.current++;
    controller.current?.abort();
    setBusy("");
    setFile(null);
    setInspection(null);
    setSpatial(null);
    setMapping(null);
    setPreview(null);
    setJob(null);
    setJobs([]);
    setUploadId("");
    uploadAttempts.current.clear();
    prepareAttempts.current.clear();
    retryAttempts.current.clear();
  }, [canImport]);
  function validScope(captured: string, requestGeneration?: number) {
    return (
      mounted.current &&
      live.current.scope === captured &&
      live.current.canImport !== false &&
      (requestGeneration === undefined ||
        generation.current === requestGeneration)
    );
  }
  function failure(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    setError(message(error));
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      setDenied(true);
      setPreview(null);
      setJobs([]);
      setJob(null);
      setInspection(null);
      live.current.onAccessError?.();
    }
  }
  function invalidate() {
    setPreview(null);
    setAcknowledged(false);
    setError("");
    prepareAttempts.current.clear();
  }
  function setInput(next: File | null) {
    generation.current++;
    controller.current?.abort();
    setFile(next);
    setFileIdentity(crypto.randomUUID());
    setInspection(null);
    setSpatial(null);
    setMapping(null);
    setPreview(null);
    setJob(null);
    setUploadId("");
    setStep(0);
    setError("");
    uploadAttempts.current.clear();
    prepareAttempts.current.clear();
    if (next && next.size > 20 * 1024 ** 2)
      setError(
        "Choose a file no larger than 20 MiB. No data has been uploaded.",
      );
  }
  async function saveAndCapabilities(
    signal: AbortSignal,
  ): Promise<{ saved: ImportSavedProject; capabilities: GisCapabilities }> {
    const snapshot = await props.onSave();
    if (!snapshot)
      throw new Error(
        "Sign in with a free account and save an editable alternative before uploading.",
      );
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const caps = await importApi.capabilities(snapshot.projectId, signal);
    return { saved: snapshot, capabilities: caps };
  }
  async function inspect() {
    if (!editable || !file || pending) return;
    const captured = scope,
      requestGeneration = ++generation.current,
      request = new AbortController();
    controller.current = request;
    setBusy("Saving and inspecting");
    setError("");
    try {
      if (file.size > 20 * 1024 ** 2)
        throw new Error("Choose a file no larger than 20 MiB.");
      const context = await saveAndCapabilities(request.signal);
      if (!validScope(captured, requestGeneration)) return;
      setSaved(context.saved);
      setCapabilities(context.capabilities);
      if (!context.capabilities.enabled || !context.capabilities.configured)
        throw new Error(
          context.capabilities.reason ??
            "The geographic conversion worker is not available.",
        );
      if (file.size > context.capabilities.limits.uploadBytes)
        throw new Error("This file exceeds the current upload limit.");
      const metadata = uploadAttempts.current.for(
        `${captured}:${fileIdentity}`,
        () => ({
          scenarioId: scenario.id,
          expectedVersion: context.saved.version,
          expectedRevision: scenario.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      const response = await importApi.upload(
        context.saved.projectId,
        file,
        metadata,
        request.signal,
      );
      if (!validScope(captured, requestGeneration)) return;
      uploadAttempts.current.clear();
      setJob(response.job);
      setUploadId(response.job.id);
      setPollWarning("");
    } catch (error) {
      if (validScope(captured, requestGeneration)) {
        if (error instanceof ApiError && error.status < 500)
          uploadAttempts.current.clear();
        failure(error);
      }
    } finally {
      if (validScope(captured, requestGeneration)) setBusy("");
    }
  }
  async function recent() {
    if (!editable || pending) return;
    const captured = scope,
      requestGeneration = ++generation.current,
      request = new AbortController();
    controller.current = request;
    setBusy("Loading recent imports");
    setError("");
    try {
      const context = await saveAndCapabilities(request.signal);
      const response = await importApi.jobs(
        context.saved.projectId,
        request.signal,
      );
      if (validScope(captured, requestGeneration)) {
        setSaved(context.saved);
        setCapabilities(context.capabilities);
        setJobs(
          response.jobs.filter(
            (entry) =>
              entry.scenarioId === scenario.id &&
              entry.kind !== "export-shapefile",
          ),
        );
      }
    } catch (error) {
      if (validScope(captured, requestGeneration)) failure(error);
    } finally {
      if (validScope(captured, requestGeneration)) setBusy("");
    }
  }
  async function completed(
    next: GisJob,
    projectId: string,
    signal: AbortSignal,
    captured: string,
  ) {
    if (next.kind === "inspect") {
      const response = await importApi.inspection(projectId, next.id, signal);
      if (
        !validScope(captured) ||
        signal.aborted ||
        currentJobId.current !== next.id
      )
        return;
      if (!response.inspection)
        throw new Error(
          "The completed upload has no retained inspection. Retry or upload the file again.",
        );
      const nextSpatial = initialSpatialDraft(response.inspection);
      setInspection(response.inspection);
      setSpatial(nextSpatial);
      setMapping(initialMapping(layer, response.inspection.layers[0]));
      setUploadId(next.id);
      setStep(1);
    } else if (next.kind === "prepare") {
      const result = await importApi.preview(projectId, next.id, signal);
      const original = await importApi.inspection(
        projectId,
        result.uploadId,
        signal,
      );
      if (
        !validScope(captured) ||
        signal.aborted ||
        currentJobId.current !== next.id
      )
        return;
      if (original.inspection) {
        // This recipe is from the server's validated, immutable prepared result.
        const recipe = result.source.import?.recipe as unknown as
          | { conversion: GisRecipe; mapping: ImportMappingRecipe }
          | undefined;
        if (recipe?.conversion && recipe.mapping) {
          const nextSpatial = spatialDraftFromRecipe(
              original.inspection,
              recipe.conversion,
            ),
            selected = sourceLayer(original.inspection, nextSpatial);
          if (selected) {
            setInspection(original.inspection);
            setSpatial(nextSpatial);
            setMapping(mappingDraftFromRecipe(recipe.mapping, selected));
            setLayer(recipe.mapping.layer);
          }
        }
        setSource({
          name: result.source.name,
          url: result.source.url,
          vintage: result.source.vintage,
          license: result.source.license,
          privateUseConfirmed: result.source.rights?.privateUse === true,
          publicRedistribution:
            result.source.rights?.publicRedistribution === true,
        });
      }
      setPreview(result);
      setUploadId(result.uploadId);
      setAcknowledged(false);
      setStep(4);
    }
  }
  useEffect(() => {
    if (
      !saved ||
      !job ||
      !editable ||
      dataScope !== scope ||
      !["queued", "running", "completed"].includes(job.status)
    )
      return;
    const request = new AbortController(),
      captured = scope,
      id = job.id,
      projectId = saved.projectId;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await importApi.job(projectId, id, request.signal);
        if (
          !validScope(captured) ||
          request.signal.aborted ||
          currentJobId.current !== id
        )
          return;
        setJob(response.job);
        setPollWarning("");
        if (response.job.status === "completed")
          await completed(response.job, projectId, request.signal, captured);
        else if (active(response.job)) timeout = setTimeout(poll, 1500);
      } catch (error) {
        if (request.signal.aborted || !validScope(captured)) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          failure(error);
        else
          setPollWarning(
            `Progress could not be refreshed: ${message(error)}. Your server job may still be running.`,
          );
      }
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timeout);
    };
  }, [job?.id, saved?.projectId, pollKey, editable, scope, dataScope]);
  async function prepare() {
    if (
      !editable ||
      !inspection ||
      !spatial ||
      !mapping ||
      !uploadId ||
      pending
    )
      return;
    const captured = scope,
      requestGeneration = ++generation.current,
      request = new AbortController();
    controller.current = request;
    setError("");
    setBusy("Preparing exact geometry");
    try {
      const selected = sourceLayer(inspection, spatial);
      if (!selected) throw new Error("Choose a source layer.");
      const conversion = spatialRecipe(spatial, inspection),
        mapped = mappingRecipe(mapping, selected);
      if (!source.name.trim() || !source.license.trim())
        throw new Error(
          "Complete the source name and license or permission statement.",
        );
      if (!source.privateUseConfirmed)
        throw new Error(
          "Confirm permission for private storage, analysis, display, authorized exports and retained history.",
        );
      const snapshot = await props.onSave();
      if (!snapshot)
        throw new Error("Save the project before preparing an import.");
      if (!validScope(captured, requestGeneration)) return;
      setSaved(snapshot);
      const body = prepareAttempts.current.for(
        JSON.stringify([captured, uploadId, conversion, mapped, source]),
        () => ({
          scenarioId: scenario.id,
          expectedVersion: snapshot.version,
          expectedRevision: scenario.revision,
          idempotencyKey: crypto.randomUUID(),
          conversion,
          mapping: mapped,
          source,
        }),
      );
      const response = await importApi.prepare(
        snapshot.projectId,
        uploadId,
        body,
        request.signal,
      );
      if (!validScope(captured, requestGeneration)) return;
      prepareAttempts.current.clear();
      setJob(response.job);
      setPollWarning("");
      setPreview(null);
    } catch (error) {
      if (validScope(captured, requestGeneration)) {
        if (error instanceof ApiError && error.status < 500)
          prepareAttempts.current.clear();
        failure(error);
      }
    } finally {
      if (validScope(captured, requestGeneration)) setBusy("");
    }
  }
  async function mutateJob(action: "cancel" | "retry") {
    if (!job || !saved || !editable || busy) return;
    const captured = scope;
    setBusy(
      action === "cancel" ? "Requesting cancellation" : "Retrying import",
    );
    setError("");
    try {
      let attempt = retryAttempts.current.get(job.id);
      if (!attempt) {
        attempt = { version: job.version, key: crypto.randomUUID() };
        retryAttempts.current.set(job.id, attempt);
      }
      const response =
        action === "cancel"
          ? await importApi.cancel(saved.projectId, job)
          : await importApi.retry(
              saved.projectId,
              { ...job, version: attempt.version },
              attempt.key,
            );
      if (validScope(captured)) {
        retryAttempts.current.delete(job.id);
        setJob(response.job);
        setPollWarning("");
        setPollKey((n) => n + 1);
      }
    } catch (error) {
      if (validScope(captured)) {
        if (error instanceof ApiError && error.status < 500)
          retryAttempts.current.delete(job.id);
        failure(error);
      }
    } finally {
      if (validScope(captured)) setBusy("");
    }
  }
  async function apply() {
    if (!preview || !editable || !acknowledged || pending || previewStale)
      return;
    const captured = scope,
      onCommitted = props.onCommitted;
    setBusy("Applying one reversible import");
    setError("");
    try {
      const result = await importApi.commit(preview, acknowledged);
      if (!validScope(captured)) return;
      assertImportCommitReceipt(preview, result);
      await onCommitted(result.project, result.version, result);
      if (mounted.current && live.current.scope === captured) {
        onDirtyChange(false);
        props.onClose();
      }
    } catch (error) {
      if (validScope(captured)) failure(error);
    } finally {
      if (validScope(captured)) setBusy("");
    }
  }
  function advance() {
    try {
      setError("");
      if (step === 1 && inspection && spatial)
        spatialRecipe(spatial, inspection);
      if (step === 2 && mapping && selectedLayer)
        mappingRecipe(mapping, selectedLayer);
      setStep(Math.min(4, step + 1));
    } catch (error) {
      failure(error);
    }
  }
  if (dataScope !== scope)
    return (
      <p role="status">Clearing the previous workspace’s import inputs…</p>
    );
  if (!canImport || denied)
    return (
      <div className="import-empty">
        <Upload size={32} />
        <h3>Local knowledge belongs here.</h3>
        <p>
          A free account and edit access are needed to upload geographic files.
          Saved-project JSON can still be restored from the other tab.
        </p>
        {props.onRequireAccount && (
          <button
            type="button"
            className="button primary"
            onClick={props.onRequireAccount}
          >
            Sign in free to import
          </button>
        )}
      </div>
    );
  return (
    <div className="import-workbench">
      <nav aria-label="Import steps" className="import-steps">
        {steps.map((label, index) => (
          <button
            type="button"
            key={label}
            aria-current={step === index ? "step" : undefined}
            disabled={
              pending ||
              index > step ||
              (index > 0 && !inspection && index !== 4)
            }
            onClick={() => setStep(index)}
          >
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </nav>
      {scenario.id === "baseline" && (
        <p className="notice">
          The captured baseline is immutable. Choose an editable alternative to
          import geographic data.
        </p>
      )}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {job && (
        <section className="import-job" aria-label="Import processing status">
          <div role="status" aria-live="polite">
            <strong>
              {active(job) ? (
                <LoaderCircle size={16} className="spin" />
              ) : job.status === "completed" ? (
                <Check size={16} />
              ) : null}
              {job.status === "completed"
                ? "Prepared for your review"
                : job.status === "failed"
                  ? "Import needs attention"
                  : job.status === "cancelled"
                    ? "Import cancelled"
                    : stageNames[job.stage]}
            </strong>
            <span>
              {job.upload?.filename ?? file?.name ?? "Geographic layer"} ·
              attempt {job.attempt}
            </span>
          </div>
          {job.cancelRequested && (
            <p>
              Cancellation requested. Waiting for the worker to stop safely.
            </p>
          )}
          {job.error && <p role="alert">{job.error.message}</p>}
          {pollWarning && <p role="status">{pollWarning}</p>}
          <div className="import-inline-actions">
            {active(job) && (
              <button
                type="button"
                className="button"
                disabled={!!busy || job.cancelRequested}
                onClick={() => void mutateJob("cancel")}
              >
                <Square size={13} /> Cancel processing
              </button>
            )}
            {job.error?.retryable && (
              <button
                type="button"
                className="button"
                disabled={pending}
                onClick={() => void mutateJob("retry")}
              >
                Retry processing
              </button>
            )}
            {pollWarning && (
              <button
                type="button"
                className="button"
                onClick={() => setPollKey((n) => n + 1)}
              >
                <RefreshCw size={13} /> Refresh progress
              </button>
            )}
          </div>
        </section>
      )}
      {step === 0 && (
        <section className="import-section">
          <h3>Bring your local knowledge.</h3>
          <p>
            Import exact footprints and boundaries. Files stay private, and the
            captured baseline stays intact.
          </p>
          <label className="field">
            <span>Layer type</span>
            <select
              aria-label="Layer type"
              disabled={pending}
              value={layer}
              onChange={(event) => {
                const next = event.target.value as ImportLayer;
                setLayer(next);
                setMapping(
                  inspection
                    ? initialMapping(next, inspection.layers[0])
                    : null,
                );
                setSource({
                  ...source,
                  name:
                    next === "buildings"
                      ? "Local building footprints"
                      : `Local ${next} boundaries`,
                });
                invalidate();
              }}
            >
              <option value="buildings">Building footprints</option>
              <option value="parcels">Parcel boundaries</option>
              <option value="blocks">Block boundaries</option>
            </select>
          </label>
          <label className="upload-zone">
            <Upload size={28} />
            <strong>{file?.name ?? "Choose a geographic file"}</strong>
            <span>GeoJSON · zipped shapefile · DXF · up to 20 MiB</span>
            <input
              aria-label="Geographic file"
              type="file"
              accept=".json,.geojson,.zip,.dxf"
              disabled={pending || !editable}
              onChange={(event) => setInput(event.target.files?.[0] ?? null)}
            />
          </label>
          <p className="import-help">
            Shapefile ZIPs need .shp, .shx and .dbf files; include .prj and .cpg
            when available. DXF closed planar footprints require explicit
            drawing units and spatial reference. Files are not sent until you
            choose Inspect.
          </p>
          {capabilities && (
            <p className="notice">
              {capabilities.reason ??
                `Free queued processing · ${capabilities.limits.features.toLocaleString()} features and ${capabilities.limits.vertices.toLocaleString()} vertices per conversion · ${capabilities.limits.operationsPerAccountPerDay} operations per account per day.`}
            </p>
          )}
          <div className="import-inline-actions">
            <button
              type="button"
              className="button primary"
              disabled={
                !editable || pending || !file || file.size > 20 * 1024 ** 2
              }
              onClick={() => void inspect()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Upload size={16} />
              )}{" "}
              Save and inspect file
            </button>
            <button
              type="button"
              className="button"
              disabled={!editable || pending}
              onClick={() => void recent()}
            >
              Save and find recent imports
            </button>
          </div>
          {!!jobs.length && (
            <div className="import-recent">
              <h4>Recent imports in this alternative</h4>
              <p>
                Resume an existing job after closing this window or losing a
                response. No new conversion is started.
              </p>
              {jobs.map((entry) => (
                <button
                  type="button"
                  className="import-recent-row"
                  key={entry.id}
                  disabled={pending}
                  onClick={() => {
                    setJob(entry);
                    setPreview(null);
                    setPollWarning("");
                    setPollKey((n) => n + 1);
                  }}
                >
                  <strong>
                    {entry.upload?.filename ??
                      (entry.kind === "prepare"
                        ? "Prepared geographic import"
                        : "Geographic upload")}
                  </strong>
                  <span>
                    {entry.status} ·{" "}
                    {new Date(entry.createdAt).toLocaleString()} · revision{" "}
                    {entry.scenarioRevision}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      <fieldset className="import-step-content" disabled={pending || !editable}>
        {step === 1 && inspection && spatial && (
          <ImportSpatialStep
            inspection={inspection}
            value={spatial}
            onChange={(next) => {
              if (next.layerId !== spatial.layerId)
                setMapping(
                  initialMapping(layer, sourceLayer(inspection, next)),
                );
              setSpatial(next);
              invalidate();
            }}
          />
        )}
        {step === 2 && selectedLayer && mapping && (
          <ImportMappingStep
            layer={selectedLayer}
            value={mapping}
            sources={sources}
            onChange={(next) => {
              setMapping(next);
              invalidate();
            }}
          />
        )}
        {step === 3 && (
          <ImportSourceStep
            value={source}
            onChange={(next) => {
              setSource(next);
              invalidate();
            }}
          />
        )}
      </fieldset>
      {step === 4 && preview && (
        <>
          <ImportPreview preview={preview} place={place} scenario={scenario} />
          {previewStale && (
            <p role="alert" className="error-message">
              This preview belongs to an earlier scenario revision. Return to
              the settings and prepare it again before applying.
            </p>
          )}
          <label className="import-check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              disabled={pending || !editable || !!previewStale}
            />
            <span>
              I reviewed the exact geometry, unknown attributes, exclusions,
              source rights and overlap diagnostics. Apply this prepared import
              as one reversible edit.
            </span>
          </label>
        </>
      )}
      <footer className="import-footer">
        <span>
          {busy ||
            (step === 4
              ? "One Apply. One Undo."
              : "Private by default · free to use")}
        </span>
        <div>
          {step > 0 && (
            <button
              type="button"
              className="button"
              disabled={pending || !inspection}
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft size={14} /> Back
            </button>
          )}
          {step > 0 && step < 3 && (
            <button
              type="button"
              className="button primary"
              disabled={pending || !editable}
              onClick={advance}
            >
              Continue <ArrowRight size={14} />
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              className="button primary"
              disabled={pending || !editable}
              onClick={() => void prepare()}
            >
              Prepare exact preview <ArrowRight size={14} />
            </button>
          )}
          {step === 4 && preview && (
            <button
              type="button"
              className="button primary"
              disabled={pending || !editable || !acknowledged || !!previewStale}
              onClick={() => void apply()}
            >
              <Check size={15} /> Apply {preview.featureCount}{" "}
              {preview.layer === "buildings"
                ? preview.featureCount === 1
                  ? "footprint"
                  : "footprints"
                : preview.featureCount === 1
                  ? preview.layer.slice(0, -1)
                  : preview.layer}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
