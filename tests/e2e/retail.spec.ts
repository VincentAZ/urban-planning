import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Place, Project, Scenario } from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

// Synthetic geography and explicitly authored QA study. All UI, HTTP/auth,
// calculations, persistence, rights enforcement and publication are real.
type CompleteProject = {
  project: Project;
  place: Place;
  baselineIdentity: { sha256: string };
};
const workbench = (page: Page) =>
  page.getByRole("dialog", { name: "Retail gap workbench", exact: true });
const active = (data: CompleteProject): Scenario =>
  data.project.scenarios.find((s) => s.id === data.project.activeScenarioId)!;
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
  await page.getByRole("button", { name: "Economy", exact: true }).click();
  await page.getByRole("button", { name: "Retail gaps", exact: true }).click();
}
async function openStudy(page: Page) {
  await page
    .getByRole("button", {
      name: /^(Set up retail evidence|Open retail workbench)$/,
    })
    .click();
  await expect(workbench(page)).toBeVisible();
}
async function context(page: Page) {
  const dialog = workbench(page);
  await dialog.getByRole("tab", { name: "Study context", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Evidence geography", exact: true })
    .fill("Synthetic QA trade area");
  await dialog
    .getByRole("spinbutton", { name: "Reference year", exact: true })
    .fill("2024");
  await dialog
    .getByRole("spinbutton", { name: "Dollar year", exact: true })
    .fill("2024");
  await dialog
    .getByRole("combobox", { name: "Classification system", exact: true })
    .selectOption("NAICS");
  await dialog
    .getByRole("textbox", { name: "Classification version", exact: true })
    .fill("2022");
  await dialog
    .getByRole("checkbox", { name: /^I confirm demand, sales/ })
    .check();
  await dialog
    .getByRole("checkbox", { name: /^I confirm these categories/ })
    .check();
}
async function addSource(page: Page) {
  const dialog = workbench(page);
  await dialog
    .getByRole("tab", { name: "Sources & rights", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();
  const source = dialog.locator(".retail-source-editor").last();
  await source
    .getByRole("textbox", { name: "Source title", exact: true })
    .fill("QA Retail Study");
  await source
    .getByRole("textbox", { name: "Source vintage", exact: true })
    .fill("2024 annual synthetic inputs");
  await source
    .getByRole("textbox", { name: "License or reuse terms", exact: true })
    .fill("Synthetic QA data; authored for workflow verification");
  await source
    .getByRole("textbox", { name: "Source description", exact: true })
    .fill(
      "Explicitly synthetic demand and establishment sales; no provider data.",
    );
  await source
    .getByRole("checkbox", { name: /^I am authorized to store/ })
    .check();
  await source
    .getByRole("textbox", { name: "Rights statement", exact: true })
    .fill(
      "Author-owned synthetic figures; initially private to exercise publication controls.",
    );
}
async function measure(
  dialog: Locator,
  label: string,
  value: number,
  source = "QA Retail Study",
) {
  await dialog
    .getByRole("combobox", { name: `${label} status`, exact: true })
    .selectOption("available");
  await dialog
    .getByRole("spinbutton", { name: `${label} ($ / year)`, exact: true })
    .fill(String(value));
  await dialog
    .getByRole("combobox", { name: `${label} source`, exact: true })
    .selectOption({
      label: `${source} · ${source === "QA Retail Study" ? "2024 annual synthetic inputs" : "Scenario edit"}`,
    });
}
async function category(
  page: Page,
  values: {
    name: string;
    code: string;
    demand: number;
    sales: number;
    capacity: number;
    capture: number;
    displacement: number;
  },
  source = "QA Retail Study",
) {
  const dialog = workbench(page);
  await dialog
    .getByRole("textbox", { name: "Category name", exact: true })
    .fill(values.name);
  await dialog
    .getByRole("textbox", { name: "Category code", exact: true })
    .fill(values.code);
  await measure(dialog, "Baseline resident demand", values.demand, source);
  await measure(dialog, "Baseline local sales", values.sales, source);
  await measure(dialog, "Annual sales per establishment", 200000, source);
  for (const [label, value] of [
    ["Annual added sales capacity ($ / year)", values.capacity],
    ["Capture share (%)", values.capture],
    ["Local displacement (%)", values.displacement],
  ] as const)
    await dialog
      .getByRole("spinbutton", { name: label, exact: true })
      .fill(String(value));
}
const grocery = {
  name: "QA Grocery stores",
  code: "4451",
  demand: 1000000,
  sales: 600000,
  capacity: 150000,
  capture: 50,
  displacement: 20,
};
async function firstCategory(page: Page, source = "QA Retail Study") {
  await workbench(page)
    .getByRole("tab", { name: "Categories", exact: true })
    .click();
  await workbench(page)
    .getByRole("button", { name: /^New category/ })
    .click();
  await category(page, grocery, source);
}
async function apply(page: Page) {
  const button = workbench(page).getByRole("button", {
    name: "Apply retail study",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(workbench(page)).toHaveCount(0);
  await settled(page);
}
async function downloadProject(page: Page) {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Complete project · JSON/ })
    .click();
  const path = await (await pending).path();
  if (!path) throw new Error("Complete project download is missing.");
  const data = JSON.parse(await readFile(path, "utf8")) as CompleteProject;
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  return data;
}
async function saveAccount(page: Page) {
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your name", exact: true })
    .fill("QA Retail Planner");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("retail-planner@urban-planning.test");
  await page.getByLabel(/^Password/).fill("Isolated-retail-test-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(
    "QA Retail Planner",
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
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}

test("retail categories retain evidence, signed gaps and invalid drafts through atomic apply, undo and reload", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await open(page);
    const before = await downloadProject(page);
    await openStudy(page);
    await context(page);
    await addSource(page);
    await firstCategory(page);
    const dialog = workbench(page);
    await expect(
      dialog.getByRole("region", { name: "Calculation for QA Grocery stores" }),
    ).toContainText("$120,000");
    await dialog
      .getByRole("spinbutton", {
        name: "Annual added sales capacity ($ / year)",
        exact: true,
      })
      .fill("");
    await dialog
      .getByRole("tab", { name: "Study context", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Apply retail study", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("tab", { name: "Categories", exact: true }).click();
    await expect(
      dialog.getByRole("spinbutton", {
        name: "Annual added sales capacity ($ / year)",
        exact: true,
      }),
    ).toHaveValue("");
    await dialog
      .getByRole("spinbutton", {
        name: "Annual added sales capacity ($ / year)",
        exact: true,
      })
      .fill("150000");
    await page.screenshot({
      path: info.outputPath("retail-category-desktop.png"),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Add category", exact: true })
      .click();
    await category(page, {
      name: "QA Clothing stores",
      code: "4581",
      demand: 200000,
      sales: 500000,
      capacity: 100000,
      capture: 100,
      displacement: 0,
    });
    await dialog
      .getByRole("button", { name: "All categories", exact: true })
      .click();
    await expect(
      dialog.getByRole("row", { name: /QA Clothing stores/ }),
    ).toContainText("-$300,000");
    await expect(
      dialog.getByRole("button", { name: /Retail categories · CSV/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("retail-results-desktop.png"),
      fullPage: true,
    });
    await apply(page);
    await page.screenshot({
      path: info.outputPath("retail-workspace-desktop.png"),
      fullPage: true,
    });
    const saved = await downloadProject(page);
    expect(saved.project.schemaVersion).toBe(6);
    expect(active(saved).revision).toBe(active(before).revision + 1);
    expect(saved.project.history.at(-1)?.command.type).toBe("scenario.retail");
    expect(active(saved).retail?.categories).toHaveLength(2);
    expect(saved.place).toEqual(before.place);
    expect(saved.baselineIdentity).toEqual(before.baselineIdentity);
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Set up retail evidence", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Open retail workbench", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await settled(page);
    await page.getByRole("button", { name: "Economy", exact: true }).click();
    await page
      .getByRole("button", { name: "Retail gaps", exact: true })
      .click();
    await openStudy(page);
    await dialog.getByRole("tab", { name: "Categories", exact: true }).click();
    const pending = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: /Retail categories · CSV/ })
      .click();
    const path = await (await pending).path();
    expect(await readFile(path!, "utf8")).toContain("QA Retail Study");
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("private retail evidence is blocked from publication until reviewed, then stays frozen and inspectable", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const publicContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  try {
    await api.connect(page);
    await open(page);
    await openStudy(page);
    await context(page);
    await addSource(page);
    await firstCategory(page);
    await apply(page);
    await saveAccount(page);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      /private project use|private.*retail/i,
    );
    await expect(
      page.getByRole("textbox", { name: "Published link", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await openStudy(page);
    await workbench(page)
      .getByRole("tab", { name: "Sources & rights", exact: true })
      .click();
    const publicRights = workbench(page).getByRole("checkbox", {
      name: /^This source permits public redistribution/,
    });
    for (const checkbox of await publicRights.all()) await checkbox.check();
    await page.screenshot({
      path: info.outputPath("retail-source-rights-desktop.png"),
      fullPage: true,
    });
    await apply(page);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", {
      name: "Published link",
      exact: true,
    });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    await publicPage.goto(url);
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    const evidence = publicPage.getByRole("region", {
      name: "Frozen retail evidence",
      exact: true,
    });
    await expect(evidence).toContainText("QA Grocery stores");
    await expect(evidence).toContainText("$120,000");
    await expect(evidence).toContainText("QA Retail Study");
    await expect(
      publicPage.getByRole("button", {
        name: "Apply retail study",
        exact: true,
      }),
    ).toHaveCount(0);
    await evidence.scrollIntoViewIfNeeded();
    await publicPage.screenshot({
      path: info.outputPath("retail-public-desktop.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await openStudy(page);
    await workbench(page)
      .getByRole("tab", { name: "Categories", exact: true })
      .click();
    await workbench(page)
      .getByRole("button", { name: "QA Grocery stores", exact: true })
      .click();
    await workbench(page)
      .getByRole("spinbutton", {
        name: "Annual added sales capacity ($ / year)",
        exact: true,
      })
      .fill("0");
    await apply(page);
    await publicPage.reload();
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await expect(evidence).toContainText("$120,000");
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("mobile retail editing preserves zero and suppressed values, guards discard and withholds stale horizon results", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  try {
    await api.connect(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await openStudy(page);
    await context(page);
    await firstCategory(page, "User retail analysis");
    const dialog = workbench(page);
    await measure(
      dialog,
      "Baseline resident demand",
      0,
      "User retail analysis",
    );
    await measure(dialog, "Baseline local sales", 0, "User retail analysis");
    await dialog
      .getByRole("combobox", {
        name: "Annual sales per establishment status",
        exact: true,
      })
      .selectOption("suppressed");
    await dialog
      .getByRole("textbox", {
        name: "Annual sales per establishment note",
        exact: true,
      })
      .fill("Synthetic suppression exercise");
    await dialog
      .getByRole("button", { name: "All categories", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath("retail-mobile-categories.png"),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await apply(page);
    const saved = await downloadProject(page);
    expect(active(saved).retail?.categories[0].baselineDemand.value).toBe(0);
    expect(
      active(saved).retail?.categories[0].salesPerEstablishment,
    ).toMatchObject({ status: "suppressed", value: null });
    await openStudy(page);
    await dialog
      .getByRole("textbox", { name: "Evidence geography", exact: true })
      .fill("Unsaved area");
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await expect(
      dialog.getByRole("textbox", { name: "Evidence geography", exact: true }),
    ).toHaveValue("Unsaved area");
    await dialog
      .getByRole("button", { name: "Discard draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(workbench(page)).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "TIME HORIZON", exact: true })
      .selectOption("10");
    await settled(page);
    await expect(page.getByText(/study’s horizon differs/)).toBeVisible();
    await openStudy(page);
    await dialog
      .getByRole("combobox", { name: "Study horizon", exact: true })
      .selectOption("10");
    await apply(page);
    await openStudy(page);
    await dialog.getByRole("tab", { name: "Categories", exact: true }).click();
    await expect(
      dialog.getByRole("row", { name: /QA Grocery stores/ }),
    ).toContainText("$0");
    await page.screenshot({
      path: info.outputPath("retail-mobile-reviewed.png"),
    });
  } finally {
    await api.close();
  }
});
