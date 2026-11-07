import type {
  HousingAffordabilityResolution,
  HousingAffordabilitySide,
  HousingIncomeLimitCatalog,
  Scenario,
} from "@urban/core";
import { HousingAreaEvidence } from "./HousingAreas";
import "./housing.css";
export const housingBandLabels = {
  extremelyLow: "Extremely low",
  veryLow: "Very low",
  low: "Low",
};
const n = (value: number | null | undefined) =>
  value == null ? "Unknown" : value.toLocaleString();
const dollars = (value: number | null) =>
  value === null
    ? "Unknown"
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });
function Capacity({
  side,
  label,
}: {
  side: HousingAffordabilitySide;
  label: string;
}) {
  return (
    <section className="housing-card">
      <h4>{label} coverage</h4>
      <dl className="housing-summary">
        <div>
          <dt>Total homes</dt>
          <dd>{n(side.totalUnits)}</dd>
        </div>
        <div>
          <dt>Known home subtotal</dt>
          <dd>{n(side.knownUnits)}</dd>
        </div>
        <div>
          <dt>Assigned to groups</dt>
          <dd>{n(side.assignedUnits)}</dd>
        </div>
        <div>
          <dt>Evaluated homes</dt>
          <dd>{n(side.evaluatedUnits)}</dd>
        </div>
        <div>
          <dt>Unassigned homes</dt>
          <dd>{n(side.unassignedUnits)}</dd>
        </div>
        <div>
          <dt>Unresolved assigned homes</dt>
          <dd>{n(side.unresolvedAssignedUnits)}</dd>
        </div>
        <div>
          <dt>Buildings with unknown capacity</dt>
          <dd>{side.unknownUnitBuildingIds.length}</dd>
        </div>
      </dl>
    </section>
  );
}
export function HousingResults({
  result,
  onSelectBuilding,
}: {
  result: HousingAffordabilityResolution;
  onSelectBuilding?: (id: string) => void;
}) {
  return (
    <section className="housing-results">
      <div className="housing-result-heading">
        <h3>Homes and published income limits</h3>
        <span className="badge">
          {result.status === "ready"
            ? "Reviewed"
            : result.status === "stale"
              ? "Review required"
              : "Incomplete evidence"}
        </span>
      </div>
      <p>
        Affordable means annual housing costs (monthly total × 12) are no more
        than 30% of the published annual limit for the chosen household size.
        This is a cost comparison, not subsidy eligibility or a count of actual
        household incomes.
      </p>
      {result.notes.length > 0 && (
        <details open={result.status !== "ready"}>
          <summary>Coverage and review notes</summary>
          <ul>
            {result.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="housing-band-cards">
        {(["extremelyLow", "veryLow", "low"] as const).map((key) => (
          <section className="housing-card" key={key}>
            <h4>
              Affordable at {housingBandLabels[key].toLowerCase()} income limit
            </h4>
            <dl className="housing-comparison">
              <div>
                <dt>Baseline</dt>
                <dd>{n(result.baseline.cumulative[key].estimate)}</dd>
                <small>
                  Known subtotal{" "}
                  {n(result.baseline.cumulative[key].knownSubtotal)}
                </small>
              </div>
              <div>
                <dt>Proposal</dt>
                <dd>{n(result.proposal.cumulative[key].estimate)}</dd>
                <small>
                  Known subtotal{" "}
                  {n(result.proposal.cumulative[key].knownSubtotal)}
                </small>
              </div>
              <div>
                <dt>Change</dt>
                <dd>{n(result.delta[key])}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>
      <p className="muted">
        Cumulative thresholds overlap; do not add these three counts.
      </p>
      <div className="housing-fields">
        <Capacity side={result.baseline} label="Baseline" />
        <Capacity side={result.proposal} label="Proposal" />
      </div>
      {(["baseline", "proposal"] as const).map((side) => (
        <section key={side}>
          <h4>{side === "baseline" ? "Baseline" : "Proposal"} group details</h4>
          {result[side].rows.length ? (
            <div className="housing-group-results">
              {result[side].rows.map((row) => (
                <details key={row.groupId} className="housing-card">
                  <summary>
                    {row.units} homes · {row.buildingId} ·{" "}
                    {row.status === "ready"
                      ? `Monthly costs ${dollars(row.grossMonthlyCents === null ? null : row.grossMonthlyCents / 100)}`
                      : row.status}
                  </summary>
                  <dl className="housing-summary">
                    <div>
                      <dt>Tenure / household size</dt>
                      <dd>
                        {row.tenure === "rent" ? "Rental" : "Ownership"} ·{" "}
                        {row.householdSize}{" "}
                        {row.householdSize === 1 ? "person" : "people"}
                      </dd>
                    </div>
                    <div>
                      <dt>HUD area</dt>
                      <dd>{row.areaName ?? "Unavailable"}</dd>
                    </div>
                    <div>
                      <dt>Income-limit / cost year</dt>
                      <dd>
                        {row.fiscalYear ?? "Unknown"} / {row.costYear}
                      </dd>
                    </div>
                    <div>
                      <dt>Gross monthly housing cost</dt>
                      <dd>
                        {dollars(
                          row.grossMonthlyCents === null
                            ? null
                            : row.grossMonthlyCents / 100,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Known monthly cost subtotal</dt>
                      <dd>{dollars(row.knownMonthlyCents / 100)}</dd>
                    </div>
                    <div>
                      <dt>Required annual income</dt>
                      <dd>{dollars(row.requiredAnnualIncome)}</dd>
                    </div>
                  </dl>
                  <p>
                    {row.areaOrigin === "imported"
                      ? "Imported income-limit evidence · not verified by this server."
                      : "Captured published income-limit area; costs are separately reviewed inputs."}
                  </p>
                  {(["extremelyLow", "veryLow", "low"] as const).map((key) => (
                    <p key={key}>
                      {housingBandLabels[key]} income limit:{" "}
                      {row.limits ? dollars(row.limits[key]) : "Unknown"} ·{" "}
                      {row.affordableAt[key] === null
                        ? "Unresolved"
                        : row.affordableAt[key]
                          ? "Within cost threshold"
                          : "Above cost threshold"}
                    </p>
                  ))}
                  {row.reasons.map((r, i) => (
                    <p key={i}>{r}</p>
                  ))}
                  {row.missingCostKinds.length > 0 && (
                    <p>
                      Unknown cost components: {row.missingCostKinds.join(", ")}
                    </p>
                  )}
                  {onSelectBuilding && (
                    <button
                      type="button"
                      onClick={() => onSelectBuilding(row.buildingId)}
                    >
                      Show building {row.buildingId} on map
                    </button>
                  )}
                  <details>
                    <summary>Exact group evidence</summary>
                    <pre>{JSON.stringify(row, null, 2)}</pre>
                  </details>
                </details>
              ))}
            </div>
          ) : (
            <p>No groups assigned.</p>
          )}
        </section>
      ))}
      <details>
        <summary>Method and exact calculation identity</summary>
        <p>
          {result.methodVersion} · review {result.reviewState}
        </p>
        <code>{result.inputHash}</code>
      </details>
    </section>
  );
}
export function HousingAffordabilityPanel({
  scenario,
  result,
  onOpen,
}: {
  scenario: Scenario;
  result?: HousingAffordabilityResolution;
  onOpen: () => void;
}) {
  return (
    <section className="housing-panel">
      <div>
        <strong>Housing affordability</strong>
        <span className="badge">
          {scenario.affordability
            ? result?.status === "ready"
              ? "Reviewed unit groups"
              : "Review coverage"
            : "Add unit-level evidence"}
        </span>
      </div>
      <p>
        Compare complete housing costs with published HUD limits for an explicit
        household size.
      </p>
      {result && (
        <p>
          {n(result.proposal.evaluatedUnits)} proposal homes evaluated ·{" "}
          {n(result.proposal.unassignedUnits)} unassigned
        </p>
      )}
      <button type="button" onClick={onOpen}>
        Review housing affordability
      </button>
    </section>
  );
}
export function HousingEvidenceSources({
  scenario,
  packs,
}: {
  scenario: Scenario;
  packs?: HousingIncomeLimitCatalog;
}) {
  if (!scenario.affordability) return null;
  const hashes = [
    ...new Set(
      [
        ...scenario.affordability.baselineGroups,
        ...scenario.affordability.proposalGroups,
      ].map((g) => g.areaHash),
    ),
  ];
  return (
    <details className="housing-published">
      <summary>Housing income-limit areas and cost citations</summary>
      {hashes.map((hash) =>
        packs?.[hash] ? (
          <HousingAreaEvidence key={hash} pack={packs[hash]} />
        ) : (
          <p key={hash}>Income-limit pack unavailable: {hash}</p>
        ),
      )}
      <h4>Housing cost citations</h4>
      {scenario.affordability.sources.map((s) => (
        <p key={s.id}>
          <strong>{s.name}</strong> · {s.vintage} · {s.license}
          <br />
          {/^https?:\/\//iu.test(s.url ?? "") && (
            <a href={s.url} target="_blank" rel="noreferrer">
              Source
            </a>
          )}
        </p>
      ))}
      <p>
        Reviewed by {scenario.affordability.review.reviewedBy} ·{" "}
        {scenario.affordability.review.reviewedAt}
      </p>
      <p>{scenario.affordability.review.notes}</p>
    </details>
  );
}
export function PublishedHousingAffordability({
  scenario,
  result,
  packs,
}: {
  scenario: Scenario;
  result?: HousingAffordabilityResolution;
  packs?: HousingIncomeLimitCatalog;
}) {
  if (!scenario.affordability) return null;
  const hashes = [
    ...new Set(
      [
        ...scenario.affordability.baselineGroups,
        ...scenario.affordability.proposalGroups,
      ].map((g) => g.areaHash),
    ),
  ];
  return (
    <section className="housing-published">
      <h2>Housing affordability · frozen evidence</h2>
      {result ? (
        <HousingResults result={result} />
      ) : (
        <p>
          The frozen affordability calculation is unavailable; no values have
          been substituted.
        </p>
      )}
      <details>
        <summary>Income-limit areas and cost citations</summary>
        {hashes.map((hash) =>
          packs?.[hash] ? (
            <HousingAreaEvidence key={hash} pack={packs[hash]} />
          ) : (
            <p key={hash}>Income-limit pack unavailable: {hash}</p>
          ),
        )}
        <h4>Housing cost citations</h4>
        {scenario.affordability.sources.map((s) => (
          <p key={s.id}>
            <strong>{s.name}</strong> · {s.vintage} · {s.license}
            <br />
            {/^https?:\/\//iu.test(s.url ?? "") && (
              <a href={s.url} target="_blank" rel="noreferrer">
                Source
              </a>
            )}
          </p>
        ))}
        <p>
          Reviewed by {scenario.affordability.review.reviewedBy} ·{" "}
          {scenario.affordability.review.reviewedAt}
        </p>
        <p>{scenario.affordability.review.notes}</p>
      </details>
    </section>
  );
}
