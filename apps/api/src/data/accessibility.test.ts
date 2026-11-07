import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accessibilityPackFixture } from "../../../../tests/fixtures/accessibility";
import {
  prepareAccessibilityDestinationPack,
  writeAccessibilityDestinationPack,
  verifyPreparedAccessibilityDestinationPack,
} from "./accessibility";
import {
  COMMUTE_SOURCE_URLS,
  lodesAreaColumns,
} from "./traffic-commute-sources";
const hash = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function directory() {
  const d = await mkdtemp(join(tmpdir(), "accessibility-source-"));
  dirs.push(d);
  return d;
}
function dbf(rows: Record<string, string>[]) {
  const names = ["GEOID20", "INTPTLAT20", "INTPTLON20"],
    widths = [15, 12, 12],
    headerLength = 33 + 32 * names.length,
    recordLength = 1 + widths.reduce((a, b) => a + b, 0),
    buffer = Buffer.alloc(headerLength + recordLength * rows.length + 1);
  buffer[0] = 3;
  buffer.writeUInt32LE(rows.length, 4);
  buffer.writeUInt16LE(headerLength, 8);
  buffer.writeUInt16LE(recordLength, 10);
  names.forEach((name, i) => {
    buffer.write(name, 32 + 32 * i, "ascii");
    buffer[32 + 32 * i + 11] = 67;
    buffer[32 + 32 * i + 16] = widths[i];
  });
  buffer[headerLength - 1] = 13;
  rows.forEach((r, i) => {
    let at = headerLength + i * recordLength;
    buffer.fill(32, at, at + recordLength);
    at++;
    names.forEach((name, j) => {
      buffer.write(r[name], at, "ascii");
      at += widths[j];
    });
  });
  buffer[buffer.length - 1] = 26;
  return buffer;
}
async function preparedFixture() {
  const d = await directory(),
    date = "2026-11-06T00:00:00Z",
    put = async (name: string, url: string, bytes: Buffer | string) => {
      const b = Buffer.from(bytes);
      await writeFile(join(d, name), b);
      await writeFile(
        join(d, `${name}.receipt.json`),
        JSON.stringify({
          url,
          bytes: b.length,
          sha256: hash(b),
          retrievedAt: date,
        }),
      );
    };
  const fixture = accessibilityPackFixture(),
    rows = fixture.destinations.slice(0, 2),
    columns = lodesAreaColumns("wac");
  for (const row of rows)
    row.position = [
      Number(row.position[0].toFixed(7)),
      Number(row.position[1].toFixed(7)),
    ];
  rows[1].cells = Object.fromEntries(
    Object.keys(rows[1].cells).map((k) => [k, 0]),
  );
  const raw =
    columns.join(",") +
    "\n" +
    rows
      .map((r) =>
        columns
          .map((k) =>
            k === "w_geocode"
              ? r.id
              : k === "createdate"
                ? "20251202"
                : (r.cells[k] ?? 0),
          )
          .join(","),
      )
      .join("\n") +
    "\n";
  const name = "az_wac_S000_JT01_2023.csv.gz";
  await put(name, COMMUTE_SOURCE_URLS[name], gzipSync(raw));
  await put(
    name.replace(/\.gz$/, ".sha256sum"),
    COMMUTE_SOURCE_URLS[name].replace(/\.gz$/, ".sha256sum"),
    `${hash(raw)}  ${name.replace(/\.gz$/, "")}\n`,
  );
  await put(
    "version.txt",
    COMMUTE_SOURCE_URLS["version.txt"],
    "Data Vintage: test\nRelease Format Version 8.5\n",
  );
  const dbfName = "tl_2024_04_tabblock20.dbf",
    zipName = "tl_2024_04_tabblock20.zip",
    zipUrl =
      "https://www2.census.gov/geo/tiger/TIGER2024/TABBLOCK20/" + zipName;
  await writeFile(
    join(d, dbfName),
    dbf(
      rows.map((r) => ({
        GEOID20: r.id,
        INTPTLON20: String(r.position[0]),
        INTPTLAT20: String(r.position[1]),
      })),
    ),
  );
  await promisify(execFile)("zip", ["-q", zipName, dbfName], { cwd: d });
  const zip = await readFile(join(d, zipName));
  await writeFile(
    join(d, `${zipName}.json`),
    JSON.stringify({
      url: zipUrl,
      bytes: zip.length,
      sha256: hash(zip),
      retrievedAt: date,
    }),
  );
  // Both points have no residents; the first is also ambiguous only in current BG geography.
  const blocks = {
    schemaVersion: 1,
    stateFips: "04",
    blockGeographyVintage: 2020,
    countyGeoids: [
      "04001",
      "04003",
      "04005",
      "04007",
      "04009",
      "04011",
      "04012",
      "04013",
      "04015",
      "04017",
      "04019",
      "04021",
      "04023",
      "04025",
      "04027",
    ],
    sources: [{ kind: "tabblock20", sha256: hash(zip) }],
    completeness: { stateBlockRows: 2 },
    blocks: [{ id: rows[1].id, position: rows[1].position, population2020: 0 }],
    unallocatedBlocks: [
      {
        id: rows[0].id,
        position: rows[0].position,
        population2020: 0,
        candidateUnitGeoids: ["040130001001", "040130001002"],
        reason: "split-current-geography",
      },
    ],
  };
  const blocksFile = join(d, "blocks.json"),
    blockBytes = JSON.stringify(blocks);
  await writeFile(blocksFile, blockBytes);
  return {
    options: {
      sourceDirectory: d,
      blocksFile,
      blocksSha256: hash(blockBytes),
      blockSourceDirectory: d,
    },
    blocks,
  };
}
describe("complete retained WAC preparation", () => {
  it("verifies original gzip/checksum/DBF and retains jobs in zero-population and split-current-BG blocks", async () => {
    const { options } = await preparedFixture(),
      pack = await prepareAccessibilityDestinationPack(options);
    expect(pack.destinations.map((d) => [d.cells.C000, d.sourceRow])).toEqual([
      [10, 2],
      [0, 3],
    ]);
    expect(pack.destinations[0].raw.CFA01).toBe("0");
    expect(pack.destinations[0].position).toEqual([-112.07, 33.45]);
    expect(pack.lodes).toMatchObject({
      year: 2023,
      formatVersion: "8.5",
      dataVintage: "test",
      createdates: ["20251202"],
    });
    expect(JSON.stringify(pack)).not.toContain(options.sourceDirectory);
    const out = await writeAccessibilityDestinationPack(
      pack,
      await directory(),
    );
    expect(out.sha256).toBe(out.jobsPackHash);
    expect(await verifyPreparedAccessibilityDestinationPack(out.path)).toEqual(
      pack,
    );
    expect(
      await writeAccessibilityDestinationPack(pack, join(out.path, "..")),
    ).toEqual(out);
  });
  it("rejects rehashed prepared point tampering against exact original DBF", async () => {
    const { options, blocks } = await preparedFixture();
    blocks.unallocatedBlocks[0].position = [-112, 33];
    const bytes = JSON.stringify(blocks);
    await writeFile(options.blocksFile, bytes);
    options.blocksSha256 = hash(bytes);
    await expect(prepareAccessibilityDestinationPack(options)).rejects.toThrow(
      /exact original/,
    );
  });
  it("rejects missing complete-state inventory and raw-source checksum mismatch", async () => {
    const { options, blocks } = await preparedFixture();
    blocks.countyGeoids.pop();
    const bytes = JSON.stringify(blocks);
    await writeFile(options.blocksFile, bytes);
    options.blocksSha256 = hash(bytes);
    await expect(prepareAccessibilityDestinationPack(options)).rejects.toThrow(
      /complete Arizona/,
    );
    const second = await preparedFixture();
    await writeFile(
      join(second.options.sourceDirectory, "az_wac_S000_JT01_2023.csv.gz"),
      "Altered original",
    );
    await expect(
      prepareAccessibilityDestinationPack(second.options),
    ).rejects.toThrow(/receipt|hash/);
  });
  it("refuses modified content-addressed packs instead of accepting their old filename", async () => {
    const out = await writeAccessibilityDestinationPack(
      accessibilityPackFixture(),
      await directory(),
    );
    await writeFile(out.path, "{}");
    await expect(
      verifyPreparedAccessibilityDestinationPack(out.path),
    ).rejects.toThrow(/hash mismatch/);
  });
});
