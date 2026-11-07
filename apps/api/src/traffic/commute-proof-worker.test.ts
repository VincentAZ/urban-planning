import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficCommuteReplayInput } from "./commute-proof";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture";
const state = vi.hoisted(() => ({
  failStarts: 0,
  workers: [] as {
    emit: (event: string, data: unknown) => boolean;
    options: any;
    terminate: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      terminate = vi.fn(async () => 0);
      constructor(
        _code: string,
        public options: unknown,
      ) {
        super();
        if (state.failStarts-- > 0)
          throw new Error("Synthetic worker startup failure");
        state.workers.push(this as any);
      }
    },
  };
});
beforeEach(() => {
  state.failStarts = 0;
  state.workers = [];
  vi.resetModules();
});
const hash = "a".repeat(64);
function input(id: string): TrafficCommuteReplayInput {
  return {
    directory: "/synthetic",
    files: [],
    network: trafficNetworkFixture(),
    routes: {
      version: 1,
      sourcePackHash: hash,
      priorHash: hash,
      regionalGraphHash: hash,
      regionalSettingsHash: hash,
      localNetworkHash: hash,
      localInventoryHash: hash,
      attachments: [],
      notes: [id],
    },
    correspondence: {
      profile: "original-osm-junction-v1",
      policyVersion: 2,
      nativeXml: {
        name: "native/" + hash + ".net.xml",
        sha256: hash,
        bytes: 1,
      },
      sourceGeometry: {
        name: "sources/" + hash + ".osm.xml",
        sha256: hash,
        bytes: 1,
      },
      projectionArtifact: {
        name: "projection-artifacts/" + hash + ".json",
        sha256: hash,
        bytes: 1,
      },
      recipe: { name: "recipes/" + hash + ".json", sha256: hash, bytes: 1 },
    },
  };
}
const receipt = {
  version: 1,
  profile: "original-osm-junction-v1",
  policyVersion: 2,
  networkHash: hash,
  inventoryHash: hash,
  sourceGeometryHash: hash,
  projectionHash: hash,
  projectionArtifactHash: hash,
  recipeHash: hash,
  routesHash: hash,
  acceptedBindingsHash: hash,
  routedFlows: 1,
};
describe("bounded pure correspondence replay scheduling", () => {
  it("also bounds fresh dependency scans before any geometry thread and deduplicates only concurrent identical assets", async () => {
    const { withTrafficCommuteProofAdmission } = await import(
      "./commute-proof-worker"
    );
    let release!: (v: number) => void;
    const firstWork = vi.fn(
        () =>
          new Promise<number>((resolve) => {
            release = resolve;
          }),
      ),
      nextWork = vi.fn(async () => 2);
    const a = withTrafficCommuteProofAdmission("a", firstWork),
      same = withTrafficCommuteProofAdmission("a", firstWork),
      b = withTrafficCommuteProofAdmission("b", nextWork),
      c = withTrafficCommuteProofAdmission("c", nextWork);
    await expect(
      withTrafficCommuteProofAdmission("d", nextWork),
    ).rejects.toMatchObject({ code: "TRAFFIC_COMMUTE_PROOF_BUSY" });
    expect(firstWork).toHaveBeenCalledOnce();
    expect(nextWork).not.toHaveBeenCalled();
    release(1);
    expect(await Promise.all([a, same, b, c])).toEqual([1, 1, 2, 2]);
    expect(nextWork).toHaveBeenCalledTimes(2);
    await withTrafficCommuteProofAdmission("a", nextWork);
    expect(nextWork).toHaveBeenCalledTimes(3);
  });
  it("recovers an unused verification slot after synchronous startup failure", async () => {
    const { verifyTrafficCommuteInWorker } = await import(
      "./commute-proof-worker"
    );
    state.failStarts = 1;
    await expect(
      verifyTrafficCommuteInWorker(input("first")),
    ).rejects.toMatchObject({ code: "TRAFFIC_COMMUTE_PROOF_FAILED" });
    const next = verifyTrafficCommuteInWorker(input("next"));
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0].options.resourceLimits.maxOldGenerationSizeMb).toBe(
      1024,
    );
    state.workers[0].emit("message", { ok: true, result: receipt });
    await expect(next).resolves.toEqual(receipt);
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
  });
  it("deduplicates exact inputs, runs one verifier, and rejects beyond two waiting requests", async () => {
    const { verifyTrafficCommuteInWorker } = await import(
      "./commute-proof-worker"
    );
    const a = verifyTrafficCommuteInWorker(input("a")),
      same = verifyTrafficCommuteInWorker(input("a")),
      b = verifyTrafficCommuteInWorker(input("b")),
      c = verifyTrafficCommuteInWorker(input("c"));
    await expect(
      verifyTrafficCommuteInWorker(input("d")),
    ).rejects.toMatchObject({ code: "TRAFFIC_COMMUTE_PROOF_BUSY" });
    expect(state.workers).toHaveLength(1);
    state.workers[0].emit("message", { ok: true, result: receipt });
    await Promise.all([a, same]);
    expect(state.workers).toHaveLength(2);
    state.workers[1].emit("message", { ok: true, result: receipt });
    await b;
    expect(state.workers).toHaveLength(3);
    state.workers[2].emit("message", { ok: true, result: receipt });
    await c;
    await expect(verifyTrafficCommuteInWorker(input("a"))).resolves.toEqual(
      receipt,
    );
    expect(state.workers).toHaveLength(3);
  });
  it("does not cache failed replay as an accepted result", async () => {
    const { verifyTrafficCommuteInWorker } = await import(
      "./commute-proof-worker"
    );
    const first = verifyTrafficCommuteInWorker(input("retry")),
      failure = expect(first).rejects.toMatchObject({
        code: "TRAFFIC_COMMUTE_PROOF_FAILED",
      });
    state.workers[0].emit("message", { ok: false });
    await failure;
    const retry = verifyTrafficCommuteInWorker(input("retry"));
    expect(state.workers).toHaveLength(2);
    state.workers[1].emit("message", { ok: true, result: receipt });
    await expect(retry).resolves.toEqual(receipt);
  });
});
