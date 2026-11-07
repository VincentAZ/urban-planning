import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { baselineIdentity, type Place } from "@urban/core";
import {
  downloadVehicleCache,
  enrichPlaceVehicleAvailability,
  readPlaceVehicleReference,
  readVehicleCache,
  VEHICLE_SOURCE_URL,
  vehicleAvailabilityFromCache,
  vehicleCacheSchema,
  type VehicleCache,
} from "./acs-vehicles";
const now = "2026-11-05T00:00:00.000Z";
export const vehicleFixture = (): VehicleCache => ({
  schemaVersion: 1,
  dataset: "acs/acs5",
  vintage: 2024,
  period: { start: 2020, end: 2024 },
  retrievedAt: now,
  sourceFile: {
    table: "B25046",
    url: VEHICLE_SOURCE_URL,
    sha256: "a".repeat(64),
    retrievedAt: now,
    bytes: 100,
  },
  columns: ["B25046_E001", "B25046_M001"],
  rows: {
    "85004": ["120", "19"],
    "00000": ["0", "3"],
    "00001": ["-999999999", "-999999999"],
  },
});
const place = (): Place => ({
  id: "vehicle-test",
  name: "Vehicle QA",
  city: "QA",
  state: "AZ",
  zip: "85004",
  center: [-112, 33],
  bounds: [-112.01, 32.99, -111.99, 33.01],
  boundary: [
    [-112.01, 32.99],
    [-111.99, 32.99],
    [-111.99, 33.01],
    [-112.01, 33.01],
    [-112.01, 32.99],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: now,
  extentLabel: "Synthetic vehicle geography",
  geography: { type: "zcta", code: "85004", boundaryVintage: "2020" },
});
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function cacheFile() {
  const dir = await mkdtemp(join(tmpdir(), "urban-vehicles-"));
  directories.push(dir);
  const path = join(dir, "vehicles.json");
  await writeFile(path, JSON.stringify(vehicleFixture()));
  return path;
}
describe("separate household-vehicle source evidence", () => {
  it("retains direct published totals, MOE, universe and detailed-table provenance without a profile-data substitution", () => {
    const value = vehicleAvailabilityFromCache(vehicleFixture(), "85004", true);
    expect(value).toMatchObject({
      dataset: "acs/acs5",
      geography: {
        id: "85004",
        boundaryVintage: "2020",
        relationshipToStudyArea: "same-area",
      },
      confidenceLevel: 90,
      measure: {
        unit: "vehicles",
        universe: "Occupied housing units",
        estimate: { value: 120, raw: "120", status: "available" },
        marginOfError: { value: 19 },
        variables: { estimate: "B25046_001E" },
      },
    });
    expect(value.source.kind).toBe("published-estimate");
    expect(value.notes.join(" ")).toContain(
      "not a count of vehicles on the road",
    );
  });
  it("distinguishes a published zero, a suppressed row and an absent geography", () => {
    const cache = vehicleFixture();
    expect(
      vehicleAvailabilityFromCache(cache, "00000").measure.estimate.value,
    ).toBe(0);
    expect(
      vehicleAvailabilityFromCache(cache, "00001").measure.estimate,
    ).toMatchObject({ value: null, status: "suppressed" });
    expect(() => vehicleAvailabilityFromCache(cache, "99999")).toThrow(
      /no record/,
    );
  });
  it("only enriches a fresh exact ZCTA snapshot and leaves the original identity/data unchanged", async () => {
    const path = await cacheFile(),
      original = place(),
      before = structuredClone(original),
      identity = await baselineIdentity(original);
    const enriched = await enrichPlaceVehicleAvailability(original, path);
    expect(enriched.vehicleAvailability?.measure.estimate.value).toBe(120);
    expect(original).toEqual(before);
    expect(await baselineIdentity(original)).toEqual(identity);
    expect(await baselineIdentity(enriched)).not.toEqual(identity);
    expect(
      await enrichPlaceVehicleAvailability(enriched, "missing-cache"),
    ).toBe(enriched);
    const partial = { ...original, geography: undefined };
    expect(
      (await enrichPlaceVehicleAvailability(partial, path)).vehicleAvailability,
    ).toBeUndefined();
    await expect(readPlaceVehicleReference(partial, path)).rejects.toThrow(
      /not an exact/,
    );
    await expect(
      readPlaceVehicleReference({ ...original, zip: "60601" }, path),
    ).rejects.toThrow(/not an exact/);
  });
  it("fails missing/corrupt/oversized caches honestly without replacing estimates with zero", async () => {
    const path = await cacheFile();
    await expect(readVehicleCache(`${path}.missing`)).rejects.toThrow(
      /not been prepared/,
    );
    await writeFile(path, '{"private text broken');
    await expect(readVehicleCache(path)).rejects.toThrow(
      /^The prepared household-vehicle cache is invalid/,
    );
    await writeFile(path, "x".repeat(2_000_001));
    await expect(readVehicleCache(path)).rejects.toThrow(/supported size/);
    expect(() =>
      vehicleCacheSchema.parse({ ...vehicleFixture(), columns: ["different"] }),
    ).toThrow();
  });
  it("downloads only the allowlisted table and keeps raw cells and a full-source hash", async () => {
    const body =
      "GEO_ID|NAME|B25046_E001|B25046_M001\n860Z200US85004|ZCTA5 85004|120|19\n860Z200US00001|ZCTA5 00001|-999999999|-999999999\n";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, {
          headers: { "content-length": String(Buffer.byteLength(body)) },
        }),
      );
    const result = await downloadVehicleCache(fetcher);
    expect(fetcher.mock.calls[0][0]).toBe(VEHICLE_SOURCE_URL);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
    expect(result.rows["85004"]).toEqual(["120", "19"]);
    expect(result.sourceFile.bytes).toBe(Buffer.byteLength(body));
    expect(result.sourceFile.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects excess, truncated and duplicate official responses without producing a partial cache", async () => {
    const fetcher = (body: string, length: number) =>
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(body, { headers: { "content-length": String(length) } }),
        );
    await expect(downloadVehicleCache(fetcher("", 25_000_001))).rejects.toThrow(
      /25 MB/,
    );
    const body = "GEO_ID|B25046_E001|B25046_M001\n860Z200US85004|120|19\n";
    await expect(
      downloadVehicleCache(fetcher(body, body.length + 1)),
    ).rejects.toThrow(/incomplete/);
    await expect(
      downloadVehicleCache(fetcher(body + "860Z200US85004|121|20\n", 0)),
    ).rejects.toThrow(/duplicate/);
  });
});
