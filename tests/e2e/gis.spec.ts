import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildingGeometry,
  materializeBuildings,
  materializeParcels,
  parcelAreaSqm,
  type ProjectSnapshot,
  type Position,
  type StudyAreaGeometry,
} from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

// These native happy paths use the real isolated HTTP API, queue, archive,
// pinned offline GDAL image, mapper and reversible commit. Only the study area
// and uploaded fixture geometry are synthetic. No application state is injected.
const workbench = (page: Page) =>
  page.getByRole("dialog", {
    name: "Bring your local knowledge.",
    exact: true,
  });
const active = (snapshot: ProjectSnapshot) =>
  snapshot.project.scenarios.find(
    (scenario) => scenario.id === snapshot.project.activeScenarioId,
  )!;
const rectangle = (
  west: number,
  south: number,
  east: number,
  north: number,
): Position[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];
const geometry: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      rectangle(-112.077, 33.451, -112.0755, 33.4522),
      rectangle(-112.0767, 33.4513, -112.0762, 33.4517),
    ],
    [rectangle(-112.0748, 33.451, -112.0742, 33.4516)],
  ],
};
const featureCollection = (
  name = "Survey Courtyard",
  extra: Record<string, unknown> = {},
) => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "survey-001",
      properties: { name, ref: "survey-001", ...extra },
      geometry,
    },
  ],
});
const uploaded = (snapshot: ProjectSnapshot, name = "Survey Courtyard") =>
  materializeBuildings(snapshot.place, active(snapshot)).find(
    (building) => building.name === name,
  )!;
function monitor(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (
      entry.type() === "error" &&
      /same key|unique.*key|maximum update depth/i.test(entry.text())
    )
      errors.push(entry.text());
  });
  return errors;
}
async function settled(page: Page) {
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
}
async function open(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await settled(page);
}
async function register(page: Page) {
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your name", exact: true })
    .fill("QA GIS Planner");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("gis-planner@urban-planning.test");
  await page.getByLabel(/^Password/).fill("Isolated-GIS-browser-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText("QA GIS Planner");
  await page.getByRole("button", { name: "Open project home" }).click();
  await page
    .getByRole("button", {
      name: "Save current project to account",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Project saved to your private workspace.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}
async function snapshot(page: Page): Promise<ProjectSnapshot> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Complete project · JSON/ })
    .click();
  const path = await (await pending).path();
  if (!path) throw new Error("Complete project download was not retained.");
  const value = JSON.parse(await readFile(path, "utf8")) as ProjectSnapshot;
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  return value;
}
async function chooseFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  layer = "buildings",
) {
  await page.getByRole("button", { name: "Import data", exact: true }).click();
  const dialog = workbench(page);
  await dialog.getByLabel("Layer type", { exact: true }).selectOption(layer);
  await dialog
    .getByLabel("Geographic file", { exact: true })
    .setInputFiles(file);
  await dialog
    .getByRole("button", { name: "Save and inspect file", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Put this layer in the right place.",
      exact: true,
    }),
  ).toBeVisible();
  return dialog;
}
const chooseGeoJson = (
  page: Page,
  value = featureCollection(),
  layer = "buildings",
) =>
  chooseFile(
    page,
    {
      name: "survey.geojson",
      mimeType: "application/geo+json",
      buffer: Buffer.from(JSON.stringify(value)),
    },
    layer,
  );
async function next(dialog: Locator) {
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
}
async function sourceReview(dialog: Locator, name = "Synthetic QA survey") {
  await dialog.getByLabel("Source name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Source URL", { exact: true })
    .fill("https://example.com/qa-survey");
  await dialog
    .getByLabel("Dataset vintage", { exact: true })
    .fill("2026-11-06");
  await dialog
    .getByLabel("License and permission statement", { exact: true })
    .fill(
      "Synthetic QA geometry; permission for private testing and public test snapshots.",
    );
  await dialog
    .getByRole("checkbox", { name: /^I am authorized to privately/ })
    .check();
  await dialog
    .getByRole("checkbox", {
      name: /^This source permits public redistribution/,
    })
    .check();
}
async function prepare(dialog: Locator) {
  await dialog
    .getByRole("button", { name: "Prepare exact preview", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "A clear look before you apply.",
      exact: true,
    }),
  ).toBeVisible();
}
async function commit(page: Page, count = 1, layer = "footprints") {
  const dialog = workbench(page),
    apply = dialog.getByRole("button", {
      name: `Apply ${count} ${count === 1 ? layer.replace(/s$/, "") : layer}`,
      exact: true,
    });
  await expect(apply).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: /^I reviewed the exact geometry/ })
    .check();
  await apply.click();
  await expect(dialog).toHaveCount(0);
  await settled(page);
}
async function defaultMapping(dialog: Locator) {
  await next(dialog);
  await dialog
    .getByLabel("Reviewed building use", { exact: true })
    .selectOption("office");
  await next(dialog);
  await sourceReview(dialog);
}
async function importUnknown(page: Page) {
  const dialog = await chooseGeoJson(page);
  await defaultMapping(dialog);
  await prepare(dialog);
  await commit(page);
}
async function inspectBuilding(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Open feature list", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search places or buildings" })
    .fill(name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  const inspector = page.getByLabel("Building inspector", { exact: true });
  await expect(
    inspector.getByRole("heading", { name, exact: true }),
  ).toBeVisible();
  return inspector;
}
async function discardReview(page: Page) {
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Leave this import review?",
  });
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "Discard local choices", exact: true })
    .click();
  await expect(workbench(page)).toHaveCount(0);
}

test("native GeoJSON unknowns and source-matched updates preserve baseline, provenance and reversible history", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(baseURL!, {
      gisNativeFixture: true,
    }),
    errors = monitor(page);
  try {
    await api.connect(page);
    await open(page);
    await register(page);
    const before = await snapshot(page);
    const dialog = await chooseGeoJson(page);
    await next(dialog);
    await dialog
      .getByLabel("Reviewed building use", { exact: true })
      .selectOption("office");
    await dialog
      .getByLabel("Direct jobs input", { exact: true })
      .selectOption("constant");
    await dialog
      .getByLabel("Direct jobs assumption", { exact: true })
      .fill("0");
    await next(dialog);
    await sourceReview(dialog);
    await prepare(dialog);
    await expect(
      dialog.getByRole("region", { name: "Prepared feature table" }),
    ).toContainText("Unknown");
    await expect(
      dialog.getByRole("cell", { name: "survey-001", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Fit imported layer", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: info.outputPath("gis-native-geojson-preview-desktop.png"),
      fullPage: false,
    });
    await commit(page);
    const first = await snapshot(page),
      building = uploaded(first),
      sourceId = building.sourceId;
    expect(first.project.schemaVersion).toBe(8);
    expect(first.place).toEqual(before.place);
    expect(first.baselineIdentity).toEqual(before.baselineIdentity);
    expect(buildingGeometry(building)).toEqual(geometry);
    expect(building).toMatchObject({
      height: null,
      floors: null,
      units: null,
      jobs: 0,
      parkingSpaces: null,
      sourceFeatureId: "survey-001",
      attributeProvenance: {
        fields: { height: { status: "missing" }, jobs: { status: "assumed" } },
      },
    });
    expect(
      active(first).sources?.find((source) => source.id === sourceId)?.import
        ?.upload.sha256,
    ).toBe(
      createHash("sha256")
        .update(JSON.stringify(featureCollection()))
        .digest("hex"),
    );
    const inspector = await inspectBuilding(page, "Survey Courtyard");
    await expect(inspector).toContainText(
      "Height unknown; footprint shown without massing",
    );
    await page.screenshot({
      path: info.outputPath("gis-unknown-building-inspector.png"),
      fullPage: false,
    });
    const second = await chooseGeoJson(
      page,
      featureCollection("Updated Survey Courtyard", {
        heightFt: "10",
        observedJobs: "0",
      }),
    );
    await next(second);
    await second
      .getByRole("radio", { name: /^Update matched features/ })
      .check();
    await second
      .getByLabel("Match existing features by", { exact: true })
      .selectOption("sourceFeatureId");
    await second
      .getByLabel("Matching source field", { exact: true })
      .selectOption("ref");
    await second
      .getByLabel("Existing source namespace", { exact: true })
      .selectOption(sourceId);
    await second
      .getByLabel("Original source reference field", { exact: true })
      .selectOption("ref");
    await second
      .getByLabel("Reviewed building use", { exact: true })
      .selectOption("office");
    await second
      .getByLabel("Height input", { exact: true })
      .selectOption("field");
    await second
      .getByLabel("Height source field", { exact: true })
      .selectOption("heightFt");
    await second
      .getByLabel("Height source units", { exact: true })
      .selectOption("feet");
    await second
      .getByLabel("Direct jobs input", { exact: true })
      .selectOption("field");
    await second
      .getByLabel("Direct jobs source field", { exact: true })
      .selectOption("observedJobs");
    await next(second);
    await sourceReview(second, "Updated synthetic QA survey");
    await prepare(second);
    await expect(second.locator(".import-stats")).toContainText(
      "matched updates",
    );
    await commit(page);
    const updated = await snapshot(page),
      matched = uploaded(updated, "Updated Survey Courtyard");
    expect(matched.id).toBe(building.id);
    expect(matched.height).toBeCloseTo(3.048, 10);
    expect(matched.jobs).toBe(0);
    expect(matched.attributeProvenance?.fields.height).toMatchObject({
      status: "supplied",
      sourceUnit: "feet",
      rawValue: "10",
    });
    expect(materializeBuildings(updated.place, active(updated))).toHaveLength(
      before.place.buildings.length + 1,
    );
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    expect(uploaded(await snapshot(page)).height).toBeNull();
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await settled(page);
    const restored = await snapshot(page);
    expect(uploaded(restored, "Updated Survey Courtyard").height).toBeCloseTo(
      3.048,
      10,
    );
    expect(restored.place).toEqual(before.place);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("native shapefile export retains exact sidecars and round-trips multipart boundaries through layer selection", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(baseURL!, {
      gisNativeFixture: true,
    }),
    errors = monitor(page);
  try {
    await api.connect(page);
    await open(page);
    await register(page);
    await importUnknown(page);
    const before = await snapshot(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const exportDialog = page.getByRole("dialog", {
      name: "Take the story with you.",
      exact: true,
    });
    await exportDialog
      .locator("summary")
      .filter({ hasText: "Scenario geometry · Shapefile ZIP" })
      .click();
    await exportDialog
      .getByRole("button", { name: "Prepare shapefile ZIP", exact: true })
      .click();
    const downloadButton = exportDialog.getByRole("button", {
      name: "Download shapefile ZIP",
      exact: true,
    });
    await expect(downloadButton).toBeEnabled();
    await expect(exportDialog.locator(".import-job")).toContainText(
      `Captured revision ${active(before).revision}`,
    );
    await page.screenshot({
      path: info.outputPath("gis-shapefile-export-desktop.png"),
      fullPage: false,
    });
    const pending = page.waitForEvent("download");
    await downloadButton.click();
    const downloaded = await pending,
      zipPath = await downloaded.path();
    if (!zipPath) throw new Error("Native shapefile ZIP was not downloaded.");
    const zip = await readFile(zipPath);
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    const evidence = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'manifest':json.loads(z.read('manifest.json')),'buildings':json.loads(z.read('buildings.exact.geojson')),'files':z.namelist()}))",
          zipPath,
        ],
        { encoding: "utf8" },
      ),
    );
    expect(evidence.files).toEqual(
      expect.arrayContaining([
        "buildings.shp",
        "buildings.shx",
        "buildings.dbf",
        "buildings.prj",
        "buildings.cpg",
        "manifest.json",
      ]),
    );
    expect(evidence.manifest.scenarioRevision).toBe(active(before).revision);
    const exact = evidence.buildings.features.find(
      (feature: { id: string }) => feature.id === uploaded(before).id,
    );
    expect(exact.geometry).toEqual(geometry);
    expect(exact.properties).toMatchObject({
      height: null,
      floors: null,
      units: null,
      jobs: null,
      parkingSpaces: null,
    });
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    const dialog = await chooseFile(
      page,
      {
        name: "native-roundtrip.zip",
        mimeType: "application/zip",
        buffer: zip,
      },
      "parcels",
    );
    await dialog
      .getByLabel("Source layer", { exact: true })
      .selectOption("buildings.shp");
    await dialog
      .getByRole("checkbox", { name: /^I reviewed the .*excluded entities/ })
      .check();
    await next(dialog);
    await dialog
      .getByLabel("Feature names", { exact: true })
      .selectOption("field");
    await dialog
      .getByLabel("Name source field", { exact: true })
      .selectOption("NAME");
    await dialog
      .getByLabel("Original source reference field", { exact: true })
      .selectOption("SRC_REF");
    await next(dialog);
    await sourceReview(dialog, "Native shapefile round-trip QA");
    await prepare(dialog);
    const count = materializeBuildings(before.place, active(before)).length;
    await commit(page, count, "parcels");
    const after = await snapshot(page),
      parcels = materializeParcels(after.place, active(after));
    expect(parcels).toHaveLength(count);
    const roundtrip = parcels.find(
      (parcel) => parcel.name === "Survey Courtyard",
    )!;
    expect(roundtrip.geometry.type).toBe("MultiPolygon");
    if (roundtrip.geometry.type !== "MultiPolygon")
      throw new Error("Multipart geometry was flattened.");
    expect(
      roundtrip.geometry.coordinates.map((part) => part.length).sort(),
    ).toEqual([1, 2]);
    expect(parcelAreaSqm(roundtrip)).toBeCloseTo(parcelAreaSqm(geometry), 5);
    expect(after.place).toEqual(before.place);
    expect(after.baselineIdentity).toEqual(before.baselineIdentity);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

const dxf = [
  "0",
  "SECTION",
  "2",
  "HEADER",
  "9",
  "$ACADVER",
  "1",
  "AC1024",
  "9",
  "$INSUNITS",
  "70",
  "6",
  "0",
  "ENDSEC",
  "0",
  "SECTION",
  "2",
  "ENTITIES",
  "0",
  "LWPOLYLINE",
  "5",
  "A1",
  "100",
  "AcDbEntity",
  "8",
  "Footprints",
  "100",
  "AcDbPolyline",
  "90",
  "4",
  "70",
  "1",
  "10",
  "0",
  "20",
  "0",
  "10",
  "20",
  "20",
  "0",
  "10",
  "20",
  "20",
  "20",
  "10",
  "0",
  "20",
  "20",
  "0",
  "POINT",
  "5",
  "B1",
  "100",
  "AcDbEntity",
  "8",
  "Notes",
  "100",
  "AcDbPoint",
  "10",
  "5",
  "20",
  "5",
  "30",
  "0",
  "0",
  "ENDSEC",
  "0",
  "EOF",
  "",
].join("\n");
test("native DXF control-point placement is explicit, keyboard accessible and usable at 390px", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(baseURL!, {
      gisNativeFixture: true,
    }),
    errors = monitor(page);
  try {
    await api.connect(page);
    await open(page);
    await register(page);
    const before = await snapshot(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await chooseFile(page, {
      name: "local-plan.dxf",
      mimeType: "application/dxf",
      buffer: Buffer.from(dxf),
    });
    await dialog
      .getByLabel("Source layer", { exact: true })
      .selectOption("Footprints");
    await dialog
      .getByLabel("Coordinate reference", { exact: true })
      .selectOption("local");
    await dialog
      .getByLabel("Drawing units", { exact: true })
      .selectOption("meters");
    const controls = [
      ["0", "0", "-112.076", "33.452"],
      ["20", "0", "-112.0757846", "33.452"],
    ];
    for (let i = 0; i < controls.length; i++)
      for (const [j, name] of [
        "Source X",
        "Source Y",
        "Longitude",
        "Latitude",
      ].entries())
        await dialog
          .getByLabel(`Control ${i + 1} ${name}`, { exact: true })
          .fill(controls[i][j]);
    await expect(
      dialog.getByRole("checkbox", {
        name: /^I reviewed the 1 excluded entities/,
      }),
    ).toBeVisible();
    await dialog
      .getByRole("checkbox", { name: /^I reviewed the 1 excluded entities/ })
      .check();
    const flatten = dialog.getByRole("checkbox", {
      name: /^Flatten Z coordinates/,
    });
    if (await flatten.count()) await flatten.check();
    await expect(dialog).toContainText(
      "They do not independently prove accuracy",
    );
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("gis-dxf-controls-mobile.png"),
      fullPage: false,
    });
    const continueButton = dialog.getByRole("button", {
      name: "Continue",
      exact: true,
    });
    await continueButton.focus();
    await continueButton.press("Enter");
    await dialog
      .getByLabel("Reviewed building use", { exact: true })
      .selectOption("office");
    await next(dialog);
    await sourceReview(dialog, "Synthetic local CAD plan");
    await prepare(dialog);
    await expect(dialog).toContainText("1");
    const details = dialog.locator("details").filter({
      has: page.locator("summary", {
        hasText: "Exact source and conversion record",
      }),
    });
    await details.locator("summary").click();
    await expect(details).toContainText("No independent check points supplied");
    const fit = dialog.getByRole("button", {
      name: "Fit imported layer",
      exact: true,
    });
    await expect(fit).toBeEnabled();
    await fit.focus();
    await fit.press("Enter");
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("gis-dxf-preview-mobile.png"),
      fullPage: false,
    });
    await commit(page);
    const after = await snapshot(page),
      added = materializeBuildings(after.place, active(after)).find(
        (building) =>
          !before.place.buildings.some((old) => old.id === building.id),
      )!;
    expect(added.height).toBeNull();
    expect(added.sourceFeatureId).toBe("A1");
    const source = active(after).sources?.find(
      (entry) => entry.id === added.sourceId,
    )!;
    expect(source.import?.format).toBe("dxf");
    expect(source.import?.recipe).toMatchObject({
      conversion: {
        dxf: {
          units: "meters",
          localTransform: {
            controls: [
              { source: [0, 0], target: [-112.076, 33.452] },
              { source: [20, 0], target: [-112.0757846, 33.452] },
            ],
          },
        },
      },
    });
    expect(
      source.import?.exclusions.reduce((count, item) => count + item.count, 0),
    ).toBe(1);
    expect(after.place).toEqual(before.place);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("real GIS jobs recover a lost upload reply and a late commit cannot replace a newer local draft", async ({
  page,
  baseURL,
}) => {
  // Only the converter is synthetic here; delivery is withheld after actual
  // HTTP commits, with the real queue, mapper, auth and persistence unchanged.
  const api = await createCollaborationApi(baseURL!, { gisFixture: true });
  let release: (() => void) | undefined;
  try {
    await api.connect(page);
    await open(page);
    await register(page);
    const before = await snapshot(page);
    api.loseNextResponse(
      `/api/v1/projects/${before.project.id}/imports/uploads`,
    );
    await page
      .getByRole("button", { name: "Import data", exact: true })
      .click();
    const dialog = workbench(page);
    await dialog.getByLabel("Geographic file", { exact: true }).setInputFiles({
      name: "lost-reply.geojson",
      mimeType: "application/geo+json",
      buffer: Buffer.from(JSON.stringify(featureCollection())),
    });
    await dialog
      .getByRole("button", { name: "Save and inspect file", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog
      .getByRole("button", { name: "Save and inspect file", exact: true })
      .click();
    await expect(
      dialog.getByRole("heading", {
        name: "Put this layer in the right place.",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await api.persistedState()).gisJobs.filter(
        (job) => job.kind === "inspect",
      ),
    ).toHaveLength(1);
    await defaultMapping(dialog);
    await prepare(dialog);
    const state = await api.persistedState(),
      prepared = state.gisJobs.find((job) => job.kind === "prepare")!;
    const hold = api.holdNextResponse(
      `/api/v1/projects/${before.project.id}/imports/${prepared.result!.importId}/commit`,
    );
    release = hold.release;
    await dialog
      .getByRole("checkbox", { name: /^I reviewed the exact geometry/ })
      .check();
    await dialog
      .getByRole("button", { name: "Apply 1 footprint", exact: true })
      .click();
    await hold.committed;
    await discardReview(page);
    const inspector = await inspectBuilding(page, "QA apartments");
    await inspector
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    await page
      .getByLabel("Building name", { exact: true })
      .fill("Retained local building edit");
    await page
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    release();
    release = undefined;
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    const local = await snapshot(page);
    expect(
      materializeBuildings(local.place, active(local)).some(
        (building) => building.name === "Retained local building edit",
      ),
    ).toBe(true);
    expect(
      materializeBuildings(local.place, active(local)).some(
        (building) => building.name === "Survey Courtyard",
      ),
    ).toBe(false);
    const server = (await api.persistedState()).projects[0];
    expect(
      materializeBuildings(
        server.baseline,
        server.project.scenarios.find(
          (scenario) => scenario.id === server.project.activeScenarioId,
        )!,
      ).some((building) => building.name === "Survey Courtyard"),
    ).toBe(true);
    expect(local.place).toEqual(before.place);
  } finally {
    release?.();
    await api.close();
  }
});
