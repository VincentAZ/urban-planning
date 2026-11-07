import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FHWA_STATION_COLUMNS,
  FHWA_VOLUME_COLUMNS,
  fhwaCountPack,
  readFhwaStations,
  readFhwaVolumes,
  type FhwaPackSelection,
} from "./traffic-fhwa";

const stationRow = (extra: Record<string, string> = {}) => ({
  Record_Type: "S",
  State_Code: "4",
  Station_Id: "001A",
  Travel_Dir: "3",
  Travel_Lane: "1",
  Year_Record: "2025",
  Number_Lanes_In_Direction: "2",
  Latitude: "33.38",
  Longitude: "-112.19",
  Station_Location: "Synthetic station — eastbound",
  ...extra,
});
const volumeRow = (extra: Record<string, string> = {}) => ({
  Record_Type: "3",
  State_Code: "4",
  F_System: "1",
  Station_Id: "001A",
  Travel_Dir: "3",
  Travel_Lane: "1",
  Year_Record: "2025",
  Month_Record: "10",
  Day_Record: "2",
  Day_of_Week: "5",
  Restrictions: "",
  Time_Increment: "",
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, h) => [
      `Hour_${String(h).padStart(2, "0")}`,
      "0",
    ]),
  ),
  ...extra,
});
const file = (columns: string[], rows: Record<string, string>[]) =>
  columns.join("|") +
  "\r\n" +
  rows.map((row) => columns.map((c) => row[c] ?? "").join("|")).join("\r\n") +
  "\r\n";
async function* chunks(text: string, width = 7) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += width)
    yield bytes.subarray(i, i + width);
}
const selection: FhwaPackSelection = {
  stateFips: "04",
  year: 2025,
  month: 10,
  date: "2025-10-02",
  stationIds: ["001A"],
  timeZone: "America/Phoenix",
  utcOffsetMinutes: -420,
  timeInterpretationSource:
    "Synthetic Phoenix test station; explicit clock assumption",
};
async function fixture(stations = [stationRow()], volumes = [volumeRow()]) {
  const station = await readFhwaStations(
    chunks(file(FHWA_STATION_COLUMNS, stations)),
    selection,
  );
  const volume = await readFhwaVolumes(
    chunks(file(FHWA_VOLUME_COLUMNS, volumes)),
    selection,
  );
  return { station, volume };
}
describe("FHWA source observations", () => {
  it("streams split UTF-8 and preserves exact IDs, source hash, blank intervals and reported zeros", async () => {
    const text =
      "\uFEFF" +
      file(FHWA_STATION_COLUMNS, [stationRow({ Type_Sensor_2: "\0" })]);
    const station = await readFhwaStations(chunks(text, 1), selection);
    expect(station.sha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(station.bytes).toBe(Buffer.byteLength(text));
    expect(station.rows[0]).toMatchObject({
      id: "001A",
      description: "Synthetic station — eastbound",
      position: [-112.19, 33.38],
      raw: { Type_Sensor_2: "\0" },
    });
    const { volume } = await fixture(undefined, [
      volumeRow({ Hour_07: "", Hour_08: "125" }),
    ]);
    const pack = fhwaCountPack(station, volume, selection, []);
    expect(pack.counts).toHaveLength(24);
    expect(pack.counts.find((c) => c.beginSeconds === 0)).toMatchObject({
      value: 0,
      status: "available",
      target: null,
      vehicleClasses: null,
      raw: { value: "0", directionCode: "3", laneCode: "1" },
    });
    expect(pack.counts.find((c) => c.beginSeconds === 7 * 3600)).toMatchObject({
      value: null,
      status: "missing",
      raw: { value: "" },
    });
    expect(pack.counts.find((c) => c.beginSeconds === 8 * 3600)?.value).toBe(
      125,
    );
    expect(pack.annualCounts).toEqual([]);
    expect(pack.counts[0].notes.join(" ")).toMatch(
      /not a confirmed unrestricted/,
    );
  });
  it("retains expected missing daily lanes and excludes declared counter malfunction without losing values", async () => {
    const { station, volume } = await fixture(
      [stationRow(), stationRow({ Travel_Lane: "2" })],
      [volumeRow({ Restrictions: "2", Hour_07: "44" })],
    );
    const pack = fhwaCountPack(station, volume, selection, []);
    expect(pack.counts.filter((c) => c.raw.laneCode === "2")).toHaveLength(24);
    expect(
      pack.counts
        .filter((c) => c.raw.laneCode === "2")
        .every(
          (c) =>
            c.status === "missing" && c.value === null && c.raw.value === null,
        ),
    ).toBe(true);
    expect(
      pack.counts.find(
        (c) => c.raw.laneCode === "1" && c.beginSeconds === 7 * 3600,
      ),
    ).toMatchObject({ value: 44, status: "excluded" });
  });
  it("maps only documented source time bins and rejects overlapping hourly/quarter-hour resolution", async () => {
    const { station, volume } = await fixture(undefined, [
      volumeRow({ Time_Increment: "2", Hour_07: "21" }),
    ]);
    const quarter = fhwaCountPack(station, volume, selection, []);
    expect(
      quarter.counts.find((c) => c.beginSeconds === 7 * 3600 + 900),
    ).toMatchObject({ endSeconds: 7 * 3600 + 1800, value: 21 });
    const five = await fixture(undefined, [volumeRow({ Time_Increment: "L" })]);
    expect(
      fhwaCountPack(five.station, five.volume, selection, []).counts.some(
        (c) => c.beginSeconds === 23 * 3600 + 3300 && c.endSeconds === 86400,
      ),
    ).toBe(true);
    const overlap = await fixture(undefined, [
      volumeRow(),
      volumeRow({ Time_Increment: "1" }),
    ]);
    expect(() =>
      fhwaCountPack(overlap.station, overlap.volume, selection, []),
    ).toThrow(/double-count/);
  });
  it("rejects duplicate keys and combined/individual totals, preserving station case", async () => {
    await expect(
      fixture(undefined, [volumeRow(), volumeRow()]),
    ).rejects.toThrow(/Duplicate/);
    await expect(fixture([stationRow(), stationRow()])).rejects.toThrow(
      /Duplicate/,
    );
    const mixed = await fixture(
      [stationRow(), stationRow({ Travel_Lane: "0" })],
      [volumeRow(), volumeRow({ Travel_Lane: "0" })],
    );
    expect(() =>
      fhwaCountPack(mixed.station, mixed.volume, selection, []),
    ).toThrow(/double-count/);
    const { station, volume } = await fixture();
    expect(() =>
      fhwaCountPack(
        station,
        volume,
        { ...selection, stationIds: ["001a"] },
        [],
      ),
    ).toThrow(/absent/);
  });
  it.each<Record<string, string>>([
    { Hour_00: "-1" },
    { Hour_00: "1,000" },
    { Time_Increment: "0" },
    { Restrictions: "9" },
    { Day_of_Week: "1" },
    { Day_Record: "32" },
    { State_Code: "6" },
    { Month_Record: "9" },
  ])(
    "rejects invalid source semantics instead of coercing %j",
    async (extra) => {
      await expect(fixture(undefined, [volumeRow(extra)])).rejects.toThrow(
        /FHWA line/,
      );
    },
  );
  it("refuses changed or duplicate headers and a truncated row", async () => {
    await expect(
      readFhwaVolumes(
        chunks(file([...FHWA_VOLUME_COLUMNS, "Unexpected"], [volumeRow()])),
        selection,
      ),
    ).rejects.toThrow(/headers/);
    const duplicate = [...FHWA_VOLUME_COLUMNS];
    duplicate[1] = duplicate[0];
    await expect(
      readFhwaVolumes(chunks(file(duplicate, [volumeRow()])), selection),
    ).rejects.toThrow(/headers/);
    await expect(
      readFhwaVolumes(
        chunks(FHWA_VOLUME_COLUMNS.join("|") + "\n3|4\n"),
        selection,
      ),
    ).rejects.toThrow(/field count/);
  });
  it("requires the explicit local clock and refuses a DST-changing day rather than fabricating an hour", async () => {
    const { station, volume } = await fixture();
    expect(() =>
      fhwaCountPack(station, volume, { ...selection, utcOffsetMinutes: 0 }, []),
    ).toThrow(/offset/);
    expect(() =>
      fhwaCountPack(
        station,
        volume,
        { ...selection, timeInterpretationSource: "" },
        [],
      ),
    ).toThrow(/basis/);
    const dst = {
      ...selection,
      month: 11,
      date: "2025-11-02",
      timeZone: "America/New_York",
      utcOffsetMinutes: -240,
    };
    expect(() => fhwaCountPack(station, volume, dst, [])).toThrow(
      /daylight saving/,
    );
  });
});
