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
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
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

const contentWidth = 10320;
const breakable = (text: string) =>
  text.replace(/([^\s]{40})(?=[^\s])/g, "$1\u200b");
const borders = Object.fromEntries(
  ["top", "bottom", "left", "right", "insideHorizontal", "insideVertical"].map(
    (side) => [side, { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" }],
  ),
);
const paragraph = (text: string, secondary = false) =>
  new Paragraph({
    children: [
      new TextRun({
        text: breakable(text),
        size: secondary ? 19 : 22,
        color: secondary ? "4A5B51" : "263F36",
      }),
    ],
    spacing: { before: 60, after: secondary ? 60 : 100, line: 276 },
    widowControl: true,
  });
const heading = (text: string, level: 1 | 2 | 3 = 1, newPage = false) =>
  new Paragraph({
    text,
    heading:
      level === 1
        ? HeadingLevel.HEADING_1
        : level === 2
          ? HeadingLevel.HEADING_2
          : HeadingLevel.HEADING_3,
    pageBreakBefore: newPage,
    keepNext: true,
    spacing: { before: 220, after: 120 },
  });
const table = (headers: string[], rows: string[][], widths: number[]) => {
  const row = (values: string[], header: boolean, index: number) =>
    new TableRow({
      tableHeader: header,
      cantSplit: true,
      children: values.map(
        (text, column) =>
          new TableCell({
            width: { size: widths[column], type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            margins: { top: 110, bottom: 110, left: 120, right: 120 },
            shading: {
              fill: header ? "33443E" : index % 2 === 0 ? "F3F6EF" : "FFFFFF",
            },
            children: [
              new Paragraph({
                spacing: { after: 0, line: 240 },
                children: [
                  new TextRun({
                    text: breakable(text),
                    bold: header,
                    size: 18,
                    color: header ? "FFFFFF" : "263F36",
                  }),
                ],
              }),
            ],
          }),
      ),
    });
  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: widths,
    borders,
    rows: [
      row(headers, true, 0),
      ...rows.map((values, index) => row(values, false, index)),
    ],
  });
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
    [3160, 1780, 1780, 1780, 1820],
  );

export async function renderStaffDocx(
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
  const { project, place, scenario, results } = snapshot;
  const children: (Paragraph | Table)[] = [
    paragraph("URBAN PLANNING", true),
    new Paragraph({
      text: "Scenario planning review",
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({ text: project.name, style: "Subtitle" }),
    paragraph(
      `${scenario.name} | Revision ${scenario.revision}${snapshot.projectVersion === undefined ? "" : ` | Saved project version ${snapshot.projectVersion}`}`,
    ),
    paragraph(
      `${place.extentLabel}. ${scenario.horizon === 0 ? "Current planning conditions" : `${scenario.horizon}-year planning horizon`}. Generated ${snapshot.generatedAt}.`,
      true,
    ),
    heading("Decision brief"),
    ...decisionBrief(snapshot).map((text) => paragraph(text)),
    heading("Priority scorecard", 2),
    scorecard(
      headlineIds.flatMap((id) =>
        results.metrics.filter((metric) => metric.id === id),
      ),
    ),
  ];
  if (snapshot.maps) {
    for (const side of ["baseline", "proposal"] as const) {
      const panel = snapshot.maps[side];
      children.push(
        heading(
          side === "baseline" ? "Before the proposal" : "After the proposal",
          1,
          true,
        ),
        paragraph(mapCaption(snapshot, side)),
        new Paragraph({
          children: [
            new ImageRun({
              type: "png",
              data: panel.png,
              transformation: {
                width: 688,
                height:
                  (688 * snapshot.maps.metadata.height) /
                  snapshot.maps.metadata.width,
              },
              altText: {
                title:
                  side === "baseline"
                    ? "Baseline source geometry"
                    : "Saved proposal geometry",
                description: panel.alt,
                name: `${side}-revision-${panel.revision}`,
              },
            }),
          ],
          spacing: { after: 180 },
        }),
      );
      if (side === "proposal") {
        const changes = snapshot.maps.metadata.changes;
        children.push(
          paragraph(
            `Mapped changes: buildings ${changes.buildings.added} added, ${changes.buildings.modified} modified, ${changes.buildings.removed} removed; roads ${changes.roads.added} added, ${changes.roads.modified} modified, ${changes.roads.removed} removed.${changes.parcels && changes.blocks ? ` Parcels ${changes.parcels.added} added, ${changes.parcels.modified} modified, ${changes.parcels.removed} removed; blocks ${changes.blocks.added} added, ${changes.blocks.modified} modified, ${changes.blocks.removed} removed. Boundaries are planning references, not verified title or subdivision approval.` : ""}`,
            true,
          ),
        );
      }
      children.push(
        paragraph(
          `Analytical study area: ${place.extentLabel}. Captured ${place.loadedAt}. Renderer ${snapshot.maps.metadata.rendererVersion}; ${snapshot.maps.metadata.projection.kind.replaceAll("-", " ")} projection.`,
          true,
        ),
        paragraph(`Figure SHA-256: ${panel.sha256}`, true),
      );
    }
  } else
    children.push(
      heading("Before and after views", 1, true),
      paragraph(
        "Comparison images are unavailable for this report input. No screenshot has been substituted. The scorecard and methods below still describe the specified model revision.",
      ),
    );
  if (scenario.description)
    children.push(
      heading("Proposal notes", 2),
      paragraph(scenario.description),
    );
  children.push(heading("Full scorecard", 1, true), paragraph(interpretation));
  for (const group of groupedMetrics(snapshot))
    children.push(heading(group.domain, 2), scorecard(group.metrics));
  children.push(
    heading("Methods and limitations", 1),
    paragraph(
      "The baseline uses frozen baseline assumptions. The proposal uses its own recorded assumptions. Neither geometry-derived dwelling capacity nor mapped jobs should be read as an observed Census total. All amounts and changes below belong to this saved scenario revision.",
    ),
    ...results.warnings.map((warning) => paragraph(warning, true)),
  );
  for (const group of groupedMetrics(snapshot)) {
    children.push(heading(group.domain, 2));
    for (const metric of group.metrics) {
      children.push(
        heading(metric.label, 3),
        paragraph(
          `${statusLabel(metric.status)}. ${metric.method}, version ${metric.methodVersion}. Geography: ${metric.geography}.`,
          true,
        ),
        paragraph(`Calculation: ${metric.formula}`, true),
        paragraph(metric.explanation),
      );
      if (metric.caveat)
        children.push(paragraph(`Limitation: ${metric.caveat}`, true));
      if (metric.low !== undefined || metric.high !== undefined)
        children.push(
          paragraph(
            `Supplied sensitivity range: ${metric.low === undefined ? "not supplied" : display(metric.low, metric.unit)} to ${metric.high === undefined ? "not supplied" : display(metric.high, metric.unit)}. This is not a statistical confidence interval unless the method explicitly says so.`,
            true,
          ),
        );
      children.push(
        ...inputNotes(metric).map((note) => paragraph(note, true)),
        paragraph(sourceReferences(snapshot, metric), true),
      );
    }
  }
  children.push(
    heading("Recorded assumptions", 1),
    paragraph(
      "These are editable planning coefficients, not automatically verified local observations. Confirmation flags record a user action, not external validation. The baseline column remains frozen when proposal assumptions change.",
    ),
  );
  const assumptions = assumptionRows(snapshot);
  for (const group of new Set(assumptions.map((row) => row.group)))
    children.push(
      heading(group, 2),
      table(
        ["Assumption", "Frozen baseline", "Proposal"],
        assumptions
          .filter((row) => row.group === group)
          .map((row) => [
            row.label + (row.changed ? " (changed)" : ""),
            row.baseline,
            row.proposal,
          ]),
        [5200, 2560, 2560],
      ),
    );
  children.push(
    paragraph(
      buildingItems.length
        ? "Employment density coefficients are recorded for transparency. Existing building jobs are retained from building records; changing a coefficient does not silently rewrite those records. Legacy mixed use combines residential trip rates with retail rates on its assumed commercial floor area; explicit programs use their recorded component allocations and rate bases."
        : "Employment density coefficients are recorded for transparency. Existing building jobs are retained from building records; changing a coefficient does not silently rewrite those records. Mixed use combines residential trip rates with retail rates on its commercial floor area.",
      true,
    ),
  );
  if (buildingItems.length) {
    children.push(
      heading("Building geometry and programs", 1),
      paragraph(
        "This inventory records explicit building authoring data for the frozen baseline and proposal separately. Component floor area plus common area equals the declared total. Homes and jobs are counted from components once. Rates are planning inputs, not automatically verified observations.",
      ),
    );
    for (const item of buildingItems) {
      children.push(
        heading(`${item.side}: ${item.name}`, 2),
        paragraph(`${item.typology}. ${item.summary}`, true),
      );
      if (item.components.length)
        children.push(
          table(
            [
              "Component / use",
              "Floor area m²",
              "Homes / jobs / beds",
              "Trip and parking rates",
            ],
            buildingComponentTable(item),
            [2600, 1600, 2000, 4120],
          ),
        );
      children.push(
        ...item.attributeDetails.map((note) => paragraph(note, true)),
      );
      children.push(
        paragraph(
          `Sources: ${item.sources}. Source feature reference: ${item.sourceFeatureId}. Building ID: ${item.id}.`,
          true,
        ),
      );
    }
  }
  if (activity) {
    children.push(
      heading("Population, employment and vehicles", 1, true),
      paragraph(activityReportDisclosure, true),
      table(
        [
          "Count",
          "Authored target",
          "Captured reference",
          "Horizon baseline / scenario",
          "Allocation",
        ],
        activity.controlRows,
        [1600, 1900, 2700, 1920, 2200],
      ),
      ...activity.notes.map((note) => paragraph(note, true)),
    );
    if (activity.areas.length)
      children.push(
        heading("Neighborhood allocation inventory", 2),
        table(
          [
            "Area",
            "Population target",
            "Population result",
            "Employment target",
            "Employment result",
          ],
          activity.areaRows,
          [2300, 2200, 1800, 2200, 1820],
        ),
        ...activity.areas.map((area) =>
          paragraph(
            `${area.name}. ID ${area.id}; ${area.areaSqm.toLocaleString("en-US", { maximumFractionDigits: 2 })} m²; source ${area.sourceId}. ${area.description}`,
            true,
          ),
        ),
      );
  }
  if (housing) {
    children.push(
      heading("Housing affordability", 1, true),
      paragraph(housingReportDisclosure, true),
      heading("Homes within each income ceiling", 2),
      table(
        [
          "Income ceiling",
          "Baseline",
          "Proposal",
          "Change",
          "Known subtotal baseline / proposal",
        ],
        housing.summaryRows,
        [3200, 1500, 1500, 1500, 2620],
      ),
      paragraph(
        "Cumulative counts overlap; do not add them. Known subtotals describe only the evaluated homes and are not complete totals.",
        true,
      ),
      heading("Lowest affordable income ceiling", 2),
      table(
        [
          "Exclusive band",
          "Baseline",
          "Proposal",
          "Known subtotal baseline / proposal",
        ],
        housing.bandRows,
        [4100, 1600, 1600, 3020],
      ),
      heading("Completeness of the comparison", 2),
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
        [1500, 1500, 1500, 1700, 1900, 2220],
      ),
      ...housing.context.map((note) => paragraph(note, true)),
    );
    for (const panel of housing.panels)
      children.push(
        heading(panel.title, 2, true),
        ...panel.context.map((note) => paragraph(note, true)),
        table(
          ["Cost component", "Monthly USD or inclusion"],
          panel.costRows.map((row) => row.slice(0, 2)),
          [4700, 5620],
        ),
        heading("Cost evidence", 3),
        ...panel.costRows.map((row) => paragraph(`${row[0]}: ${row[2]}`, true)),
        table(
          ["Published ceiling", "Annual USD", "Cost comparison"],
          panel.thresholdRows,
          [4400, 2600, 3320],
        ),
      );
    children.push(heading("Housing evidence and income limits", 2, true));
    for (const evidence of housing.evidence)
      children.push(
        heading(evidence.title, 3),
        table(
          [
            "Household size",
            "Extremely low income",
            "Very low income",
            "Low income",
          ],
          evidence.rows,
          [2000, 3000, 2660, 2660],
        ),
        ...evidence.notes.map((note) => paragraph(note, true)),
      );
  }
  if (fiscal) {
    children.push(
      heading("Fiscal study and incentive comparison", 1, true),
      paragraph(fiscalReportDisclosure, true),
      paragraph(fiscalClockDisclosure, true),
      paragraph(
        `${fiscal.profile.name}; ${fiscal.profile.jurisdiction.name}. Fiscal year ${fiscal.profile.fiscalYear}; constant ${fiscal.profile.dollarYear} USD. Result ${fiscal.resolution.status}; review ${fiscal.resolution.reviewState}.`,
        true,
      ),
      heading("Twenty year incremental outcomes", 2),
      table(
        [
          "Case",
          "Net without offer",
          "Net with offer",
          "NPV with offer",
          "Payback",
        ],
        fiscal.summaryRows,
        [2200, 2030, 2030, 2030, 2030],
      ),
      paragraph(
        "All changes subtract the corresponding baseline. Totals include time zero and 20 operating years. Annual net figures follow; component ledgers and exact numeric inputs are retained in the fiscal CSV, workbook and complete project records.",
        true,
      ),
      heading("Profile and current coefficients", 2),
      table(
        [
          "Parameter and units",
          "Profile",
          "Frozen baseline",
          "Current proposal",
        ],
        fiscal.parameterRows,
        [4260, 2020, 2020, 2020],
      ),
      ...fiscal.parameterNotes.map((note) => paragraph(note, true)),
    );
    for (const panel of fiscal.panels) {
      children.push(
        heading(`Fiscal case ${panel.name}`, 2, true),
        paragraph(panel.description),
        ...panel.notes.map((note) => paragraph(note, true)),
        heading("Annual net cash flows in USD", 3),
        table(
          [
            "Year / fiscal year",
            "Baseline",
            "Without offer",
            "With offer",
            "With offer minus baseline",
          ],
          panel.annualRows,
          [1760, 2140, 2140, 2140, 2140],
        ),
        heading("Paired case coefficients", 3),
        table(
          ["Parameter and units", "Baseline", "Proposal"],
          panel.inputRows,
          [5120, 2600, 2600],
        ),
      );
    }
    children.push(
      heading("Fiscal evidence and study lineage", 2, true),
      ...fiscal.context.map((note) => paragraph(note, true)),
    );
  }
  if (retail) {
    children.push(
      heading("Retail category evidence and opportunity", 1, true),
      paragraph(retailReportDisclosure, true),
      paragraph(retail.contextDescription, true),
      table(
        [
          "Category",
          "Demand before / scenario",
          "Sales before / scenario",
          "Gap before / scenario",
          "Net new sales / remaining equivalent",
        ],
        retail.resultRows,
        [2240, 2000, 2000, 2000, 2080],
      ),
      heading("Annual capture calculation · USD", 2),
      table(
        [
          "Category",
          "Eligible gap",
          "Gross captured",
          "Displaced",
          "Net new sales",
        ],
        retail.captureRows,
        [2800, 1880, 1880, 1880, 1880],
      ),
      heading("Recorded category inputs", 2),
      table(
        [
          "Category",
          "Annual demand",
          "Annual sales / establishment benchmark",
          "Additional annual capacity / assumptions",
        ],
        retail.inputRows,
        [2240, 2700, 2700, 2680],
      ),
      ...retail.notes.map((note) => paragraph(note, true)),
    );
  }
  if (workforce) {
    children.push(
      heading("Workforce within reach of the site", 1, true),
      paragraph(workforceReportDisclosure, true),
      paragraph(workforce.contextDescription, true),
      paragraph(workforceUncertaintyDisclosure, true),
    );
    for (const panel of workforce.panels)
      children.push(
        heading(panel.label, 2),
        paragraph(
          `${panel.universe}. Census table ${panel.table}. Counts are people; travel limits are cumulative, so do not add the 15, 30 and 45 minute rows.`,
          true,
        ),
        table(
          ["Category", "Travel limit", "People", "90% sampling MOE", "Status"],
          panel.rows,
          [3460, 1180, 1940, 2260, 1480],
        ),
      );
    children.push(
      heading("Workforce coverage and provenance", 2, true),
      table(
        ["Coverage diagnostic", "Recorded value"],
        workforce.diagnostics,
        [7000, 3320],
      ),
      ...workforce.notes.map((note) => paragraph(note, true)),
    );
  }
  for (const item of accessibility) {
    children.push(
      heading(
        `Jobs accessibility by ${item.mode === "car" ? "car" : "walking"}`,
        1,
        true,
      ),
      paragraph(accessibilityReportDisclosure, true),
      paragraph(item.contextDescription, true),
      paragraph(accessibilityUncertaintyDisclosure, true),
    );
    for (const panel of item.panels)
      children.push(
        heading(panel.label, 2),
        table(
          ["Category", "15 minutes", "30 minutes", "45 minutes"],
          panel.rows,
          [4100, 2073, 2073, 2074],
        ),
      );
    children.push(
      heading("Jobs accessibility coverage and provenance", 2, true),
      table(
        ["Coverage diagnostic", "Recorded value"],
        item.diagnostics,
        [6500, 3820],
      ),
      ...item.notes.map((note) => paragraph(note, true)),
    );
  }
  if (flood) {
    children.push(
      heading("Mapped flood exposure", 1, true),
      paragraph(floodReportDisclosure, true),
      paragraph(flood.contextDescription, true),
      paragraph(floodUncertaintyDisclosure, true),
      table(
        ["Exposure measure", "Baseline", "Proposal"],
        flood.summaryRows,
        [6400, 1960, 1960],
      ),
      heading("Retained flood classifications", 2),
      table(
        [
          "Source feature",
          "FEMA zone / subtype",
          "Classification",
          "Source citation",
        ],
        flood.zoneRows,
        [2200, 3700, 2220, 2200],
      ),
      heading("Map dates and source coverage", 2),
      table(
        ["Record", "Source identifier", "Recorded date"],
        flood.mapDates,
        [3300, 3300, 3720],
      ),
      heading("Flood coverage diagnostics", 2),
      table(
        ["Coverage diagnostic", "Recorded value"],
        flood.diagnostics,
        [4900, 5420],
      ),
      ...flood.notes.map((note) => paragraph(note, true)),
    );
  }
  if (traffic) {
    children.push(
      heading("Captured traffic experiment", 1, true),
      paragraph(trafficReportDisclosure, true),
      paragraph(traffic.contextDescription, true),
      paragraph(traffic.freshness, true),
      heading("Paired native outcomes", 2),
      table(
        ["Measure", "Unit", "Baseline", "Proposal", "Change"],
        traffic.resultRows,
        [3400, 1600, 1780, 1780, 1760],
      ),
      paragraph(trafficSubtotalDisclosure, true),
      table(
        ["Completed-cohort subtotal", "Unit", "Baseline", "Proposal"],
        traffic.subtotalRows,
        [4100, 1820, 2200, 2200],
      ),
      heading("Completion and accounting", 2),
      table(
        ["Cohort measure", "Baseline", "Proposal"],
        traffic.summaryRows,
        [5920, 2200, 2200],
      ),
      table(
        ["Native diagnostic", "Baseline", "Proposal"],
        traffic.diagnosticRows,
        [5920, 2200, 2200],
      ),
      heading("Calibration and declared holdout", 2),
      paragraph(
        traffic.capture.calibration
          ? "Observed baseline interval-count fit; this does not assess proposal predictions against observed future traffic."
          : "Not assessed. No baseline count-check plan was supplied.",
        true,
      ),
    );
    if (traffic.calibrationRows.length)
      children.push(
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
          [2200, 1560, 1300, 1300, 1300, 1300, 1360],
        ),
      );
    if (traffic.overlayRows.length)
      children.push(
        heading("Explicit native edge controls", 2),
        table(
          ["Directed native edge", "Access", "Lanes", "Speed m/s"],
          traffic.overlayRows,
          [5520, 1600, 1600, 1600],
        ),
      );
    if (traffic.signalTimingRows.length)
      children.push(
        heading("Authored signal timing", 2),
        paragraph(
          "Exact recorded durations in seconds. Movement states, sequence and clearance phases are retained; these edits do not establish field-verified timings.",
        ),
        table(
          ["Controller", "Program / phase", "Baseline s", "Proposal s"],
          traffic.signalTimingRows,
          [3000, 4120, 1600, 1600],
        ),
      );
    children.push(
      heading("Traffic scope and retained provenance", 2),
      ...traffic.notes.map((note) => paragraph(note, true)),
    );
  }
  if (presentation) {
    children.push(
      heading("Authored presentation outline", 1, true),
      paragraph(
        `${presentation.title}. Scenario ${presentation.scenarioId}, revision ${presentation.revision}.`,
      ),
      paragraph(presentationReportDisclosure, true),
    );
    for (const stop of presentation.stops) {
      children.push(
        heading(`${stop.order}. ${stop.title}`, 2),
        paragraph(stop.callout),
        paragraph(`${stop.cameraDescription} Stop ID: ${stop.id}.`, true),
        paragraph(
          `Metric references: ${stop.metricReferences.length ? stop.metricReferences.join("; ") : "None selected."}`,
          true,
        ),
      );
      if (stop.narration)
        children.push(
          heading("Presenter narration text", 3),
          paragraph(stop.narration),
        );
    }
  }
  children.push(
    heading("Sources and reproducibility", 1),
    paragraph(
      "Source numbering links methods to their evidence. Planning sources and separately retained evidence are listed together; fiscal and regional evidence retain their own applicability in the preceding appendices.",
    ),
  );
  for (const coverage of place.coverage)
    children.push(
      heading(`${coverage.layer} coverage`, 2),
      paragraph(`${coverage.status}. ${coverage.description}`, true),
    );
  reportSources(snapshot).forEach((source, index) => {
    children.push(
      heading(`${index + 1} ${source.name}`, 2),
      paragraph(
        `Source ID: ${source.id}. Vintage: ${source.vintage}. Evidence: ${source.kind}. License: ${source.license}.`,
        true,
      ),
    );
    if (source.description) children.push(paragraph(source.description, true));
    children.push(
      ...importSourceNotes(source).map((note) => paragraph(note, true)),
    );
    if (source.url) {
      if (/^https?:\/\//i.test(source.url))
        children.push(
          new Paragraph({
            children: [
              new ExternalHyperlink({
                link: source.url,
                children: [
                  new TextRun({
                    text: `Open source ${index + 1}`,
                    style: "Hyperlink",
                  }),
                ],
              }),
            ],
            spacing: { after: 90 },
          }),
        );
      children.push(paragraph(source.url, true));
    }
  });
  if (snapshot.maps) {
    children.push(
      heading("Comparison map provenance", 2),
      ...snapshot.maps.metadata.notes.map((note) => paragraph(note, true)),
      paragraph(
        `Shared displayed extent west, south, east, north: ${snapshot.maps.metadata.extent.join(", ")}. Analytical study extent: ${snapshot.maps.metadata.studyAreaExtent.join(", ")}. Projection origin: ${snapshot.maps.metadata.projection.origin.join(", ")}. Scale: ${snapshot.maps.metadata.projection.metersPerPixel} meters per pixel.`,
        true,
      ),
      paragraph(
        `Map baseline SHA-256: ${snapshot.maps.metadata.baselineHash}. Map input SHA-256: ${snapshot.maps.metadata.inputHash}.`,
        true,
      ),
    );
    for (const source of snapshot.maps.metadata.credits)
      children.push(
        paragraph(
          `Map credit: ${source.name}; ${source.vintage}; ${source.license}. ${source.url}`,
          true,
        ),
      );
  }
  children.push(
    paragraph(
      `Project ${project.id}. Scenario ${scenario.id}, revision ${scenario.revision}. Model ${results.modelVersion}. Computed ${results.computedAt}. Generated ${snapshot.generatedAt}.`,
      true,
    ),
    paragraph(`Input SHA-256: ${reportDigest(snapshot)}`, true),
  );
  const headingStyle = {
    run: { color: "000000", font: "Arial", bold: true },
    paragraph: { keepNext: true },
  };
  const document = new Document({
    creator: "Urban Planning",
    title: `${project.name} - Scenario planning review`,
    description: `${scenario.name}, revision ${scenario.revision}`,
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22, color: "263F36" },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
        title: {
          ...headingStyle,
          run: { ...headingStyle.run, size: 48 },
          paragraph: { ...headingStyle.paragraph, spacing: { after: 180 } },
        },
        heading1: { ...headingStyle, run: { ...headingStyle.run, size: 34 } },
        heading2: { ...headingStyle, run: { ...headingStyle.run, size: 27 } },
        heading3: { ...headingStyle, run: { ...headingStyle.run, size: 23 } },
      },
      paragraphStyles: [
        {
          id: "Subtitle",
          name: "Subtitle",
          run: { color: "000000", font: "Arial", size: 28 },
          paragraph: { spacing: { after: 160 }, keepNext: true },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: {
              top: 960,
              right: 960,
              bottom: 1100,
              left: 960,
              footer: 500,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `Urban Planning | Revision ${scenario.revision} | Page `,
                    size: 16,
                    color: "57665D",
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 16,
                    color: "57665D",
                  }),
                  new TextRun({ text: " of ", size: 16, color: "57665D" }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    size: 16,
                    color: "57665D",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
import {
  fiscalReportInventory,
  fiscalReportDisclosure,
  fiscalClockDisclosure,
  assertFiscalDocumentLimit,
} from "./report-fiscal";
