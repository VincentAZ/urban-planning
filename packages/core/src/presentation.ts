import { z } from "zod";
import { projectWithBuildingVersion } from "./buildings";
import { isSafeFeatureIdentifier } from "./identifiers";
import type { Place, Position, Project } from "./index";

export const MAX_PRESENTATION_STOPS = 24;
export const MAX_PRESENTATION_METRICS = 6;
export const MAX_PRESENTATION_TITLE_LENGTH = 160;
export const MAX_PRESENTATION_CALLOUT_LENGTH = 2000;
export const MAX_PRESENTATION_NARRATION_LENGTH = 4000;

export interface PresentationCamera {
  center: Position;
  zoom: number;
  pitch: number;
  bearing: number;
}
export interface PresentationStop {
  id: string;
  title: string;
  callout: string;
  camera: PresentationCamera;
  view: "3d" | "2d" | "satellite";
  /** References only. Resolve against results for the captured scenario revision. */
  metricIds?: string[];
  /** User-authored text; no generated audio, selected voice, or external request is stored. */
  narration?: string;
}
export interface ScenarioPresentation {
  version: 1;
  title: string;
  stops: PresentationStop[];
}

const identifier = z.string().refine(isSafeFeatureIdentifier, {
  message:
    "Presentation references must be safe identifiers of at most 160 characters.",
});
const title = z
  .string()
  .max(MAX_PRESENTATION_TITLE_LENGTH)
  .refine((value) => value.trim().length > 0, {
    message: "A presentation title cannot be blank.",
  });
export const presentationCameraSchema = z
  .object({
    // A camera may frame surrounding context or a courtyard. It is not edited land geometry.
    center: z.tuple([
      z.number().finite().min(-180).max(180),
      z.number().finite().min(-85).max(85),
    ]),
    zoom: z.number().finite().min(2).max(21),
    pitch: z.number().finite().min(0).max(60),
    bearing: z.number().finite().min(-180).max(180),
  })
  .strict();
export const presentationStopSchema = z
  .object({
    id: identifier,
    title,
    callout: z.string().max(MAX_PRESENTATION_CALLOUT_LENGTH),
    camera: presentationCameraSchema,
    view: z.enum(["3d", "2d", "satellite"]),
    metricIds: z
      .array(identifier)
      .max(MAX_PRESENTATION_METRICS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "A presentation stop cannot repeat a metric reference.",
      })
      .optional(),
    narration: z.string().max(MAX_PRESENTATION_NARRATION_LENGTH).optional(),
  })
  .strict();
export const scenarioPresentationSchema = z
  .object({
    version: z.literal(1),
    title,
    stops: z
      .array(presentationStopSchema)
      .min(1)
      .max(MAX_PRESENTATION_STOPS)
      .refine(
        (stops) => new Set(stops.map((stop) => stop.id)).size === stops.length,
        {
          message: "Presentation stop identifiers must be unique.",
        },
      ),
  })
  .strict();

export function assertScenarioPresentation(
  value: unknown,
): asserts value is ScenarioPresentation {
  const result = scenarioPresentationSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `The presentation is invalid: ${result.error.issues[0]?.message ?? "unsupported data"}`,
    );
}

/** Upgrade on first persisted authoring, including retained/undone history, never on read. */
export function projectWithPresentationVersion(
  project: Project,
  place?: Place,
): Project {
  const upgraded = projectWithBuildingVersion(project, place);
  if (upgraded.schemaVersion >= 4) return upgraded;
  const snapshots = [
    ...project.scenarios,
    ...project.history.flatMap((entry) => [entry.before, entry.after]),
    ...project.undone.flatMap((entry) => [entry.before, entry.after]),
  ];
  const hasPresentation =
    snapshots.some((scenario) => scenario.presentation !== undefined) ||
    [...project.history, ...project.undone].some(
      (entry) => entry.command.type === "scenario.presentation",
    );
  return hasPresentation ? { ...upgraded, schemaVersion: 4 } : upgraded;
}
