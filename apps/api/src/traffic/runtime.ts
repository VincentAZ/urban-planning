import { trafficNativeSettings } from "./native-settings.js";
import { confirmDockerContainerAbsent } from "../native-process.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  lstat,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  canonicalJSON,
  trafficContentHash,
  trafficPairRecipeHash,
  trafficPeriodSchema,
  trafficCountSchema,
  trafficOverlaySchema,
  trafficRouteEndpointsSchema,
  validateTrafficRouteEndpoints,
  trafficSignalTimingsSchema,
  trafficSimulationResultSchema,
  validateTrafficNetwork,
  TRAFFIC_METHOD_VERSION,
  type TrafficNetwork,
  type TrafficSimulationResult,
  type TrafficPairRecipe,
} from "@urban/core";
import { ApiError } from "../errors.js";
import {
  assertNativeSignalTimings,
  assertTrafficSignalEffects,
  assertSignalStateOutput,
  trafficSignalTimingEligibility,
} from "./signal-effects.js";
import { assertTrafficOverlayEffects } from "./overlay-effects.js";
import { assertTrafficEndpointEffects } from "./endpoint-effects.js";
import { inspectTrafficServiceAccess } from "./service-access.js";
import {
  SUMO_IMAGE,
  SUMO_VERSION,
  TRAFFIC_NATIVE_LIMITS as LIMITS,
  type TrafficNetworkInput,
  type PreparedTrafficNetwork,
  type TrafficNativePairRequest,
  type TrafficNativePair,
  type TrafficNativeResources,
} from "./types.js";

const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return !r || (!r.startsWith(`..${sep}`) && r !== ".." && !r.startsWith(sep));
};
export class TrafficNativeError extends ApiError {
  constructor(code: string, message: string, status = 422) {
    super(status, code, message);
  }
}
const reject = (message: string) => {
  throw new TrafficNativeError("TRAFFIC_INPUT_INVALID", message);
};
async function bounded(path: string, cap: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > cap)
    throw new TrafficNativeError(
      "TRAFFIC_BYTE_LIMIT",
      "Traffic artifact exceeds its file limit or is not a regular file.",
      413,
    );
  const raw = await readFile(path);
  if (raw.length > cap)
    throw new TrafficNativeError(
      "TRAFFIC_BYTE_LIMIT",
      "Traffic artifact grew beyond its file limit.",
      413,
    );
  return raw;
}

/** Operator-selected immutable bundle only. Callers cannot provide arbitrary paths. */
export async function loadPreparedTrafficNetwork(
  directory: string,
): Promise<PreparedTrafficNetwork> {
  const network = JSON.parse(
    (
      await bounded(join(directory, "network.json"), LIMITS.inputBytes)
    ).toString(),
  ) as TrafficNetwork;
  validateTrafficNetwork(network);
  const networkXml = await bounded(
    join(directory, "network.net.xml"),
    LIMITS.networkBytes,
  );
  if (sha(networkXml) !== network.manifest.networkFileSha256)
    throw new TrafficNativeError(
      "TRAFFIC_NETWORK_HASH",
      "Stored native network bytes do not match their manifest.",
    );
  const resources = JSON.parse(
    (await bounded(join(directory, "resources.json"), 4096)).toString(),
  ) as TrafficNativeResources;
  return {
    network,
    networkXml,
    files: { "network.net.xml": networkXml },
    resources,
  };
}

async function docker(
  args: string[],
  milliseconds: number,
  signal?: AbortSignal,
  container?: string,
): Promise<{ code: number; output: string }> {
  signal?.throwIfAborted();
  return new Promise((done, fail) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "",
      bytes = 0,
      stopped: string | undefined,
      removing: Promise<unknown> | undefined;
    const stop = (why: string) => {
      if (stopped) return;
      stopped = why;
      if (container)
        removing = docker(["rm", "--force", container], 5000).catch(() => {});
      child.kill("SIGKILL");
    };
    const consume = (data: Buffer) => {
      bytes += data.length;
      if (bytes > 256 * 1024) stop("output");
      else output += data.toString();
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const timer = setTimeout(() => stop("timeout"), milliseconds),
      abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", () => {
      clean();
      fail(
        new TrafficNativeError(
          "TRAFFIC_RUNTIME_UNAVAILABLE",
          "The pinned native traffic runtime is unavailable.",
          503,
        ),
      );
    });
    child.on("close", async (code) => {
      clean();
      await removing;
      if (stopped)
        fail(
          new TrafficNativeError(
            stopped === "cancelled"
              ? "TRAFFIC_CANCELLED"
              : "TRAFFIC_RUNTIME_LIMIT",
            stopped === "cancelled"
              ? "Traffic processing was cancelled."
              : "Traffic processing exceeded its bounded runtime or diagnostic limit; no partial result was accepted.",
            stopped === "cancelled" ? 409 : 413,
          ),
        );
      else done({ code: code ?? -1, output });
    });
  });
}

const id = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9_.:#@+\-]+$/)
  .refine(
    (v) =>
      !Object.getOwnPropertyNames(Object.prototype).includes(v) &&
      v !== "prototype",
  );
const vehicle = z
  .object({
    id,
    odId: id,
    routeId: id,
    departSeconds: z.number().finite().nonnegative(),
    endpoints: trafficRouteEndpointsSchema.optional(),
    edges: z.array(id).min(1).max(10000),
    vehicleClass: z.enum([
      "passenger",
      "truck",
      "bus",
      "motorcycle",
      "bicycle",
      "pedestrian",
    ]),
  })
  .strict();

/** Native-only adapter. Durable admission, project ACLs and source rights belong to callers. */
export class TrafficRuntime {
  readonly image = SUMO_IMAGE;
  private active = false;
  constructor(
    readonly options: { workRoot: string; allowedInputRoot: string },
  ) {}
  async available() {
    const result = await docker(
      ["image", "inspect", "--format", "{{.Id}}", SUMO_IMAGE],
      5000,
    );
    return {
      available: result.code === 0,
      image: SUMO_IMAGE,
      version: SUMO_VERSION,
      reason:
        result.code === 0
          ? null
          : "The verified pinned SUMO image has not been installed by the operator.",
    };
  }
  private async run(
    operation: "prepare" | "pair",
    request: Record<string, unknown>,
    native: { name: string; bytes: Buffer },
    signal?: AbortSignal,
  ) {
    if (this.active)
      throw new TrafficNativeError(
        "TRAFFIC_BUSY",
        "One native traffic operation is already running.",
        503,
      );
    this.active = true;
    let job: string | undefined;
    const container = `urban-traffic-${randomUUID()}`;
    try {
      signal?.throwIfAborted();
      const uid = process.getuid?.() ?? 0,
        gid = process.getgid?.() ?? 0;
      if (!uid)
        throw new TrafficNativeError(
          "TRAFFIC_NONROOT_REQUIRED",
          "Run traffic under a nonroot service account.",
          503,
        );
      await mkdir(this.options.workRoot, { recursive: true, mode: 0o700 });
      job = await mkdtemp(join(resolve(this.options.workRoot), "job-"));
      const input = join(job, "input"),
        output = join(job, "output");
      await mkdir(input, { mode: 0o700 });
      await mkdir(output, { mode: 0o700 });
      const workerSource = fileURLToPath(
        new URL("../../../../scripts/traffic-worker.py", import.meta.url),
      );
      const workerBytes = await bounded(workerSource, 1024 * 1024);
      const worker = join(input, "worker.py");
      await writeFile(worker, workerBytes, { mode: 0o400 });
      const serialized = canonicalJSON({
        ...request,
        operation,
        imageDigest: SUMO_IMAGE.split("@")[1],
        workerSha256: sha(workerBytes),
      });
      if (Buffer.byteLength(serialized) > LIMITS.inputBytes)
        throw new TrafficNativeError(
          "TRAFFIC_INPUT_LIMIT",
          "Traffic declarative input exceeds 64 MiB.",
          413,
        );
      await writeFile(join(input, "request.json"), serialized, { mode: 0o400 });
      await writeFile(join(input, native.name), native.bytes, { mode: 0o400 });
      const args = [
        "create",
        "--name",
        container,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        `${uid}:${gid}`,
        "--memory",
        String(LIMITS.memoryBytes),
        "--memory-swap",
        String(LIMITS.memoryBytes),
        "--cpus",
        "2",
        "--pids-limit",
        "64",
        "--ulimit",
        "nofile=128:128",
        "--ulimit",
        "fsize=268435456:268435456",
        "--ulimit",
        "core=0:0",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=67108864,mode=1777",
        "--env",
        "PROJ_NETWORK=OFF",
        "--env",
        "OMP_NUM_THREADS=1",
        "--mount",
        `type=bind,src=${input},dst=/input,readonly`,
        "--mount",
        `type=bind,src=${output},dst=/output`,
        "--mount",
        `type=bind,src=${worker},dst=/worker.py,readonly`,
        "--entrypoint",
        "python3",
        SUMO_IMAGE,
        "/worker.py",
      ];
      const made = await docker(args, 10000, signal);
      if (made.code)
        throw new TrafficNativeError(
          "TRAFFIC_RUNTIME_UNAVAILABLE",
          "The pinned sandbox could not be created.",
          503,
        );
      const result = await docker(
        ["start", "--attach", container],
        LIMITS.wallMilliseconds,
        signal,
        container,
      );
      const files: Record<string, Buffer> = {};
      let total = 0;
      const inventory = [];
      for (const entry of await readdir(output, { withFileTypes: true }))
        inventory.push({
          name: entry.name,
          bytes: (await lstat(join(output, entry.name))).size,
        });
      await writeFile(
        join(this.options.workRoot, "last-output-inventory.json"),
        JSON.stringify(inventory),
        { mode: 0o600 },
      );
      if (inventory.some((f) => f.name === "error.json")) {
        const error = JSON.parse(
          (await bounded(join(output, "error.json"), 4096)).toString(),
        );
        const logs: Record<string, string> = {};
        for (const entry of inventory.filter((f) => f.name.endsWith(".log")))
          logs[entry.name] = (
            await bounded(join(output, entry.name), 1024 * 1024)
          ).toString();
        await writeFile(
          join(this.options.workRoot, "last-error.json"),
          JSON.stringify({ error, logs }),
          { mode: 0o600 },
        );
        throw new TrafficNativeError(
          "TRAFFIC_NATIVE_REJECTED",
          error.message ??
            "The native traffic run failed without a complete result.",
        );
      }
      for (const entry of await readdir(output, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[A-Za-z0-9_.-]+$/.test(entry.name))
          throw new TrafficNativeError(
            "TRAFFIC_OUTPUT_INVALID",
            "Native output contains an unexpected file.",
          );
        const info = await lstat(join(output, entry.name));
        total += info.size;
        if (total > LIMITS.outputBytes)
          throw new TrafficNativeError(
            "TRAFFIC_OUTPUT_LIMIT",
            "Combined traffic evidence exceeds 256 MiB.",
            413,
          );
        files[entry.name] = await bounded(
          join(output, entry.name),
          LIMITS.outputBytes,
        );
      }
      if (result.code || files["error.json"]) {
        const error = files["error.json"]
          ? JSON.parse(files["error.json"].toString())
          : null;
        await writeFile(
          join(this.options.workRoot, "last-error.json"),
          JSON.stringify({
            error,
            logs: Object.fromEntries(
              Object.entries(files)
                .filter(([k]) => k.endsWith(".log"))
                .map(([k, v]) => [k, v.toString()]),
            ),
          }),
          { mode: 0o600 },
        );
        throw new TrafficNativeError(
          "TRAFFIC_NATIVE_REJECTED",
          error?.message ??
            "The bounded traffic worker failed; no partial result was accepted.",
        );
      }
      if (!files["response.json"] || !files["resources.json"])
        throw new TrafficNativeError(
          "TRAFFIC_OUTPUT_INVALID",
          "Native traffic output is incomplete.",
        );
      const resources = {
        ...JSON.parse(files["resources.json"].toString()),
        cpuLimit: 2,
        memoryLimitBytes: LIMITS.memoryBytes,
        outputBytes: total,
      } as TrafficNativeResources;
      const response: unknown = JSON.parse(files["response.json"].toString());
      delete files["response.json"];
      delete files["resources.json"];
      files["worker.py"] = workerBytes;
      return { response, files, resources };
    } finally {
      try {
        await docker(["rm", "--force", container], 5000).catch(() => {});
        await confirmDockerContainerAbsent(container);
      } finally {
        if (job) await rm(job, { recursive: true, force: true });
        this.active = false;
      }
    }
  }
  async prepareNetwork(
    input: TrafficNetworkInput,
    signal?: AbortSignal,
  ): Promise<PreparedTrafficNetwork> {
    const [root, path] = await Promise.all([
      realpath(this.options.allowedInputRoot),
      realpath(input.osmXmlPath),
    ]);
    if (!inside(root, path))
      throw new TrafficNativeError(
        "TRAFFIC_SOURCE_PATH",
        "Traffic source lies outside the trusted input root.",
        403,
      );
    const bytes = await bounded(path, LIMITS.sourceBytes);
    if (sha(bytes) !== input.osmXmlSha256)
      throw new TrafficNativeError(
        "TRAFFIC_SOURCE_HASH",
        "Traffic source bytes do not match their immutable receipt.",
      );
    if (
      input.serviceRoadPolicy !== undefined &&
      input.serviceRoadPolicy !== "infer-unrestricted-service-passenger"
    )
      reject("Unsupported operator service-road access policy.");
    const serviceAccess = input.serviceRoadPolicy
      ? inspectTrafficServiceAccess(bytes, input.serviceRoadPolicy)
      : undefined;
    const policyJSON = serviceAccess ? canonicalJSON(serviceAccess) : undefined;
    const policySourceId = "urban-service-passenger-policy-v1";
    if (
      serviceAccess &&
      input.sources.some((source) => source.id === policySourceId)
    )
      reject("The reserved access-policy source identity is already in use.");
    const sources = serviceAccess
      ? [
          ...input.sources,
          {
            id: policySourceId,
            name: "Explicit urban service-road passenger access inference",
            url: "https://sumo.dlr.de/docs/Networks/Import/OpenStreetMap.html",
            vintage: "Policy 1",
            license: "Project-authored inference over OSM data (ODbL)",
            kind: "inferred" as const,
            description:
              "Operator-selected passenger access for service ways without captured restrictions. Restrictive, conditional, ambiguous and barrier-controlled source access remains excluded. This is a model policy, not certified legal routing.",
          },
        ]
      : input.sources;
    const sourceFiles = policyJSON
      ? [
          ...input.sourceFiles,
          {
            sourceId: policySourceId,
            url: `urn:urban:traffic:service-access:${sha(policyJSON)}`,
            sha256: sha(policyJSON),
            bytes: Buffer.byteLength(policyJSON),
            retrievedAt: new Date().toISOString(),
          },
        ]
      : input.sourceFiles;
    const result = await this.run(
      "prepare",
      {
        bounds: input.bounds,
        sources,
        sourceFiles,
        notes: [
          ...(input.notes ?? []),
          ...(serviceAccess
            ? [
                "Explicit operator access policy: unrestricted service ways may carry passenger vehicles; captured restrictions and ambiguous access are withheld. Source tags, permission changes and original bytes are retained. Inferred access is not field-verified.",
              ]
            : []),
        ],
        ...(policyJSON ? { serviceAccessPolicyJSON: policyJSON } : {}),
      },
      { name: "source.osm.xml", bytes },
      signal,
    );
    const network = result.response as TrafficNetwork;
    if (
      policyJSON &&
      result.files["source-access-policy.json"]?.toString("utf8") !== policyJSON
    )
      reject(
        "The native access-policy receipt differs from the reviewed source preflight.",
      );
    validateTrafficNetwork(network);
    const networkXml = result.files["network.net.xml"];
    if (
      !networkXml ||
      sha(networkXml) !== network.manifest.networkFileSha256 ||
      networkXml.length > LIMITS.networkBytes
    )
      throw new TrafficNativeError(
        "TRAFFIC_NETWORK_HASH",
        "Prepared network identity does not match the complete native XML.",
      );
    return {
      network,
      networkXml,
      files: result.files,
      resources: result.resources,
    };
  }
  async runPair(input: TrafficNativePairRequest): Promise<TrafficNativePair> {
    if (input.network.networkXml.length > LIMITS.networkBytes)
      throw new TrafficNativeError(
        "TRAFFIC_NETWORK_LIMIT",
        "The complete native network exceeds 64 MiB.",
        413,
      );
    const nativeBytes = Buffer.from(input.network.networkXml);
    const network = structuredClone(input.network.network),
      period = trafficPeriodSchema.parse(input.period);
    validateTrafficNetwork(network);
    if (
      network.manifest.engine.version !== SUMO_VERSION ||
      network.manifest.engine.imageDigest !== SUMO_IMAGE.split("@")[1]
    )
      reject("The captured network uses a different native engine profile.");
    if (sha(nativeBytes) !== network.manifest.networkFileSha256)
      reject("Native network bytes do not match the supplied graph.");
    if (input.unsupportedChanges?.length)
      reject(
        "This traffic runtime cannot apply the declared geometry, turn or control changes. No change was ignored.",
      );
    if (
      period.endSeconds +
        period.cooldownSeconds -
        (period.beginSeconds - period.warmupSeconds) >
      LIMITS.simulationSeconds
    )
      reject(
        "The complete warm-up, measurement and drain window exceeds three simulated hours.",
      );
    if (
      !Number.isSafeInteger(input.seed) ||
      input.seed < 0 ||
      input.seed > 0x7fffffff
    )
      reject("Use an explicit supported nonnegative simulation seed.");
    const vehicles = z
        .array(vehicle)
        .max(LIMITS.vehicles)
        .parse(input.vehicles),
      counts = z
        .array(trafficCountSchema)
        .max(LIMITS.counts)
        .parse(input.counts),
      overlays = z
        .array(trafficOverlaySchema)
        .max(LIMITS.edges)
        .parse(input.overlays);
    if (
      new Set(vehicles.map((v) => v.id)).size !== vehicles.length ||
      new Set(counts.map((v) => v.id)).size !== counts.length ||
      new Set(overlays.map((v) => v.edgeId)).size !== overlays.length
    )
      reject("Duplicate traffic vehicle, count or overlay identities.");
    const signalTimings =
      input.signalTimings === undefined
        ? undefined
        : trafficSignalTimingsSchema.parse(input.signalTimings);
    await assertNativeSignalTimings(
      { ...input.network, network, networkXml: nativeBytes },
      signalTimings ?? [],
      overlays,
      period,
    );
    const edges = new Map(network.edges.map((e) => [e.id, e]));
    const overlayByEdge = new Map(overlays.map((o) => [o.edgeId, o]));
    const lanes = new Map(
      network.edges.flatMap((e) => e.lanes.map((l) => [l.id, l] as const)),
    );
    const turns = new Set(
      network.connections.flatMap((c) =>
        (lanes.get(c.fromLane)?.allowedClasses ?? [])
          .filter((v) => lanes.get(c.toLane)?.allowedClasses.includes(v))
          .map((v) => `${c.fromEdge}\0${c.toEdge}\0${v}`),
      ),
    );
    let segments = 0;
    for (const v of vehicles) {
      if (v.endpoints) {
        try {
          validateTrafficRouteEndpoints(
            v.endpoints,
            edges,
            v.edges[0],
            v.edges.at(-1)!,
            v.vehicleClass,
            v.edges.length === 1,
          );
        } catch {
          reject(
            "A native route attachment is outside its exact permitted lane or has no forward travel.",
          );
        }
        for (const [edgeId, attached] of [
          [v.edges[0], v.endpoints.departLaneId],
          [v.edges.at(-1)!, v.endpoints.arrivalLaneId],
        ]) {
          const overlay = overlayByEdge.get(edgeId);
          if (
            overlay &&
            (overlay.closed ||
              (overlay.lanes !== undefined &&
                lanes.get(attached)!.index >= overlay.lanes))
          )
            reject(
              "A native control removes an explicit route attachment; no endpoint was relocated.",
            );
        }
      }
      if (v.vehicleClass === "pedestrian")
        reject(
          "Pedestrian demand requires a separate person-route runtime and was not converted to cars.",
        );
      if (
        v.departSeconds < period.beginSeconds - period.warmupSeconds ||
        v.departSeconds >= period.endSeconds
      )
        reject("A departure falls outside the declared demand window.");
      segments += v.edges.length;
      for (let i = 0; i < v.edges.length; i++)
        if (
          !edges
            .get(v.edges[i])
            ?.lanes.some((l) => l.allowedClasses.includes(v.vehicleClass)) ||
          (i > 0 &&
            !turns.has(`${v.edges[i - 1]}\0${v.edges[i]}\0${v.vehicleClass}`))
        )
          reject(
            "A submitted route crosses an absent or prohibited class-specific connection.",
          );
    }
    if (segments > 1000000)
      reject("The native demand exceeds one million route segments.");
    for (const o of overlays) {
      if (!edges.has(o.edgeId))
        reject("An overlay references an absent directed edge.");
      if (
        o.closed === true &&
        (o.lanes !== undefined || o.speedMps !== undefined)
      )
        reject("A native closure cannot also apply lane or speed changes.");
    }
    for (const c of counts) {
      if (
        c.date !== period.date ||
        c.timeZone !== period.timeZone ||
        c.utcOffsetMinutes !== period.utcOffsetMinutes ||
        c.beginSeconds < period.beginSeconds ||
        c.endSeconds > period.endSeconds
      )
        reject(
          "Counts do not belong to the exact local-clock analysis window.",
        );
      if (
        c.mapping &&
        c.mapping.networkFileSha256 !== network.manifest.networkFileSha256
      )
        reject("A traffic count is matched to a different captured network.");
      if (c.target?.kind === "edge" && !edges.has(c.target.edgeId))
        reject("A count references an absent directed edge.");
      if (c.target?.kind === "edge" && c.target.laneIds) {
        const target = c.target;
        if (
          new Set(target.laneIds).size !== target.laneIds!.length ||
          target.laneIds!.some(
            (id) => !edges.get(target.edgeId)?.lanes.some((l) => l.id === id),
          )
        )
          reject(
            "A count lane set contains duplicates or lanes outside its directed edge.",
          );
      }
      if (c.target?.kind === "turn") {
        const target = c.target;
        if (!network.connections.some((x) => x.id === target.connectionId))
          reject("A count references an absent turn movement.");
      }
    }
    for (const value of [input.demandHash, input.countPackHash])
      if (!/^[a-f0-9]{64}$/.test(value))
        reject("Traffic input hashes must be SHA-256 identities.");
    const result = await this.run(
      "pair",
      {
        network,
        period,
        seed: input.seed,
        vehicles,
        counts,
        overlays,
        ...(signalTimings !== undefined ? { signalTimings } : {}),
      },
      { name: "network.net.xml", bytes: nativeBytes },
      input.signal,
    );
    const raw = result.response as {
      baselineNetwork: TrafficNetwork;
      proposalNetwork: TrafficNetwork;
      baseline: TrafficSimulationResult & {
        assignedRoutes: Record<string, string[]>;
      };
      proposal: TrafficSimulationResult & {
        assignedRoutes: Record<string, string[]>;
      };
    };
    validateTrafficNetwork(raw.baselineNetwork);
    validateTrafficNetwork(raw.proposalNetwork);
    assertTrafficOverlayEffects(
      raw.baselineNetwork,
      raw.proposalNetwork,
      overlays,
      6,
      signalTimings,
    );
    await assertTrafficSignalEffects(
      raw.baselineNetwork,
      raw.proposalNetwork,
      signalTimings ?? [],
    );
    assertTrafficEndpointEffects(
      raw.baselineNetwork,
      raw.proposalNetwork,
      vehicles,
    );
    if (signalTimings?.length) {
      const appliedEligibility = await trafficSignalTimingEligibility({
        ...input.network,
        network: raw.proposalNetwork,
        networkXml: result.files["proposal.net.xml"],
      });
      if (
        signalTimings.some(
          (control) =>
            !appliedEligibility.programs.find(
              (p) => p.signalId === control.signalId,
            )?.eligible,
        )
      )
        reject(
          "Executed signal XML is not the verified simple static program.",
        );
      for (const side of ["baseline", "proposal"] as const)
        for (const [index, control] of signalTimings.entries()) {
          const program = raw[
            side === "baseline" ? "baselineNetwork" : "proposalNetwork"
          ].signals.find((s) => s.id === control.signalId)!;
          assertSignalStateOutput(
            result.files[`${side}-signal-${index}.xml`],
            program,
            period,
          );
        }
    }
    const settings = trafficNativeSettings({
      workerSha256: sha(result.files["worker.py"]),
      overlays,
      ...(signalTimings !== undefined ? { signalTimings } : {}),
      submittedVehiclesHash: await trafficContentHash(vehicles),
      mappedCountsHash: await trafficContentHash(counts),
      ...(vehicles.some((v) => v.endpoints) ? { explicitEndpoints: true } : {}),
    });
    const settingsHash = await trafficContentHash(settings);
    if (signalTimings !== undefined || vehicles.some((v) => v.endpoints))
      result.files["native-settings.json"] = Buffer.from(
        canonicalJSON(settings),
      );
    const recipe: TrafficPairRecipe = {
      version: 1,
      baselineNetworkHash: raw.baselineNetwork.manifest.networkFileSha256,
      proposalNetworkHash: raw.proposalNetwork.manifest.networkFileSha256,
      demandHash: input.demandHash,
      countPackHash: input.countPackHash,
      settingsHash,
      period,
      seed: input.seed,
      methodVersion: TRAFFIC_METHOD_VERSION,
    };
    const recipeHash = await trafficPairRecipeHash(recipe),
      retrievedAt = new Date().toISOString();
    for (const side of ["baseline", "proposal"] as const) {
      const run = raw[side];
      run.assignedRoutesHash = await trafficContentHash(run.assignedRoutes);
      delete (run as Partial<typeof run>).assignedRoutes;
      Object.assign(run, {
        recipeHash,
        networkHash:
          recipe[
            side === "baseline" ? "baselineNetworkHash" : "proposalNetworkHash"
          ],
        demandHash: input.demandHash,
        files: Object.entries(result.files)
          .filter(
            ([name]) => name.startsWith(side) || name === "demand.rou.xml",
          )
          .map(([name, bytes]) => ({
            sourceId: "sumo-native-evidence",
            url: `urn:urban:traffic:${recipeHash}:${name}`,
            sha256: sha(bytes),
            bytes: bytes.length,
            retrievedAt,
          })),
      });
      trafficSimulationResultSchema.parse(run);
      const d = run.diagnostics;
      if (
        d.requested !== vehicles.length ||
        d.loaded !== d.requested ||
        d.inserted !== d.arrived + d.running + d.discarded ||
        d.loaded !== d.inserted + d.waiting ||
        run.trips.length !== vehicles.length
      )
        throw new TrafficNativeError(
          "TRAFFIC_BALANCE",
          "Native vehicle conservation diagnostics do not reconcile; no result accepted.",
        );
    }
    result.files["baseline.net.xml"] = nativeBytes;
    return {
      recipe,
      recipeHash,
      baselineNetwork: raw.baselineNetwork,
      proposalNetwork: raw.proposalNetwork,
      baseline: raw.baseline,
      proposal: raw.proposal,
      files: result.files,
      resources: result.resources,
      notes: [
        "Both sides retain identical submitted OD, departure times, vehicle classes and seed. Closures repair only invalid paths with unchanged endpoints; changed path identities are recorded.",
        "A successful simulation is not automatically a validated forecast. Count fit and independent holdout diagnostics must be assessed separately.",
      ],
    };
  }
}
