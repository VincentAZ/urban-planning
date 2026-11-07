/** Synthetic test-only evidence; no native routing or Census source claim. */
import { trafficCommuteFixture } from "../../core/src/traffic-commute-fixture";
import { trafficNetworkFixture } from "../../core/src/traffic-fixture";
import {
  trafficContentHash,
  type TrafficNetwork,
  type TrafficCommuteBinding,
  type TrafficCommuteRouteSet,
  type TrafficCommuteSourcePack,
} from "@urban/core";
import {
  buildTrafficCommutePrior,
  compileTrafficCommuteDemand,
  createTrafficCommuteSummary,
} from "./traffic-commute";

export async function trafficCommuteEvidenceFixture(
  options: {
    network?: TrafficNetwork;
    changePack?: (pack: TrafficCommuteSourcePack) => void;
    changeRoutes?: (routes: TrafficCommuteRouteSet) => void;
  } = {},
) {
  const { pack, recipe } = trafficCommuteFixture();
  options.changePack?.(pack);
  recipe.period.beginSeconds = 28800;
  recipe.period.endSeconds = 32400;
  recipe.period.warmupSeconds = 1800;
  const prior = buildTrafficCommutePrior(pack, recipe),
    network = options.network ?? trafficNetworkFixture();
  const routes: TrafficCommuteRouteSet = {
    version: 1,
    sourcePackHash: await trafficContentHash(pack),
    priorHash: await trafficContentHash(prior),
    regionalGraphHash: "a".repeat(64),
    regionalSettingsHash: "b".repeat(64),
    localNetworkHash: network.manifest.networkFileSha256,
    localInventoryHash: await trafficContentHash(network),
    attachments: pack.flows.map((f) => ({
      flowId: f.id,
      status: "routed",
      regionalRouteHash: "c".repeat(64),
      regionalSeconds: 1200.5,
      local: {
        edges: ["in", "top", "topjoin", "out"],
        prefixSeconds: 900.25,
        suffixSeconds: 100.125,
        classification: "through",
        bindingHash: "d".repeat(64),
        departLaneId: "in_0",
        departPositionMeters: 12.5,
        arrivalLaneId: "out_0",
        arrivalPositionMeters: 87.75,
      },
      notes: ["Synthetic route evidence."],
    })),
    notes: [],
  };
  options.changeRoutes?.(routes);
  const compilation = await compileTrafficCommuteDemand(
    prior,
    routes,
    network,
    { sourcePack: pack },
  );
  const binding: TrafficCommuteBinding = {
    version: 1,
    presetId: "fixture",
    assetHash: "e".repeat(64),
    sourcePackHash: await trafficContentHash(pack),
    priorHash: await trafficContentHash(prior),
    routesHash: await trafficContentHash(routes),
    compilationHash: await trafficContentHash(compilation),
    demandHash: compilation.demandHash,
    periodHash: await trafficContentHash(recipe.period),
    networkHash: network.manifest.networkFileSha256,
    inventoryHash: await trafficContentHash(network),
  };
  const input = {
    binding,
    sourcePack: pack,
    prior,
    routes,
    compilation,
    network,
  };
  return { ...input, summary: await createTrafficCommuteSummary(input) };
}
