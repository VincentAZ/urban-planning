import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Layer } from "@deck.gl/core";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { type Place, type Position, type StudyAreaGeometry } from "@urban/core";
import { closedParcelRing } from "./parcel-drawing";
import {
  appendNeighborhoodStrokePoint,
  canDisplayNeighborhoodDraft,
  canEditNeighborhoodDraft,
  changeNeighborhoodDraftPoint,
  neighborhoodDraftCommandForKey,
  neighborhoodStrokeCurrent,
  type MapNeighborhoodStroke,
  type NeighborhoodDrawingContext,
} from "./neighborhood-drawing";
interface Options extends NeighborhoodDrawingContext {
  mapRef: MutableRefObject<maplibregl.Map | null>;
  ready: boolean;
  place: Place;
  renderLayers: (layers: Layer[]) => void;
}
const parts = (geometry?: StudyAreaGeometry | null) =>
  !geometry
    ? []
    : geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates;
export function useNeighborhoodDrawing(options: Options) {
  const current = useRef(options);
  current.current = options;
  const syncRef = useRef<(() => void) | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const map = options.mapRef.current;
    if (!options.ready || !map) return;
    const canvas = map.getCanvas(),
      originalLabel = canvas.getAttribute("aria-label");
    let disposed = false,
      frame = 0,
      cursor: Position | undefined,
      stroke: (MapNeighborhoodStroke & { pointerId: number }) | undefined;
    let markers: { marker: maplibregl.Marker; button: HTMLButtonElement }[] =
      [];
    let drag:
      | {
          draftId: string;
          revision: number;
          ringId: string;
          index: number;
          candidate?: Position;
        }
      | undefined;
    let ignoreClickUntil = 0,
      markerKey = "",
      sessionKey = "";
    let restore: { pan: boolean; touch: boolean } | undefined;
    let restoreDoubleClick: boolean | undefined;
    const originalTouchAction = canvas.style.touchAction;
    const validDrag = () => {
      const value = current.current,
        draft = value.neighborhoodDraft;
      return (
        !!drag &&
        canEditNeighborhoodDraft(value) &&
        draft?.id === drag.draftId &&
        draft.revision === drag.revision &&
        draft.activeRingId === drag.ringId &&
        ["draw", "reshape"].includes(draft.mode)
      );
    };
    const draw = () => {
      frame = 0;
      const value = current.current,
        draft = value.neighborhoodDraft;
      if (disposed || !draft || !canDisplayNeighborhoodDraft(value)) {
        value.renderLayers([]);
        return;
      }
      const parameters = {
        depthCompare: "always" as const,
        depthWriteEnabled: false,
      };
      const active = draft.rings.find((ring) => ring.id === draft.activeRingId);
      const ringPaths = draft.rings.map((ring) => {
        const coords = ring.coordinates.map((point) => [...point] as Position);
        if (drag?.ringId === ring.id && validDrag() && drag.candidate)
          coords[drag.index] = drag.candidate;
        return {
          id: ring.id,
          coordinates: coords.length >= 3 ? closedParcelRing(coords) : coords,
        };
      });
      const drawing =
        canEditNeighborhoodDraft(value) &&
        draft.mode === "draw" &&
        !drag &&
        cursor &&
        active?.coordinates.length;
      const preview = drawing ? [active!.coordinates.at(-1)!, cursor!] : [];
      const radius = stroke?.radiusMeters ?? draft.brushRadiusMeters;
      const brush = ["paint", "erase"].includes(draft.mode);
      const safeRadius = Number.isFinite(radius)
        ? Math.max(5, Math.min(1000, radius))
        : 5;
      value.renderLayers([
        new PolygonLayer<Position[][]>({
          id: "neighborhood-draft-fill",
          data: parts(draft.previewGeometry),
          getPolygon: (rings) => rings,
          getFillColor: [50, 143, 154, 55],
          getLineColor: [27, 103, 117, 255],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          stroked: true,
          pickable: false,
          parameters,
        }),
        new PolygonLayer<Position[][]>({
          id: "neighborhood-draft-excluded",
          data: parts(draft.excludedGeometry),
          getPolygon: (rings) => rings,
          getFillColor: [191, 81, 59, 70],
          getLineColor: [160, 49, 34, 255],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          stroked: true,
          pickable: false,
          parameters,
        }),
        new PathLayer<(typeof ringPaths)[number]>({
          id: "neighborhood-draft-rings",
          data: ringPaths,
          getPath: (ring) => ring.coordinates,
          getColor: (ring) =>
            ring.id === draft.activeRingId
              ? [21, 107, 123, 255]
              : [77, 129, 138, 180],
          getWidth: 3,
          widthUnits: "pixels",
          pickable: false,
          parameters,
        }),
        new PathLayer<Position[]>({
          id: "neighborhood-draft-point-preview",
          data: preview.length ? [preview] : [],
          getPath: (path) => path,
          getColor: [36, 129, 144, 220],
          getWidth: 2,
          widthUnits: "pixels",
          pickable: false,
          parameters,
        }),
        new PathLayer<Position[]>({
          id: "neighborhood-brush-stroke",
          data: stroke && stroke.path.length > 1 ? [stroke.path] : [],
          getPath: (path) => path,
          getColor:
            draft.mode === "erase" ? [196, 91, 63, 110] : [39, 153, 165, 110],
          getWidth: safeRadius * 2,
          widthUnits: "meters",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          parameters,
        }),
        new ScatterplotLayer<Position>({
          id: "neighborhood-brush-cursor",
          data:
            cursor && brush && canEditNeighborhoodDraft(value) ? [cursor] : [],
          getPosition: (p) => p,
          getRadius: safeRadius,
          radiusUnits: "meters",
          getFillColor:
            draft.mode === "erase" ? [196, 91, 63, 70] : [39, 153, 165, 70],
          stroked: true,
          getLineColor:
            draft.mode === "erase" ? [160, 49, 34, 255] : [21, 107, 123, 255],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: false,
          parameters,
        }),
      ]);
    };
    const requestDraw = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(draw);
    };
    const removeMarkers = () => {
      markers.forEach((entry) => entry.marker.remove());
      markers = [];
    };
    const releaseStroke = () => {
      const pointerId = stroke?.pointerId;
      stroke = undefined;
      if (pointerId !== undefined && canvas.hasPointerCapture(pointerId))
        canvas.releasePointerCapture(pointerId);
    };
    const cancelStroke = (
      message = "Stroke cancelled. Your previous boundary is unchanged.",
    ) => {
      if (stroke) {
        releaseStroke();
        cursor = undefined;
        setNotice(message);
        requestDraw();
      }
    };
    const applyPoint = (position: Position, index?: number) => {
      const value = current.current,
        draft = value.neighborhoodDraft;
      if (!draft || !canEditNeighborhoodDraft(value)) return;
      const changed = changeNeighborhoodDraftPoint(draft, position, index);
      if (changed)
        value.onNeighborhoodDraftPathChange?.(
          changed.coordinates,
          changed.detail,
        );
      else
        setNotice(
          "Choose a valid point, or select a point to reshape. Boundaries support up to 500 points per ring.",
        );
    };
    const sync = () => {
      const value = current.current,
        draft = value.neighborhoodDraft,
        enabled = canEditNeighborhoodDraft(value);
      const nextSession = draft
        ? `${draft.id}:${draft.revision}:${draft.mode}`
        : "";
      if (sessionKey !== nextSession) {
        cancelStroke();
        cursor = undefined;
        drag = undefined;
        sessionKey = nextSession;
        setNotice("");
      }
      if (!enabled) {
        cancelStroke();
        drag = undefined;
        cursor = undefined;
      }
      const brush = enabled && ["paint", "erase"].includes(draft!.mode);
      if (brush && !restore) {
        restore = {
          pan: map.dragPan.isEnabled(),
          touch: map.touchZoomRotate.isEnabled(),
        };
        map.dragPan.disable();
        map.touchZoomRotate.disable();
        canvas.style.touchAction = "none";
      } else if (!brush && restore) {
        if (restore.pan) map.dragPan.enable();
        if (restore.touch) map.touchZoomRotate.enable();
        canvas.style.touchAction = originalTouchAction;
        restore = undefined;
      }
      const drawing = enabled && draft!.mode !== "pan";
      if (drawing && restoreDoubleClick === undefined) {
        restoreDoubleClick = map.doubleClickZoom.isEnabled();
        map.doubleClickZoom.disable();
      } else if (!drawing && restoreDoubleClick !== undefined) {
        if (restoreDoubleClick) map.doubleClickZoom.enable();
        restoreDoubleClick = undefined;
      }
      canvas.setAttribute(
        "aria-label",
        enabled
          ? "Neighborhood editing map. Paint or erase with a pointer, or use the coordinate controls. Enter finishes; Escape cancels the stroke or discards the draft."
          : "Map. Neighborhood editing is paused.",
      );
      const active = draft?.rings.find(
        (ring) => ring.id === draft.activeRingId,
      );
      const vertexMode = enabled && ["draw", "reshape"].includes(draft!.mode);
      const key = vertexMode && active ? `${draft!.id}:${active.id}` : "";
      if (key !== markerKey) {
        removeMarkers();
        markerKey = key;
      }
      const count = vertexMode ? (active?.coordinates.length ?? 0) : 0;
      while (markers.length > count) markers.pop()!.marker.remove();
      for (let index = 0; index < count; index++) {
        let entry = markers[index];
        if (!entry) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "city-neighborhood-vertex";
          button.textContent = String(index + 1);
          button.setAttribute("aria-label", `Neighborhood vertex ${index + 1}`);
          const marker = new maplibregl.Marker({
            element: button,
            anchor: "center",
            draggable: true,
            pitchAlignment: "viewport",
            rotationAlignment: "viewport",
          })
            .setLngLat(active!.coordinates[index])
            .addTo(map);
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const value = current.current,
              draft = value.neighborhoodDraft;
            if (canEditNeighborhoodDraft(value) && draft?.activeRingId)
              value.onNeighborhoodVertexSelect?.(draft.activeRingId, index);
          });
          for (const name of ["dblclick", "keydown", "keyup"])
            button.addEventListener(name, (event) => event.stopPropagation());
          marker.on("dragstart", () => {
            const value = current.current,
              draft = value.neighborhoodDraft;
            if (!draft?.activeRingId || !canEditNeighborhoodDraft(value))
              return;
            drag = {
              draftId: draft.id,
              revision: draft.revision,
              ringId: draft.activeRingId,
              index,
            };
            cursor = undefined;
          });
          marker.on("drag", () => {
            if (!validDrag()) return;
            const p = marker.getLngLat();
            drag!.candidate = [p.lng, p.lat];
            requestDraw();
          });
          marker.on("dragend", () => {
            const apply = validDrag(),
              p = marker.getLngLat();
            drag = undefined;
            ignoreClickUntil = performance.now() + 150;
            if (apply) applyPoint([p.lng, p.lat], index);
            const draft = current.current.neighborhoodDraft,
              point = draft?.rings.find(
                (ring) => ring.id === draft.activeRingId,
              )?.coordinates[index];
            if (point) marker.setLngLat(point);
            requestDraw();
          });
          entry = { marker, button };
          markers.push(entry);
        }
        if (drag?.index !== index)
          entry.marker.setLngLat(active!.coordinates[index]);
        entry.button.classList.toggle(
          "is-selected",
          draft!.selectedVertexIndex === index,
        );
        entry.button.setAttribute(
          "aria-pressed",
          String(draft!.selectedVertexIndex === index),
        );
        entry.button.title = active!.coordinates[index]
          .map((n) => n.toFixed(6))
          .join(", ");
      }
      requestDraw();
    };
    syncRef.current = sync;
    const position = (event: PointerEvent): Position => {
      const rect = canvas.getBoundingClientRect(),
        p = map.unproject([
          event.clientX - rect.left,
          event.clientY - rect.top,
        ]);
      return [p.lng, p.lat];
    };
    let graphicsAvailable = true;
    const down = (event: PointerEvent) => {
      const value = current.current,
        draft = value.neighborhoodDraft;
      if (
        !graphicsAvailable ||
        !map.isStyleLoaded() ||
        !canEditNeighborhoodDraft(value) ||
        !draft ||
        !["paint", "erase"].includes(draft.mode) ||
        event.button !== 0 ||
        !event.isPrimary
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      canvas.focus({ preventScroll: true });
      if (stroke) return;
      if (
        !Number.isFinite(draft.brushRadiusMeters) ||
        draft.brushRadiusMeters < 5 ||
        draft.brushRadiusMeters > 1000
      ) {
        setNotice("Choose a brush radius from 5 to 1,000 meters.");
        return;
      }
      let path: Position[];
      try {
        path = appendNeighborhoodStrokePoint(
          [],
          position(event),
          draft.brushRadiusMeters,
        );
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "Keep the brush within the map.",
        );
        return;
      }
      stroke = {
        draftId: draft.id,
        draftRevision: draft.revision,
        operation: draft.mode === "erase" ? "erase" : "add",
        radiusMeters: draft.brushRadiusMeters,
        path,
        pointerId: event.pointerId,
      };
      cursor = path[0];
      canvas.setPointerCapture(event.pointerId);
      setNotice(
        "Stroke preview. Study boundaries and other neighborhoods are excluded when released.",
      );
      requestDraw();
    };
    const move = (event: PointerEvent) => {
      if (!canEditNeighborhoodDraft(current.current)) return;
      if (stroke && event.pointerId !== stroke.pointerId) return;
      cursor = position(event);
      if (stroke) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!neighborhoodStrokeCurrent(stroke, current.current)) {
          cancelStroke();
          return;
        }
        try {
          stroke.path = appendNeighborhoodStrokePoint(
            stroke.path,
            cursor,
            stroke.radiusMeters,
          );
        } catch (error) {
          cancelStroke(error instanceof Error ? error.message : undefined);
        }
      }
      requestDraw();
    };
    const up = (event: PointerEvent) => {
      if (!stroke || event.pointerId !== stroke.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ignoreClickUntil = performance.now() + 200;
      if (!neighborhoodStrokeCurrent(stroke, current.current)) {
        cancelStroke();
        return;
      }
      try {
        const path = appendNeighborhoodStrokePoint(
          stroke.path,
          position(event),
          stroke.radiusMeters,
          true,
        );
        const completed: MapNeighborhoodStroke = {
          draftId: stroke.draftId,
          draftRevision: stroke.draftRevision,
          operation: stroke.operation,
          path,
          radiusMeters: stroke.radiusMeters,
        };
        releaseStroke();
        current.current.onNeighborhoodBrushStroke?.(completed);
        setNotice(
          "Stroke completed. Review the boundary and excluded areas before applying.",
        );
        requestDraw();
      } catch (error) {
        cancelStroke(error instanceof Error ? error.message : undefined);
      }
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerId === stroke?.pointerId) cancelStroke();
    };
    const leave = () => {
      if (!stroke) {
        cursor = undefined;
        requestDraw();
      }
    };
    const cameraMove = () => {
      cancelStroke();
      cursor = undefined;
      drag = undefined;
      requestDraw();
    };
    const styleChanged = () => {
      if (!map.isStyleLoaded()) cameraMove();
    };
    const contextLost = () => {
      graphicsAvailable = false;
      cameraMove();
    };
    const contextRestored = () => {
      graphicsAvailable = true;
    };
    const click = (event: maplibregl.MapMouseEvent) => {
      const value = current.current,
        draft = value.neighborhoodDraft;
      if (
        !canEditNeighborhoodDraft(value) ||
        !draft ||
        !["draw", "reshape"].includes(draft.mode) ||
        performance.now() < ignoreClickUntil
      )
        return;
      if (
        event.originalEvent.target instanceof Element &&
        event.originalEvent.target.closest(".city-neighborhood-vertex")
      )
        return;
      canvas.focus({ preventScroll: true });
      applyPoint([event.lngLat.lng, event.lngLat.lat]);
    };
    const keydown = (event: KeyboardEvent) => {
      if (!canEditNeighborhoodDraft(current.current)) return;
      const command = neighborhoodDraftCommandForKey(
        event,
        document.activeElement === canvas,
      );
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (stroke) {
        if (command === "cancel") cancelStroke();
        else
          setNotice("Release the brush before finishing or changing points.");
        return;
      }
      if (
        command === "delete-vertex" &&
        !["draw", "reshape"].includes(current.current.neighborhoodDraft!.mode)
      )
        return;
      current.current.onNeighborhoodDraftCommand?.(command);
    };
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("pointermove", move, true);
    canvas.addEventListener("pointerup", up, true);
    canvas.addEventListener("pointercancel", pointerCancel, true);
    canvas.addEventListener("lostpointercapture", pointerCancel, true);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("keydown", keydown, true);
    map.on("click", click);
    map.on("movestart", cameraMove);
    map.on("resize", cameraMove);
    map.on("styledata", styleChanged);
    map.on("webglcontextlost", contextLost);
    map.on("webglcontextrestored", contextRestored);
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      releaseStroke();
      syncRef.current = null;
      removeMarkers();
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerup", up, true);
      canvas.removeEventListener("pointercancel", pointerCancel, true);
      canvas.removeEventListener("lostpointercapture", pointerCancel, true);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("keydown", keydown, true);
      map.off("click", click);
      map.off("movestart", cameraMove);
      map.off("resize", cameraMove);
      map.off("styledata", styleChanged);
      map.off("webglcontextlost", contextLost);
      map.off("webglcontextrestored", contextRestored);
      if (restore) {
        if (restore.pan) map.dragPan.enable();
        if (restore.touch) map.touchZoomRotate.enable();
      }
      if (restoreDoubleClick) map.doubleClickZoom.enable();
      canvas.style.touchAction = originalTouchAction;
      if (originalLabel !== null)
        canvas.setAttribute("aria-label", originalLabel);
      else canvas.removeAttribute("aria-label");
      current.current.renderLayers([]);
    };
  }, [options.ready, options.mapRef, options.place.id]);
  useEffect(() => {
    syncRef.current?.();
  }, [
    options.neighborhoodDraft,
    options.neighborhoodEditingEnabled,
    options.view,
    options.roadDraft,
    options.parcelDraft,
    options.buildingDraft,
    options.revealScenario,
    options.placingBuilding,
    options.selectingCommentLocation,
    options.place,
  ]);
  return notice;
}
