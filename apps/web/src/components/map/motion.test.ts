import { describe, expect, it } from "vitest";
import {
  createTrackBuffers,
  simulatedSecond,
  updateTrackBuffers,
  type VehicleTracks,
} from "./motion";

const tracks: VehicleTracks = {
  version: 1,
  side: "proposal",
  beginSeconds: 25200,
  endSeconds: 25210,
  stepSeconds: 2,
  vehicles: [
    // Heading east (90° clockwise from north) for three samples.
    { id: "a", t0: 25200, lonlat: [-112, 33, -111.99, 33, -111.98, 33], angle: [90, 90, 90] },
    // Departs later and turns from 350° to 10° through north.
    { id: "b", t0: 25206, lonlat: [-112, 33.1, -112, 33.11], angle: [350, 10] },
  ],
};

describe("SUMO track playback", () => {
  it("starts with no vehicles drawn and no tracks means none ever", () => {
    expect(createTrackBuffers(tracks).count).toBe(0);
    const empty = createTrackBuffers(null);
    updateTrackBuffers(empty, null, 100);
    expect(empty.count).toBe(0);
  });

  it("loops playback over the study period", () => {
    expect(simulatedSecond(tracks, 0)).toBe(25200);
    expect(simulatedSecond(tracks, 13)).toBe(25203);
  });

  it("interpolates executed positions and converts heading to deck.gl", () => {
    const buffers = createTrackBuffers(tracks);
    updateTrackBuffers(buffers, tracks, 1);
    expect(buffers.count).toBe(1);
    expect(buffers.positions[0]).toBeCloseTo(-111.995, 9);
    expect(buffers.positions[1]).toBeCloseTo(33, 9);
    expect(buffers.angles[0]).toBeCloseTo(-90);
  });

  it("shows only vehicles on the road at that second and blends heading across north", () => {
    const buffers = createTrackBuffers(tracks);
    updateTrackBuffers(buffers, tracks, 7);
    // "a" arrived after its last sample at 25204; "b" is halfway between samples.
    expect(buffers.count).toBe(1);
    expect(buffers.positions[1]).toBeCloseTo(33.105, 9);
    expect(((buffers.angles[0] % 360) + 360) % 360).toBeCloseTo(0);
  });
});
