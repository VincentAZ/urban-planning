import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fiscalReportFixture } from "./src/fiscal-report-fixture";
import {
  exportPdf,
  exportDocx,
  exportXlsx,
  exportFiscalCsv,
} from "./src/exports";
import { renderReportMapPair } from "./src/report-maps";
import { calculateImpact } from "@urban/models";
import type { ReportSnapshot } from "./src/exports";

// Isolated deterministic QA: no API, storage adapter, credentials or environment-file reads.
const directory = ".local/qa/fiscal/reports";
await mkdir(directory, { recursive: true });
const snapshot: ReportSnapshot = process.argv.includes("--reuse-snapshot")
  ? JSON.parse(await readFile(`${directory}/snapshot.json`, "utf8"))
  : fiscalReportFixture();
snapshot.results = calculateImpact(
  snapshot.place,
  snapshot.scenario,
  {},
  { fiscalStudy: snapshot.project.fiscalStudy },
);
snapshot.maps = await renderReportMapPair({
  place: snapshot.place,
  baselineScenario: snapshot.project.scenarios[0],
  proposalScenario: snapshot.scenario,
});
const files = [
  ["fiscal-review.pdf", await exportPdf(snapshot)],
  ["fiscal-review.docx", await exportDocx(snapshot)],
  ["fiscal-review.xlsx", await exportXlsx(snapshot)],
  ["fiscal-cash-flows.csv", Buffer.from(exportFiscalCsv(snapshot))],
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
const evidence = [];
for (const [name, data] of files) {
  await writeFile(`${directory}/${name}`, data);
  evidence.push({
    name,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(
  `${directory}/artifacts.json`,
  JSON.stringify(
    {
      fixture: "authored-arithmetic-verification",
      scenarioId: snapshot.scenario.id,
      revision: snapshot.scenario.revision,
      profileHash: snapshot.project.fiscalStudy!.profileHash,
      inputHash: snapshot.results.fiscal!.inputHash,
      files: evidence,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ directory, files: evidence }));
