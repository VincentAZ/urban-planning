import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  baselineIdentity,
  type Project,
  type Place,
} from "../../packages/core/src/index";
import type { Session } from "../../apps/web/src/lib/api";
import { createCollaborationApi } from "./support/collaboration-api";

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Active scenario" }),
  ).toBeVisible();
  await expect(page.locator(".scorecard-scroll")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".city-map-loading")).toHaveCount(0);
  await expect(page.locator(".map-disclosure")).toContainText(
    "Synthetic collaboration QA",
  );
}
async function register(page: Page, name: string, email: string) {
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page
    .getByLabel(/^Password/)
    .fill("Isolated-collaboration-test-account-2026");
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(name);
}
async function closeDialog(page: Page) {
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}
async function saveProject(page: Page) {
  await page.getByRole("button", { name: "Open project home" }).click();
  await page
    .getByRole("button", {
      name: "Save current project to account",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Project saved to your private workspace.", { exact: true }),
  ).toBeVisible();
  await closeDialog(page);
}
/** Same-origin browser HTTP with the user's actual HttpOnly session cookie and issued CSRF token. */
async function requestAs<T = unknown>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await fetch("/api/v1/auth/session", {
        credentials: "include",
      }).then((response) => response.json());
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    },
    { path, method, body },
  ) as Promise<{ status: number; data: T }>;
}
async function inspectBuilding(page: Page, name = "QA apartments") {
  await page.getByRole("button", { name: "Open feature list" }).click();
  await page
    .getByRole("textbox", { name: "Search places or buildings" })
    .fill(name);
  await page
    .getByRole("region", { name: "Buildings in the current place" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit building", exact: true }),
  ).toBeVisible();
}
async function homesValue(page: Page) {
  const text = await page
    .locator(".metric-card")
    .filter({ has: page.locator(".metric-label", { hasText: /^Homes$/ }) })
    .locator(".metric-value")
    .innerText();
  return Number(text.replace(/[^\d.-]/g, ""));
}
async function roleChange(owner: Page, name: string, role: string) {
  await owner
    .getByRole("combobox", { name: `Role for ${name}`, exact: true })
    .selectOption(role);
  await owner
    .getByRole("button", { name: `Save role for ${name}`, exact: true })
    .click();
  await expect(
    owner.getByText("Project role updated.", { exact: true }),
  ).toBeVisible();
}
async function refreshAccess(page: Page, role: string) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".project-access-strip")).toContainText(
    new RegExp(role, "i"),
  );
}
async function disabledOrAbsent(control: Locator) {
  if (await control.count()) await expect(control).toBeDisabled();
}
async function postComment(page: Page, text: string) {
  await page
    .getByRole("textbox", { name: "New comment", exact: true })
    .fill(text);
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

test("project-only collaboration respects roles, preserves pinned discussion and revokes live access", async ({
  page: owner,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = await createCollaborationApi(new URL(baseURL!).origin);
  const reviewerContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const reviewer = await reviewerContext.newPage();
  const errors: string[] = [];
  for (const page of [owner, reviewer])
    page.on("pageerror", (error) => errors.push(error.message));
  const ownerName = "QA Project Owner",
    reviewerName = "QA Project Reviewer",
    reviewerEmail = "project-reviewer@urban-planning.test";
  const buildingNote = "Please review the courtyard entrance.";
  const replyText =
    "The entrance should remain visible from the public street.";
  const locationNote = "Keep a clear walking connection at this pin.";
  const metricNote = "Please document the dwelling-unit assumptions.";
  try {
    await api.connect(owner);
    await api.connect(reviewerContext);
    await openWorkspace(owner);
    await register(owner, ownerName, "project-owner@urban-planning.test");
    await saveProject(owner);
    const ownerSession = (await requestAs<Session>(owner, "/auth/session"))
      .data;
    const saved = (await api.persistedState()).projects.find(
      (record) => record.createdBy === ownerSession.user!.id,
    )!;
    expect(saved.acl?.members).toEqual([
      expect.objectContaining({ userId: ownerSession.user!.id, role: "owner" }),
    ]);
    const projectId = saved.project.id,
      scenarioId = saved.project.activeScenarioId;
    const capturedBaseline = structuredClone(saved.baseline);
    const sourceIdentity = await baselineIdentity(saved.baseline);
    // Seed a second, unrelated private project through the actual authorized endpoint.
    const secret = await requestAs<{ project: Project }>(
      owner,
      "/projects",
      "POST",
      { placeId: saved.baseline.id, name: "Owner confidential unrelated plan" },
    );
    expect(secret.status).toBe(201);
    const secretId = secret.data.project.id;
    await openWorkspace(reviewer);
    await register(reviewer, reviewerName, reviewerEmail);
    await saveProject(reviewer);
    const reviewerSession = (
      await requestAs<Session>(reviewer, "/auth/session")
    ).data;
    const ownProject = (await api.persistedState()).projects.find(
      (record) => record.createdBy === reviewerSession.user!.id,
    )!;

    for (const [accountPage, email] of [
      [owner, "project-owner@urban-planning.test"],
      [reviewer, reviewerEmail],
    ] as const) {
      expect(
        (
          await requestAs(
            accountPage,
            "/auth/email-verification/request",
            "POST",
            {},
          )
        ).status,
      ).toBe(202);
      const token = await api.identityToken("verify-email", email);
      expect(
        (
          await requestAs(
            accountPage,
            "/auth/email-verification/confirm",
            "POST",
            { token },
          )
        ).status,
      ).toBe(200);
      await accountPage.evaluate(() =>
        window.dispatchEvent(new Event("focus")),
      );
    }

    await owner.getByRole("button", { name: "Team", exact: true }).click();
    await owner
      .getByRole("textbox", { name: "Invitation email", exact: true })
      .fill(reviewerEmail);
    await owner
      .getByRole("combobox", { name: "Invitation role", exact: true })
      .selectOption("commenter");
    await owner
      .getByRole("button", { name: "Send invitation", exact: true })
      .click();
    const invitationToken = await api.identityToken(
      "invitation",
      reviewerEmail,
    );
    const preview = await requestAs<{
      invitation: { version: number };
      aclVersion: number;
    }>(reviewer, "/invitations/preview", "POST", { token: invitationToken });
    expect(preview.status).toBe(200);
    expect(
      (
        await requestAs(reviewer, "/invitations/accept", "POST", {
          token: invitationToken,
          expectedVersion: preview.data.invitation.version,
          expectedAclVersion: preview.data.aclVersion,
        })
      ).status,
    ).toBe(200);
    await owner
      .getByRole("button", { name: "Refresh project team", exact: true })
      .click();
    await expect(
      owner.getByRole("combobox", {
        name: `Role for ${reviewerName}`,
        exact: true,
      }),
    ).toHaveValue("commenter");
    await owner.screenshot({
      path: testInfo.outputPath("collaboration-project-team.png"),
      fullPage: true,
    });
    await owner.setViewportSize({ width: 390, height: 844 });
    await expect(
      owner.getByRole("dialog", { name: "Project team" }),
    ).toBeVisible();
    const mobileOverflow = await owner.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > innerWidth + 1;
        })
        .slice(0, 20)
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          right: el.getBoundingClientRect().right,
          width: el.getBoundingClientRect().width,
        })),
    }));
    expect(
      mobileOverflow.width,
      JSON.stringify(mobileOverflow),
    ).toBeLessThanOrEqual(mobileOverflow.viewport);
    await owner.screenshot({
      path: testInfo.outputPath("collaboration-project-team-mobile.png"),
      fullPage: false,
    });
    await owner.setViewportSize({ width: 1440, height: 1000 });
    const projectMembership = (await api.persistedState()).memberships.find(
      (member) =>
        member.userId === reviewerSession.user!.id &&
        member.organizationId === ownerSession.organization!.id,
    );
    expect(projectMembership?.scope).toBe("project-only");

    await reviewer.getByRole("button", { name: "Open project home" }).click();
    await reviewer
      .getByRole("button", { name: "Switch workspace", exact: true })
      .click();
    await expect(
      reviewer.getByRole("dialog", { name: "Your workspaces" }),
    ).toContainText("Shared projects only");
    await reviewer
      .getByRole("button", {
        name: `Open ${ownerSession.organization!.name} workspace`,
        exact: true,
      })
      .click();
    const sharedList = reviewer.getByRole("region", {
      name: "Saved account projects",
    });
    await expect(sharedList.locator("button.search-result")).toHaveCount(1);
    await expect(sharedList).not.toContainText(
      "Owner confidential unrelated plan",
    );
    const grantedList = await requestAs<{
      projects: { project: { id: string } }[];
    }>(reviewer, "/projects");
    expect(
      grantedList.data.projects.map((record) => record.project.id),
    ).toEqual([projectId]);
    expect((await requestAs(reviewer, `/projects/${secretId}`)).status).toBe(
      404,
    );
    expect(
      (await requestAs(reviewer, `/projects/${ownProject.project.id}`)).status,
    ).toBe(404);
    await sharedList.locator("button.search-result").click();
    await refreshAccess(reviewer, "commenter");
    await inspectBuilding(reviewer);
    await expect(
      reviewer.getByRole("button", { name: "Edit building", exact: true }),
    ).toBeDisabled();
    await expect(
      reviewer.getByRole("button", { name: "Create scenario", exact: true }),
    ).toBeDisabled();
    await reviewer
      .getByRole("button", { name: "2D plan", exact: true })
      .click();
    await reviewer
      .getByRole("button", { name: "Discuss this building", exact: true })
      .click();
    await expect(
      reviewer.getByRole("combobox", { name: "Comment target", exact: true }),
    ).toContainText("QA apartments");
    await postComment(reviewer, buildingNote);
    const buildingThread = (await api.persistedState()).comments.find(
      (comment) => comment.text === buildingNote,
    )!;
    expect(buildingThread.target).toEqual({
      kind: "building",
      id: "qa-apartments",
    });
    expect(buildingThread.scenarioRevision).toBe(
      saved.project.scenarios.find((s) => s.id === scenarioId)!.revision,
    );
    await closeDialog(reviewer);

    await closeDialog(owner);
    await owner.getByRole("button", { name: "Review", exact: true }).click();
    const ownerThread = owner.getByRole("article", {
      name: `${reviewerName}: QA apartments`,
      exact: true,
    });
    await ownerThread
      .getByRole("textbox", { name: `Reply to ${reviewerName}`, exact: true })
      .fill(replyText);
    await ownerThread
      .getByRole("button", { name: "Post reply", exact: true })
      .click();
    await expect(
      ownerThread.getByText(replyText, { exact: true }),
    ).toBeVisible();
    await closeDialog(owner);

    // Pin activation is a real native button, including keyboard activation, and never edits the scenario.
    const marker = reviewer.locator(
      `[data-review-pin-id="${buildingThread.id}"]`,
    );
    const originalCanvas = await reviewer
      .locator(".city-map canvas")
      .elementHandle();
    await expect(marker).toBeVisible();
    await marker.focus();
    await reviewer.keyboard.press("Enter");
    await expect(
      reviewer.getByRole("article", {
        name: `${reviewerName}: QA apartments`,
        exact: true,
      }),
    ).toBeFocused();
    await reviewer
      .getByRole("article", {
        name: `${reviewerName}: QA apartments`,
        exact: true,
      })
      .getByRole("button", { name: /Show review target/ })
      .click();
    await expect(
      reviewer.getByRole("dialog", { name: "Project review" }),
    ).toHaveCount(0);
    expect(await originalCanvas?.evaluate((canvas) => canvas.isConnected)).toBe(
      true,
    );
    await expect(
      reviewer.getByRole("button", { name: "2D plan", exact: true }),
    ).toHaveClass(/active/);
    await expect
      .poll(async () => {
        const pin = await marker.boundingBox(),
          map = await reviewer.locator(".city-map canvas").boundingBox();
        return pin && map
          ? Math.hypot(
              pin.x + pin.width / 2 - map.x - map.width / 2,
              pin.y + pin.height - map.y - map.height / 2,
            )
          : Infinity;
      })
      .toBeLessThan(3);
    await expect.poll(() => homesValue(reviewer)).toBe(48);
    await inspectBuilding(reviewer, "QA office");
    await expect(
      reviewer.getByRole("heading", { name: "QA office", exact: true }),
    ).toBeVisible();
    const markerBounds = await marker.boundingBox(),
      canvas = reviewer.locator(".city-map canvas"),
      canvasBounds = await canvas.boundingBox();
    if (!markerBounds || !canvasBounds)
      throw new Error("Review map geometry has no bounds.");
    await reviewer.getByRole("button", { name: "Review", exact: true }).click();
    await reviewer
      .getByRole("button", { name: "Pick a map location", exact: true })
      .click();
    await expect(reviewer.locator(".city-map")).toHaveClass(
      /city-map-selecting-comment/,
    );
    // The pin anchor is on the apartment footprint. Location mode must win over both pin and feature picking.
    await canvas.click({
      position: {
        x: markerBounds.x + markerBounds.width / 2 - canvasBounds.x,
        y: markerBounds.y + markerBounds.height - 1 - canvasBounds.y,
      },
    });
    await expect(
      reviewer.getByRole("dialog", { name: "Project review" }),
    ).toBeVisible();
    await postComment(reviewer, locationNote);
    await closeDialog(reviewer);
    await expect(
      reviewer.getByRole("heading", { name: "QA office", exact: true }),
    ).toBeVisible();
    const locationThread = (await api.persistedState()).comments.find(
      (comment) => comment.text === locationNote,
    )!;
    expect(locationThread.target?.kind).toBe("location");
    expect(locationThread.targetPosition?.[0]).toBeCloseTo(-112.073, 4);
    expect(locationThread.targetPosition?.[1]).toBeCloseTo(33.455, 4);
    await expect(reviewer.locator(".city-review-pin")).toHaveCount(2);
    await reviewer
      .getByRole("button", { name: "Before / after", exact: true })
      .click();
    await expect(
      reviewer.getByRole("slider", {
        name: "Before / after reveal",
        exact: true,
      }),
    ).toHaveValue("50");
    await expect(reviewer.locator(".city-review-pin")).toHaveCount(0);
    await expect(reviewer.locator(".city-reveal-help")).toContainText(
      "Review pins hidden",
    );
    await reviewer
      .getByRole("button", { name: "Back to scenario", exact: true })
      .click();
    await expect(reviewer.locator(".city-review-pin")).toHaveCount(2);
    expect((await api.persistedState()).comments).toHaveLength(2);
    await reviewer.screenshot({
      path: testInfo.outputPath("collaboration-private-map-pins.png"),
      fullPage: true,
    });

    await reviewer
      .locator(".metric-card")
      .filter({
        has: reviewer.locator(".metric-label", { hasText: /^Homes$/ }),
      })
      .click();
    await reviewer
      .getByRole("button", { name: "Discuss this metric", exact: true })
      .click();
    await postComment(reviewer, metricNote);
    expect(
      (await api.persistedState()).comments.find(
        (comment) => comment.text === metricNote,
      )?.target,
    ).toEqual({ kind: "metric", id: "housing.units" });
    await reviewer.screenshot({
      path: testInfo.outputPath("collaboration-review-threads.png"),
      fullPage: true,
    });
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await expect(
      reviewer.getByRole("dialog", { name: "Project review" }),
    ).toBeVisible();
    expect(
      await reviewer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await reviewer.screenshot({
      path: testInfo.outputPath("collaboration-review-mobile.png"),
      fullPage: false,
    });
    await reviewer.setViewportSize({ width: 1440, height: 1000 });
    await closeDialog(reviewer);

    await owner.getByRole("button", { name: "Team", exact: true }).click();
    await roleChange(owner, reviewerName, "viewer");
    await refreshAccess(reviewer, "viewer");
    await inspectBuilding(reviewer);
    await expect(
      reviewer.getByRole("button", { name: "Edit building", exact: true }),
    ).toBeDisabled();
    await reviewer.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      reviewer.getByRole("dialog", { name: "Project review" }),
    ).toContainText("viewer access");
    await expect(
      reviewer.getByRole("textbox", { name: "New comment", exact: true }),
    ).toHaveCount(0);
    await disabledOrAbsent(
      reviewer.getByRole("button", { name: "Post reply", exact: true }).first(),
    );
    const deniedComment = await requestAs(
      reviewer,
      `/projects/${projectId}/comments`,
      "POST",
      {
        scenarioId,
        text: "Unauthorized viewer write",
        target: { kind: "project" },
        expectedVersion: saved.version,
        expectedRevision: buildingThread.scenarioRevision,
        idempotencyKey: "viewer-denied-comment-2026",
      },
    );
    expect(deniedComment.status).toBe(403);
    const deniedEdit = await requestAs(
      reviewer,
      `/projects/${projectId}`,
      "PUT",
      {
        project: saved.project,
        expectedVersion: saved.version,
        baselineHash: sourceIdentity.sha256,
      },
    );
    expect(deniedEdit.status).toBe(403);
    expect((await api.persistedState()).comments).toHaveLength(3);
    await closeDialog(reviewer);

    await closeDialog(owner);
    await owner.getByRole("button", { name: "Review", exact: true }).click();
    await owner
      .getByRole("article", {
        name: `${reviewerName}: QA apartments`,
        exact: true,
      })
      .getByRole("button", { name: "Resolve thread", exact: true })
      .click();
    await owner
      .getByRole("combobox", { name: "Review status", exact: true })
      .selectOption("resolved");
    await expect(
      owner.getByRole("article", {
        name: `${reviewerName}: QA apartments`,
        exact: true,
      }),
    ).toContainText("Resolved");
    expect(
      (await api.persistedState()).comments.find(
        (comment) => comment.id === buildingThread.id,
      )?.resolved,
    ).toBe(true);
    await closeDialog(owner);

    await owner.getByRole("button", { name: "Team", exact: true }).click();
    await roleChange(owner, reviewerName, "editor");
    await refreshAccess(reviewer, "editor");
    await expect(
      reviewer.getByRole("button", { name: "Edit building", exact: true }),
    ).toBeEnabled();
    await reviewer
      .getByRole("button", { name: "Edit building", exact: true })
      .click();
    await reviewer
      .getByRole("spinbutton", { name: "Entered homes", exact: true })
      .fill("72");
    await reviewer
      .getByRole("button", { name: "Apply building", exact: true })
      .click();
    await expect.poll(() => homesValue(reviewer)).toBe(72);
    await saveProject(reviewer);
    const edited = (await api.persistedState()).projects.find(
      (record) => record.project.id === projectId,
    )!;
    expect(edited.version).toBe(saved.version + 1);
    expect(edited.baseline).toEqual(capturedBaseline);
    expect(edited.project.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Modify QA apartments" }),
      ]),
    );

    await closeDialog(owner);
    await refreshAccess(owner, "newer saved version");
    await owner
      .getByRole("button", { name: "Reopen saved version", exact: true })
      .click();
    await expect.poll(() => homesValue(owner)).toBe(72);
    await owner
      .getByRole("button", { name: "View history", exact: true })
      .click();
    await expect(owner.getByRole("dialog")).toContainText(
      "Modify QA apartments",
    );
    await closeDialog(owner);
    await owner.getByRole("button", { name: "Review", exact: true }).click();
    await owner
      .getByRole("combobox", { name: "Review status", exact: true })
      .selectOption("all");
    await expect(
      owner.getByRole("article", {
        name: `${reviewerName}: QA apartments`,
        exact: true,
      }),
    ).toContainText("scenario has changed");
    await closeDialog(owner);
    await owner.getByRole("button", { name: "Export", exact: true }).click();
    const recordsDownload = owner.waitForEvent("download");
    await owner.getByRole("button", { name: /Saved records · JSON/ }).click();
    const recordsFile = testInfo.outputPath("collaboration-saved-records.json");
    await (await recordsDownload).saveAs(recordsFile);
    const records = JSON.parse(await readFile(recordsFile, "utf8")) as {
      project: Project;
      baseline: Place;
      comments: {
        text: string;
        replies: { text: string }[];
        resolved: boolean;
      }[];
      audit: { action: string }[];
      projectVersion: number;
      sharing: {
        access: { mode: string; role: string };
        members: { userId: string; role: string }[];
      };
    };
    expect(records.project.history).toEqual(edited.project.history);
    expect(records.projectVersion).toBe(edited.version);
    expect(records.sharing.access).toMatchObject({
      mode: "private",
      role: "owner",
    });
    expect(records.sharing.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: reviewerSession.user!.id,
          role: "editor",
        }),
      ]),
    );
    expect(records.baseline).toEqual(capturedBaseline);
    expect(records.comments.map((comment) => comment.text)).toEqual(
      expect.arrayContaining([buildingNote, locationNote, metricNote]),
    );
    expect(
      records.comments.find((comment) => comment.text === buildingNote),
    ).toMatchObject({
      resolved: true,
      replies: [expect.objectContaining({ text: replyText })],
    });
    expect(records.audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "comment.created",
        "comment.replied",
        "comment.resolved",
        "project.member.updated",
      ]),
    );
    expect(JSON.stringify(records)).not.toContain(secretId);
    await closeDialog(owner);

    // Publishing a read-only snapshot must never publish private review threads or map pins.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const publishedLink = owner.getByRole("textbox", {
      name: "Published link",
      exact: true,
    });
    await expect(publishedLink).toBeVisible();
    const publicContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    try {
      await api.connect(publicContext);
      const publicPage = await publicContext.newPage();
      publicPage.on("pageerror", (error) => errors.push(error.message));
      await publicPage.goto(await publishedLink.inputValue());
      await expect(publicPage.locator(".city-map canvas")).toBeVisible();
      await expect(publicPage.locator(".city-map-loading")).toHaveCount(0);
      await expect(publicPage.locator(".city-review-pin")).toHaveCount(0);
      await expect(
        publicPage.getByText(buildingNote, { exact: true }),
      ).toHaveCount(0);
      await expect(
        publicPage.getByText(replyText, { exact: true }),
      ).toHaveCount(0);
      await expect(
        publicPage.getByRole("button", { name: "Review", exact: true }),
      ).toHaveCount(0);
      await publicPage.screenshot({
        path: testInfo.outputPath("collaboration-public-snapshot.png"),
        fullPage: true,
      });
    } finally {
      await publicContext.close();
    }
    await closeDialog(owner);

    await owner.getByRole("button", { name: "Team", exact: true }).click();
    await owner
      .getByRole("button", {
        name: `Remove ${reviewerName} from project`,
        exact: true,
      })
      .click();
    await owner
      .getByRole("button", { name: "Remove access", exact: true })
      .click();
    await expect(
      owner.getByText("Project access removed. Review history was retained.", {
        exact: true,
      }),
    ).toBeVisible();
    await reviewer.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      reviewer.getByText(/This draft belongs to another workspace/),
    ).toBeVisible();
    await expect(reviewer.locator(".city-map canvas")).toHaveCount(0);
    await expect(
      reviewer.getByRole("button", { name: "Edit building", exact: true }),
    ).toHaveCount(0);
    await expect(reviewer.locator(".city-review-pin")).toHaveCount(0);
    for (const path of [
      `/projects/${projectId}`,
      `/projects/${projectId}/comments`,
      `/projects/${projectId}/exports?format=records`,
    ])
      expect((await requestAs(reviewer, path)).status).toBe(404);
    await reviewer.screenshot({
      path: testInfo.outputPath("collaboration-access-revoked.png"),
      fullPage: true,
    });
    await reviewer
      .getByRole("button", { name: "Project home", exact: true })
      .click();
    await expect(
      reviewer.getByRole("button", {
        name: "Save current project to account",
        exact: true,
      }),
    ).toBeDisabled();
    await reviewer
      .getByRole("button", { name: "Switch workspace", exact: true })
      .click();
    await expect(
      reviewer.getByRole("button", {
        name: `Open ${ownerSession.organization!.name} workspace`,
        exact: true,
      }),
    ).toHaveCount(0);
    const ownWorkspace = reviewer.getByRole("button", {
      name: `Open ${reviewerSession.organization!.name} workspace`,
      exact: true,
    });
    if (await ownWorkspace.isEnabled()) await ownWorkspace.click();
    else await closeDialog(reviewer);
    const ownList = reviewer.getByRole("region", {
      name: "Saved account projects",
    });
    await expect(ownList.locator("button.search-result")).toHaveCount(1);
    await ownList.locator("button.search-result").click();
    await expect.poll(() => homesValue(reviewer)).toBe(48);
    await expect(reviewer.locator(".project-access-strip")).toContainText(
      "owner",
    );
    expect((await api.persistedState()).comments).toHaveLength(3);
    expect((await api.persistedState()).projects).toHaveLength(3);
    await reviewer.getByRole("button", { name: "Open project home" }).click();
    await reviewer
      .getByRole("button", { name: "Switch workspace", exact: true })
      .click();
    await reviewer
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await expect(reviewer.locator(".city-map canvas")).toHaveCount(0);
    await expect(reviewer.locator(".metric-card")).toHaveCount(0);
    await reviewer.reload();
    await expect(
      reviewer.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(reviewer.locator(".city-map canvas")).toHaveCount(0);
    // A session lost in another tab must dismiss private metric state before public recovery.
    await closeDialog(owner);
    await owner
      .locator(".metric-card")
      .filter({ has: owner.locator(".metric-label", { hasText: /^Homes$/ }) })
      .click();
    await expect(owner.locator(".metric-detail .detail-number")).toContainText(
      "72",
    );
    expect((await requestAs(owner, "/auth/logout", "POST", {})).status).toBe(
      200,
    );
    await owner.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      owner.getByRole("heading", { name: "Saved project access", exact: true }),
    ).toBeVisible();
    await expect(owner.locator(".metric-detail")).toHaveCount(0);
    await expect(owner.locator(".city-map canvas")).toHaveCount(0);
    await owner
      .getByRole("button", { name: "Explore public example", exact: true })
      .click();
    await expect(
      owner.getByRole("combobox", { name: "Active scenario" }),
    ).toBeVisible();
    await expect.poll(() => homesValue(owner)).toBe(48);
    await expect(owner.locator(".metric-detail")).toHaveCount(0);
    await expect(owner.locator(".city-review-pin")).toHaveCount(0);
    await expect(owner.locator(".city-map canvas")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await reviewerContext.close();
    await api.close();
  }
});
