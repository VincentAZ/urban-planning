import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMUTE_ACS_COLUMNS,
  COMMUTE_ACS_UNIVERSE,
  COMMUTE_DEPARTURE_LABELS,
  COMMUTE_SOURCE_URLS,
  LODES_OD_COLUMNS,
  lodesAreaColumns,
} from "./traffic-commute-sources";
import {
  LODES_CROSSWALK_COLUMNS,
  prepareTrafficCommuteSources,
} from "./traffic-commute";

const hash = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
const directories: string[] = [];
afterEach(async () => {
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
const tract = "04013000100",
  home = `${tract}1001`,
  work = "040130002001001",
  otherHome = "060130001001001";
async function fixture(
  options: { rac?: number; wac?: number; ambiguous?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "commute-prep-"));
  directories.push(dir);
  const put = async (name: string, url: string, bytes: Buffer | string) => {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await writeFile(join(dir, name), buffer);
    await writeFile(
      join(dir, `${name}.receipt.json`),
      JSON.stringify({
        url,
        bytes: buffer.length,
        sha256: hash(buffer),
        retrievedAt: "2026-11-06T00:00:00Z",
      }),
    );
  };
  const raw = new Map<string, string>();
  const area = (kind: "rac" | "wac", id: string, jobs: number) =>
    lodesAreaColumns(kind)
      .map((c, i) =>
        !i
          ? id
          : c === "createdate"
            ? "20251202"
            : c === "C000"
              ? String(jobs)
              : "0",
      )
      .join(",");
  const od = (h: string, jobs: number) =>
    LODES_OD_COLUMNS.map((c) =>
      c === "h_geocode"
        ? h
        : c === "w_geocode"
          ? work
          : c === "createdate"
            ? "20251202"
            : c === "S000"
              ? String(jobs)
              : "0",
    ).join(",");
  raw.set(
    "az_rac_S000_JT01_2023.csv.gz",
    `${lodesAreaColumns("rac").join(",")}\n${area("rac", home, options.rac ?? 10)}\n`,
  );
  raw.set(
    "az_wac_S000_JT01_2023.csv.gz",
    `${lodesAreaColumns("wac").join(",")}\n${area("wac", work, options.wac ?? 8)}\n`,
  );
  raw.set(
    "az_od_main_JT01_2023.csv.gz",
    `${LODES_OD_COLUMNS.join(",")}\n${od(home, 5)}\n`,
  );
  raw.set(
    "az_od_aux_JT01_2023.csv.gz",
    `${LODES_OD_COLUMNS.join(",")}\n${od(otherHome, 3)}\n`,
  );
  raw.set(
    "az_xwalk.csv.gz",
    LODES_CROSSWALK_COLUMNS.join(",") +
      "\n" +
      [home, work]
        .map((id) =>
          LODES_CROSSWALK_COLUMNS.map((c) =>
            c === "tabblk2020"
              ? id
              : c === "trct"
                ? "04013999999"
                : c === "createdate"
                  ? "20261014"
                  : "0",
          ).join(","),
        )
        .join("\n") +
      "\n",
  );
  for (const [name, text] of raw) {
    const url = COMMUTE_SOURCE_URLS[name as keyof typeof COMMUTE_SOURCE_URLS];
    await put(name, url, gzipSync(text));
    await put(
      name.replace(/\.gz$/, ".sha256sum"),
      url.replace(/\.gz$/, ".sha256sum"),
      `${hash(text)}  ${name.replace(/\.gz$/, "")}\n`,
    );
  }
  const values = COMMUTE_ACS_COLUMNS.map((c) =>
    c === "B08132_E016" || c === "B08132_E022"
      ? "100"
      : c.startsWith("B08132_M")
        ? "5"
        : "0",
  );
  await put(
    "acsdt5y2024-b08132.dat",
    COMMUTE_SOURCE_URLS["acsdt5y2024-b08132.dat"],
    `GEO_ID|${COMMUTE_ACS_COLUMNS.join("|")}\n1400000US${tract}|${values.join("|")}\n`,
  );
  await put(
    "version.txt",
    COMMUTE_SOURCE_URLS["version.txt"],
    "Data Vintage:20261014_0725\nRelease Format Version8.5\n",
  );
  const ids = Array.from(
    { length: 15 },
    (_, i) => `B08132_${String(i + 16).padStart(3, "0")}`,
  );
  await put(
    "B08132-2024-metadata.json",
    COMMUTE_SOURCE_URLS["B08132-2024-metadata.json"],
    JSON.stringify({
      variables: Object.fromEntries(
        ids.map((id, index) => [
          `${id}E`,
          {
            label:
              "Car, truck, or van - drove alone:" +
              (index ? `!!${COMMUTE_DEPARTURE_LABELS[index - 1]}` : ""),
          },
        ]),
      ),
    }),
  );
  await put(
    "ACS20245YR_Table_Shells.txt",
    COMMUTE_SOURCE_URLS["ACS20245YR_Table_Shells.txt"],
    ids
      .map((id) => `B08132|1|1|${id}|label|concept|${COMMUTE_ACS_UNIVERSE}|int`)
      .join("\n"),
  );
  const block = (id: string, group: string) => ({
    id,
    unitGeoid: group,
    position: [-112.06, 33.46],
    population2020: 1,
    housingUnits2020: 1,
    blockGroup2020: id.slice(0, 12),
  });
  const blocks = {
    schemaVersion: 1,
    stateFips: "04",
    targetGeographyVintage: 2024,
    blockGeographyVintage: 2020,
    sourceRelease: "TIGER2024",
    geographyMatch: {
      status: "verified",
      method: "census-current-suffixed-block-relationship",
    },
    completeness: { stateBlockRows: 2 },
    blocks: [
      block(work, work.slice(0, 12)),
      ...(options.ambiguous ? [] : [block(home, `${tract}1`)]),
    ],
    unallocatedBlocks: options.ambiguous
      ? [
          {
            ...block(home, `${tract}1`),
            unitGeoid: undefined,
            candidateUnitGeoids: [`${tract}1`, "040130003001"],
          },
        ]
      : [],
    sources: [
      {
        kind: "tabblock20",
        url: "https://example.test/blocks.zip",
        sha256: "1".repeat(64),
        bytes: 10,
        retrievedAt: "2026-11-06T00:00:00Z",
        dbfSha256: "2".repeat(64),
        archiveEntry: "blocks.dbf",
      },
    ],
  };
  const bytes = JSON.stringify(blocks),
    blocksFile = join(dir, "blocks.json");
  await writeFile(blocksFile, bytes);
  return {
    dir,
    put,
    args: {
      sourceDirectory: dir,
      outputDirectory: join(dir, "out"),
      blocksFile,
      blocksSha256: hash(bytes),
      residentTractGeoids: [tract],
    },
  };
}
describe("complete-cohort commute preparation", () => {
  it("scans statewide inputs, retains raw selected evidence and accounts outbound/inbound mass without renormalizing", async () => {
    const f = await fixture(),
      before = await readFile(join(f.dir, "az_od_main_JT01_2023.csv.gz"));
    const result = await prepareTrafficCommuteSources(f.args);
    expect(result.prepared.reconciliation).toMatchObject({
      residentJobs: 10,
      mainJobs: 5,
      unresolvedOutboundJobs: 5,
      auxiliaryJobs: 3,
      workplaceJobs: 8,
      auxiliaryFlowCount: 1,
      workplaceMismatchBlocks: 0,
    });
    expect(result.prepared.residences[0]).toMatchObject({
      jobs: 10,
      sourceRow: 2,
      raw: { C000: "10", createdate: "20251202" },
    });
    expect(result.prepared.flows[0]).toMatchObject({
      jobs: 5,
      sourceRow: 2,
      raw: { S000: "5" },
    });
    expect(
      result.prepared.blocks.find((b) => b.geoid === home)!.tractJoin,
    ).toMatchObject({ status: "verified", tractGeoid: tract });
    expect(result.prepared.lodes).toMatchObject({
      formatVersion: "8.5",
      dataVintage: "20261014_0725",
    });
    const again = await prepareTrafficCommuteSources(f.args);
    expect(again.artifact).toEqual(result.artifact);
    expect(await readFile(join(f.dir, "az_od_main_JT01_2023.csv.gz"))).toEqual(
      before,
    );
  });
  it("rejects negative residence residuals and workplace reconciliation mismatches", async () => {
    await expect(
      prepareTrafficCommuteSources((await fixture({ rac: 4 })).args),
    ).rejects.toThrow("reconciliation failed");
    await expect(
      prepareTrafficCommuteSources((await fixture({ wac: 9 })).args),
    ).rejects.toThrow("reconciliation failed");
  });
  it("retains ambiguous candidate geography and exposes the affected whole-tract denominator", async () => {
    const result = await prepareTrafficCommuteSources(
      (await fixture({ ambiguous: true })).args,
    );
    expect(
      result.prepared.blocks.find((b) => b.geoid === home)!.tractJoin,
    ).toMatchObject({
      status: "unresolved",
      candidateTractGeoids: [tract, "04013000300"],
    });
    const audit = JSON.parse(
      await readFile(result.reconciliation.path, "utf8"),
    );
    expect(audit.selectedTractsWithAmbiguousResidentJobs).toEqual([tract]);
    expect(audit.unresolvedTractBlocks[0].residentJobs).toBe(10);
  });
  it("refuses a self-consistent receipt for an incorrect official decompressed checksum", async () => {
    const f = await fixture();
    const name = "az_od_main_JT01_2023.csv.sha256sum";
    await f.put(
      name,
      COMMUTE_SOURCE_URLS["az_od_main_JT01_2023.csv.gz"].replace(
        /\.gz$/,
        ".sha256sum",
      ),
      `${"0".repeat(64)}  az_od_main_JT01_2023.csv\n`,
    );
    await expect(prepareTrafficCommuteSources(f.args)).rejects.toThrow(
      "Official LODES checksum",
    );
  });
});
