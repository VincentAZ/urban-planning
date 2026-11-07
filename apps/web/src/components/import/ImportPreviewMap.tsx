import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { Scan } from "lucide-react";
import {
  buildingGeometry,
  materializeBuildings,
  materializeRoads,
  studyAreaGeometry,
  type Place,
  type Scenario,
} from "@urban/core";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

maplibregl.setWorkerUrl(workerUrl);
export type ImportMapFeatures = FeatureCollection<
  Polygon | MultiPolygon,
  { id: string; name: string; change?: string }
>;
function fit(
  map: maplibregl.Map,
  features: FeatureCollection,
  selected?: string | null,
) {
  const bounds = new maplibregl.LngLatBounds();
  for (const feature of features.features) {
    if (selected && feature.properties?.id !== selected) continue;
    const geometry = feature.geometry;
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
      continue;
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    for (const rings of polygons)
      for (const ring of rings)
        for (const p of ring) bounds.extend([p[0], p[1]]);
  }
  if (!bounds.isEmpty())
    map.fitBounds(bounds, {
      padding: 45,
      maxZoom: selected ? 19 : 17,
      duration: 0,
    });
}

/** Preview geometry is independent of applied scenario state and never exported as an applied revision. */
export default function ImportPreviewMap({
  place,
  scenario,
  features,
  selectedId,
  onSelect,
}: {
  place: Place;
  scenario: Scenario;
  features: ImportMapFeatures;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const current = useRef({ features, onSelect });
  current.current = { features, onSelect };
  const study = useMemo(
    (): FeatureCollection => ({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: studyAreaGeometry(place) },
      ],
    }),
    [place],
  );
  const context = useMemo(
    (): FeatureCollection => ({
      type: "FeatureCollection",
      features: materializeBuildings(place, scenario).map((b) => ({
        type: "Feature",
        properties: {},
        geometry: buildingGeometry(b),
      })),
    }),
    [place, scenario],
  );
  const roads = useMemo(
    (): FeatureCollection => ({
      type: "FeatureCollection",
      features: materializeRoads(place, scenario).map((r) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: r.coordinates },
      })),
    }),
    [place, scenario],
  );
  useEffect(() => {
    if (!host.current) return;
    setReady(false);
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: host.current,
        center: place.center,
        zoom: 14,
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
    } catch (e) {
      setError((e as Error).message);
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
        "Import geometry preview; use the feature table to inspect without a map",
      );
    map.on("load", () => {
      map.addSource("study", { type: "geojson", data: study });
      map.addLayer({
        id: "study-area",
        type: "line",
        source: "study",
        paint: {
          "line-color": "#7c8a76",
          "line-width": 2,
          "line-dasharray": [3, 3],
        },
      });
      map.addSource("context", { type: "geojson", data: context });
      map.addLayer({
        id: "context-buildings",
        type: "fill",
        source: "context",
        paint: { "fill-color": "#c9c3b1", "fill-opacity": 0.55 },
      });
      map.addSource("roads", { type: "geojson", data: roads });
      map.addLayer({
        id: "context-roads",
        type: "line",
        source: "roads",
        paint: { "line-color": "#cbc8bc", "line-width": 2 },
      });
      map.addSource("imports", {
        type: "geojson",
        data: current.current.features,
      });
      map.addLayer({
        id: "import-fill",
        type: "fill",
        source: "imports",
        paint: { "fill-color": "#347d68", "fill-opacity": 0.35 },
      });
      map.addLayer({
        id: "import-outline",
        type: "line",
        source: "imports",
        paint: { "line-color": "#23634f", "line-width": 2 },
      });
      map.addLayer({
        id: "import-selected",
        type: "line",
        source: "imports",
        filter: ["==", "id", ""],
        paint: { "line-color": "#b87a16", "line-width": 4 },
      });
      fit(
        map,
        current.current.features.features.length
          ? current.current.features
          : study,
      );
      setReady(true);
    });
    map.on("click", "import-fill", (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === "string") current.current.onSelect(id);
    });
    map.on("error", (event) => setError(event.error.message));
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [place, study, context, roads]);
  useEffect(() => {
    if (ready && mapRef.current)
      (
        mapRef.current.getSource("imports") as maplibregl.GeoJSONSource
      )?.setData(features);
  }, [ready, features]);
  useEffect(() => {
    if (ready && mapRef.current?.getLayer("import-selected"))
      mapRef.current.setFilter("import-selected", [
        "==",
        "id",
        selectedId ?? "",
      ]);
  }, [ready, selectedId]);
  return (
    <div className="import-preview-map">
      <div
        className="import-map-controls"
        role="group"
        aria-label="Preview map framing"
      >
        <button
          type="button"
          className="button"
          disabled={!ready}
          onClick={() => mapRef.current && fit(mapRef.current, features)}
        >
          <Scan size={14} /> Fit imported layer
        </button>
        <button
          type="button"
          className="button"
          disabled={!ready}
          onClick={() => mapRef.current && fit(mapRef.current, study)}
        >
          Fit study area
        </button>
        <button
          type="button"
          className="button"
          disabled={!ready || !selectedId}
          onClick={() =>
            mapRef.current && fit(mapRef.current, features, selectedId)
          }
        >
          Fit selected feature
        </button>
      </div>
      <div ref={host} className="import-map-canvas" />
      <p className="import-map-legend">
        <span>Teal: prepared import</span>
        <span>Gray: existing context</span>
        <span>Dashed: exact study boundary</span>
      </p>
      {place.sources.some((s) =>
        /openstreetmap|odbl/i.test(`${s.url} ${s.license}`),
      ) && (
        <small>
          Context:{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            © OpenStreetMap contributors
          </a>
        </small>
      )}
      {place.geography?.type === "zcta" && (
        <small>
          Study boundary: U.S. Census Bureau, {place.geography.boundaryVintage}.
        </small>
      )}
      {error && (
        <p role="status">
          Map preview unavailable: {error}. Every prepared feature remains
          available in the table.
        </p>
      )}
    </div>
  );
}
