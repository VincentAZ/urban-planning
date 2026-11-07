import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  Building2,
  Check,
  Clock3,
  Globe2,
  Loader2,
  MapPin,
  Search,
  X,
} from "lucide-react";
import type { Building, Place, Position } from "@urban/core";
import type {
  PlaceCandidate,
  PlaceSearchResponse,
  PreparationJob,
  NationalPreparationCapabilities,
} from "../../../../packages/core/src/national";
import { api, type Session } from "../lib/api";
import { AuthDialog } from "./Dialogs";
import { Modal } from "./Modal";
import "./place-search.css";

const PlaceLocator = lazy(() => import("./PlaceLocator"));
type PreparedPlace = Omit<Place, "buildings" | "roads"> & {
  buildingCount: number;
  roadCount: number;
};
const stageLabels: Record<PreparationJob["stage"], string> = {
  queued: "Waiting for a preparation slot",
  boundary: "Capturing the Census study boundary",
  osm: "Loading real streets and building footprints",
  demographics: "Checking community data and source coverage",
  saving: "Preserving this source snapshot",
  complete: "Your place is ready to explore",
};
const live = (job: PreparationJob | null) =>
  job?.status === "queued" || job?.status === "running";

export function PlaceSearchDialog({
  place,
  buildings = place.buildings,
  session,
  onSession,
  onClose,
  onFeature,
  onOpen,
}: {
  place: Place;
  buildings?: readonly Building[];
  session: Session;
  onSession: (session: Session) => void;
  onClose: () => void;
  onFeature: (id: string) => void;
  onOpen: (place: Place) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"search" | "map">("search");
  const [prepared, setPrepared] = useState<PreparedPlace[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [capabilities, setCapabilities] =
    useState<NationalPreparationCapabilities | null>(null);
  const [response, setResponse] = useState<PlaceSearchResponse | null>(null);
  const [candidate, setCandidate] = useState<PlaceCandidate | null>(null);
  const [selected, setSelected] = useState<Position>();
  const [jobs, setJobs] = useState<PreparationJob[]>([]);
  const [job, setJob] = useState<PreparationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState(false);
  const [error, setError] = useState("");
  const [serviceNotice, setServiceNotice] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [pollFailures, setPollFailures] = useState(0);
  const [pollError, setPollError] = useState("");
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const preparationKeys = useRef(new Map<string, string>());
  const currentFeatures = useMemo(
    () =>
      query.trim().length > 1
        ? buildings
            .filter((b) =>
              `${b.name} ${b.address ?? ""}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .slice(0, 12)
        : [],
    [buildings, query],
  );

  useEffect(() => {
    const controller = new AbortController();
    void api<{ places: PreparedPlace[] }>("/places", {
      signal: controller.signal,
    })
      .then((data) => {
        setPrepared(data.places);
        setCatalogLoaded(true);
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          setServiceNotice(
            "The prepared-place catalog could not load. Your current draft is still available.",
          );
      });
    void api<NationalPreparationCapabilities>(
      "/places/preparation-capabilities",
      { signal: controller.signal },
    )
      .then(setCapabilities)
      .catch((e) => {
        if (e.name !== "AbortError")
          setServiceNotice(
            "Place preparation is temporarily unavailable. You can keep exploring prepared places.",
          );
      });
    return () => {
      controller.abort();
      request.current?.abort();
      ++requestVersion.current;
    };
  }, []);

  useEffect(() => {
    setJobs([]);
    setJob(null);
    if (!session.user) return;
    const controller = new AbortController();
    api<{ jobs: PreparationJob[] }>("/places/preparations", {
      signal: controller.signal,
    })
      .then((data) => {
        setJobs(data.jobs);
        const active = data.jobs.find((j) => live(j));
        if (active) setJob(active);
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          setServiceNotice(
            "Your recent place requests could not be loaded. You can still search the catalog.",
          );
      });
    return () => controller.abort();
  }, [session.user?.id]);

  useEffect(() => {
    if (!job || !live(job)) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        api<{ job: PreparationJob }>(
          `/places/preparations/${encodeURIComponent(job.id)}`,
          { signal: controller.signal },
        )
          .then((data) => {
            setJob(data.job);
            setPollFailures(0);
            setPollError("");
            setJobs((previous) => [
              data.job,
              ...previous.filter((j) => j.id !== data.job.id),
            ]);
          })
          .catch((e) => {
            if (e.name !== "AbortError") {
              setPollError(
                `Progress is temporarily disconnected: ${e.message} Retrying automatically; your saved request continues.`,
              );
              setPollFailures((n) => n + 1);
            }
          });
      },
      Math.min(30000, 2000 * 2 ** Math.min(pollFailures, 4)),
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job, pollFailures]);

  async function search(path: string, selectedPoint?: Position) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    setCandidate(null);
    setResponse(null);
    if (selectedPoint) setSelected(selectedPoint);
    try {
      const result = await api<PlaceSearchResponse>(path, {
        signal: controller.signal,
      });
      if (version !== requestVersion.current) return;
      setResponse(result);
      if (
        result.candidates.length === 1 &&
        result.candidates[0].kind === "zcta"
      ) {
        setCandidate(result.candidates[0]);
        if (!selectedPoint) setSelected(result.candidates[0].coordinates);
      }
    } catch (e) {
      if (
        (e as Error).name !== "AbortError" &&
        version === requestVersion.current
      )
        setError((e as Error).message);
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2) {
      setError(
        "Enter a five-digit ZIP, city and state, or a complete street address.",
      );
      return;
    }
    void search(`/places/search?q=${encodeURIComponent(query.trim())}`);
  }
  function locate(point: Position) {
    void search(
      `/places/locate?lon=${encodeURIComponent(point[0])}&lat=${encodeURIComponent(point[1])}`,
      point,
    );
  }
  function choose(item: PlaceCandidate) {
    if (item.kind === "zcta") {
      setCandidate(item);
      setSelected(item.coordinates);
      setError("");
    } else locate(item.coordinates);
  }
  async function openPrepared(id: string) {
    setOperation(true);
    setError("");
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const data = await api<Place>(`/places/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        await onOpen(data);
        onClose();
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setOperation(false);
    }
  }
  async function prepare(zip: string) {
    if (!session.user) {
      setShowAuth(true);
      return;
    }
    setOperation(true);
    setError("");
    try {
      if (!preparationKeys.current.has(zip))
        preparationKeys.current.set(zip, crypto.randomUUID());
      const data = await api<{ job: PreparationJob }>("/places/preparations", {
        method: "POST",
        body: JSON.stringify({
          zip,
          idempotencyKey: preparationKeys.current.get(zip),
        }),
      });
      setJob(data.job);
      setPollFailures(0);
      setPollError("");
      setJobs((previous) => [
        data.job,
        ...previous.filter((j) => j.id !== data.job.id),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOperation(false);
    }
  }
  async function jobAction(action: "cancel" | "retry") {
    if (!job) return;
    setOperation(true);
    setError("");
    try {
      const data = await api<{ job: PreparationJob }>(
        `/places/preparations/${encodeURIComponent(job.id)}/${action}`,
        {
          method: "POST",
          body: JSON.stringify(
            action === "retry" ? { idempotencyKey: crypto.randomUUID() } : {},
          ),
        },
      );
      setJob(data.job);
      setPollFailures(0);
      setPollError("");
      setJobs((previous) => [
        data.job,
        ...previous.filter((j) => j.id !== data.job.id),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOperation(false);
    }
  }

  return (
    <>
      <Modal
        title="Find your place"
        description="Start with a ZIP, a city, an address—or a point on the map."
        open
        wide
        onClose={onClose}
      >
        <form className="place-search-form" onSubmit={submit}>
          <div className="search-field">
            <Search size={19} />
            <input
              autoFocus
              aria-label="Search places or buildings"
              value={query}
              maxLength={200}
              placeholder="85004 · Chicago, IL · 200 W Washington St, Phoenix, AZ"
              onChange={(e) => {
                setQuery(e.target.value);
                request.current?.abort();
                ++requestVersion.current;
                setBusy(false);
                setCandidate(null);
                setResponse(null);
              }}
            />
          </div>
          <button
            className="button primary"
            type="submit"
            disabled={busy || operation}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Search size={16} />
            )}{" "}
            Search places
          </button>
        </form>
        <p className="place-search-help">
          Building matches below update as you type. National searches run only
          when you submit. A city or address helps find a Census ZIP Code
          Tabulation Area (ZCTA); it does not open a whole city.
        </p>
        <div
          className="place-picker-tabs"
          role="tablist"
          aria-label="Place finder views"
        >
          <button
            type="button"
            role="tab"
            id="place-search-tab"
            aria-selected={tab === "search"}
            aria-controls="place-search-panel"
            tabIndex={tab === "search" ? 0 : -1}
            onClick={() => setTab("search")}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                setTab("map");
                document.getElementById("place-map-tab")?.focus();
              }
            }}
          >
            Search & prepared places
          </button>
          <button
            type="button"
            role="tab"
            id="place-map-tab"
            aria-selected={tab === "map"}
            aria-controls="place-map-panel"
            tabIndex={tab === "map" ? 0 : -1}
            onClick={() => setTab("map")}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                setTab("search");
                document.getElementById("place-search-tab")?.focus();
              }
            }}
          >
            Choose on the map
          </button>
        </div>
        {tab === "map" && (
          <div
            role="tabpanel"
            id="place-map-panel"
            aria-labelledby="place-map-tab"
          >
            <Suspense
              fallback={
                <div className="place-search-status">
                  <Loader2 size={18} className="spin" /> Opening the U.S.
                  locator…
                </div>
              }
            >
              <PlaceLocator
                onLocate={locate}
                busy={busy || operation}
                selected={selected}
              />
            </Suspense>
          </div>
        )}
        {serviceNotice && (
          <p className="place-search-warning" role="status">
            {serviceNotice}
          </p>
        )}
        {error && (
          <p className="place-search-error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <div className="place-search-status" role="status">
            <Loader2 size={18} className="spin" /> Looking up the study area…
          </div>
        )}
        {response && (
          <section
            className="place-search-section"
            aria-label="National search results"
          >
            {response.warnings
              .filter(
                (warning) =>
                  !response.candidates.some((item) => item.detail === warning),
              )
              .map((warning) => (
                <p className="place-search-warning" key={warning}>
                  {warning}
                </p>
              ))}
            {!response.candidates.length && (
              <p className="place-search-empty">
                No Census ZIP area was found for this search. Some postal ZIPs
                have no ZCTA boundary. Try a full street address or select
                another point.
              </p>
            )}
            {response.candidates.map((item) => (
              <button
                type="button"
                className="place-result"
                key={item.id}
                disabled={busy || operation}
                onClick={() => choose(item)}
              >
                <MapPin size={21} />
                <div>
                  <strong>{item.label}</strong>
                  {candidate?.id !== item.id && <span>{item.detail}</span>}
                  <small>
                    {item.sourceName} ·{" "}
                    {item.kind === "zcta"
                      ? item.prepared
                        ? "Prepared area available"
                        : "Boundary found"
                      : "Choose to find the ZIP area at this location"}
                  </small>
                </div>
                {candidate?.id === item.id ? (
                  <Check size={17} />
                ) : (
                  <ArrowRight size={17} />
                )}
              </button>
            ))}
          </section>
        )}
        {candidate && (
          <section
            className="place-candidate-preview"
            aria-label="Selected study area"
          >
            <div className="place-candidate-meta">
              <MapPin size={14} /> Census study area
            </div>
            <h3>{candidate.label}</h3>
            <p>{candidate.detail}</p>
            <p>
              ZCTA boundaries are statistical areas, not city limits or taxing
              jurisdictions. Source coverage and any inferred attributes stay
              visible in the workspace.
            </p>
            {candidate.prepared && candidate.placeId ? (
              <button
                className="button primary"
                disabled={operation}
                onClick={() => void openPrepared(candidate.placeId!)}
              >
                {operation ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <ArrowRight size={16} />
                )}{" "}
                Open prepared area
              </button>
            ) : (
              <>
                <p>
                  {capabilities?.enabled
                    ? "This area needs a fresh source bundle. Preparation runs in a shared queue and may take a few minutes."
                    : (capabilities?.reason ??
                      "Checking preparation availability…")}
                </p>
                {capabilities?.enabled && (
                  <button
                    className="button primary"
                    disabled={operation || !candidate.zip || live(job)}
                    onClick={() => void prepare(candidate.zip!)}
                  >
                    {operation ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <Building2 size={16} />
                    )}
                    {session.user
                      ? "Prepare this area · free"
                      : "Free account to prepare this area"}
                  </button>
                )}
              </>
            )}
          </section>
        )}
        {job && (
          <section
            className="place-job"
            aria-label="Place preparation progress"
          >
            <div className="place-job-head">
              <strong>ZCTA {job.zip}</strong>
              <span>
                {job.status} · Attempt {job.attempt}
              </span>
            </div>
            <p role="status">
              {job.status === "failed"
                ? "Preparation could not finish."
                : job.status === "cancelled"
                  ? "This preparation request was cancelled."
                  : stageLabels[job.stage]}
            </p>
            {live(job) && (
              <progress
                aria-label={`Preparation of ZCTA ${job.zip}`}
                max={100}
                value={job.progress}
              />
            )}
            {pollError && (
              <p className="place-search-warning" role="status">
                {pollError}
              </p>
            )}
            {job.error && (
              <p className="place-search-error" role="alert">
                {job.error.message}
              </p>
            )}
            {job.warnings.length > 0 && (
              <details className="place-job-notes">
                <summary>
                  {job.warnings.length} source coverage{" "}
                  {job.warnings.length === 1 ? "note" : "notes"}
                </summary>
                {job.warnings.map((warning) => (
                  <p className="place-search-warning" key={warning}>
                    {warning}
                  </p>
                ))}
              </details>
            )}
            <div className="place-job-actions">
              {job.status === "completed" && job.placeId && (
                <button
                  className="button primary"
                  disabled={operation}
                  onClick={() => void openPrepared(job.placeId!)}
                >
                  <ArrowRight size={16} /> Open ZCTA {job.zip}
                </button>
              )}
              {live(job) && (
                <button
                  className="button"
                  disabled={operation}
                  onClick={() => void jobAction("cancel")}
                >
                  <X size={15} /> Cancel preparation
                </button>
              )}
              {((job.status === "failed" && job.error?.retryable) ||
                job.status === "cancelled") && (
                <button
                  className="button"
                  disabled={operation}
                  onClick={() => void jobAction("retry")}
                >
                  <Clock3 size={15} /> Retry preparation
                </button>
              )}
            </div>
            <p className="place-search-help">
              You can close this window. Your request is saved and can be
              reopened from here.
            </p>
          </section>
        )}
        {jobs.length > 0 && (
          <section
            className="place-search-section"
            aria-label="Your recent place requests"
          >
            <h3>Your recent place requests</h3>
            <div className="place-search-recent">
              {jobs.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setJob(item);
                    setError("");
                    setPollError("");
                    setPollFailures(0);
                  }}
                  aria-pressed={job?.id === item.id}
                >
                  ZCTA {item.zip} · {item.status}
                </button>
              ))}
            </div>
          </section>
        )}
        {tab === "search" && (
          <div
            role="tabpanel"
            id="place-search-panel"
            aria-labelledby="place-search-tab"
          >
            {currentFeatures.length > 0 && (
              <section
                className="place-search-section"
                aria-label="Buildings in the current place"
              >
                <h3>In your current place</h3>
                {currentFeatures.map((feature) => (
                  <button
                    className="feature-result"
                    key={feature.id}
                    onClick={() => {
                      onFeature(feature.id);
                      onClose();
                    }}
                  >
                    <strong>{feature.name}</strong>
                    <span>{feature.address || feature.use}</span>
                  </button>
                ))}
              </section>
            )}
            <section
              className="place-search-section"
              aria-label="Prepared places"
            >
              <h3>Ready to explore</h3>
              <p>
                Open a prepared snapshot without waiting or creating an account.
                Your current browser draft is retained in project home.
              </p>
              {prepared.map((item) => (
                <button
                  className="place-result"
                  key={item.id}
                  disabled={operation}
                  onClick={() => void openPrepared(item.id)}
                >
                  <Globe2 size={22} />
                  <div>
                    <strong>{item.name}</strong>
                    <span>
                      {item.city}, {item.state} · {item.extentLabel}
                    </span>
                    <small>
                      {item.buildingCount.toLocaleString()} mapped features ·
                      Captured {new Date(item.loadedAt).toLocaleDateString()}
                    </small>
                  </div>
                  <ArrowRight size={17} />
                </button>
              ))}
              {!prepared.length && !serviceNotice && !catalogLoaded && (
                <p className="place-search-status">
                  Loading the prepared-place catalog…
                </p>
              )}
              {!prepared.length && catalogLoaded && (
                <p className="place-search-empty">
                  No prepared places are available yet. Search for a ZIP to
                  prepare its source data.
                </p>
              )}
            </section>
          </div>
        )}
        <div className="place-search-coverage">
          <strong>Coverage before certainty.</strong> Search uses U.S. Census
          geography and address services. New source preparation uses bounded
          public-data requests; large or incomplete areas may need a larger
          ingestion service.{" "}
          {capabilities && (
            <>
              This server currently prepares study areas up to{" "}
              {capabilities.limits.maxStudyAreaKm2} km², with at most{" "}
              {capabilities.limits.jobsPerUserPerDay} requests per account per
              day.{" "}
            </>
          )}
          Traffic is illustrative until calibrated demand and routing are
          connected. There is no paid fast lane.
        </div>
      </Modal>
      {showAuth && (
        <AuthDialog
          onClose={() => setShowAuth(false)}
          onSession={(value) => {
            onSession(value);
            setShowAuth(false);
          }}
        />
      )}
    </>
  );
}
