import {
  buildingGeometry,
  materializeBuildings,
  materializeRoads,
} from "@urban/core";
import type { Place, Scenario } from "@urban/core";
import type {
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
} from "geojson";

/** Exact local display context only; never supplied to the regional router. */
export function workforceMapContext(
  place: Place,
  scenario: Scenario,
): {
  buildings: FeatureCollection<Polygon | MultiPolygon>;
  roads: FeatureCollection<LineString>;
} {
  return {
    buildings: {
      type: "FeatureCollection",
      features: materializeBuildings(place, scenario).map((building) => ({
        type: "Feature",
        id: building.id,
        properties: { name: building.name },
        geometry: buildingGeometry(building),
      })),
    },
    roads: {
      type: "FeatureCollection",
      features: materializeRoads(place, scenario).map((road) => ({
        type: "Feature",
        id: road.id,
        properties: { name: road.name },
        geometry: { type: "LineString", coordinates: road.coordinates },
      })),
    },
  };
}
