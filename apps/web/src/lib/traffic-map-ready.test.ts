import { describe, expect, it, vi } from "vitest";
import { trafficMapForUpdate } from "./traffic-map-ready";

describe("traffic map instance readiness", () => {
  it("does not send stale render effects to a replacement map before its style loads, then applies them after its own load", () => {
    const previous = { getLayer: vi.fn(() => ({})), setFilter: vi.fn() };
    let layersReady = false;
    const replacement = {
      getLayer: vi.fn(() => (layersReady ? {} : undefined)),
      setFilter: vi.fn(),
    };
    const update = (
      current: typeof previous | typeof replacement | null,
      loaded: typeof previous | typeof replacement | null,
    ) =>
      trafficMapForUpdate(current, loaded)?.setFilter("selected", [
        "==",
        "id",
        "reviewed-edge",
      ]);
    // Adoption recreates the map before React commits the next readiness state.
    update(replacement, previous);
    expect(replacement.getLayer).not.toHaveBeenCalled();
    expect(replacement.setFilter).not.toHaveBeenCalled();
    layersReady = true;
    update(replacement, replacement);
    expect(replacement.setFilter).toHaveBeenCalledOnce();
    expect(replacement.setFilter).toHaveBeenCalledWith("selected", [
      "==",
      "id",
      "reviewed-edge",
    ]);
  });
  it("withholds style commands while the loaded instance has no network layer and after teardown", () => {
    let hasLayer = false;
    const map = { getLayer: () => (hasLayer ? {} : undefined) };
    expect(trafficMapForUpdate(map, map)).toBeNull();
    hasLayer = true;
    expect(trafficMapForUpdate(map, map)).toBe(map);
    expect(trafficMapForUpdate(null, map)).toBeNull();
    expect(trafficMapForUpdate(map, null)).toBeNull();
  });
});
