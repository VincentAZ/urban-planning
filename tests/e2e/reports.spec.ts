import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createCollaborationApi } from "./support/collaboration-api";

async function ready(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
}
const homes = (page: Page) =>
  page
    .locator(".metric-card")
    .filter({ has: page.locator(".metric-label", { hasText: /^Homes$/ }) })
    .locator(".metric-value");
async function inspectApartment(page: Page) {
  await page.getByRole("button", { name: "Open feature list" }).click();
  await page
    .getByRole("textbox", { name: "Search places or buildings" })
    .fill("QA apartments");
  await page
    .getByRole("region", { name: "Buildings in the current place" })
    .getByRole("button", { name: /^QA apartments/ })
    .click();
}
async function samplePixels(page: Page, save: boolean): Promise<number> {
  return page
    .locator(".city-map canvas")
    .evaluate((source: HTMLCanvasElement, save) => {
      const target = document.createElement("canvas");
      target.width = 300;
      target.height = 220;
      const ctx = target.getContext("2d")!;
      ctx.drawImage(source, 0, 0, target.width, target.height);
      const pixels = ctx.getImageData(0, 0, target.width, target.height).data;
      const state = window as unknown as { revealPixels?: Uint8ClampedArray };
      if (save) {
        state.revealPixels = pixels;
        return 0;
      }
      let changed = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          Math.abs(pixels[i] - state.revealPixels![i]) +
            Math.abs(pixels[i + 1] - state.revealPixels![i + 1]) +
            Math.abs(pixels[i + 2] - state.revealPixels![i + 2]) >
          45
        )
          changed++;
      return changed;
    }, save);
}

// Synthetic source geometry only; requests, saves, report generation and file downloads use actual HTTP API.
test("reveal uses one camera with distinct geometry, keyboard control and honest split PNG", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      /shader.*error|deck:.*error/i.test(message.text())
    )
      errors.push(message.text());
  });
  try {
    await api.connect(page);
    await ready(page);
    await inspectApartment(page);
    await page
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    await page
      .getByRole("spinbutton", { name: "Entered homes", exact: true })
      .fill("72");
    await page
      .getByRole("spinbutton", { name: "Height", exact: true })
      .fill("100");
    await page.getByRole("button", { name: "Footprint", exact: true }).click();
    await page
      .getByText("Move, rotate, or resize precisely", { exact: true })
      .click();
    await page
      .getByRole("spinbutton", { name: "Target footprint area", exact: true })
      .fill("6000");
    await page
      .getByRole("button", { name: "Resize entire footprint", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    await expect(homes(page)).toContainText("72");
    await page.getByRole("button", { name: "3D city", exact: true }).click();
    const canvas = page.locator(".city-map canvas"),
      original = await canvas.elementHandle();
    await page
      .getByRole("button", { name: "Before / after", exact: true })
      .click();
    const slider = page.getByRole("slider", {
      name: "Before / after reveal",
      exact: true,
    });
    await expect(slider).toHaveValue("50");
    const rangeBounds = await slider.boundingBox();
    if (!rangeBounds) throw new Error("Reveal control has no bounds");
    await page.mouse.move(
      rangeBounds.x + rangeBounds.width / 2,
      rangeBounds.y + rangeBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      rangeBounds.x + rangeBounds.width * 0.3,
      rangeBounds.y + rangeBounds.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    expect(Number(await slider.inputValue())).toBeGreaterThan(20);
    expect(Number(await slider.inputValue())).toBeLessThan(40);
    await expect(page.locator(".city-reveal-labels")).toContainText(
      "Baseline · r0",
    );
    await expect(page.locator(".city-reveal-labels")).toContainText(
      "Option A · r1",
    );
    await expect(homes(page)).toContainText("72");
    await slider.focus();
    await page.keyboard.press("Home");
    await expect(slider).toHaveValue("0");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "0% before, 100% after",
    );
    // Let the GPU render the requested split, then compare actual pixels (not DOM labels).
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await samplePixels(page, true);
    const proposal = await canvas.evaluate((source: HTMLCanvasElement) =>
      source.toDataURL("image/png"),
    );
    await writeFile(
      testInfo.outputPath("reveal-proposal-frame.png"),
      Buffer.from(proposal.split(",")[1], "base64"),
    );
    await page.keyboard.press("End");
    await expect(slider).toHaveValue("100");
    await expect.poll(() => samplePixels(page, false)).toBeGreaterThan(50);
    const baseline = await canvas.evaluate((source: HTMLCanvasElement) =>
      source.toDataURL("image/png"),
    );
    await writeFile(
      testInfo.outputPath("reveal-baseline-frame.png"),
      Buffer.from(baseline.split(",")[1], "base64"),
    );
    await expect(homes(page)).toContainText("72");
    await canvas.click({ position: { x: 80, y: 180 } });
    await expect(
      page.getByRole("heading", { name: "QA apartments", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".city-review-pin")).toHaveCount(0);
    await slider.focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("PageUp");
    await expect(slider).toHaveValue("50");
    // Pan the shared camera so the edited footprint crosses the reveal line.
    const viewBounds = await canvas.boundingBox();
    if (!viewBounds) throw new Error("Map canvas has no bounds");
    await page.mouse.move(
      viewBounds.x + viewBounds.width * 0.22,
      viewBounds.y + viewBounds.height * 0.25,
    );
    await page.mouse.down();
    await page.mouse.move(
      viewBounds.x + viewBounds.width * 0.34,
      viewBounds.y + viewBounds.height * 0.29,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect(slider).toHaveValue("50");
    await page.screenshot({
      path: testInfo.outputPath("reveal-split-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "2D plan", exact: true }).click();
    await expect(slider).toHaveValue("50");
    await page.setViewportSize({ width: 390, height: 844 });
    await slider.scrollIntoViewIfNeeded();
    await expect(page.locator(".city-reveal-labels")).toBeVisible();
    const comparisonLabels = await page
        .locator(".city-reveal-labels")
        .boundingBox(),
      toolbar = await page.locator(".view-switch").boundingBox();
    expect(comparisonLabels?.y).toBeGreaterThan(
      (toolbar?.y ?? 0) + (toolbar?.height ?? 0),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("reveal-split-mobile.png"),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Satellite", exact: true }).click();
    await expect(page.locator(".city-map-attribution")).toContainText(
      /Esri|MapTiler/,
    );
    await page.getByRole("button", { name: "3D city", exact: true }).click();
    expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
    await expect(canvas).toHaveCount(1);
    await page.evaluate(() => {
      const texts: string[] = [];
      Object.assign(window, { exportCanvasTexts: texts });
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (
        text,
        x,
        y,
        width,
      ) {
        texts.push(text);
        if (width === undefined) fill.call(this, text, x, y);
        else fill.call(this, text, x, y, width);
      };
    });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /City view · PNG/ }).click();
    await (
      await download
    ).saveAs(testInfo.outputPath("reveal-split-export.png"));
    const text = await page.evaluate(() =>
      (
        window as unknown as { exportCanvasTexts: string[] }
      ).exportCanvasTexts.join(" "),
    );
    expect(text).toContain(
      "Left / before: Baseline · Revision 0 · 50% of view",
    );
    expect(text).toContain(
      "Right / after: Option A · Revision 1 · 50% of view",
    );
    expect(text).toContain("© OpenStreetMap contributors");
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("proposal notes are reversible, baseline stays locked, and saved reports download through the UI", async ({
  page,
  baseURL,
}, testInfo) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  try {
    await api.connect(page);
    await ready(page);
    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Your name" })
      .fill("QA Report Author");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("report-author@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-report-author-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "QA Report Author",
    );
    const title = "Courtyard homes with a clearer decision";
    const notes =
      "Add homes around a shared courtyard. Preserve a public walking connection.\n\nStaff should verify utility capacity and zoning before approval. The modeled outcomes are planning estimates, not confirmed forecasts.";
    await page
      .getByRole("button", { name: "Scenario details", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Scenario name", exact: true })
      .fill(title);
    await page
      .getByRole("textbox", { name: "Proposal description", exact: true })
      .fill(notes);
    await page
      .getByRole("button", { name: "Save proposal notes", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toContainText(title);
    await page.getByRole("button", { name: "Undo last edit" }).click();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).not.toContainText(title);
    await page.getByRole("button", { name: "Redo edit" }).click();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toContainText(title);
    const scenario = await page
      .getByRole("combobox", { name: "Active scenario" })
      .inputValue();
    await page
      .getByRole("combobox", { name: "Active scenario" })
      .selectOption("baseline");
    await page
      .getByRole("button", { name: "Scenario details", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Proposal description", exact: true }),
    ).toHaveAttribute("readonly", "");
    await expect(
      page.getByRole("button", { name: "Save proposal notes", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("dialog")).toContainText(
      "The baseline is locked",
    );
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Active scenario" })
      .selectOption(scenario);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(notes.split("\n")[0]);
    for (const [label, filename, magic] of [
      [/Staff report · PDF/, "proposal-staff-report.pdf", "%PDF-"],
      [/Editable report · Word/, "proposal-staff-report.docx", "PK"],
    ] as const) {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: label }).click();
      const path = testInfo.outputPath(filename);
      await (await download).saveAs(path);
      const content = await readFile(path);
      expect(content.subarray(0, magic.length).toString()).toBe(magic);
      expect(content.length).toBeGreaterThan(10000);
    }
    const saved = (await api.persistedState()).projects[0];
    expect(
      saved.project.scenarios.find((s) => s.id === scenario),
    ).toMatchObject({ name: title, description: notes });
    expect(
      saved.project.scenarios.find((s) => s.id === "baseline")?.description,
    ).not.toBe(notes);
    await page.screenshot({
      path: testInfo.outputPath("proposal-report-downloads.png"),
      fullPage: true,
    });
  } finally {
    await api.close();
  }
});
