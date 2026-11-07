import { useState } from "react";
import type {
  FiscalCaseResult,
  FiscalResolution,
  FiscalStudy,
  FiscalTrajectory,
  Scenario,
} from "@urban/core";
import { fiscalMoney } from "./FiscalFields";
import { fiscalFields } from "./draft";
import "./fiscal.css";

export function FiscalPanel({
  scenario,
  study,
  resolution,
  onOpen,
}: {
  scenario: Scenario;
  study?: FiscalStudy;
  resolution?: FiscalResolution;
  onOpen: () => void;
}) {
  return (
    <section className="fiscal-panel">
      <span className="eyebrow">LOCAL FISCAL STUDY</span>
      <h3>Make the offer add up.</h3>
      <p>
        {study
          ? `${study.profile.name} · ${resolution?.reviewState === "current" ? "Current input review" : "Review inputs and applicability"}`
          : "Build a cited local profile, then compare the same development with and without an incentive."}
      </p>
      {study && (
        <p>
          Grant {fiscalMoney(scenario.assumptions.incentiveGrant)} ·{" "}
          {scenario.assumptions.abatementPercent * 100}% added-value abatement ·{" "}
          {scenario.assumptions.abatementYears} years
        </p>
      )}
      <button type="button" className="button full-width" onClick={onOpen}>
        {study ? "Open fiscal study" : "Build a fiscal study"}
      </button>
    </section>
  );
}
const payback = (value: FiscalCaseResult["payback"]) =>
  value.status === "reached"
    ? `Year ${value.year}`
    : value.status === "not-needed"
      ? "No modeled cost to recover"
      : value.status === "not-reached"
        ? "Not reached in 20 years"
        : "Unavailable";
const yearLabel = (row: FiscalTrajectory["rows"][number]) =>
  row.year === 0
    ? "Time zero · upfront"
    : `Year ${row.year} · FY ${row.fiscalYear}`;

function AnnualComponents({
  title,
  trajectory,
}: {
  title: string;
  trajectory: FiscalTrajectory;
}) {
  const fields = [
    ["propertyRevenue", "Property revenue"],
    ["salesRevenue", "Sales revenue"],
    ["serviceCost", "Service cost"],
    ["abatementCost", "Abatement cost"],
    ["grantCost", "Grant"],
    ["netRevenue", "Net flow"],
    ["discountedNet", "Discounted net"],
  ] as const;
  return (
    <details>
      <summary>{title} · full annual components</summary>
      {!!trajectory.missingBuildingIds.length && (
        <p className="notice">
          Unresolved quantities affect {trajectory.missingBuildingIds.length}{" "}
          buildings. Null values remain unavailable; they are not zero.
        </p>
      )}
      <div
        className="fiscal-table-scroll fiscal-table-desktop"
        tabIndex={0}
        role="region"
        aria-label={`${title} annual components, horizontally scrollable`}
      >
        <table className="fiscal-table">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Payment time</th>
              {fields.map(([key, label]) => (
                <th scope="col" key={key}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trajectory.rows.map((row) => (
              <tr key={row.year}>
                <th scope="row">{yearLabel(row)}</th>
                {fields.map(([key]) => (
                  <td key={key}>{fiscalMoney(row[key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fiscal-mobile-rows">
        {trajectory.rows.map((row) => (
          <article className="fiscal-mobile-row" key={row.year}>
            <strong>{yearLabel(row)}</strong>
            <dl>
              {fields.map(([key, label]) => (
                <div key={key} style={{ display: "contents" }}>
                  <dt>{label}</dt>
                  <dd>{fiscalMoney(row[key])}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
      {!!trajectory.missingBuildingIds.length && (
        <details>
          <summary>Buildings with missing quantities</summary>
          <ul>
            {trajectory.missingBuildingIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}
export function FiscalCaseEvidence({ value }: { value: FiscalCaseResult }) {
  return (
    <section
      className="fiscal-section"
      aria-label={`${value.name} fiscal results`}
    >
      <h3>{value.name}</h3>
      <p>{value.description}</p>
      <div className="fiscal-summary">
        <div>
          <span>Incremental NPV with offer vs baseline</span>
          <strong>{fiscalMoney(value.incremental.withOffer.npv)}</strong>
        </div>
        <div>
          <span>Offer cost · discounted</span>
          <strong>{fiscalMoney(value.offerCost.npv)}</strong>
        </div>
        <div>
          <span>Undiscounted payback vs baseline</span>
          <strong>{payback(value.payback)}</strong>
        </div>
      </div>
      <p className="notice">
        Without offer assumes the same development happens. This comparison does
        not establish that an incentive caused or was needed to attract the
        development. Payback compares the development with the unchanged
        baseline; it is not causal return on the incentive.
      </p>
      <div className="fiscal-table-scroll fiscal-table-desktop">
        <table className="fiscal-table">
          <caption>
            Annual net operating cash flow · constant-dollar USD
          </caption>
          <thead>
            <tr>
              <th scope="col">Payment time</th>
              <th scope="col">Baseline</th>
              <th scope="col">Same development, no offer</th>
              <th scope="col">With offer</th>
              <th scope="col">With offer − baseline</th>
            </tr>
          </thead>
          <tbody>
            {value.withOffer.rows.map((row, index) => (
              <tr key={row.year}>
                <th scope="row">{yearLabel(row)}</th>
                <td>{fiscalMoney(value.baseline.rows[index]?.netRevenue)}</td>
                <td>
                  {fiscalMoney(value.withoutOffer.rows[index]?.netRevenue)}
                </td>
                <td>{fiscalMoney(row.netRevenue)}</td>
                <td>
                  {fiscalMoney(
                    value.incremental.withOffer.rows[index]?.netRevenue,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">20-year NPV including time zero</th>
              <td>{fiscalMoney(value.baseline.totals.npv)}</td>
              <td>{fiscalMoney(value.withoutOffer.totals.npv)}</td>
              <td>{fiscalMoney(value.withOffer.totals.npv)}</td>
              <td>{fiscalMoney(value.incremental.withOffer.npv)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="fiscal-mobile-rows">
        {value.withOffer.rows.map((row, index) => (
          <article className="fiscal-mobile-row" key={row.year}>
            <strong>{yearLabel(row)}</strong>
            <dl>
              <dt>Baseline</dt>
              <dd>{fiscalMoney(value.baseline.rows[index]?.netRevenue)}</dd>
              <dt>Same development, no offer</dt>
              <dd>{fiscalMoney(value.withoutOffer.rows[index]?.netRevenue)}</dd>
              <dt>With offer</dt>
              <dd>{fiscalMoney(row.netRevenue)}</dd>
              <dt>With offer − baseline</dt>
              <dd>
                {fiscalMoney(
                  value.incremental.withOffer.rows[index]?.netRevenue,
                )}
              </dd>
            </dl>
          </article>
        ))}
      </div>
      <AnnualComponents title="Baseline" trajectory={value.baseline} />
      <AnnualComponents
        title="Same development, no offer"
        trajectory={value.withoutOffer}
      />
      <AnnualComponents title="With offer" trajectory={value.withOffer} />
      <details>
        <summary>Exact assumptions used in this case</summary>
        <div
          className="fiscal-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Case assumptions"
        >
          <table className="fiscal-table">
            <thead>
              <tr>
                <th scope="col">Input</th>
                <th scope="col">Baseline</th>
                <th scope="col">Proposal</th>
              </tr>
            </thead>
            <tbody>
              {fiscalFields.map((field) => (
                <tr key={field.key}>
                  <th scope="row">
                    {field.label} ({field.unit})
                  </th>
                  <td>{value.assumptions.baseline[field.key] * field.scale}</td>
                  <td>{value.assumptions.proposal[field.key] * field.scale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
export function FiscalProfileEvidence({
  study,
  scenario,
  resolution,
}: {
  study: FiscalStudy;
  scenario: Scenario;
  resolution?: FiscalResolution;
}) {
  const profile = study.profile;
  return (
    <section className="fiscal-section" aria-label="Retained fiscal profile">
      <h3>
        {profile.name} · {profile.profileVersion}
      </h3>
      <p>
        {profile.jurisdiction.name} · {profile.jurisdiction.geography}
      </p>
      <p>
        Fiscal reference {profile.fiscalYear} · {profile.dollarYear}{" "}
        constant-dollar USD · real discount rate. Profile {study.profileHash}.
      </p>
      <p>{study.applicability.applicabilityNotes}</p>
      <p className="fiscal-muted">
        Applicability reviewed by {study.applicability.reviewedBy} on{" "}
        {study.applicability.reviewedAt}. This is a user review, not independent
        boundary or tax-law verification.
      </p>
      {!!resolution?.deviations.length && (
        <p className="notice">
          Current assumptions differ from this immutable profile. They are
          authored overrides; the original citations support the retained
          profile values, not the changed values.
        </p>
      )}
      <div
        className="fiscal-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Retained profile and current fiscal values"
      >
        <table className="fiscal-table">
          <thead>
            <tr>
              <th scope="col">Input</th>
              <th scope="col">Profile</th>
              <th scope="col">Current proposal</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {fiscalFields.map((field) => (
              <tr key={field.key}>
                <th scope="row">
                  {field.label} ({field.unit})
                </th>
                <td>{profile.coefficients[field.key] * field.scale}</td>
                <td>
                  {scenario.assumptions[field.key] * field.scale}
                  {scenario.assumptions[field.key] !==
                    profile.coefficients[field.key] && " · authored override"}
                </td>
                <td>
                  {profile.provenance[field.key].kind} ·{" "}
                  {profile.provenance[field.key].description}
                  <br />
                  {profile.provenance[field.key].derivation}
                  {profile.provenance[field.key].sourceIds.map((id) => (
                    <div key={id}>
                      {profile.sources.find((s) => s.id === id)?.name ?? id}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <strong>Valuation:</strong> {profile.valuation.compatibilityNotes}
      </p>
      <p>
        <strong>Service allocation:</strong> {profile.serviceAllocation.method}{" "}
        · {profile.serviceAllocation.notes}
      </p>
      <h4>Fiscal citations · separate from planning feature sources</h4>
      {profile.sources.map((source) => (
        <article key={source.id} className="fiscal-source">
          <strong>{source.name}</strong>
          <span>
            {source.vintage} · {source.kind} · {source.license}
          </span>
          {/^https?:\/\//.test(source.url) ? (
            <a href={source.url} target="_blank" rel="noreferrer">
              Source citation
            </a>
          ) : (
            source.url && <span>{source.url}</span>
          )}
          <p>{source.description}</p>
          <small>
            Public redistribution:{" "}
            {source.rights?.publicRedistribution
              ? "declared permitted"
              : "not declared permitted"}
            . Permission declarations are not independent license verification.
          </small>
        </article>
      ))}
      {!!profile.files.length && (
        <details>
          <summary>Retained source-file identities</summary>
          <ul>
            {profile.files.map((file) => (
              <li key={`${file.sourceId}:${file.sha256}`}>
                {file.sourceId} · {file.sha256} · {file.bytes} bytes ·{" "}
                {file.url}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Study lineage and review</summary>
        <p>
          New study copied the selected current alternative from project{" "}
          {study.lineage.projectId}, scenario {study.lineage.scenarioId},
          revision {study.lineage.scenarioRevision}. Earlier undo history
          remains in the original study. Copied native results are imported
          evidence.
        </p>
        <p>
          Original project hash {study.lineage.projectHash}; scenario hash{" "}
          {study.lineage.scenarioHash}; history hash {study.lineage.historyHash}
          .
        </p>
        {scenario.fiscal && (
          <p>
            Current input review: {scenario.fiscal.review.notes} ·{" "}
            {scenario.fiscal.review.reviewedBy} ·{" "}
            {scenario.fiscal.review.reviewedAt}
          </p>
        )}
      </details>
    </section>
  );
}
export function FiscalResults({
  resolution,
}: {
  resolution: FiscalResolution;
}) {
  const [selected, setSelected] = useState("base");
  const value =
    selected === "base"
      ? resolution.base
      : (resolution.cases.find((item) => item.id === selected) ??
        resolution.base);
  return (
    <section className="fiscal-section" aria-label="Fiscal study results">
      <p role="status">
        Fiscal result: {resolution.status}. Input review:{" "}
        {resolution.reviewState}.
      </p>
      {resolution.clock && (
        <p className="notice">
          Time zero is the start of the selected {resolution.clock.horizonYears}
          -year forecast horizon. The upfront grant is paid then. Twenty
          recurring year-end flows begin in fiscal{" "}
          {resolution.clock.firstOperatingYear}. Values are{" "}
          {resolution.clock.dollarYear} constant-dollar USD, discounted with a
          real rate.
        </p>
      )}
      {resolution.notes.map((note, index) => (
        <p key={index} className="fiscal-muted">
          {note}
        </p>
      ))}
      {!!resolution.cases.length && (
        <label className="fiscal-field">
          Fiscal comparison case
          <select
            aria-label="Fiscal comparison case"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="base">Reviewed central assumptions</option>
            {resolution.cases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {value ? (
        <FiscalCaseEvidence value={value} />
      ) : (
        <p className="notice">
          Complete the profile and current input review to calculate these
          results. Missing evidence is not a zero return.
        </p>
      )}
      {!!resolution.cases.length && (
        <p className="notice">
          Named sensitivity cases are paired authored assumptions, not
          probability estimates, confidence intervals or forecasts calibrated to
          observed outcomes.
        </p>
      )}
    </section>
  );
}
export function PublishedFiscal({
  study,
  scenario,
  resolution,
}: {
  study?: FiscalStudy;
  scenario: Scenario;
  resolution?: FiscalResolution;
}) {
  if (!study) return null;
  return (
    <details className="fiscal-workbench">
      <summary>Fiscal study · {study.profile.name}</summary>
      <p>
        Frozen published study. Source profile, offer and named cases remain
        bound to this captured revision.
      </p>
      {resolution ? (
        <FiscalResults resolution={resolution} />
      ) : (
        <p className="notice">
          This snapshot has no retained detailed fiscal result. No current
          recalculation is substituted.
        </p>
      )}
      <FiscalProfileEvidence
        study={study}
        scenario={scenario}
        resolution={resolution}
      />
    </details>
  );
}
