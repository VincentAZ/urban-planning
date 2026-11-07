import {
  lineWithinStudyArea,
  validateRoadEdit,
  validateParcelEdits,
  validateParcelCommand,
  validateBuildingCommand,
  validateActivityScenario,
  validateRetailScenario,
  validateWorkforceScenario,
  type Command,
  type Place,
  type Scenario,
  type Project,
} from "@urban/core";
import { ApiError } from "./errors.js";
import { resolveActivity, ActivityResolutionError } from "@urban/models";
import { validateImportExtent } from "./imports.js";

export function validateScenarioExtent(scenario: Scenario, place: Place) {
  if (scenario.workforce) {
    try {
      validateWorkforceScenario(scenario.workforce, place);
    } catch (error) {
      throw new ApiError(
        422,
        "INVALID_WORKFORCE_SCENARIO",
        (error as Error).message,
      );
    }
  }
  if (scenario.retail) {
    try {
      validateRetailScenario(scenario.retail, place, scenario.sources ?? []);
    } catch (error) {
      throw new ApiError(
        422,
        "INVALID_RETAIL_SCENARIO",
        (error as Error).message,
      );
    }
  }
  if (scenario.activity) {
    try {
      validateActivityScenario(
        scenario.activity,
        place,
        scenario.sources ?? [],
      );
      resolveActivity(place, scenario);
    } catch (error) {
      if (error instanceof ActivityResolutionError)
        throw new ApiError(422, error.code, error.message);
      throw new ApiError(
        422,
        "INVALID_ACTIVITY_SCENARIO",
        (error as Error).message,
      );
    }
  }
  try {
    validateParcelEdits(place, scenario);
  } catch (error) {
    throw new ApiError(422, "INVALID_PARCEL_EDIT", (error as Error).message);
  }
  validateImportExtent(
    Object.values(scenario.buildingEdits).filter((b) => b !== null),
    place,
  );
  const invalid = Object.values(scenario.roadEdits).flatMap((road) => {
    if (road === null) return [];
    const validation = validateRoadEdit(road, place);
    return validation.valid ? [] : [{ road, error: validation.error }];
  });
  const outside = invalid.filter(
    ({ road }) => !lineWithinStudyArea(road.coordinates, place),
  );
  if (outside.length)
    throw new ApiError(
      422,
      "OUTSIDE_STUDY_AREA",
      `${outside.length} edited road${outside.length === 1 ? " is" : "s are"} outside the editable study area. Keep changes inside the loaded boundary.`,
      {
        outsideFeatureIds: outside.map(({ road }) => road.id),
        extent: place.extentLabel,
      },
    );
  if (invalid.length)
    throw new ApiError(
      422,
      "INVALID_ROAD_GEOMETRY",
      invalid[0].error ?? "The edited street path is invalid.",
      {
        invalidFeatures: invalid.map(({ road, error }) => ({
          id: road.id,
          error,
        })),
      },
    );
}

export function validateParcelCommandForApi(
  place: Place,
  scenario: Scenario,
  command: Command,
) {
  try {
    validateParcelCommand(place, scenario, command);
  } catch (error) {
    throw new ApiError(422, "INVALID_PARCEL_EDIT", (error as Error).message);
  }
}

export function validateBuildingCommandForApi(
  place: Place,
  scenario: Scenario,
  command: Command,
) {
  try {
    validateBuildingCommand(place, scenario, command);
  } catch (error) {
    throw new ApiError(422, "INVALID_BUILDING_EDIT", (error as Error).message);
  }
}

export function validateRetailCommandForApi(
  place: Place,
  before: Scenario,
  after: Scenario,
  command: Command,
) {
  if (command.type !== "scenario.retail" || !command.retail) return;
  try {
    validateRetailScenario(command.retail, place, [
      ...(before.sources ?? []),
      ...(after.sources ?? []),
      ...(command.sources ?? []),
    ]);
  } catch (error) {
    throw new ApiError(
      422,
      "INVALID_RETAIL_SCENARIO",
      (error as Error).message,
    );
  }
}

/** Historical snapshots are future undo targets, so their geometry must be valid too. */
export function validateProjectExtents(project: Project, place: Place) {
  const checked = new Set<string>();
  for (const scenario of [
    ...project.scenarios,
    ...project.history.flatMap((entry) => [entry.before, entry.after]),
    ...project.undone.flatMap((entry) => [entry.before, entry.after]),
  ]) {
    const key = JSON.stringify([
      scenario.buildingEdits,
      scenario.roadEdits,
      scenario.parcelEdits,
      scenario.activity,
      scenario.retail,
      scenario.workforce,
      scenario.sources,
      scenario.assumptions,
      scenario.baselineAssumptions,
      scenario.horizon,
    ]);
    if (checked.has(key)) continue;
    validateScenarioExtent(scenario, place);
    checked.add(key);
  }
  for (const entry of [...project.history, ...project.undone]) {
    if (entry.command.type === "scenario.retail" && entry.command.retail) {
      try {
        validateRetailScenario(entry.command.retail, place, [
          ...(entry.before.sources ?? []),
          ...(entry.after.sources ?? []),
          ...(entry.command.sources ?? []),
        ]);
      } catch (error) {
        throw new ApiError(
          422,
          "INVALID_RETAIL_SCENARIO",
          (error as Error).message,
        );
      }
    }
    if (entry.command.type !== "scenario.activity" || !entry.command.activity)
      continue;
    try {
      validateActivityScenario(entry.command.activity, place, [
        ...(entry.after.sources ?? []),
        ...(entry.command.sources ?? []),
      ]);
    } catch (error) {
      throw new ApiError(
        422,
        "INVALID_ACTIVITY_SCENARIO",
        (error as Error).message,
      );
    }
  }
}
