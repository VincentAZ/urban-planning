import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  baselineIdentity,
  lineWithinStudyArea,
  pointInStudyArea,
  type Place,
} from "../../packages/core/src/index";
import { createPlacesApi } from "./support/places-api";

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".city-map canvas")).toBeVisible();
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
}
async function finder(page: Page) {
  await page.getByRole("button", { name: "Open feature list" }).click();
  await expect(
    page.getByRole("heading", { name: "Find your place" }),
  ).toBeVisible();
}
async function search(page: Page, query: string) {
  await page
    .getByRole("textbox", { name: "Search places or buildings" })
    .fill(query);
  await page
    .getByRole("button", { name: "Search places", exact: true })
    .click();
}
async function register(page: Page) {
  await page
    .getByRole("button", {
      name: "Free account to prepare this area",
      exact: true,
    })
    .click();
  const name = "Isolated national QA planner";
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`national-${Date.now()}@urban-planning.test`);
  await page
    .getByLabel(/^Password/)
    .fill("Synthetic-national-test-account-only-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(name);
  await expect(
    page.getByRole("button", { name: "Prepare this area · free", exact: true }),
  ).toBeVisible();
}
async function homesValue(page: Page) {
  const text = await page
    .locator(".metric-card")
    .filter({ has: page.locator(".metric-label", { hasText: /^Homes$/ }) })
    .locator(".metric-value")
    .innerText();
  return Number(text.replace(/[^\d.-]/g, ""));
}
const progress = (page: Page) =>
  page.getByRole("region", { name: "Place preparation progress" });
async function startZip(page: Page, zip: string) {
  await search(page, zip);
  await expect(
    page.getByRole("region", { name: "Selected study area" }),
  ).toContainText(zip);
  await page
    .getByRole("button", { name: "Prepare this area · free", exact: true })
    .click();
}

test("national city search prepares exact geometry, saves edits and reopens the same captured source", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000);
  const api = await createPlacesApi(new URL(baseURL!).origin),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await openWorkspace(page);
    await finder(page);
    await page
      .getByRole("textbox", { name: "Search places or buildings" })
      .fill("Chicago, IL");
    expect(
      (await api.calls()).filter((call) => call.kind === "search"),
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Search places", exact: true })
      .click();
    await page
      .getByRole("region", { name: "National search results" })
      .getByRole("button", { name: /Chicago, IL · QA search fixture/ })
      .click();
    await expect(
      page.getByRole("region", { name: "Selected study area" }),
    ).toContainText("60601");
    await expect(
      page.getByRole("region", { name: "Selected study area" }),
    ).toContainText("not city limits or taxing jurisdictions");
    expect(
      (await api.calls()).find((call) => call.kind === "locate")?.position,
    ).toEqual([-87.62, 41.89]);
    await register(page);
    await page
      .getByRole("button", { name: "Prepare this area · free", exact: true })
      .click();
    await expect(progress(page)).toContainText("60601");
    await expect(
      page.getByRole("progressbar", { name: "Preparation of ZCTA 60601" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await finder(page);
    const recent = page
      .getByRole("region", { name: "Your recent place requests" })
      .getByRole("button", { name: /ZCTA 60601/ });
    await expect(recent).toBeVisible();
    await recent.click();
    await expect(
      page.getByRole("button", { name: "Open ZCTA 60601", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Open ZCTA 60601", exact: true })
      .click();
    await expect(page.locator(".map-disclosure")).toContainText(
      "Synthetic QA ZCTA 60601",
    );
    await expect(page.locator(".map-area-label")).toContainText("ZCTA 60601");
    await expect.poll(() => homesValue(page)).toBe(48);
    await finder(page);
    await page
      .getByRole("textbox", { name: "Search places or buildings" })
      .fill("QA apartments");
    await page
      .getByRole("region", { name: "Buildings in the current place" })
      .getByRole("button", { name: /QA apartments/ })
      .click();
    await page
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    await page
      .getByRole("spinbutton", { name: "Entered homes", exact: true })
      .fill("60");
    await page
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    await expect.poll(() => homesValue(page)).toBe(60);
    await page
      .getByRole("button", { name: "Data and methodology", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Synthetic QA data only",
    );
    await expect(page.getByRole("dialog")).toContainText(
      "Synthetic exact study-area fixture",
    );
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.getByRole("button", { name: "Open project home" }).click();
    await page
      .getByRole("button", {
        name: "Save current project to account",
        exact: true,
      })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Saved account projects" })
        .locator("button.search-result"),
    ).toHaveCount(1);
    const saved = (await api.persistedState()).projects[0];
    const captured = saved.baseline;
    expect(captured.studyArea?.type).toBe("MultiPolygon");
    if (captured.studyArea?.type !== "MultiPolygon")
      throw new Error("Exact multipolygon was not saved");
    expect(captured.studyArea.coordinates).toHaveLength(2);
    expect(captured.studyArea.coordinates[0]).toHaveLength(2);
    expect(pointInStudyArea([-87.624, 41.891], captured)).toBe(false);
    expect(pointInStudyArea([-87.605, 41.89], captured)).toBe(true);
    expect(captured.roads).toHaveLength(3);
    expect(
      captured.roads.every((road) =>
        lineWithinStudyArea(road.coordinates, captured),
      ),
    ).toBe(true);
    const identity = await baselineIdentity(captured);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await api.restart();
    await page.reload();
    await expect.poll(() => homesValue(page)).toBe(60);
    await page.getByRole("button", { name: "Open project home" }).click();
    await page
      .getByRole("region", { name: "Saved account projects" })
      .locator("button.search-result")
      .click();
    await expect(
      page.getByText("Project reopened.", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => homesValue(page)).toBe(60);
    await page.getByRole("button", { name: "2D plan", exact: true }).click();
    await expect(page.locator(".city-map-loading")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("national-fixture-workspace.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Complete project · JSON/ }).click();
    const download = await downloadPromise,
      path = testInfo.outputPath("national-captured-project.json");
    await download.saveAs(path);
    const exported = JSON.parse(await readFile(path, "utf8")) as {
      place: Place;
      baselineIdentity: { sha256: string };
      project: { id: string };
    };
    expect(exported.place).toEqual(captured);
    expect(exported.baselineIdentity.sha256).toBe(identity.sha256);
    expect(exported.project.id).toBe(saved.project.id);
    expect((await api.persistedState()).projects[0].baseline).toEqual(captured);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("map lookup, explicit preparation failures, retry, cancellation and free limits preserve the original draft", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000);
  const api = await createPlacesApi(new URL(baseURL!).origin),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await openWorkspace(page);
    const originalHomes = await homesValue(page);
    await finder(page);
    await page
      .getByRole("tab", { name: "Choose on the map", exact: true })
      .click();
    await expect(page.locator(".locator-map canvas")).toBeVisible();
    await page
      .getByRole("button", { name: "Find ZIP at map center", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Selected study area" }),
    ).toContainText("60601");
    const lookup = (await api.calls()).find((call) => call.kind === "locate");
    expect(lookup?.position).toBeDefined();
    expect(lookup?.position?.every(Number.isFinite)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("national-place-locator.png"),
      fullPage: true,
    });
    await register(page);
    await page
      .getByRole("tab", { name: "Search & prepared places", exact: true })
      .click();
    await startZip(page, "99999");
    await expect(progress(page)).toContainText("50 km² study-area limit");
    await expect(
      progress(page).getByRole("button", { name: "Retry preparation" }),
    ).toHaveCount(0);
    await startZip(page, "99998");
    await expect(progress(page)).toContainText("temporarily unavailable");
    await page
      .getByRole("button", { name: "Retry preparation", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Open ZCTA 99998", exact: true }),
    ).toBeVisible();
    await expect(progress(page)).toContainText("Attempt 2");
    await startZip(page, "99997");
    await expect(
      page.getByRole("progressbar", { name: "Preparation of ZCTA 99997" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Cancel preparation", exact: true })
      .click();
    await expect(progress(page)).toContainText("request was cancelled");
    await startZip(page, "99996");
    await expect(page.locator(".place-search-error").first()).toContainText(
      /three|3/,
    );
    await expect(page.locator(".place-search-error").first()).toContainText(
      "day",
    );
    const jobs = (await api.persistedState()).preparationJobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.find((job) => job.zip === "99999")?.status).toBe("failed");
    expect(jobs.find((job) => job.zip === "99998")?.status).toBe("completed");
    expect(jobs.find((job) => job.zip === "99997")?.status).toBe("cancelled");
    expect(jobs.some((job) => job.zip === "99996")).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("national-free-queue-limits.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(page.locator(".map-disclosure")).toContainText(
      "reference area",
    );
    await expect.poll(() => homesValue(page)).toBe(originalHomes);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

// These are the committed bundles captured from Census TIGERweb + OpenStreetMap,
// separate from the synthetic provider server above. No live provider requests are made.
test("captured Phoenix and Chicago ZCTAs retain their complete Census boundary and render with community context", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWorkspace(page);
  for (const zip of ["85004", "60601"]) {
    const place = JSON.parse(
      await readFile(`public/data/zcta-${zip}-2020.json`, "utf8"),
    ) as Place;
    const identity = await baselineIdentity(place);
    const manifest = JSON.parse(
      await readFile(`public/data/manifests/${identity.sha256}.json`, "utf8"),
    ) as { sourceFile: string };
    const archivedSource = JSON.parse(
      await readFile(`public${manifest.sourceFile}`, "utf8"),
    ) as { boundary: { feature: { geometry: unknown } } };
    expect(place.studyArea).toEqual(archivedSource.boundary.feature.geometry);
    expect(place.demographics?.geography.id).toBe(zip);
    expect(place.buildings.length).toBeGreaterThan(300);
    expect(place.roads.length).toBeGreaterThan(2000);
    await finder(page);
    await page
      .getByRole("region", { name: "Prepared places" })
      .getByRole("button", { name: new RegExp(`^ZIP area ${zip}\\b`) })
      .click();
    await expect(page.locator(".map-disclosure")).toContainText(
      `Census 2020 ZCTA ${zip}`,
    );
    await expect(page.locator(".map-area-label")).toContainText(`ZCTA ${zip}`);
    await expect(page.locator(".city-map-loading")).toHaveCount(0);
    await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(page.locator(".city-map canvas")).toBeVisible();
    const credits = page.locator(".city-map-attribution");
    await expect(
      credits.getByRole("link", { name: "© OpenStreetMap", exact: true }),
    ).toBeVisible();
    await credits.locator("summary").click();
    await expect(
      credits.getByRole("link", { name: "U.S. Census Bureau", exact: true }),
    ).toBeVisible();
    const panelBounds = await credits
      .locator(".city-map-credit-panel")
      .boundingBox();
    const playbackBounds = await page.locator(".map-bottom-bar").boundingBox();
    expect(
      panelBounds &&
        playbackBounds &&
        panelBounds.y + panelBounds.height <= playbackBounds.y,
    ).toBe(true);
    await credits.locator("summary").click();
    await page.screenshot({
      path: testInfo.outputPath(`real-zcta-${zip}-workspace.png`),
      fullPage: true,
    });
    const community = page.getByRole("region", { name: "Community context" });
    await expect(community).toContainText(`ZCTA ${zip}`);
    await expect(community).toContainText("2020–2024 ACS");
    await expect(community).toContainText("90% MOE");
    await expect(community).toContainText(
      zip === "85004" ? "12,408" : "15,235",
    );
    await page
      .getByRole("button", { name: "Data and methodology", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("ODbL 1.0");
    await expect(page.getByRole("dialog")).toContainText(
      "U.S. Census Bureau public data",
    );
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await finder(page);
  const searchTab = page.getByRole("tab", {
    name: "Search & prepared places",
    exact: true,
  });
  await searchTab.focus();
  await page.keyboard.press("ArrowRight");
  const mapTab = page.getByRole("tab", {
    name: "Choose on the map",
    exact: true,
  });
  await expect(mapTab).toBeFocused();
  await expect(mapTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".locator-map canvas")).toBeVisible();
  const canvasBounds = await page.locator(".locator-map canvas").boundingBox();
  if (!canvasBounds)
    throw new Error("The mobile locator canvas has no bounds.");
  for (const name of ["Zoom place locator in", "Zoom place locator out"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    if (!bounds) throw new Error(`${name} has no bounds.`);
    expect(bounds.x).toBeGreaterThanOrEqual(canvasBounds.x);
    expect(bounds.y).toBeGreaterThanOrEqual(canvasBounds.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      canvasBounds.x + canvasBounds.width,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      canvasBounds.y + canvasBounds.height,
    );
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  const dialog = page.getByRole("dialog");
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("national-finder-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
