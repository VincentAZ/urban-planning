import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  TrafficContext,
  TrafficJobResult,
} from "../../apps/api/src/traffic/jobs-types";
import type { TrafficExperimentRequest } from "../../apps/api/src/traffic/experiment";
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
const workbench = (page: Page) =>
  page.getByRole("dialog", {
    name: "See how the streets respond.",
    exact: true,
  });
test("reviewed streets, signal timing and an incomplete count-check plan persist through native SUMO, adoption and public summary", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    process.env.RUN_TRAFFIC_JOB_QA !== "1",
    "Opt in with RUN_TRAFFIC_JOB_QA=1; requires retained full 85004 graph and pinned offline SUMO.",
  );
  test.setTimeout(300000);
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
    // Author the planning proposal through the real street editor. The signal is
    // deliberately outside the supported native controls and must remain omitted.
    await page
      .getByRole("button", { name: "Mobility", exact: true })
      .first()
      .click();
    await page
      .getByRole("textbox", { name: "Find a street", exact: true })
      .fill("osm-way-437360250");
    await page
      .locator('[aria-label="Streets in this scenario"]')
      .getByRole("button", { name: /osm-way-437360250/ })
      .click();
    await page
      .getByRole("spinbutton", { name: "Travel lanes", exact: true })
      .fill("4");
    await page
      .getByRole("spinbutton", { name: "Speed limit", exact: true })
      .fill("35");
    await page
      .getByRole("checkbox", { name: "Traffic signal", exact: true })
      .check();
    await page
      .getByRole("button", { name: "Apply street changes", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply street changes", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Save your work", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Your name", exact: true })
      .fill("QA Traffic Planner");
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill("traffic-planner@urban-planning.test");
    await page
      .getByLabel(/^Password/)
      .fill("Isolated-traffic-native-QA-account-2026");
    await page
      .getByRole("button", { name: "Create free account", exact: true })
      .click();
    await expect(page.locator(".account-button")).toContainText(
      "QA Traffic Planner",
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
    const pilot = JSON.parse(
      await readFile(
        ".local/qa/traffic/real-85004-pilot-stable-turns/experiment.json",
        "utf8",
      ),
    );
    const input = structuredClone(context.initialRequest!),
      source = input.demand.sources[0];
    // Setup uses the real HTTP review endpoint. Only explicit authored OD/route assumptions are copied;
    // original FHWA rows remain unmapped and unknown-class. No native/API output is substituted.
    input.demand.rows = pilot.request.demand.rows.map(
      (row: Record<string, unknown>) => ({ ...row, sourceIds: [source.id] }),
    );
    input.demand.candidateRoutes = pilot.request.demand.candidateRoutes.map(
      (route: Record<string, unknown>) => ({
        ...route,
        sourceIds: [source.id],
      }),
    );
    // Independent authored signal demand crosses an actual retained controlled movement.
    // Keep 700 total vehicles: 100 warm-up + 500 freeway + 100 signal measurement trips.
    input.demand.rows.find((row) => row.id === "measurement")!.vehicles = 500;
    input.demand.rows.push({
      ...input.demand.rows.find((row) => row.id === "measurement")!,
      id: "signal-measurement",
      originEdge: "531234413#1",
      destinationEdge: "325641365#0",
      vehicles: 100,
    });
    input.demand.candidateRoutes.push({
      id: "signal-measurement-route",
      odId: "signal-measurement",
      edges: ["531234413#1", "325641365#0"],
      weight: 1,
      sourceIds: [source.id],
    });
    expect(
      context.network!.connections.some(
        (movement) =>
          movement.signalId === "1256304741" &&
          movement.fromEdge === "531234413#1" &&
          movement.toEdge === "325641365#0",
      ),
    ).toBe(true);
    source.description =
      "Authored QA demand: 100 warm-up freeway trips, 500 measurement freeway trips and 100 measurement trips through native signal 1256304741. Not observed demand or calibrated traffic; no class-share inference.";
    source.license =
      "Authored QA scenario assumptions, explicitly permitted for this local public snapshot.";
    input.overlays = [];
    input.seed = 42;
    await request(page, `${base}/configurations`, {
      scenarioId,
      expectedVersion: saved.version,
      expectedRevision: saved.project.scenarios.find(
        (s) => s.id === scenarioId,
      )!.revision,
      expectedConfigurationId: null,
      idempotencyKey: "native-browser-initial-config",
      request: input,
      sourceDeclarations: [
        {
          sourceId: source.id,
          name: source.name,
          url: source.url,
          vintage: source.vintage,
          license: source.license,
          privateUseConfirmed: true,
          publicRedistribution: true,
        },
      ],
      uploadBindings: [],
      mappingReviews: [],
      scopeAcknowledged: true,
    });
    await page
      .getByRole("button", { name: "Mobility", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Open traffic workbench", exact: true })
      .click();
    const dialog = workbench(page);
    await expect(dialog).toBeVisible();
    await expect(page.locator(".traffic-map-canvas")).toHaveAttribute(
      "aria-busy",
      "false",
      { timeout: 45000 },
    );
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-network.png"),
    });
    await dialog
      .getByRole("button", { name: "Planning street changes", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Review this street", exact: true })
      .click();
    await dialog
      .getByRole("checkbox", { name: "Travel lanes", exact: true })
      .check();
    await dialog.getByRole("checkbox", { name: "Speed", exact: true }).check();
    await dialog
      .getByRole("button", {
        name: "Add edge 437360250 to with-road",
        exact: true,
      })
      .click();
    await dialog.getByLabel("With direction lanes", { exact: true }).fill("4");
    await dialog
      .getByRole("combobox", { name: "Reviewed street extent", exact: true })
      .selectOption("full-road");
    await dialog
      .getByRole("checkbox", {
        name: /^I reviewed the full native edge extent/,
      })
      .check();
    await dialog
      .getByRole("textbox", { name: "Correspondence rationale", exact: true })
      .fill(
        "Local QA review: unchanged eastbound planning centerline and native edge share source way 437360250. The entire 641.8 m native edge is affected, including its continuation beyond the approximately 129 m planning segment. This authored test applies four directional lanes and 35 mph; the proposed signal remains unsupported. No observed demand or forecast accuracy is asserted.",
      );
    await dialog
      .getByRole("button", { name: "Fit reviewed directions", exact: true })
      .click();
    await expect(page.locator(".traffic-map-canvas")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-planning-extent.png"),
    });
    await dialog
      .getByRole("button", { name: "Check correspondence", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Confirm reviewed link", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", {
        name: "Link confirmed in draft",
        exact: true,
      }),
    ).toBeDisabled();
    const planningSources = dialog.locator(".traffic-planning-source");
    await expect(planningSources).toHaveCount(2);
    for (const permission of await planningSources.all()) {
      await permission
        .getByRole("checkbox", {
          name: /^I have permission to process and retain/,
        })
        .check();
      await permission
        .getByRole("checkbox", {
          name: /^This source permits public redistribution/,
        })
        .check();
    }
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-planning-review.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByRole("heading", {
        name: "Make the connection explicit.",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "mobile-planning-review.png"),
    });
    await dialog
      .getByRole("heading", { name: "Native control preview", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "mobile-planning-controls.png"),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog
      .getByRole("button", { name: "Signal timing", exact: true })
      .click();
    await dialog
      .getByRole("textbox", { name: "Find a signal program", exact: true })
      .fill("1256304741");
    await dialog.getByRole("button", { name: /^Signal 1256304741/ }).click();
    await expect(dialog.locator(".traffic-map-canvas")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await dialog
      .getByRole("button", { name: "Fit signal extent", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Edit signal timing", exact: true })
      .click();
    await dialog
      .getByLabel("Target cycle (seconds)", { exact: true })
      .fill("102");
    await dialog
      .getByRole("button", { name: "Redistribute green time", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Phase 1 duration (seconds)", { exact: true }),
    ).toHaveValue("48");
    await expect(
      dialog.getByLabel("Phase 3 duration (seconds)", { exact: true }),
    ).toHaveValue("48");
    await dialog
      .getByLabel("Phase 1 duration (seconds)", { exact: true })
      .fill("54");
    await dialog
      .getByLabel("Phase 3 duration (seconds)", { exact: true })
      .fill("42");
    await expect(
      dialog.getByLabel("Target cycle (seconds)", { exact: true }),
    ).toHaveValue("102");
    await expect(
      dialog.getByLabel("Phase 2 duration (seconds)", { exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByLabel("Phase 2 duration (seconds)", { exact: true }),
    ).toHaveValue("3");
    await expect(
      dialog.getByLabel("Phase 4 duration (seconds)", { exact: true }),
    ).toBeDisabled();
    await dialog
      .getByLabel("Signal offset (seconds)", { exact: true })
      .fill("5");
    await dialog
      .getByRole("textbox", { name: "Signal timing rationale", exact: true })
      .fill(
        "Authored local QA timing: extend the first green from 42 to 54 seconds and set a 5 second offset. Retain both 3 second yellow phases and the 42 second opposing green. The 100 explicit trips cross this selected native controller. No observed timing, calibration or planning-road signal mapping is claimed.",
      );
    await dialog
      .getByRole("heading", { name: /Signal 1256304741/ })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-signal-timing.png"),
    });
    await dialog
      .getByLabel("Target cycle (seconds)", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-signal-controls.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByLabel("Phase 1 duration (seconds)", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "mobile-signal-timing.png"),
    });
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog
      .getByRole("tab", { name: "Counts & demand", exact: true })
      .click();
    await dialog
      .getByLabel("Traffic random seed", { exact: true })
      .fill("23061");
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
    await dialog
      .getByLabel("Count-check study rationale", { exact: true })
      .fill(
        "Authored QA criteria for baseline count-check persistence. Original observations have unknown vehicle-class coverage and no network mapping; expected result is incomplete. User-declared held-out groups do not establish independent validation.",
      );
    await dialog
      .getByRole("button", { name: "Add criteria source", exact: true })
      .click();
    await dialog
      .getByLabel("Criteria source name", { exact: true })
      .fill("Authored QA baseline count-check protocol");
    await dialog
      .getByLabel("Criteria source vintage", { exact: true })
      .fill("2026-11-06");
    await dialog
      .getByLabel("Criteria source license or permission", { exact: true })
      .fill(
        "Authored QA protocol, permitted for this local public snapshot and exports.",
      );
    await dialog
      .locator(".traffic-calibration")
      .getByRole("checkbox", { name: /^I have permission to retain/ })
      .check();
    await dialog
      .locator(".traffic-calibration")
      .getByRole("checkbox", {
        name: /^This source permits public redistribution/,
      })
      .check();
    await dialog
      .getByRole("button", {
        name: "Add criteria citation to review",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("button", { name: "Save traffic configuration", exact: true })
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
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-reviewed-inputs.png"),
    });
    await dialog
      .getByRole("button", { name: "Run paired traffic analysis", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const state = await isolated.persistedState();
          return state.trafficJobs.at(-1)?.status;
        },
        { timeout: 180000, intervals: [1500, 2500, 5000] },
      )
      .toBe("completed");
    await dialog.getByRole("tab", { name: "Results", exact: true }).click();
    await expect(
      dialog.getByRole("button", {
        name: "Save traffic capture to scenario",
        exact: true,
      }),
    ).toBeEnabled({ timeout: 30000 });
    const state = await isolated.persistedState(),
      job = state.trafficJobs.at(-1)!,
      result = await request<TrafficJobResult>(
        page,
        `${base}/jobs/${job.id}/result`,
      );
    expect(result.traffic.capture.calibration).toMatchObject({
      status: "incomplete",
      scope: "interval-count-fit",
      calibration: {
        requested: 5,
        evaluated: 0,
        unavailable: 5,
        status: "incomplete",
      },
      holdout: {
        requested: 6,
        evaluated: 0,
        unavailable: 6,
        status: "incomplete",
      },
    });
    expect(result.experiment.calibration?.rows).toHaveLength(11);
    expect(
      result.experiment.calibration?.rows.every(
        (row) => row.passed === null && row.reason,
      ),
    ).toBe(true);
    expect(
      result.experiment.request.countPack.counts.every(
        (count) => count.target === null && count.vehicleClasses === null,
      ),
    ).toBe(true);
    expect(result.traffic.capture.proposal.signalTimings).toHaveLength(1);
    const timing = result.traffic.capture.proposal.signalTimings![0];
    expect(timing.control).toMatchObject({
      signalId: "1256304741",
      programId: "0",
      phaseDurationsSeconds: [54, 3, 42, 3],
      offsetSeconds: 5,
    });
    expect(
      timing.baseline.phases.map((phase) => phase.durationSeconds),
    ).toEqual([42, 3, 42, 3]);
    expect(timing.proposal.phases.map((phase) => phase.state)).toEqual(
      timing.baseline.phases.map((phase) => phase.state),
    );
    expect(timing.baseline.quality).toBe("inferred");
    expect(timing.proposal.quality).toBe("authored");
    const signalRowIndex = [...result.experiment.request.demand.rows]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .findIndex((row) => row.id === "signal-measurement");
    expect(signalRowIndex).toBeGreaterThanOrEqual(0);
    const signalDurations = (["baseline", "proposal"] as const).map((side) =>
      result.experiment[side].trips
        .filter((trip) => trip.id.startsWith(`traffic-${signalRowIndex}-`))
        .sort((a, b) => a.id.localeCompare(b.id, "en"))
        .map((trip) => trip.durationSeconds),
    );
    expect(signalDurations[0]).toHaveLength(100);
    expect(signalDurations[1]).toHaveLength(100);
    expect(signalDurations[1]).not.toEqual(signalDurations[0]);
    expect(result.experiment.request.planningRoads?.reviews).toHaveLength(1);
    expect(result.experiment.request.planningRoads?.reviews[0]).toMatchObject({
      roadId: "osm-way-437360250",
      properties: ["lanes", "speed"],
      extent: "full-road",
      nativeExtensionAcknowledged: true,
      overlays: [{ edgeId: "437360250", lanes: 4, speedMps: 35 * 0.44704 }],
    });
    expect(result.experiment.request.planningRoads?.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roadId: "osm-way-437360250",
          property: "signal",
          reason: "unsupported",
        }),
      ]),
    );
    expect(
      result.traffic.capture.proposal.planningRoadMapping.reviewedLinks,
    ).toHaveLength(1);
    expect(result.experiment.request.countPack.counts).toHaveLength(456);
    for (const side of ["baseline", "proposal"] as const)
      expect(result.experiment[side].diagnostics).toMatchObject({
        requested: 700,
        loaded: 700,
        inserted: 700,
        arrived: 700,
        running: 0,
        waiting: 0,
        discarded: 0,
        teleports: 0,
        collisions: 0,
        routeErrors: 0,
      });
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-result.png"),
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
    await dialog
      .getByRole("button", {
        name: "List retained evidence files",
        exact: true,
      })
      .click();
    await expect(dialog.locator(".traffic-file-list")).toContainText(
      "experiment.json",
    );
    const pending = page.waitForEvent("download");
    await dialog
      .locator(".traffic-file-list li")
      .filter({ hasText: "experiment.json" })
      .getByRole("button")
      .click();
    const downloaded = await pending,
      downloadPath = await downloaded.path();
    expect(downloadPath).toBeTruthy();
    const bytes = await readFile(downloadPath!),
      manifest = await request<{
        files: { name: string; sha256: string; bytes: number }[];
      }>(page, `${base}/jobs/${job.id}/files`);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      manifest.files.find((f) => f.name === "experiment.json")!.sha256,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "mobile-result.png"),
    });
    expect(
      await dialog.evaluate((e) => e.scrollWidth - e.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await workbench(page)
      .getByRole("tab", { name: "Results", exact: true })
      .click();
    await expect(
      workbench(page).getByRole("heading", {
        name: "Saved with this scenario",
        exact: true,
      }),
    ).toBeVisible({ timeout: 45000 });
    const current = (await isolated.persistedState()).projects[0],
      scenario = current.project.scenarios.find((s) => s.id === scenarioId)!;
    expect(scenario.traffic?.captureHash).toBe(result.traffic.captureHash);
    expect(current.project.history.at(-1)?.command.type).toBe(
      "scenario.traffic",
    );
    const published = await request<{ url: string }>(
      page,
      `/projects/${projectId}/publish`,
      {
        scenarioId,
        expectedRevision: scenario.revision,
        feedbackEnabled: false,
      },
    );
    const visitor = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await isolated.connect(visitor);
    const publicPage = await visitor.newPage();
    await publicPage.goto(`${baseURL}${published.url}`);
    await publicPage
      .getByRole("button", { name: "Read the frozen assumptions", exact: true })
      .click();
    await expect(
      publicPage.getByText("Captured street response", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await publicPage
      .getByText("Captured signal timing (1)", { exact: true })
      .click();
    await expect(
      publicPage.getByRole("heading", {
        name: "Signal 1256304741 · program 0",
        exact: true,
      }),
    ).toBeVisible();
    await expect(publicPage.locator(".traffic-signal-evidence")).toContainText(
      "90 → 102 seconds",
    );
    const privateStatus = await publicPage.evaluate(
      async (path) => (await fetch(path)).status,
      `/api/v1${base}/jobs/${job.id}/files`,
    );
    expect(privateStatus).toBe(401);
    await publicPage.screenshot({
      path: join(isolated.evidenceDirectory, "public-summary.png"),
      fullPage: true,
    });
    await visitor.close();
    // A same-ID citation change leaves physical road values unchanged. It must
    // still invalidate human review and permission attestations in the browser.
    await workbench(page)
      .getByRole("button", { name: "Close", exact: true })
      .click();
    const beforeCitationEdit = (await isolated.persistedState()).projects[0];
    const beforeCitationScenario = beforeCitationEdit.project.scenarios.find(
      (item) => item.id === scenarioId,
    )!;
    const originalPlanningSource = beforeCitationScenario.sources!.find(
      (item) => item.id === "user-road-proposal",
    )!;
    const revisedPlanningSource = {
      ...originalPlanningSource,
      name: "QA revised planning citation",
      license:
        "Revised authored QA citation; public permission must be reviewed separately.",
    };
    await request(
      page,
      `/projects/${projectId}/scenarios/${scenarioId}/commands`,
      {
        expectedVersion: beforeCitationEdit.version,
        expectedRevision: beforeCitationScenario.revision,
        command: {
          type: "road.upsert",
          road: beforeCitationScenario.roadEdits["osm-way-437360250"],
          source: revisedPlanningSource,
        },
      },
    );
    await page
      .getByRole("button", { name: "Reopen saved version", exact: true })
      .click();
    await expect(
      page.getByText("The latest saved version is reopened.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Mobility", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Open traffic workbench", exact: true })
      .click();
    const reopened = workbench(page);
    await reopened
      .getByRole("button", { name: "Planning street changes", exact: true })
      .click();
    await expect(
      reopened.getByRole("button", {
        name: "Run paired traffic analysis",
        exact: true,
      }),
    ).toBeDisabled();
    const revisedCitation = reopened
      .locator(".traffic-planning-source")
      .filter({ hasText: revisedPlanningSource.name });
    await expect(revisedCitation).toBeVisible();
    const privatePermission = revisedCitation.getByRole("checkbox", {
      name: /^I have permission to process and retain/,
    });
    const publicPermission = revisedCitation.getByRole("checkbox", {
      name: /^This source permits public redistribution/,
    });
    await expect(privatePermission).not.toBeChecked();
    await expect(publicPermission).not.toBeChecked();
    await reopened
      .getByRole("button", { name: "Check correspondence", exact: true })
      .click();
    await reopened
      .getByRole("button", { name: "Confirm reviewed link", exact: true })
      .click();
    await privatePermission.check();
    await expect(publicPermission).not.toBeChecked();
    const configurationAcknowledgement = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1${base}/configurations` &&
        response.request().method() === "POST" &&
        response.status() === 201,
    );
    await reopened
      .getByRole("button", { name: "Save traffic configuration", exact: true })
      .click();
    const savedConfiguration = (await (
      await configurationAcknowledgement
    ).json()) as { configuration: { id: string } };
    await expect(
      reopened.getByRole("button", {
        name: "Save traffic configuration",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      reopened.getByRole("button", {
        name: "Run paired traffic analysis",
        exact: true,
      }),
    ).toBeEnabled();
    const revisedConfiguration = (
      await isolated.persistedState()
    ).trafficConfigs.find(
      (item) => item.id === savedConfiguration.configuration.id,
    )!;
    expect(revisedConfiguration.request.planningRoads?.sources).toEqual(
      expect.arrayContaining([revisedPlanningSource]),
    );
    expect(
      revisedConfiguration.request.planningRoads?.sourceDeclarations.find(
        (item) => item.sourceId === revisedPlanningSource.id,
      )?.publicRedistribution,
    ).toBe(false);
    await page.screenshot({
      path: join(isolated.evidenceDirectory, "desktop-revised-citation.png"),
    });
    expect(errors).toEqual([]);
    await writeFile(
      join(isolated.evidenceDirectory, "verification.json"),
      JSON.stringify(
        {
          status: "passed",
          projectId,
          jobId: job.id,
          configurationId: job.configurationId,
          captureHash: result.traffic.captureHash,
          archive: job.result!.archive,
          diagnostics: {
            baseline: result.experiment.baseline.diagnostics,
            proposal: result.experiment.proposal.diagnostics,
          },
          resources: result.experiment.resources,
          calibration: result.experiment.calibration,
          signalTiming: {
            control: timing.control,
            baselinePhases: timing.baseline.phases,
            proposalPhases: timing.proposal.phases,
            completedAuthoredSignalTrips: signalDurations.map(
              (values) => values.length,
            ),
            tripDurationsChanged: true,
          },
          privateArchiveAnonymousStatus: privateStatus,
          monthlyLimitCents: state.budget.policy.monthlyLimitCents,
          sourceChangeReview: {
            passed: true,
            configurationId: revisedConfiguration.id,
            publicPermissionCarriedForward: false,
          },
          errors,
          notes: [
            "Real HTTP and native SUMO on the complete retained 85004 graph. Explicit authored OD; original counts remain unreviewed.",
            "No calibrated forecast or production billing claim. No main development state or source data changed.",
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await isolated.close();
  }
});
