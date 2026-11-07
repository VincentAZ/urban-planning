import {
  expect,
  test,
  type Page,
  type Locator,
  type TestInfo,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Place, Project, Scenario } from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

// Explicitly authored synthetic fiscal inputs. Real UI, worker calculations,
// account/API storage, immutable library, new-study copy, and publication.
type Complete = {
  project: Project;
  place: Place;
  baselineIdentity: { sha256: string };
};
const dialog = (page: Page) =>
  page.getByRole("dialog", {
    name: "A clearer case for the public dollar.",
    exact: true,
  });
const active = (value: Complete): Scenario =>
  value.project.scenarios.find((s) => s.id === value.project.activeScenarioId)!;
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
  await expect(page.locator(".map-disclosure")).toContainText(
    "Synthetic collaboration QA",
  );
  await settled(page);
}
async function workbench(page: Page) {
  await page.getByRole("button", { name: "Economy", exact: true }).click();
  await page.getByRole("button", { name: "Incentives", exact: true }).click();
  await page
    .getByRole("button", { name: /^(Build a fiscal study|Open fiscal study)$/ })
    .click();
  await expect(dialog(page)).toBeVisible();
}
async function section(page: Page, name: string) {
  await dialog(page)
    .getByRole("navigation", { name: "Fiscal workbench sections" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function fill(d: Locator, name: string, value: string) {
  await d.getByRole("textbox", { name, exact: true }).fill(value);
}
async function profile(page: Page) {
  const d = dialog(page);
  for (const [name, value] of [
    ["Fiscal profile name", "QA municipal fiscal profile"],
    ["Receiving jurisdiction", "Synthetic QA jurisdiction"],
    ["Jurisdiction identifier", "qa-author-owned"],
    ["Fiscal reference year", "2026"],
    ["Constant-dollar price year", "2025"],
    [
      "Jurisdiction geography and applicability",
      "Synthetic collaboration study area only; no actual tax jurisdiction determination.",
    ],
    [
      "Taxable assessed-value compatibility",
      "QA building assessed values and the fallback are explicitly taxable assessed inputs; no market-value conversion claimed.",
    ],
    [
      "Service-cost allocation notes",
      "Authored QA average costs allocated to residents and jobs; no capital program or marginal service capacity claim.",
    ],
    ["Source 1 title", "QA authored fiscal evidence"],
    ["Source 1 vintage", "2025 constant-dollar synthetic inputs"],
    [
      "Source 1 reuse terms",
      "Author-owned synthetic QA inputs; private processing and public redistribution permitted.",
    ],
    [
      "Source 1 context",
      "No published provider values. Used only to verify the fiscal authoring and evidence workflow.",
    ],
    ["Fallback taxable assessed value ($/gross ft²)", "100"],
    ["Effective property levy (% per year)", "1"],
    ["Annual service cost per resident ($ / resident)", "100"],
    ["Annual service cost per job ($ / job)", "50"],
    ["Annual growth (%)", "1"],
    ["Real discount rate (%)", "3"],
    ["Annual taxable sales capacity ($/retail ft²)", "200"],
    ["Retained sales tax rate (%)", "1"],
    ["Taxable sales capture (%)", "50"],
  ])
    await fill(d, name!, value!);
  await d
    .getByRole("checkbox", { name: /^I may use, retain, analyze/ })
    .check();
  await d
    .getByRole("checkbox", {
      name: /^This source permits downloads and exports/,
    })
    .check();
  await d
    .getByRole("checkbox", {
      name: /^This source permits public redistribution/,
    })
    .check();
  await expect(
    d.getByRole("button", {
      name: "Save profile in this browser",
      exact: true,
    }),
  ).toBeEnabled();
}
async function applicability(page: Page, name: string) {
  const d = dialog(page);
  await fill(d, "New fiscal study name", name);
  await fill(
    d,
    "Study applicability review",
    "Reviewed the synthetic study geography, taxable assessment basis, cost allocation and 2025 real-dollar inputs for this exact current alternative.",
  );
  await d
    .getByRole("checkbox", { name: /^I reviewed the cited profile/ })
    .check();
}
async function create(page: Page, saved: boolean) {
  await dialog(page)
    .getByRole("button", {
      name: saved
        ? "Save source & create fiscal study"
        : "Create browser fiscal study",
      exact: true,
    })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(
    "Earlier history stays in the original study",
  );
  await confirm
    .getByRole("button", { name: "Create separate study", exact: true })
    .click();
  await expect(
    dialog(page).getByRole("textbox", {
      name: "Fiscal upfront grant ($)",
      exact: true,
    }),
  ).toBeVisible();
  await settled(page);
}
async function review(page: Page, notes: string) {
  await section(page, "Offer & review");
  await fill(dialog(page), "Current fiscal input review notes", notes);
  await dialog(page)
    .getByRole("checkbox", {
      name: /^I reviewed the current fiscal and demographic/,
    })
    .check();
}
async function offer(page: Page, grant = "10000") {
  await section(page, "Offer & review");
  await fill(dialog(page), "Fiscal upfront grant ($)", grant);
  await fill(dialog(page), "Fiscal added-value abatement (%)", "50");
  await fill(dialog(page), "Fiscal abatement term (years)", "5");
}
async function apply(page: Page) {
  await dialog(page)
    .getByRole("button", {
      name: "Apply offer & sensitivity cases",
      exact: true,
    })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await settled(page);
}
async function close(page: Page) {
  await dialog(page)
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  if (await page.getByRole("alertdialog").count())
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard draft", exact: true })
      .click();
  await expect(dialog(page)).toHaveCount(0);
}
async function downloadProject(page: Page): Promise<Complete> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Complete project · JSON/ })
    .click();
  const path = await (await pending).path();
  if (!path) throw new Error("The complete project download is missing.");
  const value = JSON.parse(await readFile(path, "utf8")) as Complete;
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  return value;
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
async function usableStickyNavigation(page: Page) {
  const nav = dialog(page).getByRole("navigation", {
    name: "Fiscal workbench sections",
  });
  const geometry = await nav.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const body = node.closest(".fiscal-dialog-body")!.getBoundingClientRect();
    const visible = [...node.querySelectorAll("button")].filter((button) => {
      const b = button.getBoundingClientRect();
      return b.left >= rect.left - 1 && b.right <= rect.right + 1;
    });
    return {
      fullHeight:
        rect.height >= 60 &&
        rect.top >= body.top - 1 &&
        rect.bottom <= body.bottom + 1,
      buttons: visible.map((button) => {
        const b = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          b.left + b.width / 2,
          b.top + b.height / 2,
        );
        return (
          b.height >= 38 &&
          b.top >= rect.top - 1 &&
          b.bottom <= rect.bottom + 1 &&
          !!hit &&
          button.contains(hit)
        );
      }),
    };
  });
  expect(geometry.fullHeight).toBe(true);
  expect(geometry.buttons.length).toBeGreaterThan(0);
  expect(geometry.buttons.every(Boolean)).toBe(true);
  const closeButton = dialog(page).getByRole("button", {
    name: "Close dialog",
    exact: true,
  });
  expect(
    await closeButton.evaluate((node) => {
      const b = node.getBoundingClientRect();
      const hit = document.elementFromPoint(
        b.left + b.width / 2,
        b.top + b.height / 2,
      );
      return (
        b.top >= 0 && b.bottom <= innerHeight && !!hit && node.contains(hit)
      );
    }),
  ).toBe(true);
}
async function account(page: Page) {
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your name", exact: true })
    .fill("QA Fiscal Planner");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("fiscal-planner@urban-planning.test");
  await page.getByLabel(/^Password/).fill("Isolated-fiscal-test-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(
    "QA Fiscal Planner",
  );
}

test("local fiscal profile keeps invalid drafts, creates a separate study, and applies paired offer cases atomically", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api.connect(page);
    await open(page);
    const original = await downloadProject(page);
    await workbench(page);
    await profile(page);
    await fill(dialog(page), "Real discount rate (%)", "");
    await section(page, "Profile library");
    await section(page, "New study");
    await expect(
      dialog(page).getByRole("textbox", {
        name: "Real discount rate (%)",
        exact: true,
      }),
    ).toHaveValue("");
    await expect(
      dialog(page).getByRole("button", {
        name: "Save profile in this browser",
        exact: true,
      }),
    ).toBeDisabled();
    await fill(dialog(page), "Real discount rate (%)", "3");
    await dialog(page)
      .getByRole("button", {
        name: "Save profile in this browser",
        exact: true,
      })
      .click();
    await expect(dialog(page)).toContainText(
      "Immutable profile saved in this browser",
    );
    await applicability(page, "QA browser fiscal study");
    await dialog(page)
      .getByRole("textbox", { name: "Fiscal profile name", exact: true })
      .scrollIntoViewIfNeeded();
    await screenshot(page, info, "fiscal-profile-desktop.png");
    await create(page, false);
    await close(page);
    const fresh = await downloadProject(page);
    expect(fresh.project.id).not.toBe(original.project.id);
    expect(fresh.place).toEqual(original.place);
    expect(fresh.baselineIdentity).toEqual(original.baselineIdentity);
    expect(fresh.project.history).toEqual([]);
    expect(fresh.project.fiscalStudy?.lineage.projectId).toBe(
      original.project.id,
    );
    expect(active(fresh).buildingEdits).toEqual(active(original).buildingEdits);
    expect(active(fresh).roadEdits).toEqual(active(original).roadEdits);
    expect(active(fresh).assumptions.annualWage).toBe(
      active(original).assumptions.annualWage,
    );
    await workbench(page);
    await offer(page);
    await section(page, "Sensitivity cases");
    await dialog(page)
      .getByRole("button", { name: "Add paired sensitivity case", exact: true })
      .click();
    await fill(
      dialog(page),
      "Case 1 name",
      "Slower revenue, higher service costs",
    );
    await fill(
      dialog(page),
      "Case 1 rationale",
      "Authored paired stress case, not a probability or observed outcome.",
    );
    await fill(dialog(page), "Case 1 baseline annual growth", "0");
    await fill(dialog(page), "Case 1 proposal annual growth", "0");
    await fill(
      dialog(page),
      "Case 1 proposal annual service cost per resident",
      "150",
    );
    await screenshot(page, info, "fiscal-paired-case-desktop.png");
    await review(
      page,
      "Reviewed the current profile and a deliberately authored paired downside case. Same development is assumed without an offer.",
    );
    await dialog(page)
      .getByRole("button", { name: "Preview offer & cases", exact: true })
      .click();
    await expect(
      dialog(page).getByRole("region", {
        name: "Fiscal study results",
        exact: true,
      }),
    ).toContainText("Input review: current");
    await expect(
      dialog(page).getByRole("row", { name: /Time zero · upfront/ }),
    ).toContainText("-$10,000");
    await expect(dialog(page)).toContainText(
      "Without offer assumes the same development happens",
    );
    await expect(
      dialog(page).getByRole("button", {
        name: "Download applied fiscal CSV",
        exact: true,
      }),
    ).toHaveCount(0);
    await screenshot(page, info, "fiscal-cash-flow-desktop.png");
    await apply(page);
    const applied = await downloadProject(page);
    expect(applied.project.history).toHaveLength(1);
    expect(applied.project.history[0].command.type).toBe("scenario.fiscal");
    expect(active(applied).assumptions.incentiveGrant).toBe(10000);
    expect(active(applied).fiscal?.cases[0].baseline).toEqual({
      annualGrowthRate: 0,
    });
    expect(active(applied).fiscal?.cases[0].proposal).toEqual({
      annualGrowthRate: 0,
      annualServiceCostPerResident: 150,
    });
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await settled(page);
    const undone = await downloadProject(page);
    expect(active(undone).assumptions.incentiveGrant).toBe(
      active(fresh).assumptions.incentiveGrant,
    );
    expect(active(undone).fiscal?.cases).toEqual([]);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await settled(page);
    await workbench(page);
    await section(page, "Cash flows");
    await dialog(page)
      .getByRole("combobox", { name: "Fiscal comparison case", exact: true })
      .selectOption({ label: "Slower revenue, higher service costs" });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog(page)
      .locator(".fiscal-mobile-row")
      .first()
      .scrollIntoViewIfNeeded();
    await usableStickyNavigation(page);
    await screenshot(page, info, "fiscal-cash-flow-mobile.png");
    const csvDownload = page.waitForEvent("download");
    await dialog(page)
      .getByRole("button", { name: "Download applied fiscal CSV", exact: true })
      .click();
    const csvPath = await (await csvDownload).path();
    const csv = await readFile(csvPath!, "utf8");
    expect(csv).toContain("Slower revenue, higher service costs");
    expect(csv).toContain("QA authored fiscal evidence");
    expect(csv).toContain("10000");
    expect(csv).toContain("2025");
    await close(page);
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Inspect travel mode shares & other assumptions",
        exact: true,
      })
      .click();
    const assumptions = page.getByRole("dialog", {
      name: "Make the assumptions yours.",
      exact: true,
    });
    await assumptions
      .getByRole("button", { name: "Fiscal", exact: true })
      .click();
    await assumptions
      .getByRole("spinbutton", { name: "Real discount rate", exact: true })
      .fill("4");
    await assumptions
      .getByRole("button", { name: "Save assumptions", exact: true })
      .click();
    await settled(page);
    await workbench(page);
    await section(page, "Cash flows");
    await expect(
      dialog(page).getByRole("region", {
        name: "Fiscal study results",
        exact: true,
      }),
    ).toContainText("Input review: stale");
    await usableStickyNavigation(page);
    await screenshot(page, info, "fiscal-stale-review-mobile.png");
    await review(
      page,
      "Renewed review: 4% real discount is an authored deviation; original profile remains at 3%.",
    );
    await expect(dialog(page)).toContainText("authored overrides");
    await apply(page);
    const renewed = await downloadProject(page);
    expect(renewed.project.fiscalStudy?.profile.coefficients.discountRate).toBe(
      0.03,
    );
    expect(active(renewed).assumptions.discountRate).toBe(0.04);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("workspace profile versions create a separate saved study and a frozen public fiscal result", async ({
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
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api.connect(page);
    await open(page);
    await account(page);
    const original = await downloadProject(page);
    await workbench(page);
    await profile(page);
    const savedV1 = page.waitForResponse(
      (r) =>
        r.url().endsWith("/fiscal-profiles") && r.request().method() === "POST",
    );
    await dialog(page)
      .getByRole("button", { name: "Save new workspace profile", exact: true })
      .click();
    const first = await (await savedV1).json();
    await expect(dialog(page)).toContainText(
      "Immutable profile saved to this workspace",
    );
    await fill(dialog(page), "Real discount rate (%)", "5");
    const savedV2 = page.waitForResponse(
      (r) =>
        r.url().endsWith("/fiscal-profiles") && r.request().method() === "POST",
    );
    await dialog(page)
      .getByRole("button", {
        name: "Append workspace profile version",
        exact: true,
      })
      .click();
    const second = await (await savedV2).json();
    expect(second.version.version).toBe(2);
    expect(second.version.previousVersionId).toBe(first.version.id);
    await section(page, "Profile library");
    await dialog(page)
      .getByRole("button", {
        name: "View retained versions of QA municipal fiscal profile",
        exact: true,
      })
      .click();
    await expect(
      dialog(page).getByRole("button", {
        name: "Use QA municipal fiscal profile version 1",
        exact: true,
      }),
    ).toBeVisible();
    await screenshot(page, info, "fiscal-library-desktop.png");
    await dialog(page)
      .getByRole("button", {
        name: "Use QA municipal fiscal profile version 1",
        exact: true,
      })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Use selected profile", exact: true })
      .click();
    await expect(
      dialog(page).getByRole("textbox", {
        name: "Real discount rate (%)",
        exact: true,
      }),
    ).toHaveValue("3");
    await applicability(page, "QA saved fiscal study from version 1");
    const creation = page.waitForResponse(
      (r) =>
        r.url().endsWith("/fiscal-studies") && r.request().method() === "POST",
    );
    await create(page, true);
    const created = await (await creation).json();
    expect(created.project.fiscalStudy.profileHash).toBe(
      first.version.profileHash,
    );
    expect(created.project.fiscalStudy.profile.coefficients.discountRate).toBe(
      0.03,
    );
    const state = await api.persistedState();
    const source = state.projects.find(
      (record) =>
        record.project.id === created.project.fiscalStudy.lineage.projectId,
    )!;
    expect(source.project.fiscalStudy).toBeUndefined();
    expect(source.project.scenarios).toEqual(original.project.scenarios);
    expect(created.project.history).toEqual([]);
    await offer(page);
    await review(
      page,
      "Reviewed version 1 and the explicit 10000 grant, with the same development assumed without an offer.",
    );
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
    const privateRequests: string[] = [];
    publicPage.on("request", (request) => {
      if (/\/api\/v1\/(projects|fiscal-profiles)\b/.test(request.url()))
        privateRequests.push(request.url());
    });
    await publicPage.goto(url);
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await publicPage
      .locator("summary")
      .filter({ hasText: /^Fiscal study · QA municipal fiscal profile$/ })
      .click();
    await expect(
      publicPage.getByRole("region", {
        name: "Fiscal study results",
        exact: true,
      }),
    ).toContainText("Input review: current");
    await expect(
      publicPage.getByRole("row", { name: /Time zero · upfront/ }),
    ).toContainText("-$10,000");
    await expect(
      publicPage.getByRole("region", {
        name: "Retained fiscal profile",
        exact: true,
      }),
    ).toContainText("QA authored fiscal evidence");
    await expect(
      publicPage.getByRole("button", {
        name: "Apply offer & sensitivity cases",
        exact: true,
      }),
    ).toHaveCount(0);
    await publicPage
      .getByRole("region", { name: "Fiscal study results", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await publicPage
        .getByRole("region", { name: "Fiscal study results", exact: true })
        .evaluate((node) => {
          const details = node.closest("details")!;
          return (
            getComputedStyle(details).overflowY === "visible" &&
            details.scrollHeight <= details.clientHeight + 1
          );
        }),
    ).toBe(true);
    await screenshot(publicPage, info, "fiscal-public-desktop.png");
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await workbench(page);
    await offer(page, "20000");
    await review(
      page,
      "Private offer changed to 20000; the earlier published capture stays unchanged.",
    );
    await apply(page);
    await publicPage.reload();
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await publicPage
      .locator("summary")
      .filter({ hasText: /^Fiscal study · QA municipal fiscal profile$/ })
      .click();
    await expect(
      publicPage.getByRole("row", { name: /Time zero · upfront/ }),
    ).toContainText("-$10,000");
    expect(privateRequests).toEqual([]);
    expect(errors).toEqual([]);
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    await page.reload();
    await settled(page);
    await workbench(page);
    await expect(
      dialog(page).getByRole("textbox", {
        name: "Fiscal upfront grant ($)",
        exact: true,
      }),
    ).toHaveValue("20000");
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("a late saved-study response cannot replace a cancelled workbench or a newer original draft", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  let release: (() => void) | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await open(page);
    await account(page);
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
      page.getByText("Project saved to your private workspace.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    const original = await downloadProject(page);
    await workbench(page);
    await profile(page);
    await applicability(page, "Retained separate study after cancellation");
    const held = api.holdNextResponse(
      `/api/v1/projects/${original.project.id}/fiscal-studies`,
    );
    release = held.release;
    await dialog(page)
      .getByRole("button", {
        name: "Save source & create fiscal study",
        exact: true,
      })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Create separate study", exact: true })
      .click();
    await held.committed;
    await close(page);
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Inspect travel mode shares & other assumptions",
        exact: true,
      })
      .click();
    const assumptions = page.getByRole("dialog", {
      name: "Make the assumptions yours.",
      exact: true,
    });
    await assumptions
      .getByRole("spinbutton", { name: "People per household", exact: true })
      .fill("4");
    await assumptions
      .getByRole("button", { name: "Save assumptions", exact: true })
      .click();
    release();
    release = undefined;
    await settled(page);
    await expect(page.locator(".project-status")).toContainText(
      "Browser draft saved",
    );
    const retained = await downloadProject(page);
    expect(retained.project.id).toBe(original.project.id);
    expect(retained.project.fiscalStudy).toBeUndefined();
    expect(active(retained).assumptions.householdSize).toBe(4);
    expect(active(retained).revision).toBe(active(original).revision + 1);
    const studies = (await api.persistedState()).projects.filter(
      (value) => value.project.fiscalStudy,
    );
    expect(studies).toHaveLength(1);
    expect(studies[0].project.fiscalStudy?.lineage).toMatchObject({
      projectId: original.project.id,
      scenarioRevision: active(original).revision,
    });
    expect(
      studies[0].project.scenarios.find(
        (s) => s.id === studies[0].project.activeScenarioId,
      )?.assumptions.householdSize,
    ).toBe(active(original).assumptions.householdSize);
    await screenshot(
      page,
      info,
      "fiscal-cancelled-study-original-retained.png",
    );
    expect(errors).toEqual([]);
  } finally {
    release?.();
    await api.close();
  }
});
