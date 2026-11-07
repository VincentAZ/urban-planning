import { trafficNativeSettings } from "./native-settings.js";
/** Synthetic native boundary for isolated lifecycle tests; never used by runtime configuration. */
import { createHash } from "node:crypto";
import {
  applyTrafficSignalTiming,
  trafficContentHash,
  canonicalJSON,
  trafficPairRecipeHash,
} from "@urban/core";
import {
  trafficRecipeFixture,
  trafficResultFixture,
} from "../../../../packages/core/src/traffic-fixture";
import type { TrafficNativePairRequest, TrafficNativePair } from "./types";
export class FixtureRuntime {
  calls = 0;
  error: Error | undefined;
  onRun: ((input: TrafficNativePairRequest) => Promise<void>) | undefined;
  worker = Buffer.from("Synthetic contract fixture. No native execution.");
  async available() {
    return {
      available: true,
      image: "synthetic",
      version: "synthetic",
      reason: null,
    };
  }
  async runPair(input: TrafficNativePairRequest): Promise<TrafficNativePair> {
    this.calls++;
    await this.onRun?.(input);
    input.signal?.throwIfAborted();
    if (this.error) throw this.error;
    const proposalNetwork = structuredClone(input.network.network);
    for (const overlay of input.overlays) {
      if (overlay.closed)
        throw new Error(
          "Synthetic fixture only implements lane/speed controls; native closure tests remain separate.",
        );
      const edge = proposalNetwork.edges.find(
        (edge) => edge.id === overlay.edgeId,
      )!;
      if (overlay.lanes !== undefined)
        edge.lanes = Array.from({ length: overlay.lanes }, (_, index) => ({
          ...edge.lanes[Math.min(index, edge.lanes.length - 1)],
          id: `${edge.id}_${index}`,
          index,
        }));
      if (overlay.speedMps !== undefined)
        edge.lanes.forEach((lane) => (lane.speedMps = overlay.speedMps!));
    }
    if (input.signalTimings?.length)
      for (const control of input.signalTimings) {
        const index = proposalNetwork.signals.findIndex(
          (signal) => signal.id === control.signalId,
        );
        proposalNetwork.signals[index] = applyTrafficSignalTiming(
          proposalNetwork.signals[index],
          control,
        );
      }
    if (input.overlays.length)
      proposalNetwork.manifest.conversion.options = [
        ...proposalNetwork.manifest.conversion.options,
        "--precision",
        "6",
      ];
    const proposalXml = input.signalTimings?.length
      ? syntheticSignalXml(proposalNetwork.signals)
      : input.overlays.length
        ? Buffer.from(
            `<net>Synthetic controlled fixture ${canonicalJSON(input.overlays)}</net>`,
          )
        : input.network.networkXml;
    proposalNetwork.manifest.networkFileSha256 = createHash("sha256")
      .update(proposalXml)
      .digest("hex");
    const settings = trafficNativeSettings({
      workerSha256: createHash("sha256").update(this.worker).digest("hex"),
      overlays: input.overlays,
      ...(input.signalTimings !== undefined
        ? { signalTimings: input.signalTimings }
        : {}),
      submittedVehiclesHash: await trafficContentHash(input.vehicles),
      mappedCountsHash: await trafficContentHash(input.counts),
      ...(input.vehicles.some((vehicle) => vehicle.endpoints)
        ? { explicitEndpoints: true }
        : {}),
    });
    const recipe = {
        ...trafficRecipeFixture(),
        ...(input.signalTimings !== undefined ||
        input.vehicles.some((vehicle) => vehicle.endpoints)
          ? { settingsHash: await trafficContentHash(settings) }
          : {}),
        baselineNetworkHash: input.network.network.manifest.networkFileSha256,
        proposalNetworkHash: proposalNetwork.manifest.networkFileSha256,
        demandHash: input.demandHash,
        countPackHash: input.countPackHash,
        seed: input.seed,
        period: input.period,
      },
      recipeHash = await trafficPairRecipeHash(recipe);
    const result = (side: "baseline" | "proposal") => ({
      ...trafficResultFixture(side),
      recipeHash,
      networkHash:
        side === "baseline"
          ? recipe.baselineNetworkHash
          : recipe.proposalNetworkHash,
      demandHash: recipe.demandHash,
      seed: input.seed,
      period: input.period,
      diagnostics: {
        requested: input.vehicles.length,
        loaded: input.vehicles.length,
        inserted: input.vehicles.length,
        arrived: input.vehicles.length,
        running: 0,
        waiting: 0,
        discarded: 0,
        teleports: 0,
        collisions: 0,
        routeErrors: 0,
      },
      trips: input.vehicles.map((v) => ({
        id: v.id,
        requestedDepartSeconds: v.departSeconds,
        arrived: true,
        departSeconds: v.departSeconds,
        arrivalSeconds: v.departSeconds + 40,
        durationSeconds: 40,
        routeLengthMeters: 400,
        waitingSeconds: 0,
        timeLossSeconds: 0,
        departDelaySeconds: 0,
      })),
      predictions: input.counts.map((c) => ({
        countId: c.id,
        vehicles: null,
        status: "unavailable" as const,
        reason: "Unmapped synthetic test count.",
      })),
    });
    return {
      recipe,
      recipeHash,
      baselineNetwork: input.network.network,
      proposalNetwork,
      baseline: result("baseline"),
      proposal: result("proposal"),
      resources: input.network.resources,
      files: {
        "baseline.net.xml": input.network.networkXml,
        ...(input.overlays.length || input.signalTimings?.length
          ? { "proposal.net.xml": proposalXml }
          : {}),
        ...(input.signalTimings !== undefined ||
        input.vehicles.some((vehicle) => vehicle.endpoints)
          ? { "native-settings.json": Buffer.from(canonicalJSON(settings)) }
          : {}),
        ...Object.fromEntries(
          (input.signalTimings ?? []).flatMap((control, index) =>
            ["baseline", "proposal"].map((side) => {
              const signal = (
                side === "baseline" ? input.network.network : proposalNetwork
              ).signals.find((s) => s.id === control.signalId)!;
              const cycle = signal.phases.reduce(
                (sum, p) => sum + p.durationSeconds,
                0,
              );
              const begin =
                  input.period.beginSeconds - input.period.warmupSeconds,
                end = input.period.endSeconds + input.period.cooldownSeconds;
              return [
                `${side}-signal-${index}.xml`,
                Buffer.from(
                  "<tlsStates>" +
                    Array.from({ length: end - begin }, (_, i) => {
                      const time = begin + i;
                      let phase = 0,
                        pos =
                          (((time - signal.offsetSeconds) % cycle) + cycle) %
                          cycle;
                      while (pos >= signal.phases[phase].durationSeconds) {
                        pos -= signal.phases[phase++].durationSeconds;
                      }
                      return `<tlsState time="${time}" id="${signal.id}" programID="${signal.programId}" phase="${phase}" state="${signal.phases[phase].state}"/>`;
                    }).join("") +
                    "</tlsStates>",
                ),
              ];
            }),
          ),
        ),
        "worker.py": this.worker,
      },
      notes: ["Synthetic lifecycle test; no native execution."],
    };
  }
}

/** Minimal declarative XML used only in contract fixtures, not a native graph. */
export function syntheticSignalXml(
  signals: import("@urban/core").TrafficSignal[],
): Buffer {
  return Buffer.from(
    "<net>" +
      signals
        .map(
          (signal) =>
            `<tlLogic id="${signal.id}" programID="${signal.programId}" type="static" offset="${signal.offsetSeconds}">${signal.phases.map((phase) => `<phase state="${phase.state}" duration="${phase.durationSeconds}"/>`).join("")}</tlLogic>`,
        )
        .join("") +
      "</net>",
  );
}
