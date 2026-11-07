import { pointInStudyArea, type Place, type Position } from "@urban/core";

/** Presentation data only. Internal review authorization and loading belong to the caller. */
export interface MapReviewPin {
  id: string;
  position: Position;
  label: string;
  resolved?: boolean;
}
export interface MapFocusLocation {
  position: Position;
  /** Change this for a new focus action, including repeated clicks on the same thread. */
  requestId: string | number;
}
export function reviewPinsForPlace(
  pins: readonly MapReviewPin[],
  place: Place,
): MapReviewPin[] {
  const seen = new Set<string>();
  return pins.filter((pin) => {
    if (!pin.id || seen.has(pin.id) || !pointInStudyArea(pin.position, place))
      return false;
    seen.add(pin.id);
    return true;
  });
}

/** One dispatch point prevents a roof/road click from both placing a pin and selecting an edit target. */
export function dispatchMapClick(
  position: Position,
  featureId: string | undefined,
  handlers: {
    selectingCommentLocation?: boolean;
    onSelect: (id: string | null) => void;
    onMapClick?: (position: Position) => void;
  },
): void {
  if (handlers.selectingCommentLocation) {
    handlers.onMapClick?.(position);
  } else if (featureId) {
    handlers.onSelect(featureId);
  } else {
    handlers.onSelect(null);
    handlers.onMapClick?.(position);
  }
}
