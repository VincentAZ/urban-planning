import {
  HOUSING_REPORT_DISCLOSURE,
  housingAffordabilityCSV,
  housingAffordabilityReferences,
  housingSourcePermissionIssues,
  housingExportInventory,
  type HousingIncomeLimitCatalog,
  type ModelResults,
  type Place,
  type Project,
  type Scenario,
  type Source,
} from "@urban/core";
import { download } from "./api";
const esc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const table = (headers: string[], rows: string[][]) =>
  `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

export function assertHousingExportAllowed(
  scenario: Pick<Scenario, "affordability">,
  catalog?: HousingIncomeLimitCatalog,
) {
  const packs = new Set(
    [
      ...(scenario.affordability?.baselineGroups ?? []),
      ...(scenario.affordability?.proposalGroups ?? []),
    ].map((g) => g.areaHash),
  );
  const sources: Source[] = [...(scenario.affordability?.sources ?? [])];
  for (const hash of packs) {
    if (!catalog?.[hash])
      throw new Error(
        "Housing export requires the complete retained income-limit pack.",
      );
    sources.push(...catalog[hash].sources);
  }
  if (housingSourcePermissionIssues(sources, "export").length)
    throw new Error(
      "Housing evidence does not permit export. Retain its citations and review the source-use declaration.",
    );
}
export function assertHousingProjectExportAllowed(project: Project) {
  for (const affordability of housingAffordabilityReferences(project))
    assertHousingExportAllowed({ affordability }, project.housingIncomeLimits);
  for (const pack of Object.values(project.housingIncomeLimits ?? {}))
    if (housingSourcePermissionIssues(pack.sources, "export").length)
      throw new Error(
        "A retained housing source does not permit project export.",
      );
}
export function assertHousingResultExportAllowed(
  place: Place,
  project: Pick<Project, "housingIncomeLimits">,
  scenario: Scenario,
  results: ModelResults,
) {
  assertHousingExportAllowed(scenario, project.housingIncomeLimits);
  return housingExportInventory(
    place,
    scenario,
    results,
    project.housingIncomeLimits,
  );
}
export function exportHousingCSV(
  place: Place,
  project: Project,
  scenario: Scenario,
  results: ModelResults,
) {
  const housing = assertHousingResultExportAllowed(
    place,
    project,
    scenario,
    results,
  );
  if (!housing)
    throw new Error(
      "Add reviewed housing costs before exporting the affordability comparison.",
    );
  download(
    "urban-planning-housing-affordability.csv",
    housingAffordabilityCSV(scenario, housing.resolution, housing.packs),
    "text/csv;charset=utf-8",
  );
}
export function housingHTML(
  place: Place,
  project: Pick<Project, "housingIncomeLimits">,
  scenario: Scenario,
  results: ModelResults,
) {
  const housing = assertHousingResultExportAllowed(
    place,
    project,
    scenario,
    results,
  );
  if (!housing) return "";
  return `<section><h2>Housing affordability</h2><p>${esc(HOUSING_REPORT_DISCLOSURE)}</p>${housing.context.map((t) => `<p>${esc(t)}</p>`).join("")}<h3>Homes within each income ceiling</h3>${table(["Income ceiling", "Baseline", "Proposal", "Change", "Known subtotal: baseline / proposal"], housing.summaryRows)}<h3>Lowest affordable income ceiling</h3>${table(["Exclusive band", "Baseline", "Proposal", "Known subtotal: baseline / proposal"], housing.bandRows)}<h3>Completeness of the comparison</h3>${table(["Side", "Total homes", "Evaluated", "Unassigned", "Unresolved assigned", "Buildings with unknown units"], housing.coverageRows)}${housing.panels.map((p) => `<section><h3>${esc(p.title)}</h3>${p.context.map((t) => `<p>${esc(t)}</p>`).join("")}${table(["Cost component", "Monthly USD or inclusion", "Evidence"], p.costRows)}${table(["Published ceiling", "Annual USD", "Cost comparison"], p.thresholdRows)}</section>`).join("")}<h3>Housing evidence</h3>${Object.entries(
    housing.packs,
  )
    .map(
      ([hash, pack]) =>
        `<h4>${esc(pack.area.name)} · FY ${pack.fiscalYear}</h4><p>Effective ${esc(pack.effectiveDate)}; pack SHA-256 ${esc(hash)}. Area assignment is user-reviewed.</p>${table(
          [
            "Household size",
            "Extremely low income",
            "Very low income",
            "Low income",
          ],
          pack.limits.map((l) => [
            String(l.householdSize),
            String(l.extremelyLow),
            String(l.veryLow),
            String(l.low),
          ]),
        )}<p>Geographies: ${esc(pack.area.geographies.map((g) => `${g.name} (${g.countyFips}${g.countySubdivisionFips ? ` / ${g.countySubdivisionFips}` : ""})`).join("; "))}.</p>${pack.notes.map((t) => `<p>${esc(t)}</p>`).join("")}${pack.sources.map((s) => `<p>${esc(s.name)} · ${esc(s.id)} · ${esc(s.vintage)}<br>${esc(s.url)}<br>${esc(s.license)} ${esc(s.description)}</p>`).join("")}${pack.files.map((f) => `<p>Retained file receipt: ${esc(f.sourceId)}; ${esc(f.url)}; ${f.bytes} bytes; SHA-256 ${esc(f.sha256)}.</p>`).join("")}<p>Exact retained source rows: ${esc(JSON.stringify(pack.sourceRows))}</p>`,
    )
    .join(
      "",
    )}${housing.controls.sources.map((s) => `<p>Cost source: ${esc(s.name)} · ${esc(s.id)} · ${esc(s.vintage)}<br>${esc(s.url)}<br>${esc(s.license)} ${esc(s.description)}</p>`).join("")}</section>`;
}
