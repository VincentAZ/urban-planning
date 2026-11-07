import type { RetailCategoryResult } from "@urban/models";

export const retailMoney = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(value);
export const retailCount = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
        value,
      );

export function RetailCalculation({ row }: { row: RetailCategoryResult }) {
  return (
    <section
      className="retail-calculation"
      aria-label={`Calculation for ${row.name}`}
    >
      <span className="eyebrow">FOLLOW THE NUMBERS</span>
      <h3>{row.name || "Category preview"}</h3>
      <dl className="retail-math">
        <div>
          <dt>Scenario resident demand</dt>
          <dd>{retailMoney(row.scenarioDemand)}</dd>
        </div>
        <div>
          <dt>Baseline local sales</dt>
          <dd>{retailMoney(row.baselineSales)}</dd>
        </div>
        <div>
          <dt>Eligible unmet demand</dt>
          <dd>{retailMoney(row.eligibleGap)}</dd>
        </div>
        <div>
          <dt>Gross captured sales</dt>
          <dd>{retailMoney(row.grossCapturedSales)}</dd>
        </div>
        <div>
          <dt>Less displaced local sales</dt>
          <dd>{retailMoney(row.displacedSales)}</dd>
        </div>
        <div className="retail-math-total">
          <dt>Net additional local sales</dt>
          <dd>{retailMoney(row.netNewSales)}</dd>
        </div>
        <div>
          <dt>Estimated scenario sales</dt>
          <dd>{retailMoney(row.scenarioSales)}</dd>
        </div>
        <div>
          <dt>Remaining signed gap</dt>
          <dd>{retailMoney(row.scenarioGap)}</dd>
        </div>
        <div>
          <dt>Remaining establishment equivalents</dt>
          <dd>{retailCount(row.scenarioEstablishmentEquivalent)}</dd>
        </div>
      </dl>
      <details>
        <summary>Calculation & interpretation</summary>
        <p>Eligible unmet demand = max(scenario demand − baseline sales, 0).</p>
        <p>
          Gross capture = the smaller of eligible demand × capture share and
          added annual sales capacity. Net additional sales subtract displaced
          sales.
        </p>
        <p>
          A negative signed gap means sales exceed resident demand; it can
          reflect inbound spending. A positive gap is potential unmet demand,
          not observed spending leakage.
        </p>
        <p>
          Establishment equivalents divide remaining positive demand by a cited
          annual-sales benchmark. They are not a forecast of openings, jobs or
          site feasibility.
        </p>
      </details>
      {row.warnings.length > 0 && (
        <ul className="retail-warnings">
          {row.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
