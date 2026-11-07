import { ApiError } from "./errors.js";
import {
  createMediaScene,
  assertMediaExportRights,
  type Place,
  type Scenario,
  type FloodDatasetCatalog,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import { assertMediaMetadataPrivacy } from "./media-rights.js";
export function prepareMediaScene(input: {
  projectId: string;
  projectVersion: number;
  place: Place;
  scenario: Scenario;
  floodDatasets?: FloodDatasetCatalog;
  fiscalStudy?: import("@urban/core").FiscalStudy;
  housingIncomeLimits?: import("@urban/core").HousingIncomeLimitCatalog;
  createdAt: string;
}) {
  assertMediaMetadataPrivacy(input);
  const results = calculateImpact(
    input.place,
    input.scenario,
    {},
    {
      floodDatasets: input.floodDatasets,
      fiscalStudy: input.fiscalStudy,
      housingIncomeLimits: input.housingIncomeLimits,
    },
  );
  try {
    const scene = createMediaScene({ ...input, results });
    assertMediaExportRights(scene);
    return scene;
  } catch (error) {
    throw new ApiError(
      422,
      "MEDIA_SCENE_INVALID",
      error instanceof Error
        ? error.message
        : "The complete media scene is invalid.",
    );
  }
}
