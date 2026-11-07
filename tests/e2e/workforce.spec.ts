import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createCollaborationApi } from "./support/collaboration-api";

const workbench = (page: Page) =>
  page.getByRole("dialog", { name: "Who can reach this site?", exact: true });
async function openWorkbench(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Economy", exact: true }).click();
  await page.getByRole("button", { name: "Readiness", exact: true }).click();
  await page
    .getByRole("button", { name: /Explore workforce|Open workforce/ })
    .click();
  await expect(workbench(page)).toBeVisible();
}
test("anonymous site and mode survive account creation and first cloud save without starting paid or native work", async ({
  page,
  baseURL,
}) => {
  const isolated = await createCollaborationApi(baseURL!);
  await isolated.connect(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openWorkbench(page);
    await workbench(page)
      .getByLabel("Site latitude", { exact: true })
      .fill("33.448");
    await workbench(page)
      .getByLabel("Site longitude", { exact: true })
      .fill("-112.074");
    await workbench(page).getByLabel("Commute mode").selectOption("walk");
    await expect(
      workbench(page).getByRole("button", { name: "Run workforce shed" }),
    ).toBeDisabled();
    await workbench(page)
      .getByRole("button", { name: "Sign in or create a free account" })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("QA Workforce Planner");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("workforce-planner@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-workforce-test-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(workbench(page)).toBeVisible();
    await expect(
      workbench(page).getByLabel("Site latitude", { exact: true }),
    ).toHaveValue("33.448");
    await expect(
      workbench(page).getByLabel("Site longitude", { exact: true }),
    ).toHaveValue("-112.074");
    await expect(workbench(page).getByLabel("Commute mode")).toHaveValue(
      "walk",
    );
    await workbench(page)
      .getByRole("button", { name: "Save project to run" })
      .click();
    await expect(
      workbench(page).getByRole("button", { name: "Save project to run" }),
    ).toHaveCount(0);
    await expect(
      workbench(page).getByLabel("Site longitude", { exact: true }),
    ).toHaveValue("-112.074");
    await expect(workbench(page).getByLabel("Commute mode")).toHaveValue(
      "walk",
    );
    await expect(workbench(page)).toContainText("disabled on this server");
    await expect(
      workbench(page).getByRole("button", { name: "Run workforce shed" }),
    ).toBeDisabled();
    const state = await isolated.persistedState();
    expect(state.projects).toHaveLength(1);
    expect(state.workforceJobs).toHaveLength(0);
    expect(state.budget.policy.monthlyLimitCents).toBe(30000);
    expect(errors).toEqual([]);
  } finally {
    await isolated.close();
  }
});

test("coordinate errors and keyboard map controls stay usable on a narrow screen", async ({
  page,
  baseURL,
}) => {
  const isolated = await createCollaborationApi(baseURL!);
  await isolated.connect(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkbench(page);
    const dialog = workbench(page);
    await dialog.getByLabel("Site latitude", { exact: true }).fill("95");
    await expect(
      dialog.getByRole("button", { name: "Run workforce shed" }),
    ).toBeDisabled();
    await dialog.getByLabel("Site latitude", { exact: true }).fill("33.455");
    const fit = dialog.getByRole("button", {
      name: "Fit study area",
      exact: true,
    });
    await expect(fit).toBeEnabled();
    await fit.focus();
    await page.keyboard.press("Enter");
    await dialog
      .getByRole("button", { name: "Choose map center", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Site latitude", { exact: true }),
    ).not.toHaveValue("95");
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await isolated.close();
  }
});

test("a retained run survives an uncertain response, export and restored-copy save, with honest public origin", async ({
  page,
  browser,
  baseURL,
}, info) => {
  const isolated = await createCollaborationApi(baseURL!, {
    workforceFixture: true,
  });
  await isolated.connect(page);
  const publicContext = await browser.newContext();
  try {
    await openWorkbench(page);
    await workbench(page)
      .getByRole("button", { name: "Sign in or create a free account" })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("QA Workforce Owner");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("workforce-owner@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-workforce-owner-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await workbench(page)
      .getByRole("button", { name: "Save project to run" })
      .click();
    const run = workbench(page).getByRole("button", {
      name: "Run workforce shed",
    });
    await expect(run).toBeEnabled();
    const saved = (await isolated.persistedState()).projects[0];
    isolated.loseNextResponse(
      `/api/v1/projects/${saved.project.id}/workforce/jobs`,
    );
    await run.click();
    await expect(workbench(page).getByRole("alert")).toBeVisible();
    await expect(run).toBeEnabled();
    await run.click();
    const adopt = workbench(page).getByRole("button", {
      name: "Save capture to scenario",
      exact: true,
    });
    await expect(adopt).toBeEnabled({ timeout: 30000 });
    await adopt.click();
    await expect(workbench(page)).toContainText("Saved with this scenario");
    let state = await isolated.persistedState();
    expect(state.workforceJobs).toHaveLength(1);
    expect(state.workforceJobs[0].attempt).toBe(1);
    const captureHash = state.workforceArtifacts[0].workforce.captureHash;
    const downloadPromise = page.waitForEvent("download");
    await workbench(page)
      .getByRole("button", {
        name: "Download full routing evidence",
        exact: true,
      })
      .click();
    const archive = await downloadPromise;
    expect(archive.suggestedFilename()).toMatch(/\.json$/);
    await workbench(page)
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const projectDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: /Complete project · JSON/ }).click();
    const path = await (await projectDownload).path();
    if (!path) throw new Error("Missing exported project");
    const bytes = await readFile(path);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Import data", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Saved project", exact: true })
      .click();
    await page.locator("input[type=file]").setInputFiles({
      name: "captured-workforce-project.json",
      mimeType: "application/json",
      buffer: bytes,
    });
    await page
      .getByRole("button", { name: "Restore as a copy", exact: true })
      .click();
    await page.getByRole("button", { name: "Economy", exact: true }).click();
    await page.getByRole("button", { name: "Readiness", exact: true }).click();
    await page
      .getByRole("button", { name: "Open workforce workbench", exact: true })
      .click();
    await expect(workbench(page)).toContainText("not verified by this server");
    await workbench(page)
      .getByRole("button", { name: "Save project to run", exact: true })
      .click();
    await expect(
      workbench(page).getByRole("button", { name: "Save project to run" }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await isolated.persistedState()).projects.length)
      .toBe(2);
    state = await isolated.persistedState();
    const copy = state.projects.find(
      (record) => record.project.id !== saved.project.id,
    )!;
    const evidence = copy.project.scenarios.find(
      (scenario) => scenario.id === copy.project.activeScenarioId,
    )!.workforce!;
    expect(evidence.origin).toBe("imported");
    expect(evidence.captureHash).toBe(captureHash);
    expect(copy.project.history[0].after.workforce!.origin).toBe("imported");
    expect(state.workforceJobs).toHaveLength(1);
    await workbench(page)
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish scenario", exact: true })
      .click();
    const link = page.getByRole("textbox", {
      name: "Published link",
      exact: true,
    });
    await expect(link).toBeVisible();
    await isolated.connect(publicContext);
    const publicPage = await publicContext.newPage();
    const privateRequests: string[] = [];
    publicPage.on("request", (request) => {
      if (request.url().includes("/workforce/jobs"))
        privateRequests.push(request.url());
    });
    await publicPage.goto(await link.inputValue());
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await expect(publicPage.getByRole("dialog")).toContainText(
      "not verified by this server",
    );
    await expect(publicPage.getByRole("dialog")).toContainText(
      "Population 25 years and over",
    );
    expect(privateRequests).toEqual([]);
    await publicPage.screenshot({
      path: info.outputPath("workforce-imported-public.png"),
    });
  } finally {
    await page.close();
    await publicContext.close();
    await isolated.close();
  }
});

test("a delayed adoption response cannot replace a newer clean version of the same scenario", async ({
  page,
  baseURL,
}) => {
  const isolated = await createCollaborationApi(baseURL!, {
    workforceFixture: true,
  });
  await isolated.connect(page);
  let release: (() => void) | undefined;
  try {
    await openWorkbench(page);
    await workbench(page)
      .getByRole("button", { name: "Sign in or create a free account" })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("QA Concurrent Planner");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("workforce-concurrent@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-concurrent-workforce-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await workbench(page)
      .getByRole("button", { name: "Save project to run" })
      .click();
    const run = workbench(page).getByRole("button", {
      name: "Run workforce shed",
    });
    await expect(run).toBeEnabled();
    await run.click();
    const adopt = workbench(page).getByRole("button", {
      name: "Save capture to scenario",
      exact: true,
    });
    await expect(adopt).toBeEnabled({ timeout: 30000 });
    const state = await isolated.persistedState();
    const saved = state.projects[0],
      job = state.workforceJobs[0];
    const held = isolated.holdNextResponse(
      `/api/v1/projects/${saved.project.id}/workforce/jobs/${job.id}/adopt`,
    );
    release = held.release;
    await adopt.click();
    await held.committed;
    // Simulate loading a newer server save in the same mounted workbench. Both
    // versions are actual authorized API commits; only delivery timing is controlled.
    await page.evaluate(
      async ({ projectId, scenarioId }) => {
        const apiPath = "/apps/web/src/lib/api.ts",
          workspacePath = "/apps/web/src/lib/workspace.ts",
          linkPath = "/apps/web/src/lib/cloud-workspace.ts";
        const { api } = await import(apiPath),
          { useWorkspace } = await import(
            performance
              .getEntriesByType("resource")
              .find((entry) => new URL(entry.name).pathname === workspacePath)
              ?.name ?? workspacePath
          ),
          { projectRevisionKey } = await import(linkPath);
        const adopted = await api(`/projects/${projectId}`);
        const scenario = adopted.project.scenarios.find(
          (item: { id: string }) => item.id === scenarioId,
        );
        await api(`/projects/${projectId}/scenarios/${scenarioId}/commands`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: adopted.version,
            expectedRevision: scenario.revision,
            command: {
              type: "scenario.details",
              name: "Newer saved version",
              description: "Retain this later server edit.",
            },
          }),
        });
        const fresh = await api(`/projects/${projectId}`);
        await useWorkspace
          .getState()
          .replace(fresh.project, fresh.baseline, fresh.baselineIdentity, {
            projectId,
            organizationId: fresh.organizationId,
            version: fresh.version,
            savedRevision: projectRevisionKey(fresh.project),
          });
        window.dispatchEvent(new Event("focus"));
      },
      {
        projectId: saved.project.id,
        scenarioId: saved.project.activeScenarioId,
      },
    );
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const path = "/apps/web/src/lib/workspace.ts";
          const { useWorkspace } = await import(
            performance
              .getEntriesByType("resource")
              .find((entry) => new URL(entry.name).pathname === path)?.name ??
              path
          );
          const state = useWorkspace.getState();
          return { version: state.cloudLink.version, readOnly: state.readOnly };
        }),
      )
      .toEqual({ version: 3, readOnly: false });
    await expect(workbench(page)).not.toContainText(
      "Your role can inspect captured evidence",
    );
    held.release();
    await expect(workbench(page).getByRole("alert")).toContainText(
      "current draft changed",
    );
    await workbench(page)
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Active scenario" }),
    ).toContainText("Newer saved version");
    const final = await page.evaluate(async () => {
      const path = "/apps/web/src/lib/workspace.ts";
      const { useWorkspace } = await import(
        performance
          .getEntriesByType("resource")
          .find((entry) => new URL(entry.name).pathname === path)?.name ?? path
      );
      const state = useWorkspace.getState();
      return {
        version: state.cloudLink.version,
        revision: state.project.scenarios.find(
          (item: { id: string }) => item.id === state.project.activeScenarioId,
        ).revision,
      };
    });
    expect(final).toEqual({ version: 3, revision: 2 });
    expect((await isolated.persistedState()).projects[0].version).toBe(3);
  } finally {
    release?.();
    await page.close();
    await isolated.close();
  }
});
