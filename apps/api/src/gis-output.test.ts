import { enableReviewedBudgetForFixture } from "./budget-test-fixture.js";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject } from "@urban/models";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { FileStore, authorize } from "./store.js";
import { GisJobService } from "./gis-jobs.js";
import { FixtureGisRuntime } from "./gis-jobs-fixture.js";
describe("GIS output retention", () => {
  it("removes a newly generated unreferenced archive after cancellation while retaining the frozen input and consumed attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "gis-output-")),
      store = new FileStore(),
      project = createProject(workforcePlaceFixture),
      runtime = new FixtureGisRuntime();
    const service = new GisJobService(store, {
      enabled: true,
      runtime,
      archiveDirectory: join(root, "archive"),
      automaticWorker: false,
      capacity: {
        mode: "fixed-capacity",
        environment: "local-development",
        statement: "Existing isolated test capacity; no external charge.",
      },
    });
    try {
      await store.transaction((s) => {
        enableReviewedBudgetForFixture(s.budget);
        s.users.push({
          id: "user",
          name: "User",
          email: "user@fixture.test",
          createdAt: "2026-11-06",
        });
        s.organizations.push({
          id: "org",
          name: "Org",
          createdAt: "2026-11-06",
        });
        s.memberships.push({
          userId: "user",
          organizationId: "org",
          role: "owner",
        });
        s.sessions.push({
          hash: "session",
          csrfToken: "csrf",
          userId: "user",
          organizationId: "org",
          expiresAt: "2099-01-01T00:00:00Z",
        });
        s.projects.push({
          project,
          baseline: workforcePlaceFixture,
          version: 1,
          organizationId: "org",
          createdBy: "user",
          createdAt: "2026-11-06",
        });
      });
      const auth = (s: Parameters<typeof authorize>[0]) =>
        authorize(s, "session");
      const job = await service.enqueue(
        project.id,
        "export-shapefile",
        {
          scenarioId: project.activeScenarioId,
          expectedVersion: 1,
          expectedRevision: 0,
          idempotencyKey: "cancel-late-output",
        },
        {},
        auth,
        "session",
      );
      const before = (await readdir(join(root, "archive"))).sort();
      expect(before).toHaveLength(1);
      runtime.exportShapefile = async () => {
        const current = await store.read((s) => s.gisJobHeaders[0], {
          gisJobHeaders: { where: [{ id: job.id }] },
        });
        await service.cancel(
          project.id,
          job.id,
          current.version,
          auth,
          "session",
        );
        const zip = Buffer.from("synthetic completed converter output");
        return {
          zip,
          sha256: createHash("sha256").update(zip).digest("hex"),
          manifest: {},
        };
      };
      await service.runOne();
      expect((await readdir(join(root, "archive"))).sort()).toEqual(before);
      const after = await store.read((s) => s.gisJobs[0], {
        gisJobs: { where: [{ id: job.id }] },
      });
      expect(after.status).toBe("cancelled");
      expect(after.attempts).toHaveLength(1);
      expect(after.attempts[0].outcome).toBe("cancelled");
      expect(after.result).toBeUndefined();
    } finally {
      await service.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
