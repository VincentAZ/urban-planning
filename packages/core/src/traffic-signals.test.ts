import { describe, expect, it } from "vitest";
import {
  applyTrafficSignalTiming,
  trafficCapturedSignalTimingSchema,
  trafficSignalEditablePhase,
  trafficSignalProgramHash,
  trafficSignalTimingsSchema,
  validateTrafficSignalTimings,
  verifyTrafficCapturedSignalTiming,
  type TrafficSignalTiming,
} from "./index";
import { trafficNetworkFixture } from "./traffic-fixture";

async function fixture() {
  const network = trafficNetworkFixture();
  const signal = network.signals[0];
  signal.phases = [
    { durationSeconds: 30, state: "G" },
    { durationSeconds: 3.5, state: "y" },
    { durationSeconds: 1.25, state: "r" },
    { durationSeconds: 20, state: "g" },
    { durationSeconds: 2, state: "u" },
  ];
  signal.quality = "inferred";
  const control: TrafficSignalTiming = {
    signalId: signal.id,
    programId: signal.programId,
    baselineProgramHash: await trafficSignalProgramHash(signal),
    phaseDurationsSeconds: [40, 3.5, 1.25, 15, 2],
    offsetSeconds: 8,
    rationale:
      "Synthetic timing experiment; existing inferred clearance is preserved, not certified.",
  };
  return { network, signal, control };
}
describe("existing native signal timing controls", () => {
  it("changes only entered green holds and offset, preserving all movements, clearance and source evidence without mutation", async () => {
    const { network, signal, control } = await fixture();
    const before = structuredClone(network);
    await expect(
      validateTrafficSignalTimings(network, [control]),
    ).resolves.toBeUndefined();
    const proposal = applyTrafficSignalTiming(signal, control);
    expect(proposal.phases.map((p) => p.durationSeconds)).toEqual([
      40, 3.5, 1.25, 15, 2,
    ]);
    expect(proposal.phases.map((p) => p.state)).toEqual(
      signal.phases.map((p) => p.state),
    );
    expect(proposal.connectionIds).toEqual([["connection-0", "connection-1"]]);
    expect(proposal.sourceIds).toEqual(signal.sourceIds);
    expect(proposal.quality).toBe("authored");
    expect(signal.quality).toBe("inferred");
    expect(network).toEqual(before);
    proposal.connectionIds[0].pop();
    expect(network).toEqual(before);
  });
  it("treats mixed yellow/green, all-red, red-yellow, stop and off phases as fixed clearance or unsupported holds", () => {
    for (const state of [
      "yG",
      "Yr",
      "uG",
      "rr",
      "RR",
      "sG",
      "oG",
      "OG",
      "",
      "xG",
    ])
      expect(trafficSignalEditablePhase({ state, durationSeconds: 5 })).toBe(
        false,
      );
    for (const state of ["G", "g", "rGgR", "GG"])
      expect(trafficSignalEditablePhase({ state, durationSeconds: 5 })).toBe(
        true,
      );
  });
  it("rejects every non-green duration change rather than silently rounding or rescaling it", async () => {
    const { signal, control } = await fixture();
    for (const index of [1, 2, 4]) {
      const changed = structuredClone(control);
      changed.phaseDurationsSeconds[index] += 1;
      expect(() => applyTrafficSignalTiming(signal, changed)).toThrow(
        /exactly unchanged/,
      );
    }
  });
  it("retains exact fractional baseline values but accepts only whole-second authored changes and offsets within the new cycle", async () => {
    const { signal, control } = await fixture();
    signal.phases[0].durationSeconds = 30.25;
    signal.offsetSeconds = 0.25;
    control.phaseDurationsSeconds[0] = 30.25;
    control.offsetSeconds = 0.25;
    expect(
      applyTrafficSignalTiming(signal, control).phases[0].durationSeconds,
    ).toBe(30.25);
    for (const value of [0, 0.5, 40.25, 3601, Infinity, NaN]) {
      const changed = structuredClone(control);
      changed.phaseDurationsSeconds[0] = value;
      expect(() => applyTrafficSignalTiming(signal, changed)).toThrow();
    }
    for (const value of [
      -1,
      1.5,
      control.phaseDurationsSeconds.reduce((a, b) => a + b, 0),
      7201,
    ])
      expect(() =>
        applyTrafficSignalTiming(signal, { ...control, offsetSeconds: value }),
      ).toThrow();
    expect(
      applyTrafficSignalTiming(signal, { ...control, offsetSeconds: 1 })
        .offsetSeconds,
    ).toBe(1);
  });
  it("binds program hashes to exact states, movement order, timing, quality and source IDs", async () => {
    const { network, signal, control } = await fixture();
    const changes = [
      () => {
        signal.phases[0].state = "g";
      },
      () => {
        signal.connectionIds[0].reverse();
      },
      () => {
        signal.offsetSeconds = 1;
      },
      () => {
        signal.quality = "source";
      },
      () => {
        signal.sourceIds = ["different-citation"];
      },
    ];
    const original = structuredClone(signal);
    for (const change of changes) {
      Object.assign(signal, structuredClone(original));
      change();
      expect(await trafficSignalProgramHash(signal)).not.toBe(
        control.baselineProgramHash,
      );
    }
    Object.assign(signal, original);
    await expect(
      validateTrafficSignalTimings(network, [
        { ...control, baselineProgramHash: "f".repeat(64) },
      ]),
    ).rejects.toThrow(/hash/);
    await expect(
      validateTrafficSignalTimings(network, [
        { ...control, programId: "other" },
      ]),
    ).rejects.toThrow(/exact baseline/);
  });
  it("rejects changed captured states, provenance or movements even when both objects have valid individual shapes", async () => {
    const { signal, control } = await fixture();
    const entry = {
      control,
      baseline: signal,
      proposal: applyTrafficSignalTiming(signal, control),
    };
    await expect(
      verifyTrafficCapturedSignalTiming(entry),
    ).resolves.toBeUndefined();
    for (const change of [
      (s: typeof signal) => {
        s.phases[0].state = "g";
      },
      (s: typeof signal) => {
        s.phases.reverse();
      },
      (s: typeof signal) => {
        s.sourceIds = ["invented-source"];
      },
      (s: typeof signal) => {
        s.connectionIds[0].reverse();
      },
      (s: typeof signal) => {
        s.quality = "source";
      },
    ]) {
      const tampered = structuredClone(entry);
      change(tampered.proposal);
      expect(
        trafficCapturedSignalTimingSchema.safeParse(tampered).success,
      ).toBe(false);
    }
  });
  it("rejects duplicate controllers, absent programs, ambiguous movement inventories and bounded phase/cycle excess", async () => {
    const { network, signal, control } = await fixture();
    expect(
      trafficSignalTimingsSchema.safeParse([control, control]).success,
    ).toBe(false);
    expect(
      trafficSignalTimingsSchema.safeParse(
        Array.from({ length: 101 }, (_, i) => ({
          ...control,
          signalId: `signal-${i}`,
        })),
      ).success,
    ).toBe(false);
    await expect(
      validateTrafficSignalTimings(network, [
        { ...control, signalId: "absent" },
      ]),
    ).rejects.toThrow(/absent/);
    for (const modify of [
      (s: typeof signal) => s.connectionIds[0].push(s.connectionIds[0][0]),
      (s: typeof signal) => s.nodeIds.splice(0),
      (s: typeof signal) => {
        s.phases[0].state = "GG";
      },
      (s: typeof signal) => {
        s.phases = Array.from({ length: 65 }, () => ({
          state: "G",
          durationSeconds: 1,
        }));
      },
      (s: typeof signal) => {
        s.phases[0].durationSeconds = 7200;
      },
      (s: typeof signal) => {
        s.phases = s.phases.map((p) => ({ ...p, state: "r" }));
      },
    ]) {
      const malformed = structuredClone(signal);
      modify(malformed);
      expect(() => applyTrafficSignalTiming(malformed, control)).toThrow();
    }
  });
  it("blocks simultaneous lane/closure changes on controlled incoming and outgoing edges but permits speeds and unrelated topology controls", async () => {
    const { network, control } = await fixture();
    for (const edgeId of ["in", "top", "bottom"])
      for (const overlay of [
        { edgeId, lanes: 2 },
        { edgeId, closed: true },
      ])
        await expect(
          validateTrafficSignalTimings(network, [control], [overlay]),
        ).rejects.toThrow(/controlled incoming or outgoing/);
    await expect(
      validateTrafficSignalTimings(
        network,
        [control],
        [
          { edgeId: "in", speedMps: 8 },
          { edgeId: "out", lanes: 2 },
        ],
      ),
    ).resolves.toBeUndefined();
  });
});
