import { mkdir, writeFile } from "node:fs/promises";
import { PlaceCatalog } from "../src/places.js";
import { createProject, buildingPreset, calculateImpact } from "@urban/models";
import { applyCommand } from "@urban/core";
import { exportPdf, exportDocx, type ReportSnapshot } from "../src/exports.js";
import { renderReportMapPair } from "../src/report-maps.js";

const directory = ".local/report-qa-v2";
await mkdir(directory, { recursive: true });
const place = await new PlaceCatalog().get("phoenix");
const project = createProject(place);
project.name = "Roosevelt Row Development Comparison";
let scenario = project.scenarios.find(
  (item) => item.id === project.activeScenarioId,
)!;
scenario = applyCommand(scenario, {
  type: "building.upsert",
  building: buildingPreset("mixed-use", place.center),
});
scenario.name = "Mixed use redevelopment";
scenario.description =
  "Illustrative product QA proposal. Compare a mixed use building against the unchanged source geometry. This report records planning estimates and the assumptions required for a local review. It is not an adopted development proposal.";
scenario.assumptions.parkingPerUnit = 0.85;
scenario.assumptions.driveShare = 0.7;
scenario.assumptions.walkShare = 0.18;
project.scenarios = project.scenarios.map((item) =>
  item.id === scenario.id ? scenario : item,
);
const generatedAt = new Date().toISOString();
const normal: ReportSnapshot = {
  project,
  place,
  scenario,
  results: calculateImpact(place, scenario),
  generatedAt,
  projectVersion: 3,
};
const stress = structuredClone(normal);
stress.project.name =
  "Long title QA for the Roosevelt Row shared planning study with neighborhood partners and accessibility review "
    .repeat(3)
    .slice(0, 240);
stress.scenario.name =
  "Long proposal label with multiple policy considerations "
    .repeat(3)
    .slice(0, 120);
stress.scenario.description =
  "LONG DESCRIPTION QA. This deliberately lengthy paragraph tests readable wrapping, pagination, and retention of every user-entered sentence. The report must preserve the entire proposal note rather than clipping its final lines.\n\n"
    .repeat(60)
    .slice(0, 9980) + " END DESCRIPTION QA.";
stress.scenario.sources = [
  {
    id: "qa-long-source",
    name: "Synthetic QA source title for pagination and full provenance retention "
      .repeat(4)
      .slice(0, 240),
    url: `https://example.invalid/qa-source/${"very-long-path-".repeat(110)}?purpose=layout-validation`,
    vintage: "Synthetic QA only",
    kind: "user-supplied",
    license: "Synthetic layout fixture only; no claims of observed evidence.",
    description:
      "Long source description QA. Retain complete licensing and coverage notes across automatic page breaks. ".repeat(
        18,
      ) + "END SOURCE QA.",
  },
];
stress.project.scenarios = stress.project.scenarios.map((item) =>
  item.id === stress.scenario.id ? stress.scenario : item,
);
stress.results = calculateImpact(stress.place, stress.scenario);
for (const [name, snapshot] of [
  ["sample", normal],
  ["stress", stress],
] as const) {
  snapshot.maps = await renderReportMapPair({
    place: snapshot.place,
    baselineScenario: snapshot.project.scenarios.find(
      (item) => item.id === "baseline",
    )!,
    proposalScenario: snapshot.scenario,
  });
  await writeFile(`${directory}/${name}.pdf`, await exportPdf(snapshot));
  await writeFile(`${directory}/${name}.docx`, await exportDocx(snapshot));
  await writeFile(
    `${directory}/${name}-baseline.png`,
    snapshot.maps.baseline.png,
  );
  await writeFile(
    `${directory}/${name}-proposal.png`,
    snapshot.maps.proposal.png,
  );
  await writeFile(
    `${directory}/${name}-provenance.json`,
    JSON.stringify(
      {
        projectName: snapshot.project.name,
        scenarioName: snapshot.scenario.name,
        scenarioRevision: snapshot.scenario.revision,
        projectVersion: snapshot.projectVersion,
        descriptionCharacters: snapshot.scenario.description.length,
        metricCount: snapshot.results.metrics.length,
        baselineImageHash: snapshot.maps.baseline.sha256,
        proposalImageHash: snapshot.maps.proposal.sha256,
        metadata: snapshot.maps.metadata,
      },
      null,
      2,
    ),
  );
}
process.stdout.write(
  `Created normal and stress PDF/DOCX QA reports in ${directory}\n`,
);
