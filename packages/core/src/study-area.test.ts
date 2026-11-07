import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { booleanPointInPolygon, polygon } from "@turf/turf";
import {
  buildingPreset,
  calculateImpact,
  createScenario,
  polygonAreaSqm,
  SQM_PER_ACRE,
} from "../../models/src/index";
import {
  baselineIdentity,
  validatePlace,
  type Place,
  type Polygon,
} from "./index";
import { studyAreaSchema } from "./validation";
import {
  buildingWithinStudyArea,
  clipLineToStudyArea,
  isValidStudyArea,
  lineWithinStudyArea,
  pointInStudyArea,
  studyAreaAnchor,
  studyAreaBounds,
  studyAreaFeature,
  studyAreaGeometry,
  studyAreaPolygons,
  studyAreaSqm,
  type StudyAreaGeometry,
} from "./study-area";
const box = (x: number, y: number, w: number, h = w): Polygon => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
];
const geometry: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [[box(0, 0, 4), box(1, 1, 2)], [box(6, 0, 2)]],
};
const legacy = { boundary: box(0, 0, 8), studyArea: geometry };

describe("exact polygon and multipolygon study areas", () => {
  it("preserves all rings and islands, subtracts holes from area, and uses full bounds", () => {
    expect(studyAreaGeometry(legacy)).toBe(geometry);
    expect(studyAreaPolygons(legacy)).toHaveLength(2);
    expect(studyAreaPolygons(legacy)[0]).toHaveLength(2);
    expect(studyAreaBounds(legacy)).toEqual([0, 0, 8, 4]);
    expect(studyAreaFeature(legacy).geometry).toEqual(geometry);
    const expected =
      polygonAreaSqm(box(0, 0, 4)) -
      polygonAreaSqm(box(1, 1, 2)) +
      polygonAreaSqm(box(6, 0, 2));
    expect(studyAreaSqm(legacy)).toBe(expected);
  });
  it("matches GeoJSON point containment across holes, islands, and every boundary", () => {
    for (let x = -0.5; x <= 8.5; x += 0.25)
      for (let y = -0.5; y <= 4.5; y += 0.25)
        expect(pointInStudyArea([x, y], geometry)).toBe(
          booleanPointInPolygon([x, y], studyAreaFeature(geometry)),
        );
    expect(pointInStudyArea([2, 2], legacy)).toBe(false);
    expect(pointInStudyArea([7, 1], legacy)).toBe(true);
    expect(pointInStudyArea([5, 1], legacy)).toBe(false);
    expect(pointInStudyArea([1, 2], legacy)).toBe(true);
  });
  it("checks the whole footprint, including an enclosed hole and bridges between islands", () => {
    expect(buildingWithinStudyArea(box(0.2, 0.2, 0.6), legacy)).toBe(true);
    expect(buildingWithinStudyArea(box(6.2, 0.2, 0.6), legacy)).toBe(true);
    expect(buildingWithinStudyArea(box(1.2, 1.2, 0.6), legacy)).toBe(false);
    expect(buildingWithinStudyArea(box(0.5, 0.5, 3), legacy)).toBe(false);
    expect(buildingWithinStudyArea(box(0.5, 1.5, 3, 0.5), legacy)).toBe(false);
    expect(buildingWithinStudyArea(box(3.5, 0.2, 3, 0.5), legacy)).toBe(false);
    expect(buildingWithinStudyArea(box(0.2, 1.5, 0.8, 0.2), legacy)).toBe(true);
  });
  it("clips a road at every outer/hole boundary without joining excluded gaps", () => {
    const pieces = clipLineToStudyArea(
      [
        [-1, 2],
        [9, 2],
      ],
      legacy,
    );
    expect(pieces).toEqual([
      [
        [0, 2],
        [1, 2],
      ],
      [
        [3, 2],
        [4, 2],
      ],
      [
        [6, 2],
        [8, 2],
      ],
    ]);
    expect(pieces.every((path) => lineWithinStudyArea(path, legacy))).toBe(
      true,
    );
    expect(
      lineWithinStudyArea(
        [
          [0.5, 2],
          [3.5, 2],
        ],
        legacy,
      ),
    ).toBe(false);
    expect(
      lineWithinStudyArea(
        [
          [3.5, 0.5],
          [6.5, 0.5],
        ],
        legacy,
      ),
    ).toBe(false);
    expect(
      clipLineToStudyArea(
        [
          [9, 2],
          [-1, 2],
        ],
        legacy,
      ),
    ).toEqual([...pieces].reverse().map((path) => [...path].reverse()));
  });
  it("preserves road direction and separates outside excursions on a multi-segment road", () => {
    expect(
      clipLineToStudyArea(
        [
          [0.5, 0.5],
          [5, 0.5],
          [5, 5],
          [0.5, 5],
          [0.5, 0.5],
        ],
        legacy,
      ),
    ).toEqual([
      [
        [0.5, 0.5],
        [4, 0.5],
      ],
      [
        [0.5, 4],
        [0.5, 0.5],
      ],
    ]);
    expect(
      lineWithinStudyArea(
        [
          [0, 0],
          [4, 0],
        ],
        legacy,
      ),
    ).toBe(true);
    expect(
      clipLineToStudyArea(
        [
          [-1, 1],
          [1, -1],
        ],
        legacy,
      ),
    ).toEqual([]);
    expect(
      clipLineToStudyArea(
        [
          [0.5, 0.5],
          [0.5, 0.5],
        ],
        legacy,
      ),
    ).toEqual([]);
    expect(
      lineWithinStudyArea(
        [
          [0.5, 0.5],
          [0.5, 0.5],
        ],
        legacy,
      ),
    ).toBe(false);
    const triangle: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 2],
          [0, 4],
          [0, 0],
        ],
      ],
    };
    expect(
      lineWithinStudyArea(
        [
          [0, 0],
          [1, 0.5],
          [4, 2],
        ],
        triangle,
      ),
    ).toBe(true);
  });
  it("accepts re-clipped floating endpoints on a real sloped Census boundary", () => {
    // Regression: OSM way747184066 (North State Street), Census2020 ZCTA60601 edge.
    const a: [number, number] = [-87.62697200003197, 41.88798299995961],
      b: [number, number] = [-87.62800399990172, 41.88750599993701];
    const local: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [[a, b, [b[0], 41.887], [a[0], 41.887], a]],
    };
    const path: [number, number][] = [
      [-87.6279031, 41.8872361],
      [-87.62791921757947, 41.88754518712183],
    ];
    expect(pointInStudyArea(path[1], local)).toBe(true);
    expect(lineWithinStudyArea(path, local)).toBe(true);
    expect(
      clipLineToStudyArea(path, local).every((piece) =>
        lineWithinStudyArea(piece, local),
      ),
    ).toBe(true);
    expect(
      lineWithinStudyArea([path[0], [path[1][0], path[1][1] + 1e-7]], local),
    ).toBe(false);
  });
  it("handles a valid island inside another polygon’s hole", () => {
    const islands: StudyAreaGeometry = {
      type: "MultiPolygon",
      coordinates: [[box(0, 0, 10), box(2, 2, 6)], [box(3, 3, 1)]],
    };
    expect(isValidStudyArea(islands)).toBe(true);
    expect(pointInStudyArea([3.5, 3.5], islands)).toBe(true);
    expect(pointInStudyArea([2.5, 2.5], islands)).toBe(false);
    expect(buildingWithinStudyArea(box(3.2, 3.2, 0.4), islands)).toBe(true);
    expect(buildingWithinStudyArea(box(1, 1, 8), islands)).toBe(false);
  });
  it("finds an interior anchor when a centroid would fall in a hole or between islands", () => {
    const anchor = studyAreaAnchor(legacy);
    expect(
      booleanPointInPolygon(anchor, polygon(geometry.coordinates[0]), {
        ignoreBoundary: true,
      }),
    ).toBe(true);
    expect(pointInStudyArea(anchor, legacy)).toBe(true);
    const crescent: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [2, 3],
          [2, 1],
          [1, 1],
          [1, 3],
          [0, 3],
          [0, 0],
        ],
      ],
    };
    expect(
      booleanPointInPolygon(
        studyAreaAnchor(crescent),
        studyAreaFeature(crescent),
        { ignoreBoundary: true },
      ),
    ).toBe(true);
    const alignedHole: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [box(0, 0, 4), box(1, 1, 2, 1)],
    };
    expect(
      booleanPointInPolygon(
        studyAreaAnchor(alignedHole),
        studyAreaFeature(alignedHole),
        { ignoreBoundary: true },
      ),
    ).toBe(true);
  });
  it("rejects invalid rings/topology and exact-baseline features in excluded holes", () => {
    expect(studyAreaSchema.safeParse(geometry).success).toBe(true);
    expect(
      studyAreaSchema.safeParse({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      }).success,
    ).toBe(false);
    expect(
      studyAreaSchema.safeParse({
        type: "Polygon",
        coordinates: [box(0, 0, 1), box(3, 3, 1)],
      }).success,
    ).toBe(false);
    expect(
      studyAreaSchema.safeParse({
        type: "Polygon",
        coordinates: [box(0, 0, 4), box(1, 1, 2), box(1.5, 1.5, 0.5)],
      }).success,
    ).toBe(false);
    expect(
      studyAreaSchema.safeParse({
        type: "MultiPolygon",
        coordinates: [[box(0, 0, 2)], [box(1, 1, 2)]],
      }).success,
    ).toBe(false);
    const place = JSON.parse(
      readFileSync("public/data/phoenix.json", "utf8"),
    ) as Place;
    const exact: Place = {
      ...place,
      boundary: box(0, 0, 8),
      studyArea: geometry,
      bounds: [0, 0, 8, 4],
      center: [0.5, 0.5],
      buildings: [buildingPreset("office", [2, 2])],
      roads: [],
    };
    expect(() => validatePlace(exact)).toThrow("outside its exact study area");
  });
  it("keeps legacy source identity and serialized content unchanged", async () => {
    const raw = readFileSync("public/data/phoenix.json", "utf8"),
      place = JSON.parse(raw) as Place,
      before = JSON.stringify(place);
    validatePlace(place);
    studyAreaGeometry(place);
    studyAreaSqm(place);
    studyAreaBounds(place);
    studyAreaAnchor(place);
    expect(JSON.stringify(place)).toBe(before);
    expect(Object.hasOwn(place, "studyArea")).toBe(false);
    expect((await baselineIdentity(place)).sha256).toBe(
      "55654735f5f3fb022694db8f4e2cca3bde31e0404fb8a91cb812eb22a797fd45",
    );
    expect(studyAreaSqm(place)).toBe(polygonAreaSqm(place.boundary));
  });
  it("uses all islands minus holes for model density rather than the legacy enclosing ring", () => {
    const base = JSON.parse(
      readFileSync("public/data/phoenix.json", "utf8"),
    ) as Place;
    const exact: Place = {
      ...base,
      boundary: box(0, 0, 0.08),
      studyArea: {
        type: "MultiPolygon",
        coordinates: [
          [box(0, 0, 0.04), box(0.01, 0.01, 0.02)],
          [box(0.06, 0, 0.02)],
        ],
      },
      bounds: [0, 0, 0.08, 0.04],
      center: [0.005, 0.005],
      buildings: [
        { ...buildingPreset("multifamily", [0.005, 0.005]), units: 40 },
      ],
      roads: [],
    };
    const result = calculateImpact(exact, createScenario("Exact boundary"));
    const density = result.metrics.find((m) => m.id === "housing.density")!;
    expect(density.value).toBeCloseTo(
      40 / (studyAreaSqm(exact) / SQM_PER_ACRE),
      8,
    );
    expect(density.value).not.toBeCloseTo(
      40 / (polygonAreaSqm(exact.boundary) / SQM_PER_ACRE),
      5,
    );
  });
});
