import { test, expect, type Page } from "@playwright/test";
import type { BudgetDashboard } from "../../packages/core/src/budget.js";
import { createBudgetApi } from "./support/budget-api.js";

async function login(
  page: Page,
  account: { email: string; password: string; name: string },
) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".account-button")).toContainText(account.name);
}

async function dashboard(page: Page): Promise<BudgetDashboard> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/admin/budget");
    if (!response.ok)
      throw new Error(`Budget read failed with HTTP ${response.status}`);
    return response.json();
  });
}

function stat(page: Page, label: string) {
  return page
    .locator(".budget-stat")
    .filter({
      has: page.locator("span", { hasText: new RegExp(`^${label}$`) }),
    })
    .locator("strong");
}

async function openBudget(page: Page) {
  await page
    .getByRole("button", { name: "Operating budget", exact: true })
    .click();
  await expect(
    page.getByRole("spinbutton", {
      name: "Monthly ceiling · USD",
      exact: true,
    }),
  ).toBeVisible();
}

async function fillReview(
  page: Page,
  values = { unreported: "20", low: "10", expected: "30", high: "60" },
) {
  const form = page.getByRole("spinbutton", {
    name: "Estimated unreported costs · USD",
    exact: true,
  });
  if (!(await form.isVisible()))
    await page
      .getByText("Review costs and spending assumptions", { exact: true })
      .click();
  const current = page.getByRole("button", {
    name: "Review current accounting",
    exact: true,
  });
  if (await current.isVisible()) await current.click();
  await form.fill(values.unreported);
  await page
    .getByRole("spinbutton", { name: "Low future spending · USD", exact: true })
    .fill(values.low);
  await page
    .getByRole("spinbutton", {
      name: "Expected future spending · USD",
      exact: true,
    })
    .fill(values.expected);
  await page
    .getByRole("spinbutton", {
      name: "High future spending · USD",
      exact: true,
    })
    .fill(values.high);
  await page
    .getByRole("textbox", { name: "Evidence and assumptions", exact: true })
    .fill(
      "Synthetic browser accounting exercise. No provider invoices or actual future spending asserted.",
    );
  await page
    .getByRole("checkbox", { name: /^My estimate includes or reconciles/ })
    .check();
}

async function realPolicyChange(page: Page, limit: number) {
  return page.evaluate(async (monthlyLimitCents) => {
    const session = await (await fetch("/api/v1/auth/session")).json();
    const current = await (await fetch("/api/v1/admin/budget")).json();
    const response = await fetch("/api/v1/admin/budget", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({
        expectedVersion: current.policy.version,
        monthlyLimitCents,
        safetyMarginCents: current.policy.safetyMarginCents,
        fixedCostReserveCents: current.policy.fixedCostReserveCents,
        paidOperationsPaused: current.policy.paidOperationsPaused,
      }),
    });
    return response.status;
  }, limit);
}

test("private administrator budget persists and ordinary project ownership cannot grant access", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = await createBudgetApi(
    new URL(baseURL ?? "http://127.0.0.1:5173").origin,
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await api.connect(page);
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Save your work", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Operating budget", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        async () => (await fetch("/api/v1/admin/budget")).status,
      ),
    ).toBe(401);

    await login(page, api.admin);
    await page
      .getByRole("button", { name: "Operating budget", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Operating budget", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("spinbutton", { name: /^Monthly ceiling · USD/ }),
    ).toHaveValue("300.00");
    await expect(stat(page, "Monthly ceiling")).toHaveText("$300.00");
    await expect(
      page.getByRole("checkbox", { name: /^Pause new paid operations/ }),
    ).toBeChecked();
    await expect(
      page.getByText("Provider billing is not connected.", { exact: true }),
    ).toBeVisible();
    expect((await dashboard(page)).coverage).toMatchObject({
      paidProviders: [],
      billingSync: false,
      externalSpendKnown: false,
      externalChargesCapped: false,
    });
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-admin-default.png") });

    await page
      .getByRole("spinbutton", { name: /^Monthly ceiling · USD/ })
      .fill("350");
    await page
      .getByRole("spinbutton", { name: /^Safety buffer · USD/ })
      .fill("30");
    await page
      .getByRole("spinbutton", { name: /^Fixed monthly reserve · USD/ })
      .fill("50");
    await page
      .getByRole("checkbox", { name: /^Pause new paid operations/ })
      .uncheck();
    await page
      .getByRole("button", { name: "Save budget settings", exact: true })
      .click();
    await expect(
      page.getByText("Operating budget saved at $350.00 per month.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(stat(page, "Available after buffer")).toHaveText("$270.00");
    expect((await api.persistedState()).budget.policy).toMatchObject({
      monthlyLimitCents: 35000,
      fixedCostReserveCents: 5000,
      safetyMarginCents: 3000,
      paidOperationsPaused: false,
      updatedBy: api.admin.id,
    });

    // A new API instance reads the saved file; a browser reload alone would only test its cache.
    await api.restart();
    await page.reload();
    await expect(page.locator(".account-button")).toContainText(api.admin.name);
    await page
      .getByRole("button", { name: "Operating budget", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: /^Monthly ceiling · USD/ }),
    ).toHaveValue("350.00");
    await expect(
      page.getByRole("spinbutton", { name: /^Safety buffer · USD/ }),
    ).toHaveValue("30.00");
    await expect(
      page.getByRole("spinbutton", { name: /^Fixed monthly reserve · USD/ }),
    ).toHaveValue("50.00");

    await page
      .getByRole("spinbutton", { name: "Amount · USD", exact: true })
      .fill("20");
    await page
      .getByRole("combobox", { name: "Cost category", exact: true })
      .selectOption("fixed");
    await page
      .getByRole("textbox", { name: "Reason or bill reference", exact: true })
      .fill("Isolated test hosting invoice");
    await page
      .getByRole("button", { name: "Record cost entry", exact: true })
      .click();
    await expect(
      page.getByText(
        "Cost entry recorded. The available job budget has been updated.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(stat(page, "Recorded costs")).toHaveText("$20.00");
    await expect(stat(page, "Reserved & committed")).toHaveText("$30.00");
    await expect(stat(page, "Available after buffer")).toHaveText("$270.00");
    const recorded = await dashboard(page);
    expect(recorded.totals).toMatchObject({
      recordedFixedCents: 2000,
      unspentFixedReserveCents: 3000,
      accountedCents: 5000,
      availableCents: 27000,
    });
    expect(recorded.adjustments).toHaveLength(1);
    expect(recorded.adjustments[0]).toMatchObject({
      amountCents: 2000,
      category: "fixed",
      actorId: api.admin.id,
    });
    // Re-delivery of the actual browser submission cannot count the same invoice twice.
    expect(
      await page.evaluate(
        async (input) => {
          const session = await (await fetch("/api/v1/auth/session")).json();
          const response = await fetch("/api/v1/admin/budget/adjustments", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify(input),
          });
          return { status: response.status, data: await response.json() };
        },
        {
          idempotencyKey: recorded.adjustments[0].idempotencyKey,
          amountCents: 2000,
          category: "fixed",
          reason: "Isolated test hosting invoice",
        },
      ),
    ).toMatchObject({
      status: 200,
      data: { totals: { accountedCents: 5000, availableCents: 27000 } },
    });
    expect((await api.persistedState()).budget.adjustments).toHaveLength(1);
    await page
      .getByRole("heading", { name: "Operating budget", exact: true })
      .scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-admin-desktop.png") });

    // Supply an explicit review so this branch still isolates exhausted admission,
    // independently of the new missing-review gate.
    await fillReview(page, {
      unreported: "0",
      low: "0",
      expected: "0",
      high: "0",
    });
    await page
      .getByRole("button", { name: "Save cost review", exact: true })
      .click();
    await expect(
      page.getByText("Current cost review", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("spinbutton", { name: /^Monthly ceiling · USD/ })
      .fill("40");
    await page
      .getByRole("button", { name: "Save budget settings", exact: true })
      .click();
    await expect(
      page.getByText("Operating budget saved at $40.00 per month.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".budget-alert")).toContainText(
      "exceed the monthly ceiling by $10.00",
    );
    await expect(page.locator(".budget-intro .budget-state")).toHaveText(
      "New paid work on hold",
    );
    await expect(stat(page, "Available after buffer")).toHaveText("$0.00");
    expect((await dashboard(page)).admission).toEqual({
      allowed: false,
      reason: "budget_exhausted",
    });
    await page
      .getByRole("checkbox", { name: /^Pause new paid operations/ })
      .check();
    await page
      .getByRole("button", { name: "Save budget settings", exact: true })
      .click();
    await expect(page.locator(".budget-intro .budget-state")).toHaveText(
      "Paid work paused",
    );
    await page.setViewportSize({ width: 768, height: 1024 });
    await page
      .getByRole("heading", { name: "Operating budget", exact: true })
      .scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-admin-tablet.png") });
    expect(
      await page
        .getByRole("dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);

    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toBeVisible();
    await expect(page.locator(".metric-card").first()).toBeVisible();
    const housingMetric = page
      .locator(".metric-card")
      .filter({ has: page.locator(".metric-label", { hasText: /^Homes$/ }) })
      .locator(".metric-value");
    const originalHomes = Number(
      (await housingMetric.innerText()).replace(/[^\d.-]/g, ""),
    );
    await page
      .getByRole("button", { name: "Open feature list", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Search places or buildings", exact: true })
      .fill("The Stewart");
    await page.getByRole("button", { name: /^The Stewart/ }).click();
    await page
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    const homes = page.getByRole("spinbutton", {
      name: "Entered homes",
      exact: true,
    });
    await expect(homes).toBeEnabled();
    await homes.fill(String(Number(await homes.inputValue()) + 1));
    await page
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    await expect
      .poll(async () =>
        Number((await housingMetric.innerText()).replace(/[^\d.-]/g, "")),
      )
      .toBe(originalHomes + 1);
    expect((await dashboard(page)).admission.reason).toBe("paused");

    const beforeDenied = (await api.persistedState()).budget;
    await page.close(); // Release this WebGL view before exercising the ordinary account.
    const ordinaryContext = await browser.newContext({
      baseURL: baseURL ?? "http://127.0.0.1:5173",
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    try {
      await api.connect(ordinaryContext);
      const ordinaryPage = await ordinaryContext.newPage();
      ordinaryPage.on("pageerror", (error) => pageErrors.push(error.message));
      await login(ordinaryPage, api.owner);
      await expect(
        ordinaryPage.getByRole("button", {
          name: "Operating budget",
          exact: true,
        }),
      ).toHaveCount(0);
      const denied = await ordinaryPage.evaluate(async () => {
        const session = await (await fetch("/api/v1/auth/session")).json();
        const headers = {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        };
        const view = await fetch("/api/v1/admin/budget");
        const change = await fetch("/api/v1/admin/budget", {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            expectedVersion: 4,
            monthlyLimitCents: 100000,
            safetyMarginCents: 0,
            fixedCostReserveCents: 0,
            paidOperationsPaused: false,
          }),
        });
        const adjust = await fetch("/api/v1/admin/budget/adjustments", {
          method: "POST",
          headers,
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            amountCents: 1,
            category: "fixed",
            reason: "Owner must not record platform costs",
          }),
        });
        return {
          role: session.role,
          platformAdmin: session.platformAdmin,
          view: view.status,
          change: change.status,
          adjust: adjust.status,
          error: (await change.json()).error.code,
        };
      });
      expect(denied).toEqual({
        role: "owner",
        platformAdmin: false,
        view: 403,
        change: 403,
        adjust: 403,
        error: "PLATFORM_ADMIN_REQUIRED",
      });
      expect((await api.persistedState()).budget).toEqual(beforeDenied);
      expect(
        beforeDenied.audit.filter((entry) => entry.action === "policy.updated"),
      ).toHaveLength(3);
      expect(
        beforeDenied.audit.every((entry) => entry.actorId === api.admin.id),
      ).toBe(true);
      expect(beforeDenied.reservations).toHaveLength(0);
    } finally {
      await ordinaryContext.close();
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("authored outlook retains unresolved costs and dirty policy values across accounting conflicts", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createBudgetApi(
    new URL(baseURL ?? "http://127.0.0.1:5173").origin,
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await login(page, api.admin);
    await openBudget(page);
    await expect(stat(page, "Expected month-end cost")).toHaveText(
      "Unavailable",
    );
    await page
      .getByRole("spinbutton", {
        name: "Fixed monthly reserve · USD",
        exact: true,
      })
      .fill("50");
    await page
      .getByRole("checkbox", { name: /^Pause new paid operations/ })
      .uncheck();
    await page
      .getByRole("button", { name: "Save budget settings", exact: true })
      .click();
    await expect(stat(page, "Available after buffer")).toHaveText("$220.00");
    await fillReview(page);
    await page
      .getByRole("button", { name: "Save cost review", exact: true })
      .click();
    await expect(stat(page, "Low month-end cost")).toHaveText("$80.00");
    await expect(stat(page, "Expected month-end cost")).toHaveText("$100.00");
    await expect(stat(page, "High month-end cost")).toHaveText("$130.00");
    await expect(stat(page, "Available after buffer")).toHaveText("$200.00");
    expect((await dashboard(page)).outlook).toMatchObject({
      review: { status: "fresh" },
      estimatedUnreportedCents: 2000,
      accountedFloorCents: 7000,
      forecast: { lowCents: 8000, expectedCents: 10000, highCents: 13000 },
    });
    await page.locator(".budget-outlook").scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-outlook-desktop.png") });

    const ceiling = page.getByRole("spinbutton", {
      name: "Monthly ceiling · USD",
      exact: true,
    });
    await ceiling.fill("500");
    await page
      .getByRole("spinbutton", { name: "Amount · USD", exact: true })
      .fill("5");
    await page
      .getByRole("combobox", { name: "Cost category", exact: true })
      .selectOption("variable");
    await page
      .getByRole("textbox", { name: "Reason or bill reference", exact: true })
      .fill("Synthetic usage adjustment invalidates earlier review");
    await page
      .getByRole("button", { name: "Record cost entry", exact: true })
      .click();
    await expect(stat(page, "Expected month-end cost")).toHaveText(
      "Unavailable",
    );
    await expect(stat(page, "Available after buffer")).toHaveText("$195.00");
    await expect(ceiling).toHaveValue("500");
    expect((await dashboard(page)).outlook).toMatchObject({
      review: { status: "evidence-changed" },
      estimatedUnreportedCents: 2000,
      forecast: null,
    });
    // A separate real API policy write simulates another administrator; refresh must not erase our draft.
    expect(await realPolicyChange(page, 40000)).toBe(200);
    await page
      .getByRole("button", { name: "Refresh ledger", exact: true })
      .click();
    await expect(ceiling).toHaveValue("500");
    await expect(
      page.getByRole("button", { name: "Save budget settings", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", {
        name: "Keep my values for review",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Keep my values for review", exact: true })
      .click();
    await expect(ceiling).toHaveValue("500");
    expect((await dashboard(page)).policy.monthlyLimitCents).toBe(40000);
    await page
      .getByRole("button", { name: "Save budget settings", exact: true })
      .click();
    await expect(stat(page, "Monthly ceiling")).toHaveText("$500.00");
    await fillReview(page, {
      unreported: "15",
      low: "0",
      expected: "0",
      high: "0",
    });
    await page
      .getByRole("button", { name: "Save cost review", exact: true })
      .click();
    await expect(stat(page, "Expected month-end cost")).toHaveText("$70.00");
    expect((await api.persistedState()).budget.costReviews).toHaveLength(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".budget-outlook").scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-outlook-mobile.png") });
    expect(
      await page
        .getByRole("dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await page
      .getByRole("combobox", { name: "Budget history records", exact: true })
      .selectOption("audit");
    await expect(
      page
        .locator(".budget-records-mobile")
        .getByText("Budget alerts observed", { exact: true })
        .first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("complete budget history retains old running holds and prior-month estimates beyond one hundred rows", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createBudgetApi(
    new URL(baseURL ?? "http://127.0.0.1:5173").origin,
    { historyFixture: true },
  );
  try {
    await api.connect(page);
    await login(page, api.admin);
    await openBudget(page);
    await expect(stat(page, "Available after buffer")).toHaveText("$199.00");
    await expect(stat(page, "Expected month-end cost")).toHaveText(
      "Unavailable",
    );
    expect((await dashboard(page)).outlook).toMatchObject({
      review: { status: "period-changed" },
      estimatedUnreportedCents: 900,
      estimateCarriedFromPriorPeriod: true,
      accountedFloorCents: 7100,
    });
    await page
      .getByRole("combobox", { name: "Budget history records", exact: true })
      .selectOption("reservations");
    await expect(
      page.getByText("1–50 of 105 job reservations.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Next records", exact: true })
      .click();
    await expect(
      page.getByText("51–100 of 105 job reservations.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Next records", exact: true })
      .click();
    await expect(
      page.getByText("101–105 of 105 job reservations.", { exact: true }),
    ).toBeVisible();
    const old = page
      .getByRole("row")
      .filter({ hasText: "Older unresolved operation" });
    await expect(old).toContainText("Awaiting cost reconciliation");
    await expect(old).toContainText("Maximum $12.00");
    await old.locator("summary").click();
    await expect(
      old.getByLabel("Complete retained budget record"),
    ).toContainText("synthetic-older-running-hold");
    await expect(
      page.getByRole("button", { name: "Next records", exact: true }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 768, height: 1024 });
    await old.scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-history-tablet.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOld = page
      .locator(".budget-records-mobile > li")
      .filter({ hasText: "Older unresolved operation" });
    await mobileOld.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(
      mobileOld.getByLabel("Complete retained budget record"),
    ).toBeVisible();
    await mobileOld.scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-history-mobile.png") });
    expect(
      await page
        .getByRole("dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Previous records", exact: true })
      .click();
    await expect(
      page.getByText("51–100 of 105 job reservations.", { exact: true }),
    ).toBeVisible();
    expect((await api.persistedState()).budget.reservations).toHaveLength(105);
  } finally {
    await api.close();
  }
});

test("open review expires without losing policy edits and a late private read cannot survive admin removal", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createBudgetApi(
    new URL(baseURL ?? "http://127.0.0.1:5173").origin,
  );
  let release: (() => void) | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.connect(page);
    await login(page, api.admin);
    await openBudget(page);
    await fillReview(page, {
      unreported: "8",
      low: "0",
      expected: "10",
      high: "20",
    });
    const now = await dashboard(page);
    await page
      .getByLabel("Review expires · UTC", { exact: true })
      .fill(
        new Date(Date.parse(now.outlook!.asOf) + 10000)
          .toISOString()
          .slice(0, 19),
      );
    await page
      .getByRole("button", { name: "Save cost review", exact: true })
      .click();
    await expect(
      page.getByText("Current cost review", { exact: true }),
    ).toBeVisible();
    const ceiling = page.getByRole("spinbutton", {
      name: "Monthly ceiling · USD",
      exact: true,
    });
    await ceiling.fill("333");
    const expiryRead = api.holdNextBudgetRead();
    release = expiryRead.release;
    // Real server time expires the review; no mocked ledger or fixed sleep.
    await expect(stat(page, "Expected month-end cost")).toHaveText(
      "Unavailable",
    );
    await expiryRead.received;
    await expect(
      page
        .locator(".budget-outlook .budget-breakdown > div")
        .filter({
          has: page.locator("dt", { hasText: /^Remaining daily allowance$/ }),
        })
        .locator("dd"),
    ).toHaveText("Unavailable");
    await expect(
      page.getByRole("list", { name: "Current budget alerts" }),
    ).toContainText("A current cost review is required");
    await expect(
      page.getByRole("button", { name: "Save cost review", exact: true }),
    ).toBeDisabled();
    expiryRead.release();
    await expect(ceiling).toHaveValue("333");
    expect((await dashboard(page)).outlook).toMatchObject({
      review: { status: "expired" },
      estimatedUnreportedCents: 800,
      forecast: null,
    });
    await page.locator(".budget-outlook").scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog")
      .screenshot({ path: testInfo.outputPath("budget-review-expired.png") });
    const held = api.holdNextBudgetRead();
    release = held.release;
    await page
      .getByRole("button", { name: "Refresh ledger", exact: true })
      .click();
    await held.received;
    // The already-computed authorized response is delayed; a new real server config removes admin scope.
    await api.restart({ platformAdmin: false });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("heading", { name: "Operating budget", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Operating budget", exact: true }),
    ).toHaveCount(0);
    held.release();
    expect(
      await page.evaluate(
        async () => (await fetch("/api/v1/admin/budget")).status,
      ),
    ).toBe(403);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".account-button")).toContainText(api.admin.name);
    expect((await api.persistedState()).budget.policy.monthlyLimitCents).toBe(
      30000,
    );
    expect(errors).toEqual([]);
  } finally {
    release?.();
    await api.close();
  }
});
