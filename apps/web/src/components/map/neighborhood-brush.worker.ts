import {
  applyNeighborhoodBrush,
  type NeighborhoodBrushInput,
} from "@urban/core";
self.onmessage = (
  event: MessageEvent<{
    draftId: string;
    draftRevision: number;
    input: NeighborhoodBrushInput;
  }>,
) => {
  const { draftId, draftRevision, input } = event.data;
  try {
    self.postMessage({
      draftId,
      draftRevision,
      result: applyNeighborhoodBrush(input),
    });
  } catch (error) {
    self.postMessage({
      draftId,
      draftRevision,
      error:
        error instanceof Error
          ? error.message
          : "The brush boundary could not be calculated.",
    });
  }
};
