import { PublishedHousingAffordability } from "./housing/HousingOverview";
import {
  PublishedFiscal,
  FiscalProfileEvidence,
} from "./fiscal/FiscalOverview";
import { useImpact } from "../lib/useImpact";
import {
  FloodEvidence,
  FloodSources,
  FloodBuildingContext,
} from "./flood/FloodEvidence";
import {
  PublishedAccessibility,
  AccessibilitySources,
} from "./accessibility/AccessibilityOverview";
import { PublishedTraffic, TrafficSources } from "./traffic/TrafficOverview";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  Globe2,
  Layers,
  List,
  LockKeyhole,
  MapPin,
  MessageSquare,
  Pause,
  Play,
  Search,
  Send,
  ShieldCheck,
  ThumbsUp,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  landUseLabels,
  buildingAnchor,
  buildingAreaSqm,
  buildingProgramTotals,
  buildingProgramWarnings,
  buildingTypologyLabels,
  materializeBuildings,
  materializeRoads,
  materializeParcels,
  parcelAreaSqm,
  studyAreaAnchor,
  pointInStudyArea,
  type FloodDataset,
  type Assumptions,
  type MetricDomain,
  type MetricResult,
  type ModelResults,
  type Place,
  type Position,
  type Scenario,
} from "@urban/core";
import { formatMetric } from "@urban/models";
import { api, ApiError, type Session } from "../lib/api";
import { AuthDialog } from "./Dialogs";
import { Modal } from "./Modal";
import { PresentationDialog } from "./presentation/PresentationDialog";
import { PublishedActivity } from "./activity/ActivitySummary";
import { PublishedRetail } from "./retail/RetailOverview";
import {
  PublishedWorkforce,
  WorkforceSources,
} from "./workforce/WorkforceOverview";
import {
  planningSources,
  housingSources,
  housingSourceInventory,
} from "../lib/source-inventory";
import { MetricDetail } from "./MetricDetail";
import "./shared-view.css";
import { PublicEngagement } from "./engagement/PublicEngagement";
import type { PublicEngagement as EngagementState } from "../../../../packages/core/src/engagement";
import {
  defaultEngagement,
  disabledEngagement,
  parsePublicPin,
} from "./engagement/state";

const CityMap = lazy(() => import("./CityMap"));
export interface PublicSnapshot {
  id: string;
  projectName: string;
  placeId: string;
  place: Place;
  scenario: Scenario;
  results: ModelResults;
  createdAt: string;
  feedbackEnabled: boolean;
  floodDataset?: FloodDataset;
  fiscalStudy?: import("@urban/core").FiscalStudy;
  housingIncomeLimits?: import("@urban/core").HousingIncomeLimitCatalog;
  engagement?: EngagementState;
}
class SnapshotError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function fetchSnapshot(
  snapshotId: string,
  signal: AbortSignal,
): Promise<PublicSnapshot> {
  const response = await fetch(
    `/api/v1/published/${encodeURIComponent(snapshotId)}`,
    { signal, credentials: "include" },
  );
  if (!response.ok)
    throw new SnapshotError(
      response.status === 404
        ? "This link may have been removed or revoked by the project owner."
        : "The published scenario could not be loaded. Check your connection and try again.",
      response.status,
    );
  const snapshot = (await response.json()) as PublicSnapshot;
  if (
    !snapshot.place ||
    snapshot.place.id !== snapshot.placeId ||
    snapshot.results?.revision !== snapshot.scenario?.revision ||
    snapshot.results?.scenarioId !== snapshot.scenario?.id
  ) {
    throw new SnapshotError(
      "The snapshot data and results do not match. The project owner will need to publish a new snapshot.",
      409,
    );
  }
  return snapshot;
}

const SHARED_LAYERS = [
  "flood",
  "buildings",
  "roads",
  "parks",
  "agents",
  "land-use",
  "parcels",
  "neighborhoods",
];
const priorityMetrics = [
  "housing.units",
  "economy.jobs",
  "mobility.dailyTrips",
  "fiscal.netAnnual",
  "economy.payroll",
  "environment.ghg",
];
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
function publishedDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}
function valueString(value: number | string | boolean) {
  return typeof value === "boolean"
    ? value
      ? "Confirmed"
      : "Not confirmed"
    : typeof value === "number"
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(
          value,
        )
      : value;
}
const assumptionLabels: Partial<Record<keyof Assumptions, string>> = {
  householdSize: "People per occupied home",
  vacancyRate: "Vacancy fraction",
  parkingPerUnit: "Parking spaces per home",
  parkingPer1000Sqft: "Parking spaces per 1,000 commercial ft²",
  annualWage: "Annual average wage ($)",
  assessedValuePerSqft: "Assumed assessed value per ft² ($)",
  effectivePropertyTaxRate: "Effective retained property-tax fraction",
  annualServiceCostPerResident: "Annual service cost per resident ($)",
  annualServiceCostPerJob: "Annual service cost per job ($)",
  annualGrowthRate: "Annual growth fraction",
  discountRate: "Real discount fraction",
  driveShare: "Driving share",
  transitShare: "Transit share",
  bikeShare: "Cycling share",
  walkShare: "Walking share",
  populationMultiplier: "Population multiplier",
  vehicleMultiplier: "Vehicle multiplier",
  incentiveGrant: "Up-front incentive grant ($)",
  abatementPercent: "Abatement fraction on added value",
  abatementYears: "Abatement duration (years)",
  salesPerSqft: "Annual retail sales per ft² ($)",
  localSalesTaxRate: "Retained sales-tax fraction",
  retailCaptureRate: "Retail capture fraction",
  emissionsKgPerMile: "Emission factor (kg CO₂/mile)",
  averageTripMiles: "Average trip length (miles)",
  jurisdictionName: "Receiving fiscal jurisdiction",
  fiscalInputsConfirmed: "Fiscal inputs reviewed",
  tripRatesConfirmed: "Trip inputs reviewed",
};

function FrozenAssumptions({ scenario }: { scenario: Scenario }) {
  const rows = Object.entries(scenario.assumptions).filter(
    ([, value]) => typeof value !== "object",
  ) as [keyof Assumptions, number | string | boolean][];
  return (
    <>
      <div className="notice">
        These assumptions were frozen when this snapshot was published.
        Fractions use 0–1 notation: 0.03 means 3%. Confirmation records input
        review, not independent model validation.
      </div>
      <div className="table-scroll shared-assumptions-table">
        <table>
          <thead>
            <tr>
              <th>Assumption</th>
              <th>Baseline</th>
              <th>Scenario</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, value]) => (
              <tr key={key}>
                <th scope="row">{assumptionLabels[key] ?? key}</th>
                <td>
                  {valueString(
                    scenario.baselineAssumptions[key] as
                      | number
                      | string
                      | boolean,
                  )}
                </td>
                <td>{valueString(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="shared-section-heading">Trip-generation coefficients</h3>
      <p className="muted small">
        Illustrative defaults unless replaced and reviewed. Daily vehicle-trip
        ends per occupied home or per 1,000 commercial ft² at the model’s
        reference drive share.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Land use</th>
              <th>Baseline</th>
              <th>Scenario</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(scenario.assumptions.tripRates).map(
              ([use, value]) => (
                <tr key={use}>
                  <th scope="row">
                    {landUseLabels[use as keyof typeof landUseLabels]}
                  </th>
                  <td>
                    {
                      scenario.baselineAssumptions.tripRates[
                        use as keyof typeof landUseLabels
                      ]
                    }
                  </td>
                  <td>{value}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SharedView({ snapshotId }: { snapshotId: string }) {
  const query = useQuery({
    queryKey: ["published-snapshot", snapshotId],
    queryFn: ({ signal }) => fetchSnapshot(snapshotId, signal),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const snapshot = query.data;
  const floodContext = useMemo(
    () => ({
      fiscalStudy: snapshot?.fiscalStudy,
      housingIncomeLimits: snapshot?.housingIncomeLimits,
      floodDatasets:
        snapshot?.scenario.flood && snapshot.floodDataset
          ? { [snapshot.scenario.flood.datasetHash]: snapshot.floodDataset }
          : undefined,
    }),
    [snapshot],
  );
  const { flood: floodResolution, error: floodCalculationError } = useImpact(
    snapshot?.scenario.flood ? snapshot.place : null,
    snapshot?.scenario.flood ? snapshot.scenario : undefined,
    floodContext,
  );
  const engagementQuery = useQuery({
    queryKey: ["public-engagement", snapshotId],
    queryFn: ({ signal }) =>
      api<EngagementState>(
        `/published/${encodeURIComponent(snapshotId)}/engagement`,
        { signal },
      ),
    retry: false,
    staleTime: 10000,
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
  });
  const engagement = engagementQuery.data ??
    snapshot?.engagement ?? {
      config: snapshot?.feedbackEnabled
        ? defaultEngagement()
        : disabledEngagement(),
      collection: {
        status: snapshot?.feedbackEnabled
          ? ("open" as const)
          : ("closed" as const),
        version: 1,
        updatedAt: snapshot?.createdAt ?? "",
      },
    };
  const engagementConfigured =
    engagement.config.comments ||
    engagement.config.votes ||
    engagement.config.pins ||
    engagement.config.questions.length > 0;
  const [publicUnavailable, setPublicUnavailable] = useState(false);
  const refreshEngagement = useCallback(() => {
    void engagementQuery.refetch();
  }, [engagementQuery.refetch]);
  const markUnavailable = useCallback(() => setPublicUnavailable(true), []);

  const [session, setSession] = useState<Session>({ user: null });
  const [authOpen, setAuthOpen] = useState(false);
  const [dialog, setDialog] = useState<
    "sources" | "assumptions" | "features" | "accessibility" | "flood" | null
  >(null);
  const [metric, setMetric] = useState<MetricResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null);
  const [view, setView] = useState<"3d" | "2d" | "satellite">("3d");
  const [playing, setPlaying] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [tab, setTab] = useState<"outcomes" | "feedback">("outcomes");
  const [domain, setDomain] = useState<MetricDomain | "Highlights">(
    "Highlights",
  );
  const [featureQuery, setFeatureQuery] = useState("");
  const [featureLimit, setFeatureLimit] = useState(50);
  const [feedbackLocationState, setFeedbackLocationState] =
    useState<Position | null>(null);
  const locationOwner = useRef<string | null>(null);
  const setFeedbackLocation = useCallback(
    (position: Position | null) => {
      locationOwner.current = session.user?.id ?? null;
      setFeedbackLocationState(position);
    },
    [session.user?.id],
  );
  const feedbackLocation =
    locationOwner.current && locationOwner.current !== session.user?.id
      ? null
      : feedbackLocationState;
  const [selectingLocation, setSelectingLocation] = useState(false);
  const [locationError, setLocationError] = useState("");
  const mapPanelRef = useRef<HTMLElement>(null),
    feedbackPanelRef = useRef<HTMLElement>(null);
  const previousUser = useRef<string | null>(null);
  const sessionRefresh = useRef<() => void>(() => {});
  const clearSession = useCallback(() => {
    setSession({ user: null });
    sessionRefresh.current();
  }, []);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false,
      closed = false;
    const refresh = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const result = await api<Session>("/auth/session", {
          signal: controller.signal,
        });
        if (!closed) {
          setSession(result);
          setSessionUnavailable(false);
        }
      } catch (error) {
        if (!closed && (error as Error).name !== "AbortError") {
          setSessionUnavailable(true);
          setSession({ user: null });
        }
      } finally {
        busy = false;
      }
    };
    sessionRefresh.current = () => void refresh();
    void refresh();
    const focused = () => void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    window.addEventListener("focus", focused);
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focused);
      sessionRefresh.current = () => {};
    };
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setShowTour(false);
    setSelectedParcelId(null);
    setMetric(null);
    setDialog(null);
    setFeedbackLocation(null);
    setSelectingLocation(false);
    setLocationError("");
    setPublicUnavailable(false);
    setTab("outcomes");
  }, [snapshotId]);
  useEffect(() => {
    const current = session.user?.id ?? null;
    if (previousUser.current && previousUser.current !== current) {
      setFeedbackLocation(null);
      setSelectingLocation(false);
    }
    if (!previousUser.current && current && feedbackLocationState)
      locationOwner.current = current;
    previousUser.current = current;
  }, [session.user?.id]);
  useEffect(() => {
    if (engagement.collection.status !== "open" || !engagement.config.pins)
      setSelectingLocation(false);
  }, [engagement.collection.status, engagement.config.pins]);
  const linkedPin = useMemo(
    () =>
      snapshot
        ? parsePublicPin(
            new URLSearchParams(window.location.search).get("pin"),
            snapshot.place,
          )
        : null,
    [snapshotId, snapshot?.place],
  );
  const displayedPin = feedbackLocation ?? linkedPin;
  const linkedFocus = useMemo(
    () =>
      displayedPin
        ? {
            position: displayedPin,
            requestId: `public-pin:${snapshotId}:${displayedPin.join(",")}`,
          }
        : null,
    [snapshotId, displayedPin],
  );

  const buildings = useMemo(
    () =>
      snapshot ? materializeBuildings(snapshot.place, snapshot.scenario) : [],
    [snapshot],
  );
  const roads = useMemo(
    () => (snapshot ? materializeRoads(snapshot.place, snapshot.scenario) : []),
    [snapshot],
  );
  const parcels = useMemo(
    () =>
      snapshot ? materializeParcels(snapshot.place, snapshot.scenario) : [],
    [snapshot],
  );
  const selectedParcel = useMemo(
    () => parcels.find((parcel) => parcel.id === selectedParcelId),
    [parcels, selectedParcelId],
  );
  const selectedParcelParts = selectedParcel
    ? selectedParcel.geometry.type === "Polygon"
      ? [selectedParcel.geometry.coordinates]
      : selectedParcel.geometry.coordinates
    : [];
  const disclosurePlace = useMemo(
    () =>
      snapshot
        ? {
            ...snapshot.place,
            sources: planningSources(snapshot.place, snapshot.scenario),
          }
        : undefined,
    [snapshot],
  );
  const selectedBuilding = useMemo(
    () => buildings.find((b) => b.id === selectedId),
    [buildings, selectedId],
  );
  const selectedRoad = useMemo(
    () => roads.find((r) => r.id === selectedId),
    [roads, selectedId],
  );
  const selectedSource = disclosurePlace?.sources.find(
    (s) =>
      s.id ===
      (selectedBuilding?.sourceId ??
        selectedRoad?.sourceId ??
        selectedParcel?.sourceId),
  );
  const selectedGeometrySource = disclosurePlace?.sources.find(
    (source) =>
      source.id ===
      (selectedBuilding?.geometrySourceId ??
        selectedRoad?.geometrySourceId ??
        selectedParcel?.geometrySourceId),
  );
  const selectedAttributeSource = disclosurePlace?.sources.find(
    (s) =>
      s.id ===
      (selectedBuilding?.attributeSourceId ?? selectedRoad?.attributeSourceId),
  );
  const selectedPosition: Position | undefined =
    (selectedBuilding ? buildingAnchor(selectedBuilding) : undefined) ??
    selectedRoad?.coordinates[0] ??
    (selectedParcel ? studyAreaAnchor(selectedParcel.geometry) : undefined);
  const visibleMetrics =
    snapshot?.results.metrics.filter((m) =>
      domain === "Highlights"
        ? priorityMetrics.includes(m.id)
        : m.domain === domain,
    ) ?? [];
  const filteredFeatures = useMemo(() => {
    const normalized = featureQuery.toLowerCase().trim();
    return [
      ...buildings.map((b) => ({
        kind: "building" as const,
        id: b.id,
        name: b.name,
        detail: `${landUseLabels[b.use]}${b.address ? ` · ${b.address}` : ""}`,
      })),
      ...roads.map((r) => ({
        kind: "road" as const,
        id: r.id,
        name: r.name,
        detail: `Street · ${r.closed ? "Closed" : `${r.lanes} lanes`}`,
      })),
      ...parcels.map((parcel) => ({
        kind: "parcel" as const,
        id: parcel.id,
        name: parcel.name,
        detail: `${parcel.kind === "block" ? "Block" : "Parcel"} · ${Math.round(parcelAreaSqm(parcel)).toLocaleString()} m²`,
      })),
    ].filter((f) => `${f.name} ${f.detail}`.toLowerCase().includes(normalized));
  }, [buildings, roads, parcels, featureQuery]);

  if (query.isPending)
    return (
      <div className="shared-state">
        <div className="shared-brand">
          <Globe2 size={26} /> urban<span>planning.</span>
        </div>
        <div className="loading-city" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <h1>Opening a shared possibility.</h1>
        <p role="status">
          Loading the published scenario and its original results.
        </p>
      </div>
    );
  if (
    query.error ||
    !snapshot ||
    publicUnavailable ||
    (engagementQuery.error instanceof ApiError &&
      engagementQuery.error.status === 404)
  ) {
    const missing =
      (query.error instanceof SnapshotError && query.error.status === 404) ||
      publicUnavailable ||
      (engagementQuery.error instanceof ApiError &&
        engagementQuery.error.status === 404);
    return (
      <main className="shared-state">
        <div className="shared-state-icon">
          <LockKeyhole size={28} />
        </div>
        <h1>
          {missing
            ? "This shared link is unavailable."
            : "We couldn’t open this scenario."}
        </h1>
        <p role="alert">
          {query.error instanceof Error
            ? query.error.message
            : "This published link is unavailable or has been revoked."}
        </p>
        <div className="shared-state-actions">
          <button className="button" onClick={() => void query.refetch()}>
            Try again
          </button>
          <a className="button primary" href="/">
            Explore Urban Planning <ArrowRight size={16} />
          </a>
        </div>
        {missing && (
          <p className="shared-subtle">
            Ask the project owner for a current published link.
          </p>
        )}
      </main>
    );
  }

  const publicationTime = publishedDate(snapshot.createdAt);
  return (
    <div className="shared-page">
      <a className="skip-link" href="#shared-outcomes">
        Skip to scenario outcomes
      </a>
      <header className="shared-header">
        <a className="shared-brand" href="/" aria-label="Urban Planning home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          urban
          <span>
            planning<span className="brand-period">.</span>
          </span>
        </a>
        <span className="shared-public-badge">
          <Globe2 size={13} /> A shared possibility
        </span>
        <a className="shared-home-link" href="/">
          Explore your own place <ArrowRight size={15} />
        </a>
      </header>
      <section className="shared-intro" aria-labelledby="snapshot-title">
        <div>
          <div className="shared-eyebrow">
            <MapPin size={12} />
            {snapshot.place.city}, {snapshot.place.state}
            <span> / </span>
            {snapshot.projectName}
          </div>
          <h1 id="snapshot-title">{snapshot.scenario.name}</h1>
          <p>
            {snapshot.scenario.description ||
              "Explore the proposal, understand its tradeoffs, and see the assumptions behind the numbers."}
          </p>
        </div>
        <div className="shared-publication">
          <span>
            <LockKeyhole size={14} /> Read-only published snapshot
          </span>
          <span>
            <CalendarDays size={14} />
            <time dateTime={snapshot.createdAt}>{publicationTime}</time> ·
            Revision {snapshot.scenario.revision}
          </span>
          {engagementConfigured && (
            <span className="shared-collection-badge">
              <MessageSquare size={14} />
              {engagement.collection.status === "open"
                ? "Feedback collection open"
                : "Feedback collection closed"}
            </span>
          )}
          {snapshot.scenario.presentation && (
            <button
              className="button secondary"
              onClick={() => {
                setPlaying(false);
                setShowTour(true);
              }}
            >
              <Play size={14} /> Watch guided tour
            </button>
          )}
          <button onClick={() => setDialog("sources")}>
            <ShieldCheck size={14} /> Sources & coverage{" "}
            <ChevronRight size={13} />
          </button>
        </div>
      </section>
      <main className="shared-content">
        <section
          className="shared-map-panel"
          aria-label="Published scenario map"
          ref={mapPanelRef}
        >
          <Suspense
            fallback={
              <div className="map-loading" role="status">
                Loading the geographic view…
              </div>
            }
          >
            <CityMap
              place={snapshot.place}
              scenario={snapshot.scenario}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setSelectedParcelId(null);
              }}
              selectedParcelIds={selectedParcelId ? [selectedParcelId] : []}
              view={view}
              playing={playing}
              speed={1}
              timeOfDay={15}
              layers={SHARED_LAYERS}
              floodDatasets={floodContext.floodDatasets}
              selectingCommentLocation={selectingLocation}
              onMapClick={(position) => {
                if (!selectingLocation) return;
                if (!pointInStudyArea(position, snapshot.place)) {
                  setLocationError(
                    "Choose a location inside the published study area.",
                  );
                  return;
                }
                setFeedbackLocation(position);
                setSelectingLocation(false);
                setLocationError("");
                setTab("feedback");
                requestAnimationFrame(() =>
                  feedbackPanelRef.current?.scrollIntoView({
                    block: "nearest",
                  }),
                );
              }}
              reviewPins={
                displayedPin
                  ? [
                      {
                        id: "public-comment-location",
                        position: displayedPin,
                        label: feedbackLocation
                          ? "Your comment location"
                          : "Shared map location",
                      },
                    ]
                  : []
              }
              focusLocation={linkedFocus}
            />
          </Suspense>
          {selectingLocation && (
            <div
              className={`shared-pin-banner ${locationError ? "error" : ""}`}
              role="status"
            >
              <MapPin size={16} />
              <span>
                {locationError ||
                  "Select a comment location inside the published study area."}
              </span>
              <button
                className="icon-button"
                aria-label="Cancel comment location"
                onClick={() => {
                  setSelectingLocation(false);
                  setLocationError("");
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="shared-map-topbar">
            <div className="shared-snapshot-label">
              <Layers size={14} />
              <span>
                {snapshot.scenario.horizon
                  ? `${snapshot.scenario.horizon}-year horizon`
                  : "Current horizon"}
              </span>
            </div>
            <div className="view-switch" role="group" aria-label="Map view">
              {(["3d", "2d", "satellite"] as const).map((mode) => (
                <button
                  key={mode}
                  className={view === mode ? "active" : ""}
                  aria-pressed={view === mode}
                  onClick={() => setView(mode)}
                >
                  {mode === "3d"
                    ? "3D city"
                    : mode === "2d"
                      ? "2D plan"
                      : "Satellite"}
                </button>
              ))}
            </div>
          </div>
          <div className="shared-map-actions">
            <button
              className="map-action"
              onClick={() => {
                setDialog("features");
                setFeatureQuery("");
                setFeatureLimit(50);
              }}
            >
              <List size={15} /> Browse features
            </button>
            <button
              className="map-action"
              onClick={() => setPlaying((p) => !p)}
              aria-pressed={playing}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}{" "}
              {playing ? "Pause activity" : "Play activity"}
            </button>
          </div>
          {(selectedBuilding || selectedRoad || selectedParcel) && (
            <section
              className="shared-inspector"
              aria-label="Selected feature details"
            >
              <div className="shared-inspector-heading">
                <div>
                  <span>
                    {selectedBuilding
                      ? landUseLabels[selectedBuilding.use]
                      : selectedParcel
                        ? selectedParcel.kind === "block"
                          ? "Block boundary"
                          : "Parcel boundary"
                        : "Street"}
                  </span>
                  <h2>
                    {selectedBuilding?.name ??
                      selectedRoad?.name ??
                      selectedParcel?.name}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  onClick={() => {
                    setSelectedId(null);
                    setSelectedParcelId(null);
                    setFeedbackLocation(null);
                  }}
                  aria-label="Close feature details"
                >
                  <X size={17} />
                </button>
              </div>
              {selectedBuilding ? (
                <>
                  {snapshot.scenario.flood && (
                    <FloodBuildingContext
                      row={floodResolution?.scenario.buildings.find(
                        (row) => row.buildingId === selectedBuilding.id,
                      )}
                      onOpen={() => setDialog("assumptions")}
                    />
                  )}
                  <dl className="shared-feature-facts">
                    {selectedBuilding.typology && (
                      <div>
                        <dt>Building type</dt>
                        <dd>
                          {buildingTypologyLabels[selectedBuilding.typology]}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Height</dt>
                      <dd>
                        {selectedBuilding.height === null
                          ? "Unknown"
                          : `${selectedBuilding.height.toLocaleString()} m`}
                      </dd>
                    </div>
                    <div>
                      <dt>Floors</dt>
                      <dd>{selectedBuilding.floors ?? "Unknown"}</dd>
                    </div>
                    <div>
                      <dt>Homes</dt>
                      <dd>{selectedBuilding.units ?? "Unknown"}</dd>
                    </div>
                    <div>
                      <dt>Direct jobs</dt>
                      <dd>{selectedBuilding.jobs ?? "Unknown"}</dd>
                    </div>
                    <div>
                      <dt>Footprint</dt>
                      <dd>
                        {Math.round(
                          buildingAreaSqm(selectedBuilding),
                        ).toLocaleString()}{" "}
                        m²
                      </dd>
                    </div>
                    <div>
                      <dt>Parking</dt>
                      <dd>
                        {selectedBuilding.parkingSpaces === null
                          ? "Unknown"
                          : `${selectedBuilding.parkingSpaces} spaces`}
                      </dd>
                    </div>
                    <div>
                      <dt>Gross floor area</dt>
                      <dd>
                        {buildingProgramTotals(selectedBuilding)
                          .grossFloorAreaSqm === null
                          ? "Unknown"
                          : `${Math.round(buildingProgramTotals(selectedBuilding).grossFloorAreaSqm!).toLocaleString()} m²`}
                      </dd>
                    </div>
                  </dl>
                  {selectedBuilding.program && (
                    <details className="shared-building-program">
                      <summary>Development program</summary>
                      <dl className="shared-feature-facts shared-building-components">
                        {selectedBuilding.program.components.map(
                          (component) => (
                            <div key={component.id}>
                              <dt>
                                {component.name || landUseLabels[component.use]}
                              </dt>
                              <dd>
                                {Math.round(
                                  component.grossFloorAreaSqm,
                                ).toLocaleString()}{" "}
                                m² · {component.units.toLocaleString()} homes ·{" "}
                                {component.jobs.toLocaleString()} jobs
                                {component.beds !== undefined
                                  ? ` · ${component.beds.toLocaleString()} beds`
                                  : ""}
                                {component.tripRate && (
                                  <small>
                                    Trips:{" "}
                                    {component.tripRate.value.toLocaleString()}{" "}
                                    per{" "}
                                    {component.tripRate.basis
                                      .replace(
                                        "occupied-dwelling",
                                        "occupied dwelling",
                                      )
                                      .replace("1000-sqft", "1,000 ft²")}{" "}
                                    ·{" "}
                                    {disclosurePlace?.sources.find(
                                      (source) =>
                                        source.id ===
                                        component.tripRate!.sourceId,
                                    )?.name ?? component.tripRate.sourceId}
                                  </small>
                                )}
                                {component.parkingRate && (
                                  <small>
                                    Parking demand:{" "}
                                    {component.parkingRate.value.toLocaleString()}{" "}
                                    per{" "}
                                    {component.parkingRate.basis
                                      .replace(
                                        "occupied-dwelling",
                                        "occupied dwelling",
                                      )
                                      .replace("1000-sqft", "1,000 ft²")}{" "}
                                    ·{" "}
                                    {disclosurePlace?.sources.find(
                                      (source) =>
                                        source.id ===
                                        component.parkingRate!.sourceId,
                                    )?.name ?? component.parkingRate.sourceId}
                                  </small>
                                )}
                              </dd>
                            </div>
                          ),
                        )}
                        <div>
                          <dt>Common area</dt>
                          <dd>
                            {Math.round(
                              selectedBuilding.program.commonAreaSqm,
                            ).toLocaleString()}{" "}
                            m²
                          </dd>
                        </div>
                      </dl>
                    </details>
                  )}
                  {buildingProgramWarnings(selectedBuilding).map((warning) => (
                    <p className="notice" key={warning}>
                      {warning}
                    </p>
                  ))}
                </>
              ) : selectedRoad ? (
                <dl className="shared-feature-facts">
                  <div>
                    <dt>Status</dt>
                    <dd>{selectedRoad.closed ? "Closed" : "Open"}</dd>
                  </div>
                  <div>
                    <dt>Lanes</dt>
                    <dd>{selectedRoad.lanes}</dd>
                  </div>
                  <div>
                    <dt>Speed</dt>
                    <dd>{selectedRoad.speedMph} mph</dd>
                  </div>
                  <div>
                    <dt>Direction</dt>
                    <dd>{selectedRoad.oneWay ? "One way" : "Two way"}</dd>
                  </div>
                </dl>
              ) : selectedParcel ? (
                <dl className="shared-feature-facts">
                  <div>
                    <dt>Land area</dt>
                    <dd>
                      {Math.round(
                        parcelAreaSqm(selectedParcel),
                      ).toLocaleString()}{" "}
                      m²
                    </dd>
                  </div>
                  <div>
                    <dt>Separate parts</dt>
                    <dd>{selectedParcelParts.length}</dd>
                  </div>
                  <div>
                    <dt>Holes preserved</dt>
                    <dd>
                      {selectedParcelParts.reduce(
                        (sum, part) => sum + part.length - 1,
                        0,
                      )}
                    </dd>
                  </div>
                </dl>
              ) : null}
              <p className="shared-feature-source">
                {selectedBuilding?.estimated ? "Estimated attributes · " : ""}
                {selectedSource?.name ?? "Scenario-supplied feature"}
                {selectedSource ? ` · ${selectedSource.vintage}` : ""}
                {selectedAttributeSource ? (
                  <>
                    <br />
                    Attributes: {selectedAttributeSource.name} ·{" "}
                    {selectedAttributeSource.vintage}
                  </>
                ) : null}
                {selectedGeometrySource && (
                  <>
                    <br />
                    Geometry: {selectedGeometrySource.name} ·{" "}
                    {selectedGeometrySource.vintage}
                  </>
                )}
              </p>
              {engagement.collection.status === "open" &&
                engagement.config.pins && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setTab("feedback");
                      setFeedbackLocation(selectedPosition ?? null);
                      requestAnimationFrame(() =>
                        feedbackPanelRef.current?.scrollIntoView({
                          block: "nearest",
                        }),
                      );
                    }}
                  >
                    <MessageSquare size={13} /> Comment on this location{" "}
                    <ChevronRight size={13} />
                  </button>
                )}
            </section>
          )}
          <div className="shared-map-disclosure">
            {snapshot.place.extentLabel} · Activity is illustrative; analytical
            results are frozen.
          </div>
        </section>
        <aside
          className="shared-sidebar"
          id="shared-outcomes"
          tabIndex={-1}
          aria-label="Scenario outcomes and feedback"
        >
          <div
            className="shared-sidebar-tabs"
            role="tablist"
            aria-label="Published scenario details"
          >
            <button
              role="tab"
              aria-selected={tab === "outcomes"}
              aria-controls="shared-outcomes-panel"
              id="shared-outcomes-tab"
              tabIndex={tab === "outcomes" ? 0 : -1}
              onClick={() => setTab("outcomes")}
              onKeyDown={(e) => {
                if (
                  engagementConfigured &&
                  (e.key === "ArrowRight" || e.key === "ArrowLeft")
                ) {
                  e.preventDefault();
                  setTab("feedback");
                  document.getElementById("shared-feedback-tab")?.focus();
                }
              }}
            >
              <Layers size={15} /> Outcomes
            </button>
            {engagementConfigured && (
              <button
                role="tab"
                aria-selected={tab === "feedback"}
                aria-controls="shared-feedback-panel"
                id="shared-feedback-tab"
                tabIndex={tab === "feedback" ? 0 : -1}
                onClick={() => setTab("feedback")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    setTab("outcomes");
                    document.getElementById("shared-outcomes-tab")?.focus();
                  }
                }}
              >
                <MessageSquare size={15} /> Your voice
              </button>
            )}
          </div>
          {tab === "outcomes" ? (
            <section
              id="shared-outcomes-panel"
              role="tabpanel"
              aria-labelledby="shared-outcomes-tab"
              className="shared-outcomes"
            >
              <div className="shared-outcome-heading">
                <div className="shared-eyebrow">A clearer picture</div>
                <h2>What changes?</h2>
                <p>
                  Baseline and proposal, with the reasoning behind every number.
                </p>
              </div>
              <label className="shared-domain">
                <span>Explore outcomes</span>
                <select
                  value={domain}
                  onChange={(e) => setDomain(e.target.value as typeof domain)}
                >
                  <option>Highlights</option>
                  {domains.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <div className="shared-metrics">
                {visibleMetrics.map((item) => (
                  <button
                    className="shared-metric"
                    key={item.id}
                    onClick={() => setMetric(item)}
                  >
                    <span className="shared-metric-name">
                      {item.label}
                      <CircleHelp size={14} />
                    </span>
                    <span className="shared-metric-value">
                      {formatMetric(item.value, item.unit)}
                      <small>{item.unit}</small>
                    </span>
                    <span className="shared-metric-comparison">
                      <span>
                        Baseline {formatMetric(item.baseline, item.unit)}
                      </span>
                      <strong>
                        {item.delta === null
                          ? "No comparison"
                          : item.delta === 0
                            ? "No change"
                            : `${item.delta > 0 ? "+" : ""}${formatMetric(item.delta, item.unit)}`}
                      </strong>
                    </span>
                    {item.status !== "ready" && (
                      <span className={`shared-result-status ${item.status}`}>
                        {item.status === "incomplete"
                          ? "Assumptions need review"
                          : "Supporting data unavailable"}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button
                className="shared-method-button"
                onClick={() => setDialog("assumptions")}
              >
                <BookOpen size={16} />
                <span>Read the frozen assumptions</span>
                <ChevronRight size={14} />
              </button>
              <div className="shared-estimate-note">
                <TriangleAlert size={15} />
                <p>
                  Planning estimates with visible limitations. A beautiful map
                  does not establish engineering accuracy.
                </p>
              </div>
            </section>
          ) : null}
          {engagementConfigured && (
            <section
              hidden={tab !== "feedback"}
              id="shared-feedback-panel"
              role="tabpanel"
              aria-labelledby="shared-feedback-tab"
              className="shared-feedback"
              ref={feedbackPanelRef}
            >
              <PublicEngagement
                key={snapshotId}
                snapshotId={snapshotId}
                engagement={engagement}
                metadataReady={engagementQuery.isSuccess}
                metadataError={engagementQuery.isError}
                place={snapshot.place}
                session={session}
                sessionUnavailable={sessionUnavailable}
                location={feedbackLocation}
                onLocationChange={setFeedbackLocation}
                onPickLocation={() => {
                  setSelectingLocation(true);
                  setLocationError("");
                  setSelectedId(null);
                  setSelectedParcelId(null);
                  mapPanelRef.current?.scrollIntoView({ block: "center" });
                }}
                onRequireAuth={() => setAuthOpen(true)}
                onSessionExpired={clearSession}
                onRefresh={refreshEngagement}
                onUnavailable={markUnavailable}
              />
            </section>
          )}
        </aside>
      </main>
      <footer className="shared-footer">
        <span>
          <ShieldCheck size={13} /> Snapshot {snapshot.id.slice(0, 8)} · Model{" "}
          {snapshot.results.modelVersion}
        </span>
        <span>Free tools. Thoughtful decisions. Better places.</span>
        <button onClick={() => setDialog("sources")}>
          Methodology & sources <ExternalLink size={12} />
        </button>
      </footer>
      {authOpen && (
        <AuthDialog
          onClose={() => setAuthOpen(false)}
          onSession={(result) => {
            setSession(result);
            setSessionUnavailable(false);
          }}
        />
      )}
      {showTour && (
        <PresentationDialog
          key={`${snapshot.id}:${snapshot.scenario.revision}`}
          place={snapshot.place}
          scenario={snapshot.scenario}
          results={snapshot.results}
          floodDatasets={floodContext.floodDatasets}
          publishedAt={snapshot.createdAt}
          onClose={() => setShowTour(false)}
        />
      )}
      {metric && (
        <Modal
          title={metric.label}
          description={`Published result · Revision ${snapshot.scenario.revision}`}
          open
          onClose={() => setMetric(null)}
        >
          <MetricDetail
            metric={metric}
            sourceInventory={
              metric.domain === "Housing" && snapshot.scenario.affordability
                ? housingSourceInventory(
                    snapshot.scenario,
                    snapshot.housingIncomeLimits,
                  )
                : undefined
            }
            place={
              metric.domain === "Housing" && snapshot.scenario.affordability
                ? {
                    ...snapshot.place,
                    sources: housingSources(
                      snapshot.scenario,
                      snapshot.housingIncomeLimits,
                    ),
                  }
                : metric.domain === "Fiscal" && snapshot.fiscalStudy
                  ? {
                      ...snapshot.place,
                      sources: snapshot.fiscalStudy.profile.sources,
                    }
                  : metric.id === "environment.flood"
                    ? {
                        ...snapshot.place,
                        sources: snapshot.floodDataset?.sources ?? [],
                      }
                    : (disclosurePlace ?? snapshot.place)
            }
            onFlood={
              snapshot.scenario.flood
                ? () => {
                    setMetric(null);
                    setDialog("flood");
                  }
                : undefined
            }
            onAccessibility={
              snapshot.scenario.accessibility
                ? () => {
                    setMetric(null);
                    setDialog("accessibility");
                  }
                : undefined
            }
            onAssumptions={() => {
              setMetric(null);
              setDialog("assumptions");
            }}
          />
        </Modal>
      )}
      {dialog === "flood" && (
        <Modal
          title="Published flood evidence"
          description="Frozen effective source map · read-only footprint screen"
          wide
          open
          onClose={() => setDialog(null)}
        >
          <FloodEvidence
            place={snapshot.place}
            scenario={snapshot.scenario}
            dataset={snapshot.floodDataset}
            context={floodContext}
            resolution={floodResolution}
            calculationError={floodCalculationError}
          />
        </Modal>
      )}
      {dialog === "accessibility" && (
        <Modal
          title="Published jobs accessibility"
          description="Frozen outbound evidence · captured source network"
          wide
          open
          onClose={() => setDialog(null)}
        >
          <PublishedAccessibility scenario={snapshot.scenario} expanded />
        </Modal>
      )}
      {dialog === "assumptions" && (
        <Modal
          title="The assumptions behind this proposal"
          description={`Read-only · Published ${publicationTime} · Revision ${snapshot.scenario.revision}`}
          wide
          open
          onClose={() => setDialog(null)}
        >
          {snapshot.scenario.flood && (
            <FloodEvidence
              place={snapshot.place}
              scenario={snapshot.scenario}
              dataset={snapshot.floodDataset}
              context={floodContext}
              resolution={floodResolution}
              calculationError={floodCalculationError}
            />
          )}
          <PublishedActivity
            place={snapshot.place}
            scenario={snapshot.scenario}
            modelVersion={snapshot.results.modelVersion}
          />
          <PublishedRetail
            place={snapshot.place}
            scenario={snapshot.scenario}
            modelVersion={snapshot.results.modelVersion}
          />
          <PublishedAccessibility scenario={snapshot.scenario} />
          <PublishedWorkforce scenario={snapshot.scenario} />
          <PublishedTraffic
            place={snapshot.place}
            scenario={snapshot.scenario}
          />
          <PublishedHousingAffordability
            scenario={snapshot.scenario}
            result={snapshot.results.affordability}
            packs={snapshot.housingIncomeLimits}
          />
          <PublishedFiscal
            study={snapshot.fiscalStudy}
            scenario={snapshot.scenario}
            resolution={snapshot.results.fiscal}
          />
          <FrozenAssumptions scenario={snapshot.scenario} />
        </Modal>
      )}
      {dialog === "sources" && (
        <Modal
          title="Know what the numbers know."
          description="Sources, coverage, and limitations frozen with the published scenario."
          wide
          open
          onClose={() => setDialog(null)}
        >
          <p className="shared-source-intro">
            {snapshot.place.extentLabel}. Data vintage varies by layer.
            Published outputs describe this frozen geography and scenario; they
            are never silently refreshed from the current project.
          </p>
          {snapshot.fiscalStudy && (
            <details className="fiscal-workbench">
              <summary>Fiscal profile sources and applicability</summary>
              <FiscalProfileEvidence
                study={snapshot.fiscalStudy}
                scenario={snapshot.scenario}
                resolution={snapshot.results.fiscal}
              />
            </details>
          )}
          {snapshot.floodDataset && (
            <FloodSources dataset={snapshot.floodDataset} />
          )}
          <h3 className="shared-section-heading">Coverage</h3>
          {snapshot.place.coverage.map((layer, i) => (
            <div className="coverage-row" key={`${layer.layer}-${i}`}>
              <span className={`status-dot ${layer.status}`} />
              <div>
                <strong>
                  {layer.layer} · {layer.status}
                </strong>
                <p>{layer.description}</p>
              </div>
            </div>
          ))}
          <h3 className="shared-section-heading">Source inventory</h3>
          {(disclosurePlace?.sources ?? []).map((source) => (
            <article className="source-record" key={source.id}>
              <div>
                <strong>{source.name}</strong>
                <span className="badge neutral">{source.kind}</span>
              </div>
              <p>{source.description}</p>
              <a
                href={/^https?:\/\//i.test(source.url) ? source.url : undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                {source.url} <ExternalLink size={12} />
              </a>
              <small>
                Vintage: {source.vintage} · {source.license}
              </small>
            </article>
          ))}
          {snapshot.scenario.traffic && (
            <>
              <h3 className="shared-section-heading">
                Traffic capture sources
              </h3>
              <p className="muted">
                Sources frozen with the explicit traffic network experiment; no
                private job archive is requested by this public view.
              </p>
              <TrafficSources capture={snapshot.scenario.traffic.capture} />
            </>
          )}
          {snapshot.scenario.accessibility && (
            <>
              <h3>Jobs accessibility capture sources</h3>
              <AccessibilitySources
                accessibility={snapshot.scenario.accessibility}
              />
            </>
          )}
          {snapshot.scenario.workforce && (
            <>
              <h3 className="shared-section-heading">
                Workforce capture sources
              </h3>
              <p className="muted">
                These citations belong to the regional workforce capture,
                separately from planning feature and scorecard sources.
              </p>
              <WorkforceSources capture={snapshot.scenario.workforce.capture} />
            </>
          )}
          <h3 className="shared-section-heading">Model limitations</h3>
          {snapshot.results.warnings.length ? (
            <ul className="shared-warning-list">
              {snapshot.results.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No additional run warnings were recorded. Read individual metric
              methods for their assumptions.
            </p>
          )}
        </Modal>
      )}
      {dialog === "features" && (
        <Modal
          title="Explore the published place"
          description="A searchable, read-only alternative to selecting features on the map."
          open
          onClose={() => setDialog(null)}
        >
          <div className="search-field">
            <Search size={17} />
            <input
              aria-label="Search published buildings and streets"
              placeholder="Search a building, street, parcel, or block…"
              value={featureQuery}
              onChange={(e) => {
                setFeatureQuery(e.target.value);
                setFeatureLimit(50);
              }}
            />
          </div>
          <p className="shared-feature-count" role="status">
            {filteredFeatures.length.toLocaleString()} matching features
          </p>
          <div className="shared-feature-list">
            {filteredFeatures.slice(0, featureLimit).map((feature) => (
              <button
                key={`${feature.kind}:${feature.id}`}
                className="shared-feature-row"
                onClick={() => {
                  setSelectedId(feature.kind === "parcel" ? null : feature.id);
                  setSelectedParcelId(
                    feature.kind === "parcel" ? feature.id : null,
                  );
                  setDialog(null);
                }}
              >
                <Building2 size={17} />
                <span>
                  <strong>{feature.name}</strong>
                  <small>{feature.detail}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          {filteredFeatures.length > featureLimit && (
            <button
              className="button full-width"
              onClick={() => setFeatureLimit((limit) => limit + 50)}
            >
              Show 50 more features
            </button>
          )}
        </Modal>
      )}
    </div>
  );
}

export default SharedView;
