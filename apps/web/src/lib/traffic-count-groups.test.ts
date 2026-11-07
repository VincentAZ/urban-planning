import { describe, expect, it } from "vitest";
import {
  trafficCountFixture,
  trafficFixturePeriod,
  trafficNetworkFixture,
} from "../../../../packages/core/src/traffic-fixture";
import { trafficCountDraft } from "./traffic-draft";
import {
  applyTrafficSeriesMapping,
  countWithinTrafficPeriod,
  groupTrafficCounts,
  previewTrafficSeriesMapping,
  trafficSeriesPreviewCurrent,
} from "./traffic-count-groups";

function series() {
  const first = trafficCountDraft(trafficCountFixture().counts[0]);
  first.count.position = [-112.005, 33];
  first.longitude = "-112.005";
  first.latitude = "33";
  const second = structuredClone(first);
  second.count.id = "later-interval";
  second.count.beginSeconds += 3600;
  second.count.endSeconds += 3600;
  second.begin = "09:00:00";
  second.end = "10:00:00";
  second.value = "0";
  second.count.value = 0;
  second.count.status = "excluded";
  second.count.raw.recordId = "separate-source-line";
  second.count.raw.value = "000";
  second.count.notes = ["This interval was excluded by its original source."];
  return [first, second];
}

describe("exact observation series", () => {
  it("groups intervals with identical source identities but never aliases station case, lane, direction, class, location or clocks", () => {
    const rows = series();
    rows[0].count.sourceIds = ["b", "a"];
    rows[1].count.sourceIds = ["a", "b"];
    expect(groupTrafficCounts(rows)).toHaveLength(1);
    for (const patch of [
      { stationId: rows[1].count.stationId.toUpperCase() + "X" },
      { sourceIds: ["different"] },
      { raw: { ...rows[1].count.raw, laneCode: "2" } },
      { raw: { ...rows[1].count.raw, directionCode: "5" } },
      { raw: { ...rows[1].count.raw, classCode: "different" } },
      { position: null },
      { date: "2026-01-13" },
      { timeZone: "Etc/GMT+7" },
      { utcOffsetMinutes: -360 },
    ])
      expect(
        groupTrafficCounts([
          rows[0],
          { ...rows[1], count: { ...rows[1].count, ...patch } },
        ]),
      ).toHaveLength(2);
    const lower = structuredClone(rows[1]);
    lower.count.stationId = "000aB";
    const upper = structuredClone(lower);
    upper.count.id = "upper";
    upper.count.stationId = "000AB";
    expect(groupTrafficCounts([lower, upper])).toHaveLength(2);
  });
  it("filters the exact selected clock and whole interval without truncating a partly overlapping observation", () => {
    const [first, second] = series();
    expect(countWithinTrafficPeriod(first, trafficFixturePeriod)).toBe(true);
    expect(countWithinTrafficPeriod(second, trafficFixturePeriod)).toBe(false);
    expect(
      countWithinTrafficPeriod(
        { ...first, begin: "07:59:00" },
        trafficFixturePeriod,
      ),
    ).toBe(false);
    expect(
      countWithinTrafficPeriod(
        { ...first, end: "09:01:00" },
        trafficFixturePeriod,
      ),
    ).toBe(false);
    expect(
      countWithinTrafficPeriod(
        { ...first, begin: "bad" },
        trafficFixturePeriod,
      ),
    ).toBe(false);
    expect(
      countWithinTrafficPeriod(
        { ...first, count: { ...first.count, utcOffsetMinutes: 0 } },
        trafficFixturePeriod,
      ),
    ).toBe(false);
  });
  it("copies only the reviewed interpretation and a dedicated note while preserving independent source values and pending edits", () => {
    const network = trafficNetworkFixture(),
      rows = series();
    rows[0].positionPercent = "35";
    rows[0].mappingChanged = true;
    rows[0].laneCoverage = "specific";
    rows[0].laneIds = ["in_0"];
    rows[0].count.vehicleClasses = ["passenger", "truck"];
    rows[1].count.vehicleClasses = null;
    const untouched = structuredClone(rows[1]);
    untouched.count.id = "another-lane";
    untouched.count.raw.laneCode = "9";
    rows.push(untouched);
    const before = structuredClone(rows);
    const preview = previewTrafficSeriesMapping(
      rows,
      rows[0].count.id,
      rows.slice(0, 2).map((row) => row.count.id),
      network,
      {
        classCoverageConfirmed: true,
        note: "Reviewed original direction and numbered source lane.",
      },
    );
    expect(preview.changedExistingMappings).toBe(1);
    const applied = applyTrafficSeriesMapping(preview, rows, network);
    expect(rows).toEqual(before);
    expect(applied[2]).toBe(rows[2]);
    expect(applied[1]).toMatchObject({
      positionPercent: "35",
      laneCoverage: "specific",
      laneIds: ["in_0"],
      mappingChanged: true,
      mappingReviewed: true,
    });
    const { vehicleClasses, notes, ...count } = applied[1].count;
    const {
      vehicleClasses: _classes,
      notes: _notes,
      ...oldCount
    } = rows[1].count;
    expect(count).toEqual(oldCount);
    expect(vehicleClasses).toEqual(["passenger", "truck"]);
    expect(notes).toEqual([
      ...rows[1].count.notes,
      "Series mapping review: Reviewed original direction and numbered source lane.",
    ]);
    for (const key of [
      "value",
      "longitude",
      "latitude",
      "begin",
      "end",
    ] as const)
      expect(applied[1][key]).toBe(rows[1][key]);
    expect(applied[1].laneIds).not.toBe(rows[0].laneIds);
  });
  it("requires explicit class acknowledgement and rejects mixed series or changed source coordinates", () => {
    const network = trafficNetworkFixture(),
      rows = series(),
      ids = rows.map((row) => row.count.id);
    expect(() =>
      previewTrafficSeriesMapping(rows, ids[0], ids, network, {
        classCoverageConfirmed: false,
        note: "",
      }),
    ).toThrow("class coverage");
    rows[1].longitude = String(Number(rows[1].longitude) + 0.0001);
    expect(() =>
      previewTrafficSeriesMapping(rows, ids[0], ids, network, {
        classCoverageConfirmed: true,
        note: "",
      }),
    ).toThrow("station location");
    rows[1] = series()[1];
    rows[1].count.raw.laneCode = "different";
    expect(() =>
      previewTrafficSeriesMapping(rows, ids[0], ids, network, {
        classCoverageConfirmed: true,
        note: "",
      }),
    ).toThrow("identical source");
  });
  it("invalidates previews after graph or exact record changes and never silently accepts a partial preview", () => {
    const network = trafficNetworkFixture(),
      rows = series(),
      ids = rows.map((row) => row.count.id);
    const preview = previewTrafficSeriesMapping(rows, ids[0], ids, network, {
      classCoverageConfirmed: true,
      note: "",
    });
    expect(trafficSeriesPreviewCurrent(preview, rows, network)).toBe(true);
    for (const changed of [
      rows.slice(0, 1),
      [rows[0], { ...rows[1], value: "17" }],
    ]) {
      expect(trafficSeriesPreviewCurrent(preview, changed, network)).toBe(
        false,
      );
      expect(() =>
        applyTrafficSeriesMapping(preview, changed, network),
      ).toThrow("changed after preview");
    }
    const other = structuredClone(network);
    other.manifest.networkFileSha256 = "f".repeat(64);
    expect(() => applyTrafficSeriesMapping(preview, rows, other)).toThrow(
      "changed after preview",
    );
    expect(() =>
      previewTrafficSeriesMapping(rows, ids[0], ids, other, {
        classCoverageConfirmed: true,
        note: "",
      }),
    ).toThrow(/review/i);
  });
  it("binds period-scoped previews to the exact current clock even when the selected interval remains visible", () => {
    const network = trafficNetworkFixture(),
      rows = series(),
      id = rows[0].count.id;
    const preview = previewTrafficSeriesMapping(rows, id, [id], network, {
      classCoverageConfirmed: true,
      note: "",
      period: trafficFixturePeriod,
    });
    expect(
      trafficSeriesPreviewCurrent(preview, rows, network, trafficFixturePeriod),
    ).toBe(true);
    const wider = { ...trafficFixturePeriod, endSeconds: 36000 };
    expect(countWithinTrafficPeriod(rows[0], wider)).toBe(true);
    expect(trafficSeriesPreviewCurrent(preview, rows, network, wider)).toBe(
      false,
    );
    expect(() =>
      applyTrafficSeriesMapping(preview, rows, network, wider),
    ).toThrow("analysis period");
    expect(() => applyTrafficSeriesMapping(preview, rows, network)).toThrow(
      "analysis period",
    );
    expect(() =>
      previewTrafficSeriesMapping(
        rows,
        id,
        rows.map((row) => row.count.id),
        network,
        {
          classCoverageConfirmed: true,
          note: "",
          period: trafficFixturePeriod,
        },
      ),
    ).toThrow("wholly inside");
    const all = previewTrafficSeriesMapping(
      rows,
      id,
      rows.map((row) => row.count.id),
      network,
      { classCoverageConfirmed: true, note: "" },
    );
    expect(trafficSeriesPreviewCurrent(all, rows, network, wider)).toBe(true);
    const extra = structuredClone(rows[1]);
    extra.count.id = "new-source-row";
    expect(
      trafficSeriesPreviewCurrent(all, [...rows, extra], network, wider),
    ).toBe(false);
  });
  it("allows an explicit unknown class interpretation without inventing composition or eligibility", () => {
    const network = trafficNetworkFixture(),
      rows = series(),
      ids = rows.map((row) => row.count.id);
    rows[0].count.vehicleClasses = null;
    rows[0].mappingChanged = true;
    const preview = previewTrafficSeriesMapping(rows, ids[0], ids, network, {
      classCoverageConfirmed: true,
      note: "Original source does not establish class coverage.",
    });
    expect(
      applyTrafficSeriesMapping(preview, rows, network)[1].count.vehicleClasses,
    ).toBeNull();
  });
});
