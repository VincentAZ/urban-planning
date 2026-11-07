import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Place, Project } from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

// Synthetic, explicitly labeled HUD-like limits verify the real UI, worker,
// API/catalog authority, durable storage and publication; no official validity claim.
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Housing affordability", exact: true });
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
    page.getByRole("combobox", { name: "Active scenario", exact: true }),
  ).toBeVisible();
  await settled(page);
}
async function workbench(page: Page) {
  await page
    .getByRole("combobox", { name: "Scorecard domain", exact: true })
    .selectOption("Housing");
  await page
    .getByRole("button", { name: "Review housing affordability", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}
async function section(page: Page, name: string) {
  await dialog(page)
    .getByRole("navigation", { name: "Housing workbench sections" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function fill(page: Page, name: string, value: string) {
  await dialog(page).getByRole("textbox", { name, exact: true }).fill(value);
}
async function area(page: Page) {
  await fill(page, "Area or jurisdiction name", "Synthetic income-limit area");
  await dialog(page)
    .getByRole("button", { name: "Search HUD areas", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", {
      name: "Review Synthetic income-limit area",
      exact: true,
    })
    .click();
  await expect(
    dialog(page).getByRole("region", {
      name: "Published annual income limits",
    }),
  ).toContainText("$20,000");
  await expect(
    dialog(page).getByRole("button", {
      name: "Retain this HUD area",
      exact: true,
    }),
  ).toBeDisabled();
  await dialog(page)
    .getByRole("checkbox", { name: /^I reviewed the named jurisdiction/ })
    .check();
  await dialog(page)
    .getByRole("button", { name: "Retain this HUD area", exact: true })
    .click();
}
async function group(
  page: Page,
  side: "baseline" | "proposal",
  tenure: "rent" | "own" = "rent",
  units = "10",
) {
  await section(
    page,
    side === "baseline" ? "Baseline groups" : "Proposal groups",
  );
  await dialog(page)
    .getByRole("button", { name: `Add ${side} group`, exact: true })
    .click();
  await dialog(page)
    .getByRole("combobox", { name: "Building", exact: true })
    .selectOption("qa-apartments");
  await expect(
    dialog(page).getByRole("textbox", { name: "Homes in group", exact: true }),
  ).toHaveValue("");
  await fill(page, "Homes in group", units);
  await dialog(page)
    .getByRole("combobox", { name: "Tenure", exact: true })
    .selectOption(tenure);
  await dialog(page)
    .getByRole("combobox", { name: "Household size", exact: true })
    .selectOption("1");
  await dialog(page)
    .getByRole("combobox", { name: "Applicable HUD area", exact: true })
    .selectOption({ label: "Synthetic income-limit area · FY 2026" });
  await fill(page, "Cost year", "2026");
}
async function cost(page: Page, label: string, state: string, amount?: string) {
  await dialog(page)
    .getByRole("combobox", { name: `${label} treatment`, exact: true })
    .selectOption(state);
  if (amount !== undefined)
    await fill(page, `${label} monthly dollars`, amount);
}
async function rental(
  page: Page,
  side: "baseline" | "proposal",
  rent = "450",
  fee = "not-applicable",
) {
  await group(page, side);
  await cost(page, "Rent", "separate", rent);
  await cost(page, "Utilities", "separate", "50");
  await cost(page, "Mandatory fees", fee);
}
async function preview(
  page: Page,
  notes = "Reviewed the synthetic county component, explicit one-person households, mutually exclusive unit assignments and complete 2026 costs.",
) {
  await section(page, "Review");
  await fill(page, "Housing review notes", notes);
  await dialog(page)
    .getByRole("checkbox", { name: /^I reviewed the HUD jurisdiction/ })
    .check();
  await dialog(page)
    .getByRole("button", { name: "Preview housing affordability", exact: true })
    .click();
  await expect(dialog(page)).toContainText("Draft preview ready");
}
async function apply(page: Page) {
  await dialog(page)
    .getByRole("button", { name: "Apply housing evidence", exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await settled(page);
}
async function close(page: Page) {
  await dialog(page)
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const discard = page.getByRole("button", {
    name: "Discard draft and close",
    exact: true,
  });
  if (await discard.count()) await discard.click();
  await expect(dialog(page)).toHaveCount(0);
}
async function complete(page: Page) {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Complete project · JSON/ })
    .click();
  const path = await (await pending).path();
  if (!path) throw new Error("Project download missing");
  const value = JSON.parse(await readFile(path, "utf8")) as {
    place: Place;
    project: Project;
  };
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  return value;
}
function active(project: Project) {
  return project.scenarios.find((s) => s.id === project.activeScenarioId)!;
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const dismiss = page.getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  });
  if (await dismiss.isVisible()) await dismiss.click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath(name) });
}
async function navigationVisible(page: Page) {
  const nav = dialog(page).getByRole("navigation", {
    name: "Housing workbench sections",
  });
  const evidence = await nav.evaluate((el) => {
    const n = el.getBoundingClientRect();
    return [...el.querySelectorAll("button")]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= n.left && r.right <= n.right;
      })
      .map((b) => {
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return (
          r.height >= 38 &&
          r.top >= n.top &&
          r.bottom <= n.bottom &&
          !!hit &&
          b.contains(hit)
        );
      });
  });
  expect(evidence.length).toBeGreaterThan(0);
  expect(evidence.every(Boolean)).toBe(true);
}

test("local reviewed income limits and rental groups keep unknown distinct, apply atomically, undo, reload and export", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin, {
    housingFixture: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api.connect(page);
    await open(page);
    await workbench(page);
    await area(page);
    await screenshot(page, info, "housing-area-desktop.png");
    await rental(page, "baseline");
    await rental(page, "proposal", "600", "unknown");
    await fill(page, "Rent monthly dollars", "");
    await section(page, "Sources");
    await section(page, "Proposal groups");
    await expect(
      dialog(page).getByRole("textbox", {
        name: "Rent monthly dollars",
        exact: true,
      }),
    ).toHaveValue("");
    await section(page, "Review");
    await fill(
      page,
      "Housing review notes",
      "Invalid blank test; never convert blank rent to zero.",
    );
    await dialog(page)
      .getByRole("checkbox", { name: /^I reviewed the HUD jurisdiction/ })
      .check();
    await dialog(page)
      .getByRole("button", {
        name: "Preview housing affordability",
        exact: true,
      })
      .click();
    await expect(dialog(page).getByRole("alert")).toContainText(
      "enter dollars",
    );
    await section(page, "Proposal groups");
    await fill(page, "Rent monthly dollars", "600");
    await preview(page);
    await expect(dialog(page).locator(".housing-results")).toContainText(
      "Incomplete evidence",
    );
    await dialog(page)
      .locator(".housing-group-results")
      .last()
      .locator("summary")
      .first()
      .click();
    await expect(dialog(page)).toContainText(
      "Unknown cost components: mandatory-fees",
    );
    await section(page, "Proposal groups");
    await cost(page, "Mandatory fees", "not-applicable");
    await preview(page);
    await expect(dialog(page).locator(".housing-result-heading")).toContainText(
      "Reviewed",
    );
    await screenshot(page, info, "housing-results-desktop.png");
    await apply(page);
    const saved = await complete(page);
    expect(saved.project.history).toHaveLength(1);
    expect(saved.project.history[0].command.type).toBe(
      "scenario.affordability",
    );
    expect(Object.keys(saved.project.housingIncomeLimits!)).toHaveLength(1);
    expect(
      active(saved.project).affordability?.proposalGroups[0].areaOrigin,
    ).toBe("server-catalog");
    expect(JSON.stringify(saved.project.history[0])).not.toContain(
      "sourceRows",
    );
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await settled(page);
    expect(
      active((await complete(page)).project).affordability,
    ).toBeUndefined();
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await settled(page);
    await workbench(page);
    await section(page, "Results");
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog(page)
      .locator(".housing-group-results")
      .last()
      .scrollIntoViewIfNeeded();
    await navigationVisible(page);
    await screenshot(page, info, "housing-results-mobile.png");
    const pending = page.waitForEvent("download");
    await dialog(page)
      .getByRole("button", { name: "Download saved housing CSV", exact: true })
      .click();
    const path = await (await pending).path();
    const csv = await readFile(path!, "utf8");
    expect(csv).toContain("Synthetic income-limit area");
    expect(csv).toContain("mandatory-fees");
    expect(csv).toContain("60000");
    expect(csv).toContain("housing-affordability-1.0.0");
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("ownership escrow groups survive saved reload and public snapshots retain their frozen costs", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin, {
    housingFixture: true,
  });
  const publicContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  try {
    await api.connect(page);
    await open(page);
    await workbench(page);
    await area(page);
    await rental(page, "baseline");
    await group(page, "proposal", "own");
    await cost(page, "Loan payment", "separate", "900");
    await cost(page, "Property tax", "included");
    await dialog(page)
      .getByRole("combobox", { name: "Property tax included in", exact: true })
      .selectOption({ label: "Loan payment" });
    await cost(page, "Property insurance", "included");
    await dialog(page)
      .getByRole("combobox", {
        name: "Property insurance included in",
        exact: true,
      })
      .selectOption({ label: "Loan payment" });
    for (const label of [
      "Flood insurance",
      "Mortgage insurance",
      "Association fees",
      "Ground rent",
      "Mandatory fees",
    ])
      await cost(page, label, "not-applicable");
    await cost(page, "Utilities", "separate", "100");
    await screenshot(page, info, "housing-ownership-desktop.png");
    await preview(page);
    await apply(page);
    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("Housing QA Planner");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("housing-planner@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-housing-test-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "Housing QA Planner",
    );
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
    const privateCalls: string[] = [];
    publicPage.on("request", (r) => {
      if (
        /\/api\/v1\/(projects|housing\/catalog|housing\/packs)/u.test(r.url())
      )
        privateCalls.push(r.url());
    });
    await publicPage.goto(url);
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    const frozen = publicPage.locator(".housing-published");
    await expect(frozen).toContainText(
      "Housing affordability · frozen evidence",
    );
    await frozen
      .locator(".housing-group-results")
      .last()
      .locator("summary")
      .first()
      .click();
    await expect(frozen).toContainText("$1,000");
    await expect(frozen).toContainText("$40,000");
    await expect(
      frozen.getByRole("button", {
        name: "Apply housing evidence",
        exact: true,
      }),
    ).toHaveCount(0);
    await frozen.scrollIntoViewIfNeeded();
    await screenshot(publicPage, info, "housing-public-desktop.png");
    expect(privateCalls).toEqual([]);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await workbench(page);
    await section(page, "Proposal groups");
    await fill(page, "Loan payment monthly dollars", "1100");
    await preview(
      page,
      "Updated private ownership loan cost; captured public version remains the earlier $900 payment plus $100 utilities.",
    );
    await apply(page);
    await page.reload();
    await settled(page);
    await workbench(page);
    await section(page, "Proposal groups");
    await expect(
      dialog(page).getByRole("textbox", {
        name: "Loan payment monthly dollars",
        exact: true,
      }),
    ).toHaveValue("1100.00");
    await close(page);
    await publicPage.reload();
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await publicPage
      .locator(".housing-published .housing-group-results")
      .last()
      .locator("summary")
      .first()
      .click();
    await expect(publicPage.locator(".housing-published")).toContainText(
      "$1,000",
    );
    expect(privateCalls).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("changed unit capacity becomes stale, and renewed review exposes unassigned homes on mobile", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin, {
    housingFixture: true,
  });
  try {
    await api.connect(page);
    await open(page);
    await workbench(page);
    await area(page);
    await rental(page, "baseline");
    await rental(page, "proposal");
    await preview(page);
    await apply(page);
    await page.locator("button.place-search").click();
    await page
      .getByRole("textbox", { name: "Search places or buildings", exact: true })
      .fill("QA apartments");
    await page.getByRole("button", { name: /QA apartments/ }).click();
    await page
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    await page.getByLabel("Entered homes", { exact: true }).fill("20");
    await page
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    await settled(page);
    await workbench(page);
    await section(page, "Results");
    await expect(dialog(page).locator(".housing-result-heading")).toContainText(
      "Review required",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, info, "housing-stale-mobile.png");
    await preview(
      page,
      "Reviewed changed 20-home capacity. The retained 10-home group is intentional; the other 10 homes have unassigned costs and remain unresolved.",
    );
    await expect(dialog(page).locator(".housing-results")).toContainText(
      "Incomplete evidence",
    );
    const proposalCoverage = dialog(page)
      .locator(".housing-card")
      .filter({
        has: page.getByRole("heading", {
          name: "Proposal coverage",
          exact: true,
        }),
      });
    await expect(proposalCoverage).toContainText("20");
    await expect(proposalCoverage).toContainText("Unassigned homes");
    await proposalCoverage.scrollIntoViewIfNeeded();
    await navigationVisible(page);
    await screenshot(page, info, "housing-coverage-mobile.png");
    await apply(page);
    const saved = await complete(page);
    expect(active(saved.project).affordability?.proposalGroups[0].units).toBe(
      10,
    );
    expect(active(saved.project).buildingEdits["qa-apartments"]?.units).toBe(
      20,
    );
  } finally {
    await api.close();
  }
});
