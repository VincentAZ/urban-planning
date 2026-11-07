import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canonicalJSON,
  trafficSignalProgramHash,
  validateTrafficSignalTimings,
  applyTrafficSignalTiming,
  type TrafficSignal,
} from "@urban/core";
import {
  trafficNetworkFixture,
  trafficCountFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
} from "../../../../packages/core/src/traffic-fixture";
import {
  signalDraftFromProgram,
  signalTimingDraft,
  readSignalTimingDraft,
  readSignalTimingDrafts,
  redistributeSignalGreen,
  signalGroupGreen,
  signalStateLabel,
  signalTimingEligibility,
  signalTimingControlLimit,
} from "./traffic-signal-draft";
import { admittedTrafficDraft } from "./traffic-session";
import {
  TrafficSignalEvidence,
  SignalTimeline,
} from "../components/traffic/TrafficSignalEvidence";
const program = (): TrafficSignal => ({
  id: "controller",
  programId: "0",
  nodeIds: ["junction"],
  connectionIds: [["straight-a"], ["straight-b"]],
  offsetSeconds: 0,
  phases: [
    { durationSeconds: 42, state: "Gr" },
    { durationSeconds: 3, state: "yr" },
    { durationSeconds: 42, state: "rG" },
    { durationSeconds: 3, state: "ry" },
  ],
  quality: "inferred",
  sourceIds: ["source"],
});
async function draft() {
  const signal = program();
  return {
    signal,
    draft: {
      ...signalDraftFromProgram(signal, await trafficSignalProgramHash(signal)),
      rationale: "Authored timing experiment, not field timing.",
    },
  };
}
describe("signal timing draft integrity", () => {
  it("preserves an unchanged cycle exactly, including retained fractions, and tolerates only arithmetic roundoff in a fractional clearance budget", async () => {
    const signal = program();
    signal.phases = [
      { state: "Gr", durationSeconds: 1 },
      { state: "yr", durationSeconds: 1.1 },
      { state: "rG", durationSeconds: 99 },
      { state: "rr", durationSeconds: 2.2 },
    ];
    const raw = {
      ...signalDraftFromProgram(signal, await trafficSignalProgramHash(signal)),
      rationale: "No-op redistribution should be exact.",
    };
    expect(redistributeSignalGreen(raw, signal)).toEqual(raw);
    signal.phases[0].durationSeconds = 15.25;
    signal.phases[2].durationSeconds = 15;
    const fractions = {
      ...signalDraftFromProgram(signal, await trafficSignalProgramHash(signal)),
      rationale: "Retained fractions.",
    };
    expect(redistributeSignalGreen(fractions, signal)).toEqual(fractions);
    const target = { ...fractions, cycleSeconds: "33.3" };
    const result = redistributeSignalGreen(target, signal);
    expect(result.phaseDurationsSeconds[1]).toBe("1.1");
    expect(result.phaseDurationsSeconds[3]).toBe("2.2");
    expect(
      Number(result.phaseDurationsSeconds[0]) +
        Number(result.phaseDurationsSeconds[2]),
    ).toBe(30);
    expect(() => readSignalTimingDraft(result, signal)).not.toThrow();
    expect(() =>
      redistributeSignalGreen(
        { ...fractions, cycleSeconds: "33.30000001" },
        signal,
      ),
    ).toThrow("whole second");
  });
  it("withholds stale phase-array previews instead of crashing or inventing a movement green total", () => {
    const signal = program();
    const old = [42, 3, 42, 3, 15];
    expect(() =>
      renderToStaticMarkup(
        createElement(SignalTimeline, {
          signal,
          durations: old,
          label: "Stale preview",
        }),
      ),
    ).not.toThrow();
    expect(
      renderToStaticMarkup(
        createElement(SignalTimeline, {
          signal,
          durations: old,
          label: "Stale preview",
        }),
      ),
    ).toContain("phase sequence changed");
    expect(signalGroupGreen(signal, old, 0)).toBeNull();
    expect(signalGroupGreen(signal, [NaN, 3, 42, 3], 0)).toBeNull();
  });
  it("colors only eligible green holds as editable and retains uppercase clearance and mixed off states", () => {
    const signal = program();
    signal.phases = [
      { state: "RG", durationSeconds: 10 },
      { state: "YG", durationSeconds: 3 },
      { state: "UG", durationSeconds: 2 },
      { state: "oG", durationSeconds: 4 },
      { state: "sG", durationSeconds: 5 },
    ];
    const html = renderToStaticMarkup(
      createElement(SignalTimeline, {
        signal,
        durations: signal.phases.map((p) => p.durationSeconds),
        label: "Authored timing preview",
      }),
    );
    expect(html.match(/class="green"/g)).toHaveLength(1);
    expect(html.match(/class="transition"/g)).toHaveLength(2);
    expect(html.match(/class="clearance"/g)).toHaveLength(2);
    expect(
      signalGroupGreen(
        signal,
        signal.phases.map((p) => p.durationSeconds),
        1,
      ),
    ).toBe(24);
    expect(signalStateLabel("RYU")).toBe("red, yellow, red and yellow");
  });
  it("uses native eligibility only for the exact network and program identity", async () => {
    const f = await draft(),
      control = readSignalTimingDraft(f.draft, f.signal),
      networkHash = "a".repeat(64);
    const eligibility = {
      networkHash,
      controllerLimit: 16,
      programs: [
        {
          signalId: control.signalId,
          programId: control.programId,
          baselineProgramHash: control.baselineProgramHash,
          eligible: false,
          reason: "Actuated sequence requires unsupported detector controls.",
        },
      ],
    };
    expect(signalTimingControlLimit(networkHash, eligibility)).toBe(16);
    expect(signalTimingControlLimit("b".repeat(64), eligibility)).toBe(100);
    expect(signalTimingEligibility(networkHash, control, eligibility)).toEqual({
      status: "ineligible",
      reason: eligibility.programs[0].reason,
    });
    expect(
      signalTimingEligibility("b".repeat(64), control, eligibility).status,
    ).toBe("unverified");
    expect(
      signalTimingEligibility(
        networkHash,
        { ...control, baselineProgramHash: "c".repeat(64) },
        eligibility,
      ).status,
    ).toBe("unverified");
    expect(signalTimingEligibility(networkHash, control).status).toBe(
      "unverified",
    );
    expect(
      signalTimingEligibility(networkHash, control, {
        ...eligibility,
        programs: [
          { ...eligibility.programs[0], eligible: true, reason: null },
        ],
      }).status,
    ).toBe("eligible");
  });
  it("redistributes only after explicit action, preserving exact clearance, budget and source bytes", async () => {
    const f = await draft(),
      before = canonicalJSON(f.signal),
      pending = { ...f.draft, cycleSeconds: "103" };
    expect(() => readSignalTimingDraft(pending, f.signal)).toThrow(
      "Redistribute",
    );
    const changed = redistributeSignalGreen(pending, f.signal);
    expect(changed.phaseDurationsSeconds).toEqual(["49", "3", "48", "3"]);
    expect(
      readSignalTimingDraft(changed, f.signal).phaseDurationsSeconds.reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(103);
    expect(pending.phaseDurationsSeconds).toEqual(["42", "3", "42", "3"]);
    expect(canonicalJSON(f.signal)).toBe(before);
    expect(() =>
      redistributeSignalGreen({ ...pending, cycleSeconds: "7" }, f.signal),
    ).toThrow("clearance");
  });
  it("retains raw blanks and invalid numeric inputs instead of coercing zero or silently applying a target", async () => {
    const f = await draft();
    for (const raw of ["", " ", "-1", "1e2", "NaN", "Infinity", "4.2"]) {
      const invalid = {
        ...f.draft,
        phaseDurationsSeconds: [raw, ...f.draft.phaseDurationsSeconds.slice(1)],
      };
      expect(() => readSignalTimingDraft(invalid, f.signal)).toThrow();
      expect(invalid.phaseDurationsSeconds[0]).toBe(raw);
    }
    expect(() =>
      readSignalTimingDraft(
        {
          ...f.draft,
          phaseDurationsSeconds: ["42", "4", "42", "3"],
          cycleSeconds: "91",
        },
        f.signal,
      ),
    ).toThrow("clearance");
    expect(() =>
      readSignalTimingDraft({ ...f.draft, offsetSeconds: "90" }, f.signal),
    ).toThrow("offset");
    expect(() =>
      readSignalTimingDraft({ ...f.draft, rationale: " " }, f.signal),
    ).toThrow("assumption");
  });
  it("preserves unchanged fractional baseline values without rounding and distinguishes movement green from phase shares", async () => {
    const signal = program();
    signal.phases[0].durationSeconds = 42.25;
    signal.offsetSeconds = 0.5;
    const value = {
      ...signalDraftFromProgram(signal, await trafficSignalProgramHash(signal)),
      rationale: "Retain captured fractions.",
    };
    expect(readSignalTimingDraft(value, signal).phaseDurationsSeconds[0]).toBe(
      42.25,
    );
    expect(readSignalTimingDraft(value, signal).offsetSeconds).toBe(0.5);
    signal.phases[1].state = "yG";
    expect(
      signalGroupGreen(
        signal,
        signal.phases.map((p) => p.durationSeconds),
        1,
      ),
    ).toBe(45);
    expect(signalStateLabel("Ggys")).toBe(
      "priority green, yielding green, yellow, stop then yield",
    );
  });
  it("binds the current program and rejects controlled lane/closure conflicts before save", async () => {
    const network = trafficNetworkFixture(),
      signal = network.signals[0];
    const raw = {
      ...signalDraftFromProgram(signal, await trafficSignalProgramHash(signal)),
      phaseDurationsSeconds: ["40", "30"],
      cycleSeconds: "70",
      offsetSeconds: "5",
      rationale: "Test exact native timing.",
    };
    const controls = readSignalTimingDrafts([raw], network);
    await expect(
      validateTrafficSignalTimings(network, controls),
    ).resolves.toBeUndefined();
    await expect(
      validateTrafficSignalTimings(network, controls, [
        { edgeId: "in", lanes: 2 },
      ]),
    ).rejects.toThrow("lane-count or closure");
    const changed = structuredClone(network);
    changed.signals[0].phases[0].durationSeconds = 35;
    await expect(
      validateTrafficSignalTimings(changed, controls),
    ).rejects.toThrow("hash");
    expect(() =>
      readSignalTimingDrafts([raw], { ...network, signals: [] }),
    ).toThrow("absent");
  });
  it("retains exact optional timing controls through API admission, without adding fields to a legacy draft", async () => {
    const f = await draft(),
      timing = readSignalTimingDraft(f.draft, f.signal);
    const value = {
      networkHash: "a".repeat(64),
      seed: 1,
      calibrationPlan: null,
      scopeAcknowledged: true,
      countPack: trafficCountFixture(),
      demand: trafficDemandFixture(),
      period: trafficFixturePeriod,
      overlays: [],
      sourceDeclarations: [],
      stagedFiles: [],
      mappingReviews: [],
    };
    expect(admittedTrafficDraft(value, new Map()).request).not.toHaveProperty(
      "signalTimings",
    );
    const result = admittedTrafficDraft(
      { ...value, signalTimings: [timing] },
      new Map(),
    );
    expect(result.request.signalTimings).toEqual([timing]);
    expect(result.request.signalTimings?.[0]).not.toBe(timing);
    expect(signalTimingDraft(timing)).toEqual(f.draft);
  });
  it("public timing evidence shows exact before/after and keeps inferred timing distinct from authored assumptions", async () => {
    const f = await draft(),
      control = readSignalTimingDraft(
        {
          ...f.draft,
          phaseDurationsSeconds: ["54", "3", "42", "3"],
          cycleSeconds: "102",
          offsetSeconds: "5",
        },
        f.signal,
      );
    const html = renderToStaticMarkup(
      createElement(TrafficSignalEvidence, {
        timings: [
          {
            control,
            baseline: f.signal,
            proposal: applyTrafficSignalTiming(f.signal, control),
          },
        ],
      }),
    );
    expect(html).toContain("Inferred baseline → authored proposal");
    expect(html).toContain("90 → 102");
    expect(html).toContain("0 → 5");
    expect(html).toContain("42 → 54");
    expect(html).toContain("not a surveyed or field-validated plan");
    expect(html).toContain("ratios overlap");
    expect(html).toContain(control.baselineProgramHash);
  });
});
