import type {
  GisInspection,
  GisLayer,
  GisRecipe,
  GisUnit,
} from "../../../../api/src/gis-types";

export interface ImportControlPoint {
  id: string;
  x: string;
  y: string;
  longitude: string;
  latitude: string;
}
export interface SpatialDraft {
  layerId: string;
  reference: "file" | "epsg" | "local";
  epsg: string;
  encoding: "" | NonNullable<GisRecipe["encoding"]>;
  flattenZ: boolean;
  acknowledgeExcluded: boolean;
  units: "" | GisUnit;
  tolerance: string;
  controls: ImportControlPoint[];
  checkpoints: ImportControlPoint[];
  maximumResidual: string;
}
export const newControlPoint = (): ImportControlPoint => ({
  id: crypto.randomUUID(),
  x: "",
  y: "",
  longitude: "",
  latitude: "",
});
export function initialSpatialDraft(inspection: GisInspection): SpatialDraft {
  const layer = inspection.layers[0];
  return {
    layerId: layer?.id ?? "",
    reference: layer?.crs || inspection.format === "geojson" ? "file" : "epsg",
    epsg: "",
    encoding: "",
    flattenZ: false,
    acknowledgeExcluded: false,
    units: "",
    tolerance: "0.05",
    controls: [newControlPoint(), newControlPoint()],
    checkpoints: [],
    maximumResidual: "5",
  };
}
function finite(raw: string, label: string): number {
  if (!raw.trim() || !Number.isFinite(Number(raw)))
    throw new Error(`Enter ${label}.`);
  return Number(raw);
}
function point(point: ImportControlPoint, label: string) {
  const longitude = finite(point.longitude, `${label} longitude`),
    latitude = finite(point.latitude, `${label} latitude`);
  if (longitude < -180 || longitude > 180 || latitude < -85 || latitude > 85)
    throw new Error(`${label} needs a valid longitude / latitude.`);
  return {
    source: [
      finite(point.x, `${label} source X`),
      finite(point.y, `${label} source Y`),
    ] as [number, number],
    target: [longitude, latitude] as [number, number],
  };
}
export function spatialRecipe(
  draft: SpatialDraft,
  inspection: GisInspection,
): GisRecipe {
  const layer = inspection.layers.find((entry) => entry.id === draft.layerId);
  if (!layer) throw new Error("Choose a source layer.");
  if (
    excludedImportEntities(inspection, layer.id).total > 0 &&
    !draft.acknowledgeExcluded
  )
    throw new Error(
      "Review and acknowledge excluded entities, including unselected layers and unsupported entities, before conversion.",
    );
  if (layer.hasZ && !draft.flattenZ)
    throw new Error(
      "Review and authorize flattening Z coordinates to a 2D footprint.",
    );
  const result: GisRecipe = {
    layerId: layer.id,
    flattenZ: draft.flattenZ,
    acknowledgeExcluded: draft.acknowledgeExcluded,
    ...(draft.encoding ? { encoding: draft.encoding } : {}),
  };
  if (draft.reference === "file") {
    if (!layer.crs && inspection.format !== "geojson")
      throw new Error(
        "The layer has no recorded CRS. Select an explicit EPSG code or georeference a local CAD drawing.",
      );
    result.sourceCrs = { kind: "file" };
  } else if (draft.reference === "epsg") {
    const code = finite(draft.epsg, "the source EPSG code");
    if (!Number.isInteger(code) || code < 1 || code > 1000000)
      throw new Error("Enter a valid source EPSG code.");
    result.sourceCrs = { kind: "epsg", code };
  } else if (inspection.format !== "dxf")
    throw new Error(
      "Local control-point georeferencing is available for DXF drawings only.",
    );
  if (inspection.format === "dxf") {
    if (!draft.units)
      throw new Error(
        "Choose the actual drawing units; units are never guessed.",
      );
    const tolerance = finite(draft.tolerance, "curve tolerance in meters");
    if (tolerance < 0.001 || tolerance > 10)
      throw new Error("Curve tolerance must be from 0.001 to 10 meters.");
    result.dxf = { units: draft.units, curveToleranceMeters: tolerance };
    if (draft.reference === "local") {
      const maximumResidualMeters = finite(
        draft.maximumResidual,
        "maximum allowed residual in meters",
      );
      if (maximumResidualMeters <= 0 || maximumResidualMeters > 100)
        throw new Error(
          "Maximum residual must be greater than 0 and at most 100 meters.",
        );
      result.dxf.localTransform = {
        controls: draft.controls.map((p, i) => point(p, `Control ${i + 1}`)),
        checkpoints: draft.checkpoints.map((p, i) =>
          point(p, `Check point ${i + 1}`),
        ),
        maximumResidualMeters,
      };
    }
  }
  return result;
}
export function sourceLayer(
  inspection: GisInspection,
  draft: SpatialDraft,
): GisLayer | undefined {
  return inspection.layers.find((layer) => layer.id === draft.layerId);
}
export function excludedImportEntities(
  inspection: GisInspection,
  layerId: string,
) {
  const selected = inspection.layers.find((layer) => layer.id === layerId);
  const unselected = inspection.layers
    .filter((layer) => layer.id !== layerId)
    .reduce((count, layer) => count + layer.featureCount, 0);
  const unsupported = selected
    ? selected.featureCount - selected.supportedFootprints
    : 0;
  return { unselected, unsupported, total: unselected + unsupported };
}
export function spatialDraftFromRecipe(
  inspection: GisInspection,
  recipe: GisRecipe,
): SpatialDraft {
  const draft = initialSpatialDraft(inspection);
  const control = (p: {
    source: [number, number];
    target: [number, number];
  }): ImportControlPoint => ({
    id: crypto.randomUUID(),
    x: String(p.source[0]),
    y: String(p.source[1]),
    longitude: String(p.target[0]),
    latitude: String(p.target[1]),
  });
  return {
    ...draft,
    layerId: recipe.layerId,
    reference: recipe.dxf?.localTransform
      ? "local"
      : (recipe.sourceCrs?.kind ?? "file"),
    epsg:
      recipe.sourceCrs?.kind === "epsg" ? String(recipe.sourceCrs.code) : "",
    encoding: recipe.encoding ?? "",
    flattenZ: recipe.flattenZ ?? false,
    acknowledgeExcluded: recipe.acknowledgeExcluded ?? false,
    units: recipe.dxf?.units ?? "",
    tolerance: String(recipe.dxf?.curveToleranceMeters ?? 0.05),
    controls:
      recipe.dxf?.localTransform?.controls.map(control) ?? draft.controls,
    checkpoints: recipe.dxf?.localTransform?.checkpoints?.map(control) ?? [],
    maximumResidual: String(
      recipe.dxf?.localTransform?.maximumResidualMeters ?? 5,
    ),
  };
}
