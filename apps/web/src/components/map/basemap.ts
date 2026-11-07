import type { RasterSourceSpecification, StyleSpecification } from "maplibre-gl";

export function satelliteImagery(maptilerKey?: string) {
  const key = maptilerKey?.trim();
  return key
    ? {
        tiles: [
          `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${encodeURIComponent(key)}`,
        ],
        attribution: "© MapTiler © imagery providers",
        creditsUrl: "https://www.maptiler.com/copyright/",
        maxzoom: 20,
      }
    : {
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        attribution:
          "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
        creditsUrl:
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
        maxzoom: 19,
      };
}

export function mapStyle(
  view: "3d" | "2d" | "satellite",
  night: boolean,
  maptilerKey?: string,
): StyleSpecification {
  const imagery = satelliteImagery(maptilerKey);
  const source: RasterSourceSpecification = {
    type: "raster",
    tiles: imagery.tiles,
    tileSize: 256,
    attribution: imagery.attribution,
    maxzoom: imagery.maxzoom,
  };
  return {
    version: 8,
    sources: view === "satellite" ? { satellite: source } : {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": night ? "#394a4a" : "#e9e7dc" },
      },
      ...(view === "satellite"
        ? [{ id: "satellite", type: "raster" as const, source: "satellite" }]
        : []),
    ],
  };
}
