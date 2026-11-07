import { test, expect, type Locator } from "@playwright/test";
import {
  applyCommand,
  accessibilityContentHash,
  baselineIdentity,
  projectWithAccessibilityVersion,
  validateProjectSnapshot,
  type ProjectSnapshot,
} from "../../packages/core/src/index";
import {
  createProject,
  createAccessibilityModeEvidence,
  resolveAccessibility,
} from "../../packages/models/src/index";
import {
  accessibilityFixture,
  accessibilityRunFixture,
} from "../fixtures/accessibility";
import { createCollaborationApi } from "./support/collaboration-api";

/** Synthetic, source-reconciled imported evidence. No native provider, private archive or QA-file dependency. */
async function largeSubtotalSnapshot(): Promise<ProjectSnapshot> {
  const fixture = await accessibilityFixture();
  const pack = structuredClone(fixture.pack);
  for (const key of ["C000", "CE01", "CNS01"]) {
    pack.destinations[0].cells[key] = 1_898_521;
    pack.destinations[0].raw[key] = "1898521";
  }
  const run = await accessibilityRunFixture(pack);
  run.rows[1] = {
    ...run.rows[1],
    status: "unreachable",
    seconds: null,
    distanceMeters: null,
  };
  const result = await resolveAccessibility(pack, run);
  const project = createProject(fixture.place);
  project.name = "Synthetic seven-digit accessibility layout";
  const evidence = await createAccessibilityModeEvidence({
    binding: {
      placeId: fixture.place.id,
      baselineHash: await accessibilityContentHash(fixture.place),
    },
    receipt: { projectId: project.id, jobId: "synthetic-large-layout" },
    pack,
    artifact: { ...fixture.artifact, run, result },
  });
  evidence.origin = "imported";
  const index = project.scenarios.findIndex(
    (scenario) => scenario.id === project.activeScenarioId,
  );
  project.scenarios[index] = applyCommand(project.scenarios[index], {
    type: "scenario.accessibility",
    mode: "car",
    evidence,
  });
  for (const threshold of evidence.capture.thresholds) {
    expect(threshold.total).toMatchObject({
      estimate: null,
      knownSubtotal: 1_898_521,
      status: "partial",
      unresolvedJobs: 20,
      upperBound: 1_898_541,
    });
    for (const family of [threshold.earnings, threshold.industries])
      expect(family.reduce((sum, row) => sum + row.knownSubtotal!, 0)).toBe(
        1_898_521,
      );
  }
  return validateProjectSnapshot({
    project: projectWithAccessibilityVersion(project, fixture.place),
    place: fixture.place,
    baselineIdentity: await baselineIdentity(fixture.place),
  });
}

async function assertSingleLine(number: Locator) {
  await expect(number).toHaveText("1,898,521");
  await expect
    .poll(() =>
      number.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = Array.from(range.getClientRects()).filter(
          (rect) => rect.width > 0 && rect.height > 0,
        );
        const own = element.getBoundingClientRect();
        const parent = element.parentElement!.getBoundingClientRect();
        return {
          lines: lines.length,
          // A nowrap rule must not merely push or clip the number outside its card.
          contained:
            lines.every(
              (rect) =>
                rect.left >= parent.left - 1 && rect.right <= parent.right + 1,
            ) &&
            own.left >= parent.left - 1 &&
            own.right <= parent.right + 1,
        };
      }),
    )
    .toEqual({ lines: 1, contained: true });
}

test("seven-digit imported accessibility subtotals stay complete on desktop and 390px mobile", async ({
  page,
  baseURL,
}, info) => {
  const snapshot = await largeSubtotalSnapshot();
  const isolated = await createCollaborationApi(baseURL!);
  await isolated.connect(page);
  const errors: string[] = [],
    privateRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      /\/accessibility\/jobs(?:\/|\?|$)/.test(new URL(request.url()).pathname)
    )
      privateRequests.push(request.url());
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Import data", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Saved project", exact: true })
      .click();
    await page.locator("input[type=file]").setInputFiles({
      name: "synthetic-large-accessibility.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(snapshot)),
    });
    await page
      .getByRole("button", { name: "Restore as a copy", exact: true })
      .click();
    await page.getByRole("button", { name: "Economy", exact: true }).click();
    await page.getByRole("button", { name: "Readiness", exact: true }).click();
    await page
      .getByRole("button", { name: "Open jobs accessibility", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Where can you get to work?",
      exact: true,
    });
    await expect(dialog).toContainText("not verified by this server");
    await expect(dialog).toContainText("Known subtotal only");
    await expect(dialog).toContainText("Full total unavailable");

    for (const [label, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      const quick = dialog.locator(".accessibility-quick");
      await quick.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`accessibility-large-${label}-summary.png`),
      });
      await assertSingleLine(
        quick.locator("strong").filter({ hasText: /^1,898,521$/ }),
      );
      const results = dialog.locator(".accessibility-results");
      await results
        .locator(".accessibility-thresholds")
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`accessibility-large-${label}-thresholds.png`),
      });
      const thresholds = results.locator(
        ".accessibility-thresholds button > strong",
      );
      await expect(thresholds).toHaveCount(3);
      for (let i = 0; i < 3; i++) await assertSingleLine(thresholds.nth(i));
      const category = results
        .locator(".accessibility-category-value > strong")
        .filter({ hasText: /^1,898,521$/ });
      await expect(category).toHaveCount(1);
      await assertSingleLine(category);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
    }
    expect(privateRequests).toEqual([]);
    const state = await isolated.persistedState();
    expect(state.accessibilityJobs).toHaveLength(0);
    expect(state.accessibilityArtifacts).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await isolated.close();
  }
});
