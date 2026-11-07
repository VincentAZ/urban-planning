import {
  buildingAreaSqm,
  buildingProgramTotals,
  hasImportExtensions,
  BUILDING_QUANTITY_FIELDS,
  buildingGeometry,
  buildingTypologyLabels,
  landUseLabels,
  materializeBuildings,
  studyAreaPolygons,
} from "@urban/core";
import type { ReportSnapshot } from "./exports";
import { ApiError } from "./errors";
import { reportSources } from "./report-content";

export interface BuildingReportComponent {
  id: string;
  name: string;
  use: string;
  grossFloorAreaSqm: number;
  units: number;
  jobs: number;
  beds: number | null;
  tripRate: string;
  parkingRate: string;
  sourceIds: string[];
  sources: string;
}
export interface BuildingReportItem {
  side: "Frozen baseline" | "Proposal";
  id: string;
  name: string;
  typology: string;
  geometryType: string;
  parts: number;
  holes: number;
  footprintSqm: number;
  grossFloorAreaSqm: number | null;
  height: number | null;
  floors: number | null;
  attributeProvenance: string;
  attributeDetails: string[];
  commonAreaSqm: number | null;
  units: number | null;
  jobs: number | null;
  parkingSupply: number | null;
  sourceFeatureId: string;
  summary: string;
  sources: string;
  components: BuildingReportComponent[];
}

/** Legacy-only reports retain their existing layout. New authoring records receive an explicit inventory. */
export function buildingReportItems(
  snapshot: ReportSnapshot,
  format: "document" | "workbook" = "document",
): BuildingReportItem[] {
  let rowCount = 0,
    buildingCount = 0;
  const sources = reportSources(snapshot);
  const sourceLabel = (id: string) => {
    const index = sources.findIndex((source) => source.id === id);
    return index < 0
      ? `Unresolved source ${id}`
      : `[${index + 1}] ${sources[index].name}`;
  };
  const baseline = snapshot.project.scenarios.find(
    (scenario) => scenario.id === "baseline",
  );
  const sides = [
    ...(baseline
      ? [{ side: "Frozen baseline" as const, scenario: baseline }]
      : []),
    { side: "Proposal" as const, scenario: snapshot.scenario },
  ];
  return sides.flatMap(({ side, scenario }) =>
    materializeBuildings(snapshot.place, scenario)
      .filter(
        (building) =>
          building.geometry !== undefined ||
          building.program !== undefined ||
          building.typology !== undefined ||
          hasImportExtensions(building),
      )
      .map((building) => {
        rowCount += Math.max(1, building.program?.components.length ?? 0);
        buildingCount++;
        if (
          rowCount > (format === "document" ? 2000 : 20000) ||
          (format === "document" && buildingCount > 500)
        )
          throw new ApiError(
            413,
            "BUILDING_REPORT_TOO_LARGE",
            "This export exceeds the bounded building-program inventory limit. No rows were omitted. Use complete project or GeoJSON export, or a smaller study area.",
          );
        const geometry = buildingGeometry(building),
          parts = studyAreaPolygons(geometry),
          program = building.program;
        const sourceIds = [
          ...new Set(
            [
              building.sourceId,
              building.attributeSourceId,
              building.geometrySourceId,
              building.programSourceId,
              ...Object.values(building.attributeProvenance?.fields ?? {}).map(
                (e) => e?.sourceId,
              ),
              building.attributeProvenance?.use?.sourceId,
            ].filter((id): id is string => Boolean(id)),
          ),
        ];
        const rate = (
          value: NonNullable<typeof program>["components"][number]["tripRate"],
        ) =>
          value
            ? `${value.value} per ${value.basis}; ${sourceLabel(value.sourceId)}`
            : "Scenario default (see recorded assumptions)";
        const footprintSqm = buildingAreaSqm(building);
        const grossFloorAreaSqm =
          buildingProgramTotals(building).grossFloorAreaSqm;
        const discrepancy =
          program &&
          building.floors !== null &&
          Math.abs(program.grossFloorAreaSqm - footprintSqm * building.floors) >
            Math.max(0.001, program.grossFloorAreaSqm * 1e-9);
        const quantity = (v: number | null) =>
          v === null ? "Unknown" : v.toLocaleString("en-US");
        const labels = {
          height: "Height",
          floors: "Floors",
          units: "Homes",
          jobs: "Jobs",
          parkingSpaces: "Parking supply",
        };
        const attributeDetails = BUILDING_QUANTITY_FIELDS.flatMap((field) => {
          const e = building.attributeProvenance?.fields[field];
          return e
            ? [
                `${labels[field]}: ${quantity(building[field])}; ${e.status}. Source: ${sourceLabel(e.sourceId)}.${e.sourceField !== undefined ? ` Field: ${e.sourceField}.` : ""}${e.sourceUnit ? ` Source unit: ${e.sourceUnit}.` : ""}${e.rawValue !== undefined ? ` Raw value: ${JSON.stringify(e.rawValue)}.` : ""}${e.method ? ` Method: ${e.method}` : ""}`,
              ]
            : [];
        });
        if (building.attributeProvenance?.use) {
          const e = building.attributeProvenance.use;
          attributeDetails.push(
            `Land use: ${landUseLabels[building.use]}; ${e.status}. Source: ${sourceLabel(e.sourceId)}.${e.sourceField !== undefined ? ` Field: ${e.sourceField}.` : ""}${e.rawValue !== undefined ? ` Raw value: ${JSON.stringify(e.rawValue)}.` : ""}${e.method ? ` Method: ${e.method}` : ""}`,
          );
        }
        return {
          side,
          id: building.id,
          name: building.name,
          typology: building.typology
            ? buildingTypologyLabels[building.typology]
            : landUseLabels[building.use],
          geometryType: geometry.type,
          parts: parts.length,
          holes: parts.reduce((count, rings) => count + rings.length - 1, 0),
          footprintSqm,
          grossFloorAreaSqm,
          commonAreaSqm: program?.commonAreaSqm ?? null,
          height: building.height,
          floors: building.floors,
          attributeDetails,
          attributeProvenance: building.attributeProvenance
            ? JSON.stringify(building.attributeProvenance)
            : "",
          units: building.units,
          jobs: building.jobs,
          parkingSupply: building.parkingSpaces,
          sourceFeatureId: building.sourceFeatureId ?? "Not supplied",
          summary: `${geometry.type}; ${parts.length} part(s), ${parts.reduce((count, rings) => count + rings.length - 1, 0)} hole(s). Footprint ${footprintSqm.toLocaleString("en-US", { maximumFractionDigits: 2 })} m². ${program ? `Explicit floor area ${program.grossFloorAreaSqm.toLocaleString("en-US")} m², including ${program.commonAreaSqm.toLocaleString("en-US")} m² common area.` : grossFloorAreaSqm === null ? "No component program supplied; gross floor area is unavailable because floors are unknown." : "No component program supplied; legacy use/floor assumptions apply."} ${quantity(building.units)} homes; ${quantity(building.jobs)} jobs; ${quantity(building.parkingSpaces)} supplied parking spaces. Height: ${quantity(building.height)} m; floors: ${quantity(building.floors)}. Unknown quantities are not zero. Parking supply is separate from calculated demand.${discrepancy ? " Explicit floor area differs from footprint × floors; the program controls calculations." : ""} Map massing uses one height for the feature and does not depict floor-by-floor use, setbacks, or component heights.`,
          sources: sourceIds.map(sourceLabel).join("; "),
          components: (program?.components ?? []).map((component) => ({
            id: component.id,
            name: component.name ?? landUseLabels[component.use],
            use: `${landUseLabels[component.use]}${component.residentialSubtype ? ` (${component.residentialSubtype})` : ""}`,
            grossFloorAreaSqm: component.grossFloorAreaSqm,
            units: component.units,
            jobs: component.jobs,
            beds: component.beds ?? null,
            tripRate: rate(component.tripRate),
            parkingRate: rate(component.parkingRate),
            sourceIds: [
              ...new Set(
                [
                  component.sourceId,
                  component.tripRate?.sourceId,
                  component.parkingRate?.sourceId,
                ].filter((id): id is string => Boolean(id)),
              ),
            ],
            sources: component.sourceId
              ? sourceLabel(component.sourceId)
              : "Building program source",
          })),
        };
      }),
  );
}

export const buildingComponentTable = (item: BuildingReportItem): string[][] =>
  item.components.map((component) => [
    `${component.name}\n${component.use}\n${component.sources}`,
    component.grossFloorAreaSqm.toLocaleString("en-US", {
      maximumFractionDigits: 2,
    }),
    `${component.units} homes\n${component.jobs} jobs${component.beds === null ? "" : `\n${component.beds} beds`}`,
    `Trips: ${component.tripRate}\nParking demand: ${component.parkingRate}`,
  ]);
