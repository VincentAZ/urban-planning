import { describe, expect, it } from "vitest";
import type { StudyAreaGeometry } from "@urban/core";
import { prepareFloodShape, strictFloodRelation } from "./flood-geometry";

function box(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): StudyAreaGeometry {
  return {
    type: "Polygon",
    coordinates: [
      [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
        [x1, y1],
      ],
    ],
  };
}
const ring = (geometry: StudyAreaGeometry) =>
  geometry.type === "Polygon"
    ? geometry.coordinates[0]
    : geometry.coordinates[0][0];

describe("strict flood-region shortcuts", () => {
  it("proves strictly separated containment and disjointness without accepting boundary contact", () => {
    const prepared = prepareFloodShape(box(-5, -5, 5, 5));
    expect(strictFloodRelation(box(-1, -1, 1, 1), prepared)).toBe("inside");
    expect(strictFloodRelation(box(6, -1, 7, 1), prepared)).toBe("outside");
    expect(strictFloodRelation(box(4, -1, 5, 1), prepared)).toBe("boundary");
    expect(strictFloodRelation(box(4, -1, 6, 1), prepared)).toBe("boundary");
    expect(strictFloodRelation(box(-1, -1, 1, 1), null)).toBe("outside");
  });

  it("does not mistake a fully enclosed source hole or island for uniform coverage", () => {
    const donut: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [ring(box(-5, -5, 5, 5)), ring(box(-1, -1, 1, 1)).reverse()],
    };
    const prepared = prepareFloodShape(donut);
    expect(strictFloodRelation(box(-2, -2, 2, 2), prepared)).toBe("boundary");
    expect(strictFloodRelation(box(-0.5, -0.5, 0.5, 0.5), prepared)).toBe(
      "outside",
    );
    expect(strictFloodRelation(box(2, 2, 3, 3), prepared)).toBe("inside");
    expect(
      strictFloodRelation(
        box(-2, -2, 2, 2),
        prepareFloodShape(box(-1, -1, 1, 1)),
      ),
    ).toBe("boundary");
  });

  it("respects footprint holes and every multipart component", () => {
    const footprint: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [ring(box(-5, -5, 5, 5)), ring(box(-2, -2, 2, 2)).reverse()],
    };
    expect(
      strictFloodRelation(footprint, prepareFloodShape(box(-1, -1, 1, 1))),
    ).toBe("outside");
    const source: StudyAreaGeometry = {
      type: "MultiPolygon",
      coordinates: [[ring(box(-5, -5, -1, 5))], [ring(box(1, -5, 5, 5))]],
    };
    const both: StudyAreaGeometry = {
      type: "MultiPolygon",
      coordinates: [[ring(box(-4, -1, -2, 1))], [ring(box(2, -1, 4, 1))]],
    };
    expect(strictFloodRelation(both, prepareFloodShape(source))).toBe("inside");
    both.coordinates[1] = [ring(box(6, -1, 7, 1))];
    expect(strictFloodRelation(both, prepareFloodShape(source))).toBe(
      "boundary",
    );
  });

  it("sends concavity crossings and conservative diagonal bounding-box overlaps to overlay", () => {
    const concave: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [-5, -5],
          [5, -5],
          [5, 5],
          [1, 5],
          [1, -1],
          [-1, -1],
          [-1, 5],
          [-5, 5],
          [-5, -5],
        ],
      ],
    };
    expect(
      strictFloodRelation(box(-2, -2, 2, 2), prepareFloodShape(concave)),
    ).toBe("boundary");
    const triangle: StudyAreaGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [5, 5],
          [0, 5],
          [0, 0],
        ],
      ],
    };
    expect(
      strictFloodRelation(box(0.1, 3, 0.2, 4), prepareFloodShape(triangle)),
    ).toBe("boundary");
  });

  it("never erases a tiny real gap or changes a captured coordinate", () => {
    const source = box(-87.62, 41.88, -87.61, 41.89);
    const before = structuredClone(source),
      prepared = prepareFloodShape(source);
    const tinyBreach = box(-87.611, 41.881, -87.61 + 1e-10, 41.882);
    expect(strictFloodRelation(tinyBreach, prepared)).toBe("boundary");
    expect(source).toEqual(before);
    source.coordinates[0][0][0] = -180;
    expect(
      strictFloodRelation(box(-87.619, 41.881, -87.618, 41.882), prepared),
    ).toBe("inside");
  });

  it("handles canonical decimal scientific notation and ring direction without a rounding grid", () => {
    const source = box(-5e-9, -5e-9, 5e-9, 5e-9);
    source.coordinates[0].reverse();
    expect(
      strictFloodRelation(
        box(-1e-9, -1e-9, 1e-9, 1e-9),
        prepareFloodShape(source),
      ),
    ).toBe("inside");
    expect(
      strictFloodRelation(
        box(6e-9, -1e-9, 7e-9, 1e-9),
        prepareFloodShape(source),
      ),
    ).toBe("outside");
  });
});
