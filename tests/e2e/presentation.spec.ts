import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ModelResults,
  Place,
  Project,
  Scenario,
} from "../../packages/core/src/index";
import { createCollaborationApi } from "./support/collaboration-api";

type Exported = {
  project: Project;
  place: Place;
  baselineIdentity: { sha256: string };
  results: ModelResults;
};
const tour = (page: Page) => page.locator(".tour-dialog");
const active = (data: Exported) =>
  data.project.scenarios.find(
    (scenario) => scenario.id === data.project.activeScenarioId,
  )!;
async function settled(page: Page) {
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
}
async function open(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await settled(page);
}
async function openTour(page: Page) {
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(tour(page)).toBeVisible();
  await expect(tour(page).locator(".city-map-loading")).toHaveCount(0);
}
async function edit(page: Page) {
  await tour(page)
    .getByRole("button", { name: "Edit tour", exact: true })
    .click();
  await expect(
    tour(page).getByRole("button", {
      name: "Capture current view",
      exact: true,
    }),
  ).toBeEnabled();
}
async function exportProject(page: Page): Promise<Exported> {
  await settled(page);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Complete project · JSON/ }).click();
  const path = await (await pending).path();
  if (!path) throw new Error("No project export");
  const value = JSON.parse(await readFile(path, "utf8")) as Exported;
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  return value;
}
async function durable(page: Page) {
  await expect(page.locator(".project-status")).toHaveText(
    "Browser draft saved",
  );
}
async function protectedNavigation(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function paint(scope: Locator) {
  await expect
    .poll(() =>
      scope
        .locator("canvas")
        .first()
        .evaluate((canvas) => {
          const source = canvas as HTMLCanvasElement;
          if (!source.width || !source.height) return 0;
          const sample = document.createElement("canvas");
          sample.width = 64;
          sample.height = 64;
          const context = sample.getContext("2d")!;
          context.drawImage(source, 0, 0, 64, 64);
          const values = context.getImageData(0, 0, 64, 64).data,
            colors = new Set<string>();
          for (let i = 0; i < values.length; i += 4)
            if (values[i + 3])
              colors.add(
                `${values[i] >> 4},${values[i + 1] >> 4},${values[i + 2] >> 4}`,
              );
          return colors.size;
        }),
    )
    .toBeGreaterThan(7);
}
function trackErrors(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message));
}

// The source is labeled synthetic; all edits/auth/saves/publication use the real
// isolated HTTP API and durable store. No project, model or API responses are mocked.
test("guided tour authoring persists exact views and narrative through undo, reload and frozen publication", async ({
  page,
  browser,
}, testInfo) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173");
  const publicContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  trackErrors(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const before = await exportProject(page);
    await openTour(page);
    await expect(tour(page)).toContainText("Quick overview · tour not saved");
    await edit(page);
    await tour(page)
      .getByLabel("Tour title", { exact: true })
      .fill("Roosevelt Row · the next chapter");
    await tour(page)
      .getByLabel("Stop title", { exact: true })
      .fill("A place for more homes");
    await tour(page)
      .getByRole("textbox", { name: "Callout", exact: true })
      .fill(
        "Keep the existing street network and explore the shape of this proposal. These are planning estimates.",
      );
    await tour(page)
      .getByRole("textbox", {
        name: "Narration transcript (optional)",
        exact: true,
      })
      .fill(
        "Here is the proposal. Read the evidence before making a decision.",
      );
    await tour(page).getByLabel("Longitude", { exact: true }).fill("-112.073");
    await tour(page).getByLabel("Latitude", { exact: true }).fill("33.456");
    await tour(page).getByLabel("Zoom", { exact: true }).fill("17");
    await tour(page).getByLabel("Pitch", { exact: true }).fill("45");
    await tour(page)
      .getByRole("button", { name: "Preview selected view", exact: true })
      .click();
    await tour(page)
      .getByRole("button", { name: "Capture current view", exact: true })
      .click();
    await expect(
      tour(page).getByLabel("Longitude", { exact: true }),
    ).toHaveValue("-112.073");
    await expect(tour(page).getByLabel("Zoom", { exact: true })).toHaveValue(
      "17",
    );
    await tour(page)
      .getByRole("checkbox", { name: /^Homes(?: · incomplete)?$/ })
      .check();
    await expect.poll(() => protectedNavigation(page)).toBe(true);
    await paint(tour(page).locator(".tour-stage"));
    await page.screenshot({
      path: testInfo.outputPath("tour-studio-desktop.png"),
      fullPage: false,
    });
    await tour(page)
      .getByRole("button", { name: "Add stop", exact: true })
      .click();
    await tour(page)
      .getByLabel("Stop title", { exact: true })
      .fill("Look at the street pattern");
    await tour(page)
      .getByRole("combobox", { name: "View", exact: true })
      .selectOption("2d");
    await tour(page).getByLabel("Longitude", { exact: true }).fill("-112.0715");
    await tour(page).getByLabel("Latitude", { exact: true }).fill("33.455");
    await tour(page)
      .getByRole("button", { name: "Preview selected view", exact: true })
      .click();
    await tour(page)
      .getByRole("button", { name: "Move stop earlier", exact: true })
      .click();
    await tour(page)
      .getByRole("button", { name: "Preview tour", exact: true })
      .click();
    await expect(tour(page).locator(".tour-map-label")).toContainText(
      "2D plan",
    );
    await tour(page)
      .getByRole("button", { name: "Next stop", exact: true })
      .click();
    await expect(
      tour(page).getByRole("heading", {
        name: "See what changes",
        exact: true,
      }),
    ).toBeVisible();
    await tour(page)
      .getByRole("button", { name: "Edit tour", exact: true })
      .click();
    await tour(page)
      .getByRole("button", { name: "Save tour", exact: true })
      .click();
    await expect(tour(page)).toHaveCount(0);
    await durable(page);
    const saved = await exportProject(page);
    expect(saved.project.schemaVersion).toBe(4);
    const savedTour = active(saved).presentation!;
    expect(savedTour.stops.map((stop) => stop.title)).toEqual([
      "A place for more homes",
      "Look at the street pattern",
      "See what changes",
    ]);
    expect(savedTour.stops[0].camera.center).toEqual([-112.073, 33.456]);
    expect(savedTour.stops[1].camera.pitch).toBe(0);
    expect(saved.place).toEqual(before.place);
    expect(saved.baselineIdentity).toEqual(before.baselineIdentity);
    expect(saved.project.scenarios.find((s) => s.id === "baseline")).toEqual(
      before.project.scenarios.find((s) => s.id === "baseline"),
    );
    expect(saved.results.metrics.map((m) => m.value)).toEqual(
      before.results.metrics.map((m) => m.value),
    );
    await page
      .getByRole("button", { name: "Undo last edit", exact: true })
      .click();
    await durable(page);
    expect(active(await exportProject(page)).presentation).toBeUndefined();
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await durable(page);
    await page.reload();
    await settled(page);
    expect(active(await exportProject(page)).presentation).toEqual(savedTour);
    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page.getByLabel("Your name", { exact: true }).fill("QA Tour Planner");
    await page
      .getByLabel("Email", { exact: true })
      .fill("tour@urban-planning.test");
    await page.getByLabel(/^Password/).fill("Isolated-tour-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "QA Tour Planner",
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
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", { name: "Published link" });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await openTour(page);
    await edit(page);
    await tour(page)
      .getByLabel("Tour title", { exact: true })
      .fill("A later private revision");
    await tour(page)
      .getByRole("button", { name: "Save tour", exact: true })
      .click();
    await durable(page);
    await api.connect(publicContext);
    const publicPage = await publicContext.newPage();
    trackErrors(publicPage, errors);
    await publicPage.goto(url);
    await publicPage
      .getByRole("button", { name: "Watch guided tour", exact: true })
      .click();
    await expect(
      tour(publicPage).getByRole("heading", {
        name: "Roosevelt Row · the next chapter",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      tour(publicPage).getByRole("button", { name: "Edit tour", exact: true }),
    ).toHaveCount(0);
    await expect(tour(publicPage)).toContainText("Published snapshot");
    await paint(tour(publicPage).locator(".tour-stage"));
    await publicPage.screenshot({
      path: testInfo.outputPath("tour-published-desktop.png"),
      fullPage: false,
    });
    await publicPage.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        publicPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
      .toBe(true);
    await tour(publicPage)
      .getByRole("button", { name: "Next stop", exact: true })
      .click();
    await expect(tour(publicPage).locator(".tour-map-label")).toContainText(
      "2D plan",
    );
    await expect(tour(publicPage).locator(".tour-stage")).toHaveAttribute(
      "data-camera-state",
      "ready",
    );
    await paint(tour(publicPage).locator(".tour-stage"));
    await publicPage.screenshot({
      path: testInfo.outputPath("tour-published-mobile.png"),
      fullPage: false,
    });
    await tour(publicPage)
      .getByRole("button", { name: "Close presentation", exact: true })
      .click();
    await expect(
      publicPage.getByRole("button", {
        name: "Watch guided tour",
        exact: true,
      }),
    ).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await publicContext.close();
    await api.close();
  }
});

test("tour draft guards, numeric errors, keyboard navigation and baseline read-only mode preserve the saved scenario", async ({
  page,
}, testInfo) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173");
  const errors: string[] = [];
  trackErrors(page, errors);
  try {
    await api.connect(page);
    await open(page);
    const before = await exportProject(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openTour(page);
    await edit(page);
    await tour(page)
      .getByLabel("Tour title", { exact: true })
      .fill("Unsaved meeting story");
    await tour(page).getByLabel("Longitude", { exact: true }).fill("999");
    await tour(page)
      .getByRole("button", { name: "Save tour", exact: true })
      .click();
    await expect(tour(page).getByRole("alert")).toBeVisible();
    await expect(tour(page)).toBeVisible();
    await tour(page)
      .getByRole("button", { name: "Close presentation", exact: true })
      .click();
    await expect(tour(page)).toContainText("Discard unsaved tour changes?");
    await tour(page)
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await tour(page).getByLabel("Longitude", { exact: true }).fill("-112.073");
    await tour(page)
      .getByRole("button", { name: "Preview tour", exact: true })
      .click();
    await expect(
      tour(page).getByRole("heading", {
        name: "Start with the place",
        exact: true,
      }),
    ).toBeVisible();
    await tour(page)
      .getByRole("heading", { name: "Start with the place", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      tour(page).getByRole("heading", {
        name: "See what changes",
        exact: true,
      }),
    ).toBeFocused();
    await expect(
      tour(page).locator(".tour-metric table").first(),
    ).toContainText("Baseline");
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("tour-mobile-evidence.png"),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(tour(page)).toContainText("Discard unsaved tour changes?");
    await tour(page)
      .getByRole("button", { name: "Discard tour changes", exact: true })
      .click();
    await expect(tour(page)).toHaveCount(0);
    await settled(page);
    const after = await exportProject(page);
    expect(after.project).toEqual(before.project);
    expect(after.baselineIdentity).toEqual(before.baselineIdentity);
    await page
      .getByRole("combobox", { name: "Active scenario" })
      .selectOption("baseline");
    await settled(page);
    await openTour(page);
    await expect(
      tour(page).getByRole("button", { name: "Edit tour", exact: true }),
    ).toHaveCount(0);
    await tour(page)
      .getByRole("button", { name: "Close presentation", exact: true })
      .click();
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("real-source presentation renders for a projector and fullscreen; local-device narration is explicit and cancellable", async ({
  page,
}, testInfo) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173", {
    placeFile: resolve("public/data/phoenix.json"),
  });
  const errors: string[] = [];
  trackErrors(page, errors);
  // Only the absent CI device speech capability is supplied. App state, API,
  // geometry, rendering, persistence and the fullscreen API remain real.
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { speechCalls: string[] }).speechCalls = calls;
    class Utterance {
      text: string;
      voice: unknown;
      lang = "";
      rate = 1;
      onend: unknown;
      onerror: unknown;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: Utterance,
      configurable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        getVoices: () => [
          {
            name: "Local QA",
            lang: "en-US",
            voiceURI: "local-qa",
            localService: true,
          },
          {
            name: "Remote QA",
            lang: "en-US",
            voiceURI: "remote-qa",
            localService: false,
          },
        ],
        addEventListener: () => {},
        removeEventListener: () => {},
        speak: (value: Utterance) => calls.push(`speak:${value.text}`),
        cancel: () => calls.push("cancel"),
      },
      configurable: true,
    });
  });
  try {
    await api.connect(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await open(page);
    await openTour(page);
    await paint(tour(page).locator(".tour-stage"));
    await expect(
      tour(page).getByRole("option", { name: /Remote QA/ }),
    ).toHaveCount(0);
    await tour(page)
      .getByRole("button", { name: "Read this stop aloud", exact: true })
      .click();
    await expect(
      tour(page).getByRole("button", { name: "Stop narration", exact: true }),
    ).toBeVisible();
    await tour(page)
      .getByRole("button", { name: "Next stop", exact: true })
      .click();
    await expect(
      tour(page).getByRole("button", {
        name: "Read this stop aloud",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { speechCalls: string[] }).speechCalls,
      ),
    ).toContain("cancel");
    await tour(page)
      .getByRole("button", { name: "Enter fullscreen", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.fullscreenElement?.classList.contains("tour-dialog"),
        ),
      )
      .toBe(true);
    await paint(tour(page).locator(".tour-stage"));
    await page.screenshot({
      path: testInfo.outputPath("tour-projector-fullscreen.png"),
      fullPage: false,
    });
    await tour(page)
      .getByRole("button", { name: "Leave fullscreen", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    // Exercise a real MapLibre flight, in addition to the suite’s reduced-motion jumps.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await edit(page);
    await tour(page).getByLabel("Longitude", { exact: true }).fill("-112.0705");
    await tour(page).getByLabel("Latitude", { exact: true }).fill("33.455");
    await tour(page).getByLabel("Zoom", { exact: true }).fill("16.8");
    await tour(page)
      .getByRole("button", { name: "Preview selected view", exact: true })
      .click();
    await expect(tour(page).locator(".tour-stage")).toHaveAttribute(
      "data-camera-state",
      "ready",
    );
    await tour(page)
      .getByRole("button", { name: "Capture current view", exact: true })
      .click();
    expect(
      Number(
        await tour(page).getByLabel("Longitude", { exact: true }).inputValue(),
      ),
    ).toBeCloseTo(-112.0705, 6);
    expect(
      Number(await tour(page).getByLabel("Zoom", { exact: true }).inputValue()),
    ).toBeCloseTo(16.8, 5);
    await tour(page)
      .getByRole("button", { name: "Discard draft", exact: true })
      .click();
    await tour(page)
      .getByRole("button", { name: "Play tour", exact: true })
      .click();
    await expect(
      tour(page).getByRole("button", { name: "Pause tour", exact: true }),
    ).toBeVisible();
    await tour(page)
      .getByRole("button", { name: "Pause tour", exact: true })
      .click();
    await tour(page)
      .getByRole("button", { name: "Read this stop aloud", exact: true })
      .click();
    await expect(
      tour(page).getByRole("button", { name: "Stop narration", exact: true }),
    ).toBeVisible();
    const cancellations = await page.evaluate(
      () =>
        (window as unknown as { speechCalls: string[] }).speechCalls.filter(
          (call) => call === "cancel",
        ).length,
    );
    await tour(page)
      .getByRole("button", { name: "Close presentation", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { speechCalls: string[] }).speechCalls.filter(
              (call) => call === "cancel",
            ).length,
        ),
      )
      .toBeGreaterThan(cancellations);
    expect(errors).toEqual([]);
  } finally {
    await api.close();
  }
});

test("timed tour playback advances and stops while mobile evidence keeps unavailable measures explicit", async ({
  page,
}, testInfo) => {
  const api = await createCollaborationApi("http://127.0.0.1:5173");
  try {
    await api.connect(page);
    await open(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openTour(page);
    await edit(page);
    await tour(page)
      .getByRole("button", { name: "02 See what changes", exact: true })
      .click();
    await tour(page)
      .getByRole("checkbox", {
        name: "Intersection level of service · unavailable",
        exact: true,
      })
      .check();
    await tour(page)
      .getByRole("button", { name: "Preview tour", exact: true })
      .click();
    const unavailable = tour(page)
      .locator(".tour-metric")
      .filter({
        has: page.getByRole("heading", {
          name: "Intersection level of service",
          exact: true,
        }),
      });
    await expect(unavailable.locator("tbody td")).toHaveText(["—", "—", "—"]);
    await expect(unavailable.locator(".tour-metric-status")).toHaveText(
      "Unavailable",
    );
    const homes = tour(page)
      .locator(".tour-metric")
      .filter({
        has: page.getByRole("heading", { name: "Homes", exact: true }),
      });
    await homes.locator("summary").click();
    await homes.scrollIntoViewIfNeeded();
    await expect(homes.locator("details")).toHaveAttribute("open", "");
    await expect(homes).toContainText("Baseline");
    await page.screenshot({
      path: testInfo.outputPath("tour-mobile-expanded-evidence.png"),
      fullPage: false,
    });
    await tour(page).locator(".tour-coverage summary").click();
    await expect(tour(page).locator(".tour-coverage")).toContainText(
      "Source captured",
    );
    await expect(
      tour(page).locator(".tour-coverage .tour-source").first(),
    ).toContainText(/observed|inferred|published-estimate|user-supplied/);
    // Virtualize only the passage of browser time, keeping real UI/HTTP/model data.
    // This checks both the scheduled advance and the final-stop termination.
    await page.clock.install();
    await tour(page)
      .getByRole("combobox", { name: "Seconds per stop", exact: true })
      .selectOption("15");
    await tour(page)
      .getByRole("button", { name: "Play tour", exact: true })
      .click();
    await expect(
      tour(page).getByRole("button", { name: "Pause tour", exact: true }),
    ).toBeVisible();
    await expect(
      tour(page).getByRole("heading", {
        name: "Start with the place",
        exact: true,
      }),
    ).toBeVisible();
    await page.clock.fastForward(15_001);
    await expect(
      tour(page).getByRole("heading", {
        name: "See what changes",
        exact: true,
      }),
    ).toBeVisible();
    await page.clock.fastForward(15_001);
    await expect(
      tour(page).getByRole("button", { name: "Play tour", exact: true }),
    ).toBeVisible();
    await tour(page)
      .getByRole("button", { name: "Close presentation", exact: true })
      .click();
    await tour(page)
      .getByRole("button", { name: "Discard tour changes", exact: true })
      .click();
    await expect(tour(page)).toHaveCount(0);
  } finally {
    await api.close();
  }
});
