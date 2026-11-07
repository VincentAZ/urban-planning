import {
  pointInStudyArea,
  type Place,
  type Position,
  type ReviewCommentsResponse,
  type ReviewTarget,
} from "@urban/core";

export function reviewWriteBlock(
  data: ReviewCommentsResponse | null,
  savedVersion: number | null,
  revision: number,
  hasUnsavedChanges: boolean,
) {
  if (!data) return "Load the saved review before posting.";
  if (!data.access.canComment)
    return "Your viewer access lets you read this discussion. Ask a project owner for commenter or editor access to join in.";
  if (savedVersion !== null && savedVersion !== data.projectVersion)
    return "The saved project has changed. Refresh review and load the latest project before posting.";
  if (hasUnsavedChanges || savedVersion === null)
    return "Save your project changes before adding a comment or reply, so everyone reviews the same version.";
  if (revision !== data.scenarioRevision)
    return "The saved project has changed. Refresh review and load the latest project before posting.";
  return null;
}

export function coordinateTarget(
  latitude: string,
  longitude: string,
  place?: Place,
): ReviewTarget {
  if (!latitude.trim() || !longitude.trim())
    throw new Error("Enter both latitude and longitude.");
  const lat = Number(latitude),
    lng = Number(longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  )
    throw new Error(
      "Use a latitude between −90 and 90 and a longitude between −180 and 180.",
    );
  const position: Position = [lng, lat];
  if (place && !pointInStudyArea(position, place))
    throw new Error(
      "Choose coordinates inside this project’s study area, outside any excluded holes.",
    );
  return { kind: "location", position };
}

/** A failed request may have committed. Reuse its key until the exact payload changes. */
export function reviewRequestKey(
  previous: { fingerprint: string; key: string } | undefined,
  payload: unknown,
  makeKey: () => string = () => crypto.randomUUID(),
) {
  const fingerprint = JSON.stringify(payload);
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, key: makeKey() };
}
