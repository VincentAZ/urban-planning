import { expect, it, vi } from "vitest";
import type { MapExportFrame, MapExportHandle } from "../map/export-frame";
import { renderCurrentExportFrame } from "./preview-frame";
const frame: MapExportFrame = {
  sceneHash: "scene",
  frameIndex: 0,
  view: "3d",
  width: 3840,
  height: 1555,
  camera: { center: [-112, 33], zoom: 16, pitch: 45, bearing: 0 },
};
const paint = () => Promise.resolve();
it("uses the replacement map when StrictMode closes the first owner during an awaited frame", async () => {
  const replacement = {
    renderFrame: vi.fn(async () => ({ ...frame, drawSerial: 1 })),
    assertFrame: vi.fn(),
  };
  const first: MapExportHandle = {
    renderFrame: vi.fn(async () => {
      current = replacement;
      throw new Error("The export renderer was closed.");
    }),
    assertFrame: vi.fn(),
  };
  let current: MapExportHandle = first;
  await expect(
    renderCurrentExportFrame(
      () => current,
      frame,
      new AbortController().signal,
      paint,
    ),
  ).resolves.toEqual({ ...frame, drawSerial: 1 });
  expect(first.renderFrame).toHaveBeenCalledOnce();
  expect(replacement.renderFrame).toHaveBeenCalledOnce();
});
it("does not retry actual graphics errors on the current renderer", async () => {
  const owner = {
    renderFrame: vi.fn(async () => {
      throw new Error("Graphics context lost");
    }),
    assertFrame: vi.fn(),
  };
  await expect(
    renderCurrentExportFrame(
      () => owner,
      frame,
      new AbortController().signal,
      paint,
    ),
  ).rejects.toThrow("Graphics context lost");
  expect(owner.renderFrame).toHaveBeenCalledOnce();
});
it("does not reuse an acknowledged frame after its owner changed", async () => {
  const replacement = {
    renderFrame: vi.fn(async () => ({ ...frame, drawSerial: 7 })),
    assertFrame: vi.fn(),
  };
  const old: MapExportHandle = {
    renderFrame: vi.fn(async () => {
      current = replacement;
      return { ...frame, drawSerial: 6 };
    }),
    assertFrame: vi.fn(),
  };
  let current: MapExportHandle = old;
  await expect(
    renderCurrentExportFrame(
      () => current,
      frame,
      new AbortController().signal,
      paint,
    ),
  ).resolves.toMatchObject({ drawSerial: 7 });
});
it("cancels rather than retries when the preview closes during replacement", async () => {
  const controller = new AbortController();
  const next = {
    renderFrame: vi.fn(async () => ({ ...frame, drawSerial: 2 })),
    assertFrame: vi.fn(),
  };
  const old: MapExportHandle = {
    renderFrame: vi.fn(async () => {
      current = next;
      controller.abort();
      throw new Error("The export renderer was closed.");
    }),
    assertFrame: vi.fn(),
  };
  let current: MapExportHandle = old;
  await expect(
    renderCurrentExportFrame(() => current, frame, controller.signal, paint),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(next.renderFrame).not.toHaveBeenCalled();
});
