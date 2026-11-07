import { mkdir, writeFile } from "node:fs/promises";
import { engagementReportFixture } from "./engagement-report-fixture";
import {
  exportEngagementCsv,
  renderEngagementPdf,
} from "./src/engagement-report";

const directory = ".local/engagement-report-qa";
await mkdir(directory, { recursive: true });
for (const [name, stress] of [
  ["sample", false],
  ["stress", true],
] as const) {
  const report = engagementReportFixture(stress);
  await writeFile(
    `${directory}/${name}.pdf`,
    await renderEngagementPdf(report),
  );
  await writeFile(`${directory}/${name}.csv`, exportEngagementCsv(report));
  await writeFile(`${directory}/${name}.json`, JSON.stringify(report, null, 2));
}
console.log(
  `Created synthetic normal and long-text engagement reports in ${directory}`,
);
