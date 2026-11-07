import { useId } from "react";
import { ExternalLink, Info, Users } from "lucide-react";
import type {
  CensusValue,
  CommunityDemographics,
  CommunityMeasure,
  Place,
} from "@urban/core";
import "./community-context.css";

const statusLabels: Record<CensusValue["status"], string> = {
  available: "Available",
  missing: "Not available",
  suppressed: "Too few sample cases",
  "not-applicable": "Not applicable or available",
  uncomputable: "Not computable",
  controlled: "Controlled estimate",
  bounded: "Open-ended estimate",
};
// Captured source JSON is canonicalized, so its key order is not a display order.
const measureOrder: (keyof CommunityDemographics["measures"])[] = [
  "population",
  "households",
  "housingUnits",
  "medianHouseholdIncome",
  "povertyPercent",
  "bachelorsOrHigherPercent",
];
function numeric(
  value: number,
  unit: CommunityMeasure["unit"],
  margin = false,
) {
  if (unit === "USD")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: unit === "percent" ? 1 : 0,
  }).format(value);
  return unit === "percent" ? `${formatted}${margin ? " pp" : "%"}` : formatted;
}
function valueLabel(cell: CensusValue, unit: CommunityMeasure["unit"]) {
  if (cell.value !== null) return numeric(cell.value, unit);
  return cell.status === "bounded" && cell.annotation
    ? cell.annotation
    : "Unavailable";
}
function marginLabel(measure: CommunityMeasure) {
  const cell = measure.marginOfError;
  if (measure.estimate.value === null)
    return statusLabels[measure.estimate.status];
  if (cell.status === "controlled")
    return "Controlled estimate · sampling MOE treated as 0";
  if (cell.value !== null)
    return `${measure.method?.kind === "derived" ? "Approx. " : ""}± ${numeric(cell.value, measure.unit, true)} · 90% MOE`;
  return `MOE: ${statusLabels[cell.status].toLowerCase()}`;
}

/** Baseline statistical context. Scenario edits never mutate these published survey estimates. */
export function CommunityContext({ place }: { place: Place }) {
  const heading = useId();
  const profile = place.demographics;
  const unavailable = place.coverage.find(
    (item) =>
      item.layer === "Census community context" &&
      item.status === "unavailable",
  );
  return (
    <section className="community-context" aria-labelledby={heading}>
      <div className="community-heading">
        <Users size={17} aria-hidden="true" />
        <div>
          <h3 id={heading}>Community context</h3>
          <p>Published Census estimates</p>
        </div>
      </div>
      {!profile ? (
        <p className="community-unavailable">
          {unavailable?.description ??
            "Census community estimates have not been loaded for this area. Building-based planning estimates remain separate."}
        </p>
      ) : (
        <>
          <p className="community-period">
            <strong>ZCTA {profile.geography.id}</strong>
            <span>
              {profile.period.start}–{profile.period.end} ACS · five-year survey
            </span>
          </p>
          {profile.geography.relationshipToStudyArea === "context-only" && (
            <p className="community-scope">
              <Info size={14} aria-hidden="true" /> Whole-ZCTA context. These
              figures are not totals for the smaller displayed area.
            </p>
          )}
          <dl className="community-measures">
            {measureOrder.map((key) => {
              const measure = profile.measures[key];
              return (
                <div className="community-measure" key={key}>
                  <dt>{measure.label}</dt>
                  <dd>
                    <strong>
                      {valueLabel(measure.estimate, measure.unit)}
                    </strong>
                    <span>{marginLabel(measure)}</span>
                  </dd>
                  <small>{measure.universe}</small>
                </div>
              );
            })}
          </dl>
          <p className="community-uncertainty">
            ± is the margin of error at 90% confidence. Derived margins are
            marked approximate; percentage margins are percentage points. These
            are survey estimates, not a count of mapped buildings or a scenario
            forecast.
          </p>
          <details className="community-method">
            <summary>Source, coverage & uncertainty</summary>
            <p>{profile.source.name}</p>
            <p>
              Retrieved{" "}
              <time dateTime={profile.retrievedAt}>
                {new Date(profile.retrievedAt).toLocaleDateString("en-US", {
                  dateStyle: "medium",
                  timeZone: "UTC",
                })}
              </time>{" "}
              · {profile.dataset}
            </p>
            <ul>
              {profile.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <dl>
              {measureOrder.map((key) => {
                const measure = profile.measures[key];
                return (
                  <div key={key}>
                    <dt>{measure.label}</dt>
                    <dd>
                      <code>{measure.variables.estimate}</code> /{" "}
                      <code>{measure.variables.marginOfError}</code>
                      {measure.estimate.annotation && (
                        <span>
                          {" "}
                          · Estimate annotation: {measure.estimate.annotation}
                        </span>
                      )}
                      {measure.marginOfError.annotation && (
                        <span>
                          {" "}
                          · MOE annotation: {measure.marginOfError.annotation}
                        </span>
                      )}
                      {measure.method && (
                        <>
                          <p>{measure.method.description}</p>
                          <p>{measure.method.formula}</p>
                          <a
                            href={
                              measure.method.sourceUrl.startsWith(
                                "https://www.census.gov/",
                              )
                                ? measure.method.sourceUrl
                                : "https://www.census.gov/programs-surveys/acs/guidance.html"
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            Census calculation guidance{" "}
                            <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        </>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <a
              href={`https://data.census.gov/profile/ZCTA5_${profile.geography.id}?g=860XX00US${profile.geography.id}`}
              target="_blank"
              rel="noreferrer"
            >
              View Census profile <ExternalLink size={12} aria-hidden="true" />
            </a>
            <a
              href={`https://api.census.gov/data/${profile.vintage}/${profile.dataset}/variables.html`}
              target="_blank"
              rel="noreferrer"
            >
              Dataset variables <ExternalLink size={12} aria-hidden="true" />
            </a>
            {profile.sourceFiles && (
              <p>
                Cached official files:{" "}
                {profile.sourceFiles.map((file) => file.table).join(", ")}. Each
                file’s retrieval date and SHA-256 are retained in the captured
                source data.
              </p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
