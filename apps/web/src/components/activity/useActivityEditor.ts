import { useEffect, useMemo, useRef, useState } from "react";
import {
  USER_ACTIVITY_SOURCE,
  validateActivityGeometry,
  validateActivityScenario,
  type ActivityNeighborhood,
  type ActivityScenario,
  type NeighborhoodBrushResult,
  type Place,
  type Position,
  type Project,
  type Scenario,
  type Source,
  type VehicleAvailability,
} from "@urban/core";
import { adoptActivityScenario } from "@urban/models";
import { useWorkspace } from "../../lib/workspace";
import { api } from "../../lib/api";
import type {
  MapNeighborhoodDraft,
  MapNeighborhoodDraftChange,
  MapNeighborhoodStroke,
} from "../map/neighborhood-drawing";
import { runNeighborhoodBrush } from "../map/neighborhood-brush";
import { useActivityResolution } from "./useActivityResolution";
import {
  activeAreaPath,
  areaGeometry,
  areaRings,
  changeActivityDraft,
  draftValue,
  parseAreaCoordinates,
  replaceAreaGeometry,
  travelActivityDraft,
  type ActivityDraft,
  type ActivityDraftValue,
  type AreaDraft,
} from "./draft";

interface Options {
  place: Place | null;
  project: Project | null;
  scenario: Scenario | undefined;
  editable: boolean;
  enabled: boolean;
  onStart: () => void;
  onToast: (message: string) => void;
}
export function useActivityEditor({
  place,
  project,
  scenario,
  editable,
  enabled,
  onStart,
  onToast,
}: Options) {
  const scope =
    project && scenario
      ? `${project.id}:${scenario.id}:${scenario.revision}`
      : "";
  const [state, setState] = useState<ActivityDraft | null>(null);
  const [selection, setSelection] = useState<{
    scope: string;
    id: string | null;
  }>({ scope: "", id: null });
  const [busy, setBusy] = useState(false);
  const [brushResult, setBrushResult] =
    useState<NeighborhoodBrushResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [referenceNotice, setReferenceNotice] = useState("");
  const operation = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveScope = useRef({ scope, editable });
  liveScope.current = { scope, editable };
  const draft = state?.scope === scope && editable ? state : null;
  const previewScenario = useMemo(
    () =>
      scenario && draft
        ? {
            ...scenario,
            activity: draft.activity,
            horizon: draft.horizon,
            sources: [
              ...(scenario.sources ?? []).filter(
                (source) => !draft.sources.some((s) => s.id === source.id),
              ),
              ...draft.sources,
            ],
          }
        : scenario,
    [scenario, draft?.activity, draft?.horizon, draft?.sources],
  );
  const preview = useActivityResolution(
    enabled || draft ? place : null,
    enabled || draft ? previewScenario : undefined,
  );
  const areas =
    draft?.activity.neighborhoods ?? scenario?.activity?.neighborhoods ?? [];
  const selected =
    selection.scope === scope
      ? (areas.find((area) => area.id === selection.id) ?? null)
      : null;
  const area = draft?.area;
  const areaPreview = useMemo(() => {
    if (!area || !place) return { geometry: null, error: null };
    try {
      const geometry = areaGeometry(area.rings, area.originalType);
      const checked = validateActivityGeometry(geometry, place);
      if (!checked.valid)
        throw new Error(checked.error ?? "Finish the neighborhood boundary.");
      return { geometry, error: null };
    } catch (error) {
      return { geometry: null, error: (error as Error).message };
    }
  }, [area?.rings, area?.originalType, place]);
  useEffect(() => {
    if (state && (state.scope !== scope || !editable)) {
      setState(null);
      setBrushResult(null);
      setLocalError(null);
      onToast(
        "The People draft closed because the scenario or editing access changed.",
      );
    }
  }, [state, scope, editable, onToast]);
  useEffect(
    () => () => {
      operation.current?.abort();
      operation.current = null;
    },
    [scope, editable],
  );
  useEffect(() => {
    setBusy(false);
    setReferenceNotice("");
  }, [scope, editable]);
  function validFields() {
    const valid = !formRef.current || formRef.current.reportValidity();
    if (!valid)
      setLocalError("Finish the highlighted field before continuing.");
    return valid;
  }
  function change(value: ActivityDraftValue) {
    if (busy) return;
    setLocalError(null);
    setBrushResult(null);
    setState((current) =>
      current?.scope === scope ? changeActivityDraft(current, value) : current,
    );
  }
  function update(
    activity: ActivityScenario,
    sources?: Source[],
    horizon?: Scenario["horizon"],
  ) {
    if (!draft) return;
    change({
      ...draftValue(draft),
      activity,
      horizon: horizon ?? draft.horizon,
      sources: sources
        ? [
            ...draft.sources.filter(
              (s) => !sources.some((other) => other.id === s.id),
            ),
            ...sources,
          ]
        : draft.sources,
    });
  }
  function patchArea(patch: Partial<AreaDraft>, history = true) {
    if (!draft?.area || busy) return;
    const value = { ...draftValue(draft), area: { ...draft.area, ...patch } };
    if (history) change(value);
    else
      setState((current) =>
        current?.id === draft.id
          ? { ...current, area: value.area, revision: current.revision + 1 }
          : current,
      );
  }
  function start() {
    if (!editable || !place || !scenario || draft) return;
    try {
      const activity = scenario.activity
        ? structuredClone(scenario.activity)
        : adoptActivityScenario(place, scenario);
      setState({
        id: crypto.randomUUID(),
        scope,
        revision: 0,
        activity,
        horizon: scenario.horizon,
        sources: [USER_ACTIVITY_SOURCE],
        area: null,
        past: [],
        future: [],
      });
      setLocalError(null);
      setBrushResult(null);
      onStart();
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  function startArea(original?: ActivityNeighborhood) {
    if (!draft || busy || draft.area || !validFields()) return;
    if (!original && draft.activity.neighborhoods.length >= 100) {
      setLocalError("Use at most 100 neighborhoods in an alternative.");
      return;
    }
    const rings = areaRings(original?.geometry);
    change({
      ...draftValue(draft),
      area: {
        id: original?.id ?? `neighborhood-${crypto.randomUUID()}`,
        name: original?.name ?? "New neighborhood",
        rings,
        originalType: original?.geometry.type,
        population: original?.population,
        employment: original?.employment,
        activeRingId: rings[0]?.id ?? null,
        selectedVertexIndex: null,
        mode: original ? "reshape" : "paint",
        brushRadiusMeters: 60,
        coordinateText: "",
      },
    });
    onStart();
  }
  function pathChange(
    coordinates: Position[],
    detail: MapNeighborhoodDraftChange,
  ) {
    if (!area || area.coordinateText.trim()) return;
    patchArea({
      rings: area.rings.map((ring) =>
        ring.id === detail.ringId ? { ...ring, coordinates } : ring,
      ),
      selectedVertexIndex:
        detail.vertexIndex < coordinates.length ? detail.vertexIndex : null,
      ...(coordinates.length ? {} : { mode: "draw" }),
    });
  }
  function vertexSelect(ringId: string, index: number) {
    if (area?.coordinateText.trim()) return;
    patchArea(
      { activeRingId: ringId, selectedVertexIndex: index, mode: "reshape" },
      false,
    );
  }
  function removeVertex(index?: number) {
    if (!area) return;
    const vertex =
      index ?? area.selectedVertexIndex ?? activeAreaPath(area).length - 1;
    pathChange(
      activeAreaPath(area).filter((_, i) => i !== vertex),
      {
        ringId: area.activeRingId!,
        kind: "move",
        vertexIndex: Math.max(0, vertex - 1),
      },
    );
  }
  function addRing(hole: boolean) {
    if (!area || area.coordinateText.trim()) return;
    const active = area.rings.find((ring) => ring.id === area.activeRingId);
    const partIndex = hole
      ? (active?.partIndex ?? 0)
      : Math.max(-1, ...area.rings.map((ring) => ring.partIndex)) + 1;
    const ringIndex = hole
      ? Math.max(
          0,
          ...area.rings
            .filter((ring) => ring.partIndex === partIndex)
            .map((ring) => ring.ringIndex),
        ) + 1
      : 0;
    const id = crypto.randomUUID();
    patchArea({
      rings: [...area.rings, { id, partIndex, ringIndex, coordinates: [] }],
      activeRingId: id,
      selectedVertexIndex: null,
      mode: "draw",
    });
  }
  function removeRing() {
    if (!area || area.coordinateText.trim()) return;
    const active = area.rings.find((ring) => ring.id === area.activeRingId);
    if (!active) return;
    let rings = area.rings
      .filter((ring) =>
        active.ringIndex === 0
          ? ring.partIndex !== active.partIndex
          : ring.id !== active.id,
      )
      .map((ring) => ({
        ...ring,
        partIndex:
          active.ringIndex === 0 && ring.partIndex > active.partIndex
            ? ring.partIndex - 1
            : ring.partIndex,
        ringIndex:
          active.ringIndex > 0 &&
          ring.partIndex === active.partIndex &&
          ring.ringIndex > active.ringIndex
            ? ring.ringIndex - 1
            : ring.ringIndex,
      }));
    if (!rings.length) rings = areaRings();
    patchArea({
      rings,
      activeRingId: rings[0].id,
      selectedVertexIndex: null,
      mode: "draw",
    });
  }
  function useCoordinates() {
    if (!area) return;
    try {
      const coordinates = parseAreaCoordinates(area.coordinateText);
      patchArea({
        rings: area.rings.map((ring) =>
          ring.id === area.activeRingId ? { ...ring, coordinates } : ring,
        ),
        coordinateText: "",
        selectedVertexIndex: null,
      });
    } catch (error) {
      setLocalError((error as Error).message);
    }
  }
  async function brush(stroke: MapNeighborhoodStroke) {
    if (
      !draft ||
      !area ||
      !place ||
      busy ||
      area.coordinateText.trim() ||
      stroke.draftId !== draft.id ||
      stroke.draftRevision !== draft.revision
    )
      return;
    if (area.rings.some((r) => r.coordinates.length) && !areaPreview.geometry) {
      setLocalError(
        "Finish the precise boundary or undo it before using the brush.",
      );
      return;
    }
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setLocalError(null);
    try {
      const response = await runNeighborhoodBrush(
        {
          draftId: draft.id,
          draftRevision: draft.revision,
          input: {
            geometry: areaPreview.geometry,
            studyArea: place,
            otherGeometries: draft.activity.neighborhoods
              .filter((n) => n.id !== area.id)
              .map((n) => n.geometry),
            stroke,
          },
        },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        liveScope.current.scope !== scope ||
        !liveScope.current.editable ||
        stateRef.current?.id !== response.draftId ||
        stateRef.current.revision !== response.draftRevision
      )
        return;
      setState((current) => {
        if (
          !current?.area ||
          current.id !== response.draftId ||
          current.revision !== response.draftRevision
        )
          return current;
        return response.result.changed
          ? changeActivityDraft(current, {
              ...draftValue(current),
              area: replaceAreaGeometry(
                current.area!,
                response.result.geometry,
              ),
            })
          : current;
      });
      setBrushResult(response.result);
    } catch (error) {
      if (!controller.signal.aborted) setLocalError((error as Error).message);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }
  function finishArea() {
    if (!draft || !area || !place || busy || !validFields()) return;
    if (area.coordinateText.trim()) {
      setLocalError(
        "Use or discard the coordinate text before keeping the area.",
      );
      return;
    }
    try {
      if (!areaPreview.geometry)
        throw new Error(
          areaPreview.error ?? "Paint or draw a nonempty boundary.",
        );
      const neighborhood: ActivityNeighborhood = {
        id: area.id,
        name: area.name.trim(),
        geometry: areaPreview.geometry,
        population: area.population,
        employment: area.employment,
        sourceId: USER_ACTIVITY_SOURCE.id,
      };
      const activity = {
        ...draft.activity,
        neighborhoods: [
          ...draft.activity.neighborhoods.filter((n) => n.id !== area.id),
          neighborhood,
        ],
      };
      validateActivityScenario(activity, place, [
        ...(scenario?.sources ?? []),
        ...draft.sources,
      ]);
      change({ ...draftValue(draft), activity, area: null });
      setSelection({ scope, id: area.id });
    } catch (error) {
      setLocalError((error as Error).message);
    }
  }
  function discardArea() {
    if (draft && !busy) change({ ...draftValue(draft), area: null });
  }
  function removeArea(id: string) {
    if (draft && !draft.area)
      update({
        ...draft.activity,
        neighborhoods: draft.activity.neighborhoods.filter((n) => n.id !== id),
      });
  }
  function commit(
    activity: ActivityScenario | null,
    label: string,
    horizon?: Scenario["horizon"],
  ) {
    if (!editable || !place || !project || !scenario) return;
    const current = useWorkspace.getState();
    const active = current.project?.scenarios.find(
      (s) => s.id === current.project?.activeScenarioId,
    );
    if (
      current.readOnly ||
      current.project?.id !== project.id ||
      active?.id !== scenario.id ||
      active.revision !== scenario.revision
    )
      throw new Error(
        "The project or editing access changed. Reopen this alternative before applying.",
      );
    if (activity)
      validateActivityScenario(activity, place, [
        ...(scenario.sources ?? []),
        ...(draft?.sources ?? []),
      ]);
    current.dispatch(
      {
        type: "scenario.activity",
        activity,
        sources: draft?.sources ?? [USER_ACTIVITY_SOURCE],
        ...(horizon === undefined ? {} : { horizon }),
      },
      label,
    );
    if (
      useWorkspace.getState().project?.scenarios.find((s) => s.id === active.id)
        ?.revision !==
      active.revision + 1
    )
      throw new Error(
        "The controls were not applied. Wait for the current project operation to finish.",
      );
    operation.current?.abort();
    setState(null);
    setLocalError(null);
    setBrushResult(null);
  }
  function apply() {
    if (!draft || busy || draft.area || !validFields()) return;
    try {
      commit(
        draft.activity,
        "Update population, jobs & household vehicles",
        draft.horizon === scenario?.horizon ? undefined : draft.horizon,
      );
      onToast(
        "People controls applied. Building capacity is preserved; Undo restores the previous controls.",
      );
    } catch (error) {
      setLocalError((error as Error).message);
    }
  }
  function remove() {
    try {
      commit(null, "Remove activity controls");
      onToast(
        "Activity controls removed. This alternative uses its building-based assumptions again.",
      );
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  function discard() {
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setState(null);
    setLocalError(null);
    setBrushResult(null);
  }
  function travel(direction: "undo" | "redo") {
    if (busy || !validFields()) return;
    setLocalError(null);
    setBrushResult(null);
    setState((current) =>
      current?.scope === scope
        ? travelActivityDraft(current, direction)
        : current,
    );
  }
  async function fetchVehicleReference() {
    if (!draft || busy || !project) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setBusy(true);
    setReferenceNotice("");
    try {
      const response = await api<{
        status: "available" | "unavailable";
        reference: VehicleAvailability | null;
        reason?: string;
      }>(`/projects/${encodeURIComponent(project.id)}/vehicle-reference`, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        liveScope.current.scope !== scope ||
        !liveScope.current.editable ||
        stateRef.current?.id !== draft.id
      )
        return;
      if (!response.reference) {
        setReferenceNotice(
          response.reason ??
            "No matching household vehicle estimate is prepared for this geography.",
        );
        return;
      }
      const reference = response.reference;
      setState((current) =>
        current?.id === draft.id
          ? changeActivityDraft(current, {
              ...draftValue(current),
              activity: {
                ...current.activity,
                vehicleReference: reference,
                reference: {
                  ...current.activity.reference,
                  vehicles: { kind: "published" },
                },
              },
            })
          : current,
      );
      setReferenceNotice(
        "Matching Census vehicle estimate added to this draft. Apply controls to retain this frozen reference.",
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setReferenceNotice((error as Error).message);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }
  const mapDraft: MapNeighborhoodDraft | null =
    draft && area
      ? {
          id: draft.id,
          revision: draft.revision,
          neighborhoodId: area.id,
          rings: area.rings,
          mode: area.mode,
          activeRingId: area.activeRingId,
          selectedVertexIndex: area.selectedVertexIndex,
          previewGeometry: areaPreview.geometry,
          excludedGeometry: brushResult?.excludedGeometry,
          brushRadiusMeters: area.brushRadiusMeters,
          busy,
        }
      : null;
  return {
    formRef,
    validFields,
    draft,
    area,
    areas,
    selected,
    mapDraft,
    previewScenario,
    preview,
    areaPreview,
    busy,
    brushResult,
    localError,
    referenceNotice,
    editable,
    start,
    update,
    patchArea,
    startArea,
    finishArea,
    discardArea,
    removeArea,
    pathChange,
    vertexSelect,
    removeVertex,
    addRing,
    removeRing,
    useCoordinates,
    brush,
    apply,
    remove,
    discard,
    fetchVehicleReference,
    select: (id: string | null) => setSelection({ scope, id }),
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    clearError: () => setLocalError(null),
  };
}
export type ActivityEditorController = ReturnType<typeof useActivityEditor>;
