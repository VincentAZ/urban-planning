import type { Scenario, WorkforceCapturedCount } from "@urban/core";

const esc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const number = (value: number | null) =>
  value === null
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const count = (row: WorkforceCapturedCount) =>
  row.estimate !== null
    ? number(row.estimate)
    : row.knownSubtotal !== null
      ? `Subtotal ${number(row.knownSubtotal)}`
      : "Unavailable";
const margin = (row: WorkforceCapturedCount) =>
  row.marginOfError90 !== null
    ? `±${number(row.marginOfError90)}`
    : row.knownSubtotalMarginOfError90 !== null
      ? `Conditional ±${number(row.knownSubtotalMarginOfError90)}`
      : "Unavailable";

/** Print the saved capture; no API, private archive lookup or recalculation. */
export function workforceHTML(scenario: Scenario) {
  const evidence = scenario.workforce;
  if (!evidence) return "";
  const capture = evidence.capture;
  return `<h2>Workforce within reach of the site</h2>
${evidence.origin === "imported" ? '<p class="notice"><strong>Imported evidence — not verified by this server.</strong> Numbers and source claims are retained from the imported file, not presented as a server-produced analysis.</p>' : ""}
<p>${esc(capture.cohort.region.label)} · Inbound ${esc(capture.request.mode)} travel · Site longitude ${esc(capture.request.site[0])}, latitude ${esc(capture.request.site[1])} · Captured ${esc(capture.capturedAt)} · ${esc(capture.methodVersion)}.</p>
<p>Site to matched network distance: ${esc(number(capture.siteSnapMeters))} m. This does not establish a site entrance.</p>
<p class="notice">These frozen estimates use the captured road network and Census sources. Proposed roads, buildings, growth and future horizons are not applied. Education and occupation describe different, overlapping populations and must not be added together. These are not counts of available applicants or workplace jobs.</p>
<p>A subtotal includes only the resolved contribution, not a complete catchment. A conditional 90% margin of error applies only to that subtotal. Sampling margins exclude spatial allocation and routing error. Travel limits are cumulative; do not add the 15, 30 and 45 minute results.</p>
${capture.panels.map((panel) => `<h3>${esc(panel.label)}</h3><p>${esc(panel.universe)} · Census ${esc(panel.table)}</p><table><thead><tr><th>Category</th><th>Travel limit</th><th>People</th><th>90% sampling MOE</th><th>Status</th></tr></thead><tbody>${panel.thresholds.flatMap((threshold) => [{ ...threshold.total, label: "Total population in this universe" }, ...threshold.categories].map((row) => `<tr><th scope="row">${esc(row.label)}</th><td>${threshold.minutes} min</td><td>${esc(count(row))}</td><td>${esc(margin(row))}</td><td>${esc(row.status)}</td></tr>`)).join("")}</tbody></table>`).join("")}
<h3>Coverage and retained evidence</h3><p>Source catchment: ${esc(capture.coverage.cohort.status)}. Network catchment: ${esc(capture.coverage.network)}. Allocation unavailable in ${esc(capture.coverage.allocationUnavailableUnits)} native block groups. Retained regular origins: ${esc(capture.coverage.origins)}; ambiguous original blocks: ${esc(capture.coverage.unallocatedOriginCount)}.</p>
<h3>Workforce capture sources</h3><p>These citations belong to the regional capture, separately from planning feature and scorecard sources.</p>${capture.sources.map((source) => `<section><h4>${esc(source.name)}</h4><p>Source ID: ${esc(source.id)} · ${esc(source.vintage)} · ${esc(source.kind)} · ${esc(source.license)}</p>${source.description ? `<p>${esc(source.description)}</p>` : ""}${source.url ? `<p>${esc(source.url)}</p>` : ""}</section>`).join("")}
${[...capture.notes, ...capture.coverage.cohort.notes, ...capture.network.notes].map((note) => `<p>${esc(note)}</p>`).join("")}
<p>Capture SHA-256: ${esc(evidence.captureHash)}<br>Original artifact SHA-256: ${esc(capture.artifactHash)}<br>Source pack SHA-256: ${esc(capture.cohortPackHash)}<br>Graph SHA-256: ${esc(capture.network.graphHash)}<br>Profile SHA-256: ${esc(capture.network.profileHash)}<br>Contour archive SHA-256: ${esc(capture.contour.sha256)}</p>
<p>Exact regional contours are archived separately and are not included in this browser report. Hashes and job receipts identify retained evidence but do not independently authenticate an imported file. This export does not establish empirical calibration.</p>
<details><summary>Exact saved workforce evidence</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(evidence, null, 2))}</pre></details>`;
}
