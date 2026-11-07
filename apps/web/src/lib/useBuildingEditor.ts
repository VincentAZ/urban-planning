import { useEffect, useMemo, useState } from "react";
import {
  applyBuildingGeometry,
  buildingGeometry,
  buildingProgramUse,
  buildingProgramWarnings,
  buildingSpatialWarnings,
  ILLUSTRATIVE_BUILDING_SOURCE,
  USER_BUILDING_SOURCE,
  studyAreaAnchor,
  transformBuildingGeometry,
  validateBuildingCommand,
  validateBuildingGeometry,
  type Building,
  type BuildingGeometryTransform,
  type BuildingProgram,
  type BuildingTypology,
  type Command,
  type Place,
  type Position,
  type Project,
  type Scenario,
} from "@urban/core";
import {
  adoptBuildingProgram,
  previewBuildingConversion,
  typedBuildingPreset,
} from "@urban/models";
import { commandSchema } from "../../../../packages/core/src/validation";
import type {
  MapBuildingDraft,
  MapBuildingRing,
} from "../components/map/building-drawing";
import { parcelDraftGeometry, parcelDraftRings } from "./parcel-draft";
import {
  activeBuildingPath,
  changeBuildingDraft,
  redoBuildingDraft,
  undoBuildingDraft,
  type BuildingDraft,
  type BuildingDraftValue,
} from "./building-draft";
import { useWorkspace } from "./workspace";
import { withBuildingAttributeEdits } from "./building-attributes";

interface Options {
  place: Place | null;
  project: Project | null;
  scenario: Scenario | undefined;
  editable: boolean;
  onStart: (section: BuildingDraft["section"]) => void;
  onSelect: (id: string | null) => void;
  onToast: (message: string) => void;
}
function comparable(building: Building) {
  const {
    attributeSourceId,
    geometrySourceId,
    programSourceId,
    estimated,
    ...value
  } = building;
  return value;
}
/** Replace coordinates while retaining ring identities for a rigid transform. */
function transformedRings(
  rings: MapBuildingRing[],
  geometry: ReturnType<typeof buildingGeometry>,
): MapBuildingRing[] {
  const parts =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return rings.map((ring) => ({
    ...ring,
    coordinates: parts[ring.partIndex][ring.ringIndex]
      .slice(0, -1)
      .map((p): Position => [...p]),
  }));
}
export function useBuildingEditor({
  place,
  project,
  scenario,
  editable,
  onStart,
  onSelect,
  onToast,
}: Options) {
  const scope =
    project && scenario
      ? `${project.id}:${scenario.id}:${scenario.revision}`
      : "";
  const [state, setState] = useState<BuildingDraft | null>(null);
  const draft = state?.scope === scope && editable ? state : null;
  useEffect(() => {
    if (state && (state.scope !== scope || !editable)) {
      setState(null);
      onToast(
        "Building draft closed because the scenario or editing access changed.",
      );
    }
  }, [state, scope, editable, onToast]);
  const geometryType = draft
    ? buildingGeometry(draft.value.building).type
    : undefined;
  const geometry = useMemo(() => {
    if (!draft) return null;
    const next = parcelDraftGeometry(draft.value.rings, geometryType);
    return validateBuildingGeometry(next).valid ? next : null;
  }, [draft?.value.rings, geometryType]);
  const spatialWarnings = useMemo(() => {
    if (!draft || !geometry || !place || !scenario) return [];
    try {
      return buildingSpatialWarnings(
        applyBuildingGeometry(draft.value.building, geometry),
        place,
        scenario,
      );
    } catch {
      return [
        "Some nearby source geometry could not be checked. Review building overlaps and parcel boundaries before relying on site measures.",
      ];
    }
  }, [
    geometry,
    draft?.value.building.id,
    draft?.value.building.use,
    place,
    scenario,
  ]);
  const preview = useMemo((): {
    building: Building | null;
    command: Command | null;
    error: string | null;
    warnings: string[];
  } => {
    if (!draft || !place || !scenario)
      return { building: null, command: null, error: null, warnings: [] };
    try {
      const nextGeometry = parcelDraftGeometry(
        draft.value.rings,
        buildingGeometry(draft.value.building).type,
      );
      const unchangedCapturedGeometry =
        draft.original &&
        JSON.stringify(nextGeometry) ===
          JSON.stringify(buildingGeometry(draft.original));
      if (!unchangedCapturedGeometry) {
        const check = validateBuildingGeometry(nextGeometry);
        if (!check.valid) throw new Error(check.error!);
      }
      let building = draft.value.building;
      const geometryChanged =
        JSON.stringify(nextGeometry) !==
        JSON.stringify(buildingGeometry(building));
      if (geometryChanged)
        building = applyBuildingGeometry(building, nextGeometry);
      if (
        draft.original &&
        JSON.stringify(comparable(building)) ===
          JSON.stringify(comparable(draft.original))
      )
        throw new Error("Change the building or its program before applying.");
      if (draft.original) {
        const original = draft.original;
        const {
          footprint: oldFootprint,
          geometry: oldGeometry,
          areaSqm: oldArea,
          program: oldProgram,
          ...oldAttributes
        } = comparable(original);
        const {
          footprint: nextFootprint,
          geometry: nextShape,
          areaSqm: nextArea,
          program: nextProgram,
          ...nextAttributes
        } = comparable(building);
        building = {
          ...building,
          ...(JSON.stringify(oldAttributes) !== JSON.stringify(nextAttributes)
            ? {
                attributeSourceId:
                  building.attributeSourceId ?? USER_BUILDING_SOURCE.id,
                estimated: true,
              }
            : { attributeSourceId: original.attributeSourceId }),
          ...(JSON.stringify(oldProgram) !== JSON.stringify(nextProgram)
            ? {
                programSourceId:
                  building.programSourceId ?? USER_BUILDING_SOURCE.id,
                estimated: true,
              }
            : { programSourceId: original.programSourceId }),
        };
      }
      const command: Command = {
        type: "building.upsert",
        building,
        sources: [USER_BUILDING_SOURCE, ILLUSTRATIVE_BUILDING_SOURCE],
      };
      const parsed = commandSchema.safeParse(command);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues[0]?.message ?? "Review the building inputs.",
        );
      validateBuildingCommand(place, scenario, parsed.data);
      return {
        building,
        command: parsed.data,
        error: null,
        warnings: [...buildingProgramWarnings(building), ...spatialWarnings],
      };
    } catch (error) {
      return {
        building: null,
        command: null,
        error: (error as Error).message,
        warnings: [],
      };
    }
  }, [draft?.value, draft?.original, place, scenario, spatialWarnings]);
  function start(
    building: Building,
    section: BuildingDraft["section"] = "program",
    isNew = false,
    draw = false,
  ) {
    if (!editable || !place || !scenario || draft) return;
    const rings = parcelDraftRings(
      draw ? undefined : buildingGeometry(building),
    );
    setState({
      id: crypto.randomUUID(),
      scope,
      original: isNew ? null : structuredClone(building),
      value: { building: structuredClone(building), rings },
      section,
      activeRingId: rings[0]?.id ?? null,
      mode: draw ? "draw" : "reshape",
      selectedVertexIndex: null,
      snapToVertices: true,
      coordinateText: "",
      past: [],
      future: [],
    });
    onStart(section);
  }
  function startNew(
    typology: BuildingTypology,
    position: Position,
    draw = false,
  ) {
    start(
      typedBuildingPreset(typology, position),
      draw ? "footprint" : "program",
      true,
      draw,
    );
  }
  function change(value: BuildingDraftValue) {
    setState((current) =>
      current?.scope === scope ? changeBuildingDraft(current, value) : current,
    );
  }
  function patch(
    patch: Partial<
      Pick<
        BuildingDraft,
        | "activeRingId"
        | "mode"
        | "selectedVertexIndex"
        | "snapToVertices"
        | "coordinateText"
      >
    >,
  ) {
    setState((current) =>
      current?.scope === scope ? { ...current, ...patch } : current,
    );
  }
  function section(section: BuildingDraft["section"]) {
    if (!draft) return;
    if (draft.coordinateText.trim()) {
      onToast("Use or discard the coordinate text before changing sections.");
      return;
    }
    setState((current) => (current ? { ...current, section } : current));
    onStart(section);
  }
  function updateBuilding(patch: Partial<Building>) {
    if (!draft) return;
    change({
      ...draft.value,
      building: withBuildingAttributeEdits(draft.value.building, patch),
    });
  }
  function updateProgram(program: BuildingProgram) {
    if (!draft) return;
    const units = program.components.reduce(
      (sum, component) => sum + component.units,
      0,
    );
    const jobs = program.components.reduce(
      (sum, component) => sum + component.jobs,
      0,
    );
    const use = buildingProgramUse(program, draft.value.building.use);
    updateBuilding({
      program,
      units,
      jobs,
      use,
      programSourceId: USER_BUILDING_SOURCE.id,
      estimated: true,
    });
  }
  function adoptProgram() {
    if (!draft) return;
    try {
      change({
        ...draft.value,
        building: adoptBuildingProgram(
          preview.building ?? draft.value.building,
          scenario?.assumptions,
        ),
      });
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  function conversion(
    typology: BuildingTypology,
    mode: "preserve-program" | "typed-defaults",
  ) {
    if (!draft) return null;
    const building =
      geometry &&
      JSON.stringify(geometry) !==
        JSON.stringify(buildingGeometry(draft.value.building))
        ? applyBuildingGeometry(draft.value.building, geometry)
        : draft.value.building;
    return previewBuildingConversion(
      building,
      typology,
      mode,
      scenario?.assumptions,
    );
  }
  function applyConversion(
    typology: BuildingTypology,
    mode: "preserve-program" | "typed-defaults",
  ) {
    if (!draft || draft.coordinateText.trim()) return;
    try {
      const converted = conversion(typology, mode);
      if (converted) change({ ...draft.value, building: converted.building });
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  function pathChange(
    coordinates: Position[],
    detail: { ringId: string; kind: "append" | "move"; vertexIndex: number },
  ) {
    setState((current) => {
      if (!current || current.scope !== scope) return current;
      return {
        ...changeBuildingDraft(current, {
          ...current.value,
          rings: current.value.rings.map((ring) =>
            ring.id === detail.ringId ? { ...ring, coordinates } : ring,
          ),
        }),
        selectedVertexIndex: detail.vertexIndex,
      };
    });
  }
  function vertexSelect(ringId: string, index: number) {
    if (!draft || draft.coordinateText.trim()) return;
    patch({
      activeRingId: ringId,
      selectedVertexIndex: index,
      mode: "reshape",
    });
  }
  function removeVertex(index: number) {
    if (!draft || !draft.activeRingId || draft.coordinateText.trim()) return;
    pathChange(
      activeBuildingPath(draft).filter((_, i) => i !== index),
      {
        ringId: draft.activeRingId,
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
    const selected = draft.value.rings.find(
      (ring) => ring.id === draft.activeRingId,
    );
    if (!selected) return;
    const rings =
      selected.ringIndex === 0
        ? draft.value.rings
            .filter((ring) => ring.partIndex !== selected.partIndex)
            .map((ring) => ({
              ...ring,
              partIndex:
                ring.partIndex > selected.partIndex
                  ? ring.partIndex - 1
                  : ring.partIndex,
            }))
        : draft.value.rings
            .filter((ring) => ring.id !== selected.id)
            .map((ring) => ({
              ...ring,
              ringIndex:
                ring.partIndex === selected.partIndex &&
                ring.ringIndex > selected.ringIndex
                  ? ring.ringIndex - 1
                  : ring.ringIndex,
            }));
    change({
      ...draft.value,
      rings: rings.length ? rings : parcelDraftRings(),
    });
    patch({ selectedVertexIndex: null, mode: "draw" });
  }
  function transform(transform: BuildingGeometryTransform) {
    if (!draft || draft.coordinateText.trim()) return;
    try {
      if (!geometry)
        throw new Error(
          "Finish a valid footprint before moving or rotating the building.",
        );
      const transformed = transformBuildingGeometry(geometry, transform);
      change({
        ...draft.value,
        rings: transformedRings(draft.value.rings, transformed),
      });
    } catch (error) {
      onToast((error as Error).message);
    }
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
        "The building was not applied. Wait for the current project operation to finish.",
      );
  }
  function apply() {
    if (!draft || !editable) return;
    if (draft.coordinateText.trim()) {
      onToast("Use or discard the coordinate text before applying.");
      return;
    }
    if (!preview.command || !preview.building) {
      onToast(preview.error ?? "Finish the building draft.");
      return;
    }
    try {
      commit(
        preview.command,
        `${draft.original ? "Modify" : "Add"} ${preview.building.name}`,
      );
      setState(null);
      onSelect(preview.building.id);
      onToast(
        `${preview.building.name} applied. Undo restores the previous building and program.`,
      );
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  function discard() {
    if (!draft) return;
    setState(null);
    onSelect(draft.original?.id ?? null);
    onToast("Building draft discarded. The saved scenario is unchanged.");
  }
  function remove(building: Building) {
    if (!editable || draft) return;
    try {
      commit(
        { type: "building.remove", id: building.id },
        `Remove ${building.name}`,
      );
      onSelect(null);
      onToast(
        "Building removed from this alternative. Parcel boundaries remain available; Undo restores the building.",
      );
    } catch (error) {
      onToast((error as Error).message);
    }
  }
  const mapDraft: MapBuildingDraft | null = draft
    ? {
        id: draft.id,
        buildingId: draft.value.building.id,
        rings: draft.value.rings,
        activeRingId: draft.activeRingId,
        mode: draft.mode,
        selectedVertexIndex: draft.selectedVertexIndex,
        ...(geometry
          ? { previewGeometry: geometry, pivot: studyAreaAnchor(geometry) }
          : {}),
        height:
          draft.value.building.height === null
            ? null
            : Number.isFinite(draft.value.building.height)
              ? Math.max(0, draft.value.building.height)
              : (draft.original?.height ?? 0),
        snapToVertices: draft.snapToVertices,
      }
    : null;
  return {
    draft,
    geometry,
    preview,
    mapDraft,
    start,
    startNew,
    change,
    patch,
    section,
    updateBuilding,
    updateProgram,
    adoptProgram,
    conversion,
    applyConversion,
    pathChange,
    vertexSelect,
    removeVertex,
    addRing,
    removeRing,
    transform,
    apply,
    discard,
    remove,
    undo: () =>
      setState((current) => (current ? undoBuildingDraft(current) : current)),
    redo: () =>
      setState((current) => (current ? redoBuildingDraft(current) : current)),
  };
}
export type BuildingEditorController = ReturnType<typeof useBuildingEditor>;
