import { describe, expect, it, vi } from "vitest";
import { PathLayer, PolygonLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import {
  clampRevealPercent,
  clipRevealLayers,
  RevealExtension,
  type RevealLayerProps,
} from "./reveal";

describe("same-camera before/after reveal", () => {
  it("keeps shared study geometry and scenario buffers intact as the divider moves", () => {
    const footprint = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
      roads = [
        {
          path: [
            [0, 0],
            [1, 1],
          ],
        },
      ];
    const ground = new PolygonLayer({
      id: "reference-area",
      data: [footprint],
      getPolygon: (d) => d,
    });
    const before = new PathLayer({
      id: "before-road-surfaces",
      data: roads,
      getPath: (d) => d.path,
      pickable: true,
    });
    const proposal = new PolygonLayer({
      id: "buildings",
      data: [footprint],
      getPolygon: (d) => d,
      pickable: true,
    });
    const first = clipRevealLayers([ground, before, proposal], 25);
    const moved = clipRevealLayers([ground, before, proposal], 75);
    expect(first[0]).toBe(ground);
    expect(moved[0]).toBe(ground);
    for (let i = 1; i < first.length; i++) {
      expect(moved[i].props.data).toBe(first[i].props.data);
      expect(moved[i].id).toBe(first[i].id);
      expect(moved[i].props.extensions[0]).toBe(first[i].props.extensions[0]);
      expect(moved[i].props.pickable).toBe(false);
    }
    expect((first[1].props as unknown as RevealLayerProps).revealSide).toBe(-1);
    expect((first[2].props as unknown as RevealLayerProps).revealSide).toBe(1);
    expect(before.props.pickable).toBe(true);
    expect(proposal.props.pickable).toBe(true);
  });

  it("uses the current physical buffer width for HiDPI, resize, and full-before/full-after endpoints", () => {
    const setProps = vi.fn(),
      getDrawingBufferSize = vi.fn(() => [2400, 1600]);
    const layer = {
      props: { revealSide: -1, revealPercent: 25 },
      context: { device: { canvasContext: { getDrawingBufferSize } } },
      getModels: () => [{ shaderInputs: { setProps } }],
    } as unknown as Layer<RevealLayerProps>;
    RevealExtension.prototype.draw.call(layer);
    expect(setProps).toHaveBeenLastCalledWith({
      urbanReveal: { divider: 600, side: -1 },
    });
    getDrawingBufferSize.mockReturnValue([1200, 800]);
    RevealExtension.prototype.draw.call(layer);
    expect(setProps).toHaveBeenLastCalledWith({
      urbanReveal: { divider: 300, side: -1 },
    });
    expect(clampRevealPercent(-10)).toBe(0);
    expect(clampRevealPercent(125)).toBe(100);
    expect(clampRevealPercent(NaN)).toBe(50);
  });
});
