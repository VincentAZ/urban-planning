import type { FloodDatasetCatalog } from "@urban/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Camera,
  ChevronLeft,
  ChevronRight,
  List,
  Maximize2,
  Minimize2,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import {
  assertScenarioPresentation,
  MAX_PRESENTATION_METRICS,
  MAX_PRESENTATION_STOPS,
  type ModelResults,
  type Place,
  type PresentationCamera,
  type PresentationStop,
  type Scenario,
  type ScenarioPresentation,
  type Source,
} from "@urban/core";
import { formatMetric } from "@urban/models";
import type { CityMapProps } from "../CityMap";
import {
  movePresentationStop,
  overviewPresentation,
  presentationMetric,
  PRESENTATION_CAMERA_LIMITS,
  PRESENTATION_LAYERS,
} from "./state";
import { useLocalNarration } from "./useLocalNarration";
import "./presentation.css";

const CityMap = lazy(() => import("../CityMap"));
const noSelection = () => {};
const numberValue = (value: number) => (Number.isFinite(value) ? value : "");

function TourSource({ source, id }: { source?: Source; id: string }) {
  if (!source) return <span>{id} · Source record unavailable</span>;
  return (
    <div className="tour-source">
      <strong>{source.name}</strong>
      <p>
        {source.kind} · {source.vintage} · {source.license}
      </p>
      {source.description && <p>{source.description}</p>}
      {/^https?:\/\//i.test(source.url) && (
        <a href={source.url} target="_blank" rel="noopener noreferrer">
          Open source documentation
        </a>
      )}
    </div>
  );
}

export function PresentationDialog({
  place,
  scenario,
  results,
  initialCamera,
  floodDatasets,
  canEdit = false,
  publishedAt,
  onSave,
  onClose,
}: {
  place: Place;
  scenario: Scenario;
  results: ModelResults;
  initialCamera?: PresentationCamera;
  floodDatasets?: FloodDatasetCatalog;
  canEdit?: boolean;
  publishedAt?: string;
  onSave?: (tour: ScenarioPresentation | null) => void;
  onClose: () => void;
}) {
  // The parent keys this dialog by project/scenario/revision. Keep one immutable
  // source/results bundle throughout playback and the unsaved editing session.
  const [initial] = useState(() =>
    structuredClone(
      scenario.presentation ??
        overviewPresentation(place, scenario, results, initialCamera),
    ),
  );
  const [draft, setDraft] = useState(initial);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [seconds, setSeconds] = useState(30);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState("");
  const [fullScreen, setFullScreen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const ownedFullscreen = useRef<Element | null>(null);
  const story = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const cameraCaptureRef = useRef<(() => PresentationCamera | null) | null>(
    null,
  );
  const stop = draft.stops[index];
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const resultsMatch =
    results.scenarioId === scenario.id &&
    results.revision === scenario.revision;
  const [cameraCommand, setCameraCommand] = useState<
    CityMapProps["cameraCommand"]
  >(() => ({
    requestId: crypto.randomUUID(),
    camera: initial.stops[0].camera,
    transition: "jump",
  }));
  const [mapView, setMapView] = useState<PresentationStop["view"]>(
    initial.stops[0].view,
  );
  const [cameraNotice, setCameraNotice] = useState("");
  const [cameraMoving, setCameraMoving] = useState(true);
  const narrationText = stop
    ? `${stop.title}. ${stop.narration?.trim() || stop.callout}`
    : "";
  const narration = useLocalNarration(narrationText);
  const sources = useMemo(
    () =>
      new Map(
        [...place.sources, ...(scenario.sources ?? [])].map((source) => [
          source.id,
          source,
        ]),
      ),
    [place, scenario],
  );

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  useEffect(() => {
    const changed = () => {
      const active =
        !!content.current && document.fullscreenElement === content.current;
      setFullScreen(active);
      if (active) ownedFullscreen.current = content.current;
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (
        ownedFullscreen.current &&
        document.fullscreenElement === ownedFullscreen.current
      )
        void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (confirmClose) keepEditing.current?.focus();
  }, [confirmClose]);
  useEffect(() => {
    const pause = () => {
      if (document.hidden) {
        setAutoPlay(false);
        narration.stop();
      }
    };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, [narration.stop]);
  const requestCamera = useCallback(
    (target: PresentationStop, transition: "fly" | "jump" = "fly") => {
      setMapView(target.view);
      setCameraNotice("");
      setCameraMoving(true);
      setCameraCommand({
        requestId: crypto.randomUUID(),
        camera: target.camera,
        transition,
        durationMs: 1800,
      });
    },
    [],
  );
  function goTo(next: number, manual = true) {
    if (next < 0 || next >= draft.stops.length) return;
    if (manual) setAutoPlay(false);
    narration.stop();
    setIndex(next);
    requestCamera(draft.stops[next]);
    requestAnimationFrame(() => {
      story.current?.scrollTo({ top: 0 });
      body.current?.scrollTo({ top: 0 });
      if (!editing) heading.current?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (!autoPlay || editing || confirmClose || !draft.stops.length) return;
    const timer = window.setTimeout(() => {
      if (index === draft.stops.length - 1) setAutoPlay(false);
      else goTo(index + 1, false);
    }, seconds * 1000);
    const visibility = () => {
      if (document.hidden) {
        setAutoPlay(false);
        narration.stop();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [autoPlay, editing, confirmClose, index, seconds, draft.stops]);
  function requestClose() {
    setAutoPlay(false);
    narration.stop();
    if (dirty) setConfirmClose(true);
    else onClose();
  }
  function patchStop(patch: Partial<PresentationStop>) {
    if (!stop) return;
    setDraft((current) => ({
      ...current,
      stops: current.stops.map((item) =>
        item.id === stop.id ? { ...item, ...patch } : item,
      ),
    }));
    setError("");
  }
  function previewView() {
    if (!stop) return;
    try {
      assertScenarioPresentation({
        version: 1,
        title: draft.title || "Preview",
        stops: [stop],
      });
      requestCamera(stop);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function save() {
    if (!canEdit || !onSave) return;
    try {
      const value = draft.stops.length ? draft : null;
      if (value) assertScenarioPresentation(value);
      onSave(value);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function addStop() {
    if (draft.stops.length >= MAX_PRESENTATION_STOPS) return;
    const camera =
      cameraCaptureRef.current?.() ?? stop?.camera ?? initial.stops[0].camera;
    const next: PresentationStop = {
      id: crypto.randomUUID(),
      title: `Stop ${draft.stops.length + 1}`,
      callout: "",
      camera: structuredClone(camera),
      view: mapView,
    };
    setDraft((current) => ({ ...current, stops: [...current.stops, next] }));
    setIndex(draft.stops.length);
    setError("");
  }
  const cameraResult = useCallback<
    NonNullable<CityMapProps["onCameraCommandResult"]>
  >(
    (result) => {
      if (result.requestId !== cameraCommand?.requestId) return;
      setCameraMoving(false);
      if (result.status === "rejected")
        setCameraNotice(
          result.reason || "This camera view could not be displayed.",
        );
      else if (result.status === "cancelled")
        setCameraNotice(
          "Camera move paused. Use Replay view to return to the saved view.",
        );
      else setCameraNotice("");
    },
    [cameraCommand?.requestId],
  );
  const cleanCameraNumber = (
    key: "zoom" | "pitch" | "bearing",
    value: number,
  ) => stop && patchStop({ camera: { ...stop.camera, [key]: value } });

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="tour-overlay" />
        <Dialog.Content
          ref={content}
          className={`tour-dialog ${editing ? "tour-editing" : "tour-viewing"}`}
          aria-describedby="tour-context"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current;
            if (target?.isConnected) {
              if (target instanceof HTMLButtonElement && target.disabled)
                document
                  .getElementById("main-workspace")
                  ?.focus({ preventScroll: true });
              else target.focus({ preventScroll: true });
            }
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            requestClose();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (
              editing ||
              event.defaultPrevented ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              (event.target as HTMLElement).closest(
                "input,textarea,select,[contenteditable],.city-map",
              )
            )
              return;
            if (event.key === "ArrowRight" || event.key === "PageDown") {
              event.preventDefault();
              goTo(index + 1);
            }
            if (event.key === "ArrowLeft" || event.key === "PageUp") {
              event.preventDefault();
              goTo(index - 1);
            }
          }}
        >
          <header className="tour-header">
            <div>
              <span className="tour-eyebrow">
                {editing ? "Presentation studio" : "A guided possibility"}
              </span>
              <Dialog.Title>
                {editing ? "Shape the story." : draft.title}
              </Dialog.Title>
              <Dialog.Description id="tour-context">
                {scenario.name} · Revision {scenario.revision} ·{" "}
                {scenario.horizon
                  ? `${scenario.horizon}-year horizon`
                  : "Today"}
                {publishedAt ? " · Published snapshot" : " · Browser proposal"}
              </Dialog.Description>
            </div>
            <div className="tour-header-actions">
              {canEdit && (
                <button
                  className="button secondary"
                  onClick={() => {
                    if (editing) {
                      try {
                        assertScenarioPresentation(draft);
                        if (stop) requestCamera(stop);
                      } catch (cause) {
                        setError((cause as Error).message);
                        return;
                      }
                    }
                    setError("");
                    setEditing((value) => !value);
                    setAutoPlay(false);
                    narration.stop();
                  }}
                >
                  <Pencil size={16} />
                  {editing ? "Preview tour" : "Edit tour"}
                </button>
              )}
              <button
                className="button secondary"
                aria-label={
                  fullScreen ? "Leave fullscreen" : "Enter fullscreen"
                }
                onClick={async () => {
                  try {
                    if (document.fullscreenElement === content.current)
                      await document.exitFullscreen();
                    else if (content.current?.requestFullscreen)
                      await content.current.requestFullscreen();
                    else
                      setError(
                        "Fullscreen is unavailable here. The presentation still fills this browser window.",
                      );
                  } catch {
                    setError(
                      "Fullscreen was not allowed. The presentation still fills this browser window.",
                    );
                  }
                }}
              >
                {fullScreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                <span>Fullscreen</span>
              </button>
              <button
                className="button secondary"
                onClick={requestClose}
                aria-label="Close presentation"
              >
                <X size={18} />
                <span>Close</span>
              </button>
            </div>
          </header>
          {confirmClose && (
            <div className="tour-confirm" role="alert">
              <strong>Discard unsaved tour changes?</strong>
              <span>Your saved scenario stays unchanged.</span>
              <button
                ref={keepEditing}
                className="button secondary"
                onClick={() => setConfirmClose(false)}
              >
                Keep editing
              </button>
              <button className="button primary" onClick={onClose}>
                Discard tour changes
              </button>
            </div>
          )}
          {error && (
            <p className="tour-message error-message" role="alert">
              {error}
            </p>
          )}
          {!resultsMatch && (
            <p className="tour-message error-message" role="alert">
              These results do not match the scenario revision. Metric values
              are hidden; reopen the presentation after calculations finish.
            </p>
          )}
          <div className="tour-body" ref={body}>
            {editing && (
              <aside className="tour-outline" aria-label="Tour outline">
                <label className="field">
                  <span>Tour title</span>
                  <input
                    value={draft.title}
                    maxLength={160}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                  />
                </label>
                <p className="muted small">
                  Arrange the stops in the order you will tell the story. Save
                  them as one reversible scenario edit.
                </p>
                <ol>
                  {draft.stops.map((item, i) => (
                    <li key={item.id}>
                      <button
                        className={i === index ? "active" : ""}
                        aria-current={i === index ? "step" : undefined}
                        onClick={() => goTo(i)}
                      >
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        {item.title || "Untitled stop"}
                      </button>
                    </li>
                  ))}
                </ol>
                <button
                  className="button secondary full-width"
                  onClick={addStop}
                  disabled={draft.stops.length >= MAX_PRESENTATION_STOPS}
                >
                  <Plus size={16} /> Add stop
                </button>
                <p className="muted small">
                  {draft.stops.length} of {MAX_PRESENTATION_STOPS} stops
                </p>
              </aside>
            )}
            <section
              className="tour-stage"
              aria-label="Presentation map"
              data-camera-state={cameraMoving ? "moving" : "ready"}
            >
              <Suspense
                fallback={
                  <div className="map-loading" role="status">
                    Preparing the city view…
                  </div>
                }
              >
                <CityMap
                  place={place}
                  scenario={scenario}
                  selectedId={null}
                  onSelect={noSelection}
                  view={mapView}
                  playing={false}
                  speed={1}
                  timeOfDay={15}
                  layers={PRESENTATION_LAYERS}
                  floodDatasets={floodDatasets}
                  cameraLimits={PRESENTATION_CAMERA_LIMITS}
                  cameraCommand={cameraCommand}
                  onCameraCommandResult={cameraResult}
                  cameraCaptureRef={cameraCaptureRef}
                  onCameraReadyChange={setCameraReady}
                />
              </Suspense>
              <div className="tour-map-label">
                <span>{place.name}</span>
                <span>
                  {mapView === "2d"
                    ? "2D plan"
                    : mapView === "3d"
                      ? "3D city"
                      : "Satellite"}
                </span>
              </div>
              {cameraMoving && (
                <span role="status" className="sr-only">
                  Moving to the saved view
                </span>
              )}
              {cameraNotice && (
                <p className="tour-camera-notice" role="status">
                  {cameraNotice}
                </p>
              )}
            </section>
            <section
              ref={story}
              className="tour-story"
              aria-label={editing ? "Edit tour stop" : "Tour callout"}
            >
              {editing ? (
                stop ? (
                  <>
                    <div className="tour-stop-actions">
                      <span>Stop {index + 1}</span>
                      <button
                        className="icon-button"
                        aria-label="Move stop earlier"
                        disabled={index === 0}
                        onClick={() => {
                          setDraft((current) => ({
                            ...current,
                            stops: movePresentationStop(
                              current.stops,
                              stop.id,
                              -1,
                            ),
                          }));
                          setIndex(index - 1);
                        }}
                      >
                        <ArrowUp size={18} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Move stop later"
                        disabled={index === draft.stops.length - 1}
                        onClick={() => {
                          setDraft((current) => ({
                            ...current,
                            stops: movePresentationStop(
                              current.stops,
                              stop.id,
                              1,
                            ),
                          }));
                          setIndex(index + 1);
                        }}
                      >
                        <ArrowDown size={18} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Remove tour stop"
                        onClick={() => {
                          const next = draft.stops.filter(
                            (item) => item.id !== stop.id,
                          );
                          setDraft((current) => ({ ...current, stops: next }));
                          setIndex(
                            Math.min(index, Math.max(0, next.length - 1)),
                          );
                          if (next.length)
                            requestCamera(
                              next[Math.min(index, next.length - 1)],
                            );
                        }}
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                    <label className="field">
                      <span>Stop title</span>
                      <input
                        value={stop.title}
                        maxLength={160}
                        onChange={(event) =>
                          patchStop({ title: event.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Callout</span>
                      <textarea
                        rows={5}
                        value={stop.callout}
                        maxLength={2000}
                        onChange={(event) =>
                          patchStop({ callout: event.target.value })
                        }
                        placeholder="What should the audience notice here?"
                      />
                    </label>
                    <p className="muted small">
                      Authored by your team. Check narrative claims when the
                      proposal changes; the linked metrics always use this
                      scenario revision.
                    </p>
                    <label className="field">
                      <span>Narration transcript (optional)</span>
                      <textarea
                        rows={3}
                        value={stop.narration ?? ""}
                        maxLength={4000}
                        onChange={(event) =>
                          patchStop({ narration: event.target.value })
                        }
                        placeholder="Leave blank to read the callout."
                      />
                    </label>
                    <fieldset className="tour-camera-fields">
                      <legend>Saved camera</legend>
                      <label className="field">
                        <span>View</span>
                        <select
                          value={stop.view}
                          onChange={(event) =>
                            patchStop({
                              view: event.target
                                .value as PresentationStop["view"],
                              camera: {
                                ...stop.camera,
                                ...(event.target.value === "2d"
                                  ? { pitch: 0 }
                                  : {}),
                              },
                            })
                          }
                        >
                          <option value="3d">3D city</option>
                          <option value="2d">2D plan</option>
                          <option value="satellite">
                            Satellite (requires imagery)
                          </option>
                        </select>
                      </label>
                      <div className="tour-number-grid">
                        {(["Longitude", "Latitude"] as const).map(
                          (label, i) => (
                            <label className="field" key={label}>
                              <span>{label}</span>
                              <input
                                type="number"
                                step="any"
                                min={i ? -85 : -180}
                                max={i ? 85 : 180}
                                value={numberValue(stop.camera.center[i])}
                                onChange={(event) => {
                                  const center: [number, number] = [
                                    ...stop.camera.center,
                                  ];
                                  center[i] = event.target.valueAsNumber;
                                  patchStop({
                                    camera: { ...stop.camera, center },
                                  });
                                }}
                              />
                            </label>
                          ),
                        )}
                        {(["zoom", "pitch", "bearing"] as const).map((key) => (
                          <label className="field" key={key}>
                            <span>{key[0].toUpperCase() + key.slice(1)}</span>
                            <input
                              type="number"
                              step="any"
                              min={
                                key === "zoom" ? 2 : key === "pitch" ? 0 : -180
                              }
                              max={
                                key === "zoom" ? 21 : key === "pitch" ? 60 : 180
                              }
                              value={numberValue(stop.camera[key])}
                              onChange={(event) =>
                                cleanCameraNumber(
                                  key,
                                  event.target.valueAsNumber,
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <div className="tour-field-actions">
                        <button
                          className="button secondary"
                          disabled={!cameraReady}
                          onClick={() => {
                            const camera = cameraCaptureRef.current?.();
                            if (!camera) {
                              setError("Wait for the map to finish loading.");
                              return;
                            }
                            patchStop({ camera, view: mapView });
                          }}
                        >
                          <Camera size={15} /> Capture current view
                        </button>
                        <button
                          className="button secondary"
                          onClick={previewView}
                        >
                          Preview selected view
                        </button>
                      </div>
                    </fieldset>
                    <fieldset className="tour-metric-picker">
                      <legend>Measures to explain</legend>
                      <p className="muted small">
                        Choose up to {MAX_PRESENTATION_METRICS}. Values and
                        methods come from the frozen result bundle.
                      </p>
                      {results.metrics.map((metric) => (
                        <label key={metric.id}>
                          <input
                            type="checkbox"
                            checked={
                              stop.metricIds?.includes(metric.id) ?? false
                            }
                            disabled={
                              !stop.metricIds?.includes(metric.id) &&
                              (stop.metricIds?.length ?? 0) >=
                                MAX_PRESENTATION_METRICS
                            }
                            onChange={(event) =>
                              patchStop({
                                metricIds: event.target.checked
                                  ? [...(stop.metricIds ?? []), metric.id]
                                  : stop.metricIds?.filter(
                                      (id) => id !== metric.id,
                                    ),
                              })
                            }
                          />
                          <span>
                            {metric.label}
                            {metric.status !== "ready"
                              ? ` · ${metric.status}`
                              : ""}
                          </span>
                        </label>
                      ))}
                      {stop.metricIds
                        ?.filter(
                          (id) =>
                            !results.metrics.some((metric) => metric.id === id),
                        )
                        .map((id) => (
                          <label key={id}>
                            <input
                              type="checkbox"
                              checked
                              onChange={() =>
                                patchStop({
                                  metricIds: stop.metricIds?.filter(
                                    (item) => item !== id,
                                  ),
                                })
                              }
                            />
                            <span>
                              {id} · unavailable in this model version
                            </span>
                          </label>
                        ))}
                    </fieldset>
                  </>
                ) : (
                  <div className="tour-empty">
                    <List size={30} />
                    <h2>Make the first stop.</h2>
                    <p>
                      Add a view and give the audience one clear point to take
                      away.
                    </p>
                    <button className="button primary" onClick={addStop}>
                      Add stop
                    </button>
                    <p className="muted small">
                      Saving an empty outline removes the existing saved tour.
                    </p>
                  </div>
                )
              ) : stop ? (
                <>
                  <span className="tour-eyebrow">
                    {String(index + 1).padStart(2, "0")} /{" "}
                    {String(draft.stops.length).padStart(2, "0")}
                  </span>
                  <h2 ref={heading} tabIndex={-1}>
                    {stop.title}
                  </h2>
                  <p className="tour-callout">
                    {stop.callout ||
                      "Explore this view, then continue to the next stop."}
                  </p>
                  <p className="tour-evidence-note">
                    {dirty
                      ? "Unsaved tour preview"
                      : scenario.presentation
                        ? "Team-authored narrative"
                        : "Quick overview · tour not saved"}{" "}
                    · Planning estimates, with assumptions shown.
                  </p>
                  <div className="tour-narration">
                    <button
                      className="button secondary"
                      disabled={
                        !narration.voices.length || !narrationText.trim()
                      }
                      onClick={() =>
                        narration.speaking
                          ? narration.stop()
                          : narration.start()
                      }
                    >
                      {narration.speaking ? (
                        <Pause size={16} />
                      ) : (
                        <Volume2 size={16} />
                      )}{" "}
                      {narration.speaking
                        ? "Stop narration"
                        : "Read this stop aloud"}
                    </button>
                    {narration.voices.length > 0 ? (
                      <label className="field">
                        <span>Device voice</span>
                        <select
                          value={narration.voiceURI}
                          onChange={(event) =>
                            narration.setVoiceURI(event.target.value)
                          }
                        >
                          {narration.voices.map((voice) => (
                            <option key={voice.voiceURI} value={voice.voiceURI}>
                              {voice.name} · {voice.lang}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <small>
                        Device narration is unavailable in this browser. The
                        complete transcript is below.
                      </small>
                    )}
                    {narration.error && <p role="status">{narration.error}</p>}
                    <details>
                      <summary>Narration transcript</summary>
                      <p>{narrationText}</p>
                    </details>
                  </div>
                  {(stop.metricIds?.length ?? 0) > 0 && (
                    <div className="tour-metrics">
                      <h3>The evidence at this stop</h3>
                      {stop.metricIds!.map((id) => {
                        const metric = presentationMetric(
                          id,
                          scenario,
                          results,
                        );
                        if (!metric)
                          return (
                            <article key={id} className="tour-metric">
                              <h4>{id}</h4>
                              <p>
                                Unavailable for this scenario revision/model. No
                                value has been substituted.
                              </p>
                            </article>
                          );
                        return (
                          <article key={id} className="tour-metric">
                            <h4>{metric.label}</h4>
                            <strong>
                              {formatMetric(metric.value, metric.unit)}{" "}
                              <small>{metric.unit}</small>
                            </strong>
                            <table>
                              <caption className="sr-only">
                                {metric.label} comparison
                              </caption>
                              <thead>
                                <tr>
                                  <th>Baseline</th>
                                  <th>Proposal</th>
                                  <th>Change</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td>
                                    {formatMetric(metric.baseline, metric.unit)}
                                  </td>
                                  <td>
                                    {formatMetric(metric.value, metric.unit)}
                                  </td>
                                  <td>
                                    {formatMetric(metric.delta, metric.unit)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                            <p className="tour-metric-status">
                              {metric.status === "ready"
                                ? "Planning estimate"
                                : metric.status === "incomplete"
                                  ? "Incomplete evidence"
                                  : "Unavailable"}
                              {metric.low !== undefined &&
                              metric.high !== undefined
                                ? ` · Range ${formatMetric(metric.low, metric.unit)}–${formatMetric(metric.high, metric.unit)}`
                                : ""}
                            </p>
                            <details>
                              <summary>Method, inputs & sources</summary>
                              <p>{metric.explanation}</p>
                              <p>
                                {metric.method} · {metric.methodVersion} · r
                                {metric.scenarioRevision}
                              </p>
                              <p>{metric.formula}</p>
                              <ul>
                                {metric.inputs.map((input, i) => (
                                  <li key={i}>
                                    {input.name}: {String(input.value)} (
                                    {input.source})
                                  </li>
                                ))}
                              </ul>
                              <ul>
                                {metric.sourceIds.map((sourceId) => (
                                  <li key={sourceId}>
                                    <TourSource
                                      source={
                                        metric.id === "environment.flood" &&
                                        scenario.flood
                                          ? floodDatasets?.[
                                              scenario.flood.datasetHash
                                            ]?.sources.find(
                                              (s) => s.id === sourceId,
                                            )
                                          : sources.get(sourceId)
                                      }
                                      id={sourceId}
                                    />
                                  </li>
                                ))}
                              </ul>
                              <p>{metric.geography}</p>
                              {metric.caveat && <p>{metric.caveat}</p>}
                            </details>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  <details className="tour-coverage">
                    <summary>Sources & coverage</summary>
                    <p>
                      {place.extentLabel} · Source captured {place.loadedAt}.
                      Model {results.modelVersion} · Scenario revision{" "}
                      {scenario.revision}.
                    </p>
                    <p>
                      Source vintage varies by layer. Geometry and results stay
                      bound to this presentation’s scenario; narration is
                      authored text.
                    </p>
                    <ul>
                      {place.coverage.map((layer, i) => (
                        <li key={i}>
                          <strong>
                            {layer.layer} · {layer.status}
                          </strong>
                          <p>{layer.description}</p>
                        </li>
                      ))}
                    </ul>
                    {results.warnings.length > 0 && (
                      <>
                        <h3>Model limitations</h3>
                        <ul>
                          {results.warnings.map((warning, i) => (
                            <li key={i}>{warning}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    <ul>
                      {[...sources.values()].map((source) => (
                        <li key={source.id}>
                          <TourSource source={source} id={source.id} />
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              ) : (
                <p>No stops in this tour. Choose Edit tour to add a stop.</p>
              )}
            </section>
          </div>
          <footer className="tour-footer">
            {editing ? (
              <>
                <p>
                  {dirty
                    ? "Changes are not saved yet."
                    : "Your saved scenario is unchanged."}
                </p>
                <div>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setDraft(initial);
                      setIndex(0);
                      setEditing(false);
                      setError("");
                      requestCamera(initial.stops[0]);
                    }}
                  >
                    Discard draft
                  </button>
                  <button
                    className="button primary"
                    disabled={!canEdit || (!dirty && !!scenario.presentation)}
                    onClick={save}
                  >
                    <Save size={16} />
                    {draft.stops.length ? "Save tour" : "Remove saved tour"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="tour-navigation">
                  <button
                    className="button secondary"
                    disabled={index === 0 || !stop}
                    onClick={() => goTo(index - 1)}
                    aria-label="Previous stop"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <label>
                    <span className="sr-only">Tour stop</span>
                    <select
                      value={stop?.id ?? ""}
                      onChange={(event) =>
                        goTo(
                          draft.stops.findIndex(
                            (item) => item.id === event.target.value,
                          ),
                        )
                      }
                    >
                      {draft.stops.map((item, i) => (
                        <option key={item.id} value={item.id}>
                          {i + 1}. {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button secondary"
                    disabled={index >= draft.stops.length - 1 || !stop}
                    onClick={() => goTo(index + 1)}
                    aria-label="Next stop"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
                <div className="tour-playback">
                  <button
                    className="button secondary"
                    disabled={!stop}
                    onClick={() => stop && requestCamera(stop)}
                  >
                    Replay view
                  </button>
                  <button
                    className="button primary"
                    disabled={draft.stops.length < 2}
                    onClick={() => {
                      narration.stop();
                      if (!autoPlay && index === draft.stops.length - 1)
                        goTo(0, false);
                      setAutoPlay((value) => !value);
                    }}
                  >
                    {autoPlay ? <Pause size={16} /> : <Play size={16} />}{" "}
                    {autoPlay ? "Pause tour" : "Play tour"}
                  </button>
                  <label>
                    <span className="sr-only">Seconds per stop</span>
                    <select
                      value={seconds}
                      onChange={(event) =>
                        setSeconds(Number(event.target.value))
                      }
                    >
                      <option value={15}>15 sec / stop</option>
                      <option value={30}>30 sec / stop</option>
                      <option value={60}>60 sec / stop</option>
                    </select>
                  </label>
                  <span className="sr-only" role="status">
                    {autoPlay
                      ? `Playing stop ${index + 1} of ${draft.stops.length}`
                      : `Stop ${index + 1} of ${draft.stops.length}`}
                  </span>
                </div>
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
