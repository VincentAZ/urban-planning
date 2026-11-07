import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { trafficContentHash, studyAreaGeometry } from "@urban/core";
import { trafficPlaceFixture } from "../../../../tests/fixtures/traffic";
import {
  trafficNetworkFixture,
  trafficCountFixture,
  trafficFixturePeriod,
} from "../../../../packages/core/src/traffic-fixture";
import { TrafficCatalog } from "./catalog";
import { SUMO_IMAGE, SUMO_VERSION } from "./types";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "traffic-catalog-"));
  dirs.push(root);
  const folder = join(root, "network");
  await mkdir(folder);
  const network = structuredClone(trafficNetworkFixture()),
    xml = Buffer.from("Synthetic catalog fixture. No native run."),
    pack = structuredClone(trafficCountFixture());
  network.manifest.networkFileSha256 = createHash("sha256")
    .update(xml)
    .digest("hex");
  network.manifest.engine = {
    name: "sumo",
    version: SUMO_VERSION,
    imageDigest: SUMO_IMAGE.split("@")[1],
  };
  for (const count of pack.counts) {
    count.target = null;
    delete count.mapping;
  }
  await Promise.all([
    writeFile(join(folder, "network.json"), JSON.stringify(network)),
    writeFile(join(folder, "network.net.xml"), xml),
    writeFile(
      join(folder, "resources.json"),
      JSON.stringify({
        wallMilliseconds: 1,
        peakMemoryBytes: 1,
        cpuLimit: 2,
        memoryLimitBytes: 2147483648,
        outputBytes: 1,
      }),
    ),
    writeFile(join(root, "counts.json"), JSON.stringify(pack)),
  ]);
  const entry = {
    id: "fixture",
    placeId: trafficPlaceFixture.id,
    studyAreaHash: await trafficContentHash(
      studyAreaGeometry(trafficPlaceFixture),
    ),
    networkDirectory: "network",
    networkHash: network.manifest.networkFileSha256,
    inventoryHash: await trafficContentHash(network),
    sourceEnvelope: [-112.03, 32.97, -111.97, 33.03],
    bufferMeters: 1000,
    countPackPath: "counts.json",
    countPackHash: await trafficContentHash(pack),
    initialPeriod: trafficFixturePeriod,
  };
  const path = join(root, "registry.json"),
    save = () =>
      writeFile(path, JSON.stringify({ version: 1, entries: [entry] }));
  await save();
  return { root, path, folder, entry, save, network };
}
describe("operator traffic registry binds complete prepared inputs", () => {
  it("v2 preserves an explicit default and selects another graph only by prepared identity", async () => {
    const f = await fixture();
    const second = {
      ...f.entry,
      id: "commute-access",
      label: "Reviewed service access",
      defaultForStudy: false,
    };
    await writeFile(
      f.path,
      JSON.stringify({
        version: 2,
        entries: [
          { ...f.entry, label: "Original network", defaultForStudy: true },
          second,
        ],
      }),
    );
    const catalog = new TrafficCatalog(f.path);
    expect((await catalog.forPlace(trafficPlaceFixture)).identity.id).toBe(
      "fixture",
    );
    expect(
      (await catalog.forPlace(trafficPlaceFixture, "commute-access")).identity
        .id,
    ).toBe("commute-access");
    expect(await catalog.choices(trafficPlaceFixture)).toEqual([
      {
        id: "fixture",
        label: "Original network",
        networkHash: f.entry.networkHash,
      },
      {
        id: "commute-access",
        label: "Reviewed service access",
        networkHash: f.entry.networkHash,
      },
    ]);
    await expect(
      catalog.forPlace(trafficPlaceFixture, "missing"),
    ).rejects.toMatchObject({ code: "TRAFFIC_SOURCES_UNAVAILABLE" });
    const elsewhere = structuredClone(trafficPlaceFixture);
    elsewhere.id = "another-study";
    await expect(
      catalog.forPlace(elsewhere, "commute-access"),
    ).rejects.toMatchObject({ code: "TRAFFIC_SOURCES_UNAVAILABLE" });
  });
  it("v2 refuses missing/ambiguous defaults and reused prepared IDs", async () => {
    const f = await fixture();
    for (const entries of [
      [{ ...f.entry, label: "No default", defaultForStudy: false }],
      [
        { ...f.entry, label: "A", defaultForStudy: true },
        { ...f.entry, id: "second", label: "B", defaultForStudy: true },
      ],
      [
        { ...f.entry, label: "A", defaultForStudy: true },
        { ...f.entry, label: "B", defaultForStudy: false },
      ],
    ]) {
      await writeFile(f.path, JSON.stringify({ version: 2, entries }));
      await expect(
        new TrafficCatalog(f.path).forPlace(trafficPlaceFixture),
      ).rejects.toMatchObject({ code: "TRAFFIC_SOURCES_UNAVAILABLE" });
    }
  });
  it("loads the exact saved study without fabricating demand or mapping reviews", async () => {
    const f = await fixture(),
      catalog = new TrafficCatalog(f.path),
      prepared = await catalog.forPlace(trafficPlaceFixture),
      request = await catalog.initialRequest(trafficPlaceFixture, "project");
    expect(prepared.identity.inventoryHash).toBe(f.entry.inventoryHash);
    expect(prepared.identity.workerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(request.demand.rows).toEqual([]);
    expect(request.calibrationPlan).toBeNull();
    expect(
      request.countPack.counts.every((c) => c.target === null && !c.mapping),
    ).toBe(true);
    expect(request.demand.sources[0].rights).toBeUndefined();
  });
  it("rejects an altered complete study and an envelope that misses its edge", async () => {
    const f = await fixture(),
      changed = structuredClone(trafficPlaceFixture);
    changed.boundary![0][0] -= 0.001;
    await expect(
      new TrafficCatalog(f.path).forPlace(changed),
    ).rejects.toMatchObject({ code: "TRAFFIC_SOURCES_UNAVAILABLE" });
    f.entry.sourceEnvelope = [-112.001, 32.97, -111.97, 33.03];
    await f.save();
    await expect(
      new TrafficCatalog(f.path).forPlace(trafficPlaceFixture),
    ).rejects.toThrow("complete saved study");
  });
  it("refuses changed graph inventory and observations rather than fetching replacement evidence", async () => {
    const f = await fixture();
    f.network.manifest.notes.push("Altered after operator capture");
    await writeFile(join(f.folder, "network.json"), JSON.stringify(f.network));
    await expect(
      new TrafficCatalog(f.path).forPlace(trafficPlaceFixture),
    ).rejects.toThrow("operator capture");
    f.entry.inventoryHash = await trafficContentHash(f.network);
    await f.save();
    const pack = trafficCountFixture();
    pack.counts[0].value = 999;
    await writeFile(join(f.root, "counts.json"), JSON.stringify(pack));
    await expect(
      new TrafficCatalog(f.path).forPlace(trafficPlaceFixture),
    ).rejects.toThrow("no replacement was fetched");
  });
  it("confines file paths to the operator registry and fails duplicate study bindings", async () => {
    const f = await fixture();
    f.entry.networkDirectory = "../";
    await f.save();
    await expect(
      new TrafficCatalog(f.path).forPlace(trafficPlaceFixture),
    ).rejects.toThrow("outside the operator registry");
    await writeFile(
      f.path,
      JSON.stringify({
        version: 1,
        entries: [f.entry, { ...f.entry, id: "duplicate" }],
      }),
    );
    await expect(
      new TrafficCatalog(f.path).forPlace(trafficPlaceFixture),
    ).rejects.toThrow("duplicate study");
  });
});
