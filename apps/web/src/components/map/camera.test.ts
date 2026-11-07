import { describe, expect, it, vi } from "vitest";
import {
  CameraCommandController,
  cameraCommandError,
  camerasEqual,
  type CameraEnvironment,
  type CameraMap,
  type MapCamera,
  type MapCameraCommand,
} from "./camera";

type CameraEvent = Parameters<Parameters<CameraMap["on"]>[1]>[0];
type CameraOptions = Parameters<CameraMap["jumpTo"]>[0];
class TestCamera implements CameraMap {
  camera: MapCamera = {
    center: [-112.07, 33.46],
    zoom: 15,
    pitch: 53,
    bearing: -27,
  };
  listeners = {
    movestart: new Set<(event: CameraEvent) => void>(),
    moveend: new Set<(event: CameraEvent) => void>(),
  };
  pending: { camera: MapCamera; event: CameraEvent } | null = null;
  moves: { method: string; options: CameraOptions; event: CameraEvent }[] = [];
  stops = 0;
  getCenter() {
    return { lng: this.camera.center[0], lat: this.camera.center[1] };
  }
  getZoom() {
    return this.camera.zoom;
  }
  getPitch() {
    return this.camera.pitch;
  }
  getBearing() {
    return this.camera.bearing;
  }
  on(type: "movestart" | "moveend", listener: (event: CameraEvent) => void) {
    this.listeners[type].add(listener);
  }
  off(type: "movestart" | "moveend", listener: (event: CameraEvent) => void) {
    this.listeners[type].delete(listener);
  }
  emit(type: "movestart" | "moveend", event: CameraEvent = {}) {
    this.listeners[type].forEach((listener) => listener(event));
  }
  stop() {
    this.stops++;
    const prior = this.pending;
    this.pending = null;
    if (prior) this.emit("moveend", prior.event);
  }
  private move(
    method: string,
    options: CameraOptions,
    event: CameraEvent = {},
  ) {
    this.stop();
    this.moves.push({ method, options, event });
    this.pending = {
      camera: {
        center: [...options.center],
        zoom: options.zoom,
        pitch: options.pitch,
        bearing: options.bearing,
      },
      event,
    };
    this.emit("movestart", event);
    if (method === "jump") this.finish();
  }
  jumpTo(options: CameraOptions, event?: CameraEvent) {
    this.move("jump", options, event);
  }
  easeTo(options: CameraOptions, event?: CameraEvent) {
    this.move("ease", options, event);
  }
  flyTo(options: CameraOptions, event?: CameraEvent) {
    this.move("fly", options, event);
  }
  finish() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    this.camera = pending.camera;
    this.emit("moveend", pending.event);
  }
}

const command = (
  requestId: string,
  camera: Partial<MapCamera> = {},
): MapCameraCommand => ({
  requestId,
  camera: {
    center: [-87.62, 41.89],
    zoom: 17,
    pitch: 45,
    bearing: 90,
    ...camera,
  },
});

function setup(environment: Partial<CameraEnvironment> = {}) {
  const map = new TestCamera();
  const onResult = vi.fn(),
    onReady = vi.fn();
  const options: CameraEnvironment = {
    limits: { minZoom: 2, maxZoom: 21, maxPitch: 60 },
    flat: false,
    reducedMotion: false,
    ...environment,
  };
  const controller = new CameraCommandController(
    map,
    () => options,
    onResult,
    onReady,
  );
  return { map, controller, onResult, onReady, options };
}

describe("presentation camera command lifecycle", () => {
  it("queues a copied destination until ready and captures the actual live camera, including framing outside the study area", () => {
    const { map, controller, onResult, onReady } = setup();
    const request = command("first");
    const destination = structuredClone(request.camera);
    controller.request(request);
    request.camera.center[0] = 1;
    expect(controller.capture()).toBeNull();
    expect(map.moves).toHaveLength(0);
    controller.setReady(true);
    expect(map.moves[0].options.center).toEqual(destination.center);
    expect(controller.capture()).toEqual(map.camera);
    map.finish();
    expect(onResult).toHaveBeenCalledExactlyOnceWith({
      requestId: "first",
      status: "completed",
      camera: destination,
    });
    const captured = controller.capture()!;
    captured.center[0] = 0;
    expect(controller.capture()).toEqual(destination);
    expect(onReady.mock.calls).toEqual([[false], [true]]);
  });

  it("replaces a queued stop without flying through the stale destination", () => {
    const { map, controller, onResult } = setup();
    controller.request(command("first"));
    controller.request(command("second", { zoom: 19 }));
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "first",
        status: "cancelled",
        camera: null,
      }),
    );
    controller.setReady(true);
    expect(map.moves).toHaveLength(1);
    expect(map.moves[0].options.zoom).toBe(19);
    map.finish();
    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: "second", status: "completed" }),
    );
  });

  it("does not replay on rerender, callback refresh, or readiness changes, but a new request ID explicitly replays", () => {
    const { map, controller, onResult } = setup();
    controller.setReady(true);
    controller.request(command("first"));
    map.finish();
    controller.request(command("first", { zoom: 18 }));
    controller.setReady(false);
    controller.setReady(true);
    expect(map.moves).toHaveLength(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    controller.request(command("replay"));
    expect(map.moves).toHaveLength(2);
    map.finish();
    expect(onResult).toHaveBeenCalledTimes(2);
    controller.request(command("first"));
    expect(map.moves).toHaveLength(2);
  });

  it("cancels a superseded flight once, before stop emits the prior tagged moveend", () => {
    const { map, controller, onResult } = setup();
    controller.setReady(true);
    controller.request(command("first"));
    controller.request(command("second", { bearing: -90 }));
    expect(
      onResult.mock.calls.map(([value]) => [value.requestId, value.status]),
    ).toEqual([["first", "cancelled"]]);
    map.finish();
    expect(
      onResult.mock.calls.map(([value]) => [value.requestId, value.status]),
    ).toEqual([
      ["first", "cancelled"],
      ["second", "completed"],
    ]);
  });

  it("treats a user stop midway as cancellation rather than a completed stop", () => {
    const { map, controller, onResult } = setup();
    controller.setReady(true);
    controller.request(command("first"));
    map.camera = { ...map.camera, zoom: 16 };
    map.stop();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestId: "first",
        status: "cancelled",
        camera: map.camera,
      }),
    );
    controller.request(command("first"));
    expect(map.moves).toHaveLength(1);
  });

  it("does not stop a new manual, review-focus, or comparison movement that interrupts the flight", () => {
    const { map, controller, onResult } = setup();
    controller.setReady(true);
    controller.request(command("first"));
    const stops = map.stops;
    map.emit("movestart");
    expect(map.stops).toBe(stops);
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    map.finish();
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("ignores resize movement events during a flight", () => {
    const { map, controller, onResult } = setup();
    controller.setReady(true);
    controller.request(command("first"));
    map.emit("movestart", { urbanCameraResize: true });
    map.emit("moveend", { urbanCameraResize: true });
    expect(onResult).not.toHaveBeenCalled();
    map.finish();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("suspends a flight through style/context recovery and resumes the same request only when ready", () => {
    const { map, controller, onResult, onReady } = setup();
    controller.setReady(true);
    controller.request(command("first"));
    controller.setReady(false);
    expect(controller.capture()).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    controller.setReady(true);
    expect(map.moves).toHaveLength(2);
    map.finish();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ requestId: "first", status: "completed" }),
    );
    expect(onReady.mock.calls).toEqual([[false], [true], [false], [true]]);
  });

  it("honors reduced motion and reports the effective flat-view pitch", () => {
    const { map, controller, onResult } = setup({
      flat: true,
      reducedMotion: true,
    });
    controller.setReady(true);
    controller.request({ ...command("first"), durationMs: 3000 });
    expect(map.moves[0]).toMatchObject({
      method: "jump",
      options: { pitch: 0, duration: 0, essential: false },
    });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: "completed",
        camera: { ...command("first").camera, pitch: 0 },
      }),
    );
  });

  it("supports a requested ease duration and explicit jump without animation", () => {
    const { map, controller } = setup();
    controller.setReady(true);
    controller.request({
      ...command("ease"),
      transition: "ease",
      durationMs: 400,
    });
    expect(map.moves[0]).toMatchObject({
      method: "ease",
      options: { duration: 400, essential: false },
    });
    map.finish();
    controller.request({ ...command("jump"), transition: "jump" });
    expect(map.moves[1].method).toBe("jump");
    expect(map.pending).toBeNull();
  });

  it("validates queued destinations again if supported limits changed while loading", () => {
    const { map, controller, onResult, options } = setup();
    controller.request(command("first", { zoom: 21 }));
    options.limits.maxZoom = 20;
    controller.setReady(true);
    expect(map.moves).toHaveLength(0);
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "rejected" }),
    );
  });

  it("clears a queued request and detaches listeners on unmount without future results", () => {
    const { map, controller, onResult } = setup();
    controller.request(command("first"));
    controller.request(undefined);
    controller.setReady(true);
    expect(map.moves).toHaveLength(0);
    controller.request(command("second"));
    controller.dispose();
    controller.dispose();
    map.finish();
    controller.request(command("third"));
    expect(controller.capture()).toBeNull();
    expect(map.listeners.movestart.size + map.listeners.moveend.size).toBe(0);
    expect(
      onResult.mock.calls.map(([value]) => [value.requestId, value.status]),
    ).toEqual([
      ["first", "cancelled"],
      ["second", "cancelled"],
    ]);
  });
});

describe("camera destinations", () => {
  it("accepts the full persisted range and longitude/bearing equivalence", () => {
    const limits = { minZoom: 2, maxZoom: 21, maxPitch: 60 };
    expect(
      cameraCommandError(
        command("wide", {
          center: [-180, -85],
          zoom: 2,
          pitch: 0,
          bearing: -180,
        }),
        limits,
      ),
    ).toBeNull();
    expect(
      cameraCommandError(
        command("close", {
          center: [180, 85],
          zoom: 21,
          pitch: 60,
          bearing: 180,
        }),
        limits,
      ),
    ).toBeNull();
    expect(
      camerasEqual(
        command("a", { center: [-180, 0], bearing: -180 }).camera,
        command("b", { center: [180, 0], bearing: 180 }).camera,
      ),
    ).toBe(true);
  });

  it.each([
    { center: [NaN, 10] },
    { center: [181, 0] },
    { center: [0, 86] },
    { zoom: 22 },
    { pitch: 61 },
    { bearing: 181 },
  ] satisfies Partial<MapCamera>[])(
    "rejects unsupported destination %j without changing the camera",
    (invalid) => {
      const { map, controller, onResult } = setup();
      controller.setReady(true);
      controller.request(command("invalid", invalid));
      expect(map.moves).toHaveLength(0);
      expect(onResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: "rejected", camera: map.camera }),
      );
    },
  );

  it("rejects invalid durations and reversed camera limits", () => {
    const limits = { minZoom: 2, maxZoom: 21, maxPitch: 60 };
    expect(
      cameraCommandError(
        { ...command("duration"), durationMs: Infinity },
        limits,
      ),
    ).toMatch(/10 seconds/);
    expect(
      cameraCommandError(command("limits"), { ...limits, minZoom: 22 }),
    ).toMatch(/limits are invalid/);
  });
});
