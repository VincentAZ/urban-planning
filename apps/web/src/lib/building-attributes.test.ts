import { describe, expect, it } from "vitest";
import {
  applyBuildingGeometry,
  buildingGeometry,
  transformBuildingGeometry,
  USER_BUILDING_SOURCE,
} from "@urban/core";
import { typedBuildingPreset } from "@urban/models";
import { withBuildingAttributeEdits } from "./building-attributes";

describe("explicit building attribute edits", () => {
  it("preserves unknown attributes through geometry-only changes and identifies a reviewed zero as an assumption", () => {
    const source = typedBuildingPreset("office", [-112.07, 33.45]);
    const unknown = withBuildingAttributeEdits(
      { ...source, program: undefined },
      {
        height: null,
        floors: null,
        units: null,
        jobs: null,
        parkingSpaces: null,
      },
    );
    const reshaped = applyBuildingGeometry(
      unknown,
      transformBuildingGeometry(buildingGeometry(unknown), { scale: 1.2 }),
    );
    expect([
      reshaped.height,
      reshaped.floors,
      reshaped.units,
      reshaped.jobs,
      reshaped.parkingSpaces,
    ]).toEqual([null, null, null, null, null]);
    expect(reshaped.attributeProvenance).toEqual(unknown.attributeProvenance);
    const knownZero = withBuildingAttributeEdits(unknown, { jobs: 0 });
    expect(knownZero.jobs).toBe(0);
    expect(knownZero.attributeProvenance?.fields.jobs).toMatchObject({
      status: "assumed",
      sourceId: USER_BUILDING_SOURCE.id,
    });
    expect(knownZero.attributeProvenance?.fields.height?.status).toBe(
      "missing",
    );
    expect(unknown.jobs).toBeNull();
  });
});
