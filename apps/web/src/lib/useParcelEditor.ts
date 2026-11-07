import { useEffect, useMemo, useState } from "react";
import {
  assembleParcels,
  materializeParcels,
  parcelPreset,
  splitParcel,
  USER_PARCEL_SOURCE,
  validateParcelCommand,
  type Command,
  type Parcel,
  type Place,
  type Position,
  type Project,
  type Scenario,
} from "@urban/core";
import type {
  MapParcelDraft,
  MapParcelDraftChange,
} from "../components/map/parcel-drawing";
import {
  activeParcelPath,
  changeParcelDraft,
  parcelDraftGeometry,
  parcelDraftRings,
  redoParcelDraft,
  undoParcelDraft,
  type ParcelDraft,
  type ParcelDraftValue,
} from "./parcel-draft";
import { useWorkspace } from "./workspace";
import { commandSchema } from "../../../../packages/core/src/validation";

interface Options {
  place: Place | null;
  project: Project | null;
  scenario: Scenario | undefined;
  editable: boolean;
  onStart: () => void;
  onToast: (message: string) => void;
}
export function useParcelEditor({
  place,
  project,
  scenario,
  editable,
  onStart,
  onToast,
}: Options) {
  const scope =
    project && scenario
      ? `${project.id}:${scenario.id}:${scenario.revision}`
      : "";
  const [state, setState] = useState<ParcelDraft | null>(null);
  const [selection, setSelection] = useState<{
    scope: string;
    id: string | null;
  }>({ scope: "", id: null });
  const parcels = useMemo(
    () => (place && scenario ? materializeParcels(place, scenario) : []),
    [place, scenario],
  );
  const draft = state?.scope === scope && editable ? state : null;
  const selected =
    selection.scope === scope
      ? (parcels.find((item) => item.id === selection.id) ?? null)
      : null;
  useEffect(() => {
    if (state && (state.scope !== scope || !editable)) {
      setState(null);
      onToast(
        "Parcel drawing closed because the scenario or editing access changed.",
      );
    }
  }, [state, scope, editable, onToast]);

  const preview = useMemo((): {
    parcels: Parcel[];
    command: Command | null;
    error: string | null;
  } => {
    if (!draft || !place || !scenario)
      return { parcels: [], command: null, error: null };
    try {
      const name = draft.value.name.trim();
      if (!name || name.length > 240)
        throw new Error(
          "Give the proposal a name between 1 and 240 characters.",
        );
      const originals = draft.value.sourceParcelIds.map((id) => {
        const found = parcels.find((item) => item.id === id);
        if (!found)
          throw new Error("A selected source boundary is no longer available.");
        return found;
      });
      let proposed: Parcel[];
      let command: Command;
      if (draft.operation === "split") {
        if (draft.value.splitLine.length !== 2)
          throw new Error("Choose two points to define the straight cut.");
        if (originals.length !== 1)
          throw new Error("Choose one parcel or block to subdivide.");
        proposed = splitParcel(
          originals[0],
          draft.value.splitLine as [Position, Position],
        ).map((parcel, index) => ({
          ...parcel,
          name: `${name} · ${index + 1}`,
        }));
        command = {
          type: "parcels.replace",
          operation: "split",
          removeIds: originals.map((item) => item.id),
          parcels: proposed,
          source: USER_PARCEL_SOURCE,
        };
      } else if (draft.operation === "assemble") {
        if (originals.length < 2)
          throw new Error(
            "Choose at least two parcels or two blocks to assemble.",
          );
        proposed = [assembleParcels(originals, name)];
        command = {
          type: "parcels.replace",
          operation: "assemble",
          removeIds: originals.map((item) => item.id),
          parcels: proposed,
          source: USER_PARCEL_SOURCE,
        };
      } else {
        const original = originals[0];
        const geometry = parcelDraftGeometry(
          draft.value.rings,
          original?.geometry.type,
        );
        const reshaped =
          original &&
          JSON.stringify(geometry) !== JSON.stringify(original.geometry);
        if (
          original &&
          name === original.name &&
          JSON.stringify(geometry) === JSON.stringify(original.geometry)
        )
          throw new Error("Change the boundary or name before applying.");
        const parcel: Parcel = original
          ? {
              ...original,
              name,
              geometry,
              ...(reshaped
                ? {
                    geometrySourceId: USER_PARCEL_SOURCE.id,
                    lineage: {
                      operation: "reshape",
                      parentIds: [original.id],
                      sourceIds: [
                        ...new Set([
                          original.sourceId,
                          original.geometrySourceId ?? original.sourceId,
                          ...(original.lineage?.sourceIds ?? []),
                        ]),
                      ],
                    },
                  }
                : {}),
            }
          : {
              ...parcelPreset(geometry, name, draft.value.kind),
              id: `parcel-${draft.id}`,
            };
        proposed = [parcel];
        command = { type: "parcel.upsert", parcel, source: USER_PARCEL_SOURCE };
      }
      const parsed = commandSchema.safeParse(command);
      if (!parsed.success)
        throw new Error(
          draft.operation === "split" &&
          parsed.error.issues.some((issue) => issue.path.includes("name"))
            ? "Use a shorter name prefix so each new boundary name fits within 240 characters."
            : (parsed.error.issues[0]?.message ??
              "Review the boundary fields before applying."),
        );
      validateParcelCommand(place, scenario, command);
      return { parcels: proposed, command, error: null };
    } catch (error) {
      return { parcels: [], command: null, error: (error as Error).message };
    }
  }, [draft?.value, draft?.operation, draft?.id, place, scenario, parcels]);

  function select(id: string | null) {
    if (draft?.operation === "assemble" && id) {
      const selected = draft.value.sourceParcelIds.includes(id)
        ? draft.value.sourceParcelIds.filter((item) => item !== id)
        : [...draft.value.sourceParcelIds, id];
      change({
        ...draft.value,
        kind:
          parcels.find((item) => item.id === selected[0])?.kind ??
          draft.value.kind,
        sourceParcelIds: selected,
      });
    } else if (!draft) setSelection({ scope, id });
  }
  function start(
    operation: ParcelDraft["operation"],
    parcel?: Parcel,
    kind: Parcel["kind"] = "parcel",
  ) {
    if (!editable || !place || !scenario) return;
    const rings =
      operation === "draw" || operation === "reshape"
        ? parcelDraftRings(parcel?.geometry)
        : [];
    setState({
      id: crypto.randomUUID(),
      scope,
      operation,
      value: {
        name:
          operation === "assemble"
            ? "Assembled boundary"
            : (parcel?.name ??
              (kind === "block" ? "Proposed block" : "Proposed parcel")),
        kind: parcel?.kind ?? kind,
        rings,
        splitLine: [],
        sourceParcelIds: parcel ? [parcel.id] : [],
      },
      activeRingId: rings[0]?.id ?? null,
      mode: operation === "reshape" ? "reshape" : "draw",
      selectedVertexIndex: operation === "reshape" ? 0 : null,
      snapToParcels: true,
      coordinateText: "",
      past: [],
      future: [],
    });
    setSelection({ scope, id: null });
    onStart();
  }
  function change(value: ParcelDraftValue) {
    setState((current) =>
      current?.scope === scope ? changeParcelDraft(current, value) : current,
    );
  }
  function patch(
    patch: Partial<
      Pick<
        ParcelDraft,
        | "activeRingId"
        | "mode"
        | "selectedVertexIndex"
        | "snapToParcels"
        | "coordinateText"
      >
    >,
  ) {
    setState((current) =>
      current?.scope === scope ? { ...current, ...patch } : current,
    );
  }
  function pathChange(coordinates: Position[], detail: MapParcelDraftChange) {
    setState((current) => {
      if (!current || current.scope !== scope) return current;
      const value =
        detail.ringId === null
          ? { ...current.value, splitLine: coordinates }
          : {
              ...current.value,
              rings: current.value.rings.map((ring) =>
                ring.id === detail.ringId ? { ...ring, coordinates } : ring,
              ),
            };
      return {
        ...changeParcelDraft(current, value),
        selectedVertexIndex: detail.vertexIndex,
      };
    });
  }
  function vertexSelect(ringId: string | null, index: number) {
    patch({
      activeRingId: ringId,
      selectedVertexIndex: index,
      mode: "reshape",
    });
  }
  function removeVertex(index: number) {
    if (!draft) return;
    pathChange(
      activeParcelPath(draft).filter((_, i) => i !== index),
      {
        ringId: draft.operation === "split" ? null : draft.activeRingId,
        kind: "move",
        vertexIndex: Math.max(0, index - 1),
      },
    );
    patch({ selectedVertexIndex: null });
  }
  function addRing(hole: boolean) {
    if (!draft || draft.coordinateText.trim()) return;
    const current = draft.value.rings.find(
      (ring) => ring.id === draft.activeRingId,
    );
    const partIndex = hole
      ? (current?.partIndex ?? 0)
      : Math.max(-1, ...draft.value.rings.map((ring) => ring.partIndex)) + 1;
    const ringIndex = hole
      ? Math.max(
          -1,
          ...draft.value.rings
            .filter((ring) => ring.partIndex === partIndex)
            .map((ring) => ring.ringIndex),
        ) + 1
      : 0;
    const id = crypto.randomUUID();
    change({
      ...draft.value,
      rings: [
        ...draft.value.rings,
        { id, partIndex, ringIndex, coordinates: [] },
      ],
    });
    patch({ activeRingId: id, selectedVertexIndex: null, mode: "draw" });
  }
  function removeRing() {
    if (!draft || draft.coordinateText.trim()) return;
    const current = draft.value.rings.find(
      (ring) => ring.id === draft.activeRingId,
    );
    if (!current) return;
    const rings =
      current.ringIndex === 0
        ? draft.value.rings
            .filter((ring) => ring.partIndex !== current.partIndex)
            .map((ring) => ({
              ...ring,
              partIndex:
                ring.partIndex > current.partIndex
                  ? ring.partIndex - 1
                  : ring.partIndex,
            }))
        : draft.value.rings
            .filter((ring) => ring.id !== current.id)
            .map((ring) => ({
              ...ring,
              ringIndex:
                ring.partIndex === current.partIndex &&
                ring.ringIndex > current.ringIndex
                  ? ring.ringIndex - 1
                  : ring.ringIndex,
            }));
    change({
      ...draft.value,
      rings: rings.length ? rings : parcelDraftRings(),
    });
    patch({ selectedVertexIndex: null, mode: "draw" });
  }
  function selectAfterCommand(ids: string[]) {
    const latest = useWorkspace.getState().project;
    const active = latest?.scenarios.find(
      (item) => item.id === latest.activeScenarioId,
    );
    setSelection({
      scope:
        latest && active
          ? `${latest.id}:${active.id}:${active.revision}`
          : scope,
      id: ids.length === 1 ? ids[0] : null,
    });
  }
  function commit(command: Command, label: string) {
    const current = useWorkspace.getState();
    const active = current.project?.scenarios.find(
      (item) => item.id === current.project?.activeScenarioId,
    );
    if (
      !active ||
      current.readOnly ||
      current.project?.id !== project?.id ||
      active.id !== scenario?.id ||
      active.revision !== scenario?.revision
    )
      throw new Error(
        "The project or editing access changed. Reopen this alternative before applying.",
      );
    current.dispatch(command, label);
    if (
      useWorkspace
        .getState()
        .project?.scenarios.find((item) => item.id === active.id)?.revision !==
      active.revision + 1
    )
      throw new Error(
        "The boundary was not applied. Wait for the current project operation to finish.",
      );
  }
  function apply() {
    if (!draft || !editable) return;
    if (draft.coordinateText.trim()) {
      onToast("Use or discard the coordinate text before applying.");
      return;
    }
    if (!preview.command || preview.error) {
      onToast(preview.error ?? "Finish the boundary before applying.");
      return;
    }
    try {
      commit(
        preview.command,
        `${draft.operation === "draw" ? "Draw" : draft.operation === "reshape" ? "Reshape" : draft.operation === "split" ? "Subdivide" : "Assemble"} ${draft.value.name.trim()}`,
      );
      setState(null);
      selectAfterCommand(preview.parcels.map((item) => item.id));
      onToast(
        `${preview.parcels.length === 1 ? preview.parcels[0].name : `${preview.parcels.length} boundaries`} applied. Undo restores the previous geometry.`,
      );
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  function discard() {
    setState(null);
    setSelection({
      scope,
      id:
        draft?.value.sourceParcelIds.length === 1
          ? draft.value.sourceParcelIds[0]
          : null,
    });
  }
  function remove(parcel: Parcel) {
    if (!editable || draft) return;
    try {
      commit({ type: "parcel.remove", id: parcel.id }, `Remove ${parcel.name}`);
      selectAfterCommand([]);
      onToast(
        "Boundary removed from this alternative. The baseline is preserved.",
      );
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  const mapDraft: MapParcelDraft | null = draft
    ? {
        id: draft.id,
        operation: draft.operation,
        rings: draft.value.rings,
        activeRingId: draft.activeRingId,
        mode: draft.mode,
        selectedVertexIndex: draft.selectedVertexIndex,
        splitLine: draft.value.splitLine,
        sourceParcelIds: draft.value.sourceParcelIds,
        previewGeometries: preview.parcels.map((item) => item.geometry),
        snapToParcels: draft.snapToParcels,
      }
    : null;
  return {
    draft,
    mapDraft,
    parcels,
    selected,
    preview,
    selectedIds: draft
      ? draft.value.sourceParcelIds
      : selected
        ? [selected.id]
        : [],
    select,
    start,
    change,
    patch,
    pathChange,
    vertexSelect,
    removeVertex,
    addRing,
    removeRing,
    apply,
    discard,
    remove,
    undo: () =>
      setState((current) => (current ? undoParcelDraft(current) : current)),
    redo: () =>
      setState((current) => (current ? redoParcelDraft(current) : current)),
  };
}
export type ParcelEditorController = ReturnType<typeof useParcelEditor>;
