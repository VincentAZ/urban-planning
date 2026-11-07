import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { createCollaborationApi } from "./support/collaboration-api";

test("quick run simulates rush hour in one click and plays SUMO vehicles on the map", async ({
  page,
  baseURL,
}) => {
  test.skip(
    process.env.RUN_TRAFFIC_JOB_QA !== "1",
    "Opt in with RUN_TRAFFIC_JOB_QA=1; requires the retained 85004 graph and pinned offline SUMO.",
  );
  test.setTimeout(300000);
  const isolated = await createCollaborationApi(baseURL!, {
    placeFile: "public/data/zcta-85004-2020.json",
    trafficNativeFixture: true,
    retainTrafficEvidence: true,
  });
  await isolated.connect(page);
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 300));
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Save your work", exact: true }).click();
    await page.getByRole("textbox", { name: "Your name", exact: true }).fill("Demo Planner");
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("demo-planner@urban-planning.test");
    await page.getByLabel(/^Password/).fill("Isolated-quick-run-QA-account-2026");
    await page.getByRole("button", { name: "Create free account", exact: true }).click();
    await expect(page.locator(".account-button")).toContainText("Demo Planner");
    await page.getByRole("button", { name: "Open project home" }).click();
    await page.getByRole("button", { name: "Save current project to account", exact: true }).click();
    await expect(page.getByText("Project saved to your private workspace.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();

    await page.getByRole("button", { name: "Mobility", exact: true }).first().click();
    await page.getByRole("button", { name: "Open traffic workbench", exact: true }).click();
    const quick = page.getByRole("button", { name: "Quick run: simulate rush hour", exact: true });
    await expect(quick).toBeEnabled({ timeout: 60000 });
    await quick.click();
    // The workbench closes itself once the run is saved to the scenario.
    await expect(quick).toBeHidden({ timeout: 240000 });
    await expect(page.locator(".city-map-activity")).toContainText(
      /SUMO-simulated vehicles · 7:00–8:00/,
      { timeout: 30000 },
    );
    const label = (await page.locator(".city-map-activity").textContent())!;
    expect(Number(label.match(/[\d,]+/)![0].replace(/,/g, ""))).toBeGreaterThan(500);
    await expect(page.getByRole("combobox", { name: /time of day/i })).toHaveValue("8");
    // Zoom toward downtown for a street-level look at the vehicles.
    const map = page.locator(".maplibregl-canvas").first();
    const box = (await map.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(isolated.evidenceDirectory, "quick-run-street-level.png") });
    await page.getByRole("button", { name: "2D plan", exact: true }).click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(isolated.evidenceDirectory, "quick-run-2d.png") });
  } finally {
    await isolated.close();
  }
});
