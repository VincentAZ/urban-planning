import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Position } from "@urban/core";
import { LocateFixed, Minus, Plus } from "lucide-react";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

maplibregl.setWorkerUrl(workerUrl);
const normalizedLongitude = (longitude: number) =>
  ((((longitude + 180) % 360) + 360) % 360) - 180;
const continentalBounds: [Position, Position] = [
  [-125, 24],
  [-66, 50],
];
const regions = [
  { name: "Contiguous U.S.", center: [-98, 38.5] as Position, zoom: 3 },
  { name: "Alaska", center: [-151, 64] as Position, zoom: 3 },
  { name: "Hawaii", center: [-157, 20.6] as Position, zoom: 5 },
  { name: "Puerto Rico / VI", center: [-65.8, 18.2] as Position, zoom: 6 },
  { name: "Guam / N. Mariana", center: [145, 16] as Position, zoom: 5 },
  { name: "American Samoa", center: [-170.7, -14.3] as Position, zoom: 7 },
];

export default function PlaceLocator({
  onLocate,
  busy,
  selected,
}: {
  onLocate: (point: Position) => void;
  busy: boolean;
  selected?: Position;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<maplibregl.Map | null>(null);
  const callback = useRef(onLocate);
  const blocked = useRef(busy);
  const marker = useRef<maplibregl.Marker | null>(null);
  const [error, setError] = useState("");
  const [center, setCenter] = useState<Position>([-98, 38.5]);
  callback.current = onLocate;
  blocked.current = busy;
  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: container.current,
        bounds: continentalBounds,
        fitBoundsOptions: { padding: 18 },
        minZoom: 0.5,
        maxZoom: 12,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        style: {
          version: 8,
          sources: {
            states: {
              type: "geojson",
              data: "/data/ui/us-states.json",
              attribution:
                "U.S. Census Bureau · TIGERweb 2026 · Generalized locator",
            },
          },
          layers: [
            {
              id: "water",
              type: "background",
              paint: { "background-color": "#e6efed" },
            },
            {
              id: "states",
              type: "fill",
              source: "states",
              paint: { "fill-color": "#ecebdc", "fill-opacity": 0.95 },
            },
            {
              id: "borders",
              type: "line",
              source: "states",
              paint: { "line-color": "#8d9b80", "line-width": 1 },
            },
          ],
        },
      });
    } catch {
      setError(
        "The locator map cannot open on this device. Use ZIP, address, or city search above.",
      );
      return;
    }
    instance.current = map;
    const initialCenter = map.getCenter();
    setCenter([normalizedLongitude(initialCenter.lng), initialCenter.lat]);
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        "U.S. place locator. Arrow keys move the map; use Find ZIP at map center to select.",
      );
    map.on("moveend", () => {
      const p = map.getCenter();
      setCenter([normalizedLongitude(p.lng), p.lat]);
    });
    map.on("click", (e) => {
      if (!blocked.current)
        callback.current([
          Number(normalizedLongitude(e.lngLat.lng).toFixed(6)),
          Number(e.lngLat.lat.toFixed(6)),
        ]);
    });
    map.on("error", () =>
      setError(
        "The locator outline could not load. ZIP and address search are still available.",
      ),
    );
    return () => {
      marker.current?.remove();
      marker.current = null;
      map.remove();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    if (!selected || !instance.current) return;
    if (!marker.current)
      marker.current = new maplibregl.Marker({ color: "#28634f" })
        .setLngLat(selected)
        .addTo(instance.current);
    else marker.current.setLngLat(selected);
    const current = instance.current.getBounds();
    if (!current.contains(selected))
      instance.current.jumpTo({ center: selected, zoom: 6 });
  }, [selected]);
  return (
    <div className="place-locator">
      <div className="locator-regions" aria-label="Locator regions">
        {regions.map((region) => (
          <button
            type="button"
            key={region.name}
            onClick={() =>
              region.name === "Contiguous U.S."
                ? instance.current?.fitBounds(continentalBounds, {
                    padding: 18,
                    duration: 0,
                  })
                : instance.current?.jumpTo({
                    center: region.center,
                    zoom: region.zoom,
                  })
            }
          >
            {region.name}
          </button>
        ))}
      </div>
      <div className="locator-map-frame">
        <div className="locator-map" ref={container} />
        <div className="locator-controls">
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom place locator in"
            onClick={() => instance.current?.zoomIn({ duration: 0 })}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom place locator out"
            onClick={() => instance.current?.zoomOut({ duration: 0 })}
          >
            <Minus size={17} />
          </button>
        </div>
      </div>
      <div className="locator-footer">
        <button
          type="button"
          className="button compact"
          disabled={busy || !!error}
          onClick={() => callback.current(center)}
        >
          <LocateFixed size={15} /> Find ZIP at map center
        </button>
        <small>
          Click the map to look up a Census ZIP area. State outlines are
          generalized for navigation.
        </small>
      </div>
      {error && (
        <p className="place-search-error" role="alert">
          {error}
        </p>
      )}
      <p className="locator-credit">
        Source:{" "}
        <a
          href="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0"
          target="_blank"
          rel="noreferrer"
        >
          U.S. Census Bureau, TIGERweb 2026
        </a>
        . Search provides a text alternative to the map.
      </p>
    </div>
  );
}
