import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { Scan } from "lucide-react";
import {
  studyAreaGeometry,
  type Place,
  type TrafficPlanningRoadChange,
  type TrafficSignal,
} from "@urban/core";
import type {
  TrafficNetwork,
  TrafficCount,
} from "../../../../../packages/core/src/traffic";
import type { FeatureCollection } from "geojson";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { trafficMapForUpdate } from "../../lib/traffic-map-ready";
import { trafficCountReviewBounds } from "../../lib/traffic-count-map";
maplibregl.setWorkerUrl(workerUrl);
const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
const noEdges: readonly string[] = [];

/** Actual directed graph geometry. No tiles, decorative agents or inferred station snaps. */
export default function TrafficNetworkMap({
  place,
  network,
  counts,
  selectedEdgeId,
  onSelectEdge,
  planningChange,
  candidateEdgeIds = noEdges,
  reviewedEdgeIds = noEdges,
  signal,
  signalGroupIndex = null,
  countReview = false,
}: {
  place: Place;
  network: TrafficNetwork;
  counts: readonly TrafficCount[];
  selectedEdgeId: string | null;
  onSelectEdge: (id: string) => void;
  planningChange?: TrafficPlanningRoadChange;
  candidateEdgeIds?: readonly string[];
  reviewedEdgeIds?: readonly string[];
  signal?: TrafficSignal;
  signalGroupIndex?: number | null;
  /** A focused observation-review view; all other map modes keep their existing framing. */
  countReview?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    mapRef = useRef<maplibregl.Map | null>(null);
  const [readyMap, setReadyMap] = useState<maplibregl.Map | null>(null),
    [renderedMap, setRenderedMap] = useState<maplibregl.Map | null>(null),
    [error, setError] = useState("");
  const ready = !!trafficMapForUpdate(mapRef.current, readyMap);
  const rendered = ready && renderedMap === readyMap;
  const current = useRef({
    network,
    onSelectEdge,
    countReview,
    counts,
    selectedEdgeId,
    reviewedEdgeIds,
  });
  current.current = {
    network,
    onSelectEdge,
    countReview,
    counts,
    selectedEdgeId,
    reviewedEdgeIds,
  };
  const signalEdges = useMemo(() => {
    if (!signal) return noEdges;
    const ids = new Set(
      signalGroupIndex === null
        ? signal.connectionIds.flat()
        : (signal.connectionIds[signalGroupIndex] ?? []),
    );
    return [
      ...new Set(
        network.connections
          .filter((value) => ids.has(value.id))
          .flatMap((value) => [value.fromEdge, value.toEdge]),
      ),
    ];
  }, [signal, signalGroupIndex, network]);
  const highlightedEdges = signal ? signalEdges : reviewedEdgeIds;
  const edges = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: network.edges
        .filter((edge) => edge.lanes[0]?.shape.length > 1)
        .map((edge) => ({
          type: "Feature",
          properties: { id: edge.id, from: edge.from, to: edge.to },
          geometry: { type: "LineString", coordinates: edge.lanes[0].shape },
        })),
    }),
    [network],
  );
  const ports = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: network.nodes
        .filter((node) => node.external)
        .map((node) => ({
          type: "Feature",
          properties: { id: node.id },
          geometry: { type: "Point", coordinates: node.position },
        })),
    }),
    [network],
  );
  const stations = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: counts
        .filter((count) => count.position !== null)
        .map((count) => ({
          type: "Feature",
          properties: { id: count.id },
          geometry: { type: "Point", coordinates: count.position! },
        })),
    }),
    [counts],
  );
  const study = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: studyAreaGeometry(place) },
      ],
    }),
    [place],
  );
  const planning = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: planningChange
        ? (["baseline", "proposal"] as const).flatMap((side) => {
            const road = planningChange[side];
            return road
              ? [
                  {
                    type: "Feature" as const,
                    properties: { side },
                    geometry: {
                      type: "LineString" as const,
                      coordinates: road.coordinates,
                    },
                  },
                ]
              : [];
          })
        : [],
    }),
    [planningChange],
  );
  useEffect(() => {
    if (!host.current) return;
    setReadyMap(null);
    setRenderedMap(null);
    setError("");
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: host.current,
        center: place.center,
        zoom: 12,
        minZoom: 2,
        maxZoom: 22,
        pitch: 0,
        dragRotate: false,
        touchPitch: false,
        attributionControl: false,
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#eeeade" },
            },
          ],
        },
      });
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        "Traffic network map; use the directed street list for keyboard selection",
      );
    map.on("load", () => {
      for (const id of ["study", "edges", "ports", "counts", "planning"])
        map.addSource(id, { type: "geojson", data: empty });
      const arrow = new Uint8Array(16 * 16 * 4);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if (
            (x >= 2 && x <= 10 && y >= 6 && y <= 9) ||
            (x >= 8 && x <= 14 && Math.abs(y - 7.5) <= 14 - x)
          ) {
            const offset = (y * 16 + x) * 4;
            arrow.set([22, 74, 60, 255], offset);
          }
        }
      map.addImage("traffic-direction-arrow", {
        width: 16,
        height: 16,
        data: arrow,
      });
      map.addLayer({
        id: "study",
        type: "line",
        source: "study",
        paint: {
          "line-color": "#7c8a76",
          "line-width": 2,
          "line-dasharray": [3, 3],
        },
      });
      map.addLayer({
        id: "edges",
        type: "line",
        source: "edges",
        paint: { "line-color": "#959e93", "line-width": 3 },
      });
      map.addLayer({
        id: "edge-hit",
        type: "line",
        source: "edges",
        paint: {
          "line-color": "#959e93",
          "line-opacity": 0.01,
          "line-width": 12,
        },
      });
      map.addLayer({
        id: "candidates",
        type: "line",
        source: "edges",
        filter: ["in", "id", ""],
        paint: {
          "line-color": "#aa8d50",
          "line-width": 4,
          "line-opacity": 0.7,
        },
      });
      map.addLayer({
        id: "reviewed",
        type: "line",
        source: "edges",
        filter: ["in", "id", ""],
        paint: { "line-color": "#317e94", "line-width": 7 },
      });
      map.addLayer({
        id: "planning-before",
        type: "line",
        source: "planning",
        filter: ["==", "side", "baseline"],
        paint: {
          "line-color": "#796b7a",
          "line-width": 5,
          "line-dasharray": [2, 2],
        },
      });
      map.addLayer({
        id: "planning-after",
        type: "line",
        source: "planning",
        filter: ["==", "side", "proposal"],
        paint: { "line-color": "#ce6b35", "line-width": 3 },
      });
      map.addLayer({
        id: "selected",
        type: "line",
        source: "edges",
        filter: ["==", "id", ""],
        paint: { "line-color": "#246e58", "line-width": 5 },
      });
      map.addLayer({
        id: "direction-arrows",
        type: "symbol",
        source: "edges",
        filter: ["in", "id", ""],
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 70,
          "icon-image": "traffic-direction-arrow",
          "icon-size": 1.2,
          "icon-rotation-alignment": "map",
          "icon-keep-upright": false,
          "icon-allow-overlap": true,
        },
      });
      map.addLayer({
        id: "ports",
        type: "circle",
        source: "ports",
        paint: {
          "circle-color": "#fffdf7",
          "circle-stroke-color": "#a77827",
          "circle-stroke-width": 2,
          "circle-radius": 5,
        },
      });
      map.addLayer({
        id: "counts",
        type: "circle",
        source: "counts",
        paint: {
          "circle-color": "#b27834",
          "circle-stroke-color": "#fffdf7",
          "circle-stroke-width": 1.5,
          "circle-radius": 5,
        },
      });
      if (mapRef.current === map) setReadyMap(map);
    });
    map.on("click", "edge-hit", (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === "string") current.current.onSelectEdge(id);
    });
    map.on("error", (event) => setError(event.error.message));
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [place]);
  useEffect(() => {
    const map = trafficMapForUpdate(mapRef.current, readyMap);
    if (!map) return;
    setRenderedMap(null);
    const markRendered = () => {
      if (
        ["study", "edges", "ports", "counts", "planning"].every((id) =>
          map.isSourceLoaded(id),
        )
      )
        if (mapRef.current === map) setRenderedMap(map);
    };
    map.on("idle", markRendered);
    for (const [id, data] of [
      ["study", study],
      ["edges", edges],
      ["ports", ports],
      ["counts", stations],
      ["planning", planning],
    ] as const)
      (map.getSource(id) as maplibregl.GeoJSONSource)?.setData(data);
    return () => {
      map.off("idle", markRendered);
    };
  }, [readyMap, study, edges, ports, stations, planning]);
  const identity = `${network.id}:${network.manifest.networkFileSha256}`;
  useEffect(() => {
    const map = trafficMapForUpdate(mapRef.current, readyMap);
    if (map) {
      const view = current.current;
      const focus = view.countReview
        ? trafficCountReviewBounds(
            view.network,
            view.counts,
            view.selectedEdgeId,
            view.reviewedEdgeIds,
          )
        : null;
      map.fitBounds(focus ?? view.network.manifest.bounds, {
        padding: focus ? 55 : 35,
        duration: 0,
        maxZoom: focus ? 18 : 17,
      });
    }
  }, [readyMap, identity]);
  useEffect(() => {
    const map = trafficMapForUpdate(mapRef.current, readyMap);
    if (!map) return;
    if (map.getLayer("ports"))
      map.setLayoutProperty(
        "ports",
        "visibility",
        countReview ? "none" : "visible",
      );
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        countReview
          ? "Count review map; use the count target and lane controls for keyboard selection"
          : "Traffic network map; use the directed street list for keyboard selection",
      );
  }, [readyMap, countReview]);
  useEffect(() => {
    const map = trafficMapForUpdate(mapRef.current, readyMap);
    if (map?.getLayer("selected"))
      map.setFilter("selected", ["==", "id", selectedEdgeId ?? ""]);
  }, [readyMap, selectedEdgeId]);
  useEffect(() => {
    const map = trafficMapForUpdate(mapRef.current, readyMap);
    if (!map) return;
    map.setFilter("candidates", ["in", "id", "", ...candidateEdgeIds]);
    map.setFilter("reviewed", ["in", "id", "", ...highlightedEdges]);
    map.setFilter("direction-arrows", [
      "in",
      "id",
      "",
      ...new Set([
        ...highlightedEdges,
        ...(selectedEdgeId ? [selectedEdgeId] : []),
      ]),
    ]);
  }, [readyMap, candidateEdgeIds, highlightedEdges, selectedEdgeId]);
  useEffect(() => {
    const map = trafficMapForUpdate(mapRef.current, readyMap);
    if (!map || !signal) return;
    const nodes = network.nodes.filter((node) =>
      signal.nodeIds.includes(node.id),
    );
    const markers = nodes.map((node) => {
      const element = document.createElement("span");
      element.className = "traffic-signal-map-node";
      element.textContent = "Signal";
      element.title = `Controller ${signal.id}, junction ${node.id}`;
      return new maplibregl.Marker({ element })
        .setLngLat(node.position)
        .addTo(map);
    });
    fitSignal();
    return () => markers.forEach((marker) => marker.remove());
  }, [readyMap, signal, network]);
  function fitSignal() {
    if (!signal) return;
    const ids = new Set(signal.connectionIds.flat());
    const edges = new Set(
      network.connections
        .filter((value) => ids.has(value.id))
        .flatMap((value) => [value.fromEdge, value.toEdge]),
    );
    const bounds = new maplibregl.LngLatBounds();
    for (const edge of network.edges)
      if (edges.has(edge.id))
        for (const lane of edge.lanes)
          for (const point of lane.shape) bounds.extend(point);
    for (const node of network.nodes)
      if (signal.nodeIds.includes(node.id)) bounds.extend(node.position);
    if (!bounds.isEmpty())
      trafficMapForUpdate(mapRef.current, readyMap)?.fitBounds(bounds, {
        padding: 45,
        maxZoom: 18,
        duration: 0,
      });
  }
  useEffect(() => {
    const map = trafficMapForUpdate(mapRef.current, readyMap),
      road = planningChange?.proposal ?? planningChange?.baseline;
    if (!map || !road?.coordinates.length) return;
    const markers = [road.coordinates[0], road.coordinates.at(-1)!].map(
      (position, index) => {
        const element = document.createElement("span");
        element.className = "traffic-road-endpoint";
        element.textContent = index ? "End" : "Start";
        element.title = `Planning centerline ${index ? "end" : "start"}: ${position.join(", ")}`;
        return new maplibregl.Marker({ element })
          .setLngLat(position)
          .addTo(map);
      },
    );
    return () => markers.forEach((marker) => marker.remove());
  }, [readyMap, planningChange]);
  function fitPlanning() {
    const bounds = new maplibregl.LngLatBounds();
    for (const road of [planningChange?.baseline, planningChange?.proposal])
      for (const p of road?.coordinates ?? []) bounds.extend(p);
    if (!bounds.isEmpty())
      trafficMapForUpdate(mapRef.current, readyMap)?.fitBounds(bounds, {
        padding: 55,
        maxZoom: 18,
        duration: 0,
      });
  }
  function fitReviewed() {
    const ids = new Set(reviewedEdgeIds),
      bounds = new maplibregl.LngLatBounds();
    for (const edge of network.edges)
      if (ids.has(edge.id))
        for (const lane of edge.lanes)
          for (const point of lane.shape) bounds.extend(point);
    for (const road of [planningChange?.baseline, planningChange?.proposal])
      for (const point of road?.coordinates ?? []) bounds.extend(point);
    if (!bounds.isEmpty())
      trafficMapForUpdate(mapRef.current, readyMap)?.fitBounds(bounds, {
        padding: 55,
        maxZoom: 18,
        duration: 0,
      });
  }
  function fitSelected() {
    const edge = network.edges.find((value) => value.id === selectedEdgeId);
    const map = trafficMapForUpdate(mapRef.current, readyMap);
    if (!edge || !map) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const lane of edge.lanes) for (const p of lane.shape) bounds.extend(p);
    if (!bounds.isEmpty())
      map.fitBounds(bounds, {
        padding: 55,
        maxZoom: 18,
        duration: 0,
      });
  }
  const countBounds = useMemo(
    () =>
      countReview
        ? trafficCountReviewBounds(
            network,
            counts,
            selectedEdgeId,
            reviewedEdgeIds,
          )
        : null,
    [countReview, network, counts, selectedEdgeId, reviewedEdgeIds],
  );
  function fitCountReview() {
    if (countBounds)
      trafficMapForUpdate(mapRef.current, readyMap)?.fitBounds(countBounds, {
        padding: 55,
        maxZoom: 18,
        duration: 0,
      });
  }
  const osm = network.manifest.sources.some((source) =>
    /openstreetmap|odbl/i.test(
      `${source.name} ${source.license} ${source.url}`,
    ),
  );
  return (
    <div className="traffic-map">
      <div className="traffic-actions">
        {countReview && (
          <button
            type="button"
            className="button"
            disabled={!ready || !countBounds}
            onClick={fitCountReview}
          >
            Fit count and direction
          </button>
        )}
        {signal && (
          <button
            type="button"
            className="button"
            disabled={!ready}
            onClick={fitSignal}
          >
            Fit signal extent
          </button>
        )}
        {planningChange && (
          <button
            type="button"
            className="button"
            disabled={!ready}
            onClick={fitPlanning}
          >
            Fit planning street
          </button>
        )}
        {planningChange && (
          <button
            type="button"
            className="button"
            disabled={!ready || !reviewedEdgeIds.length}
            onClick={fitReviewed}
          >
            Fit reviewed directions
          </button>
        )}
        <button
          type="button"
          className="button"
          disabled={!ready}
          onClick={() =>
            trafficMapForUpdate(mapRef.current, readyMap)?.fitBounds(
              network.manifest.bounds,
              {
                padding: 35,
                duration: 0,
                maxZoom: 17,
              },
            )
          }
        >
          <Scan size={14} />
          Fit traffic network
        </button>
        <button
          type="button"
          className="button"
          disabled={!ready || !selectedEdgeId}
          onClick={fitSelected}
        >
          Fit selected direction
        </button>
      </div>
      <div
        ref={host}
        className="traffic-map-canvas"
        aria-busy={!rendered && !error}
      />
      {error && (
        <p role="status" className="traffic-warning">
          Map unavailable: {error}. The complete network list remains available.
        </p>
      )}
      <p className="traffic-map-key">
        <span>Teal: selected direction</span>
        <span>Amber points: supplied count locations</span>
        {!countReview && <span>Rings: external ports</span>}
        <span>Dashed: editable study area</span>
        {signal && (
          <span>
            Blue: controlled incoming/outgoing edges. Turn connections are
            identified in the movement list.
          </span>
        )}
        {planningChange && (
          <>
            <span>Orange: proposed centerline</span>
            <span>Purple dashed: baseline centerline</span>
            <span>Blue: reviewed native edges</span>
            <span>Gold: source-way candidates only</span>
            <span>Arrows: native travel direction</span>
          </>
        )}
      </p>
      {osm && (
        <a
          className="traffic-attribution"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap contributors
        </a>
      )}
      <p className="traffic-muted">
        {countReview
          ? "The supplied observation point and native lane geometry are shown independently. The point is not a snapped detector location. The reviewed percentage and lane fields define the detector; use Fit count and direction to inspect their extent together."
          : "The traffic graph includes its recorded external network. A nearby count point is not automatically matched to a street."}
      </p>
    </div>
  );
}
