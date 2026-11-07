import { createHash } from "node:crypto";
import {
  canonicalJSON,
  USER_ACTIVITY_SOURCE,
  USER_RETAIL_SOURCE,
  landUseLabels,
  type Assumptions,
  type LandUse,
  type MetricResult,
  type Source,
} from "@urban/core";
import { formatMetric } from "@urban/models";
import type { ReportSnapshot } from "./exports";
import { floodReportInventory } from "./report-flood";

export const headlineIds = [
  "housing.units",
  "economy.jobs",
  "economy.payroll",
  "mobility.dailyTrips",
  "mobility.parkingDemand",
  "fiscal.netAnnual",
];
export const reportPlanningSources = (snapshot: ReportSnapshot) => [
  ...new Map(
    [
      ...snapshot.place.sources,
      ...(snapshot.scenario.sources ?? []),
      ...(snapshot.place.vehicleAvailability
        ? [snapshot.place.vehicleAvailability.source]
        : []),
      ...(snapshot.scenario.activity ? [USER_ACTIVITY_SOURCE] : []),
      ...(snapshot.scenario.retail ? [USER_RETAIL_SOURCE] : []),
      ...(snapshot.scenario.activity?.vehicleReference
        ? [snapshot.scenario.activity.vehicleReference.source]
        : []),
    ].map((source) => [source.id, source]),
  ).values(),
];
/** Independent evidence inventories never replace planning citations with colliding IDs. */
export const reportSources = (snapshot: ReportSnapshot) => {
  const planning = reportPlanningSources(snapshot);
  const ids = new Set(planning.map((source) => source.id));
  const evidence = [
    ["fiscal profile", snapshot.project.fiscalStudy?.profile.sources ?? []],
    [
      "flood",
      (snapshot.scenario.flood
        ? snapshot.project.floodDatasets?.[snapshot.scenario.flood.datasetHash]
            ?.sources
        : undefined) ?? [],
    ],
    [
      "jobs accessibility car",
      snapshot.scenario.accessibility?.captures.car?.capture.sources ?? [],
    ],
    [
      "jobs accessibility walk",
      snapshot.scenario.accessibility?.captures.walk?.capture.sources ?? [],
    ],
    ["workforce", snapshot.scenario.workforce?.capture.sources ?? []],
    ["traffic", snapshot.scenario.traffic?.capture.sources ?? []],
    [
      "traffic planning correspondence",
      snapshot.scenario.traffic?.capture.proposal.planningRoadMapping
        .correspondence?.sources ?? [],
    ],
  ] as const;
  return [
    ...planning,
    ...evidence.flatMap(([namespace, sources]) =>
      sources.map((source) => {
        const result = ids.has(source.id)
          ? { ...source, name: `${source.name} (${namespace} capture)` }
          : source;
        ids.add(source.id);
        return result;
      }),
    ),
  ];
};
export const reportDigest = (snapshot: ReportSnapshot) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        place: snapshot.place,
        scenario: snapshot.scenario,
        model: snapshot.results.modelVersion,
        ...(snapshot.project.fiscalStudy
          ? { fiscalStudy: snapshot.project.fiscalStudy }
          : {}),
        ...(snapshot.scenario.flood
          ? {
              floodDataset:
                snapshot.project.floodDatasets?.[
                  snapshot.scenario.flood.datasetHash
                ],
            }
          : {}),
      }),
    )
    .digest("hex");
export const display = (value: number | null, unit: string) => {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (value === 0) return formatMetric(0, unit);
  const formatted = formatMetric(value, unit);
  // Preserve a small, real change when ordinary display precision rounds it to zero.
  if (Number(formatted.replace(/[^0-9.+-]/g, "")) !== 0) return formatted;
  const precise = new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 2,
    ...(unit.startsWith("$") || unit === "USD"
      ? { style: "currency", currency: "USD" }
      : {}),
  }).format(value);
  return unit === "%" || unit === "percent" ? `${precise}%` : precise;
};
export const statusLabel = (status: MetricResult["status"]) =>
  ({
    ready: "Calculated",
    incomplete: "Limited inputs",
    unavailable: "Unavailable",
  })[status];
export const displayChange = (metric: MetricResult) =>
  metric.delta === null
    ? "Unavailable"
    : `${metric.delta > 0 ? "+" : ""}${display(metric.delta, metric.unit)}`;
export const inputNotes = (metric: MetricResult) => {
  const grouped = new Map<string, string[]>();
  for (const input of metric.inputs) {
    const values = grouped.get(input.source) ?? [];
    values.push(`${input.name}: ${input.value}`);
    grouped.set(input.source, values);
  }
  return [
    ...[...grouped].map(
      ([source, values]) => `${values.join("; ")}. Source: ${source}`,
    ),
    ...(!metric.coverage
      ? []
      : (["baseline", "scenario"] as const).map((side) => {
          const c = metric.coverage![side];
          if (!c.missingBuildingIds.length)
            return `${side === "baseline" ? "Baseline" : "Proposal"} completeness: no required ${metric.id === "environment.flood" ? "building quantities or mapped exposure classifications" : "building attributes"} are missing for this measure.`;
          return `${side === "baseline" ? "Baseline" : "Proposal"} completeness: ${c.missingBuildingIds.length} building(s) lack required ${metric.id === "environment.flood" ? "home counts or mapped exposure classifications" : "attributes"}.${"knownSubtotal" in c ? ` Known subtotal: ${display(c.knownSubtotal ?? null, metric.unit)}; not a complete total.` : ""} Complete missing-ID lists are retained in the result JSON, CSV and workbook.`;
        })),
  ];
};
export function assertReportSnapshot(snapshot: ReportSnapshot) {
  if (
    snapshot.results.scenarioId !== snapshot.scenario.id ||
    snapshot.results.revision !== snapshot.scenario.revision ||
    snapshot.results.metrics.some(
      (metric) => metric.scenarioRevision !== snapshot.scenario.revision,
    )
  )
    throw new Error(
      "The report results do not match the requested saved scenario revision.",
    );
  const flood = floodReportInventory(snapshot);
  if (flood) {
    const metric = snapshot.results.metrics.find(
      (row) => row.id === "environment.flood",
    );
    const { baseline, scenario } = flood.resolution;
    const delta =
      baseline.value === null || scenario.value === null
        ? null
        : scenario.value - baseline.value;
    if (
      !metric ||
      metric.baseline !== baseline.value ||
      metric.value !== scenario.value ||
      metric.delta !== delta
    )
      throw new Error(
        "The flood scorecard does not reproduce from this report's exact retained map and building geometry.",
      );
  }
  const maps = snapshot.maps;
  if (maps) {
    const baseline = snapshot.project.scenarios.find(
      (scenario) => scenario.id === "baseline",
    );
    if (
      !baseline ||
      maps.proposal.scenarioId !== snapshot.scenario.id ||
      maps.proposal.revision !== snapshot.scenario.revision ||
      maps.baseline.scenarioId !== baseline.id ||
      maps.baseline.revision !== baseline.revision
    )
      throw new Error(
        "The comparison maps do not match the report scenario and baseline.",
      );
    const sha = (input: string | Buffer) =>
      createHash("sha256").update(input).digest("hex");
    const baselineHash = sha(canonicalJSON(snapshot.place));
    if (
      maps.metadata.floodDatasetHash !== snapshot.scenario.flood?.datasetHash ||
      maps.metadata.baselineHash !== baselineHash ||
      maps.metadata.inputHash !==
        sha(
          canonicalJSON({
            rendererVersion: maps.metadata.rendererVersion,
            baselineHash,
            baselineScenario: baseline,
            proposalScenario: snapshot.scenario,
            projection: maps.metadata.projection,
            ...(snapshot.scenario.flood
              ? { floodDatasetHash: snapshot.scenario.flood.datasetHash }
              : {}),
          }),
        )
    )
      throw new Error(
        "The comparison map inputs do not match this report snapshot.",
      );
    for (const panel of [maps.baseline, maps.proposal]) {
      if (!Buffer.isBuffer(panel.png) || sha(panel.png) !== panel.sha256)
        throw new Error(
          "A comparison map image does not match its declared hash.",
        );
      if (
        panel.png.length < 24 ||
        panel.png.readUInt32BE(16) !== maps.metadata.width ||
        panel.png.readUInt32BE(20) !== maps.metadata.height
      )
        throw new Error(
          "A comparison map image does not match its declared dimensions.",
        );
    }
  }
}
export function decisionBrief(snapshot: ReportSnapshot) {
  const { scenario, results } = snapshot;
  const change = headlineIds.flatMap((id) =>
    results.metrics.filter(
      (metric) =>
        metric.id === id && metric.delta !== null && metric.delta !== 0,
    ),
  );
  const lead = change.length
    ? `Compared with the frozen baseline, this scenario changes ${change
        .slice(0, 3)
        .map(
          (metric) =>
            `${metric.label.toLowerCase()} by ${displayChange(metric)}`,
        )
        .join(", ")}.`
    : "No change is calculated in the available priority measures at this revision. Unavailable measures cannot be interpreted as no impact.";
  const limited = results.metrics.filter(
    (metric) => metric.status !== "ready",
  ).length;
  return [
    `This report supports a staff review of ${scenario.name}. It compares the saved proposal with its captured baseline using the same study area and the recorded assumptions. ${lead}`,
    `${limited} of ${results.metrics.length} measures have limited or unavailable inputs. Calculated results are planning estimates, not an approval recommendation or a calibrated traffic forecast. Review the methods and local evidence before deciding whether to advance the proposal.`,
  ];
}
export const interpretation =
  "Calculated means the stated method can run on the supplied inputs. Limited inputs means the result relies on incomplete coverage or illustrative assumptions. Unavailable means a necessary input is absent; it is never reported as zero. A positive change is not automatically a benefit. Large values may be abbreviated; changes are calculated before display rounding.";

type ScalarKey = Exclude<keyof Assumptions, "tripRates" | "jobsPer1000Sqft">;
const scalarLabels: Record<
  ScalarKey,
  { label: string; unit?: string; percent?: boolean; group: string }
> = {
  householdSize: {
    label: "People per occupied home",
    group: "Population and growth",
  },
  vacancyRate: {
    label: "Housing vacancy rate",
    percent: true,
    group: "Population and growth",
  },
  annualGrowthRate: {
    label: "Annual growth rate",
    percent: true,
    group: "Population and growth",
  },
  populationMultiplier: {
    label: "Population sensitivity multiplier",
    unit: "times",
    group: "Population and growth",
  },
  parkingPerUnit: {
    label: "Parking demand per home",
    unit: "spaces",
    group: "Travel and parking",
  },
  parkingPer1000Sqft: {
    label: "Parking demand per 1,000 commercial sq ft",
    unit: "spaces",
    group: "Travel and parking",
  },
  driveShare: {
    label: "Driving mode share",
    percent: true,
    group: "Travel and parking",
  },
  transitShare: {
    label: "Transit mode share",
    percent: true,
    group: "Travel and parking",
  },
  bikeShare: {
    label: "Cycling mode share",
    percent: true,
    group: "Travel and parking",
  },
  walkShare: {
    label: "Walking mode share",
    percent: true,
    group: "Travel and parking",
  },
  vehicleMultiplier: {
    label: "Vehicle sensitivity multiplier",
    unit: "times",
    group: "Travel and parking",
  },
  averageTripMiles: {
    label: "Average vehicle trip length",
    unit: "miles",
    group: "Travel and parking",
  },
  tripRatesConfirmed: {
    label: "Trip rates confirmed by the user",
    group: "Travel and parking",
  },
  annualWage: {
    label: "Annual wage per job",
    unit: "USD",
    group: "Economic and environmental inputs",
  },
  emissionsKgPerMile: {
    label: "Vehicle emissions factor",
    unit: "kg CO2e per mile",
    group: "Economic and environmental inputs",
  },
  jurisdictionName: { label: "Fiscal jurisdiction", group: "Fiscal profile" },
  fiscalInputsConfirmed: {
    label: "Fiscal profile confirmed by the user",
    group: "Fiscal profile",
  },
  assessedValuePerSqft: {
    label: "Assessed value per floor sq ft",
    unit: "USD",
    group: "Fiscal profile",
  },
  effectivePropertyTaxRate: {
    label: "Effective property tax rate",
    percent: true,
    group: "Fiscal profile",
  },
  annualServiceCostPerResident: {
    label: "Annual service cost per resident",
    unit: "USD",
    group: "Fiscal profile",
  },
  annualServiceCostPerJob: {
    label: "Annual service cost per job",
    unit: "USD",
    group: "Fiscal profile",
  },
  discountRate: {
    label: "Annual discount rate",
    percent: true,
    group: "Fiscal profile",
  },
  incentiveGrant: {
    label: "Upfront incentive grant",
    unit: "USD",
    group: "Fiscal profile",
  },
  abatementPercent: {
    label: "Property tax abatement share",
    percent: true,
    group: "Fiscal profile",
  },
  abatementYears: {
    label: "Tax abatement duration",
    unit: "years",
    group: "Fiscal profile",
  },
  salesPerSqft: {
    label: "Annual retail sales per sq ft",
    unit: "USD",
    group: "Fiscal profile",
  },
  localSalesTaxRate: {
    label: "Local sales tax rate",
    percent: true,
    group: "Fiscal profile",
  },
  retailCaptureRate: {
    label: "Local taxable sales capture fraction",
    percent: true,
    group: "Fiscal profile",
  },
};
export interface AssumptionRow {
  key: string;
  label: string;
  baseline: string;
  proposal: string;
  changed: boolean;
  group: string;
}
export function assumptionRows(snapshot: ReportSnapshot): AssumptionRow[] {
  const before = snapshot.scenario.baselineAssumptions,
    after = snapshot.scenario.assumptions;
  const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
  const rows: AssumptionRow[] = Object.entries(scalarLabels).map(
    ([rawKey, item]) => {
      const key = rawKey as ScalarKey;
      const format = (value: Assumptions[ScalarKey]) =>
        typeof value === "boolean"
          ? value
            ? "Yes"
            : "No"
          : typeof value === "number"
            ? `${item.unit === "USD" ? "$" : ""}${number.format(value * (item.percent ? 100 : 1))}${item.percent ? "%" : item.unit && item.unit !== "USD" ? ` ${item.unit}` : ""}`
            : value;
      return {
        key,
        label: item.label,
        baseline: format(before[key]),
        proposal: format(after[key]),
        changed: before[key] !== after[key],
        group: item.group,
      };
    },
  );
  for (const key of ["tripRates", "jobsPer1000Sqft"] as const)
    for (const use of Object.keys(landUseLabels) as LandUse[]) {
      const perHome = ["residential", "multifamily", "mixed-use"].includes(use);
      rows.push({
        key: `${key}.${use}`,
        label: `${landUseLabels[use]} ${key === "tripRates" ? `trips per ${perHome ? "occupied home" : "1,000 commercial sq ft"}` : "jobs per 1,000 commercial sq ft"}`,
        baseline: number.format(before[key][use]),
        proposal: number.format(after[key][use]),
        changed: before[key][use] !== after[key][use],
        group:
          key === "tripRates"
            ? "Trip rate assumptions"
            : "Employment density assumptions",
      });
    }
  return rows;
}
export function sourceReferences(
  snapshot: ReportSnapshot,
  metric: MetricResult,
) {
  const sources = reportPlanningSources(snapshot);
  const fiscalSources =
    metric.domain === "Fiscal"
      ? (snapshot.project.fiscalStudy?.profile.sources ?? [])
      : [];
  const floodSources =
    metric.id === "environment.flood" && snapshot.scenario.flood
      ? (snapshot.project.floodDatasets?.[snapshot.scenario.flood.datasetHash]
          ?.sources ?? [])
      : [];
  return metric.sourceIds.length
    ? `Source references: ${metric.sourceIds
        .map((id) => {
          const index = sources.findIndex((source) => source.id === id);
          const flood = floodSources.find((source) => source.id === id);
          const fiscal = fiscalSources.find((source) => source.id === id);
          if (fiscal)
            return `${fiscal.name} (fiscal profile source ${id}; see Fiscal study and incentive comparison)${index >= 0 ? `; planning inventory [${index + 1}] has the same source ID` : ""}`;
          if (flood)
            return `${flood.name} (flood map source ${id}; see Mapped flood exposure)${index >= 0 ? `; planning inventory [${index + 1}] has the same source ID` : ""}`;
          return index < 0
            ? `${id} (source metadata unavailable)`
            : `[${index + 1}]`;
        })
        .join(", ")}.`
    : "No external source reference is attached to this method; inspect its listed input provenance.";
}
export const groupedMetrics = (snapshot: ReportSnapshot) =>
  [...new Set(snapshot.results.metrics.map((metric) => metric.domain))].map(
    (domain) => ({
      domain,
      metrics: snapshot.results.metrics.filter(
        (metric) => metric.domain === domain,
      ),
    }),
  );
export const mapCaption = (
  snapshot: ReportSnapshot,
  side: "baseline" | "proposal",
) => {
  const panel = snapshot.maps?.[side];
  return `${side === "baseline" ? "Unedited captured source geometry" : snapshot.scenario.name}. ${panel ? `${side === "baseline" ? "Baseline" : "Saved scenario"} revision ${panel.revision}.` : ""} Both views use the same extent, scale, and projection. ${snapshot.maps?.metadata.focus.mode === "changes" ? "The maps focus on localized changes; the overview locates this view within the full study area. Scorecard calculations still cover the complete analytical boundary." : "The maps show the full captured study area."} Building heights and program may be inferred; these are plan views, not surveyed conditions.`;
};

/** Concise human-readable import provenance; complete recipes remain in structured exports. */
export function importSourceNotes(source: Source): string[] {
  const m = source.import,
    r = source.rights,
    rows: string[] = [];
  if (m) {
    rows.push(
      `Imported ${m.format}; selected layer: ${m.selection.layer}. Upload: ${m.upload.name}; ${m.upload.bytes} bytes; SHA-256 ${m.upload.sha256}. Normalized GeoJSON SHA-256 ${m.normalizedSha256}.`,
    );
    rows.push(
      `Source CRS: ${m.crs.source}. Axis order: ${m.crs.axisOrder}; coordinate unit: ${m.crs.coordinateUnit ?? "Not supplied"}; target: ${m.crs.target}. Coordinate operation: ${m.operation.name}; accuracy: ${m.operation.accuracyMeters === null ? "Unknown" : `${m.operation.accuracyMeters} m`}. Converter: ${m.converter.name} ${m.converter.version}${m.converter.projVersion ? `; PROJ ${m.converter.projVersion}` : ""}${m.converter.imageDigest ? `; image ${m.converter.imageDigest}` : ""}.`,
    );
    if (m.upload.members.length)
      rows.push(
        `Retained member files: ${m.upload.members.map((f) => `${f.name} (${f.bytes} bytes; SHA-256 ${f.sha256})`).join("; ")}.`,
      );
    if (m.exclusions.length)
      rows.push(
        `Explicit exclusions: ${m.exclusions.map((e) => `${e.count}: ${e.reason}`).join("; ")}.`,
      );
    rows.push(
      "Complete declarative mapping, coordinate-operation details, selected entity IDs and source manifests are retained in the project, GeoJSON and workbook import-provenance export. No raw upload bytes or private server paths are embedded.",
    );
  }
  if (r)
    rows.push(
      `Uploader rights attestation: private use ${r.privateUse}; cache ${r.cache}; analysis ${r.analyze}; private display ${r.privateDisplay}; export ${r.export}; historical retention ${r.historicalRetention}; public redistribution ${r.publicRedistribution}. Declared by ${r.declaredBy} at ${r.declaredAt}. This is an attestation, not independent license verification.`,
    );
  return rows;
}
