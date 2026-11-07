import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  buildingGeometry,
  buildingProgramTotals,
  materializeBuildings,
  transformBuildingGeometry,
  type Building,
  type ModelResults,
  type Place,
  type Position,
  type Project,
  type Scenario,
  type StudyAreaGeometry,
} from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

// Synthetic geography, actual isolated HTTP authentication/storage/validation.
// All scenario changes use the UI. No injected draft, mocked API or shared dev store.
interface ProjectDownload {
  project: Project;
  place: Place;
  results: ModelResults;
  baselineIdentity: { sha256: string };
}
interface GisDownload {
  features: {
    id: string;
    geometry: StudyAreaGeometry;
    properties: Record<string, unknown>;
  }[];
}
const editor = (page: Page) => page.locator('[aria-label="Building editor"]');
const inspector = (page: Page) =>
  page.locator('[aria-label="Building inspector"]');
const apply = (page: Page) =>
  editor(page).getByRole("button", { name: "Apply building", exact: true });
const active = (project: Project) =>
  project.scenarios.find(
    (scenario) => scenario.id === project.activeScenarioId,
  )!;
const baseline = (project: Project) =>
  project.scenarios.find((scenario) => scenario.id === "baseline")!;
const buildings = (data: ProjectDownload) =>
  materializeBuildings(data.place, active(data.project));
const byName = (data: ProjectDownload, name: string) =>
  buildings(data).find((building) => building.name === name)!;
const coordinates = (points: readonly Position[]) =>
  points.map((point) => point.join(", ")).join("\n");
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
const outer = rectangle(-112.0755, 33.456, -112.0735, 33.4572);
const courtyard = rectangle(-112.0751, 33.4563, -112.0745, 33.4567);
const wing = rectangle(-112.0725, 33.4561, -112.0715, 33.457);
const completeGeometry: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [[outer, courtyard], [wing]],
};
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
async function unloadPrevented(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function durableDraft(page: Page) {
  await expect(page.locator(".project-status")).toHaveText(
    "Browser draft saved",
  );
  await expect.poll(() => unloadPrevented(page)).toBe(false);
}
async function expectHomes(page: Page, homes: number) {
  const card = page
    .locator(".metric-card")
    .filter({ has: page.locator(".metric-label", { hasText: /^Homes$/ }) });
  await expect(card.locator(".metric-value")).toHaveText(
    new RegExp(`^${homes}\\s*homes$`),
  );
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
async function paint(page: Page) {
  // Screenshot synchronization only; assertion/action deadlines remain unchanged.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function closeDialog(page: Page) {
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}
async function download<T>(page: Page, label: RegExp): Promise<T> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name: label }).click();
  const path = await (await pending).path();
  if (!path) throw new Error("The requested scenario export was not written.");
  const data = JSON.parse(await readFile(path, "utf8")) as T;
  await closeDialog(page);
  return data;
}
const projectDownload = (page: Page) =>
  download<ProjectDownload>(page, /^Complete project · JSON/);
const gisDownload = (page: Page) =>
  download<GisDownload>(page, /^Scenario geometry · GeoJSON/);
async function inspect(page: Page, name: string) {
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
  await expect(
    inspector(page).getByRole("heading", { name, exact: true }),
  ).toBeVisible();
}
async function startDraw(page: Page, type: string, name: string) {
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page
    .getByRole("button", { name: "Draw a footprint", exact: true })
    .click();
  await page.getByRole("button", { name: type, exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await editor(page).getByRole("textbox", { name: "Building name" }).fill(name);
  await editor(page)
    .getByRole("checkbox", { name: "Align to nearby building points" })
    .uncheck();
  await expect(
    page.getByRole("button", { name: "2D plan", exact: true }),
  ).toHaveClass(/active/);
}
async function details(scope: Locator, title: string) {
  const summary = scope
    .locator("summary")
    .filter({ hasText: new RegExp(`^${title}$`) });
  if ((await summary.locator("..").getAttribute("open")) === null)
    await summary.click();
}
async function useCoordinates(page: Page, points: readonly Position[]) {
  await details(editor(page), "Enter exact footprint coordinates");
  await editor(page)
    .getByRole("textbox", { name: "Footprint coordinates" })
    .fill(coordinates(points));
  const use = editor(page).getByRole("button", {
    name: "Use footprint coordinates",
    exact: true,
  });
  await use.focus();
  await use.press("Enter");
  await expect(
    editor(page).getByRole("textbox", { name: "Footprint coordinates" }),
  ).toHaveValue("");
}
async function openComponent(page: Page, index: number) {
  const item = editor(page).locator("details.building-component").nth(index);
  if ((await item.getAttribute("open")) === null)
    await item.locator(":scope > summary").click();
  return item.locator(`[aria-label="Program component ${index + 1}"]`);
}
async function registerAndSave(page: Page) {
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your name" })
    .fill("QA Building Planner");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("building-planner@urban-planning.test");
  await page
    .getByLabel(/^Password/)
    .fill("Isolated-building-test-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(
    "QA Building Planner",
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
async function dragHandle(
  page: Page,
  handle: Locator,
  dx: number,
  dy: number,
  beforeRelease?: () => Promise<void>,
) {
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error("Building editing handle is not positioned.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 8 },
  );
  await beforeRelease?.();
  await page.mouse.up();
}
async function expectPublicInspectorLayout(inspector: Locator) {
  await expect
    .poll(() =>
      inspector.evaluate((element) => {
        const panel = element.closest(".shared-map-panel")!;
        const card = element.getBoundingClientRect();
        const map = panel.getBoundingClientRect();
        const controls = panel
          .querySelector(".shared-map-actions")!
          .getBoundingClientRect();
        const graphics = panel
          .querySelector(".city-map-graphics")!
          .getBoundingClientRect();
        const heading = element.querySelector(".shared-inspector-heading")!;
        const close = element.querySelector(
          '[aria-label="Close feature details"]',
        )!;
        const within = (target: Element) => {
          const bounds = target.getBoundingClientRect();
          return (
            bounds.top >= card.top - 1 &&
            bounds.bottom <= card.bottom + 1 &&
            bounds.left >= card.left - 1 &&
            bounds.right <= card.right + 1
          );
        };
        return {
          insideMap:
            card.top >= map.top &&
            card.bottom <= map.bottom &&
            card.left >= map.left &&
            card.right <= map.right,
          belowControls: card.top >= controls.bottom + 8,
          graphicsClear:
            graphics.right <= card.left ||
            graphics.left >= card.right ||
            graphics.bottom <= card.top ||
            graphics.top >= card.bottom,
          headingReachable: within(heading),
          closeReachable: within(close),
        };
      }),
    )
    .toEqual({
      insideMap: true,
      belowControls: true,
      graphicsClear: true,
      headingReachable: true,
      closeReachable: true,
    });
}
async function scrollPublicInspectorToSources(page: Page, inspector: Locator) {
  await inspector.hover();
  await page.mouse.wheel(0, 1500);
  await expect
    .poll(() => inspector.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  const source = inspector.locator(".shared-feature-source");
  await expect(source).toContainText("Synthetic collaboration test fixture");
  await expect
    .poll(() =>
      source.evaluate((element) => {
        const card = element.closest(".shared-inspector")!;
        const bounds = element.getBoundingClientRect();
        const cardBounds = card.getBoundingClientRect();
        const headingBounds = card
          .querySelector(".shared-inspector-heading")!
          .getBoundingClientRect();
        return (
          bounds.top >= headingBounds.bottom &&
          bounds.bottom <= cardBounds.bottom + 1
        );
      }),
    )
    .toBe(true);
  await expectPublicInspectorLayout(inspector);
  await expect(
    inspector.getByRole("heading", {
      name: "QA Medical Mixed Use",
      exact: true,
    }),
  ).toBeVisible();
}
async function scrollPublicInspectorToTop(page: Page, inspector: Locator) {
  await inspector.hover();
  await page.mouse.wheel(0, -1500);
  await expect.poll(() => inspector.evaluate((el) => el.scrollTop)).toBe(0);
  await expectPublicInspectorLayout(inspector);
  await expect(
    inspector.getByRole("heading", {
      name: "QA Medical Mixed Use",
      exact: true,
    }),
  ).toBeVisible();
}
function expectSameGeometry(
  actual: StudyAreaGeometry,
  expected: StudyAreaGeometry,
) {
  expect(actual.type).toBe(expected.type);
  const a =
    actual.type === "Polygon" ? [actual.coordinates] : actual.coordinates;
  const b =
    expected.type === "Polygon" ? [expected.coordinates] : expected.coordinates;
  expect(a.map((part) => part.map((ring) => ring.length))).toEqual(
    b.map((part) => part.map((ring) => ring.length)),
  );
  a.forEach((part, pi) =>
    part.forEach((ring, ri) =>
      ring.forEach((point, vi) => {
        expect(point[0]).toBeCloseTo(b[pi][ri][vi][0], 10);
        expect(point[1]).toBeCloseTo(b[pi][ri][vi][1], 10);
      }),
    ),
  );
}

test("building map drawing and whole-building gestures apply once, preserve baseline and survive undo and reload", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin),
    errors: string[] = [];
  errorsOn(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const before = await projectDownload(page);
    await startDraw(page, "Townhomes", "QA Map Townhomes");
    await expect(page.locator(".project-status")).toHaveText(
      "Draft not applied",
    );
    await expect.poll(() => unloadPrevented(page)).toBe(true);
    const canvas = page.locator(".city-map canvas");
    await expect(canvas).toHaveAttribute(
      "aria-label",
      /^Building editing map\./,
    );
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Share", exact: true }),
    ).toBeDisabled();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Building map canvas has no dimensions.");
    for (const [index, [x, y]] of [
      [0.4, 0.46],
      [0.6, 0.46],
      [0.6, 0.65],
      [0.4, 0.65],
    ].entries()) {
      await canvas.click({ position: { x: box.width * x, y: box.height * y } });
      await expect(
        editor(page).getByRole("button", { name: /^Select footprint point / }),
      ).toHaveCount(index + 1);
    }
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(
      editor(page).getByRole("button", { name: /^Select footprint point / }),
    ).toHaveCount(3);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(
      editor(page).getByRole("button", { name: /^Select footprint point / }),
    ).toHaveCount(4);
    const points = editor(page).locator('[aria-label="Footprint points"]');
    const beforeDrag = await points.innerText();
    await dragHandle(
      page,
      page.getByRole("button", { name: "Building vertex 2", exact: true }),
      -12,
      10,
      async () => {
        // The draw-to-reshape selection transition must wait until drag end.
        // The marker stays mounted and uncommitted coordinates stay in local preview.
        await expect(
          page.getByRole("button", { name: "Building vertex 2", exact: true }),
        ).toBeVisible();
        expect(await points.innerText()).toBe(beforeDrag);
      },
    );
    await expect.poll(() => points.innerText()).not.toBe(beforeDrag);
    await editor(page)
      .getByRole("button", { name: "Move building", exact: true })
      .click();
    const beforeMove = await points.innerText();
    await dragHandle(
      page,
      page.getByRole("button", { name: "Move building handle", exact: true }),
      18,
      -9,
    );
    await expect.poll(() => points.innerText()).not.toBe(beforeMove);
    await editor(page)
      .getByRole("button", { name: "Rotate building", exact: true })
      .click();
    const beforeRotate = await points.innerText();
    await dragHandle(
      page,
      page.getByRole("button", { name: "Rotate building handle", exact: true }),
      22,
      6,
    );
    await expect.poll(() => points.innerText()).not.toBe(beforeRotate);
    await paint(page);
    await page.screenshot({
      path: testInfo.outputPath("building-map-gestures-desktop.png"),
      fullPage: true,
    });
    await expect(apply(page)).toBeEnabled();
    await canvas.focus();
    await canvas.press("Enter");
    await expect(editor(page)).toHaveCount(0);
    await expect(inspector(page)).toContainText("QA Map Townhomes");
    const applied = await projectDownload(page),
      added = byName(applied, "QA Map Townhomes");
    expect(added.typology).toBe("townhome");
    expect(added.program?.components[0].residentialSubtype).toBe("townhome");
    expect(added.units).toBe(6);
    expect(applied.project.schemaVersion).toBe(3);
    expect(active(applied.project).revision).toBe(
      active(before.project).revision + 1,
    );
    expect(baseline(applied.project)).toEqual(baseline(before.project));
    expect(applied.place).toEqual(before.place);
    expect(applied.baselineIdentity).toEqual(before.baselineIdentity);
    await expectHomes(page, 54);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expectHomes(page, 48);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expectHomes(page, 54);
    await durableDraft(page);
    await page.reload();
    await settled(page);
    const reloaded = await projectDownload(page);
    expect(byName(reloaded, "QA Map Townhomes")).toEqual(added);
    await inspect(page, "QA Map Townhomes");
    await inspector(page)
      .getByRole("button", { name: "Reshape footprint", exact: true })
      .click();
    await expect(apply(page)).toBeDisabled();
    await canvas.focus();
    await canvas.press("Enter");
    await expect(editor(page)).toBeVisible();
    await editor(page)
      .getByRole("textbox", { name: "Building name" })
      .fill("Unapplied name");
    await editor(page)
      .getByRole("button", { name: "Discard draft", exact: true })
      .click();
    const discarded = await projectDownload(page);
    expect(active(discarded.project)).toEqual(active(reloaded.project));
    await inspect(page, "QA Map Townhomes");
    await inspector(page)
      .getByRole("button", { name: "Remove building", exact: true })
      .click();
    await inspector(page)
      .getByRole("button", { name: "Confirm removal", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Active scenario" })
      .selectOption("baseline");
    await inspect(page, "QA apartments");
    await expect(
      inspector(page).getByRole("button", {
        name: "Edit building",
        exact: true,
      }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("courtyard and wing coordinates preserve full geometry through numeric transforms, mobile draft guards and exact exports", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin),
    errors: string[] = [];
  errorsOn(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const before = await projectDownload(page);
    await startDraw(page, "Mixed-use", "QA Courtyard and Wing");
    await useCoordinates(page, outer);
    await editor(page)
      .getByRole("button", { name: "Add a courtyard", exact: true })
      .click();
    await useCoordinates(page, courtyard);
    await editor(page)
      .getByRole("button", { name: "Add a wing", exact: true })
      .click();
    await useCoordinates(page, wing);
    await expect(
      editor(page)
        .getByRole("combobox", { name: "Footprint ring" })
        .locator("option"),
    ).toHaveCount(3);
    await details(editor(page), "Move, rotate, or resize precisely");
    await editor(page)
      .getByRole("spinbutton", { name: "Move east", exact: true })
      .fill("15");
    await editor(page)
      .getByRole("spinbutton", { name: "Move north", exact: true })
      .fill("-8");
    await editor(page)
      .getByRole("button", { name: "Move by these distances", exact: true })
      .click();
    await editor(page)
      .getByRole("spinbutton", { name: "Clockwise rotation", exact: true })
      .fill("20");
    await editor(page)
      .getByRole("button", { name: "Rotate by this angle", exact: true })
      .click();
    const expected = transformBuildingGeometry(
      transformBuildingGeometry(completeGeometry, {
        translateMeters: [15, -8],
      }),
      { rotationDegrees: 20 },
    );
    await details(editor(page), "Enter exact footprint coordinates");
    const input = editor(page).getByRole("textbox", {
      name: "Footprint coordinates",
    });
    await input.fill(
      "-112.072,33.456\n-112.071,33.457\n-112.072,33.457\n-112.071,33.456",
    );
    await expect(apply(page)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Undo last edit", exact: true }),
    ).toBeDisabled();
    await expect(
      editor(page).getByRole("combobox", { name: "Footprint ring" }),
    ).toBeDisabled();
    await editor(page)
      .getByRole("button", { name: "Use footprint coordinates", exact: true })
      .click();
    await expect(editor(page).getByRole("alert")).toBeVisible();
    await editor(page)
      .getByRole("button", { name: "Discard coordinate text", exact: true })
      .click();
    await expect(apply(page)).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await apply(page).scrollIntoViewIfNeeded();
    await paint(page);
    await page.screenshot({
      path: testInfo.outputPath("building-courtyard-mobile-actions.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await editor(page)
      .getByRole("button", { name: "Program & massing", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "3D city", exact: true }).click();
    await paint(page);
    await page.screenshot({
      path: testInfo.outputPath("building-courtyard-unapplied-3d.png"),
      fullPage: true,
    });
    await apply(page).click();
    await expect(inspector(page)).toContainText(
      "2 footprint parts · 1 courtyards / holes",
    );
    const exported = await projectDownload(page),
      building = byName(exported, "QA Courtyard and Wing");
    expectSameGeometry(buildingGeometry(building), expected);
    expect(building.footprint).toBeUndefined();
    expect(building.geometrySourceId).toBe("user-building-proposal");
    expect(exported.project.schemaVersion).toBe(3);
    expect(baseline(exported.project)).toEqual(baseline(before.project));
    expect(exported.place).toEqual(before.place);
    const gis = await gisDownload(page);
    expectSameGeometry(
      gis.features.find((feature) => feature.id === building.id)!.geometry,
      expected,
    );
    await durableDraft(page);
    await page.reload();
    await settled(page);
    const restored = await projectDownload(page);
    expect(byName(restored, "QA Courtyard and Wing")).toEqual(building);
    expect(restored.baselineIdentity).toEqual(before.baselineIdentity);
    await inspect(page, "QA Courtyard and Wing");
    await paint(page);
    await page.screenshot({
      path: testInfo.outputPath("building-courtyard-inspector-desktop.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("hospital conversion and mixed program rates reconcile once and persist in a read-only published snapshot", async ({
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
    const before = await projectDownload(page),
      source = byName(before, "QA office");
    await inspect(page, "QA office");
    await inspector(page)
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    await editor(page)
      .getByRole("textbox", { name: "Building name" })
      .fill("QA Medical Mixed Use");
    await details(editor(page), "Change the building type");
    await editor(page)
      .getByRole("combobox", { name: "New building type" })
      .selectOption("hospital");
    await editor(page)
      .getByRole("combobox", { name: "Conversion approach" })
      .selectOption("typed-defaults");
    await editor(page)
      .getByRole("button", { name: "Preview conversion", exact: true })
      .click();
    await expect(editor(page).getByRole("table")).toContainText("450");
    await editor(page)
      .getByRole("button", { name: "Use conversion in draft", exact: true })
      .click();
    let medical = await openComponent(page, 0);
    await expect(
      medical.getByRole("spinbutton", { name: "Entered beds", exact: true }),
    ).toHaveValue("120");
    await details(medical, "Trip and parking assumptions");
    await medical
      .getByRole("checkbox", { name: "Override daily trip rate", exact: true })
      .check();
    await medical
      .getByRole("spinbutton", { name: "Daily trip rate", exact: true })
      .fill("3");
    await medical
      .getByRole("combobox", { name: "Trip denominator" })
      .selectOption("bed");
    await medical
      .getByRole("checkbox", { name: "Specify a bed count", exact: true })
      .uncheck();
    await expect(apply(page)).toBeDisabled();
    await medical
      .getByRole("checkbox", { name: "Specify a bed count", exact: true })
      .check();
    await medical
      .getByRole("spinbutton", { name: "Entered beds", exact: true })
      .fill("120");
    await medical
      .getByRole("checkbox", {
        name: "Override parking demand rate",
        exact: true,
      })
      .check();
    await medical
      .getByRole("spinbutton", { name: "Parking demand rate", exact: true })
      .fill("0.5");
    await medical
      .getByRole("combobox", { name: "Parking denominator" })
      .selectOption("job");
    await editor(page)
      .getByRole("button", { name: "Add program component", exact: true })
      .click();
    const housing = await openComponent(page, 1);
    await housing
      .getByRole("textbox", { name: "Component name" })
      .fill("Staff homes");
    await housing
      .getByRole("combobox", { name: "Component use" })
      .selectOption("multifamily");
    await housing
      .getByRole("spinbutton", { name: "Component floor area", exact: true })
      .fill("500");
    await housing
      .getByRole("spinbutton", { name: "Entered homes", exact: true })
      .fill("8");
    await housing
      .getByRole("combobox", { name: "Residential form" })
      .selectOption("apartment");
    await editor(page)
      .getByRole("button", { name: "Add program component", exact: true })
      .click();
    const retail = await openComponent(page, 2);
    await retail
      .getByRole("textbox", { name: "Component name" })
      .fill("Neighborhood shop");
    await retail
      .getByRole("combobox", { name: "Component use" })
      .selectOption("retail");
    await retail
      .getByRole("spinbutton", { name: "Component floor area", exact: true })
      .fill("250");
    await retail
      .getByRole("spinbutton", { name: "Entered direct jobs", exact: true })
      .fill("12");
    await editor(page)
      .getByRole("spinbutton", {
        name: "Shared / common floor area",
        exact: true,
      })
      .fill("100");
    await expect(apply(page)).toBeDisabled();
    await editor(page)
      .getByRole("button", {
        name: "Use allocated area as the declared total",
        exact: true,
      })
      .click();
    await expect(apply(page)).toBeEnabled();
    await details(editor(page), "Change the building type");
    await editor(page)
      .getByRole("combobox", { name: "New building type" })
      .selectOption("mixed-use");
    await editor(page)
      .getByRole("combobox", { name: "Conversion approach" })
      .selectOption("preserve-program");
    await editor(page)
      .getByRole("button", { name: "Preview conversion", exact: true })
      .click();
    await expect(editor(page).getByRole("table")).toContainText("462");
    await editor(page)
      .getByRole("button", { name: "Use conversion in draft", exact: true })
      .click();
    await paint(page);
    await page.screenshot({
      path: testInfo.outputPath("building-program-reconciled-desktop.png"),
      fullPage: true,
    });
    await apply(page).click();
    const exported = await projectDownload(page),
      changed = byName(exported, "QA Medical Mixed Use");
    expect(changed.id).toBe(source.id);
    expectSameGeometry(buildingGeometry(changed), buildingGeometry(source));
    expect(changed.typology).toBe("mixed-use");
    expect(changed.use).toBe("mixed-use");
    expect(buildingProgramTotals(changed)).toMatchObject({
      units: 8,
      jobs: 462,
      commonAreaSqm: 100,
    });
    expect(changed.program!.components).toHaveLength(3);
    expect(changed.program!.components[0]).toMatchObject({
      beds: 120,
      tripRate: { value: 3, basis: "bed", sourceId: "user-building-proposal" },
      parkingRate: { value: 0.5, basis: "job" },
    });
    expect(
      exported.results.metrics.find((metric) => metric.id === "housing.units")
        ?.value,
    ).toBe(56);
    expect(
      exported.results.metrics.find((metric) => metric.id === "economy.jobs")
        ?.value,
    ).toBe(462);
    expect(baseline(exported.project)).toEqual(baseline(before.project));
    expect(exported.place).toEqual(before.place);
    await registerAndSave(page);
    await durableDraft(page);
    await page.reload();
    await settled(page);
    const reopened = await projectDownload(page);
    expect(byName(reopened, "QA Medical Mixed Use")).toEqual(changed);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", { name: "Published link" });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    const snapshotId = new URL(url).pathname.split("/").pop()!;
    const published = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/published/${id}`);
      if (!response.ok)
        throw new Error("Published building snapshot unavailable");
      return response.json() as Promise<{ place: Place; scenario: Scenario }>;
    }, snapshotId);
    expect(published.place).toEqual(before.place);
    expect(
      materializeBuildings(published.place, published.scenario).find(
        (building) => building.id === changed.id,
      ),
    ).toEqual(changed);
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    errorsOn(publicPage, errors);
    await publicPage.goto(url);
    await expect(publicPage.locator(".city-map-loading")).toHaveCount(0);
    await publicPage
      .getByRole("button", { name: "Browse features", exact: true })
      .click();
    await publicPage
      .getByRole("dialog")
      .getByRole("button", { name: /^QA Medical Mixed Use/ })
      .click();
    const publicInspector = publicPage.locator(
      '[aria-label="Selected feature details"]',
    );
    await expect(publicInspector).toContainText("QA Medical Mixed Use");
    await publicInspector
      .locator("summary")
      .filter({ hasText: /^Development program$/ })
      .click();
    await expect(publicInspector).toContainText("120 beds");
    await expect(publicInspector).toContainText("Trips: 3 per bed");
    await expectPublicInspectorLayout(publicInspector);
    await expect(
      publicPage.getByRole("button", {
        name: /^(Apply building|Edit building|Reshape footprint)$/,
      }),
    ).toHaveCount(0);
    await paint(publicPage);
    await publicPage.screenshot({
      path: testInfo.outputPath("building-public-program-desktop.png"),
      fullPage: true,
    });
    await scrollPublicInspectorToSources(publicPage, publicInspector);
    await scrollPublicInspectorToTop(publicPage, publicInspector);
    await publicPage.setViewportSize({ width: 390, height: 844 });
    await publicInspector.scrollIntoViewIfNeeded();
    await expectPublicInspectorLayout(publicInspector);
    await expect
      .poll(() =>
        publicPage.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await scrollPublicInspectorToSources(publicPage, publicInspector);
    await paint(publicPage);
    await publicPage.locator(".shared-map-panel").screenshot({
      path: testInfo.outputPath("building-public-program-mobile-sources.png"),
    });
    await scrollPublicInspectorToTop(publicPage, publicInspector);
    await paint(publicPage);
    await publicPage.locator(".shared-map-panel").screenshot({
      path: testInfo.outputPath("building-public-program-mobile-top.png"),
    });
    await publicPage
      .getByRole("button", { name: "Reduce graphics", exact: true })
      .click();
    await expect(
      publicPage.getByRole("button", { name: "Enable 3D detail", exact: true }),
    ).toBeVisible();
    await expectPublicInspectorLayout(publicInspector);
    await publicPage
      .getByRole("button", { name: "Enable 3D detail", exact: true })
      .click();
    await expect(
      publicPage.getByRole("button", { name: "Reduce graphics", exact: true }),
    ).toBeVisible();
    await expectPublicInspectorLayout(publicInspector);
    await publicInspector
      .getByRole("button", { name: "Close feature details", exact: true })
      .click();
    await expect(publicInspector).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});
