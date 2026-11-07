import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCollaborationApi } from "./support/collaboration-api";

async function cityPainted(page: Page) {
  const canvas = page.locator(".city-map canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((source: HTMLCanvasElement) => {
        const sample = document.createElement("canvas");
        sample.width = sample.height = 64;
        const context = sample.getContext("2d")!;
        context.drawImage(source, 0, 0, 64, 64);
        const pixels = context.getImageData(0, 0, 64, 64).data;
        const colors = new Set<string>();
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 100)
            colors.add(
              `${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`,
            );
        }
        return colors.size;
      }),
    )
    .toBeGreaterThanOrEqual(8);
}
async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await expect(page.locator(".metric-card").first()).toBeVisible();
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".city-map canvas")).toBeVisible();
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
  // Source/map readiness can precede the first GPU scene paint. Assert actual
  // city pixels rather than accepting the initial blank canvas as ready.
  await cityPainted(page);
}
function homesCard(page: Page) {
  return page
    .locator(".metric-card")
    .filter({ has: page.locator(".metric-label", { hasText: /^Homes$/ }) });
}
async function homesValue(page: Page) {
  return Number(
    (await homesCard(page).locator(".metric-value").innerText()).replace(
      /[^\d.-]/g,
      "",
    ),
  );
}
async function browserDraftConnections(page: Page) {
  return page.evaluate(
    () =>
      new Promise<
        { id: string; cloudProjectId: string | null; version: number | null }[]
      >((resolve, reject) => {
        const request = indexedDB.open("urban-planning:workspace:v2");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("drafts", "readonly");
          const read = tx.objectStore("drafts").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(
              read.result.map((draft) => ({
                id: draft.project.id,
                cloudProjectId: draft.cloudLink?.projectId ?? null,
                version: draft.cloudLink?.version ?? null,
              })),
            );
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}
async function inspectBuilding(page: Page, name = "The Stewart", edit = true) {
  await page.getByRole("button", { name: "Open feature list" }).click();
  await page
    .getByRole("textbox", { name: "Search places or buildings" })
    .fill(name);
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.locator(".building-inspector")).toBeVisible();
  if (edit) await editSelectedBuilding(page);
}
async function editSelectedBuilding(page: Page) {
  await page
    .getByRole("button", { name: "Edit building", exact: true })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Entered homes", exact: true }),
  ).toBeVisible();
}
async function placeApartments(page: Page) {
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Apartments", exact: true }).click();
  await expect(page.locator(".placement-banner")).toBeVisible();
  const canvas = page.locator(".city-map canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Map canvas has no dimensions");
  // Try central map locations; occupied footprints intentionally cannot accept placement clicks.
  for (const [x, y] of [
    [0.5, 0.5],
    [0.35, 0.65],
    [0.65, 0.45],
    [0.4, 0.4],
    [0.55, 0.55],
    [0.7, 0.65],
    [0.3, 0.4],
    [0.6, 0.7],
  ]) {
    await canvas.click({ position: { x: box.width * x, y: box.height * y } });
    await page.waitForTimeout(150);
    if (!(await page.locator(".placement-banner").isVisible())) break;
  }
  await expect(page.locator(".placement-banner")).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "Entered homes", exact: true }),
  ).toHaveValue("48");
  await page
    .getByRole("button", { name: "Apply building", exact: true })
    .click();
  await expect(page.locator(".building-inspector")).toBeVisible();
}

test("guest explores real geometry, inspects evidence, switches views and layers", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWorkspace(page);
  await expect(
    page.getByText("Free for everyone", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".map-disclosure")).toContainText("reference area");
  await page.screenshot({
    path: testInfo.outputPath("workspace-desktop.png"),
    fullPage: true,
  });
  await homesCard(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "How it is calculated" }),
  ).toBeVisible();
  await expect(page.locator(".formula")).toContainText("dwelling units");
  await expect(
    page.getByRole("heading", { name: "Source records" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "2D plan", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "2D plan", exact: true }),
  ).toHaveClass(/active/);
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page.getByRole("checkbox", { name: "City activity" }).uncheck();
  await expect(
    page.getByRole("checkbox", { name: "City activity" }),
  ).not.toBeChecked();
  await expect(page.locator(".city-map-activity")).toHaveText(
    "Activity hidden",
  );
  await page
    .getByRole("checkbox", { name: "Buildings", exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "Buildings", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Buildings", exact: true }).check();
  const imageryTile = page.waitForResponse((response) =>
    /World_Imagery\/MapServer\/tile\/|api\.maptiler\.com\/tiles\/satellite/.test(response.url()) &&
    response.ok() && response.headers()["content-type"]?.startsWith("image/"),
  );
  await page.getByRole("button", { name: "Satellite", exact: true }).click();
  await imageryTile;
  await expect(page.locator(".city-map-error")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("satellite-view.png") });
  await expect(page.locator(".city-map-attribution")).toContainText(
    /Esri|MapTiler/,
  );
  expect(errors).toEqual([]);
});

test("placing and editing a building updates metrics, undo/redo restores them, branches preserve baseline", async ({
  page,
}) => {
  await openWorkspace(page);
  const originalHomes = await homesValue(page);
  await placeApartments(page);
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 48);
  await editSelectedBuilding(page);
  await page
    .getByRole("spinbutton", { name: "Entered homes", exact: true })
    .fill("120");
  await page
    .getByRole("button", { name: "Apply building", exact: true })
    .click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 120);
  await page.getByRole("button", { name: "Undo last edit" }).click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 48);
  await page.getByRole("button", { name: "Redo edit" }).click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 120);
  await page
    .getByRole("button", { name: "Create scenario", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Scenario name" })
    .fill("E2E: more homes");
  await page.getByRole("button", { name: "Create alternative" }).click();
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toContainText("E2E: more homes");
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 120);
  await inspectBuilding(page, "New apartments");
  await page
    .getByRole("spinbutton", { name: "Entered homes", exact: true })
    .fill("200");
  await page
    .getByRole("button", { name: "Apply building", exact: true })
    .click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 200);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clearer view of the alternatives." }),
  ).toBeVisible();
  await expect(page.locator(".comparison-table")).toContainText("Homes");
  await expect(page.locator(".comparison-table")).toContainText(
    "E2E: more homes",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Active scenario" })
    .selectOption("baseline");
  await expect.poll(() => homesValue(page)).toBe(originalHomes);
  await inspectBuilding(page, "The Stewart", false);
  await expect(
    page.getByRole("button", { name: "Edit building", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reshape footprint", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("spinbutton", { name: "Entered homes", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Apply building", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Open an editable alternative to change this building.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("a browser draft survives reload and editable-source changes are reflected in the scorecard", async ({
  page,
}) => {
  await openWorkspace(page);
  const originalHomes = await homesValue(page);
  await inspectBuilding(page);
  const units = Number(
    await page
      .getByRole("spinbutton", { name: "Entered homes", exact: true })
      .inputValue(),
  );
  await page
    .getByRole("spinbutton", { name: "Entered homes", exact: true })
    .fill(String(units + 25));
  await page
    .getByRole("button", { name: "Apply building", exact: true })
    .click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 25);
  await page.reload();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 25);
  await page.getByRole("button", { name: "View history" }).click();
  await expect(page.getByRole("dialog")).toContainText("Modify The Stewart");
});

test("free account saves a project and publishes an immutable read-only snapshot", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const isolatedApi = await createCollaborationApi(new URL(baseURL!).origin, {
    placeFile: fileURLToPath(
      new URL("../../public/data/phoenix.json", import.meta.url),
    ),
  });
  try {
    await isolatedApi.connect(page.context());
    await openWorkspace(page);
    await expect.poll(() => browserDraftConnections(page)).toHaveLength(1);
    const [anonymousDraft] = await browserDraftConnections(page);
    expect(anonymousDraft.cloudProjectId).toBeNull();
    const name = `QA Planner ${Date.now()}`;
    const email = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@urban-planning.test`;
    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Your name" }).fill(name);
    await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await page
      .getByLabel(/^Password/)
      .fill(`Test-only-${Date.now()}-local-account`);
    await page.getByRole("button", { name: "Create free account" }).click();
    await expect(page.locator(".account-button")).toContainText(name);
    await page.getByRole("button", { name: "Open project home" }).click();
    const firstSave = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/projects" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save current project to account" })
      .click();
    const firstResponse = await firstSave;
    expect(firstResponse.status()).toBe(201);
    const saved = (await firstResponse.json()) as {
      project: { id: string };
      version: number;
    };
    expect(saved.project.id).not.toBe(anonymousDraft.id);
    await expect(
      page.getByRole("heading", { name: "Saved projects" }),
    ).toBeVisible();
    // Adopting the server identity must retain the open dialog and replace the
    // anonymous browser draft, rather than leaving an editable-looking duplicate.
    const browserDrafts = page.getByRole("region", { name: "On this browser" });
    await expect(browserDrafts.locator("button.search-result")).toHaveCount(1);
    await expect(browserDrafts.locator("button.search-result")).toBeDisabled();
    await expect
      .poll(() => browserDraftConnections(page))
      .toEqual([
        {
          id: saved.project.id,
          cloudProjectId: saved.project.id,
          version: saved.version,
        },
      ]);
    await page.screenshot({
      path: testInfo.outputPath("first-cloud-save-project-home.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Build", exact: true }),
    ).toBeEnabled();
    await inspectBuilding(page);
    await expect(
      page.getByRole("spinbutton", { name: "Entered homes", exact: true }),
    ).toBeEnabled();
    const firstSaveHomes = await homesValue(page);
    const editableHomes = page.getByRole("spinbutton", {
      name: "Entered homes",
      exact: true,
    });
    await editableHomes.fill(
      String(Number(await editableHomes.inputValue()) + 1),
    );
    await expect(
      page.getByRole("button", { name: "Apply building", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("first-cloud-save-editable.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    await expect.poll(() => homesValue(page)).toBe(firstSaveHomes + 1);
    await page.getByRole("button", { name: "Open project home" }).click();
    await page
      .getByRole("button", { name: "Save current project to account" })
      .click();
    await expect
      .poll(() => browserDraftConnections(page))
      .toEqual([
        {
          id: saved.project.id,
          cloudProjectId: saved.project.id,
          version: saved.version + 1,
        },
      ]);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.reload();
    await expect(page.locator(".account-button")).toContainText(name);
    await page.getByRole("button", { name: "Open project home" }).click();
    const savedProject = page
      .getByRole("region", { name: "Saved account projects" })
      .locator("button.search-result")
      .first();
    await expect(savedProject).toBeVisible();
    await savedProject.click();
    await expect(
      page.getByText("Project reopened.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", { name: "Published link" });
    await expect(link).toBeVisible();
    const publicUrl = await link.inputValue();
    const publicContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    try {
      await isolatedApi.connect(publicContext);
      const publicPage = await publicContext.newPage();
      await publicPage.goto(publicUrl);
      await expect(publicPage.getByText(/read.only/i).first()).toBeVisible();
      await expect(
        publicPage.getByRole("button", { name: "Build", exact: true }),
      ).toHaveCount(0);
      await expect(
        publicPage.getByRole("button", { name: "Apply building", exact: true }),
      ).toHaveCount(0);
      await expect(
        publicPage.getByRole("button", {
          name: "Create scenario",
          exact: true,
        }),
      ).toHaveCount(0);
      const frozenHomes = await publicPage
        .locator(".shared-metric")
        .filter({
          has: publicPage.locator(".shared-metric-name", {
            hasText: /^Homes$/,
          }),
        })
        .locator(".shared-metric-value")
        .innerText();
      await page
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await inspectBuilding(page);
      const units = Number(
        await page
          .getByRole("spinbutton", { name: "Entered homes", exact: true })
          .inputValue(),
      );
      await page
        .getByRole("spinbutton", { name: "Entered homes", exact: true })
        .fill(String(units + 5));
      await page
        .getByRole("button", { name: "Apply building", exact: true })
        .click();
      await page.getByRole("button", { name: "Open project home" }).click();
      await page
        .getByRole("button", { name: "Save current project to account" })
        .click();
      await expect(
        page.getByText("Project saved to your private workspace.", {
          exact: true,
        }),
      ).toBeVisible();
      await publicPage.reload();
      await expect(
        publicPage
          .locator(".shared-metric")
          .filter({
            has: publicPage.locator(".shared-metric-name", {
              hasText: /^Homes$/,
            }),
          })
          .locator(".shared-metric-value"),
      ).toHaveText(frozenHomes, { useInnerText: true });
      await cityPainted(publicPage);
      await publicPage.screenshot({
        path: testInfo.outputPath("public-snapshot-desktop.png"),
        fullPage: true,
      });
    } finally {
      await publicContext.close();
    }
  } finally {
    await isolatedApi.close();
  }
});

test("narrow layout remains navigable without horizontal overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openWorkspace(page);
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("workspace-tablet.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Methodology", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The evidence behind the picture." }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("methodology-tablet.png"),
    fullPage: true,
  });
});

test("PNG export includes the active scenario revision and source attribution", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  await inspectBuilding(page);
  const units = Number(
    await page
      .getByRole("spinbutton", { name: "Entered homes", exact: true })
      .inputValue(),
  );
  await page
    .getByRole("spinbutton", { name: "Entered homes", exact: true })
    .fill(String(units + 3));
  await page
    .getByRole("button", { name: "Apply building", exact: true })
    .click();
  const scenarioName = await page
    .getByRole("combobox", { name: "Active scenario" })
    .locator("option:checked")
    .innerText();
  const canvasSize = await page
    .locator(".city-map canvas")
    .evaluate((canvas: HTMLCanvasElement) => ({
      width: canvas.width,
      height: canvas.height,
    }));
  await page
    .getByRole("button", { name: "Before / after", exact: true })
    .click();
  await expect(
    page.getByRole("slider", { name: "Before / after reveal", exact: true }),
  ).toHaveValue("50");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator(".city-map-reveal")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toContainText("Revision 1");
  // Observe the text actually burned into the exported canvas, alongside the downloaded bitmap.
  await page.evaluate(() => {
    const texts: string[] = [];
    Object.assign(window, { exportCanvasTexts: texts });
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      x,
      y,
      maxWidth,
    ) {
      texts.push(text);
      if (maxWidth === undefined) fill.call(this, text, x, y);
      else fill.call(this, text, x, y, maxWidth);
    };
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /City view · PNG/ }).click();
  const download = await downloadPromise;
  const imagePath = testInfo.outputPath("scenario-export.png");
  await download.saveAs(imagePath);
  const png = await readFile(imagePath);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.readUInt32BE(16)).toBe(canvasSize.width);
  expect(png.readUInt32BE(20)).toBeGreaterThan(canvasSize.height + 90);
  const text = await page.evaluate(() =>
    (
      window as unknown as { exportCanvasTexts: string[] }
    ).exportCanvasTexts.join(" "),
  );
  expect(text).toContain(
    `Right / after: ${scenarioName} · Revision 1 · 50% of view`,
  );
  expect(text).toContain("Left / before: Baseline · Revision 0 · 50% of view");
  expect(text).toContain("© OpenStreetMap contributors");
  expect(text).toContain("ODbL 1.0");
});

test("captured source survives a catalog refresh and complete JSON restoration", async ({
  page,
}, testInfo) => {
  const original = JSON.parse(
    await readFile("public/data/phoenix.json", "utf8"),
  );
  const refreshed = structuredClone(original);
  refreshed.buildings.find(
    (b: { name: string }) => b.name === "The Stewart",
  ).units += 1000;
  refreshed.loadedAt = "2030-01-01T00:00:00.000Z";
  refreshed.sources[0].vintage = "2030";
  let source = original,
    refreshedRequests = 0;
  await page.route("**/data/phoenix.json", async (route) => {
    if (source === refreshed) refreshedRequests++;
    await route.fulfill({ json: source });
  });
  await openWorkspace(page);
  const originalHomes = await homesValue(page);
  await inspectBuilding(page);
  const units = Number(
    await page
      .getByRole("spinbutton", { name: "Entered homes", exact: true })
      .inputValue(),
  );
  await page
    .getByRole("spinbutton", { name: "Entered homes", exact: true })
    .fill(String(units + 3));
  await page
    .getByRole("button", { name: "Apply building", exact: true })
    .click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 3);
  await expect(
    page.getByText("Browser draft saved", { exact: true }),
  ).toBeVisible();
  source = refreshed;
  await page.reload();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 3);
  expect(refreshedRequests).toBe(0);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Complete project · JSON/ }).click();
  const download = await downloadPromise,
    path = testInfo.outputPath("captured-project.json");
  await download.saveAs(path);
  const bytes = await readFile(path),
    snapshot = JSON.parse(bytes.toString());
  expect(snapshot.place).toEqual(original);
  expect(snapshot.baselineIdentity.sha256).toMatch(/^[a-f0-9]{64}$/);
  // Clear only this isolated test browser's draft, then load the changed catalog as a genuinely new project.
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("urban-planning:workspace:v2");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Test database still open"));
      }),
  );
  await page.reload();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 1000);
  expect(refreshedRequests).toBe(1);
  await inspectBuilding(page);
  await page
    .getByRole("spinbutton", { name: "Entered homes", exact: true })
    .fill(String(units + 1007));
  await page
    .getByRole("button", { name: "Apply building", exact: true })
    .click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 1007);
  await expect(
    page.getByText("Browser draft saved", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Import data", exact: true }).click();
  await page
    .getByRole("button", { name: "Saved project", exact: true })
    .click();
  await page.locator("input[type=file]").setInputFiles({
    name: "captured-project.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await page
    .getByRole("button", { name: "Restore as a copy", exact: true })
    .click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 3);
  await page.reload();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 3);
  expect(refreshedRequests).toBe(1);
  await page.getByRole("button", { name: "Open project home" }).click();
  const browserDrafts = page.getByRole("region", { name: "On this browser" });
  const originalDraft = browserDrafts
    .locator("button.search-result")
    .filter({ has: page.getByText(snapshot.project.name, { exact: true }) });
  await expect(originalDraft).toContainText("Source captured 2030-01-01");
  await originalDraft.click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 1007);
  await page.getByRole("button", { name: "Open project home" }).click();
  const restoredCopy = page
    .getByRole("region", { name: "On this browser" })
    .getByRole("button", { name: /restored copy/ });
  await restoredCopy.click();
  await expect.poll(() => homesValue(page)).toBe(originalHomes + 3);
  await page.screenshot({
    path: testInfo.outputPath("restored-copy-workspace.png"),
    fullPage: true,
  });
});
