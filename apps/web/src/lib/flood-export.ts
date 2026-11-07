import {
  materializeBuildings,
  floodMethodVersion,
  type FloodDataset,
  type Place,
  type Scenario,
} from "@urban/core";
import type { FloodResolution, ModelContext } from "@urban/models";
import { download } from "./api";
import {
  FLOOD_CAVEAT,
  floodStatus,
  floodCount,
} from "../components/flood/presentation";
const csv = (value: unknown) => {
  const text = typeof value === "number" ? String(value) : String(value ?? "");
  return `"${(typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function floodCSV(
  place: Place,
  scenario: Scenario,
  context: ModelContext,
  resolution: FloodResolution,
): string {
  assertFloodResult(scenario, resolution);
  const dataset =
    scenario.flood && context.floodDatasets?.[scenario.flood.datasetHash];
  const proposal = new Map(
    materializeBuildings(place, scenario).map((b) => [b.id, b.name]),
  );
  const baseline = new Map(place.buildings.map((b) => [b.id, b.name]));
  const header = [
    "scenario_id",
    "revision",
    "side",
    "building_id",
    "building_name",
    "status",
    "homes",
    "counted_exposed_homes",
    "sfha_intersection_sqm",
    "unclassified_area_sqm",
    "zone_ids",
    "notes",
    "dataset_hash",
    "origin",
    "captured_at",
    "method",
    "sources",
    "method_caveat",
  ];
  const rows = (["baseline", "scenario"] as const).flatMap((side) =>
    resolution[side].buildings.map((row) => [
      scenario.id,
      scenario.revision,
      side,
      row.buildingId,
      (side === "baseline" ? baseline : proposal).get(row.buildingId),
      row.status,
      row.units,
      row.exposedUnits,
      row.intersectionAreaSqm,
      row.unclassifiedAreaSqm,
      JSON.stringify(row.zoneIds),
      JSON.stringify(row.notes),
      resolution.datasetHash,
      scenario.flood?.origin,
      dataset?.capturedAt,
      resolution.methodVersion,
      JSON.stringify(dataset?.sources ?? []),
      FLOOD_CAVEAT,
    ]),
  );
  return [header, ...rows].map((row) => row.map(csv).join(",")).join("\r\n");
}
export function exportFloodCSV(
  place: Place,
  scenario: Scenario,
  context: ModelContext,
  resolution: FloodResolution,
) {
  download(
    `flood-exposure-r${scenario.revision}.csv`,
    floodCSV(place, scenario, context, resolution),
    "text/csv",
  );
}
export function floodHTML(
  place: Place,
  scenario: Scenario,
  context: ModelContext = {},
  resolution?: FloodResolution | null,
) {
  if (!scenario.flood) return "";
  assertFloodResult(scenario, resolution);
  const dataset = context.floodDatasets?.[scenario.flood.datasetHash];
  return `<section><h2>Captured flood-map exposure</h2><p>${esc(FLOOD_CAVEAT)}</p><p>${scenario.flood.origin === "imported" ? "Imported source pack · not verified by this server" : "Captured catalog source"} · ${esc(dataset?.capturedAt ?? "Source pack unavailable")} · ${esc(scenario.flood.datasetHash)}</p><p>Calculation method: ${esc(resolution.methodVersion)}</p><p>Potential homes in intersecting buildings: baseline ${esc(floodCount(resolution.baseline))}; proposal ${esc(floodCount(resolution.scenario))}.</p>${resolution.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}<table><thead><tr><th>Building</th><th>Footprint screen</th><th>Homes</th><th>Zone IDs</th></tr></thead><tbody>${resolution.scenario.buildings.map((r) => `<tr><td>${esc(r.buildingId)}</td><td>${esc(floodStatus(r))}</td><td>${r.units === null ? "Unknown" : esc(r.units)}</td><td>${esc(r.zoneIds.join(", "))}</td></tr>`).join("")}</tbody></table>${dataset?.sources.map((s) => `<p>${esc(s.name)} · ${esc(s.vintage)} · ${esc(s.url)} · ${esc(s.license)}</p>`).join("") ?? ""}</section>`;
}

function assertFloodResult(
  scenario: Scenario,
  resolution: FloodResolution | null | undefined,
): asserts resolution is FloodResolution {
  if (
    !resolution ||
    resolution.datasetHash !== scenario.flood?.datasetHash ||
    resolution.methodVersion !== floodMethodVersion(scenario.flood)
  )
    throw new Error(
      "Wait for the current flood exposure calculation before exporting.",
    );
}
