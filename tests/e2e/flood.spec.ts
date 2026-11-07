import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createCollaborationApi } from "./support/collaboration-api";
import {
  baselineIdentity,
  FLOOD_LEGACY_METHOD_VERSION,
  FLOOD_METHOD_VERSION,
  type ProjectSnapshot,
} from "../../packages/core/src/index";
import { floodFixture } from "../fixtures/flood";
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Flood evidence", exact: true });
async function open(page: Page) {
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page
    .getByRole("button", {
      name: /^(Explore flood evidence|Review flood exposure)$/,
    })
    .click();
  await expect(dialog(page)).toBeVisible();
}
async function close(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
}
async function attach(page: Page) {
  await open(page);
  await dialog(page)
    .getByRole("button", { name: "Attach flood map", exact: true })
    .click();
  await expect(dialog(page).getByText(/Map attached/)).toBeVisible();
  await expect(
    dialog(page).getByText("Calculating footprint intersections…"),
  ).toHaveCount(0);
}
async function saved(page: Page) {
  await expect(page.locator(".project-status")).toContainText(
    "Browser draft saved",
  );
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
}

test("retained flood attachment follows real building edits, undo, saved account and frozen public evidence", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(baseURL!, { floodFixture: true });
  await api.connect(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const publicContext = await browser.newContext();
  try {
    await page.goto("/");
    await attach(page);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "10",
      "10",
    ]);
    await dialog(page)
      .getByRole("button", { name: "wet", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    await page.getByLabel("Entered homes", { exact: true }).fill("20");
    await page
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    await page
      .locator('[aria-label="Building inspector"]')
      .getByRole("button", { name: "Review flood evidence", exact: true })
      .click();
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "10",
      "20",
    ]);
    await dialog(page)
      .locator("summary")
      .filter({ hasText: "Source, effective dates & coverage" })
      .click();
    await expect(dialog(page)).toContainText("2013-10-16");
    await page.screenshot({
      path: info.outputPath("flood-exposure-desktop.png"),
      fullPage: false,
    });
    const downloadPromise = page.waitForEvent("download");
    await dialog(page)
      .getByRole("button", {
        name: "Download all flood exposure · CSV",
        exact: true,
      })
      .click();
    const file = await downloadPromise;
    const csv = await readFile((await file.path())!, "utf8");
    expect(csv.split("\r\n")).toHaveLength(5);
    expect(csv).toContain('"20"');
    expect(csv).toContain('"baseline"');
    const retainedHash = csv.match(/"([a-f0-9]{64})","server-catalog"/)?.[1];
    expect(retainedHash).toMatch(/^[a-f0-9]{64}$/);
    const currentRevision = (
      await dialog(page).locator(".flood-attached").innerText()
    ).match(/scenario r(\d+)/)?.[1];
    expect(currentRevision).toMatch(/^\d+$/);
    await close(page);

    // This comparison now runs in one background worker, including a baseline
    // screened against the same selected source rather than its unattached state.
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const comparison = page.getByRole("dialog", {
      name: "A clearer view of the alternatives.",
      exact: true,
    });
    await expect(comparison.locator(".comparison-table")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(comparison).toContainText(
      "Baseline flood screening uses the same captured map",
    );
    const floodRow = comparison.getByRole("row").filter({
      has: page.getByText("Homes in SFHA-intersecting buildings", {
        exact: true,
      }),
    });
    await expect(floodRow).toHaveCount(1);
    await expect(floodRow.locator("td").nth(1)).toHaveText("10");
    await expect(floodRow.locator("td").nth(2)).toHaveText("20");
    await close(page);

    // Export the current browser draft before account save. The downloaded
    // document must reuse the current worker result, including its exact source.
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const exportDialog = page.getByRole("dialog", {
      name: "Take the story with you.",
      exact: true,
    });
    const reportDownload = page.waitForEvent("download");
    await exportDialog.getByRole("button", { name: /^Browser report/ }).click();
    const report = await reportDownload;
    expect(report.suggestedFilename()).toBe("urban-planning-report.html");
    const html = await readFile((await report.path())!, "utf8");
    const evidence = await page.evaluate((contents) => {
      const doc = new DOMParser().parseFromString(contents, "text/html");
      const section = Array.from(doc.querySelectorAll("section")).find(
        (element) =>
          element.querySelector("h2")?.textContent ===
          "Captured flood-map exposure",
      );
      return {
        text: section?.textContent ?? "",
        rows: Array.from(section?.querySelectorAll("tbody tr") ?? []).map(
          (row) =>
            Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
        ),
        revision: doc.querySelector("p.muted")?.textContent ?? "",
      };
    }, html);
    expect(evidence.revision).toContain(`Revision ${currentRevision}`);
    expect(evidence.text).toContain(
      "Potential homes in intersecting buildings: baseline 10; proposal 20.",
    );
    expect(evidence.text).toContain(retainedHash!);
    expect(evidence.text).toContain("Synthetic flood test source");
    expect(evidence.text).toContain("Test only");
    expect(evidence.text).toContain("not prorated by area");
    expect(evidence.rows).toEqual([
      ["wet", "SFHA footprint intersection", "20", "sfha"],
      ["clear", "No SFHA intersection in mapped footprint", "5", "x"],
    ]);
    await close(page);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await open(page);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "10",
      "10",
    ]);
    await close(page);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await saved(page);
    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("Flood Planner");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("flood-planner@urban-planning.test");
    await page.getByLabel(/^Password/).fill("Isolated-flood-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await page.getByRole("button", { name: "Open project home" }).click();
    await page
      .getByRole("button", {
        name: "Save current project to account",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Project saved to your private workspace.", {
        exact: true,
      }),
    ).toBeVisible();
    await close(page);
    await saved(page);
    await page.reload();
    await open(page);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "10",
      "20",
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog(page)
      .getByRole("searchbox", { name: "Find a building", exact: true })
      .fill("wet");
    await expect(dialog(page).locator(".flood-buildings article")).toHaveCount(
      1,
    );
    await noOverflow(page);
    await dialog(page).locator(".flood-table-heading").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("flood-exposure-mobile.png"),
      fullPage: false,
    });
    await close(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", { name: "Published link" });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    await publicPage.goto(url);
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await expect(publicPage.locator(".flood-totals strong")).toHaveText([
      "10",
      "20",
    ]);
    await expect(
      publicPage.getByRole("button", { name: "Attach flood map", exact: true }),
    ).toHaveCount(0);
    await publicPage.screenshot({
      path: info.outputPath("flood-public-readonly.png"),
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("partial flood coverage and unknown homes stay explicit on mobile and removal remains reversible", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(baseURL!, {
    floodPartialFixture: true,
  });
  await api.connect(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await attach(page);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "Unavailable",
      "Unavailable",
    ]);
    await expect(dialog(page)).toContainText(
      "1 building with unresolved home quantities",
    );
    await expect(dialog(page)).toContainText(
      "1 building with undetermined coverage affecting the total",
    );
    await dialog(page)
      .getByRole("combobox", { name: "Footprint screen", exact: true })
      .selectOption("undetermined");
    await expect(dialog(page).locator(".flood-buildings article")).toHaveCount(
      1,
    );
    await expect(dialog(page).locator(".flood-buildings")).toContainText(
      "clear",
    );
    await noOverflow(page);
    await dialog(page).locator(".flood-totals").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("flood-partial-mobile.png"),
      fullPage: false,
    });
    const remove = dialog(page).getByRole("button", {
      name: "Remove flood map from scenario",
      exact: true,
    });
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page).getByText(/Map attached/)).toHaveCount(0);
    await close(page);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await saved(page);
    await page.reload();
    await open(page);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "Unavailable",
      "Unavailable",
    ]);
  } finally {
    await api.close();
  }
});

// The fixture is a complete legacy export, restored through the public import UI.
// All saves/publications below use the actual isolated HTTP service; no application
// state or session is injected into the browser.
test("legacy flood method upgrades explicitly, undoes exactly, and leaves the old public snapshot frozen", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(baseURL!, { floodFixture: true });
  const fixture = await floodFixture();
  const input: ProjectSnapshot = {
    project: fixture.project,
    place: fixture.place,
    baselineIdentity: await baselineIdentity(fixture.place),
  };
  const originalReference = fixture.scenario.flood!;
  expect(originalReference).not.toHaveProperty("methodVersion");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const publicContext = await browser.newContext();
  const method = () =>
    dialog(page).getByRole("region", {
      name: "Flood calculation method",
      exact: true,
    });
  const active = (snapshot: ProjectSnapshot) =>
    snapshot.project.scenarios.find(
      (scenario) => scenario.id === snapshot.project.activeScenarioId,
    )!;
  async function downloadProject() {
    await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const pending = page.waitForEvent("download");
    await page
      .getByRole("dialog")
      .getByRole("button", {
        name: /^Complete project · JSON/,
      })
      .click();
    const file = await pending;
    const result = JSON.parse(
      await readFile((await file.path())!, "utf8"),
    ) as ProjectSnapshot;
    await close(page);
    return result;
  }
  async function saveAccountProject() {
    await page.getByRole("button", { name: "Open project home" }).click();
    const response = page.waitForResponse(
      (response) =>
        /\/api\/v1\/projects(?:\/[^/]+)?$/.test(
          new URL(response.url()).pathname,
        ) && ["POST", "PUT"].includes(response.request().method()),
    );
    await page
      .getByRole("button", {
        name: "Save current project to account",
        exact: true,
      })
      .click();
    expect((await response).ok()).toBe(true);
    await expect(
      page.getByRole("button", {
        name: "Save current project to account",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.getByText("Project saved to your private workspace.", {
        exact: true,
      }),
    ).toBeVisible();
    await close(page);
    await saved(page);
  }
  async function publicSnapshot(publicPage: Page, url: string) {
    const response = publicPage.waitForResponse(
      (response) =>
        /\/api\/v1\/published\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "GET",
    );
    await publicPage.goto(url);
    const received = await response;
    expect(received.ok()).toBe(true);
    const snapshot = await received.json();
    expect(snapshot.scenario.flood).toEqual(originalReference);
    expect(snapshot.floodDataset).toEqual(fixture.dataset);
    await publicPage
      .getByRole("button", {
        name: "Read the frozen assumptions",
        exact: true,
      })
      .click();
    const selectedMethod = publicPage.getByRole("region", {
      name: "Flood calculation method",
      exact: true,
    });
    await expect(selectedMethod).toContainText(FLOOD_LEGACY_METHOD_VERSION);
    await expect(selectedMethod).not.toContainText(FLOOD_METHOD_VERSION);
    await expect(publicPage.locator(".flood-totals strong")).toHaveText([
      "10",
      "10",
    ]);
    await expect(
      publicPage.getByRole("button", {
        name: "Update calculation method",
        exact: true,
      }),
    ).toHaveCount(0);
    return snapshot;
  }
  try {
    await api.connect(page);
    await page.goto("/");
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Import data", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Saved project", exact: true })
      .click();
    await page
      .getByLabel("Exported project JSON", { exact: true })
      .setInputFiles({
        name: "legacy-flood-project.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(input)),
      });
    await page
      .getByRole("button", { name: "Restore as a copy", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await open(page);
    await expect(method()).toContainText(FLOOD_LEGACY_METHOD_VERSION);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "10",
      "10",
    ]);
    await expect(
      method().getByRole("button", {
        name: "Update calculation method",
        exact: true,
      }),
    ).toBeEnabled();
    await close(page);
    const legacy = await downloadProject();
    expect(active(legacy).flood).toEqual(originalReference);
    expect(legacy.project.floodDatasets).toEqual(input.project.floodDatasets);
    expect(legacy.place).toEqual(input.place);

    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("Legacy Flood Planner");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("legacy-flood@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-legacy-flood-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "Legacy Flood Planner",
    );
    await saveAccountProject();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", { name: "Published link" });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    await close(page);
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    publicPage.on("pageerror", (error) => errors.push(error.message));
    const publishedBefore = await publicSnapshot(publicPage, url);

    // Preserve a real legacy branch to expose mixed-method comparison honestly.
    await page
      .getByRole("button", { name: "Create scenario", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Scenario name", exact: true })
      .fill("Retained legacy comparison");
    await page
      .getByRole("button", { name: "Create alternative", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Active scenario" })
      .selectOption(fixture.scenario.id);
    await open(page);
    await expect(method()).toContainText("The source map is unchanged");
    await expect(method()).toContainText(
      "prior reports and published snapshots retain their original method",
    );
    await method()
      .getByRole("button", { name: "Update calculation method", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(method()).toContainText(FLOOD_METHOD_VERSION);
    await expect(
      method().getByRole("button", {
        name: "Update calculation method",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "10",
      "10",
    ]);
    await page.screenshot({
      path: info.outputPath("flood-method-updated-desktop.png"),
      fullPage: false,
    });
    await close(page);
    const updated = await downloadProject();
    expect(active(updated).flood).toEqual({
      ...originalReference,
      methodVersion: FLOOD_METHOD_VERSION,
    });
    expect(updated.project.floodDatasets).toEqual(legacy.project.floodDatasets);
    expect(updated.place).toEqual(legacy.place);
    expect(updated.project.history.at(-1)?.before.flood).toEqual(
      originalReference,
    );
    expect(updated.project.history.at(-1)?.command).toEqual({
      type: "scenario.flood",
      flood: { ...originalReference, methodVersion: FLOOD_METHOD_VERSION },
    });
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const comparison = page.getByRole("dialog", {
      name: "A clearer view of the alternatives.",
      exact: true,
    });
    await expect(comparison.locator(".comparison-table")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(comparison).toContainText(
      "These scenarios use different flood calculation methods.",
    );
    await expect(comparison).toContainText("No shared flood baseline is shown");
    const floodRow = comparison.getByRole("row").filter({
      has: page.getByText("Homes in SFHA-intersecting buildings", {
        exact: true,
      }),
    });
    await expect(floodRow).toContainText("Not comparable");
    await page.screenshot({
      path: info.outputPath("flood-mixed-method-comparison.png"),
      fullPage: false,
    });
    await close(page);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await open(page);
    await expect(method()).toContainText(FLOOD_LEGACY_METHOD_VERSION);
    await expect(
      method().getByRole("button", {
        name: "Update calculation method",
        exact: true,
      }),
    ).toBeEnabled();
    await close(page);
    const undone = await downloadProject();
    expect(active(undone).flood).toEqual(originalReference);
    expect(active(undone).flood).not.toHaveProperty("methodVersion");
    expect(undone.project.floodDatasets).toEqual(legacy.project.floodDatasets);
    expect(undone.place).toEqual(legacy.place);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await saveAccountProject();
    await page.reload();
    await open(page);
    await expect(method()).toContainText(FLOOD_METHOD_VERSION);
    await expect(dialog(page).locator(".flood-totals strong")).toHaveText([
      "10",
      "10",
    ]);
    // A fresh public HTTP read after the private save must remain byte-equivalent
    // in selected evidence; this is not merely a still-open React view.
    await publicPage.goto("about:blank");
    const publishedAfter = await publicSnapshot(publicPage, url);
    expect(publishedAfter).toEqual(publishedBefore);
    await publicPage.screenshot({
      path: info.outputPath("flood-method-frozen-public.png"),
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});
