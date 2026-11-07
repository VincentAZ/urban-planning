import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  Check,
  LoaderCircle,
  Play,
  Route,
  Upload,
} from "lucide-react";
import {
  canonicalJSON,
  validateTrafficDemand,
  trafficPeriodSchema,
  type Place,
  type Scenario,
  type TrafficCalibrationPlan,
  reviewTrafficPlanningRoads,
  mergeTrafficPlanningOverlays,
  trafficPlanningOverlays,
  type TrafficPlanningRoadMapping,
  type TrafficSignalTiming,
  validateTrafficSignalTimings,
  type TrafficCommuteBinding,
  type TrafficCommuteSummary,
} from "@urban/core";
import type {
  TrafficCountPack,
  TrafficDemand,
  TrafficNetwork,
  TrafficOverlay,
  TrafficPeriod,
} from "../../../../../packages/core/src/traffic";
import { Modal } from "../Modal";
import {
  TrafficNetworkPanel,
  type TrafficOverlayDraft,
} from "./TrafficNetworkPanel";
import {
  TrafficCountsPanel,
  type TrafficCountBatch,
} from "./TrafficCountsPanel";
import {
  TrafficDemandPanel,
  TrafficPeriodPanel,
  demandDraft,
  readDemandDraft,
  periodDraft,
  readPeriodDraft,
  routeDraft,
} from "./TrafficDemandPanel";
import { TrafficResults, type TrafficResultPair } from "./TrafficResults";
import {
  draftSource,
  trafficDeclarationsForSources,
  authoredTrafficCommuteCopy,
  trafficCountDraft,
  readTrafficCountDraft,
  createTrafficCountNetworkIndex,
  validateTrafficOverlayDraft,
  type TrafficDraftValue,
  type TrafficSourceDeclaration,
  type TrafficStagedCSV,
} from "../../lib/traffic-draft";
import type { TrafficConfigurationRecord } from "../../lib/traffic-api";
import { TrafficSourceReview } from "./TrafficSourceReview";
import {
  manualTrafficOverlays,
  planningReviewDraft,
  planningSourceDraft,
  readPlanningReviews,
  readPlanningSourceDeclarations,
} from "../../lib/traffic-planning-draft";
import type { TrafficPlanningPreview } from "./TrafficPlanningRoadPanel";
import {
  signalTimingDraft,
  readSignalTimingDrafts,
  signalTimingEligibility,
  signalTimingControlLimit,
  type TrafficSignalEligibility,
} from "../../lib/traffic-signal-draft";
import { TrafficCalibrationPanel } from "./TrafficCalibrationPanel";
import {
  trafficCalibrationDraft,
  readTrafficCalibrationDraft,
} from "../../lib/traffic-calibration-draft";
import { inspectTrafficCalibrationSelection } from "@urban/models";
import { PublishedTraffic } from "./TrafficOverview";
import { TrafficCommutePanel } from "./TrafficCommutePanel";
import "./traffic.css";

export interface TrafficJobView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  progress: number | null;
  canCancel: boolean;
  canRetry: boolean;
  error?: string;
}
export interface TrafficDialogProps {
  place: Place;
  scenario: Scenario;
  accountScope: string;
  canEdit: boolean;
  network: TrafficNetwork | null;
  countPack: TrafficCountPack;
  demand: TrafficDemand;
  commute?: TrafficCommuteBinding;
  commutePresets?: {
    id: string;
    label: string;
    summary: TrafficCommuteSummary;
    demand: TrafficDemand;
  }[];
  onDownloadCommute?: (presetId: string) => Promise<void>;
  onInspectCommute?: (
    presetId: string,
  ) => Promise<
    import("../../lib/traffic-commute-ledger").TrafficCommuteLedgerView
  >;
  period: TrafficPeriod;
  seed?: number;
  calibrationPlan?: TrafficCalibrationPlan | null;
  overlays?: TrafficOverlay[];
  planningRoads?: TrafficPlanningRoadMapping;
  signalTimings?: TrafficSignalTiming[];
  signalEligibility?: TrafficSignalEligibility;
  result?: TrafficResultPair | null;
  resultCurrent?: boolean;
  resultStaleReason?: string;
  job?: TrafficJobView | null;
  /** Parent adapter admits real work; absent callbacks never simulate a queue. */
  onApply?: (
    draft: TrafficDraftValue,
  ) => Promise<TrafficConfigurationRecord | void>;
  configuration?: Pick<
    TrafficConfigurationRecord,
    "id" | "requestHash" | "scopeAcknowledged"
  > | null;
  onDirtyChange?: (dirty: boolean) => void;
  controls?: ReactNode;
  resultActions?: ReactNode;
  mutationBlockedReason?: string;
  externalBusy?: boolean;
  /** Exact revision returned by this workbench's successful adoption, not an inferred external update. */
  acknowledgedScenarioRevision?: number | null;
  configurationNeedsReview?: boolean;
  onRun?: () => Promise<void>;
  onCancel?: () => Promise<void>;
  onRetry?: () => Promise<void>;
  onDownload?: (id: string) => Promise<void>;
  onRequireAccount?: () => void;
  capabilityReason?: string;
  onClose: () => void;
}
function initialDraft(props: TrafficDialogProps) {
  let manual = props.overlays ?? [],
    mappingError: string | null = null;
  try {
    manual = manualTrafficOverlays(manual, props.planningRoads);
  } catch (failure) {
    mappingError = (failure as Error).message;
  }
  return {
    signalDrafts: (props.signalTimings ?? []).map(signalTimingDraft),
    planningReviews: (props.planningRoads?.reviews ?? []).map((value) =>
      planningReviewDraft(value, true, props.planningRoads),
    ),
    planningSourceDeclarations: (
      props.planningRoads?.sourceDeclarations ?? []
    ).flatMap((value) => {
      const source = props.planningRoads?.sources.find(
        (source) => source.id === value.sourceId,
      );
      return source
        ? [
            planningSourceDraft(source, {
              privateUseConfirmed: !!value.privateUseConfirmed,
              publicRedistribution: value.publicRedistribution,
            }),
          ]
        : [];
    }),
    mappingError,
    counts: props.countPack.counts.map(trafficCountDraft),
    period: periodDraft(props.period),
    seed: String(props.seed ?? props.result?.recipe.seed ?? 0),
    calibrationPlan: trafficCalibrationDraft(props.calibrationPlan ?? null),
    scopeAcknowledged: props.configuration?.scopeAcknowledged ?? false,
    demandRows: demandDraft(props.demand),
    routes: routeDraft(props.demand),
    overlays: manual.map(
      (value): TrafficOverlayDraft => ({
        edgeId: value.edgeId,
        closed: value.closed ?? false,
        lanes: value.lanes === undefined ? "" : String(value.lanes),
        speedMps: value.speedMps === undefined ? "" : String(value.speedMps),
      }),
    ),
    countPack: props.countPack,
    demand: props.demand,
    commute: props.commute,
    sourceDeclarations: [] as TrafficSourceDeclaration[],
    stagedFiles: [] as TrafficStagedCSV[],
  };
}
const tabs = [
  { id: "network", label: "Network", icon: Route },
  { id: "counts", label: "Counts & demand", icon: Upload },
  { id: "results", label: "Results", icon: Activity },
] as const;
export function TrafficDialog(props: TrafficDialogProps) {
  const scope = JSON.stringify([
    props.accountScope,
    props.place.id,
    props.scenario.id,
    props.network?.manifest.networkFileSha256,
  ]);
  const [base, setBase] = useState(() => ({
    scope,
    revision: props.scenario.revision,
    configurationId: props.configuration?.id ?? null,
    draft: initialDraft(props),
  }));
  const [draft, setDraft] = useState(() => base.draft),
    [tab, setTab] = useState<(typeof tabs)[number]["id"]>("network"),
    [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [countSubdraftDirty, setCountSubdraftDirty] = useState(false),
    [demandSubdraftDirty, setDemandSubdraftDirty] = useState(false),
    [criteriaSubdraftDirty, setCriteriaSubdraftDirty] = useState(false),
    [confirm, setConfirm] = useState<"close" | "reload" | "commute" | null>(
      null,
    ),
    [pendingCommutePreset, setPendingCommutePreset] = useState<string | null>(
      null,
    ),
    [resetVersion, setResetVersion] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const locked = !!busy || !!props.externalBusy;
  const subdraftDirty =
    countSubdraftDirty || demandSubdraftDirty || criteriaSubdraftDirty;
  const keep = useRef<HTMLButtonElement>(null),
    mounted = useRef(true),
    generation = useRef(0),
    live = useRef({ props, scope });
  live.current = { props, scope };
  const activeScope = base.scope === scope;
  const propDraft = useMemo(
    () => initialDraft(props),
    [
      props.countPack,
      props.period,
      props.demand,
      props.overlays,
      props.seed,
      props.calibrationPlan,
      props.planningRoads,
      props.signalTimings,
      props.commute,
    ],
  );
  const current = props.canEdit && activeScope ? draft : propDraft;
  const networkCounts = useMemo(
    () => current.counts.map((value) => value.count),
    [current.counts],
  );
  const reviewedPeriod = useMemo(() => {
    try {
      return {
        value: trafficPeriodSchema.parse(readPeriodDraft(current.period)),
        error: "",
      };
    } catch (failure) {
      return { value: null, error: (failure as Error).message };
    }
  }, [current.period]);
  const countNetworkIndex = useMemo(
    () =>
      props.network ? createTrafficCountNetworkIndex(props.network) : undefined,
    [props.network],
  );
  const countReview = useMemo(() => {
    const pendingMappingCountIds: string[] = [];
    let error = "";
    const mapped = current.counts.map((value) => {
      if (!props.network) return { count: value.count };
      try {
        const parsed = readTrafficCountDraft(
          value,
          props.network,
          countNetworkIndex,
        );
        if (parsed.review) pendingMappingCountIds.push(parsed.count.id);
        return parsed;
      } catch (failure) {
        error ||= (failure as Error).message;
        return { count: { ...value.count, target: null, mapping: undefined } };
      }
    });
    const pack = {
      ...current.countPack,
      counts: mapped.map((value) => value.count),
    };
    return { pack, mapped, error, pendingMappingCountIds };
  }, [current.countPack, current.counts, props.network, countNetworkIndex]);
  // Hash the complete graph only on initial context or an explicit review action,
  // never on each keystroke. Small draft identities synchronously mask stale output.
  const planningIdentity = useMemo(
    () =>
      canonicalJSON(
        current.planningReviews.map(
          ({ confirmed: _confirmed, confirmedFor: _binding, ...review }) =>
            review,
        ),
      ),
    [current.planningReviews],
  );
  const overlayIdentity = useMemo(
    () => canonicalJSON(current.overlays),
    [current.overlays],
  );
  const needsPlanning =
    props.scenario.id !== "baseline" &&
    (Object.keys(props.scenario.roadEdits).length > 0 ||
      current.planningReviews.length > 0);
  const planningLive = useRef({
    place: props.place,
    scenario: props.scenario,
    network: props.network,
    planningIdentity,
    overlayIdentity,
  });
  planningLive.current = {
    place: props.place,
    scenario: props.scenario,
    network: props.network,
    planningIdentity,
    overlayIdentity,
  };
  const planningSequence = useRef(0);
  const [planningCheck, setPlanningCheck] = useState<{
    place: Place;
    scenario: Scenario;
    network: TrafficNetwork;
    planningIdentity: string;
    overlayIdentity: string;
    mapping: TrafficPlanningRoadMapping | null;
    error: string | null;
    pending: boolean;
  } | null>(null);
  function checkPlanning() {
    if (!props.network || props.scenario.id === "baseline") return;
    const network = props.network,
      captured = {
        place: props.place,
        scenario: props.scenario,
        network,
        planningIdentity,
        overlayIdentity,
      },
      sequence = ++planningSequence.current;
    const valid = () =>
      mounted.current &&
      sequence === planningSequence.current &&
      Object.entries(captured).every(
        ([key, value]) =>
          planningLive.current[key as keyof typeof captured] === value,
      );
    setPlanningCheck({
      ...captured,
      mapping: null,
      error: null,
      pending: true,
    });
    void (async () => {
      const reviewed = await reviewTrafficPlanningRoads({
        place: props.place,
        scenario: props.scenario,
        network,
        reviews: readPlanningReviews(current.planningReviews, false),
        reviewedBy: "browser-preview",
        reviewedAt: "2000-01-01T00:00:00.000Z",
      });
      mergeTrafficPlanningOverlays(
        validateTrafficOverlayDraft(network, current.overlays),
        reviewed.planningRoads,
      );
      return reviewed.planningRoads;
    })().then(
      (mapping) => {
        if (valid())
          setPlanningCheck({
            ...captured,
            mapping,
            error: null,
            pending: false,
          });
      },
      (failure) => {
        if (valid())
          setPlanningCheck({
            ...captured,
            mapping: null,
            error: (failure as Error).message,
            pending: false,
          });
      },
    );
  }
  useEffect(() => {
    if (needsPlanning) checkPlanning();
    return () => {
      planningSequence.current++;
    };
  }, [props.place, props.scenario, props.network]);
  const planningCurrent =
    planningCheck?.place === props.place &&
    planningCheck.scenario === props.scenario &&
    planningCheck.network === props.network &&
    planningCheck.planningIdentity === planningIdentity &&
    planningCheck.overlayIdentity === overlayIdentity;
  const planningPreview: TrafficPlanningPreview = {
    mapping: planningCurrent ? planningCheck.mapping : null,
    error: planningCurrent ? planningCheck.error : null,
    pending: planningCurrent && planningCheck.pending,
    needsCheck: needsPlanning && !planningCurrent,
  };
  const mappedOverlays = useMemo(
    () =>
      planningPreview.mapping
        ? trafficPlanningOverlays(planningPreview.mapping)
        : [],
    [planningPreview.mapping],
  );
  const dirty =
    props.canEdit &&
    activeScope &&
    canonicalJSON({
      ...draft,
      stagedFiles: draft.stagedFiles.map(({ file, ...rest }) => ({
        ...rest,
        filename: file.name,
      })),
    }) !== canonicalJSON({ ...base.draft, stagedFiles: [] });
  const changedRevision =
    base.revision !== props.scenario.revision ||
    base.configurationId !== (props.configuration?.id ?? null);
  useEffect(() => {
    if (
      props.acknowledgedScenarioRevision === props.scenario.revision &&
      base.revision !== props.scenario.revision &&
      base.scope === scope &&
      base.configurationId === (props.configuration?.id ?? null) &&
      !dirty &&
      !subdraftDirty &&
      !locked
    )
      setBase((previous) => ({
        ...previous,
        revision: props.scenario.revision,
      }));
  }, [
    props.acknowledgedScenarioRevision,
    props.scenario.revision,
    props.configuration?.id,
    base.revision,
    base.scope,
    base.configurationId,
    scope,
    dirty,
    subdraftDirty,
    locked,
  ]);
  useEffect(() => {
    props.onDirtyChange?.(dirty || subdraftDirty || !!busy);
    return () => props.onDirtyChange?.(false);
  }, [dirty, subdraftDirty, busy, props.onDirtyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (base.scope === scope) return;
    generation.current++;
    const next = initialDraft(props);
    setBase({
      scope,
      revision: props.scenario.revision,
      configurationId: props.configuration?.id ?? null,
      draft: next,
    });
    setDraft(next);
    setSelectedEdgeId(null);
    setCountSubdraftDirty(false);
    setDemandSubdraftDirty(false);
    setCriteriaSubdraftDirty(false);
    setConfirm(null);
    setBusy("");
    setError("");
  }, [scope, base.scope, props]);
  useEffect(() => {
    if (props.canEdit) return;
    generation.current++;
    const next = initialDraft(props);
    setBase({
      scope,
      revision: props.scenario.revision,
      configurationId: props.configuration?.id ?? null,
      draft: next,
    });
    setDraft(next);
    setConfirm(null);
    setCountSubdraftDirty(false);
    setDemandSubdraftDirty(false);
    setCriteriaSubdraftDirty(false);
    setBusy("");
  }, [props.canEdit, scope]);
  useEffect(() => {
    if (!dirty && !subdraftDirty && !locked) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, subdraftDirty, locked]);
  const input = useMemo(() => {
    if (!props.network)
      return {
        value: null,
        error:
          "Prepare the study area and external network before saving traffic inputs.",
      };
    try {
      if (current.mappingError) throw new Error(current.mappingError);
      if (planningPreview.pending)
        throw new Error(
          "Wait for the exact planning-street correspondence check.",
        );
      if (planningPreview.needsCheck)
        throw new Error(
          "Check correspondence before saving changed planning-street inputs.",
        );
      if (planningPreview.error) throw new Error(planningPreview.error);
      const planningRoadReviews = readPlanningReviews(
        current.planningReviews,
        true,
        planningPreview.mapping,
      );
      const planningSourceDeclarations = readPlanningSourceDeclarations(
        planningPreview.mapping?.sources ?? [],
        current.planningSourceDeclarations,
      );
      const period = trafficPeriodSchema.parse(readPeriodDraft(current.period));
      const seed = Number(current.seed);
      if (
        !current.seed.trim() ||
        !/^\d+$/.test(current.seed) ||
        !Number.isSafeInteger(seed) ||
        seed < 0 ||
        seed > 0x7fffffff
      )
        throw new Error(
          "Enter a whole random seed from 0 to 2,147,483,647. Both runs use this same seed.",
        );
      if (countReview.error) throw new Error(countReview.error);
      const mapped = countReview.mapped;
      const demand = readDemandDraft(
        current.demandRows,
        current.demand,
        current.routes,
      );
      if (demand.rows.length)
        validateTrafficDemand(demand, props.network, period);
      for (const source of current.sourceDeclarations)
        if (
          !source.name.trim() ||
          !source.license.trim() ||
          !source.privateUseConfirmed
        )
          throw new Error(
            "Every new source requires a title, permission statement and private-use declaration.",
          );
      const signalTimings = readSignalTimingDrafts(
        current.signalDrafts,
        props.network,
      );
      const controllerLimit = signalTimingControlLimit(
        props.network.manifest.networkFileSha256,
        props.signalEligibility,
      );
      if (signalTimings.length > controllerLimit)
        throw new Error(
          `This worker supports at most ${controllerLimit} signal timing controls per configuration. Remove extra timing changes before saving.`,
        );
      for (const timing of signalTimings) {
        const eligibility = signalTimingEligibility(
          props.network.manifest.networkFileSha256,
          timing,
          props.signalEligibility,
        );
        if (eligibility.status === "ineligible")
          throw new Error(eligibility.reason);
      }
      const calibrationPlan = readTrafficCalibrationDraft(
        current.calibrationPlan,
      );
      if (calibrationPlan) {
        const selection = inspectTrafficCalibrationSelection(
          { ...current.countPack, counts: mapped.map((value) => value.count) },
          calibrationPlan,
          props.network,
          period,
          {
            pendingMappingCountIds: mapped.flatMap((value) =>
              value.review ? [value.count.id] : [],
            ),
          },
        );
        if (selection.errors.length)
          throw new Error(selection.errors.join(" "));
      }
      const value: TrafficDraftValue = {
        networkHash: props.network.manifest.networkFileSha256,
        seed,
        calibrationPlan,
        scopeAcknowledged: current.scopeAcknowledged,
        countPack: {
          ...current.countPack,
          counts: mapped.map((value) => value.count),
        },
        demand,
        ...(current.commute === undefined ? {} : { commute: current.commute }),
        period,
        overlays: validateTrafficOverlayDraft(props.network, current.overlays),
        planningRoadReviews,
        planningSourceDeclarations,
        signalTimings,
        sourceDeclarations: current.sourceDeclarations,
        stagedFiles: current.stagedFiles,
        mappingReviews: mapped.flatMap((value) =>
          value.review ? [value.review] : [],
        ),
      };
      return { value, error: "" };
    } catch (failure) {
      return {
        value: null,
        error:
          failure instanceof Error
            ? failure.message
            : "Review the traffic inputs.",
      };
    }
  }, [
    current,
    countReview,
    props.network,
    props.demand,
    props.signalEligibility,
    planningPreview.mapping,
    planningPreview.pending,
    planningPreview.error,
    planningPreview.needsCheck,
  ]);
  function change(patch: Partial<typeof draft>) {
    if (props.canEdit && activeScope && !locked) {
      setDraft((value) => ({ ...value, ...patch }));
      setError("");
    }
  }
  function useCommutePreset(id: string) {
    const preset = props.commutePresets?.find((value) => value.id === id);
    if (!preset || !props.canEdit || locked || subdraftDirty) return;
    change({
      demand: structuredClone(preset.demand),
      demandRows: demandDraft(preset.demand),
      routes: routeDraft(preset.demand),
      period: periodDraft(preset.summary.recipe.period),
      commute: structuredClone(preset.summary.binding),
      sourceDeclarations: trafficDeclarationsForSources(
        current.sourceDeclarations,
        [...current.countPack.sources, ...preset.demand.sources],
      ),
      scopeAcknowledged: false,
    });
    setResetVersion((value) => value + 1);
    setConfirm(null);
    setPendingCommutePreset(null);
  }
  function detachCommute() {
    if (!props.canEdit || locked || subdraftDirty) return;
    const demand = authoredTrafficCommuteCopy(current.demand);
    change({
      commute: undefined,
      demand,
      demandRows: demandDraft(demand),
      routes: routeDraft(demand),
      scopeAcknowledged: false,
    });
  }
  function addBatch(batch: TrafficCountBatch) {
    if (!props.canEdit || !activeScope || locked) return;
    setDraft((value) => ({
      ...value,
      counts: [...value.counts, ...batch.counts.map(trafficCountDraft)],
      countPack: {
        ...value.countPack,
        sources: [...value.countPack.sources, draftSource(batch.source)],
      },
      sourceDeclarations: [...value.sourceDeclarations, batch.source],
      stagedFiles: [...value.stagedFiles, ...(batch.file ? [batch.file] : [])],
    }));
  }
  function reset() {
    generation.current++;
    setResetVersion((value) => value + 1);
    const next = initialDraft(props);
    setBase({
      scope,
      revision: props.scenario.revision,
      configurationId: props.configuration?.id ?? null,
      draft: next,
    });
    setDraft(next);
    setError("");
    setConfirm(null);
    setCountSubdraftDirty(false);
    setDemandSubdraftDirty(false);
    setCriteriaSubdraftDirty(false);
  }
  async function action(kind: "save" | "run" | "cancel" | "retry") {
    if (locked || !activeScope || !props.canEdit) return;
    if ((kind === "save" || kind === "run") && props.mutationBlockedReason) {
      setError(props.mutationBlockedReason);
      return;
    }
    const callback =
      kind === "save"
        ? props.onApply
        : kind === "run"
          ? props.onRun
          : kind === "cancel"
            ? props.onCancel
            : props.onRetry;
    if (!callback) return;
    if (
      kind === "save" &&
      (!input.value ||
        !current.scopeAcknowledged ||
        changedRevision ||
        subdraftDirty)
    )
      return;
    if (kind === "run" && (dirty || subdraftDirty || changedRevision)) return;
    const sequence = ++generation.current,
      captured = scope;
    setBusy(kind);
    setError("");
    try {
      if (kind === "save" && input.value && props.network) {
        await validateTrafficSignalTimings(
          props.network,
          input.value.signalTimings ?? [],
          planningPreview.mapping
            ? mergeTrafficPlanningOverlays(
                input.value.overlays,
                planningPreview.mapping,
              )
            : input.value.overlays,
        );
        if (
          !mounted.current ||
          generation.current !== sequence ||
          live.current.scope !== captured
        )
          return;
      }
      const acknowledgement =
        kind === "save"
          ? await props.onApply!(input.value!)
          : await (callback as () => Promise<void>)();
      if (
        mounted.current &&
        generation.current === sequence &&
        live.current.scope === captured
      ) {
        if (kind === "save") {
          if (acknowledgement) {
            const next = initialDraft({
              ...live.current.props,
              ...acknowledgement.request,
              commute: acknowledgement.request.commute,
              configuration: acknowledgement,
            });
            setBase({
              scope: captured,
              revision: live.current.props.scenario.revision,
              configurationId: acknowledgement.id,
              draft: next,
            });
            setDraft(next);
            setResetVersion((value) => value + 1);
            setCountSubdraftDirty(false);
            setDemandSubdraftDirty(false);
            setCriteriaSubdraftDirty(false);
          } else props.onClose();
        }
      }
    } catch (failure) {
      if (
        mounted.current &&
        generation.current === sequence &&
        live.current.scope === captured
      )
        setError((failure as Error).message);
    } finally {
      if (
        mounted.current &&
        generation.current === sequence &&
        live.current.scope === captured
      )
        setBusy("");
    }
  }
  const requestClose = () => {
    if (dirty || subdraftDirty || locked) setConfirm("close");
    else props.onClose();
  };
  const job = props.job;
  return (
    <>
      <Modal
        title="See how the streets respond."
        description="Review the full traffic network and its external buffer, retain local evidence, and compare real baseline and proposal runs."
        wide
        open
        onClose={requestClose}
      >
        <div className="traffic-workbench">
          <div className="traffic-scope">
            <span>
              Traffic analysis · {props.scenario.name} · r
              {props.scenario.revision}
            </span>
            <span>
              {props.network ? "Prepared network" : "Network unavailable"}
            </span>
          </div>
          {!activeScope ? (
            <p role="status">
              Clearing the previous workspace’s traffic inputs…
            </p>
          ) : (
            <>
              <div
                className="traffic-tabs"
                role="tablist"
                aria-label="Traffic workbench"
              >
                {tabs.map(({ id, label, icon: Icon }, index) => (
                  <button
                    type="button"
                    key={id}
                    id={`traffic-tab-${id}`}
                    role="tab"
                    aria-selected={tab === id}
                    aria-controls={`traffic-panel-${id}`}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                    onKeyDown={(event) => {
                      if (
                        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      )
                        return;
                      event.preventDefault();
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? tabs.length - 1
                            : (index +
                                (event.key === "ArrowRight" ? 1 : -1) +
                                tabs.length) %
                              tabs.length;
                      setTab(tabs[next].id);
                      document
                        .getElementById(`traffic-tab-${tabs[next].id}`)
                        ?.focus();
                    }}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))}
              </div>
              {props.controls}
              {props.mutationBlockedReason && (
                <p className="traffic-warning">{props.mutationBlockedReason}</p>
              )}
              {props.configurationNeedsReview && (
                <p className="traffic-warning">
                  The planning streets, source citations, prepared network or
                  worker identity changed. Recheck the displayed inputs and save
                  a reviewed configuration before starting another run. Retained
                  earlier evidence is unchanged.
                </p>
              )}
              {props.capabilityReason && (
                <p className="traffic-warning">{props.capabilityReason}</p>
              )}
              {!props.canEdit && (
                <p className="traffic-muted">
                  Read-only evidence. An editable alternative and a free account
                  are needed to save inputs or request processing.{" "}
                  {props.onRequireAccount && (
                    <button
                      type="button"
                      className="traffic-text-button"
                      onClick={props.onRequireAccount}
                    >
                      Sign in with a free account
                    </button>
                  )}
                </p>
              )}
              {changedRevision && (
                <div className="traffic-warning" role="status">
                  The scenario or saved traffic configuration changed while this
                  review was open. Saving and running are paused so this draft
                  cannot overwrite newer work.{" "}
                  <button
                    type="button"
                    className="button"
                    onClick={() => setConfirm("reload")}
                  >
                    Discard review and reload current inputs
                  </button>
                </div>
              )}
              {job && (
                <section
                  className="traffic-job"
                  aria-label="Traffic processing status"
                >
                  <strong>{job.stage}</strong>
                  <span>
                    {job.status} · job {job.id}
                  </span>
                  {job.progress !== null && (
                    <progress
                      aria-label="Traffic processing progress"
                      max={100}
                      value={Math.max(0, Math.min(100, job.progress))}
                    />
                  )}
                  <small>
                    Stage progress is not an estimated completion time.
                  </small>
                  {job.error && <p role="alert">{job.error}</p>}
                  <div className="traffic-actions">
                    {job.canCancel && props.onCancel && (
                      <button
                        type="button"
                        className="button"
                        disabled={locked || !props.canEdit}
                        onClick={() => void action("cancel")}
                      >
                        Cancel traffic run
                      </button>
                    )}
                    {job.canRetry && props.onRetry && (
                      <button
                        type="button"
                        className="button"
                        disabled={locked || !props.canEdit}
                        onClick={() => void action("retry")}
                      >
                        Retry traffic run
                      </button>
                    )}
                  </div>
                </section>
              )}
              <div
                id="traffic-panel-network"
                role="tabpanel"
                aria-labelledby="traffic-tab-network"
                hidden={tab !== "network"}
              >
                <fieldset disabled={locked} className="traffic-busy-fieldset">
                  <TrafficNetworkPanel
                    place={props.place}
                    scenario={props.scenario}
                    network={props.network}
                    counts={networkCounts}
                    selectedEdgeId={selectedEdgeId}
                    onSelectEdge={setSelectedEdgeId}
                    overlays={current.overlays}
                    onOverlaysChange={(overlays) => change({ overlays })}
                    canEdit={props.canEdit}
                    planningReviews={current.planningReviews}
                    onPlanningReviewsChange={(planningReviews) =>
                      change({ planningReviews })
                    }
                    planningPreview={planningPreview}
                    onCheckPlanning={checkPlanning}
                    mappedOverlays={mappedOverlays}
                    signalDrafts={current.signalDrafts}
                    signalEligibility={props.signalEligibility}
                    onSignalDraftsChange={(signalDrafts) =>
                      change({ signalDrafts })
                    }
                    planningSourceDeclarations={
                      current.planningSourceDeclarations
                    }
                    onPlanningSourceDeclarationsChange={(
                      planningSourceDeclarations,
                    ) => change({ planningSourceDeclarations })}
                  />
                </fieldset>
              </div>
              <div
                id="traffic-panel-counts"
                role="tabpanel"
                aria-labelledby="traffic-tab-counts"
                hidden={tab !== "counts"}
              >
                <fieldset disabled={locked} className="traffic-busy-fieldset">
                  <nav
                    className="traffic-count-steps"
                    aria-label="Counts and demand steps"
                  >
                    <a href="#traffic-count-period">1 · Period</a>
                    <a href="#traffic-count-observations">2 · Observations</a>
                    <a href="#traffic-count-demand">3 · Demand</a>
                    <a href="#traffic-count-validation">4 · Count check</a>
                  </nav>
                  {(props.commutePresets ?? []).map((preset) => (
                    <TrafficCommutePanel
                      key={`${base.scope}:${preset.id}:${preset.summary.binding.assetHash}`}
                      review={{
                        id: preset.id,
                        label: preset.label,
                        ...preset.summary,
                        compilationHash: preset.summary.binding.compilationHash,
                      }}
                      selected={
                        current.commute?.presetId === preset.id &&
                        current.commute.assetHash ===
                          preset.summary.binding.assetHash
                      }
                      canEdit={props.canEdit}
                      busy={locked || subdraftDirty}
                      onUse={() => {
                        if (!props.canEdit || locked || subdraftDirty) return;
                        if (current.demandRows.length) {
                          setPendingCommutePreset(preset.id);
                          setConfirm("commute");
                        } else useCommutePreset(preset.id);
                      }}
                      onDetach={detachCommute}
                      onDownload={
                        props.onDownloadCommute
                          ? () => props.onDownloadCommute!(preset.id)
                          : undefined
                      }
                      onInspect={
                        props.onInspectCommute
                          ? () => props.onInspectCommute!(preset.id)
                          : undefined
                      }
                    />
                  ))}
                  {current.commute &&
                    !(props.commutePresets ?? []).some(
                      (preset) =>
                        preset.summary.binding.assetHash ===
                        current.commute?.assetHash,
                    ) && (
                      <div className="traffic-warning">
                        <p>
                          This configuration retains an earlier Census commute
                          preparation. Its current operator files are
                          unavailable. The source-bound demand and clock remain
                          fixed; use the saved run’s private evidence files to
                          review the original preparation.
                        </p>
                        {props.canEdit && (
                          <button
                            type="button"
                            className="button"
                            disabled={locked || subdraftDirty}
                            onClick={detachCommute}
                          >
                            Make an editable copy
                          </button>
                        )}
                      </div>
                    )}
                  <TrafficPeriodPanel
                    period={current.period}
                    seed={current.seed}
                    onSeedChange={(seed) => change({ seed })}
                    onPeriodChange={(period) => change({ period })}
                    canEdit={props.canEdit}
                    periodLocked={!!current.commute}
                  />
                  {reviewedPeriod.error && (
                    <p role="status" className="traffic-warning">
                      {reviewedPeriod.error} Observation filtering uses the last
                      saved period until this is corrected.
                    </p>
                  )}
                  <section
                    id="traffic-count-observations"
                    aria-label="Observation review"
                  >
                    <span className="eyebrow">2 · OBSERVATIONS</span>
                    <TrafficCountsPanel
                      key={`${base.scope}:${resetVersion}`}
                      place={props.place}
                      network={props.network}
                      rows={current.counts}
                      pack={current.countPack}
                      period={reviewedPeriod.value ?? props.period}
                      canEdit={props.canEdit}
                      onChange={(counts) => change({ counts })}
                      onAddBatch={addBatch}
                      onDirtyChange={setCountSubdraftDirty}
                    />
                  </section>
                  <TrafficDemandPanel
                    period={current.period}
                    rows={current.demandRows}
                    onRowsChange={(demandRows) => change({ demandRows })}
                    routes={current.routes}
                    onRoutesChange={(routes) => change({ routes })}
                    demand={current.demand}
                    onAddSource={(source) => {
                      if (!props.canEdit || locked) return;
                      setDraft((value) => ({
                        ...value,
                        demand: {
                          ...value.demand,
                          sources: [
                            ...value.demand.sources,
                            draftSource(source),
                          ],
                        },
                        sourceDeclarations: [
                          ...value.sourceDeclarations,
                          source,
                        ],
                      }));
                    }}
                    onDirtyChange={setDemandSubdraftDirty}
                    key={`demand:${base.scope}:${resetVersion}`}
                    network={props.network}
                    canEdit={props.canEdit && !current.commute}
                  />
                  <TrafficCalibrationPanel
                    key={`criteria:${base.scope}:${resetVersion}`}
                    value={current.calibrationPlan}
                    onChange={(calibrationPlan) => change({ calibrationPlan })}
                    pack={countReview.pack}
                    pendingMappingCountIds={countReview.pendingMappingCountIds}
                    network={props.network}
                    period={reviewedPeriod.value}
                    periodError={reviewedPeriod.error}
                    canEdit={props.canEdit}
                    onDirtyChange={setCriteriaSubdraftDirty}
                    onAddSource={(source) => {
                      if (!props.canEdit || locked) return;
                      setDraft((value) => ({
                        ...value,
                        countPack: {
                          ...value.countPack,
                          sources: [
                            ...value.countPack.sources,
                            draftSource(source),
                          ],
                        },
                        sourceDeclarations: [
                          ...value.sourceDeclarations,
                          source,
                        ],
                        calibrationPlan: value.calibrationPlan
                          ? {
                              ...value.calibrationPlan,
                              sourceIds: [
                                ...value.calibrationPlan.sourceIds,
                                source.sourceId,
                              ],
                            }
                          : null,
                      }));
                    }}
                  />
                  <TrafficSourceReview
                    sources={[
                      ...current.countPack.sources,
                      ...current.demand.sources,
                    ]}
                    declarations={current.sourceDeclarations}
                    canEdit={props.canEdit}
                    onChange={(sourceDeclarations) =>
                      change({ sourceDeclarations })
                    }
                  />
                </fieldset>
              </div>
              <div
                id="traffic-panel-results"
                role="tabpanel"
                aria-labelledby="traffic-tab-results"
                hidden={tab !== "results"}
              >
                {!props.result && props.scenario.traffic ? (
                  <PublishedTraffic
                    place={props.place}
                    scenario={props.scenario}
                  />
                ) : (
                  <TrafficResults
                    pair={props.result ?? null}
                    stale={dirty || subdraftDirty || !props.resultCurrent}
                    staleReason={
                      dirty || subdraftDirty
                        ? "Local review inputs have changed. This capture describes the earlier saved inputs."
                        : props.resultStaleReason
                    }
                    onDownload={props.onDownload}
                  />
                )}
                <fieldset disabled={locked} className="traffic-busy-fieldset">
                  {props.resultActions}
                </fieldset>
              </div>
              {error && (
                <p role="alert" className="traffic-error">
                  {error}
                </p>
              )}
              {props.canEdit && (
                <label className="traffic-check">
                  <input
                    type="checkbox"
                    checked={current.scopeAcknowledged}
                    disabled={locked}
                    onChange={(event) =>
                      change({ scopeAcknowledged: event.target.checked })
                    }
                  />
                  <span>
                    I understand this is an explicit network experiment. Entered
                    demand and directed-edge controls are independent of
                    planning edits; geometry, signal and turn edits are not
                    represented without a reviewed correspondence.
                  </span>
                </label>
              )}
              <footer className="traffic-footer">
                <div>
                  <strong>
                    {dirty || subdraftDirty
                      ? "Local review · not saved"
                      : "Recorded inputs"}
                  </strong>
                  {dirty && input.error && (
                    <p className="traffic-validation" role="status">
                      {input.error}
                    </p>
                  )}
                  <small>
                    Free for everyone. Processing is subject to the shared
                    operating budget and fair queue.
                  </small>
                </div>
                <div className="traffic-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={locked}
                    onClick={requestClose}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={
                      !props.onApply ||
                      !props.canEdit ||
                      (!dirty && !props.configurationNeedsReview) ||
                      !input.value ||
                      !current.scopeAcknowledged ||
                      !!props.mutationBlockedReason ||
                      changedRevision ||
                      subdraftDirty ||
                      locked
                    }
                    onClick={() => void action("save")}
                  >
                    {busy === "save" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Check size={14} />
                    )}
                    Save traffic configuration
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      !props.onRun ||
                      !!props.mutationBlockedReason ||
                      !props.canEdit ||
                      dirty ||
                      subdraftDirty ||
                      changedRevision ||
                      locked ||
                      job?.status === "queued" ||
                      job?.status === "running"
                    }
                    onClick={() => void action("run")}
                  >
                    <Play size={14} />
                    Run paired traffic analysis
                  </button>
                </div>
              </footer>
            </>
          )}
        </div>
      </Modal>
      <Dialog.Root
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content
            role="alertdialog"
            className="modal traffic-confirm"
            aria-describedby="traffic-discard-description"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              keep.current?.focus();
            }}
          >
            <Dialog.Title>
              {confirm === "commute"
                ? "Use this commute recipe?"
                : "Leave this traffic review?"}
            </Dialog.Title>
            <Dialog.Description id="traffic-discard-description">
              {confirm === "commute"
                ? "This replaces the draft demand, routes and analysis clock with the selected preparation. Saved configurations and runs stay unchanged. Review the new inputs before saving."
                : "Unsubmitted field mappings and local changes will be discarded. Already admitted server jobs and retained evidence remain available."}
            </Dialog.Description>
            <div className="traffic-actions">
              <button
                type="button"
                className="button"
                ref={keep}
                onClick={() => setConfirm(null)}
              >
                Keep reviewing
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => {
                  if (confirm === "commute" && pendingCommutePreset) {
                    useCommutePreset(pendingCommutePreset);
                  } else if (confirm === "reload") {
                    reset();
                  } else props.onClose();
                }}
              >
                {confirm === "commute"
                  ? "Replace draft demand and clock"
                  : "Discard local review"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export { TrafficPanel } from "./TrafficEntry";
