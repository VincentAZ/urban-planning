import { describe, expect, it } from "vitest";
import {
  trafficDemandFixture,
  trafficNetworkFixture,
  trafficFixturePeriod,
} from "../../core/src/traffic-fixture";
import { allocateTrafficVehicles } from "./traffic";

describe("attachment-preserving demand allocation", () => {
  it("preserves seed/departure/route allocation and copies optional native attachments", () => {
    const demand = trafficDemandFixture(),
      network = trafficNetworkFixture();
    const original = allocateTrafficVehicles(
      demand,
      network,
      42,
      trafficFixturePeriod,
    );
    const endpoints = {
      departLaneId: "in_0",
      departPositionMeters: 12.5,
      arrivalLaneId: "out_0",
      arrivalPositionMeters: 83.25,
    };
    demand.rows[0].endpoints = endpoints;
    const attached = allocateTrafficVehicles(
      demand,
      network,
      42,
      trafficFixturePeriod,
    );
    expect(
      attached.vehicles.map(({ endpoints: _, ...vehicle }) => vehicle),
    ).toEqual(original.vehicles);
    expect(attached.routeCounts).toEqual(original.routeCounts);
    expect(
      original.vehicles.every(
        (vehicle) => !Object.hasOwn(vehicle, "endpoints"),
      ),
    ).toBe(true);
    for (const vehicle of attached.vehicles) {
      expect(vehicle.endpoints).toEqual(endpoints);
      expect(vehicle.endpoints).not.toBe(endpoints);
    }
  });
});
