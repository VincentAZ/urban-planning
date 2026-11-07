import { test, expect, type Page } from "@playwright/test";
import { createCollaborationApi } from "./support/collaboration-api";
import type { Session } from "../../apps/web/src/lib/api";

const password = "Isolated-account-password-2026";
test("disabled email is explained while authenticated password changes remain available", async ({
  page,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin, {
    identityDisabled: true,
  });
  try {
    await api.connect(page);
    await register(page, "delivery-disabled@example.test", "Private Planner");
    await page
      .getByRole("button", { name: "Account security", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Request verification email",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByText(/Email delivery is unavailable on this server/).first(),
    ).toBeVisible();
    await page.getByText("Change password", { exact: true }).click();
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page
      .getByLabel("New password", { exact: true })
      .fill("New-private-account-password-2026");
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill("New-private-account-password-2026");
    await page.screenshot({
      path: info.outputPath("account-password-change.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: "Change password and sign out",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Password updated.", exact: true }),
    ).toBeVisible();
    const state = await api.persistedState();
    expect(state.sessions).toHaveLength(0);
    expect(state.identityOutbox).toHaveLength(0);
    expect(state.users[0].emailVerifiedAt).toBeUndefined();
    await page
      .getByRole("button", {
        name: "Sign in with your new password",
        exact: true,
      })
      .click();
    await page
      .getByLabel("Email", { exact: true })
      .fill("delivery-disabled@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("New-private-account-password-2026");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "Private Planner",
    );
  } finally {
    await api.close();
  }
});
async function request<T = any>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await fetch("/api/v1/auth/session").then((r) => r.json());
      const response = await fetch(`/api/v1${path}`, {
        method,
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
async function register(page: Page, email: string, name: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page.getByLabel("Your name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create free account", exact: true })
    .click();
  await expect(page.locator(".account-button")).toContainText(name);
}
async function openLink(page: Page, kind: string, token: string) {
  await page.goto(`/#identity=${kind}&token=${token}`);
  await expect.poll(() => new URL(page.url()).hash.length === 0).toBe(true);
}
async function verify(
  page: Page,
  api: Awaited<ReturnType<typeof createCollaborationApi>>,
  email: string,
) {
  await expect(page.locator(".account-button")).not.toContainText(
    "Save your work",
  );
  await page.locator(".account-button").click();
  await page
    .getByRole("button", { name: "Account security", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Request verification email", exact: true })
    .click();
  const token = await api.identityToken("verify-email", email);
  await openLink(page, "verify-email", token);
  await page
    .getByRole("button", { name: "Verify this email", exact: true })
    .click();
  await expect(
    page.getByText("Your email is verified.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  return token;
}

test("verified email and recovery use explicit actions and revoke every old session without losing projects", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin),
    email = "identity-owner@example.test";
  const oldContext = await browser.newContext({ baseURL }),
    oldSession = await oldContext.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api.connect(page);
    await api.connect(oldContext);
    await register(page, email, "Identity Owner");
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
    const before = (await api.persistedState()).projects;
    await page
      .getByRole("button", { name: "Account security", exact: true })
      .click();
    await expect(
      page.getByText("Email not yet verified", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("account-security-desktop.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Request verification email", exact: true })
      .click();
    const verification = await api.identityToken("verify-email", email);
    await openLink(page, "verify-email", verification);
    expect(
      (await api.persistedState()).users[0].emailVerifiedAt,
    ).toBeUndefined();
    await page
      .getByRole("button", { name: "Verify this email", exact: true })
      .click();
    await expect(
      page.getByText("Your email is verified.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await oldSession.goto("/");
    expect(
      (await request(oldSession, "/auth/login", "POST", { email, password }))
        .status,
    ).toBe(200);
    expect((await request(page, "/auth/logout", "POST", {})).status).toBe(200);
    await page.reload();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // A saved-project gate can open the shared auth dialog in its default register mode.
    if (
      await page
        .getByRole("button", { name: "Sign in instead", exact: true })
        .count()
    )
      await page
        .getByRole("button", { name: "Sign in instead", exact: true })
        .click();
    if (
      !(await page
        .getByRole("button", { name: "Forgot password?", exact: true })
        .count())
    )
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Forgot password?", exact: true })
      .click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page
      .getByRole("button", { name: "Request password reset", exact: true })
      .click();
    const reset = await api.identityToken("password-reset", email);
    await openLink(page, "password-reset", reset);
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByLabel("New password", { exact: true })
      .fill("A-new-isolated-password-2026");
    await page
      .getByLabel("Confirm new password", { exact: true })
      .fill("A-new-isolated-password-2026");
    await page.screenshot({
      path: info.outputPath("password-recovery-mobile.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Reset password", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Password updated.", exact: true }),
    ).toBeVisible();
    expect(
      (await request<Session>(oldSession, "/auth/session")).data.user,
    ).toBeNull();
    expect((await api.persistedState()).projects).toEqual(before);
    expect(
      (await request(oldSession, "/auth/login", "POST", { email, password }))
        .status,
    ).toBe(401);
    await page
      .getByRole("button", {
        name: "Sign in with your new password",
        exact: true,
      })
      .click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page
      .getByLabel("Password", { exact: true })
      .fill("A-new-isolated-password-2026");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "Identity Owner",
    );
    expect(
      (
        await request(page, "/auth/password-reset/confirm", "POST", {
          token: reset,
          password: "Another-new-password-2026",
        })
      ).status,
    ).toBe(400);
    expect(errors).toEqual([]);
  } finally {
    await oldContext.close();
    await api.close();
  }
});

test("project invitation reveals details only after verification and requires acceptance without replacing the recipient draft", async ({
  page: owner,
  browser,
  baseURL,
}, info) => {
  const api = await createCollaborationApi(new URL(baseURL!).origin),
    recipientEmail = "invited-planner@example.test";
  const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
    }),
    recipient = await context.newPage();
  try {
    await api.connect(owner);
    await api.connect(context);
    await register(owner, "inviting-owner@example.test", "Inviting Owner");
    await verify(owner, api, "inviting-owner@example.test");
    await owner.getByRole("button", { name: "Open project home" }).click();
    await owner
      .getByRole("button", {
        name: "Save current project to account",
        exact: true,
      })
      .click();
    await expect(
      owner.getByText("Project saved to your private workspace.", {
        exact: true,
      }),
    ).toBeVisible();
    await owner
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    const projectId = (await api.persistedState()).projects[0].project.id;
    await register(recipient, recipientEmail, "Invited Planner");
    const originalName = await recipient
      .locator(".project-breadcrumb strong")
      .innerText();
    await owner.getByRole("button", { name: "Team", exact: true }).click();
    await owner
      .getByRole("textbox", { name: "Invitation email", exact: true })
      .fill(recipientEmail);
    await owner
      .getByRole("combobox", { name: "Invitation role", exact: true })
      .selectOption("commenter");
    await owner
      .getByRole("button", { name: "Send invitation", exact: true })
      .click();
    const token = await api.identityToken("invitation", recipientEmail);
    await expect(owner.getByText(/Pending acceptance/)).toBeVisible();
    await owner.screenshot({
      path: info.outputPath("pending-invitation-desktop.png"),
      fullPage: true,
    });
    expect((await request(recipient, `/projects/${projectId}`)).status).toBe(
      404,
    );
    await openLink(recipient, "invitation", token);
    await expect(
      recipient.getByText(/Verify this account’s email before reviewing/),
    ).toBeVisible();
    await expect(
      recipient.getByRole("button", { name: "Review invitation", exact: true }),
    ).toHaveCount(0);
    // Verify in a second tab so the invitation stays only in memory in the original tab.
    const verificationPage = await context.newPage();
    await verificationPage.goto("/");
    await verify(verificationPage, api, recipientEmail);
    await verificationPage.close();
    await recipient
      .getByRole("button", { name: "Refresh verification status", exact: true })
      .click();
    await recipient
      .getByRole("button", { name: "Review invitation", exact: true })
      .click();
    await expect(
      recipient.getByRole("region", { name: "Invitation details" }),
    ).toBeVisible();
    expect((await request(recipient, `/projects/${projectId}`)).status).toBe(
      404,
    );
    await recipient.screenshot({
      path: info.outputPath("invitation-review-mobile.png"),
      fullPage: true,
    });
    await recipient
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(
      recipient.getByText(/Invitation accepted/).first(),
    ).toBeVisible();
    const after = await api.persistedState();
    expect(after.identityInvitations[0].status).toBe("accepted");
    expect(after.projects[0].acl?.members).toHaveLength(2);
    expect(
      after.projects[0].acl?.members.find(
        (m) =>
          m.userId === after.users.find((u) => u.email === recipientEmail)?.id,
      )?.role,
    ).toBe("commenter");
    expect(
      after.memberships
        .filter((m) => m.organizationId === after.projects[0].organizationId)
        .find(
          (m) =>
            m.userId ===
            after.users.find((u) => u.email === recipientEmail)?.id,
        )?.scope,
    ).toBe("project-only");
    expect(
      await recipient.locator(".project-breadcrumb strong").innerText(),
    ).toBe(originalName);
    expect(new URL(recipient.url()).hash).toBe("");
  } finally {
    await context.close();
    await api.close();
  }
});
