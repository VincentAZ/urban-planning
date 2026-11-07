import type { Place, RetailMeasure, Scenario } from "@urban/core";
import { MODEL_VERSION, resolveRetail } from "@urban/models";

const escapeHTML = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Local printable brief uses the same saved study and model as the scorecard. */
export function retailHTML(
  place: Place,
  scenario: Scenario,
  modelVersion: string,
) {
  const study = scenario.retail;
  if (!study) return "";
  const context = study.context;
  const amount = (value: number | null) =>
    value === null
      ? "Unavailable"
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }).format(value);
  const measure = (value: RetailMeasure) =>
    escapeHTML(
      `${value.status === "available" ? amount(value.value) : value.status}; source ${value.sourceId ?? "not supplied"}${value.note ? `; ${value.note}` : ""}`,
    );
  const inputs = `<h3>Authored category inputs</h3><table><thead><tr><th>Category</th><th>Demand / sales evidence</th><th>Annual sales benchmark</th><th>Scenario assumptions</th></tr></thead><tbody>${study.categories.map((row) => `<tr><th scope="row">${escapeHTML(row.name)}</th><td>Demand: ${measure(row.baselineDemand)}<br>Sales: ${measure(row.baselineSales)}</td><td>${measure(row.salesPerEstablishment)}</td><td>Demand: ${row.scenarioDemand === null ? "Keep reference demand" : escapeHTML(amount(row.scenarioDemand))}<br>Added capacity: ${escapeHTML(amount(row.annualSalesCapacity))}<br>Capture: ${escapeHTML(row.captureShare * 100)}%; displacement: ${escapeHTML(row.displacementShare * 100)}%<br>Source: ${escapeHTML(row.assumptionSourceId)}</td></tr>`).join("")}</tbody></table><h3>Source-use declarations</h3>${study.sourceRights.map((right) => `<p>${escapeHTML(right.sourceId)}: authorized private use ${right.authorizedPrivateUse ? "confirmed" : "not confirmed"}; public redistribution ${right.publicRedistribution ? "confirmed" : "not confirmed"}. ${escapeHTML(right.statement)}</p>`).join("")}`;
  const exactInputs = `<details><summary>Exact retail inputs and sharing declarations</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(JSON.stringify(study, null, 2))}</pre></details>`;
  const heading = `<h2>Retail demand and sales</h2><p>${escapeHTML(context.geography)} · ${escapeHTML(context.relationshipToStudyArea)} · ${context.referenceYear} reference · ${context.dollarYear} USD · ${escapeHTML(context.classification.system)} ${escapeHTML(context.classification.version)} · ${context.horizon}-year study horizon.</p><p class="notice">Demand minus local establishment sales is a screening gap, not measured resident spending leakage. Added capacity, capture and displacement are authored assumptions. This study does not change buildings, population, traffic or tax revenue.</p>`;
  if (modelVersion !== MODEL_VERSION)
    return `${heading}<p>These inputs belong to model ${escapeHTML(modelVersion)}. Category results have not been recalculated with a different model. The frozen scorecard above remains authoritative for this export.</p>${inputs}${exactInputs}`;
  const resolved = resolveRetail(place, scenario);
  if (!resolved) return `${heading}${inputs}${exactInputs}`;
  return `${heading}<p>${escapeHTML(resolved.status)} · ${resolved.coverage.completeCategories} of ${resolved.coverage.categories} monetary categories complete.</p><table><thead><tr><th>Category</th><th>Demand / baseline sales</th><th>Baseline gap</th><th>Net added sales</th><th>Scenario gap</th><th>Status</th></tr></thead><tbody>${resolved.categories.map((row) => `<tr><td>${escapeHTML(row.name)}<br>${escapeHTML(row.code)}</td><td>${escapeHTML(amount(row.baselineDemand))} / ${escapeHTML(amount(row.baselineSales))}</td><td>${escapeHTML(amount(row.baselineGap))}</td><td>${escapeHTML(amount(row.netNewSales))}</td><td>${escapeHTML(amount(row.scenarioGap))}</td><td>${escapeHTML(row.status)}${row.warnings.length ? `<br>${row.warnings.map(escapeHTML).join("; ")}` : ""}</td></tr>`).join("")}</tbody></table>${resolved.warnings.map((warning) => `<p class="notice">${escapeHTML(warning)}</p>`).join("")}${inputs}${exactInputs}`;
}
