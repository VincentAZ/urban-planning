import type { Position } from "@urban/core";

export interface MapCamera {
  center: Position;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface MapCameraLimits {
  minZoom: number;
  maxZoom: number;
  maxPitch: number;
}

export interface MapCameraCommand {
  /** A new ID explicitly replays even an identical destination. */
  requestId: string;
  camera: MapCamera;
  transition?: "fly" | "ease" | "jump";
  durationMs?: number;
}

export interface MapCameraCommandResult {
  requestId: string;
  status: "completed" | "cancelled" | "rejected";
  camera: MapCamera | null;
  reason?: string;
}

type CameraEvent = {
  urbanCameraRequestId?: string;
  urbanCameraResize?: boolean;
};
type CameraOptions = MapCamera & { duration?: number; essential?: boolean };

/** Small evented boundary keeps camera lifecycle tests independent of WebGL. */
export interface CameraMap {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getPitch(): number;
  getBearing(): number;
  stop(): unknown;
  jumpTo(camera: CameraOptions, eventData?: CameraEvent): unknown;
  easeTo(camera: CameraOptions, eventData?: CameraEvent): unknown;
  flyTo(camera: CameraOptions, eventData?: CameraEvent): unknown;
  on(
    type: "movestart" | "moveend",
    listener: (event: CameraEvent) => void,
  ): unknown;
  off(
    type: "movestart" | "moveend",
    listener: (event: CameraEvent) => void,
  ): unknown;
}

export interface CameraEnvironment {
  limits: MapCameraLimits;
  flat: boolean;
  reducedMotion: boolean;
}

export function cameraLimitsValid(limits: MapCameraLimits): boolean {
  return (
    Object.values(limits).every(Number.isFinite) &&
    limits.minZoom >= 0 &&
    limits.maxZoom <= 24 &&
    limits.minZoom <= limits.maxZoom &&
    limits.maxPitch >= 0 &&
    limits.maxPitch <= 85
  );
}

export function readMapCamera(map: CameraMap): MapCamera {
  const center = map.getCenter();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

function angularDistance(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

export function camerasEqual(actual: MapCamera, target: MapCamera): boolean {
  return (
    angularDistance(actual.center[0], target.center[0]) < 1e-7 &&
    Math.abs(actual.center[1] - target.center[1]) < 1e-7 &&
    Math.abs(actual.zoom - target.zoom) < 1e-5 &&
    Math.abs(actual.pitch - target.pitch) < 1e-5 &&
    angularDistance(actual.bearing, target.bearing) < 1e-5
  );
}

export function cameraCommandError(
  command: MapCameraCommand,
  limits: MapCameraLimits,
): string | null {
  const camera = command.camera;
  if (!cameraLimitsValid(limits)) return "The map camera limits are invalid.";
  if (
    !command.requestId ||
    !Array.isArray(camera?.center) ||
    camera.center.length !== 2 ||
    ![...camera.center, camera.zoom, camera.pitch, camera.bearing].every(
      Number.isFinite,
    ) ||
    Math.abs(camera.center[0]) > 180 ||
    Math.abs(camera.center[1]) > 85 ||
    camera.zoom < limits.minZoom ||
    camera.zoom > limits.maxZoom ||
    camera.pitch < 0 ||
    camera.pitch > limits.maxPitch ||
    Math.abs(camera.bearing) > 180
  )
    return "This camera destination is outside the supported map limits.";
  if (
    (command.transition !== undefined &&
      !["fly", "ease", "jump"].includes(command.transition)) ||
    (command.durationMs !== undefined &&
      (!Number.isFinite(command.durationMs) ||
        command.durationMs < 0 ||
        command.durationMs > 10_000))
  )
    return "Use a camera transition lasting between 0 and 10 seconds.";
  return null;
}

/** One command per ID; readiness and callback updates never replay a completed stop. */
export class CameraCommandController {
  private ready = false;
  private disposed = false;
  private seenRequestIds = new Set<string>();
  private pending: MapCameraCommand | null = null;
  private active: { command: MapCameraCommand; target: MapCamera } | null =
    null;

  constructor(
    private map: CameraMap,
    private environment: () => CameraEnvironment,
    private onResult: (result: MapCameraCommandResult) => void,
    private onReady: (ready: boolean) => void,
  ) {
    map.on("movestart", this.onMoveStart);
    map.on("moveend", this.onMoveEnd);
    onReady(false);
  }

  capture = (): MapCamera | null =>
    this.ready && !this.disposed ? readMapCamera(this.map) : null;

  hasSeen(requestId: string): boolean {
    return this.seenRequestIds.has(requestId);
  }

  setReady(ready: boolean): void {
    if (this.disposed || ready === this.ready) return;
    this.ready = ready;
    if (!ready && this.active) {
      // Style/context recovery resumes the same request, without a false completion
      // from MapLibre.stop() emitting the previous animation's moveend event.
      this.pending = this.active.command;
      this.active = null;
      this.map.stop();
    }
    this.onReady(ready);
    if (ready) this.flush();
  }

  request(command: MapCameraCommand | undefined): void {
    if (this.disposed) return;
    if (!command) {
      this.cancel("The camera request was cleared.");
      return;
    }
    if (this.hasSeen(command.requestId)) return;
    this.cancel("A newer camera destination replaced this request.");
    this.seenRequestIds.add(command.requestId);
    const error = cameraCommandError(command, this.environment().limits);
    if (error) {
      this.onResult({
        requestId: command.requestId,
        status: "rejected",
        camera: this.capture(),
        reason: error,
      });
      return;
    }
    this.pending = {
      ...command,
      camera: { ...command.camera, center: [...command.camera.center] },
    };
    this.flush();
  }

  cancel(reason: string, stop = true): void {
    const command = this.active?.command ?? this.pending;
    this.active = null;
    this.pending = null;
    if (!command) return;
    if (stop) this.map.stop();
    this.onResult({
      requestId: command.requestId,
      status: "cancelled",
      camera: this.capture(),
      reason,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel("The map was closed.");
    this.setReady(false);
    this.disposed = true;
    this.map.off("movestart", this.onMoveStart);
    this.map.off("moveend", this.onMoveEnd);
  }

  private flush(): void {
    if (!this.ready || !this.pending || this.disposed) return;
    const command = this.pending;
    this.pending = null;
    const environment = this.environment();
    const error = cameraCommandError(command, environment.limits);
    if (error) {
      this.onResult({
        requestId: command.requestId,
        status: "rejected",
        camera: this.capture(),
        reason: error,
      });
      return;
    }
    const target = {
      ...command.camera,
      pitch: environment.flat ? 0 : command.camera.pitch,
    };
    // Stop a non-command animation before recording ownership of its successor.
    this.map.stop();
    this.active = { command, target };
    const transition = command.transition ?? "fly";
    const options = {
      ...target,
      duration: environment.reducedMotion
        ? 0
        : (command.durationMs ?? (transition === "fly" ? 1200 : 700)),
      essential: false,
    };
    const eventData = { urbanCameraRequestId: command.requestId };
    try {
      if (transition === "jump" || options.duration === 0)
        this.map.jumpTo(options, eventData);
      else if (transition === "ease") this.map.easeTo(options, eventData);
      else this.map.flyTo(options, eventData);
    } catch (cause) {
      this.active = null;
      this.onResult({
        requestId: command.requestId,
        status: "rejected",
        camera: this.capture(),
        reason:
          cause instanceof Error
            ? cause.message
            : "The camera destination could not be shown.",
      });
    }
  }

  private onMoveStart = (event: CameraEvent): void => {
    if (event.urbanCameraResize) return;
    if (
      this.active &&
      event.urbanCameraRequestId !== this.active.command.requestId
    )
      // The incoming interaction already owns movement; do not stop that new gesture.
      this.cancel(
        "The camera transition was interrupted by another map movement.",
        false,
      );
  };

  private onMoveEnd = (event: CameraEvent): void => {
    const active = this.active;
    if (
      !active ||
      event.urbanCameraResize ||
      event.urbanCameraRequestId !== active.command.requestId
    )
      return;
    this.active = null;
    const camera = this.capture();
    const completed = camera !== null && camerasEqual(camera, active.target);
    this.onResult({
      requestId: active.command.requestId,
      status: completed ? "completed" : "cancelled",
      camera,
      ...(completed
        ? {}
        : { reason: "The camera transition stopped before its destination." }),
    });
  };
}
