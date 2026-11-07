import type { FloodDataset, FloodZoneFeature } from "@urban/core";
import { floodColors, floodZoneKind } from "../flood/presentation";
export interface FloodMapPart {
  zone: FloodZoneFeature;
  rings: number[][][];
}
/** Display-only elevation, below park/building surfaces; holes and all parts retained. */
export function floodMapParts(dataset?: FloodDataset): FloodMapPart[] {
  return (dataset?.zones ?? []).flatMap((zone) =>
    (zone.geometry.type === "Polygon"
      ? [zone.geometry.coordinates]
      : zone.geometry.coordinates
    ).map((rings) => ({
      zone,
      rings: rings.map((r) => r.map((p) => [p[0], p[1], 0.045])),
    })),
  );
}
export function floodMapColor(
  part: FloodMapPart,
): [number, number, number, number] {
  return [...floodColors[floodZoneKind(part.zone)]];
}
