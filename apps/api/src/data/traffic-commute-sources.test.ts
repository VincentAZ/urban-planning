import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreparedWorkforceBlocks } from "./workforce-blocks";
import {
  COMMUTE_ACS_COLUMNS,
  LODES_OD_COLUMNS,
  commuteTractRelationships,
  lodesAreaColumns,
  readCommuteAcs,
  readCommuteTable,
  readLodesArea,
  readLodesOd,
  verifyCommuteSource,
} from "./traffic-commute-sources";

async function* chunks(text: string, width = 23) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += width)
    yield bytes.subarray(i, i + width);
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const od = (home: string, work: string, jobs = 2) =>
  [
    work,
    home,
    String(jobs),
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "20251202",
  ].join(",");
const area = (kind: "rac" | "wac", id: string, jobs: number) =>
  lodesAreaColumns(kind)
    .map((f, i) =>
      i === 0
        ? id
        : f === "C000"
          ? String(jobs)
          : f === "createdate"
            ? "20251202"
            : "0",
    )
    .join(",");

describe("bounded official commute source readers", () => {
  it("preserves complete raw OD records, source rows, dates and decompressed-byte identity", async () => {
    const text = `${LODES_OD_COLUMNS.join(",")}\r\n${od("040130001001001", "040130002001001")}\r\n${od("040130001001002", "040130002001001", 0)}\r\n`;
    const retained: unknown[] = [];
    const result = await readLodesOd(chunks(text, 1), "main", (...values) =>
      retained.push(values),
    );
    expect(result.source).toMatchObject({
      rows: 2,
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
    });
    expect([...result.homes.values()]).toEqual([2, 0]);
    expect(result.createdates).toEqual(["20251202"]);
    expect(retained[0]).toEqual([
      "040130001001001",
      "040130002001001",
      2,
      expect.objectContaining({ S000: "2", createdate: "20251202" }),
      2,
    ]);
  });
  it("distinguishes inbound aux from resident main and rejects duplicate, reordered or invalid jobs", async () => {
    const head = LODES_OD_COLUMNS.join(",") + "\n";
    await expect(
      readLodesOd(
        chunks(head + od("060130001001001", "040130002001001")),
        "aux",
      ),
    ).resolves.toHaveProperty("source.rows", 1);
    await expect(
      readLodesOd(
        chunks(head + od("060130001001001", "040130002001001")),
        "main",
      ),
    ).rejects.toThrow("wrong-state");
    await expect(
      readLodesOd(
        chunks(
          head +
            [
              od("040130001001001", "040130002001001"),
              od("040130001001001", "040130002001001"),
            ].join("\n"),
        ),
        "main",
      ),
    ).rejects.toThrow("duplicate");
    await expect(
      readLodesOd(
        chunks(head + od("040130001001001", "040130002001001", -1)),
        "main",
      ),
    ).rejects.toThrow("integer");
  });
  it("retains complete RAC and WAC denominators without applying any mode or population factor", async () => {
    const captured: unknown[] = [];
    for (const kind of ["rac", "wac"] as const) {
      const text =
        lodesAreaColumns(kind).join(",") +
        "\n" +
        area(kind, "040130001001001", 123);
      const result = await readLodesArea(chunks(text), kind, (raw, row) =>
        captured.push([raw.C000, row]),
      );
      expect(result.counts.get("040130001001001")).toBe(123);
      await expect(
        readLodesArea(
          chunks(text + "\n" + area(kind, "040130001001001", 1)),
          kind,
        ),
      ).rejects.toThrow("Duplicate");
    }
    expect(captured).toEqual([
      ["123", 2],
      ["123", 2],
    ]);
  });
  it("preserves all90 ACS native cells, explicit zero, suppression and controlled MOE", async () => {
    const values = Object.fromEntries(COMMUTE_ACS_COLUMNS.map((c) => [c, "0"]));
    values.B08132_E016 = "7";
    values.B08132_E022 = "7";
    values.B08132_E031 = "-999999999";
    values.B08132_M031 = "-555555555";
    const text = `GEO_ID|${COMMUTE_ACS_COLUMNS.join("|")}\n1400000US04013000100|${COMMUTE_ACS_COLUMNS.map((c) => values[c]).join("|")}\n`;
    const result = await readCommuteAcs(chunks(text, 7));
    const cells = result.tracts.get("04013000100")!.cells;
    expect(Object.keys(cells)).toHaveLength(90);
    expect(cells.B08132_022.estimate).toMatchObject({
      value: 7,
      raw: "7",
      status: "available",
    });
    expect(cells.B08132_023.estimate.value).toBe(0);
    expect(cells.B08132_031).toMatchObject({
      estimate: { value: null, status: "suppressed" },
      marginOfError: { value: 0, status: "controlled" },
    });
    await expect(
      readCommuteAcs(chunks(text.replace("|7|0|", "|8|0|"))),
    ).rejects.toThrow("reconcile");
  });
  it("rejects wrong headers, malformed CSV, invalid UTF8 and byte/record bounds without silent truncation", async () => {
    await expect(
      readCommuteTable(chunks("a,a\n1,2"), ",", ["a", "b"], () => {}),
    ).rejects.toThrow("header");
    await expect(
      readCommuteTable(chunks('a,b\n"bad,2'), ",", ["a", "b"], () => {}),
    ).rejects.toThrow("unterminated");
    await expect(
      readCommuteTable(chunks("a\n1\n2"), ",", ["a"], () => {}, { rows: 1 }),
    ).rejects.toThrow("row count");
    await expect(
      readCommuteTable(chunks("a\n123456"), ",", ["a"], () => {}, { bytes: 4 }),
    ).rejects.toThrow("byte limit");
    async function* invalid() {
      yield new Uint8Array([97, 10, 255]);
    }
    await expect(
      readCommuteTable(invalid(), ",", ["a"], () => {}),
    ).rejects.toThrow();
    const records: unknown[] = [];
    await readCommuteTable(
      chunks('a,b\n1,"quoted, field"\n2,"a""b"'),
      ",",
      ["a", "b"],
      (r) => records.push(r),
    );
    expect(records).toEqual([
      { a: "1", b: "quoted, field" },
      { a: "2", b: 'a"b' },
    ]);
  });
  it("retains only selected ACS rows while validating unselected tract evidence and duplicate identities", async () => {
    const header = `GEO_ID|${COMMUTE_ACS_COLUMNS.join("|")}\n`;
    const row = (id: string, total = "0") =>
      `1400000US${id}|${COMMUTE_ACS_COLUMNS.map((c) => (c === "B08132_E016" ? total : "0")).join("|")}\n`;
    const selected = new Set(["04013000100"]);
    const result = await readCommuteAcs(
      chunks(header + row("04013000100") + row("04013000200")),
      selected,
    );
    expect(result.nativeTractRows).toBe(2);
    expect([...result.tracts.keys()]).toEqual(["04013000100"]);
    await expect(
      readCommuteAcs(
        chunks(header + row("04013000100") + row("04013000200", "1")),
        selected,
      ),
    ).rejects.toThrow("reconcile");
    await expect(
      readCommuteAcs(
        chunks(
          header + row("04013000100") + row("04013000200") + row("04013000200"),
        ),
        selected,
      ),
    ).rejects.toThrow("Duplicate");
  });
  it("resolves current tract from official relationships and retains cross-tract ambiguity", () => {
    const base = {
      stateFips: "04",
      targetGeographyVintage: 2024,
      blockGeographyVintage: 2020,
      sourceRelease: "TIGER2024",
      geographyMatch: { status: "verified" },
      completeness: { stateBlockRows: 3 },
      blocks: [
        {
          id: "040130001001001",
          unitGeoid: "040130002001",
          position: [-112, 33],
        },
      ],
      unallocatedBlocks: [
        {
          id: "040130001001002",
          candidateUnitGeoids: ["040130003001", "040130003002"],
          position: [-112, 33],
        },
        {
          id: "040130001001003",
          candidateUnitGeoids: ["040130004001", "040130005001"],
          position: [-112, 33],
        },
      ],
    } as unknown as PreparedWorkforceBlocks;
    const joins = commuteTractRelationships(base);
    expect(joins.resolved.get("040130001001001")!.tract).toBe("04013000200");
    expect(joins.resolved.get("040130001001002")!.tract).toBe("04013000300");
    expect(joins.ambiguous.get("040130001001003")!.tracts).toEqual([
      "04013000400",
      "04013000500",
    ]);
    expect(() => commuteTractRelationships({ ...base, blocks: [] })).toThrow(
      "complete",
    );
  });
  it("verifies receipt URL and raw hash, refusing missing receipts, symlinks and modified originals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commute-source-"));
    try {
      const path = join(dir, "source.csv"),
        text = "a\n1\n",
        url = "https://example.test/source.csv";
      await writeFile(path, text);
      await expect(
        verifyCommuteSource(dir, "source.csv", url),
      ).rejects.toThrow();
      await writeFile(
        `${path}.receipt.json`,
        JSON.stringify({
          url,
          bytes: Buffer.byteLength(text),
          sha256: hash(text),
          retrievedAt: "2026-11-06T00:00:00Z",
        }),
      );
      await expect(
        verifyCommuteSource(dir, "source.csv", url),
      ).resolves.toHaveProperty("receipt.sha256", hash(text));
      await expect(
        verifyCommuteSource(dir, "source.csv", url + "wrong"),
      ).rejects.toThrow("receipt");
      await symlink(path, join(dir, "link.csv"));
      await expect(verifyCommuteSource(dir, "link.csv", url)).rejects.toThrow(
        "regular file",
      );
      await writeFile(path, "a\n2\n");
      await expect(verifyCommuteSource(dir, "source.csv", url)).rejects.toThrow(
        "hash mismatch",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
