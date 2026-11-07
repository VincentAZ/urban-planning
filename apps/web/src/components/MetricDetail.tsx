import { ArrowUpRight, BookOpen, ExternalLink } from "lucide-react";
import type { MetricResult, Place } from "@urban/core";
import { formatMetric } from "@urban/models";
export function MetricDetail({
  metric,
  place,
  onAssumptions,
  onReview,
  onAccessibility,
  onFlood,
  onFiscal,
}: {
  metric: MetricResult;
  place: Place;
  onAssumptions: () => void;
  onReview?: () => void;
  onAccessibility?: () => void;
  onFlood?: () => void;
  onFiscal?: () => void;
}) {
  return (
    <div className="metric-detail">
      <div className="eyebrow">
        {metric.domain} · {metric.status}
      </div>
      <div className="detail-number">
        {formatMetric(metric.value, metric.unit)} <span>{metric.unit}</span>
      </div>
      <p>{metric.explanation}</p>
      {onFiscal && metric.domain === "Fiscal" && (
        <button type="button" className="button primary" onClick={onFiscal}>
          Review fiscal study and annual cash flows
        </button>
      )}
      {onAccessibility &&
        /^access\.(car|walk|transit)(15|30|45)$/.test(metric.id) && (
          <button
            type="button"
            className="button primary"
            onClick={onAccessibility}
          >
            Open jobs accessibility
          </button>
        )}
      {onFlood && metric.id === "environment.flood" && (
        <button type="button" className="button primary" onClick={onFlood}>
          Review flood exposure
        </button>
      )}
      {onReview && (
        <button className="button compact" onClick={onReview}>
          Discuss this metric
        </button>
      )}
      <div className="comparison-strip">
        <div>
          <span>Baseline</span>
          <strong>{formatMetric(metric.baseline, metric.unit)}</strong>
        </div>
        <div>
          <span>Change</span>
          <strong>
            {metric.delta === null
              ? "—"
              : `${metric.delta > 0 ? "+" : ""}${formatMetric(metric.delta, metric.unit)}`}
          </strong>
        </div>
        <div>
          <span>Revision</span>
          <strong>{metric.scenarioRevision}</strong>
        </div>
      </div>
      {metric.caveat && <div className="notice">{metric.caveat}</div>}
      <h3>
        <BookOpen size={16} /> How it is calculated
      </h3>
      <code className="formula">{metric.formula}</code>
      <p className="muted">
        {metric.method} · v{metric.methodVersion}
        <br />
        {metric.geography}
      </p>
      <h3>Inputs & assumptions</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Input</th>
              <th>Value</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {metric.inputs.map((input, i) => (
              <tr key={i}>
                <td>{input.name}</td>
                <td>{input.value}</td>
                <td>{input.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Source records</h3>
      {metric.sourceIds.length === 0 ? (
        <p className="muted">
          Scenario geometry and editable assumptions. No independent observed
          source is claimed.
        </p>
      ) : (
        metric.sourceIds.map((id) => {
          const s = place.sources.find((x) => x.id === id);
          return s && /^https?:\/\//i.test(s.url) ? (
            <a
              className="source-link"
              key={id}
              href={s.url}
              target="_blank"
              rel="noreferrer"
            >
              {s.name}
              <span>
                {s.vintage} <ExternalLink size={13} />
              </span>
            </a>
          ) : (
            <p className="muted" key={id}>
              {id}
            </p>
          );
        })
      )}
      <button className="button primary" onClick={onAssumptions}>
        Review assumptions <ArrowUpRight size={16} />
      </button>
    </div>
  );
}
