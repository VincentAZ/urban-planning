import { describe, it, expect } from "vitest";
import {
  applyNeighborhoodBrush,
  validateActivityNeighborhoods,
  type NeighborhoodBrushInput,
} from "./activity-geometry";
import { geometryIntersectionAreaSqm } from "./parcels";
import { pointInStudyArea, type StudyAreaGeometry } from "./study-area";
const square = (x: number, y: number, w: number): StudyAreaGeometry => ({
  type: "Polygon",
  coordinates: [
    [
      [x, y],
      [x + w, y],
      [x + w, y + w],
      [x, y + w],
      [x, y],
    ],
  ],
});
const study = square(0, 0, 0.02);
const input = (
  patch: Partial<NeighborhoodBrushInput> = {},
): NeighborhoodBrushInput => ({
  geometry: null,
  studyArea: study,
  otherGeometries: [],
  stroke: { operation: "add", path: [[0.01, 0.01]], radiusMeters: 50 },
  ...patch,
});
describe("neighborhood brush vector geometry", () => {
  it("paints continuous buffered strokes as authored geometry without mutating input", () => {
    const request = input({
        stroke: {
          operation: "add",
          path: [
            [0.005, 0.01],
            [0.015, 0.01],
          ],
          radiusMeters: 50,
        },
      }),
      before = JSON.stringify(request);
    const result = applyNeighborhoodBrush(request);
    expect(result.changed).toBe(true);
    expect(result.geometry).not.toBeNull();
    expect(pointInStudyArea([0.01, 0.01], result.geometry!)).toBe(true);
    expect(result.excludedAreaSqm).toBe(0);
    expect(JSON.stringify(request)).toBe(before);
  });
  it("clips against study holes and separate components, preserving exclusions rather than bridging them", () => {
    const holed: StudyAreaGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [0.01, 0],
            [0.01, 0.01],
            [0, 0.01],
            [0, 0],
          ],
          [
            [0.004, 0.004],
            [0.006, 0.004],
            [0.006, 0.006],
            [0.004, 0.006],
            [0.004, 0.004],
          ],
        ],
        (
          square(0.012, 0, 0.005) as Extract<
            StudyAreaGeometry,
            { type: "Polygon" }
          >
        ).coordinates,
      ],
    };
    const result = applyNeighborhoodBrush(
      input({
        studyArea: holed,
        stroke: {
          operation: "add",
          path: [
            [0.002, 0.005],
            [0.015, 0.005],
          ],
          radiusMeters: 200,
        },
      }),
    );
    expect(result.geometry?.type).toBe("MultiPolygon");
    expect(pointInStudyArea([0.005, 0.005], result.geometry!)).toBe(false);
    expect(pointInStudyArea([0.011, 0.005], result.geometry!)).toBe(false);
    expect(result.excludedStudyAreaSqm).toBeGreaterThan(0);
  });
  it("shows clipped neighboring land and never changes the other neighborhood", () => {
    const other = square(0.01, 0.009, 0.002),
      before = JSON.stringify(other);
    const result = applyNeighborhoodBrush(input({ otherGeometries: [other] }));
    expect(result.excludedNeighborhoodAreaSqm).toBeGreaterThan(0);
    expect(geometryIntersectionAreaSqm(result.geometry!, other)).toBeLessThan(
      1e-6,
    );
    expect(JSON.stringify(other)).toBe(before);
  });
  it("erases a real hole and supports a complete empty draft without deleting a saved object", () => {
    const geometry = square(0.005, 0.005, 0.01),
      before = JSON.stringify(geometry);
    const result = applyNeighborhoodBrush(
      input({
        geometry,
        stroke: { operation: "erase", path: [[0.01, 0.01]], radiusMeters: 50 },
      }),
    );
    expect(result.geometry?.type).toBe("Polygon");
    expect(
      (result.geometry as Extract<StudyAreaGeometry, { type: "Polygon" }>)
        .coordinates.length,
    ).toBe(2);
    expect(pointInStudyArea([0.01, 0.01], result.geometry!)).toBe(false);
    expect(JSON.stringify(geometry)).toBe(before);
    expect(
      applyNeighborhoodBrush(
        input({
          geometry: square(0.0099, 0.0099, 0.0002),
          stroke: {
            operation: "erase",
            path: [[0.01, 0.01]],
            radiusMeters: 50,
          },
        }),
      ).geometry,
    ).toBeNull();
  });
  it("reports fully excluded strokes as no-op and keeps the previous geometry reference", () => {
    const geometry = square(0.005, 0.005, 0.001);
    const result = applyNeighborhoodBrush(
      input({
        geometry,
        stroke: { operation: "add", path: [[0.03, 0.03]], radiusMeters: 5 },
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.geometry).toBe(geometry);
    expect(result.excludedStudyAreaSqm).toBeGreaterThan(0);
  });
  it("rejects invalid stroke work before silently truncating or editing anything", () => {
    for (const radiusMeters of [4, 1001, NaN])
      expect(() =>
        applyNeighborhoodBrush(
          input({
            stroke: { operation: "add", path: [[0.01, 0.01]], radiusMeters },
          }),
        ),
      ).toThrow(/radius/);
    expect(() =>
      applyNeighborhoodBrush(
        input({
          stroke: {
            operation: "add",
            path: Array.from({ length: 501 }, () => [0.01, 0.01]),
            radiusMeters: 5,
          },
        }),
      ),
    ).toThrow(/points/);
    expect(() =>
      applyNeighborhoodBrush(
        input({
          stroke: { operation: "add", path: [[0, Infinity]], radiusMeters: 5 },
        }),
      ),
    ).toThrow(/coordinates/);
  });
  it("validates disjoint precise geometry while allowing shared edges", () => {
    expect(() =>
      validateActivityNeighborhoods(
        [
          { geometry: square(0, 0, 0.005) },
          { geometry: square(0.005, 0, 0.005) },
        ],
        study,
      ),
    ).not.toThrow();
    expect(() =>
      validateActivityNeighborhoods(
        [
          { geometry: square(0, 0, 0.005) },
          { geometry: square(0.004, 0, 0.005) },
        ],
        study,
      ),
    ).toThrow(/overlap/);
    expect(() =>
      validateActivityNeighborhoods(
        [{ geometry: square(-0.001, 0, 0.005) }],
        study,
      ),
    ).toThrow(/inside/);
  });
});
