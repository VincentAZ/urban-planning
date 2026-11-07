import { canonicalJSON } from "./canonical";
export { canonicalJSON } from "./canonical";
import { validateProjectFlood } from "./flood";
import {
  verifyAccessibilityScenarioIntegrity,
  verifyAccessibilityModeEvidence,
} from "./accessibility-scenario";
import { projectHasImportExtensions } from "./import-metadata";
import {
  buildingGeometry,
  validateBuildingEdit,
  validateBuildingGeometry,
  hasExtendedBuilding,
} from "./buildings";
import { assertFeatureEditRecords } from "./identifiers";
import { z } from "zod";
import { validateParcelEdits } from "./parcels";
import { validateActivityScenario } from "./activity";
import { validateRetailScenario } from "./retail";
import { verifyWorkforceScenario } from "./workforce-scenario";
import { verifyTrafficScenario } from "./traffic-scenario";
import {
  buildingWithinStudyArea,
  isValidStudyArea,
  lineWithinStudyArea,
  pointInStudyArea,
  studyAreaPolygons,
} from "./study-area";
import type { Place, Project, Scenario } from "./index";
import { placeSchema, projectSchema } from "./validation";
import { validateRoadEdit, type RoadPathValidation } from "./roads";

export interface BaselineIdentity {
  version: 1;
  placeId: string;
  sha256: string;
}
export interface ProjectSnapshot {
  project: Project;
  place: Place;
  baselineIdentity: BaselineIdentity;
}
export const baselineIdentitySchema = z.object({
  version: z.literal(1),
  placeId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function baselineIdentity(
  place: Place,
): Promise<BaselineIdentity> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJSON(place)),
  );
  return {
    version: 1,
    placeId: place.id,
    sha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export function validatePlace(input: unknown): Place {
  const result = placeSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `The captured baseline is invalid: ${result.error.issues[0]?.message ?? "unsupported data"}`,
    );
  const place = result.data as Place;
  const inside = ([x, y]: number[]) =>
    x >= place.bounds[0] - 1e-8 &&
    x <= place.bounds[2] + 1e-8 &&
    y >= place.bounds[1] - 1e-8 &&
    y <= place.bounds[3] + 1e-8;
  if (!inside(place.center) || !isValidStudyArea(place))
    throw new Error("The captured baseline boundary is invalid.");
  if (
    !studyAreaPolygons(place).every((rings) =>
      rings.every((ring) => ring.every(inside)),
    ) ||
    !place.buildings.every((b) =>
      studyAreaPolygons(buildingGeometry(b)).every((rings) =>
        rings.every((ring) => ring.every(inside)),
      ),
    ) ||
    !place.roads.every((r) => r.coordinates.every(inside))
  )
    throw new Error(
      "The captured baseline contains geometry outside its declared bounds.",
    );
  if (
    place.studyArea &&
    (!pointInStudyArea(place.center, place) ||
      !place.buildings.every((building) =>
        building.geometry
          ? validateBuildingGeometry(building.geometry, place).valid
          : buildingWithinStudyArea(building.footprint, place),
      ) ||
      !place.roads.every((road) =>
        lineWithinStudyArea(road.coordinates, place),
      ))
  )
    throw new Error(
      "The captured baseline contains a center or feature outside its exact study area.",
    );
  if (place.parcels !== undefined)
    validateParcelEdits(place, { parcelEdits: {} } as Scenario);
  // Preserve the exact source object rather than normalizing away optional metadata before hashing.
  return input as Place;
}
function validateEdits(
  scenario: Scenario,
  place: Place,
  roadChecks: Map<string, RoadPathValidation>,
  parcelChecks: Set<string>,
) {
  if (scenario.retail) {
    const key = `retail:${canonicalJSON([scenario.retail, scenario.sources ?? []])}`;
    if (!parcelChecks.has(key)) {
      validateRetailScenario(scenario.retail, place, scenario.sources ?? []);
      parcelChecks.add(key);
    }
  }
  if (scenario.activity) {
    const key = `activity:${canonicalJSON([scenario.activity, scenario.sources ?? []])}`;
    if (!parcelChecks.has(key)) {
      validateActivityScenario(
        scenario.activity,
        place,
        scenario.sources ?? [],
      );
      parcelChecks.add(key);
    }
  }
  if (place.parcels !== undefined || scenario.parcelEdits !== undefined) {
    const key = canonicalJSON(scenario.parcelEdits ?? {});
    if (!parcelChecks.has(key)) {
      validateParcelEdits(place, scenario);
      parcelChecks.add(key);
    }
  }
  assertFeatureEditRecords(scenario);
  for (const building of Object.values(scenario.buildingEdits))
    if (building && !validateBuildingEdit(building, place).valid)
      throw new Error(
        `Building ${building.id} has invalid geometry or lies outside the captured study area.`,
      );
  for (const road of Object.values(scenario.roadEdits)) {
    if (!road) continue;
    const key = JSON.stringify([road.id, road.coordinates]);
    const check = roadChecks.get(key) ?? validateRoadEdit(road, place);
    roadChecks.set(key, check);
    if (!check.valid) throw new Error(`Road ${road.id}: ${check.error}`);
  }
}
export async function validateProjectSnapshot(
  input: unknown,
): Promise<ProjectSnapshot> {
  if (
    !input ||
    typeof input !== "object" ||
    !("place" in input) ||
    !input.place
  )
    throw new Error(
      "This project file has no captured baseline. Its original source cannot be reconstructed. Recover a complete export or open the original browser draft and explicitly adopt a new source.",
    );
  const envelope = input as {
    project?: unknown;
    place: unknown;
    baselineIdentity?: unknown;
  };
  const parsed = projectSchema.safeParse(envelope.project);
  if (!parsed.success)
    throw new Error(
      `The project is invalid: ${parsed.error.issues[0]?.message ?? "unsupported project"}`,
    );
  const project = parsed.data as Project,
    place = validatePlace(envelope.place);
  if (project.schemaVersion < 8 && projectHasImportExtensions(project, place))
    throw new Error(
      "Nullable quantities and import provenance require project format 8.",
    );
  if (place.vehicleAvailability !== undefined && project.schemaVersion < 5)
    throw new Error(
      "Captured household vehicle evidence requires project schema version 5.",
    );
  if (project.schemaVersion < 3 && place.buildings.some(hasExtendedBuilding))
    throw new Error(
      "Captured extended buildings require project schema version 3.",
    );
  if (place.parcels !== undefined && project.schemaVersion < 2)
    throw new Error(
      "A captured parcel baseline requires project schema version 2.",
    );
  if (project.placeId !== place.id)
    throw new Error(
      "The project and captured baseline belong to different places.",
    );
  await validateProjectFlood(project, place);
  const identity = await baselineIdentity(place);
  if (envelope.baselineIdentity) {
    const supplied = baselineIdentitySchema.safeParse(
      envelope.baselineIdentity,
    );
    if (
      !supplied.success ||
      canonicalJSON(supplied.data) !== canonicalJSON(identity)
    )
      throw new Error(
        "The captured baseline does not match its snapshot identity. Restore an unmodified complete export.",
      );
  }
  const roadChecks = new Map<string, RoadPathValidation>();
  const parcelChecks = new Set<string>();
  const workforceChecks = new Set<string>();
  const accessibilityChecks = new Set<string>();
  const trafficChecks = new Set<string>();
  for (const scenario of [
    ...project.scenarios,
    ...project.history.flatMap((e) => [e.before, e.after]),
    ...project.undone.flatMap((e) => [e.before, e.after]),
  ]) {
    validateEdits(scenario, place, roadChecks, parcelChecks);
    if (scenario.traffic) {
      const key = canonicalJSON(scenario.traffic);
      if (!trafficChecks.has(key)) {
        await verifyTrafficScenario(scenario.traffic, place, identity.sha256);
        trafficChecks.add(key);
      }
    }
    if (scenario.accessibility) {
      const key = canonicalJSON(scenario.accessibility);
      if (!accessibilityChecks.has(key)) {
        await verifyAccessibilityScenarioIntegrity(
          scenario.accessibility,
          place,
          identity.sha256,
        );
        accessibilityChecks.add(key);
      }
    }
    if (scenario.workforce) {
      const key = canonicalJSON(scenario.workforce);
      if (!workforceChecks.has(key)) {
        await verifyWorkforceScenario(
          scenario.workforce,
          place,
          identity.sha256,
        );
        workforceChecks.add(key);
      }
    }
  }
  for (const entry of [...project.history, ...project.undone]) {
    if (
      entry.command.type === "scenario.accessibility" &&
      entry.command.evidence
    ) {
      if (entry.command.mode !== entry.command.evidence.capture.request.mode)
        throw new Error("Accessibility history mode mismatch.");
      const key = canonicalJSON(entry.command.evidence);
      if (!accessibilityChecks.has(key)) {
        await verifyAccessibilityModeEvidence(
          entry.command.evidence,
          place,
          identity.sha256,
        );
        accessibilityChecks.add(key);
      }
    }
    if (entry.command.type === "scenario.traffic" && entry.command.traffic) {
      const key = canonicalJSON(entry.command.traffic);
      if (!trafficChecks.has(key)) {
        await verifyTrafficScenario(
          entry.command.traffic,
          place,
          identity.sha256,
        );
        trafficChecks.add(key);
      }
    }
    if (
      entry.command.type === "scenario.workforce" &&
      entry.command.workforce
    ) {
      const key = canonicalJSON(entry.command.workforce);
      if (!workforceChecks.has(key)) {
        await verifyWorkforceScenario(
          entry.command.workforce,
          place,
          identity.sha256,
        );
        workforceChecks.add(key);
      }
    }
    if (entry.command.type === "scenario.retail" && entry.command.retail) {
      const retail = entry.command.retail,
        sources = [
          ...(entry.before.sources ?? []),
          ...(entry.after.sources ?? []),
          ...(entry.command.sources ?? []),
        ];
      const key = `retail:${canonicalJSON([retail, sources])}`;
      if (!parcelChecks.has(key)) {
        validateRetailScenario(retail, place, sources);
        parcelChecks.add(key);
      }
    }
    if (entry.command.type !== "scenario.activity" || !entry.command.activity)
      continue;
    const activity = entry.command.activity,
      sources = [
        ...(entry.before.sources ?? []),
        ...(entry.after.sources ?? []),
        ...(entry.command.sources ?? []),
      ];
    const key = `activity:${canonicalJSON([activity, sources])}`;
    if (!parcelChecks.has(key)) {
      validateActivityScenario(activity, place, sources);
      parcelChecks.add(key);
    }
  }
  return { project, place, baselineIdentity: identity };
}
