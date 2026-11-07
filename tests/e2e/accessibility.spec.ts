import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createCollaborationApi } from "./support/collaboration-api";

const workbench = (page: Page) =>
  page.getByRole("dialog", { name: "Where can you get to work?", exact: true });
async function openWorkbench(page: Page, navigate = true) {
  if (navigate) await page.goto("/");
  await page.getByRole("button", { name: "Economy", exact: true }).click();
  await page.getByRole("button", { name: "Readiness", exact: true }).click();
  await page
    .getByRole("button", { name: "Open jobs accessibility", exact: true })
    .click();
  await expect(workbench(page)).toBeVisible();
}
async function register(page: Page, email: string) {
  await workbench(page)
    .getByRole("button", { name: "Sign in or create a free account" })
    .click();
  await page
    .getByRole("textbox", { name: "Your name", exact: true })
    .fill("QA Jobs Planner");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page
    .getByLabel(/^Password/)
    .fill("Isolated-accessibility-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(workbench(page)).toBeVisible();
}
async function done(page: Page) {
  await workbench(page)
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(workbench(page)).toHaveCount(0);
}

test("outbound origin and walking query survive free-account creation, with keyboard mobile controls and no automatic run", async ({
  page,
  baseURL,
}, info) => {
  const isolated = await createCollaborationApi(baseURL!);
  await isolated.connect(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkbench(page);
    const dialog = workbench(page);
    await dialog.getByLabel("Origin latitude", { exact: true }).fill("");
    await expect(
      dialog.getByRole("button", {
        name: "Run jobs accessibility",
        exact: true,
      }),
    ).toBeDisabled();
    await dialog.getByLabel("Origin latitude", { exact: true }).fill("95");
    await expect(
      dialog.getByRole("button", {
        name: "Run jobs accessibility",
        exact: true,
      }),
    ).toBeDisabled();
    const fit = dialog.getByRole("button", {
      name: "Fit study area",
      exact: true,
    });
    await expect(fit).toBeEnabled();
    await fit.focus();
    await page.keyboard.press("Enter");
    await dialog
      .getByRole("button", { name: "Choose map center", exact: true })
      .click();
    await dialog.getByLabel("Origin latitude", { exact: true }).fill("33.448");
    await dialog
      .getByLabel("Origin longitude", { exact: true })
      .fill("-112.074");
    await dialog
      .getByLabel("Travel mode", { exact: true })
      .selectOption("walk");
    await expect(
      dialog.getByRole("option", { name: /Transit/ }),
    ).toHaveJSProperty("disabled", true);
    await register(page, "jobs-guest@urban-planning.test");
    await expect(
      dialog.getByLabel("Origin latitude", { exact: true }),
    ).toHaveValue("33.448");
    await expect(
      dialog.getByLabel("Origin longitude", { exact: true }),
    ).toHaveValue("-112.074");
    await expect(dialog.getByLabel("Travel mode", { exact: true })).toHaveValue(
      "walk",
    );
    await dialog
      .getByRole("button", { name: "Save project to run", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Save project to run", exact: true }),
    ).toHaveCount(0);
    await expect(dialog).toContainText("disabled on this server");
    await expect(
      dialog.getByRole("button", {
        name: "Run jobs accessibility",
        exact: true,
      }),
    ).toBeDisabled();
    expect(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("jobs-accessibility-mobile-query.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const state = await isolated.persistedState();
    expect(state.projects).toHaveLength(1);
    expect(state.accessibilityJobs).toHaveLength(0);
    expect(state.workforceJobs).toHaveLength(0);
    expect(state.budget.policy.monthlyLimitCents).toBe(30000);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await isolated.close();
  }
});

// Real HTTP, ACLs, queue, immutable archives, adoption, exports and publication.
// The named executor is synthetic: this test does not establish native routing or Census accuracy.
test("outbound captures preserve both modes across lost delivery, durable reload, exports and public read-only inspection", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const isolated = await createCollaborationApi(baseURL!, {
    accessibilityFixture: true,
  });
  await isolated.connect(page);
  const publicContext = await browser.newContext();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await openWorkbench(page);
    await register(page, "jobs-owner@urban-planning.test");
    const dialog = workbench(page);
    await dialog
      .getByRole("button", { name: "Save project to run", exact: true })
      .click();
    const run = dialog.getByRole("button", {
      name: "Run jobs accessibility",
      exact: true,
    });
    await expect(run).toBeEnabled();
    const saved = (await isolated.persistedState()).projects[0];
    isolated.loseNextResponse(
      `/api/v1/projects/${saved.project.id}/accessibility/jobs`,
    );
    await run.click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(run).toBeEnabled();
    await run.click();
    const adopt = dialog.getByRole("button", {
      name: "Save capture to scenario",
      exact: true,
    });
    await expect(adopt).toBeEnabled();
    await adopt.click();
    await expect(dialog).toContainText("Saved with this scenario");
    let state = await isolated.persistedState();
    expect(state.accessibilityJobs).toHaveLength(1);
    expect(state.accessibilityJobs[0].attempt).toBe(1);
    const carHash = state.accessibilityArtifacts[0].accessibility.captureHash;
    await dialog
      .getByLabel("Origin longitude", { exact: true })
      .fill("-112.074");
    await expect(dialog).toContainText("Previous result · query changed");
    await dialog
      .getByLabel("Travel mode", { exact: true })
      .selectOption("walk");
    await expect(run).toBeEnabled();
    await run.click();
    await expect(adopt).toBeEnabled();
    await adopt.click();
    await expect(dialog).toContainText("Saved with this scenario");
    await expect(dialog).toContainText("different origins");
    state = await isolated.persistedState();
    expect(state.accessibilityJobs).toHaveLength(2);
    expect(state.workforceJobs).toHaveLength(0);
    const scenario = state.projects[0].project.scenarios.find(
      (s) => s.id === state.projects[0].project.activeScenarioId,
    )!;
    expect(scenario.accessibility!.captures.car!.captureHash).toBe(carHash);
    expect(
      scenario.accessibility!.captures.walk!.capture.request.direction,
    ).toBe("outbound");
    expect(
      scenario.accessibility!.captures.walk!.capture.thresholds[0].total
        .estimate,
    ).toBe(100);
    await dialog.locator(".accessibility-results").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("jobs-accessibility-desktop-results.png"),
    });
    const rawDownload = page.waitForEvent("download");
    await dialog
      .getByRole("button", {
        name: "Download full routing evidence",
        exact: true,
      })
      .click();
    expect((await rawDownload).suggestedFilename()).toMatch(/\.json$/);
    await done(page);
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await openWorkbench(page, false);
    await expect(dialog).toContainText("Saved with this scenario");
    await expect(
      dialog.getByRole("button", {
        name: "Load saved regional map",
        exact: true,
      }),
    ).toBeVisible();
    await dialog
      .getByLabel("Travel mode", { exact: true })
      .selectOption("walk");
    await dialog
      .getByRole("button", { name: "Use captured query", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Load saved regional map", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", {
        name: "Download full routing evidence",
        exact: true,
      }),
    ).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.locator(".accessibility-results").scrollIntoViewIfNeeded();
    expect(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("jobs-accessibility-mobile-results.png"),
    });
    await done(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const csvDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: /^Jobs accessibility · CSV/ })
      .click();
    const csvPath = await (await csvDownload).path();
    if (!csvPath) throw new Error("Missing jobs CSV");
    const csv = await readFile(csvPath, "utf8");
    expect(csv).toContain("outbound");
    expect(csv).toContain("car");
    expect(csv).toContain("walk");
    expect(csv).toContain(carHash);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", {
      name: "Published link",
      exact: true,
    });
    await expect(link).toBeVisible();
    await isolated.connect(publicContext);
    const publicPage = await publicContext.newPage();
    const privateRequests: string[] = [];
    publicPage.on("request", (r) => {
      if (r.url().includes("/accessibility/jobs"))
        privateRequests.push(r.url());
    });
    await publicPage.goto(await link.inputValue());
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await publicPage
      .getByText("Jobs accessibility · frozen outbound evidence", {
        exact: true,
      })
      .click();
    const published = publicPage.locator(".accessibility-published");
    await expect(published).toContainText("different origins");
    await expect(published).toContainText("Driving");
    await expect(published).toContainText("Walking");
    await expect(published).toContainText("not included here");
    await expect(
      published.getByRole("button", { name: "Run jobs accessibility" }),
    ).toHaveCount(0);
    await published.scrollIntoViewIfNeeded();
    await publicPage.screenshot({
      path: info.outputPath("jobs-accessibility-public-readonly.png"),
    });
    expect(privateRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await publicContext.close();
    await isolated.close();
  }
});
