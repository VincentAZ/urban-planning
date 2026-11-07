import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  parseHousingWorkbook,
  deriveHousingPacks,
  prepareHousingCatalog,
  loadPreparedHousingCatalog,
  HUD_WORKBOOK_URL,
  HUD_AREA_URL,
  HUD_METHOD_URL,
  HUD_TABLE_PDF_URL,
} from "./housing";
const headers = [
  "fips",
  "stusps",
  "state",
  "state_name",
  "hud_area_code",
  "hud_area_name",
  "county",
  "County_Name",
  "county_town_name",
  "metro",
  "median2026",
  ...Array.from({ length: 8 }, (_, i) => `l50_${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `ELI_${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `l80_${i + 1}`),
];
const cells = (fips = "0401399999", area = "SYNTHETIC") => [
  fips,
  "AZ",
  fips.slice(0, 2),
  "Synthetic state",
  area,
  "Synthetic HUD area",
  fips.slice(2, 5),
  "Synthetic county",
  "Synthetic jurisdiction",
  1,
  100000,
  ...Array.from({ length: 8 }, (_, i) => 30000 + i * 1000),
  ...Array.from({ length: 8 }, (_, i) => 20000 + i * 1300),
  ...Array.from({ length: 8 }, (_, i) => 50000 + i * 1000),
];
async function workbook(
  rows: unknown[][],
  mutate?: (w: ExcelJS.Workbook) => void,
) {
  const w = new ExcelJS.Workbook(),
    s = w.addWorksheet("Section8-FY26");
  s.addRow(headers);
  rows.forEach((r) => s.addRow(r));
  w.addWorksheet("Field_Descriptions").addRows([
    ["Field_Name", "Description"],
    ["fips", "Synthetic test geography"],
  ]);
  mutate?.(w);
  return Buffer.from(await w.xlsx.writeBuffer());
}
const files = [
  HUD_WORKBOOK_URL,
  HUD_AREA_URL,
  HUD_METHOD_URL,
  HUD_TABLE_PDF_URL,
].map((url, i) => ({
  url,
  filename: `source${i}`,
  sha256: String(i + 1).repeat(64),
  bytes: 100,
}));
const declaration = {
  declaredBy: "Synthetic operator test",
  preparedAt: "2026-11-06T00:00:00.000Z",
};
describe("bounded published HUD workbook ingestion", () => {
  it("retains every literal cell and exact town/territory rows without regenerating thresholds", async () => {
    const table = await parseHousingWorkbook(
      await workbook([
        cells(),
        cells("0402199999"),
        cells("0919004720", "OTHER"),
        cells("6601099999", "TERRITORY"),
      ]),
    );
    const packs = deriveHousingPacks(table, files, declaration),
      area = packs.find((p) => p.area.id === "SYNTHETIC")!;
    expect(table.rows.map((r) => r.row)).toEqual([2, 3, 4, 5]);
    expect(table.rows[0].cells).toEqual(
      Object.fromEntries(headers.map((key, i) => [key, cells()[i]])),
    );
    expect(area.sourceRows).toHaveLength(2);
    expect(area.area.geographies.map((g) => g.countyFips)).toEqual([
      "04013",
      "04021",
    ]);
    expect(area.limits[1].extremelyLow).toBe(21300);
    expect(
      packs.find((p) => p.area.id === "OTHER")!.area.geographies[0]
        .countySubdivisionFips,
    ).toBe("04720");
    expect(
      packs.find((p) => p.area.id === "TERRITORY")!.area.geographies[0]
        .stateFips,
    ).toBe("66");
  });
  it("refuses inconsistent same-area rows instead of picking a convenient row", async () => {
    const a = cells(),
      b = cells("0402199999");
    b[11] = 99999;
    const table = await parseHousingWorkbook(await workbook([a, b]));
    expect(() => deriveHousingPacks(table, files, declaration)).toThrow(
      /conflicting/,
    );
  });
  it("rejects empty/challenge bytes, formulas, missing headers and duplicate geography rows", async () => {
    await expect(parseHousingWorkbook(Buffer.alloc(0))).rejects.toThrow(
      /nonempty/,
    );
    await expect(
      parseHousingWorkbook(Buffer.from("<html>challenge</html>")),
    ).rejects.toThrow(/nonempty/);
    await expect(
      parseHousingWorkbook(
        await workbook([cells()], (w) => {
          w.getWorksheet(1)!.getCell("L2").value = {
            formula: "1+2",
            result: 3,
          };
        }),
      ),
    ).rejects.toThrow(/literal/);
    await expect(
      parseHousingWorkbook(
        await workbook([cells()], (w) => {
          w.getWorksheet(1)!.getCell("A1").value = "new-code";
        }),
      ),
    ).rejects.toThrow(/column schema/);
    await expect(
      parseHousingWorkbook(await workbook([cells(), cells()])),
    ).rejects.toThrow(/duplicated/);
  });
  it("replays retained raw rows and receipts, rejects changed packs, and confines every dependency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "housing-loader-")),
      source = join(directory, "source"),
      output = join(directory, "catalog");
    try {
      await mkdir(source);
      const originals = [
        {
          filename: "Section8-FY26.xlsx",
          url: HUD_WORKBOOK_URL,
          body: await workbook([cells()]),
        },
        {
          filename: "area-definitions-FY26.pdf",
          url: HUD_AREA_URL,
          body: Buffer.from("%PDF-1.4 synthetic area"),
        },
        {
          filename: "IncomeLimitsMethodology-FY26.pdf",
          url: HUD_METHOD_URL,
          body: Buffer.from("%PDF-1.4 synthetic method"),
        },
        {
          filename: "Section8-IncomeLimits-FY26.pdf",
          url: HUD_TABLE_PDF_URL,
          body: Buffer.from("%PDF-1.4 synthetic table"),
        },
      ];
      for (const f of originals)
        await writeFile(join(source, f.filename), f.body);
      const receipts = originals.map((f) => ({
        url: f.url,
        downloaded: true,
        bytes: f.body.length,
        sha256: createHash("sha256").update(f.body).digest("hex"),
      }));
      await writeFile(
        join(source, "receipts.json"),
        JSON.stringify(receipts.slice(0, 1)),
      );
      await writeFile(
        join(source, "pdf-navigation-receipts.json"),
        JSON.stringify(receipts.slice(1)),
      );
      const prepared = await prepareHousingCatalog({
        sourceDirectory: source,
        outputDirectory: output,
        ...declaration,
      });
      const entries = await loadPreparedHousingCatalog(output);
      expect(entries).toHaveLength(1);
      expect(entries[0].sourceManifestHash).toBe(prepared.sourceManifestHash);
      expect(entries[0].pack.sourceRows[0].row).toBe(2);
      const packPath = join(output, "packs", entries[0].id + ".json"),
        packBytes = await readFile(packPath);
      const changed = JSON.parse(packBytes.toString());
      changed.limits[0].low += 1;
      await writeFile(packPath, JSON.stringify(changed));
      await expect(loadPreparedHousingCatalog(output)).rejects.toThrow(
        /source row replay/,
      );
      await writeFile(packPath, packBytes);
      for (const path of [
        join(output, "manifest.json"),
        join(output, "raw", "receipts.json"),
        join(output, "national-table.json"),
        packPath,
      ]) {
        const outside = join(directory, "outside.json");
        await rename(path, outside);
        await symlink(outside, path);
        await expect(loadPreparedHousingCatalog(output)).rejects.toThrow(
          /escapes/,
        );
        await rm(path);
        await rename(outside, path);
      }
      const manifestPath = join(output, "manifest.json"),
        manifest = JSON.parse((await readFile(manifestPath)).toString());
      manifest.packs = Array.from({ length: 129 }, (_, i) => ({
        hash: i.toString(16).padStart(64, "0"),
        bytes: 512 * 1024,
      }));
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(loadPreparedHousingCatalog(output)).rejects.toThrow(
        /64 MiB/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
