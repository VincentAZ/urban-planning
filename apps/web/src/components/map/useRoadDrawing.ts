import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as maplibregl from "maplibre-gl";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import {
  lineWithinStudyArea,
  validateRoadPath,
  type Place,
  type Position,
  type Road,
} from "@urban/core";
import {
  canEditRoadDraft,
  changeRoadDraftPoint,
  createRoadSnapIndex,
  nearestRoadVertex,
  roadDraftCommandForKey,
  roadDraftCandidate,
  type RoadDraftCandidate as Candidate,
  type RoadDrawingContext,
  type RoadSnap,
  type RoadSnapIndex,
} from "./road-drawing";

interface Options extends RoadDrawingContext {
  ready: boolean;
  mapRef: MutableRefObject<maplibregl.Map | null>;
  place: Place;
  roads: readonly Road[];
  renderLayers: (layers: Layer[]) => void;
}
type Drag = {
  draftId: string;
  index: number;
  original: Position;
  candidate?: Candidate;
};

/** Only this small overlay changes while moving the pointer; source layers stay intact. */
export function useRoadDrawing(options: Options): string {
  const current = useRef(options);
  current.current = options;
  const syncRef = useRef<(() => void) | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const map = options.mapRef.current;
    if (!options.ready || !map) return;
    const canvas = map.getCanvas();
    const originalLabel = canvas.getAttribute("aria-label");
    let sessionId: string | undefined,
      coordinates: readonly Position[] | undefined;
    let markers: { marker: maplibregl.Marker; button: HTMLButtonElement }[] =
      [];
    let cursor: Candidate | undefined, drag: Drag | undefined;
    let snapIndex: RoadSnapIndex = new Map(),
      snapDirty = true;
    let snapRoads: readonly Road[] | undefined,
      excludedRoadId: string | undefined;
    let baseValid = true,
      frame = 0,
      disposed = false;
    let ignoreClickUntil = 0;
    let restoreDoubleClick: boolean | undefined;

    const snapAt = (position: Position): Candidate => {
      const value = current.current;
      let snap: RoadSnap | undefined;
      if (value.roadDraft?.snapToRoads && !map.isMoving()) {
        if (snapDirty) {
          snapIndex = createRoadSnapIndex(
            value.roads,
            (point) => map.project(point),
            value.roadDraft.roadId,
          );
          snapDirty = false;
        }
        snap = nearestRoadVertex(snapIndex, position, map.project(position));
      }
      return roadDraftCandidate(position, value.place, snap);
    };
    const describeCandidate = (candidate?: Candidate) => {
      if (!candidate) {
        setNotice("");
        return;
      }
      setNotice(
        !candidate.inside
          ? "Keep street points inside the study area and outside excluded areas."
          : candidate.snap
            ? `Aligned to ${candidate.snap.name || "street"}.`
            : "",
      );
    };
    const validDrag = () => {
      const draft = current.current.roadDraft;
      return (
        drag &&
        draft &&
        drag.draftId === draft.id &&
        draft.coordinates[drag.index]?.[0] === drag.original[0] &&
        draft.coordinates[drag.index]?.[1] === drag.original[1]
      );
    };
    const draw = () => {
      frame = 0;
      const value = current.current,
        draft = value.roadDraft;
      if (disposed || !draft || !canEditRoadDraft(value)) {
        value.renderLayers([]);
        return;
      }
      const candidate = validDrag() ? drag?.candidate : cursor;
      const change = candidate
        ? changeRoadDraftPoint(
            draft,
            candidate.position,
            validDrag() ? drag!.index : undefined,
          )
        : null;
      const preview = change?.coordinates;
      const incidentSegments: Position[][] = [];
      if (preview && change) {
        const i = change.detail.vertexIndex;
        if (i > 0) incidentSegments.push([preview[i - 1], preview[i]]);
        if (i + 1 < preview.length)
          incidentSegments.push([preview[i], preview[i + 1]]);
      }
      const previewValid =
        !!candidate?.inside &&
        incidentSegments.every((path) =>
          lineWithinStudyArea(path, value.place),
        );
      const paths = draft.coordinates.length > 1 ? [draft.coordinates] : [];
      const overlay: Layer[] = [
        new PathLayer<readonly Position[]>({
          id: "street-draft-halo",
          data: paths,
          getPath: (path) => path as Position[],
          getColor: [255, 254, 244, 240],
          getWidth: 8,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
        new PathLayer<readonly Position[]>({
          id: "street-draft-path",
          data: paths,
          getPath: (path) => path as Position[],
          getColor: baseValid ? [22, 109, 91, 255] : [184, 73, 58, 255],
          getWidth: 4,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
        new PathLayer<Position[]>({
          id: "street-draft-preview",
          data: incidentSegments,
          getPath: (path) => path,
          getColor: previewValid ? [218, 158, 43, 255] : [184, 73, 58, 255],
          getWidth: 5,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
        new ScatterplotLayer<Candidate>({
          id: "street-draft-cursor",
          data: candidate ? [candidate] : [],
          getPosition: (point) => point.position,
          getRadius: candidate?.snap ? 9 : 6,
          radiusUnits: "pixels",
          getFillColor: previewValid
            ? [246, 209, 119, 220]
            : [231, 154, 135, 220],
          stroked: true,
          getLineColor: [75, 70, 46, 255],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          pickable: false,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
      ];
      value.renderLayers(overlay);
    };
    const requestDraw = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    const applyCandidate = (candidate: Candidate, index?: number) => {
      const value = current.current;
      if (!canEditRoadDraft(value) || !value.roadDraft || !candidate.inside) {
        describeCandidate(candidate);
        return;
      }
      const change = changeRoadDraftPoint(
        value.roadDraft,
        candidate.position,
        index,
      );
      if (!change) return;
      value.onRoadDraftChange?.(change.coordinates, {
        ...change.detail,
        ...(candidate.snap
          ? {
              snap: {
                roadId: candidate.snap.roadId,
                vertexIndex: candidate.snap.vertexIndex,
              },
            }
          : {}),
      });
      describeCandidate(candidate);
    };
    const removeMarkers = () => {
      for (const entry of markers) entry.marker.remove();
      markers = [];
    };
    const sync = () => {
      const value = current.current,
        draft = value.roadDraft;
      const enabled = canEditRoadDraft(value);
      if (sessionId !== draft?.id) {
        sessionId = draft?.id;
        drag = undefined;
        cursor = undefined;
        coordinates = undefined;
        removeMarkers();
        setNotice("");
      }
      if (snapRoads !== value.roads || excludedRoadId !== draft?.roadId) {
        snapRoads = value.roads;
        excludedRoadId = draft?.roadId;
        snapDirty = true;
      }
      if (enabled && restoreDoubleClick === undefined) {
        restoreDoubleClick = map.doubleClickZoom.isEnabled();
        map.doubleClickZoom.disable();
      } else if (!enabled && restoreDoubleClick !== undefined) {
        if (restoreDoubleClick) map.doubleClickZoom.enable();
        restoreDoubleClick = undefined;
      }
      if (draft)
        canvas.setAttribute(
          "aria-label",
          enabled
            ? "Street drawing map. Enter finishes, Escape discards, Delete removes the selected point. Coordinate controls are in the street editor."
            : "Map. Street drawing is paused.",
        );
      else if (originalLabel !== null)
        canvas.setAttribute("aria-label", originalLabel);
      else canvas.removeAttribute("aria-label");
      if (!draft || !enabled) {
        drag = undefined;
        cursor = undefined;
        removeMarkers();
        requestDraw();
        return;
      }
      if (!validDrag()) drag = undefined;
      if (coordinates !== draft.coordinates) {
        coordinates = draft.coordinates;
        cursor = undefined;
        baseValid =
          coordinates.length < 2 ||
          validateRoadPath(coordinates, value.place).valid;
      }
      while (markers.length > coordinates.length)
        markers.pop()!.marker.remove();
      for (let index = 0; index < coordinates.length; index++) {
        let entry = markers[index];
        if (!entry) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "city-street-vertex";
          button.textContent = String(index + 1);
          button.dataset.streetVertex = String(index);
          button.setAttribute("aria-label", `Street vertex ${index + 1}`);
          const marker = new maplibregl.Marker({
            element: button,
            anchor: "center",
            draggable: true,
            pitchAlignment: "viewport",
            rotationAlignment: "viewport",
          })
            .setLngLat(coordinates[index])
            .addTo(map);
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (canEditRoadDraft(current.current))
              current.current.onRoadVertexSelect?.(index);
          });
          // Do not stop pointerdown: MapLibre's Marker consumes it to begin a drag.
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
              point = latest.roadDraft?.coordinates[index];
            if (!point || !canEditRoadDraft(latest)) return;
            drag = {
              draftId: latest.roadDraft!.id,
              index,
              original: [...point],
            };
            cursor = undefined;
            latest.onRoadVertexSelect?.(index);
          });
          marker.on("drag", () => {
            if (!validDrag()) return;
            const point = marker.getLngLat();
            drag!.candidate = snapAt([point.lng, point.lat]);
            describeCandidate(drag!.candidate);
            requestDraw();
          });
          marker.on("dragend", () => {
            ignoreClickUntil = performance.now() + 150;
            const point = marker.getLngLat(),
              candidate = snapAt([point.lng, point.lat]);
            const shouldApply =
              validDrag() && canEditRoadDraft(current.current);
            drag = undefined;
            if (shouldApply) applyCandidate(candidate, index);
            // Controlled state owns the final location, including rejected/invalid moves.
            const latest = current.current.roadDraft?.coordinates[index];
            if (latest) marker.setLngLat(latest);
            requestDraw();
          });
          entry = { button, marker };
          markers.push(entry);
        }
        if (drag?.index !== index) entry.marker.setLngLat(coordinates[index]);
        const selected = draft.selectedVertexIndex === index;
        entry.button.classList.toggle("is-selected", selected);
        entry.button.setAttribute("aria-pressed", String(selected));
      }
      requestDraw();
    };
    syncRef.current = sync;
    const click = (event: maplibregl.MapMouseEvent) => {
      if (
        !canEditRoadDraft(current.current) ||
        performance.now() < ignoreClickUntil
      )
        return;
      // Marker clicks select a vertex; they never append/move another one.
      if (
        event.originalEvent.target instanceof Element &&
        event.originalEvent.target.closest(".city-street-vertex")
      )
        return;
      canvas.focus({ preventScroll: true });
      applyCandidate(snapAt([event.lngLat.lng, event.lngLat.lat]));
      cursor = undefined;
      requestDraw();
    };
    const move = (event: maplibregl.MapMouseEvent) => {
      if (!canEditRoadDraft(current.current) || drag || map.isMoving()) return;
      cursor = snapAt([event.lngLat.lng, event.lngLat.lat]);
      describeCandidate(cursor);
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
      if (current.current.roadDraft) requestDraw();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!canEditRoadDraft(current.current)) return;
      const command = roadDraftCommandForKey(
        event,
        document.activeElement === canvas,
      );
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        command !== "delete-vertex" ||
        current.current.roadDraft?.selectedVertexIndex !== null
      )
        current.current.onRoadDraftCommand?.(command);
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
      removeMarkers();
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
    options.roadDraft,
    options.roadEditingEnabled,
    options.view,
    options.revealScenario,
    options.selectingCommentLocation,
    options.roads,
    options.place,
  ]);
  return notice;
}
