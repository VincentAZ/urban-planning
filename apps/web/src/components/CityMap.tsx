import { carIconAtlas, carIconMapping } from "./map/car-icons";
import { FloodLegend } from "./flood/FloodEvidence";
import {
  floodMapParts,
  floodMapColor,
  type FloodMapPart,
} from "./map/flood-layer";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import * as maplibregl from "maplibre-gl";
import { mapStyle, satelliteImagery } from "./map/basemap";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import {
  AmbientLight,
  DirectionalLight,
  LightingEffect,
  type Layer,
} from "@deck.gl/core";
import { IconLayer, PathLayer, PolygonLayer, TextLayer } from "@deck.gl/layers";
import { Compass, Minus, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import {
  studyAreaPolygons,
  studyAreaBounds,
  studyAreaAnchor,
  pointInStudyArea,
  landUseColors,
  landUseLabels,
  materializeBuildings,
  materializeRoads,
  materializeParcels,
  validateBuildingGeometry,
  MAX_AUTHORED_PARCEL_RING_POINTS,
  type FloodDatasetCatalog,
  type Building,
  type Place,
  type Polygon,
  type Position,
  type Road,
  type Scenario,
} from "@urban/core";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import "./map/city-map.css";
import {
  createAgents,
  sampleAgents,
  createVehicleBuffers,
  updateVehicleBuffers,
  footways,
  type VehicleBuffers,
} from "./map/motion";
import { captureMapImage } from "./map/capture";
import { MapExportFence, type MapExportHandle } from "./map/export-frame";
import {
  CameraCommandController,
  cameraLimitsValid,
  readMapCamera,
  type CameraEnvironment,
  type MapCamera,
  type MapCameraCommand,
  type MapCameraCommandResult,
  type MapCameraLimits,
} from "./map/camera";
export type {
  MapCamera,
  MapCameraCommand,
  MapCameraCommandResult,
  MapCameraLimits,
} from "./map/camera";
import { clampRevealPercent, clipRevealLayers } from "./map/reveal";
import {
  assertRoadDraftCaptureAllowed,
  canEditRoadDraft,
  type RoadDrawingProps,
} from "./map/road-drawing";
import { useRoadDrawing } from "./map/useRoadDrawing";
import { roadSurfaceDepth, roadSurfacePath } from "./map/road-surface";
import {
  assertParcelDraftCaptureAllowed,
  canEditParcelDraft,
  canSelectParcel,
  parcelMapParts,
  parcelSurfaceRings,
  type ParcelDrawingProps,
  type ParcelMapPart,
} from "./map/parcel-drawing";
import { useParcelDrawing } from "./map/useParcelDrawing";
import { useBuildingDrawing } from "./map/useBuildingDrawing";
import {
  assertBuildingDraftCaptureAllowed,
  buildingMapParts,
  buildingMapRings,
  buildingRoofPath,
  buildingSurfaceRings,
  safeDraftHeight,
  buildingOutlineRings,
  canDisplayBuildingDraft,
  canEditBuildingDraft,
  draftBuildingGeometry,
  type BuildingDrawingProps,
  type BuildingMapPart,
  type BuildingMapRing,
} from "./map/building-drawing";
export type {
  MapBuildingDraft,
  MapBuildingRing,
  MapBuildingDraftChange,
  MapBuildingTransform,
} from "./map/building-drawing";
export type {
  MapParcelDraft,
  MapParcelRing,
  MapParcelDraftChange,
  MapParcelDraftPathChange,
} from "./map/parcel-drawing";
export type {
  MapRoadDraft,
  MapRoadDraftChange,
  MapRoadDraftCommand,
} from "./map/road-drawing";
import {
  dispatchMapClick,
  reviewPinsForPlace,
  type MapReviewPin,
  type MapFocusLocation,
} from "./map/review";
export type { MapReviewPin, MapFocusLocation } from "./map/review";

import { useNeighborhoodDrawing } from "./map/useNeighborhoodDrawing";
import {
  assertNeighborhoodDraftCaptureAllowed,
  canDisplayNeighborhoodDraft,
  canEditNeighborhoodDraft,
  canSelectNeighborhood,
  neighborhoodMapParts,
  neighborhoodSurfaceRings,
  type NeighborhoodDrawingProps,
  type NeighborhoodMapPart,
} from "./map/neighborhood-drawing";
export type {
  MapNeighborhoodDraft,
  MapNeighborhoodRing,
  MapNeighborhoodStroke,
  MapNeighborhoodDraftChange,
  MapNeighborhoodSummary,
} from "./map/neighborhood-drawing";

export interface CityMapProps
  extends RoadDrawingProps,
    ParcelDrawingProps,
    BuildingDrawingProps,
    NeighborhoodDrawingProps {
  place: Place;
  scenario: Scenario;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  view: "3d" | "2d" | "satellite";
  playing: boolean;
  speed: number;
  timeOfDay: number;
  layers: string[];
  floodDatasets?: FloodDatasetCatalog;
  onMapClick?: (position: Position) => void;
  /** Keep the original building/park/motor-road placement blockers while exploring paths stays selectable. */
  placingBuilding?: boolean;
  compareScenario?: Scenario | null;
  /** Captured baseline on the left; scenario remains the proposal on the right. */
  revealScenario?: Scenario;
  revealPercent?: number;
  onRevealPercentChange?: (percent: number) => void;
  captureRef?: MutableRefObject<(() => Promise<string>) | null>;
  camera?: MapCamera;
  onCameraChange?: (camera: MapCamera) => void;
  cameraCommand?: MapCameraCommand;
  onCameraCommandResult?: (result: MapCameraCommandResult) => void;
  cameraCaptureRef?: MutableRefObject<(() => MapCamera | null) | null>;
  onCameraReadyChange?: (ready: boolean) => void;
  /** Private frozen-scene renderer only. Interactive maps leave this absent. */
  exportMode?: {
    sceneHash: string;
    rendererRef: MutableRefObject<MapExportHandle | null>;
  };
  cameraLimits?: MapCameraLimits;
  reviewPins?: readonly MapReviewPin[];
  selectedReviewPinId?: string | null;
  onReviewPinSelect?: (id: string) => void;
  selectingCommentLocation?: boolean;
  focusLocation?: MapFocusLocation | null;
}
type StreetLabel = { name: string; position: Position; angle: number };
function getStreetLabels(roads: Road[]): StreetLabel[] {
  const named = new Map<string, Road>();
  for (const road of roads) {
    if (
      footways.has(road.kind) ||
      road.name === "Local access" ||
      road.name === "Pedestrian path"
    )
      continue;
    const prior = named.get(road.name);
    if (!prior || road.coordinates.length > prior.coordinates.length)
      named.set(road.name, road);
  }
  return [...named.values()].slice(0, 28).map((road) => {
    const a = road.coordinates[0],
      b = road.coordinates[road.coordinates.length - 1];
    const angle =
      (Math.atan2((b[1] - a[1]) * 1.2, b[0] - a[0]) * 180) / Math.PI;
    return {
      name: road.name
        .replace("North ", "N ")
        .replace("East ", "E ")
        .replace("West ", "W ")
        .replace("South ", "S "),
      position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      angle: angle > 90 ? angle - 180 : angle < -90 ? angle + 180 : angle,
    };
  });
}
const imagery = satelliteImagery(import.meta.env.VITE_MAPTILER_KEY);
const styleFor = (view: CityMapProps["view"], night: boolean) =>
  mapStyle(view, night, import.meta.env.VITE_MAPTILER_KEY);
/** Real source geometry, scenario edits, and explicitly illustrative sampled activity. */
export function CityMap(props: CityMapProps) {
  const {
    place,
    scenario,
    selectedId,
    view,
    playing,
    speed,
    timeOfDay,
    layers,
    captureRef,
  } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const cameraControllerRef = useRef<CameraCommandController | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const exportFenceRef = useRef<MapExportFence | null>(null);
  const exportDrawRef = useRef({
    serial: 0,
    layers: 0,
    drawn: 0,
    error: null as string | null,
    loaded: false,
    zoom: NaN,
    view: "",
  });
  const reviewMarkersRef = useRef(
    new Map<
      string,
      {
        marker: maplibregl.Marker;
        button: HTMLButtonElement;
        label: HTMLSpanElement;
      }
    >(),
  );
  const appliedFocusRef = useRef<{
    map: maplibregl.Map;
    requestId: string | number;
  } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    building: Building;
  } | null>(null);
  const [reducedGraphics, setReducedGraphics] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const cameraEnvironmentRef = useRef<CameraEnvironment>(null!);
  cameraEnvironmentRef.current = {
    limits: props.cameraLimits ?? {
      minZoom: place.studyArea ? 5 : 12,
      maxZoom: 20,
      maxPitch: 65,
    },
    flat: view === "2d" || reducedGraphics,
    reducedMotion,
  };
  const [retry, setRetry] = useState(0);
  const elapsedRef = useRef(0);
  const styleKeyRef = useRef("");
  const pitchKeyRef = useRef("");
  const staticLayersRef = useRef<Layer[]>([]);
  const roadDraftLayersRef = useRef<Layer[]>([]);
  const parcelDraftLayersRef = useRef<Layer[]>([]);
  const buildingDraftLayersRef = useRef<Layer[]>([]);
  const neighborhoodDraftLayersRef = useRef<Layer[]>([]);
  const [zoom, setZoom] = useState(16);
  const [localRevealPercent, setLocalRevealPercent] = useState(50);
  const revealPercent = clampRevealPercent(
    props.revealPercent ?? localRevealPercent,
  );
  const revealPercentRef = useRef(revealPercent);
  revealPercentRef.current = revealPercent;
  const reveal = !!props.revealScenario;
  const changeReveal = (value: number) => {
    const percent = clampRevealPercent(value);
    setLocalRevealPercent(percent);
    props.onRevealPercentChange?.(percent);
  };
  const floodParts = useMemo(
    () =>
      floodMapParts(
        props.scenario.flood
          ? props.floodDatasets?.[props.scenario.flood.datasetHash]
          : undefined,
      ),
    [props.floodDatasets, props.scenario.flood?.datasetHash],
  );
  const buildings = useMemo(
    () => materializeBuildings(place, scenario),
    [place, scenario],
  );
  // Commands clone the scenario, including road edits. Key the network by
  // road content so changing density or unrelated assumptions keeps cars alive.
  const roadEditsKey = JSON.stringify(scenario.roadEdits);
  const roads = useMemo(
    () => materializeRoads(place, scenario),
    [place, roadEditsKey],
  );
  const parcels = useMemo(
    () => materializeParcels(place, scenario),
    [place, scenario],
  );
  const parcelParts = useMemo(() => parcelMapParts(parcels), [parcels]);
  const beforeParcelParts = useMemo(
    () =>
      props.revealScenario
        ? parcelMapParts(materializeParcels(place, props.revealScenario))
        : [],
    [place, props.revealScenario],
  );
  const comparisonBuildings = useMemo(
    () =>
      props.compareScenario
        ? materializeBuildings(place, props.compareScenario).filter(
            (b) =>
              b.use !== "park" &&
              b.use !== "vacant" &&
              (scenario.buildingEdits[b.id] !== undefined ||
                props.compareScenario?.buildingEdits[b.id] !== undefined),
          )
        : [],
    [place, props.compareScenario, scenario.buildingEdits],
  );
  const beforeBuildings = useMemo(
    () =>
      props.revealScenario
        ? materializeBuildings(place, props.revealScenario)
        : [],
    [place, props.revealScenario],
  );
  const buildingParts = useMemo(() => buildingMapParts(buildings), [buildings]);
  const beforeBuildingParts = useMemo(
    () => buildingMapParts(beforeBuildings),
    [beforeBuildings],
  );
  const comparisonBuildingParts = useMemo(
    () => buildingMapParts(comparisonBuildings),
    [comparisonBuildings],
  );
  const draftGeometry = useMemo(
    () =>
      props.buildingDraft ? draftBuildingGeometry(props.buildingDraft) : null,
    [props.buildingDraft],
  );
  const replacingDraftBuildingId =
    canDisplayBuildingDraft(props) &&
    draftGeometry &&
    validateBuildingGeometry(draftGeometry).valid
      ? props.buildingDraft?.buildingId
      : undefined;
  const beforeRoads = useMemo(
    () =>
      props.revealScenario ? materializeRoads(place, props.revealScenario) : [],
    [place, props.revealScenario],
  );
  const beforeLabels = useMemo(
    () => getStreetLabels(beforeRoads),
    [beforeRoads],
  );
  const showAgents = layers.includes("agents");
  const agentPool = useMemo(() => createAgents(roads, 3), [roads]);
  const agents = useMemo(
    () => showAgents ? sampleAgents(agentPool, scenario.assumptions.vehicleMultiplier) : [],
    [agentPool, scenario.assumptions.vehicleMultiplier, showAgents],
  );
  const vehicleBuffers = useMemo(() => createVehicleBuffers(agents), [agents]);
  const beforeAgentPool = useMemo(() => createAgents(beforeRoads, 3), [beforeRoads]);
  const beforeAgents = useMemo(
    () => showAgents && props.revealScenario
      ? sampleAgents(beforeAgentPool, props.revealScenario.assumptions.vehicleMultiplier)
      : [],
    [beforeAgentPool, showAgents, props.revealScenario],
  );
  const beforeVehicleBuffers = useMemo(
    () => createVehicleBuffers(beforeAgents),
    [beforeAgents],
  );
  const beforeBuffersRef = useRef<VehicleBuffers | null>(null);
  beforeBuffersRef.current = reveal ? beforeVehicleBuffers : null;
  const streetLabels = useMemo(() => getStreetLabels(roads), [roads]);
  const night = timeOfDay < 6 || timeOfDay >= 19;
  const reviewPinsInteractive = !!props.onReviewPinSelect;
  const parcelPickable = canSelectParcel(props);
  const neighborhoodPickable = canSelectNeighborhood(props);
  const selectedParcelsKey = JSON.stringify(props.selectedParcelIds ?? []);
  const selectedParcels = useMemo(
    () => new Set<string>(JSON.parse(selectedParcelsKey)),
    [selectedParcelsKey],
  );

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(preference.matches);
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setReady(false);
    setError(null);
    let map: maplibregl.Map;
    try {
      if (propsRef.current.exportMode && propsRef.current.view === "satellite")
        throw new Error(
          "Satellite imagery is not captured and authorized for this export profile.",
        );
      const requestedLimits = cameraEnvironmentRef.current.limits;
      const limits = cameraLimitsValid(requestedLimits)
        ? requestedLimits
        : { minZoom: place.studyArea ? 5 : 12, maxZoom: 20, maxPitch: 65 };
      map = new maplibregl.Map({
        container: host,
        style: styleFor(propsRef.current.view, night),
        center:
          propsRef.current.camera?.center ??
          (pointInStudyArea(place.center, place)
            ? place.center
            : studyAreaAnchor(place)),
        zoom:
          propsRef.current.camera?.zoom ?? (place.studyArea ? undefined : 15.8),
        ...(place.studyArea && !propsRef.current.camera
          ? {
              bounds: studyAreaBounds(place),
              fitBoundsOptions: { padding: 70, maxZoom: 16 },
            }
          : {}),
        minZoom: limits.minZoom,
        maxZoom: limits.maxZoom,
        pitch:
          propsRef.current.camera?.pitch ??
          (propsRef.current.view === "2d" || reducedGraphics ? 0 : 53),
        bearing: propsRef.current.camera?.bearing ?? -27,
        maxPitch: limits.maxPitch,
        attributionControl: false,
        renderWorldCopies: false,
        ...(propsRef.current.exportMode
          ? { interactive: false, pixelRatio: 1, fadeDuration: 0 }
          : {}),
        canvasContextAttributes: {
          antialias: true,
          preserveDrawingBuffer: true,
        },
      });
      styleKeyRef.current = `${propsRef.current.view}:${night}`;
      pitchKeyRef.current = `${propsRef.current.view}:${reducedGraphics}`;
      mapRef.current = map;
      exportDrawRef.current = {
        serial: 0,
        layers: 0,
        drawn: 0,
        error: null,
        loaded: false,
        zoom: NaN,
        view: "",
      };
      if (propsRef.current.exportMode) {
        const exportMode = propsRef.current.exportMode;
        const fence = new MapExportFence(
          () => ({
            sceneHash: propsRef.current.exportMode?.sceneHash ?? "",
            ready:
              exportDrawRef.current.loaded &&
              exportDrawRef.current.layers > 0 &&
              exportDrawRef.current.view === propsRef.current.view &&
              Math.abs(exportDrawRef.current.zoom - map.getZoom()) < 1e-6 &&
              !!map.isStyleLoaded() &&
              map.areTilesLoaded(),
            style: styleKeyRef.current.split(":")[0],
            view: propsRef.current.view,
            camera: readMapCamera(map),
            width: map.getCanvas().width,
            height: map.getCanvas().height,
            drawSerial: exportDrawRef.current.serial,
            layerGeneration: exportDrawRef.current.layers,
            drawnLayerGeneration: exportDrawRef.current.drawn,
            error: exportDrawRef.current.error,
          }),
          (frame) => {
            const current = propsRef.current;
            if (
              current.view === "satellite" ||
              current.layers.includes("agents") ||
              current.selectedId ||
              current.reviewPins?.length ||
              current.roadDraft ||
              current.parcelDraft ||
              current.buildingDraft ||
              current.neighborhoodDraft
            )
              throw new Error(
                "Export requires the frozen scene without imagery, activity, private pins, selections or drafts.",
              );
            map.stop();
            map.setPixelRatio(1);
            map.resize();
            map.jumpTo(frame.camera);
            setZoom(frame.camera.zoom);
            map.triggerRepaint();
          },
        );
        exportFenceRef.current = fence;
        exportMode.rendererRef.current = fence;
        map.on("render", () => fence.rendered());
      }
      const cameraController = new CameraCommandController(
        map,
        () => ({
          ...cameraEnvironmentRef.current,
          // Respect the initial preference even before React's media-query effect.
          reducedMotion:
            cameraEnvironmentRef.current.reducedMotion ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        }),
        (result) => propsRef.current.onCameraCommandResult?.(result),
        (isReady) => propsRef.current.onCameraReadyChange?.(isReady),
      );
      cameraControllerRef.current = cameraController;
      cameraController.request(propsRef.current.cameraCommand);
      let renderReady = false;
      let contextLost = false;
      const updateCameraReadiness = () =>
        cameraController.setReady(
          renderReady && !contextLost && !!map.isStyleLoaded(),
        );
      map.on("styledata", updateCameraReadiness);
      map.on("idle", updateCameraReadiness);
      map.on("load", () => {
        const overlay = new MapLibreOverlay({
          interleaved: true,
          layers: [],
          ...(propsRef.current.exportMode
            ? {
                useDevicePixels: 1,
                onAfterRender: () => {
                  exportDrawRef.current.serial++;
                  exportDrawRef.current.drawn = exportDrawRef.current.layers;
                },
                onError: (error: Error) => {
                  exportDrawRef.current.error = error.message;
                  exportFenceRef.current?.cancel(error.message);
                },
              }
            : {}),
          getCursor: ({ isDragging, isHovering }) =>
            propsRef.current.selectingCommentLocation ||
            (!propsRef.current.parcelDraft &&
              canEditRoadDraft(propsRef.current)) ||
            canEditParcelDraft(propsRef.current) ||
            canEditBuildingDraft(propsRef.current) ||
            canEditNeighborhoodDraft(propsRef.current)
              ? "crosshair"
              : isDragging
                ? "grabbing"
                : isHovering
                  ? "pointer"
                  : "grab",
        });
        map.addControl(overlay);
        overlayRef.current = overlay;
        renderReady = true;
        exportDrawRef.current.loaded = true;
        setReady(true);
        updateCameraReadiness();
        propsRef.current.onCameraChange?.(readMapCamera(map));
      });
      map.on("zoomend", () => setZoom(map.getZoom()));
      map.on("moveend", () =>
        propsRef.current.onCameraChange?.(readMapCamera(map)),
      );
      map.on("click", (event) => {
        const current = propsRef.current;
        // A draft owns map interaction even while disabled or transitioning views.
        // The drawing controller handles valid edits; never fall through to placement.
        if (current.neighborhoodDraft) return;
        if (current.buildingDraft) return;
        if (current.roadDraft) return;
        if (current.revealScenario) return;
        if (current.parcelDraft && !canSelectParcel(current)) return;
        if (canSelectNeighborhood(current)) {
          const picked =
            overlayRef.current?.pickMultipleObjects({
              x: event.point.x,
              y: event.point.y,
              radius: 2,
              depth: 1,
              layerIds: ["neighborhoods"],
            }) ?? [];
          const neighborhood = picked.find(
            (item: { object?: { neighborhoodId?: string } }) =>
              typeof item.object?.neighborhoodId === "string",
          )?.object as NeighborhoodMapPart | undefined;
          current.onNeighborhoodSelect?.(neighborhood?.neighborhoodId ?? null);
          return;
        }
        if (canSelectParcel(current)) {
          const picked =
            overlayRef.current?.pickMultipleObjects({
              x: event.point.x,
              y: event.point.y,
              radius: 2,
              depth: 2,
              layerIds: ["parcels"],
            }) ?? [];
          const parcel = picked.find(
            (item: { object?: { parcelId?: string } }) =>
              typeof item.object?.parcelId === "string",
          )?.object as ParcelMapPart | undefined;
          current.onParcelSelect?.(parcel?.parcelId ?? null);
          return;
        }
        if (!overlayRef.current && !current.selectingCommentLocation) return;
        const objects = current.selectingCommentLocation
          ? []
          : (overlayRef.current?.pickMultipleObjects({
              x: event.point.x,
              y: event.point.y,
              radius: 3,
              depth: 3,
              // Apply this before picking so a path cannot consume the depth budget
              // or intercept placement during the layer-update transition.
              layerIds: current.placingBuilding
                ? ["mapped-parks", "road-surfaces", "buildings"]
                : [
                    "mapped-parks",
                    "road-surfaces",
                    "road-footways",
                    "buildings",
                  ],
            }) ?? []);
        const feature = objects.find(
          (item: { object?: { id?: string } }) =>
            typeof item.object?.id === "string",
        )?.object as { id: string } | undefined;
        dispatchMapClick(
          [event.lngLat.lng, event.lngLat.lat],
          feature?.id,
          current,
        );
      });
      map.on("webglcontextlost", () => {
        contextLost = true;
        if (propsRef.current.exportMode) {
          exportDrawRef.current.error =
            "The 3D graphics context was lost. No reduced-detail export was accepted.";
          exportFenceRef.current?.cancel(exportDrawRef.current.error);
          return;
        }
        updateCameraReadiness();
        setError(
          "Graphics paused. Your scenario is safe. Restore the view or use the feature list.",
        );
        setReducedGraphics(true);
      });
      map.on("webglcontextrestored", () => {
        contextLost = false;
        setError(null);
        setReady(true);
        updateCameraReadiness();
      });
      map.on("error", (event) => {
        if (propsRef.current.exportMode) {
          exportDrawRef.current.error =
            event.error?.message ?? "Export map rendering failed.";
          exportFenceRef.current?.cancel(exportDrawRef.current.error);
        }
        console.warn("Map renderer:", event.error?.message);
        if (!map.isStyleLoaded())
          setError(
            "The geographic view could not load. Your scenario is still available in the feature list.",
          );
      });
      const observer = new ResizeObserver(() =>
        map.resize({ urbanCameraResize: true }),
      );
      observer.observe(host);
      return () => {
        exportFenceRef.current?.cancel();
        exportFenceRef.current = null;
        if (propsRef.current.exportMode)
          propsRef.current.exportMode.rendererRef.current = null;
        observer.disconnect();
        cameraController.dispose();
        cameraControllerRef.current = null;
        for (const { marker } of reviewMarkersRef.current.values())
          marker.remove();
        reviewMarkersRef.current.clear();
        overlayRef.current = null;
        map.remove();
        mapRef.current = null;
      };
    } catch (cause) {
      exportDrawRef.current.error =
        cause instanceof Error
          ? cause.message
          : "The export graphics device could not start.";
      setError(
        cause instanceof Error
          ? cause.message
          : "WebGL could not start. Use the accessible feature list to continue.",
      );
    }
  }, [place.id, retry]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const styleKey = `${view}:${night}`,
      pitchKey = `${view}:${reducedGraphics}`;
    if (styleKeyRef.current !== styleKey) {
      cameraControllerRef.current?.setReady(false);
      mapRef.current.setStyle(styleFor(view, night));
      styleKeyRef.current = styleKey;
    }
    if (pitchKeyRef.current !== pitchKey) {
      const command = propsRef.current.cameraCommand;
      // A newly selected stop owns its pitch; do not race it with the view default.
      if (
        !propsRef.current.exportMode &&
        (!command || cameraControllerRef.current?.hasSeen(command.requestId))
      )
        mapRef.current.easeTo({
          pitch:
            view === "2d" || reducedGraphics
              ? 0
              : Math.min(53, cameraEnvironmentRef.current.limits.maxPitch),
          duration: reducedMotion ? 0 : 650,
        });
      pitchKeyRef.current = pitchKey;
    }
  }, [view, night, ready, reducedGraphics, reducedMotion]);

  useEffect(() => {
    const map = mapRef.current;
    const limits = cameraEnvironmentRef.current.limits;
    if (!map || !cameraLimitsValid(limits)) return;
    if (
      map.getMinZoom() === limits.minZoom &&
      map.getMaxZoom() === limits.maxZoom &&
      map.getMaxPitch() === limits.maxPitch
    )
      return;
    cameraControllerRef.current?.cancel("The supported camera limits changed.");
    // Expand first so switching disjoint zoom ranges never violates MapLibre's setter guards.
    map.setMinZoom(Math.min(map.getMinZoom(), limits.minZoom));
    map.setMaxZoom(limits.maxZoom);
    map.setMinZoom(limits.minZoom);
    map.setMaxPitch(limits.maxPitch);
  }, [
    ready,
    props.cameraLimits?.minZoom,
    props.cameraLimits?.maxZoom,
    props.cameraLimits?.maxPitch,
    place.id,
  ]);

  useEffect(() => {
    cameraControllerRef.current?.request(props.cameraCommand);
  }, [ready, props.cameraCommand?.requestId]);

  useEffect(() => {
    const capture = props.cameraCaptureRef;
    if (!capture) return;
    capture.current = () => cameraControllerRef.current?.capture() ?? null;
    return () => {
      capture.current = null;
    };
  }, [props.cameraCaptureRef]);

  useEffect(() => {
    const map = mapRef.current,
      camera = props.camera;
    if (!ready || !map || !camera) return;
    const center = map.getCenter();
    if (
      Math.abs(center.lng - camera.center[0]) +
        Math.abs(center.lat - camera.center[1]) >
        1e-8 ||
      Math.abs(map.getZoom() - camera.zoom) > 1e-6 ||
      Math.abs(map.getPitch() - camera.pitch) > 1e-6 ||
      Math.abs(map.getBearing() - camera.bearing) > 1e-6
    )
      map.jumpTo(camera);
  }, [ready, props.camera]);

  useEffect(() => {
    const map = mapRef.current,
      focus = props.focusLocation;
    if (!ready || !map || !focus || !pointInStudyArea(focus.position, place))
      return;
    if (
      appliedFocusRef.current?.map === map &&
      appliedFocusRef.current.requestId === focus.requestId
    )
      return;
    appliedFocusRef.current = { map, requestId: focus.requestId };
    map.easeTo({ center: focus.position, duration: reducedMotion ? 0 : 500 });
  }, [ready, props.focusLocation, place, reducedMotion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const pins = reviewPinsForPlace(
      reveal ||
        props.roadDraft ||
        props.parcelDraft ||
        props.buildingDraft ||
        props.neighborhoodDraft
        ? []
        : (props.reviewPins ?? []),
      place,
    );
    const present = new Set(pins.map((pin) => pin.id));
    for (const [id, entry] of reviewMarkersRef.current) {
      if (!present.has(id)) {
        entry.marker.remove();
        reviewMarkersRef.current.delete(id);
      }
    }
    for (const pin of pins) {
      let entry = reviewMarkersRef.current.get(pin.id);
      if (!entry) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "city-review-pin";
        button.dataset.reviewPinId = pin.id;
        const face = document.createElement("span");
        face.className = "city-review-pin-face";
        face.setAttribute("aria-hidden", "true");
        // Static icon only; user-authored labels are assigned as text, never HTML.
        face.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/><path d="M8 11h8M8 14h5"/></svg>';
        const label = document.createElement("span");
        label.className = "city-review-pin-label";
        label.setAttribute("aria-hidden", "true");
        button.append(face, label);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (
            !propsRef.current.selectingCommentLocation &&
            !propsRef.current.neighborhoodDraft &&
            !propsRef.current.buildingDraft &&
            !propsRef.current.roadDraft &&
            !propsRef.current.parcelDraft &&
            !propsRef.current.revealScenario
          )
            propsRef.current.onReviewPinSelect?.(pin.id);
        });
        button.addEventListener("pointerdown", (event) =>
          event.stopPropagation(),
        );
        button.addEventListener("mousedown", (event) =>
          event.stopPropagation(),
        );
        button.addEventListener("dblclick", (event) => event.stopPropagation());
        button.addEventListener("keydown", (event) => event.stopPropagation());
        button.addEventListener("keyup", (event) => event.stopPropagation());
        entry = {
          button,
          label,
          marker: new maplibregl.Marker({
            element: button,
            anchor: "bottom",
            pitchAlignment: "viewport",
            rotationAlignment: "viewport",
          })
            .setLngLat(pin.position)
            .addTo(map),
        };
        reviewMarkersRef.current.set(pin.id, entry);
      }
      const position = entry.marker.getLngLat();
      if (position.lng !== pin.position[0] || position.lat !== pin.position[1])
        entry.marker.setLngLat(pin.position);
      const selected = props.selectedReviewPinId === pin.id;
      entry.button.classList.toggle("is-selected", selected);
      entry.button.classList.toggle("is-resolved", !!pin.resolved);
      entry.button.setAttribute("aria-pressed", String(selected));
      entry.button.setAttribute(
        "aria-label",
        `Review pin: ${pin.label}${pin.resolved ? " · Resolved" : ""}`,
      );
      entry.button.title = `${pin.label}${pin.resolved ? " · Resolved" : ""}`;
      entry.label.textContent = pin.label;
      const disabled =
        !!props.selectingCommentLocation || !reviewPinsInteractive;
      entry.button.setAttribute("aria-disabled", String(disabled));
      entry.button.tabIndex = disabled ? -1 : 0;
      entry.button.style.pointerEvents = disabled ? "none" : "auto";
    }
  }, [
    ready,
    props.reviewPins,
    props.selectedReviewPinId,
    reviewPinsInteractive,
    reveal,
    props.selectingCommentLocation,
    props.roadDraft,
    props.parcelDraft,
    props.buildingDraft,
    props.neighborhoodDraft,
    place,
  ]);

  useEffect(() => {
    if (
      props.selectingCommentLocation ||
      reveal ||
      props.roadDraft ||
      props.parcelDraft ||
      props.buildingDraft ||
      props.neighborhoodDraft ||
      props.neighborhoodSelectionEnabled ||
      props.parcelSelectionEnabled
    )
      setHover(null);
  }, [
    props.selectingCommentLocation,
    reveal,
    props.roadDraft,
    props.parcelDraft,
    props.buildingDraft,
    props.neighborhoodDraft,
    props.parcelSelectionEnabled,
    props.neighborhoodSelectionEnabled,
  ]);

  const setLayers = useCallback(
    (staticLayers: Layer[], buffers: VehicleBuffers | null) => {
      if (!overlayRef.current) return;
      const vehicleLayer = (
        buffers: VehicleBuffers | null,
        id: string,
      ): Layer[] =>
        buffers && buffers.count && propsRef.current.layers.includes("agents")
          ? [
              new IconLayer({
                id,
                data: {
                  length: buffers.count,
                  attributes: {
                    getPosition: { value: buffers.positions, size: 3 },
                    getAngle: { value: buffers.angles, size: 1 },
                  },
                },
                iconAtlas: carIconAtlas,
                iconMapping: carIconMapping,
                getIcon: (_, { index }) => buffers.icons[index],
                getSize: 4.8,
                sizeUnits: "meters",
                sizeMinPixels: 0,
                sizeMaxPixels: 48,
                billboard: false,
                pickable: false,
                parameters: { depthWriteEnabled: false },
              }),
            ]
          : [];
      const allLayers = [
        ...staticLayers,
        ...vehicleLayer(buffers, "illustrative-vehicles"),
        ...vehicleLayer(
          buffers ? beforeBuffersRef.current : null,
          "before-illustrative-vehicles",
        ),
        ...(!propsRef.current.neighborhoodDraft &&
        !propsRef.current.buildingDraft &&
        !propsRef.current.parcelDraft &&
        canEditRoadDraft(propsRef.current)
          ? roadDraftLayersRef.current
          : []),
        ...(!propsRef.current.neighborhoodDraft &&
        !propsRef.current.buildingDraft &&
        canEditParcelDraft(propsRef.current)
          ? parcelDraftLayersRef.current
          : []),
        ...(canDisplayNeighborhoodDraft(propsRef.current)
          ? neighborhoodDraftLayersRef.current
          : []),
        ...(canDisplayBuildingDraft(propsRef.current)
          ? buildingDraftLayersRef.current
          : []),
      ];
      overlayRef.current.setProps({
        layers: propsRef.current.revealScenario
          ? clipRevealLayers(allLayers, revealPercentRef.current)
          : allLayers,
      });
      exportDrawRef.current.layers++;
    },
    [],
  );

  const activeBuffersRef = useRef<VehicleBuffers | null>(vehicleBuffers);
  activeBuffersRef.current = reducedGraphics ? null : vehicleBuffers;
  const renderRoadDraftLayers = useCallback(
    (draftLayers: Layer[]) => {
      roadDraftLayersRef.current = draftLayers;
      setLayers(staticLayersRef.current, activeBuffersRef.current);
    },
    [setLayers],
  );
  const roadDraftNotice = useRoadDrawing({
    ...props,
    ready:
      ready &&
      !props.parcelDraft &&
      !props.buildingDraft &&
      !props.neighborhoodDraft,
    mapRef,
    roads,
    renderLayers: renderRoadDraftLayers,
  });
  const renderParcelDraftLayers = useCallback(
    (draftLayers: Layer[]) => {
      parcelDraftLayersRef.current = draftLayers;
      setLayers(staticLayersRef.current, activeBuffersRef.current);
    },
    [setLayers],
  );
  const parcelDraftNotice = useParcelDrawing({
    ...props,
    ready:
      ready &&
      !!props.parcelDraft &&
      !props.roadDraft &&
      !props.buildingDraft &&
      !props.neighborhoodDraft,
    mapRef,
    parcels,
    maxRingPoints: MAX_AUTHORED_PARCEL_RING_POINTS,
    renderLayers: renderParcelDraftLayers,
  });

  const renderBuildingDraftLayers = useCallback(
    (draftLayers: Layer[]) => {
      buildingDraftLayersRef.current = draftLayers;
      setLayers(staticLayersRef.current, activeBuffersRef.current);
    },
    [setLayers],
  );
  const buildingDraftNotice = useBuildingDrawing({
    ...props,
    ready:
      ready &&
      !!props.buildingDraft &&
      !props.roadDraft &&
      !props.parcelDraft &&
      !props.neighborhoodDraft,
    mapRef,
    buildings,
    reducedGraphics,
    renderLayers: renderBuildingDraftLayers,
  });

  const renderNeighborhoodDraftLayers = useCallback(
    (draftLayers: Layer[]) => {
      neighborhoodDraftLayersRef.current = draftLayers;
      setLayers(staticLayersRef.current, activeBuffersRef.current);
    },
    [setLayers],
  );
  const neighborhoodDraftNotice = useNeighborhoodDrawing({
    ...props,
    ready:
      ready &&
      !!props.neighborhoodDraft &&
      !props.roadDraft &&
      !props.parcelDraft &&
      !props.buildingDraft,
    mapRef,
    place,
    renderLayers: renderNeighborhoodDraftLayers,
  });

  useEffect(() => {
    if (!ready || !overlayRef.current) return;
    const roadBaseColor: [number, number, number, number] = night
      ? [101, 115, 111, 255]
      : [172, 177, 167, 255];
    const showUse = layers.includes("land-use") || layers.includes("Land use");
    const showNetwork =
      layers.includes("traffic") || layers.includes("mobility");
    const ambient = new AmbientLight({
      color: night ? [167, 187, 207] : [255, 244, 222],
      intensity: night ? 0.7 : 0.85,
    });
    const sun = new DirectionalLight({
      color: night ? [184, 203, 228] : [255, 237, 202],
      intensity: night ? 0.75 : 1.05,
      direction: [-3, -4, -7],
    });
    const lighting = new LightingEffect({ ambient, sun });
    lighting.shadowColor = [0.18, 0.24, 0.19, 0.2];
    overlayRef.current.setProps({ effects: [lighting] });
    const sharedLayers: Layer[] = [
      new PolygonLayer<Polygon[]>({
        id: "reference-area",
        data: studyAreaPolygons(place),
        getPolygon: (d) => d,
        getFillColor:
          view === "satellite"
            ? [230, 229, 210, 0]
            : night
              ? [59, 77, 70, 255]
              : [223, 226, 210, 255],
        stroked: false,
        pickable: false,
      }),
    ];
    const scenarioLayers = (
      buildings: BuildingMapPart[],
      roads: Road[],
      parcelParts: ParcelMapPart[],
      streetLabels: StreetLabel[],
      scenario: Scenario,
      before: boolean,
    ): Layer[] => {
      const visibleBuildings = before
        ? buildings
        : buildings.filter((part) => part.id !== replacingDraftBuildingId);
      const parks = visibleBuildings.filter(
        (part) => part.building.use === "park",
      );
      const solids = visibleBuildings.filter(
        (part) =>
          part.building.use !== "park" && part.building.use !== "vacant",
      );
      const selected = before
        ? []
        : visibleBuildings.filter((part) => part.id === selectedId);
      const neighborhoods = scenario.activity?.neighborhoods ?? [];
      const neighborhoodParts = neighborhoodMapParts(
        neighborhoods.filter(
          (area) =>
            before || area.id !== props.neighborhoodDraft?.neighborhoodId,
        ),
      );
      const selectedNeighborhood = before
        ? undefined
        : neighborhoods.find(
            (area) => area.id === props.selectedNeighborhoodId,
          );
      const neighborhoodSummary = before
        ? undefined
        : props.neighborhoodSummaries?.find(
            (summary) => summary.id === props.selectedNeighborhoodId,
          );
      const items: Layer[] = [
        new PolygonLayer<FloodMapPart>({
          id: "captured-flood-zones",
          data: floodParts,
          visible: layers.includes("flood"),
          getPolygon: (part) => part.rings,
          getFillColor: floodMapColor,
          getLineColor: (part) => {
            const c = floodMapColor(part);
            return [c[0], c[1], c[2], 160];
          },
          getLineWidth: 1,
          lineWidthUnits: "pixels",
          stroked: true,
          pickable: false,
          getPolygonOffset: ({ layerIndex }) => [-1, -layerIndex * 100],
          parameters: { depthCompare: "less-equal", depthWriteEnabled: false },
        }),
        new PolygonLayer<NeighborhoodMapPart>({
          id: "neighborhoods",
          data: neighborhoodParts,
          visible: layers.includes("neighborhoods"),
          getPolygon: neighborhoodSurfaceRings,
          getFillColor: (part) =>
            part.neighborhoodId === props.selectedNeighborhoodId && !before
              ? [40, 132, 147, 70]
              : [40, 132, 147, 32],
          getLineColor: [27, 104, 118, 220],
          getLineWidth: (part) =>
            part.neighborhoodId === props.selectedNeighborhoodId && !before
              ? 3
              : 1.5,
          lineWidthUnits: "pixels",
          stroked: true,
          pickable: !before && neighborhoodPickable,
          getPolygonOffset: ({ layerIndex }) => [-1, -layerIndex * 100],
          parameters: { depthCompare: "less-equal", depthWriteEnabled: false },
        }),
        new TextLayer({
          id: "selected-neighborhood-label",
          data: selectedNeighborhood ? [selectedNeighborhood] : [],
          visible: layers.includes("neighborhoods") && !props.neighborhoodDraft,
          getPosition: (area) => [...studyAreaAnchor(area.geometry), 0.2],
          getText: (area) =>
            [
              area.name,
              neighborhoodSummary?.populationLabel,
              neighborhoodSummary?.employmentLabel,
              neighborhoodSummary?.statusLabel,
            ]
              .filter(Boolean)
              .join("\n"),
          getSize: 12,
          getColor: [20, 77, 88, 255],
          background: true,
          getBackgroundColor: [255, 255, 246, 225],
          backgroundPadding: [7, 5],
          fontFamily: props.exportMode ? "UrbanMedia" : "Arial, sans-serif",
          fontWeight: 600,
          pickable: false,
          parameters: { depthCompare: "less-equal", depthWriteEnabled: false },
        }),
        new PolygonLayer<ParcelMapPart>({
          id: "parcels",
          visible: layers.includes("parcels"),
          data: parcelParts,
          getPolygon: parcelSurfaceRings,
          getFillColor: (part) =>
            part.kind === "block" ? [175, 144, 88, 25] : [78, 144, 130, 22],
          getLineColor: (part) =>
            part.kind === "block" ? [164, 124, 58, 220] : [47, 122, 108, 220],
          getLineWidth: (part) => (part.kind === "block" ? 2 : 1),
          lineWidthUnits: "pixels",
          stroked: true,
          pickable: !before && parcelPickable,
          // Flat fills/strokes otherwise compete with the study-area ground at
          // tilted cameras. Keep depth testing, but let later roads/parks and
          // buildings cover this translucent annotation, including in 2D.
          getPolygonOffset: ({ layerIndex }) => [-1, -layerIndex * 100],
          parameters: { depthCompare: "less-equal", depthWriteEnabled: false },
        }),
        new PolygonLayer<ParcelMapPart>({
          id: "selected-parcels",
          visible: layers.includes("parcels"),
          data: before
            ? []
            : parcelParts.filter((part) => selectedParcels.has(part.parcelId)),
          getPolygon: parcelSurfaceRings,
          getFillColor: [235, 187, 78, 38],
          getLineColor: [171, 119, 28, 255],
          getLineWidth: 3,
          lineWidthUnits: "pixels",
          stroked: true,
          pickable: false,
          getPolygonOffset: ({ layerIndex }) => [-1, -layerIndex * 100],
          parameters: { depthCompare: "less-equal", depthWriteEnabled: false },
        }),
        new PolygonLayer<BuildingMapPart>({
          id: "mapped-parks",
          visible: layers.includes("parks"),
          data: parks,
          getPolygon: (part) => part.rings,
          getFillColor: night ? [73, 104, 78, 255] : [157, 183, 136, 255],
          getElevation: 0.12,
          extruded: true,
          stroked: false,
          pickable: true,
        }),
        new PathLayer<Road>({
          id: "road-sidewalks",
          ...roadSurfaceDepth,
          visible: layers.includes("roads"),
          data: roads.filter((road) => !footways.has(road.kind)),
          getPath: (road) => roadSurfacePath(road, "sidewalk"),
          getColor: night ? [128, 133, 119, 255] : [244, 238, 218, 255],
          getWidth: (d) =>
            d.kind === "service" ? 5 : Math.max(6, d.lanes * 3.2 + 5),
          widthMinPixels: 1,
          jointRounded: true,
          capRounded: true,
          pickable: false,
        }),
        new PathLayer<Road>({
          id: "road-footways",
          ...roadSurfaceDepth,
          visible: layers.includes("roads"),
          data: roads.filter((road) => footways.has(road.kind)),
          getPath: (road) => roadSurfacePath(road, "carriageway"),
          getColor: night ? [128, 133, 119, 255] : [244, 238, 218, 255],
          getWidth: 1.8,
          widthMinPixels: 1,
          jointRounded: true,
          capRounded: true,
          pickable: !props.placingBuilding,
        }),
        new PathLayer<Road>({
          id: "road-surfaces",
          ...roadSurfaceDepth,
          visible: layers.includes("roads"),
          data: roads.filter((r) => !footways.has(r.kind)),
          getPath: (road) => roadSurfacePath(road, "carriageway"),
          getColor: (d) =>
            d.closed
              ? [191, 104, 84, 255]
              : d.bikeLane && showNetwork
                ? [105, 155, 128, 255]
                : roadBaseColor,
          getWidth: (d) =>
            d.kind === "service" ? 3.4 : Math.max(4, d.lanes * 3.2),
          widthMinPixels: 1,
          jointRounded: true,
          capRounded: true,
          pickable: true,
        }),
        new PathLayer<Road>({
          id: "selected-street",
          ...roadSurfaceDepth,
          visible: layers.includes("roads"),
          data: before ? [] : roads.filter((road) => road.id === selectedId),
          getPath: (road) => roadSurfacePath(road, "selection"),
          getColor: [34, 126, 103, 230],
          getWidth: (road) => Math.max(4, road.lanes * 3.2),
          widthMinPixels: 4,
          capRounded: true,
          jointRounded: true,
          pickable: false,
        }),
        new PathLayer<Road>({
          id: "road-markings",
          ...roadSurfaceDepth,
          visible: layers.includes("roads"),
          data: roads.filter(
            (r) =>
              ["primary", "secondary", "tertiary"].includes(r.kind) &&
              !r.closed,
          ),
          getPath: (road) => roadSurfacePath(road, "marking"),
          getColor: night ? [166, 171, 148, 130] : [242, 233, 191, 180],
          getWidth: 0.24,
          widthMinPixels: 0.4,
          pickable: false,
        }),
        new PolygonLayer<BuildingMapPart>({
          id: "buildings",
          visible: layers.includes("buildings"),
          data: solids,
          getPolygon: buildingSurfaceRings,
          extruded: view !== "2d" && !reducedGraphics,
          getElevation: (part) => safeDraftHeight(part.building.height),
          getFillColor: ({ building: d }) => {
            if (!before && d.id === selectedId) return [57, 137, 116, 255];
            if (scenario.buildingEdits[d.id]) return [108, 163, 137, 255];
            const c = landUseColors[d.use] ?? [205, 195, 170];
            if (showUse) return [...c, 255];
            const variation =
              ((Number(d.id.replace(/\D/g, "").slice(-3)) % 5) - 2) * 5;
            return [
              Math.min(250, c[0] + 15 + variation),
              Math.min(240, c[1] + 16 + variation),
              Math.min(220, c[2] + 13 + variation),
              255,
            ];
          },
          stroked: view === "2d",
          getLineColor: [148, 145, 124, 180],
          getLineWidth: 0.7,
          lineWidthMinPixels: 0.5,
          material: {
            ambient: 0.42,
            diffuse: 0.62,
            shininess: 16,
            specularColor: [20, 20, 20],
          },
          pickable: true,
          autoHighlight: true,
          highlightColor: [242, 214, 139, 80],
          updateTriggers: {
            getFillColor: [selectedId, scenario.revision, showUse],
            getElevation: scenario.revision,
          },
          onHover: (info) =>
            setHover(
              info.object &&
                !propsRef.current.selectingCommentLocation &&
                !propsRef.current.roadDraft &&
                !propsRef.current.parcelDraft &&
                !propsRef.current.neighborhoodDraft &&
                !propsRef.current.buildingDraft &&
                !propsRef.current.parcelSelectionEnabled &&
                !propsRef.current.neighborhoodSelectionEnabled &&
                !propsRef.current.revealScenario
                ? { x: info.x, y: info.y, building: info.object.building }
                : null,
            ),
        }),
        new PolygonLayer<BuildingMapPart>({
          id: "comparison-massing",
          visible: layers.includes("buildings"),
          data: reveal || before ? [] : comparisonBuildingParts,
          getPolygon: buildingSurfaceRings,
          getElevation: (part) => safeDraftHeight(part.building.height),
          extruded: view !== "2d" && !reducedGraphics,
          getFillColor: [184, 117, 76, 35],
          getLineColor: [184, 117, 76, 150],
          getLineWidth: 1,
          lineWidthMinPixels: 1,
          wireframe: true,
          stroked: true,
          pickable: false,
        }),
        new PathLayer<BuildingMapRing>({
          id: "roof-lines",
          visible: layers.includes("buildings"),
          data: buildingMapRings(solids),
          getPath: (ring) =>
            buildingRoofPath(ring, reducedGraphics || view === "2d"),
          getColor: (d) =>
            !before && d.id === selectedId
              ? [209, 240, 218, 240]
              : d.building.height === null
                ? [68, 111, 101, 240]
                : [247, 240, 217, 150],
          getWidth: 0.45,
          widthMinPixels: 0.4,
          opacity: reducedGraphics ? 0.3 : 0.7,
          pickable: false,
        }),
        new PolygonLayer<BuildingMapPart>({
          id: "selected-footprint",
          visible: layers.includes("buildings"),
          data: selected,
          getPolygon: buildingOutlineRings,
          filled: false,
          stroked: true,
          getLineColor: [18, 102, 80, 255],
          getLineWidth: 2,
          lineWidthMinPixels: 2,
          parameters: { depthCompare: "less-equal", depthWriteEnabled: false },
          pickable: false,
        }),
        new TextLayer<StreetLabel>({
          id: "street-labels",
          data: streetLabels,
          getPosition: (d) => [d.position[0], d.position[1], 0.5],
          getText: (d) => d.name.toUpperCase(),
          getColor: night ? [204, 211, 197, 230] : [96, 111, 97, 235],
          getSize: 10,
          sizeUnits: "pixels",
          getAngle: (d) => d.angle,
          billboard: false,
          fontFamily: props.exportMode ? "UrbanMedia" : "Arial, sans-serif",
          fontWeight: 600,
          fontSettings: { sdf: true },
          characterSet: "auto",
          background: false,
          outlineWidth: 2,
          outlineColor: night ? [59, 77, 70, 100] : [232, 233, 219, 190],
          pickable: false,
          visible: layers.includes("roads") && zoom > 14.7,
        }),
      ];
      return before
        ? items.map((layer) => layer.clone({ id: `before-${layer.id}` }))
        : items;
    };
    const staticLayers = [
      ...sharedLayers,
      ...(props.revealScenario
        ? scenarioLayers(
            beforeBuildingParts,
            beforeRoads,
            beforeParcelParts,
            beforeLabels,
            props.revealScenario,
            true,
          )
        : []),
      ...scenarioLayers(
        buildingParts,
        roads,
        parcelParts,
        streetLabels,
        scenario,
        false,
      ),
    ];
    staticLayersRef.current = staticLayers;
    updateVehicleBuffers(vehicleBuffers, agents, elapsedRef.current);
    updateVehicleBuffers(
      beforeVehicleBuffers,
      beforeAgents,
      elapsedRef.current,
    );
    setLayers(staticLayers, reducedGraphics ? null : vehicleBuffers);
    exportDrawRef.current.zoom = zoom;
    exportDrawRef.current.view = view;
  }, [
    ready,
    buildings,
    comparisonBuildingParts,
    beforeBuildingParts,
    buildingParts,
    replacingDraftBuildingId,
    beforeRoads,
    parcelParts,
    beforeParcelParts,
    beforeLabels,
    beforeVehicleBuffers,
    beforeAgents,
    floodParts,
    props.revealScenario,
    props.placingBuilding,
    parcelPickable,
    neighborhoodPickable,
    props.selectedNeighborhoodId,
    props.neighborhoodSummaries,
    props.neighborhoodDraft,
    selectedParcels,
    reveal,
    roads,
    agents,
    vehicleBuffers,
    selectedId,
    place,
    scenario.buildingEdits,
    scenario.revision,
    view,
    layers,
    night,
    reducedGraphics,
    streetLabels,
    zoom,
    setLayers,
  ]);

  useEffect(() => {
    if (ready && reveal)
      setLayers(
        staticLayersRef.current,
        reducedGraphics ? null : vehicleBuffers,
      );
  }, [
    ready,
    reveal,
    revealPercent,
    reducedGraphics,
    vehicleBuffers,
    setLayers,
  ]);

  useEffect(() => {
    if (
      !ready ||
      !playing ||
      reducedMotion ||
      reducedGraphics ||
      !showAgents ||
      (!agents.length && !beforeAgents.length)
    )
      return;
    let frame = 0,
      last = performance.now(),
      lastDraw = 0;
    const animate = (now: number) => {
      elapsedRef.current +=
        Math.min(0.12, (now - last) / 1000) * Math.min(speed, 60);
      last = now;
      if (now - lastDraw > 40) {
        updateVehicleBuffers(vehicleBuffers, agents, elapsedRef.current);
        updateVehicleBuffers(
          beforeVehicleBuffers,
          beforeAgents,
          elapsedRef.current,
        );
        setLayers(staticLayersRef.current, vehicleBuffers);
        lastDraw = now;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [
    ready,
    playing,
    speed,
    showAgents,
    reducedMotion,
    reducedGraphics,
    agents,
    vehicleBuffers,
    beforeAgents,
    beforeVehicleBuffers,
    setLayers,
  ]);

  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = async () => {
      assertRoadDraftCaptureAllowed(propsRef.current.roadDraft);
      assertParcelDraftCaptureAllowed(propsRef.current.parcelDraft);
      assertBuildingDraftCaptureAllowed(propsRef.current.buildingDraft);
      assertNeighborhoodDraftCaptureAllowed(propsRef.current.neighborhoodDraft);
      const map = mapRef.current;
      if (!map || !ready) throw new Error("The map is not ready");
      // Discard/apply can precede the drawing controller's next animation frame.
      // Clear any remaining preview before the capture's guaranteed fresh render.
      if (
        roadDraftLayersRef.current.length ||
        parcelDraftLayersRef.current.length ||
        buildingDraftLayersRef.current.length ||
        neighborhoodDraftLayersRef.current.length
      ) {
        roadDraftLayersRef.current = [];
        parcelDraftLayersRef.current = [];
        buildingDraftLayersRef.current = [];
        neighborhoodDraftLayersRef.current = [];
        setLayers(staticLayersRef.current, activeBuffersRef.current);
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = window.setTimeout(() => {
          map.off("render", finish);
          reject(
            new Error(
              "Map capture timed out. Restore the geographic view and retry.",
            ),
          );
        }, 8000);
        map.once("render", finish);
        map.triggerRepaint();
      });
      const current = propsRef.current;
      assertRoadDraftCaptureAllowed(current.roadDraft);
      assertParcelDraftCaptureAllowed(current.parcelDraft);
      assertBuildingDraftCaptureAllowed(current.buildingDraft);
      assertNeighborhoodDraftCaptureAllowed(current.neighborhoodDraft);
      return captureMapImage(map.getCanvas(), {
        scenarioName: current.scenario.name,
        revision: current.scenario.revision,
        reveal: current.revealScenario
          ? {
              scenarioName: current.revealScenario.name,
              revision: current.revealScenario.revision,
              percent: revealPercentRef.current,
            }
          : undefined,
        flood:
          current.layers.includes("flood") &&
          current.scenario.flood &&
          current.floodDatasets?.[current.scenario.flood.datasetHash]
            ? {
                hash: current.scenario.flood.datasetHash,
                imported: current.scenario.flood.origin === "imported",
                capturedAt:
                  current.floodDatasets[current.scenario.flood.datasetHash]
                    .capturedAt,
              }
            : undefined,
        extentLabel: current.place.extentLabel,
        censusBoundaryVintage: current.place.geography?.boundaryVintage,
        satellite: current.view === "satellite",
        imageryAttribution: imagery.attribution,
      });
    };
    return () => {
      captureRef.current = null;
    };
  }, [captureRef, ready, setLayers]);

  const reset = () => {
    if (place.studyArea) {
      mapRef.current?.fitBounds(studyAreaBounds(place), {
        padding: 70,
        maxZoom: 16,
        bearing: -27,
        pitch: view === "2d" || reducedGraphics ? 0 : 53,
        duration: reducedMotion ? 0 : 900,
      });
      return;
    }
    mapRef.current?.flyTo({
      center: pointInStudyArea(place.center, place)
        ? place.center
        : studyAreaAnchor(place),
      zoom: 15.8,
      bearing: -27,
      pitch: view === "2d" || reducedGraphics ? 0 : 53,
      duration: reducedMotion ? 0 : 900,
    });
  };
  if (props.exportMode)
    return (
      <div
        className="city-map city-map-export"
        role="img"
        aria-label={`Frozen geographic view of ${place.extentLabel}`}
      >
        <div className="city-map-canvas" ref={hostRef} />
      </div>
    );
  return (
    <div
      className={`city-map ${night ? "city-map-night" : ""} ${props.selectingCommentLocation ? "city-map-selecting-comment" : ""} ${!props.parcelDraft && canEditRoadDraft(props) ? "city-map-drawing-street" : ""} ${canEditParcelDraft(props) ? "city-map-drawing-parcel" : ""} ${canEditBuildingDraft(props) ? "city-map-drawing-building" : ""} ${canEditNeighborhoodDraft(props) ? "city-map-drawing-neighborhood" : ""}`}
      role="region"
      aria-label={`Geographic view of ${place.extentLabel}`}
    >
      <div className="city-map-canvas" ref={hostRef} />
      {layers.includes("flood") && floodParts.length > 0 && (
        <div className="flood-map-legend">
          {props.scenario.flood?.origin === "imported" && (
            <small>Imported flood evidence · not server verified</small>
          )}
          <FloodLegend />
        </div>
      )}
      {props.neighborhoodDraft && props.neighborhoodEditingEnabled && (
        <div className="city-neighborhood-drawing-help">
          <strong>
            {props.neighborhoodDraft.busy
              ? "Calculating the neighborhood boundary"
              : !canEditNeighborhoodDraft(props)
                ? "Neighborhood editing paused"
                : props.neighborhoodDraft.mode === "pan"
                  ? "Move the map"
                  : props.neighborhoodDraft.mode === "paint"
                    ? "Paint a neighborhood"
                    : props.neighborhoodDraft.mode === "erase"
                      ? "Erase from this neighborhood"
                      : "Edit the neighborhood boundary"}
          </strong>
          <span>
            {["paint", "erase"].includes(props.neighborhoodDraft.mode)
              ? "Drag or click with the brush. Study boundaries and other neighborhoods are excluded; red areas show the last excluded portion."
              : props.neighborhoodDraft.mode === "pan"
                ? "Drag to pan; switch back to a drawing tool to edit."
                : "Click to add or move points, or drag a numbered vertex. Exact coordinates are in the editor."}
          </span>
          <small>
            Map focused: Enter applies · Escape cancels the stroke or discards ·
            Delete removes the selected point.
          </small>
          <span role="status" aria-live="polite">
            {neighborhoodDraftNotice}
          </span>
        </div>
      )}
      {props.buildingDraft && props.buildingEditingEnabled && (
        <div className="city-building-drawing-help">
          <strong>
            {!canEditBuildingDraft(props)
              ? "Building editing paused"
              : props.buildingDraft.mode === "move"
                ? "Move the whole building"
                : props.buildingDraft.mode === "rotate"
                  ? "Rotate the whole building"
                  : props.buildingDraft.mode === "draw"
                    ? "Draw a building footprint"
                    : "Reshape the active building ring"}
          </strong>
          <span>
            {!canEditBuildingDraft(props)
              ? "Return to an editable 2D view to continue."
              : props.buildingDraft.mode === "move"
                ? "Drag the move handle, or click a destination for the pivot. All parts and courtyards move together."
                : props.buildingDraft.mode === "rotate"
                  ? "Drag the rotation handle, or click a direction from the pivot. Rotation is clockwise from north."
                  : "Click to add or move points. Drag a numbered vertex to adjust; other rings remain intact."}
          </span>
          <small>
            Map focused: Enter applies · Escape discards · Delete removes
            selected vertex. Exact controls are in the editor.
          </small>
          <span
            className="city-building-drawing-status"
            role="status"
            aria-live="polite"
          >
            {buildingDraftNotice}
          </span>
        </div>
      )}
      {props.parcelDraft && (
        <div className="city-parcel-drawing-help">
          <strong>
            {!canEditParcelDraft(props)
              ? "Parcel editing paused"
              : props.parcelDraft.operation === "assemble"
                ? "Assemble selected lots"
                : props.parcelDraft.operation === "split"
                  ? "Draw a two-point cut"
                  : props.parcelDraft.operation === "draw"
                    ? "Outline a proposed area"
                    : "Reshape the active ring"}
          </strong>
          <span>
            {!canEditParcelDraft(props)
              ? "Return to an editable 2D view to continue."
              : props.parcelDraft.operation === "assemble"
                ? "Select lots on the map or in the list. Review the combined area before applying."
                : props.parcelDraft.operation === "split"
                  ? "Place two cut points. The line extends through the selected area; colored outputs show the proposed split."
                  : "Only the active ring changes. Holes and other parts remain intact. Drag a numbered point to adjust."}
          </span>
          <small>
            Map focused: Enter finishes · Escape discards · Delete removes
            selected point
          </small>
          <span
            className="city-parcel-drawing-status"
            role="status"
            aria-live="polite"
          >
            {parcelDraftNotice}
          </span>
        </div>
      )}
      {props.roadDraft && (
        <div className="city-street-drawing-help">
          <strong>
            {canEditRoadDraft(props)
              ? props.roadDraft.mode === "draw"
                ? "Draw a street"
                : "Reshape the selected street"
              : "Street drawing paused"}
          </strong>
          <span>
            {canEditRoadDraft(props)
              ? props.roadDraft.mode === "draw"
                ? "Click to add points. Drag a numbered point to adjust."
                : "Select a numbered point, then click or drag to move it."
              : "Return to an editable 2D view to continue."}
          </span>
          <small>
            Map focused: Enter finishes · Escape discards · Delete removes
            selected point
          </small>
          <span
            className="city-street-drawing-status"
            role="status"
            aria-live="polite"
          >
            {roadDraftNotice}
          </span>
        </div>
      )}
      {props.revealScenario && (
        <div
          className="city-map-reveal"
          role="group"
          aria-label="Before and after comparison"
        >
          <div className="city-reveal-labels">
            <span>
              <strong>Before</strong>
              <small
                title={`${props.revealScenario.name} · Revision ${props.revealScenario.revision}`}
              >
                {props.revealScenario.name} · r{props.revealScenario.revision}
              </small>
            </span>
            <span>
              <strong>After</strong>
              <small title={`${scenario.name} · Revision ${scenario.revision}`}>
                {scenario.name} · r{scenario.revision}
              </small>
            </span>
          </div>
          <div
            className="city-reveal-divider"
            aria-hidden="true"
            style={{ left: `${revealPercent}%` }}
          />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={revealPercent}
            onChange={(event) => changeReveal(Number(event.target.value))}
            className="city-reveal-range"
            aria-label="Before / after reveal"
            aria-valuetext={`${Math.round(revealPercent)}% before, ${Math.round(100 - revealPercent)}% after`}
            title="Drag or use arrow keys to reveal before and after"
          />
          <p className="city-reveal-help">
            Comparison view · use the feature list to inspect.
            {!!props.reviewPins?.length && " Review pins hidden."}
          </p>
        </div>
      )}
      {!ready && !error && (
        <div className="city-map-loading" role="status">
          <span className="city-map-loading-orbit" />
          <strong>Bringing your place to life</strong>
          <span>Loading real streets and building footprints</span>
        </div>
      )}
      {error && (
        <div className="city-map-error" role="alert">
          <TriangleAlert size={24} />
          <strong>The map needs a moment</strong>
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            Restore geographic view
          </button>
        </div>
      )}
      <div
        className="city-map-navigation"
        role="group"
        aria-label="Map navigation"
      >
        <button
          type="button"
          onClick={() =>
            mapRef.current?.easeTo({
              bearing: 0,
              duration: reducedMotion ? 0 : 500,
            })
          }
          aria-label="Orient map north"
          title="Orient north"
        >
          <Compass size={19} />
          <small>N</small>
        </button>
        <div className="city-map-zoom">
          <button
            type="button"
            onClick={() => mapRef.current?.zoomIn()}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={19} />
          </button>
          <button
            type="button"
            onClick={() => mapRef.current?.zoomOut()}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={19} />
          </button>
        </div>
        <button
          type="button"
          onClick={reset}
          aria-label="Reset map view"
          title="Reset view"
        >
          <RotateCcw size={17} />
        </button>
      </div>
      <div className="city-map-scale">
        <span />
        <small>
          {zoom > 17 ? "25 m" : zoom > 15.5 ? "100 m" : "250 m"} · approximate
        </small>
      </div>
      <button
        type="button"
        className="city-map-graphics"
        onClick={() => setReducedGraphics((v) => !v)}
      >
        {reducedGraphics ? "Enable 3D detail" : "Reduce graphics"}
      </button>
      {hover && (
        <div
          className="city-map-tooltip"
          style={{
            left: Math.min(
              hover.x + 14,
              (hostRef.current?.clientWidth ?? 500) - 238,
            ),
            top: Math.max(12, hover.y - 75),
          }}
          role="tooltip"
        >
          <strong>
            {hover.building.name.startsWith("Building ")
              ? landUseLabels[hover.building.use]
              : hover.building.name}
          </strong>
          <span>
            {landUseLabels[hover.building.use]} ·{" "}
            {hover.building.floors === null
              ? "Floors unknown"
              : `${hover.building.floors} ${hover.building.floors === 1 ? "floor" : "floors"}`}
            {hover.building.height === null &&
              " · Height unknown; footprint only"}
          </span>
          <small>
            {hover.building.estimated
              ? "Mapped footprint · estimated attributes"
              : "Mapped source attributes"}
          </small>
        </div>
      )}
      <div className="city-map-activity">
        <span
          className={
            playing && !reducedMotion && !reducedGraphics ? "activity-live" : ""
          }
        />
        {reducedGraphics
          ? "Reduced graphics"
          : !layers.includes("agents")
            ? "Activity hidden"
            : `${agents.length} illustrative vehicles`}
      </div>
      <div className="city-map-attribution">
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap
        </a>
        {view === "satellite" && (
          <a href={imagery.creditsUrl} target="_blank" rel="noreferrer">
            {imagery.attribution}
          </a>
        )}
        <details className="city-map-credits">
          <summary>Map credits</summary>
          <div
            className="city-map-credit-panel"
            aria-label="Map source credits"
          >
            <p>
              Streets & footprints:{" "}
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                © OpenStreetMap contributors
              </a>{" "}
              · ODbL 1.0
            </p>
            {layers.includes("flood") && floodParts.length > 0 && (
              <p>
                Flood overlay: captured effective FEMA NFHL. Footprint screening
                only; unmapped areas are unknown.
              </p>
            )}
            {place.geography?.type === "zcta" && (
              <p>
                Study boundary:{" "}
                <a
                  href="https://www.census.gov/"
                  target="_blank"
                  rel="noreferrer"
                >
                  U.S. Census Bureau
                </a>{" "}
                · {place.geography.boundaryVintage} ZCTA · Public data
              </p>
            )}
            {view === "satellite" && (
              <p>
                Imagery:{" "}
                <a
                  href={imagery.creditsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {imagery.attribution}
                </a>
                . Provider terms apply to redistribution.
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
export default CityMap;
