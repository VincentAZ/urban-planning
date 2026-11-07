import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const directories: string[] = [];
const script = resolve("scripts/traffic-counts-archive.py");
const build = String.raw`
import json,sys,zipfile,stat
data=json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    for item in data['entries']:
        info=zipfile.ZipInfo(item['name'])
        info.compress_type=zipfile.ZIP_DEFLATED if item.get('compressed') else zipfile.ZIP_STORED
        if item.get('symlink'):
            info.create_system=3
            info.external_attr=(stat.S_IFLNK|0o777)<<16
        archive.writestr(info, item.get('text','data').encode()*item.get('repeat',1))
if data.get('corrupt'):
    with open(sys.argv[1], 'r+b') as archive:
        archive.seek(30+len(data['entries'][0]['name'].encode()))
        archive.write(b'X')
`;
async function fixture(
  entries: {
    name: string;
    text?: string;
    repeat?: number;
    compressed?: boolean;
    symlink?: boolean;
  }[],
  corrupt = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "traffic-archive-"));
  directories.push(directory);
  const archive = join(directory, "source.zip"),
    output = join(directory, "retained", "observations.VOL");
  await execute("python3", [
    "-c",
    build,
    archive,
    JSON.stringify({ entries, corrupt }),
  ]);
  return {
    directory,
    archive,
    output,
    run: (member = "AZ.VOL") =>
      execute(
        "python3",
        [script, "--archive", archive, "--member", member, "--output", output],
        { timeout: 10000 },
      ),
  };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("retained FHWA ZIP extraction", () => {
  it("selects exact source bytes and verifies idempotent reuse without overwriting evidence", async () => {
    const text = "Station|Hour_00\r\n001A|0\r\n",
      f = await fixture([
        { name: "AZ.VOL", text },
        { name: "NY.VOL", text: "not selected" },
      ]);
    const first = JSON.parse((await f.run()).stdout),
      second = JSON.parse((await f.run()).stdout);
    expect(first).toEqual({
      member: "AZ.VOL",
      sha256: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    });
    expect(second).toEqual(first);
    expect(await readFile(f.output, "utf8")).toBe(text);
    await writeFile(f.output, "changed original");
    await expect(f.run()).rejects.toThrow(/retained source member changed/);
    expect(await readFile(f.output, "utf8")).toBe("changed original");
    expect(await readdir(join(f.directory, "retained"))).toEqual([
      "observations.VOL",
    ]);
  });
  it.each(["../outside", "/absolute", "C:drive", "bad\\path"])(
    "rejects dangerous inventory paths even in unselected member %s",
    async (name) => {
      const f = await fixture([{ name: "AZ.VOL" }, { name }]);
      await expect(f.run()).rejects.toThrow(/Unsafe or oversized/);
      expect(await readdir(f.directory)).toEqual(["source.zip"]);
    },
  );
  it("rejects case-insensitive duplicate members and archive symlinks", async () => {
    for (const extra of [
      { name: "az.vol" },
      { name: "linked", symlink: true, text: "../secret" },
    ]) {
      const f = await fixture([{ name: "AZ.VOL" }, extra]);
      await expect(f.run()).rejects.toThrow(/Unsafe or oversized/);
      expect(await readdir(f.directory)).toEqual(["source.zip"]);
    }
  });
  it("rejects an expansion bomb before creating the destination", async () => {
    const f = await fixture([
      { name: "AZ.VOL", text: "0", repeat: 1_000_000, compressed: true },
    ]);
    await expect(f.run()).rejects.toThrow(/Unsafe or oversized/);
    expect(await readdir(f.directory)).toEqual(["source.zip"]);
  });
  it("checks CRC and cleans the partial file after corrupt input", async () => {
    const f = await fixture([{ name: "AZ.VOL", text: "unchanged" }], true);
    await expect(f.run()).rejects.toThrow(/CRC/);
    expect(await readdir(join(f.directory, "retained"))).toEqual([]);
  });
  it("refuses an existing linked destination even if bytes match", async () => {
    const f = await fixture([{ name: "AZ.VOL", text: "original" }]);
    await f.run();
    await rm(f.output);
    const target = join(f.directory, "private.txt");
    await writeFile(target, "original");
    await symlink(target, f.output);
    await expect(f.run()).rejects.toThrow(/retained source member changed/);
    expect(await readFile(target, "utf8")).toBe("original");
  });
});
