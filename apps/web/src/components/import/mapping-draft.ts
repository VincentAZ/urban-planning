import {
  landUseLabels,
  type BuildingQuantityField,
  type LandUse,
} from "@urban/core";
import type {
  ImportLayer,
  ImportMappingRecipe,
  ImportNumberMapping,
} from "../../../../api/src/gis-jobs-types";
import type { GisLayer } from "../../../../api/src/gis-types";
export const quantityLabels: Record<BuildingQuantityField, string> = {
  height: "Height",
  floors: "Floors",
  units: "Homes",
  jobs: "Direct jobs",
  parkingSpaces: "Parking spaces supplied",
};
export interface QuantityDraft {
  mode: "missing" | "field" | "constant";
  field: string;
  value: string;
  unit: "meters" | "feet" | "us-survey-feet";
  decimal: "dot" | "comma";
}
export interface MappingDraft {
  layer: ImportLayer;
  targetMode: "append" | "match";
  matchBy: "id" | "sourceFeatureId";
  matchField: string;
  sourceId: string;
  nameField: string;
  nameConstant: string;
  nameMode: "default" | "field" | "constant";
  referenceField: string;
  useMode: "constant" | "field";
  use: LandUse | "";
  useField: string;
  useValues: { id: string; raw: string; use: LandUse | "" }[];
  quantities: Record<BuildingQuantityField, QuantityDraft>;
  programField: string;
  typologyField: string;
}
export function initialMapping(
  layer: ImportLayer,
  source?: GisLayer,
): MappingDraft {
  const has = (name: string) =>
    source?.fields.some((field) => field.name === name) ?? false;
  return {
    layer,
    targetMode: "append",
    matchBy: "id",
    matchField: "",
    sourceId: "",
    nameMode: has("name") ? "field" : "default",
    nameField: has("name") ? "name" : "",
    nameConstant: "",
    referenceField: "",
    useMode: "constant",
    use: "",
    useField: "",
    useValues: [],
    programField: "",
    typologyField: "",
    quantities: Object.fromEntries(
      Object.keys(quantityLabels).map((field) => [
        field,
        {
          mode: "missing",
          field: "",
          value: "",
          unit: "meters",
          decimal: "dot",
        },
      ]),
    ) as MappingDraft["quantities"],
  };
}
export function mappingRecipe(
  draft: MappingDraft,
  layer: GisLayer,
): ImportMappingRecipe {
  const field = (value: string, name: string) => {
    if (
      value !== "$featureId" &&
      !layer.fields.some((f) => f.name === value && f.name !== "$featureId")
    )
      throw new Error(`Choose a source field for ${name}.`);
    return value;
  };
  const recipe: ImportMappingRecipe = {
    layer: draft.layer,
    target: { mode: "append" },
  };
  if (draft.targetMode === "match") {
    recipe.target = {
      mode: "match",
      field: field(draft.matchField, "matching"),
      by: draft.matchBy,
    };
    if (draft.matchBy === "sourceFeatureId") {
      if (!draft.sourceId)
        throw new Error(
          "Choose the source namespace for replacement matching.",
        );
      recipe.target.sourceId = draft.sourceId;
    }
  }
  if (draft.nameMode === "field")
    recipe.name = {
      kind: "field",
      field: field(draft.nameField, "feature name"),
    };
  if (draft.nameMode === "constant") {
    if (!draft.nameConstant.trim())
      throw new Error("Enter the reviewed feature name.");
    recipe.name = { kind: "constant", value: draft.nameConstant.trim() };
  }
  if (draft.referenceField)
    recipe.sourceFeatureId = {
      kind: "field",
      field: field(draft.referenceField, "source reference"),
    };
  if (draft.layer === "buildings") {
    if (draft.useMode === "constant") {
      if (!draft.use)
        throw new Error(
          "Choose and review the building land use; it is never guessed from a footprint.",
        );
      recipe.use = { kind: "constant", value: draft.use };
    } else {
      const values: Record<string, LandUse> = Object.create(null);
      if (!draft.useValues.length)
        throw new Error("Map each source land-use value to a planning use.");
      for (const entry of draft.useValues) {
        if (
          !entry.raw.trim() ||
          !entry.use ||
          !Object.hasOwn(landUseLabels, entry.use)
        )
          throw new Error("Complete every source land-use mapping.");
        if (Object.hasOwn(values, entry.raw))
          throw new Error(
            "Each source land-use value must be mapped only once.",
          );
        values[entry.raw] = entry.use;
      }
      recipe.use = {
        kind: "field",
        field: field(draft.useField, "land use"),
        values,
      };
    }
    recipe.quantities = {};
    for (const key of Object.keys(quantityLabels) as BuildingQuantityField[]) {
      const value = draft.quantities[key];
      let output: ImportNumberMapping = { kind: "missing" };
      if (value.mode === "field")
        output = {
          kind: "field",
          field: field(value.field, quantityLabels[key]),
          decimal: value.decimal,
          ...(key === "height" ? { unit: value.unit } : {}),
        };
      if (value.mode === "constant") {
        const n = Number(value.value);
        if (!value.value.trim() || !Number.isFinite(n) || n < 0)
          throw new Error(
            `Enter a nonnegative ${quantityLabels[key].toLowerCase()} assumption, or leave this quantity unknown.`,
          );
        if (["floors", "units"].includes(key) && !Number.isInteger(n))
          throw new Error(`${quantityLabels[key]} must be a whole number.`);
        output = {
          kind: "constant",
          value: n,
          ...(key === "height" ? { unit: value.unit } : {}),
        };
      }
      recipe.quantities[key] = output;
    }
    if (draft.programField)
      recipe.programField = field(draft.programField, "typed program");
    if (draft.typologyField)
      recipe.typologyField = field(draft.typologyField, "building typology");
  }
  return recipe;
}
export function mappingDraftFromRecipe(
  recipe: ImportMappingRecipe,
  layer: GisLayer,
): MappingDraft {
  const draft = initialMapping(recipe.layer, layer);
  draft.targetMode = recipe.target.mode;
  if (recipe.target.mode === "match") {
    draft.matchBy = recipe.target.by;
    draft.matchField = recipe.target.field;
    draft.sourceId = recipe.target.sourceId ?? "";
  }
  if (recipe.name) {
    draft.nameMode = recipe.name.kind;
    if (recipe.name.kind === "field") draft.nameField = recipe.name.field;
    else draft.nameConstant = recipe.name.value;
  }
  if (recipe.sourceFeatureId?.kind === "field")
    draft.referenceField = recipe.sourceFeatureId.field;
  if (recipe.use?.kind === "constant") draft.use = recipe.use.value;
  if (recipe.use?.kind === "field") {
    draft.useMode = "field";
    draft.useField = recipe.use.field;
    draft.useValues = Object.entries(recipe.use.values).map(([raw, use]) => ({
      id: crypto.randomUUID(),
      raw,
      use,
    }));
  }
  for (const key of Object.keys(quantityLabels) as BuildingQuantityField[]) {
    const q = recipe.quantities?.[key];
    if (!q) continue;
    draft.quantities[key] = {
      ...draft.quantities[key],
      mode: q.kind,
      ...(q.kind === "field"
        ? {
            field: q.field,
            decimal: q.decimal ?? "dot",
            unit: q.unit ?? "meters",
          }
        : q.kind === "constant"
          ? { value: String(q.value), unit: q.unit ?? "meters" }
          : {}),
    };
  }
  draft.programField = recipe.programField ?? "";
  draft.typologyField = recipe.typologyField ?? "";
  return draft;
}
