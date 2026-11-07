import { useMemo } from "react";
import { ArrowUpRight, Download, ShoppingBag } from "lucide-react";
import { USER_RETAIL_SOURCE } from "@urban/core";
import type {
  Place,
  RetailMeasure,
  RetailScenario,
  Scenario,
  Source,
} from "@urban/core";
import {
  MODEL_VERSION,
  resolveRetail,
  type RetailResolution,
} from "@urban/models";
import { download } from "../../lib/api";
import {
  RetailCalculation,
  retailMoney,
  retailCount,
} from "./RetailCalculation";
import { retailSourceIds } from "./draft";
import "./retail.css";

export function useRetailPreview(
  place: Place,
  scenario: Scenario,
  modelVersion?: string,
) {
  return useMemo(() => {
    if (modelVersion && modelVersion !== MODEL_VERSION)
      return {
        resolution: null,
        error:
          "This snapshot uses a different model version. The frozen evidence is shown below; current formulas have not been substituted.",
      };
    try {
      return { resolution: resolveRetail(place, scenario), error: "" };
    } catch (error) {
      return {
        resolution: null,
        error:
          error instanceof Error
            ? error.message
            : "Retail calculation unavailable.",
      };
    }
  }, [place, scenario, modelVersion]);
}
export function RetailResultsTable({
  resolution,
  onSelect,
}: {
  resolution: RetailResolution;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="retail-results">
      <div className="retail-result-heading">
        <h3>Category results</h3>
        <span>
          {resolution.coverage.completeCategories} of{" "}
          {resolution.coverage.categories} monetary categories complete
        </span>
      </div>
      <table className="retail-results-table">
        <caption>
          Annual USD at the stated dollar year. Gaps are signed estimates, not
          observed leakage.
        </caption>
        <thead>
          <tr>
            <th>Category</th>
            <th>Baseline gap</th>
            <th>Net additional sales</th>
            <th>Remaining gap</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {resolution.categories.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                {onSelect ? (
                  <button
                    type="button"
                    className="retail-category-link"
                    onClick={() => onSelect(row.id)}
                  >
                    {row.name || "Unnamed category"}
                    <ArrowUpRight size={13} />
                  </button>
                ) : (
                  row.name
                )}
                <small>{row.code}</small>
              </th>
              <td data-label="Baseline gap">{retailMoney(row.baselineGap)}</td>
              <td data-label="Net additional sales">
                {retailMoney(row.netNewSales)}
              </td>
              <td data-label="Remaining gap">{retailMoney(row.scenarioGap)}</td>
              <td data-label="Evidence">
                <span className={`retail-status is-${row.status}`}>
                  {row.status === "ready"
                    ? "Monetary inputs complete"
                    : row.status === "incomplete"
                      ? "Partial inputs"
                      : "Unavailable"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="retail-totals">
        <div>
          <span>Net additional local sales</span>
          <strong>{retailMoney(resolution.totals.netNewSales)}</strong>
          <small>All entered categories</small>
        </div>
        <div>
          <span>Remaining signed gap</span>
          <strong>{retailMoney(resolution.totals.scenarioGap)}</strong>
          <small>Demand less estimated sales</small>
        </div>
        <div>
          <span>Establishment equivalents</span>
          <strong>
            {retailCount(resolution.totals.scenarioEstablishmentEquivalent)}
          </strong>
          <small>Screening measure, not openings</small>
        </div>
      </div>
      {resolution.coverage.completeCategories <
        resolution.coverage.categories && (
        <p className="retail-note">
          Partial known subtotal:{" "}
          {retailMoney(resolution.knownSubtotal.netNewSales)} net additional
          sales. Missing categories are not zero; this subtotal is not a
          complete market total.
        </p>
      )}
      {resolution.warnings.length > 0 && (
        <details className="retail-limitations">
          <summary>Method & limitations ({resolution.warnings.length})</summary>
          <ul>
            {resolution.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
export function RetailContext({ retail }: { retail: RetailScenario }) {
  const context = retail.context;
  return (
    <div className="retail-context-strip">
      <div>
        <strong>{context.geography}</strong>
        <span>
          {context.relationshipToStudyArea === "same-area"
            ? "Declared same study area"
            : "Context only · different geography"}
        </span>
      </div>
      <div>
        <strong>
          {context.referenceYear} evidence · {context.dollarYear} USD
        </strong>
        <span>
          {context.classification.system} {context.classification.version} ·
          Horizon {context.horizon} years
        </span>
      </div>
    </div>
  );
}
const measureLabel = (measure: RetailMeasure) =>
  measure.status === "available"
    ? retailMoney(measure.value)
    : measure.status === "suppressed"
      ? "Suppressed by source"
      : "Missing";
function SourceRecord({ source }: { source: Source }) {
  return (
    <article className="retail-source-record">
      <strong>{source.name}</strong>
      <p>
        {source.vintage} · {source.kind} · {source.license}
      </p>
      {source.description && <p>{source.description}</p>}
      {/^https?:\/\//i.test(source.url) ? (
        <a href={source.url} target="_blank" rel="noreferrer">
          Open source citation <ArrowUpRight size={13} />
        </a>
      ) : source.url ? (
        <p>{source.url}</p>
      ) : (
        <p>No web link supplied.</p>
      )}
    </article>
  );
}
export function RetailEvidence({
  place,
  scenario,
  resolution,
}: {
  place: Place;
  scenario: Scenario;
  resolution: RetailResolution | null;
}) {
  const retail = scenario.retail;
  if (!retail) return null;
  const sources = new Map(
    [...place.sources, ...(scenario.sources ?? []), USER_RETAIL_SOURCE].map(
      (source) => [source.id, source],
    ),
  );
  return (
    <div className="retail-evidence">
      {retail.categories.map((category) => (
        <details className="retail-category-evidence" key={category.id}>
          <summary>
            {category.name}{" "}
            <span>{category.code} · Evidence & assumptions</span>
          </summary>
          <dl className="retail-evidence-values">
            {(
              [
                ["Baseline resident demand", category.baselineDemand],
                ["Baseline local sales", category.baselineSales],
                [
                  "Annual sales per establishment",
                  category.salesPerEstablishment,
                ],
              ] as const
            ).map(([label, measure]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {measureLabel(measure)}
                  <small>
                    {measure.sourceId
                      ? (sources.get(measure.sourceId)?.name ??
                        measure.sourceId)
                      : "No source supplied"}
                    {measure.note ? ` · ${measure.note}` : ""}
                  </small>
                </dd>
              </div>
            ))}
            <div>
              <dt>Scenario resident demand</dt>
              <dd>
                {category.scenarioDemand === null
                  ? "Keep captured demand"
                  : retailMoney(category.scenarioDemand)}
              </dd>
            </div>
            <div>
              <dt>Added annual sales capacity</dt>
              <dd>{retailMoney(category.annualSalesCapacity)}</dd>
            </div>
            <div>
              <dt>Capture / displacement</dt>
              <dd>
                {category.captureShare * 100}% /{" "}
                {category.displacementShare * 100}%
              </dd>
            </div>
          </dl>
          {resolution?.categories.find((row) => row.id === category.id) && (
            <RetailCalculation
              row={resolution.categories.find((row) => row.id === category.id)!}
            />
          )}
        </details>
      ))}
      <details className="retail-limitations">
        <summary>Citations & reuse declarations</summary>
        {[...retailSourceIds(retail)].map((id) => (
          <div key={id}>
            {sources.get(id) ? (
              <SourceRecord source={sources.get(id)!} />
            ) : (
              <p>{id} · Source record unavailable</p>
            )}
            {retail.sourceRights.find((right) => right.sourceId === id) && (
              <p className="retail-note">
                {
                  retail.sourceRights.find((right) => right.sourceId === id)!
                    .statement
                }{" "}
                ·{" "}
                {retail.sourceRights.find((right) => right.sourceId === id)!
                  .publicRedistribution
                  ? "Public redistribution declared permitted"
                  : "Private analysis only"}
              </p>
            )}
          </div>
        ))}
      </details>
    </div>
  );
}
export function RetailPanel({
  place,
  scenario,
  modelVersion,
  onOpen,
}: {
  place: Place;
  scenario: Scenario;
  modelVersion?: string;
  onOpen: () => void;
}) {
  const { resolution, error } = useRetailPreview(place, scenario, modelVersion);
  return (
    <section className="retail-panel" aria-label="Retail gap summary">
      <div className="retail-panel-icon">
        <ShoppingBag size={22} />
      </div>
      <h3>Room for local business.</h3>
      <p>
        Compare cited resident demand with local sales, one category at a time.
      </p>
      {scenario.retail ? (
        <>
          <div className="retail-panel-number">
            <span>Net additional local sales</span>
            <strong>{retailMoney(resolution?.totals.netNewSales)}</strong>
            <small>
              {scenario.retail.categories.length} categories · annual USD
            </small>
          </div>
          {resolution?.status === "stale" && (
            <p className="retail-warning">
              This study’s horizon differs from the current scenario. Review it
              before using scenario results.
            </p>
          )}
          {error && <p className="retail-warning">{error}</p>}
        </>
      ) : (
        <p className="retail-note">
          No retail evidence entered yet. Missing estimates stay unavailable.
        </p>
      )}
      <button
        type="button"
        className="button primary full-width"
        onClick={onOpen}
      >
        {scenario.retail ? "Open retail workbench" : "Set up retail evidence"}
        <ArrowUpRight size={15} />
      </button>
      <p className="retail-note">
        Potential unmet demand is not proof of spending leakage or a business
        opening.
      </p>
    </section>
  );
}
/** Author-entered text is inert in spreadsheets; numbers retain their numeric type. */
export function retailCSVCell(value: unknown) {
  const text = value == null ? "" : String(value);
  const safe =
    typeof value === "string" &&
    (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))
      ? `'${text}`
      : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function retailCSV(
  place: Place,
  scenario: Scenario,
  resolution: RetailResolution,
) {
  const retail = scenario.retail!;
  const sources = new Map(
    [...place.sources, ...(scenario.sources ?? []), USER_RETAIL_SOURCE].map(
      (source) => [source.id, source],
    ),
  );
  const citation = (id?: string) => {
    if (!id) return "";
    const source = sources.get(id),
      rights = retail.sourceRights.find((right) => right.sourceId === id);
    return JSON.stringify({
      id,
      ...(source ?? {}),
      ...(rights ? { rights } : {}),
    });
  };
  const rows: unknown[][] = [
    [
      "Category",
      "Code",
      "Status",
      "Geography",
      "Geography relationship",
      "Reference year",
      "Dollar year",
      "Currency",
      "Classification",
      "Classification version",
      "Horizon",
      "Scenario revision",
      "Model version",
      "Demand status",
      "Demand",
      "Demand citation",
      "Sales status",
      "Sales",
      "Sales citation",
      "Benchmark status",
      "Sales per establishment",
      "Benchmark citation",
      "Scenario demand override",
      "Annual added capacity",
      "Capture share",
      "Displacement share",
      "Baseline gap",
      "Eligible gap",
      "Gross captured sales",
      "Displaced sales",
      "Net additional sales",
      "Scenario sales",
      "Remaining signed gap",
      "Remaining establishment equivalents",
      "Warnings",
      "Study status",
      "Resolved scenario demand",
      "Baseline establishment equivalents",
      "Assumption citation",
      "Demand note",
      "Sales note",
      "Benchmark note",
    ],
  ];
  for (const category of retail.categories) {
    const row = resolution.categories.find((item) => item.id === category.id)!;
    rows.push([
      category.name,
      category.code,
      row.status,
      retail.context.geography,
      retail.context.relationshipToStudyArea,
      retail.context.referenceYear,
      retail.context.dollarYear,
      retail.context.currency,
      retail.context.classification.system,
      retail.context.classification.version,
      retail.context.horizon,
      scenario.revision,
      MODEL_VERSION,
      category.baselineDemand.status,
      category.baselineDemand.value,
      citation(category.baselineDemand.sourceId),
      category.baselineSales.status,
      category.baselineSales.value,
      citation(category.baselineSales.sourceId),
      category.salesPerEstablishment.status,
      category.salesPerEstablishment.value,
      citation(category.salesPerEstablishment.sourceId),
      category.scenarioDemand,
      category.annualSalesCapacity,
      category.captureShare,
      category.displacementShare,
      row.baselineGap,
      row.eligibleGap,
      row.grossCapturedSales,
      row.displacedSales,
      row.netNewSales,
      row.scenarioSales,
      row.scenarioGap,
      row.scenarioEstablishmentEquivalent,
      [...resolution.warnings, ...row.warnings].join(" | "),
      resolution.status,
      row.scenarioDemand,
      row.baselineEstablishmentEquivalent,
      citation(category.assumptionSourceId),
      category.baselineDemand.note ?? "",
      category.baselineSales.note ?? "",
      category.salesPerEstablishment.note ?? "",
    ]);
  }
  return rows.map((row) => row.map(retailCSVCell).join(",")).join("\r\n");
}
export function RetailCSVButton({
  place,
  scenario,
  resolution,
}: {
  place: Place;
  scenario: Scenario;
  resolution: RetailResolution;
}) {
  return (
    <button
      type="button"
      className="button compact"
      onClick={() =>
        download(
          "urban-planning-retail-categories.csv",
          retailCSV(place, scenario, resolution),
          "text/csv;charset=utf-8",
        )
      }
    >
      <Download size={14} /> Retail categories · CSV
    </button>
  );
}
export function PublishedRetail({
  place,
  scenario,
  modelVersion,
}: {
  place: Place;
  scenario: Scenario;
  modelVersion: string;
}) {
  const { resolution, error } = useRetailPreview(place, scenario, modelVersion);
  if (!scenario.retail) return null;
  return (
    <section className="retail-published" aria-label="Frozen retail evidence">
      <h3>Retail opportunity evidence</h3>
      <RetailContext retail={scenario.retail} />
      <p className="retail-note">
        Frozen category evidence and authored assumptions. No observed leakage,
        future openings or automatic fiscal effects are claimed.
      </p>
      {error && <p className="retail-warning">{error}</p>}
      {resolution && <RetailResultsTable resolution={resolution} />}
      <RetailEvidence
        place={place}
        scenario={scenario}
        resolution={resolution}
      />
      {resolution && (
        <RetailCSVButton
          place={place}
          scenario={scenario}
          resolution={resolution}
        />
      )}
    </section>
  );
}
