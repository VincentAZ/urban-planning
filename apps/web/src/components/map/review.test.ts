import { describe, expect, it, vi } from "vitest";
import type { Place } from "@urban/core";
import {
  dispatchMapClick,
  reviewPinsForPlace,
  type MapReviewPin,
} from "./review";

const ring = (x: number, y: number, size: number): [number, number][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];
const place = {
  boundary: ring(0, 0, 10),
  studyArea: {
    type: "MultiPolygon",
    coordinates: [[ring(0, 0, 6), ring(2, 2, 2)], [ring(8, 0, 2)]],
  },
} as Place;

describe("private review map interactions", () => {
  it("routes a building or street click exclusively to location selection while preserving the current feature selection", () => {
    const onSelect = vi.fn(),
      onMapClick = vi.fn();
    dispatchMapClick([1, 1], "building-42", {
      selectingCommentLocation: true,
      onSelect,
      onMapClick,
    });
    expect(onMapClick).toHaveBeenCalledExactlyOnceWith([1, 1]);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("keeps normal feature editing and empty-ground placement behavior independent from comment mode", () => {
    const onSelect = vi.fn(),
      onMapClick = vi.fn();
    dispatchMapClick([1, 1], "street-42", { onSelect, onMapClick });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("street-42");
    expect(onMapClick).not.toHaveBeenCalled();
    dispatchMapClick([1, 1], undefined, { onSelect, onMapClick });
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onMapClick).toHaveBeenCalledExactlyOnceWith([1, 1]);
  });
  it("does not fall back to editing if a location-selection handler is temporarily absent", () => {
    const onSelect = vi.fn();
    dispatchMapClick([1, 1], "building-42", {
      selectingCommentLocation: true,
      onSelect,
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("only exposes unique pins covered by the captured study geometry, including separate islands but excluding holes", () => {
    const pin = (id: string, position: [number, number]): MapReviewPin => ({
      id,
      position,
      label: "Thread",
    });
    const inside = pin("inside", [1, 1]),
      island = pin("island", [9, 1]);
    const pins = [
      inside,
      pin("inside", [1.5, 1.5]),
      pin("hole", [3, 3]),
      pin("gap", [7, 1]),
      pin("invalid", [NaN, 1]),
      island,
    ];
    expect(reviewPinsForPlace(pins, place)).toEqual([inside, island]);
    expect(pins).toHaveLength(6);
  });
});
