import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  geometryIntersectionAreaSqm,
  validateActivityNeighborhoods,
  type ActivityScenario,
  type Place,
  type Position,
  type Project,
  type Scenario,
  type StudyAreaGeometry,
} from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

// Only the geographic source is synthetic. Account sessions, model resolution,
// commands, persistence, publication, and exports use the actual isolated API.
// All authoring uses visible controls or real pointer gestures; no UI/store mutation.
interface CompleteProject {
  project: Project;
  place: Place;
  baselineIdentity: { sha256: string };
}
interface GeometryExport {
  metadata: { activity?: ActivityScenario; revision: number };
  features: {
    id: string;
    geometry: StudyAreaGeometry;
    properties: Record<string, unknown>;
  }[];
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "Population and activity controls" });
const areaEditor = (page: Page) =>
  page.locator('[aria-label="Neighborhood drawing editor"]');
const active = (data: CompleteProject) =>
  data.project.scenarios.find((s) => s.id === data.project.activeScenarioId)!;
const baseline = (data: CompleteProject) =>
  data.project.scenarios.find((s) => s.id === "baseline")!;
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
const outer = rectangle(-112.075, 33.453, -112.071, 33.457);
const hole = rectangle(-112.0746, 33.4535, -112.0738, 33.4543);
const island = rectangle(-112.0695, 33.456, -112.0678, 33.458);
const second = rectangle(-112.071, 33.451, -112.067, 33.452);
const courtyard: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [[outer, hole], [island]],
};
const holeCount = (geometry: StudyAreaGeometry) =>
  (geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates
  ).reduce((sum, rings) => sum + rings.length - 1, 0);
function trackErrors(page: Page, errors: string[]) {
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
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function open(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await expect(page.locator(".map-disclosure")).toContainText(
    "Synthetic collaboration QA",
  );
  await settled(page);
}
async function closeDialog(page: Page) {
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}
async function download<T>(page: Page, name: RegExp): Promise<T> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name }).click();
  const path = await (await pending).path();
  if (!path)
    throw new Error("The requested project/geometry download was not written.");
  const data = JSON.parse(await readFile(path, "utf8")) as T;
  await closeDialog(page);
  return data;
}
const exportProject = (page: Page) =>
  download<CompleteProject>(page, /^Complete project · JSON/);
async function startPeople(page: Page) {
  await page.getByRole("button", { name: "People", exact: true }).click();
  await panel(page)
    .getByRole("button", { name: "Set up People controls", exact: true })
    .click();
  await expect(panel(page)).toContainText("UNAPPLIED");
}
async function target(scope: Locator, label: string, value: number) {
  await scope
    .getByRole("combobox", { name: `${label} target method`, exact: true })
    .selectOption("absolute");
  await scope
    .getByRole("spinbutton", { name: `${label} count`, exact: true })
    .fill(String(value));
}
async function neighborhoods(page: Page) {
  await panel(page)
    .getByRole("button", { name: "Neighborhoods", exact: true })
    .click();
}
async function startArea(page: Page, name: string) {
  await panel(page)
    .getByRole("button", { name: "Paint a neighborhood", exact: true })
    .click();
  await areaEditor(page)
    .getByRole("textbox", { name: "Neighborhood name", exact: true })
    .fill(name);
  await expect(
    page.getByRole("button", { name: "2D plan", exact: true }),
  ).toHaveClass(/active/);
}
async function precision(page: Page) {
  const details = areaEditor(page).locator(".activity-precision");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
  return details;
}
async function coordinates(page: Page, points: readonly Position[]) {
  await precision(page);
  await areaEditor(page)
    .getByRole("textbox", {
      name: "Ring coordinates (longitude, latitude)",
      exact: true,
    })
    .fill(points.map((p) => p.join(", ")).join("\n"));
  await expect(
    areaEditor(page).getByRole("combobox", {
      name: "Active boundary ring",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    panel(page).getByRole("button", { name: "Undo draft", exact: true }),
  ).toBeDisabled();
  await areaEditor(page)
    .getByRole("button", { name: "Use coordinates", exact: true })
    .click();
}
async function keepArea(page: Page) {
  const button = panel(page).getByRole("button", {
    name: "Keep area in draft",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(areaEditor(page)).toHaveCount(0);
}
async function applyPeople(page: Page) {
  const button = panel(page).getByRole("button", {
    name: "Apply People controls",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    panel(page).getByRole("button", {
      name: "Edit People controls",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel(page).locator('[aria-label="People estimate"] strong'),
  ).not.toBeEmpty();
  await settled(page);
}
async function mapPainted(page: Page) {
  await expect
    .poll(() =>
      page.locator(".city-map canvas").evaluate((canvas) => {
        const sample = document.createElement("canvas");
        sample.width = 64;
        sample.height = 64;
        const context = sample.getContext("2d")!;
        context.drawImage(canvas as HTMLCanvasElement, 0, 0, 64, 64);
        const bytes = context.getImageData(0, 0, 64, 64).data,
          colors = new Set<string>();
        for (let i = 0; i < bytes.length; i += 4)
          if (bytes[i + 3])
            colors.add(
              `${bytes[i] >> 4},${bytes[i + 1] >> 4},${bytes[i + 2] >> 4}`,
            );
        return colors.size;
      }),
    )
    .toBeGreaterThan(4);
}
async function registerAndSave(page: Page) {
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your name", exact: true })
    .fill("QA Neighborhood Planner");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("activity-planner@urban-planning.test");
  await page
    .getByLabel(/^Password/)
    .fill("Isolated-neighborhood-test-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(
    "QA Neighborhood Planner",
  );
  await page
    .getByRole("button", { name: "Open project home", exact: true })
    .click();
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

test("precise neighborhood holes and islands apply atomically with count targets, undo, account publication and exact GIS", async ({
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
  trackErrors(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const before = await exportProject(page);
    await startPeople(page);
    await target(panel(page), "Population", 1000);
    await target(panel(page), "Workplace jobs", 200);
    await neighborhoods(page);
    await panel(page)
      .getByRole("combobox", { name: "Population allocation", exact: true })
      .selectOption("uniform-area");
    await panel(page)
      .getByRole("combobox", { name: "Employment allocation", exact: true })
      .selectOption("uniform-area");
    await startArea(page, "QA Courtyard neighborhood");
    await areaEditor(page)
      .getByRole("button", { name: "Draw", exact: true })
      .click();
    await coordinates(page, outer);
    await areaEditor(page)
      .getByRole("button", { name: "Add hole", exact: true })
      .click();
    await coordinates(page, hole);
    await areaEditor(page)
      .getByRole("button", { name: "Add part", exact: true })
      .click();
    await coordinates(page, island);
    await target(areaEditor(page), "Area population", 120);
    await target(areaEditor(page), "Area workplace jobs", 30);
    await keepArea(page);
    await startArea(page, "QA South neighborhood");
    await coordinates(page, second);
    await target(areaEditor(page), "Area population", 80);
    await target(areaEditor(page), "Area workplace jobs", 50);
    await keepArea(page);
    await expect(
      panel(page).locator(".activity-area-list article"),
    ).toHaveCount(2);
    await panel(page)
      .getByRole("button", { name: "Counts", exact: true })
      .click();
    await panel(page)
      .getByRole("spinbutton", { name: "Population count", exact: true })
      .fill("1100");
    await panel(page)
      .getByRole("button", { name: "Undo draft", exact: true })
      .click();
    await expect(
      panel(page).getByRole("spinbutton", {
        name: "Population count",
        exact: true,
      }),
    ).toHaveValue("1000");
    await panel(page)
      .getByRole("button", { name: "Redo", exact: true })
      .click();
    await expect(
      panel(page).getByRole("spinbutton", {
        name: "Population count",
        exact: true,
      }),
    ).toHaveValue("1100");
    // The whole People draft is unapplied; export is visibly disabled.
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await neighborhoods(page);
    await mapPainted(page);
    await page.screenshot({
      path: testInfo.outputPath("activity-precise-draft-desktop.png"),
      fullPage: true,
    });
    await applyPeople(page);
    const result = await exportProject(page);
    const scenario = active(result),
      areas = scenario.activity!.neighborhoods;
    expect(scenario.revision).toBe(active(before).revision + 1);
    expect(result.project.history.length).toBe(
      before.project.history.length + 1,
    );
    expect(result.project.history.at(-1)?.command.type).toBe(
      "scenario.activity",
    );
    expect(scenario.activity!.global).toMatchObject({
      population: { mode: "absolute", value: 1100 },
      employment: { mode: "absolute", value: 200 },
    });
    expect(areas).toHaveLength(2);
    expect(areas[0]).toMatchObject({
      name: "QA Courtyard neighborhood",
      geometry: courtyard,
      population: { mode: "absolute", value: 120 },
      employment: { mode: "absolute", value: 30 },
    });
    expect(areas[1].geometry).toEqual({
      type: "Polygon",
      coordinates: [second],
    });
    expect(
      geometryIntersectionAreaSqm(areas[0].geometry, areas[1].geometry),
    ).toBeLessThan(1e-6);
    expect(result.place).toEqual(before.place);
    expect(result.baselineIdentity).toEqual(before.baselineIdentity);
    expect(baseline(result)).toEqual(baseline(before));
    expect(scenario.buildingEdits).toEqual(active(before).buildingEdits);
    expect(scenario.roadEdits).toEqual(active(before).roadEdits);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(
      panel(page).getByRole("button", {
        name: "Set up People controls",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(
      panel(page).getByRole("button", {
        name: "Edit People controls",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".project-status")).toHaveText(
      "Browser draft saved",
    );
    await page.reload();
    await settled(page);
    await page.getByRole("button", { name: "People", exact: true }).click();
    await expect(
      panel(page).getByRole("button", { name: /^QA Courtyard neighborhood/ }),
    ).toBeVisible();
    await registerAndSave(page);
    const gis = await download<GeometryExport>(
      page,
      /^Scenario geometry · GeoJSON/,
    );
    const gisAreas = gis.features.filter(
      (feature) => feature.properties.featureType === "activity-neighborhood",
    );
    expect(gisAreas).toHaveLength(2);
    expect(gis.metadata.activity).toEqual(scenario.activity);
    expect(
      gisAreas.find((feature) => feature.id === areas[0].id)?.geometry,
    ).toEqual(courtyard);
    expect(
      gisAreas.every(
        (feature) =>
          feature.properties.boundaryStatus ===
          "Authored planning allocation; not an observed Census or legal neighborhood",
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const published = page.getByRole("textbox", {
      name: "Published link",
      exact: true,
    });
    await expect(published).toBeVisible();
    const url = await published.inputValue(),
      id = new URL(url).pathname.split("/").pop()!;
    const frozen = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/published/${id}`);
      if (!response.ok)
        throw new Error("Published activity snapshot unavailable");
      return response.json() as Promise<{ place: Place; scenario: Scenario }>;
    }, id);
    expect(frozen.place).toEqual(before.place);
    expect(frozen.scenario.activity).toEqual(scenario.activity);
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    trackErrors(publicPage, errors);
    await publicPage.goto(url);
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    const frozenControls = publicPage.getByRole("region", {
      name: "Frozen population and activity controls",
    });
    await expect(frozenControls).toHaveAttribute("aria-busy", "false");
    await expect(frozenControls).toContainText("QA Courtyard neighborhood");
    await expect(frozenControls).toContainText("120 people · 30 jobs");
    await expect(frozenControls).toContainText("80 people · 50 jobs");
    await expect(
      publicPage.getByRole("button", {
        name: /^(Paint a neighborhood|Edit People controls|Apply People controls)$/,
      }),
    ).toHaveCount(0);
    await frozenControls.scrollIntoViewIfNeeded();
    await publicPage.screenshot({
      path: testInfo.outputPath("activity-public-frozen-desktop.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("real paint and erase gestures preserve holes, local undo and cancellation while mobile discard leaves the scenario intact", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin),
    errors: string[] = [];
  trackErrors(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const before = await exportProject(page);
    await startPeople(page);
    await neighborhoods(page);
    await panel(page)
      .getByRole("combobox", { name: "Population allocation", exact: true })
      .selectOption("uniform-area");
    await panel(page)
      .getByRole("combobox", { name: "Employment allocation", exact: true })
      .selectOption("uniform-area");
    await startArea(page, "QA Painted neighborhood");
    await areaEditor(page)
      .getByRole("spinbutton", { name: "Brush radius (meters)", exact: true })
      .fill("80");
    const canvas = page.locator(".city-map canvas");
    await expect(canvas).toHaveAttribute(
      "aria-label",
      /^Neighborhood editing map\./,
    );
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Neighborhood canvas has no visible dimensions.");
    const start = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.67 },
      end = { x: box.x + box.width * 0.62, y: start.y },
      middle = { x: (start.x + end.x) / 2, y: start.y };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    const keep = panel(page).getByRole("button", {
      name: "Keep area in draft",
      exact: true,
    });
    await expect(keep).toBeEnabled();
    await panel(page)
      .getByRole("button", { name: "Undo draft", exact: true })
      .click();
    await expect(keep).toBeDisabled();
    await panel(page)
      .getByRole("button", { name: "Redo", exact: true })
      .click();
    await expect(keep).toBeEnabled();
    await areaEditor(page)
      .getByRole("button", { name: "Erase", exact: true })
      .click();
    await areaEditor(page)
      .getByRole("spinbutton", { name: "Brush radius (meters)", exact: true })
      .fill("20");
    await page.mouse.click(middle.x, middle.y);
    await expect(keep).toBeEnabled();
    await precision(page);
    const ringOptions = areaEditor(page)
      .getByRole("combobox", { name: "Active boundary ring", exact: true })
      .locator("option");
    await expect(ringOptions.filter({ hasText: "hole 1" })).toHaveCount(1);
    await panel(page)
      .getByRole("button", { name: "Undo draft", exact: true })
      .click();
    await expect(ringOptions.filter({ hasText: "hole 1" })).toHaveCount(0);
    await panel(page)
      .getByRole("button", { name: "Redo", exact: true })
      .click();
    await expect(ringOptions.filter({ hasText: "hole 1" })).toHaveCount(1);
    await areaEditor(page)
      .getByRole("button", { name: "Load current ring into text", exact: true })
      .click();
    const coordinateInput = areaEditor(page).getByRole("textbox", {
      name: "Ring coordinates (longitude, latitude)",
      exact: true,
    });
    const savedRing = await coordinateInput.inputValue();
    await areaEditor(page)
      .getByRole("button", { name: "Discard coordinate text", exact: true })
      .click();
    await areaEditor(page)
      .getByRole("button", { name: "Paint", exact: true })
      .click();
    // A cancelled in-progress stroke cannot become a partial history entry.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 50, { steps: 5 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(areaEditor(page)).toBeVisible();
    await areaEditor(page)
      .getByRole("button", { name: "Load current ring into text", exact: true })
      .click();
    await expect(coordinateInput).toHaveValue(savedRing);
    await areaEditor(page)
      .getByRole("button", { name: "Discard coordinate text", exact: true })
      .click();
    await target(areaEditor(page), "Area population", 100);
    await mapPainted(page);
    await page.screenshot({
      path: testInfo.outputPath("activity-brush-hole-desktop.png"),
      fullPage: true,
    });
    await keepArea(page);
    await applyPeople(page);
    const applied = await exportProject(page);
    const area = active(applied).activity!.neighborhoods[0];
    expect(holeCount(area.geometry)).toBe(1);
    expect(area.population).toEqual({ mode: "absolute", value: 100 });
    expect(() =>
      validateActivityNeighborhoods([area], applied.place),
    ).not.toThrow();
    expect(applied.place).toEqual(before.place);
    expect(baseline(applied)).toEqual(baseline(before));
    await panel(page)
      .getByRole("button", { name: "Edit People controls", exact: true })
      .click();
    await neighborhoods(page);
    await panel(page)
      .locator(".activity-area-list article")
      .filter({ hasText: "QA Painted neighborhood" })
      .getByRole("button", { name: "Edit area", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await areaEditor(page)
      .getByRole("textbox", { name: "Neighborhood name", exact: true })
      .fill("Unapplied mobile draft");
    await areaEditor(page)
      .getByRole("textbox", { name: "Neighborhood name", exact: true })
      .press("Escape");
    await expect(areaEditor(page)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await areaEditor(page).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("activity-mobile-editing.png"),
      fullPage: true,
    });
    await page.screenshot({
      path: testInfo.outputPath("activity-mobile-viewport.png"),
      fullPage: false,
    });
    await panel(page)
      .getByRole("button", { name: "Discard area edit", exact: true })
      .click();
    await panel(page)
      .getByRole("button", { name: "Discard controls", exact: true })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const discarded = await exportProject(page);
    expect(active(discarded)).toEqual(active(applied));
    expect(discarded.baselineIdentity).toEqual(applied.baselineIdentity);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});
