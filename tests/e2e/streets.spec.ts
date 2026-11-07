import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  materializeRoads,
  type ModelResults,
  type Place,
  type Position,
  type Project,
  type Scenario,
} from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

interface ProjectDownload {
  project: Project;
  place: Place;
  results: ModelResults;
}
interface GisDownload {
  metadata: { scenarioId: string; revision: number; sources: Place["sources"] };
  features: {
    id: string;
    geometry: { type: string; coordinates: Position[] };
    properties: Record<string, unknown>;
  }[];
}
const streetName = "QA Community Connector";
// These are inside the documented synthetic source in collaboration-server.ts.
// The first geometry is drawn by actual map clicks; only its reshape uses these coordinates.
const reshaped: Position[] = [
  [-112.074, 33.453],
  [-112.0715, 33.454],
  [-112.069, 33.453],
];
const coordinateText = (coordinates: Position[]) =>
  coordinates.map((position) => position.join(", ")).join("\n");
const editor = (page: Page) =>
  page.locator('[aria-label="Street drawing editor"]');
const streetItem = (page: Page) =>
  page.locator('[aria-label="Streets in this scenario"]').getByRole("button", {
    name: new RegExp(`^${streetName}`),
  });
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
}
async function downloadJson<T>(
  page: Page,
  name: RegExp,
): Promise<{ value: T; filename: string }> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error("The requested JSON download was not written.");
  const value = JSON.parse(await readFile(path, "utf8")) as T;
  await closeDialog(page);
  return { value, filename: download.suggestedFilename() };
}
async function openCoordinates(page: Page) {
  const details = editor(page).locator("details");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
  await expect(
    editor(page).getByRole("textbox", { name: "Street coordinates" }),
  ).toBeVisible();
}
async function useCoordinates(page: Page, text: string) {
  await openCoordinates(page);
  await editor(page)
    .getByRole("textbox", { name: "Street coordinates" })
    .fill(text);
  // Exercise the keyboard activation path as well as the accessible coordinate editor.
  const use = editor(page).getByRole("button", {
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
    .fill("QA Street Planner");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("street-planner@urban-planning.test");
  await page.getByLabel(/^Password/).fill("Isolated-street-test-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(
    "QA Street Planner",
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

test("street drawing, reshaping, undo and export survive reload and a frozen public snapshot", async ({
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
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await open(page);
    // Read the actual delivered source; do not replace application state or seed an edit.
    const source = await page.evaluate(async () => {
      const response = await fetch("/data/phoenix.json");
      if (!response.ok) throw new Error("Source fixture unavailable");
      return response.json() as Promise<Place>;
    });
    await page.getByRole("button", { name: "Mobility", exact: true }).click();
    await page
      .getByRole("button", { name: "Draw a street", exact: true })
      .click();
    await editor(page)
      .getByRole("textbox", { name: "Street name", exact: true })
      .fill(streetName);
    await expect(
      page.getByRole("button", { name: "2D plan", exact: true }),
    ).toHaveClass(/active/);
    await expect(page.locator(".city-map canvas")).toHaveAttribute(
      "aria-label",
      /^Street drawing map\./,
    );
    await editor(page)
      .getByRole("checkbox", { name: "Align to nearby street points" })
      .uncheck();
    const canvas = page.locator(".city-map canvas");
    const box = await canvas.boundingBox();
    if (!box)
      throw new Error("The street drawing map has no visible dimensions.");
    for (const [index, [x, y]] of [
      [0.43, 0.53],
      [0.52, 0.6],
      [0.63, 0.51],
    ].entries()) {
      await canvas.click({ position: { x: box.width * x, y: box.height * y } });
      await expect(
        editor(page).getByRole("button", { name: /^Select street point / }),
      ).toHaveCount(index + 1);
      await expect(
        page.getByRole("button", {
          name: `Street vertex ${index + 1}`,
          exact: true,
        }),
      ).toBeVisible();
    }
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(
      editor(page).getByRole("button", { name: /^Select street point / }),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Street vertex 3", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(
      editor(page).getByRole("button", { name: /^Select street point / }),
    ).toHaveCount(3);
    const middlePoint = editor(page).getByRole("button", {
      name: "Select street point 2",
      exact: true,
    });
    await expect(middlePoint).toHaveAttribute("aria-describedby", /.+/);
    await expect(middlePoint).toHaveAccessibleDescription(/lat/i);
    const middleCoordinates = await middlePoint.locator("div").textContent();
    const describedCoordinates = () =>
      middlePoint.evaluate((element) =>
        (element.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
    const descriptionBeforeDrag = await describedCoordinates();
    const middleMarker = page.getByRole("button", {
      name: "Street vertex 2",
      exact: true,
    });
    const markerBox = await middleMarker.boundingBox();
    if (!markerBox) throw new Error("The middle street vertex is not visible.");
    const markerX = markerBox.x + markerBox.width / 2;
    const markerY = markerBox.y + markerBox.height / 2;
    await page.mouse.move(markerX, markerY);
    await page.mouse.down();
    await page.mouse.move(markerX + 25, markerY + 14, { steps: 6 });
    // Drag previews must not create persistent coordinate changes before release.
    await expect(middlePoint.locator("div")).toHaveText(middleCoordinates!);
    await page.mouse.up();
    await expect(middlePoint.locator("div")).not.toHaveText(middleCoordinates!);
    await expect.poll(describedCoordinates).not.toBe(descriptionBeforeDrag);
    await expect(middlePoint).toHaveAccessibleDescription(/lat/i);
    await expect(middlePoint).toHaveAttribute("aria-pressed", "true");
    await expect(
      editor(page).getByRole("button", { name: /^Select street point / }),
    ).toHaveCount(3);
    // Escape on an editor control must not act like the focused-map discard shortcut.
    const drawMode = editor(page).getByRole("button", {
      name: "Add points",
      exact: true,
    });
    await drawMode.focus();
    await drawMode.press("Escape");
    await expect(editor(page)).toBeVisible();
    await expect(middlePoint).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: /time horizon/i }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Share", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "3D city", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath("street-drawing-desktop.png"),
      fullPage: true,
    });
    await canvas.focus();
    await canvas.press("Enter");
    await expect(editor(page)).toHaveCount(0);
    await expect(
      page.getByRole("spinbutton", { name: "Travel lanes", exact: true }),
    ).toHaveValue("2");
    await page
      .getByRole("spinbutton", { name: "Travel lanes", exact: true })
      .fill("0");
    await expect(
      page.getByRole("button", { name: "Apply street changes", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".inspector").getByRole("alert")).toContainText(
      /travel lanes/i,
    );
    await page
      .getByRole("spinbutton", { name: "Travel lanes", exact: true })
      .fill("3");
    await page
      .getByRole("spinbutton", { name: "Speed limit", exact: true })
      .fill("-5");
    await expect(
      page.getByRole("button", { name: "Apply street changes", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".inspector").getByRole("alert")).toContainText(
      /speed limit/i,
    );
    await page
      .getByRole("spinbutton", { name: "Speed limit", exact: true })
      .fill("25");
    await expect(page.locator(".inspector").getByRole("alert")).toHaveCount(0);
    await page
      .getByRole("checkbox", { name: "Protected bike lane", exact: true })
      .check();
    await page
      .getByRole("button", { name: "Apply street changes", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply street changes", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Reshape street path", exact: true })
      .click();
    await expect(
      editor(page).getByRole("button", { name: "Apply street", exact: true }),
    ).toBeDisabled();
    await canvas.focus();
    await canvas.press("Enter");
    await expect(editor(page)).toBeVisible();
    await expect(
      editor(page).getByRole("button", { name: "Apply street", exact: true }),
    ).toBeDisabled();
    await useCoordinates(page, coordinateText(reshaped));
    await expect(
      editor(page).getByRole("textbox", { name: "Street coordinates" }),
    ).toHaveValue("");
    await expect(
      editor(page).getByRole("button", { name: /^Select street point / }),
    ).toHaveCount(3);
    // Replacing a longer path must not leave selection pointing beyond its end.
    await editor(page)
      .getByRole("button", { name: "Select street point 3", exact: true })
      .click();
    await useCoordinates(page, coordinateText(reshaped.slice(0, 2)));
    await expect(
      editor(page).getByRole("button", { name: /^Select street point / }),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Street vertex 3", exact: true }),
    ).toHaveCount(0);
    await editor(page)
      .getByRole("button", { name: "Move a point", exact: true })
      .click();
    await expect(
      editor(page).locator('.street-vertex[aria-pressed="true"]'),
    ).toHaveCount(1);
    await expect(
      editor(page).locator('.street-vertex[aria-pressed="true"]'),
    ).toHaveAccessibleName(/^Select street point [12]$/);
    await useCoordinates(page, coordinateText(reshaped));
    await expect(
      editor(page).getByRole("button", { name: "Apply street", exact: true }),
    ).toBeEnabled();
    // Deck paints the updated draft on a frame after React updates the controls.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.screenshot({
      path: testInfo.outputPath("street-reshape-desktop.png"),
      fullPage: true,
    });
    await editor(page)
      .getByRole("button", { name: "Apply street", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "Travel lanes", exact: true }),
    ).toHaveValue("3");
    await expect(
      page.getByRole("checkbox", { name: "Protected bike lane", exact: true }),
    ).toBeChecked();
    await page
      .getByRole("button", { name: "Remove street", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Confirm street removal" })
      .getByRole("button", { name: "Remove from scenario", exact: true })
      .click();
    await expect(streetItem(page)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(streetItem(page)).toBeVisible();
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(streetItem(page)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(streetItem(page)).toBeVisible();
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toBeVisible();
    await settled(page);
    await page.getByRole("button", { name: "Mobility", exact: true }).click();
    await expect(streetItem(page)).toBeVisible();
    await streetItem(page).click();
    await expect(
      page.getByRole("spinbutton", { name: "Travel lanes", exact: true }),
    ).toHaveValue("3");
    const gis = await downloadJson<GisDownload>(
      page,
      /^Scenario geometry · GeoJSON/,
    );
    expect(gis.filename).toBe("urban-planning-scenario.geojson");
    const proposed = gis.value.features.find(
      (feature) => feature.properties.name === streetName,
    )!;
    expect(proposed).toMatchObject({
      geometry: { type: "LineString", coordinates: reshaped },
      properties: {
        featureType: "road",
        lanes: 3,
        bikeLane: true,
        estimated: true,
        sourceId: "user-road-proposal",
        geometrySourceId: "user-road-proposal",
        attributeSourceId: "user-road-proposal",
        scenarioRevision: 7,
      },
    });
    expect(proposed.properties).not.toHaveProperty("aadt");
    expect(
      gis.value.metadata.sources.some(
        (item) => item.id === "user-road-proposal",
      ),
    ).toBe(true);
    const exported = (
      await downloadJson<ProjectDownload>(page, /^Complete project · JSON/)
    ).value;
    const scenario = exported.project.scenarios.find(
      (item) => item.id === exported.project.activeScenarioId,
    )!;
    expect(scenario.revision).toBe(7);
    expect(exported.results.revision).toBe(scenario.revision);
    expect(exported.place).toEqual(source);
    expect(
      exported.project.scenarios.find((item) => item.id === "baseline")
        ?.roadEdits,
    ).toEqual({});
    expect(scenario.roadEdits[proposed.id]?.coordinates).toEqual(reshaped);
    expect(exported.project.history.at(-1)?.command).toEqual({
      type: "road.remove",
      id: proposed.id,
    });
    expect(exported.project.undone.at(-1)?.command.type).toBe("road.remove");
    await registerAndSave(page);
    const saved = (await api.persistedState()).projects[0];
    expect(saved.baseline).toEqual(source);
    expect(
      saved.project.scenarios.find((item) => item.id === scenario.id),
    ).toEqual(scenario);
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
        throw new Error("Published street snapshot unavailable");
      return response.json() as Promise<{ place: Place; scenario: Scenario }>;
    }, snapshotId);
    expect(frozen.place).toEqual(source);
    expect(frozen.scenario).toEqual(scenario);
    expect(
      materializeRoads(frozen.place, frozen.scenario).find(
        (road) => road.id === proposed.id,
      )?.coordinates,
    ).toEqual(reshaped);
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    publicPage.on("pageerror", (error) => errors.push(error.message));
    await publicPage.goto(url);
    await expect(publicPage.getByText(/read.only/i).first()).toBeVisible();
    await expect(publicPage.locator(".city-map canvas")).toBeVisible();
    await expect(publicPage.locator(".city-map-loading")).toHaveCount(0);
    await expect(
      publicPage.getByRole("button", { name: "Draw a street", exact: true }),
    ).toHaveCount(0);
    await publicPage.screenshot({
      path: testInfo.outputPath("street-public-desktop.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("keyboard street coordinates reject invalid paths and discarding preserves the baseline and model revision", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await open(page);
    const before = (
      await downloadJson<ProjectDownload>(page, /^Complete project · JSON/)
    ).value;
    await page.getByRole("button", { name: "Mobility", exact: true }).click();
    await page
      .getByRole("button", { name: "Draw a street", exact: true })
      .click();
    for (const [text, message] of [
      [
        "not-a-longitude, 33.454\n-112.070, 33.453",
        /Line 1: enter longitude, latitude/,
      ],
      [
        coordinateText([
          [-112.075, 33.452],
          [-112.068, 33.458],
          [-112.075, 33.458],
          [-112.068, 33.452],
        ]),
        /cannot cross or overlap itself/,
      ],
      [
        coordinateText([
          [-112.074, 33.454],
          [-112.06, 33.454],
        ]),
        /entire street path inside the study area/,
      ],
      [
        coordinateText([
          [-112.074, 33.454],
          [-112.074, 33.454],
        ]),
        /Separate consecutive street points/,
      ],
    ] as const) {
      await useCoordinates(page, text);
      await expect(editor(page).getByRole("alert")).toContainText(message);
      await expect(
        editor(page).getByRole("button", { name: "Apply street", exact: true }),
      ).toBeDisabled();
      await expect(
        editor(page).getByRole("button", { name: /^Select street point / }),
      ).toHaveCount(0);
    }
    await useCoordinates(page, coordinateText(reshaped));
    await expect(
      editor(page).getByRole("button", { name: "Apply street", exact: true }),
    ).toBeEnabled();
    await expect(
      editor(page).getByRole("button", { name: /^Select street point / }),
    ).toHaveCount(3);
    await page.screenshot({
      path: testInfo.outputPath("street-keyboard-draft.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor(page)).toBeVisible();
    await expect(
      editor(page).getByRole("button", { name: "Apply street", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath("street-editing-mobile.png"),
      fullPage: true,
    });
    const helpBounds = await page
      .locator(".city-street-drawing-help")
      .boundingBox();
    const viewBounds = await page.locator(".view-switch").boundingBox();
    expect(helpBounds!.y).toBeGreaterThanOrEqual(
      viewBounds!.y + viewBounds!.height,
    );
    await editor(page)
      .getByRole("button", { name: "Apply street", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("street-editing-mobile-actions.png"),
      fullPage: true,
    });
    await editor(page)
      .getByRole("button", { name: "Discard draft", exact: true })
      .click();
    await expect(editor(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(
      page.getByRole("button", { name: "Undo last edit", exact: true }),
    ).toBeDisabled();
    // Canceling a reshape also leaves the captured existing centerline and settings intact.
    await page
      .locator('[aria-label="Streets in this scenario"]')
      .getByRole("button", { name: /^QA street/ })
      .click();
    await page
      .getByRole("button", { name: "Reshape street path", exact: true })
      .click();
    await useCoordinates(page, coordinateText(reshaped));
    await editor(page)
      .getByRole("button", { name: "Discard draft", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "Travel lanes", exact: true }),
    ).toHaveValue("2");
    const after = (
      await downloadJson<ProjectDownload>(page, /^Complete project · JSON/)
    ).value;
    expect(after.project).toEqual(before.project);
    expect(after.place).toEqual(before.place);
    expect(after.results.revision).toBe(before.results.revision);
    expect(after.results.metrics).toEqual(before.results.metrics);
    await page
      .getByRole("combobox", { name: "Active scenario" })
      .selectOption("baseline");
    await page.getByRole("button", { name: "Mobility", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Draw a street", exact: true }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});
