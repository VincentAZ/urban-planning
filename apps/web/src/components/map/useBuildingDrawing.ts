import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as maplibregl from "maplibre-gl";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import {
  MAX_AUTHORED_BUILDING_RING_POINTS,
  validateBuildingGeometry,
  type Building,
  type Place,
  type Position,
  type StudyAreaGeometry,
} from "@urban/core";
import { closedParcelRing, previewParcelParts } from "./parcel-drawing";
import {
  activeBuildingRing,
  buildingDraftCandidate,
  buildingDraftCommandForKey,
  buildingDraftPivot,
  buildingRotationHandle,
  buildingTransformAt,
  canDisplayBuildingDraft,
  canEditBuildingDraft,
  changeBuildingDraftPoint,
  createBuildingSnapIndex,
  draftBuildingGeometry,
  nearestBuildingVertex,
  safeDraftHeight,
  transformedBuildingDraft,
  type BuildingDrawingContext,
  type BuildingSnapIndex,
  type MapBuildingDraft,
  type MapBuildingTransform,
} from "./building-drawing";

interface Options extends BuildingDrawingContext {
  ready: boolean;
  mapRef: MutableRefObject<maplibregl.Map | null>;
  place: Place;
  buildings: readonly Building[];
  reducedGraphics: boolean;
  renderLayers: (layers: Layer[]) => void;
}
type Candidate = ReturnType<typeof buildingDraftCandidate>;
type Drag = {
  draft: MapBuildingDraft;
  ringId: string | null;
  index: number | null;
  candidate?: Candidate;
};
type Handle = { marker: maplibregl.Marker; button: HTMLButtonElement };

/** Pointer previews are local. Only completed gestures enter the root's draft history. */
export function useBuildingDrawing(options: Options): string {
  const current = useRef(options);
  current.current = options;
  const syncRef = useRef<(() => void) | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const map = options.mapRef.current;
    if (!options.ready || !map) return;
    const canvas = map.getCanvas(),
      originalLabel = canvas.getAttribute("aria-label");
    let handles: Handle[] = [],
      sessionKey = "",
      cursor: Candidate | undefined,
      drag: Drag | undefined;
    let frame = 0,
      disposed = false,
      ignoreClickUntil = 0;
    let restoreDoubleClick: boolean | undefined;
    let snapIndex: BuildingSnapIndex = new Map(),
      snapDirty = true;
    let snapBuildings: readonly Building[] | undefined,
      excludedId: string | undefined;
    const validDrag = () => {
      const draft = current.current.buildingDraft;
      return !!(
        drag &&
        draft &&
        draft.id === drag.draft.id &&
        draft.rings === drag.draft.rings &&
        draft.mode === drag.draft.mode
      );
    };
    const snapAt = (position: Position): Candidate => {
      const value = current.current,
        draft = value.buildingDraft;
      if (!draft?.snapToVertices || draft.mode === "rotate" || map.isMoving())
        return buildingDraftCandidate(position, value.place);
      if (snapDirty) {
        snapIndex = createBuildingSnapIndex(
          value.buildings,
          (point) => map.project(point),
          draft.buildingId,
        );
        snapDirty = false;
      }
      return buildingDraftCandidate(
        position,
        value.place,
        nearestBuildingVertex(snapIndex, position, map.project(position)),
      );
    };
    const describe = (candidate?: Candidate) =>
      setNotice(
        !candidate
          ? ""
          : !candidate.inside
            ? "Choose a point inside the study area, outside excluded areas."
            : candidate.snap
              ? `Aligned to ${candidate.snap.name || "building"}. Alignment is not a surveyed position.`
              : "",
      );
    const previewAt = (draft: MapBuildingDraft, candidate?: Candidate) => {
      let geometry: StudyAreaGeometry | null = draftBuildingGeometry(draft);
      let rings = draft.rings;
      let transform: MapBuildingTransform | null = null;
      if (candidate) {
        if (draft.mode === "move" || draft.mode === "rotate") {
          transform = buildingTransformAt(draft, candidate.position);
          if (transform) geometry = transformedBuildingDraft(draft, transform);
          if (geometry) {
            const parts =
              geometry.type === "Polygon"
                ? [geometry.coordinates]
                : geometry.coordinates;
            rings = draft.rings.map((ring) => ({
              ...ring,
              coordinates: parts[ring.partIndex][ring.ringIndex].slice(0, -1),
            }));
          }
        } else {
          const changed = changeBuildingDraftPoint(
            draft,
            candidate.position,
            MAX_AUTHORED_BUILDING_RING_POINTS,
            validDrag() && drag?.index !== null ? drag?.index : undefined,
          );
          if (changed) {
            rings = draft.rings.map((ring) =>
              ring.id === changed.detail.ringId
                ? { ...ring, coordinates: changed.coordinates }
                : ring,
            );
            geometry = draftBuildingGeometry({ ...draft, rings });
          }
        }
      }
      return { geometry, rings, transform };
    };
    const draw = () => {
      frame = 0;
      const value = current.current,
        draft = value.buildingDraft;
      if (disposed || !draft || !canDisplayBuildingDraft(value)) {
        value.renderLayers([]);
        return;
      }
      const editing = canEditBuildingDraft(value),
        candidate = editing
          ? validDrag()
            ? drag?.candidate
            : cursor
          : undefined;
      const { geometry, rings } = previewAt(draft, candidate);
      const topologyValid =
        !!geometry && validateBuildingGeometry(geometry).valid;
      const valid =
        topologyValid && validateBuildingGeometry(geometry!, value.place).valid;
      // Keep an out-of-area draft visible so it can be moved back. Only invalid
      // topology suppresses the fill; the root still blocks invalid Apply.
      const parts = topologyValid ? previewParcelParts([geometry!]) : [];
      const outlines = rings
        .filter((ring) => ring.coordinates.length > 1)
        .map((ring) => ({ ...ring, path: closedParcelRing(ring.coordinates) }));
      const depth = {
        depthCompare: "always" as const,
        depthWriteEnabled: false,
      };
      const pivot = buildingDraftPivot(draft),
        rotationPoint = buildingRotationHandle(draft);
      const guide =
        draft.mode === "rotate" && pivot && rotationPoint
          ? [[pivot, candidate?.position ?? rotationPoint]]
          : [];
      value.renderLayers([
        new PolygonLayer<(typeof parts)[number]>({
          id: "building-draft-massing",
          data: parts,
          getPolygon: (part) =>
            part.rings.map((ring) =>
              ring.map(([x, y]) => [x, y, 0.15] as [number, number, number]),
            ),
          extruded: value.view !== "2d" && !value.reducedGraphics,
          getElevation: safeDraftHeight(draft.height),
          getFillColor: valid ? [66, 144, 120, 210] : [184, 73, 58, 160],
          getLineColor: [19, 106, 84, 255],
          stroked: true,
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: false,
          parameters: { depthCompare: "less-equal", depthWriteEnabled: false },
        }),
        new PathLayer<(typeof outlines)[number]>({
          id: "building-draft-rings",
          data: editing ? outlines : [],
          getPath: (ring) => ring.path,
          getColor: (ring) =>
            !valid && geometry
              ? [184, 73, 58, 255]
              : ring.id === draft.activeRingId
                ? [22, 109, 91, 255]
                : ring.ringIndex > 0
                  ? [174, 118, 40, 240]
                  : [76, 128, 120, 210],
          getWidth: (ring) => (ring.id === draft.activeRingId ? 4 : 2),
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          parameters: depth,
        }),
        new PathLayer<Position[]>({
          id: "building-rotation-guide",
          data: editing ? guide : [],
          getPath: (path) => path,
          getColor: [192, 137, 43, 220],
          getWidth: 2,
          widthUnits: "pixels",
          pickable: false,
          parameters: depth,
        }),
        new ScatterplotLayer<Candidate>({
          id: "building-draft-cursor",
          data: candidate ? [candidate] : [],
          getPosition: (point) => point.position,
          getRadius: candidate?.snap ? 9 : 6,
          radiusUnits: "pixels",
          getFillColor: candidate?.inside
            ? [246, 209, 119, 220]
            : [231, 154, 135, 220],
          stroked: true,
          getLineColor: [75, 70, 46, 255],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: false,
          parameters: depth,
        }),
      ]);
    };
    const requestDraw = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(draw);
    };
    const apply = (candidate: Candidate, index?: number) => {
      const value = current.current,
        draft = value.buildingDraft;
      if (!draft || !canEditBuildingDraft(value)) return;
      if (draft.mode === "move" || draft.mode === "rotate") {
        const transform = buildingTransformAt(draft, candidate.position);
        if (transform && transformedBuildingDraft(draft, transform))
          value.onBuildingDraftTransform?.(transform);
        else
          setNotice(
            "This transform cannot be represented. Review the exact position or rotation in the editor.",
          );
      } else {
        if (!candidate.inside) {
          describe(candidate);
          return;
        }
        const changed = changeBuildingDraftPoint(
          draft,
          candidate.position,
          MAX_AUTHORED_BUILDING_RING_POINTS,
          index,
        );
        if (!changed) return;
        const snap = candidate.snap;
        value.onBuildingDraftPathChange?.(changed.coordinates, {
          ...changed.detail,
          ...(snap
            ? {
                snap: {
                  buildingId: snap.buildingId,
                  partIndex: snap.partIndex,
                  ringIndex: snap.ringIndex,
                  vertexIndex: snap.vertexIndex,
                },
              }
            : {}),
        });
        describe(candidate);
      }
    };
    const removeHandles = () => {
      handles.forEach((entry) => entry.marker.remove());
      handles = [];
    };
    const sync = () => {
      const value = current.current,
        draft = value.buildingDraft,
        enabled = canEditBuildingDraft(value);
      const key = draft
        ? `${draft.id}:${draft.mode}:${draft.activeRingId ?? ""}`
        : "";
      if (key !== sessionKey) {
        sessionKey = key;
        drag = undefined;
        cursor = undefined;
        removeHandles();
        setNotice("");
      }
      if (
        snapBuildings !== value.buildings ||
        excludedId !== draft?.buildingId
      ) {
        snapBuildings = value.buildings;
        excludedId = draft?.buildingId;
        snapDirty = true;
      }
      if (enabled && restoreDoubleClick === undefined) {
        restoreDoubleClick = map.doubleClickZoom.isEnabled();
        map.doubleClickZoom.disable();
      } else if (!enabled && restoreDoubleClick !== undefined) {
        if (restoreDoubleClick) map.doubleClickZoom.enable();
        restoreDoubleClick = undefined;
      }
      canvas.setAttribute(
        "aria-label",
        enabled
          ? "Building editing map. Enter applies, Escape discards, Delete removes the selected vertex. Coordinate and transform controls are in the building editor."
          : "Map showing an unapplied building preview. Use the building editor to apply or discard.",
      );
      if (!draft || !enabled) {
        drag = undefined;
        cursor = undefined;
        removeHandles();
        requestDraw();
        return;
      }
      if (!validDrag()) drag = undefined;
      const active = activeBuildingRing(draft),
        transformMode = draft.mode === "move" || draft.mode === "rotate";
      const anchor =
        draft.mode === "rotate"
          ? buildingRotationHandle(draft)
          : buildingDraftPivot(draft);
      const points = transformMode
        ? anchor
          ? [anchor]
          : []
        : (active?.coordinates ?? []);
      while (handles.length > points.length) handles.pop()!.marker.remove();
      points.forEach((point, index) => {
        let entry = handles[index];
        if (!entry) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "city-building-vertex";
          button.textContent = transformMode
            ? draft.mode === "move"
              ? "↔"
              : "↻"
            : String(index + 1);
          button.setAttribute(
            "aria-label",
            transformMode
              ? draft.mode === "move"
                ? "Move building handle"
                : "Rotate building handle"
              : `Building vertex ${index + 1}`,
          );
          button.title = transformMode
            ? "Drag this handle, or use the exact transform controls in the building editor."
            : "Drag to move this vertex; exact coordinates are in the building editor.";
          const marker = new maplibregl.Marker({
            element: button,
            anchor: "center",
            draggable: true,
            pitchAlignment: "viewport",
            rotationAlignment: "viewport",
          })
            .setLngLat(point)
            .addTo(map);
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (performance.now() < ignoreClickUntil) return;
            const latest = current.current;
            const ring = latest.buildingDraft
              ? activeBuildingRing(latest.buildingDraft)
              : null;
            if (!transformMode && ring && canEditBuildingDraft(latest))
              latest.onBuildingVertexSelect?.(ring.id, index);
          });
          button.addEventListener("dblclick", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          button.addEventListener("keydown", (event) =>
            event.stopPropagation(),
          );
          button.addEventListener("keyup", (event) => event.stopPropagation());
          marker.on("dragstart", () => {
            const latest = current.current,
              next = latest.buildingDraft;
            if (!next || !canEditBuildingDraft(latest)) return;
            drag = {
              draft: next,
              ringId: transformMode ? null : next.activeRingId,
              index: transformMode ? null : index,
            };
            cursor = undefined;
            // Selection may switch the controlled editor from draw to reshape.
            // Keep the original mode and ring stable until the gesture commits.
          });
          marker.on("drag", () => {
            if (!validDrag()) return;
            const p = marker.getLngLat();
            drag!.candidate = snapAt([p.lng, p.lat]);
            describe(drag!.candidate);
            requestDraw();
          });
          marker.on("dragend", () => {
            ignoreClickUntil = performance.now() + 150;
            const p = marker.getLngLat(),
              candidate = snapAt([p.lng, p.lat]),
              allowed = validDrag() && canEditBuildingDraft(current.current),
              ringId = drag?.ringId;
            drag = undefined;
            if (allowed) {
              apply(candidate, transformMode ? undefined : index);
              if (!transformMode && ringId)
                current.current.onBuildingVertexSelect?.(ringId, index);
            }
            sync();
          });
          entry = { marker, button };
          handles.push(entry);
        }
        if (!drag || (!transformMode && drag.index !== index))
          entry.marker.setLngLat(point);
        entry.button.classList.toggle(
          "is-selected",
          !transformMode && draft.selectedVertexIndex === index,
        );
        if (!transformMode)
          entry.button.setAttribute(
            "aria-pressed",
            String(draft.selectedVertexIndex === index),
          );
      });
      requestDraw();
    };
    syncRef.current = sync;
    const click = (event: maplibregl.MapMouseEvent) => {
      if (
        !canEditBuildingDraft(current.current) ||
        performance.now() < ignoreClickUntil ||
        (event.originalEvent.target instanceof Element &&
          event.originalEvent.target.closest(".city-building-vertex"))
      )
        return;
      canvas.focus({ preventScroll: true });
      apply(snapAt([event.lngLat.lng, event.lngLat.lat]));
      cursor = undefined;
      requestDraw();
    };
    const move = (event: maplibregl.MapMouseEvent) => {
      if (!canEditBuildingDraft(current.current) || drag || map.isMoving())
        return;
      cursor = snapAt([event.lngLat.lng, event.lngLat.lat]);
      describe(cursor);
      requestDraw();
    };
    const leave = () => {
      cursor = undefined;
      if (!drag) {
        setNotice("");
        requestDraw();
      }
    };
    const cameraMove = () => {
      snapDirty = true;
      cursor = undefined;
      requestDraw();
    };
    const keydown = (event: KeyboardEvent) => {
      const value = current.current,
        draft = value.buildingDraft;
      if (!canEditBuildingDraft(value) || !draft) return;
      const command = buildingDraftCommandForKey(
        event,
        document.activeElement === canvas,
      );
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        command !== "delete-vertex" ||
        (["draw", "reshape"].includes(draft.mode) &&
          draft.selectedVertexIndex !== null)
      )
        value.onBuildingDraftCommand?.(command);
    };
    map.on("click", click);
    map.on("mousemove", move);
    map.on("mouseout", leave);
    map.on("movestart", cameraMove);
    map.on("moveend", cameraMove);
    map.on("resize", cameraMove);
    canvas.addEventListener("keydown", keydown, true);
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      syncRef.current = null;
      removeHandles();
      map.off("click", click);
      map.off("mousemove", move);
      map.off("mouseout", leave);
      map.off("movestart", cameraMove);
      map.off("moveend", cameraMove);
      map.off("resize", cameraMove);
      canvas.removeEventListener("keydown", keydown, true);
      if (restoreDoubleClick) map.doubleClickZoom.enable();
      if (originalLabel !== null)
        canvas.setAttribute("aria-label", originalLabel);
      else canvas.removeAttribute("aria-label");
      current.current.renderLayers([]);
    };
  }, [options.ready, options.mapRef, options.place.id]);
  useEffect(() => {
    syncRef.current?.();
  }, [
    options.buildingDraft,
    options.buildingEditingEnabled,
    options.view,
    options.roadDraft,
    options.parcelDraft,
    options.revealScenario,
    options.placingBuilding,
    options.selectingCommentLocation,
    options.buildings,
    options.place,
    options.reducedGraphics,
  ]);
  return notice;
}
