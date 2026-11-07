import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  materializeParcels,
  parcelAreaSqm,
  type ModelResults,
  type Place,
  type Position,
  type Project,
  type Scenario,
  type StudyAreaGeometry,
} from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

// The HTTP fixture provides real authentication, persistence, ACLs, imports and
// publication. Its explicitly synthetic source is never modified by these tests.
interface ProjectDownload {
  project: Project;
  place: Place;
  baselineIdentity: { sha256: string };
  results: ModelResults;
}
interface GisDownload {
  metadata: { sources: Place["sources"] };
  features: {
    id: string;
    geometry: StudyAreaGeometry;
    properties: Record<string, unknown>;
  }[];
}
const draft = (page: Page) =>
  page.locator('[aria-label="Parcel drawing editor"]');
const inspector = (page: Page) =>
  page.locator('[aria-label="Parcel inspector"]');
const list = (page: Page) =>
  page.locator('[aria-label="Parcels and blocks in this scenario"]');
const apply = (page: Page) =>
  draft(page).getByRole("button", { name: "Apply boundaries", exact: true });
const active = (project: Project) =>
  project.scenarios.find((item) => item.id === project.activeScenarioId)!;
const parcels = (data: ProjectDownload) =>
  materializeParcels(data.place, active(data.project));
const baseline = (project: Project) =>
  project.scenarios.find((item) => item.id === "baseline");
const textCoordinates = (points: readonly Position[]) =>
  points.map((p) => p.join(", ")).join("\n");
function rectangle(
  west: number,
  south: number,
  east: number,
  north: number,
): Position[] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}
const outer = rectangle(-112.075, 33.453, -112.071, 33.457);
const hole = rectangle(-112.0746, 33.4535, -112.0738, 33.4543);
const island = rectangle(-112.069, 33.456, -112.067, 33.458);
const donut: StudyAreaGeometry = {
  type: "Polygon",
  coordinates: [outer, hole],
};
const multi: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [[rectangle(-112.0707, 33.4527, -112.0693, 33.4543)], [island]],
};
const geometryHoles = (geometry: StudyAreaGeometry) =>
  (geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates
  ).reduce((sum, rings) => sum + rings.length - 1, 0);
function errorsOn(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /same key|unique.*key|maximum update depth/i.test(message.text())
    )
      errors.push(message.text());
  });
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
  await expect(page.locator(".city-map canvas")).toBeVisible();
  await expect(page.locator(".map-disclosure")).toContainText(
    "Synthetic collaboration QA",
  );
  await settled(page);
}
async function closeDialog(page: Page) {
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const discard = page.getByRole("alertdialog", {
    name: "Leave this import review?",
  });
  if (await discard.count())
    await discard
      .getByRole("button", { name: "Discard local choices", exact: true })
      .click();
}
async function downloadJson<T>(page: Page, name: RegExp): Promise<T> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name }).click();
  const path = await (await pending).path();
  if (!path)
    throw new Error("The requested geometry/project export was not written.");
  const value = JSON.parse(await readFile(path, "utf8")) as T;
  await closeDialog(page);
  return value;
}
const projectDownload = (page: Page) =>
  downloadJson<ProjectDownload>(page, /^Complete project · JSON/);
const gisDownload = (page: Page) =>
  downloadJson<GisDownload>(page, /^Scenario geometry · GeoJSON/);
async function parcelTool(page: Page) {
  await page.getByRole("button", { name: "Parcels", exact: true }).click();
}
async function useCoordinates(page: Page, points: readonly Position[]) {
  const details = draft(page).locator(".parcel-coordinates");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
  await draft(page)
    .getByRole("textbox", { name: "Boundary coordinates" })
    .fill(textCoordinates(points));
  const use = draft(page).getByRole("button", {
    name: "Use these coordinates",
    exact: true,
  });
  await use.focus();
  await use.press("Enter");
}
async function registerAndSave(page: Page) {
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your name" })
    .fill("QA Parcel Planner");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("parcel-planner@urban-planning.test");
  await page.getByLabel(/^Password/).fill("Isolated-parcel-test-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(
    "QA Parcel Planner",
  );
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
  await closeDialog(page);
}
async function sourcePlace(page: Page): Promise<Place> {
  return page.evaluate(async () => {
    const response = await fetch("/data/phoenix.json");
    if (!response.ok) throw new Error("Source fixture unavailable");
    return response.json();
  });
}
function sameArea(before: number, after: number) {
  // Geodesic area can differ slightly when the clipping algorithm adds vertices.
  expect(Math.abs(before - after)).toBeLessThan(
    Math.max(0.01, before * 0.00001),
  );
}

test("parcel map drawing, subdivision and assembly preserve land through undo, account save and public inspection", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const publicContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  errorsOn(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const source = await sourcePlace(page);
    const toolbarFits = await page.locator(".tool-tabs").evaluate((toolbar) => {
      const bounds = toolbar.getBoundingClientRect();
      return [...toolbar.querySelectorAll("button")].every((button) => {
        const rect = button.getBoundingClientRect();
        return (
          rect.top >= bounds.top &&
          rect.bottom <= bounds.bottom &&
          rect.left >= bounds.left &&
          rect.right <= bounds.right
        );
      });
    });
    expect(toolbarFits).toBe(true);
    const featureList = await page
      .getByRole("button", { name: "Open feature list", exact: true })
      .boundingBox();
    const northControl = await page
      .getByRole("button", { name: "Orient map north", exact: true })
      .boundingBox();
    expect(featureList).not.toBeNull();
    expect(northControl).not.toBeNull();
    expect(featureList!.x + featureList!.width).toBeLessThan(northControl!.x);
    await parcelTool(page);
    await page
      .getByRole("button", { name: "Draw a parcel", exact: true })
      .click();
    await draft(page)
      .getByRole("textbox", { name: "Boundary name" })
      .fill("QA Courtyard");
    await draft(page)
      .getByRole("checkbox", { name: "Align to nearby boundary points" })
      .uncheck();
    const canvas = page.locator(".city-map canvas");
    await expect(canvas).toHaveAttribute("aria-label", /^Parcel editing map\./);
    await expect(
      page.getByRole("button", { name: "2D plan", exact: true }),
    ).toHaveClass(/active/);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("The parcel map has no visible dimensions.");
    for (const [index, [x, y]] of [
      [0.4, 0.48],
      [0.62, 0.48],
      [0.62, 0.69],
      [0.4, 0.69],
    ].entries()) {
      await canvas.click({ position: { x: box.width * x, y: box.height * y } });
      await expect(
        draft(page).getByRole("button", { name: /^Select boundary point / }),
      ).toHaveCount(index + 1);
      await expect(
        page.getByRole("button", {
          name: `Parcel vertex ${index + 1}`,
          exact: true,
        }),
      ).toBeVisible();
    }
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(
      draft(page).getByRole("button", { name: /^Select boundary point / }),
    ).toHaveCount(3);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(
      draft(page).getByRole("button", { name: /^Select boundary point / }),
    ).toHaveCount(4);
    const point = draft(page).getByRole("button", {
      name: "Select boundary point 2",
      exact: true,
    });
    await expect(point).toHaveAccessibleDescription(/lat.*lon/i);
    const coordinatesBefore = await point.locator("div").textContent();
    const marker = await page
      .getByRole("button", { name: "Parcel vertex 2", exact: true })
      .boundingBox();
    if (!marker) throw new Error("The parcel vertex is not visible.");
    const x = marker.x + marker.width / 2,
      y = marker.y + marker.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y + 10, { steps: 6 });
    await expect(point.locator("div")).toHaveText(coordinatesBefore!);
    await page.mouse.up();
    await expect(point.locator("div")).not.toHaveText(coordinatesBefore!);
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: /time horizon/i }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Open feature list", exact: true }),
    ).toBeDisabled();
    await expect(apply(page)).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("parcel-map-draft-desktop.png"),
      fullPage: true,
    });
    await canvas.focus();
    await canvas.press("Enter");
    await expect(draft(page)).toHaveCount(0);
    await expect(
      inspector(page).getByRole("heading", { name: "QA Courtyard" }),
    ).toBeVisible();
    await expect(
      inspector(page).getByText("Floor area ratio", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("parcel-profile-desktop.png"),
      fullPage: true,
    });
    const drawn = await projectDownload(page);
    const original = parcels(drawn)[0];
    expect(drawn.project.schemaVersion).toBe(2);
    expect(drawn.place).toEqual(source);
    expect(original.lineage?.operation).toBe("draw");
    expect(original.geometry.type).toBe("Polygon");
    const points =
      original.geometry.type === "Polygon"
        ? original.geometry.coordinates[0]
        : [];
    const west = Math.min(...points.map((p) => p[0])),
      east = Math.max(...points.map((p) => p[0]));
    const south = Math.min(...points.map((p) => p[1])),
      north = Math.max(...points.map((p) => p[1]));
    await inspector(page)
      .getByRole("button", { name: "Subdivide boundary", exact: true })
      .click();
    await useCoordinates(page, [
      [(west + east) / 2, south - 0.0001],
      [(west + east) / 2, north + 0.0001],
    ]);
    await expect(draft(page).locator(".parcel-preview")).toContainText(
      "2 parcels",
    );
    await apply(page).click();
    await expect(list(page).getByRole("button")).toHaveCount(2);
    const splitGis = await gisDownload(page);
    const split = splitGis.features.filter(
      (feature) => feature.properties.featureType === "parcel",
    );
    expect(split).toHaveLength(2);
    sameArea(
      parcelAreaSqm(original),
      split.reduce((sum, feature) => sum + parcelAreaSqm(feature.geometry), 0),
    );
    for (const feature of split)
      expect(feature.properties.lineage).toMatchObject({
        operation: "split",
        parentIds: [original.id],
      });
    await page
      .getByRole("button", { name: "Assemble boundaries", exact: true })
      .click();
    const assembly = draft(page).locator(
      '[aria-label="Choose boundaries to assemble"]',
    );
    for (const item of await assembly.getByRole("button").all())
      await item.click();
    await expect(assembly.locator('[aria-pressed="true"]')).toHaveCount(2);
    await draft(page)
      .getByRole("textbox", { name: "Boundary name" })
      .fill("QA Reunited Courtyard");
    await apply(page).click();
    await expect(
      inspector(page).getByRole("heading", { name: "QA Reunited Courtyard" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(list(page).getByRole("button")).toHaveCount(2);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(list(page).getByRole("button")).toHaveCount(1);
    await list(page)
      .getByRole("button", { name: /^QA Reunited Courtyard/ })
      .click();
    await inspector(page)
      .getByRole("button", { name: "Remove boundary", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Confirm boundary removal" })
      .getByRole("button", { name: "Remove from scenario", exact: true })
      .click();
    await expect(list(page).getByRole("button")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(list(page).getByRole("button")).toHaveCount(1);
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await settled(page);
    await parcelTool(page);
    await expect(
      list(page).getByRole("button", { name: /^QA Reunited Courtyard/ }),
    ).toBeVisible();
    const final = await projectDownload(page);
    expect(final.place).toEqual(source);
    expect(final.baselineIdentity).toEqual(drawn.baselineIdentity);
    expect(baseline(final.project)).toEqual(baseline(drawn.project));
    sameArea(parcelAreaSqm(original), parcelAreaSqm(parcels(final)[0]));
    expect(parcels(final)[0].lineage).toMatchObject({
      operation: "assemble",
      parentIds: expect.arrayContaining(split.map((feature) => feature.id)),
    });
    await registerAndSave(page);
    const saved = (await api.persistedState()).projects[0];
    expect(saved.baseline).toEqual(source);
    expect(active(saved.project)).toEqual(active(final.project));
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", { name: "Published link" });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    const snapshotId = new URL(url).pathname.split("/").pop()!;
    const frozen = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/published/${id}`);
      if (!response.ok)
        throw new Error("Published parcel snapshot unavailable");
      return response.json() as Promise<{ place: Place; scenario: Scenario }>;
    }, snapshotId);
    expect(frozen.place).toEqual(source);
    expect(materializeParcels(frozen.place, frozen.scenario)).toEqual(
      parcels(final),
    );
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    errorsOn(publicPage, errors);
    await publicPage.goto(url);
    await expect(publicPage.getByText(/read.only/i).first()).toBeVisible();
    await expect(publicPage.locator(".city-map-loading")).toHaveCount(0);
    await publicPage
      .getByRole("button", { name: "Browse features", exact: true })
      .click();
    await publicPage
      .getByRole("dialog")
      .getByRole("button", { name: /^QA Reunited Courtyard/ })
      .click();
    const publicInspector = publicPage.locator(
      '[aria-label="Selected feature details"]',
    );
    await expect(
      publicInspector.getByRole("heading", { name: "QA Reunited Courtyard" }),
    ).toBeVisible();
    await expect(
      publicInspector.getByText("Holes preserved", { exact: true }),
    ).toBeVisible();
    await expect(
      publicPage.getByRole("button", {
        name: /^(Draw a parcel|Reshape boundary|Remove boundary)$/,
      }),
    ).toHaveCount(0);
    await publicPage.screenshot({
      path: testInfo.outputPath("parcel-public-readonly-desktop.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("parcel coordinate rings preserve holes and islands while invalid drafts and mobile discard leave revisions intact", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const errors: string[] = [];
  errorsOn(page, errors);
  try {
    await api.connect(page);
    await open(page);
    await parcelTool(page);
    await page
      .getByRole("button", { name: "Draw a parcel", exact: true })
      .click();
    await draft(page)
      .getByRole("textbox", { name: "Boundary name" })
      .fill("QA Courtyard and Island");
    await useCoordinates(page, outer);
    await draft(page)
      .getByRole("button", { name: "Add a hole", exact: true })
      .click();
    await useCoordinates(page, hole);
    await draft(page)
      .getByRole("button", { name: "Add land component", exact: true })
      .click();
    await useCoordinates(page, island);
    await expect(apply(page)).toBeEnabled();
    await page.locator(".city-map canvas").focus();
    await page.locator(".city-map canvas").press("Enter");
    await expect(inspector(page)).toContainText("multiple land components");
    const before = await projectDownload(page);
    const captured = parcels(before)[0];
    expect(captured.geometry).toEqual({
      type: "MultiPolygon",
      coordinates: [[outer, hole], [island]],
    });
    expect(geometryHoles(captured.geometry)).toBe(1);
    await inspector(page)
      .getByRole("button", { name: "Reshape boundary", exact: true })
      .click();
    await expect(apply(page)).toBeDisabled();
    await page.locator(".city-map canvas").focus();
    await page.locator(".city-map canvas").press("Enter");
    await expect(draft(page)).toBeVisible();
    // A self-crossing ring must not overwrite the last valid boundary.
    await useCoordinates(page, [
      outer[0],
      outer[2],
      outer[1],
      outer[3],
      outer[0],
    ]);
    await expect(
      draft(page)
        .getByRole("alert")
        .filter({ hasText: /self.cross|overlap|invalid/i }),
    ).toBeVisible();
    await expect(apply(page)).toBeDisabled();
    await expect(
      draft(page).getByRole("combobox", { name: "Boundary ring" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Undo last edit", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Redo edit", exact: true }),
    ).toBeDisabled();
    for (const name of [
      "Add land component",
      "Add a hole",
      "Remove land component",
    ])
      await expect(
        draft(page).getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    await draft(page)
      .getByRole("button", { name: "Discard coordinate text", exact: true })
      .click();
    // Keep the hole valid while extending the outer boundary beyond this captured source.
    await useCoordinates(page, rectangle(-112.08, 33.452, -112.0705, 33.4585));
    await expect(draft(page).getByRole("alert")).toContainText(
      /study area|within|outside/i,
    );
    await expect(apply(page)).toBeDisabled();
    await useCoordinates(page, outer);
    await draft(page)
      .getByRole("combobox", { name: "Boundary ring" })
      .selectOption({ label: "Part 2 · outer boundary" });
    await useCoordinates(page, rectangle(-112.072, 33.456, -112.068, 33.458));
    await expect(draft(page).getByRole("alert")).toContainText(
      /overlap|invalid/i,
    );
    await expect(apply(page)).toBeDisabled();
    await useCoordinates(page, island);
    await expect(apply(page)).toBeDisabled();
    // Escape while typing is not the map's discard shortcut.
    await draft(page).getByRole("textbox", { name: "Boundary name" }).focus();
    await draft(page)
      .getByRole("textbox", { name: "Boundary name" })
      .press("Escape");
    await expect(draft(page)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: "Share", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await draft(page)
      .getByRole("button", { name: "Discard draft", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("parcel-rings-mobile.png"),
      fullPage: true,
    });
    await draft(page)
      .getByRole("button", { name: "Discard draft", exact: true })
      .focus();
    await draft(page)
      .getByRole("button", { name: "Discard draft", exact: true })
      .press("Enter");
    await expect(draft(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const after = await projectDownload(page);
    expect(after.project).toEqual(before.project);
    expect(after.place).toEqual(before.place);
    expect(after.baselineIdentity).toEqual(before.baselineIdentity);
    expect(after.results.revision).toBe(before.results.revision);
    expect(parcels(after)[0].geometry).toEqual(captured.geometry);
    // Split one land component away from its hole; neither the hole nor the island may disappear.
    await inspector(page)
      .getByRole("button", { name: "Subdivide boundary", exact: true })
      .click();
    await useCoordinates(page, [
      [-112.073, 33.452],
      [-112.073, 33.459],
    ]);
    await expect(draft(page).locator(".parcel-preview")).toContainText(
      "3 parcels",
    );
    await apply(page).click();
    const gis = await gisDownload(page);
    const pieces = gis.features.filter(
      (feature) => feature.properties.featureType === "parcel",
    );
    expect(pieces).toHaveLength(3);
    expect(
      pieces.reduce((count, piece) => count + geometryHoles(piece.geometry), 0),
    ).toBe(1);
    sameArea(
      parcelAreaSqm(captured),
      pieces.reduce((sum, piece) => sum + parcelAreaSqm(piece.geometry), 0),
    );
    await page
      .getByRole("combobox", { name: "Active scenario" })
      .selectOption("baseline");
    await expect(
      page.getByRole("button", { name: "Draw a parcel", exact: true }),
    ).toBeDisabled();
    await expect(list(page).getByRole("button")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

interface ImportFeature {
  type: "Feature";
  id: string;
  properties: { name: string };
  geometry: StudyAreaGeometry;
}
async function previewImport(
  page: Page,
  layer: "parcels" | "blocks",
  features: ImportFeature[],
) {
  await page.getByRole("button", { name: "Import data", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Bring your local knowledge.",
  });
  await dialog
    .getByRole("combobox", { name: "Layer type" })
    .selectOption(layer);
  await dialog.getByLabel("Geographic file", { exact: true }).setInputFiles({
    name: `qa-${layer}.geojson`,
    mimeType: "application/geo+json",
    buffer: Buffer.from(
      JSON.stringify({ type: "FeatureCollection", features }),
    ),
  });
  await dialog
    .getByRole("button", { name: "Save and inspect file", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Put this layer in the right place.",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Source name", exact: true })
    .fill("QA boundary survey fixture");
  await dialog
    .getByRole("textbox", { name: "Source URL", exact: true })
    .fill("https://example.com/qa-boundaries");
  await dialog
    .getByRole("textbox", { name: "Dataset vintage", exact: true })
    .fill("2026-11-05");
  await dialog
    .getByRole("textbox", {
      name: "License and permission statement",
      exact: true,
    })
    .fill("Synthetic QA geometry; permission granted for testing.");
  await dialog
    .getByRole("checkbox", { name: /^I am authorized to privately/ })
    .check();
  await dialog
    .getByRole("checkbox", {
      name: /^This source permits public redistribution/,
    })
    .check();
  await dialog
    .getByRole("button", { name: "Prepare exact preview", exact: true })
    .click();
  return dialog;
}
async function commitImport(
  page: Page,
  count: number,
  layer: "parcels" | "blocks",
) {
  const dialog = page.getByRole("dialog", {
    name: "Bring your local knowledge.",
  });
  await expect(
    dialog.getByRole("heading", {
      name: "A clear look before you apply.",
      exact: true,
    }),
  ).toBeVisible();
  const button = dialog.getByRole("button", {
    name: `Apply ${count} ${count === 1 ? layer.slice(0, -1) : layer}`,
    exact: true,
  });
  await expect(button).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: /^I reviewed the exact geometry/ })
    .check();
  await button.click();
  await expect(dialog).toHaveCount(0);
  await settled(page);
}

test("parcel and block GeoJSON imports preserve source geometry and reject peer overlap atomically", async ({
  page,
  baseURL,
}, testInfo) => {
  // Identity conversion is synthetic here; the real API, mapper, exact parcel
  // validation, history and rights are exercised. gis.spec covers native GDAL.
  const api = await createCollaborationApi(new URL(baseURL!).origin, {
    gisFixture: true,
  });
  const errors: string[] = [];
  errorsOn(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const source = await sourcePlace(page);
    await registerAndSave(page);
    const original = await projectDownload(page);
    const features: ImportFeature[] = [
      {
        type: "Feature",
        id: "survey-courtyard-001",
        properties: { name: "Survey Courtyard" },
        geometry: donut,
      },
      {
        type: "Feature",
        id: "survey-islands-002",
        properties: { name: "Survey Islands" },
        geometry: multi,
      },
    ];
    const preview = await previewImport(page, "parcels", features);
    await expect(
      preview.getByRole("cell", { name: "survey-courtyard-001", exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByRole("cell", { name: /^MultiPolygon/ }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("parcel-import-preview-desktop.png"),
      fullPage: true,
    });
    await commitImport(page, 2, "parcels");
    await parcelTool(page);
    await expect(list(page).getByRole("button")).toHaveCount(2);
    await list(page)
      .getByRole("button", { name: /^Survey Courtyard/ })
      .click();
    await expect(inspector(page)).toContainText(
      "Source feature: survey-courtyard-001",
    );
    await expect(
      inspector(page)
        .locator(".parcel-stat-grid > div")
        .filter({ hasText: "Contained buildings" })
        .locator("strong"),
    ).toHaveText("1");
    await page.screenshot({
      path: testInfo.outputPath("parcel-import-profile-desktop.png"),
      fullPage: true,
    });
    const imported = await projectDownload(page);
    expect(imported.project.schemaVersion).toBe(8);
    expect(imported.place).toEqual(source);
    expect(imported.baselineIdentity).toEqual(original.baselineIdentity);
    expect(baseline(imported.project)).toEqual(baseline(original.project));
    expect(active(imported.project).revision).toBe(
      active(original.project).revision + 1,
    );
    expect(imported.project.history.at(-1)?.command.type).toBe(
      "parcels.import",
    );
    for (const feature of features) {
      const item = parcels(imported).find(
        (p) => p.sourceFeatureId === feature.id,
      )!;
      expect(item.id).not.toBe(feature.id);
      expect(item.geometry).toEqual(feature.geometry);
      expect(item.lineage?.operation).toBe("import");
      expect(
        active(imported.project).sources?.find((s) => s.id === item.sourceId),
      ).toMatchObject({
        name: "QA boundary survey fixture",
        url: "https://example.com/qa-boundaries",
        vintage: "2026-11-05",
        license: "Synthetic QA geometry; permission granted for testing.",
      });
    }
    const far = imported.results.metrics.find(
      (metric) => metric.id === "land.far",
    )!;
    const coverage = imported.results.metrics.find(
      (metric) => metric.id === "land.lotCoverage",
    )!;
    expect(far.baseline).toBeNull();
    expect(far.value).toBeGreaterThan(0);
    expect(coverage.value).toBeGreaterThan(0);
    const totalArea = parcelAreaSqm(donut) + parcelAreaSqm(multi);
    expect(source.buildings.every((building) => building.floors !== null)).toBe(
      true,
    );
    expect(far.value).toBeCloseTo(
      source.buildings.reduce(
        (sum, building) => sum + building.areaSqm * building.floors!,
        0,
      ) / totalArea,
      7,
    );
    // The exact same geometry already occupies this parcel-kind layer. Validation
    // must reject it without adding history or partially applying an import.
    const rejected = await previewImport(page, "parcels", [features[0]]);
    await expect(rejected.getByRole("alert")).toContainText(/overlap/i);
    await expect(
      rejected.getByRole("button", { name: /^Apply \d/ }),
    ).toHaveCount(0);
    await closeDialog(page);
    const afterRejected = await projectDownload(page);
    expect(active(afterRejected.project)).toEqual(active(imported.project));
    expect(afterRejected.project.history).toEqual(imported.project.history);
    expect(afterRejected.place).toEqual(source);
    // Blocks may contain parcel land, but must not double the parcel denominator.
    await previewImport(page, "blocks", [
      {
        type: "Feature",
        id: "block-envelope-003",
        properties: { name: "Survey Block" },
        geometry: { type: "Polygon", coordinates: [outer] },
      },
    ]);
    await commitImport(page, 1, "blocks");
    const withBlock = await projectDownload(page);
    expect(
      parcels(withBlock).filter((parcel) => parcel.kind === "block"),
    ).toHaveLength(1);
    expect(
      withBlock.results.metrics.find((metric) => metric.id === "land.far")
        ?.value,
    ).toBe(far.value);
    expect(
      withBlock.results.metrics.find(
        (metric) => metric.id === "land.lotCoverage",
      )?.value,
    ).toBe(coverage.value);
    const gis = await gisDownload(page);
    for (const feature of features) {
      const exported = gis.features.find(
        (item) => item.properties.sourceFeatureId === feature.id,
      )!;
      expect(exported.geometry).toEqual(feature.geometry);
      expect(exported.properties.featureType).toBe("parcel");
    }
    expect(
      gis.features.find(
        (item) => item.properties.sourceFeatureId === "block-envelope-003",
      )?.properties.featureType,
    ).toBe("block");
    const saved = (await api.persistedState()).projects[0];
    expect(saved.baseline).toEqual(source);
    expect(active(saved.project)).toEqual(active(withBlock.project));
    await page.reload();
    await settled(page);
    await parcelTool(page);
    await expect(list(page).getByRole("button")).toHaveCount(3);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});
