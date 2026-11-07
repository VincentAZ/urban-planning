import {
  HousingAffordabilityPanel,
  HousingEvidenceSources,
} from "./components/housing/HousingOverview";
import { FiscalProfileEvidence } from "./components/fiscal/FiscalOverview";
import { fiscalApi } from "./lib/fiscal-api";
import { useVehicleTracks } from "./lib/vehicle-tracks";
import { createFiscalStudyInWorker } from "./lib/fiscal-task";
import { FloodPanel, FloodSources } from "./components/flood/FloodEvidence";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Building2,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Clock3,
  Cloud,
  Download,
  Eye,
  Factory,
  FileText,
  GitBranch,
  Globe2,
  History,
  Home,
  Layers3,
  Leaf,
  Lightbulb,
  Loader2,
  Map as MapIcon,
  MapPin,
  Maximize2,
  MessageSquare,
  Minus,
  MoreHorizontal,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Redo2,
  Route,
  Search,
  Settings2,
  Share2,
  SlidersHorizontal,
  Sparkles,
  ShieldCheck,
  Sun,
  Undo2,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  buildingTypologyLabels,
  buildingAnchor,
  type BuildingTypology,
  pointInStudyArea,
  studyAreaAnchor,
  landUseLabels,
  materializeBuildings,
  materializeRoads,
  roadPreset,
  validateRoadEdit,
  USER_ROAD_SOURCE,
  type BaselineIdentity,
  type ProjectSnapshot,
  type LandUse,
  type MetricDomain,
  type MetricResult,
  type Place,
  type Position,
  type Project,
  type Scenario,
  type Road,
  type WorkforceRequest,
  type AccessibilityRequest,
} from "@urban/core";
import { createProject, formatMetric } from "@urban/models";
import { api, ApiError, download, type Session } from "./lib/api";
import {
  identityBootstrap,
  watchIdentityLinks,
  type IdentityLanding,
} from "./lib/identity-intent";
import {
  identityError,
  type IdentityInvitationAccepted,
} from "./lib/identity-api";
import { AccountSecurityDialog } from "./components/identity/AccountSecurityDialog";
import { IdentityTokenDialog } from "./components/identity/IdentityTokenDialog";
import { useWorkspace } from "./lib/workspace";
import {
  writeWorkspace,
  listWorkspaceDrafts,
  readWorkspaceDraft,
  type BrowserDraftSummary,
  type WorkspaceSnapshot,
} from "./lib/workspace-storage";
import {
  projectRevisionKey,
  type CloudProjectLink,
} from "./lib/cloud-workspace";
import { useProjectAccess } from "./lib/useProjectAccess";
import type {
  ProjectAccess,
  ReviewComment,
  ReviewCommentsResponse,
  ReviewTarget,
} from "../../../packages/core/src/collaboration";
import { TeamDialog } from "./components/TeamDialog";
import { ReviewDialog } from "./components/ReviewDialog";
import { ScenarioDetailsDialog } from "./components/ScenarioDetailsDialog";
import { EngagementDialog } from "./components/EngagementDialog";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { useImpact } from "./lib/useImpact";
import { PresentationDialog } from "./components/presentation/PresentationDialog";
import type { PresentationCamera } from "@urban/core";
import { Modal } from "./components/Modal";
import { ImportWizard } from "./components/ImportWizard";
import { BudgetDialog } from "./components/BudgetDialog";
import { budgetAdministratorScope } from "./lib/budget-dialog";
import { PlaceSearchDialog } from "./components/PlaceSearchDialog";
import { CommunityContext } from "./components/CommunityContext";
import { MetricDetail } from "./components/MetricDetail";
import { StreetBrowser, StreetDraftEditor } from "./components/StreetEditor";
import {
  ParcelBrowser,
  ParcelDraftEditor,
  ParcelInspector,
} from "./components/ParcelEditor";
import { ActivityPanel } from "./components/activity/ActivityPanel";
import { useActivityEditor } from "./components/activity/useActivityEditor";
import { countLabel } from "./components/activity/ActivitySummary";
import { RetailDialog } from "./components/retail/RetailDialog";
import { WorkforceDialog } from "./components/workforce/WorkforceDialog";
import { WorkforceSources } from "./components/workforce/WorkforceOverview";
import {
  AccessibilityPanel,
  AccessibilitySources,
} from "./components/accessibility/AccessibilityOverview";
import { TrafficPanel } from "./components/traffic/TrafficEntry";
import { TrafficSources } from "./components/traffic/TrafficOverview";
import {
  planningSources,
  housingSources,
  housingSourceInventory,
} from "./lib/source-inventory";
import { useParcelEditor } from "./lib/useParcelEditor";
import { useBuildingEditor } from "./lib/useBuildingEditor";
import { activeBuildingPath } from "./lib/building-draft";
import {
  BuildingDraftEditor,
  BuildingInspector,
} from "./components/BuildingEditor";
import { activeParcelPath } from "./lib/parcel-draft";
import {
  changeStreetDraft,
  undoStreetDraft,
  redoStreetDraft,
  type StreetDraft,
  type StreetDraftValue,
} from "./lib/street-draft";
import {
  AssumptionsEditor,
  BuildingLibrary,
  EconomyPanel,
  RoadEditor,
} from "./components/Editors";
import {
  AuthDialog,
  CompareDialog,
  ExportDialog,
  ShareDialog,
} from "./components/Dialogs";

const HousingAffordabilityDialog = lazy(() =>
  import("./components/housing/HousingAffordabilityDialog").then((m) => ({
    default: m.HousingAffordabilityDialog,
  })),
);
const FiscalDialog = lazy(() =>
  import("./components/fiscal/FiscalDialog").then((module) => ({
    default: module.FiscalDialog,
  })),
);
const FloodDialog = lazy(() =>
  import("./components/flood/FloodDialog").then((m) => ({
    default: m.FloodDialog,
  })),
);
const AccessibilityDialog = lazy(() =>
  import("./components/accessibility/AccessibilityDialog").then((module) => ({
    default: module.AccessibilityDialog,
  })),
);
const CityMap = lazy(() => import("./components/CityMap"));
const MediaExportDialog = lazy(() =>
  import("./components/media/MediaExportDialog").then((module) => ({
    default: module.MediaExportDialog,
  })),
);
const TrafficWorkspace = lazy(
  () => import("./components/traffic/TrafficWorkspace"),
);
const domains: MetricDomain[] = [
  "Housing",
  "Mobility",
  "Economy",
  "Fiscal",
  "Land & form",
  "Access & equity",
  "Environment",
  "Safety",
];
const tools = [
  { id: "explore", label: "Explore", icon: MousePointer2 },
  { id: "build", label: "Build", icon: Building2 },
  { id: "mobility", label: "Mobility", icon: Route },
  { id: "parcels", label: "Parcels", icon: MapIcon },
  { id: "economy", label: "Economy", icon: Factory },
  { id: "people", label: "People", icon: Users },
  { id: "layers", label: "Layers", icon: Layers3 },
] as const;
type Tool = (typeof tools)[number]["id"];
type Dialog =
  | "search"
  | "auth"
  | "account-security"
  | "identity"
  | "identity-accepted"
  | "password-updated"
  | "assumptions"
  | "scenario-details"
  | "engagement"
  | "compare"
  | "presentation"
  | "fiscal"
  | "housing"
  | "retail"
  | "workforce"
  | "flood"
  | "accessibility"
  | "traffic"
  | "export"
  | "media"
  | "share"
  | "sources"
  | "history"
  | "assistant"
  | "projects"
  | "team"
  | "review"
  | "import"
  | "budget"
  | null;
const priorityIds = [
  "housing.units",
  "economy.jobs",
  "mobility.dailyTrips",
  "fiscal.netAnnual",
];
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>
        urban<span className="brand-light">planning</span>
        <span className="brand-period">.</span>
      </span>
    </span>
  );
}

export default function App() {
  const {
    place,
    project,
    selectedId,
    initialize,
    reset,
    select,
    dispatch,
    attachFlood,
    applyAffordability,
    updateFloodMethod,
    undo,
    redo,
    activate,
    branch,
    replace,
    restoreCopy,
    storageError,
    storagePending,
    baselineIdentity,
    legacyDraft,
    resolveLegacy,
    cloudLink,
    linkCloud,
    adoptCloudSave,
    readOnly,
    readOnlyReason,
    setReadOnly,
    setActorName,
  } = useWorkspace();
  const [loadError, setLoadError] = useState("");
  const [tool, setTool] = useState<Tool>("explore");
  const [identityLanding, setIdentityLanding] = useState<IdentityLanding>(
    identityBootstrap.read,
  );
  const [identityReviewEpoch, setIdentityReviewEpoch] = useState(0);
  const [dialog, setDialogState] = useState<Dialog>(() =>
    identityBootstrap.read().kind === "none" ? null : "identity",
  );
  const [authInitialMode, setAuthInitialMode] = useState<"register" | "login">(
    "register",
  );
  const [authInitialEmail, setAuthInitialEmail] = useState("");
  const identityAuthReturn = useRef<"identity" | "account-security" | null>(
    null,
  );
  const securityReturn = useRef<Dialog>(null);
  const [identityAccepted, setIdentityAccepted] = useState<{
    userId: string;
    result: IdentityInvitationAccepted;
  } | null>(null);
  const [identitySwitch, setIdentitySwitch] = useState<{
    busy: boolean;
    error: string;
    email?: string;
  } | null>(null);
  const identitySwitchRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    identityBootstrap.forget();
    const stop = watchIdentityLinks(window, (landing) => {
      identitySwitchRequest.current?.abort();
      identitySwitchRequest.current = null;
      identityAuthReturn.current = null;
      securityReturn.current = null;
      setIdentitySwitch(null);
      setIdentityAccepted(null);
      setIdentityLanding(landing);
      setIdentityReviewEpoch((value) => value + 1);
      setDialogState("identity");
    });
    return () => {
      stop();
      identitySwitchRequest.current?.abort();
    };
  }, []);
  const [accessibilitySite, setAccessibilitySite] = useState<{
    position: Position;
    label: string;
  }>();
  const [accessibilityRequest, setAccessibilityRequest] =
    useState<AccessibilityRequest>();
  const accessibilityAuthReturn = useRef<{
    projectId: string;
    scenarioId: string;
  } | null>(null);
  const [workforceSite, setWorkforceSite] = useState<{
    position: Position;
    label: string;
  }>();
  const [workforceRequest, setWorkforceRequest] = useState<WorkforceRequest>();
  const trafficAuthReturn = useRef<{
    projectId: string;
    scenarioId: string;
  } | null>(null);
  const mediaAuthReturn = useRef<{
    projectId: string;
    scenarioId: string;
  } | null>(null);
  const [mediaFormat, setMediaFormat] = useState<"png" | "mp4">("png");
  const workforceAuthReturn = useRef<{
    projectId: string;
    scenarioId: string;
  } | null>(null);
  const [streetDraftState, setStreetDraftState] = useState<StreetDraft | null>(
    null,
  );
  const [metricState, setMetricState] = useState<{
    scope: string;
    value: MetricResult;
  } | null>(null);
  const [view, setView] = useState<"3d" | "2d" | "satellite">("3d");
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [timeOfDay, setTimeOfDay] = useState(15);
  const [layers, setLayers] = useState<string[]>([
    "buildings",
    "roads",
    "parks",
    "parcels",
    "agents",
    "flood",
  ]);
  const [placing, setPlacing] = useState<BuildingTypology | null>(null);
  const [domain, setDomain] = useState<MetricDomain | "Overview">("Overview");
  const [persona, setPersona] = useState<"planner" | "economy">("planner");
  const [session, setSessionState] = useState<Session>({ user: null });
  const [budgetOpenedFor, setBudgetOpenedFor] = useState<string | null>(null);
  const budgetAccountId = budgetAdministratorScope(session);
  const budgetVisible =
    dialog === "budget" &&
    budgetAccountId !== null &&
    budgetOpenedFor === budgetAccountId;
  useEffect(() => {
    if (dialog === "budget" && !budgetVisible) {
      setDialogState(null);
      setBudgetOpenedFor(null);
    }
  }, [dialog, budgetVisible]);
  const [authPending, setAuthPending] = useState(true);
  const sessionGeneration = useRef(0);
  const sessionRead = useRef<AbortController | null>(null);
  const sessionLive = useRef(session);
  sessionLive.current = session;
  const setSession = useCallback((next: Session) => {
    sessionGeneration.current++;
    sessionRead.current?.abort();
    sessionRead.current = null;
    sessionLive.current = next;
    setSessionState(next);
    setAuthPending(false);
  }, []);
  const [accessActionError, setAccessActionError] = useState("");
  const [openingExample, setOpeningExample] = useState(false);
  useEffect(() => {
    setActorName(session.user?.name ?? "Anonymous browser");
  }, [session.user?.name, setActorName]);
  const cloudVersion = cloudLink?.version ?? null;
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  // A previous workspace notice should not cover the next dialog's controls.
  useEffect(() => {
    if (dialog) setToast("");
  }, [dialog]);
  const [showBaseline, setShowBaseline] = useState(false);
  const [revealPercent, setRevealPercent] = useState(50);
  const [featureQuery, setFeatureQuery] = useState("");
  const [newScenarioName, setNewScenarioName] = useState("");
  const [scenarioDialog, setScenarioDialog] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget>({
    kind: "project",
  });
  const [reviewTargetLabel, setReviewTargetLabel] = useState(
    "Scenario discussion",
  );
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const reviewGeneration = useRef(0);
  const updateReviewComments = useCallback((comments: ReviewComment[]) => {
    ++reviewGeneration.current;
    setReviewComments(comments);
  }, []);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [selectingCommentLocation, setSelectingCommentLocation] =
    useState(false);
  const [focusLocation, setFocusLocation] = useState<{
    position: Position;
    requestId: string;
  }>();
  const [pendingMetricId, setPendingMetricId] = useState<string | null>(null);
  const workspaceContext = `${project?.id}:${session.user?.id}:${session.organization?.id}`;
  const workspaceContextRef = useRef(workspaceContext);
  workspaceContextRef.current = workspaceContext;
  const projectAccess = useProjectAccess(cloudLink, session);
  useEffect(() => {
    if (projectAccess.status === 401) setSession({ user: null });
  }, [projectAccess.status]);
  const projectReadOnly = readOnly || projectAccess.readOnly;
  const canViewCurrent = !cloudLink || !!projectAccess.access;
  const authorizedPlace = canViewCurrent ? place : null;
  const metricScope = `${project?.id}:${project?.activeScenarioId}:${session.user?.id}:${session.organization?.id}`;
  const metric =
    canViewCurrent && metricState?.scope === metricScope
      ? metricState.value
      : null;
  function setMetric(value: MetricResult | null) {
    setMetricState(value ? { scope: metricScope, value } : null);
  }
  const canCreateInWorkspace =
    !session.user ||
    (session.membershipScope !== "project-only" &&
      (session.role === undefined ||
        session.role === "owner" ||
        session.role === "editor"));
  const hasUnsavedChanges = !!(
    project &&
    cloudLink &&
    projectRevisionKey(project) !== cloudLink.savedRevision
  );
  useEffect(() => {
    setReadOnly(projectAccess.readOnly, projectAccess.reason);
    if (projectAccess.readOnly) setPlacing(null);
  }, [projectAccess.readOnly, projectAccess.reason, setReadOnly]);
  useEffect(() => {
    setReviewComments([]);
    setMetricState(null);
    setPendingMetricId(null);
    setFeatureQuery("");
    setShowBaseline(false);
    setFocusLocation(undefined);
    setScenarioDialog(false);
    setSelectedReviewId(null);
    setSelectingCommentLocation(false);
    setReviewTarget({ kind: "project" });
    setReviewTargetLabel("Scenario discussion");
  }, [project?.id, session.user?.id, session.organization?.id, canViewCurrent]);
  const captureRef = useRef<(() => Promise<string>) | null>(null);
  const presentationCameraRef = useRef<
    (() => PresentationCamera | null) | null
  >(null);
  const scenario = project?.scenarios.find(
    (s) => s.id === project.activeScenarioId,
  );
  const baseline = project?.scenarios.find((s) => s.id === "baseline");
  const vehicleTracks = useVehicleTracks(scenario?.traffic);
  // Match the clock to the simulated morning peak when a run loads.
  useEffect(() => {
    if (vehicleTracks) setTimeOfDay(8);
  }, [vehicleTracks]);
  const modelContext = useMemo(
    () => ({
      floodDatasets: project?.floodDatasets,
      fiscalStudy: project?.fiscalStudy,
      housingIncomeLimits: project?.housingIncomeLimits,
    }),
    [
      project?.floodDatasets,
      project?.fiscalStudy,
      project?.housingIncomeLimits,
    ],
  );
  const {
    results,
    flood: floodResolution,
    updating,
    error: calculationError,
  } = useImpact(
    authorizedPlace,
    canViewCurrent ? scenario : undefined,
    modelContext,
  );
  const buildings = useMemo(
    () =>
      authorizedPlace && scenario
        ? materializeBuildings(authorizedPlace, scenario)
        : [],
    [authorizedPlace, scenario],
  );
  const roads = useMemo(
    () =>
      authorizedPlace && scenario
        ? materializeRoads(authorizedPlace, scenario)
        : [],
    [authorizedPlace, scenario],
  );
  const selectedBuilding = buildings.find((b) => b.id === selectedId);
  const selectedRoad = roads.find((r) => r.id === selectedId);
  const streetScope =
    project && scenario
      ? `${project.id}:${scenario.id}:${scenario.revision}`
      : "";
  const streetDraft =
    streetDraftState?.scope === streetScope &&
    !projectReadOnly &&
    canViewCurrent
      ? streetDraftState
      : null;
  const parcelEditor = useParcelEditor({
    place: canViewCurrent ? place : null,
    project: canViewCurrent ? project : null,
    scenario: canViewCurrent ? scenario : undefined,
    editable:
      !!scenario &&
      scenario.id !== "baseline" &&
      !projectReadOnly &&
      canViewCurrent &&
      !streetDraft,
    onToast: setToast,
    onStart: () => {
      setPlacing(null);
      setSelectingCommentLocation(false);
      setShowBaseline(false);
      setView("2d");
      setTool("parcels");
      select(null);
      setLayers((current) =>
        current.includes("parcels") ? current : [...current, "parcels"],
      );
    },
  });
  const buildingEditor = useBuildingEditor({
    place: canViewCurrent ? place : null,
    project: canViewCurrent ? project : null,
    scenario: canViewCurrent ? scenario : undefined,
    editable:
      !!scenario &&
      scenario.id !== "baseline" &&
      !projectReadOnly &&
      canViewCurrent &&
      !streetDraft &&
      !parcelEditor.draft,
    onToast: setToast,
    onSelect: select,
    onStart: (section) => {
      setPlacing(null);
      setSelectingCommentLocation(false);
      setShowBaseline(false);
      setTool("build");
      if (section === "footprint") setView("2d");
      setLayers((current) => [...new Set([...current, "buildings", "parks"])]);
    },
  });
  const activityEditor = useActivityEditor({
    enabled: tool === "people",
    place: authorizedPlace,
    project: canViewCurrent ? project : null,
    scenario: canViewCurrent ? scenario : undefined,
    editable:
      !!scenario &&
      scenario.id !== "baseline" &&
      !projectReadOnly &&
      canViewCurrent &&
      !streetDraft &&
      !parcelEditor.draft &&
      !buildingEditor.draft,
    onToast: setToast,
    onStart: () => {
      setPlacing(null);
      setSelectingCommentLocation(false);
      setShowBaseline(false);
      setView("2d");
      setTool("people");
      select(null);
      setLayers((current) =>
        current.includes("neighborhoods")
          ? current
          : [...current, "neighborhoods"],
      );
    },
  });
  const geometryDraft =
    streetDraft ||
    parcelEditor.draft ||
    buildingEditor.draft ||
    activityEditor.draft;
  const localChangesAtRisk =
    !!geometryDraft || storagePending || !!storageError;
  useEffect(() => {
    if (!localChangesAtRisk) return;
    const protectLocalChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectLocalChanges);
    return () =>
      window.removeEventListener("beforeunload", protectLocalChanges);
  }, [localChangesAtRisk]);
  function setDialog(value: Dialog) {
    if (
      value &&
      geometryDraft &&
      !["sources", "history", "budget"].includes(value)
    ) {
      setToast("Apply or discard the draft before leaving the editor.");
      return;
    }
    if (value === "auth") {
      setAuthInitialMode("register");
      setAuthInitialEmail("");
    }
    if (value === "budget") {
      const scope = budgetAdministratorScope(sessionLive.current);
      if (!scope) return;
      setBudgetOpenedFor(scope);
    }
    setDialogState(value);
  }
  function openAccessibility(site?: { position: Position; label: string }) {
    setAccessibilityRequest(undefined);
    setAccessibilitySite(site);
    setDialog("accessibility");
  }
  function openAccountSecurity(returnTo: Dialog = null) {
    securityReturn.current = returnTo;
    setDialog("account-security");
  }
  function dismissIdentity() {
    setIdentityLanding({ kind: "none" });
    identityAuthReturn.current = null;
    setDialogState(null);
  }
  async function signInForIdentity(email?: string) {
    if (identitySwitchRequest.current) return;
    identityAuthReturn.current =
      dialog === "account-security"
        ? "account-security"
        : identityLanding.kind === "intent"
          ? "identity"
          : null;
    setAuthInitialMode("login");
    setAuthInitialEmail(email ?? "");
    if (!sessionLive.current.user) {
      setDialogState("auth");
      return;
    }
    const originalUserId = sessionLive.current.user.id;
    const controller = new AbortController();
    identitySwitchRequest.current = controller;
    sessionGeneration.current++;
    sessionRead.current?.abort();
    setIdentitySwitch({ busy: true, error: "", email });
    try {
      try {
        await api("/auth/logout", {
          method: "POST",
          signal: controller.signal,
        });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }
      if (controller.signal.aborted) return;
      if (
        sessionLive.current.user &&
        sessionLive.current.user.id !== originalUserId
      )
        throw new Error("Account changed");
      setSession({ user: null });
      setIdentitySwitch(null);
      setDialogState("auth");
    } catch (error) {
      if (!controller.signal.aborted)
        setIdentitySwitch({ busy: false, error: identityError(error), email });
    } finally {
      if (identitySwitchRequest.current === controller)
        identitySwitchRequest.current = null;
    }
  }
  useEffect(() => {
    if (
      streetDraftState &&
      (streetDraftState.scope !== streetScope ||
        projectReadOnly ||
        !canViewCurrent)
    ) {
      setStreetDraftState(null);
      setToast(
        "Street drawing closed because the active scenario or editing access changed.",
      );
    }
  }, [streetDraftState, streetScope, projectReadOnly, canViewCurrent]);
  const metricList = results?.metrics || [];
  useEffect(() => {
    if (
      !canViewCurrent ||
      !pendingMetricId ||
      updating ||
      !results ||
      results.scenarioId !== scenario?.id
    )
      return;
    const found = results.metrics.find((item) => item.id === pendingMetricId);
    setPendingMetricId(null);
    if (found) setMetric(found);
    else
      setToast(
        "This metric is not available in the current model revision. The review thread retains its original target.",
      );
  }, [pendingMetricId, results, updating, scenario?.id, canViewCurrent]);
  useEffect(() => {
    const generation = ++reviewGeneration.current;
    setReviewComments([]);
    if (!cloudLink || !projectAccess.access || !scenario) return;
    const controller = new AbortController();
    api<ReviewCommentsResponse>(
      `/projects/${encodeURIComponent(cloudLink.projectId)}/comments?scenarioId=${encodeURIComponent(scenario.id)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (
          !controller.signal.aborted &&
          generation === reviewGeneration.current
        )
          setReviewComments(data.comments);
      })
      .catch(() => {}); // The review dialog provides a visible retry/error state.
    return () => controller.abort();
  }, [
    cloudLink?.projectId,
    scenario?.id,
    projectAccess.access?.role,
    projectAccess.error,
    session.organization?.id,
  ]);
  const priorityMetrics = (
    persona === "planner"
      ? priorityIds
      : [
          "economy.jobs",
          "economy.payroll",
          "fiscal.netAnnual",
          "mobility.dailyTrips",
        ]
  )
    .map((id) => metricList.find((m) => m.id === id))
    .filter((m): m is MetricResult => !!m);
  const visibleMetrics =
    domain === "Overview"
      ? priorityMetrics
      : metricList.filter((m) => m.domain === domain);
  useEffect(() => {
    const controller = new AbortController();
    initialize(async () => {
      const response = await fetch("/data/phoenix.json", {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error("The Phoenix data bundle could not be loaded.");
      return response.json();
    }).catch((e) => {
      if (e.name !== "AbortError") setLoadError(e.message);
    });
    return () => controller.abort();
  }, [initialize]);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (
        disposed ||
        document.visibilityState === "hidden" ||
        identitySwitchRequest.current ||
        (sessionRead.current && !sessionRead.current.signal.aborted)
      )
        return;
      const controller = new AbortController(),
        generation = sessionGeneration.current;
      sessionRead.current = controller;
      const valid = () =>
        !disposed &&
        !controller.signal.aborted &&
        generation === sessionGeneration.current;
      void api<Session>("/auth/session", {
        signal: controller.signal,
        cache: "no-store",
      })
        .then((next) => {
          if (valid()) {
            sessionLive.current = next;
            setSessionState(next);
          }
        })
        .catch((error) => {
          if (valid() && error instanceof ApiError && error.status === 401) {
            sessionLive.current = { user: null };
            setSessionState({ user: null });
          }
        })
        .finally(() => {
          if (sessionRead.current === controller) sessionRead.current = null;
          if (valid()) setAuthPending(false);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 30000);
    return () => {
      disposed = true;
      sessionRead.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.defaultPrevented ||
        dialog ||
        target.matches("input,textarea,select,[contenteditable]") ||
        target.closest('[role="dialog"]')
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (activityEditor.draft)
          e.shiftKey ? activityEditor.redo() : activityEditor.undo();
        else if (buildingEditor.draft)
          e.shiftKey ? buildingEditor.redo() : buildingEditor.undo();
        else if (parcelEditor.draft)
          e.shiftKey ? parcelEditor.redo() : parcelEditor.undo();
        else if (streetDraft)
          setStreetDraftState((current) =>
            current
              ? e.shiftKey
                ? redoStreetDraft(current)
                : undoStreetDraft(current)
              : current,
          );
        else e.shiftKey ? redo() : undo();
      }
      if (e.key === "Escape") {
        setPlacing(null);
        setSelectingCommentLocation(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("search");
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [
    redo,
    undo,
    streetDraft,
    parcelEditor,
    buildingEditor,
    activityEditor,
    select,
    dialog,
  ]);
  async function saveCloud(): Promise<{
    projectId: string;
    version: number;
  } | null> {
    if (!session.user) {
      setDialog("auth");
      return null;
    }
    if (!project || !place || !baselineIdentity) return null;
    if (
      (cloudLink && projectAccess.readOnly) ||
      (!cloudLink && !canCreateInWorkspace)
    )
      throw new Error(
        projectAccess.reason ||
          "Your workspace role cannot save new projects here. Choose your own workspace in project home.",
      );
    setSaving(true);
    try {
      const response = await api<{
        project: Project;
        version: number;
        baselineIdentity: BaselineIdentity;
        organizationId: string;
        access: ProjectAccess;
      }>(cloudVersion === null ? "/projects" : `/projects/${project.id}`, {
        method: cloudVersion === null ? "POST" : "PUT",
        body: JSON.stringify({
          project,
          expectedVersion: cloudVersion,
          baselineHash: baselineIdentity.sha256,
        }),
      });
      if (workspaceContextRef.current !== workspaceContext)
        throw new Error(
          "The project was saved, but your workspace changed. Reopen it from its workspace to continue.",
        );
      const connection: CloudProjectLink = {
        projectId: response.project.id,
        organizationId: response.organizationId,
        version: response.version,
        savedRevision: projectRevisionKey(response.project),
      };
      const current = useWorkspace.getState();
      if (current.project?.id === project.id) {
        // The save response is already an authenticated permission check.
        // Commit it before Zustand attaches the cloud link; otherwise the
        // first save briefly unmounts the publishing/export dialog.
        flushSync(() =>
          projectAccess.acceptVerifiedSave({
            projectId: response.project.id,
            organizationId: response.organizationId,
            version: response.version,
            access: response.access,
          }),
        );
        if (cloudVersion === null && response.project.id !== project.id)
          await adoptCloudSave(
            project.id,
            connection,
            response.baselineIdentity,
          );
        else await linkCloud(connection);
        projectAccess.refresh();
      }
      setToast("Project saved to your private workspace.");
      return { projectId: response.project.id, version: response.version };
    } catch (e) {
      setToast((e as Error).message);
      throw e;
    } finally {
      setSaving(false);
    }
  }
  function chooseTool(id: Tool) {
    if (geometryDraft) {
      setToast("Apply or discard the draft before changing tools.");
      return;
    }
    setTool(id);
    select(null);
    parcelEditor.select(null);
    activityEditor.select(null);
    setPlacing(null);
    if (id === "people")
      setLayers((current) =>
        current.includes("neighborhoods")
          ? current
          : [...current, "neighborhoods"],
      );
    if (id === "parcels")
      setLayers((current) =>
        current.includes("parcels") ? current : [...current, "parcels"],
      );
  }
  function startStreetDrawing(road?: Road) {
    if (parcelEditor.draft || buildingEditor.draft || activityEditor.draft) {
      setToast("Apply or discard the current draft before drawing a street.");
      return;
    }
    if (!project || !scenario || projectReadOnly) return;
    if (scenario.id === "baseline") {
      setScenarioDialog(true);
      setToast("Create an alternative before changing the baseline.");
      return;
    }
    setStreetDraftState({
      id: crypto.randomUUID(),
      scope: streetScope,
      original: road ?? null,
      value: {
        name: road?.name ?? "Proposed street",
        coordinates: road ? road.coordinates.map((point) => [...point]) : [],
      },
      mode: road ? "reshape" : "draw",
      selectedVertexIndex: road ? 0 : null,
      snapToRoads: true,
      coordinateText: "",
      past: [],
      future: [],
    });
    setPlacing(null);
    setSelectingCommentLocation(false);
    setShowBaseline(false);
    setView("2d");
    setTool("mobility");
    select(null);
    setLayers((current) =>
      current.includes("roads") ? current : [...current, "roads"],
    );
  }
  function updateStreetDrawing(value: StreetDraftValue) {
    setStreetDraftState((current) =>
      current && current.scope === streetScope
        ? changeStreetDraft(current, value)
        : current,
    );
  }
  function discardStreetDrawing() {
    select(streetDraft?.original?.id ?? null);
    setStreetDraftState(null);
  }
  function selectStreetPoint(index: number) {
    setStreetDraftState((current) =>
      current
        ? { ...current, mode: "reshape", selectedVertexIndex: index }
        : current,
    );
  }
  function removeStreetPoint(index: number) {
    setStreetDraftState((current) =>
      current
        ? {
            ...changeStreetDraft(current, {
              ...current.value,
              coordinates: current.value.coordinates.filter(
                (_, i) => i !== index,
              ),
            }),
            selectedVertexIndex: null,
          }
        : current,
    );
  }
  function applyStreetDrawing() {
    if (
      !streetDraft ||
      !place ||
      !scenario ||
      scenario.id === "baseline" ||
      projectReadOnly
    )
      return;
    if (streetDraft.coordinateText.trim()) {
      setToast(
        "Use or discard the coordinate text before applying the street.",
      );
      return;
    }
    if (!streetDraft.value.name.trim()) {
      setToast("Give the street a name before applying it.");
      return;
    }
    if (
      streetDraft.original &&
      streetDraft.value.name.trim() === streetDraft.original.name &&
      JSON.stringify(streetDraft.value.coordinates) ===
        JSON.stringify(streetDraft.original.coordinates)
    ) {
      setToast("Change the street name or path before applying it.");
      return;
    }
    let road: Road;
    try {
      road = streetDraft.original
        ? {
            ...streetDraft.original,
            ...streetDraft.value,
            name: streetDraft.value.name.trim(),
          }
        : roadPreset(streetDraft.value.coordinates, streetDraft.value.name);
      const check = validateRoadEdit(road, place);
      if (!check.valid) {
        setToast(check.error!);
        return;
      }
      const reshaped =
        !streetDraft.original ||
        JSON.stringify(road.coordinates) !==
          JSON.stringify(streetDraft.original.coordinates);
      road = {
        ...road,
        ...(reshaped ? { geometrySourceId: USER_ROAD_SOURCE.id } : {}),
        attributeSourceId: USER_ROAD_SOURCE.id,
        estimated: true,
      };
      if (reshaped) delete road.aadt;
      setStreetDraftState(null);
      dispatch(
        { type: "road.upsert", road, source: USER_ROAD_SOURCE },
        `${streetDraft.original ? "Reshape" : "Add"} ${road.name}`,
      );
      select(road.id);
      setToast(
        `${road.name} applied. You can adjust its settings or undo this edit.`,
      );
    } catch (error) {
      setToast((error as Error).message);
    }
  }
  function focusStreet(road: Road) {
    select(road.id);
    const position = road.coordinates[Math.floor(road.coordinates.length / 2)];
    if (position)
      setFocusLocation({ position, requestId: crypto.randomUUID() });
  }
  function startPlacement(use: LandUse | BuildingTypology, draw = false) {
    if (geometryDraft) {
      setToast("Apply or discard the draft before placing a building.");
      return;
    }
    if (projectReadOnly) {
      setToast(readOnlyReason || projectAccess.reason);
      return;
    }
    if (scenario?.id === "baseline") {
      setToast("Create an alternative before changing the baseline.");
      setScenarioDialog(true);
      return;
    }
    setShowBaseline(false);
    const typology: BuildingTypology =
      use === "residential"
        ? "house"
        : use === "multifamily"
          ? "apartments"
          : use;
    select(null);
    setTool("build");
    if (draw && place)
      buildingEditor.startNew(typology, studyAreaAnchor(place), true);
    else setPlacing(typology);
  }
  function placeBuilding(position: Position) {
    if (!placing || !place || projectReadOnly) return;
    buildingEditor.startNew(placing, position);
    setPlacing(null);
    setToast(
      "Review the building program and footprint, then Apply when it is ready.",
    );
  }

  async function capture() {
    return captureRef.current ? captureRef.current() : undefined;
  }
  function openReview(
    target: ReviewTarget = { kind: "project" },
    label = "Scenario discussion",
  ) {
    if (geometryDraft) {
      setToast("Apply or discard the draft before opening discussions.");
      return;
    }
    setReviewTarget(target);
    setReviewTargetLabel(label);
    setSelectedReviewId(null);
    setDialog("review");
  }
  function navigateReview(comment: ReviewComment) {
    if (!project?.scenarios.some((item) => item.id === comment.scenarioId)) {
      setToast(
        "This thread refers to a scenario that is no longer in the project. Its saved discussion remains available.",
      );
      return;
    }
    activate(comment.scenarioId);
    setDialog(null);
    setSelectedReviewId(comment.id);
    if (comment.targetPosition)
      setFocusLocation({
        position: comment.targetPosition,
        requestId: crypto.randomUUID(),
      });
    if (comment.target?.kind === "building") {
      select(comment.target.id);
      setTool("explore");
    }
    if (comment.target?.kind === "metric")
      setPendingMetricId(comment.target.id);
  }
  async function reopenSavedVersion() {
    if (geometryDraft) {
      setToast("Apply or discard the draft before reopening a saved version.");
      return;
    }
    if (!cloudLink || !project || !place || !baselineIdentity) return;
    const detail = await api<{
      project: Project;
      version: number;
      baseline: Place;
      baselineIdentity: BaselineIdentity;
      access: ProjectAccess;
    }>(`/projects/${encodeURIComponent(cloudLink.projectId)}`);
    if (workspaceContextRef.current !== workspaceContext)
      throw new Error(
        "Your project or workspace changed. Reopen the saved version from its workspace.",
      );
    const latest = useWorkspace.getState();
    const keepCopy = !!(
      latest.project &&
      latest.cloudLink &&
      projectRevisionKey(latest.project) !== latest.cloudLink.savedRevision
    );
    if (keepCopy && latest.project && latest.place && latest.baselineIdentity) {
      await restoreCopy({
        project: latest.project,
        place: latest.place,
        baselineIdentity: latest.baselineIdentity,
      });
    }
    await replace(detail.project, detail.baseline, detail.baselineIdentity, {
      projectId: detail.project.id,
      organizationId: cloudLink.organizationId,
      version: detail.version,
      savedRevision: projectRevisionKey(detail.project),
    });
    projectAccess.refresh();
    setToast(
      keepCopy
        ? "Your local edits are retained as a separate browser copy. The saved project is reopened."
        : "The latest saved version is reopened.",
    );
  }
  const projectsDialog = dialog === "projects" && project && (
    <ProjectsDialog
      session={session}
      project={project}
      canViewCurrent={canViewCurrent}
      canSave={
        !projectReadOnly &&
        (cloudLink ? !!projectAccess.access?.canEdit : canCreateInWorkspace)
      }
      onSession={setSession}
      onAccountSecurity={() => openAccountSecurity("projects")}
      onClose={() => setDialog(null)}
      onAuth={() => setDialog("auth")}
      onSave={saveCloud}
      onOpenBrowser={async (snapshot) => {
        await replace(
          snapshot.project,
          snapshot.place,
          snapshot.baselineIdentity,
          snapshot.cloudLink,
        );
        setShowBaseline(false);
        setDialog(null);
        setToast("Browser draft reopened.");
      }}
      onOpen={async (p, v, baselinePlace, identity, access) => {
        await replace(p, baselinePlace, identity, {
          projectId: p.id,
          organizationId: session.organization!.id,
          version: v,
          savedRevision: projectRevisionKey(p),
        });
        setReadOnly(
          !access.canEdit,
          `You have ${access.role} access to this project.`,
        );
        projectAccess.refresh();
        setDialog(null);
        setToast("Project reopened.");
      }}
    />
  );
  const authDialog = dialog === "auth" && (
    <AuthDialog
      key={identityReviewEpoch}
      initialMode={identityAuthReturn.current ? "login" : authInitialMode}
      initialEmail={authInitialEmail}
      onClose={() => {
        const identityReturn = identityAuthReturn.current;
        if (identityReturn) {
          identityAuthReturn.current = null;
          setDialogState(identityReturn);
          return;
        }
        const accessibilityPending = accessibilityAuthReturn.current;
        accessibilityAuthReturn.current = null;
        const trafficPending = trafficAuthReturn.current;
        trafficAuthReturn.current = null;
        const pending = workforceAuthReturn.current;
        workforceAuthReturn.current = null;
        const mediaPending = mediaAuthReturn.current;
        mediaAuthReturn.current = null;
        const current = useWorkspace.getState().project;
        setDialog(
          mediaPending &&
            current?.id === mediaPending.projectId &&
            current.activeScenarioId === mediaPending.scenarioId
            ? "media"
            : accessibilityPending &&
                current?.id === accessibilityPending.projectId &&
                current.activeScenarioId === accessibilityPending.scenarioId
              ? "accessibility"
              : trafficPending &&
                  current?.id === trafficPending.projectId &&
                  current.activeScenarioId === trafficPending.scenarioId
                ? "traffic"
                : pending &&
                    current?.id === pending.projectId &&
                    current.activeScenarioId === pending.scenarioId
                  ? "workforce"
                  : null,
        );
      }}
      onSession={(s) => {
        setSession(s);
        setToast("Your account is ready. Your browser draft is still here.");
      }}
    />
  );
  const identityOverlays = identitySwitch ? (
    <Modal
      title="Switching accounts"
      description="Your current browser draft is retained."
      open
      onClose={() => {
        if (!identitySwitch.busy) setIdentitySwitch(null);
      }}
    >
      <div className="identity-panel">
        {identitySwitch.busy ? (
          <p role="status">Signing out before opening another account…</p>
        ) : (
          <>
            <p role="alert" className="identity-error">
              {identitySwitch.error}
            </p>
            <div className="identity-actions">
              <button
                type="button"
                className="button primary"
                onClick={() => void signInForIdentity(identitySwitch.email)}
              >
                Retry sign out
              </button>
              <button
                type="button"
                className="button"
                onClick={() => setIdentitySwitch(null)}
              >
                Return to account review
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  ) : (
    <>
      {authDialog}
      {dialog === "account-security" && (
        <AccountSecurityDialog
          session={session}
          onSession={(next) => {
            setSession(next);
            if (!next.user) setDialogState("password-updated");
          }}
          onRequireSignIn={() => void signInForIdentity()}
          onClose={() => {
            const destination = securityReturn.current;
            securityReturn.current = null;
            setDialogState(
              destination === "identity" && identityLanding.kind === "intent"
                ? "identity"
                : destination === "team" && !canViewCurrent
                  ? null
                  : destination,
            );
          }}
        />
      )}
      {dialog === "identity" && identityLanding.kind === "invalid" && (
        <Modal
          title="This account link could not be opened."
          description="No account or project access was changed."
          open
          onClose={dismissIdentity}
        >
          <div className="identity-panel">
            <p role="alert">
              The link is incomplete or uses an unsupported format. Request a
              fresh link. The original link is not included in this message.
            </p>
            <div className="identity-actions">
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setIdentityLanding({ kind: "none" });
                  void signInForIdentity();
                }}
              >
                Sign in or recover your account
              </button>
              <button
                type="button"
                className="button"
                onClick={dismissIdentity}
              >
                Continue with current draft
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "identity" &&
        identityLanding.kind === "intent" &&
        (authPending ? (
          <Modal
            title="Checking your account"
            description="Opening this link has not submitted it."
            open
            onClose={dismissIdentity}
          >
            <p role="status">
              Checking the current sign-in before showing account actions…
            </p>
          </Modal>
        ) : (
          <IdentityTokenDialog
            key={identityReviewEpoch}
            intent={identityLanding.intent}
            session={session}
            onSession={(next) => {
              setSession(next);
              if (
                !next.user &&
                identityLanding.intent.kind === "password-reset"
              ) {
                setIdentityLanding({ kind: "none" });
                identityAuthReturn.current = null;
                setDialogState("password-updated");
              }
            }}
            onRequireSignIn={(email) => void signInForIdentity(email)}
            onAccountSecurity={() => openAccountSecurity("identity")}
            onClose={dismissIdentity}
            onAccepted={(result) => {
              const userId = sessionLive.current.user?.id;
              if (!userId) return;
              setIdentityAccepted({ userId, result });
              setIdentityLanding({ kind: "none" });
              identityAuthReturn.current = null;
              setDialogState("identity-accepted");
              projectAccess.refresh();
            }}
          />
        ))}
      {dialog === "password-updated" && (
        <Modal
          title="Password updated."
          description="All account sessions have been signed out."
          open
          onClose={() =>
            setDialogState(
              identityLanding.kind === "intent" ? "identity" : null,
            )
          }
        >
          <div className="identity-panel">
            <p role="status">
              Your password was changed and your projects were retained. Sign in
              normally with your new password. No new session has been created
              automatically.
            </p>
            <div className="identity-actions">
              <button
                type="button"
                className="button primary"
                onClick={() => void signInForIdentity()}
              >
                Sign in with your new password
              </button>
              <button
                type="button"
                className="button"
                onClick={() =>
                  setDialogState(
                    identityLanding.kind === "intent" ? "identity" : null,
                  )
                }
              >
                Keep current draft
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "identity-accepted" && (
        <Modal
          title="Invitation accepted."
          description="Your current draft stays in place."
          open
          onClose={() => {
            setIdentityAccepted(null);
            setDialogState(null);
          }}
        >
          <div className="identity-panel">
            {identityAccepted?.userId === session.user?.id ? (
              <>
                <p role="status">
                  Access was added. Your current project has not been opened,
                  replaced or moved to another workspace.
                </p>
                <p>
                  Choose a workspace explicitly, then use Project home to open a
                  shared project when you are ready.
                </p>
                <WorkspaceSwitcher session={session} onSession={setSession} />
                <div className="identity-actions">
                  {project && (
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => {
                        setIdentityAccepted(null);
                        setDialog("projects");
                      }}
                    >
                      Project home
                    </button>
                  )}
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setIdentityAccepted(null);
                      setDialogState(null);
                    }}
                  >
                    Keep current draft
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  Sign in to the account that accepted the invitation to review
                  its workspaces.
                </p>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setIdentityAccepted(null);
                    void signInForIdentity();
                  }}
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
  if (cloudLink && !canViewCurrent && project)
    return (
      <div className="boot-screen saved-access-gate">
        <Brand />
        <div className="saved-access-symbol">
          <ShieldCheck size={30} />
        </div>
        <h1>Saved project access</h1>
        <p role="status">
          {authPending ? "Checking your account access…" : projectAccess.reason}
        </p>
        <p className="muted small">
          Your browser draft is retained on this device. Sign in to the right
          workspace to reopen it, or explore a public example.
        </p>
        <div className="saved-access-actions">
          {!session.user && !authPending && (
            <button
              className="button primary"
              onClick={() => setDialog("auth")}
            >
              Sign in
            </button>
          )}
          <button
            className="button secondary"
            onClick={() => setDialog("projects")}
          >
            Project home
          </button>
          {session.user && (
            <button
              className="button secondary"
              onClick={projectAccess.refresh}
            >
              Refresh access
            </button>
          )}
          {session.user && (
            <button
              className="button secondary"
              onClick={() => openAccountSecurity()}
            >
              Account security
            </button>
          )}
          <button
            className="button text"
            disabled={openingExample}
            onClick={async () => {
              setOpeningExample(true);
              setAccessActionError("");
              try {
                await reset();
                setDialog(null);
                setMetric(null);
                setShowBaseline(false);
                setTool("explore");
              } catch (e) {
                setAccessActionError((e as Error).message);
              } finally {
                setOpeningExample(false);
              }
            }}
          >
            {openingExample ? "Opening example…" : "Explore public example"}
          </button>
        </div>
        {accessActionError && <p role="alert">{accessActionError}</p>}
        {identityOverlays}
        {projectsDialog}
      </div>
    );
  if (legacyDraft)
    return (
      <div className="boot-screen">
        <Brand />
        <h1>Keep your work. Choose its source.</h1>
        <p role="alert" style={{ maxWidth: 650 }}>
          {legacyDraft.reason}
        </p>
        <p>
          {legacyDraft.project?.name || "Older browser draft"} · Current source:{" "}
          {legacyDraft.currentPlace.extentLabel}
        </p>
        <button
          className="button secondary"
          onClick={() =>
            download(
              "urban-planning-original-legacy-draft.json",
              legacyDraft.raw,
              "application/json",
            )
          }
        >
          Download original draft for recovery
        </button>
        <button
          className="button primary"
          disabled={
            !legacyDraft.project ||
            legacyDraft.project.placeId !== legacyDraft.currentPlace.id
          }
          onClick={() =>
            void resolveLegacy("adopt")
              .then(() => setLoadError(""))
              .catch((e) => setLoadError(e.message))
          }
        >
          Adopt current source and keep edits
        </button>
        <button
          className="button secondary"
          onClick={() =>
            void resolveLegacy("new")
              .then(() => setLoadError(""))
              .catch((e) => setLoadError(e.message))
          }
        >
          Start a new project with current data
        </button>
        {loadError && <p role="alert">{loadError}</p>}
        {identityOverlays}
      </div>
    );
  if (loadError)
    return (
      <div className="boot-screen">
        <Brand />
        <h1>Let’s get your city loaded.</h1>
        <p role="alert">{loadError}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Try again
        </button>
        {identityOverlays}
      </div>
    );
  if (!place || !project || !scenario)
    return (
      <div className="boot-screen">
        <Brand />
        <div className="loading-city">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <h1>A place full of possibility.</h1>
        <p>
          Opening your saved place—or the Phoenix example to get you started…
        </p>
        <span className="eyebrow">
          GOOD PLACES START WITH A LITTLE IMAGINATION
        </span>
        {identityOverlays}
      </div>
    );
  const editable = scenario.id !== "baseline" && !projectReadOnly;
  const edits =
    Object.keys(scenario.buildingEdits).length +
    Object.keys(scenario.roadEdits).length;
  const activeHistory = project.history.filter(
    (e) =>
      e.after.id === scenario.id &&
      !e.superseded &&
      !project.undone.some((u) => u.id === e.id),
  );
  const matchingBuildings = buildings.filter((b) =>
    `${b.name} ${landUseLabels[b.use]} ${b.address || ""}`
      .toLowerCase()
      .includes(featureQuery.toLowerCase()),
  );
  return (
    <div className="app">
      <a className="skip-link" href="#main-workspace">
        Skip to workspace
      </a>
      <header className="app-header">
        <button
          className="brand-button"
          aria-label="Open project home"
          onClick={() => setDialog("projects")}
        >
          <Brand />
        </button>
        <span className="header-divider" />
        <button className="place-search" onClick={() => setDialog("search")}>
          <Search size={16} />
          <span>Find a place, imagine a future</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="header-right">
          <span className="free-label">
            <span />
            Free for everyone
          </span>
          <button
            className="help-button"
            onClick={() => setDialog("sources")}
            aria-label="Data and methodology"
          >
            <CircleHelp size={19} />
          </button>
          {budgetAccountId && (
            <button
              className="help-button"
              aria-label="Operating budget"
              onClick={() => setDialog("budget")}
            >
              <ShieldCheck size={19} />
            </button>
          )}
          {session.user && (
            <button
              className="help-button"
              aria-label="Account security"
              title="Account security"
              onClick={() => openAccountSecurity()}
            >
              <ShieldCheck size={19} />
            </button>
          )}
          <button
            className="account-button"
            onClick={() => setDialog(session.user ? "projects" : "auth")}
          >
            {session.user ? (
              <span className="avatar">
                {session.user.name.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <Users size={16} />
            )}
            <span>{session.user ? session.user.name : "Save your work"}</span>
            {!session.user && <ArrowUpRight size={14} />}
          </button>
        </div>
      </header>
      <nav className="project-bar" aria-label="Project controls">
        <div className="project-breadcrumb">
          <span className="project-icon">
            <MapPin size={18} />
          </span>
          <div>
            <strong>{project.name}</strong>
            <span>
              {place.city}, {place.state} <i />{" "}
              {place.geography?.type === "zcta" ? "ZCTA" : "near"} {place.zip}{" "}
              <ChevronDown size={12} />
            </span>
          </div>
          <span
            className="project-status"
            title={
              storageError || "Your anonymous draft is saved in this browser"
            }
          >
            {storageError ? <CircleHelp size={13} /> : <CheckCheck size={13} />}
            <span>
              {saving || storagePending
                ? "Saving…"
                : storageError
                  ? "Draft not saved"
                  : geometryDraft
                    ? "Draft not applied"
                    : "Browser draft saved"}
            </span>
          </span>
        </div>
        <div className="project-actions">
          <div className="undo-group">
            <button
              className="icon-button"
              aria-label="Undo last edit"
              title="Undo (Ctrl/⌘ Z)"
              disabled={
                projectReadOnly ||
                (activityEditor.draft
                  ? activityEditor.busy ||
                    !activityEditor.draft.past.length ||
                    !!activityEditor.area?.coordinateText.trim()
                  : buildingEditor.draft
                    ? !buildingEditor.draft.past.length ||
                      !!buildingEditor.draft.coordinateText.trim()
                    : parcelEditor.draft
                      ? !parcelEditor.draft.past.length ||
                        !!parcelEditor.draft.coordinateText.trim()
                      : streetDraft
                        ? !streetDraft.past.length
                        : !activeHistory.length)
              }
              onClick={() =>
                activityEditor.draft
                  ? activityEditor.undo()
                  : buildingEditor.draft
                    ? buildingEditor.undo()
                    : parcelEditor.draft
                      ? parcelEditor.undo()
                      : streetDraft
                        ? setStreetDraftState((current) =>
                            current ? undoStreetDraft(current) : current,
                          )
                        : undo()
              }
            >
              <Undo2 size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Redo edit"
              title="Redo (Ctrl/⌘ Shift Z)"
              disabled={
                projectReadOnly ||
                (activityEditor.draft
                  ? activityEditor.busy ||
                    !activityEditor.draft.future.length ||
                    !!activityEditor.area?.coordinateText.trim()
                  : buildingEditor.draft
                    ? !buildingEditor.draft.future.length ||
                      !!buildingEditor.draft.coordinateText.trim()
                    : parcelEditor.draft
                      ? !parcelEditor.draft.future.length ||
                        !!parcelEditor.draft.coordinateText.trim()
                      : streetDraft
                        ? !streetDraft.future.length
                        : !project.undone.some(
                            (e) => e.after.id === scenario.id,
                          ))
              }
              onClick={() =>
                activityEditor.draft
                  ? activityEditor.redo()
                  : buildingEditor.draft
                    ? buildingEditor.redo()
                    : parcelEditor.draft
                      ? parcelEditor.redo()
                      : streetDraft
                        ? setStreetDraftState((current) =>
                            current ? redoStreetDraft(current) : current,
                          )
                        : redo()
              }
            >
              <Redo2 size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="View history"
              onClick={() => setDialog("history")}
            >
              <History size={17} />
            </button>
          </div>
          <button
            className="button compact"
            onClick={() => setDialog("compare")}
          >
            <Layers3 size={15} />
            Compare
          </button>
          <button className="button compact" onClick={() => openReview()}>
            <MessageSquare size={15} /> Review
          </button>
          <button className="button compact" onClick={() => setDialog("team")}>
            <Users size={15} /> Team
          </button>
          <button
            className="button compact"
            onClick={() => setDialog("engagement")}
          >
            <Globe2 size={15} /> Feedback
          </button>
          <button
            className="button compact presentation-button"
            disabled={!!geometryDraft || !results || updating}
            onClick={() => setDialog("presentation")}
          >
            <Maximize2 size={15} />
            Present
          </button>
          <button
            className="button compact"
            disabled={
              !!geometryDraft ||
              (!!cloudLink && !projectAccess.access?.canPublish)
            }
            title={
              cloudLink && !projectAccess.access?.canPublish
                ? "Project owners publish public snapshots."
                : undefined
            }
            onClick={() => setDialog(session.user ? "share" : "auth")}
          >
            <Share2 size={15} />
            Share
          </button>
          <button
            className="button primary compact"
            disabled={!!geometryDraft || !results || updating}
            onClick={() => {
              setDialog("export");
            }}
          >
            <Download size={15} />
            Export
            <ChevronDown size={13} />
          </button>
        </div>
      </nav>
      {cloudLink && (
        <div
          className={`project-access-strip ${projectReadOnly ? "is-review" : ""}`}
          role="status"
        >
          <span>
            {projectAccess.reason ||
              `${projectAccess.access?.role ?? "Saved"} access · ${hasUnsavedChanges ? "Local changes to save" : "Saved proposal"}`}
          </span>
          <div>
            <button onClick={projectAccess.refresh}>Refresh access</button>
            {projectAccess.access && (
              <button
                onClick={() =>
                  void reopenSavedVersion().catch((e) => setToast(e.message))
                }
              >
                {hasUnsavedChanges
                  ? "Keep a copy & reopen saved"
                  : "Reopen saved version"}
              </button>
            )}
            {!session.user && (
              <button onClick={() => setDialog("auth")}>Sign in</button>
            )}
            {projectAccess.error && (
              <button onClick={() => setDialog("projects")}>
                Project home
              </button>
            )}
          </div>
        </div>
      )}
      <main id="main-workspace" className="workspace">
        <aside className="left-panel" aria-label="Planning tools">
          <div className="tool-tabs">
            {tools.map((t) => (
              <button
                key={t.id}
                className={tool === t.id ? "active" : ""}
                onClick={() => chooseTool(t.id)}
                aria-pressed={tool === t.id}
              >
                <t.icon size={19} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className="left-panel-scroll">
            {activityEditor.draft || tool === "people" ? (
              <ActivityPanel
                editor={activityEditor}
                place={place}
                scenario={scenario}
                canFetchReference={!!cloudLink && !!projectAccess.access}
                onAssumptions={() => setDialog("assumptions")}
                onCreateAlternative={() => setScenarioDialog(true)}
                onFocus={(id) => {
                  const area = activityEditor.areas.find(
                    (area) => area.id === id,
                  );
                  if (area)
                    setFocusLocation({
                      position: studyAreaAnchor(area.geometry),
                      requestId: crypto.randomUUID(),
                    });
                }}
              />
            ) : buildingEditor.draft ? (
              <BuildingDraftEditor
                key={buildingEditor.draft.id}
                editor={buildingEditor}
                place={place}
                scenario={scenario}
              />
            ) : parcelEditor.draft ? (
              <ParcelDraftEditor
                key={parcelEditor.draft.id}
                editor={parcelEditor}
              />
            ) : streetDraft ? (
              <StreetDraftEditor
                key={streetDraft.id}
                draft={streetDraft}
                place={place}
                onChange={updateStreetDrawing}
                onMode={(mode) =>
                  setStreetDraftState((current) =>
                    current
                      ? {
                          ...current,
                          mode,
                          selectedVertexIndex:
                            mode === "reshape"
                              ? (current.selectedVertexIndex ?? 0)
                              : current.selectedVertexIndex,
                        }
                      : current,
                  )
                }
                onSelectVertex={selectStreetPoint}
                onRemoveVertex={removeStreetPoint}
                onSnapChange={(snapToRoads) =>
                  setStreetDraftState((current) =>
                    current ? { ...current, snapToRoads } : current,
                  )
                }
                onCoordinateTextChange={(coordinateText) =>
                  setStreetDraftState((current) =>
                    current ? { ...current, coordinateText } : current,
                  )
                }
                onApply={applyStreetDrawing}
                onDiscard={discardStreetDrawing}
              />
            ) : tool === "parcels" && parcelEditor.selected ? (
              <>
                <ParcelInspector
                  key={parcelEditor.selected.id}
                  parcel={parcelEditor.selected}
                  place={place}
                  scenario={scenario}
                  editor={parcelEditor}
                  editable={editable}
                />
                <button
                  className="button"
                  onClick={() => {
                    setWorkforceRequest(undefined);
                    setWorkforceSite({
                      position: studyAreaAnchor(
                        parcelEditor.selected!.geometry,
                      ),
                      label: parcelEditor.selected!.name || "Selected parcel",
                    });
                    setDialog("workforce");
                  }}
                >
                  Explore workforce near this parcel
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    openAccessibility({
                      position: studyAreaAnchor(
                        parcelEditor.selected!.geometry,
                      ),
                      label: parcelEditor.selected!.name || "Selected parcel",
                    })
                  }
                >
                  Explore jobs from this parcel
                </button>
              </>
            ) : selectedBuilding ? (
              <>
                <BuildingInspector
                  key={selectedBuilding.id}
                  editor={buildingEditor}
                  editable={editable}
                  place={place}
                  scenario={scenario}
                  building={selectedBuilding}
                  flood={
                    scenario.flood
                      ? floodResolution?.scenario.buildings.find(
                          (row) => row.buildingId === selectedBuilding.id,
                        )
                      : undefined
                  }
                  hasFlood={!!scenario.flood}
                  onFlood={() => setDialog("flood")}
                  onHousing={() => setDialog("housing")}
                  onClose={() => select(null)}
                  onReview={() =>
                    openReview(
                      { kind: "building", id: selectedBuilding.id },
                      selectedBuilding.name || "Selected building",
                    )
                  }
                />
                <button
                  className="button"
                  onClick={() => {
                    setWorkforceRequest(undefined);
                    setWorkforceSite({
                      position: buildingAnchor(selectedBuilding),
                      label: selectedBuilding.name || "Selected building",
                    });
                    setDialog("workforce");
                  }}
                >
                  Explore workforce near this building
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    openAccessibility({
                      position: buildingAnchor(selectedBuilding),
                      label: selectedBuilding.name || "Selected building",
                    })
                  }
                >
                  Explore jobs from this building
                </button>
              </>
            ) : selectedRoad ? (
              <RoadEditor
                road={selectedRoad}
                onClose={() => select(null)}
                onEditGeometry={startStreetDrawing}
              />
            ) : tool === "build" ? (
              <fieldset
                className="permission-fields"
                disabled={projectReadOnly}
              >
                <BuildingLibrary
                  onPlace={startPlacement}
                  onDraw={(typology) => startPlacement(typology, true)}
                />
              </fieldset>
            ) : tool === "economy" ? (
              <EconomyPanel
                editable={editable}
                onPlace={startPlacement}
                onAssumptions={() => setDialog("assumptions")}
                onRetail={() => setDialog("retail")}
                onFiscal={() => setDialog("fiscal")}
                fiscalResolution={results?.fiscal}
                onAccessibility={() => openAccessibility()}
                onWorkforce={() => {
                  setWorkforceRequest(undefined);
                  setWorkforceSite(undefined);
                  setDialog("workforce");
                }}
              />
            ) : tool === "mobility" ? (
              <>
                <TrafficPanel onOpen={() => setDialog("traffic")} />
                <StreetBrowser
                  roads={roads}
                  editable={editable}
                  onDraw={() => startStreetDrawing()}
                  onSelect={focusStreet}
                />
              </>
            ) : tool === "parcels" ? (
              <ParcelBrowser
                editor={parcelEditor}
                editable={editable}
                onImport={() => setDialog("import")}
                onFocus={(parcel) => {
                  select(null);
                  const position = studyAreaAnchor(parcel.geometry);
                  setFocusLocation({
                    position,
                    requestId: crypto.randomUUID(),
                  });
                }}
              />
            ) : tool === "layers" ? (
              <>
                <div className="panel-intro">
                  <span className="eyebrow">ANOTHER WAY TO SEE IT</span>
                  <h2>A little more context.</h2>
                  <p>Reveal the layers that help tell your place’s story.</p>
                </div>
                {[
                  { id: "buildings", label: "Buildings", icon: Building2 },
                  { id: "roads", label: "Street network", icon: Route },
                  { id: "parcels", label: "Parcels & blocks", icon: MapIcon },
                  { id: "parks", label: "Parks & open space", icon: Leaf },
                  { id: "agents", label: "City activity", icon: Users },
                  {
                    id: "neighborhoods",
                    label: "Neighborhood exceptions",
                    icon: MapPin,
                  },
                  { id: "land-use", label: "Land use colors", icon: Layers3 },
                  ...(scenario.flood
                    ? [
                        {
                          id: "flood",
                          label: "Captured flood zones",
                          icon: Layers3,
                        },
                      ]
                    : []),
                ].map((l) => (
                  <label className="layer-row" key={l.id}>
                    <l.icon size={18} />
                    <span>{l.label}</span>
                    <input
                      type="checkbox"
                      checked={layers.includes(l.id)}
                      onChange={(e) =>
                        setLayers(
                          e.target.checked
                            ? [...layers, l.id]
                            : layers.filter((v) => v !== l.id),
                        )
                      }
                    />
                  </label>
                ))}
                <FloodPanel
                  scenario={scenario}
                  resolution={floodResolution}
                  onOpen={() => setDialog("flood")}
                />
                <h3 className="section-label">DATA COVERAGE</h3>
                {scenario.flood &&
                  project.floodDatasets?.[scenario.flood.datasetHash] && (
                    <FloodSources
                      dataset={
                        project.floodDatasets[scenario.flood.datasetHash]
                      }
                    />
                  )}
                {place.coverage.map((c) => (
                  <div className="coverage-row" key={c.layer}>
                    <div>
                      <strong>{c.layer}</strong>
                      <p>{c.description}</p>
                    </div>
                    <span className={`status-dot ${c.status}`} />
                  </div>
                ))}
                <button
                  className="button full-width"
                  onClick={() => setDialog("import")}
                >
                  <Upload size={15} />
                  Bring your own data
                </button>
              </>
            ) : (
              <>
                <div className="panel-intro explore-intro">
                  <span className="eyebrow">
                    <span className="tiny-dot" /> YOUR PLANNING STUDIO
                  </span>
                  <h1>
                    A little imagination.
                    <br />
                    <em>A better place.</em>
                  </h1>
                  <p>
                    Explore what’s here. Shape what’s next. See the difference
                    it makes.
                  </p>
                </div>
                <div className="place-card">
                  <div className="place-card-art">
                    <span className="sun-disc" />
                    <span className="desert-building b1" />
                    <span className="desert-building b2" />
                    <span className="desert-building b3" />
                    <span className="desert-building b4" />
                    <span className="desert-road" />
                    <span className="desert-tree t1" />
                    <span className="desert-tree t2" />
                  </div>
                  <div className="place-card-text">
                    <span className="eyebrow">
                      {place.city}, {place.state}
                    </span>
                    <h2>{place.name}</h2>
                    <p>
                      {place.geography?.type === "zcta"
                        ? `Census ZCTA ${place.zip} · a place of possibilities.`
                        : "A neighborhood of possibilities."}
                    </p>
                    <div className="place-card-stats">
                      <span>
                        <Building2 size={13} />
                        {place.buildings.length.toLocaleString()} features
                      </span>
                      <span>
                        <Route size={13} />
                        Real street network
                      </span>
                    </div>
                  </div>
                </div>
                {(place.demographics || place.geography?.type === "zcta") && (
                  <CommunityContext place={place} />
                )}
                <button
                  className="button full-width"
                  onClick={() => setDialog("search")}
                >
                  <Globe2 size={15} /> Explore another place
                </button>
                <h3 className="section-label">
                  WHERE WOULD YOU LIKE TO START?
                </h3>
                <button
                  className="workflow-card"
                  onClick={() => {
                    setPersona("planner");
                    chooseTool("build");
                  }}
                >
                  <span className="workflow-icon">
                    <Building2 size={22} />
                  </span>
                  <div>
                    <strong>Plan a development</strong>
                    <span>Homes, places & better streets</span>
                  </div>
                  <ArrowUpRight size={16} />
                </button>
                <button
                  className="workflow-card"
                  onClick={() => {
                    setPersona("economy");
                    chooseTool("economy");
                  }}
                >
                  <span className="workflow-icon clay">
                    <Factory size={22} />
                  </span>
                  <div>
                    <strong>Attract an employer</strong>
                    <span>Jobs, investment & opportunity</span>
                  </div>
                  <ArrowUpRight size={16} />
                </button>
                <div className="gentle-tip">
                  <Lightbulb size={19} />
                  <p>
                    <strong>Start with a what-if.</strong> Click any building to
                    explore it, or add something new.
                  </p>
                </div>
                <button
                  className="data-coverage-button"
                  onClick={() => setDialog("sources")}
                >
                  <span className="tiny-dot" />
                  <span>Real geometry. Transparent estimates.</span>
                  <ChevronRight size={14} />
                </button>
              </>
            )}
          </div>
          <div className="left-panel-bottom">
            <button
              disabled={projectReadOnly}
              onClick={() => setDialog("import")}
            >
              <Upload size={15} />
              Import data
            </button>
            <button onClick={() => setDialog("sources")}>
              <BookOpen size={15} />
              Methodology
            </button>
          </div>
        </aside>
        <section className="map-workspace" aria-label="Interactive city map">
          <div className="map-topbar">
            <div className="scenario-control">
              <GitBranch size={16} />
              <select
                aria-label="Active scenario"
                disabled={!!geometryDraft}
                value={scenario.id}
                onChange={(e) => {
                  activate(e.target.value);
                  setShowBaseline(false);
                }}
              >
                {project.scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <span className={`scenario-status ${editable ? "" : "baseline"}`}>
                {scenario.id === "baseline"
                  ? "BASELINE"
                  : projectReadOnly
                    ? "REVIEWING"
                    : "EXPLORING"}
              </span>
              <button
                aria-label="Scenario details"
                disabled={!!geometryDraft}
                title="Scenario details and report notes"
                className="icon-button"
                onClick={() => setDialog("scenario-details")}
              >
                <FileText size={15} />
              </button>
              <button
                aria-label="Create scenario"
                className="icon-button"
                disabled={projectReadOnly || !!geometryDraft}
                onClick={() => setScenarioDialog(true)}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="view-switch" aria-label="Map view">
              {(["3d", "2d", "satellite"] as const).map((v) => (
                <button
                  key={v}
                  className={view === v ? "active" : ""}
                  disabled={
                    !!(
                      streetDraft ||
                      parcelEditor.draft ||
                      buildingEditor.draft?.section === "footprint"
                    ) && v !== "2d"
                  }
                  onClick={() => setView(v)}
                >
                  {v === "3d" ? (
                    <Building2 size={13} />
                  ) : v === "2d" ? (
                    <MapIcon size={13} />
                  ) : (
                    <Globe2 size={13} />
                  )}
                  <span>
                    {v === "3d"
                      ? "3D city"
                      : v === "2d"
                        ? "2D plan"
                        : "Satellite"}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <Suspense
            fallback={
              <div className="map-loading">
                <Loader2 className="spin" />
                <p>Building your view of {place.name}…</p>
              </div>
            }
          >
            <CityMap
              place={place}
              vehicleTracks={vehicleTracks}
              scenario={
                activityEditor.draft
                  ? activityEditor.previewScenario!
                  : scenario
              }
              revealScenario={
                showBaseline && scenario.id !== "baseline"
                  ? baseline
                  : undefined
              }
              revealPercent={revealPercent}
              onRevealPercentChange={setRevealPercent}
              selectedId={selectedId}
              onSelect={(id) => {
                if (!placing && !geometryDraft) select(id);
              }}
              placingBuilding={!!placing}
              view={view}
              playing={
                playing &&
                !geometryDraft &&
                !dialog &&
                !metric &&
                !scenarioDialog
              }
              speed={speed}
              timeOfDay={timeOfDay}
              layers={layers}
              floodDatasets={project.floodDatasets}
              onMapClick={
                selectingCommentLocation
                  ? (position) => {
                      if (!pointInStudyArea(position, place)) {
                        setToast("Choose a point inside this study area.");
                        return;
                      }
                      setReviewTarget({ kind: "location", position });
                      setReviewTargetLabel("Pinned location");
                      setSelectingCommentLocation(false);
                      setDialog("review");
                    }
                  : placing
                    ? placeBuilding
                    : undefined
              }
              selectingCommentLocation={selectingCommentLocation}
              reviewPins={(projectAccess.access ? reviewComments : [])
                .filter(
                  (comment) =>
                    comment.targetPosition &&
                    comment.scenarioId === scenario.id,
                )
                .map((comment) => ({
                  id: comment.id,
                  position: comment.targetPosition!,
                  label: `${comment.targetLabel}: ${comment.text.slice(0, 100)}`,
                  resolved: comment.resolved,
                }))}
              selectedReviewPinId={selectedReviewId}
              onReviewPinSelect={(id) => {
                setSelectedReviewId(id);
                setDialog("review");
              }}
              focusLocation={focusLocation}
              buildingDraft={buildingEditor.mapDraft}
              buildingEditingEnabled={
                buildingEditor.draft?.section === "footprint" &&
                !buildingEditor.draft.coordinateText.trim() &&
                !dialog &&
                !metric &&
                !scenarioDialog
              }
              onBuildingDraftPathChange={buildingEditor.pathChange}
              onBuildingVertexSelect={buildingEditor.vertexSelect}
              onBuildingDraftTransform={buildingEditor.transform}
              onBuildingDraftCommand={(command) => {
                if (command === "finish") buildingEditor.apply();
                else if (command === "cancel") buildingEditor.discard();
                else if (buildingEditor.draft)
                  buildingEditor.removeVertex(
                    buildingEditor.draft.selectedVertexIndex ??
                      activeBuildingPath(buildingEditor.draft).length - 1,
                  );
              }}
              neighborhoodDraft={activityEditor.mapDraft}
              neighborhoodEditingEnabled={
                !!activityEditor.area &&
                !activityEditor.area.coordinateText.trim() &&
                !dialog &&
                !metric &&
                !scenarioDialog
              }
              neighborhoodSelectionEnabled={
                tool === "people" &&
                !geometryDraft &&
                !dialog &&
                !metric &&
                !scenarioDialog
              }
              selectedNeighborhoodId={activityEditor.selected?.id}
              onNeighborhoodSelect={activityEditor.select}
              neighborhoodSummaries={activityEditor.preview.resolution?.neighborhoods.map(
                (area) => ({
                  id: area.id,
                  populationLabel: `${countLabel(area.population.value)} people`,
                  employmentLabel: `${countLabel(area.employment.value)} jobs`,
                  statusLabel: "Modeled allocation",
                }),
              )}
              onNeighborhoodBrushStroke={activityEditor.brush}
              onNeighborhoodDraftPathChange={activityEditor.pathChange}
              onNeighborhoodVertexSelect={activityEditor.vertexSelect}
              onNeighborhoodDraftCommand={(command) => {
                if (command === "finish") activityEditor.finishArea();
                else if (command === "cancel") activityEditor.discardArea();
                else activityEditor.removeVertex();
              }}
              parcelDraft={parcelEditor.mapDraft}
              parcelEditingEnabled={
                !!parcelEditor.draft && !dialog && !metric && !scenarioDialog
              }
              parcelSelectionEnabled={
                tool === "parcels" &&
                !activityEditor.draft &&
                !buildingEditor.draft &&
                !streetDraft &&
                !dialog &&
                !metric &&
                !scenarioDialog
              }
              selectedParcelIds={parcelEditor.selectedIds}
              onParcelSelect={(id) => {
                select(null);
                parcelEditor.select(id);
              }}
              onParcelDraftPathChange={parcelEditor.pathChange}
              onParcelVertexSelect={parcelEditor.vertexSelect}
              onParcelDraftCommand={(command) => {
                if (command === "finish") parcelEditor.apply();
                else if (command === "cancel") parcelEditor.discard();
                else if (parcelEditor.draft)
                  parcelEditor.removeVertex(
                    parcelEditor.draft.selectedVertexIndex ??
                      activeParcelPath(parcelEditor.draft).length - 1,
                  );
              }}
              roadDraft={
                streetDraft
                  ? {
                      id: streetDraft.id,
                      mode: streetDraft.mode,
                      roadId: streetDraft.original?.id,
                      coordinates: streetDraft.value.coordinates,
                      selectedVertexIndex: streetDraft.selectedVertexIndex,
                      snapToRoads: streetDraft.snapToRoads,
                    }
                  : null
              }
              roadEditingEnabled={
                !!streetDraft && !dialog && !metric && !scenarioDialog
              }
              onRoadDraftChange={(coordinates, detail) => {
                setStreetDraftState((current) =>
                  current && current.scope === streetScope
                    ? {
                        ...changeStreetDraft(current, {
                          ...current.value,
                          coordinates,
                        }),
                        selectedVertexIndex: detail.vertexIndex,
                      }
                    : current,
                );
                if (detail.snap)
                  setToast(
                    `Point aligned to ${roads.find((road) => road.id === detail.snap!.roadId)?.name ?? "a nearby street"}.`,
                  );
              }}
              onRoadVertexSelect={selectStreetPoint}
              onRoadDraftCommand={(command) => {
                if (command === "finish") applyStreetDrawing();
                else if (command === "cancel") discardStreetDrawing();
                else if (streetDraft)
                  removeStreetPoint(
                    streetDraft.selectedVertexIndex ??
                      streetDraft.value.coordinates.length - 1,
                  );
              }}
              captureRef={captureRef}
              cameraCaptureRef={presentationCameraRef}
            />
          </Suspense>
          {placing && (
            <div className="placement-banner">
              <Plus size={17} />
              <span>
                Click the map to place{" "}
                <strong>{buildingTypologyLabels[placing].toLowerCase()}</strong>
              </span>
              <button
                className="icon-button"
                onClick={() => setPlacing(null)}
                aria-label="Cancel placement"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {selectingCommentLocation && (
            <div className="placement-banner" role="status">
              <MapPin size={16} /> Select a review location inside the study
              area.
              <button
                className="icon-button"
                aria-label="Cancel review location"
                onClick={() => {
                  setSelectingCommentLocation(false);
                  setDialog("review");
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="map-floating-left">
            <span className="map-area-label">
              <MapPin size={13} />
              {place.geography?.type === "zcta"
                ? `ZCTA ${place.geography.code}`
                : place.city.toUpperCase()}
              <span> / </span>
              {place.geography?.type === "zcta"
                ? "CENSUS STUDY AREA"
                : "REFERENCE AREA"}
            </span>
            <div className="map-legend">
              <span>
                <i style={{ background: "#d9a777" }} />
                Residential
              </span>
              <span>
                <i style={{ background: "#aec1be" }} />
                Employment
              </span>
              <span>
                <i style={{ background: "#80a075" }} />
                Open space
              </span>
            </div>
          </div>
          <div className="map-floating-right">
            <button
              className={`map-action ${showBaseline ? "active" : ""}`}
              aria-pressed={showBaseline}
              disabled={!!geometryDraft || scenario.id === "baseline"}
              onClick={() => {
                setPlacing(null);
                setSelectingCommentLocation(false);
                setShowBaseline(!showBaseline);
              }}
            >
              <Eye size={16} />
              {showBaseline ? "Back to scenario" : "Before / after"}
            </button>
            <button
              className="map-action circle"
              aria-label="Open feature list"
              disabled={!!geometryDraft}
              onClick={() => {
                if (geometryDraft) return;
                setTool("explore");
                setDialog("search");
              }}
            >
              <Search size={17} />
            </button>
          </div>
          <div className="map-bottom-bar">
            <div className="time-controls">
              <button
                className="play-button"
                onClick={() => setPlaying(!playing)}
                aria-label={
                  playing ? "Pause city animation" : "Play city animation"
                }
              >
                {playing ? (
                  <Pause size={14} fill="currentColor" />
                ) : (
                  <Play size={14} fill="currentColor" />
                )}
              </button>
              <button
                className="speed-button"
                onClick={() =>
                  setSpeed(
                    speed === 1 ? 5 : speed === 5 ? 15 : speed === 15 ? 60 : 1,
                  )
                }
              >
                {speed}×
              </button>
              <span className="small-divider" />
              <Sun size={16} />
              <label>
                <span className="sr-only">Time of day</span>
                <select
                  value={timeOfDay}
                  onChange={(e) => setTimeOfDay(Number(e.target.value))}
                >
                  <option value={8}>8:00 AM · Morning</option>
                  <option value={12}>12:00 PM · Midday</option>
                  <option value={15}>3:00 PM · Afternoon</option>
                  <option value={17}>5:00 PM · Evening</option>
                  <option value={21}>9:00 PM · Night</option>
                </select>
              </label>
            </div>
            <span className="animation-label">
              <span className={playing ? "tiny-dot" : ""} />
              {!layers.includes("agents")
                ? "Activity hidden"
                : !vehicleTracks
                  ? "Vehicles appear after a saved traffic simulation"
                  : playing
                    ? "SUMO traffic run · playing"
                    : "SUMO traffic run · paused"}
            </span>
          </div>
          <div className="map-disclosure">
            {place.extentLabel} ·{" "}
            <button onClick={() => setDialog("sources")}>
              Sources & attribution
            </button>
          </div>
        </section>
        <aside className="right-panel" aria-label="Impact scorecard">
          <div className="scorecard-header">
            <div className="scorecard-title">
              <span className="eyebrow">THE BIGGER PICTURE</span>
              <button
                className="icon-button"
                onClick={() => setDialog("assumptions")}
                aria-label="Edit assumptions"
              >
                <Settings2 size={17} />
              </button>
            </div>
            <h2>
              Every change
              <br />
              has an impact<span>.</span>
            </h2>
            <p>Small moves. Measurable possibilities.</p>
            <div className="scorecard-meta">
              <span className="badge">
                <span className="tiny-dot" />
                {updating ? "Updating estimates" : "Live planning estimates"}
              </span>
              <button
                onClick={() => setDialog("sources")}
                className="text-button"
                aria-label="Explain scorecard data quality"
              >
                <CircleHelp size={14} />
              </button>
            </div>
          </div>
          <div className="scorecard-controls">
            <label>
              <span>TIME HORIZON</span>
              <select
                value={scenario.horizon}
                disabled={!editable || !!geometryDraft}
                onChange={(e) =>
                  dispatch(
                    {
                      type: "scenario.horizon",
                      horizon: Number(e.target.value) as Scenario["horizon"],
                    },
                    "Change forecast horizon",
                  )
                }
              >
                <option value={0}>Today</option>
                <option value={5}>+5 years</option>
                <option value={10}>+10 years</option>
                <option value={20}>+20 years</option>
              </select>
            </label>
            <div className="scorecard-domain">
              <select
                aria-label="Scorecard domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value as typeof domain)}
              >
                <option>Overview</option>
                {domains.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
              <SlidersHorizontal size={14} />
            </div>
          </div>
          <div
            className={`scorecard-scroll ${updating ? "updating" : ""}`}
            aria-busy={updating}
          >
            {domain === "Housing" && (
              <HousingAffordabilityPanel
                scenario={scenario}
                result={results?.affordability}
                onOpen={() => setDialog("housing")}
              />
            )}
            {domain === "Environment" && (
              <FloodPanel
                scenario={scenario}
                resolution={floodResolution}
                onOpen={() => setDialog("flood")}
              />
            )}
            {domain === "Access & equity" && (
              <AccessibilityPanel
                scenario={scenario}
                onOpen={() => openAccessibility()}
              />
            )}
            {calculationError && (
              <div className="error-message">{calculationError}</div>
            )}
            {!results ? (
              <div className="scorecard-skeleton">
                <div />
                <div />
                <div />
                <div />
              </div>
            ) : (
              visibleMetrics.map((m, index) => (
                <button
                  className={`metric-card metric-${index % 4}`}
                  key={m.id}
                  onClick={() => setMetric(m)}
                >
                  <div className="metric-label">
                    <span className="metric-icon">
                      {m.domain === "Housing" ? (
                        <Home size={16} />
                      ) : m.domain === "Economy" ? (
                        <Users size={16} />
                      ) : m.domain === "Mobility" ? (
                        <Route size={16} />
                      ) : m.domain === "Environment" ? (
                        <Leaf size={16} />
                      ) : (
                        <Building2 size={16} />
                      )}
                    </span>
                    <span>{m.label}</span>
                    <ArrowUpRight size={13} />
                  </div>
                  <div className="metric-value">
                    {formatMetric(m.value, m.unit)}
                    <span>
                      {m.unit === "USD/year"
                        ? " / yr"
                        : m.unit === "%"
                          ? ""
                          : m.unit === "units"
                            ? "homes"
                            : m.unit === "jobs"
                              ? "jobs"
                              : m.unit}
                    </span>
                  </div>
                  <div className="metric-baseline">
                    <span>Baseline {formatMetric(m.baseline, m.unit)}</span>
                    <span
                      className={`metric-delta ${m.delta ? "changed" : ""}`}
                    >
                      {m.delta === null
                        ? "No data"
                        : m.delta === 0
                          ? "No change"
                          : `${m.delta > 0 ? "+" : ""}${formatMetric(m.delta, m.unit)}`}
                    </span>
                  </div>
                  {m.status !== "ready" && (
                    <div className="metric-caveat">
                      {m.status === "unavailable"
                        ? "Needs additional evidence"
                        : "Illustrative inputs · review assumptions"}
                    </div>
                  )}
                </button>
              ))
            )}
            {domain === "Overview" && (
              <>
                <button
                  className="all-outcomes"
                  onClick={() => setDomain("Housing")}
                >
                  Explore all 8 impact areas <ArrowRight size={15} />
                </button>
                <div className="impact-note">
                  <span className="note-illustration">
                    <Leaf size={27} />
                  </span>
                  <h3>
                    {edits
                      ? "An idea is taking shape."
                      : "Your next chapter starts here."}
                  </h3>
                  <p>
                    {edits
                      ? `${edits} mapped ${edits === 1 ? "change" : "changes"} in this alternative. Open any metric to understand the assumptions behind it.`
                      : "Add a building or change a street to see how the possibilities compare."}
                  </p>
                </div>
              </>
            )}
          </div>
          <div className="scorecard-bottom">
            <button
              className="assistant-button"
              onClick={() => setDialog("assistant")}
            >
              <Sparkles size={17} />
              <span>Understand this scenario</span>
              <ArrowUpRight size={14} />
            </button>
          </div>
        </aside>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {(storageError || project.baselineMigration) && (
        <div className="storage-error" role="alert">
          {storageError ||
            "Legacy draft migrated: current source adopted. Original baseline results cannot be reconstructed."}
        </div>
      )}
      {dialog === "housing" && (
        <Suspense fallback={<div role="status">Loading housing evidence…</div>}>
          <HousingAffordabilityDialog
            key={`${project.id}:${scenario.id}:${session.user?.id ?? "guest"}:${session.organization?.id ?? "browser"}`}
            place={place}
            project={project}
            scenario={scenario}
            results={results ?? undefined}
            canEdit={editable && !geometryDraft}
            actor={session.user?.name ?? "Anonymous browser"}
            accountScope={`${session.user?.id ?? "guest"}:${session.organization?.id ?? "browser"}`}
            selectedBuildingId={selectedBuilding?.id}
            onClose={() => setDialog(null)}
            onApply={async (packs, affordability, signal) => {
              if (
                useWorkspace.getState().project !== project ||
                useWorkspace.getState().place !== place ||
                sessionLive.current.user?.id !== session.user?.id ||
                sessionLive.current.organization?.id !==
                  session.organization?.id ||
                !editable
              )
                throw new Error(
                  "The project or account changed. Review housing evidence again.",
                );
              await applyAffordability(packs, affordability, signal);
              setDialog(null);
              setToast(
                "Housing evidence applied. Undo restores the previous review.",
              );
            }}
            onRemove={() => {
              dispatch(
                { type: "scenario.affordability", affordability: null },
                "Remove housing affordability evidence",
              );
              setDialog(null);
            }}
            onSelectBuilding={(id) => {
              select(id);
              setTool("explore");
              const building = buildings.find((b) => b.id === id);
              if (building)
                setFocusLocation({
                  position: buildingAnchor(building),
                  requestId: crypto.randomUUID(),
                });
              setToast(
                "Building highlighted on the map. Close the workbench when ready to inspect it.",
              );
            }}
          />
        </Suspense>
      )}
      {dialog === "flood" && (
        <Suspense fallback={<div role="status">Loading flood evidence…</div>}>
          <FloodDialog
            key={`${project.id}:${scenario.id}:${session.user?.id ?? "guest"}:${session.organization?.id ?? "browser"}`}
            place={place}
            scenario={scenario}
            context={modelContext}
            resolution={floodResolution}
            calculationError={calculationError}
            canEdit={editable}
            onAttach={async (dataset, hash, signal) => {
              if (
                useWorkspace.getState().project !== project ||
                useWorkspace.getState().place !== place ||
                sessionLive.current.user?.id !== session.user?.id ||
                sessionLive.current.organization?.id !==
                  session.organization?.id ||
                !editable
              )
                throw new Error(
                  "The project or account changed. Review the flood map again.",
                );
              await attachFlood(dataset, hash, signal);
              setLayers((current) =>
                current.includes("flood") ? current : [...current, "flood"],
              );
              setToast("Captured flood map attached.");
            }}
            onUpdateMethod={() => {
              if (
                !editable ||
                updating ||
                sessionLive.current.user?.id !== session.user?.id ||
                sessionLive.current.organization?.id !==
                  session.organization?.id
              )
                throw new Error(
                  "The calculation or account changed. Review the flood method again.",
                );
              updateFloodMethod(project, scenario);
              setToast(
                "Flood calculation method updated. The source map is unchanged. Undo restores the previous method.",
              );
            }}
            onRemove={() => {
              dispatch(
                { type: "scenario.flood", flood: null },
                "Remove flood map from scenario",
              );
            }}
            onSelect={(id) => {
              select(id);
              setTool("explore");
              const building = buildings.find((b) => b.id === id);
              if (building)
                setFocusLocation({
                  position: buildingAnchor(building),
                  requestId: crypto.randomUUID(),
                });
              setDialog(null);
            }}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}
      {budgetVisible && budgetAccountId && (
        <BudgetDialog
          key={budgetAccountId}
          accountId={budgetAccountId}
          onClose={() => setDialog(null)}
        />
      )}
      {identityOverlays}
      {dialog === "search" && (
        <PlaceSearchDialog
          place={place}
          buildings={buildings}
          session={session}
          onSession={setSession}
          onClose={() => setDialog(null)}
          onFeature={select}
          onOpen={async (nextPlace) => {
            await replace(createProject(nextPlace), nextPlace);
            setShowBaseline(false);
            setPlacing(null);
            setMetric(null);
            setTool("explore");
            setToast(
              `${nextPlace.name} is ready to explore. Your previous draft is kept in project home.`,
            );
          }}
        />
      )}
      {dialog === "scenario-details" && (
        <ScenarioDetailsDialog
          key={`${project.id}:${scenario.id}:${scenario.revision}`}
          scenario={scenario}
          readOnly={!editable}
          onClose={() => setDialog(null)}
          onSave={(details) => {
            dispatch(
              { type: "scenario.details", ...details },
              "Update proposal notes",
            );
            setToast(
              "Proposal notes updated. Save your project to include them in account reports.",
            );
          }}
        />
      )}
      {dialog === "assumptions" && (
        <Modal
          title="Make the assumptions yours."
          description="Transparent inputs are the foundation of a useful planning estimate."
          wide
          open
          onClose={() => setDialog(null)}
        >
          <AssumptionsEditor
            assumptions={scenario.assumptions}
            activityEnabled={!!scenario.activity}
            retailEnabled={!!scenario.retail}
            onClose={() => setDialog(null)}
          />
        </Modal>
      )}
      {metric && (
        <Modal
          title={metric.label}
          description="An estimate you can inspect, explain, and improve."
          open
          onClose={() => setMetric(null)}
        >
          <MetricDetail
            metric={metric}
            sourceInventory={
              metric.domain === "Housing" && scenario.affordability
                ? housingSourceInventory(scenario, project.housingIncomeLimits)
                : undefined
            }
            place={{
              ...place,
              sources:
                metric.domain === "Housing" && scenario.affordability
                  ? housingSources(scenario, project.housingIncomeLimits)
                  : metric.domain === "Fiscal" && project.fiscalStudy
                    ? project.fiscalStudy.profile.sources
                    : metric.id === "environment.flood" && scenario.flood
                      ? (project.floodDatasets?.[scenario.flood.datasetHash]
                          ?.sources ?? [])
                      : planningSources(place, scenario),
            }}
            onAssumptions={() => {
              setMetric(null);
              setDialog("assumptions");
            }}
            onFlood={() => {
              setMetric(null);
              setDialog("flood");
            }}
            onHousing={() => {
              setMetric(null);
              setDialog("housing");
            }}
            onFiscal={() => {
              setMetric(null);
              setDialog("fiscal");
            }}
            onAccessibility={() => {
              setMetric(null);
              openAccessibility();
            }}
            onReview={() => {
              const target = metric;
              setMetric(null);
              openReview({ kind: "metric", id: target.id }, target.label);
            }}
          />
        </Modal>
      )}
      {dialog === "compare" && (
        <CompareDialog
          place={place}
          project={project}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "presentation" && results && (
        <PresentationDialog
          key={`${project.id}:${scenario.id}:${scenario.revision}`}
          place={place}
          scenario={scenario}
          results={results}
          floodDatasets={project.floodDatasets}
          initialCamera={presentationCameraRef.current?.() ?? undefined}
          canEdit={editable}
          onClose={() => setDialog(null)}
          onSave={(presentation) => {
            const current = useWorkspace.getState();
            const active = current.project?.scenarios.find(
              (item) => item.id === current.project?.activeScenarioId,
            );
            if (
              !editable ||
              current.readOnly ||
              current.project?.id !== project.id ||
              active?.id !== scenario.id ||
              active?.revision !== scenario.revision
            )
              throw new Error(
                "The scenario or your access changed. Reopen the tour before saving.",
              );
            dispatch(
              { type: "scenario.presentation", presentation },
              presentation
                ? "Saved presentation tour"
                : "Removed presentation tour",
            );
            setToast(
              presentation
                ? "Tour saved to this scenario. Publish a new snapshot to share it."
                : "Saved tour removed. Undo restores it.",
            );
          }}
        />
      )}
      {dialog === "fiscal" && (
        <Suspense
          fallback={<div role="status">Opening the fiscal workbench…</div>}
        >
          <FiscalDialog
            key={`${session.user?.id ?? "guest"}:${session.organization?.id ?? "local"}:${baselineIdentity?.sha256}:${scenario.id}`}
            place={place}
            project={project}
            scenario={scenario}
            results={results ?? undefined}
            actor={session.user?.name ?? "Anonymous browser"}
            accountScope={`${session.user?.id ?? "guest"}:${session.organization?.id ?? "local"}`}
            canEdit={editable}
            canCreateSaved={!!session.user && canCreateInWorkspace}
            canReadLibrary={
              !!session.user && session.membershipScope !== "project-only"
            }
            canWriteLibrary={!!session.user && canCreateInWorkspace}
            onAccessError={() => projectAccess.refresh()}
            onClose={() => setDialog(null)}
            onApply={(command) => {
              const current = useWorkspace.getState();
              const active = current.project?.scenarios.find(
                (value) => value.id === current.project?.activeScenarioId,
              );
              if (
                !editable ||
                current.readOnly ||
                current.project !== project ||
                active?.id !== scenario.id ||
                active.revision !== scenario.revision
              )
                throw new Error(
                  "The scenario or your access changed. Reopen the fiscal workbench before applying.",
                );
              dispatch(
                command,
                "Review fiscal offer and paired sensitivity cases",
              );
              setToast(
                "Offer and sensitivity cases applied together. Undo restores the previous review.",
              );
            }}
            onCreateStudy={async (request, signal) => {
              const original = useWorkspace.getState();
              const sessionKey = `${sessionLive.current.user?.id ?? "guest"}:${sessionLive.current.organization?.id ?? "local"}`;
              const sourceRevision = projectRevisionKey(project);
              const ensure = (expectedProjectId = project.id) => {
                signal.throwIfAborted();
                const now = useWorkspace.getState();
                if (
                  now.readOnly ||
                  now.place !== place ||
                  now.project?.id !== expectedProjectId ||
                  now.project.activeScenarioId !== scenario.id ||
                  projectRevisionKey(now.project) !== sourceRevision ||
                  `${sessionLive.current.user?.id ?? "guest"}:${sessionLive.current.organization?.id ?? "local"}` !==
                    sessionKey
                )
                  throw new Error(
                    "The source draft, account or permissions changed. No new study was opened; retain this draft and review again.",
                  );
                return now;
              };
              if (!editable || !original.baselineIdentity)
                throw new Error(
                  "Open an editable alternative with its captured baseline before creating a fiscal study.",
                );
              ensure();
              // Preserve the complete current source draft before opening a different project.
              await writeWorkspace({
                project,
                place,
                baselineIdentity: original.baselineIdentity,
                ...(original.cloudLink
                  ? { cloudLink: original.cloudLink }
                  : {}),
              });
              ensure();
              if (!request.saved) {
                const next = await createFiscalStudyInWorker(
                  {
                    place,
                    project,
                    scenarioId: scenario.id,
                    profile: request.profile,
                    review: {
                      reviewedBy: session.user?.name ?? "Anonymous browser",
                      reviewedAt: new Date().toISOString(),
                      applicabilityNotes: request.applicabilityNotes,
                    },
                    name: request.name,
                  },
                  signal,
                );
                ensure();
                await replace(next, place, original.baselineIdentity);
              } else {
                const saved =
                  cloudLink && !hasUnsavedChanges
                    ? {
                        projectId: cloudLink.projectId,
                        version: cloudLink.version,
                      }
                    : await saveCloud();
                if (!saved)
                  throw new Error(
                    "Sign in and save the original source project before creating a saved fiscal study.",
                  );
                const savedSource = ensure(saved.projectId);
                const response = await fiscalApi.createStudy(
                  saved.projectId,
                  {
                    scenarioId: scenario.id,
                    expectedVersion: saved.version,
                    expectedRevision: scenario.revision,
                    ...(request.libraryVersionId
                      ? { libraryVersionId: request.libraryVersionId }
                      : { profile: request.profile }),
                    name: request.name,
                    applicabilityNotes: request.applicabilityNotes,
                    idempotencyKey: request.idempotencyKey,
                  },
                  signal,
                );
                const current = ensure(saved.projectId);
                if (
                  current.cloudLink?.version !== saved.version ||
                  current.cloudLink.savedRevision !== sourceRevision ||
                  response.version !== 1 ||
                  response.organizationId !== session.organization?.id ||
                  response.baselineIdentity.sha256 !==
                    original.baselineIdentity.sha256 ||
                  response.project.fiscalStudy?.lineage.projectId !==
                    saved.projectId ||
                  response.project.fiscalStudy.lineage.scenarioId !==
                    scenario.id ||
                  response.project.fiscalStudy.lineage.scenarioRevision !==
                    scenario.revision ||
                  !response.access.canEdit
                )
                  throw new Error(
                    "The saved study response no longer matches the reviewed source. Your original draft is preserved; reopen the separate study from Project home.",
                  );
                if (savedSource.place !== place)
                  throw new Error("The saved source baseline changed.");
                flushSync(() =>
                  projectAccess.acceptVerifiedSave({
                    projectId: response.project.id,
                    organizationId: response.organizationId,
                    version: response.version,
                    access: response.access,
                  }),
                );
                await replace(
                  response.project,
                  place,
                  response.baselineIdentity,
                  {
                    projectId: response.project.id,
                    organizationId: response.organizationId,
                    version: response.version,
                    savedRevision: projectRevisionKey(response.project),
                  },
                );
                setReadOnly(false);
                projectAccess.refresh();
              }
              setShowBaseline(false);
              setDialog("fiscal");
              setToast(
                "Separate fiscal study created. The original project and its earlier history remain intact.",
              );
            }}
          />
        </Suspense>
      )}
      {dialog === "retail" && (
        <RetailDialog
          key={`${project.id}:${scenario.id}:${scenario.revision}`}
          place={place}
          scenario={scenario}
          canEdit={editable}
          onClose={() => setDialog(null)}
          onSave={(retail, sources) => {
            const current = useWorkspace.getState();
            const active = current.project?.scenarios.find(
              (item) => item.id === current.project?.activeScenarioId,
            );
            if (
              !editable ||
              current.readOnly ||
              current.project?.id !== project.id ||
              active?.id !== scenario.id ||
              active?.revision !== scenario.revision
            )
              throw new Error(
                "The scenario or your access changed. Reopen the retail workbench before saving.",
              );
            dispatch(
              { type: "scenario.retail", retail, sources },
              retail ? "Saved retail study" : "Removed retail study",
            );
            setToast(
              retail
                ? "Retail study saved to this scenario. Undo restores the previous version."
                : "Retail study removed. Undo restores it.",
            );
          }}
        />
      )}
      {dialog === "traffic" && (
        <Suspense
          fallback={
            <Modal
              title="Traffic analysis"
              open
              onClose={() => setDialog(null)}
            >
              <p role="status">Loading the traffic workbench…</p>
            </Modal>
          }
        >
          <TrafficWorkspace
            key={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}:${scenario.id}`}
            place={place}
            scenario={scenario}
            accountId={session.user?.id ?? null}
            accountScope={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}`}
            connection={cloudLink}
            canEdit={editable}
            hasUnsavedChanges={hasUnsavedChanges}
            onSignIn={() => {
              trafficAuthReturn.current = {
                projectId: project.id,
                scenarioId: scenario.id,
              };
              setDialog("auth");
            }}
            onSaveProject={async () => {
              if (!cloudLink || hasUnsavedChanges) await saveCloud();
            }}
            onAccessError={projectAccess.refresh}
            onClose={() => setDialog(null)}
            onRemove={() => {
              const current = useWorkspace.getState();
              const active = current.project?.scenarios.find(
                (item) => item.id === current.project?.activeScenarioId,
              );
              if (
                !editable ||
                current.readOnly ||
                current.project?.id !== project.id ||
                active?.id !== scenario.id ||
                active.revision !== scenario.revision
              ) {
                setToast(
                  "Your scenario or editing access changed. Reopen the traffic workbench before removing evidence.",
                );
                return;
              }
              dispatch(
                { type: "scenario.traffic", traffic: null },
                "Removed saved traffic capture",
              );
              setToast(
                "Saved traffic capture removed. Undo restores it; archived runs are retained.",
              );
            }}
            onAdopt={async (response) => {
              const current = useWorkspace.getState();
              const active = current.project?.scenarios.find(
                (item) => item.id === current.project?.activeScenarioId,
              );
              const returned = response.project.scenarios.find(
                (item) => item.id === scenario.id,
              );
              if (
                workspaceContextRef.current !== workspaceContext ||
                current.readOnly ||
                !editable ||
                current.project?.id !== project.id ||
                active?.id !== scenario.id ||
                active.revision !== scenario.revision ||
                current.cloudLink?.version !== cloudLink?.version ||
                projectRevisionKey(current.project) !==
                  current.cloudLink?.savedRevision ||
                response.project.id !== project.id ||
                response.organizationId !== session.organization?.id ||
                response.baselineIdentity.sha256 !==
                  current.baselineIdentity?.sha256 ||
                response.version !== (cloudLink?.version ?? 0) + 1 ||
                returned?.revision !== scenario.revision + 1
              )
                throw new Error(
                  "The traffic evidence was saved on the server, but your current draft or access changed. Reopen the saved project to review it; local edits have been retained.",
                );
              flushSync(() =>
                projectAccess.acceptVerifiedSave({
                  projectId: response.project.id,
                  organizationId: response.organizationId,
                  version: response.version,
                  access: response.access,
                }),
              );
              await replace(
                response.project,
                response.baseline,
                response.baselineIdentity,
                {
                  projectId: response.project.id,
                  organizationId: response.organizationId,
                  version: response.version,
                  savedRevision: projectRevisionKey(response.project),
                },
              );
              setReadOnly(!response.access.canEdit);
              projectAccess.refresh();
              setToast(
                "Traffic evidence saved to this scenario. Undo restores the previous capture.",
              );
            }}
          />
        </Suspense>
      )}
      {dialog === "accessibility" && (
        <Suspense
          fallback={
            <Modal
              title="Opening jobs accessibility"
              open
              onClose={() => setDialog(null)}
            >
              <p role="status">Preparing the regional workbench…</p>
            </Modal>
          }
        >
          <AccessibilityDialog
            key={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}:${scenario.id}`}
            place={place}
            scenario={scenario}
            accountId={session.user?.id ?? null}
            connection={cloudLink}
            canEdit={editable}
            hasUnsavedChanges={hasUnsavedChanges}
            initialSite={accessibilitySite}
            initialRequest={accessibilityRequest}
            onSignIn={(request, label) => {
              setAccessibilityRequest(request ?? undefined);
              if (request)
                setAccessibilitySite({ position: request.site, label });
              accessibilityAuthReturn.current = {
                projectId: project.id,
                scenarioId: scenario.id,
              };
              setDialog("auth");
            }}
            onSaveProject={async () => {
              await saveCloud();
            }}
            onAccessError={projectAccess.refresh}
            onRemove={(mode) => {
              const current = useWorkspace.getState();
              const active = current.project?.scenarios.find(
                (item) => item.id === current.project?.activeScenarioId,
              );
              if (
                !editable ||
                current.readOnly ||
                current.project?.id !== project.id ||
                active?.id !== scenario.id ||
                active.revision !== scenario.revision
              ) {
                setToast(
                  "Your scenario or editing access changed. Reopen the workbench before removing the capture.",
                );
                return;
              }
              dispatch(
                { type: "scenario.accessibility", mode, evidence: null },
                "Removed saved accessibility capture",
              );
              setToast(
                "Saved capture removed. Undo restores it; archived analysis runs are retained.",
              );
            }}
            onClose={() => setDialog(null)}
            onAdopt={async (response) => {
              const current = useWorkspace.getState();
              const active = current.project?.scenarios.find(
                (item) => item.id === current.project?.activeScenarioId,
              );
              if (
                workspaceContextRef.current !== workspaceContext ||
                current.readOnly ||
                !editable ||
                current.project?.id !== project.id ||
                active?.id !== scenario.id ||
                active.revision !== scenario.revision ||
                current.cloudLink?.version !== cloudLink?.version ||
                projectRevisionKey(current.project) !==
                  current.cloudLink?.savedRevision ||
                response.project.id !== project.id ||
                response.organizationId !== session.organization?.id
              )
                throw new Error(
                  "The analysis was saved on the server, but your current draft changed. Reopen the saved project to review it; your local edits have been retained.",
                );
              flushSync(() =>
                projectAccess.acceptVerifiedSave({
                  projectId: response.project.id,
                  organizationId: response.organizationId,
                  version: response.version,
                  access: response.access,
                }),
              );
              await replace(
                response.project,
                response.baseline,
                response.baselineIdentity,
                {
                  projectId: response.project.id,
                  organizationId: response.organizationId,
                  version: response.version,
                  savedRevision: projectRevisionKey(response.project),
                },
              );
              setReadOnly(!response.access.canEdit);
              projectAccess.refresh();
              setToast(
                "Accessibility evidence saved to this scenario. Undo restores the previous capture.",
              );
            }}
          />
        </Suspense>
      )}
      {dialog === "workforce" && (
        <WorkforceDialog
          key={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}:${scenario.id}`}
          place={place}
          scenario={scenario}
          accountId={session.user?.id ?? null}
          connection={cloudLink}
          canEdit={editable}
          hasUnsavedChanges={hasUnsavedChanges}
          initialSite={workforceSite}
          initialRequest={workforceRequest}
          onSignIn={(request, label) => {
            setWorkforceRequest(request ?? undefined);
            if (request) setWorkforceSite({ position: request.site, label });
            workforceAuthReturn.current = {
              projectId: project.id,
              scenarioId: scenario.id,
            };
            setDialog("auth");
          }}
          onSaveProject={async () => {
            await saveCloud();
          }}
          onAccessError={projectAccess.refresh}
          onRemove={() => {
            const current = useWorkspace.getState();
            const active = current.project?.scenarios.find(
              (item) => item.id === current.project?.activeScenarioId,
            );
            if (
              !editable ||
              current.readOnly ||
              current.project?.id !== project.id ||
              active?.id !== scenario.id ||
              active.revision !== scenario.revision
            ) {
              setToast(
                "Your scenario or editing access changed. Reopen the workbench before removing the capture.",
              );
              return;
            }
            dispatch(
              { type: "scenario.workforce", workforce: null },
              "Removed saved workforce capture",
            );
            setToast(
              "Saved capture removed. Undo restores it; archived analysis runs are retained.",
            );
          }}
          onClose={() => setDialog(null)}
          onAdopt={async (response) => {
            const current = useWorkspace.getState();
            const active = current.project?.scenarios.find(
              (item) => item.id === current.project?.activeScenarioId,
            );
            if (
              workspaceContextRef.current !== workspaceContext ||
              current.readOnly ||
              !editable ||
              current.project?.id !== project.id ||
              active?.id !== scenario.id ||
              active.revision !== scenario.revision ||
              current.cloudLink?.version !== cloudLink?.version ||
              projectRevisionKey(current.project) !==
                current.cloudLink?.savedRevision ||
              response.project.id !== project.id ||
              response.organizationId !== session.organization?.id
            )
              throw new Error(
                "The analysis was saved on the server, but your current draft changed. Reopen the saved project to review it; your local edits have been retained.",
              );
            flushSync(() =>
              projectAccess.acceptVerifiedSave({
                projectId: response.project.id,
                organizationId: response.organizationId,
                version: response.version,
                access: response.access,
              }),
            );
            await replace(
              response.project,
              response.baseline,
              response.baselineIdentity,
              {
                projectId: response.project.id,
                organizationId: response.organizationId,
                version: response.version,
                savedRevision: projectRevisionKey(response.project),
              },
            );
            setReadOnly(!response.access.canEdit);
            projectAccess.refresh();
            setToast(
              "Workforce evidence saved to this scenario. Undo restores the previous capture.",
            );
          }}
        />
      )}
      {dialog === "export" && results && (
        <ExportDialog
          place={place}
          project={project}
          scenario={scenario}
          results={results}
          floodResolution={floodResolution}
          onClose={() => setDialog(null)}
          capture={capture}
          onOpenMedia={(format) => {
            setMediaFormat(format);
            setDialog("media");
          }}
          cloudVersion={cloudVersion}
          hasUnsavedChanges={hasUnsavedChanges}
          onEditDescription={() => setDialog("scenario-details")}
          canEditDescription={editable}
          canProcessGis={Boolean(session.user) && editable}
          gisAccountScope={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}`}
          onRequireGisAccount={
            !session.user ? () => setDialog("auth") : undefined
          }
          onGisAccessError={projectAccess.refresh}
          onSave={async () =>
            cloudLink && !hasUnsavedChanges
              ? { projectId: project.id, version: cloudLink.version }
              : saveCloud()
          }
        />
      )}
      {dialog === "media" && (
        <Suspense fallback={<div role="status">Loading media exports…</div>}>
          <MediaExportDialog
            key={`${session.user?.id ?? "guest"}:${session.organization?.id ?? "browser"}:${baselineIdentity?.sha256}:${scenario.id}`}
            projectId={project.id}
            scenarioId={scenario.id}
            revision={scenario.revision}
            accountScope={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}`}
            canProcess={Boolean(session.user) && editable}
            initialFormat={mediaFormat}
            initialCamera={presentationCameraRef.current?.() ?? undefined}
            onClose={() => setDialog(null)}
            onAccessError={projectAccess.refresh}
            onRequireAccount={
              !session.user
                ? () => {
                    mediaAuthReturn.current = {
                      projectId: project.id,
                      scenarioId: scenario.id,
                    };
                    setDialog("auth");
                  }
                : undefined
            }
            onSave={async () =>
              cloudLink && !hasUnsavedChanges
                ? { projectId: project.id, version: cloudLink.version }
                : saveCloud()
            }
          />
        </Suspense>
      )}
      {dialog === "share" && (
        <ShareDialog
          project={project}
          scenario={scenario}
          onClose={() => setDialog(null)}
          onSave={saveCloud}
        />
      )}
      {dialog === "sources" && (
        <Modal
          title="The evidence behind the picture."
          description="Know what is observed, estimated, assumed, or not yet available."
          wide
          open
          onClose={() => setDialog(null)}
        >
          <div className="notice">
            {place.extentLabel}.{" "}
            {place.geography?.type === "zcta"
              ? "The study area follows its captured Census ZCTA boundary."
              : "This reference area is smaller than a complete ZIP area."}{" "}
            Geometry is sourced; inferred uses, heights, units, and jobs are
            estimates. Published Census survey data is displayed separately from
            building capacity. Local fiscal and trip assumptions need review
            before professional use.
          </div>
          <div className="method-summary">
            <div>
              <Globe2 />
              <h3>Real geometry</h3>
              <p>
                {place.buildings.length.toLocaleString()} building and land
                features, plus {place.roads.length.toLocaleString()} street/path
                segments.
              </p>
            </div>
            <div>
              <GitBranch />
              <h3>Reversible scenarios</h3>
              <p>
                The baseline is untouched. Changes and calculations carry
                explicit revision numbers.
              </p>
            </div>
            <div>
              <BookOpen />
              <h3>Open assumptions</h3>
              <p>
                Click any scorecard number to inspect its formula, inputs,
                method, and limitations.
              </p>
            </div>
          </div>
          <h3>Source inventory</h3>
          {planningSources(place, scenario).map((s) => (
            <div className="source-record" key={s.id}>
              <div>
                <h4>{s.name}</h4>
                <span className="badge neutral">{s.kind}</span>
              </div>
              <p>{s.description}</p>
              {/^https?:\/\//i.test(s.url) && (
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.url}
                </a>
              )}
              <small>
                {s.vintage} · {s.license}
              </small>
            </div>
          ))}
          {scenario.affordability && (
            <HousingEvidenceSources
              scenario={scenario}
              packs={project.housingIncomeLimits}
            />
          )}
          {project.fiscalStudy && (
            <details className="fiscal-workbench">
              <summary>Fiscal profile sources and applicability</summary>
              <FiscalProfileEvidence
                study={project.fiscalStudy}
                scenario={scenario}
                resolution={results?.fiscal}
              />
            </details>
          )}
          {scenario.traffic && (
            <section>
              <h3>Traffic capture sources</h3>
              <p className="muted">
                These citations belong to the retained network experiment,
                separately from planning feature and scorecard sources.
              </p>
              <TrafficSources capture={scenario.traffic.capture} />
            </section>
          )}
          {scenario.accessibility && (
            <>
              <h3>Jobs accessibility capture sources</h3>
              <AccessibilitySources accessibility={scenario.accessibility} />
            </>
          )}
          {scenario.workforce && (
            <>
              <h3>Workforce capture sources</h3>
              <p className="muted">
                These citations belong to the regional workforce capture,
                separately from planning feature and scorecard sources.
              </p>
              <WorkforceSources capture={scenario.workforce.capture} />
            </>
          )}
          {scenario.flood &&
            project.floodDatasets?.[scenario.flood.datasetHash] && (
              <FloodSources
                dataset={project.floodDatasets[scenario.flood.datasetHash]}
              />
            )}
          <h3>Coverage</h3>
          <table>
            <thead>
              <tr>
                <th>Layer</th>
                <th>Status</th>
                <th>What to know</th>
              </tr>
            </thead>
            <tbody>
              {place.coverage.map((c) => (
                <tr key={c.layer}>
                  <td>{c.layer}</td>
                  <td>{c.status}</td>
                  <td>{c.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {dialog === "history" && (
        <Modal
          title="Every idea has a history."
          description="Edits are retained with their author, time, and scenario revision."
          open
          onClose={() => setDialog(null)}
        >
          {project.history.length ? (
            project.history
              .slice()
              .reverse()
              .map((e) => (
                <div className="history-row" key={e.id}>
                  <span className="history-dot" />
                  <div>
                    <strong>{e.label}</strong>
                    <span>
                      {e.actor} · {new Date(e.at).toLocaleString()} · r
                      {e.after.revision}
                    </span>
                    {(e.superseded ||
                      project.undone.some((u) => u.id === e.id)) && (
                      <small>
                        {e.superseded ? "Superseded branch" : "Undone"}
                      </small>
                    )}
                  </div>
                </div>
              ))
          ) : (
            <div className="empty-state">
              <History size={30} />
              <h3>A clean slate.</h3>
              <p>Your changes will appear here as you explore.</p>
            </div>
          )}
        </Modal>
      )}
      {dialog === "assistant" && (
        <Modal
          title="Understand this scenario."
          description="Start with the evidence. Every answer points back to a model result."
          open
          onClose={() => setDialog(null)}
        >
          <div className="assistant-intro">
            <Sparkles size={24} />
            <p>
              Choose an outcome to inspect what changed, how it was calculated,
              and which assumptions matter.
            </p>
          </div>
          {priorityMetrics.map((m) => (
            <button
              className="assistant-question"
              key={m.id}
              onClick={() => {
                setDialog(null);
                setMetric(m);
              }}
            >
              How did {m.label.toLowerCase()} change?
              <ArrowUpRight size={15} />
            </button>
          ))}
          <div className="notice">
            Natural-language editing and narrative generation require the server
            AI integration. Evidence inspection works locally and never invents
            a model explanation.
          </div>
        </Modal>
      )}
      {dialog === "engagement" && (
        <EngagementDialog
          key={`engagement:${project.id}:${session.user?.id}:${session.organization?.id}`}
          projectId={cloudLink?.projectId ?? null}
          projectName={project.name}
          session={session}
          onClose={() => setDialog(null)}
          onRequireAccount={() => setDialog("auth")}
          onRequireSave={async () => {
            await saveCloud();
          }}
          onPublish={() => setDialog("share")}
          onAccessChanged={(access) => {
            if (!access.canEdit)
              setReadOnly(true, `You have ${access.role} access.`);
            projectAccess.refresh();
          }}
        />
      )}
      {dialog === "team" && (
        <TeamDialog
          projectId={cloudLink?.projectId ?? null}
          projectName={project.name}
          session={session}
          savedVersion={cloudVersion}
          onClose={() => setDialog(null)}
          onRequireAccount={() => setDialog("auth")}
          onAccountSecurity={() => openAccountSecurity("team")}
          onRequireSave={async () => {
            await saveCloud();
          }}
          onAccessChanged={(access) => {
            if (!access?.canEdit)
              setReadOnly(
                true,
                access
                  ? `You have ${access.role} access.`
                  : "Your access to this saved project changed.",
              );
            if (!access) updateReviewComments([]);
            projectAccess.refresh();
          }}
        />
      )}
      <ReviewDialog
        key={`review:${project.id}:${session.user?.id}:${session.organization?.id}`}
        open={dialog === "review"}
        projectId={cloudLink?.projectId ?? null}
        projectName={project.name}
        scenarioId={scenario.id}
        scenarioName={scenario.name}
        revision={scenario.revision}
        savedVersion={cloudVersion}
        hasUnsavedChanges={hasUnsavedChanges}
        session={session}
        place={place}
        target={reviewTarget}
        targetLabel={reviewTargetLabel}
        selectedCommentId={selectedReviewId ?? undefined}
        onNavigateComment={navigateReview}
        onCommentsChange={updateReviewComments}
        onAccessChanged={(access) => {
          if (!access.canEdit)
            setReadOnly(true, `You have ${access.role} access.`);
          projectAccess.refresh();
        }}
        onReopenSaved={reopenSavedVersion}
        onPickLocation={() => {
          setShowBaseline(false);
          setDialog(null);
          setSelectingCommentLocation(true);
          setPlacing(null);
        }}
        onClose={() => setDialog(null)}
        onRequireAccount={() => setDialog("auth")}
        onRequireSave={async () => {
          await saveCloud();
        }}
      />
      {projectsDialog}
      {dialog === "import" && (
        <ImportWizard
          key={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}:${scenario.id}`}
          place={place}
          project={project}
          scenario={scenario}
          canImport={Boolean(session.user) && editable}
          accountScope={`${session.user?.id}:${session.organization?.id}:${baselineIdentity?.sha256}`}
          onRequireAccount={!session.user ? () => setDialog("auth") : undefined}
          onAccessError={projectAccess.refresh}
          onSave={async () => {
            const saved =
              cloudLink && !hasUnsavedChanges
                ? { projectId: project.id, version: cloudLink.version }
                : await saveCloud();
            return saved
              ? {
                  ...saved,
                  scenarioRevision: scenario.revision,
                  baselineHash: baselineIdentity?.sha256,
                }
              : null;
          }}
          onClose={() => setDialog(null)}
          onRestore={async (snapshot) => {
            await restoreCopy(snapshot);
            setToast(
              "Project restored as a new copy. Your previous draft is available in project home.",
            );
          }}
          onCommitted={async (p, v, receipt) => {
            const current = useWorkspace.getState();
            const active = current.project?.scenarios.find(
              (item) => item.id === current.project?.activeScenarioId,
            );
            if (
              workspaceContextRef.current !== workspaceContext ||
              current.readOnly ||
              !editable ||
              current.project?.id !== project.id ||
              active?.id !== scenario.id ||
              active.revision !== scenario.revision ||
              current.cloudLink?.version !== cloudLink?.version ||
              projectRevisionKey(current.project) !==
                current.cloudLink?.savedRevision ||
              current.baselineIdentity?.sha256 !== baselineIdentity?.sha256 ||
              p.id !== project.id ||
              !session.organization ||
              receipt.organizationId !== session.organization.id
            )
              throw new Error(
                "The import was saved on the server, but your current draft or access changed. Reopen the saved project to review it; your local edits have been retained.",
              );
            flushSync(() =>
              projectAccess.acceptVerifiedSave({
                projectId: p.id,
                organizationId: receipt.organizationId,
                version: v,
                access: receipt.access,
              }),
            );
            await replace(p, place, baselineIdentity ?? undefined, {
              projectId: p.id,
              organizationId: session.organization!.id,
              version: v,
              savedRevision: projectRevisionKey(p),
            });
            setReadOnly(!receipt.access.canEdit);
            projectAccess.refresh();
            setToast("Local geometry imported as one reversible change.");
          }}
        />
      )}
      {scenarioDialog && (
        <Modal
          title="Give your next idea a name."
          description="Branch from the current scenario. Every alternative keeps its own edits and assumptions."
          open
          onClose={() => setScenarioDialog(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              branch(newScenarioName || undefined);
              setScenarioDialog(false);
              setNewScenarioName("");
              setShowBaseline(false);
            }}
          >
            <label className="field">
              <span>Scenario name</span>
              <input
                value={newScenarioName}
                onChange={(e) => setNewScenarioName(e.target.value)}
                placeholder="Option B: a greener neighborhood"
                maxLength={120}
                autoFocus
              />
            </label>
            <button className="button primary full-width">
              <GitBranch size={16} />
              Create alternative
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function ProjectsDialog({
  session,
  project,
  onClose,
  onAuth,
  onSave,
  onOpen,
  onOpenBrowser,
  onSession,
  onAccountSecurity,
  canSave,
  canViewCurrent = true,
}: {
  session: Session;
  canViewCurrent?: boolean;
  project: Project;
  onSession: (session: Session) => void;
  onAccountSecurity: () => void;
  canSave: boolean;
  onClose: () => void;
  onAuth: () => void;
  onSave: () => Promise<{ projectId: string; version: number } | null>;
  onOpenBrowser: (snapshot: WorkspaceSnapshot) => Promise<void>;
  onOpen: (
    p: Project,
    v: number,
    place: Place,
    identity: BaselineIdentity,
    access: ProjectAccess,
  ) => Promise<void>;
}) {
  const [projects, setProjects] = useState<
    {
      project: Pick<Project, "id" | "name" | "placeId" | "updatedAt"> & {
        scenarioCount: number;
      };
      version: number;
      access: ProjectAccess;
    }[]
  >([]);
  const sessionKey = `${session.user?.id ?? "guest"}:${session.organization?.id ?? ""}`;
  const [projectsSessionKey, setProjectsSessionKey] = useState("");
  const visibleProjects = projectsSessionKey === sessionKey ? projects : [];
  const [browserDrafts, setBrowserDrafts] = useState<BrowserDraftSummary[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    setProjects([]);
    setError("");
    if (!session.user) return;
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const r = await api<{ projects: typeof projects }>("/projects", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setProjects(r.projects);
          setProjectsSessionKey(sessionKey);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setProjects([]);
          setProjectsSessionKey("");
          setError((e as Error).message);
          if (e instanceof ApiError && e.status === 401)
            onSession({ user: null });
        }
      } finally {
        pending = false;
      }
    };
    void read();
    const focus = () => void read();
    const timer = setInterval(focus, 30000);
    window.addEventListener("focus", focus);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [session, sessionKey, onSession]);
  const visibleDrafts = browserDrafts.filter(
    (draft) =>
      !draft.cloudOrganizationId ||
      (draft.cloudOrganizationId === session.organization?.id &&
        visibleProjects.some((item) => item.project.id === draft.id)),
  );
  useEffect(() => {
    let active = true;
    listWorkspaceDrafts()
      .then((drafts) => {
        if (active) setBrowserDrafts(drafts);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [project.id, project.updatedAt]);
  return (
    <Modal
      title="Your places. Your possibilities."
      description="Start where you left off, or save your current work."
      open
      onClose={onClose}
    >
      {session.user && (
        <div className="identity-actions">
          <WorkspaceSwitcher session={session} onSession={onSession} />
          <button type="button" className="button" onClick={onAccountSecurity}>
            <ShieldCheck size={15} aria-hidden="true" />
            Account security
          </button>
        </div>
      )}
      <div className="share-preview">
        <MapPin size={30} />
        <div>
          <h3>{canViewCurrent ? project.name : "Saved browser draft"}</h3>
          <p>
            {canViewCurrent
              ? `${project.scenarios.length} scenarios · Current browser draft`
              : "Access needs to be verified before reopening."}
          </p>
        </div>
      </div>
      {session.user ? (
        <button
          className="button primary full-width"
          disabled={busy || !canSave}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave();
              const r = await api<{
                projects: {
                  project: Pick<
                    Project,
                    "id" | "name" | "placeId" | "updatedAt"
                  > & { scenarioCount: number };
                  version: number;
                  access: ProjectAccess;
                }[];
              }>("/projects");
              if (
                sessionRef.current.user?.id === session.user?.id &&
                sessionRef.current.organization?.id === session.organization?.id
              ) {
                setProjects(r.projects);
                setProjectsSessionKey(sessionKey);
              }
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Cloud size={16} />
          {busy ? "Saving…" : "Save current project to account"}
        </button>
      ) : (
        <button className="button primary full-width" onClick={onAuth}>
          Create a free account to save
          <ArrowRight size={16} />
        </button>
      )}
      {session.user && !canSave && (
        <p className="notice">
          This saved proposal is open for review, or your current workspace does
          not permit new projects. You can inspect it and use your own workspace
          for new work.
        </p>
      )}
      <section aria-label="On this browser">
        <h3>On this browser</h3>
        {visibleDrafts.map((draft) => (
          <button
            className="search-result"
            key={draft.id}
            disabled={busy || draft.id === project.id}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onOpenBrowser(await readWorkspaceDraft(draft.id));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <MapPin size={24} />
            <div>
              <strong>{draft.name}</strong>
              <span>
                {new Date(draft.updatedAt).toLocaleString()}
                {draft.baselineLoadedAt
                  ? ` · Source captured ${draft.baselineLoadedAt.slice(0, 10)}`
                  : " · Captured baseline"}
                {draft.id === project.id ? " · Current draft" : ""}
              </span>
            </div>
            <ArrowRight size={16} />
          </button>
        ))}
        {!visibleDrafts.length && (
          <p className="muted small">No stored browser drafts are available.</p>
        )}
      </section>
      <section aria-label="Saved account projects">
        {visibleProjects.length > 0 && <h3>Saved projects</h3>}
        {visibleProjects.map(({ project: p, version, access }) => (
          <button
            className="search-result"
            key={p.id}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const detail = await api<{
                  project: Project;
                  version: number;
                  baseline: Place;
                  baselineIdentity: BaselineIdentity;
                  access: ProjectAccess;
                }>(`/projects/${p.id}`);
                if (
                  sessionRef.current.user?.id !== session.user?.id ||
                  sessionRef.current.organization?.id !==
                    session.organization?.id
                )
                  throw new Error(
                    "The workspace changed. Select the project again.",
                  );
                await onOpen(
                  detail.project,
                  detail.version,
                  detail.baseline,
                  detail.baselineIdentity,
                  detail.access,
                );
              } catch (e) {
                setError((e as Error).message);
                if (e instanceof ApiError) {
                  if (e.status === 403 || e.status === 404)
                    setProjects((all) =>
                      all.filter((item) => item.project.id !== p.id),
                    );
                  if (e.status === 401) {
                    setProjects([]);
                    onSession({ user: null });
                  }
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            <MapPin size={24} />
            <div>
              <strong>{p.name}</strong>
              <span>
                {p.scenarioCount} scenarios ·{" "}
                {new Date(p.updatedAt).toLocaleDateString()}
                {access ? ` · ${access.role}` : ""}
              </span>
            </div>
            <ArrowRight size={16} />
          </button>
        ))}
      </section>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
