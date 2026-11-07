import { expect, it, vi } from "vitest";
import {
  MapExportFence,
  type MapExportFrame,
  type MapExportState,
} from "./export-frame";
const camera = {
  center: [-112, 33] as [number, number],
  zoom: 15,
  pitch: 45,
  bearing: 0,
};
const frame: MapExportFrame = {
  sceneHash: "scene",
  frameIndex: 0,
  width: 1920,
  height: 960,
  view: "3d",
  camera,
};
function fixture() {
  const state: MapExportState = {
    ...frame,
    ready: true,
    style: "3d",
    drawSerial: 3,
    layerGeneration: 2,
    drawnLayerGeneration: 2,
    error: null,
  };
  const prepare = vi.fn();
  return { state, prepare, fence: new MapExportFence(() => state, prepare) };
}
it("requires a fresh complete Deck generation, exact view and camera before acknowledging", async () => {
  const { state, fence, prepare } = fixture();
  const done = vi.fn();
  const result = fence.renderFrame(frame).then(done);
  fence.rendered();
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  state.drawSerial++;
  state.drawnLayerGeneration = 1;
  fence.rendered();
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  state.drawnLayerGeneration = 2;
  state.camera = { ...camera, pitch: 0 };
  fence.rendered();
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  state.camera = camera;
  state.style = "2d";
  fence.rendered();
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  state.style = "3d";
  fence.rendered();
  await result;
  expect(done).toHaveBeenCalledWith({ ...frame, drawSerial: 4 });
  expect(prepare).toHaveBeenCalledOnce();
});
it("fails closed on downsampling or context loss instead of accepting reduced graphics", async () => {
  const one = fixture();
  const result = one.fence.renderFrame(frame);
  one.state.drawSerial++;
  one.state.width = 960;
  one.fence.rendered();
  await expect(result).rejects.toThrow("exact requested dimensions");
  const two = fixture();
  const lost = two.fence.renderFrame(frame);
  two.state.error = "Graphics context lost";
  two.fence.rendered();
  await expect(lost).rejects.toThrow("Graphics context lost");
});
it("binds scene identity and rejects satellite and pitched 2D without fallback", async () => {
  const { fence } = fixture();
  await expect(
    fence.renderFrame({ ...frame, sceneHash: "other" }),
  ).rejects.toThrow("frozen scene");
  await expect(
    fence.renderFrame({ ...frame, view: "satellite" as "3d" }),
  ).rejects.toThrow("frozen scene");
  await expect(fence.renderFrame({ ...frame, view: "2d" })).rejects.toThrow(
    "frozen scene",
  );
});
it("cancels replaced requests and pending frames when closed or aborted", async () => {
  const { fence } = fixture();
  const first = fence.renderFrame(frame);
  const firstCheck = expect(first).rejects.toThrow("newer export frame");
  const controller = new AbortController();
  const second = fence.renderFrame(
    { ...frame, frameIndex: 1 },
    controller.signal,
  );
  controller.abort();
  await firstCheck;
  await expect(second).rejects.toThrow("cancelled");
  const third = fence.renderFrame(frame);
  fence.cancel();
  await expect(third).rejects.toThrow("closed");
});
it("rejects context loss, camera drift and unapplied layers after acknowledgement without starting another draw", async () => {
  const { state, fence, prepare } = fixture();
  const result = fence.renderFrame(frame);
  state.drawSerial++;
  fence.rendered();
  await result;
  expect(() => fence.assertFrame(frame)).not.toThrow();
  state.error = "Graphics context lost";
  expect(() => fence.assertFrame(frame)).toThrow("Graphics context lost");
  state.error = null;
  state.camera = { ...camera, bearing: 20 };
  expect(() => fence.assertFrame(frame)).toThrow("changed before capture");
  state.camera = camera;
  state.layerGeneration++;
  expect(() => fence.assertFrame(frame)).toThrow("changed before capture");
  expect(prepare).toHaveBeenCalledOnce();
});
