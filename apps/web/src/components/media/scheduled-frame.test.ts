import { expect, it } from "vitest";
import type { MediaFrame } from "@urban/core";
import { applyScheduledCamera } from "./scheduled-frame";
const frame: MediaFrame = {
  index: 30,
  timeSeconds: 1,
  timestampMicroseconds: 1000000,
  durationMicroseconds: 33333,
  camera: {
    center: [-112.0715, 33.457503054631346],
    zoom: 16.503,
    pitch: 53,
    bearing: -26.84,
  },
  view: "3d",
  stopId: "first",
  title: "Synthetic view",
  caption: "Retained caption",
  metricIds: [],
  phase: "transition",
};
it("preserves exact authoritative camera numbers despite the observed cross-engine Mercator last-bit difference", () => {
  const scheduled = {
    ...frame.camera,
    center: [-112.0715, 33.457503054631374] as [number, number],
  };
  const rendered = applyScheduledCamera(frame, scheduled);
  expect(rendered.camera).toEqual(scheduled);
  expect(rendered.camera.center[1]).not.toBe(frame.camera.center[1]);
  expect({ ...rendered, camera: frame.camera }).toEqual(frame);
  scheduled.center[1] = 20;
  expect(rendered.camera.center[1]).toBe(33.457503054631374);
});
it("rejects material camera changes and invalid coordinates instead of changing the frozen path", () => {
  expect(() =>
    applyScheduledCamera(frame, { ...frame.camera, zoom: 17 }),
  ).toThrow("scheduled path");
  expect(() =>
    applyScheduledCamera(frame, {
      ...frame.camera,
      center: [-112.0715, 33.458],
    }),
  ).toThrow("scheduled path");
  expect(() =>
    applyScheduledCamera(frame, { ...frame.camera, pitch: NaN }),
  ).toThrow();
  expect(() =>
    applyScheduledCamera(frame, { ...frame.camera, pitch: 65 }),
  ).toThrow();
});
it("keeps browser preview sampling unchanged when no authoritative host camera is supplied", () => {
  expect(applyScheduledCamera(frame)).toBe(frame);
});
