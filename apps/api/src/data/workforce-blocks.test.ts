import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  censusBlockSourceUrl,
  loadWorkforceBlockSource,
  prepareWorkforceBlocks,
  readCensusDbf,
  sha256,
  WORKFORCE_BLOCK_LIMITS,
  writeWorkforceBlocks,
  type WorkforceBlockSource,
  type WorkforceBlockSourceKind,
} from "./workforce-blocks";

type Row = Record<string, string | null>;
const fields = {
  tabblock20: [
    "STATEFP20",
    "COUNTYFP20",
    "TRACTCE20",
    "BLOCKCE20",
    "GEOID20",
    "POP20",
    "HOUSING20",
    "INTPTLAT20",
    "INTPTLON20",
  ],
  tabblocksufx: [
    "STATEFP20",
    "COUNTYFP20",
    "TRACTCE20",
    "BLOCKCE20",
    "STATEFP",
    "COUNTYFP",
    "TRACTCE",
    "BLKGRPCE",
    "SUFFIXCE",
  ],
  bg: ["STATEFP", "COUNTYFP", "TRACTCE", "BLKGRPCE", "GEOID"],
};
function dbf(names: string[], rows: Row[]) {
  const widths = names.map((name) =>
    Math.max(1, ...rows.map((row) => row[name]?.length ?? 0)),
  );
  const headerLength = 33 + names.length * 32;
  const recordLength = 1 + widths.reduce((sum, width) => sum + width, 0);
  const result = Buffer.alloc(headerLength + rows.length * recordLength + 1, 0);
  result[0] = 3;
  result.writeUInt32LE(rows.length, 4);
  result.writeUInt16LE(headerLength, 8);
  result.writeUInt16LE(recordLength, 10);
  names.forEach((name, i) => {
    const offset = 32 + 32 * i;
    result.write(name, offset, "ascii");
    result[offset + 11] = "C".charCodeAt(0);
    result[offset + 16] = widths[i];
  });
  result[headerLength - 1] = 13;
  rows.forEach((row, index) => {
    let at = headerLength + index * recordLength;
    result.fill(32, at, at + recordLength);
    at++;
    names.forEach((name, i) => {
      result.write(row[name] ?? "", at, "ascii");
      at += widths[i];
    });
  });
  result[result.length - 1] = 26;
  return result;
}
function block(
  blockNumber: string,
  population: string | null,
  county = "013",
): Row {
  return {
    STATEFP20: "04",
    COUNTYFP20: county,
    TRACTCE20: "000100",
    BLOCKCE20: blockNumber,
    GEOID20: `04${county}000100${blockNumber}`,
    POP20: population,
    HOUSING20: "3",
    INTPTLAT20: "+33.4500000",
    INTPTLON20: "-112.0700000",
  };
}
function relation(row: Row, group = row.BLOCKCE20![0], suffix = ""): Row {
  return {
    ...row,
    STATEFP: "04",
    COUNTYFP: row.COUNTYFP20,
    TRACTCE: "000100",
    BLKGRPCE: group,
    SUFFIXCE: suffix,
  };
}
function group(bg = "1", county = "013"): Row {
  return {
    STATEFP: "04",
    COUNTYFP: county,
    TRACTCE: "000100",
    BLKGRPCE: bg,
    GEOID: `04${county}000100${bg}`,
  };
}
function fixture(
  options: {
    blocks?: Row[];
    relationships?: Row[];
    groups?: Row[];
    counties?: string[];
  } = {},
) {
  const blocks = options.blocks ?? [
    block("1000", "10"),
    block("1001", "0"),
    block("1000", "8", "021"),
  ];
  const buffers = {
    tabblock20: dbf(fields.tabblock20, blocks),
    tabblocksufx: dbf(
      fields.tabblocksufx,
      options.relationships ?? blocks.map((b) => relation(b)),
    ),
    bg: dbf(fields.bg, options.groups ?? [group(), group("1", "021")]),
  };
  const sources: WorkforceBlockSource[] = Object.entries(buffers).map(
    ([name, bytes]) => {
      const kind = name as WorkforceBlockSourceKind;
      return {
        kind,
        url: censusBlockSourceUrl("04", kind),
        sha256: "a".repeat(64),
        bytes: 1234,
        retrievedAt: "2026-11-06T00:00:00.000Z",
        archiveEntry: `tl_2024_04_${kind}.dbf`,
        dbfSha256: sha256(bytes),
        dbfBytes: bytes.length,
        records: readCensusDbf(bytes).records,
      };
    },
  );
  return {
    stateFips: "04",
    countyGeoids: options.counties,
    blocksDbf: buffers.tabblock20,
    relationshipsDbf: buffers.tabblocksufx,
    blockGroupsDbf: buffers.bg,
    sources,
  };
}
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "workforce-blocks-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("complete Census workforce origin preparation", () => {
  it("preserves complete county rows, true zero counts, internal points and separate vintages", () => {
    const result = prepareWorkforceBlocks(fixture({ counties: ["04013"] }));
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[1].population2020).toBe(0);
    expect(result.blocks[0]).toMatchObject({
      id: "040130001001000",
      unitGeoid: "040130001001",
      position: [-112.07, 33.45],
    });
    expect(result.completeness.counties).toEqual([
      {
        geoid: "04013",
        blocks: 2,
        blockGroups: 1,
        zeroPopulationBlocks: 1,
        population2020: 10,
        housingUnits2020: 6,
      },
    ]);
    expect(result.completeness.stateBlockRows).toBe(3);
    expect(result.populationVintage).toBe(2020);
    expect(result.targetGeographyVintage).toBe(2024);
    expect(result.geographyMatch.unchangedPolygonsAsserted).toBe(false);
    expect(result.blocks[0]).not.toHaveProperty("weight");
  });
  it("uses official changed-BG membership, accepting suffix subdivisions only within one current BG", () => {
    const original = block("1000", "9");
    const result = prepareWorkforceBlocks(
      fixture({
        blocks: [original],
        relationships: [
          relation(original, "2", "A"),
          relation(original, "2", "B"),
        ],
        groups: [group("2")],
      }),
    );
    expect(result.blocks[0].unitGeoid).toBe("040130001002");
    expect(result.blocks[0].blockGroup2020).toBe("040130001001");
    expect(result.geographyMatch.changedBlockGroupIds).toBe(1);
    expect(result.geographyMatch.multipleSuffixPiecesSameGroup).toBe(1);
    expect(result.completeness.counties[0].population2020).toBe(9);
  });
  it("retains cross-BG original blocks once as unallocated, preserving positive and zero counts", () => {
    for (const population of ["9", "0"]) {
      const original = block("1000", population);
      const result = prepareWorkforceBlocks(
        fixture({
          blocks: [original],
          relationships: [
            relation(original, "1", "A"),
            relation(original, "2", "B"),
          ],
          groups: [group(), group("2")],
        }),
      );
      expect(result.blocks).toEqual([]);
      expect(result.unallocatedBlocks).toHaveLength(1);
      expect(result.unallocatedBlocks[0]).toMatchObject({
        id: original.GEOID20,
        population2020: Number(population),
        candidateUnitGeoids: ["040130001001", "040130001002"],
        reason: "split-current-geography",
      });
      expect(result.unallocatedBlocks[0]).not.toHaveProperty("unitGeoid");
      expect(result.unallocatedBlocks[0]).not.toHaveProperty("weight");
      expect(result.completeness.counties[0]).toMatchObject({
        blocks: 1,
        blockGroups: 2,
        population2020: Number(population),
        zeroPopulationBlocks: population === "0" ? 1 : 0,
      });
      expect(result.geographyMatch.unresolvedPopulation2020).toBe(
        Number(population),
      );
      expect(result.blockGroupGeoids).toEqual(["040130001001", "040130001002"]);
    }
  });
  it("distinguishes missing counts from zero and rejects negative, fractional and overflow counts", () => {
    for (const invalid of [null, "-1", "1.5", "9007199254740992"])
      expect(() =>
        prepareWorkforceBlocks(
          fixture({ blocks: [block("1000", invalid)], groups: [group()] }),
        ),
      ).toThrow(/POP20/);
    const missingHousing = { ...block("1000", "0"), HOUSING20: null };
    expect(() =>
      prepareWorkforceBlocks(
        fixture({ blocks: [missingHousing], groups: [group()] }),
      ),
    ).toThrow("HOUSING20 is missing");
    expect(() =>
      prepareWorkforceBlocks(
        fixture({
          blocks: [block("1000", "9007199254740991"), block("1001", "1")],
          groups: [group()],
        }),
      ),
    ).toThrow("safe integer precision");
  });
  it("rejects absent relationships, absent current BGs, orphan BGs and missing selected counties", () => {
    const original = block("1000", "9");
    expect(() =>
      prepareWorkforceBlocks(fixture({ relationships: [relation(original)] })),
    ).toThrow("no official current-BG relationship");
    expect(() =>
      prepareWorkforceBlocks(fixture({ groups: [group()] })),
    ).toThrow("absent from TIGER2024 BG");
    expect(() =>
      prepareWorkforceBlocks(
        fixture({ groups: [group(), group("2"), group("1", "021")] }),
      ),
    ).toThrow("no complete original-block allocation");
    expect(() =>
      prepareWorkforceBlocks(fixture({ counties: ["04015"] })),
    ).toThrow("selected county is absent");
  });
  it("rejects duplicate original blocks and relationship records, invalid IDs and invalid points", () => {
    const original = block("1000", "9");
    expect(() =>
      prepareWorkforceBlocks(
        fixture({
          blocks: [original, original],
          relationships: [relation(original)],
          groups: [group()],
        }),
      ),
    ).toThrow("duplicate");
    expect(() =>
      prepareWorkforceBlocks(
        fixture({
          blocks: [original],
          relationships: [relation(original), relation(original)],
          groups: [group()],
        }),
      ),
    ).toThrow("Duplicate");
    expect(() =>
      prepareWorkforceBlocks(
        fixture({
          blocks: [{ ...original, GEOID20: "040130001002000" }],
          groups: [group()],
        }),
      ),
    ).toThrow("mismatched");
    expect(() =>
      prepareWorkforceBlocks(
        fixture({
          blocks: [{ ...original, INTPTLAT20: "" }],
          groups: [group()],
        }),
      ),
    ).toThrow("Invalid Census internal point");
  });
  it("validates complete DBF structure, no skipped deleted records, and source digest binding", () => {
    const input = fixture();
    expect(() => readCensusDbf(input.blocksDbf.subarray(0, -2))).toThrow(
      "record count",
    );
    const deleted = Buffer.from(input.blocksDbf);
    deleted[deleted.readUInt16LE(8)] = 42;
    expect(() => [...readCensusDbf(deleted).rows()]).toThrow("Deleted");
    const trailing = Buffer.concat([input.blocksDbf, Buffer.from([0])]);
    expect(() => readCensusDbf(trailing)).toThrow("record count");
    input.sources[0].dbfSha256 = "0".repeat(64);
    expect(() => prepareWorkforceBlocks(input)).toThrow("provenance");
  });
  it("writes deterministic immutable artifacts and refuses existing hash-path tampering", async () => {
    const path = await directory();
    const prepared = prepareWorkforceBlocks(fixture());
    const first = await writeWorkforceBlocks(path, prepared);
    expect(await writeWorkforceBlocks(path, prepared)).toEqual(first);
    expect(sha256(await readFile(first.filename))).toBe(first.sha256);
    expect(await readdir(path)).toHaveLength(1);
    await writeFile(first.filename, "tampered");
    await expect(writeWorkforceBlocks(path, prepared)).rejects.toBeDefined();
    expect(await readFile(first.filename, "utf8")).toBe("tampered");
    expect(await readdir(path)).toHaveLength(1);
  });
  it("downloads and checks a real ZIP member, then reuses verified bytes without refetching", async () => {
    const path = await directory();
    const sourcePath = await directory();
    const entry = "tl_2024_04_bg.dbf";
    const expected = fixture().blockGroupsDbf;
    await writeFile(join(sourcePath, entry), expected);
    await promisify(execFile)("zip", ["-q", "fixture.zip", entry], {
      cwd: sourcePath,
    });
    const archive = await readFile(join(sourcePath, "fixture.zip"));
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(new Uint8Array(archive), {
        headers: { "content-length": String(archive.length) },
      });
    }) as typeof fetch;
    const first = await loadWorkforceBlockSource(path, "04", "bg", fetcher);
    expect(first.dbf).toEqual(expected);
    expect(first.source.sha256).toBe(sha256(archive));
    expect(await loadWorkforceBlockSource(path, "04", "bg", fetcher)).toEqual(
      first,
    );
    expect(calls).toBe(1);
    await writeFile(
      join(path, "tl_2024_04_bg.zip"),
      Buffer.alloc(archive.length, 0),
    );
    await expect(
      loadWorkforceBlockSource(path, "04", "bg", fetcher),
    ).rejects.toThrow("integrity");
    expect(calls).toBe(1);
  });
  it("rejects oversized source downloads and leaves no partial output", async () => {
    const path = await directory();
    const fetcher = async () =>
      new Response("x", {
        headers: {
          "content-length": String(WORKFORCE_BLOCK_LIMITS.archiveBytes + 1),
        },
      });
    await expect(
      loadWorkforceBlockSource(path, "04", "bg", fetcher as typeof fetch),
    ).rejects.toThrow("byte limit");
    expect(await readdir(path)).toEqual([]);
  });
});
