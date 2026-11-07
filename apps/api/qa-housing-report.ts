import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { housingReportFixture } from "./src/housing-report-fixture";
import {
  exportPdf,
  exportDocx,
  exportXlsx,
  exportHousingCsv,
} from "./src/exports";
import { renderReportMapPair } from "./src/report-maps";
// Isolated authored fixture: no API, storage adapter, credentials or .env reads.
const directory = ".local/qa/housing/reports";
await mkdir(directory, { recursive: true });
const snapshot = process.argv.includes("--reuse-snapshot")
  ? (JSON.parse(
      await readFile(`${directory}/snapshot.json`, "utf8"),
    ) as ReturnType<typeof housingReportFixture>)
  : housingReportFixture();
snapshot.maps = await renderReportMapPair({
  place: snapshot.place,
  baselineScenario: snapshot.project.scenarios[0],
  proposalScenario: snapshot.scenario,
});
const outputs = [
  ["housing-review.pdf", await exportPdf(snapshot)],
  ["housing-review.docx", await exportDocx(snapshot)],
  ["housing-review.xlsx", await exportXlsx(snapshot)],
  ["housing-affordability.csv", Buffer.from(exportHousingCsv(snapshot))],
  [
    "snapshot.json",
    Buffer.from(
      JSON.stringify(
        snapshot,
        (key, value) => (key === "maps" ? undefined : value),
        2,
      ),
    ),
  ],
] as const;
const files = [];
for (const [name, data] of outputs) {
  await writeFile(`${directory}/${name}`, data);
  files.push({
    name,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(
  `${directory}/artifacts.json`,
  JSON.stringify(
    {
      fixture: "synthetic arithmetic, not official HUD limits",
      inputHash: snapshot.results.affordability!.inputHash,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ directory, files }));
