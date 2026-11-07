import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { GisArchive } from "./gis-archive.js";
import { GIS_LIMITS } from "./gis-types.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gis-archive-test-"));
  directories.push(directory);
  return { directory, archive: new GisArchive(directory) };
}
const sha256 = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const entries = async (directory: string) => (await readdir(directory)).sort();
const published = async (directory: string) =>
  (await entries(directory)).filter((name) => name.endsWith(".bin"));

describe("staged GIS archive admission", () => {
  it("keeps buffered artifacts unpublished until finalize and preserves exact bytes on retention", async () => {
    const { archive, directory } = await fixture();
    const bytes = Buffer.concat([
      Buffer.from([0, 255, 0, 13, 10]),
      Buffer.from("courtyard · source evidence", "utf8"),
    ]);
    const staged = await archive.stageBuffer("org-a", "project-a", bytes);
    expect(staged.reference).toEqual({
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
    expect(await entries(directory)).toEqual([
      expect.stringMatching(/\.pending$/),
    ]);
    expect(await published(directory)).toEqual([]);
    await expect(
      archive.read("org-a", "project-a", staged.reference),
    ).rejects.toMatchObject({ code: "GIS_ARCHIVE_UNAVAILABLE" });

    const publication = await staged.finalize();
    expect(publication.reference).toEqual(staged.reference);
    expect(await entries(directory)).toContain(".write-lock");
    expect(await published(directory)).toHaveLength(1);
    expect(
      await archive.read("org-a", "project-a", publication.reference),
    ).toEqual(bytes);
    await publication.settle(true);
    await staged.discard();
    expect(await entries(directory)).toEqual(await published(directory));
    expect(await published(directory)).toHaveLength(1);
    expect(
      await readFile(
        await archive.path("org-a", "project-a", publication.reference),
      ),
    ).toEqual(bytes);
  });

  it("keeps a streamed upload temporary until admission and can discard it without publishing", async () => {
    const { archive, directory } = await fixture();
    const chunks = [Buffer.from("first\0"), Buffer.from("second\n")];
    const staged = await archive.receiveTemporary(
      "org-a",
      "project-a",
      Readable.from(chunks),
    );
    expect(staged.reference).toEqual({
      sha256: sha256(Buffer.concat(chunks)),
      bytes: Buffer.concat(chunks).length,
    });
    expect(await entries(directory)).toEqual([
      expect.stringMatching(/\.upload$/),
    ]);
    await expect(
      archive.path("org-a", "project-a", staged.reference),
    ).rejects.toMatchObject({ code: "GIS_ARCHIVE_UNAVAILABLE" });
    await Promise.all([staged.discard(), staged.discard()]);
    expect(await entries(directory)).toEqual([]);

    const accepted = await archive.receiveTemporary(
      "org-a",
      "project-a",
      Readable.from(chunks),
    );
    const publication = await accepted.finalize();
    await publication.settle(true);
    await accepted.discard();
    expect(
      await archive.read("org-a", "project-a", publication.reference),
    ).toEqual(Buffer.concat(chunks));
    expect(await entries(directory)).toEqual(await published(directory));
  });

  it("holds the cross-instance writer lock until admission settles, then permits the next writer", async () => {
    const { archive, directory } = await fixture();
    const peer = new GisArchive(directory);
    const first = await archive.stageBuffer(
      "org-a",
      "project-a",
      Buffer.from("first evidence"),
    );
    const second = await peer.stageBuffer(
      "org-b",
      "project-b",
      Buffer.from("second evidence"),
    );
    const admission = await first.finalize();

    // Admission can await an external transaction. Finalize must not release
    // its lock just because the content-addressed file now exists.
    await expect(second.finalize()).rejects.toMatchObject({
      code: "GIS_ARCHIVE_BUSY",
    });
    expect(await entries(directory)).toContain(".write-lock");
    expect(await published(directory)).toHaveLength(1);
    await first.discard();
    expect(await entries(directory)).toContain(".write-lock");
    await admission.settle(true);
    await second.discard();

    const retry = await peer.stageBuffer(
      "org-b",
      "project-b",
      Buffer.from("second evidence"),
    );
    const retryAdmission = await retry.finalize();
    await retryAdmission.settle(true);
    await retry.discard();
    expect(await entries(directory)).not.toContain(".write-lock");
    expect(await published(directory)).toHaveLength(2);
  });

  it("serializes simultaneous publications so a rejected admission cannot delete a later retained copy", async () => {
    const { archive, directory } = await fixture();
    const peer = new GisArchive(directory);
    const bytes = Buffer.from("the same raw file was retried");
    const candidates = await Promise.all([
      archive.stageBuffer("org-a", "project-a", bytes),
      peer.stageBuffer("org-a", "project-a", bytes),
    ]);
    const decisions = await Promise.allSettled(
      candidates.map((candidate) => candidate.finalize()),
    );
    const accepted = decisions.filter((entry) => entry.status === "fulfilled");
    const refused = decisions.filter((entry) => entry.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: "GIS_ARCHIVE_BUSY" });
    const publication = accepted[0].value;
    await publication.settle(false);
    await Promise.all(candidates.map((candidate) => candidate.discard()));
    expect(await entries(directory)).toEqual([]);

    const retained = await peer.put("org-a", "project-a", bytes);
    // An old settled admission must not roll back a new accepted publication.
    await publication.settle(false);
    await publication.settle(true);
    expect(await archive.read("org-a", "project-a", retained)).toEqual(bytes);
    expect(await published(directory)).toHaveLength(1);
  });

  it("rolls back fresh rejected content but never removes previously retained identical evidence", async () => {
    const { archive, directory } = await fixture();
    const bytes = Buffer.from("retained survey bytes");
    const staged = await archive.stageBuffer("org-a", "project-a", bytes);
    const fresh = await staged.finalize();
    await fresh.settle(false);
    await Promise.all([fresh.settle(false), fresh.settle(true)]);
    await Promise.all([staged.discard(), staged.discard()]);
    expect(await entries(directory)).toEqual([]);

    const retained = await archive.put("org-a", "project-a", bytes);
    const duplicate = await archive.stageBuffer("org-a", "project-a", bytes);
    const duplicateAdmission = await duplicate.finalize();
    await duplicateAdmission.settle(false);
    await duplicateAdmission.settle(false);
    await duplicate.discard();
    expect(await archive.read("org-a", "project-a", retained)).toEqual(bytes);
    expect(await entries(directory)).toEqual(await published(directory));
    expect(await published(directory)).toHaveLength(1);
  });

  it("isolates equal content by both organization and project and rejects mismatched references", async () => {
    const { archive, directory } = await fixture();
    const bytes = Buffer.from("private source bytes");
    const reference = await archive.put("org-a", "project-a", bytes);
    for (const [organization, project] of [
      ["org-b", "project-a"],
      ["org-a", "project-b"],
    ]) {
      await expect(
        archive.read(organization, project, reference),
      ).rejects.toMatchObject({ code: "GIS_ARCHIVE_UNAVAILABLE" });
      const other = await archive.put(organization, project, bytes);
      expect(other).toEqual(reference);
      expect(await archive.read(organization, project, other)).toEqual(bytes);
    }
    expect(await published(directory)).toHaveLength(3);
    for (const changed of [
      { ...reference, bytes: reference.bytes + 1 },
      { ...reference, sha256: "0".repeat(64) },
      { ...reference, sha256: "../private" },
    ])
      await expect(
        archive.read("org-a", "project-a", changed),
      ).rejects.toMatchObject({ code: "GIS_ARCHIVE_UNAVAILABLE" });
    expect(await archive.read("org-a", "project-a", reference)).toEqual(bytes);
  });

  it("checks staged bytes again before publication and releases the lock on a failed integrity check", async () => {
    const { archive, directory } = await fixture();
    const bytes = Buffer.from("original bytes");
    const staged = await archive.stageBuffer("org-a", "project-a", bytes);
    const pending = (await entries(directory)).find((name) =>
      name.endsWith(".pending"),
    )!;
    await writeFile(join(directory, pending), Buffer.from("tampered bytes"));
    await expect(staged.finalize()).rejects.toMatchObject({
      code: "GIS_ARCHIVE_UNAVAILABLE",
    });
    expect(await entries(directory)).not.toContain(".write-lock");
    expect(await published(directory)).toEqual([]);
    await staged.discard();
    const retained = await archive.put("org-a", "project-a", bytes);
    expect(await archive.read("org-a", "project-a", retained)).toEqual(bytes);
  });

  it("cleans temporary files after oversized, truncated, empty and cancelled streams", async () => {
    const { archive, directory } = await fixture();
    async function* oversized() {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let n = 0; n < GIS_LIMITS.inputBytes / chunk.length; n++)
        yield chunk;
      yield Buffer.from([0x62]);
    }
    await expect(
      archive.receiveTemporary(
        "org-a",
        "project-a",
        Readable.from(oversized()),
      ),
    ).rejects.toMatchObject({ code: "GIS_UPLOAD_TOO_LARGE" });
    expect(await entries(directory)).toEqual([]);

    const truncated = Object.assign(Readable.from([Buffer.from("partial")]), {
      truncated: true,
    });
    await expect(
      archive.receiveTemporary("org-a", "project-a", truncated),
    ).rejects.toMatchObject({ code: "GIS_UPLOAD_TOO_LARGE" });
    expect(await entries(directory)).toEqual([]);
    await expect(
      archive.receiveTemporary("org-a", "project-a", Readable.from([])),
    ).rejects.toMatchObject({ code: "GIS_UPLOAD_EMPTY" });
    expect(await entries(directory)).toEqual([]);

    const cancelled = new Error("The client cancelled this upload");
    let started = false;
    const stream = new Readable({
      read() {
        if (started) return;
        started = true;
        this.push(Buffer.from("partial source"));
        process.nextTick(() => this.destroy(cancelled));
      },
    });
    await expect(
      archive.receiveTemporary("org-a", "project-a", stream),
    ).rejects.toBe(cancelled);
    expect(await entries(directory)).toEqual([]);

    // Failure paths also release upload admission slots for subsequent work.
    const next = await archive.receiveTemporary(
      "org-a",
      "project-a",
      Readable.from([Buffer.from("complete")]),
    );
    await next.discard();
    expect(await entries(directory)).toEqual([]);
  });
});
