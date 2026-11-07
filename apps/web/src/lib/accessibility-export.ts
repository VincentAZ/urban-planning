import type {
  AccessibilityCount,
  AccessibilityModeEvidence,
  Scenario,
} from "@urban/core";
const escapeHTML = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const numeric = (value: number | null) =>
  value === null ? "Unavailable" : value.toLocaleString("en-US");
const count = (value: AccessibilityCount) =>
  value.estimate !== null
    ? numeric(value.estimate)
    : value.knownSubtotal !== null
      ? `Known subtotal ${numeric(value.knownSubtotal)}`
      : "Unavailable";
const saved = (scenario: Scenario) =>
  Object.values(scenario.accessibility?.captures ?? {});
const csv = (value: unknown) => {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
/** Exact saved evidence only. Numerical zero is retained; blanks are accompanied by status. */
export function exportAccessibilityCSV(scenario: Scenario): string {
  const rows: unknown[][] = [
    [
      "scenario",
      "revision",
      "origin",
      "mode",
      "direction",
      "longitude",
      "latitude",
      "minutes",
      "family",
      "category",
      "source_cells",
      "estimate_jobs",
      "known_subtotal_jobs",
      "status",
      "unresolved_workplace_blocks",
      "unresolved_jobs",
      "upper_bound_jobs",
      "source_region",
      "lodes_year",
      "job_type",
      "job_universe",
      "network_coverage",
      "destination_coverage",
      "source_inventory_complete",
      "captured_at",
      "method_version",
      "capture_sha256",
      "jobs_pack_sha256",
      "graph_sha256",
      "profile_sha256",
      "origin_snap_meters",
      "sources_json",
      "exact_saved_evidence_json",
      "limitations",
    ],
  ];
  for (const evidence of saved(scenario)) {
    const c = evidence.capture;
    for (const threshold of c.thresholds)
      for (const [family, categories] of [
        [
          "total",
          [
            {
              ...threshold.total,
              label: "All primary jobs",
              sourceCells: ["C000"],
            },
          ],
        ],
        ["earnings", threshold.earnings],
        ["industries", threshold.industries],
      ] as const)
        for (const row of categories)
          rows.push([
            scenario.name,
            scenario.revision,
            evidence.origin,
            c.request.mode,
            c.request.direction,
            ...c.request.site,
            threshold.minutes,
            family,
            row.label,
            row.sourceCells.join(";"),
            row.estimate,
            row.knownSubtotal,
            row.status,
            row.unresolvedDestinationCount,
            row.unresolvedJobs,
            row.upperBound,
            c.source.region.label,
            c.source.lodes.year,
            c.source.lodes.jobType,
            "Primary jobs at workplaces; not vacancies or distinct employers",
            c.coverage.network,
            c.coverage.destinations.status,
            c.coverage.regionDataComplete,
            c.capturedAt,
            c.methodVersion,
            evidence.captureHash,
            c.jobsPackHash,
            c.network.graphHash,
            c.network.profileHash,
            c.siteSnapMeters,
            JSON.stringify(c.sources),
            JSON.stringify(evidence),
            "Cumulative thresholds and category families must not be added. Captured outbound source network; no proposed road/building/growth effects or scenario delta. No sampling margin supplied. Imported evidence is not server-verified.",
          ]);
  }
  return rows.map((row) => row.map(csv).join(",")).join("\r\n");
}
function modeHTML(evidence: AccessibilityModeEvidence) {
  const c = evidence.capture;
  return `<section><h3>${c.request.mode === "car" ? "Driving" : "Walking"} · outbound</h3><p>${escapeHTML(evidence.origin === "imported" ? "Imported evidence — not verified by this server" : "Captured analysis")} · ${escapeHTML(c.source.region.label)} · LODES ${c.source.lodes.year} ${escapeHTML(c.source.lodes.jobType)} primary jobs · Origin ${escapeHTML(c.request.site.join(", "))} · Captured ${escapeHTML(c.capturedAt)}.</p><table><thead><tr><th>Travel limit</th><th>Primary jobs</th><th>Status</th><th>Unresolved jobs</th><th>Upper bound</th></tr></thead><tbody>${c.thresholds.map((t) => `<tr><td>${t.minutes} min</td><td>${escapeHTML(count(t.total))}</td><td>${escapeHTML(t.total.status)}</td><td>${escapeHTML(numeric(t.total.unresolvedJobs))}</td><td>${escapeHTML(numeric(t.total.upperBound))}</td></tr>`).join("")}</tbody></table>${(["earnings", "industries"] as const).map((family) => `<h4>${family === "earnings" ? "Source-year monthly earnings" : "Workplace industry"}</h4><table><thead><tr><th>Category</th><th>Travel limit</th><th>Primary jobs</th><th>Status</th><th>Unresolved jobs</th></tr></thead><tbody>${c.thresholds.flatMap((t) => t[family].map((row) => `<tr><th>${escapeHTML(row.label)}</th><td>${t.minutes} min</td><td>${escapeHTML(count(row))}</td><td>${escapeHTML(row.status)}</td><td>${escapeHTML(numeric(row.unresolvedJobs))}</td></tr>`)).join("")}</tbody></table>`).join("")}
<p>Network coverage: ${escapeHTML(c.coverage.network)}. Destination coverage: ${escapeHTML(c.coverage.destinations.status)}. Retained workplace blocks: ${c.coverage.destinationCount}; primary jobs in the full source region: ${c.coverage.sourceJobs} (not the catchment total). Origin to routing connection: ${c.siteSnapMeters} m; no entrance or exact snapped coordinate is established.</p><p>${escapeHTML(c.methodVersion)} · ${escapeHTML(c.network.engine)} ${escapeHTML(c.network.engineVersion)} · ${escapeHTML(c.network.costing)} network.</p>${[...c.notes, ...c.network.notes, ...c.coverage.destinations.notes].map((note) => `<p>${escapeHTML(note)}</p>`).join("")}<h4>Capture sources</h4>${c.sources.map((source) => `<section><strong>${escapeHTML(source.name)}</strong><p>${escapeHTML(source.vintage)} · ${escapeHTML(source.license)} · ${escapeHTML(source.kind)}</p><p>${escapeHTML(source.description)} ${escapeHTML(source.url)}</p></section>`).join("")}<p>Capture SHA-256: ${escapeHTML(evidence.captureHash)}<br>Jobs pack SHA-256: ${escapeHTML(c.jobsPackHash)}<br>Graph SHA-256: ${escapeHTML(c.network.graphHash)}<br>Profile SHA-256: ${escapeHTML(c.network.profileHash)}<br>Contour SHA-256: ${escapeHTML(c.contour.sha256)}</p><details><summary>Exact saved jobs accessibility evidence</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(JSON.stringify(evidence, null, 2))}</pre></details></section>`;
}
export function accessibilityHTML(scenario: Scenario): string {
  const captures = saved(scenario);
  if (!captures.length) return "";
  const [a, b] = captures;
  const mismatch =
    a &&
    b &&
    (a.capture.request.site[0] !== b.capture.request.site[0] ||
      a.capture.request.site[1] !== b.capture.request.site[1]);
  return `<h2>Jobs accessibility from the origin</h2><p class="notice">Frozen captured-network context, not a baseline-to-proposal effect. Proposed streets, signals, buildings, activity changes and future horizons are not applied. This is outbound access to workplace primary jobs, not inbound workforce, vacancies or distinct employers.</p>${mismatch ? "<p>Driving and walking use different origins. They are not a same-origin mode comparison.</p>" : ""}<p>Travel limits are cumulative. Earnings and industry each describe the same total and must not be added together. A known subtotal omits unresolved evidence; an upper bound is not a forecast or confidence interval. No sampling margin is supplied. Workplace locations are Census block representative points, not entrances. Regional contours remain in a separate archive and are not reconstructed from counts.</p>${captures.map(modeHTML).join("")}`;
}
