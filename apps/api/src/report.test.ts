import { beforeAll, describe, expect, it, vi } from "vitest";
import PDFDocument from "pdfkit";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { createProject, calculateImpact, buildingPreset } from "@urban/models";
import {
  applyBuildingGeometry,
  applyCommand,
  projectWithBuildingVersion,
  projectWithPresentationVersion,
  USER_BUILDING_SOURCE,
  USER_ACTIVITY_SOURCE,
  type ActivityScenario,
  type Place,
} from "@urban/core";
import {
  exportDocx,
  exportPdf,
  exportXlsx,
  exportGeoJson,
  type ReportSnapshot,
} from "./exports";
import { buildingReportItems } from "./report-buildings";
import { activityReportInventory } from "./report-activity";
import { presentationReportOutline } from "./report-presentation";
import {
  assumptionRows,
  assertReportSnapshot,
  decisionBrief,
  display,
  groupedMetrics,
} from "./report-content";
import { renderReportMapPair } from "./report-maps";

/** Inspect actual OOXML/PNG parts using ZIP's central directory; no extra test dependency. */
function unzip(buffer: Buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Missing ZIP directory");
  const result = new Map<string, Buffer>();
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(offset + 10),
      size = buffer.readUInt32LE(offset + 20),
      nameLength = buffer.readUInt16LE(offset + 28),
      extraLength = buffer.readUInt16LE(offset + 30),
      commentLength = buffer.readUInt16LE(offset + 32),
      local = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString();
    const start =
        local +
        30 +
        buffer.readUInt16LE(local + 26) +
        buffer.readUInt16LE(local + 28),
      data = buffer.subarray(start, start + size);
    result.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
let snapshot: ReportSnapshot;
beforeAll(async () => {
  const place: Place = {
    id: "report-qa",
    name: "Synthetic report QA",
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
    sources: [
      {
        id: "qa",
        name: "Synthetic source for report verification",
        url: "https://example.invalid/source",
        vintage: "QA only",
        license: "Synthetic fixture",
        kind: "user-supplied",
        description: "No observed conditions are asserted.",
      },
    ],
    coverage: [],
    loadedAt: "2026-11-05T00:00:00Z",
    extentLabel: "Synthetic test study area",
  };
  const project = createProject(place);
  const proposal = applyCommand(project.scenarios[1], {
    type: "building.upsert",
    building: buildingPreset("mixed-use", place.center),
  });
  proposal.description =
    "Full proposal notes retained through rendering. END NOTES.";
  proposal.assumptions.abatementPercent = 0.25;
  proposal.assumptions.fiscalInputsConfirmed = false;
  project.scenarios[1] = proposal;
  snapshot = {
    project,
    place,
    scenario: proposal,
    results: calculateImpact(place, proposal),
    generatedAt: "2026-11-05T00:00:00Z",
    projectVersion: 4,
    maps: await renderReportMapPair({
      place,
      baselineScenario: project.scenarios[0],
      proposalScenario: proposal,
    }),
  };
});

describe("saved staff report integrity and accessible structure", () => {
  it("keeps each methods domain with its first metric and introduction on the same native PDF page", async () => {
    const entries: { text: string; page: unknown }[] = [];
    const original = PDFDocument.prototype.text;
    const spy = vi
      .spyOn(PDFDocument.prototype, "text")
      .mockImplementation(function (
        this: PDFKit.PDFDocument,
        ...args: Parameters<typeof original>
      ) {
        entries.push({ text: String(args[0]), page: this.page });
        return original.apply(this, args);
      });
    try {
      await exportPdf(snapshot);
    } finally {
      spy.mockRestore();
    }
    let offset =
      entries.findIndex((entry) => entry.text === "Methods and limitations") +
      1;
    expect(offset).toBeGreaterThan(0);
    for (const group of groupedMetrics(snapshot)) {
      const domain = entries.findIndex(
        (entry, i) => i >= offset && entry.text === group.domain,
      );
      expect(domain).toBeGreaterThanOrEqual(offset);
      expect(entries[domain + 1].text).toBe(group.metrics[0].label);
      expect(entries[domain + 2].text).toContain("Geography:");
      expect(entries[domain + 1].page).toBe(entries[domain].page);
      expect(entries[domain + 2].page).toBe(entries[domain].page);
      offset = domain + 3;
    }
  });
  it("keeps authored presentation text and unavailable metric references in Word and typed workbook camera rows", async () => {
    const project = structuredClone(snapshot.project),
      prior = project.scenarios[1];
    const scenario = applyCommand(prior, {
      type: "scenario.presentation",
      presentation: {
        version: 1,
        title: "A council conversation",
        stops: [
          {
            id: "view-one",
            title: "Homes & public space",
            callout: "Authored <callout>, not a verified finding.",
            narration: "Ask what would make this place welcoming.",
            camera: {
              center: [-112.002, 33.001],
              zoom: 15.25,
              pitch: 45,
              bearing: -27,
            },
            view: "3d",
            metricIds: ["housing.units", "future.unavailable"],
          },
        ],
      },
    });
    project.scenarios[1] = scenario;
    const report: ReportSnapshot = {
      ...snapshot,
      project: projectWithPresentationVersion(project, snapshot.place),
      scenario,
      results: calculateImpact(snapshot.place, scenario),
      maps: undefined,
    };
    const outline = presentationReportOutline(report)!;
    expect(outline.stops[0].metricReferences).toEqual([
      "Homes [housing.units]",
      "future.unavailable — unavailable in this saved result bundle",
    ]);
    expect(outline.stops[0]).not.toHaveProperty("value");
    const xml = unzip(await exportDocx(report))
      .get("word/document.xml")!
      .toString()
      .replaceAll("\u200b", "");
    for (const text of [
      "Authored presentation outline",
      "A council conversation",
      "Homes &amp; public space",
      "Authored &lt;callout&gt;, not a verified finding.",
      "Ask what would make this place welcoming.",
      "future.unavailable",
      "unavailable in this saved result bundle",
      "not a model conclusion",
      "zoom 15.25",
    ])
      expect(xml).toContain(text);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Uint8Array.from(await exportXlsx(report)).buffer);
    const sheet = book.getWorksheet("Presentation")!;
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getCell("D2").value).toBe(
      scenario.presentation!.stops[0].callout,
    );
    expect(sheet.getCell("E2").value).toBe(
      scenario.presentation!.stops[0].narration,
    );
    expect(sheet.getCell("G2").value).toBe(-112.002);
    expect(sheet.getCell("I2").value).toBe(15.25);
    expect(sheet.getCell("I2").type).toBe(ExcelJS.ValueType.Number);
    expect(sheet.getCell("M2").value).toContain(
      "unavailable in this saved result bundle",
    );
    expect(sheet.getCell("O2").value).toBe(scenario.revision);
    expect(presentationReportOutline(snapshot)).toBeNull();
  });
  it("exports exact component allocation, rate bases and evidence in Word and numeric workbook rows without double-counting", async () => {
    const building = applyBuildingGeometry(
      buildingPreset("healthcare", snapshot.place.center),
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-112.003, 32.998],
              [-112, 32.998],
              [-112, 33.001],
              [-112.003, 33.001],
              [-112.003, 32.998],
            ],
            [
              [-112.0025, 32.9985],
              [-112.001, 32.9985],
              [-112.001, 32.9995],
              [-112.0025, 32.9995],
              [-112.0025, 32.9985],
            ],
          ],
          [
            [
              [-111.999, 32.998],
              [-111.998, 32.998],
              [-111.998, 32.999],
              [-111.999, 32.999],
              [-111.999, 32.998],
            ],
          ],
        ],
      },
    );
    building.name = "Courtyard hospital & clinic";
    building.typology = "hospital";
    building.units = 0;
    building.jobs = 120;
    building.parkingSpaces = 70;
    building.programSourceId = USER_BUILDING_SOURCE.id;
    building.sourceFeatureId = "Hospital <external> 42";
    building.program = {
      version: 1,
      grossFloorAreaSqm: 5000,
      commonAreaSqm: 500,
      components: [
        {
          id: "care",
          name: "Care beds",
          use: "healthcare",
          grossFloorAreaSqm: 4500,
          units: 0,
          jobs: 120,
          beds: 45,
          sourceId: USER_BUILDING_SOURCE.id,
          tripRate: {
            value: 8,
            basis: "bed",
            sourceId: USER_BUILDING_SOURCE.id,
          },
          parkingRate: {
            value: 1.5,
            basis: "bed",
            sourceId: USER_BUILDING_SOURCE.id,
          },
        },
      ],
    };
    let project = createProject(snapshot.place);
    const scenario = applyCommand(project.scenarios[1], {
      type: "building.upsert",
      building,
      sources: [USER_BUILDING_SOURCE],
    });
    project.scenarios[1] = scenario;
    project = projectWithBuildingVersion(project, snapshot.place);
    const report: ReportSnapshot = {
      ...snapshot,
      project,
      scenario,
      results: calculateImpact(snapshot.place, scenario),
      maps: undefined,
    };
    const items = buildingReportItems(report);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      side: "Proposal",
      parts: 2,
      holes: 1,
      grossFloorAreaSqm: 5000,
      commonAreaSqm: 500,
      units: 0,
      jobs: 120,
      parkingSupply: 70,
    });
    expect(items[0].components[0].tripRate).toContain("8 per bed");
    expect(items[0].components[0].tripRate).toContain("User building proposal");
    expect(items[0].summary).toContain("does not depict floor-by-floor");
    const xml = unzip(await exportDocx(report))
      .get("word/document.xml")!
      .toString()
      .replaceAll("\u200b", "");
    for (const label of [
      "Building geometry and programs",
      "Courtyard hospital &amp; clinic",
      "Care beds",
      "8 per bed",
      "1.5 per bed",
      "45 beds",
      "Hospital &lt;external&gt; 42",
      "User building proposal",
    ])
      expect(xml).toContain(label);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Uint8Array.from(await exportXlsx(report)).buffer);
    const programs = book.getWorksheet("Building programs")!,
      components = book.getWorksheet("Building components")!;
    expect(programs.rowCount).toBe(2);
    expect(components.rowCount).toBe(2);
    expect(programs.getCell("F2").value).toBe(2);
    expect(programs.getCell("G2").value).toBe(1);
    expect(programs.getCell("I2").value).toBe(5000);
    expect(programs.getCell("J2").value).toBe(500);
    expect(programs.getCell("L2").value).toBe(120);
    expect(programs.getCell("M2").value).toBe(70);
    expect(components.getCell("G2").value).toBe(4500);
    expect(components.getCell("J2").value).toBe(45);
    expect(components.getCell("K2").value).toContain("8 per bed");
    expect(components.getCell("G2").type).toBe(ExcelJS.ValueType.Number);
    const legacy = new ExcelJS.Workbook();
    await legacy.xlsx.load(Uint8Array.from(await exportXlsx(snapshot)).buffer);
    expect(legacy.getWorksheet("Building programs")).toBeUndefined();
    expect(buildingReportItems(snapshot)).toEqual([]);
    const tooLarge = structuredClone(report);
    tooLarge.scenario.buildingEdits = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `b${index}`,
        { ...building, id: `b${index}` },
      ]),
    );
    expect(() => buildingReportItems(tooLarge)).toThrow("No rows were omitted");
  });
  it("distinguishes true zero, unavailable values and small real changes across report units", () => {
    expect(display(0, "ratio")).toBe("0");
    expect(display(-0, "ratio")).toBe("0");
    expect(display(null, "ratio")).toBe("Unavailable");
    expect(display(Number.NaN, "ratio")).toBe("Unavailable");
    expect(display(-0.047, "ratio")).toBe("-0.047");
    expect(display(-0.004, "m²/person")).toBe("-0.004");
    expect(display(0.000123, "%")).toBe("0.00012%");
    expect(display(-0.004, "$ / year")).toBe("-$0.004");
    expect(display(0, "USD")).toBe("$0");
    expect(display(1_200_000, "USD")).toBe("$1.2M");
  });
  it("embeds the exact baseline and proposal image bytes, alt descriptions, repeated table headers and real heading styles in Word", async () => {
    const parts = unzip(await exportDocx(snapshot));
    const images = [...parts].filter(([name]) =>
      /^word\/media\/.*\.png$/.test(name),
    );
    expect(images).toHaveLength(2);
    expect(images.map(([, data]) => sha(data)).sort()).toEqual(
      [snapshot.maps!.baseline.sha256, snapshot.maps!.proposal.sha256].sort(),
    );
    const xml = parts
      .get("word/document.xml")!
      .toString()
      .replaceAll("\u200b", "");
    for (const text of [
      "Decision brief",
      "Before the proposal",
      "After the proposal",
      "Full scorecard",
      "Recorded assumptions",
      "Frozen baseline",
      "Proposal notes",
      "END NOTES.",
      "Map input SHA-256:",
      snapshot.maps!.metadata.inputHash,
      "Property tax abatement share",
      "25%",
    ])
      expect(xml).toContain(text);
    expect(xml).toContain('w:val="Title"');
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('w:val="Heading3"');
    expect((xml.match(/<w:tblHeader/g) ?? []).length).toBeGreaterThan(8);
    expect(xml.match(/<wp:docPr[^>]*descr="[^"]+"/g) ?? []).toHaveLength(2);
    expect(parts.get("word/footer1.xml")!.toString()).toContain("NUMPAGES");
    expect(parts.get("word/_rels/document.xml.rels")!.toString()).toContain(
      "https://example.invalid/source",
    );
  });
  it("embeds two real raster maps in PDF and uses the same validated image hashes as Word", async () => {
    const pdf = await exportPdf(snapshot);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(
      (pdf.toString("latin1").match(/\/Subtype \/Image/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(pdf.includes(Buffer.from("/Width 1400")), "native map width").toBe(
      true,
    );
    expect(pdf.includes(Buffer.from("/Height 900")), "native map height").toBe(
      true,
    );
    expect(/DejaVuSans/.test(pdf.toString("latin1"))).toBe(true);
  });
  it("exports saved activity targets, holes, sources and nullable vehicle baselines without relabeling them observed counts", async () => {
    const activity: ActivityScenario = {
      version: 1,
      reference: {
        population: {
          kind: "entered",
          value: 1000,
          sourceId: USER_ACTIVITY_SOURCE.id,
          asOfYear: 2024,
          universe: "Synthetic residents",
        },
        employment: {
          kind: "entered",
          value: 200,
          sourceId: USER_ACTIVITY_SOURCE.id,
          asOfYear: 2024,
          universe: "Synthetic workplace jobs",
        },
      },
      allocation: { population: "uniform-area", employment: "uniform-area" },
      global: {
        population: { mode: "baseline-percent", percent: 125 },
        householdVehicles: { mode: "absolute", value: 300 },
      },
      neighborhoods: [
        {
          id: "courtyard",
          name: "Courtyard <allocation>",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-112.008, 32.992],
                [-112.002, 32.992],
                [-112.002, 32.998],
                [-112.008, 32.998],
                [-112.008, 32.992],
              ],
              [
                [-112.006, 32.994],
                [-112.004, 32.994],
                [-112.004, 32.996],
                [-112.006, 32.996],
                [-112.006, 32.994],
              ],
            ],
          },
          population: { mode: "absolute", value: 50 },
          employment: { mode: "absolute", value: 0 },
          sourceId: USER_ACTIVITY_SOURCE.id,
        },
      ],
      demandResponse: {
        population: "none",
        employment: "none",
        vehicles: "none",
        reviewed: false,
        sourceId: USER_ACTIVITY_SOURCE.id,
      },
    };
    const scenario = {
      ...snapshot.scenario,
      activity,
      revision: snapshot.scenario.revision + 1,
    };
    const current = {
      ...snapshot,
      maps: undefined,
      scenario,
      results: calculateImpact(snapshot.place, scenario),
    };
    const inventory = activityReportInventory(current)!;
    expect(
      inventory.controls.find(
        (row) => row.dimension === "Household vehicles available",
      ),
    ).toMatchObject({
      reference: null,
      baseline: null,
      scenario: 300,
      delta: null,
    });
    expect(inventory.areas[0]).toMatchObject({
      id: "courtyard",
      population: 50,
      employment: 0,
    });
    const geo = exportGeoJson(current);
    expect(geo.metadata.activity).toEqual(activity);
    expect(geo.features.find((row) => row.id === "courtyard")).toMatchObject({
      geometry: activity.neighborhoods[0].geometry,
      properties: {
        featureType: "activity-neighborhood",
        scenarioRevision: scenario.revision,
      },
    });
    expect(
      geo.metadata.sources.some((s) => s.id === USER_ACTIVITY_SOURCE.id),
    ).toBe(true);
    const docx = unzip(await exportDocx(current))
      .get("word/document.xml")!
      .toString()
      .replaceAll("\u200b", "");
    expect(docx).toContain("Population, employment and vehicles");
    expect(docx).toContain("Courtyard &lt;allocation&gt;");
    expect(docx).toContain("125% of captured year-zero reference");
    expect(docx).toContain("Unavailable");
    expect(docx).toContain(USER_ACTIVITY_SOURCE.id);
    expect(docx).toContain("not observed neighborhood counts");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportXlsx(current)) as never);
    const controls = book.getWorksheet("Activity controls")!;
    expect(controls.getRow(4).getCell(3).value).toBeNull();
    expect(controls.getRow(4).getCell(7).value).toBe(300);
    expect(
      book.getWorksheet("Activity areas")!.getRow(2).getCell(11).value,
    ).toBe(0);
    expect(book.getWorksheet("Activity evidence")!.rowCount).toBeGreaterThan(5);
    const plain = new ExcelJS.Workbook();
    await plain.xlsx.load((await exportXlsx(snapshot)) as never);
    expect(plain.getWorksheet("Activity controls")).toBeUndefined();
  });
  it("rejects stale results, mismatched baseline content, same-revision changed inputs, and substituted pixels", async () => {
    expect(() =>
      assertReportSnapshot({
        ...snapshot,
        results: { ...snapshot.results, revision: 99 },
      }),
    ).toThrow("saved scenario revision");
    expect(() =>
      assertReportSnapshot({
        ...snapshot,
        place: { ...snapshot.place, extentLabel: "Another boundary snapshot" },
      }),
    ).toThrow("map inputs");
    expect(() =>
      assertReportSnapshot({
        ...snapshot,
        scenario: {
          ...snapshot.scenario,
          description: "Changed at same revision",
        },
      }),
    ).toThrow("map inputs");
    expect(() =>
      assertReportSnapshot({
        ...snapshot,
        maps: {
          ...snapshot.maps!,
          baseline: { ...snapshot.maps!.baseline, revision: 8 },
        },
      }),
    ).toThrow("scenario and baseline");
    await expect(
      exportPdf({
        ...snapshot,
        maps: {
          ...snapshot.maps!,
          proposal: {
            ...snapshot.maps!.proposal,
            png: snapshot.maps!.baseline.png,
          },
        },
      }),
    ).rejects.toThrow("declared hash");
  });
  it("labels fractional assumptions in percent, retains separate frozen coefficients and does not invent approval recommendations", () => {
    const abatement = assumptionRows(snapshot).find(
      (row) => row.key === "abatementPercent",
    )!;
    expect(abatement).toMatchObject({
      label: "Property tax abatement share",
      baseline: "0%",
      proposal: "25%",
      changed: true,
    });
    expect(
      assumptionRows(snapshot).find(
        (row) => row.key === "fiscalInputsConfirmed",
      )?.proposal,
    ).toBe("No");
    const brief = decisionBrief(snapshot).join(" ");
    expect(brief).toContain("limited or unavailable inputs");
    expect(brief).toContain("not an approval recommendation");
  });
  it("retains long user notes, source names and URLs without truncation in the editable document", async () => {
    const long = {
      ...snapshot,
      maps: undefined,
      scenario: {
        ...snapshot.scenario,
        description: "Long proposal detail. ".repeat(450) + "END LONG PROPOSAL",
        sources: [
          {
            ...snapshot.place.sources[0],
            id: "long",
            name: "Source title ".repeat(20) + "END TITLE",
            url:
              "https://example.invalid/" +
              "path-segment/".repeat(125) +
              "END-URL",
            description: "Coverage note. ".repeat(150) + "END SOURCE",
          },
        ],
      },
    };
    const xml = unzip(await exportDocx(long))
      .get("word/document.xml")!
      .toString()
      .replaceAll("\u200b", "");
    expect(xml).toContain("END LONG PROPOSAL");
    expect(xml).toContain("END TITLE");
    expect(xml).toContain("END-URL");
    expect(xml).toContain("END SOURCE");
    expect(xml).toContain("Comparison images are unavailable");
  });
});
