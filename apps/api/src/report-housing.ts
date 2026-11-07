import { housingExportInventory } from "@urban/core";
import type { ReportSnapshot } from "./exports";
import { assertHousingExport } from "./housing-validation";
import { ApiError } from "./errors";
export { HOUSING_REPORT_DISCLOSURE as housingReportDisclosure } from "@urban/core";
export function housingReportInventory(snapshot: ReportSnapshot) {
  assertHousingExport(snapshot.project, snapshot.scenario);
  try {
    const h = housingExportInventory(
      snapshot.place,
      snapshot.scenario,
      snapshot.results,
      snapshot.project.housingIncomeLimits,
    );
    if (!h) return null;
    const evidence = Object.entries(h.packs).map(([hash, pack]) => ({
      title: `${pack.area.name} · FY ${pack.fiscalYear}`,
      rows: pack.limits.map((l) => [
        String(l.householdSize),
        String(l.extremelyLow),
        String(l.veryLow),
        String(l.low),
      ]),
      notes: [
        `Area ${pack.area.id}; effective ${pack.effectiveDate}; pack SHA-256 ${hash}. Geographic applicability is user-reviewed.`,
        `Geographies: ${pack.area.geographies.map((g) => `${g.name} (${g.countyFips}${g.countySubdivisionFips ? ` / ${g.countySubdivisionFips}` : ""})`).join("; ")}.`,
        ...pack.notes,
        ...pack.files.map(
          (f) =>
            `Retained source-file receipt: ${f.sourceId}; ${f.url}; ${f.bytes} bytes; SHA-256 ${f.sha256}. Imported receipts are declarations, not independently authenticated contents.`,
        ),
        ...pack.sourceRows.map(
          (r) =>
            `Retained source row: file ${r.fileSha256}; sheet ${r.sheet}; row ${r.row}. ${JSON.stringify(r.cells)}`,
        ),
      ],
    }));
    return { ...h, evidence };
  } catch (error) {
    throw new ApiError(
      409,
      "HOUSING_RESULT_MISMATCH",
      error instanceof Error
        ? error.message
        : "The housing report requires its matching frozen evidence and results.",
    );
  }
}
export function requireHousingReport(snapshot: ReportSnapshot) {
  const result = housingReportInventory(snapshot);
  if (!result)
    throw new ApiError(
      422,
      "HOUSING_COMPARISON_REQUIRED",
      "Add and save reviewed housing costs before exporting the affordability comparison.",
    );
  return result;
}
export function assertHousingDocumentLimit(snapshot: ReportSnapshot) {
  const h = housingReportInventory(snapshot);
  if (
    h &&
    (h.panels.length > 60 ||
      JSON.stringify({
        controls: h.controls,
        packs: h.packs,
        results: h.resolution,
      }).length > 160_000)
  )
    throw new ApiError(
      413,
      "HOUSING_REPORT_TOO_LARGE",
      "This housing evidence exceeds the document appendix limit. Export its complete CSV, workbook or project records; no groups or sources have been omitted.",
    );
}
