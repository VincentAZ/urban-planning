import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON, trafficContentHash } from "@urban/core";
import { compileTrafficCommuteDemand } from "@urban/models";
import { trafficCountFixture } from "../../../../packages/core/src/traffic-fixture";
import {
  packagedCommuteFixture,
  packagedJunctionCommuteFixture,
} from "./commute-evidence-fixture";
import {
  packageTrafficCommutePreset,
  verifyArchivedTrafficCommute,
  verifyPreparedCommuteRequest,
} from "./commute-evidence";
import { TrafficArchive } from "./archive";
import type { TrafficExperimentRequest } from "./experiment";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "commute-evidence-"));
  dirs.push(dir);
  return { dir, ...(await packagedCommuteFixture(dir)) };
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function request(
  f: Awaited<ReturnType<typeof setup>>,
): TrafficExperimentRequest {
  return {
    version: 1,
    networkHash: f.network.manifest.networkFileSha256,
    period: f.prior.recipe.period,
    demand: f.preset.demand,
    commute: f.preset.summary.binding,
    countPack: trafficCountFixture(),
    seed: 42,
    overlays: [],
    calibrationPlan: null,
    unsupportedChanges: [],
  };
}
describe("prepared commute source authority and complete loss evidence", () => {
  it("canonicalizes new normalized JSON without rewriting originals or changing model identities, and records both byte hashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junction-encoding-"));
    dirs.push(dir);
    const f = await packagedJunctionCommuteFixture(dir);
    const pretty = Buffer.from(JSON.stringify(f.compilation, null, 4) + "\n");
    await writeFile(f.input.compilationPath, pretty);
    const result = await packageTrafficCommutePreset({
      ...f.input,
      outputDirectory: join(dir, "canonical-copy"),
    });
    expect(result.manifestHash).toBe(f.receipt.manifestHash);
    expect(result.summary.binding).toEqual(f.receipt.summary.binding);
    expect(
      result.normalization!.files.find(
        (x) => x.name === "commute-compilation.json",
      ),
    ).toEqual({
      name: "commute-compilation.json",
      inputSha256: hash(pretty),
      inputBytes: pretty.length,
      packagedSha256: hash(Buffer.from(canonicalJSON(f.compilation))),
      packagedBytes: Buffer.byteLength(canonicalJSON(f.compilation)),
      canonicalSha256: await trafficContentHash(f.compilation),
    });
    expect(await readFile(f.input.compilationPath)).toEqual(pretty);
    expect(
      await readFile(
        join(dir, "canonical-copy", "commute-reconciliation.json"),
      ),
    ).toEqual(await readFile(f.input.reconciliationPath));
  });
  it.each([2, 3] as const)(
    "replays exact original-source junction proof policy %i in a bounded worker and retains its compact receipt",
    async (policy) => {
      const dir = await mkdtemp(join(tmpdir(), "junction-proof-"));
      dirs.push(dir);
      const f = await packagedJunctionCommuteFixture(dir, policy);
      const proof = JSON.parse(
        f.preset.archiveFiles["commute-regional-proofs.json"].toString(),
      );
      expect(proof.version).toBe(2);
      expect(proof.correspondence.replay).toMatchObject({
        policyVersion: policy,
        routedFlows: 2,
        networkHash: f.network.manifest.networkFileSha256,
      });
      expect(f.preset.evidenceBytes.toString()).not.toContain(dir);
      expect(Object.keys(f.preset.archiveFiles)).toHaveLength(7);
      expect(await f.load()).toEqual(f.preset);
    },
  );
  it.each([
    "source-xml",
    "native-xml",
    "projection-output",
    "projection-recipe",
    "matching-recipe",
    "binding-body",
    "regional-elapsed",
    "raw-receipt",
  ])("rejects rehashed original-source proof tampering: %s", async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "junction-forgery-"));
    dirs.push(dir);
    const f = await packagedJunctionCommuteFixture(dir),
      input = structuredClone(f.input);
    input.outputDirectory = join(dir, "forged");
    async function replaceDependency(
      field: keyof typeof input.correspondence,
      raw: Buffer,
    ) {
      const old = input.correspondence[field] as string,
        prefix = old.split("/")[0],
        ext = old.slice(old.indexOf("."));
      const name = `${prefix}/${hash(raw)}${ext}`;
      await f.put(name, raw);
      Object.assign(input.correspondence, { [field]: name });
    }
    if (kind === "source-xml")
      await replaceDependency(
        "sourceGeometryFile",
        Buffer.concat([f.source, Buffer.from("<!-- changed -->")]),
      );
    if (kind === "native-xml")
      await replaceDependency(
        "nativeXmlFile",
        Buffer.concat([f.xml, Buffer.from("<!-- changed -->")]),
      );
    if (kind.startsWith("projection-")) {
      const p = structuredClone(f.projection);
      if (kind === "projection-output") {
        p.output = p.output.replace(/^\S+/, "0.01");
        p.projectionReceipt.outputSha256 = hash(Buffer.from(p.output));
      } else p.projectionReceipt.args[1] = "%.6f";
      p.projectionHash = await trafficContentHash(p.projectionReceipt);
      await replaceDependency(
        "projectionArtifactFile",
        Buffer.from(canonicalJSON(p)),
      );
    }
    if (kind === "matching-recipe") {
      const path = join(
          f.input.regionalProofDirectory,
          input.correspondence.recipeFile,
        ),
        recipe = JSON.parse(await readFile(path, "utf8"));
      recipe.matchPolicy.maximumResidualMeters = 250;
      await replaceDependency("recipeFile", Buffer.from(canonicalJSON(recipe)));
    }
    if (kind === "binding-body" || kind === "regional-elapsed") {
      const routes = structuredClone(f.routes),
        a = routes.attachments[0];
      const evidence = JSON.parse(
        await readFile(
          join(
            f.input.regionalProofDirectory,
            `bindings/${a.local!.bindingHash}.json`,
          ),
          "utf8",
        ),
      );
      if (kind === "binding-body")
        evidence.movements[0].centerlineProof.maximumSourceResidualMeters += 0.01;
      else {
        const regional = JSON.parse(
          await readFile(
            join(
              f.input.regionalProofDirectory,
              `regional/${a.regionalRouteHash}.json`,
            ),
            "utf8",
          ),
        );
        regional.seconds++;
        regional.segmentSeconds[1]++;
        regional.edges[1].endSeconds++;
        const regionalHash = await trafficContentHash(regional);
        await f.put(`regional/${regionalHash}.json`, regional);
        for (const row of routes.attachments) {
          row.regionalRouteHash = regionalHash;
          row.regionalSeconds = regional.seconds;
        }
        evidence.regionalRouteHash = regionalHash;
      }
      const { bindingHash: _old, ...body } = evidence,
        newHash = await trafficContentHash(body);
      await f.put(`bindings/${newHash}.json`, {
        ...body,
        bindingHash: newHash,
      });
      for (const row of routes.attachments) row.local!.bindingHash = newHash;
      const compilation = await compileTrafficCommuteDemand(
        f.prior,
        routes,
        f.network,
        { sourcePack: f.pack },
      );
      await writeFile(input.routesPath, canonicalJSON(routes));
      await writeFile(input.compilationPath, canonicalJSON(compilation));
    }
    if (kind === "raw-receipt") {
      const manifest = JSON.parse(
          f.preset.archiveFiles["commute-regional-proofs.json"].toString(),
        ),
        file = manifest.files.find((f: { name: string }) =>
          f.name.endsWith("/receipt.json"),
        );
      const value = JSON.parse(
        await readFile(join(input.regionalProofDirectory, file.name), "utf8"),
      );
      value.routeStatus = 400;
      await f.put(file.name, value);
    }
    await expect(packageTrafficCommutePreset(input)).rejects.toMatchObject({
      statusCode: 503,
    });
  });
  it("replays every normalized record and exact regional proof, then retains compact plus complete archive evidence", async () => {
    const f = await setup(),
      r = request(f),
      archive = new TrafficArchive(join(f.dir, "archive")),
      scope = { organizationId: "org", projectId: "project" };
    expect(f.preset.summary.totals.conservationResidual).toBeCloseTo(0, 12);
    const decoded = JSON.parse(f.preset.evidenceBytes.toString());
    expect(decoded.compilation.ledger).toEqual(f.compilation.ledger);
    expect(decoded.sourcePack.flows).toEqual(f.pack.flows);
    expect(f.preset.evidenceFile).toEqual({
      sha256: hash(f.preset.evidenceBytes),
      bytes: f.preset.evidenceBytes.length,
    });
    expect(f.preset.evidenceFile.sha256).not.toBe(
      f.preset.summary.binding.assetHash,
    );
    const staged = await archive.stage(scope, f.preset.archiveFiles);
    await staged.settle(true);
    expect(
      await verifyArchivedTrafficCommute({
        archive,
        reference: staged.reference,
        scope,
        request: r,
        network: f.network,
      }),
    ).toEqual(f.preset.summary);
    await expect(
      verifyArchivedTrafficCommute({
        archive,
        reference: staged.reference,
        scope: { ...scope, projectId: "other" },
        request: r,
        network: f.network,
      }),
    ).rejects.toThrow();
    const copied = structuredClone(r);
    delete copied.commute;
    expect(
      await verifyArchivedTrafficCommute({
        archive,
        reference: staged.reference,
        scope,
        request: copied,
        network: f.network,
      }),
    ).toBeUndefined();
    expect(await packageTrafficCommutePreset(f.input)).toEqual(f.receipt);
  });
  it("requires the exact server preset and refuses changed demand, time, network or fabricated identity", async () => {
    const f = await setup(),
      r = request(f);
    expect(await verifyPreparedCommuteRequest(r, f.network, [f.preset])).toBe(
      f.preset,
    );
    await expect(
      verifyPreparedCommuteRequest(r, f.network, []),
    ).rejects.toThrow(/server-prepared/);
    for (const mutate of [
      (v: TrafficExperimentRequest) => {
        v.demand.rows[0].vehicles++;
      },
      (v: TrafficExperimentRequest) => {
        v.period.beginSeconds++;
      },
      (v: TrafficExperimentRequest) => {
        v.commute!.assetHash = "f".repeat(64);
      },
    ]) {
      const changed = structuredClone(r);
      mutate(changed);
      await expect(
        verifyPreparedCommuteRequest(changed, f.network, [f.preset]),
      ).rejects.toThrow();
    }
    const detached = structuredClone(r);
    delete detached.commute;
    detached.demand.rows[0].vehicles++;
    expect(
      await verifyPreparedCommuteRequest(detached, f.network, [f.preset]),
    ).toBeUndefined();
  });
  it("rejects edited full fractional ledger even when the manifest is freshly rehashed", async () => {
    const f = await setup(),
      changed = structuredClone(f.compilation);
    changed.ledger[0].roundingDelta += 1;
    await writeFile(f.input.compilationPath, canonicalJSON(changed));
    await expect(
      packageTrafficCommutePreset({
        ...f.input,
        outputDirectory: join(f.dir, "forged"),
      }),
    ).rejects.toThrow(/ledger|binding/);
  });
  it.each(["endpoint", "prefix", "edges", "regionalSeconds"])(
    "refuses a recompiled %s change that retains an older correspondence proof",
    async (kind) => {
      const f = await setup(),
        routes = structuredClone(f.routes),
        first = routes.attachments[0];
      if (kind === "endpoint") first.local!.departPositionMeters += 1;
      if (kind === "prefix") first.local!.prefixSeconds += 1;
      if (kind === "edges")
        first.local!.edges = ["in", "bottom", "bottomjoin", "out"];
      if (kind === "regionalSeconds") first.regionalSeconds! += 1;
      const compiled = await compileTrafficCommuteDemand(
        f.prior,
        routes,
        f.network,
        { sourcePack: f.pack },
      );
      await writeFile(f.input.routesPath, canonicalJSON(routes));
      await writeFile(f.input.compilationPath, canonicalJSON(compiled));
      await expect(
        packageTrafficCommutePreset({
          ...f.input,
          outputDirectory: join(f.dir, "forged"),
        }),
      ).rejects.toThrow(/correspondence|outcome|time/);
    },
  );
  it("fails closed when a retained source, raw regional response or directory member changes", async () => {
    const f = await setup(),
      proof = JSON.parse(
        f.preset.archiveFiles["commute-regional-proofs.json"].toString(),
      );
    const raw = proof.files.find((x: { name: string }) =>
      x.name.endsWith("/route.json"),
    );
    await writeFile(join(f.input.regionalProofDirectory, raw.name), "changed");
    await expect(f.load()).rejects.toMatchObject({
      code: "TRAFFIC_COMMUTE_UNAVAILABLE",
    });
    await rm(join(f.input.outputDirectory, "commute-prior.json"));
    await symlink(
      f.input.priorPath,
      join(f.input.outputDirectory, "commute-prior.json"),
    );
    await expect(f.load()).rejects.toMatchObject({
      code: "TRAFFIC_COMMUTE_UNAVAILABLE",
    });
  });
  it("withholds later source-geometry correspondence profiles until their additional proof is supported", async () => {
    const f = await setup(),
      routes = structuredClone(f.routes),
      attachment = routes.attachments[0];
    const old = JSON.parse(
      await readFile(
        join(
          f.input.regionalProofDirectory,
          `bindings/${attachment.local!.bindingHash}.json`,
        ),
        "utf8",
      ),
    );
    const { bindingHash: _previous, ...body } = old;
    body.originalSourceGeometryHash = "d".repeat(64);
    const bindingHash = await trafficContentHash(body);
    await writeFile(
      join(f.input.regionalProofDirectory, `bindings/${bindingHash}.json`),
      canonicalJSON({ ...body, bindingHash }),
    );
    attachment.local!.bindingHash = bindingHash;
    const compilation = await compileTrafficCommuteDemand(
      f.prior,
      routes,
      f.network,
      { sourcePack: f.pack },
    );
    await writeFile(f.input.routesPath, canonicalJSON(routes));
    await writeFile(f.input.compilationPath, canonicalJSON(compilation));
    await expect(
      packageTrafficCommutePreset({
        ...f.input,
        outputDirectory: join(f.dir, "unsupported-profile"),
      }),
    ).rejects.toThrow(/original-source geometry proof validation/);
  });
  it.each([
    "crossing-segment",
    "lane-outside-envelope",
    "missing-regional-proof",
  ])("rejects falsely known out-of-local mass: %s", async (kind) => {
    const f = await setup(),
      routes = structuredClone(f.routes),
      network = structuredClone(f.network);
    // Both endpoint vertices lie outside this small box, but their segment crosses it.
    network.manifest.bounds = [-111.9995, 32.9999, -111.9985, 33.0001];
    if (kind === "lane-outside-envelope") {
      network.manifest.bounds = [-115, 30, -114, 31];
      network.edges[0].lanes[0].shape = [
        [-112, 33],
        [-111.998, 33],
      ];
    }
    routes.localInventoryHash = await trafficContentHash(network);
    for (const attachment of routes.attachments) {
      attachment.status = "no-local-intersection";
      attachment.local = null;
    }
    if (kind === "missing-regional-proof") {
      routes.attachments[0].regionalRouteHash = null;
      routes.attachments[0].regionalSeconds = null;
    }
    if (kind === "missing-regional-proof") {
      await expect(
        compileTrafficCommuteDemand(f.prior, routes, network, {
          sourcePack: f.pack,
        }),
      ).rejects.toThrow(/retained regional path evidence/);
      return;
    }
    const compilation = await compileTrafficCommuteDemand(
      f.prior,
      routes,
      network,
      { sourcePack: f.pack },
    );
    await writeFile(f.input.routesPath, canonicalJSON(routes));
    await writeFile(f.input.compilationPath, canonicalJSON(compilation));
    await expect(
      packageTrafficCommutePreset({
        ...f.input,
        network,
        outputDirectory: join(f.dir, "false-outside"),
      }),
    ).rejects.toThrow(/no-local-intersection/);
  });
  it("accepts known out-of-local mass only when the entire retained route is outside all native lane bounds", async () => {
    const f = await setup(),
      routes = structuredClone(f.routes),
      network = structuredClone(f.network);
    network.manifest.bounds = [-115, 30, -114, 31];
    for (const edge of network.edges)
      for (const lane of edge.lanes)
        lane.shape = lane.shape.map(([x, y]) => [x - 3, y - 3]);
    routes.localInventoryHash = await trafficContentHash(network);
    for (const attachment of routes.attachments) {
      attachment.status = "no-local-intersection";
      attachment.local = null;
    }
    const compilation = await compileTrafficCommuteDemand(
      f.prior,
      routes,
      network,
      { sourcePack: f.pack },
    );
    await writeFile(f.input.routesPath, canonicalJSON(routes));
    await writeFile(f.input.compilationPath, canonicalJSON(compilation));
    const result = await packageTrafficCommutePreset({
      ...f.input,
      network,
      outputDirectory: join(f.dir, "outside"),
    });
    expect(result.summary.totals.vehicles).toBe(0);
  });
});
