import {
  presentationCameraSchema,
  type MediaFrame,
  type PresentationCamera,
} from "@urban/core";
import { camerasEqual } from "../map/camera";

/** The trusted native host owns receipt numbers; independent browser sampling bounds its authority. */
export function applyScheduledCamera(
  frame: MediaFrame,
  scheduledCamera?: PresentationCamera,
): MediaFrame {
  if (scheduledCamera === undefined) return frame;
  const exact = presentationCameraSchema.parse(scheduledCamera);
  if (!camerasEqual(exact, frame.camera))
    throw new Error(
      "The host camera does not match this frozen frame's scheduled path.",
    );
  return { ...frame, camera: structuredClone(exact) };
}
