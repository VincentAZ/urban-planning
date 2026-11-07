import { z } from "zod";
import type { TrafficNetwork, TrafficOverlay, TrafficSignal } from "./traffic";
import {
  trafficContentHash,
  trafficOverlaySchema,
  trafficSignalSchema,
  validateTrafficNetwork,
} from "./traffic-validation";

/** Processing bounds, not engineering recommendations or clearance standards. */
export const MAX_TRAFFIC_SIGNAL_TIMINGS = 100;
export const MAX_TRAFFIC_TIMING_PHASES = 64;
export const MAX_TRAFFIC_SIGNAL_CYCLE_SECONDS = 7200;
export const MAX_TRAFFIC_EDITED_GREEN_SECONDS = 3600;

export interface TrafficSignalTiming {
  signalId: string;
  programId: string;
  /** Canonical identity of the entire retained baseline signal, including provenance and movements. */
  baselineProgramHash: string;
  phaseDurationsSeconds: number[];
  offsetSeconds: number;
  rationale: string;
}
export interface TrafficCapturedSignalTiming {
  control: TrafficSignalTiming;
  baseline: TrafficSignal;
  proposal: TrafficSignal;
}
export const TRAFFIC_SIGNAL_SCOPE_NOTES = [
  "Native signal timings are authored changes to existing selected programs; they do not establish correspondence with planning-road signal flags.",
  "Signal states, phase order and clearance durations are retained. Baseline programs may be inferred; edited timings are not agency-approved or field-calibrated signal plans.",
  "Phase duration shares are not movement green ratios: movements may receive green in overlapping phases. The timing limits are processing bounds, not engineering minimums.",
] as const;
const id = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^\s<>"'&\u0000-\u001f]+$/u);
export const trafficSignalTimingSchema: z.ZodType<TrafficSignalTiming> = z
  .object({
    signalId: id,
    programId: id,
    baselineProgramHash: z.string().regex(/^[a-f0-9]{64}$/),
    phaseDurationsSeconds: z
      .array(
        z.number().finite().positive().max(MAX_TRAFFIC_SIGNAL_CYCLE_SECONDS),
      )
      .min(1)
      .max(MAX_TRAFFIC_TIMING_PHASES),
    offsetSeconds: z
      .number()
      .finite()
      .nonnegative()
      .max(MAX_TRAFFIC_SIGNAL_CYCLE_SECONDS),
    rationale: z
      .string()
      .min(1)
      .max(2000)
      .refine(
        (value) => value.trim().length > 0,
        "A timing rationale is required.",
      ),
  })
  .strict();
export const trafficSignalTimingsSchema = z
  .array(trafficSignalTimingSchema)
  .max(MAX_TRAFFIC_SIGNAL_TIMINGS)
  .superRefine((controls, ctx) => {
    if (new Set(controls.map((c) => c.signalId)).size !== controls.length)
      ctx.addIssue({
        code: "custom",
        message:
          "Only one timing program per native controller can be selected.",
      });
  });

/** State-shape eligibility only. The native worker must separately verify static/simple-sequence XML. */
export function trafficSignalEditablePhase(
  phase: TrafficSignal["phases"][number],
): boolean {
  return /^[rRgG]+$/.test(phase.state) && /[Gg]/.test(phase.state);
}
function assertTimingProgram(signal: TrafficSignal): void {
  trafficSignalSchema.parse(signal);
  if (
    !signal.nodeIds.length ||
    new Set(signal.nodeIds).size !== signal.nodeIds.length ||
    new Set(signal.connectionIds.flat()).size !==
      signal.connectionIds.flat().length ||
    signal.phases.some((p) => p.state.length !== signal.connectionIds.length)
  )
    throw new Error(
      "Signal timing requires an unambiguous complete controlled-movement inventory.",
    );
  if (
    signal.phases.length > MAX_TRAFFIC_TIMING_PHASES ||
    signal.phases.reduce((sum, p) => sum + p.durationSeconds, 0) >
      MAX_TRAFFIC_SIGNAL_CYCLE_SECONDS
  )
    throw new Error(
      "Signal program exceeds the bounded phase or cycle processing limit.",
    );
  if (!signal.phases.some(trafficSignalEditablePhase))
    throw new Error("Signal program has no supported green-hold phase.");
}
export async function trafficSignalProgramHash(
  signal: TrafficSignal,
): Promise<string> {
  trafficSignalSchema.parse(signal);
  return trafficContentHash(signal);
}
/** Exact projection only; callers must separately verify the asynchronous baseline hash and native XML. */
export function applyTrafficSignalTiming(
  signal: TrafficSignal,
  control: TrafficSignalTiming,
): TrafficSignal {
  assertTimingProgram(signal);
  trafficSignalTimingSchema.parse(control);
  if (
    signal.id !== control.signalId ||
    signal.programId !== control.programId ||
    signal.phases.length !== control.phaseDurationsSeconds.length
  )
    throw new Error(
      "Signal timing does not select the exact baseline controller, program and phase sequence.",
    );
  signal.phases.forEach((phase, index) => {
    const duration = control.phaseDurationsSeconds[index];
    if (duration === phase.durationSeconds) return;
    if (!trafficSignalEditablePhase(phase))
      throw new Error(
        "Signal clearance and non-green phase durations must remain exactly unchanged.",
      );
    if (
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > MAX_TRAFFIC_EDITED_GREEN_SECONDS
    )
      throw new Error(
        "Edited green holds require whole seconds between 1 and 3600; values are never silently rounded.",
      );
  });
  const cycle = control.phaseDurationsSeconds.reduce(
    (sum, value) => sum + value,
    0,
  );
  if (
    cycle > MAX_TRAFFIC_SIGNAL_CYCLE_SECONDS ||
    control.offsetSeconds >= cycle
  )
    throw new Error(
      "Signal offset must lie within the proposed cycle and cycle must not exceed 7200 seconds.",
    );
  if (
    control.offsetSeconds !== signal.offsetSeconds &&
    !Number.isInteger(control.offsetSeconds)
  )
    throw new Error(
      "Edited signal offsets require whole seconds; retained fractional baseline offsets are not rounded.",
    );
  return {
    ...structuredClone(signal),
    offsetSeconds: control.offsetSeconds,
    phases: signal.phases.map((phase, index) => ({
      ...phase,
      durationSeconds: control.phaseDurationsSeconds[index],
    })),
    quality: "authored",
  };
}
export const trafficCapturedSignalTimingSchema: z.ZodType<TrafficCapturedSignalTiming> =
  z
    .object({
      control: trafficSignalTimingSchema,
      baseline: trafficSignalSchema,
      proposal: trafficSignalSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
      try {
        const expected = applyTrafficSignalTiming(
          value.baseline,
          value.control,
        );
        if (
          JSON.stringify(trafficSignalSchema.parse(expected)) !==
          JSON.stringify(value.proposal)
        )
          throw new Error(
            "Captured signal proposal must exactly retain the baseline states, movements and sources with only the entered timing changes.",
          );
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message:
            error instanceof Error
              ? error.message
              : "Invalid captured signal timing.",
        });
      }
    });
export async function verifyTrafficCapturedSignalTiming(
  value: TrafficCapturedSignalTiming,
): Promise<void> {
  trafficCapturedSignalTimingSchema.parse(value);
  if (
    (await trafficSignalProgramHash(value.baseline)) !==
    value.control.baselineProgramHash
  )
    throw new Error("Signal timing baseline program hash is stale or altered.");
}
export async function validateTrafficSignalTimings(
  network: TrafficNetwork,
  timings: readonly TrafficSignalTiming[],
  overlays: readonly TrafficOverlay[] = [],
): Promise<void> {
  trafficSignalTimingsSchema.parse(timings);
  if (!timings.length) return;
  validateTrafficNetwork(network);
  const signals = new Map(network.signals.map((signal) => [signal.id, signal]));
  const connections = new Map(
    network.connections.map((connection) => [connection.id, connection]),
  );
  const controlledEdges = new Set<string>();
  for (const control of timings) {
    const baseline = signals.get(control.signalId);
    if (!baseline)
      throw new Error("Signal timing references an absent native controller.");
    const proposal = applyTrafficSignalTiming(baseline, control);
    await verifyTrafficCapturedSignalTiming({ control, baseline, proposal });
    for (const id of baseline.connectionIds.flat()) {
      const connection = connections.get(id)!;
      controlledEdges.add(connection.fromEdge);
      controlledEdges.add(connection.toEdge);
    }
  }
  for (const overlay of overlays) {
    trafficOverlaySchema.parse(overlay);
    if (
      controlledEdges.has(overlay.edgeId) &&
      (overlay.lanes !== undefined || overlay.closed === true)
    )
      throw new Error(
        "Selected signal timings cannot be combined with lane-count or closure changes on their controlled incoming or outgoing edges.",
      );
  }
}
