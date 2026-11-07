import type { Road } from "@urban/core";

// Display planes only: keep the captured centerline two-dimensional. These
// surfaces sit above the parcel annotation (4 cm), below parks (12 cm) and
// labels (50 cm). Their draw order then composes sidewalk, road and markings.
export const ROAD_SURFACE_HEIGHTS_METERS = {
  sidewalk: 0.05,
  carriageway: 0.06,
  selection: 0.07,
  marking: 0.08,
} as const;

export function roadSurfacePath(
  road: Pick<Road, "coordinates">,
  surface: keyof typeof ROAD_SURFACE_HEIGHTS_METERS,
): [number, number, number][] {
  return road.coordinates.map(([longitude, latitude]) => [
    longitude,
    latitude,
    ROAD_SURFACE_HEIGHTS_METERS[surface],
  ]);
}

// Slope bias protects the shallow display lift against ground-depth precision
// at pitched cameras. Normal depth testing remains enabled; later buildings
// must also cover these paths in 2D, so the paths do not write depth themselves.
export const roadSurfaceDepth = {
  getPolygonOffset: ({
    layerIndex,
  }: {
    layerIndex: number;
  }): [number, number] => [-1, -layerIndex * 100],
  parameters: { depthCompare: "less-equal" as const, depthWriteEnabled: false },
};
