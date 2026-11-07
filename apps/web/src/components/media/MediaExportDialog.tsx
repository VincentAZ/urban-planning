import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  defaultMediaExportRecipe,
  mediaFrameCount,
  validateMediaExport,
  type MediaExportRecipe,
  type PresentationCamera,
} from "@urban/core";
import { Modal } from "../Modal";
import { ApiError, download } from "../../lib/api";
import {
  mediaApi,
  downloadMediaFile,
  type MediaContext,
  type MediaJob,
  type MediaStartBody,
} from "../../lib/media-api";
import { mergeMediaHistory } from "../../lib/media-history";
import "./media.css";
const Preview = lazy(() =>
  import("./MediaPreview").then((module) => ({ default: module.MediaPreview })),
);
const active = (job: MediaJob | null) =>
  job?.status === "queued" || job?.status === "running";
export interface MediaExportDialogProps {
  projectId: string;
  scenarioId: string;
  revision: number;
  accountScope: string;
  canProcess: boolean;
  initialFormat: "png" | "mp4";
  initialCamera?: PresentationCamera;
  onSave: () => Promise<{ projectId: string; version: number } | null>;
  onClose: () => void;
  onRequireAccount?: () => void;
  onAccessError?: () => void;
}
export function MediaExportDialog(props: MediaExportDialogProps) {
  const scope = `${props.accountScope}:${props.scenarioId}`;
  const [dataScope, setDataScope] = useState(scope),
    [context, setContext] = useState<MediaContext | null>(null),
    [saved, setSaved] = useState<{ projectId: string; version: number } | null>(
      null,
    );
  const [format, setFormat] = useState(props.initialFormat),
    [recipe, setRecipe] = useState<MediaExportRecipe | null>(null),
    [jobs, setJobs] = useState<MediaJob[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [job, setJob] = useState<MediaJob | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false),
    [previewFrame, setPreviewFrame] = useState(0),
    [pollKey, setPollKey] = useState(0),
    [denied, setDenied] = useState(false);
  const mounted = useRef(true),
    request = useRef<AbortController | null>(null),
    savingScene = useRef(false),
    previousProject = useRef(props.projectId),
    live = useRef({
      scope,
      canProcess: props.canProcess,
      revision: props.revision,
      projectId: props.projectId,
    });
  live.current = {
    scope,
    canProcess: props.canProcess,
    revision: props.revision,
    projectId: props.projectId,
  };
  const attempt = useRef<{ fingerprint: string; body: MediaStartBody } | null>(
      null,
    ),
    retryAttempt = useRef<{
      jobId: string;
      version: number;
      key: string;
    } | null>(null);
  const valid = (captured: string) =>
    mounted.current &&
    live.current.scope === captured &&
    live.current.canProcess &&
    live.current.projectId === previousProject.current;
  const allowed = props.canProcess && !denied;
  const stale = !!context && context.scenarioRevision !== props.revision;
  let recipeError = "",
    frameCount = 0;
  if (context && recipe)
    try {
      validateMediaExport(context.scene, recipe);
      frameCount = mediaFrameCount(recipe);
    } catch (error) {
      recipeError =
        error instanceof Error ? error.message : "Invalid export settings.";
    }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (previousProject.current === props.projectId || savingScene.current)
      return;
    previousProject.current = props.projectId;
    request.current?.abort();
    setContext(null);
    setSaved(null);
    setJobs([]);
    setNextCursor(null);
    setJob(null);
    setRecipe(null);
    setPreview(false);
    setBusy("");
    attempt.current = null;
  }, [props.projectId, busy]);
  useEffect(() => {
    if (dataScope === scope && props.canProcess) return;
    request.current?.abort();
    setDataScope(scope);
    setContext(null);
    setSaved(null);
    setJobs([]);
    setNextCursor(null);
    setJob(null);
    setRecipe(null);
    setPreview(false);
    setBusy("");
    setError("");
    setDenied(false);
    attempt.current = null;
    retryAttempt.current = null;
  }, [scope, dataScope, props.canProcess]);
  function failure(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    setError(
      error instanceof Error
        ? error.message
        : "The media export request failed.",
    );
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      setDenied(true);
      setContext(null);
      setJobs([]);
      setNextCursor(null);
      setJob(null);
      setPreview(false);
      props.onAccessError?.();
    }
  }
  async function load() {
    if (!allowed || busy) return;
    const captured = scope,
      revision = props.revision,
      controller = new AbortController();
    request.current = controller;
    setBusy("Saving and reading the scene");
    setError("");
    setPreview(false);
    try {
      savingScene.current = true;
      const saved = await props.onSave();
      savingScene.current = false;
      if (!saved)
        throw new Error(
          "Sign in with a free account and save this project before rendering.",
        );
      if (saved.projectId !== live.current.projectId)
        throw new Error(
          "The active project changed while saving. Reopen the export workbench.",
        );
      previousProject.current = saved.projectId;
      if (
        !valid(captured) ||
        controller.signal.aborted ||
        live.current.revision !== revision
      )
        return;
      const [next, recent] = await Promise.all([
        mediaApi.context(saved.projectId, props.scenarioId, controller.signal),
        mediaApi.jobs(
          saved.projectId,
          { scenarioId: props.scenarioId },
          controller.signal,
        ),
      ]);
      if (
        !valid(captured) ||
        controller.signal.aborted ||
        live.current.revision !== revision
      )
        return;
      if (
        next.projectVersion !== saved.version ||
        next.scenarioRevision !== revision ||
        next.scene.binding.projectId !== saved.projectId ||
        next.scene.binding.scenarioId !== props.scenarioId ||
        next.sceneHash !== next.scene.sceneHash
      )
        throw new Error(
          "The saved scene changed. Load it again before reviewing an export.",
        );
      setSaved(saved);
      setContext(next);
      setJobs(
        mergeMediaHistory([], recent.jobs, saved.projectId, props.scenarioId),
      );
      setNextCursor(recent.nextCursor);
      setJob(null);
      attempt.current = null;
      setPreviewFrame(0);
      try {
        const initial = defaultMediaExportRecipe(next.scene, format);
        if (initial.format === "png" && props.initialCamera)
          initial.camera = structuredClone(props.initialCamera);
        setRecipe(initial);
      } catch (error) {
        setRecipe(null);
        failure(error);
      }
    } catch (error) {
      if (valid(captured)) failure(error);
    } finally {
      savingScene.current = false;
      if (valid(captured)) setBusy("");
    }
  }
  function changeFormat(next: "png" | "mp4") {
    setFormat(next);
    setPreview(false);
    setPreviewFrame(0);
    setError("");
    attempt.current = null;
    if (context)
      try {
        setRecipe(defaultMediaExportRecipe(context.scene, next));
      } catch (error) {
        setRecipe(null);
        failure(error);
      }
  }
  async function loadOlder() {
    if (!allowed || busy || !saved || !nextCursor) return;
    const captured = scope,
      projectId = saved.projectId,
      scenarioId = props.scenarioId,
      cursor = nextCursor,
      controller = new AbortController();
    request.current = controller;
    setBusy("Loading older exports");
    setError("");
    try {
      const page = await mediaApi.jobs(
        projectId,
        { scenarioId, cursor },
        controller.signal,
      );
      if (
        !valid(captured) ||
        controller.signal.aborted ||
        request.current !== controller ||
        live.current.projectId !== projectId
      )
        return;
      // Validate before entering a state updater so a bad server scope is handled as an explicit failure.
      mergeMediaHistory([], page.jobs, projectId, scenarioId);
      setJobs((current) =>
        mergeMediaHistory(current, page.jobs, projectId, scenarioId),
      );
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (
        valid(captured) &&
        !controller.signal.aborted &&
        request.current === controller
      )
        failure(error);
    } finally {
      if (valid(captured) && request.current === controller) setBusy("");
    }
  }
  function edit(next: MediaExportRecipe) {
    setRecipe(next);
    setPreview(false);
    setPreviewFrame(0);
    attempt.current = null;
    setError("");
  }
  async function enqueue() {
    if (
      !allowed ||
      busy ||
      !saved ||
      !context ||
      !recipe ||
      stale ||
      recipeError ||
      active(job)
    )
      return;
    const captured = scope,
      controller = new AbortController();
    request.current = controller;
    setBusy("Submitting the reviewed export");
    setError("");
    try {
      const fingerprint = JSON.stringify({
        sceneHash: context.sceneHash,
        recipe,
      });
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = {
          fingerprint,
          body: {
            scenarioId: props.scenarioId,
            expectedVersion: saved.version,
            expectedRevision: context.scenarioRevision,
            sceneHash: context.sceneHash,
            recipe: structuredClone(recipe),
            idempotencyKey: crypto.randomUUID(),
          },
        };
      const result = await mediaApi.start(
        saved.projectId,
        attempt.current.body,
        controller.signal,
      );
      if (valid(captured) && !controller.signal.aborted) {
        setJob(result.job);
        setJobs((old) => [
          result.job,
          ...old.filter((value) => value.id !== result.job.id),
        ]);
        attempt.current = null;
        setPollKey((value) => value + 1);
      }
    } catch (error) {
      if (valid(captured)) {
        if (error instanceof ApiError && error.status < 500)
          attempt.current = null;
        failure(error);
      }
    } finally {
      if (valid(captured)) setBusy("");
    }
  }
  useEffect(() => {
    if (!job || !saved || !active(job) || !allowed || dataScope !== scope)
      return;
    const captured = scope,
      controller = new AbortController(),
      id = job.id;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await mediaApi.job(
          saved.projectId,
          id,
          controller.signal,
        );
        if (!valid(captured) || controller.signal.aborted) return;
        setJob(result.job);
        setJobs((old) => [
          result.job,
          ...old.filter((value) => value.id !== id),
        ]);
        if (active(result.job)) timer = setTimeout(poll, 1500);
      } catch (error) {
        if (valid(captured) && !controller.signal.aborted) failure(error);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [job?.id, saved?.projectId, allowed, scope, dataScope, pollKey]);
  async function action(
    kind: "cancel" | "retry" | "download",
    fileName?: string,
  ) {
    if (!allowed || busy || !saved || !job) return;
    const captured = scope,
      controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    setError("");
    try {
      if (kind === "download") {
        const file = job.result?.files.find((file) => file.name === fileName);
        if (!file)
          throw new Error(
            "This completed job has no retained file with that name.",
          );
        const result = await downloadMediaFile(
          saved.projectId,
          job.id,
          file,
          controller.signal,
        );
        if (valid(captured) && !controller.signal.aborted)
          download(result.filename, result.blob);
      } else {
        if (kind === "retry" && retryAttempt.current?.jobId !== job.id)
          retryAttempt.current = {
            jobId: job.id,
            version: job.version,
            key: crypto.randomUUID(),
          };
        const result =
          kind === "cancel"
            ? await mediaApi.cancel(saved.projectId, job, controller.signal)
            : await mediaApi.retry(
                saved.projectId,
                { ...job, version: retryAttempt.current!.version },
                retryAttempt.current!.key,
                controller.signal,
              );
        if (valid(captured) && !controller.signal.aborted) {
          setJob(result.job);
          retryAttempt.current = null;
          setPollKey((value) => value + 1);
        }
      }
    } catch (error) {
      if (valid(captured)) {
        if (error instanceof ApiError && error.status < 500)
          retryAttempt.current = null;
        failure(error);
      }
    } finally {
      if (valid(captured)) setBusy("");
    }
  }
  if (dataScope !== scope || previousProject.current !== props.projectId)
    return null;
  return (
    <Modal
      title="A view worth taking with you."
      description="High-resolution stills and captioned fly-throughs · Free for everyone."
      wide
      open
      onClose={props.onClose}
    >
      <div className="media-workbench">
        <p>
          Render the real 3D city from a frozen saved revision. All tour stops
          and full notes are retained. Video has captions and no audio;
          illustrative traffic is omitted.
        </p>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <div className="media-toolbar">
          <label>
            Output
            <select
              aria-label="Media output"
              value={format}
              disabled={!!busy || active(job)}
              onChange={(event) =>
                changeFormat(event.target.value as "png" | "mp4")
              }
            >
              <option value="png">High-resolution still · PNG</option>
              <option value="mp4">Tour fly-through · MP4</option>
            </select>
          </label>
          {allowed ? (
            <button
              type="button"
              className="button"
              disabled={!!busy || active(job)}
              onClick={() => void load()}
            >
              {context ? "Reload saved scene" : "Save and load scene"}
            </button>
          ) : (
            <>
              <p>
                A free account and project edit access are required for server
                rendering. Quick PNG capture remains available without an
                account.
              </p>
              {props.onRequireAccount && (
                <button
                  type="button"
                  className="button primary"
                  onClick={props.onRequireAccount}
                >
                  Sign in free to render
                </button>
              )}
            </>
          )}
        </div>
        {busy && <p role="status">{busy}…</p>}
        {allowed && context && (
          <>
            <p className="media-binding">
              {context.scene.scenario.name} · Revision{" "}
              {context.scenarioRevision} · Saved project version{" "}
              {context.projectVersion}. Source captured{" "}
              {context.scene.place.loadedAt}.
            </p>
            {stale && (
              <p role="alert">
                This reviewed scene is an earlier revision. Reload the saved
                scene to include your current edits; existing jobs stay frozen.
              </p>
            )}
            {context.capabilities.reason && (
              <p className="notice">
                {context.capabilities.reason} Retained exports remain available.
              </p>
            )}
            <p>
              3D and 2D source geometry only. Satellite imagery is unavailable
              in this export profile; it will never be replaced silently.
            </p>
            {recipe && (
              <fieldset
                disabled={!!busy || active(job)}
                className="media-settings"
              >
                <legend>Composition and timing</legend>
                <div className="media-fields">
                  <label>
                    Exact output dimensions
                    <select
                      aria-label="Exact output dimensions"
                      value={`${recipe.width}x${recipe.height}`}
                      onChange={(event) => {
                        const [width, height] = event.target.value
                          .split("x")
                          .map(Number);
                        edit({ ...recipe, width, height });
                      }}
                    >
                      {(format === "png"
                        ? [
                            [1920, 1080],
                            [3840, 2160],
                          ]
                        : [
                            [1280, 720],
                            [1920, 1080],
                          ]
                      ).map(([w, h]) => (
                        <option key={w} value={`${w}x${h}`}>
                          {w} × {h} pixels
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Lighting time
                    <input
                      aria-label="Lighting time"
                      type="number"
                      min="0"
                      max="24"
                      step="1"
                      value={
                        Number.isFinite(recipe.timeOfDay)
                          ? recipe.timeOfDay
                          : ""
                      }
                      onChange={(event) =>
                        edit({
                          ...recipe,
                          timeOfDay:
                            event.target.value === ""
                              ? NaN
                              : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                {recipe.format === "png" ? (
                  <>
                    <div className="media-fields">
                      <label>
                        Map view
                        <select
                          aria-label="Export map view"
                          value={recipe.view}
                          onChange={(event) =>
                            edit({
                              ...recipe,
                              view: event.target.value as "3d" | "2d",
                            })
                          }
                        >
                          <option value="3d">3D city</option>
                          <option value="2d">2D plan</option>
                        </select>
                      </label>
                      <label>
                        Brief screen caption
                        <textarea
                          aria-label="Brief screen caption"
                          maxLength={240}
                          value={recipe.caption}
                          onChange={(event) =>
                            edit({ ...recipe, caption: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <details>
                      <summary>Exact camera coordinates</summary>
                      <div className="media-fields">
                        {(
                          [
                            "longitude",
                            "latitude",
                            "zoom",
                            "pitch",
                            "bearing",
                          ] as const
                        ).map((name, i) => {
                          const value =
                            i < 2
                              ? recipe.camera.center[i]
                              : recipe.camera[
                                  name as "zoom" | "pitch" | "bearing"
                                ];
                          return (
                            <label key={name}>
                              {name}
                              <input
                                aria-label={`Export camera ${name}`}
                                type="number"
                                step="any"
                                value={Number.isFinite(value) ? value : ""}
                                onChange={(event) => {
                                  const value =
                                    event.target.value === ""
                                      ? NaN
                                      : Number(event.target.value);
                                  edit({
                                    ...recipe,
                                    camera:
                                      i < 2
                                        ? {
                                            ...recipe.camera,
                                            center: recipe.camera.center.map(
                                              (coordinate, index) =>
                                                index === i
                                                  ? value
                                                  : coordinate,
                                            ) as [number, number],
                                          }
                                        : { ...recipe.camera, [name]: value },
                                  });
                                }}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </details>
                  </>
                ) : (
                  <>
                    <p>
                      30 frames per second. Hold and transition times are exact
                      frame counts. Different map views use an explicit cut.
                      Full authored callouts and narration text remain in the
                      transcript and caption file.
                    </p>
                    <ol className="media-stops">
                      {recipe.stops.map((timing, index) => {
                        const stop =
                          context.scene.scenario.presentation!.stops[index];
                        return (
                          <li key={timing.stopId}>
                            <strong>
                              {index + 1}. {stop.title}
                            </strong>
                            <div className="media-fields">
                              <label>
                                Hold frames
                                <input
                                  aria-label={`Stop ${index + 1} hold frames`}
                                  type="number"
                                  min="1"
                                  max="3600"
                                  value={
                                    Number.isFinite(timing.holdFrames)
                                      ? timing.holdFrames
                                      : ""
                                  }
                                  onChange={(event) =>
                                    edit({
                                      ...recipe,
                                      stops: recipe.stops.map((value, i) =>
                                        i === index
                                          ? {
                                              ...value,
                                              holdFrames:
                                                event.target.value === ""
                                                  ? NaN
                                                  : Number(event.target.value),
                                            }
                                          : value,
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Transition frames
                                <input
                                  aria-label={`Stop ${index + 1} transition frames`}
                                  type="number"
                                  min="0"
                                  max="300"
                                  disabled={index === recipe.stops.length - 1}
                                  value={
                                    Number.isFinite(timing.transitionFrames)
                                      ? timing.transitionFrames
                                      : ""
                                  }
                                  onChange={(event) =>
                                    edit({
                                      ...recipe,
                                      stops: recipe.stops.map((value, i) =>
                                        i === index
                                          ? {
                                              ...value,
                                              transitionFrames:
                                                event.target.value === ""
                                                  ? NaN
                                                  : Number(event.target.value),
                                            }
                                          : value,
                                      ),
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <label>
                              Brief screen caption
                              <textarea
                                aria-label={`Stop ${index + 1} screen caption`}
                                maxLength={240}
                                value={timing.caption ?? stop.callout}
                                onChange={(event) =>
                                  edit({
                                    ...recipe,
                                    stops: recipe.stops.map((value, i) =>
                                      i === index
                                        ? {
                                            ...value,
                                            caption: event.target.value,
                                          }
                                        : value,
                                    ),
                                  })
                                }
                              />
                            </label>
                            {stop.callout.length > 240 &&
                              timing.caption === undefined && (
                                <p role="status">
                                  This full callout needs an explicit brief
                                  screen caption before export. No text has been
                                  dropped.
                                </p>
                              )}
                          </li>
                        );
                      })}
                    </ol>
                  </>
                )}
                <div
                  className="media-layers"
                  role="group"
                  aria-label="Export visible layers"
                >
                  {(
                    ["buildings", "roads", "parks", "parcels", "flood"] as const
                  ).map((layer) => (
                    <label key={layer}>
                      <input
                        type="checkbox"
                        checked={recipe.layers.includes(layer)}
                        onChange={(event) =>
                          edit({
                            ...recipe,
                            layers: event.target.checked
                              ? [...recipe.layers, layer]
                              : recipe.layers.filter(
                                  (value) => value !== layer,
                                ),
                          })
                        }
                      />
                      {layer}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {recipeError && (
              <p role="alert" className="notice">
                {recipeError}
              </p>
            )}
            {recipe && !recipeError && (
              <>
                <p>
                  {recipe.width} × {recipe.height} total pixels, including map,
                  text and source credits.{" "}
                  {recipe.format === "mp4"
                    ? `${frameCount} frames · ${(frameCount / 30).toFixed(2)} seconds · no audio.`
                    : "One exact-resolution image."}
                </p>
                <div className="media-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={!!busy || stale}
                    onClick={() => setPreview((value) => !value)}
                  >
                    {preview ? "Hide preview" : "Preview frozen composition"}
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      !!busy ||
                      stale ||
                      active(job) ||
                      !context.capabilities.enabled ||
                      !context.capabilities.configured
                    }
                    onClick={() => void enqueue()}
                  >
                    Render{" "}
                    {recipe.format === "png"
                      ? "high-resolution still"
                      : "tour video"}
                  </button>
                </div>
                {preview && (
                  <>
                    <label>
                      Preview frame
                      <input
                        aria-label="Preview frame"
                        type="number"
                        min="0"
                        max={frameCount - 1}
                        value={previewFrame}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (
                            Number.isInteger(value) &&
                            value >= 0 &&
                            value < frameCount
                          )
                            setPreviewFrame(value);
                        }}
                      />
                    </label>
                    <Suspense
                      fallback={<p role="status">Loading the 3D renderer…</p>}
                    >
                      <Preview
                        scene={context.scene}
                        recipe={recipe}
                        index={previewFrame}
                      />
                    </Suspense>
                  </>
                )}
              </>
            )}
            <details>
              <summary>Captured sources and export permissions</summary>
              <p>
                This private download does not authorize public redistribution.
                Publishing remains a separate rights-checked action.
              </p>
              <ul>
                {context.scene.sources.map(({ namespace, source }) => (
                  <li key={`${namespace}:${source.id}`}>
                    <strong>{source.name}</strong> · {namespace} ·{" "}
                    {source.vintage} · {source.license}
                    {source.rights && (
                      <span>
                        {" "}
                        · Public redistribution{" "}
                        {source.rights.publicRedistribution
                          ? "declared permitted"
                          : "not permitted"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        {allowed && jobs.length > 0 && (
          <section aria-label="Retained export history">
            <label>
              Retained media exports
              <select
                aria-label="Retained media exports"
                value={job?.id ?? ""}
                disabled={!!busy}
                onChange={(event) => {
                  setJob(
                    jobs.find((value) => value.id === event.target.value) ??
                      null,
                  );
                  setPollKey((value) => value + 1);
                }}
              >
                <option value="">Choose an export</option>
                {jobs.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.recipe.format.toUpperCase()} · revision{" "}
                    {value.scenarioRevision} · {value.status} ·{" "}
                    {value.createdAt}
                  </option>
                ))}
              </select>
            </label>
            <p role="status">
              {jobs.length} retained {jobs.length === 1 ? "export" : "exports"}{" "}
              loaded for this scenario.
              {nextCursor
                ? " Older exports are available."
                : " All retained exports are shown."}
            </p>
            {nextCursor && (
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => void loadOlder()}
              >
                Load older exports
              </button>
            )}
          </section>
        )}
        {allowed && job && (
          <section className="media-job" aria-label="Media export progress">
            <h3>
              {job.status === "completed"
                ? "Your export is ready"
                : job.status === "failed"
                  ? "Export needs attention"
                  : job.status === "cancelled"
                    ? "Export cancelled"
                    : "Preparing your saved view"}
            </h3>
            <p>
              Revision {job.scenarioRevision} · Project version{" "}
              {job.projectVersion} · {job.stage} · Attempt {job.attempt}
            </p>
            {job.scenarioRevision !== props.revision && (
              <p>
                This artifact belongs to an earlier revision, not your current
                edits.
              </p>
            )}
            <p role="status">
              {job.completedFrames} of {job.totalFrames} frames rendered
            </p>
            <progress
              aria-label="Frames rendered"
              value={job.completedFrames}
              max={Math.max(1, job.totalFrames)}
            />
            {job.cancelRequested && (
              <p>Cancellation requested; waiting for the renderer to stop.</p>
            )}
            {job.error && <p role="alert">{job.error.message}</p>}
            <div className="media-actions">
              {active(job) && (
                <button
                  type="button"
                  className="button"
                  disabled={!!busy || job.cancelRequested}
                  onClick={() => void action("cancel")}
                >
                  Cancel media export
                </button>
              )}
              {(job.error?.retryable ||
                (job.status === "cancelled" &&
                  job.attempt < 3 &&
                  job.error?.retryable !== false)) && (
                <button
                  type="button"
                  className="button"
                  disabled={!!busy || active(job)}
                  onClick={() => void action("retry")}
                >
                  Retry media export
                </button>
              )}
              {error && active(job) && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setPollKey((value) => value + 1)}
                >
                  Refresh export progress
                </button>
              )}
              {job.status === "completed" &&
                job.result?.files.map((file) => (
                  <button
                    type="button"
                    className="button"
                    key={file.name}
                    disabled={!!busy}
                    onClick={() => void action("download", file.name)}
                  >
                    Download {file.name}
                  </button>
                ))}
            </div>
            <p>
              Closing this window does not cancel an admitted job. Reopen and
              load the saved scene to find retained exports.
            </p>
          </section>
        )}
      </div>
    </Modal>
  );
}
