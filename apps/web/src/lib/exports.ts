import {
  housingHTML,
  assertHousingExportAllowed,
  assertHousingProjectExportAllowed,
  assertHousingResultExportAllowed,
} from "./housing-export";
import { floodHTML } from "./flood-export";
import {
  fiscalHTML,
  assertFiscalExportAllowed,
  assertFiscalResultExportAllowed,
} from "./fiscal-export";
import type { ModelContext, FloodResolution } from "@urban/models";
import { trafficHTML, type TrafficExportStatus } from "./traffic-export";
import { resolveActivity } from "@urban/models";
import type {
  MetricResult,
  ModelResults,
  Place,
  Project,
  Scenario,
} from "@urban/core";
import {
  baselineIdentity,
  materializeBuildings,
  buildingGeometry,
  buildingAreaSqm,
  materializeRoads,
  materializeParcels,
  parcelAreaSqm,
  studyAreaSqm,
} from "@urban/core";
import { download } from "./api";
import { retailHTML } from "./retail-export";
import { workforceHTML } from "./workforce-export";
import { accessibilityHTML } from "./accessibility-export";
import { planningSources } from "./source-inventory";
export function exportCSV(
  results: ModelResults,
  context?: { place: Place; project: Project; scenario: Scenario },
) {
  if (results.fiscal || context?.project.fiscalStudy) {
    if (!context)
      throw new Error("The scorecard export needs the matching fiscal study.");
    assertFiscalResultExportAllowed(
      context.place,
      context.project,
      context.scenario,
      results,
    );
  }
  if (results.affordability || context?.scenario.affordability) {
    if (!context)
      throw new Error(
        "The scorecard export needs the matching housing evidence.",
      );
    assertHousingResultExportAllowed(
      context.place,
      context.project,
      context.scenario,
      results,
    );
  }
  const escape = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = [
    [
      "Metric",
      "Domain",
      "Unit",
      "Baseline",
      "Scenario",
      "Delta",
      "Status",
      "Method",
      "Revision",
      "Formula",
      "Caveat",
      "baseline_known_subtotal",
      "scenario_known_subtotal",
      "baseline_missing_building_ids",
      "scenario_missing_building_ids",
    ],
    ...results.metrics.map((m) => [
      m.label,
      m.domain,
      m.unit,
      m.baseline,
      m.value,
      m.delta,
      m.status,
      m.method,
      m.scenarioRevision,
      m.formula,
      m.caveat,
      m.coverage?.baseline.knownSubtotal,
      m.coverage?.scenario.knownSubtotal,
      JSON.stringify(m.coverage?.baseline.missingBuildingIds ?? []),
      JSON.stringify(m.coverage?.scenario.missingBuildingIds ?? []),
    ]),
  ];
  download(
    "urban-planning-scorecard.csv",
    rows.map((row) => row.map(escape).join(",")).join("\r\n"),
    "text/csv",
  );
}
export function exportGeoJSON(
  place: Place,
  scenario: Scenario,
  context: ModelContext = {},
) {
  assertFiscalExportAllowed(context.fiscalStudy);
  assertHousingExportAllowed(scenario, context.housingIncomeLimits);
  const geo = {
    type: "FeatureCollection",
    metadata: {
      place: place.name,
      placeId: place.id,
      scenario: scenario.name,
      scenarioId: scenario.id,
      revision: scenario.revision,
      sources: planningSources(place, scenario),
      ...(scenario.affordability
        ? {
            housing: {
              controls: scenario.affordability,
              incomeLimits: Object.fromEntries(
                [
                  ...new Set(
                    [
                      ...scenario.affordability.baselineGroups,
                      ...scenario.affordability.proposalGroups,
                    ].map((g) => g.areaHash),
                  ),
                ].map((hash) => [hash, context.housingIncomeLimits?.[hash]]),
              ),
            },
          }
        : {}),
      ...(context.fiscalStudy
        ? { fiscalStudy: context.fiscalStudy, fiscalControls: scenario.fiscal }
        : {}),
      ...(scenario.flood
        ? {
            flood: scenario.flood,
            floodDataset:
              context.floodDatasets?.[scenario.flood.datasetHash] ?? null,
            floodScope:
              "Captured FEMA footprint screening; missing coverage is unknown. Not a regulatory determination.",
          }
        : {}),
      ...(scenario.activity ? { activity: scenario.activity } : {}),
      ...(scenario.retail ? { retail: scenario.retail } : {}),
      ...(scenario.traffic
        ? {
            traffic: scenario.traffic,
            trafficScope:
              "Explicit network experiment; planning-road freshness must be checked against the retained binding before reuse. Native graph and per-vehicle rows are not included.",
          }
        : {}),
      ...(scenario.accessibility
        ? {
            accessibility: scenario.accessibility,
            accessibilityScope:
              "Captured outbound regional network, not proposal effects. Exact contours are archived separately.",
          }
        : {}),
      ...(scenario.workforce
        ? {
            workforce: scenario.workforce,
            workforceGeometry:
              "Regional contours are archived separately by the retained contour hash.",
          }
        : {}),
      ...(place.vehicleAvailability
        ? { vehicleAvailability: place.vehicleAvailability }
        : {}),
    },
    features: [
      ...(scenario.activity?.neighborhoods ?? []).map((area) => ({
        type: "Feature",
        id: area.id,
        geometry: area.geometry,
        properties: {
          ...area,
          geometry: undefined,
          featureType: "activity-neighborhood",
          areaSqm: studyAreaSqm(area.geometry),
          boundaryStatus:
            "Authored planning allocation; not an observed Census or legal neighborhood",
          scenarioId: scenario.id,
          scenarioRevision: scenario.revision,
        },
      })),
      ...materializeBuildings(place, scenario).map((b) => ({
        type: "Feature",
        id: b.id,
        geometry: buildingGeometry(b),
        properties: {
          ...b,
          featureType: "building",
          footprint: undefined,
          geometry: undefined,
          areaSqm: buildingAreaSqm(b),
          scenarioId: scenario.id,
          scenarioRevision: scenario.revision,
        },
      })),
      ...materializeRoads(place, scenario).map((road) => ({
        type: "Feature",
        id: road.id,
        geometry: { type: "LineString", coordinates: road.coordinates },
        properties: {
          ...road,
          featureType: "road",
          coordinates: undefined,
          scenarioId: scenario.id,
          scenarioRevision: scenario.revision,
        },
      })),
      ...materializeParcels(place, scenario).map((parcel) => ({
        type: "Feature",
        id: parcel.id,
        geometry: parcel.geometry,
        properties: {
          ...parcel,
          geometry: undefined,
          featureType: parcel.kind,
          areaSqm: parcelAreaSqm(parcel),
          boundaryStatus:
            parcel.lineage?.operation === "import"
              ? "user-supplied boundary; legal status unverified"
              : parcel.lineage
                ? "planning proposal; not a legal subdivision"
                : "captured source boundary; legal status unverified",
          scenarioId: scenario.id,
          scenarioRevision: scenario.revision,
        },
      })),
    ],
  };
  download(
    "urban-planning-scenario.geojson",
    JSON.stringify(geo, null, 2),
    "application/geo+json",
  );
}
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function metricCoverageHTML(metric: MetricResult): string {
  if (!metric.coverage) return "";
  return (["baseline", "scenario"] as const)
    .map((side) => {
      const coverage = metric.coverage![side],
        label = side === "baseline" ? "Baseline" : "Proposal",
        missing = coverage.missingBuildingIds.length;
      if (!missing)
        return `<p>${label} completeness: no required building attributes are missing for this measure.</p>`;
      const subtotal =
        "knownSubtotal" in coverage
          ? ` Known subtotal: ${coverage.knownSubtotal == null ? "Unknown" : `${esc(coverage.knownSubtotal)} ${esc(metric.unit)}`}; not a complete total.`
          : "";
      return `<p class="notice">${label} completeness: ${missing} ${missing === 1 ? "building lacks" : "buildings lack"} required attributes.${subtotal} Complete missing-building identifier lists are retained in the CSV and project JSON exports.</p>`;
    })
    .join("");
}
function buildingProgramHTML(place: Place, scenario: Scenario) {
  const sides = [
    { label: "Frozen baseline", buildings: place.buildings },
    { label: "Proposal", buildings: materializeBuildings(place, scenario) },
  ];
  let rows = 0;
  const sections = sides.flatMap(({ label, buildings }) =>
    buildings
      .filter((b) => b.geometry || b.program || b.typology)
      .map((building) => {
        rows += Math.max(1, building.program?.components.length ?? 0);
        if (rows > 2000)
          throw new Error(
            "The building-program inventory exceeds this browser report's 2,000-row limit. No records were omitted; use the complete project or GeoJSON export.",
          );
        const program = building.program;
        const rate = (
          value: NonNullable<typeof program>["components"][number]["tripRate"],
        ) =>
          value
            ? `${value.value} per ${value.basis} · source ${value.sourceId}`
            : "Scenario default; see assumptions";
        return `<section><h3>${esc(label)}: ${esc(building.name)}</h3><p>${esc(building.typology ?? building.use)} · ${esc(buildingGeometry(building).type)} · ${esc(buildingAreaSqm(building).toLocaleString())} m² footprint. Source reference: ${esc(building.sourceFeatureId ?? "Not supplied")}.</p>${program ? `<p>Declared floor area: ${esc(program.grossFloorAreaSqm)} m²; common area: ${esc(program.commonAreaSqm)} m². Component homes/jobs are authoritative and counted once. Parking supply: ${building.parkingSpaces === null ? "Unknown" : `${esc(building.parkingSpaces)} spaces`}, separate from demand.</p><table><thead><tr><th>Component / use</th><th>Floor area m²</th><th>Homes / jobs / beds</th><th>Trip and parking rates</th></tr></thead><tbody>${program.components.map((component) => `<tr><td>${esc(component.name ?? component.use)}<br>${esc(component.use)} ${esc(component.residentialSubtype ?? "")}</td><td>${esc(component.grossFloorAreaSqm)}</td><td>${esc(component.units)} homes; ${esc(component.jobs)} jobs${component.beds === undefined ? "" : `; ${esc(component.beds)} beds`}</td><td>Trips: ${esc(rate(component.tripRate))}<br>Parking demand: ${esc(rate(component.parkingRate))}</td></tr>`).join("")}</tbody></table>` : "<p>No explicit program; legacy use/floor assumptions apply.</p>"}<p class="muted">One height is displayed for every component of this feature; this is schematic massing, not floor-by-floor design. Sources: ${esc([building.sourceId, building.geometrySourceId, building.programSourceId].filter(Boolean).join("; "))}.</p></section>`;
      }),
  );
  return sections.length
    ? `<h2>Building geometry and programs</h2>${sections.join("")}`
    : "";
}
function activityHTML(place: Place, scenario: Scenario) {
  const activity = scenario.activity;
  if (!activity) return "";
  const resolved = resolveActivity(place, scenario);
  const target = (value?: import("@urban/core").CountTarget) =>
    !value
      ? "No override"
      : value.mode === "absolute"
        ? `${value.value} absolute`
        : `${value.percent}% of captured year-zero reference`;
  const count = (value: number | null) =>
    value === null
      ? "Unavailable"
      : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const controls = [
    ["Population", activity.global.population, resolved.population],
    ["Workplace employment", activity.global.employment, resolved.employment],
    [
      "Household vehicles available",
      activity.global.householdVehicles,
      resolved.vehicles,
    ],
  ] as const;
  return `<h2>Population, employment and vehicles</h2><p class="notice">Authored targets and modeled allocations, not observed neighborhood counts. Targets apply at the selected horizon without growing them again. Area overrides replace their allocated counts; the rest is not rebalanced. Vehicle stock is separate from road traffic, trips and visible agents. Building records remain unchanged.</p><table><thead><tr><th>Count</th><th>Target</th><th>Captured reference</th><th>Horizon baseline / scenario</th></tr></thead><tbody>${controls.map(([label, control, value]) => `<tr><td>${esc(label)}</td><td>${esc(target(control))}</td><td>${esc(count(value.reference))}<br>${esc(value.referenceLabel)}</td><td>${esc(count(value.baseline))} / ${esc(count(value.value))}</td></tr>`).join("")}</tbody></table><p>Allocation: population ${esc(activity.allocation.population)}; employment ${esc(activity.allocation.employment)}. Demand sensitivity: population ${esc(activity.demandResponse.population)}; employment ${esc(activity.demandResponse.employment)}; vehicles ${esc(activity.demandResponse.vehicles)}. Review recorded: ${activity.demandResponse.reviewed ? "yes" : "no"}; source ${esc(activity.demandResponse.sourceId)}.</p>${activity.neighborhoods.map((area, i) => `<h3>${esc(area.name)}</h3><p>Area ID ${esc(area.id)}; ${esc(resolved.neighborhoods[i].areaSqm)} m²; source ${esc(area.sourceId)}. Population ${esc(target(area.population))}, result ${esc(count(resolved.neighborhoods[i].population.value))}; employment ${esc(target(area.employment))}, result ${esc(count(resolved.neighborhoods[i].employment.value))}. Complete ${esc(area.geometry.type)} geometry remains in project and GeoJSON exports.</p>`).join("")}${resolved.warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join("")}<details><summary>Exact saved controls and reference evidence</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(activity, null, 2))}</pre></details>`;
}
export function reportHTML(
  place: Place,
  scenario: Scenario,
  results: ModelResults,
  image?: string,
  trafficStatus?: TrafficExportStatus,
  context: ModelContext = {},
  floodResolution?: FloodResolution | null,
) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(scenario.name)} — Urban Planning</title><style>@page{size:letter;margin:18mm}body{font:12px/1.55 Arial,sans-serif;color:#203f38;max-width:860px;margin:32px auto}h1{font-size:30px}h2{font-size:18px;margin-top:28px}.brand{letter-spacing:3px;font-size:11px;font-weight:bold}.muted{color:#62746c}.notice{background:#f5f1e5;padding:12px;border-left:3px solid #bb8b4f}table{border-collapse:collapse;width:100%;font-size:11px}th,td{padding:9px 7px;border-bottom:1px solid #ddd;text-align:left}thead{display:table-header-group}tr{break-inside:avoid}.method{break-inside:avoid;margin-bottom:20px}.image{width:100%;max-height:300px;object-fit:cover}footer{font-size:10px;border-top:1px solid #ddd;margin-top:30px;padding-top:12px}@media print{.print-button{display:none}body{margin:0}}button{padding:12px 22px;background:#18594e;color:white;border:0;border-radius:5px}</style></head><body><button class="print-button" onclick="window.print()">Print / Save as PDF</button><p class="brand">URBAN PLANNING / DECISION BRIEF</p><h1>${esc(scenario.name)}</h1><p>${esc(place.name)} · ${esc(place.city)}, ${esc(place.state)} ${esc(place.zip)}</p><p class="muted">${esc(place.extentLabel)} · Revision ${scenario.revision} · ${new Date().toLocaleDateString()} · ${scenario.horizon === 0 ? "Current conditions" : `${scenario.horizon}-year horizon`}</p>${image ? `<img class="image" alt="Scenario map" src="${esc(image)}">` : ""}<p>${esc(scenario.description || "A planning scenario exploring changes to the built environment.")}</p><div class="notice">Planning estimates. Inferred attributes and illustrative assumptions are identified below. This report is not an engineering study or an entitlement determination.</div><h2>Baseline and scenario outcomes</h2><table><thead><tr><th>Measure</th><th>Baseline</th><th>Scenario</th><th>Change</th><th>Status</th></tr></thead><tbody>${results.metrics.map((m) => `<tr><td>${esc(m.label)}<br><span class="muted">${esc(m.unit)}</span></td><td>${m.baseline === null ? "—" : esc(Math.round(m.baseline * 100) / 100)}</td><td>${m.value === null ? "—" : esc(Math.round(m.value * 100) / 100)}</td><td>${m.delta === null ? "—" : esc(Math.round(m.delta * 100) / 100)}</td><td>${esc(m.status)}</td></tr>`).join("")}</tbody></table><h2>Methodology & assumptions</h2>${results.metrics.map((m) => `<div class="method"><h3>${esc(m.label)}</h3><p>${esc(m.explanation)}</p><p><strong>Formula:</strong> ${esc(m.formula)}</p><p>${esc(m.method)} · ${esc(m.methodVersion)} · ${esc(m.geography)}</p>${m.caveat ? `<p class="notice">${esc(m.caveat)}</p>` : ""}${metricCoverageHTML(m)}<ul>${m.inputs.map((i) => `<li>${esc(i.name)}: ${esc(i.value)} (${esc(i.source)})</li>`).join("")}</ul></div>`).join("")}${buildingProgramHTML(place, scenario)}${activityHTML(place, scenario)}${fiscalHTML(place, scenario, results, context.fiscalStudy)}${housingHTML(place, { housingIncomeLimits: context.housingIncomeLimits }, scenario, results)}${retailHTML(place, scenario, results.modelVersion)}${workforceHTML(scenario)}${accessibilityHTML(scenario)}${trafficHTML(scenario, trafficStatus)}${floodHTML(place, scenario, context, floodResolution)}<h2>Source inventory</h2>${planningSources(
    place,
    scenario,
  )
    .map(
      (s) =>
        `<p><strong>${esc(s.name)}</strong> · ${esc(s.vintage)} · ${esc(s.kind)}<br>${esc(s.url)}<br>${esc(s.license)}</p>`,
    )
    .join(
      "",
    )}<footer>Urban Planning · Free planning tools for better-informed places.<br>Scenario ${esc(scenario.id)} · Revision ${scenario.revision} · Model ${esc(results.modelVersion)}</footer></body></html>`;
}
export async function exportProject(
  project: Project,
  place: Place,
  results: ModelResults,
) {
  assertFiscalExportAllowed(project.fiscalStudy);
  assertHousingProjectExportAllowed(project);
  const identity = await baselineIdentity(place);
  download(
    "urban-planning-project.json",
    JSON.stringify(
      { project, place, baselineIdentity: identity, results },
      null,
      2,
    ),
  );
}
