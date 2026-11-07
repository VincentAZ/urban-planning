import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  trafficSignalEditablePhase,
  trafficSignalProgramHash,
  type Place,
  type TrafficNetwork,
  type TrafficCount,
} from "@urban/core";
import {
  signalKey,
  timingKey,
  signalCycle,
  signalDraftFromProgram,
  readSignalTimingDraft,
  redistributeSignalGreen,
  signalStateLabel,
  signalGroupGreen,
  signalTimingEligibility,
  signalTimingControlLimit,
  type TrafficSignalDraft,
  type TrafficSignalEligibility,
} from "../../lib/traffic-signal-draft";
import {
  TrafficNumber,
  TrafficText,
  TrafficField,
  trafficNumber,
  trafficQuality,
} from "./TrafficFields";
import { SignalTimeline } from "./TrafficSignalEvidence";
const TrafficNetworkMap = lazy(() => import("./TrafficNetworkMap"));
export function TrafficSignalPanel({
  place,
  network,
  counts,
  drafts,
  onChange,
  canEdit,
  selectedEdgeId,
  onSelectEdge,
  eligibility,
}: {
  place: Place;
  network: TrafficNetwork;
  counts: readonly TrafficCount[];
  drafts: TrafficSignalDraft[];
  onChange: (values: TrafficSignalDraft[]) => void;
  canEdit: boolean;
  selectedEdgeId: string | null;
  onSelectEdge: (id: string) => void;
  eligibility?: TrafficSignalEligibility;
}) {
  const [query, setQuery] = useState(""),
    [selectedKey, setSelectedKey] = useState(""),
    [limit, setLimit] = useState(40),
    [phaseIndex, setPhaseIndex] = useState(0),
    [groupIndex, setGroupIndex] = useState<number | null>(null),
    [error, setError] = useState("");
  const [identity, setIdentity] = useState<{
    signal: (typeof network.signals)[number];
    hash?: string;
    error?: string;
  } | null>(null);
  const signals = useMemo(() => {
    const term = query.trim().toLowerCase();
    return network.signals.filter((signal) =>
      `${signal.id} ${signal.programId} ${signal.nodeIds.join(" ")}`
        .toLowerCase()
        .includes(term),
    );
  }, [network, query]);
  const signal =
    network.signals.find((value) => signalKey(value) === selectedKey) ??
    signals[0];
  const draft = signal
    ? drafts.find((value) => timingKey(value) === signalKey(signal))
    : undefined;
  const hash = identity?.signal === signal ? identity.hash : undefined;
  const eligible = signalTimingEligibility(
    network.manifest.networkFileSha256,
    {
      signalId: signal?.id ?? "",
      programId: signal?.programId ?? "",
      baselineProgramHash: hash ?? "",
    },
    eligibility,
  );
  const editable = canEdit && eligible.status !== "ineligible";
  const controllerLimit = signalTimingControlLimit(
    network.manifest.networkFileSha256,
    eligibility,
  );
  useEffect(() => {
    let cancelled = false;
    setError("");
    setPhaseIndex(0);
    setGroupIndex(null);
    if (signal)
      void trafficSignalProgramHash(signal).then(
        (hash) => {
          if (!cancelled) setIdentity({ signal, hash });
        },
        (failure) => {
          if (!cancelled)
            setIdentity({ signal, error: (failure as Error).message });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [signal]);
  const connectionIndex = useMemo(
    () => new Map(network.connections.map((value) => [value.id, value])),
    [network],
  );
  const edge = network.edges.find((value) => value.id === selectedEdgeId);
  const nearby = network.signals.filter(
    (value) =>
      edge &&
      (value.nodeIds.includes(edge.from) || value.nodeIds.includes(edge.to)),
  );
  if (!network.signals.length)
    return (
      <div className="traffic-empty">
        <h3>No signal program is retained.</h3>
        <p>
          This graph has no existing program to retime. A planning-road signal
          flag does not create a native junction controller.
        </p>
      </div>
    );
  function replace(value: TrafficSignalDraft) {
    if (!editable) return;
    onChange([
      ...drafts.filter((item) => timingKey(item) !== timingKey(value)),
      value,
    ]);
    setError("");
  }
  function changePhase(index: number, raw: string) {
    if (!draft) return;
    const durations = [...draft.phaseDurationsSeconds];
    durations[index] = raw;
    const valid = durations.every(
      (value) =>
        value.trim() !== "" &&
        Number.isFinite(Number(value)) &&
        Number(value) > 0,
    );
    replace({
      ...draft,
      phaseDurationsSeconds: durations,
      ...(valid
        ? { cycleSeconds: String(signalCycle(durations.map(Number))) }
        : {}),
    });
  }
  const durations =
    draft?.phaseDurationsSeconds.map((raw) =>
      /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN,
    ) ??
    signal?.phases.map((value) => value.durationSeconds) ??
    [];
  const cycle = signalCycle(durations);
  const fixed =
    signal?.phases.reduce(
      (sum, phase) =>
        sum + (trafficSignalEditablePhase(phase) ? 0 : phase.durationSeconds),
      0,
    ) ?? 0;
  let validation = "";
  if (draft && signal)
    try {
      readSignalTimingDraft(draft, signal);
    } catch (failure) {
      validation = (failure as Error).message;
    }
  const stale = !!draft && !!hash && draft.baselineProgramHash !== hash;
  const orphan = drafts.filter(
    (value) =>
      !network.signals.some((signal) => signalKey(signal) === timingKey(value)),
  );
  return (
    <section className="traffic-signal-editor">
      <div className="traffic-section-heading">
        <div>
          <span className="eyebrow">SIGNAL TIMING</span>
          <h3>Give each movement time.</h3>
        </div>
        <span className="traffic-badge">
          {network.signals.length.toLocaleString()} captured programs
        </span>
      </div>
      <p className="traffic-muted">
        Choose an existing native controller explicitly. A controller can serve
        several junctions. Timing edits do not create signals, crosswalks or
        turning movements.
      </p>
      <p className="traffic-muted">
        {drafts.length} timing controls in this configuration · limit{" "}
        {controllerLimit}. This is a processing limit. The current native worker
        checks whether each program can be represented exactly by its execution
        time step.
      </p>
      {nearby.length > 0 && (
        <div
          className="traffic-actions"
          aria-label="Programs near selected street"
        >
          {nearby.map((value) => (
            <button
              type="button"
              className="button"
              key={signalKey(value)}
              onClick={() => setSelectedKey(signalKey(value))}
            >
              Inspect signal {value.id}
            </button>
          ))}
        </div>
      )}
      {orphan.map((value) => (
        <p className="traffic-error" key={timingKey(value)}>
          Signal {value.signalId} / {value.programId} is absent from this graph.{" "}
          <button
            className="button"
            type="button"
            disabled={!canEdit}
            onClick={() => onChange(drafts.filter((item) => item !== value))}
          >
            Remove absent timing draft
          </button>
        </p>
      ))}
      <div className="traffic-signal-layout">
        <div>
          <TrafficText
            label="Find a signal program"
            value={query}
            onChange={(value) => {
              setQuery(value);
              setLimit(40);
            }}
            hint="Search by native controller, program or junction ID."
          />
          <div
            className="traffic-network-list traffic-signal-list"
            aria-label="Signal programs"
          >
            {signals.slice(0, limit).map((value) => (
              <button
                type="button"
                key={signalKey(value)}
                aria-pressed={signal === value}
                onClick={() => setSelectedKey(signalKey(value))}
              >
                <strong>Signal {value.id}</strong>
                <span>
                  Program {value.programId} ·{" "}
                  {trafficNumber(
                    signalCycle(value.phases.map((p) => p.durationSeconds)),
                    3,
                  )}
                  s cycle
                </span>
                <small>
                  {trafficQuality[value.quality]}
                  {drafts.some((d) => timingKey(d) === signalKey(value))
                    ? " · timing draft"
                    : ""}
                </small>
              </button>
            ))}
          </div>
          {!signals.length && <p>No captured program matches this search.</p>}
          {signals.length > limit && (
            <button
              type="button"
              className="button"
              onClick={() => setLimit((value) => value + 40)}
            >
              Show more signal programs
            </button>
          )}
        </div>
        {signal && (
          <div className="traffic-signal-detail">
            <h4>
              Signal {signal.id} · program {signal.programId}
            </h4>
            <p>
              <strong>{trafficQuality[signal.quality]} native baseline.</strong>{" "}
              {eligible.reason}
            </p>
            <Suspense fallback={<p role="status">Loading signal map…</p>}>
              <TrafficNetworkMap
                place={place}
                network={network}
                counts={counts}
                selectedEdgeId={selectedEdgeId}
                onSelectEdge={onSelectEdge}
                signal={signal}
                signalGroupIndex={groupIndex}
              />
            </Suspense>
            <div className="traffic-stats">
              <div>
                <strong>
                  {trafficNumber(Number.isFinite(cycle) ? cycle : null, 3)}
                </strong>
                <span>current cycle seconds</span>
              </div>
              <div>
                <strong>{trafficNumber(fixed, 3)}</strong>
                <span>fixed transition / clearance seconds</span>
              </div>
              <div>
                <strong>{signal.nodeIds.length}</strong>
                <span>controlled junctions</span>
              </div>
            </div>
            <SignalTimeline
              signal={signal}
              durations={durations}
              label={draft ? "Authored timing preview" : "Captured timing"}
            />
            <p className="traffic-muted">
              Green: green-hold phase · amber: mixed/yellow transition · gray:
              other retained state. Numbers are phase indexes, not
              traffic-engineering ring phase names. Preview only; no assigned
              traffic is animated.
            </p>
            {stale && (
              <p className="traffic-error" role="alert">
                This program changed. Start from the current program before
                saving new timing assumptions.
              </p>
            )}
            {identity?.signal === signal && identity.error && (
              <p className="traffic-error" role="alert">
                {identity.error}
              </p>
            )}
            {!draft || stale ? (
              <button
                type="button"
                className="button primary"
                disabled={
                  !editable ||
                  !hash ||
                  (!draft && drafts.length >= controllerLimit)
                }
                onClick={() =>
                  hash && replace(signalDraftFromProgram(signal, hash))
                }
              >
                {stale ? "Start from current program" : "Edit signal timing"}
              </button>
            ) : (
              <>
                <div className="traffic-form-grid">
                  <TrafficNumber
                    label="Target cycle (seconds)"
                    value={draft.cycleSeconds}
                    disabled={!editable}
                    onChange={(cycleSeconds) =>
                      replace({ ...draft, cycleSeconds })
                    }
                    hint="Changing this target alone does not alter phase durations."
                  />
                  <TrafficNumber
                    label="Signal offset (seconds)"
                    value={draft.offsetSeconds}
                    disabled={!editable}
                    onChange={(offsetSeconds) =>
                      replace({ ...draft, offsetSeconds })
                    }
                    hint="Offset is relative to simulation time; it must be below the cycle length."
                  />
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={!editable}
                  onClick={() => {
                    try {
                      replace(redistributeSignalGreen(draft, signal));
                    } catch (failure) {
                      setError((failure as Error).message);
                    }
                  }}
                >
                  Redistribute green time
                </button>
                <p className="traffic-muted">
                  Redistribution reserves one second for each editable green
                  phase, then divides the remaining green budget by current
                  durations. Clearance phases remain exact. Review the resulting
                  whole-second durations before saving.
                </p>
              </>
            )}
            <div className="traffic-signal-phase-cards">
              {signal.phases.map((phase, index) => (
                <section
                  key={index}
                  className={phaseIndex === index ? "selected" : ""}
                >
                  <button
                    type="button"
                    className="traffic-text-button"
                    aria-pressed={phaseIndex === index}
                    onClick={() => setPhaseIndex(index)}
                  >
                    Inspect phase {index + 1}
                  </button>
                  <code>{phase.state}</code>
                  <small>
                    {trafficSignalEditablePhase(phase)
                      ? "Editable green hold"
                      : "Fixed clearance / mixed state"}
                  </small>
                  {draft ? (
                    <TrafficNumber
                      label={`Phase ${index + 1} duration (seconds)`}
                      value={draft.phaseDurationsSeconds[index] ?? ""}
                      onChange={(raw) => changePhase(index, raw)}
                      disabled={
                        !editable || stale || !trafficSignalEditablePhase(phase)
                      }
                      hint={`Captured: ${trafficNumber(phase.durationSeconds, 3)} seconds.`}
                    />
                  ) : (
                    <p>{trafficNumber(phase.durationSeconds, 3)} seconds</p>
                  )}
                </section>
              ))}
            </div>
            {draft && (
              <>
                <TrafficField
                  label="Signal timing rationale"
                  hint="Describe the authored assumption or cited plan and its period of applicability; this does not make the inferred baseline observed."
                >
                  {({ id, describedBy }) => (
                    <textarea
                      id={id}
                      aria-describedby={describedBy}
                      value={draft.rationale}
                      maxLength={2000}
                      disabled={!editable || stale}
                      onChange={(event) =>
                        replace({ ...draft, rationale: event.target.value })
                      }
                    />
                  )}
                </TrafficField>
                {(error || validation) && (
                  <p role="alert" className="traffic-error">
                    {error || validation}
                  </p>
                )}
                <button
                  type="button"
                  className="button"
                  disabled={!canEdit}
                  onClick={() =>
                    onChange(drafts.filter((value) => value !== draft))
                  }
                >
                  Remove timing change
                </button>
              </>
            )}
            <details open className="traffic-source-details">
              <summary>
                Phase {Math.min(phaseIndex + 1, signal.phases.length)} ·
                controlled movement groups
              </summary>
              <p>
                One signal-state index may govern multiple connections. Green
                time includes priority G and yielding g in every phase; ratios
                overlap and do not sum to 100%.
              </p>
              <div className="traffic-signal-movements">
                {signal.connectionIds.map((ids, index) => (
                  <section key={index}>
                    <button
                      type="button"
                      className="button"
                      aria-pressed={groupIndex === index}
                      onClick={() =>
                        setGroupIndex(groupIndex === index ? null : index)
                      }
                    >
                      Highlight movement group {index + 1}
                    </button>
                    <p>
                      <strong>
                        {signalStateLabel(
                          signal.phases[
                            Math.min(phaseIndex, signal.phases.length - 1)
                          ].state[index],
                        )}
                      </strong>{" "}
                      in phase {phaseIndex + 1} ·{" "}
                      {trafficNumber(
                        Number.isFinite(cycle)
                          ? signalGroupGreen(signal, durations, index)
                          : null,
                        3,
                      )}{" "}
                      green seconds per cycle.
                    </p>
                    <ul>
                      {ids.map((id) => {
                        const connection = connectionIndex.get(id);
                        return (
                          <li key={id}>
                            {connection
                              ? `${connection.direction}: ${connection.fromEdge} → ${connection.toEdge}; ${connection.fromLane} → ${connection.toLane}`
                              : id}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </details>
            <details className="traffic-source-details">
              <summary>Captured program provenance</summary>
              <p>
                Junction IDs: {signal.nodeIds.join(", ")}. Program SHA-256:{" "}
                {hash ?? "Checking exact program identity…"}
              </p>
              <ul>
                {signal.sourceIds.map((id) => {
                  const source = network.manifest.sources.find(
                    (value) => value.id === id,
                  );
                  return (
                    <li key={id}>
                      {source
                        ? `${source.name} · ${source.vintage} · ${source.license}`
                        : id}
                      {source && /^https?:\/\//.test(source.url) && (
                        <>
                          {" "}
                          ·{" "}
                          <a href={source.url} target="_blank" rel="noreferrer">
                            Original source
                          </a>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}
