import {
  materializeBuildings,
  materializeRoads,
  materializeParcels,
  buildingGeometry,
  floodDatasetHashSync,
  validateFloodDataset,
  type FloodDatasetCatalog,
  type Place,
  type Scenario,
} from "@urban/core";
import type { GisExportLayer } from "./gis-types.js";
import type { GisRuntime } from "./gis-runtime.js";
import {
  floodGeoJsonFeatures,
  floodReportDisclosure,
  floodUncertaintyDisclosure,
} from "./report-flood.js";
import { resolveFloodExposure } from "@urban/models";
import { ApiError } from "./errors.js";

function selectedFlood(
  place: Place,
  scenario: Scenario,
  catalog?: FloodDatasetCatalog,
) {
  if (!scenario.flood) return undefined;
  const dataset = catalog?.[scenario.flood.datasetHash];
  if (!dataset || floodDatasetHashSync(dataset) !== scenario.flood.datasetHash)
    throw new ApiError(
      422,
      "FLOOD_DATASET_UNAVAILABLE",
      "The shapefile requires the scenario's exact retained flood dataset.",
    );
  validateFloodDataset(dataset, place);
  return dataset;
}

/** Call after capturing one authorized, revision-bound project snapshot and checking source rights. */
export function shapefileLayers(
  place: Place,
  scenario: Scenario,
  floodDatasets?: FloodDatasetCatalog,
): GisExportLayer[] {
  const flood = selectedFlood(place, scenario, floodDatasets);
  const floodFeatures = flood
    ? floodGeoJsonFeatures(flood, scenario.flood!.datasetHash)
    : [];
  const properties = (value: object) => ({
    ...value,
    scenarioId: scenario.id,
    scenarioRevision: scenario.revision,
  });
  const layer = (id: string, features: GeoJSON.Feature[]): GisExportLayer => ({
    id,
    geojson: { type: "FeatureCollection", features },
  });
  return [
    ...(flood
      ? ["zones", "availability", "panels", "revisions", "seclusions"].map(
          (kind) =>
            layer(
              `flood_${kind}`,
              floodFeatures.filter(
                (feature) =>
                  feature.properties?.featureType === `flood-${kind}`,
              ),
            ),
        )
      : []),
    layer(
      "buildings",
      materializeBuildings(place, scenario).map((building) => ({
        type: "Feature",
        id: building.id,
        geometry: buildingGeometry(building),
        properties: properties(building),
      })),
    ),
    layer(
      "roads",
      materializeRoads(place, scenario).map((road) => ({
        type: "Feature",
        id: road.id,
        geometry: { type: "LineString", coordinates: road.coordinates },
        properties: properties(road),
      })),
    ),
    ...(["parcel", "block"] as const).map((kind) =>
      layer(
        `${kind}s`,
        materializeParcels(place, scenario)
          .filter((parcel) => parcel.kind === kind)
          .map((parcel) => ({
            type: "Feature",
            id: parcel.id,
            geometry: parcel.geometry,
            properties: properties(parcel),
          })),
      ),
    ),
    layer(
      "neighborhoods",
      (scenario.activity?.neighborhoods ?? []).map((area) => ({
        type: "Feature",
        id: area.id,
        geometry: area.geometry,
        properties: properties(area),
      })),
    ),
  ].filter((item) => item.geojson.features.length);
}

export function exportScenarioShapefile(
  runtime: Pick<GisRuntime, "exportShapefile">,
  input: {
    place: Place;
    scenario: Scenario;
    projectId: string;
    projectVersion: number;
    baselineHash: string;
    generatedAt: string;
    floodDatasets?: FloodDatasetCatalog;
    signal?: AbortSignal;
  },
) {
  const flood = selectedFlood(input.place, input.scenario, input.floodDatasets);
  return runtime.exportShapefile({
    layers: shapefileLayers(input.place, input.scenario, input.floodDatasets),
    manifest: {
      projectId: input.projectId,
      projectVersion: input.projectVersion,
      placeId: input.place.id,
      baselineHash: input.baselineHash,
      scenarioId: input.scenario.id,
      scenarioRevision: input.scenario.revision,
      generatedAt: input.generatedAt,
      planningSources: [
        ...input.place.sources,
        ...(input.scenario.sources ?? []),
      ],
      ...(input.scenario.workforce
        ? { workforceCapture: input.scenario.workforce }
        : {}),
      ...(input.scenario.retail ? { retail: input.scenario.retail } : {}),
      ...(input.scenario.activity ? { activity: input.scenario.activity } : {}),
      ...(flood
        ? {
            flood: {
              reference: input.scenario.flood,
              dataset: flood,
              resolution: resolveFloodExposure(input.place, input.scenario, {
                floodDatasets: input.floodDatasets,
              }),
              interpretation: floodReportDisclosure,
              uncertainty: floodUncertaintyDisclosure,
              exactSource:
                "Exact source geometry, attributes, receipts and classifications are retained here and in the layer GeoJSON sidecars; DBF fields are a compatibility projection.",
            },
          }
        : {}),
    },
    signal: input.signal,
  });
}
