/** Shared, explicitly illustrative OSM attribute inference, not observed residents or employment. */
import type { LandUse } from "@urban/core";
export function inferOsmUse(
  tags: Record<string, string>,
  footprintArea: number,
): LandUse {
  if (tags.leisure === "park") return "park";
  if (["hospital", "clinic", "doctors"].includes(tags.amenity))
    return "healthcare";
  if (
    ["school", "university", "college", "kindergarten"].includes(tags.amenity)
  )
    return "school";
  if (
    ["parking", "parking_entrance"].includes(tags.amenity) ||
    tags.building === "parking"
  )
    return "parking";
  if (
    [
      "place_of_worship",
      "library",
      "townhall",
      "courthouse",
      "community_centre",
    ].includes(tags.amenity)
  )
    return "civic";
  if (tags.building === "apartments" || tags.building === "dormitory")
    return "multifamily";
  if (
    ["house", "detached", "residential", "terrace", "bungalow"].includes(
      tags.building,
    )
  )
    return "residential";
  if (
    tags.shop ||
    ["restaurant", "cafe", "bar", "fast_food", "pub"].includes(tags.amenity) ||
    tags.building === "retail"
  )
    return "retail";
  if (tags.building === "warehouse") return "warehouse";
  if (tags.building === "industrial") return "industrial";
  if (
    tags.building === "commercial" ||
    tags.building === "office" ||
    tags.office
  )
    return "office";
  if (tags.building === "hotel") return "office";
  return footprintArea < 200 ? "residential" : "office";
}
// Explicit illustrative density assumptions; these are not employer observations.
const jobsPer1000Sqft: Record<LandUse, number> = {
  residential: 0,
  multifamily: 0,
  retail: 2,
  office: 4,
  industrial: 1.5,
  warehouse: 0.5,
  school: 2,
  healthcare: 3,
  civic: 3,
  "mixed-use": 2,
  park: 0,
  parking: 0,
  vacant: 0,
};

export function inferOsmAttributes(
  tags: Record<string, string>,
  areaSqm: number,
) {
  const use = inferOsmUse(tags, areaSqm);
  const rawHeight = Number.parseFloat(tags.height ?? "");
  const measuredHeight =
    Number.isFinite(rawHeight) && rawHeight > 0
      ? rawHeight * (tags.height.toLowerCase().includes("ft") ? 0.3048 : 1)
      : undefined;
  const rawFloors = Number.parseInt(tags["building:levels"] ?? "", 10);
  const floors =
    use === "park"
      ? 0
      : Math.max(
          1,
          Math.min(
            250,
            rawFloors > 0
              ? rawFloors
              : measuredHeight
                ? Math.round(measuredHeight / 3.5)
                : use === "multifamily"
                  ? 4
                  : use === "office" && areaSqm > 1800
                    ? 5
                    : use === "office" && areaSqm > 700
                      ? 3
                      : 1,
          ),
        );
  const height = use === "park" ? 0.3 : (measuredHeight ?? floors * 3.5);
  const flats = Number.parseInt(tags["building:flats"] ?? "", 10);
  const units =
    Number.isFinite(flats) && flats >= 0
      ? flats
      : use === "residential"
        ? 1
        : use === "multifamily"
          ? Math.max(1, Math.round((areaSqm * floors) / 100))
          : 0;
  return {
    use,
    floors,
    height: Math.round(Math.min(1500, height) * 10) / 10,
    units,
    jobs: Math.round(
      ((areaSqm * floors * 10.7639104167) / 1000) * jobsPer1000Sqft[use],
    ),
    parkingSpaces: use === "parking" ? Math.floor((areaSqm * floors) / 30) : 0,
  };
}
export const OSM_INFERENCE_DESCRIPTION =
  "Illustrative OSM inference v1.1: mapped use tags where present; otherwise footprints below 200 m² are assumed residential and larger footprints office. Missing height uses levels × 3.5 m; missing floors use mapped height or use/footprint heuristics (1–5 floors). Mapped flats are used when present; otherwise one home per assumed house or 100 m² gross floor area per apartment. Jobs use gross floor area × illustrative jobs per 1,000 ft² (office4, retail/school2, industrial1.5, warehouse0.5, healthcare/civic3). Parking structures use30 m² per space. These are unvalidated capacity estimates, not observed population/employment/parking. Geometry completeness varies; review all assumptions.";
