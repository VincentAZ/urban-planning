import { createHash } from "node:crypto";
import { SaxesParser } from "saxes";
import {
  applyTrafficSignalTiming,
  canonicalJSON,
  trafficSignalProgramHash,
  validateTrafficSignalTimings,
  type TrafficNetwork,
  type TrafficSignal,
  type TrafficSignalTiming,
  type TrafficCapturedSignalTiming,
  type TrafficPeriod,
} from "@urban/core";
import { ApiError } from "../errors.js";
import type { PreparedTrafficNetwork } from "./types.js";

export const TRAFFIC_SIGNAL_CONTROLLER_LIMIT = 16;
export interface TrafficSignalTimingEligibility {
  networkHash: string;
  controllerLimit: number;
  programs: {
    signalId: string;
    programId: string;
    baselineProgramHash: string;
    eligible: boolean;
    reason: string | null;
  }[];
}
interface NativeProgram {
  attributes: Record<string, string>;
  phases: Record<string, string>[];
  unsupported: boolean;
}
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
function fail(message: string): never {
  throw new ApiError(422, "TRAFFIC_SIGNAL_INVALID", message);
}
/** SAX is non-validating: reject DTDs explicitly; never fetch schemas, entities or URLs. */
function parseXml(
  bytes: Buffer,
  visit: (
    name: string,
    attributes: Record<string, string>,
    path: string[],
  ) => void,
): void {
  if (!Buffer.isBuffer(bytes))
    fail("Required native signal evidence is missing.");
  if (bytes.length > 64 * 1024 ** 2)
    fail("Signal XML exceeds the 64 MiB native artifact bound.");
  const parser = new SaxesParser({ xmlns: false });
  const path: string[] = [];
  let elements = 0;
  parser.on("doctype", () =>
    fail("XML document types and external entities are not supported."),
  );
  parser.on("error", () => fail("The retained native signal XML is invalid."));
  parser.on("opentag", (tag) => {
    if (++elements > 2000000 || path.length >= 64)
      fail("Signal XML exceeds structural processing bounds.");
    visit(tag.name, tag.attributes as Record<string, string>, path);
    path.push(tag.name);
  });
  parser.on("closetag", () => {
    path.pop();
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let offset = 0; offset < bytes.length; offset += 65536)
      parser.write(
        decoder.decode(bytes.subarray(offset, offset + 65536), {
          stream: true,
        }),
      );
    parser.write(decoder.decode()).close();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail("The retained native signal XML is invalid UTF-8/XML.");
  }
}
function programs(bytes: Buffer): NativeProgram[] {
  const result: NativeProgram[] = [];
  let active: NativeProgram | undefined;
  parseXml(bytes, (name, attributes, path) => {
    if (name === "tlLogic" && path.length === 1 && path[0] === "net") {
      active = {
        attributes: { ...attributes },
        phases: [],
        unsupported: false,
      };
      result.push(active);
    } else if (path[1] === "tlLogic" && active) {
      if (name === "phase" && path.length === 2)
        active.phases.push({ ...attributes });
      else active.unsupported = true;
    }
  });
  return result;
}
function eligibility(
  signal: TrafficSignal,
  raw: NativeProgram[],
): string | null {
  const matches = raw.filter((p) => p.attributes.id === signal.id);
  if (
    matches.length !== 1 ||
    matches[0].attributes.programID !== signal.programId
  )
    return "Exactly one native program per controller is required; program selection is ambiguous.";
  const p = matches[0];
  if (
    p.attributes.type !== "static" ||
    p.unsupported ||
    Object.keys(p.attributes).some(
      (k) => !["id", "type", "programID", "offset"].includes(k),
    ) ||
    p.phases.some((phase) =>
      Object.keys(phase).some(
        (k) => !["duration", "state", "name"].includes(k),
      ),
    )
  )
    return "Only simple static programs without branching, dynamic phase attributes, parameters or conditions are supported.";
  if (
    Number(p.attributes.offset ?? 0) !== signal.offsetSeconds ||
    !same(
      p.phases.map((phase) => ({
        durationSeconds: Number(phase.duration),
        state: phase.state,
      })),
      signal.phases,
    )
  )
    return "Native XML and retained signal inventory disagree.";
  if (
    [
      signal.offsetSeconds,
      ...signal.phases.map((phase) => phase.durationSeconds),
    ].some((value) => !Number.isInteger(value))
  )
    return "This one-second-step timing editor supports whole-second native programs only; retained fractional programs remain unchanged.";
  try {
    applyTrafficSignalTiming(signal, {
      signalId: signal.id,
      programId: signal.programId,
      baselineProgramHash: "0".repeat(64),
      phaseDurationsSeconds: signal.phases.map((p) => p.durationSeconds),
      offsetSeconds: signal.offsetSeconds,
      rationale: "Eligibility inspection",
    });
  } catch (error) {
    return error instanceof Error ? error.message : "Unsupported program.";
  }
  return null;
}
export async function trafficSignalTimingEligibility(
  prepared: PreparedTrafficNetwork,
): Promise<TrafficSignalTimingEligibility> {
  if (
    createHash("sha256").update(prepared.networkXml).digest("hex") !==
    prepared.network.manifest.networkFileSha256
  )
    fail("Native XML does not match its captured network identity.");
  const raw = programs(prepared.networkXml);
  return {
    networkHash: prepared.network.manifest.networkFileSha256,
    controllerLimit: TRAFFIC_SIGNAL_CONTROLLER_LIMIT,
    programs: await Promise.all(
      prepared.network.signals.map(async (signal) => {
        const reason = eligibility(signal, raw);
        return {
          signalId: signal.id,
          programId: signal.programId,
          baselineProgramHash: await trafficSignalProgramHash(signal),
          eligible: reason === null,
          reason,
        };
      }),
    ),
  };
}
export async function assertNativeSignalTimings(
  prepared: PreparedTrafficNetwork,
  timings: readonly TrafficSignalTiming[],
  overlays: Parameters<typeof validateTrafficSignalTimings>[2] = [],
  period?: TrafficPeriod,
): Promise<void> {
  if (!timings.length) return;
  if (timings.length > TRAFFIC_SIGNAL_CONTROLLER_LIMIT)
    throw new ApiError(
      413,
      "TRAFFIC_SIGNAL_CONTROLLER_LIMIT",
      "At most 16 controllers can retain complete baseline/proposal state files within the 64-file archive limit. No native work started.",
    );
  await validateTrafficSignalTimings(prepared.network, timings, overlays);
  const eligible = await trafficSignalTimingEligibility(prepared);
  for (const timing of timings) {
    const entry = eligible.programs.find(
      (p) => p.signalId === timing.signalId && p.programId === timing.programId,
    );
    if (!entry?.eligible)
      fail(entry?.reason ?? "Selected signal program is absent.");
  }
  if (
    period &&
    timings.length *
      (period.endSeconds +
        period.cooldownSeconds -
        period.beginSeconds +
        period.warmupSeconds) >
      250000
  )
    throw new ApiError(
      413,
      "TRAFFIC_SIGNAL_OUTPUT_LIMIT",
      "Selected programs exceed 250,000 retained state samples per run. Reduce the controllers or simulated interval; no states were omitted.",
    );
}
export async function assertTrafficSignalEffects(
  baseline: TrafficNetwork,
  proposal: TrafficNetwork,
  timings: readonly TrafficSignalTiming[],
): Promise<TrafficCapturedSignalTiming[]> {
  const evidence: TrafficCapturedSignalTiming[] = [];
  for (const control of timings) {
    const before = baseline.signals.find(
      (s) => s.id === control.signalId && s.programId === control.programId,
    );
    const actual = proposal.signals.filter((s) => s.id === control.signalId);
    if (!before || actual.length !== 1)
      fail("Executed signal controller/program is absent or ambiguous.");
    const expected = applyTrafficSignalTiming(before, control);
    if (
      (await trafficSignalProgramHash(before)) !==
        control.baselineProgramHash ||
      !same(expected, actual[0])
    )
      fail(
        "Executed signal timing changed an undeclared program state, movement, source or timing value.",
      );
    evidence.push({
      control: structuredClone(control),
      baseline: structuredClone(before),
      proposal: structuredClone(actual[0]),
    });
  }
  return evidence;
}
/** One sample per simulated second, exact active program and phase state. Raw samples remain archived. */
export function assertSignalStateOutput(
  bytes: Buffer,
  signal: TrafficSignal,
  period: TrafficPeriod,
): void {
  const begin = period.beginSeconds - period.warmupSeconds,
    end = period.endSeconds + period.cooldownSeconds;
  let expectedTime = begin;
  // Pinned SUMO 1.26: positive offsets delay phases; begin-of-step events execute
  // scheduled times < t + 1 second (MSEventControl.cpp). Native time uses milliseconds.
  const durations = signal.phases.map((phase) =>
    Math.round(phase.durationSeconds * 1000),
  );
  const cycle = durations.reduce((sum, value) => sum + value, 0);
  const offset = Math.round(signal.offsetSeconds * 1000);
  const scheduledPhase = (time: number) => {
    let position =
      (((Math.round(time * 1000) + 999 - offset) % cycle) + cycle) % cycle;
    for (let phase = 0; phase < durations.length; phase++) {
      if (position < durations[phase]) return phase;
      position -= durations[phase];
    }
    return -1;
  };
  parseXml(bytes, (name, a, path) => {
    if (name !== "tlsState" || path.length !== 1 || path[0] !== "tlsStates")
      return;
    const phase = Number(a.phase),
      time = Number(a.time);
    if (
      a.id !== signal.id ||
      a.programID !== signal.programId ||
      !Number.isInteger(phase) ||
      !signal.phases[phase] ||
      signal.phases[phase].state !== a.state ||
      time !== expectedTime ||
      phase !== scheduledPhase(time)
    )
      fail(
        "Native signal-state output omitted time steps or executed an unexpected controller, program or phase.",
      );
    expectedTime++;
  });
  if (expectedTime !== end)
    fail(
      "Native signal-state output does not cover the complete simulation window.",
    );
}
