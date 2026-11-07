import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseTrafficCSV } from "@urban/core";
import type { TrafficContext } from "../../apps/api/src/traffic/jobs-types";
import { createCollaborationApi } from "./support/collaboration-api";

const dialogFor = (page: Page) =>
  page.getByRole("dialog", {
    name: "See how the streets respond.",
    exact: true,
  });
const preparedId = "phoenix-85004-commute-access-v1";

for (const preparation of [
  {
    name: "strict 39 routes",
    registry: ".local/traffic/registry-commute-qa.json",
    routed: 39,
    expected: "5.64",
    unresolved: "111.962397",
    vehicles: 6,
    inspectLedger: false,
  },
  {
    name: "source-proven 660 routes",
    registry: ".local/traffic/registry-commute-v3-qa.json",
    routed: 660,
    expected: "94.76",
    unresolved: "22.843713",
    vehicles: 95,
    inspectLedger: true,
  },
])
  test(`Census commute review preserves partial coverage through explicit selection, editable copy, native run and adoption · ${preparation.name}`, async ({
    page,
    baseURL,
  }) => {
    test.skip(
      process.env.RUN_TRAFFIC_COMMUTE_QA !== "1",
      "Requires the separately packaged real Census cohort and both retained networks.",
    );
    test.setTimeout(360000);
    const isolated = await createCollaborationApi(baseURL!, {
      placeFile: "public/data/zcta-85004-2020.json",
      trafficNativeFixture: true,
      trafficRegistryPath: preparation.registry,
      retainTrafficEvidence: true,
    });
    await isolated.connect(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto("/");
      await expect(
        page.getByRole("combobox", { name: "Active scenario" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Save your work", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Your name", exact: true })
        .fill("QA Commute Reviewer");
      await page
        .getByRole("textbox", { name: "Email", exact: true })
        .fill("commute-reviewer@urban-planning.test");
      await page
        .getByLabel(/^Password/)
        .fill("Isolated-commute-browser-QA-2026");
      await page
        .getByRole("button", { name: "Create free account", exact: true })
        .click();
      await expect(page.locator(".account-button")).toContainText(
        "QA Commute Reviewer",
      );
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
      await page
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      const saved = (await isolated.persistedState()).projects[0];
      const open = async () => {
        await page
          .getByRole("button", { name: "Mobility", exact: true })
          .first()
          .click();
        await page
          .getByRole("button", { name: "Open traffic workbench", exact: true })
          .click();
        await expect(dialogFor(page)).toBeVisible();
      };
      await open();
      const dialog = dialogFor(page);
      const selector = dialog.getByRole("combobox", {
        name: "Prepared traffic network",
      });
      await expect(selector).toBeEnabled();
      expect(await selector.inputValue()).not.toBe(preparedId);
      await selector.selectOption(preparedId);
      // A cold source-geometry preparation performs bounded server replay before
      // it becomes the selected verified network; preserve the default until then.
      await expect(selector).toHaveValue(preparedId, { timeout: 60000 });
      await dialog
        .getByRole("tab", { name: "Counts & demand", exact: true })
        .click();
      const panel = dialog.getByRole("tabpanel", {
        name: "Counts & demand",
        exact: true,
      });
      const review = panel.getByRole("region", {
        name: "Census commute preparation",
      });
      await expect(review).toContainText("Partial cohort coverage");
      await expect(review).toContainText(`${preparation.routed} of 805`);
      await expect(review.locator(".traffic-commute-stats")).toContainText(
        "120",
      );
      await expect(review.locator(".traffic-commute-stats")).toContainText(
        preparation.expected,
      );
      await page.screenshot({
        path: join(isolated.evidenceDirectory, "commute-desktop-review.png"),
      });
      await review
        .getByText("Where every estimated trip goes", { exact: true })
        .click();
      const accounting = review.getByRole("table", {
        name: "Fractional expected vehicles before rounding",
        exact: true,
      });
      await expect(accounting).toContainText(preparation.unresolved);
      const context = (await page.evaluate(
        async ({ projectId, scenarioId, preparedId }) => {
          const response = await fetch(
            `/api/v1/projects/${projectId}/traffic/context?scenarioId=${scenarioId}&preparedId=${preparedId}`,
          );
          if (!response.ok) throw new Error(`Context ${response.status}`);
          return response.json();
        },
        {
          projectId: saved.project.id,
          scenarioId: saved.project.activeScenarioId,
          preparedId,
        },
      )) as TrafficContext;
      const preset = context.commutePresets![0];
      const pending = page.waitForEvent("download");
      await review
        .getByRole("button", {
          name: "Download complete evidence",
          exact: true,
        })
        .click();
      const downloaded = await pending;
      const bytes = await readFile((await downloaded.path())!);
      expect(bytes.length).toBe(preset.evidenceFile.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        preset.evidenceFile.sha256,
      );
      await writeFile(
        join(isolated.evidenceDirectory, "commute-downloaded-evidence.json"),
        bytes,
      );
      if (preparation.inspectLedger) {
        await review
          .getByRole("button", { name: "Inspect trip accounting", exact: true })
          .click();
        const ledger = review.getByRole("region", {
          name: "Follow the trips",
          exact: true,
        });
        await expect(ledger).toBeVisible({ timeout: 45000 });
        await expect(
          review.getByRole("group", {
            name: "Complete trip accounting",
            exact: true,
          }),
        ).toBeFocused();
        const global = ledger.locator(
          '[aria-label="Unfiltered preparation totals"]',
        );
        await expect(global).toContainText(
          "1,610 flow/bin records · 805 distinct source OD pairs",
        );
        await expect(global).toContainText("2.3972");
        await expect(global).toContainText("22.8437");
        await expect(global).toContainText("94.7591");
        const globalText = await global.innerText();
        const rows = ledger.locator(".traffic-ledger-flows tbody > tr");
        await expect(rows).toHaveCount(50);
        await ledger
          .getByRole("button", { name: "Next flow page", exact: true })
          .click();
        await expect(
          ledger.getByRole("navigation", { name: "Flow pages", exact: true }),
        ).toContainText("Page 2 of 33");
        await ledger
          .getByRole("combobox", { name: "Flow outcome", exact: true })
          .selectOption("unresolved");
        await expect(ledger.getByRole("status")).toContainText(
          "290 matching flow/bin records · 145 distinct source OD pairs",
        );
        await ledger
          .getByRole("searchbox", {
            name: "Search home or work block",
            exact: true,
          })
          .fill("not-a-block");
        await expect(rows).toHaveCount(0);
        await expect(ledger.getByRole("status")).toContainText(
          "No records match",
        );
        expect(await global.innerText()).toBe(globalText);
        const exportAll = async (label: string, filename: string) => {
          const pending = page.waitForEvent("download");
          await ledger
            .getByRole("button", { name: label, exact: true })
            .click();
          const result = await pending;
          const raw = await readFile((await result.path())!);
          await writeFile(join(isolated.evidenceDirectory, filename), raw);
          return parseTrafficCSV(raw.toString("utf8"));
        };
        // The empty filtered view must still export every source row, including
        // positive fractions rounded to zero and the separate source-cell residual.
        const flows = await exportAll(
          "Export all flow records · CSV",
          "commute-flows.csv",
        );
        expect(flows.rows).toHaveLength(1610);
        const column = (header: string) => {
          const index = flows.headers.indexOf(header);
          expect(index).toBeGreaterThanOrEqual(0);
          return index;
        };
        const rounded = column("rounded_vehicles"),
          expected = column("source_expected_vehicles"),
          admitted = column("admitted_expected_vehicles");
        expect(
          flows.rows.reduce(
            (total, row) => total + Number(row.cells[rounded]),
            0,
          ),
        ).toBe(95);
        expect(
          flows.rows.reduce(
            (total, row) => total + Number(row.cells[expected]),
            0,
          ),
        ).toBeCloseTo(117.60282021151586, 9);
        expect(
          flows.rows.some(
            (row) =>
              Number(row.cells[admitted]) > 0 &&
              Number(row.cells[rounded]) === 0,
          ),
        ).toBe(true);
        await ledger
          .getByText("Source-cell allocation · 2 cells", { exact: true })
          .click();
        const cells = await exportAll(
          "Export all source cells · CSV",
          "commute-source-cells.csv",
        );
        expect(cells.rows).toHaveLength(2);
        const unresolvedIndex = cells.headers.indexOf(
          "unresolved_expected_vehicles",
        );
        expect(unresolvedIndex).toBeGreaterThanOrEqual(0);
        expect(
          cells.rows.reduce(
            (total, row) => total + Number(row.cells[unresolvedIndex]),
            0,
          ),
        ).toBeCloseTo(2.397179788484136, 12);
        await ledger
          .getByRole("button", { name: "Clear filters", exact: true })
          .click();
        await expect(rows).toHaveCount(50);
        const inspect = ledger
          .getByRole("button", { name: /^Inspect flow record / })
          .first();
        await inspect.focus();
        await page.keyboard.press("Enter");
        await expect(inspect).toHaveAttribute("aria-expanded", "true");
        await expect(
          ledger.getByRole("heading", {
            name: "Exact modeled vehicle accounting",
            exact: true,
          }),
        ).toBeVisible();
        await inspect.press("Enter");
        await ledger
          .getByRole("heading", { name: "Follow the trips", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(isolated.evidenceDirectory, "commute-ledger-desktop.png"),
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await ledger
          .getByRole("heading", { name: "Follow the trips", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            isolated.evidenceDirectory,
            "commute-ledger-mobile-totals.png",
          ),
        });
        await global
          .locator(".traffic-ledger-primary")
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            isolated.evidenceDirectory,
            "commute-ledger-mobile-quantities.png",
          ),
        });
        await global.locator(".traffic-ledger-losses").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            isolated.evidenceDirectory,
            "commute-ledger-mobile-losses.png",
          ),
        });
        await ledger
          .getByRole("region", { name: "Flow ledger records", exact: true })
          .locator(".traffic-ledger-mobile-card")
          .first()
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            isolated.evidenceDirectory,
            "commute-ledger-mobile-records.png",
          ),
        });
        expect(
          await ledger.evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          ),
        ).toBeLessThanOrEqual(1);
        const mobileInspect = ledger
          .getByRole("button", { name: /^Inspect flow record / })
          .first();
        await mobileInspect.click();
        await expect(mobileInspect).toHaveAttribute("aria-expanded", "true");
        await expect(
          ledger.getByRole("heading", {
            name: "Exact modeled vehicle accounting",
            exact: true,
          }),
        ).toBeVisible();
        await mobileInspect.click();
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      // A reviewed authored source is replaced along with demand; its now-hidden
      // declaration must not survive and make the next save impossible.
      const permissions = dialog.locator(".traffic-source-details").filter({
        has: page
          .locator("summary")
          .filter({ hasText: "Review authored-source permissions (1)" }),
      });
      await permissions.locator("summary").first().click();
      await permissions
        .getByText("Authored traffic assumptions", { exact: true })
        .click();
      await permissions
        .getByRole("checkbox", { name: /^I have permission to retain/ })
        .check();
      await review
        .getByRole("button", { name: "Use this commute recipe", exact: true })
        .click();
      await expect(
        panel.getByLabel("Traffic analysis date", { exact: true }),
      ).toBeDisabled();
      await expect(
        panel.getByLabel("Traffic random seed", { exact: true }),
      ).toBeEnabled();
      const save = async () => {
        await dialog
          .getByRole("checkbox", {
            name: /^I understand this is an explicit network experiment/,
          })
          .check();
        await dialog
          .getByRole("button", {
            name: "Save traffic configuration",
            exact: true,
          })
          .click();
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
        ).toBeEnabled();
      };
      await save();
      const bound = (await isolated.persistedState()).trafficConfigs.at(-1)!;
      expect(bound.prepared.id).toBe(preparedId);
      expect(bound.request.commute).toEqual(preset.summary.binding);
      await review
        .getByRole("button", { name: "Make an editable copy", exact: true })
        .click();
      await expect(
        panel.getByLabel("Traffic analysis date", { exact: true }),
      ).toBeEnabled();
      await panel
        .getByLabel("Traffic analysis date", { exact: true })
        .fill("2025-10-03");
      await save();
      const authored = (await isolated.persistedState()).trafficConfigs.at(-1)!;
      expect(authored.request.commute).toBeUndefined();
      expect(authored.request.period.date).toBe("2025-10-03");
      expect(authored.request.demand.notes.join(" ")).toContain(
        "authored assumption",
      );
      await review
        .getByRole("button", { name: "Use this commute recipe", exact: true })
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", {
          name: "Replace draft demand and clock",
          exact: true,
        })
        .click();
      await expect(
        panel.getByLabel("Traffic analysis date", { exact: true }),
      ).toHaveValue("2025-10-02");
      await save();
      await page.setViewportSize({ width: 390, height: 844 });
      await review.scrollIntoViewIfNeeded();
      expect(
        await review
          .getByRole("table", {
            name: "Fractional expected vehicles before rounding",
            exact: true,
          })
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: join(isolated.evidenceDirectory, "commute-mobile-review.png"),
      });
      await accounting.screenshot({
        path: join(isolated.evidenceDirectory, "commute-mobile-accounting.png"),
      });
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await dialog
        .getByRole("button", {
          name: "Run paired traffic analysis",
          exact: true,
        })
        .click();
      await expect
        .poll(
          async () =>
            (await isolated.persistedState()).trafficJobs.at(-1)?.status,
          { timeout: 180000, intervals: [1500, 2500, 5000] },
        )
        .toBe("completed");
      await dialog.getByRole("tab", { name: "Results", exact: true }).click();
      const results = dialog.getByRole("tabpanel", {
        name: "Results",
        exact: true,
      });
      await expect(results).toContainText("Partial cohort coverage");
      await expect(results).toContainText(`${preparation.routed} of 805`);
      await expect(
        dialog.getByRole("button", {
          name: "Save traffic capture to scenario",
          exact: true,
        }),
      ).toBeEnabled({ timeout: 30000 });
      await page.screenshot({
        path: join(isolated.evidenceDirectory, "commute-desktop-result.png"),
      });
      await dialog
        .getByRole("button", {
          name: "Save traffic capture to scenario",
          exact: true,
        })
        .click();
      await expect(
        dialog.getByRole("heading", {
          name: "Saved with this scenario",
          exact: true,
        }),
      ).toBeVisible({ timeout: 30000 });
      const state = await isolated.persistedState();
      const scenario = state.projects[0].project.scenarios.find(
        (item) => item.id === saved.project.activeScenarioId,
      )!;
      expect(scenario.traffic!.capture.originalDemand.commute).toEqual(
        preset.summary,
      );
      expect(scenario.traffic!.capture.comparison.baseline.completed).toBe(
        preparation.vehicles,
      );
      expect(scenario.traffic!.capture.comparison.proposal.completed).toBe(
        preparation.vehicles,
      );
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      await isolated.restart();
      await isolated.connect(page);
      await page.goto("/");
      await open();
      await expect(
        dialogFor(page).getByRole("combobox", {
          name: "Prepared traffic network",
        }),
      ).toHaveValue(preparedId, { timeout: 60000 });
      await dialogFor(page)
        .getByRole("tab", { name: "Results", exact: true })
        .click();
      await expect(
        dialogFor(page).getByRole("tabpanel", { name: "Results", exact: true }),
      ).toContainText("Partial cohort coverage");
      expect(errors).toEqual([]);
      await writeFile(
        join(isolated.evidenceDirectory, "commute-browser-verification.json"),
        JSON.stringify(
          {
            status: "verified",
            preparedId,
            presetId: preset.id,
            binding: preset.summary.binding,
            evidenceFile: preset.evidenceFile,
            configuredIds: state.trafficConfigs.map((item) => item.id),
            jobId: state.trafficJobs.at(-1)!.id,
            captureHash: scenario.traffic!.captureHash,
            browserErrors: errors,
          },
          null,
          2,
        ),
      );
      console.log(`Commute browser evidence: ${isolated.evidenceDirectory}`);
    } finally {
      await isolated.close();
    }
  });
