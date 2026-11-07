import { exportHousingCSV } from "../lib/housing-export";
import { exportFiscalCSV } from "../lib/fiscal-export";
import {
  floodComparisonScenarios,
  floodComparisonMetrics,
} from "./flood/comparison";
import { floodMethodVersion } from "@urban/core";
import { exportFloodCSV } from "../lib/flood-export";
import { exportAccessibilityCSV } from "../lib/accessibility-export";
import { exportTrafficCSV, trafficExportStatus } from "../lib/traffic-export";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Download,
  FileText,
  FolderOpen,
  Globe2,
  Image,
  Layers,
  Link2,
  Loader2,
  LockKeyhole,
  Upload,
} from "lucide-react";
import { formatMetric, type FloodResolution } from "@urban/models";
import { useImpactComparison } from "../lib/useImpact";
import type {
  MetricResult,
  ModelResults,
  Place,
  Project,
  Scenario,
} from "@urban/core";
import { Modal } from "./Modal";
import { ShapefileExport } from "./import/ShapefileExport";
import { PublishEngagementConfig } from "./engagement/PublishEngagementConfig";
import {
  cleanEngagement,
  defaultEngagement,
  disabledEngagement,
  validateEngagement,
} from "./engagement/state";
import { api, download } from "../lib/api";
import {
  exportCSV,
  exportGeoJSON,
  exportProject,
  reportHTML,
} from "../lib/exports";
import type { MapCamera } from "./CityMap";
const CompareMap = lazy(() => import("./CityMap"));
const comparisonLayers = ["buildings", "roads", "parks", "parcels", "flood"];
const noSelection = () => {};

export { AuthDialog } from "./identity/AuthDialog";

export function CompareDialog({
  place,
  project,
  onClose,
}: {
  place: Place;
  project: Project;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(
    project.scenarios.slice(0, 4).map((s) => s.id),
  );
  const scenarios = useMemo(
    () =>
      floodComparisonScenarios(
        project.scenarios.filter((s) => selected.includes(s.id)),
      ),
    [project.scenarios, selected],
  );
  const noCommonFloodBaseline =
    scenarios.some((s) => s.id === "baseline" && !s.flood) &&
    scenarios.some((s) => s.id !== "baseline" && s.flood);
  const context = useMemo(
    () => ({
      floodDatasets: project.floodDatasets,
      fiscalStudy: project.fiscalStudy,
      housingIncomeLimits: project.housingIncomeLimits,
    }),
    [project.floodDatasets, project.fiscalStudy, project.housingIncomeLimits],
  );
  const calculation = useImpactComparison(place, scenarios, context);
  const results = calculation.values?.map((value) => value.results) ?? [];
  const [camera, setCamera] = useState<MapCamera | undefined>(
    place.studyArea
      ? undefined
      : {
          center: place.center,
          zoom: 15.4,
          pitch: 50,
          bearing: -27,
        },
  );
  const metrics = floodComparisonMetrics(scenarios, results);
  return (
    <Modal
      title="A clearer view of the alternatives."
      description="Compare consistent, revision-bound results. Every outcome has tradeoffs."
      wide
      open
      onClose={onClose}
    >
      <div className="compare-options">
        {project.scenarios.map((s) => (
          <label key={s.id} className="scenario-pill">
            <input
              type="checkbox"
              checked={selected.includes(s.id)}
              disabled={!selected.includes(s.id) && selected.length >= 4}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, s.id]
                    : selected.filter((id) => id !== s.id),
                )
              }
            />
            {s.name}
            <span>r{s.revision}</span>
          </label>
        ))}
      </div>
      {scenarios.some((s) => s.id === "baseline" && s.flood) && (
        <p className="notice">
          Baseline flood screening uses the same captured map and calculation
          method as these proposals. The original baseline and source geometries
          remain unchanged.
        </p>
      )}
      {new Set(
        scenarios
          .filter((s) => s.id !== "baseline" && s.flood)
          .map((s) => floodMethodVersion(s.flood)),
      ).size > 1 && (
        <p className="notice">
          These scenarios use different flood calculation methods. Their results
          may differ even with the same source map. No single flood method has
          been assigned to the comparison baseline.
        </p>
      )}
      {noCommonFloodBaseline && (
        <p className="notice">
          No shared flood baseline is shown because these scenarios do not all
          select the same source map and calculation method.
        </p>
      )}
      <div className="compare-maps">
        {scenarios.map((s) => (
          <div className="compare-map" key={s.id}>
            <span className="compare-map-title">
              {s.name} · r{s.revision}
            </span>
            <Suspense fallback={<span>Loading city…</span>}>
              <CompareMap
                place={place}
                scenario={s}
                selectedId={null}
                onSelect={noSelection}
                view="3d"
                playing={false}
                speed={1}
                timeOfDay={15}
                layers={comparisonLayers}
                floodDatasets={project.floodDatasets}
                camera={camera}
                onCameraChange={setCamera}
              />
            </Suspense>
          </div>
        ))}
      </div>
      {new Set(scenarios.map((s) => s.horizon)).size > 1 && (
        <div className="notice">
          These scenarios use different forecast horizons. Interpret their
          differences with care.
        </div>
      )}
      {calculation.updating && (
        <p role="status">Calculating this comparison…</p>
      )}
      {calculation.error && (
        <p role="alert">Comparison unavailable: {calculation.error}</p>
      )}
      <div
        className="table-scroll comparison-table"
        aria-busy={calculation.updating}
      >
        <table>
          <thead>
            <tr>
              <th>Outcome</th>
              {scenarios.map((s) => (
                <th key={s.id}>
                  {s.name}
                  <small>
                    {s.horizon || "Current"} {s.horizon ? "years" : ""}
                  </small>
                  {s.flood && (
                    <small>Flood method · {floodMethodVersion(s.flood)}</small>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.label}</strong>
                  <small>
                    {m.domain} · {m.unit}
                  </small>
                </td>
                {results.map((r, i) => {
                  if (
                    m.id === "environment.flood" &&
                    scenarios[i].id === "baseline" &&
                    noCommonFloodBaseline
                  )
                    return (
                      <td key={i}>
                        Not comparable
                        <small>No common flood source and method</small>
                      </td>
                    );
                  const val = r.metrics.find((x) => x.id === m.id)!;
                  return (
                    <td key={i}>
                      {formatMetric(val.value, val.unit)}
                      {val.status !== "ready" && <small>{val.status}</small>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
export function ExportDialog({
  place,
  project,
  scenario,
  results,
  floodResolution,
  onClose,
  capture,
  cloudVersion,
  onSave,
  hasUnsavedChanges = false,
  onEditDescription,
  canEditDescription = false,
  canProcessGis = false,
  gisAccountScope,
  onRequireGisAccount,
  onGisAccessError,
  onOpenMedia,
}: {
  place: Place;
  project: Project;
  scenario: Scenario;
  results: ModelResults;
  floodResolution: FloodResolution | null;
  onClose: () => void;
  capture: () => Promise<string | undefined>;
  cloudVersion: number | null;
  hasUnsavedChanges?: boolean;
  onEditDescription?: () => void;
  canEditDescription?: boolean;
  canProcessGis?: boolean;
  gisAccountScope?: string;
  onRequireGisAccount?: () => void;
  onGisAccessError?: () => void;
  onOpenMedia?: (format: "png" | "mp4") => void;
  onSave: () => Promise<{ projectId: string; version: number } | null>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function run(kind: string, action: () => Promise<void> | void) {
    setBusy(kind);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const exportScope = useRef({
    place,
    scenario,
    catalog: project.floodDatasets,
    fiscalStudy: project.fiscalStudy,
    housingIncomeLimits: project.housingIncomeLimits,
  });
  const exportLive = useRef(true);
  useEffect(() => {
    exportLive.current = true;
    return () => {
      exportLive.current = false;
    };
  }, []);
  exportScope.current = {
    place,
    scenario,
    catalog: project.floodDatasets,
    fiscalStudy: project.fiscalStudy,
    housingIncomeLimits: project.housingIncomeLimits,
  };
  function checkExportScope() {
    if (
      !exportLive.current ||
      exportScope.current.place !== place ||
      exportScope.current.scenario !== scenario ||
      exportScope.current.catalog !== project.floodDatasets ||
      exportScope.current.fiscalStudy !== project.fiscalStudy ||
      exportScope.current.housingIncomeLimits !== project.housingIncomeLimits
    )
      throw new Error(
        "The scenario changed while preparing the export. Please export the current revision again.",
      );
  }
  async function serverExport(format: string) {
    const saved =
      cloudVersion !== null && !hasUnsavedChanges
        ? { projectId: project.id, version: cloudVersion }
        : await onSave();
    if (saved === null)
      throw new Error(
        "Create a free account and save your project to generate this document.",
      );
    const response = await fetch(
      `/api/v1/projects/${saved.projectId}/exports?format=${format}&scenarioId=${scenario.id}&revision=${scenario.revision}&version=${saved.version}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.message || data.error?.message || "Export failed");
    }
    download(
      `urban-planning-${scenario.name}${format === "records" ? "-records.json" : format === "workforce-csv" ? "-workforce.csv" : format === "accessibility-csv" ? "-jobs-accessibility.csv" : format === "traffic-csv" ? "-traffic.csv" : format === "fiscal-csv" ? "-fiscal.csv" : `.${format}`}`,
      await response.blob(),
    );
  }
  return (
    <Modal
      title="Take the story with you."
      description={`${scenario.name} · Revision ${scenario.revision} · All exports are free.`}
      open
      onClose={onClose}
    >
      <div className="report-export-summary">
        <div>
          <FileText size={20} aria-hidden="true" />
          <h3>A report with the evidence attached.</h3>
        </div>
        <p>
          PDF and Word include a decision brief, matched before-and-after plan
          maps, the scorecard, and a methods and assumptions appendix.
        </p>
        {scenario.description && (
          <p className="report-description-preview">{scenario.description}</p>
        )}
        {onEditDescription && (
          <button
            className="button small"
            disabled={!!busy}
            onClick={onEditDescription}
          >
            {canEditDescription ? "Edit proposal notes" : "Read proposal notes"}
          </button>
        )}
        {hasUnsavedChanges && (
          <p className="small">
            Your current changes will be saved before the report is created.
          </p>
        )}
      </div>
      <ShapefileExport
        scenario={scenario}
        canProcess={canProcessGis}
        accountScope={gisAccountScope}
        onSave={onSave}
        onRequireAccount={onRequireGisAccount}
        onAccessError={onGisAccessError}
      />
      <div className="export-options">
        {onOpenMedia && (
          <>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => onOpenMedia("png")}
            >
              <Image size={24} />
              <div>
                <strong>High-resolution still · PNG</strong>
                <span>
                  Exact 1920 or 3840 pixel output from a saved 3D scene
                </span>
              </div>
              <Download size={16} />
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => onOpenMedia("mp4")}
            >
              <Image size={24} />
              <div>
                <strong>Tour fly-through · MP4</strong>
                <span>
                  Every saved tour stop · captions, full transcript · no audio
                </span>
              </div>
              <Download size={16} />
            </button>
          </>
        )}
        <button
          disabled={!!busy}
          onClick={() => run("pdf", () => serverExport("pdf"))}
        >
          <FileText size={24} />
          <div>
            <strong>Staff report · PDF</strong>
            <span>
              Decision brief, before / after maps, scorecard & evidence
            </span>
          </div>
          {busy === "pdf" ? (
            <Loader2 className="spin" size={18} />
          ) : (
            <Download size={16} />
          )}
        </button>
        <button
          disabled={!!busy}
          onClick={() => run("docx", () => serverExport("docx"))}
        >
          <FileText size={24} />
          <div>
            <strong>Editable report · Word</strong>
            <span>The same evidence in an editable team document</span>
          </div>
          {busy === "docx" ? (
            <Loader2 className="spin" size={18} />
          ) : (
            <Download size={16} />
          )}
        </button>
        <button
          disabled={!!busy || (!!scenario.flood && !floodResolution)}
          onClick={() =>
            run("html", async () => {
              const image = await capture();
              const trafficStatus = await trafficExportStatus(place, scenario);
              checkExportScope();
              download(
                "urban-planning-report.html",
                reportHTML(
                  place,
                  scenario,
                  results,
                  image,
                  trafficStatus,
                  {
                    floodDatasets: project.floodDatasets,
                    fiscalStudy: project.fiscalStudy,
                    housingIncomeLimits: project.housingIncomeLimits,
                  },
                  floodResolution,
                ),
                "text/html",
              );
            })
          }
        >
          <FileText size={24} />
          <div>
            <strong>Browser report</strong>
            <span>Download, open, and print or save as PDF</span>
          </div>
          <Download size={16} />
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            run("image", async () => {
              const image = await capture();
              if (!image)
                throw new Error(
                  "Map capture is unavailable. Try again when the city has loaded.",
                );
              const response = await fetch(image);
              download("urban-planning-city.png", await response.blob());
            })
          }
        >
          <Image size={24} />
          <div>
            <strong>City view · PNG</strong>
            <span>Capture the current camera and scenario</span>
          </div>
          <Download size={16} />
        </button>
        <button
          disabled={!!busy}
          onClick={() => run("records", () => serverExport("records"))}
        >
          <FolderOpen size={24} />
          <div>
            <strong>Saved records · JSON</strong>
            <span>
              Saved proposal, review threads, access history, and audit records
            </span>
          </div>
          {busy === "records" ? (
            <Loader2 className="spin" size={18} />
          ) : (
            <Download size={16} />
          )}
        </button>
        <button
          disabled={!!busy}
          onClick={() => run("xlsx", () => serverExport("xlsx"))}
        >
          <FileText size={24} />
          <div>
            <strong>Analysis workbook · Excel</strong>
            <span>Metrics, methods, assumptions, and source tables</span>
          </div>
          <Download size={16} />
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            run("csv", () => exportCSV(results, { place, project, scenario }))
          }
        >
          <Download size={24} />
          <div>
            <strong>Scorecard · CSV</strong>
            <span>Every metric, status, and calculation method</span>
          </div>
          <ArrowRight size={16} />
        </button>
        {scenario.accessibility && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              run("accessibility-csv", async () => {
                if (cloudVersion !== null && !hasUnsavedChanges)
                  await serverExport("accessibility-csv");
                else
                  download(
                    `urban-planning-${scenario.name}-jobs-accessibility.csv`,
                    exportAccessibilityCSV(scenario),
                    "text/csv;charset=utf-8",
                  );
              })
            }
          >
            <Download size={24} />
            <div>
              <strong>Jobs accessibility · CSV</strong>
              <span>
                Captured outbound jobs, travel limits, coverage and sources
              </span>
            </div>
            <ArrowRight size={16} />
          </button>
        )}
        {scenario.workforce && (
          <button
            disabled={!!busy}
            onClick={() =>
              run("workforce-csv", () => serverExport("workforce-csv"))
            }
          >
            <Download size={24} />
            <div>
              <strong>Workforce evidence · CSV</strong>
              <span>
                Education and occupation, travel limits, uncertainty, and
                sources
              </span>
            </div>
            <ArrowRight size={16} />
          </button>
        )}
        {scenario.affordability && (
          <button
            type="button"
            disabled={!!busy || !results.affordability}
            onClick={() =>
              run("housing-csv", async () => {
                checkExportScope();
                if (cloudVersion !== null && !hasUnsavedChanges)
                  await serverExport("housing-csv");
                else exportHousingCSV(place, project, scenario, results);
              })
            }
          >
            <FileText size={24} />
            <div>
              <strong>Housing affordability · CSV</strong>
              <span>
                Complete unit groups, cost components, published limits,
                coverage and source evidence
              </span>
            </div>
            <ArrowRight size={16} />
          </button>
        )}
        {project.fiscalStudy && (
          <button
            type="button"
            disabled={!!busy || !results.fiscal}
            onClick={() =>
              run("fiscal-csv", async () => {
                checkExportScope();
                if (cloudVersion !== null && !hasUnsavedChanges)
                  await serverExport("fiscal-csv");
                else exportFiscalCSV(place, project, scenario, results);
              })
            }
          >
            <FileText size={24} />
            <div>
              <strong>Fiscal study · CSV</strong>
              <span>
                Annual baseline, same-development no-offer, with-offer,
                sensitivity cases and cited inputs
              </span>
            </div>
            {busy === "fiscal-csv" ? (
              <Loader2 className="spin" size={18} />
            ) : (
              <ArrowRight size={16} />
            )}
          </button>
        )}
        {scenario.traffic && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              run("traffic-csv", async () => {
                if (cloudVersion !== null && !hasUnsavedChanges)
                  await serverExport("traffic-csv");
                else
                  download(
                    `urban-planning-${scenario.name}-traffic.csv`,
                    await exportTrafficCSV(place, scenario),
                    "text/csv;charset=utf-8",
                  );
              })
            }
          >
            <Download size={24} />
            <div>
              <strong>Traffic evidence · CSV</strong>
              <span>
                Captured comparison, completion, count-fit status, and sources
              </span>
            </div>
            {busy === "traffic-csv" ? (
              <Loader2 className="spin" size={18} />
            ) : (
              <ArrowRight size={16} />
            )}
          </button>
        )}
        {scenario.flood && (
          <button
            disabled={!!busy || !floodResolution}
            onClick={() =>
              run("flood-csv", () => {
                checkExportScope();
                if (!floodResolution)
                  throw new Error("Wait for the current flood calculation.");
                exportFloodCSV(
                  place,
                  scenario,
                  {
                    floodDatasets: project.floodDatasets,
                    fiscalStudy: project.fiscalStudy,
                    housingIncomeLimits: project.housingIncomeLimits,
                  },
                  floodResolution,
                );
              })
            }
          >
            <FileText size={24} />
            <div>
              <strong>Flood exposure · CSV</strong>
              <span>
                Every baseline and proposal building, coverage, sources, and
                unknowns
              </span>
            </div>
            <Download size={16} />
          </button>
        )}
        <button
          onClick={() =>
            exportGeoJSON(place, scenario, {
              floodDatasets: project.floodDatasets,
              fiscalStudy: project.fiscalStudy,
              housingIncomeLimits: project.housingIncomeLimits,
            })
          }
        >
          <Layers size={24} />
          <div>
            <strong>Scenario geometry · GeoJSON</strong>
            <span>
              Buildings, streets, parcels, and blocks with source attribution
            </span>
          </div>
          <ArrowRight size={16} />
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            run("project", () => exportProject(project, place, results))
          }
        >
          <FolderOpen size={24} />
          <div>
            <strong>Complete project · JSON</strong>
            <span>Scenario history, source data, and results</span>
          </div>
          <ArrowRight size={16} />
        </button>
      </div>
      {busy && (
        <p className="report-export-status" role="status">
          <Loader2 className="spin" size={16} aria-hidden="true" />
          {busy === "pdf" || busy === "docx"
            ? "Preparing your saved proposal, comparison maps, and report…"
            : "Preparing your download…"}
        </p>
      )}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      <div className="tip">
        <LockKeyhole size={15} />
        <span>
          Cloud document exports require a free account. Browser exports work
          immediately.
        </span>
      </div>
    </Modal>
  );
}
export function ShareDialog({
  project,
  scenario,
  onSave,
  onClose,
}: {
  project: Project;
  scenario: Scenario;
  onSave: () => Promise<{ projectId: string; version: number } | null>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [engagement, setEngagement] = useState(defaultEngagement);
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title="A shared vision starts here."
      description="Publish an immutable, read-only snapshot. Later edits stay private."
      open
      onClose={onClose}
    >
      <div className="share-preview">
        <Globe2 size={35} />
        <div>
          <h3>{scenario.name}</h3>
          <p>
            {project.name} · Revision {scenario.revision}
          </p>
        </div>
      </div>
      <label className="check-row">
        <span>Collect public feedback</span>
        <input
          type="checkbox"
          disabled={busy || !!url}
          checked={feedback}
          onChange={(e) => setFeedback(e.target.checked)}
        />
      </label>
      {feedback && (
        <PublishEngagementConfig
          value={engagement}
          onChange={setEngagement}
          disabled={busy || !!url}
        />
      )}
      {url ? (
        <>
          <label className="field">
            <span>Published link</span>
            <input readOnly value={url} />
          </label>
          <button
            className="button primary full-width"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              } catch {
                setError(
                  "Copying was unavailable. Select and copy the published link above.",
                );
              }
            }}
          >
            {copied ? <Check size={16} /> : <Link2 size={16} />}{" "}
            {copied ? "Copied" : "Copy link"}
          </button>
        </>
      ) : (
        <button
          className="button primary full-width"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const config = feedback
                ? cleanEngagement(engagement)
                : disabledEngagement();
              const invalid = validateEngagement(config);
              if (invalid) throw new Error(invalid);
              if (
                feedback &&
                !config.comments &&
                !config.votes &&
                !config.pins &&
                !config.questions.length
              )
                throw new Error(
                  "Choose a feedback method or add a survey question.",
                );
              const saved = await onSave();
              if (saved === null)
                throw new Error(
                  "Sign in to your free account to publish a snapshot.",
                );
              const result = await api<{ url: string }>(
                `/projects/${saved.projectId}/publish`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    scenarioId: scenario.id,
                    expectedRevision: scenario.revision,
                    feedbackEnabled: feedback,
                    engagement: config,
                  }),
                },
              );
              setUrl(new URL(result.url, window.location.origin).href);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <Globe2 size={16} />}{" "}
          Publish scenario
        </button>
      )}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      <p className="muted small">
        Published content includes the selected scenario, model assumptions, and
        source disclosures. Review these before publishing.
      </p>
    </Modal>
  );
}
