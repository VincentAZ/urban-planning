import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TrafficWorkbenchQAData } from "./support/traffic-workbench";

const root = new URL("../../", import.meta.url);
const artifactPaths = {
  experiment: ".local/qa/traffic/real-85004-pilot-stable-turns/experiment.json",
  network:
    ".local/qa/traffic/real-85004-pilot-stable-turns/baseline-network.json",
  place: "public/data/zcta-85004-2020.json",
};
const harnessHTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local QA · Traffic workbench</title></head><body><div id="root"></div><script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script><script type="module" src="/@vite/client"></script><script type="module" src="/tests/e2e/support/traffic-workbench.tsx"></script></body></html>`;

async function noHorizontalOverflow(page: Page, dialog: Locator) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

async function networkPainted(page: Page) {
  const canvas = page.locator(".traffic-map-canvas canvas");
  await expect(canvas).toBeVisible();
  await expect(page.locator(".traffic-map-canvas")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "Fit traffic network", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(async () => {
      const screenshot = await canvas.screenshot();
      return page.evaluate(async (base64) => {
        const source = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${base64}`)).blob(),
        );
        const sample = document.createElement("canvas");
        sample.width = sample.height = 96;
        const context = sample.getContext("2d")!;
        context.drawImage(source, 0, 0, 96, 96);
        const pixels = context.getImageData(0, 0, 96, 96).data;
        const colors = new Set<string>();
        for (let index = 0; index < pixels.length; index += 4)
          if (pixels[index + 3] > 100)
            colors.add(
              `${pixels[index] >> 4},${pixels[index + 1] >> 4},${pixels[index + 2] >> 4}`,
            );
        source.close();
        return colors.size;
      }, screenshot.toString("base64"));
    })
    .toBeGreaterThanOrEqual(3);
}

// Explicit opt-in: this is retained-real-native component QA, not a durable API workflow.
// It does not run SUMO, claim calibration, change source geometry, or open Vite's .local directory.
test("real retained traffic capture supports network, evidence, comparison and accessible draft review", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.RUN_TRAFFIC_UI_QA !== "1",
    "Set RUN_TRAFFIC_UI_QA=1 to inspect the retained real Phoenix traffic capture.",
  );
  const evidence: { path: string; bytes: number; sha256: string }[] = [];
  const values: Record<string, unknown> = {};
  try {
    for (const [key, path] of Object.entries(artifactPaths)) {
      const filename = fileURLToPath(new URL(path, root));
      const info = await stat(filename);
      expect(
        info.size,
        `Bounded retained artifact ${path}`,
      ).toBeLessThanOrEqual(64 * 1024 * 1024);
      const bytes = await readFile(filename);
      evidence.push({
        path,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      values[key] = JSON.parse(bytes.toString("utf8"));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    test.skip(
      true,
      "Retained native traffic artifacts are unavailable; no synthetic substitute is used.",
    );
    return;
  }
  const data = values as unknown as TrafficWorkbenchQAData;
  // Reduce display-only payload; exact study area, bounds, IDs and traffic graph remain untouched.
  data.place = { ...data.place, buildings: [], roads: [] };
  expect(data.network.edges).toHaveLength(22739);
  expect(data.experiment.request.countPack.counts).toHaveLength(456);
  expect(data.experiment.calibration).toBeNull();
  expect(data.network.manifest.networkFileSha256).toBe(
    data.experiment.recipe.baselineNetworkHash,
  );
  for (const side of ["baseline", "proposal"] as const) {
    expect(data.experiment[side].diagnostics).toMatchObject({
      requested: 700,
      loaded: 700,
      inserted: 700,
      arrived: 700,
      running: 0,
      waiting: 0,
      discarded: 0,
      teleports: 0,
      collisions: 0,
      routeErrors: 0,
    });
    expect(data.experiment.comparison[side]).toMatchObject({
      requested: 700,
      completed: 700,
      measurementRequested: 600,
      measurementCompleted: 600,
      status: "complete",
    });
  }
  const errors: string[] = [],
    developmentWarnings: string[] = [],
    apiRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Chromium local-network policy can block the Vite development HMR socket
    // for a route-fulfilled test page. Record it separately from application errors.
    if (
      /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:5173\/.*ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS/.test(
        message.text(),
      ) ||
      message.text().startsWith("[vite] failed to connect to websocket.")
    ) {
      developmentWarnings.push(message.text());
      return;
    }
    if (
      message.type() === "error" &&
      !/^Failed to load resource:/.test(message.text())
    )
      errors.push(message.text());
    else if (
      /Each child in a list|same key|Maximum update depth|shader.*error|deck:.*error/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      apiRequests.push(
        request.method() + " " + new URL(request.url()).pathname,
      );
  });
  await page.route("**/__traffic-workbench", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: harnessHTML }),
  );
  const body = JSON.stringify(data);
  await page.route("**/__traffic-qa-data", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body,
    }),
  );
  await testInfo.attach("retained-native-input-identity", {
    body: JSON.stringify(
      {
        scope:
          "Retained actual native run; authored demand; no API persistence or new execution",
        artifacts: evidence,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await page.goto("/__traffic-workbench");
  const dialog = page.getByRole("dialog", {
    name: "See how the streets respond.",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("22,739 directed edges", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Local QA only · actual authored-demand run/),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Save traffic configuration",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", {
      name: "Run paired traffic analysis",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await networkPainted(page);
  await noHorizontalOverflow(page, dialog);
  await page.screenshot({
    path: testInfo.outputPath("traffic-native-network-desktop.png"),
    fullPage: false,
  });

  const networkTab = dialog.getByRole("tab", { name: "Network", exact: true });
  await networkTab.focus();
  await page.keyboard.press("ArrowRight");
  const countsTab = dialog.getByRole("tab", {
    name: "Counts & demand",
    exact: true,
  });
  await expect(countsTab).toBeFocused();
  await expect(countsTab).toHaveAttribute("aria-selected", "true");
  const counts = dialog.getByRole("tabpanel", {
    name: "Counts & demand",
    exact: true,
  });
  await expect(
    counts
      .locator(".traffic-stats > div")
      .filter({ hasText: "retained interval records" })
      .locator("strong"),
  ).toHaveText(String(data.experiment.request.countPack.counts.length));
  await expect(
    counts
      .locator(".traffic-stats > div")
      .filter({ hasText: "need network mapping" })
      .locator("strong"),
  ).toHaveText(
    String(
      data.experiment.request.countPack.counts.filter((count) => !count.target)
        .length,
    ),
  );
  await counts
    .getByRole("textbox", { name: "Find a count station", exact: true })
    .scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page, dialog);
  await page.screenshot({
    path: testInfo.outputPath("traffic-native-counts-desktop.png"),
    fullPage: false,
  });
  await dialog.getByRole("tab", { name: "Results", exact: true }).click();
  const results = dialog.getByRole("tabpanel", {
    name: "Results",
    exact: true,
  });
  await expect(results.getByText("700 / 700", { exact: true })).toHaveCount(2);
  await expect(
    results.getByText(/Analysis-window cohort: 600 completed \/ 600 requested/),
  ).toHaveCount(2);
  await expect(
    results.getByText(
      /No recorded calibration\/holdout evaluation is attached/,
    ),
  ).toBeVisible();
  await expect(
    results.getByText(/It is not HCM intersection control delay/),
  ).toBeVisible();
  const travel = results
    .getByRole("table")
    .first()
    .getByRole("row")
    .filter({ hasText: "Mean travel time" });
  await expect(travel).toContainText("119.1");
  await expect(travel).toContainText("144");
  await expect(travel).toContainText("24.9");
  await results
    .getByRole("heading", {
      name: "What changed, and what is still uncertain.",
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("traffic-native-results-desktop.png"),
    fullPage: false,
  });

  await networkTab.click();
  await dialog
    .getByRole("textbox", { name: "Find a directed street", exact: true })
    .fill("437360250");
  await dialog
    .locator(".traffic-network-list")
    .getByRole("button")
    .filter({ hasText: /^437360250/ })
    .click();
  const speed = dialog.getByRole("textbox", {
    name: "Proposed speed (m/s)",
    exact: true,
  });
  await expect(speed).toHaveValue("15");
  await speed.fill("12");
  await expect(
    dialog.getByText("Local review · not saved", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await dialog.getByRole("tab", { name: "Results", exact: true }).click();
  await expect(
    results.getByText(/Local review inputs have changed/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Leave this traffic review?",
  });
  await expect(
    confirmation.getByRole("button", { name: "Keep reviewing", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "Discard local review", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(
    "Local review closed. Retained inputs are unchanged.",
  );
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Reopen local traffic review", exact: true })
    .click();
  await networkPainted(page);
  await noHorizontalOverflow(page, dialog);
  await page.screenshot({
    path: testInfo.outputPath("traffic-native-network-mobile.png"),
    fullPage: false,
  });
  await dialog
    .getByRole("textbox", { name: "Find a directed street", exact: true })
    .fill("437360250");
  await dialog
    .locator(".traffic-network-list")
    .getByRole("button")
    .filter({ hasText: /^437360250/ })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Proposed speed (m/s)", exact: true }),
  ).toHaveValue("15");
  await dialog.getByRole("tab", { name: "Results", exact: true }).click();
  await expect(results.getByText("700 / 700", { exact: true })).toHaveCount(2);
  await noHorizontalOverflow(page, dialog);
  await results
    .getByRole("heading", {
      name: "What changed, and what is still uncertain.",
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("traffic-native-results-mobile.png"),
    fullPage: false,
  });
  const mobileTravel = results.getByRole("region", {
    name: "Mean travel time",
    exact: true,
  });
  await mobileTravel.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await expect(mobileTravel).toBeInViewport();
  for (const value of [
    "Baseline",
    "Proposal",
    "Change",
    "119.1",
    "144",
    "24.9",
  ])
    await expect(mobileTravel.getByText(value, { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("traffic-native-measures-mobile.png"),
    fullPage: false,
  });
  expect(apiRequests).toEqual([]);
  await testInfo.attach("development-runtime-warnings", {
    body: JSON.stringify(developmentWarnings, null, 2),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  // The test intercepts only its two private QA URLs, never a filesystem permission override.
  expect(
    (
      await page.request.get(
        "/.local/qa/traffic/real-85004-pilot-stable-turns/experiment.json",
      )
    ).status(),
  ).toBe(403);
});
