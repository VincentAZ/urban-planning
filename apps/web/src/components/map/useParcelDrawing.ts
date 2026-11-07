import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as maplibregl from "maplibre-gl";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import {
  validateParcelGeometry,
  type Parcel,
  type Place,
  type Position,
} from "@urban/core";
import {
  activeParcelPath,
  canEditParcelDraft,
  changeParcelDraftPoint,
  closedParcelRing,
  createParcelSnapIndex,
  draftParcelGeometry,
  extendedParcelCut,
  nearestParcelVertex,
  parcelDraftCandidate,
  parcelDraftCommandForKey,
  previewParcelParts,
  type ParcelDrawingContext,
  type ParcelSnapIndex,
} from "./parcel-drawing";

interface Options extends ParcelDrawingContext {
  ready: boolean;
  mapRef: MutableRefObject<maplibregl.Map | null>;
  place: Place;
  parcels: readonly Parcel[];
  maxRingPoints: number;
  renderLayers: (layers: Layer[]) => void;
}
type Candidate = ReturnType<typeof parcelDraftCandidate>;
type Drag = {
  draftId: string;
  ringId: string | null;
  index: number;
  original: Position;
  candidate?: Candidate;
};
const colors: [number, number, number, number][] = [
  [59, 136, 129, 65],
  [222, 166, 71, 75],
  [115, 125, 177, 70],
  [169, 117, 141, 65],
];

/** The root owns canonical geometry and undo. Only the active ring/cut has drag handles. */
export function useParcelDrawing(options: Options): string {
  const current = useRef(options);
  current.current = options;
  const syncRef = useRef<(() => void) | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const map = options.mapRef.current;
    if (!options.ready || !map) return;
    const canvas = map.getCanvas(),
      originalLabel = canvas.getAttribute("aria-label");
    let markers: { marker: maplibregl.Marker; button: HTMLButtonElement }[] =
      [];
    let sessionId: string | undefined, pathKey: string | null | undefined;
    let cursor: Candidate | undefined, drag: Drag | undefined;
    let snapIndex: ParcelSnapIndex = new Map(),
      snapDirty = true;
    let snapParcels: readonly Parcel[] | undefined,
      excludedKey = "";
    let frame = 0,
      disposed = false,
      ignoreClickUntil = 0;
    let restoreDoubleClick: boolean | undefined;
    let fillParts: ReturnType<typeof previewParcelParts> = [],
      baseValid = true;
    const snapAt = (position: Position): Candidate => {
      const value = current.current,
        draft = value.parcelDraft;
      if (!draft?.snapToParcels || map.isMoving())
        return parcelDraftCandidate(position, value.place);
      if (snapDirty) {
        snapIndex = createParcelSnapIndex(
          value.parcels,
          (point) => map.project(point),
          draft.operation === "split" ? [] : draft.sourceParcelIds,
        );
        snapDirty = false;
      }
      return parcelDraftCandidate(
        position,
        value.place,
        nearestParcelVertex(snapIndex, position, map.project(position)),
      );
    };
    const describe = (candidate?: Candidate) =>
      setNotice(
        !candidate
          ? ""
          : !candidate.inside
            ? "Choose a point inside the study area, outside excluded areas."
            : candidate.snap
              ? `Aligned to ${candidate.snap.name || "parcel"}. Alignment is not a surveyed boundary.`
              : "",
      );
    const validDrag = () => {
      const draft = current.current.parcelDraft,
        path = draft ? activeParcelPath(draft) : null;
      return !!(
        drag &&
        draft &&
        path &&
        draft.id === drag.draftId &&
        path.ringId === drag.ringId &&
        path.coordinates[drag.index]?.[0] === drag.original[0] &&
        path.coordinates[drag.index]?.[1] === drag.original[1]
      );
    };
    const draw = () => {
      frame = 0;
      const value = current.current,
        draft = value.parcelDraft;
      if (disposed || !draft || !canEditParcelDraft(value)) {
        value.renderLayers([]);
        return;
      }
      const active = activeParcelPath(draft),
        candidate = validDrag() ? drag?.candidate : cursor;
      const changed = candidate
        ? changeParcelDraftPoint(
            draft,
            candidate.position,
            value.maxRingPoints,
            validDrag() ? drag!.index : undefined,
          )
        : null;
      const outlines = draft.rings
        .filter((ring) => ring.coordinates.length > 1)
        .map((ring) => ({
          id: ring.id,
          path: closedParcelRing(ring.coordinates),
          hole: ring.ringIndex > 0,
        }));
      const activePreview = changed
        ? draft.operation === "split"
          ? changed.coordinates
          : closedParcelRing(changed.coordinates)
        : [];
      const cut =
        draft.operation === "split"
          ? extendedParcelCut(
              changed?.coordinates ?? draft.splitLine,
              value.place,
            )
          : [];
      const parameters = {
        depthCompare: "always" as const,
        depthWriteEnabled: false,
      };
      value.renderLayers([
        new PolygonLayer<(typeof fillParts)[number]>({
          id: "parcel-draft-fill",
          data: fillParts,
          getPolygon: (part) => part.rings,
          getFillColor: (part) => colors[part.outputIndex % colors.length],
          getLineColor: [53, 112, 102, 220],
          getLineWidth: 2,
          lineWidthUnits: "pixels",
          stroked: true,
          pickable: false,
          parameters,
        }),
        new PathLayer<(typeof outlines)[number]>({
          id: "parcel-draft-rings",
          data: outlines,
          getPath: (ring) => ring.path,
          getColor: (ring) =>
            !baseValid
              ? [179, 75, 57, 240]
              : ring.id === active?.ringId
                ? [29, 112, 101, 255]
                : ring.hole
                  ? [164, 115, 49, 230]
                  : [76, 128, 120, 200],
          getWidth: (ring) => (ring.id === active?.ringId ? 4 : 2),
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          parameters,
        }),
        new PathLayer<Position[]>({
          id: "parcel-draft-cut-extension",
          data: cut.length > 1 ? [cut] : [],
          getPath: (path) => path,
          getColor: [203, 140, 39, 140],
          getWidth: 2,
          widthUnits: "pixels",
          pickable: false,
          parameters,
        }),
        new PathLayer<readonly Position[]>({
          id: "parcel-draft-cut",
          data:
            draft.operation === "split" && draft.splitLine.length > 1
              ? [draft.splitLine]
              : [],
          getPath: (path) => path as Position[],
          getColor: [196, 126, 30, 255],
          getWidth: 4,
          widthUnits: "pixels",
          capRounded: true,
          pickable: false,
          parameters,
        }),
        new PathLayer<Position[]>({
          id: "parcel-draft-pointer-path",
          data: activePreview.length > 1 ? [activePreview] : [],
          getPath: (path) => path,
          getColor: candidate?.inside
            ? [223, 159, 47, 255]
            : [183, 73, 56, 255],
          getWidth: 3,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
          pickable: false,
          parameters,
        }),
        new ScatterplotLayer<Candidate>({
          id: "parcel-draft-cursor",
          data: candidate ? [candidate] : [],
          getPosition: (point) => point.position,
          getRadius: candidate?.snap ? 9 : 6,
          radiusUnits: "pixels",
          getFillColor: candidate?.inside
            ? [246, 207, 111, 220]
            : [230, 150, 132, 220],
          stroked: true,
          getLineColor: [74, 77, 51, 255],
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
    const apply = (candidate: Candidate, index?: number) => {
      const value = current.current,
        draft = value.parcelDraft;
      if (!draft || !canEditParcelDraft(value) || !candidate.inside) {
        describe(candidate);
        return;
      }
      const changed = changeParcelDraftPoint(
        draft,
        candidate.position,
        value.maxRingPoints,
        index,
      );
      if (!changed) return;
      const snap = candidate.snap;
      value.onParcelDraftPathChange?.(changed.coordinates, {
        ...changed.detail,
        ...(snap
          ? {
              snap: {
                parcelId: snap.parcelId,
                partIndex: snap.partIndex,
                ringIndex: snap.ringIndex,
                vertexIndex: snap.vertexIndex,
              },
            }
          : {}),
      });
      describe(candidate);
    };
    const removeMarkers = () => {
      markers.forEach((entry) => entry.marker.remove());
      markers = [];
    };
    const sync = () => {
      const value = current.current,
        draft = value.parcelDraft,
        enabled = canEditParcelDraft(value),
        path = draft ? activeParcelPath(draft) : null;
      if (sessionId !== draft?.id || pathKey !== path?.ringId) {
        sessionId = draft?.id;
        pathKey = path?.ringId;
        drag = undefined;
        cursor = undefined;
        removeMarkers();
        setNotice("");
      }
      const nextExcluded = JSON.stringify(
        draft?.operation === "split" ? [] : (draft?.sourceParcelIds ?? []),
      );
      if (snapParcels !== value.parcels || excludedKey !== nextExcluded) {
        snapParcels = value.parcels;
        excludedKey = nextExcluded;
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
          ? "Parcel editing map. Enter finishes, Escape discards, Delete removes the selected point. Coordinate controls are in the parcel editor."
          : "Map. Parcel editing is paused.",
      );
      if (!draft || !enabled) {
        drag = undefined;
        cursor = undefined;
        removeMarkers();
        requestDraw();
        return;
      }
      if (!validDrag()) drag = undefined;
      const geometry = draftParcelGeometry(draft.rings);
      baseValid =
        !geometry || validateParcelGeometry(geometry, value.place).valid;
      const geometries =
        draft.operation === "split" || draft.operation === "assemble"
          ? (draft.previewGeometries ?? [])
          : geometry && baseValid
            ? [geometry]
            : [];
      fillParts = previewParcelParts(geometries);
      while (markers.length > (path?.coordinates.length ?? 0))
        markers.pop()!.marker.remove();
      if (path)
        for (let index = 0; index < path.coordinates.length; index++) {
          let entry = markers[index];
          if (!entry) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "city-parcel-vertex";
            button.textContent = String(index + 1);
            button.dataset.parcelVertex = String(index);
            button.setAttribute(
              "aria-label",
              `${draft.operation === "split" ? "Split line" : "Parcel"} vertex ${index + 1}`,
            );
            const marker = new maplibregl.Marker({
              element: button,
              anchor: "center",
              draggable: true,
              pitchAlignment: "viewport",
              rotationAlignment: "viewport",
            })
              .setLngLat(path.coordinates[index])
              .addTo(map);
            button.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              const latest = current.current,
                active = latest.parcelDraft
                  ? activeParcelPath(latest.parcelDraft)
                  : null;
              if (active && canEditParcelDraft(latest))
                latest.onParcelVertexSelect?.(active.ringId, index);
            });
            button.addEventListener("dblclick", (event) => {
              event.preventDefault();
              event.stopPropagation();
            });
            button.addEventListener("keydown", (event) =>
              event.stopPropagation(),
            );
            button.addEventListener("keyup", (event) =>
              event.stopPropagation(),
            );
            marker.on("dragstart", () => {
              const latest = current.current,
                active = latest.parcelDraft
                  ? activeParcelPath(latest.parcelDraft)
                  : null,
                point = active?.coordinates[index];
              if (!point || !active || !canEditParcelDraft(latest)) return;
              drag = {
                draftId: latest.parcelDraft!.id,
                ringId: active.ringId,
                index,
                original: [...point],
              };
              cursor = undefined;
              latest.onParcelVertexSelect?.(active.ringId, index);
            });
            marker.on("drag", () => {
              if (!validDrag()) return;
              const point = marker.getLngLat();
              drag!.candidate = snapAt([point.lng, point.lat]);
              describe(drag!.candidate);
              requestDraw();
            });
            marker.on("dragend", () => {
              ignoreClickUntil = performance.now() + 150;
              const point = marker.getLngLat(),
                candidate = snapAt([point.lng, point.lat]),
                shouldApply =
                  validDrag() && canEditParcelDraft(current.current);
              drag = undefined;
              if (shouldApply) apply(candidate, index);
              const latest = current.current.parcelDraft,
                active = latest ? activeParcelPath(latest) : null;
              if (active?.coordinates[index])
                marker.setLngLat(active.coordinates[index]);
              requestDraw();
            });
            entry = { marker, button };
            markers.push(entry);
          }
          if (drag?.index !== index)
            entry.marker.setLngLat(path.coordinates[index]);
          entry.button.classList.toggle(
            "is-selected",
            draft.selectedVertexIndex === index,
          );
          entry.button.setAttribute(
            "aria-pressed",
            String(draft.selectedVertexIndex === index),
          );
        }
      requestDraw();
    };
    syncRef.current = sync;
    const click = (event: maplibregl.MapMouseEvent) => {
      if (
        !canEditParcelDraft(current.current) ||
        performance.now() < ignoreClickUntil ||
        current.current.parcelDraft?.operation === "assemble"
      )
        return;
      if (
        event.originalEvent.target instanceof Element &&
        event.originalEvent.target.closest(".city-parcel-vertex")
      )
        return;
      canvas.focus({ preventScroll: true });
      apply(snapAt([event.lngLat.lng, event.lngLat.lat]));
      cursor = undefined;
      requestDraw();
    };
    const move = (event: maplibregl.MapMouseEvent) => {
      if (
        !canEditParcelDraft(current.current) ||
        current.current.parcelDraft?.operation === "assemble" ||
        drag ||
        map.isMoving()
      )
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
      if (!canEditParcelDraft(current.current)) return;
      const command = parcelDraftCommandForKey(
        event,
        document.activeElement === canvas,
      );
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        command !== "delete-vertex" ||
        current.current.parcelDraft?.selectedVertexIndex !== null
      )
        current.current.onParcelDraftCommand?.(command);
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
    options.parcelDraft,
    options.parcelEditingEnabled,
    options.view,
    options.roadDraft,
    options.revealScenario,
    options.placingBuilding,
    options.selectingCommentLocation,
    options.parcels,
    options.place,
  ]);
  return notice;
}
