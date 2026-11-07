/** Synthetic, file-backed proof fixture. No Census/provider/native execution claim. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalJSON,
  trafficContentHash,
  type TrafficNetwork,
  type TrafficCommuteRouteSet,
} from "@urban/core";
import {
  buildTrafficCommutePrior,
  compileTrafficCommuteDemand,
} from "@urban/models";
import { trafficCommuteFixture } from "../../../../packages/core/src/traffic-commute-fixture";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture";
import {
  commuteMeters,
  type CommuteRegionalRoute,
} from "./commute-routing-valhalla";
import { projectRetainedCommuteAttachment } from "./commute-routing";
import { buildCommuteNativeIndex, matchCommuteRoute } from "./commute-routing";
import { bindCommuteSourceGeometry } from "./commute-routing-source";
import { restoreCommuteNativeGeometry } from "./commute-routing-projection";
import { normalizeCommuteRoute } from "./commute-routing-valhalla";
import {
  trafficCommuteCorrespondenceRecipe,
  type TrafficCommuteCorrespondenceInput,
} from "./commute-proof";
import {
  packageTrafficCommutePreset,
  loadTrafficCommutePreset,
} from "./commute-evidence";
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function packagedCommuteFixture(
  root: string,
  network: TrafficNetwork = trafficNetworkFixture(),
) {
  const { pack, recipe } = trafficCommuteFixture();
  pack.sources[0].id = "commute-fixture";
  pack.sources[0].kind = "observed";
  for (const file of pack.files) file.sourceId = "commute-fixture";
  recipe.sourceIds = ["commute-fixture"];
  const reconciliation = Buffer.from(
    canonicalJSON({
      version: 1,
      synthetic: true,
      residentJobs: 100,
      knownDestinationJobs: 80,
    }),
  );
  const oldReconciliation = pack.reconciliation.evidenceFileSha256;
  pack.reconciliation.evidenceFileSha256 = hash(reconciliation);
  pack.files.find((file) => file.sha256 === oldReconciliation)!.sha256 =
    hash(reconciliation);
  const prior = buildTrafficCommutePrior(pack, recipe),
    proofDirectory = join(root, "proofs");
  await mkdir(proofDirectory, { recursive: true });
  async function put(name: string, value: unknown) {
    const bytes = Buffer.from(canonicalJSON(value)),
      path = join(proofDirectory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
    return hash(bytes);
  }
  const routes: TrafficCommuteRouteSet = {
    version: 1,
    sourcePackHash: await trafficContentHash(pack),
    priorHash: await trafficContentHash(prior),
    regionalGraphHash: "a".repeat(64),
    regionalSettingsHash: "b".repeat(64),
    localNetworkHash: network.manifest.networkFileSha256,
    localInventoryHash: await trafficContentHash(network),
    attachments: [],
    notes: ["Synthetic correspondence; no actual route provider."],
  };
  for (const [index, flow] of pack.flows.entries()) {
    const home = pack.blocks.find(
        (b) => b.geoid === flow.homeBlockGeoid,
      )!.position!,
      work = pack.blocks.find(
        (b) => b.geoid === flow.workBlockGeoid,
      )!.position!;
    const key = String(index + 1).repeat(64),
      rawRouteHash = await put(`route-cache/${key}/route.json`, {
        synthetic: "route",
        index,
      }),
      rawTraceHash = await put(`route-cache/${key}/trace.json`, {
        synthetic: "trace",
        index,
      });
    await put(`route-cache/${key}/receipt.json`, {
      routeHash: rawRouteHash,
      traceHash: rawTraceHash,
      routeStatus: 200,
      traceStatus: 200,
    });
    const regional: CommuteRegionalRoute = {
      version: 1,
      request: { home, work },
      graphHash: routes.regionalGraphHash,
      settingsHash: routes.regionalSettingsHash,
      sourcePbfHash: "c".repeat(64),
      shape: [home, work],
      segmentSeconds: [1200.5],
      edges: [
        {
          id: "1",
          wayId: "1",
          forward: true,
          beginShapeIndex: 0,
          endShapeIndex: 1,
          startSeconds: 0,
          endSeconds: 1200.5,
          sourcePercentAlong: null,
          targetPercentAlong: null,
        },
      ],
      seconds: 1200.5,
      homeSnapMeters: 0,
      workSnapMeters: 0,
      rawRouteHash,
      rawTraceHash,
      notes: ["Synthetic normalized response"],
    };
    const regionalHash = await trafficContentHash(regional);
    await put(`regional/${regionalHash}.json`, regional);
    const distance = commuteMeters(home, work),
      selected = ["in", "top", "topjoin", "out"].map((id, i) => ({
        edgeId: id,
        laneId: id + "_0",
        start: (distance * i) / 4,
        end: (distance * (i + 1)) / 4,
        laneStart: i === 0 ? 12.5 : 0,
        laneEnd: i === 3 ? 87.75 : 100,
        residual: 0,
      }));
    const body = {
      version: 1,
      regionalRouteHash: regionalHash,
      nativeXmlHash: routes.localNetworkHash,
      nativeInventoryHash: routes.localInventoryHash,
      nativeProjectionHash: null,
      selected,
      reason: null,
      endpoints: {
        departure: {
          laneId: "in_0",
          positionMeters: 12.5,
          regionalCutPoint: home,
          lanePoint: home,
          residualMeters: 0,
          reference: "SUMO vehicle front position" as const,
        },
        arrival: {
          laneId: "out_0",
          positionMeters: 87.75,
          regionalCutPoint: work,
          lanePoint: work,
          residualMeters: 0,
          reference: "SUMO vehicle front position" as const,
        },
      },
    };
    const bindingHash = await trafficContentHash(body),
      evidence = { ...body, bindingHash };
    await put(`bindings/${bindingHash}.json`, evidence);
    routes.attachments.push({
      flowId: flow.id,
      status: "routed",
      regionalRouteHash: regionalHash,
      regionalSeconds: regional.seconds,
      local: projectRetainedCommuteAttachment(
        flow.id,
        regional,
        evidence as Parameters<typeof projectRetainedCommuteAttachment>[2],
      ),
      notes: ["Synthetic reviewed local attachment"],
    });
  }
  const compilation = await compileTrafficCommuteDemand(
    prior,
    routes,
    network,
    { sourcePack: pack },
  );
  const paths = {
    sourcePackPath: join(root, "pack.json"),
    priorPath: join(root, "prior.json"),
    routesPath: join(root, "routes.json"),
    compilationPath: join(root, "compilation.json"),
    reconciliationPath: join(root, "reconciliation.json"),
  };
  for (const [path, value] of [
    [paths.sourcePackPath, pack],
    [paths.priorPath, prior],
    [paths.routesPath, routes],
    [paths.compilationPath, compilation],
  ] as const)
    await writeFile(path, canonicalJSON(value));
  await writeFile(paths.reconciliationPath, reconciliation);
  const input = {
    presetId: "synthetic-commute",
    outputDirectory: join(root, "preset"),
    network,
    ...paths,
    regionalProofDirectory: proofDirectory,
  };
  const receipt = await packageTrafficCommutePreset(input),
    descriptor = {
      id: input.presetId,
      label: "Synthetic complete cohort",
      directory: "preset",
      regionalProofDirectory: "proofs",
      manifestHash: receipt.manifestHash,
    };
  const load = () =>
    loadTrafficCommutePreset({
      descriptor,
      directory: input.outputDirectory,
      regionalProofDirectory: proofDirectory,
      network,
    });
  return {
    input,
    receipt,
    descriptor,
    load,
    preset: await load(),
    pack,
    prior,
    routes,
    compilation,
    network,
  };
}

/** A synthetic two-way source junction and manually retained projection. No projection executable or native provider. */
export async function packagedJunctionCommuteFixture(
  root: string,
  policyVersion: 2 | 3 = 2,
) {
  const { pack, recipe } = trafficCommuteFixture(),
    network = trafficNetworkFixture();
  pack.sources[0].id = "commute-fixture";
  pack.sources[0].kind = "observed";
  for (const f of pack.files) f.sourceId = "commute-fixture";
  recipe.sourceIds = ["commute-fixture"];
  const p = (x: number, y: number): [number, number] => [
    x / 111195.0802335329,
    y / 111195.0802335329,
  ];
  const points = { "1": p(0, 0), "2": p(40, 0), "3": p(0, 40) };
  network.nodes = Object.entries(points).map(([id, position]) => ({
    id,
    position,
    type: "priority",
    external: id !== "1",
    quality: "authored",
    sourceIds: ["traffic-fixture"],
  }));
  network.edges = [
    {
      id: "e0",
      from: "2",
      to: "1",
      sourceWayIds: ["11"],
      quality: "authored",
      sourceIds: ["traffic-fixture"],
      lanes: [
        {
          id: "e0_0",
          index: 0,
          shape: [p(40, 8), p(16, 8)],
          lengthMeters: 24,
          speedMps: 10,
          allowedClasses: ["passenger"],
          quality: "authored",
          sourceIds: ["traffic-fixture"],
        },
      ],
    },
    {
      id: "e1",
      from: "1",
      to: "3",
      sourceWayIds: ["12"],
      quality: "authored",
      sourceIds: ["traffic-fixture"],
      lanes: [
        {
          id: "e1_0",
          index: 0,
          shape: [p(8, 16), p(8, 40)],
          lengthMeters: 24,
          speedMps: 10,
          allowedClasses: ["passenger"],
          quality: "authored",
          sourceIds: ["traffic-fixture"],
        },
      ],
    },
  ];
  network.connections = [
    {
      id: "movement",
      fromEdge: "e0",
      toEdge: "e1",
      fromLane: "e0_0",
      toLane: "e1_0",
      viaLaneIds: [":J_0_0"],
      direction: "right",
      quality: "authored",
      sourceIds: ["traffic-fixture"],
    },
  ];
  network.signals = [];
  network.manifest.bounds = [-0.01, -0.01, 0.01, 0.01];
  const xml = Buffer.from(
    '<net><location netOffset="0,0" projParameter="+proj=utm +zone=31 +ellps=WGS84 +datum=WGS84 +units=m +no_defs"/><edge id="e0" from="2" to="1"><lane id="e0_0" index="0" length="24" allow="passenger"><param key="origId" value="11"/></lane></edge><edge id="e1" from="1" to="3"><lane id="e1_0" index="0" length="24" allow="passenger"><param key="origId" value="12"/></lane></edge><edge id=":J_0" function="internal"><lane id=":J_0_0" index="0" length="12" allow="passenger" shape="0,0 1,1 2,2"/></edge><connection from="e0" to="e1" fromLane="0" toLane="0" via=":J_0_0"/><connection from=":J_0" to="e1" fromLane="0" toLane="0"/></net>',
  );
  const source = Buffer.from(
    "<osm>" +
      Object.entries(points)
        .map(
          ([id, [lon, lat]]) => `<node id="${id}" lon="${lon}" lat="${lat}"/>`,
        )
        .join("") +
      '<way id="11"><nd ref="2"/><nd ref="1"/></way><way id="12"><nd ref="1"/><nd ref="3"/></way></osm>',
  );
  network.manifest.networkFileSha256 = hash(xml);
  network.manifest.sourceFiles = [
    {
      sourceId: "traffic-fixture",
      url: "https://example.test/fixture.osm.pbf",
      sha256: "a".repeat(64),
      bytes: 1,
      retrievedAt: "2026-01-01T00:00:00Z",
    },
    {
      sourceId: "traffic-fixture",
      url: `urn:urban:traffic:osm-extract:${hash(source)}`,
      sha256: hash(source),
      bytes: source.length,
      retrievedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const output =
    [p(16, 8), p(10.34, 10.34), p(8, 16)].map((p) => p.join(" ")).join("\n") +
    "\n";
  const projectionReceipt = {
    binarySha256: "b".repeat(64),
    args: [
      "-f",
      "%.12f",
      "+proj=utm",
      "+zone=31",
      "+ellps=WGS84",
      "+datum=WGS84",
      "+units=m",
      "+no_defs",
      "+to",
      "+proj=longlat",
      "+datum=WGS84",
    ],
    networkXmlHash: hash(xml),
    inputSha256: hash("0 0\n1 1\n2 2\n"),
    outputSha256: hash(output),
  };
  const projection = {
    version: 2,
    networkHash: hash(xml),
    projectionHash: await trafficContentHash(projectionReceipt),
    projectionReceipt,
    output,
  };
  const index = bindCommuteSourceGeometry(
    restoreCommuteNativeGeometry(
      buildCommuteNativeIndex(network, xml),
      Buffer.from(canonicalJSON(projection)),
    ),
    source,
  );
  const home = points["2"],
    work = points["3"];
  for (const b of pack.blocks)
    b.position = pack.residences.some((r) => r.blockGeoid === b.geoid)
      ? home
      : work;
  const reconciliation = Buffer.from(
    canonicalJSON({
      version: 1,
      synthetic: true,
      residentJobs: 100,
      knownDestinationJobs: 80,
    }),
  );
  pack.files.find(
    (f) => f.sha256 === pack.reconciliation.evidenceFileSha256,
  )!.sha256 = hash(reconciliation);
  pack.reconciliation.evidenceFileSha256 = hash(reconciliation);
  const prior = buildTrafficCommutePrior(pack, recipe),
    proofDirectory = join(root, "proofs");
  await mkdir(proofDirectory, { recursive: true });
  async function put(name: string, value: unknown) {
    const raw = Buffer.isBuffer(value)
        ? value
        : Buffer.from(canonicalJSON(value)),
      path = join(proofDirectory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, raw);
    return { name, sha256: hash(raw), bytes: raw.length };
  }
  const xmlFile = await put(`native/${hash(xml)}.net.xml`, xml),
    sourceFile = await put(`sources/${hash(source)}.osm.xml`, source),
    projectionRaw = Buffer.from(canonicalJSON(projection)),
    projectionFile = await put(
      `projection-artifacts/${hash(projectionRaw)}.json`,
      projectionRaw,
    ),
    recipeRaw = Buffer.from(
      canonicalJSON(await trafficCommuteCorrespondenceRecipe(policyVersion)),
    ),
    recipeFile = await put(`recipes/${hash(recipeRaw)}.json`, recipeRaw);
  await put(`projections/${projection.projectionHash}.json`, projectionReceipt);
  const encode = (shape: [number, number][]) => {
    let lat = 0,
      lon = 0,
      out = "";
    for (const p of shape) {
      const next = [Math.round(p[1] * 1e6), Math.round(p[0] * 1e6)];
      for (const delta of [next[0] - lat, next[1] - lon]) {
        let v = delta < 0 ? ~(delta << 1) : delta << 1;
        while (v >= 32) {
          out += String.fromCharCode(((v & 31) | 32) + 63);
          v >>>= 5;
        }
        out += String.fromCharCode(v + 63);
      }
      lat = next[0];
      lon = next[1];
    }
    return out;
  };
  const shape = encode([home, points["1"], work]);
  const rawRoute = Buffer.from(
    canonicalJSON({
      trip: {
        status: 0,
        summary: { time: 20, length: 0.08 },
        legs: [{ shape }],
      },
    }),
  );
  const rawTrace = Buffer.from(
    canonicalJSON({
      shape,
      shape_attributes: { time: [10, 10] },
      edges: [
        {
          id: 1,
          way_id: 11,
          forward: true,
          begin_shape_index: 0,
          end_shape_index: 1,
          end_node: { elapsed_time: 10 },
        },
        {
          id: 2,
          way_id: 12,
          forward: true,
          begin_shape_index: 1,
          end_shape_index: 2,
          end_node: { elapsed_time: 20 },
        },
      ],
    }),
  );
  const identity = {
      home,
      work,
      graphHash: "a".repeat(64),
      settingsHash: "b".repeat(64),
      sourcePbfHash: "a".repeat(64),
    },
    key = await trafficContentHash(identity);
  await put(`route-cache/${key}/route.json`, rawRoute);
  await put(`route-cache/${key}/trace.json`, rawTrace);
  await put(`route-cache/${key}/receipt.json`, {
    routeHash: hash(rawRoute),
    traceHash: hash(rawTrace),
    routeStatus: 200,
    traceStatus: 200,
  });
  const regional = normalizeCommuteRoute({ ...identity, rawRoute, rawTrace }),
    routes: TrafficCommuteRouteSet = {
      version: 1,
      sourcePackHash: await trafficContentHash(pack),
      priorHash: await trafficContentHash(prior),
      regionalGraphHash: identity.graphHash,
      regionalSettingsHash: identity.settingsHash,
      localNetworkHash: hash(xml),
      localInventoryHash: await trafficContentHash(network),
      attachments: [],
      notes: ["Synthetic source-junction fixture only."],
    };
  await put(`regional/${regional.routeHash}.json`, regional.route);
  for (const flow of pack.flows) {
    const matched = matchCommuteRoute(flow.id, regional.route, index, {
      policyVersion,
    });
    if (matched.attachment.status !== "routed")
      throw new Error("Synthetic junction did not match");
    routes.attachments.push(matched.attachment);
    await put(
      `bindings/${matched.evidence.bindingHash}.json`,
      matched.evidence,
    );
  }
  const compilation = await compileTrafficCommuteDemand(
    prior,
    routes,
    network,
    { sourcePack: pack },
  );
  const paths = {
    sourcePackPath: join(root, "pack.json"),
    priorPath: join(root, "prior.json"),
    routesPath: join(root, "routes.json"),
    compilationPath: join(root, "compilation.json"),
    reconciliationPath: join(root, "reconciliation.json"),
  };
  for (const [path, value] of [
    [paths.sourcePackPath, pack],
    [paths.priorPath, prior],
    [paths.routesPath, routes],
    [paths.compilationPath, compilation],
  ] as const)
    await writeFile(path, canonicalJSON(value));
  await writeFile(paths.reconciliationPath, reconciliation);
  const correspondence: TrafficCommuteCorrespondenceInput = {
    profile: "original-osm-junction-v1",
    policyVersion,
    nativeXmlFile: xmlFile.name,
    sourceGeometryFile: sourceFile.name,
    projectionArtifactFile: projectionFile.name,
    recipeFile: recipeFile.name,
  };
  const input = {
    presetId: `synthetic-junction-v${policyVersion}`,
    outputDirectory: join(root, "preset"),
    network,
    ...paths,
    regionalProofDirectory: proofDirectory,
    correspondence,
  };
  const receipt = await packageTrafficCommutePreset(input),
    descriptor = {
      id: input.presetId,
      label: "Synthetic source junction",
      directory: "preset",
      regionalProofDirectory: "proofs",
      manifestHash: receipt.manifestHash,
    };
  const load = () =>
    loadTrafficCommutePreset({
      descriptor,
      directory: input.outputDirectory,
      regionalProofDirectory: proofDirectory,
      network,
    });
  return {
    input,
    receipt,
    descriptor,
    load,
    preset: await load(),
    pack,
    prior,
    routes,
    compilation,
    network,
    projection,
    source,
    xml,
    put,
  };
}
