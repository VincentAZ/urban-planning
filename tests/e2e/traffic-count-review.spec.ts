import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { TrafficContext } from "../../apps/api/src/traffic/jobs-types";
import { createCollaborationApi } from "./support/collaboration-api";
async function request<T>(
  page: Page,
  path: string,
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ path, body }) => {
      const session = await (await fetch("/api/v1/auth/session")).json();
      const response = await fetch(
        `/api/v1${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": session.csrfToken,
              },
              body: JSON.stringify(body),
            },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(`${response.status} ${JSON.stringify(value)}`);
      return value;
    },
    { path, body },
  );
}

test("grouped real count review and a study-specific baseline check persist without rewriting source observations", async ({
  page,
  baseURL,
}) => {
  test.skip(
    process.env.RUN_TRAFFIC_JOB_QA !== "1",
    "Uses the retained full Phoenix graph and original count pack with an isolated real API.",
  );
  test.setTimeout(180000);
  const isolated = await createCollaborationApi(baseURL!, {
    placeFile: "public/data/zcta-85004-2020.json",
    trafficNativeFixture: true,
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
      .fill("QA Count Reviewer");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("count-reviewer@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-traffic-native-QA-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "QA Count Reviewer",
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
    const saved = (await isolated.persistedState()).projects[0],
      projectId = saved.project.id,
      scenarioId = saved.project.activeScenarioId;
    const base = `/projects/${projectId}/traffic`,
      context = await request<TrafficContext>(
        page,
        `${base}/context?scenarioId=${scenarioId}`,
      );
    expect(context.network!.edges).toHaveLength(22739);
    expect(
      context.capabilities.enabled,
      context.capabilities.reason ?? "",
    ).toBe(true);
    const original = structuredClone(context.initialRequest!);
    const source = original.demand.sources[0];
    const initial = await request<{ configuration: { id: string } }>(
      page,
      `${base}/configurations`,
      {
        scenarioId,
        expectedVersion: saved.version,
        expectedRevision: saved.project.scenarios.find(
          (s) => s.id === scenarioId,
        )!.revision,
        expectedConfigurationId: null,
        idempotencyKey: "count-review-initial-config",
        request: original,
        sourceDeclarations: [
          {
            sourceId: source.id,
            name: source.name,
            url: source.url,
            vintage: source.vintage,
            license: source.license,
            privateUseConfirmed: true,
            publicRedistribution: false,
          },
        ],
        uploadBindings: [],
        mappingReviews: [],
        scopeAcknowledged: true,
      },
    );
    await page
      .getByRole("button", { name: "Mobility", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Open traffic workbench", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "See how the streets respond.",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("tab", { name: "Counts & demand", exact: true })
      .click();
    const countPanel = dialog.getByRole("tabpanel", {
      name: "Counts & demand",
      exact: true,
    });
    await expect(
      countPanel.getByLabel("Traffic analysis date", { exact: true }),
    ).toHaveValue("2025-10-02");
    await countPanel
      .getByRole("textbox", { name: "Find a count station", exact: true })
      .fill("0F0085");
    const series = countPanel.locator(".traffic-count-series").filter({
      has: page
        .locator("summary")
        .filter({ hasText: /Direction 3 · lane 1 ·/ }),
    });
    await series.locator("summary").click();
    await series.getByRole("button", { name: /07:00:00–08:00:00/ }).click();
    await countPanel
      .getByRole("combobox", { name: "Count network target", exact: true })
      .selectOption("edge");
    await countPanel
      .getByRole("textbox", { name: "Find a count target", exact: true })
      .fill("437360250");
    await countPanel
      .getByRole("combobox", { name: "Matched directed edge", exact: true })
      .selectOption("437360250");
    await countPanel
      .getByLabel("Count location along directed edge (%)", { exact: true })
      .fill("50");
    await countPanel
      .getByRole("combobox", { name: "Reviewed lane coverage", exact: true })
      .selectOption("specific");
    await countPanel
      .getByRole("checkbox", { name: "437360250_0", exact: true })
      .check();
    // Coverage remains unknown. This exercises review mechanics without inventing a class crosswalk.
    await countPanel
      .getByRole("checkbox", {
        name: /I reviewed the class coverage interpretation: coverage remains unknown/,
      })
      .check();
    await countPanel
      .getByRole("checkbox", {
        name: /I reviewed the station direction, measurement position/,
      })
      .check();
    await countPanel
      .getByRole("combobox", { name: "Series mapping scope", exact: true })
      .selectOption("all");
    await countPanel
      .getByRole("textbox", { name: "Series mapping review note", exact: true })
      .fill(
        "Authored isolated QA target/position to exercise grouped review; no verified detector position or class coverage is asserted. Original source values remain unchanged.",
      );
    await countPanel
      .getByRole("button", { name: "Preview series mapping", exact: true })
      .click();
    await expect(
      countPanel.getByText("24 records will receive this mapping.", {
        exact: true,
      }),
    ).toBeVisible();
    await countPanel
      .getByText("Exact affected records (24)", { exact: true })
      .click();
    await countPanel
      .getByRole("checkbox", {
        name: /I reviewed these exact affected records/,
      })
      .check();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-series-preview.png"),
    });
    await countPanel
      .getByRole("button", {
        name: "Apply mapping to this series",
        exact: true,
      })
      .click();
    await countPanel
      .getByRole("button", { name: "Show count mapping map", exact: true })
      .click();
    await expect(countPanel.locator(".traffic-map-canvas")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await countPanel.locator(".traffic-map-canvas").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-count-map.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await countPanel
      .getByRole("button", { name: "Fit count and direction", exact: true })
      .click();
    await countPanel.locator(".traffic-map-canvas").scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "mobile-count-map.png"),
    });
    expect(
      await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog
      .getByRole("button", {
        name: "Add baseline count-check plan",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("combobox", {
        name: "Role for 0F0085 direction 3",
        exact: true,
      })
      .selectOption("calibration");
    await dialog
      .getByRole("combobox", {
        name: "Role for 0F0133 direction 3",
        exact: true,
      })
      .selectOption("holdout");
    for (const [name, value] of [
      ["Maximum GEH", "5"],
      ["Maximum absolute hourly error", "20"],
      ["Maximum relative error (%)", "15"],
      ["Required passing observations (%)", "85"],
      ["Minimum calibration observations", "1"],
      ["Minimum held-out observations", "1"],
    ])
      await dialog.getByLabel(name, { exact: true }).fill(value);
    const rationale =
      "Isolated procedural QA: authored tolerances and user-declared groups. Unmapped and class-unknown source rows remain incomplete; no station independence, vehicle composition or calibrated whole-ZIP accuracy is asserted.";
    await dialog
      .getByRole("textbox", {
        name: "Count-check study rationale",
        exact: true,
      })
      .fill(rationale);
    await dialog
      .getByRole("button", { name: "Add criteria source", exact: true })
      .click();
    await dialog
      .getByLabel("Criteria source name", { exact: true })
      .fill("Authored QA count-check protocol");
    await dialog
      .getByLabel("Criteria source vintage", { exact: true })
      .fill("2026-11-06");
    await dialog
      .getByLabel("Criteria source license or permission", { exact: true })
      .fill("Authored isolated test protocol; private QA use only.");
    await dialog
      .locator(".traffic-calibration")
      .getByRole("checkbox", { name: /I have permission to retain/ })
      .check();
    await dialog
      .getByRole("button", {
        name: "Add criteria citation to review",
        exact: true,
      })
      .click();
    await dialog
      .locator("#traffic-count-validation h3")
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-count-check-plan.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.locator(".traffic-validation-groups").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "mobile-count-check-groups.png"),
    });
    expect(
      await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await dialog.getByLabel("Maximum GEH", { exact: true }).fill("bad");
    await expect(
      dialog.getByRole("button", {
        name: "Save traffic configuration",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(dialog.getByLabel("Maximum GEH", { exact: true })).toHaveValue(
      "bad",
    );
    await dialog.getByLabel("Maximum GEH", { exact: true }).fill("5");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog
      .getByRole("button", { name: "Save traffic configuration", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", {
        name: "Save traffic configuration",
        exact: true,
      }),
    ).toBeDisabled();
    await expect
      .poll(
        async () =>
          (await isolated.persistedState()).trafficConfigs.at(-1)?.request
            .calibrationPlan?.description,
      )
      .toBe(rationale);
    await expect(
      dialog.getByText("Recorded inputs", { exact: true }),
    ).toBeVisible();
    const persisted = await isolated.persistedState();
    const configuration = persisted.trafficConfigs.at(-1)!;
    expect(configuration.id).not.toBe(initial.configuration.id);
    expect(configuration.request.calibrationPlan).toMatchObject({
      description: rationale,
      criteria: {
        gehMaximum: 5,
        relativeErrorMaximum: 0.15,
        requiredPassingFraction: 0.85,
      },
    });
    expect(
      configuration.request.calibrationPlan!.calibrationCountIds,
    ).toHaveLength(5);
    expect(configuration.request.calibrationPlan!.holdoutCountIds).toHaveLength(
      6,
    );
    const observation = (
      count: (typeof original.countPack.counts)[number],
    ) => ({
      id: count.id,
      stationId: count.stationId,
      position: count.position,
      date: count.date,
      timeZone: count.timeZone,
      utcOffsetMinutes: count.utcOffsetMinutes,
      beginSeconds: count.beginSeconds,
      endSeconds: count.endSeconds,
      value: count.value,
      status: count.status,
      kind: count.kind,
      raw: count.raw,
      sourceIds: count.sourceIds,
    });
    expect(configuration.request.countPack.counts.map(observation)).toEqual(
      original.countPack.counts.map(observation),
    );
    const citation = configuration.request.countPack.sources.find(
      (s) => s.name === "Authored QA count-check protocol",
    )!;
    expect(citation.rights?.publicRedistribution).toBe(false);
    expect(configuration.request.calibrationPlan!.sourceIds).toEqual([
      citation.id,
    ]);
    expect(
      configuration.request.countPack.counts.filter((c) => c.target),
    ).toHaveLength(24);
    expect(
      configuration.request.countPack.counts.every(
        (c) => c.vehicleClasses === null,
      ),
    ).toBe(true);
    for (const count of configuration.request.countPack.counts.filter(
      (c) => c.target,
    )) {
      expect(count.target).toEqual({
        kind: "edge",
        edgeId: "437360250",
        positionFraction: 0.5,
        laneIds: ["437360250_0"],
      });
      expect(count.mapping?.networkFileSha256).toBe(
        context.network!.manifest.networkFileSha256,
      );
      expect(count.mapping?.reviewedBy).toBe(configuration.userId);
    }
    expect(persisted.trafficJobs).toHaveLength(0);
    expect(persisted.budget.policy.monthlyLimitCents).toBe(30000);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    // Stop browser polling and drain real forwarded requests before restarting the isolated API.
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "wait" });
    await isolated.restart();
    await isolated.connect(page);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Mobility", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Open traffic workbench", exact: true })
      .click();
    await dialog
      .getByRole("tab", { name: "Counts & demand", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Count-check study rationale", { exact: true }),
    ).toHaveValue(rationale);
    await expect(
      dialog.getByRole("combobox", {
        name: "Role for 0F0085 direction 3",
        exact: true,
      }),
    ).toHaveValue("calibration");
    await expect(
      dialog.getByRole("combobox", {
        name: "Role for 0F0133 direction 3",
        exact: true,
      }),
    ).toHaveValue("holdout");
    await expect(
      dialog.getByLabel("Required passing observations (%)", { exact: true }),
    ).toHaveValue("85");
    await dialog
      .locator("#traffic-count-validation h3")
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-reopened-count-plan.png"),
    });
    expect(errors).toEqual([]);
    await writeFile(
      join(isolated.evidenceDirectory, "count-review-verification.json"),
      JSON.stringify(
        {
          status: "passed",
          configurationId: configuration.id,
          originalRows: original.countPack.counts.length,
          originalObservationHash: createHash("sha256")
            .update(JSON.stringify(original.countPack.counts.map(observation)))
            .digest("hex"),
          selectedCalibration: 5,
          selectedHoldout: 6,
          nativeRuns: 0,
          calibrationClaim: false,
          criteriaSourcePrivate: true,
          apiRestartReopen: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!page.isClosed()) {
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
    }
    await isolated.close();
  }
});
