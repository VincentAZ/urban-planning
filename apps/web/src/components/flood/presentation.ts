import type { FloodDataset, FloodZoneFeature } from "@urban/core";
import type { FloodBuildingExposure, FloodExposureSide } from "@urban/models";
export const FLOOD_CAVEAT =
  "Footprint screening against a captured effective FEMA map. Homes are counted once per intersecting building, not prorated by area. This is not a flood prediction, insurance decision, or regulatory determination.";
export function floodZoneKind(
  zone: FloodZoneFeature,
): "sfha" | "floodway" | "moderate" | "other" | "unknown" {
  if (zone.classification === "undetermined") return "unknown";
  if (/FLOODWAY/i.test(zone.attributes.ZONE_SUBTY ?? "")) return "floodway";
  if (zone.classification === "sfha") return "sfha";
  if (/0\.2|500.YEAR/i.test(zone.attributes.ZONE_SUBTY ?? ""))
    return "moderate";
  return "other";
}
export const floodColors = {
  sfha: [48, 130, 171, 68],
  floodway: [49, 81, 148, 90],
  moderate: [64, 163, 163, 45],
  other: [158, 172, 151, 16],
  unknown: [184, 135, 62, 60],
} as const;
export const floodLabels = {
  sfha: "1% annual-chance / SFHA",
  floodway: "Regulatory floodway",
  moderate: "0.2% annual-chance",
  other: "Other mapped zone",
  unknown: "Undetermined / Zone D",
};
export function floodStatus(row: FloodBuildingExposure) {
  return row.status === "intersects-sfha"
    ? "SFHA footprint intersection"
    : row.status === "no-sfha-intersection"
      ? "No SFHA intersection in mapped footprint"
      : "Coverage or classification undetermined";
}
export function floodCount(side: FloodExposureSide) {
  return side.value !== null
    ? side.value.toLocaleString()
    : side.knownSubtotal !== null
      ? `${side.knownSubtotal.toLocaleString()} known subtotal`
      : "Unavailable";
}
/** FEMA panel, revision and study dates have different meanings; never flatten them. */
export function floodDates(dataset: FloodDataset): string[] {
  const recordedDate = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined || value === "")
      return "Not supplied";
    const date =
      typeof value === "number" && Number.isFinite(value)
        ? new Date(value)
        : null;
    const text =
      date && Number.isFinite(date.valueOf())
        ? date.toISOString().slice(0, 10)
        : String(value);
    if (/^9999-09-09/.test(text))
      return `Not supplied / source placeholder (${text})`;
    return text;
  };
  const field = (
    attributes: Record<string, string | number | null>,
    names: string[],
  ) => {
    for (const name of names)
      if (attributes[name] !== undefined && attributes[name] !== null)
        return attributes[name];
    return undefined;
  };
  const rows: string[] = [];
  for (const panel of dataset.panels) {
    const id =
      field(panel.attributes, ["FIRM_PAN", "PANEL", "PANEL_ID"]) ?? panel.id;
    rows.push(
      `Panel ${id} · effective: ${recordedDate(field(panel.attributes, ["EFF_DATE", "EFFECTIVE", "EFF_DT"]))}`,
    );
    if (
      panel.attributes.PRE_DATE !== undefined &&
      panel.attributes.PRE_DATE !== null
    )
      rows.push(
        `Panel ${id} · preliminary source date (not effective): ${recordedDate(panel.attributes.PRE_DATE)}`,
      );
  }
  for (const revision of dataset.revisions) {
    const id =
      field(revision.attributes, ["CASE_NO", "CASE_NUM"]) ?? revision.id;
    rows.push(
      `Map revision ${id} · effective: ${recordedDate(field(revision.attributes, ["EFF_DATE", "EFFECTIVE", "EFF_DT"]))}`,
    );
  }
  for (const study of dataset.capture.studyInfo) {
    const id = study.DFIRM_ID ?? "identifier not supplied";
    rows.push(
      `Study ${id} · database revision: ${recordedDate(field(study, ["DBREV_DT", "DBREV_DATE"]))}`,
    );
    rows.push(
      `Study ${id} · index effective: ${recordedDate(field(study, ["INDX_EFFDT", "EFF_DATE", "EFF_DT"]))}`,
    );
  }
  return rows;
}
