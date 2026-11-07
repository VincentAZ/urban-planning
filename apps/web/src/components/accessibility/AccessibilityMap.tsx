import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { studyAreaBounds } from "@urban/core";
import type { Place, Position, Scenario, StudyAreaGeometry } from "@urban/core";
import { Crosshair, Minus, Plus, Scan } from "lucide-react";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { accessibilityMapContext } from "./map-context";

maplibregl.setWorkerUrl(workerUrl);
const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
type Contours = FeatureCollection<Polygon | MultiPolygon>;
const longitude = (n: number) => ((((n + 180) % 360) + 360) % 360) - 180;
function boundsOf(contours: Contours): maplibregl.LngLatBounds | null {
  const bounds = new maplibregl.LngLatBounds();
  for (const feature of contours.features) {
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    for (const rings of polygons)
      for (const ring of rings)
        for (const point of ring) bounds.extend([point[0], point[1]]);
  }
  return bounds.isEmpty() ? null : bounds;
}
/** Regional context only. No local-road simulation or approximate commute circles. */
export default function AccessibilityMap({
  place,
  scenario,
  site,
  capturedSite,
  studyArea,
  contour,
  minutes,
  extent,
  onSiteChange,
}: {
  place: Place;
  scenario: Scenario;
  site: Position | null;
  capturedSite?: Position;
  studyArea: StudyAreaGeometry;
  contour: Contours | null;
  minutes: 15 | 30 | 45;
  extent: [number, number, number, number] | null;
  onSiteChange?: (position: Position) => void;
}) {
  const [pickOnMap, setPickOnMap] = useState(false);
  const pick = useRef(false);
  pick.current = pickOnMap;
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const capturedMarker = useRef<maplibregl.Marker | null>(null);
  const studyMarker = useRef<maplibregl.Marker | null>(null);
  const localContext = useMemo(
    () => accessibilityMapContext(place, scenario),
    [place, scenario],
  );
  const localBounds = useMemo(() => studyAreaBounds(place), [place]);
  const hasOsm =
    !!contour ||
    place.sources.some((source) =>
      /openstreetmap|odbl/i.test(`${source.url} ${source.license}`),
    );
  const current = useRef({
    site,
    capturedSite,
    studyArea,
    contour,
    minutes,
    extent,
    onSiteChange,
  });
  current.current = {
    site,
    capturedSite,
    studyArea,
    contour,
    minutes,
    extent,
    onSiteChange,
  };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [center, setCenter] = useState<Position>(
    site ?? capturedSite ?? [-112.07, 33.45],
  );
  useEffect(() => {
    if (!host.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: host.current,
        center: current.current.site ??
          current.current.capturedSite ?? [-112.07, 33.45],
        zoom: 13,
        minZoom: 2,
        maxZoom: 18,
        pitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: false,
        style: {
          version: 8,
          sources: {
            states: { type: "geojson", data: "/data/ui/us-states.json" },
            study: { type: "geojson", data: empty },
            contours: { type: "geojson", data: empty },
            extent: { type: "geojson", data: empty },
            "local-roads": { type: "geojson", data: empty },
            "local-buildings": { type: "geojson", data: empty },
          },
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#e8eeea" },
            },
            {
              id: "land",
              type: "fill",
              source: "states",
              paint: { "fill-color": "#efede2" },
            },
            {
              id: "state-lines",
              type: "line",
              source: "states",
              paint: { "line-color": "#a8b0a4", "line-width": 1 },
            },
            {
              id: "region-extent",
              type: "line",
              source: "extent",
              paint: {
                "line-color": "#9b8d70",
                "line-width": 1,
                "line-dasharray": [4, 4],
              },
            },
            {
              id: "contour-fill",
              type: "fill",
              source: "contours",
              paint: { "fill-color": "#38826a", "fill-opacity": 0.18 },
            },
            {
              id: "contour-lines",
              type: "line",
              source: "contours",
              paint: {
                "line-color": [
                  "match",
                  ["get", "contour"],
                  15,
                  "#285a48",
                  30,
                  "#4f8c70",
                  "#8b9e67",
                ],
                "line-width": 2,
              },
            },
            {
              id: "study-fill",
              type: "fill",
              source: "study",
              paint: { "fill-color": "#c8884b", "fill-opacity": 0.08 },
            },
            {
              id: "study-line",
              type: "line",
              source: "study",
              paint: {
                "line-color": "#a86b39",
                "line-width": 2,
                "line-dasharray": [2, 2],
              },
            },
            {
              id: "local-roads",
              type: "line",
              source: "local-roads",
              minzoom: 10,
              paint: {
                "line-color": "#abaf99",
                "line-width": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  10,
                  1,
                  16,
                  5,
                ],
              },
            },
            {
              id: "local-buildings-fill",
              type: "fill",
              source: "local-buildings",
              minzoom: 11,
              paint: { "fill-color": "#d0c5a6", "fill-opacity": 0.7 },
            },
            {
              id: "local-buildings-lines",
              type: "line",
              source: "local-buildings",
              minzoom: 11,
              paint: { "line-color": "#a5997b", "line-width": 0.8 },
            },
          ],
        },
      });
    } catch {
      setError(
        "The regional map cannot open on this device. Origin coordinates, job controls, and evidence tables remain available.",
      );
      return;
    }
    mapRef.current = map;
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        "Regional jobs accessibility map. Arrow keys pan; use Choose map center to select an origin.",
      );
    map.on("load", () => {
      setReady(true);
      const bounds = studyAreaBounds(current.current.studyArea);
      const area = new maplibregl.LngLatBounds(
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      );
      if (
        !current.current.contour &&
        (!current.current.site || area.contains(current.current.site))
      )
        map.fitBounds(area, { padding: 36, duration: 0, maxZoom: 16 });
    });
    map.on("moveend", () => {
      const p = map.getCenter();
      setCenter([longitude(p.lng), p.lat]);
    });
    map.on("click", (event) => {
      if (!pick.current || !current.current.onSiteChange) return;
      current.current.onSiteChange([
        Number(longitude(event.lngLat.lng).toFixed(6)),
        Number(event.lngLat.lat.toFixed(6)),
      ]);
      setPickOnMap(false);
    });
    map.on("error", () =>
      setError(
        "Some regional map context could not load. This does not change the captured evidence. Use coordinates to choose an origin.",
      ),
    );
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      marker.current?.remove();
      capturedMarker.current?.remove();
      studyMarker.current?.remove();
      map.remove();
      mapRef.current = null;
      marker.current = null;
      capturedMarker.current = null;
      studyMarker.current = null;
    };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("study") as maplibregl.GeoJSONSource).setData({
      type: "Feature",
      properties: {},
      geometry: studyArea,
    });
    (map.getSource("contours") as maplibregl.GeoJSONSource).setData(
      contour ?? empty,
    );
    map.setFilter("contour-fill", ["==", ["get", "contour"], minutes]);
    (map.getSource("extent") as maplibregl.GeoJSONSource).setData(
      extent
        ? {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [extent[0], extent[1]],
                  [extent[2], extent[1]],
                  [extent[2], extent[3]],
                  [extent[0], extent[3]],
                  [extent[0], extent[1]],
                ],
              ],
            },
          }
        : empty,
    );
  }, [ready, studyArea, contour, minutes, extent]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("local-roads") as maplibregl.GeoJSONSource).setData(
      localContext.roads,
    );
    (map.getSource("local-buildings") as maplibregl.GeoJSONSource).setData(
      localContext.buildings,
    );
    if (!studyMarker.current) {
      const label = document.createElement("span");
      label.className = "accessibility-study-label";
      label.textContent = place.extentLabel || place.name;
      studyMarker.current = new maplibregl.Marker({
        element: label,
        anchor: "bottom-left",
        offset: [4, -4],
      })
        .setLngLat([localBounds[0], localBounds[3]])
        .addTo(map);
    } else {
      studyMarker.current.getElement().textContent =
        place.extentLabel || place.name;
      studyMarker.current.setLngLat([localBounds[0], localBounds[3]]);
    }
  }, [ready, localContext, localBounds, place.name, place.extentLabel]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (site) {
      if (!marker.current) {
        marker.current = new maplibregl.Marker({ color: "#235e4a" })
          .setLngLat(site)
          .addTo(map);
        marker.current
          .getElement()
          .setAttribute(
            "aria-label",
            "Selected origin, not the snapped network location",
          );
      } else marker.current.setLngLat(site);
      if (!map.getBounds().contains(site)) map.jumpTo({ center: site });
    } else {
      marker.current?.remove();
      marker.current = null;
    }
    const different =
      capturedSite &&
      (!site || site[0] !== capturedSite[0] || site[1] !== capturedSite[1]);
    if (different) {
      if (!capturedMarker.current) {
        capturedMarker.current = new maplibregl.Marker({
          color: "#ba7b40",
          scale: 0.75,
        })
          .setLngLat(capturedSite)
          .addTo(map);
        capturedMarker.current
          .getElement()
          .setAttribute(
            "aria-label",
            "Origin used by the displayed previous result",
          );
      } else capturedMarker.current.setLngLat(capturedSite);
    } else {
      capturedMarker.current?.remove();
      capturedMarker.current = null;
    }
  }, [ready, site, capturedSite]);
  useEffect(() => {
    if (!ready || !contour) return;
    const bounds = boundsOf(contour);
    if (bounds)
      mapRef.current?.fitBounds(bounds, {
        padding: 32,
        duration: 0,
        maxZoom: 14,
      });
  }, [ready, contour]);
  return (
    <section
      className="accessibility-map"
      aria-label="Outbound jobs accessibility map"
      aria-busy={!ready}
    >
      <div className="accessibility-map-frame">
        <div className="accessibility-map-canvas" ref={host} />
        <div className="accessibility-map-controls">
          <button
            type="button"
            aria-label="Zoom regional map in"
            disabled={!ready}
            onClick={() => mapRef.current?.zoomIn({ duration: 0 })}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            aria-label="Zoom regional map out"
            disabled={!ready}
            onClick={() => mapRef.current?.zoomOut({ duration: 0 })}
          >
            <Minus size={17} />
          </button>
          <button
            type="button"
            aria-label="Fit captured travel-time contours"
            disabled={!ready || !contour}
            onClick={() => {
              const b = contour && boundsOf(contour);
              if (b) mapRef.current?.fitBounds(b, { padding: 32, duration: 0 });
            }}
          >
            <Scan size={17} />
          </button>
        </div>
        <div className="accessibility-map-center" aria-hidden="true">
          +
        </div>
        <div className="accessibility-map-attribution">
          <a
            href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html"
            target="_blank"
            rel="noreferrer"
          >
            U.S. Census Bureau
          </a>{" "}
          · generalized state context
          {hasOsm ? (
            <>
              {" "}
              ·{" "}
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                © OpenStreetMap contributors
              </a>
            </>
          ) : null}
        </div>
      </div>
      {pickOnMap && (
        <p className="accessibility-note" role="status">
          Choose a point on the map. You can also enter coordinates or use
          Choose map center.
        </p>
      )}
      {contour && (
        <div
          className="accessibility-contour-legend"
          aria-label="Outbound travel-time contour colors"
        >
          {([15, 30, 45] as const).map((value) => (
            <span key={value}>
              <i aria-hidden="true" className={`contour-${value}`} />
              {value} min{minutes === value ? " · shaded" : ""}
            </span>
          ))}
        </div>
      )}
      <div className="accessibility-map-footer">
        {onSiteChange && (
          <button
            type="button"
            className="button secondary-button"
            aria-pressed={pickOnMap}
            disabled={!ready}
            onClick={() => setPickOnMap((value) => !value)}
          >
            {pickOnMap ? "Cancel origin selection" : "Pick origin on map"}
          </button>
        )}
        {onSiteChange && (
          <button
            type="button"
            className="button secondary-button"
            disabled={!ready}
            onClick={() =>
              onSiteChange([
                Number(center[0].toFixed(6)),
                Number(center[1].toFixed(6)),
              ])
            }
          >
            <Crosshair size={15} />
            Choose map center
          </button>
        )}
        <button
          type="button"
          className="button secondary-button"
          disabled={!ready}
          onClick={() =>
            mapRef.current?.fitBounds(
              [
                [localBounds[0], localBounds[1]],
                [localBounds[2], localBounds[3]],
              ],
              { padding: 36, duration: 0, maxZoom: 16 },
            )
          }
        >
          <Scan size={15} />
          Fit study area
        </button>
        <span>
          {center[1].toFixed(5)}, {center[0].toFixed(5)}
        </span>
      </div>
      <p className="accessibility-map-key">
        Green pin: chosen origin. Amber boundary: local study area. Detailed
        building and street context is available only in the study area; it does
        not change the regional routing graph. Dashed gray box: prepared region
        extent.{" "}
        {contour
          ? "Contours show captured travel from the captured origin; totals use routed workplace points, not polygon area."
          : "No captured contour is loaded. The map does not estimate travel time."}
      </p>
      {error && (
        <p className="accessibility-warning" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
