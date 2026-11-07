import { describe, expect, it } from "vitest";
import {
  trafficCountFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
  trafficNetworkFixture,
} from "../../../../packages/core/src/traffic-fixture";
import { validateTrafficDemand } from "@urban/core";
import { parseTrafficCSV } from "./traffic-csv";
import {
  createTrafficCountNetworkIndex,
  changeTrafficCountTarget,
  countsFromCSV,
  draftSource,
  trafficDeclarationsForSources,
  authoredTrafficCommuteCopy,
  readTrafficClock,
  readTrafficCoordinates,
  readTrafficCountDraft,
  trafficCountDraft,
  validateTrafficOverlayDraft,
} from "./traffic-draft";
import {
  demandDraft,
  readDemandDraft,
  routeDraft,
} from "../components/traffic/TrafficDemandPanel";

describe("traffic evidence review", () => {
  it("detaches commute values as authored without changing exact lane positions, fractional time, source citations or original input", () => {
    const original = trafficDemandFixture();
    original.rows[0] = {
      ...original.rows[0],
      quality: "inferred",
      beginSeconds: 25200.123456789,
      endpoints: {
        departLaneId: "lane-a",
        departPositionMeters: 12.3456789,
        arrivalLaneId: "lane-b",
        arrivalPositionMeters: 98.7654321,
      },
    };
    const before = structuredClone(original);
    const copy = authoredTrafficCommuteCopy(original);
    expect(copy.rows.every((row) => row.quality === "authored")).toBe(true);
    expect(copy.rows[0]).toEqual({ ...before.rows[0], quality: "authored" });
    expect(copy.candidateRoutes).toEqual(before.candidateRoutes);
    expect(copy.sources).toEqual(before.sources);
    expect(copy.notes.at(-1)).toContain("verification no longer applies");
    expect(original).toEqual(before);
  });
  it("removes orphan demand declarations when a commute preset replaces demand while preserving count-source permissions", () => {
    const declaration = {
      sourceId: "old-demand",
      name: "Authored demand",
      url: "",
      vintage: "Authored",
      license: "Author permission",
      privateUseConfirmed: true,
      publicRedistribution: false,
    };
    const declarations = [
      declaration,
      {
        ...declaration,
        sourceId: "retained-count",
        name: "Observed counts",
        publicRedistribution: true,
      },
    ];
    const before = structuredClone(declarations);
    expect(
      trafficDeclarationsForSources(declarations, [
        { id: "retained-count" },
        { id: "census-preset" },
      ]),
    ).toEqual([declarations[1]]);
    expect(
      trafficDeclarationsForSources(declarations, [
        { id: "retained-count" },
        { id: "old-demand" },
      ]),
    ).toEqual(declarations);
    expect(declarations).toEqual(before);
  });
  it("retains excluded published values and raw codes; only missing clears the working value", () => {
    const count = trafficCountFixture().counts[0];
    count.stationId = "000aB";
    count.value = 0;
    count.raw.value = "000";
    count.status = "excluded";
    const draft = trafficCountDraft(count);
    const before = structuredClone(count);
    expect(readTrafficCountDraft(draft, trafficNetworkFixture()).count).toEqual(
      before,
    );
    draft.value = "153";
    expect(
      readTrafficCountDraft(draft, trafficNetworkFixture()).count.value,
    ).toBe(153);
    draft.count = { ...draft.count, status: "missing" };
    draft.value = "incomplete numeric correction";
    expect(
      readTrafficCountDraft(draft, trafficNetworkFixture()).count.value,
    ).toBeNull();
    expect(count).toEqual(before);
  });

  it("preserves factored decimals while rejecting fractional observed counts", () => {
    const draft = trafficCountDraft(trafficCountFixture().counts[0]);
    draft.value = "12.5";
    expect(() =>
      readTrafficCountDraft(draft, trafficNetworkFixture()),
    ).toThrow();
    draft.count = { ...draft.count, kind: "factored" };
    expect(
      readTrafficCountDraft(draft, trafficNetworkFixture()).count.value,
    ).toBe(12.5);
  });

  it("requires a reviewed detector position and exact graph binding without inventing an actor or snap", () => {
    const network = trafficNetworkFixture();
    const draft = trafficCountDraft(trafficCountFixture().counts[0]);
    network.manifest.networkFileSha256 = "e".repeat(64);
    expect(() => readTrafficCountDraft(draft, network)).toThrow(/review/i);
    draft.mappingChanged = true;
    draft.laneCoverageNetworkHash = network.manifest.networkFileSha256;
    draft.positionPercent = "";
    expect(() => readTrafficCountDraft(draft, network)).toThrow(
      "reviewed count location",
    );
    draft.positionPercent = "25";
    draft.mappingReviewed = false;
    expect(() => readTrafficCountDraft(draft, network)).toThrow(/review/i);
    draft.mappingReviewed = true;
    const output = readTrafficCountDraft(draft, network);
    expect(output.count.mapping).toBeUndefined();
    expect(output.review).toEqual({
      countId: draft.count.id,
      target: { kind: "edge", edgeId: "in", positionFraction: 0.25 },
      networkFileSha256: "e".repeat(64),
      directionAgreement: "confirmed",
    });
    draft.targetKind = "unmapped";
    expect(readTrafficCountDraft(draft, network).count.mapping).toBeUndefined();
    expect(readTrafficCountDraft(draft, network).review).toBeUndefined();
  });

  it("rejects invalid lane, time zone, date and coordinate edits before admission", () => {
    const network = trafficNetworkFixture();
    const draft = trafficCountDraft(trafficCountFixture().counts[0]);
    draft.laneIds = ["out_0"];
    expect(() => readTrafficCountDraft(draft, network)).toThrow("lane");
    draft.laneIds = [];
    draft.count = { ...draft.count, date: "2026-02-30" };
    expect(() => readTrafficCountDraft(draft, network)).toThrow();
    draft.count = { ...draft.count, date: "2026-01-12", utcOffsetMinutes: 0 };
    expect(() => readTrafficCountDraft(draft, network)).toThrow("UTC offset");
    expect(readTrafficCoordinates("", "")).toBeNull();
    expect(() => readTrafficCoordinates("-112", "")).toThrow("both");
    expect(readTrafficClock("24:00", "End")).toBe(86400);
    expect(() => readTrafficClock("24:01", "End")).toThrow();
  });

  it("stages CSV zero and missing separately with exact station codes, source rows and no inferred targets/classes", () => {
    const table = parseTrafficCSV(
      "station,count,dir,class\n000aB,0,01,13\n000AB,,03,\n",
    );
    const map = { station: 0, value: 1, direction: 2, class: 3 };
    expect(() =>
      countsFromCSV(
        table,
        map,
        trafficFixturePeriod,
        "source",
        false,
        "observed",
        "batch",
      ),
    ).toThrow("Map the observation date");
    const rows = countsFromCSV(
      table,
      map,
      trafficFixturePeriod,
      "source",
      true,
      "observed",
      "batch",
    );
    expect(rows.map((row) => [row.stationId, row.value, row.status])).toEqual([
      ["000aB", 0, "available"],
      ["000AB", null, "missing"],
    ]);
    expect(rows[0]).toMatchObject({
      position: null,
      target: null,
      vehicleClasses: null,
      sourceIds: ["source"],
      raw: {
        directionCode: "01",
        classCode: "13",
        recordId: "line-2",
        value: "0",
      },
    });
    expect(rows[0].notes.join(" ")).toContain("explicitly selected");
    expect(() =>
      countsFromCSV(
        parseTrafficCSV("s,n\na,1.5"),
        { station: 0, value: 1 },
        trafficFixturePeriod,
        "source",
        true,
        "observed",
        "batch",
      ),
    ).toThrow();
    expect(
      countsFromCSV(
        parseTrafficCSV("s,n\na,1.5"),
        { station: 0, value: 1 },
        trafficFixturePeriod,
        "source",
        true,
        "factored",
        "batch",
      )[0].value,
    ).toBe(1.5);
  });

  it("retains explicit source declarations without manufacturing authenticated permission metadata", () => {
    const source = draftSource({
      sourceId: "cited",
      name: " Authored scenario ",
      url: "",
      vintage: "",
      license: "Author permits use",
      privateUseConfirmed: true,
      publicRedistribution: false,
    });
    expect(source).toMatchObject({
      id: "cited",
      name: "Authored scenario",
      vintage: "Unknown",
      kind: "user-supplied",
    });
    expect(source.rights).toBeUndefined();
    expect(source.import).toBeUndefined();
  });

  it("does not infer lane/speed defaults and preserves zero closure distinctly from invalid numeric fields", () => {
    const network = trafficNetworkFixture();
    expect(
      validateTrafficOverlayDraft(network, [
        { edgeId: "in", closed: false, lanes: "", speedMps: "" },
      ]),
    ).toEqual([]);
    expect(
      validateTrafficOverlayDraft(network, [
        { edgeId: "in", closed: true, lanes: "", speedMps: "" },
      ]),
    ).toEqual([{ edgeId: "in", closed: true }]);
    for (const patch of [
      { lanes: "0" },
      { lanes: "1.5" },
      { speedMps: "0" },
      { speedMps: "NaN" },
    ])
      expect(() =>
        validateTrafficOverlayDraft(network, [
          { edgeId: "in", closed: false, lanes: "", speedMps: "", ...patch },
        ]),
      ).toThrow();
  });

  it("uses a reusable graph index without accepting a stale graph or unknown target", () => {
    const network = trafficNetworkFixture(),
      draft = trafficCountDraft(trafficCountFixture().counts[0]);
    const index = createTrafficCountNetworkIndex(network);
    expect(readTrafficCountDraft(draft, network, index)).toEqual(
      readTrafficCountDraft(draft, network),
    );
    expect(() =>
      readTrafficCountDraft(draft, structuredClone(network), index),
    ).toThrow("different traffic graph");
    const turn = changeTrafficCountTarget(draft, "turn", "connection-0");
    turn.mappingReviewed = true;
    expect(readTrafficCountDraft(turn, network, index).count.target).toEqual({
      kind: "turn",
      connectionId: "connection-0",
    });
    turn.targetId = "absent";
    expect(() => readTrafficCountDraft(turn, network, index)).toThrow(
      "turning movement",
    );
    expect(() =>
      readTrafficCountDraft({ ...draft, targetId: "absent" }, network, index),
    ).toThrow("directed edge");
  });

  it("requires an explicit lane interpretation and clears it when a target changes", () => {
    const network = trafficNetworkFixture(),
      draft = trafficCountDraft(trafficCountFixture().counts[0]);
    expect(draft.laneCoverage).toBe("all");
    const fresh = trafficCountDraft({
      ...draft.count,
      target: null,
      mapping: undefined,
    });
    expect(fresh.laneCoverage).toBe("unknown");
    const changed = changeTrafficCountTarget(draft, "edge", "top");
    expect(changed).toMatchObject({
      laneCoverage: "unknown",
      laneIds: [],
      positionPercent: "",
      mappingReviewed: false,
      mappingChanged: true,
    });
    changed.positionPercent = "40";
    changed.mappingReviewed = true;
    expect(() => readTrafficCountDraft(changed, network)).toThrow(
      "Choose whether",
    );
    changed.laneCoverage = "specific";
    changed.laneCoverageNetworkHash = network.manifest.networkFileSha256;
    expect(() => readTrafficCountDraft(changed, network)).toThrow(
      "at least one",
    );
    changed.laneIds = ["in_0"];
    expect(() => readTrafficCountDraft(changed, network)).toThrow("absent");
    changed.laneIds = ["top_0"];
    expect(readTrafficCountDraft(changed, network).count.target).toEqual({
      kind: "edge",
      edgeId: "top",
      positionFraction: 0.4,
      laneIds: ["top_0"],
    });
    changed.laneCoverage = "all";
    expect(() => readTrafficCountDraft(changed, network)).toThrow(
      "Clear specific",
    );
    changed.laneIds = [];
    expect(readTrafficCountDraft(changed, network).count.target).toEqual({
      kind: "edge",
      edgeId: "top",
      positionFraction: 0.4,
    });
    const retained = trafficCountDraft({
      ...draft.count,
      target: {
        kind: "edge",
        edgeId: "in",
        positionFraction: 0.5,
        laneIds: ["in_0"],
      },
    });
    expect(retained.laneCoverage).toBe("specific");
    expect(
      changeTrafficCountTarget(retained, "turn", "connection-0"),
    ).toMatchObject({
      laneCoverage: "unknown",
      laneIds: [],
      mappingReviewed: false,
    });
    expect(draft.laneCoverage).toBe("all");
    const stale = structuredClone(draft);
    stale.mappingChanged = true;
    stale.mappingReviewed = true;
    network.manifest.networkFileSha256 = "d".repeat(64);
    expect(() => readTrafficCountDraft(stale, network)).toThrow(
      "lane coverage against the current graph",
    );
    stale.laneCoverageNetworkHash = network.manifest.networkFileSha256;
    expect(
      readTrafficCountDraft(stale, network).review?.networkFileSha256,
    ).toBe(network.manifest.networkFileSha256);
  });

  it("preserves OD/path provenance and lets core topology reject a disconnected edited route", () => {
    const original = trafficDemandFixture(),
      before = structuredClone(original);
    const rows = demandDraft(original),
      routes = routeDraft(original);
    rows[0].vehicles = "0";
    const value = readDemandDraft(rows, original, routes);
    expect(value.rows[0].vehicles).toBe(0);
    expect(value.rows[0].sourceIds).toEqual(original.rows[0].sourceIds);
    routes[0].edgeText = "in\nout";
    expect(() =>
      validateTrafficDemand(
        readDemandDraft(rows, original, routes),
        trafficNetworkFixture(),
        trafficFixturePeriod,
      ),
    ).toThrow("connection");
    rows[0].vehicles = "";
    expect(() => readDemandDraft(rows, original, routes)).toThrow(
      "one-way vehicle trips",
    );
    expect(original).toEqual(before);
  });
  it("retains exact regional entry timing and native attachments through an unchanged demand edit", () => {
    const demand = trafficDemandFixture();
    demand.rows[0].beginSeconds += 12.123456789;
    demand.rows[0].endSeconds -= 5.876543211;
    demand.rows[0].endpoints = {
      departLaneId: "in_0",
      departPositionMeters: 15.25,
      arrivalLaneId: "out_0",
      arrivalPositionMeters: 62.5,
    };
    const draft = demandDraft(demand);
    expect(readDemandDraft(draft, demand, routeDraft(demand))).toEqual(demand);
    draft[0].begin = "08:00:30.125";
    expect(
      readDemandDraft(draft, demand, routeDraft(demand)).rows[0].beginSeconds,
    ).toBe(28830.125);
    draft[0].begin = "24:00:00.1";
    expect(() => readDemandDraft(draft, demand, routeDraft(demand))).toThrow(
      /between/,
    );
  });
});
