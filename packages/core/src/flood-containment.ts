import type { Polygon, MultiPolygon } from "geojson";
import type { StudyAreaGeometry } from "./study-area";

type Geometry = StudyAreaGeometry | Polygon | MultiPolygon;
const buffer = new ArrayBuffer(8),
  view = new DataView(buffer),
  fractionMask = (1n << 52n) - 1n;
/** Exact integer multiples of the smallest binary64 subnormal (2^-1074). */
function exact(value: number): bigint {
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false),
    exponent = Number((bits >> 52n) & 2047n),
    fraction = bits & fractionMask;
  const magnitude =
    exponent === 0
      ? fraction
      : ((1n << 52n) | fraction) << BigInt(exponent - 1);
  return bits >> 63n ? -magnitude : magnitude;
}
function neighbor(value: number, up: boolean): number {
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  bits += value > 0 === up ? 1n : -1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}
type Ratio = { n: bigint; d: bigint };
const less = (a: Ratio, b: Ratio) => a.n * b.d < b.n * a.d;
/** Does the exact source segment intersect the point's one-neighbor coordinate cell? */
function meetsCell(p: number[], a: number[], b: number[]): boolean {
  let lower: Ratio = { n: 0n, d: 1n },
    upper: Ratio = { n: 1n, d: 1n };
  for (let axis = 0; axis < 2; axis++) {
    const lo = neighbor(p[axis], false),
      hi = neighbor(p[axis], true);
    if (hi < Math.min(a[axis], b[axis]) || lo > Math.max(a[axis], b[axis]))
      return false;
    const start = exact(a[axis]),
      delta = exact(b[axis]) - start,
      min = exact(lo) - start,
      max = exact(hi) - start;
    if (delta === 0n) {
      if (min > 0n || max < 0n) return false;
      continue;
    }
    const l: Ratio = delta > 0n ? { n: min, d: delta } : { n: -max, d: -delta },
      u: Ratio = delta > 0n ? { n: max, d: delta } : { n: -min, d: -delta };
    if (less(lower, l)) lower = l;
    if (less(u, upper)) upper = u;
    if (less(upper, lower)) return false;
  }
  return true;
}

/**
 * Narrow normalization containment certificate, NOT a model coverage tolerance.
 * Each residual component must collapse to <3 exact points, or all its vertices
 * must have one common original boundary segment intersecting their cells
 * [nextDown(x),nextUp(x)] × [nextDown(y),nextUp(y)]. These are the immediately
 * adjacent binary64 values, not a fixed degree/metre/area buffer. Exact rational
 * interval clipping proves each cell intersection with segment t within [0,1].
 * The component's full edges/interior lie in that segment's convex rounding
 * enclosure. Unrelated boundary segments cannot justify a shortcut across a
 * concavity or hole. No coordinates change, and exact real-number containment
 * beyond binary64 precision is not claimed. Exposure coverage does not use this.
 */
export function floodResidualWithinCoordinateCells(
  residual: Geometry | null,
  boundary: StudyAreaGeometry,
): boolean {
  if (!residual) return true;
  const polygons =
    residual.type === "Polygon" ? [residual.coordinates] : residual.coordinates;
  const rings =
    boundary.type === "Polygon"
      ? boundary.coordinates
      : boundary.coordinates.flat();
  const segments = rings.flatMap((r) => r.slice(1).map((b, i) => [r[i], b]));
  return polygons.every((p) => {
    const vertices = p.flat();
    if (new Set(p[0].map(([x, y]) => `${x},${y}`)).size < 3) return true;
    return segments.some(([a, b]) => vertices.every((v) => meetsCell(v, a, b)));
  });
}
