import { camerasEqual, cameraCommandError, type MapCamera } from "./camera";

export interface MapExportFrame {
  sceneHash: string;
  frameIndex: number;
  width: number;
  height: number;
  view: "3d" | "2d";
  camera: MapCamera;
}
export interface MapExportAck extends MapExportFrame {
  drawSerial: number;
}
export interface MapExportHandle {
  renderFrame(
    frame: MapExportFrame,
    signal?: AbortSignal,
  ): Promise<MapExportAck>;
  assertFrame(frame: MapExportFrame): void;
}
export interface MapExportState {
  sceneHash: string;
  ready: boolean;
  style: string;
  view: string;
  camera: MapCamera;
  width: number;
  height: number;
  drawSerial: number;
  layerGeneration: number;
  drawnLayerGeneration: number;
  error: string | null;
}
/** A renderer acknowledgement, not an elapsed-time or camera-animation approximation. */
export class MapExportFence {
  private pending: {
    frame: MapExportFrame;
    minimumDraw: number;
    resolve: (value: MapExportAck) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  } | null = null;
  constructor(
    private read: () => MapExportState,
    private prepare: (frame: MapExportFrame) => void,
  ) {}
  renderFrame = (
    frame: MapExportFrame,
    signal?: AbortSignal,
  ): Promise<MapExportAck> => {
    this.cancel("A newer export frame replaced this frame.");
    const state = this.read();
    const cameraError = cameraCommandError(
      { requestId: "export-frame", camera: frame.camera, transition: "jump" },
      { minZoom: 2, maxZoom: 21, maxPitch: 60 },
    );
    if (
      cameraError ||
      !Number.isSafeInteger(frame.frameIndex) ||
      frame.frameIndex < 0 ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width <= 0 ||
      frame.height <= 0 ||
      !["3d", "2d"].includes(frame.view) ||
      (frame.view === "2d" && frame.camera.pitch !== 0) ||
      frame.sceneHash !== state.sceneHash
    )
      return Promise.reject(
        new Error(
          cameraError ??
            "The export frame does not match its frozen scene or dimensions.",
        ),
      );
    if (state.error) return Promise.reject(new Error(state.error));
    if (signal?.aborted)
      return Promise.reject(
        new DOMException("Export cancelled.", "AbortError"),
      );
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel("Export cancelled.");
      const timeout = setTimeout(
        () =>
          this.cancel(
            "The requested 3D export frame did not finish rendering.",
          ),
        15000,
      );
      this.pending = {
        frame: structuredClone(frame),
        minimumDraw: state.drawSerial + 1,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.prepare(frame);
      } catch (error) {
        this.cancel(
          error instanceof Error ? error.message : "Export rendering failed.",
        );
      }
    });
  };
  /** Call after MapLibre's entire render, after interleaved Deck draw callbacks. */
  rendered() {
    const pending = this.pending;
    if (!pending) return;
    const state = this.read(),
      frame = pending.frame;
    if (state.error || state.sceneHash !== frame.sceneHash) {
      this.cancel(state.error ?? "The frozen export scene changed.");
      return;
    }
    if (
      !state.ready ||
      state.view !== frame.view ||
      state.style !== frame.view ||
      state.drawSerial < pending.minimumDraw ||
      state.drawnLayerGeneration !== state.layerGeneration ||
      !camerasEqual(state.camera, frame.camera)
    )
      return;
    if (state.width !== frame.width || state.height !== frame.height) {
      this.cancel(
        "The graphics device did not render the exact requested dimensions; no downsampled export was accepted.",
      );
      return;
    }
    this.pending = null;
    pending.cleanup();
    pending.resolve({
      ...frame,
      camera: structuredClone(state.camera),
      drawSerial: state.drawSerial,
    });
  }
  assertFrame(frame: MapExportFrame) {
    const state = this.read();
    if (
      state.error ||
      !state.ready ||
      state.sceneHash !== frame.sceneHash ||
      state.view !== frame.view ||
      state.style !== frame.view ||
      state.width !== frame.width ||
      state.height !== frame.height ||
      state.layerGeneration !== state.drawnLayerGeneration ||
      !camerasEqual(state.camera, frame.camera)
    )
      throw new Error(
        state.error ?? "The rendered frame changed before capture completed.",
      );
  }
  cancel(message = "The export renderer was closed.") {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    pending.cleanup();
    pending.reject(new Error(message));
  }
}
