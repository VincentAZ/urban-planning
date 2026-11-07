import {
  FISCAL_ALTERNATIVES,
  FISCAL_COEFFICIENT_KEYS,
  FISCAL_METHOD_VERSION,
  FISCAL_REPORT_DISCLOSURE,
  FISCAL_CLOCK_DISCLOSURE,
  fiscalCashFlowCSV,
  fiscalResolutionInputHash,
  type FiscalStudy,
  type ModelResults,
  type Place,
  type Project,
  type Scenario,
} from "@urban/core";
import { download } from "./api";

const esc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const money = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);

export function assertFiscalExportAllowed(study?: FiscalStudy) {
  if (
    study?.profile.sources.some(
      (source) =>
        !source.rights?.privateUse ||
        !source.rights.privateDisplay ||
        !source.rights.export,
    )
  )
    throw new Error(
      "This fiscal profile has a source that does not permit export. Keep its citation and review the source-use declaration.",
    );
}

function fiscalExport(
  place: Place,
  scenario: Scenario,
  results: ModelResults,
  study?: FiscalStudy,
) {
  if (!study && !results.fiscal) return null;
  assertFiscalExportAllowed(study);
  const resolution = results.fiscal;
  if (
    !study ||
    !resolution ||
    resolution.methodVersion !== FISCAL_METHOD_VERSION ||
    resolution.profileHash !== study.profileHash ||
    resolution.scenarioId !== scenario.id ||
    resolution.scenarioRevision !== scenario.revision ||
    resolution.inputHash !== fiscalResolutionInputHash(place, scenario, study)
  )
    throw new Error(
      "The fiscal export needs the matching frozen profile and results. Wait for this revision to finish calculating before exporting.",
    );
  return {
    study,
    resolution,
    cases: [...(resolution.base ? [resolution.base] : []), ...resolution.cases],
  };
}

export function exportFiscalCSV(
  place: Place,
  project: Project,
  scenario: Scenario,
  results: ModelResults,
) {
  const fiscal = fiscalExport(place, scenario, results, project.fiscalStudy);
  if (!fiscal)
    throw new Error(
      "Create a fiscal study before exporting annual cash flows.",
    );
  download(
    "urban-planning-fiscal-cash-flows.csv",
    fiscalCashFlowCSV(fiscal.study, scenario, fiscal.resolution),
    "text/csv;charset=utf-8",
  );
}

/** Scorecard downloads also contain fiscal results and must honor their evidence. */
export function assertFiscalResultExportAllowed(
  place: Place,
  project: Project,
  scenario: Scenario,
  results: ModelResults,
) {
  fiscalExport(place, scenario, results, project.fiscalStudy);
}

export function fiscalHTML(
  place: Place,
  scenario: Scenario,
  results: ModelResults,
  study?: FiscalStudy,
) {
  const fiscal = fiscalExport(place, scenario, results, study);
  if (!fiscal) return "";
  const { profile } = fiscal.study;
  const r = fiscal.resolution;
  const table = (headers: string[], rows: unknown[][]) =>
    `<table><thead><tr>${headers.map((v) => `<th scope="col">${esc(v)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const review = scenario.fiscal?.review;
  const coefficientRows = FISCAL_COEFFICIENT_KEYS.map((key) => [
    key,
    profile.coefficients[key],
    scenario.baselineAssumptions[key],
    scenario.assumptions[key],
    scenario.assumptions[key] === profile.coefficients[key]
      ? profile.provenance[key].kind
      : "Authored deviation from profile",
  ]);
  const cases = fiscal.cases
    .map((c) => {
      const payback =
        c.payback.status === "reached"
          ? `Year ${c.payback.year}`
          : c.payback.status === "not-reached"
            ? "Not reached within 20 years"
            : c.payback.status === "not-needed"
              ? "No incentive cost"
              : "Unavailable";
      const totals = FISCAL_ALTERNATIVES.map(([key, label]) => [
        label,
        money(c[key].totals.netRevenue),
        money(c[key].totals.npv),
        c[key].missingBuildingIds.length
          ? `Missing quantities: ${c[key].missingBuildingIds.join(", ")}`
          : "No required building quantities missing",
      ]);
      const annual = c.baseline.rows.map((row, i) => [
        row.year === 0
          ? "Time zero"
          : `Year ${row.year}; FY ${row.fiscalYear ?? "unspecified"}`,
        money(row.netRevenue),
        money(c.withoutOffer.rows[i].netRevenue),
        money(c.withOffer.rows[i].netRevenue),
        money(c.incremental.withOffer.rows[i].netRevenue),
      ]);
      const inputs = FISCAL_COEFFICIENT_KEYS.map((key) => [
        key,
        c.assumptions.baseline[key],
        c.assumptions.proposal[key],
      ]);
      return `<section><h3>${esc(c.name)}</h3><p>${esc(c.description)} Status: ${esc(c.status)}. Sources: ${esc(c.sourceIds.join(", "))}.</p><p>Upfront grant ${esc(money(c.assumptions.proposal.incentiveGrant))}; abatement ${esc(c.assumptions.proposal.abatementPercent * 100)}% for ${esc(c.assumptions.proposal.abatementYears)} years. Offer cost ${esc(money(c.offerCost.total))}; offer-cost NPV ${esc(money(c.offerCost.npv))}. Payback: ${esc(payback)}.</p>${table(["Alternative", "20-year net incl time zero", "NPV at horizon start", "Quantity coverage"], totals)}<p>Incremental with offer: net ${esc(money(c.incremental.withOffer.netRevenue))}; NPV ${esc(money(c.incremental.withOffer.npv))}. Incremental without offer: net ${esc(money(c.incremental.withoutOffer.netRevenue))}; NPV ${esc(money(c.incremental.withoutOffer.npv))}.</p><h4>Annual net cash flows in USD</h4>${table(["Time", "Baseline", "Without offer", "With offer", "With offer minus baseline"], annual)}<h4>Paired case coefficients</h4>${table(["Parameter", "Baseline", "Proposal"], inputs)}</section>`;
    })
    .join("");
  return `<section><h2>Fiscal study and incentive comparison</h2><p>${esc(FISCAL_REPORT_DISCLOSURE)}</p><p>${esc(FISCAL_CLOCK_DISCLOSURE)}</p><p>${esc(profile.name)} · profile ${esc(profile.profileVersion)} · ${esc(profile.jurisdiction.name)} · fiscal year ${profile.fiscalYear} · constant ${profile.dollarYear} USD. ${esc(profile.jurisdiction.geography)}.</p><p>Result: ${esc(r.status)}; input review: ${esc(r.reviewState)}.${review ? ` ${esc(review.reviewedBy)} on ${esc(review.reviewedAt)}. ${esc(review.notes)}` : ""}</p><p>Applicability: ${esc(fiscal.study.applicability.applicabilityNotes)}. Valuation: ${esc(profile.valuation.compatibilityNotes)}. Service allocation: ${esc(profile.serviceAllocation.method)}; ${esc(profile.serviceAllocation.notes)}.</p>${r.clock ? `<p>Operating years ${r.clock.firstOperatingYear} through ${r.clock.firstOperatingYear + r.clock.years - 1}; ${r.clock.horizonYears}-year scenario horizon. Time zero precedes the first operating year.</p>` : ""}${r.notes.map((note) => `<p>${esc(note)}</p>`).join("")}<h3>Profile and current coefficients</h3>${table(["Parameter", "Profile", "Baseline", "Proposal", "Current evidence"], coefficientRows)}${FISCAL_COEFFICIENT_KEYS.map(
    (key) => {
      const p = profile.provenance[key];
      return `<p><strong>${esc(key)}</strong>: ${esc(p.kind)} profile value ${esc(profile.coefficients[key])}. ${esc(p.description)} ${esc(p.derivation ?? "")} Sources: ${esc(p.sourceIds.join(", "))}.</p>`;
    },
  ).join(
    "",
  )}<p>Changed proposal values are authored deviations; original profile citations do not establish the changed value. Detailed component ledgers and exact numeric inputs are retained in the fiscal CSV, workbook and complete project records.</p>${cases}<h3>Fiscal sources and lineage</h3>${profile.sources.map((source) => `<p><strong>${esc(source.name)}</strong> · ${esc(source.id)} · ${esc(source.vintage)} · ${esc(source.kind)}<br>${esc(source.url)}<br>${esc(source.license)} ${esc(source.description ?? "")}</p>`).join("")}${profile.files.map((file) => `<p>Declared source-file receipt: ${esc(file.sourceId)}, ${esc(file.url)}, ${file.bytes} bytes, SHA-256 ${esc(file.sha256)}. Receipt contents are not independently authenticated.</p>`).join("")}${profile.notes.map((note) => `<p>${esc(note)}</p>`).join("")}<p>Copied from project ${esc(fiscal.study.lineage.projectId)}, scenario ${esc(fiscal.study.lineage.scenarioId)}, revision ${fiscal.study.lineage.scenarioRevision}. The original history remains in the source project. Profile SHA-256 ${esc(fiscal.study.profileHash)}. Fiscal input SHA-256 ${esc(r.inputHash)}. Method ${esc(r.methodVersion)}.</p></section>`;
}
