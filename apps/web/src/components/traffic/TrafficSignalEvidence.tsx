import {
  trafficSignalEditablePhase,
  type TrafficCapturedSignalTiming,
  type TrafficSignal,
} from "@urban/core";
import { signalCycle, signalGroupGreen } from "../../lib/traffic-signal-draft";
import { trafficNumber, trafficQuality } from "./TrafficFields";

export function SignalTimeline({
  signal,
  durations,
  label,
}: {
  signal: TrafficSignal;
  durations: readonly number[];
  label: string;
}) {
  if (durations.length !== signal.phases.length)
    return (
      <p className="traffic-muted">
        The phase sequence changed. Review the current program before previewing
        its timing.
      </p>
    );
  const cycle = signalCycle(durations);
  if (
    !Number.isFinite(cycle) ||
    cycle <= 0 ||
    durations.some((value) => !Number.isFinite(value) || value <= 0)
  )
    return (
      <p className="traffic-muted">
        Enter valid phase durations to preview the cycle.
      </p>
    );
  return (
    <div
      className="traffic-signal-timeline"
      role="img"
      aria-label={`${label}: ${trafficNumber(cycle, 3)} seconds. ${durations.map((value, index) => `Phase ${index + 1}: ${trafficNumber(value, 3)} seconds`).join("; ")}`}
    >
      {durations.map((duration, index) => (
        <span
          key={index}
          style={{ flexGrow: duration }}
          className={
            /[yYuU]/.test(signal.phases[index].state)
              ? "transition"
              : trafficSignalEditablePhase(signal.phases[index])
                ? "green"
                : "clearance"
          }
          title={`Phase ${index + 1}: ${duration}s · ${signal.phases[index].state}`}
        >
          <b>{index + 1}</b>
        </span>
      ))}
    </div>
  );
}
export function TrafficSignalEvidence({
  timings,
}: {
  timings?: readonly TrafficCapturedSignalTiming[];
}) {
  if (!timings?.length) return null;
  return (
    <details className="traffic-card traffic-signal-evidence">
      <summary>Captured signal timing ({timings.length})</summary>
      <p>
        Authored duration and offset changes preserve the captured movement
        states, sequence and clearance timing. This is a timing assumption, not
        a surveyed or field-validated plan. Planning-road signal flags remain
        separate.
      </p>
      {timings.map(({ control, baseline, proposal }) => (
        <section key={JSON.stringify([control.signalId, control.programId])}>
          <h4>
            Signal {control.signalId} · program {control.programId}
          </h4>
          <p>
            {trafficQuality[baseline.quality]} baseline → authored proposal ·
            cycle{" "}
            {trafficNumber(
              signalCycle(baseline.phases.map((p) => p.durationSeconds)),
              3,
            )}{" "}
            → {trafficNumber(signalCycle(control.phaseDurationsSeconds), 3)}{" "}
            seconds · offset {trafficNumber(baseline.offsetSeconds, 3)} →{" "}
            {trafficNumber(control.offsetSeconds, 3)} seconds.
          </p>
          <SignalTimeline
            signal={proposal}
            durations={control.phaseDurationsSeconds}
            label={`Proposed signal ${control.signalId}`}
          />
          <div className="traffic-signal-phase-cards">
            {baseline.phases.map((phase, index) => (
              <div key={index}>
                <strong>Phase {index + 1}</strong>
                <span>
                  {trafficNumber(phase.durationSeconds, 3)} →{" "}
                  {trafficNumber(control.phaseDurationsSeconds[index], 3)}{" "}
                  seconds
                </span>
                <code>{phase.state}</code>
              </div>
            ))}
          </div>
          <p>{control.rationale}</p>
          <details>
            <summary>Movement green time and exact identity</summary>
            <p>
              Green time includes priority and yielding green in every phase,
              including mixed transitions. Movement ratios overlap and do not
              add to 100%.
            </p>
            <ul>
              {baseline.connectionIds.map((ids, index) => (
                <li key={index}>
                  Movement group {index + 1}:{" "}
                  {trafficNumber(
                    signalGroupGreen(
                      baseline,
                      baseline.phases.map((p) => p.durationSeconds),
                      index,
                    ),
                    3,
                  )}{" "}
                  →{" "}
                  {trafficNumber(
                    signalGroupGreen(
                      proposal,
                      control.phaseDurationsSeconds,
                      index,
                    ),
                    3,
                  )}{" "}
                  green seconds. {ids.join(", ")}
                </li>
              ))}
            </ul>
            <p className="traffic-muted">
              Baseline program SHA-256: {control.baselineProgramHash}. Baseline
              source IDs: {baseline.sourceIds.join(", ")}.
            </p>
          </details>
        </section>
      ))}
    </details>
  );
}
