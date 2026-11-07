import type { Position } from "@urban/core";
export type Bounds = [number, number, number, number];
export function inBounds(
  p: Position,
  [west, south, east, north]: Bounds,
): boolean {
  return p[0] >= west && p[0] <= east && p[1] >= south && p[1] <= north;
}
/** Liang–Barsky segment clipping; preserve disconnected pieces as separate paths. */
export function clipLineToBounds(
  points: Position[],
  bounds: Bounds,
): Position[][] {
  const [west, south, east, north] = bounds;
  const pieces: Position[][] = [];
  let current: Position[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    if (Math.abs(dx) + Math.abs(dy) < 1e-12) continue;
    let lo = 0,
      hi = 1,
      accept = true;
    const p = [-dx, dx, -dy, dy],
      q = [a[0] - west, east - a[0], a[1] - south, north - a[1]];
    for (let side = 0; side < 4; side++) {
      if (Math.abs(p[side]) < 1e-12) {
        if (q[side] < 0) {
          accept = false;
          break;
        }
      } else {
        const t = q[side] / p[side];
        if (p[side] < 0) lo = Math.max(lo, t);
        else hi = Math.min(hi, t);
        if (lo > hi) {
          accept = false;
          break;
        }
      }
    }
    if (!accept || hi - lo < 1e-12) {
      if (current.length > 1) pieces.push(current);
      current = [];
      continue;
    }
    const clamp = (x: number, min: number, max: number) =>
      Math.max(min, Math.min(max, x));
    const start: Position = [
      clamp(a[0] + lo * dx, west, east),
      clamp(a[1] + lo * dy, south, north),
    ];
    const end: Position = [
      clamp(a[0] + hi * dx, west, east),
      clamp(a[1] + hi * dy, south, north),
    ];
    const last = current[current.length - 1];
    if (
      !last ||
      Math.abs(last[0] - start[0]) > 1e-9 ||
      Math.abs(last[1] - start[1]) > 1e-9
    ) {
      if (current.length > 1) pieces.push(current);
      current = [start];
    }
    current.push(end);
    if (hi < 1) {
      pieces.push(current);
      current = [];
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}
