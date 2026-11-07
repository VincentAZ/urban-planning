import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Place,
  Project,
  ModelResults,
} from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

type Download = {
  project: Project;
  place: Place;
  results: ModelResults;
  baselineIdentity: { sha256: string };
};
const active = (data: Download) =>
  data.project.scenarios.find((s) => s.id === data.project.activeScenarioId)!;
async function settled(page: Page) {
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
}
async function exportProject(page: Page): Promise<Download> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Complete project · JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error("No export");
  const data = JSON.parse(await readFile(path, "utf8"));
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  return data;
}
async function controls(page: Page) {
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page
    .getByRole("button", { name: /^(Set up|Edit) People controls$/ })
    .click();
  await expect(page.getByLabel("Resulting draft counts")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function apply(page: Page) {
  await page
    .getByRole("button", { name: "Apply People controls", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit People controls", exact: true }),
  ).toBeVisible();
  await settled(page);
}
async function presets(page: Page) {
  const details = page.locator(".activity-preset-picker");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
}
async function reference(
  page: Page,
  dimension: "population" | "vehicle",
  count: number,
) {
  await page
    .getByRole("button", { name: `Choose ${dimension} reference`, exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Reference method", exact: true })
    .selectOption("entered");
  await dialog
    .getByRole("spinbutton", {
      name:
        dimension === "population"
          ? "Population reference count"
          : "Household vehicles reference count",
      exact: true,
    })
    .fill(String(count));
  await dialog
    .getByRole("spinbutton", { name: "Reference year", exact: true })
    .fill("2024");
  await dialog
    .getByRole("textbox", {
      name: "Geography and population covered",
      exact: true,
    })
    .fill("Synthetic QA reference covering the complete study boundary");
  await dialog
    .getByRole("textbox", { name: "Source name or description", exact: true })
    .fill("Synthetic QA entered evidence");
  await dialog
    .getByRole("button", { name: "Use reference in draft", exact: true })
    .click();
}

test("absolute and reference-percent counts, reviewed demand and sourced forecast remain atomic and inspectable", async ({
  page,
}, testInfo) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api.connect(page);
    await page.goto("/");
    await settled(page);
    const original = await exportProject(page);
    await controls(page);
    await reference(page, "population", 1000);
    await reference(page, "vehicle", 800);
    await page
      .getByRole("combobox", { name: "Population target method", exact: true })
      .selectOption("baseline-percent");
    await page
      .getByRole("spinbutton", {
        name: "Population percent of reference",
        exact: true,
      })
      .fill("125");
    await page
      .getByRole("combobox", {
        name: "Household vehicles target method",
        exact: true,
      })
      .selectOption("baseline-percent");
    await page
      .getByRole("spinbutton", {
        name: "Household vehicles percent of reference",
        exact: true,
      })
      .fill("125");
    await expect(page.getByLabel("Resulting draft counts")).toContainText(
      "1,250",
    );
    await presets(page);
    await page
      .getByRole("button", { name: "+25% population", exact: false })
      .click();
    await page
      .getByRole("button", { name: "+25% population", exact: false })
      .click();
    await expect(
      page.getByRole("spinbutton", {
        name: "Population percent of reference",
        exact: true,
      }),
    ).toHaveValue("125");
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeDisabled();
    await apply(page);
    const counts = await exportProject(page);
    expect(active(counts).activity?.global.population).toEqual({
      mode: "baseline-percent",
      percent: 125,
    });
    expect(active(counts).activity?.demandResponse.population).toBe("none");
    expect(counts.place).toEqual(original.place);
    expect(counts.baselineIdentity).toEqual(original.baselineIdentity);
    const trip = (d: Download) =>
      d.results.metrics.find((m) => m.id === "mobility.dailyTrips")?.value;
    expect(trip(counts)).toBe(trip(original));
    await controls(page);
    await page.getByRole("button", { name: "Demand", exact: true }).click();
    const population = page.getByRole("checkbox", {
      name: "Scale residential demand with effective population.",
      exact: true,
    });
    await expect(population).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I have reviewed proportional demand responses and their limits.",
        exact: true,
      })
      .check();
    await population.check();
    await page
      .getByRole("checkbox", {
        name: "Use the household vehicle stock ratio for residential demand.",
        exact: true,
      })
      .check();
    await expect(page.getByLabel("Resulting draft counts")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await page.screenshot({
      path: testInfo.outputPath("reviewed-demand.png"),
      fullPage: true,
    });
    await apply(page);
    const both = await exportProject(page);
    await controls(page);
    await page.getByRole("button", { name: "Demand", exact: true }).click();
    await population.uncheck();
    await apply(page);
    const stockOnly = await exportProject(page);
    expect(trip(stockOnly)).toBe(trip(both));
    expect(trip(stockOnly)).not.toBe(trip(counts));
    await controls(page);
    await page.getByRole("button", { name: "Counts", exact: true }).click();
    await presets(page);
    await page
      .getByRole("button", {
        name: "+10 years at regional forecast",
        exact: false,
      })
      .click();
    const forecast = page.getByRole("dialog");
    await forecast
      .getByRole("textbox", { name: "Source name or description", exact: true })
      .fill("Synthetic regional projection for workflow QA");
    await forecast
      .getByRole("textbox", { name: "Source URL (if available)", exact: true })
      .fill("https://example.org/qa-forecast");
    await forecast
      .getByRole("textbox", { name: "Forecast geography", exact: true })
      .fill("Synthetic wider region");
    await forecast
      .getByRole("spinbutton", { name: "Forecast base year", exact: true })
      .fill("2024");
    await forecast
      .getByRole("spinbutton", { name: "Forecast target year", exact: true })
      .fill("2035");
    await forecast
      .getByRole("spinbutton", { name: "Population at base year", exact: true })
      .fill("10000");
    await forecast
      .getByRole("spinbutton", {
        name: "Population at target year",
        exact: true,
      })
      .fill("14000");
    await forecast
      .getByRole("button", { name: "Use forecast in draft", exact: true })
      .click();
    await expect(forecast.getByRole("alert")).toContainText("ten-year");
    await forecast
      .getByRole("spinbutton", { name: "Forecast target year", exact: true })
      .fill("2034");
    await forecast
      .getByRole("button", { name: "Use forecast in draft", exact: true })
      .click();
    await expect(page.locator(".activity-horizon")).toContainText(
      "10 year horizon",
    );
    await apply(page);
    const future = await exportProject(page);
    expect(active(future).horizon).toBe(10);
    expect(active(future).activity?.global.population).toEqual({
      mode: "baseline-percent",
      percent: 140,
    });
    expect(active(future).activity?.forecast?.geography).toBe(
      "Synthetic wider region",
    );
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await settled(page);
    const undone = await exportProject(page);
    expect(active(undone).horizon).toBe(0);
    expect(active(undone).activity).toEqual(active(stockOnly).activity);
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await settled(page);
    await page.reload();
    await settled(page);
    await page.getByRole("button", { name: "People", exact: true }).click();
    await expect(page.locator(".activity-horizon")).toContainText(
      "10 year horizon",
    );
    await expect(
      page.getByLabel("People estimate", { exact: true }),
    ).toContainText("1,400");
    await page.screenshot({
      path: testInfo.outputPath("forecast-applied.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("matching Census vehicle reference is explicitly adopted without mutating the captured baseline", async ({
  page,
}, testInfo) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173", {
    placeFile: resolve("public/data/zcta-85004-2020.json"),
  });
  try {
    await api.connect(page);
    await page.goto("/");
    await settled(page);
    const original = await exportProject(page);
    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("Activity Census QA");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("activity-census@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-activity-Census-test-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "Activity Census QA",
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
      page.getByText("Project saved to your private workspace.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await controls(page);
    await page
      .getByRole("button", {
        name: "Check prepared Census vehicle reference",
        exact: true,
      })
      .click();
    await expect(
      page.getByText(
        "Matching Census vehicle estimate added to this draft. Apply controls to retain this frozen reference.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.locator(".activity-source summary").click();
    await expect(page.locator(".activity-source")).toContainText("7,975");
    await expect(page.locator(".activity-source")).toContainText("793");
    await expect(page.locator(".activity-source")).toContainText("90%");
    await page.screenshot({
      path: testInfo.outputPath("official-vehicle-reference.png"),
      fullPage: true,
    });
    await apply(page);
    const adopted = await exportProject(page);
    expect(adopted.place).toEqual(original.place);
    expect(adopted.baselineIdentity).toEqual(original.baselineIdentity);
    expect(
      active(adopted).activity?.vehicleReference?.measure.estimate.value,
    ).toBe(7975);
    expect(active(adopted).activity?.reference.vehicles).toEqual({
      kind: "published",
    });
    expect(adopted.project.schemaVersion).toBe(5);
  } finally {
    await api.close();
  }
});

test("invalid numeric drafts cannot bypass validation through tabs or map completion", async ({
  page,
}, testInfo) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173");
  try {
    await api.connect(page);
    await page.goto("/");
    await settled(page);
    await controls(page);
    const count = page.getByRole("spinbutton", {
      name: "Population count",
      exact: true,
    });
    await count.fill("");
    await page
      .getByRole("button", { name: "Neighborhoods", exact: true })
      .click();
    await expect(count).toBeVisible();
    await expect(count).toHaveValue("");
    await expect(count).toHaveAttribute("aria-invalid", "true");
    await expect(
      page.getByRole("button", { name: "Counts", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await count.fill("500");
    await page
      .getByRole("button", { name: "Neighborhoods", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Paint a neighborhood", exact: true })
      .click();
    await page.locator(".activity-precision summary").click();
    await page
      .getByRole("textbox", {
        name: "Ring coordinates (longitude, latitude)",
        exact: true,
      })
      .fill(
        "-112.075, 33.453\n-112.071, 33.453\n-112.071, 33.457\n-112.075, 33.457",
      );
    await page
      .getByRole("button", { name: "Use coordinates", exact: true })
      .click();
    await page
      .getByRole("combobox", {
        name: "Area population target method",
        exact: true,
      })
      .selectOption("absolute");
    const areaCount = page.getByRole("spinbutton", {
      name: "Area population count",
      exact: true,
    });
    await areaCount.fill("");
    const canvas = page.locator(".city-map canvas").first();
    await canvas.focus();
    await canvas.press("Enter");
    await expect(page.getByLabel("Neighborhood drawing editor")).toBeVisible();
    await expect(areaCount).toHaveValue("");
    await expect(areaCount).toHaveAttribute("aria-invalid", "true");
    await areaCount.fill("150");
    await page
      .getByRole("button", { name: "Keep area in draft", exact: true })
      .click();
    await apply(page);
    const result = await exportProject(page);
    expect(active(result).activity?.global.population).toEqual({
      mode: "absolute",
      value: 500,
    });
    expect(active(result).activity?.neighborhoods[0].population).toEqual({
      mode: "absolute",
      value: 150,
    });
    await controls(page);
    await page
      .getByRole("button", { name: "Neighborhoods", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Paint a neighborhood", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Neighborhood name", exact: true })
      .fill("Office closure study");
    await page.locator(".activity-precision summary").click();
    await page
      .getByRole("textbox", {
        name: "Ring coordinates (longitude, latitude)",
        exact: true,
      })
      .fill(
        "-112.0708, 33.4528\n-112.0692, 33.4528\n-112.0692, 33.4542\n-112.0708, 33.4542",
      );
    await page
      .getByRole("button", { name: "Use coordinates", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Keep area in draft", exact: true })
      .click();
    await page.getByRole("button", { name: "Counts", exact: true }).click();
    await presets(page);
    await page
      .getByRole("button", { name: "Post-plant-closure", exact: false })
      .click();
    const closure = page.getByRole("dialog");
    await closure
      .getByRole("combobox", { name: "Plant or employment area", exact: true })
      .selectOption({ label: "Office closure study" });
    await closure
      .getByRole("spinbutton", { name: "Documented jobs removed", exact: true })
      .fill("50");
    await closure
      .getByRole("textbox", { name: "Source name or description", exact: true })
      .fill("Synthetic documented workforce change");
    await closure
      .getByRole("checkbox", {
        name: /I have reviewed the proportional response/,
      })
      .check();
    await closure
      .getByRole("button", { name: "Use closure in draft", exact: true })
      .click();
    await apply(page);
    const closed = await exportProject(page);
    expect(active(closed).activity?.preset?.jobsRemoved).toBe(50);
    expect(
      active(closed).activity?.neighborhoods.find(
        (n) => n.name === "Office closure study",
      )?.employment,
    ).toEqual({ mode: "absolute", value: 200 });
    expect(active(closed).buildingEdits).toEqual(active(result).buildingEdits);
    await page.screenshot({
      path: testInfo.outputPath("closure-applied.png"),
      fullPage: true,
    });
  } finally {
    await api.close();
  }
});

test("a failed activity worker can be restarted without losing the scenario", async ({
  page,
}) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173");
  try {
    await api.connect(page);
    await page.addInitScript(() => {
      const Original = window.Worker;
      let injected = false;
      window.Worker = class extends Original {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (String(url).includes("activity.worker") && !injected) {
            injected = true;
            const post = this.postMessage.bind(this);
            this.postMessage = ((data: unknown) => {
              if ((data as { type?: string }).type === "resolve") {
                queueMicrotask(() =>
                  this.dispatchEvent(
                    new ErrorEvent("error", {
                      message: "Injected calculation worker failure",
                      cancelable: true,
                    }),
                  ),
                );
              } else post(data);
            }) as Worker["postMessage"];
          }
        }
      };
    });
    await page.goto("/");
    await settled(page);
    await page.getByRole("button", { name: "People", exact: true }).click();
    await expect(
      page.getByText(
        "Activity estimates could not be calculated. Retry to restart the calculation worker.",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Retry activity calculation", exact: true })
      .click();
    await expect(page.getByLabel("People estimate")).toContainText("106");
    await expect(
      page.getByRole("button", {
        name: "Retry activity calculation",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Set up People controls", exact: true })
      .click();
    await expect(page.getByLabel("Resulting draft counts")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await apply(page);
  } finally {
    await api.close();
  }
});
