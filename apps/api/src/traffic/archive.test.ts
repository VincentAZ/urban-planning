import {
  mkdtemp,
  readdir,
  rm,
  writeFile,
  symlink,
  mkdir,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TrafficArchive, TRAFFIC_ARCHIVE_LIMITS } from "./archive.js";

const directories: string[] = [];
const scope = { organizationId: "organization", projectId: "project" };
const files = () => ({
  "baseline.net.xml": Buffer.from("<net/>", "utf8"),
  "pair.json": Buffer.from('{"version":1}'),
  "baseline.log": Buffer.alloc(0),
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "traffic-evidence-"));
  directories.push(directory);
  return { directory, archive: new TrafficArchive(directory) };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("private traffic evidence bundles", () => {
  it("reuses verified evidence at the quota without reserving a second copy", async () => {
    const { archive, directory } = await fixture();
    const original = await archive.stage(scope, files());
    await original.settle(true);
    const pending = join(
      directory,
      "pending-00000000-0000-0000-0000-000000000000",
    );
    await mkdir(pending);
    const padding = join(pending, "retained.bin");
    await writeFile(padding, "");
    // Sparse quota fixture: the declared archive bytes are exercised without allocating 2 GiB of memory or data blocks.
    await truncate(
      padding,
      TRAFFIC_ARCHIVE_LIMITS.totalBytes - original.reference.bytes,
    );
    await expect(
      archive.stage(scope, { "new.json": Buffer.from("new") }),
    ).rejects.toMatchObject({ code: "TRAFFIC_ARCHIVE_FULL" });
    const reused = await archive.stage(scope, files());
    expect(reused.reference).toEqual(original.reference);
    await reused.settle(false);
    expect(await archive.verify(scope, original.reference)).toBeTruthy();
  });
  it("retains exact native bytes with a verified manifest, including empty logs", async () => {
    const { archive } = await fixture(),
      original = files(),
      staged = await archive.stage(scope, original);
    await staged.settle(true);
    const manifest = await archive.verify(scope, staged.reference);
    expect(manifest.files).toHaveLength(3);
    expect(staged.reference.fileCount).toBe(3);
    for (const [name, raw] of Object.entries(original))
      expect(await archive.read(scope, staged.reference, name)).toEqual(raw);
    await expect(
      archive.read(scope, staged.reference, "../pair.json"),
    ).rejects.toMatchObject({ code: "TRAFFIC_ARCHIVE_UNAVAILABLE" });
  });
  it("holds one writer across instances until database admission is settled", async () => {
    const { directory, archive } = await fixture(),
      other = new TrafficArchive(directory),
      staged = await archive.stage(scope, files());
    await expect(other.stage(scope, files())).rejects.toMatchObject({
      code: "TRAFFIC_ARCHIVE_BUSY",
    });
    await staged.settle(true);
    const same = await other.stage(scope, files());
    expect(same.reference).toEqual(staged.reference);
    await same.settle(false);
    expect(await archive.verify(scope, staged.reference)).toBeTruthy();
    expect(await readdir(directory)).toEqual([
      `bundle-${staged.reference.sha256}`,
    ]);
  });
  it("rolls back only newly published unreferenced bytes and settles idempotently", async () => {
    const { archive, directory } = await fixture(),
      staged = await archive.stage(scope, files());
    await staged.settle(false);
    await staged.settle(true);
    expect(await readdir(directory)).toEqual([]);
    await expect(archive.verify(scope, staged.reference)).rejects.toMatchObject(
      { code: "TRAFFIC_ARCHIVE_UNAVAILABLE" },
    );
  });
  it("keeps identical content scoped to its project and refuses cross-project lookup", async () => {
    const { archive } = await fixture(),
      first = await archive.stage(scope, files());
    await first.settle(true);
    const otherScope = { ...scope, projectId: "another-project" },
      second = await archive.stage(otherScope, files());
    await second.settle(true);
    expect(second.reference.sha256).not.toBe(first.reference.sha256);
    await expect(
      archive.read(otherScope, first.reference, "pair.json"),
    ).rejects.toMatchObject({ code: "TRAFFIC_ARCHIVE_UNAVAILABLE" });
  });
  it("detects changed bytes, wrong declared size, and unexpected inventory", async () => {
    const { archive, directory } = await fixture(),
      staged = await archive.stage(scope, files());
    await staged.settle(true);
    const path = join(directory, `bundle-${staged.reference.sha256}`);
    await expect(
      archive.verify(scope, {
        ...staged.reference,
        bytes: staged.reference.bytes + 1,
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_ARCHIVE_UNAVAILABLE" });
    await writeFile(join(path, "extra.xml"), "unexpected");
    await expect(archive.verify(scope, staged.reference)).rejects.toMatchObject(
      { code: "TRAFFIC_ARCHIVE_UNAVAILABLE" },
    );
    await rm(join(path, "extra.xml"));
    await writeFile(join(path, "baseline.net.xml"), "<bad/>");
    await expect(archive.verify(scope, staged.reference)).rejects.toMatchObject(
      { code: "TRAFFIC_ARCHIVE_UNAVAILABLE" },
    );
    await expect(archive.stage(scope, files())).rejects.toMatchObject({
      code: "TRAFFIC_ARCHIVE_UNAVAILABLE",
    });
    expect((await readdir(directory)).includes(".write-lock")).toBe(false);
  });
  it("rejects source names and symlinks without following them", async () => {
    const { archive, directory } = await fixture();
    for (const name of [
      "../outside",
      "/absolute",
      ".manifest.json",
      "nested/file.xml",
      "bad\\path",
      "a..b",
    ]) {
      await expect(
        archive.stage(scope, { [name]: Buffer.from("bad") }),
      ).rejects.toMatchObject({ code: "TRAFFIC_ARCHIVE_UNAVAILABLE" });
    }
    await expect(
      archive.stage(scope, {
        "A.xml": Buffer.alloc(0),
        "a.xml": Buffer.alloc(0),
      }),
    ).rejects.toMatchObject({ code: "TRAFFIC_ARCHIVE_UNAVAILABLE" });
    const staged = await archive.stage(scope, files());
    await staged.settle(true);
    const path = join(
        directory,
        `bundle-${staged.reference.sha256}`,
        "pair.json",
      ),
      target = join(directory, "sensitive");
    await writeFile(target, '{"version":1}');
    await rm(path);
    await symlink(target, path);
    await expect(
      archive.read(scope, staged.reference, "pair.json"),
    ).rejects.toMatchObject({ code: "TRAFFIC_ARCHIVE_UNAVAILABLE" });
  });
  it("does not silently steal a persistent writer lock or ignore an unexpected directory", async () => {
    const { archive, directory } = await fixture();
    await mkdir(join(directory, ".write-lock"));
    await expect(archive.stage(scope, files())).rejects.toMatchObject({
      code: "TRAFFIC_ARCHIVE_BUSY",
    });
    await rm(join(directory, ".write-lock"), { recursive: true });
    await mkdir(join(directory, "unreviewed"));
    await expect(archive.assertCapacity()).rejects.toMatchObject({
      code: "TRAFFIC_ARCHIVE_UNAVAILABLE",
    });
  });
});
