import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  trafficNetworkFixture,
  trafficFixturePeriod,
} from "../../../../packages/core/src/traffic-fixture";
import {
  applyTrafficSignalTiming,
  trafficSignalProgramHash,
} from "@urban/core";
import {
  assertNativeSignalTimings,
  trafficSignalTimingEligibility,
  assertTrafficSignalEffects,
  assertSignalStateOutput,
} from "./signal-effects.js";
import { assertTrafficOverlayEffects } from "./overlay-effects.js";
import type { PreparedTrafficNetwork } from "./types.js";
async function fixture(extra = "", type = "static") {
  const network = trafficNetworkFixture(),
    signal = network.signals[0];
  signal.phases = [
    { durationSeconds: 10, state: "G" },
    { durationSeconds: 3, state: "y" },
    { durationSeconds: 7, state: "r" },
  ];
  signal.offsetSeconds = 0;
  const raw = Buffer.from(
    `<net><tlLogic id="${signal.id}" programID="${signal.programId}" type="${type}" offset="0"><phase duration="10" state="G" ${extra}/><phase duration="3" state="y"/><phase duration="7" state="r"/></tlLogic></net>`,
  );
  network.manifest.networkFileSha256 = createHash("sha256")
    .update(raw)
    .digest("hex");
  const prepared: PreparedTrafficNetwork = {
    network,
    networkXml: raw,
    files: {},
    resources: {
      wallMilliseconds: 0,
      peakMemoryBytes: 0,
      cpuLimit: 2,
      memoryLimitBytes: 2 ** 31,
      outputBytes: 0,
    },
  };
  const control = {
    signalId: signal.id,
    programId: signal.programId,
    baselineProgramHash: await trafficSignalProgramHash(signal),
    phaseDurationsSeconds: [12, 3, 7],
    offsetSeconds: 5,
    rationale: "Explicit synthetic fixed-time comparison.",
  };
  return { prepared, signal, control };
}
describe("native signal authority and actual state evidence", () => {
  it("binds eligibility to complete XML and accepts a simple static phase sequence", async () => {
    const { prepared, control } = await fixture();
    const result = await trafficSignalTimingEligibility(prepared);
    expect(result.programs[0]).toMatchObject({
      eligible: true,
      reason: null,
      baselineProgramHash: control.baselineProgramHash,
    });
    await expect(
      assertNativeSignalTimings(prepared, [control]),
    ).resolves.toBeUndefined();
    prepared.networkXml = Buffer.from("<net/>");
    await expect(trafficSignalTimingEligibility(prepared)).rejects.toThrow(
      /identity/,
    );
  });
  it.each(['next="0"', 'minDur="1"', 'maxDur="20"', 'earlyTarget="x"'])(
    "rejects dynamic/branching native attribute %s",
    async (attr) => {
      const { prepared, control } = await fixture(attr);
      await expect(
        assertNativeSignalTimings(prepared, [control]),
      ).rejects.toThrow(/simple static/);
    },
  );
  it("rejects actuated, XML entity declarations, duplicates and inventory mismatches", async () => {
    const { prepared, control } = await fixture("", "actuated");
    await expect(
      assertNativeSignalTimings(prepared, [control]),
    ).rejects.toThrow(/simple static/);
    const next = await fixture();
    next.prepared.network.signals[0].phases[0].durationSeconds = 9;
    expect(
      (await trafficSignalTimingEligibility(next.prepared)).programs[0]
        .eligible,
    ).toBe(false);
    const raw = Buffer.from(
      '<!DOCTYPE net [<!ENTITY x SYSTEM "file:///private">]><net/>',
    );
    prepared.networkXml = raw;
    prepared.network.manifest.networkFileSha256 = createHash("sha256")
      .update(raw)
      .digest("hex");
    await expect(trafficSignalTimingEligibility(prepared)).rejects.toThrow(
      /document types/,
    );
    const duplicate = await fixture();
    duplicate.prepared.networkXml = Buffer.from(
      duplicate.prepared.networkXml
        .toString()
        .replace(
          "</net>",
          duplicate.prepared.networkXml
            .toString()
            .replace(/^<net>|<\/net>$/g, "") + "</net>",
        ),
    );
    duplicate.prepared.network.manifest.networkFileSha256 = createHash("sha256")
      .update(duplicate.prepared.networkXml)
      .digest("hex");
    expect(
      (await trafficSignalTimingEligibility(duplicate.prepared)).programs[0]
        .eligible,
    ).toBe(false);
  });
  it("requires exact effective program and protects timing-only geometry, movements and other programs", async () => {
    const { prepared, signal, control } = await fixture();
    const proposal = structuredClone(prepared.network);
    proposal.signals[0] = applyTrafficSignalTiming(signal, control);
    proposal.manifest.networkFileSha256 = "f".repeat(64);
    await expect(
      assertTrafficSignalEffects(prepared.network, proposal, [control]),
    ).resolves.toHaveLength(1);
    expect(() =>
      assertTrafficOverlayEffects(prepared.network, proposal, [], 6, [control]),
    ).not.toThrow();
    proposal.connections[0].direction = "unknown";
    expect(() =>
      assertTrafficOverlayEffects(prepared.network, proposal, [], 6, [control]),
    ).toThrow(/topology/);
    proposal.signals[0].phases[0].durationSeconds++;
    await expect(
      assertTrafficSignalEffects(prepared.network, proposal, [control]),
    ).rejects.toThrow(/Executed/);
  });
  it("rejects missing, stuck-phase and wrong-offset output, accepting exact complete schedule", async () => {
    const { signal } = await fixture();
    const period = {
      ...trafficFixturePeriod,
      beginSeconds: 0,
      endSeconds: 40,
      warmupSeconds: 0,
      cooldownSeconds: 0,
    };
    const state = (phase: (t: number) => number) =>
      Buffer.from(
        "<tlsStates>" +
          Array.from({ length: 40 }, (_, t) => {
            const p = phase(t);
            return `<tlsState time="${t}" id="${signal.id}" programID="${signal.programId}" phase="${p}" state="${signal.phases[p].state}"/>`;
          }).join("") +
          "</tlsStates>",
      );
    const valid = state((t) => (t % 20 < 10 ? 0 : t % 20 < 13 ? 1 : 2));
    expect(() => assertSignalStateOutput(valid, signal, period)).not.toThrow();
    expect(() =>
      assertSignalStateOutput(
        state(() => 0),
        signal,
        period,
      ),
    ).toThrow();
    expect(() =>
      assertSignalStateOutput(valid, { ...signal, offsetSeconds: 5 }, period),
    ).toThrow();
    expect(() =>
      assertSignalStateOutput(Buffer.from("<tlsStates/>"), signal, period),
    ).toThrow(/complete/);
  });
  it("rejects excessive retained state output before a native run", async () => {
    const { prepared, control } = await fixture();
    await expect(
      assertNativeSignalTimings(prepared, [control], [], {
        ...trafficFixturePeriod,
        beginSeconds: 0,
        endSeconds: 250001,
        warmupSeconds: 0,
        cooldownSeconds: 0,
      }),
    ).rejects.toThrow(/250,000/);
  });
  it("rejects controller/file overflow and fractional native programs before execution", async () => {
    const { prepared, control } = await fixture();
    await expect(
      assertNativeSignalTimings(
        prepared,
        Array.from({ length: 17 }, () => control),
      ),
    ).rejects.toThrow(/16 controllers/);
    prepared.network.signals[0].phases[1].durationSeconds = 3.5;
    prepared.networkXml = Buffer.from(
      prepared.networkXml.toString().replace('duration="3"', 'duration="3.5"'),
    );
    prepared.network.manifest.networkFileSha256 = createHash("sha256")
      .update(prepared.networkXml)
      .digest("hex");
    expect(
      (await trafficSignalTimingEligibility(prepared)).programs[0],
    ).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("whole-second"),
    });
  });
});
