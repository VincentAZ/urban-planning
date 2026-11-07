import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Project,
  MediaExportManifest,
  MediaFrameReceipt,
} from "../../packages/core/src/index";
import type { MediaContext, MediaJob } from "../../apps/api/src/media-types";
import { createCollaborationApi } from "./support/collaboration-api";

// Explicitly synthetic two-building geography; real auth, saves, immutable jobs,
// private archives, offline Chromium/CityMap and FFmpeg. No mock frames or UI state injection.
// The opt-in prevents normal application checks from starting native processes.
test.beforeEach(() => {
  test.skip(
    process.env.RUN_MEDIA_JOB_QA !== "1",
    "Opt in with RUN_MEDIA_JOB_QA=1; requires the pinned media image and built private renderer.",
  );
});
const workbench = (page: Page) =>
  page.getByRole("dialog", {
    name: "A view worth taking with you.",
    exact: true,
  });
const hash = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");
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
async function openMedia(page: Page, format: "png" | "mp4" = "png") {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page
    .getByRole("button", {
      name:
        format === "png"
          ? /^High-resolution still · PNG/
          : /^Tour fly-through · MP4/,
    })
    .click();
  await expect(workbench(page)).toBeVisible();
}
async function registerFromMedia(page: Page, suffix: string) {
  await workbench(page)
    .getByRole("button", { name: "Sign in free to render", exact: true })
    .click();
  await page.getByLabel("Your name", { exact: true }).fill("QA Media Planner");
  await page
    .getByLabel("Email", { exact: true })
    .fill(`media-${suffix}@urban-planning.test`);
  await page
    .getByLabel(/^Password/)
    .fill("Isolated-media-browser-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(
    "QA Media Planner",
  );
  await expect(workbench(page)).toBeVisible();
}
async function loadScene(page: Page, reload = false): Promise<MediaContext> {
  const reply = page.waitForResponse(
    (response) =>
      response.url().includes("/media/context?") &&
      response.request().method() === "GET",
  );
  await workbench(page)
    .getByRole("button", {
      name: reload ? "Reload saved scene" : "Save and load scene",
      exact: true,
    })
    .click();
  const response = await reply;
  expect(response.status()).toBe(200);
  const context = (await response.json()) as MediaContext;
  await expect(workbench(page).locator(".media-binding")).toContainText(
    `Revision ${context.scenarioRevision}`,
  );
  return context;
}
async function request<T>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (
        await fetch("/api/v1/auth/session", {
          credentials: "include",
          cache: "no-store",
        })
      ).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    },
    { path, method, body },
  );
}
async function rendered(page: Page) {
  await expect(
    workbench(page).getByRole("heading", {
      name: "Your export is ready",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    workbench(page).getByRole("button", { name: /^Download output\./ }),
  ).toBeEnabled();
}
async function file(page: Page, name: string, directory: string) {
  const pending = page.waitForEvent("download");
  await workbench(page)
    .getByRole("button", { name: `Download ${name}`, exact: true })
    .click();
  const downloaded = await pending;
  await downloaded.saveAs(join(directory, name));
  return readFile(join(directory, name));
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await workbench(page).evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
}
async function clearNotification(page: Page) {
  const dismiss = page.locator('button[aria-label="Dismiss notification"]');
  if (
    (await dismiss.isVisible()) &&
    (await dismiss.evaluate(
      (element) => getComputedStyle(element).pointerEvents !== "none",
    ))
  )
    await dismiss.click();
  // A modal makes background controls inert. In that case observe the existing
  // toast lifecycle instead of forcing an inaccessible click or adding a sleep.
  await expect(page.locator(".toast")).toHaveCount(0);
}
async function authorTwoStops(page: Page) {
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const tour = page.locator(".tour-dialog");
  await tour.getByRole("button", { name: "Edit tour", exact: true }).click();
  await expect(tour.locator(".tour-outline ol > li")).toHaveCount(2);
  await tour
    .getByLabel("Tour title", { exact: true })
    .fill("Synthetic QA · two exact views");
  await tour.getByLabel("Stop title", { exact: true }).fill("Synthetic homes");
  const fullCallout =
    "This is explicitly synthetic geometry for browser verification, not an observed city. "
      .repeat(4)
      .trim();
  await tour
    .getByRole("textbox", { name: "Callout", exact: true })
    .fill(fullCallout);
  await tour
    .getByRole("textbox", {
      name: "Narration transcript (optional)",
      exact: true,
    })
    .fill(
      "Retain this full transcript as text. There is no generated narration audio.",
    );
  await tour.getByLabel("Longitude", { exact: true }).fill("-112.073");
  await tour.getByLabel("Latitude", { exact: true }).fill("33.455");
  await tour.getByLabel("Zoom", { exact: true }).fill("17");
  await tour.getByLabel("Pitch", { exact: true }).fill("45");
  await tour.locator(".tour-outline ol button").nth(1).click();
  await tour
    .getByLabel("Stop title", { exact: true })
    .fill("Synthetic workplace");
  await tour
    .getByRole("textbox", { name: "Callout", exact: true })
    .fill(
      "The second saved view retains the same two synthetic buildings and source citation.",
    );
  await tour.getByLabel("Longitude", { exact: true }).fill("-112.0725");
  await tour.getByLabel("Latitude", { exact: true }).fill("33.4545");
  await tour.getByLabel("Zoom", { exact: true }).fill("17.25");
  await tour.getByLabel("Pitch", { exact: true }).fill("45");
  await tour.getByRole("button", { name: "Save tour", exact: true }).click();
  await expect(tour).toHaveCount(0);
  await expect(page.locator(".project-status")).toHaveText(
    "Browser draft saved",
  );
  return fullCallout;
}

test("real native 4K still preserves first-save scene, preview, exact pixels and private downloads through reload", async ({
  page,
  baseURL,
}) => {
  const isolated = await createCollaborationApi(baseURL!, {
    mediaNativeFixture: true,
    retainMediaEvidence: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await isolated.connect(page);
  try {
    await ready(page);
    await openMedia(page);
    await expect(workbench(page)).toContainText(
      "Quick PNG capture remains available without an account",
    );
    await registerFromMedia(page, "still");
    const context = await loadScene(page);
    expect(context.scene.place.buildings).toHaveLength(2);
    expect(
      context.scene.sources.some(
        ({ source }) => source.name === "Synthetic collaboration test fixture",
      ),
    ).toBe(true);
    await clearNotification(page);
    await workbench(page)
      .getByRole("heading", {
        name: "A view worth taking with you.",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "media-still-workbench-top.png"),
      fullPage: false,
    });
    await workbench(page)
      .getByLabel("Exact output dimensions", { exact: true })
      .selectOption("3840x2160");
    await workbench(page)
      .getByLabel("Brief screen caption", { exact: true })
      .fill("Synthetic QA source · exact 4K saved revision.");
    await workbench(page)
      .getByRole("button", { name: "Preview frozen composition", exact: true })
      .click();
    await expect(
      workbench(page)
        .getByRole("status")
        .filter({ hasText: "Frozen preview ready" }),
    ).toContainText("3840 × 2160");
    await expect(page.locator("#urban-media-output")).toHaveAttribute(
      "data-scene-hash",
      context.sceneHash,
    );
    expect(
      await page
        .locator("#urban-media-output")
        .evaluate((element) => [element.clientWidth, element.clientHeight]),
    ).toEqual([3840, 2160]);
    await page.locator(".media-preview").scrollIntoViewIfNeeded();
    await clearNotification(page);
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "media-still-preview-desktop.png"),
      fullPage: false,
    });
    await workbench(page)
      .getByRole("button", {
        name: "Render high-resolution still",
        exact: true,
      })
      .click();
    await rendered(page);
    const png = await file(page, "output.png", isolated.evidenceDirectory);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([3840, 2160]);
    const manifest = JSON.parse(
      (
        await file(page, "manifest.json", isolated.evidenceDirectory)
      ).toString(),
    ) as MediaExportManifest;
    const frames = JSON.parse(
      (await file(page, "frames.json", isolated.evidenceDirectory)).toString(),
    ) as MediaFrameReceipt[];
    expect(manifest.sceneHash).toBe(context.sceneHash);
    expect(manifest.frameCount).toBe(1);
    expect(
      manifest.files.find((entry) => entry.name === "output.png")?.sha256,
    ).toBe(hash(png));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      index: 0,
      sceneHash: context.sceneHash,
      width: 3840,
      height: 2160,
      pixelHash: hash(png),
    });
    const transcript = (
      await file(page, "transcript.txt", isolated.evidenceDirectory)
    ).toString();
    expect(transcript).toContain("Synthetic collaboration test fixture");
    const jobId = await workbench(page)
      .getByLabel("Retained media exports", { exact: true })
      .inputValue();
    const seeded = await isolated.seedMediaHistory(jobId);
    expect(seeded.appended).toBe(105);
    expect(seeded.scenarioId).toBe(context.scene.scenario.id);
    await expect(page.locator(".project-status")).toHaveText(
      "Browser draft saved",
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeVisible();
    await openMedia(page);
    const reopened = await loadScene(page);
    expect(reopened.projectVersion).toBe(context.projectVersion);
    expect(reopened.scenarioRevision).toBe(context.scenarioRevision);
    const history = workbench(page).getByRole("region", {
      name: "Retained export history",
      exact: true,
    });
    const selection = history.getByLabel("Retained media exports", {
      exact: true,
    });
    await expect(history).toContainText(
      "100 retained exports loaded for this scenario.",
    );
    await expect(selection.locator('option:not([value=""])')).toHaveCount(100);
    await selection.selectOption(jobId);
    await history
      .getByRole("button", { name: "Load older exports", exact: true })
      .scrollIntoViewIfNeeded();
    await clearNotification(page);
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "media-history-first-page.png"),
      fullPage: false,
    });
    await history
      .getByRole("button", { name: "Load older exports", exact: true })
      .click();
    await expect(history).toContainText(
      "106 retained exports loaded for this scenario. All retained exports are shown.",
    );
    await expect(selection.locator('option:not([value=""])')).toHaveCount(106);
    await expect(selection).toHaveValue(jobId);
    await expect(
      history.getByRole("button", { name: "Load older exports", exact: true }),
    ).toHaveCount(0);
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "media-history-complete.png"),
      fullPage: false,
    });
    await rendered(page);
    expect(
      hash(await file(page, "output.png", isolated.evidenceDirectory)),
    ).toBe(hash(png));
    const oldestJobId = await selection
      .locator('option:not([value=""])')
      .last()
      .getAttribute("value");
    expect(oldestJobId).not.toBe(jobId);
    await selection.selectOption(oldestJobId!);
    await rendered(page);
    expect(
      hash(await file(page, "output.png", isolated.evidenceDirectory)),
    ).toBe(hash(png));
    await writeFile(
      join(isolated.evidenceDirectory, "history-pagination.json"),
      JSON.stringify(
        {
          scope:
            "105 test-only older metadata rows reuse one actual native archive; not 106 native executions.",
          sourceNativeJobId: jobId,
          appended: seeded.appended,
          projectId: seeded.projectId,
          scenarioId: seeded.scenarioId,
          firstPageCount: 100,
          finalCount: 106,
          selectedJobPreservedDuringLoad: true,
          oldestJobId,
          outputSha256: hash(png),
        },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
  } finally {
    await isolated.close();
  }
});

test("real three-frame MP4 retains both saved stops, exact transition, full narrative and mobile composition controls", async ({
  page,
  baseURL,
}) => {
  const isolated = await createCollaborationApi(baseURL!, {
    mediaNativeFixture: true,
    retainMediaEvidence: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await isolated.connect(page);
  try {
    await ready(page);
    const fullCallout = await authorTwoStops(page);
    await openMedia(page, "mp4");
    await registerFromMedia(page, "video");
    const context = await loadScene(page);
    await expect(workbench(page)).toContainText(
      "long callouts require an explicit brief screen caption",
    );
    await workbench(page)
      .getByLabel("Stop 1 screen caption", { exact: true })
      .fill("Synthetic QA homes; full narrative retained in the transcript.");
    await workbench(page)
      .getByLabel("Exact output dimensions", { exact: true })
      .selectOption("1280x720");
    await workbench(page)
      .getByLabel("Stop 1 hold frames", { exact: true })
      .fill("1");
    await workbench(page)
      .getByLabel("Stop 1 transition frames", { exact: true })
      .fill("1");
    await workbench(page)
      .getByLabel("Stop 2 hold frames", { exact: true })
      .fill("1");
    await expect(workbench(page)).toContainText(
      "3 frames · 0.10 seconds · no audio",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await clearNotification(page);
    await workbench(page)
      .getByRole("heading", {
        name: "A view worth taking with you.",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "media-video-mobile-top.png"),
      fullPage: false,
    });
    await workbench(page)
      .getByLabel("Stop 1 hold frames", { exact: true })
      .scrollIntoViewIfNeeded();
    await noOverflow(page);
    await clearNotification(page);
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "media-video-mobile-settings.png"),
      fullPage: false,
    });
    await workbench(page)
      .getByRole("button", { name: "Render tour video", exact: true })
      .click();
    await rendered(page);
    const movie = await file(page, "output.mp4", isolated.evidenceDirectory);
    expect(movie.subarray(4, 8).toString()).toBe("ftyp");
    const manifest = JSON.parse(
      (
        await file(page, "manifest.json", isolated.evidenceDirectory)
      ).toString(),
    ) as MediaExportManifest;
    const frames = JSON.parse(
      (await file(page, "frames.json", isolated.evidenceDirectory)).toString(),
    ) as MediaFrameReceipt[];
    expect(manifest.sceneHash).toBe(context.sceneHash);
    expect(manifest.frameCount).toBe(3);
    expect(manifest.duration).toEqual({ numerator: 3, denominator: 30 });
    expect(manifest.recipe.audio).toBe("none");
    expect(manifest.encoder?.name).toBe("FFmpeg / libx264");
    expect(
      manifest.files.find((entry) => entry.name === "output.mp4")?.sha256,
    ).toBe(hash(movie));
    expect(frames.map((frame) => frame.index)).toEqual([0, 1, 2]);
    expect(
      frames.every(
        (frame) =>
          frame.width === 1280 &&
          frame.height === 720 &&
          frame.reusedFromFrame === undefined,
      ),
    ).toBe(true);
    const stops = context.scene.scenario.presentation!.stops;
    expect(frames[0].requestedCamera).toEqual(stops[0].camera);
    expect(frames[2].requestedCamera).toEqual(stops[1].camera);
    expect(frames[1].pixelHash).not.toBe(frames[0].pixelHash);
    const transcript = (
      await file(page, "transcript.txt", isolated.evidenceDirectory)
    ).toString();
    expect(transcript).toContain(fullCallout);
    expect(transcript).toContain("There is no generated narration audio");
    expect(
      (await file(page, "captions.vtt", isolated.evidenceDirectory)).toString(),
    ).toContain("WEBVTT");
    await noOverflow(page);
    await clearNotification(page);
    await page.screenshot({
      path: join(
        isolated.evidenceDirectory,
        "media-video-mobile-downloads.png",
      ),
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await isolated.close();
  }
});

test("queued cancellation and explicit retry use the real native worker, and revoked sessions discard a late private scene", async ({
  page,
  baseURL,
}) => {
  const isolated = await createCollaborationApi(baseURL!, {
    mediaNativeFixture: true,
    mediaManualWorker: true,
    retainMediaEvidence: true,
  });
  await isolated.connect(page);
  let release: (() => void) | undefined;
  try {
    await ready(page);
    await openMedia(page);
    await registerFromMedia(page, "queue");
    const context = await loadScene(page),
      projectId = context.scene.binding.projectId;
    await workbench(page)
      .getByRole("button", {
        name: "Render high-resolution still",
        exact: true,
      })
      .click();
    await expect(
      workbench(page).getByRole("button", {
        name: "Cancel media export",
        exact: true,
      }),
    ).toBeEnabled();
    await workbench(page)
      .getByRole("button", { name: "Cancel media export", exact: true })
      .click();
    await expect(
      workbench(page).getByRole("heading", {
        name: "Export cancelled",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      workbench(page).getByRole("button", {
        name: "Retry media export",
        exact: true,
      }),
    ).toBeEnabled();
    const jobId = await workbench(page)
      .getByLabel("Retained media exports", { exact: true })
      .inputValue();
    await workbench(page)
      .getByRole("button", { name: "Retry media export", exact: true })
      .click();
    await expect(
      workbench(page).getByRole("button", {
        name: "Cancel media export",
        exact: true,
      }),
    ).toBeEnabled();
    // The fixture changes only scheduling. The same service now executes the retained queued input with the real native renderer.
    await isolated.runMediaWorker();
    await rendered(page);
    const record = await request<{ job: MediaJob }>(
      page,
      `/projects/${projectId}/media/jobs/${jobId}`,
    );
    expect(record.data.job.status).toBe("completed");
    expect(record.data.job.attempt).toBe(1);
    const hold = isolated.holdNextResponse(
      `/api/v1/projects/${projectId}/media/context`,
      "GET",
    );
    release = hold.release;
    await workbench(page)
      .getByRole("button", { name: "Reload saved scene", exact: true })
      .click();
    await hold.committed;
    expect((await request(page, "/auth/logout", "POST", {})).status).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(workbench(page).locator(".media-binding")).toHaveCount(0);
    hold.release();
    await expect(workbench(page).locator(".media-binding")).toHaveCount(0);
    await expect(page.locator("#urban-media-output")).toHaveCount(0);
    expect(
      (await request(page, `/projects/${projectId}/media/jobs/${jobId}`))
        .status,
    ).toBe(401);
    const stored = await isolated.persistedState();
    expect(stored.mediaJobs.find((job) => job.id === jobId)?.status).toBe(
      "completed",
    );
    await writeFile(
      join(isolated.evidenceDirectory, "queue-retry-revocation.json"),
      JSON.stringify(
        {
          jobId,
          retainedStatus: "completed",
          privateReadAfterSignOut: 401,
          sceneHash: context.sceneHash,
        },
        null,
        2,
      ),
    );
  } finally {
    release?.();
    await isolated.close();
  }
});

test("an externally changed saved revision cannot render from an earlier reviewed scene", async ({
  page,
  baseURL,
}) => {
  const isolated = await createCollaborationApi(baseURL!, {
    mediaNativeFixture: true,
    mediaManualWorker: true,
    retainMediaEvidence: true,
  });
  await isolated.connect(page);
  try {
    await ready(page);
    await openMedia(page);
    await registerFromMedia(page, "stale");
    const context = await loadScene(page),
      projectId = context.scene.binding.projectId;
    const saved = await request<{
      project: Project;
      version: number;
      baselineIdentity: { sha256: string };
    }>(page, `/projects/${projectId}`);
    const changed = structuredClone(saved.data.project);
    changed.name = "Saved elsewhere after media review";
    const updated = await request(page, `/projects/${projectId}`, "PUT", {
      project: changed,
      expectedVersion: saved.data.version,
      baselineHash: saved.data.baselineIdentity.sha256,
    });
    expect(updated.status).toBe(200);
    await workbench(page)
      .getByRole("button", {
        name: "Render high-resolution still",
        exact: true,
      })
      .click();
    await expect(workbench(page).getByRole("alert")).toContainText(
      "The saved project or scenario changed",
    );
    expect(
      (
        await request<{ jobs: MediaJob[] }>(
          page,
          `/projects/${projectId}/media/jobs`,
        )
      ).data.jobs,
    ).toEqual([]);
    await expect(workbench(page).locator(".media-binding")).toContainText(
      `Saved project version ${context.projectVersion}`,
    );
    expect((await isolated.persistedState()).nativeCapacity.slot).toBeNull();
  } finally {
    await isolated.close();
  }
});
