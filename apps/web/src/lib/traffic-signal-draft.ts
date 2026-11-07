import {
  trafficSignalEditablePhase,
  applyTrafficSignalTiming,
  MAX_TRAFFIC_SIGNAL_TIMINGS,
  type TrafficSignal,
  type TrafficSignalTiming,
  type TrafficNetwork,
} from "@urban/core";
import type { TrafficContext } from "../../../api/src/traffic/jobs-types";
export type TrafficSignalEligibility =
  TrafficContext["signalTimingEligibility"];
export function signalTimingControlLimit(
  networkHash: string,
  eligibility?: TrafficSignalEligibility,
): number {
  return eligibility?.networkHash === networkHash
    ? Math.min(MAX_TRAFFIC_SIGNAL_TIMINGS, eligibility.controllerLimit)
    : MAX_TRAFFIC_SIGNAL_TIMINGS;
}
export function signalTimingEligibility(
  networkHash: string,
  signal: { signalId: string; programId: string; baselineProgramHash: string },
  eligibility?: TrafficSignalEligibility,
): { status: "eligible" | "ineligible" | "unverified"; reason: string } {
  const program =
    eligibility?.networkHash === networkHash
      ? eligibility.programs.find(
          (value) =>
            value.signalId === signal.signalId &&
            value.programId === signal.programId &&
            value.baselineProgramHash === signal.baselineProgramHash,
        )
      : undefined;
  if (!program)
    return {
      status: "unverified",
      reason:
        "Static-program eligibility has not been verified for this exact program. The native worker must confirm it before execution.",
    };
  return program.eligible
    ? {
        status: "eligible",
        reason:
          "Retained native XML confirms an eligible static sequence. This is a structural check, not a field timing validation.",
      }
    : {
        status: "ineligible",
        reason:
          program.reason ??
          "This native program cannot be retimed with the supported fixed-sequence controls.",
      };
}

export interface TrafficSignalDraft {
  signalId: string;
  programId: string;
  baselineProgramHash: string;
  phaseDurationsSeconds: string[];
  offsetSeconds: string;
  cycleSeconds: string;
  rationale: string;
}
export const signalKey = (signal: Pick<TrafficSignal, "id" | "programId">) =>
  JSON.stringify([signal.id, signal.programId]);
export const timingKey = (
  value: Pick<TrafficSignalTiming, "signalId" | "programId">,
) => JSON.stringify([value.signalId, value.programId]);
export const signalCycle = (durations: readonly number[]) =>
  durations.reduce((sum, value) => sum + value, 0);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7;
function numeric(raw: string, label: string): number {
  if (
    !raw.trim() ||
    !/^\d+(?:\.\d+)?$/.test(raw.trim()) ||
    !Number.isFinite(Number(raw))
  )
    throw new Error(
      `Enter a finite, nonnegative number for ${label}. Blank is not zero.`,
    );
  return Number(raw);
}
export function signalTimingDraft(
  value: TrafficSignalTiming,
): TrafficSignalDraft {
  return {
    ...value,
    phaseDurationsSeconds: value.phaseDurationsSeconds.map(String),
    offsetSeconds: String(value.offsetSeconds),
    cycleSeconds: String(signalCycle(value.phaseDurationsSeconds)),
  };
}
export function signalDraftFromProgram(
  signal: TrafficSignal,
  baselineProgramHash: string,
): TrafficSignalDraft {
  return signalTimingDraft({
    signalId: signal.id,
    programId: signal.programId,
    baselineProgramHash,
    phaseDurationsSeconds: signal.phases.map((p) => p.durationSeconds),
    offsetSeconds: signal.offsetSeconds,
    rationale: "",
  });
}
export function readSignalTimingDraft(
  draft: TrafficSignalDraft,
  signal: TrafficSignal,
): TrafficSignalTiming {
  if (
    timingKey(draft) !== signalKey(signal) ||
    draft.phaseDurationsSeconds.length !== signal.phases.length
  )
    throw new Error(
      "The selected signal program changed. Remove the earlier timing draft and review its current phases.",
    );
  const durations = draft.phaseDurationsSeconds.map((raw, index) => {
    const value = numeric(raw, `phase ${index + 1}`),
      baseline = signal.phases[index];
    if (value <= 0)
      throw new Error(`Phase ${index + 1} needs a positive duration.`);
    if (
      value !== baseline.durationSeconds &&
      (!trafficSignalEditablePhase(baseline) ||
        !Number.isInteger(value) ||
        value > 3600)
    )
      throw new Error(
        `Phase ${index + 1} must preserve clearance timing or use whole green-hold seconds from 1 to 3,600.`,
      );
    return value;
  });
  const cycle = signalCycle(durations),
    target = numeric(draft.cycleSeconds, "target cycle"),
    offset = numeric(draft.offsetSeconds, "offset");
  if (cycle <= 0 || cycle > 7200)
    throw new Error(
      "The complete cycle must be positive and no longer than 7,200 seconds.",
    );
  if (!close(target, cycle))
    throw new Error(
      "Redistribute green time to apply the target cycle, or restore the target to the current phase total.",
    );
  if (
    offset >= cycle ||
    (offset !== signal.offsetSeconds && !Number.isInteger(offset))
  )
    throw new Error(
      "Use a whole-second offset from zero up to, but not including, the cycle length.",
    );
  if (!draft.rationale.trim() || draft.rationale.length > 2000)
    throw new Error("Describe the timing assumption in 1–2,000 characters.");
  const control = {
    signalId: draft.signalId,
    programId: draft.programId,
    baselineProgramHash: draft.baselineProgramHash,
    phaseDurationsSeconds: durations,
    offsetSeconds: offset,
    rationale: draft.rationale.trim(),
  };
  applyTrafficSignalTiming(signal, control);
  return control;
}
export function readSignalTimingDrafts(
  drafts: readonly TrafficSignalDraft[],
  network: TrafficNetwork,
): TrafficSignalTiming[] {
  return drafts.map((draft) => {
    const signal = network.signals.find(
      (signal) => signalKey(signal) === timingKey(draft),
    );
    if (!signal)
      throw new Error(
        "An edited signal program is absent from this network. Remove that timing draft before saving.",
      );
    return readSignalTimingDraft(draft, signal);
  });
}
/** Explicit user action only. Largest-remainder allocation preserves the target budget and every clearance duration. */
export function redistributeSignalGreen(
  draft: TrafficSignalDraft,
  signal: TrafficSignal,
): TrafficSignalDraft {
  if (draft.phaseDurationsSeconds.length !== signal.phases.length)
    throw new Error(
      "The signal phase sequence changed. Start from the current program before redistributing.",
    );
  const target = numeric(draft.cycleSeconds, "target cycle");
  if (target <= 0 || target > 7200)
    throw new Error(
      "Choose a target cycle greater than zero and no longer than 7,200 seconds.",
    );
  const editable = signal.phases.flatMap((phase, index) =>
    trafficSignalEditablePhase(phase) ? [index] : [],
  );
  if (!editable.length)
    throw new Error(
      "This program has no eligible green-hold phases. Its clearance and mixed transition phases are retained.",
    );
  const current = draft.phaseDurationsSeconds.map((raw, index) =>
    numeric(raw, `phase ${index + 1}`),
  );
  if (current.some((value) => value <= 0))
    throw new Error(
      "Enter positive phase durations before redistributing green time.",
    );
  const arithmeticTolerance =
    Number.EPSILON * Math.max(1, target, signalCycle(current)) * 8;
  if (
    Math.abs(target - signalCycle(current)) <= arithmeticTolerance &&
    signal.phases.every(
      (phase, index) =>
        current[index] === phase.durationSeconds ||
        (trafficSignalEditablePhase(phase) &&
          Number.isInteger(current[index]) &&
          current[index] <= 3600),
    )
  )
    return {
      ...draft,
      phaseDurationsSeconds: [...draft.phaseDurationsSeconds],
    };
  const fixed = signal.phases.reduce(
    (sum, phase) =>
      sum + (trafficSignalEditablePhase(phase) ? 0 : phase.durationSeconds),
    0,
  );
  const rawBudget = target - fixed;
  const nearest = Math.round(rawBudget);
  const budget =
    Math.abs(rawBudget - nearest) <=
    Number.EPSILON * Math.max(1, target, fixed) * 8
      ? nearest
      : rawBudget;
  if (!Number.isInteger(budget) || budget < editable.length)
    throw new Error(
      "The target must retain all clearance time and leave at least one whole second per editable green phase.",
    );
  const weight = editable.reduce((sum, index) => sum + current[index], 0);
  const remaining = budget - editable.length;
  const shares = editable.map((index) => {
    const exact = (remaining * current[index]) / weight;
    return {
      index,
      seconds: 1 + Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let extra = budget - shares.reduce((sum, part) => sum + part.seconds, 0);
  for (const part of [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  ))
    if (extra-- > 0) part.seconds++;
  if (shares.some((part) => part.seconds > 3600))
    throw new Error(
      "That redistribution would exceed 3,600 seconds in one green phase. Choose a shorter cycle or review phase weights.",
    );
  const durations = signal.phases.map((phase) => String(phase.durationSeconds));
  for (const part of shares) durations[part.index] = String(part.seconds);
  return { ...draft, phaseDurationsSeconds: durations };
}
export function signalStateLabel(state: string): string {
  return [...state]
    .map(
      (value) =>
        ({
          G: "priority green",
          g: "yielding green",
          r: "red",
          R: "red",
          y: "yellow",
          Y: "yellow",
          u: "red and yellow",
          U: "red and yellow",
          s: "stop then yield",
          o: "off, yield",
          O: "off, priority",
        })[value] ?? `native state ${value}`,
    )
    .join(", ");
}
export function signalGroupGreen(
  signal: TrafficSignal,
  durations: readonly number[],
  group: number,
) {
  if (
    durations.length !== signal.phases.length ||
    durations.some((value) => !Number.isFinite(value) || value <= 0)
  )
    return null;
  return durations.reduce((sum, duration, index) => {
    const state = signal.phases[index].state[group];
    return sum + (state === "G" || state === "g" ? duration : 0);
  }, 0);
}
