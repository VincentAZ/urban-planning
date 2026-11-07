import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Place, Position } from "@urban/core";
import { PARCEL_SURFACE_HEIGHT_METERS } from "./parcel-drawing";
import { roadSurfacePath, ROAD_SURFACE_HEIGHTS_METERS } from "./road-surface";

describe("road display surfaces", () => {
  it("preserves every captured Phoenix centerline and source attribute while lifting only render coordinates", () => {
    const place = JSON.parse(
      readFileSync("public/data/phoenix.json", "utf8"),
    ) as Place;
    const before = JSON.stringify(place.roads);
    expect(place.roads.length).toBeGreaterThan(0);
    for (const road of place.roads) {
      for (const surface of Object.keys(
        ROAD_SURFACE_HEIGHTS_METERS,
      ) as (keyof typeof ROAD_SURFACE_HEIGHTS_METERS)[]) {
        const path = roadSurfacePath(road, surface);
        expect(
          path.map(([longitude, latitude]) => [longitude, latitude]),
        ).toEqual(road.coordinates);
        expect(
          path.every(
            (point) =>
              point[2] > PARCEL_SURFACE_HEIGHT_METERS && point[2] < 0.12,
          ),
        ).toBe(true);
      }
    }
    expect(JSON.stringify(place.roads)).toBe(before);
  });

  it("keeps authored loop closure, point order and input ownership across display planes", () => {
    const coordinates: Position[] = [
      [-112.07, 33.45],
      [-112.069, 33.45],
      [-112.069, 33.451],
      [-112.07, 33.45],
    ];
    coordinates.forEach(Object.freeze);
    Object.freeze(coordinates);
    const paths = (
      Object.keys(
        ROAD_SURFACE_HEIGHTS_METERS,
      ) as (keyof typeof ROAD_SURFACE_HEIGHTS_METERS)[]
    ).map((surface) => roadSurfacePath({ coordinates }, surface));
    for (const path of paths) {
      expect(path[0]).toEqual(path.at(-1));
      expect(
        path.map(([longitude, latitude]) => [longitude, latitude]),
      ).toEqual(coordinates);
    }
    expect(paths.map((path) => path[0][2])).toEqual(
      [...paths.map((path) => path[0][2])].sort((a, b) => a - b),
    );
  });
});
