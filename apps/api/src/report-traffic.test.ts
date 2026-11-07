import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import {
  applyCommand,
  reviewTrafficPlanningRoads,
  trafficRoadEditsHash,
  projectWithTrafficVersion,
  trafficContentHash,
  trafficSignalProgramHash,
  applyTrafficSignalTiming,
  TRAFFIC_SIGNAL_SCOPE_NOTES,
  type TrafficScenario,
  trafficPairRecipeHash,
} from "@urban/core";
import { trafficCommuteEvidenceFixture } from "../../../packages/models/src/traffic-commute-evidence-fixture";
import { trafficNetworkFixture } from "../../../packages/core/src/traffic-fixture";
import { planningProposalMetadata } from "./traffic/planning-review";
import { calculateImpact } from "@urban/models";
import { trafficScenarioFixture } from "../../../tests/fixtures/traffic";
import {
  exportCsv,
  exportTrafficCsv,
  exportXlsx,
  exportPdf,
  exportDocx,
  exportGeoJson,
  type ReportSnapshot,
} from "./exports";
import {
  trafficReportInventory,
  assertTrafficDocumentLimit,
} from "./report-traffic";
import { reportPlanningSources, reportSources } from "./report-content";
import {
  trafficHTML,
  trafficExportStatus,
  exportTrafficCSV,
} from "../../web/src/lib/traffic-export";
import { download } from "../../web/src/lib/api";
vi.mock("../../web/src/lib/api", () => ({ download: vi.fn() }));
import { reportHTML, exportGeoJSON } from "../../web/src/lib/exports";

async function fixture(): Promise<ReportSnapshot> {
  const f = await trafficScenarioFixture();
  f.traffic.origin = "imported";
  f.traffic.capture.calibration = null;
  f.traffic.capture.countEvidence.selectionHash = null;
  f.traffic.captureHash = await trafficContentHash(f.traffic.capture);
  const scenario = applyCommand(f.scenario, {
    type: "scenario.traffic",
    traffic: f.traffic,
  });
  f.project.scenarios[1] = scenario;
  return {
    place: f.place,
    project: projectWithTrafficVersion(f.project, f.place),
    scenario,
    results: calculateImpact(f.place, scenario),
    generatedAt: "2026-11-06T00:00:00Z",
  };
}
const decode = (csv: string) =>
  csv
    .replace(/^\uFEFF/, "")
    .trim()
    .split("\r\n")
    .map((row) =>
      Array.from(row.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), (m) =>
        m[1].replaceAll('""', '"'),
      ),
    );
function docXml(buffer: Buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("ZIP directory absent");
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const length = buffer.readUInt16LE(offset + 28),
      name = buffer.subarray(offset + 46, offset + 46 + length).toString(),
      local = buffer.readUInt32LE(offset + 42),
      size = buffer.readUInt32LE(offset + 20),
      method = buffer.readUInt16LE(offset + 10);
    if (name === "word/document.xml") {
      const start =
          local +
          30 +
          buffer.readUInt16LE(local + 26) +
          buffer.readUInt16LE(local + 28),
        data = buffer.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data)
        .toString()
        .replaceAll("\u200b", "");
    }
    offset +=
      46 +
      length +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
  throw new Error("Word document absent");
}
describe("saved traffic report and export fidelity", () => {
  it("preserves unknown source totals, unresolved route mass and rounded-only native counts across commute exports", async () => {
    const snapshot = await fixture(),
      evidence = snapshot.scenario.traffic!;
    const f = await trafficCommuteEvidenceFixture({
      changePack(pack) {
        pack.tracts[0].cells.B08132_022.estimate = {
          status: "suppressed",
          value: null,
          raw: "-666666666",
          annotation: "**",
        };
      },
      changeRoutes(routes) {
        routes.attachments[0].status = "unmatched-local-network";
        routes.attachments[0].local = null;
      },
    });
    const { summary } = f,
      n = summary.totals.vehicles;
    evidence.capture.originalDemand = {
      hash: f.binding.demandHash,
      vehicleCount: n,
      description: "Synthetic source-derived partial cohort",
      sourceIds: summary.sources.map((s) => s.id),
      commute: summary,
    };
    evidence.capture.recipe.demandHash = f.binding.demandHash;
    evidence.capture.recipe.baselineNetworkHash = f.binding.networkHash;
    evidence.capture.recipe.period = structuredClone(f.prior.recipe.period);
    evidence.capture.network.baselineFileSha256 = f.binding.networkHash;
    evidence.capture.comparison.recipeHash = await trafficPairRecipeHash(
      evidence.capture.recipe,
    );
    for (const side of ["baseline", "proposal"] as const) {
      Object.assign(evidence.capture.runs[side].diagnostics, {
        requested: n,
        loaded: n,
        inserted: n,
        arrived: n,
      });
      Object.assign(evidence.capture.comparison[side], {
        requested: n,
        completed: n,
      });
    }
    evidence.captureHash = await trafficContentHash(evidence.capture);
    const notes = trafficReportInventory(snapshot)!.notes.join(" ");
    expect(notes).toContain("Census commute subset: partial");
    expect(notes).toContain(
      "Source estimate Unavailable commuters; known source subtotal 20",
    );
    expect(notes).toContain(
      "unresolved source/destination 4; unresolved route 8",
    );
    expect(notes).toContain("1 of 2 selected native origin-destination pairs");
    expect(notes).toContain("not a whole-area or all-purpose traffic forecast");
    expect(notes).toContain(
      "excludes route, synthetic-source and model uncertainty",
    );
    expect(summary.totals.vehicles).toBe(8);
    const visibleHtml = trafficHTML(
      snapshot.scenario,
      await trafficExportStatus(snapshot.place, snapshot.scenario),
    ).split("<details>")[0];
    expect(visibleHtml).toContain("Census commute subset");
    expect(visibleHtml).toContain(
      "<td>Source estimate</td><td>Unavailable</td>",
    );
    expect(visibleHtml).toContain("<td>Known source subtotal</td><td>20</td>");
    expect(visibleHtml).toContain("<td>Unresolved local route</td><td>8</td>");
    expect(visibleHtml).toContain(
      "not establish a whole-area or all-purpose traffic forecast",
    );
    const [h, row] = decode(exportTrafficCsv(snapshot));
    expect(JSON.parse(row[h.indexOf("demand_json")]).commute).toEqual(summary);
    expect(exportGeoJson(snapshot).metadata.traffic).toEqual(evidence);
    const [browserHeaders, browserRow] = decode(
      await exportTrafficCSV(snapshot.place, snapshot.scenario),
    );
    expect(
      JSON.parse(browserRow[browserHeaders.indexOf("capture_json")]).capture
        .originalDemand.commute,
    ).toEqual(summary);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    const rows: string[] = [];
    workbook
      .getWorksheet("Traffic evidence")!
      .eachRow((r) => rows.push(String(r.getCell(3).value)));
    expect(rows.join(" ")).toContain("known source subtotal 20");
    expect(docXml(await exportDocx(snapshot))).toContain("unresolved route 8");
    // The public summary cannot re-prove private source/route hashes. It can and must
    // reject a recipe clock that no longer matches the retained binding, even rehashed.
    evidence.capture.originalDemand.commute!.binding.periodHash = "f".repeat(
      64,
    );
    evidence.captureHash = await trafficContentHash(evidence.capture);
    expect(() => exportTrafficCsv(snapshot)).toThrow(/does not match/);
    await expect(exportDocx(snapshot)).rejects.toThrow(/does not match/);
    await expect(
      exportTrafficCSV(snapshot.place, snapshot.scenario),
    ).rejects.toThrow(/clock/);
  });
  it("retains exact derived controls, exclusions and separate planning citations in reports and machine-readable exports", async () => {
    const snapshot = await fixture(),
      road = snapshot.place.roads[0];
    snapshot.scenario.roadEdits[road.id] = {
      ...road,
      speedMph: 35,
      signal: true,
    };
    const reviewed = await reviewTrafficPlanningRoads({
      place: snapshot.place,
      scenario: snapshot.scenario,
      network: trafficNetworkFixture(),
      reviews: [
        {
          roadId: road.id,
          properties: ["speed"],
          directions: [{ direction: "with-road", edgeIds: ["in"] }],
          extent: "partial-road",
          nativeExtensionAcknowledged: true,
          rationale:
            "Partial test extent keeps unsupported signal changes visible.",
        },
      ],
      reviewedBy: "reviewer",
      reviewedAt: "2026-11-06T10:00:00Z",
      sourceDeclarations: [
        {
          sourceId: road.sourceId,
          privateUseConfirmed: true,
          publicRedistribution: false,
          declaredBy: "reviewer",
          declaredAt: "2026-11-06T10:00:00Z",
        },
      ],
    });
    const traffic = snapshot.scenario.traffic!;
    traffic.binding.roadEditsHash = await trafficRoadEditsHash(
      snapshot.place,
      snapshot.scenario,
    );
    traffic.capture.proposal = {
      overlays: reviewed.overlays,
      planningRoadMapping: planningProposalMetadata(
        reviewed,
        snapshot.scenario,
      ),
    };
    traffic.captureHash = await trafficContentHash(traffic.capture);
    const inventory = trafficReportInventory(snapshot)!;
    expect(inventory.notes.join(" ")).toContain("signal (unsupported)");
    expect(inventory.notes.join(" ")).toContain("speed (partial-extent)");
    expect(inventory.notes.join(" ")).toContain(
      "Planning-correspondence source [separate namespace]",
    );
    expect(inventory.notes.join(" ")).toContain(
      "public redistribution not permitted",
    );
    expect(reportSources(snapshot).map((source) => source.name)).toContain(
      `${snapshot.place.sources[0].name} (traffic planning correspondence capture)`,
    );
    const [headers, first] = decode(exportTrafficCsv(snapshot));
    expect(
      JSON.parse(first[headers.indexOf("planning_correspondence_json")]),
    ).toEqual(reviewed.planningRoads);
    expect(JSON.parse(first[headers.indexOf("planning_sources_json")])).toEqual(
      snapshot.place.sources,
    );
    expect(exportGeoJson(snapshot).metadata.traffic).toEqual(traffic);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    const texts: string[] = [];
    workbook
      .getWorksheet("Traffic evidence")!
      .eachRow((row) => texts.push(String(row.getCell(3).value)));
    expect(texts.join(" ")).toContain("signal (unsupported)");
    const word = docXml(await exportDocx(snapshot));
    expect(word).toContain(
      "Planning-correspondence source [separate namespace]",
    );
    expect(word).toContain("signal (unsupported)");
  });

  it("retains exact authored signal timing and interpretation across report and data exports", async () => {
    const snapshot = await fixture();
    const evidence = snapshot.scenario.traffic!;
    const baseline = trafficNetworkFixture().signals[0];
    const control = {
      signalId: baseline.id,
      programId: baseline.programId,
      baselineProgramHash: await trafficSignalProgramHash(baseline),
      phaseDurationsSeconds: [45, 30],
      offsetSeconds: 5,
      rationale: "Test <green> timing with the original clearance retained.",
    };
    const captured = {
      control,
      baseline,
      proposal: applyTrafficSignalTiming(baseline, control),
    };
    evidence.capture.proposal.signalTimings = [captured];
    evidence.capture.notes.push(...TRAFFIC_SIGNAL_SCOPE_NOTES);
    evidence.captureHash = await trafficContentHash(evidence.capture);
    const before = canonical(evidence);
    const inventory = trafficReportInventory(snapshot)!;
    expect(inventory.signalTimingRows).toEqual([
      [baseline.id, `Program ${baseline.programId} · cycle`, "60", "75"],
      [baseline.id, "Offset", "0", "5"],
      [baseline.id, "Phase 1 · G", "30", "45"],
      [baseline.id, "Phase 2 · r", "30", "30"],
    ]);
    expect(inventory.notes.join(" ")).toContain(control.baselineProgramHash);
    expect(inventory.notes.join(" ")).toContain("engineering safety");
    const [headings, row] = decode(exportTrafficCsv(snapshot));
    expect(JSON.parse(row[headings.indexOf("signal_timings_json")])).toEqual([
      captured,
    ]);
    expect(
      JSON.parse(row[headings.indexOf("proposal_controls_and_mapping_json")])
        .signalTimings,
    ).toEqual([captured]);
    const browserRows = decode(
      await exportTrafficCSV(snapshot.place, snapshot.scenario),
    );
    expect(
      JSON.parse(browserRows[1][browserRows[0].indexOf("capture_json")]).capture
        .proposal.signalTimings,
    ).toEqual([captured]);
    const html = trafficHTML(snapshot.scenario, {
      stale: false,
      origin: "imported",
    });
    expect(html).toContain("Authored signal timing");
    expect(html).toContain("Test &lt;green&gt; timing");
    expect(html).toContain("<td>Phase 1 · G</td><td>30</td><td>45</td>");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    expect(
      workbook.getWorksheet("Signal timing")!.getRow(4).getCell(4).value,
    ).toBe(45);
    expect(
      exportGeoJson(snapshot).metadata.traffic?.capture.proposal.signalTimings,
    ).toEqual([captured]);
    const xml = docXml(await exportDocx(snapshot));
    expect(xml).toContain("Authored signal timing");
    expect(xml).toContain("Phase 1");
    expect(xml).toContain(control.baselineProgramHash);
    expect(canonical(evidence)).toBe(before);
    captured.control.baselineProgramHash = "f".repeat(64);
    evidence.captureHash = await trafficContentHash(evidence.capture);
    expect(() => exportTrafficCsv(snapshot)).toThrow(/does not match/);
    await expect(exportDocx(snapshot)).rejects.toThrow(/does not match/);
    await expect(
      exportTrafficCSV(snapshot.place, snapshot.scenario),
    ).rejects.toThrow(/hash/);
  });

  it("preserves exact paired numbers, separate source inventory and unassessed calibration without recomputation", async () => {
    const snapshot = await fixture(),
      before = canonical(snapshot.scenario.traffic);
    snapshot.place.sources[0].name = "Planning-only citation";
    // Rebind this synthetic fixture after changing its captured baseline, without changing its evidence sources.
    snapshot.scenario.traffic!.binding.baselineHash = await trafficContentHash(
      snapshot.place,
    );
    const inventory = trafficReportInventory(snapshot)!;
    expect(inventory.resultRows[0]).toEqual([
      "Mean travel time",
      "seconds",
      "40",
      "40",
      "0",
    ]);
    expect(inventory.calibrationRows).toEqual([]);
    expect(inventory.notes.join(" ")).toContain("Not assessed");
    expect(reportPlanningSources(snapshot)[0].name).toBe(
      "Planning-only citation",
    );
    expect(reportSources(snapshot).map((s) => s.name)).toContain(
      `${snapshot.scenario.traffic!.capture.sources[0].name} (traffic capture)`,
    );
    const [headers, ...rows] = decode(exportTrafficCsv(snapshot));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toHaveLength(headers.length);
      expect(row[headers.indexOf("calibration_status")]).toBe("not-assessed");
      expect(JSON.parse(row[headers.indexOf("source_files_json")])).toEqual(
        snapshot.scenario.traffic!.capture.files,
      );
      expect(JSON.parse(row[headers.indexOf("sources_json")])).toEqual(
        snapshot.scenario.traffic!.capture.sources,
      );
    }
    expect(rows[0][headers.indexOf("baseline")]).toBe("40");
    expect(rows[0][headers.indexOf("delta")]).toBe("0");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportXlsx(snapshot)) as unknown as ArrayBuffer,
    );
    expect(
      workbook.getWorksheet("Traffic outcomes")!.getRow(2).getCell(4).value,
    ).toBe(40);
    expect(
      workbook.getWorksheet("Traffic outcomes")!.getRow(2).getCell(9).value,
    ).toBe(0);
    const chunks: string[] = [];
    workbook.getWorksheet("Traffic evidence")!.eachRow((row) => {
      if (row.getCell(1).value === "Exact saved traffic JSON")
        chunks.push(String(row.getCell(3).value));
    });
    expect(JSON.parse(chunks.join(""))).toEqual(snapshot.scenario.traffic);
    expect(exportGeoJson(snapshot).metadata.traffic).toEqual(
      snapshot.scenario.traffic,
    );
    exportGeoJSON(snapshot.place, snapshot.scenario);
    expect(
      JSON.parse(String(vi.mocked(download).mock.calls.at(-1)![1])).metadata
        .traffic,
    ).toEqual(snapshot.scenario.traffic);
    expect(canonical(snapshot.scenario.traffic!.capture)).toBe(
      canonical(JSON.parse(before).capture),
    );
  });
  it("shows incomplete subtotals as censored and withholds full values and deltas in CSV, workbook and HTML", async () => {
    const s = await fixture(),
      e = s.scenario.traffic!;
    const p = e.capture.comparison.proposal;
    p.status = "incomplete";
    p.completed = 1;
    p.incomplete = 1;
    p.completionFraction = 0.5;
    p.measurementCompleted = 1;
    for (const key of [
      "meanTravelTimeSeconds",
      "meanTimeLossSeconds",
      "meanDepartureDelaySeconds",
      "vehicleKilometers",
      "vehicleHours",
    ] as const) {
      p[key] = null;
      e.capture.comparison.delta[key] = null;
    }
    e.capture.runs.proposal.diagnostics.arrived = 1;
    e.capture.runs.proposal.diagnostics.running = 1;
    e.captureHash = await trafficContentHash(e.capture);
    const [h, ...rows] = decode(exportTrafficCsv(s));
    expect(rows[0][h.indexOf("proposal")]).toBe("");
    expect(rows[0][h.indexOf("proposal_completed_subtotal")]).toBe("40");
    expect(rows[0][h.indexOf("delta")]).toBe("");
    const html = trafficHTML(
      s.scenario,
      await trafficExportStatus(s.place, s.scenario),
    );
    expect(html).toContain("censored");
    expect(html).toContain("Unavailable");
    expect(html).toContain("Not assessed");
    expect(html).toContain("not verified by this server");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportXlsx(s)) as unknown as ArrayBuffer);
    const row = book.getWorksheet("Traffic outcomes")!.getRow(2);
    expect(row.getCell(7).value).toBeNull();
    expect(row.getCell(8).value).toBe(40);
    expect(row.getCell(9).value).toBeNull();
  });
  it("detects changed and removed planning roads while unrelated horizon edits retain captured values", async () => {
    const s = await fixture(),
      before = exportTrafficCsv(s);
    s.scenario.horizon = 20;
    expect(trafficReportInventory(s)!.stale).toBe(false);
    expect(exportTrafficCsv(s)).toBe(before);
    s.scenario.roadEdits["planning-road"] = null;
    expect(trafficReportInventory(s)!.stale).toBe(true);
    const status = await trafficExportStatus(s.place, s.scenario);
    expect(status?.stale).toBe(true);
    expect(
      reportHTML(s.place, s.scenario, s.results, undefined, status),
    ).toContain("Stale for current planning roads");
    expect(trafficHTML(s.scenario)).toContain("freshness was not checked");
    const [h, ...rows] = decode(await exportTrafficCSV(s.place, s.scenario));
    expect(rows[0][h.indexOf("road_identity_stale")]).toBe("true");
    expect(JSON.parse(rows[0][h.indexOf("capture_json")])).toEqual(
      s.scenario.traffic,
    );
  });
  it("rejects forged evidence before native report creation and safely retains untrusted strings", async () => {
    const s = await fixture(),
      e = s.scenario.traffic!;
    e.capture.comparison.baseline.meanTravelTimeSeconds = 100;
    expect(() => exportTrafficCsv(s)).toThrow();
    await expect(exportDocx(s)).rejects.toThrow();
    e.capture.comparison.baseline.meanTravelTimeSeconds = 40;
    e.capture.notes.push('<script>alert("private")</script>');
    e.captureHash = await trafficContentHash(e.capture);
    s.scenario.id = "=untrusted";
    expect(exportTrafficCsv(s)).toContain('"\'=untrusted"');
    const html = trafficHTML(s.scenario);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("private")');
    e.capture.notes.push(
      ...Array.from({ length: 20 }, () =>
        "Retained long evidence. ".repeat(400),
      ),
    );
    e.captureHash = await trafficContentHash(e.capture);
    expect(() => assertTrafficDocumentLimit(s)).toThrow(/too large/);
    expect(exportTrafficCsv(s)).toContain("Retained long evidence");
  });
  it("places the traffic scope, imported status, exact diagnostics and provenance into native documents", async () => {
    const s = await fixture(),
      xml = docXml(await exportDocx(s));
    for (const phrase of [
      "Captured traffic experiment",
      "Imported evidence",
      "Not assessed",
      "Completed-cohort subtotal",
      "Calibration and declared holdout",
      "not a simulation of the entire planning scenario",
      s.scenario.traffic!.captureHash,
      s.scenario.traffic!.capture.privateArchive.sha256,
    ])
      expect(xml).toContain(phrase);
    expect(xml).not.toContain("private raw records");
    expect(xml).not.toContain("file://");
    expect((await exportPdf(s)).subarray(0, 5).toString()).toBe("%PDF-");
    const noTraffic = structuredClone(s);
    delete noTraffic.scenario.traffic;
    expect(exportCsv(s)).toBe(exportCsv(noTraffic));
  });
});
const canonical = (value: TrafficScenario | undefined | unknown) =>
  JSON.stringify(value);
