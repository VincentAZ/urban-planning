import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import type { Session } from "../../apps/web/src/lib/api";
import type {
  EngagementSnapshotDetail,
  OwnEngagementResponse,
} from "../../packages/core/src/engagement";
import { createCollaborationApi } from "./support/collaboration-api";

async function requestAs<T = unknown>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await fetch("/api/v1/auth/session").then((response) =>
        response.json(),
      );
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    },
    { path, method, body },
  );
}
async function register(page: Page, name: string, email: string) {
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel(/^Password/).fill("Isolated-engagement-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
}
async function closeDialog(page: Page) {
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}
async function ownResponses(page: Page, snapshotId: string) {
  return (
    await requestAs<OwnEngagementResponse>(
      page,
      `/published/${snapshotId}/feedback/mine`,
    )
  ).data.responses;
}
async function detail(page: Page, projectId: string, snapshotId: string) {
  return (
    await requestAs<EngagementSnapshotDetail>(
      page,
      `/projects/${projectId}/engagement/${snapshotId}`,
    )
  ).data;
}

// Only source geometry is synthetic. Sessions, publishing, submissions, moderation, exports and storage use the real HTTP API.
test("public survey and pinned feedback preserve privacy, retry safely and remain auditable through closure and revocation", async ({
  page: owner,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(240000);
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const responderContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const otherContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const responder = await responderContext.newPage(),
    other = await otherContext.newPage();
  const errors: string[] = [],
    consoleErrors: string[] = [];
  for (const page of [owner, responder, other]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
  }
  const introduction =
    "Help us shape a comfortable, welcoming neighborhood. Your responses will inform the next review.";
  const question = "Which improvement matters most?",
    writtenQuestion = "What should the team consider?";
  const comment = "Please keep a shaded walking connection at this location.";
  try {
    await api.connect(owner.context());
    await api.connect(responderContext);
    await api.connect(otherContext);
    await owner.goto("/");
    await expect(
      owner.getByRole("combobox", { name: "Active scenario" }),
    ).toBeVisible();
    // Publishing requires an account before configuration so signup never
    // destroys an already authored questionnaire.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      owner.getByRole("button", { name: "Create free account", exact: true }),
    ).toBeVisible();
    await expect(
      owner.getByRole("textbox", {
        name: "Feedback introduction",
        exact: true,
      }),
    ).toHaveCount(0);
    await closeDialog(owner);
    await owner
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await register(
      owner,
      "QA Engagement Owner",
      "engagement-owner@urban-planning.test",
    );
    await expect(owner.locator(".account-button")).toContainText(
      "QA Engagement Owner",
    );
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner
      .getByRole("checkbox", { name: "Collect public feedback", exact: true })
      .check();
    for (const name of [
      "Written comments",
      "Support / concern responses",
      "Comments with map locations",
    ])
      await owner.getByRole("checkbox", { name, exact: true }).uncheck();
    await owner
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    await expect(owner.getByRole("alert")).toContainText(
      "Choose a feedback method",
    );
    expect((await api.persistedState()).published).toHaveLength(0);
    for (const name of [
      "Written comments",
      "Support / concern responses",
      "Comments with map locations",
    ])
      await owner.getByRole("checkbox", { name, exact: true }).check();
    await owner
      .getByRole("textbox", { name: "Feedback introduction", exact: true })
      .fill(introduction);
    await owner
      .getByRole("button", { name: "Add survey question", exact: true })
      .click();
    await owner
      .getByRole("textbox", { name: "Question 1 prompt", exact: true })
      .fill(question);
    await owner
      .getByRole("combobox", { name: "Question 1 type", exact: true })
      .selectOption("single-choice");
    await owner
      .getByRole("textbox", { name: "Question 1, choice 1", exact: true })
      .fill("More homes");
    await owner
      .getByRole("textbox", { name: "Question 1, choice 2", exact: true })
      .fill("More shade");
    await owner
      .getByRole("checkbox", { name: "Required question 1", exact: true })
      .check();
    await owner
      .getByRole("button", { name: "Add survey question", exact: true })
      .click();
    await owner
      .getByRole("textbox", { name: "Question 2 prompt", exact: true })
      .fill(writtenQuestion);
    await owner
      .getByRole("heading", {
        name: "A shared vision starts here.",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await owner.screenshot({
      path: testInfo.outputPath("engagement-publish-configuration.png"),
      fullPage: true,
    });
    await owner
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = owner.getByRole("textbox", {
      name: "Published link",
      exact: true,
    });
    await expect(link).toBeVisible();
    const url = await link.inputValue(),
      snapshotId = new URL(url).pathname.split("/").pop()!;
    const published = (await api.persistedState()).published.find(
      (value) => value.id === snapshotId,
    )!;
    const projectId = published.projectId;
    const capturedConfig = structuredClone(published.engagement!.config);
    await expect(
      owner.getByRole("textbox", {
        name: "Feedback introduction",
        exact: true,
      }),
    ).toBeDisabled();
    await closeDialog(owner);

    await responder.goto(url);
    await expect(responder.locator(".city-map canvas")).toBeVisible();
    await responder
      .getByRole("tab", { name: "Your voice", exact: true })
      .click();
    await expect(responder.locator(".engagement-introduction")).toHaveText(
      introduction,
    );
    await expect(
      responder.getByText("A free account to add your voice", { exact: true }),
    ).toBeVisible();
    const publicMetadata = await requestAs(
      responder,
      `/published/${snapshotId}/engagement`,
    );
    expect(JSON.stringify(publicMetadata.data)).not.toContain(
      "engagement-owner@",
    );
    expect(
      (await requestAs(responder, `/published/${snapshotId}/feedback/mine`))
        .status,
    ).toBe(401);
    await responder
      .getByRole("button", { name: "Sign in or join free", exact: true })
      .click();
    await register(
      responder,
      "QA Neighborhood Voice",
      "engagement-responder@urban-planning.test",
    );
    await expect(
      responder.getByText("Responding as QA Neighborhood Voice", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      responder.getByRole("button", { name: "Send survey", exact: true }),
    ).toBeEnabled();
    await responder
      .getByRole("button", { name: "Send survey", exact: true })
      .click();
    await expect(responder.getByRole("alert")).toContainText(
      `Please answer: ${question}`,
    );
    expect(
      (await ownResponses(responder, snapshotId)).filter(
        (response) => response.kind === "survey",
      ),
    ).toHaveLength(0);
    await responder
      .getByRole("radio", { name: "More homes", exact: true })
      .check();
    await responder
      .getByRole("textbox", { name: writtenQuestion, exact: true })
      .fill("Keep the walking route accessible.");
    await responder
      .getByRole("button", { name: "Send survey", exact: true })
      .click();
    await expect(
      responder.getByText("Your survey was saved.", { exact: false }),
    ).toBeVisible();
    await responder
      .getByRole("radio", { name: "More shade", exact: true })
      .check();
    await responder
      .getByRole("button", { name: "Send survey", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await ownResponses(responder, snapshotId)).filter(
            (response) => response.kind === "survey" && response.current,
          ).length,
      )
      .toBe(1);
    await responder
      .getByRole("radio", { name: "I see promise here", exact: true })
      .check();
    await responder
      .getByRole("button", { name: "Send response", exact: true })
      .click();
    await expect(
      responder.getByText("Your response was saved.", { exact: false }),
    ).toBeVisible();
    await responder
      .getByRole("radio", { name: "I have concerns", exact: true })
      .check();
    await responder
      .getByRole("button", { name: "Send response", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await ownResponses(responder, snapshotId))
          .filter((response) => response.kind === "vote" && response.current)
          .map((response) => response.vote),
      )
      .toEqual(["concern"]);

    await responder
      .getByRole("button", { name: "Pick a map location", exact: true })
      .click();
    await expect(
      responder.locator(".city-map-selecting-comment"),
    ).toBeVisible();
    await responder.locator(".maplibregl-canvas").click();
    await expect(
      responder.getByText("Comment location:", { exact: false }),
    ).toBeVisible();
    await expect(responder.locator(".shared-inspector")).toHaveCount(0);
    await responder
      .getByRole("button", { name: "Remove comment location", exact: true })
      .click();
    await responder
      .getByRole("button", { name: "Enter coordinates", exact: true })
      .click();
    await responder
      .getByRole("textbox", { name: "Latitude", exact: true })
      .fill("0");
    await responder
      .getByRole("textbox", { name: "Longitude", exact: true })
      .fill("0");
    await responder
      .getByRole("button", { name: "Use coordinates", exact: true })
      .click();
    await expect(responder.getByRole("alert")).toContainText(
      "inside the published study area",
    );
    await responder
      .getByRole("textbox", { name: "Latitude", exact: true })
      .fill("33.455");
    await responder
      .getByRole("textbox", { name: "Longitude", exact: true })
      .fill("-112.073");
    await responder
      .getByRole("button", { name: "Use coordinates", exact: true })
      .click();
    await expect(
      responder.getByText("Comment location:", { exact: false }),
    ).toContainText("33.45500, -112.07300");
    await expect(responder.locator(".city-review-pin")).toHaveCount(1);
    await responder
      .getByRole("textbox", {
        name: "What would you like the team to know?",
        exact: true,
      })
      .fill(comment);
    api.loseNextResponse(`/api/v1/published/${snapshotId}/feedback`);
    await responder
      .getByRole("button", { name: "Send comment", exact: true })
      .click();
    await expect(responder.getByRole("alert")).toContainText(
      "couldn't confirm this submission",
    );
    expect(
      (await ownResponses(responder, snapshotId)).filter(
        (response) => response.kind === "comment",
      ),
    ).toHaveLength(1);
    // The reply was lost after commit. Even a real close/reopen must preserve its
    // original request version/key when refreshed metadata reaches the responder.
    const collectionPath = `/projects/${projectId}/engagement/${snapshotId}/collection`;
    expect(
      (
        await requestAs(owner, collectionPath, "PATCH", {
          status: "closed",
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await requestAs(owner, collectionPath, "PATCH", {
          status: "open",
          expectedVersion: 2,
        })
      ).status,
    ).toBe(200);
    const refreshedAvailability = responder.waitForResponse(
      (response) =>
        response.url().endsWith(`/published/${snapshotId}/engagement`) &&
        response.request().method() === "GET",
    );
    await responder
      .getByRole("button", { name: "Refresh availability", exact: true })
      .click();
    expect(
      (await (await refreshedAvailability).json()).collection.version,
    ).toBe(3);
    await responder
      .getByRole("button", { name: "Send comment", exact: true })
      .click();
    await expect(
      responder.getByText(
        "This response was already received. No duplicate was added.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      (await ownResponses(responder, snapshotId)).filter(
        (response) => response.kind === "comment",
      ),
    ).toHaveLength(1);
    await responder.reload();
    await responder
      .getByRole("tab", { name: "Your voice", exact: true })
      .click();
    await expect(
      responder.getByRole("radio", { name: "I have concerns", exact: true }),
    ).toBeChecked();
    await expect(
      responder.getByRole("radio", { name: "More shade", exact: true }),
    ).toBeChecked();
    await responder.getByText(/^Your submitted responses/).click();
    await expect(responder.locator(".engagement-own-history")).toContainText(
      comment,
    );
    await responder.setViewportSize({ width: 390, height: 844 });
    await responder.locator(".engagement-public").scrollIntoViewIfNeeded();
    expect(
      await responder.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await responder.screenshot({
      path: testInfo.outputPath("engagement-public-mobile.png"),
    });
    await responder.setViewportSize({ width: 1440, height: 1000 });

    await other.goto(url);
    await other.getByRole("tab", { name: "Your voice", exact: true }).click();
    await expect(other.getByText(comment, { exact: true })).toHaveCount(0);
    await other
      .getByRole("button", { name: "Sign in or join free", exact: true })
      .click();
    await register(
      other,
      "QA Second Neighbor",
      "engagement-second@urban-planning.test",
    );
    await expect(
      other.getByText("Responding as QA Second Neighbor", { exact: false }),
    ).toBeVisible();
    await expect(other.getByText(comment, { exact: true })).toHaveCount(0);
    await other
      .getByRole("radio", { name: "I see promise here", exact: true })
      .check();
    await other
      .getByRole("button", { name: "Send response", exact: true })
      .click();
    await expect(
      other.getByText("Your response was saved.", { exact: false }),
    ).toBeVisible();
    expect(
      (
        await requestAs(
          other,
          `/projects/${projectId}/engagement/${snapshotId}`,
        )
      ).status,
    ).toBe(404);

    await owner.getByRole("button", { name: "Feedback", exact: true }).click();
    await expect(
      owner.getByRole("dialog", { name: "Listen to the neighborhood." }),
    ).toBeVisible();
    await expect(owner.locator('[role="dialog"]')).toHaveCount(1);
    const row = owner
      .locator(".engagement-response")
      .filter({ hasText: comment });
    await expect(row).toBeVisible();
    let report = await detail(owner, projectId, snapshotId);
    expect(report.snapshot.aggregate).toMatchObject({
      participatingAccounts: 2,
      comments: { count: 1, pinnedCount: 1 },
      votes: { accounts: 2, support: 1, concern: 1 },
      survey: { accounts: 1 },
      supersededRecords: 2,
    });
    const popupPromise = owner.waitForEvent("popup");
    await row.getByRole("link", { name: /View location/ }).click();
    const popup = await popupPromise;
    await expect(popup.locator(".city-review-pin")).toHaveCount(1);
    expect(new URL(popup.url()).searchParams.get("pin")).toBe(
      "-112.073,33.455",
    );
    await expect(popup.getByText(comment, { exact: true })).toHaveCount(0);
    await popup.screenshot({
      path: testInfo.outputPath("engagement-public-pin.png"),
    });
    await popup.close();
    await row
      .getByRole("button", { name: "Exclude from summary", exact: true })
      .click();
    await row
      .getByRole("textbox", { name: "Reason for exclusion", exact: true })
      .fill("QA review: checking duplicate content before inclusion.");
    await row
      .getByRole("button", { name: "Save review decision", exact: true })
      .click();
    await expect(row).toContainText("Excluded from summary");
    await expect
      .poll(
        async () =>
          (await detail(owner, projectId, snapshotId)).snapshot.aggregate
            .comments.count,
      )
      .toBe(0);
    expect(
      JSON.stringify(await ownResponses(responder, snapshotId)),
    ).not.toContain("QA review: checking duplicate");
    await row
      .getByRole("button", { name: "Restore to summary", exact: true })
      .click();
    await row
      .getByRole("textbox", { name: "Review reason", exact: true })
      .fill("Reviewed: distinct local perspective, retained in the summary.");
    await row
      .getByRole("button", { name: "Save review decision", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await detail(owner, projectId, snapshotId)).snapshot.aggregate
            .comments.count,
      )
      .toBe(1);
    await owner
      .getByRole("checkbox", {
        name: "Include replaced responses",
        exact: true,
      })
      .check();
    await expect(
      owner.getByText("Replaced · not counted", { exact: true }),
    ).toHaveCount(2);
    await owner.screenshot({
      path: testInfo.outputPath("engagement-owner-review.png"),
      fullPage: true,
    });
    for (const [label, filename] of [
      ["Feedback report · PDF", "engagement-report.pdf"],
      ["Responses · CSV", "engagement-responses.csv"],
    ] as const) {
      const download = owner.waitForEvent("download");
      await owner.getByRole("button", { name: label, exact: true }).click();
      const path = testInfo.outputPath(filename);
      await (await download).saveAs(path);
      const data = await readFile(path);
      if (filename.endsWith("pdf"))
        expect(data.subarray(0, 5).toString()).toBe("%PDF-");
      else expect(data.toString()).toContain(comment);
    }
    await owner
      .getByRole("heading", {
        name: "Listen to the neighborhood.",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await owner.screenshot({
      path: testInfo.outputPath("engagement-owner-summary.png"),
    });
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await owner.screenshot({
      path: testInfo.outputPath("engagement-owner-mobile.png"),
    });
    await owner.setViewportSize({ width: 1440, height: 1000 });

    await owner
      .getByRole("button", { name: "Close submissions", exact: true })
      .click();
    await expect(
      owner.getByText("Submissions closed", { exact: true }),
    ).toBeVisible();
    await responder
      .getByRole("button", { name: "Refresh availability", exact: true })
      .click();
    await expect(
      responder.getByText("Feedback collection is closed", { exact: true }),
    ).toBeVisible();
    await expect(
      responder.getByRole("button", { name: "Send survey", exact: true }),
    ).toBeDisabled();
    expect(
      (
        await requestAs(
          responder,
          `/published/${snapshotId}/feedback`,
          "POST",
          {
            kind: "vote",
            vote: "support",
            idempotencyKey: "closed-collection-qa-request",
            expectedCollectionVersion: 4,
          },
        )
      ).status,
    ).toBe(409);
    await owner
      .getByRole("button", { name: "Reopen submissions", exact: true })
      .click();
    await responder
      .getByRole("button", { name: "Refresh availability", exact: true })
      .click();
    await expect(
      responder.getByText("Open for feedback", { exact: true }),
    ).toBeVisible();
    await expect(
      responder.getByRole("button", { name: "Send survey", exact: true }),
    ).toBeEnabled();
    expect(
      (await api.persistedState()).published.find(
        (value) => value.id === snapshotId,
      )!.engagement!.config,
    ).toEqual(capturedConfig);
    // A cross-tab logout must immediately hide personal history and draft identity on focus.
    await responder
      .getByRole("textbox", {
        name: "What would you like the team to know?",
        exact: true,
      })
      .fill("Private unsent draft from the first account.");
    expect((await requestAs(responder, "/auth/logout", "POST")).status).toBe(
      200,
    );
    await responder.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      responder.getByText("A free account to add your voice", { exact: true }),
    ).toBeVisible();
    await expect(responder.getByText(comment, { exact: true })).toHaveCount(0);
    await expect(
      responder.getByText("Responding as QA Neighborhood Voice", {
        exact: false,
      }),
    ).toHaveCount(0);

    await expect(
      responder.getByRole("textbox", {
        name: "What would you like the team to know?",
        exact: true,
      }),
    ).toHaveValue("");

    const retainedCount = (await api.persistedState()).publicFeedback.length;
    await owner
      .getByRole("button", { name: "Revoke public link", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Confirm revocation", exact: true })
      .click();
    await expect(
      owner.getByText(
        "Public link revoked. Responses remain in project records.",
        { exact: true },
      ),
    ).toBeVisible();
    await responder
      .getByRole("button", { name: "Refresh availability", exact: true })
      .click();
    await expect(
      responder.getByRole("heading", {
        name: "This shared link is unavailable.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(responder.locator(".city-map canvas")).toHaveCount(0);
    expect((await api.persistedState()).publicFeedback).toHaveLength(
      retainedCount,
    );
    report = await detail(owner, projectId, snapshotId);
    expect(report.records).toHaveLength(retainedCount);
    expect(report.audit.length).toBeGreaterThan(3);
    expect(errors).toEqual([]);
    // This workflow intentionally exercises 401/404/409 responses and one lost
    // network reply. React/runtime console errors must still fail the test.
    expect(
      consoleErrors.filter(
        (message) => !message.startsWith("Failed to load resource:"),
      ),
    ).toEqual([]);
  } finally {
    await writeFile(
      testInfo.outputPath("browser-console.json"),
      JSON.stringify({ errors, consoleErrors }, null, 2),
    );
    await responderContext.close();
    await otherContext.close();
    await api.close();
  }
});
