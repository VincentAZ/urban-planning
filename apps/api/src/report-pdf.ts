import {
  housingReportInventory,
  housingReportDisclosure,
  assertHousingDocumentLimit,
} from "./report-housing";
import {
  trafficReportInventory,
  trafficReportDisclosure,
  trafficSubtotalDisclosure,
  assertTrafficDocumentLimit,
} from "./report-traffic";
import {
  retailReportInventory,
  retailReportDisclosure,
  assertRetailDocumentLimit,
} from "./report-retail";
import {
  workforceReportInventory,
  workforceReportDisclosure,
  workforceUncertaintyDisclosure,
  assertWorkforceDocumentLimit,
} from "./report-workforce";
import {
  activityReportDisclosure,
  activityReportInventory,
} from "./report-activity";
import {
  buildingReportItems,
  buildingComponentTable,
} from "./report-buildings";
import {
  presentationReportDisclosure,
  presentationReportOutline,
} from "./report-presentation";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { MetricResult } from "@urban/core";
import type { ReportSnapshot } from "./exports";
import {
  accessibilityReportInventory,
  accessibilityReportDisclosure,
  accessibilityUncertaintyDisclosure,
  assertAccessibilityDocumentLimit,
} from "./report-accessibility";
import {
  floodReportInventory,
  floodReportDisclosure,
  floodUncertaintyDisclosure,
  assertFloodDocumentLimit,
} from "./report-flood";
import {
  assertReportSnapshot,
  assumptionRows,
  decisionBrief,
  display,
  displayChange,
  groupedMetrics,
  headlineIds,
  inputNotes,
  importSourceNotes,
  interpretation,
  mapCaption,
  reportDigest,
  reportSources,
  sourceReferences,
  statusLabel,
} from "./report-content";

const fonts = {
  regular: fileURLToPath(
    new URL("../assets/fonts/DejaVuSans.ttf", import.meta.url),
  ),
  bold: fileURLToPath(
    new URL("../assets/fonts/DejaVuSans-Bold.ttf", import.meta.url),
  ),
};
const clean = (text: string) =>
  text.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\u00a0/g, " ");

export async function renderStaffPdf(
  snapshot: ReportSnapshot,
): Promise<Buffer> {
  assertReportSnapshot(snapshot);
  assertFiscalDocumentLimit(snapshot);
  assertHousingDocumentLimit(snapshot);
  assertRetailDocumentLimit(snapshot);
  assertWorkforceDocumentLimit(snapshot);
  assertAccessibilityDocumentLimit(snapshot);
  assertFloodDocumentLimit(snapshot);
  assertTrafficDocumentLimit(snapshot);
  const buildingItems = buildingReportItems(snapshot);
  const presentation = presentationReportOutline(snapshot);
  const activity = activityReportInventory(snapshot);
  const fiscal = fiscalReportInventory(snapshot);
  const housing = housingReportInventory(snapshot);
  const retail = retailReportInventory(snapshot);
  const workforce = workforceReportInventory(snapshot);
  const accessibility = accessibilityReportInventory(snapshot);
  const flood = floodReportInventory(snapshot);
  const traffic = trafficReportInventory(snapshot);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 48, right: 48, bottom: 72, left: 48 },
      bufferPages: true,
      info: {
        Title: `${snapshot.project.name} - Scenario planning review`,
        Author: "Urban Planning",
        Subject: `${snapshot.scenario.name}, revision ${snapshot.scenario.revision}`,
        CreationDate: new Date(snapshot.generatedAt),
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("Report", fonts.regular);
    doc.registerFont("ReportBold", fonts.bold);
    const left = 48,
      width = 516,
      bottom = 716;
    const font = (size = 10, bold = false, color = "#263f36") =>
      doc
        .font(bold ? "ReportBold" : "Report")
        .fontSize(size)
        .fillColor(color);
    const room = (height: number) => {
      if (doc.y + height > bottom) doc.addPage();
    };
    const paragraph = (text: string, size = 10, color = "#35473f") => {
      font(size, false, color);
      const value = clean(text),
        height = doc.heightOfString(value, { width, lineGap: 2.5 });
      if (height < 240) room(height + 9);
      doc.text(value, left, doc.y, { width, lineGap: 2.5 });
      doc.y += size < 10 ? 6 : 9;
    };
    const heading = (text: string, size = 17, newPage = false) => {
      if (newPage) doc.addPage();
      room(size * 2 + 48);
      doc.y += 8;
      font(size, true, "#000000");
      doc.text(clean(text), left, doc.y, { width, lineGap: 2 });
      doc.y += 10;
    };
    const wrap = (
      value: string,
      available: number,
      size: number,
      bold: boolean,
    ) => {
      font(size, bold);
      const lines: string[] = [];
      for (const paragraph of clean(value).split("\n")) {
        let current = "";
        for (const word of paragraph.split(/\s+/)) {
          if (!word) continue;
          if (
            doc.widthOfString(current ? `${current} ${word}` : word) <=
            available
          ) {
            current = current ? `${current} ${word}` : word;
            continue;
          }
          if (current) {
            lines.push(current);
            current = "";
          }
          for (const character of word) {
            if (doc.widthOfString(current + character) > available && current) {
              lines.push(current);
              current = "";
            }
            current += character;
          }
        }
        lines.push(current);
      }
      return lines.length ? lines : [""];
    };
    const table = (
      headers: string[],
      rows: string[][],
      columns: number[],
      size = 8.5,
    ) => {
      const lineHeight = size * 1.45,
        padding = 8;
      const draw = (
        values: string[][],
        header: boolean,
        shaded: boolean,
        from = 0,
        count?: number,
      ) => {
        const n = count ?? Math.max(...values.map((value) => value.length)),
          height = n * lineHeight + padding * 2;
        let x = left;
        const y = doc.y;
        columns.forEach((column, i) => {
          doc
            .rect(x, y, column, height)
            .fillAndStroke(
              header ? "#33443e" : shaded ? "#f3f6ef" : "#ffffff",
              "#d9d9d9",
            );
          font(size, header, header ? "#ffffff" : "#263f36");
          values[i].slice(from, from + n).forEach((line, j) =>
            doc.text(line, x + padding, y + padding + j * lineHeight, {
              width: column - padding * 2,
              lineBreak: false,
            }),
          );
          x += column;
        });
        doc.y = y + height;
      };
      const headerLines = headers.map((value, i) =>
        wrap(value, columns[i] - padding * 2, size, true),
      );
      const headerHeight =
        Math.max(...headerLines.map((value) => value.length)) * lineHeight +
        padding * 2;
      room(headerHeight + 42);
      draw(headerLines, true, false);
      rows.forEach((row, index) => {
        const lines = row.map((value, i) =>
          wrap(value, columns[i] - padding * 2, size, false),
        );
        const total = Math.max(...lines.map((value) => value.length));
        if (
          total * lineHeight + padding * 2 <= bottom - 48 - headerHeight &&
          doc.y + total * lineHeight + padding * 2 > bottom
        ) {
          doc.addPage();
          draw(headerLines, true, false);
        }
        let from = 0;
        while (from < total) {
          let fit = Math.floor((bottom - doc.y - padding * 2) / lineHeight);
          if (fit < 1) {
            doc.addPage();
            draw(headerLines, true, false);
            fit = Math.floor((bottom - doc.y - padding * 2) / lineHeight);
          }
          const count = Math.min(total - from, fit);
          draw(lines, false, index % 2 === 0, from, count);
          from += count;
          if (from < total) {
            doc.addPage();
            draw(headerLines, true, false);
          }
        }
      });
      doc.y += 14;
    };
    const scorecard = (metrics: MetricResult[]) =>
      table(
        ["Measure", "Baseline", "Proposal", "Change", "Evidence"],
        metrics.map((metric) => [
          `${metric.label} (${metric.unit})`,
          display(metric.baseline, metric.unit),
          display(metric.value, metric.unit),
          displayChange(metric),
          statusLabel(metric.status),
        ]),
        [158, 89, 89, 89, 91],
      );
    try {
      font(9, true, "#345747");
      doc.text("URBAN PLANNING", left, doc.y, { characterSpacing: 1.6 });
      doc.y += 14;
      heading("Scenario planning review", 25);
      paragraph(snapshot.project.name, 15, "#000000");
      paragraph(
        `${snapshot.scenario.name} | Revision ${snapshot.scenario.revision}${snapshot.projectVersion === undefined ? "" : ` | Saved project version ${snapshot.projectVersion}`}`,
        11,
      );
      paragraph(
        `${snapshot.place.extentLabel}. ${snapshot.scenario.horizon === 0 ? "Current planning conditions" : `${snapshot.scenario.horizon}-year planning horizon`}. Report generated ${snapshot.generatedAt}.`,
        9,
      );
      heading("Decision brief", 16);
      decisionBrief(snapshot).forEach((value) => paragraph(value));
      heading("Priority scorecard", 14);
      scorecard(
        headlineIds.flatMap((id) =>
          snapshot.results.metrics.filter((metric) => metric.id === id),
        ),
      );
      if (snapshot.maps) {
        for (const side of ["baseline", "proposal"] as const) {
          heading(
            side === "baseline" ? "Before the proposal" : "After the proposal",
            22,
            true,
          );
          paragraph(mapCaption(snapshot, side), 10);
          const height =
            (width * snapshot.maps.metadata.height) /
            snapshot.maps.metadata.width;
          room(height + 12);
          const imageY = doc.y;
          doc.image(snapshot.maps[side].png, left, imageY, { width });
          doc.y = imageY + height + 14;
          if (side === "proposal") {
            const changes = snapshot.maps.metadata.changes;
            paragraph(
              `Mapped changes: buildings ${changes.buildings.added} added, ${changes.buildings.modified} modified, ${changes.buildings.removed} removed; roads ${changes.roads.added} added, ${changes.roads.modified} modified, ${changes.roads.removed} removed.${changes.parcels && changes.blocks ? ` Parcels ${changes.parcels.added} added, ${changes.parcels.modified} modified, ${changes.parcels.removed} removed; blocks ${changes.blocks.added} added, ${changes.blocks.modified} modified, ${changes.blocks.removed} removed. Boundaries are planning references, not verified title or subdivision approval.` : ""}`,
              9,
            );
          }
          paragraph(
            `Analytical study area: ${snapshot.place.extentLabel}. Captured ${snapshot.place.loadedAt}. Renderer ${snapshot.maps.metadata.rendererVersion}; ${snapshot.maps.metadata.projection.kind.replaceAll("-", " ")} projection.`,
            9,
          );
          paragraph(`Figure SHA-256: ${snapshot.maps[side].sha256}`, 8);
        }
      } else {
        heading("Before and after views", 18, true);
        paragraph(
          "Comparison images are unavailable for this report input. No screenshot has been substituted. The scorecard and methods below still describe the specified model revision.",
        );
      }
      if (snapshot.scenario.description) {
        heading("Proposal notes", 14);
        for (const block of snapshot.scenario.description.split(
          /\r?\n\s*\r?\n/,
        ))
          if (block.trim()) paragraph(block);
      }
      heading("Full scorecard", 22, true);
      paragraph(interpretation);
      for (const group of groupedMetrics(snapshot)) {
        const first = group.metrics[0];
        if (first) {
          font(14, true);
          const titleHeight =
            18 + doc.heightOfString(clean(group.domain), { width, lineGap: 2 });
          const columns = [158, 89, 89, 89, 91],
            size = 8.5,
            lineHeight = size * 1.45;
          const headerHeight =
            Math.max(
              ...["Measure", "Baseline", "Proposal", "Change", "Evidence"].map(
                (text, i) => wrap(text, columns[i] - 16, size, true).length,
              ),
            ) *
              lineHeight +
            16;
          const firstHeight =
            Math.max(
              ...[
                `${first.label} (${first.unit})`,
                display(first.baseline, first.unit),
                display(first.value, first.unit),
                displayChange(first),
                statusLabel(first.status),
              ].map(
                (text, i) => wrap(text, columns[i] - 16, size, false).length,
              ),
            ) *
              lineHeight +
            16;
          room(titleHeight + headerHeight + Math.max(42, firstHeight));
        }
        heading(group.domain, 14);
        scorecard(group.metrics);
      }
      heading("Methods and limitations", 22, doc.y > bottom - 240);
      paragraph(
        "The baseline uses frozen baseline assumptions. The proposal uses its own recorded assumptions. Neither geometry-derived dwelling capacity nor mapped jobs should be read as an observed Census total. All amounts and changes below belong to this saved scenario revision.",
      );
      snapshot.results.warnings.forEach((warning) => paragraph(warning, 9));
      for (const group of groupedMetrics(snapshot)) {
        // Keep a domain with its first metric and method introduction. Each
        // heading's own lookahead cannot protect a preceding domain heading.
        const firstMetric = group.metrics[0];
        if (firstMetric) {
          font(17, true);
          const domainHeight =
            18 + doc.heightOfString(clean(group.domain), { width, lineGap: 2 });
          font(12, true);
          const metricHeight =
            18 +
            doc.heightOfString(clean(firstMetric.label), { width, lineGap: 2 });
          font(9);
          const introductionHeight = doc.heightOfString(
            clean(
              `${statusLabel(firstMetric.status)}. ${firstMetric.method}, version ${firstMetric.methodVersion}. Geography: ${firstMetric.geography}.`,
            ),
            { width, lineGap: 2.5 },
          );
          room(
            Math.max(
              82,
              domainHeight +
                Math.max(72, metricHeight + introductionHeight + 9),
            ),
          );
        }
        heading(group.domain, 17);
        for (const metric of group.metrics) {
          heading(metric.label, 12);
          paragraph(
            `${statusLabel(metric.status)}. ${metric.method}, version ${metric.methodVersion}. Geography: ${metric.geography}.`,
            9,
          );
          paragraph(`Calculation: ${metric.formula}`, 9);
          paragraph(metric.explanation, 10);
          if (metric.caveat) paragraph(`Limitation: ${metric.caveat}`, 9);
          if (metric.low !== undefined || metric.high !== undefined)
            paragraph(
              `Supplied sensitivity range: ${metric.low === undefined ? "not supplied" : display(metric.low, metric.unit)} to ${metric.high === undefined ? "not supplied" : display(metric.high, metric.unit)}. This is not a statistical confidence interval unless the method explicitly says so.`,
              9,
            );
          inputNotes(metric).forEach((note) => paragraph(note, 8.5));
          paragraph(sourceReferences(snapshot, metric), 8.5);
        }
      }
      heading("Recorded assumptions", 22, doc.y > 180);
      paragraph(
        "These are editable planning coefficients, not automatically verified local observations. Confirmation flags record a user action, not external validation. The baseline column remains frozen when proposal assumptions change.",
      );
      const assumptions = assumptionRows(snapshot);
      for (const group of new Set(assumptions.map((row) => row.group))) {
        heading(group, 14);
        table(
          ["Assumption", "Frozen baseline", "Proposal"],
          assumptions
            .filter((row) => row.group === group)
            .map((row) => [
              row.label + (row.changed ? " (changed)" : ""),
              row.baseline,
              row.proposal,
            ]),
          [260, 128, 128],
          9,
        );
      }
      paragraph(
        buildingItems.length
          ? "Employment density coefficients are recorded for transparency. Existing building jobs are retained from building records; changing a coefficient does not silently rewrite those records. Legacy mixed use combines residential trip rates with retail rates on its assumed commercial floor area; explicit programs use their recorded component allocations and rate bases."
          : "Employment density coefficients are recorded for transparency. Existing building jobs are retained from building records; changing a coefficient does not silently rewrite those records. Mixed use combines residential trip rates with retail rates on its commercial floor area.",
        9,
      );
      if (buildingItems.length) {
        heading("Building geometry and programs", 22, true);
        paragraph(
          "This inventory records explicit building authoring data for the frozen baseline and proposal separately. Component floor area plus common area equals the declared total. Homes and jobs are counted from components once. Rates are planning inputs, not automatically verified observations.",
        );
        for (const item of buildingItems) {
          heading(`${item.side}: ${item.name}`, 14);
          paragraph(`${item.typology}. ${item.summary}`, 9);
          if (item.components.length)
            table(
              [
                "Component / use",
                "Floor area m²",
                "Homes / jobs / beds",
                "Trip and parking rates",
              ],
              buildingComponentTable(item),
              [130, 80, 100, 206],
              8.5,
            );
          item.attributeDetails.forEach((note) => paragraph(note, 8.5));
          paragraph(
            `Sources: ${item.sources}. Source feature reference: ${item.sourceFeatureId}. Building ID: ${item.id}.`,
            8.5,
          );
        }
      }
      if (activity) {
        heading("Population, employment and vehicles", 22, true);
        paragraph(activityReportDisclosure, 9);
        table(
          [
            "Count",
            "Authored target",
            "Captured reference",
            "Horizon baseline / scenario",
            "Allocation",
          ],
          activity.controlRows,
          [80, 95, 135, 96, 110],
          8.5,
        );
        activity.notes.forEach((note) => paragraph(note, 9));
        if (activity.areas.length) {
          heading("Neighborhood allocation inventory", 17);
          table(
            [
              "Area",
              "Population target",
              "Population result",
              "Employment target",
              "Employment result",
            ],
            activity.areaRows,
            [115, 110, 90, 110, 91],
            8.5,
          );
          activity.areas.forEach((area) =>
            paragraph(
              `${area.name}. ID ${area.id}; ${area.areaSqm.toLocaleString("en-US", { maximumFractionDigits: 2 })} m²; source ${area.sourceId}. ${area.description}`,
              8.5,
            ),
          );
        }
      }
      if (housing) {
        heading("Housing affordability", 22, true);
        paragraph(housingReportDisclosure, 9);
        heading("Homes within each income ceiling", 17);
        table(
          [
            "Income ceiling",
            "Baseline",
            "Proposal",
            "Change",
            "Known subtotal baseline / proposal",
          ],
          housing.summaryRows,
          [160, 75, 75, 75, 131],
          8.5,
        );
        paragraph(
          "Cumulative counts overlap; do not add them. Known subtotals describe only the evaluated homes and are not complete totals.",
          9,
        );
        heading("Lowest affordable income ceiling", 17);
        table(
          [
            "Exclusive band",
            "Baseline",
            "Proposal",
            "Known subtotal baseline / proposal",
          ],
          housing.bandRows,
          [205, 80, 80, 151],
          8.5,
        );
        room(170);
        heading("Completeness of the comparison", 17);
        table(
          [
            "Side",
            "Total homes",
            "Evaluated",
            "Unassigned",
            "Unresolved assigned",
            "Buildings with unknown units",
          ],
          housing.coverageRows,
          [75, 75, 75, 85, 95, 111],
          8,
        );
        housing.context.forEach((note) => paragraph(note, 9));
        for (const panel of housing.panels) {
          heading(panel.title, 17, true);
          panel.context.forEach((note) => paragraph(note, 9));
          table(
            ["Cost component", "Monthly USD or inclusion"],
            panel.costRows.map((row) => row.slice(0, 2)),
            [235, 281],
            9,
          );
          heading("Cost evidence", 14);
          panel.costRows.forEach((row) => paragraph(`${row[0]}: ${row[2]}`, 9));
          table(
            ["Published ceiling", "Annual USD", "Cost comparison"],
            panel.thresholdRows,
            [220, 130, 166],
            9,
          );
        }
        heading("Housing evidence and income limits", 17, true);
        for (const evidence of housing.evidence) {
          heading(evidence.title, 14);
          table(
            [
              "Household size",
              "Extremely low income",
              "Very low income",
              "Low income",
            ],
            evidence.rows,
            [100, 150, 133, 133],
            8.5,
          );
          evidence.notes.forEach((note) => paragraph(note, 8.5));
        }
      }
      if (fiscal) {
        heading("Fiscal study and incentive comparison", 22, true);
        paragraph(fiscalReportDisclosure, 9);
        paragraph(fiscalClockDisclosure, 9);
        paragraph(
          `${fiscal.profile.name}; ${fiscal.profile.jurisdiction.name}. Fiscal year ${fiscal.profile.fiscalYear}; constant ${fiscal.profile.dollarYear} USD. Result ${fiscal.resolution.status}; review ${fiscal.resolution.reviewState}.`,
          9,
        );
        heading("Twenty year incremental outcomes", 17);
        table(
          [
            "Case",
            "Net without offer",
            "Net with offer",
            "NPV with offer",
            "Payback",
          ],
          fiscal.summaryRows,
          [110, 101.5, 101.5, 101.5, 101.5],
        );
        paragraph(
          "All changes subtract the corresponding baseline. Totals include time zero and 20 operating years. Annual net figures follow; component ledgers and exact numeric inputs are retained in the fiscal CSV, workbook and complete project records.",
          9,
        );
        heading("Profile and current coefficients", 17);
        table(
          [
            "Parameter and units",
            "Profile",
            "Frozen baseline",
            "Current proposal",
          ],
          fiscal.parameterRows,
          [213, 101, 101, 101],
        );
        fiscal.parameterNotes.forEach((note) => paragraph(note, 9));
        for (const panel of fiscal.panels) {
          heading(`Fiscal case ${panel.name}`, 17, true);
          paragraph(panel.description, 10);
          panel.notes.forEach((note) => paragraph(note, 9));
          heading("Annual net cash flows in USD", 14);
          table(
            [
              "Year / fiscal year",
              "Baseline",
              "Without offer",
              "With offer",
              "With offer minus baseline",
            ],
            panel.annualRows,
            [88, 107, 107, 107, 107],
          );
          heading("Paired case coefficients", 14);
          table(
            ["Parameter and units", "Baseline", "Proposal"],
            panel.inputRows,
            [256, 130, 130],
          );
        }
        heading("Fiscal evidence and study lineage", 17, true);
        fiscal.context.forEach((note) => paragraph(note, 9));
      }
      if (retail) {
        heading("Retail category evidence and opportunity", 22, true);
        paragraph(retailReportDisclosure, 9);
        paragraph(retail.contextDescription, 9);
        table(
          [
            "Category",
            "Demand before / scenario",
            "Sales before / scenario",
            "Gap before / scenario",
            "Net new sales / remaining equivalent",
          ],
          retail.resultRows,
          [112, 100, 100, 100, 104],
          8.5,
        );
        heading("Annual capture calculation · USD", 17);
        table(
          [
            "Category",
            "Eligible gap",
            "Gross captured",
            "Displaced",
            "Net new sales",
          ],
          retail.captureRows,
          [140, 94, 94, 94, 94],
          8.5,
        );
        heading("Recorded category inputs", 17);
        table(
          [
            "Category",
            "Annual demand",
            "Annual sales / establishment benchmark",
            "Additional annual capacity / assumptions",
          ],
          retail.inputRows,
          [112, 135, 135, 134],
          8.5,
        );
        retail.notes.forEach((note) => paragraph(note, 9));
      }
      if (workforce) {
        heading("Workforce within reach of the site", 22, true);
        paragraph(workforceReportDisclosure, 9);
        paragraph(workforce.contextDescription, 9);
        paragraph(workforceUncertaintyDisclosure, 9);
        for (const panel of workforce.panels) {
          // Keep the panel title, population definition and first table row together.
          room(220);
          heading(panel.label, 17);
          paragraph(
            `${panel.universe}. Census table ${panel.table}. Counts are people; travel limits are cumulative, so do not add the 15, 30 and 45 minute rows.`,
            9,
          );
          table(
            [
              "Category",
              "Travel limit",
              "People",
              "90% sampling MOE",
              "Status",
            ],
            panel.rows,
            [173, 59, 97, 113, 74],
            8.5,
          );
        }
        room(180);
        heading("Workforce coverage and provenance", 17);
        table(
          ["Coverage diagnostic", "Recorded value"],
          workforce.diagnostics,
          [350, 166],
          9,
        );
        workforce.notes.forEach((note) => paragraph(note, 8.5));
      }
      for (const item of accessibility) {
        heading(
          `Jobs accessibility by ${item.mode === "car" ? "car" : "walking"}`,
          22,
          true,
        );
        paragraph(accessibilityReportDisclosure, 9);
        paragraph(item.contextDescription, 9);
        paragraph(accessibilityUncertaintyDisclosure, 9);
        for (const panel of item.panels) {
          room(180);
          heading(panel.label, 17);
          table(
            ["Category", "15 minutes", "30 minutes", "45 minutes"],
            panel.rows,
            [205, 103, 104, 104],
            8.5,
          );
        }
        room(180);
        heading("Jobs accessibility coverage and provenance", 17);
        table(
          ["Coverage diagnostic", "Recorded value"],
          item.diagnostics,
          [325, 191],
          9,
        );
        item.notes.forEach((note) => paragraph(note, 8.5));
      }
      if (flood) {
        heading("Mapped flood exposure", 22, true);
        paragraph(floodReportDisclosure, 9);
        paragraph(flood.contextDescription, 9);
        paragraph(floodUncertaintyDisclosure, 9);
        table(
          ["Exposure measure", "Baseline", "Proposal"],
          flood.summaryRows,
          [320, 98, 98],
          9,
        );
        room(180);
        heading("Retained flood classifications", 17);
        table(
          [
            "Source feature",
            "FEMA zone / subtype",
            "Classification",
            "Source citation",
          ],
          flood.zoneRows,
          [110, 185, 111, 110],
          8.5,
        );
        room(180);
        heading("Map dates and source coverage", 17);
        table(
          ["Record", "Source identifier", "Recorded date"],
          flood.mapDates,
          [165, 165, 186],
          8.5,
        );
        table(
          ["Coverage diagnostic", "Recorded value"],
          flood.diagnostics,
          [245, 271],
          8.5,
        );
        flood.notes.forEach((note) => paragraph(note, 8.5));
      }
      if (traffic) {
        heading("Captured traffic experiment", 22, true);
        paragraph(trafficReportDisclosure, 9);
        paragraph(traffic.contextDescription, 9);
        paragraph(traffic.freshness, 9);
        room(200);
        heading("Paired native outcomes", 17);
        table(
          ["Measure", "Unit", "Baseline", "Proposal", "Change"],
          traffic.resultRows,
          [170, 80, 89, 89, 88],
          9,
        );
        paragraph(trafficSubtotalDisclosure, 9);
        table(
          ["Completed-cohort subtotal", "Unit", "Baseline", "Proposal"],
          traffic.subtotalRows,
          [205, 91, 110, 110],
          9,
        );
        room(180);
        heading("Completion and accounting", 17);
        table(
          ["Cohort measure", "Baseline", "Proposal"],
          traffic.summaryRows,
          [296, 110, 110],
          9,
        );
        table(
          ["Native diagnostic", "Baseline", "Proposal"],
          traffic.diagnosticRows,
          [296, 110, 110],
          9,
        );
        room(200);
        heading("Calibration and declared holdout", 17);
        paragraph(
          traffic.capture.calibration
            ? "Observed baseline interval-count fit; this does not assess proposal predictions against observed future traffic."
            : "Not assessed. No baseline count-check plan was supplied.",
          9,
        );
        if (traffic.calibrationRows.length)
          table(
            [
              "Set",
              "Status",
              "Selected",
              "Evaluated",
              "Unknown",
              "Passed",
              "Pass share",
            ],
            traffic.calibrationRows,
            [110, 78, 65, 65, 65, 65, 68],
            8.5,
          );
        if (traffic.overlayRows.length) {
          room(180);
          heading("Explicit native edge controls", 17);
          table(
            ["Directed native edge", "Access", "Lanes", "Speed m/s"],
            traffic.overlayRows,
            [276, 80, 80, 80],
            9,
          );
        }
        if (traffic.signalTimingRows.length) {
          room(180);
          heading("Authored signal timing", 17);
          paragraph(
            "Exact recorded durations in seconds. Movement states, sequence and clearance phases are retained; these edits do not establish field-verified timings.",
            9,
          );
          table(
            ["Controller", "Program / phase", "Baseline s", "Proposal s"],
            traffic.signalTimingRows,
            [150, 206, 80, 80],
            8.5,
          );
        }
        room(180);
        heading("Traffic scope and retained provenance", 17);
        traffic.notes.forEach((note) => paragraph(note, 8.5));
      }
      if (presentation) {
        heading("Authored presentation outline", 22, true);
        paragraph(
          `${presentation.title}. Scenario ${presentation.scenarioId}, revision ${presentation.revision}.`,
        );
        paragraph(presentationReportDisclosure, 9);
        for (const stop of presentation.stops) {
          heading(`${stop.order}. ${stop.title}`, 14);
          paragraph(stop.callout);
          paragraph(`${stop.cameraDescription} Stop ID: ${stop.id}.`, 8.5);
          paragraph(
            `Metric references: ${stop.metricReferences.length ? stop.metricReferences.join("; ") : "None selected."}`,
            9,
          );
          if (stop.narration) {
            heading("Presenter narration text", 12);
            paragraph(stop.narration, 9);
          }
        }
      }
      heading("Sources and reproducibility", 22, doc.y > 180);
      paragraph(
        "Source numbering links methods to their evidence. Planning sources and separately retained evidence are listed together; fiscal and regional evidence retain their own applicability in the preceding appendices.",
      );
      for (const coverage of snapshot.place.coverage) {
        heading(`${coverage.layer} coverage`, 12);
        paragraph(`${coverage.status}. ${coverage.description}`, 9);
      }
      reportSources(snapshot).forEach((source, index) => {
        heading(`${index + 1} ${source.name}`, 12);
        paragraph(
          `Source ID: ${source.id}. Vintage: ${source.vintage}. Evidence: ${source.kind}. License: ${source.license}.`,
          9,
        );
        if (source.description) paragraph(source.description, 9);
        importSourceNotes(source).forEach((note) => paragraph(note, 8.5));
        if (source.url) paragraph(source.url, 8.5);
      });
      if (snapshot.maps) {
        heading("Comparison map provenance", 14, Boolean(fiscal || housing));
        snapshot.maps.metadata.notes.forEach((note) => paragraph(note, 9));
        paragraph(
          `Shared displayed extent west, south, east, north: ${snapshot.maps.metadata.extent.join(", ")}. Analytical study extent: ${snapshot.maps.metadata.studyAreaExtent.join(", ")}. Projection origin: ${snapshot.maps.metadata.projection.origin.join(", ")}. Scale: ${snapshot.maps.metadata.projection.metersPerPixel} meters per pixel.`,
          9,
        );
        paragraph(
          `Map baseline SHA-256: ${snapshot.maps.metadata.baselineHash}. Map input SHA-256: ${snapshot.maps.metadata.inputHash}.`,
          8.5,
        );
        snapshot.maps.metadata.credits.forEach((source) =>
          paragraph(
            `Map credit: ${source.name}; ${source.vintage}; ${source.license}. ${source.url}`,
            8.5,
          ),
        );
      }
      paragraph(
        `Project ${snapshot.project.id}. Scenario ${snapshot.scenario.id}, revision ${snapshot.scenario.revision}. Model ${snapshot.results.modelVersion}. Computed ${snapshot.results.computedAt}. Generated ${snapshot.generatedAt}.`,
        9,
      );
      paragraph(`Input SHA-256: ${reportDigest(snapshot)}`, 8.5);
      const pages = doc.bufferedPageRange();
      for (let page = pages.start; page < pages.start + pages.count; page++) {
        doc.switchToPage(page);
        doc
          .save()
          .moveTo(48, 738)
          .lineTo(564, 738)
          .strokeColor("#d9dfd4")
          .stroke()
          .restore();
        const margin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        font(8, false, "#57665d");
        doc.text(
          `Urban Planning | Revision ${snapshot.scenario.revision}`,
          48,
          748,
          { width: 360, lineBreak: false },
        );
        doc.text(`${page + 1} / ${pages.count}`, 440, 748, {
          width: 124,
          align: "right",
          lineBreak: false,
        });
        doc.page.margins.bottom = margin;
      }
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}
import {
  fiscalReportInventory,
  fiscalReportDisclosure,
  fiscalClockDisclosure,
  assertFiscalDocumentLimit,
} from "./report-fiscal";
