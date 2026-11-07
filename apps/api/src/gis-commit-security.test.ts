import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  applyCommand,
  baselineIdentity,
  buildingGeometry,
  parcelPreset,
  projectWithImportVersion,
  type Command,
  type Project,
  type Source,
} from "@urban/core";
import { buildingPreset, createProject } from "@urban/models";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { emptyState, type ImportRecord, type ProjectRecord } from "./store.js";
import { encodeRecord } from "./storage-core.js";
import { tokenHash } from "./security.js";

// Synthetic persisted-preview fixtures; this suite exercises actual restricted SQL,
// not the converter or the already-covered job completion path.
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "prepared import commit evidence",
  () => {
    const at = "2026-11-06T00:00:00Z";
    const sessionHash = tokenHash("gis-commit-fixture-session");
    const source: Source = {
      id: "import-source",
      name: "Synthetic reviewed layer",
      url: "",
      vintage: "test",
      license: "Test only",
      kind: "user-supplied",
    };
    let fixture: Awaited<ReturnType<typeof createPostgresSecurityFixture>>;
    let web: pg.Pool;
    let record: ProjectRecord;
    let staged: ImportRecord[];
    beforeAll(async () => {
      const place = structuredClone(workforcePlaceFixture);
      const existingBuilding = {
        ...buildingPreset("office", [-112, 33]),
        id: "existing-building",
      };
      const existingParcel = {
        ...parcelPreset(buildingGeometry(existingBuilding)),
        id: "existing-parcel",
      };
      place.buildings = [existingBuilding];
      place.parcels = [existingParcel];
      const project = createProject(place);
      project.id = "commit-project";
      project.scenarios[1].sources = [
        { ...source, id: "retained-source", name: "Retained attribution" },
        { ...source, name: "Earlier attribution replaced by exact upload" },
      ];
      record = {
        project,
        baseline: place,
        organizationId: "commit-org",
        version: 1,
        createdBy: "commit-owner",
        createdAt: at,
      };
      const identity = await baselineIdentity(place);
      staged = (
        [
          "building-append",
          "building-match",
          "parcel-append",
          "parcel-match",
        ] as const
      ).map((id): ImportRecord => {
        const isParcel = id.startsWith("parcel"),
          match = id.endsWith("match");
        const base = {
          id,
          projectId: project.id,
          organizationId: record.organizationId,
          createdBy: record.createdBy,
          createdAt: at,
          expiresAt: "2099-01-01T00:00:00Z",
          source,
          warnings: [],
          prepared: {
            mode: match ? ("match" as const) : ("append" as const),
            preview: {
              jobId: `${id}-job`,
              uploadId: `${id}-upload`,
              projectId: project.id,
              scenarioId: project.activeScenarioId,
              expectedVersion: 1,
              expectedRevision: 0,
              baselineIdentity: identity,
              previewHash: "a".repeat(64),
              featureCount: 1,
              extentChecked: true as const,
              expiresAt: "2099-01-01T00:00:00Z",
              changes: {
                added: match ? 0 : 1,
                updated: match ? 1 : 0,
                overlaps: [],
              },
              diagnostics: {
                inputFeatures: 1,
                selectedFeatures: 1,
                outputFeatures: 1,
                excludedFeatures: 0,
                vertices: 5,
                warnings: [],
              },
            },
          },
        };
        return isParcel
          ? {
              ...base,
              layer: "parcels",
              parcels: [
                {
                  ...existingParcel,
                  id: match ? existingParcel.id : "added-parcel",
                  name: "Reviewed parcel",
                  sourceId: source.id,
                },
              ],
            }
          : {
              ...base,
              layer: "buildings",
              buildings: [
                {
                  ...existingBuilding,
                  id: match ? existingBuilding.id : "added-building",
                  name: "Reviewed building",
                  units: 0,
                  jobs: 20,
                  sourceId: source.id,
                },
              ],
            };
      });
      const state = emptyState();
      state.users.push({
        id: record.createdBy,
        name: "Owner",
        email: "commit@example.test",
        passwordHash: "fixture",
        createdAt: at,
      });
      state.organizations.push({
        id: record.organizationId,
        name: "Fixture",
        createdAt: at,
      });
      state.memberships.push({
        userId: record.createdBy,
        organizationId: record.organizationId,
        role: "owner",
      });
      state.sessions.push({
        hash: sessionHash,
        userId: record.createdBy,
        organizationId: record.organizationId,
        csrfToken: "fixture",
        expiresAt: "2099-01-01T00:00:00Z",
      });
      state.projects.push(record);
      state.imports.push(...staged);
      fixture = await createPostgresSecurityFixture(
        process.env.TEST_DATABASE_URL!,
        { state },
      );
      web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
    }, 30000);
    afterAll(async () => {
      await web?.end();
      await fixture?.close();
    }, 30000);

    const commandFor = (preview: ImportRecord): Command =>
      "parcels" in preview
        ? {
            type: "parcels.import",
            parcels: preview.parcels,
            source: preview.source,
            mode: preview.prepared!.mode,
          }
        : {
            type: "buildings.import",
            buildings: preview.buildings,
            source: preview.source,
            mode: preview.prepared!.mode,
          };
    function applied(
      preview: ImportRecord,
      command = commandFor(preview),
    ): Project {
      const project = structuredClone(record.project),
        before = structuredClone(project.scenarios[1]);
      const after = applyCommand(before, command);
      project.scenarios[1] = after;
      project.history.push({
        id: "commit-history",
        at,
        actor: "Owner",
        label: "Apply reviewed layer",
        command,
        before,
        after: structuredClone(after),
      });
      project.updatedAt = after.updatedAt;
      return projectWithImportVersion(project, record.baseline);
    }
    async function asOwner(fn: (client: pg.PoolClient) => Promise<void>) {
      const client = await web.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('urban.session_hash',$1,true),set_config('urban.purpose','',true)",
          [sessionHash],
        );
        await fn(client);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    async function save(client: pg.PoolClient, project: Project) {
      const row = encodeRecord("projects", {
        ...record,
        project,
        version: 2,
      }).row;
      await client.query(
        "UPDATE app_projects SET header=$2::jsonb,payload=$3::jsonb WHERE id=$1",
        [project.id, JSON.stringify(row.header), JSON.stringify(row.payload)],
      );
    }
    async function commit(client: pg.PoolClient, preview: ImportRecord) {
      const receipt = {
        projectId: record.project.id,
        scenarioId: record.project.activeScenarioId,
        version: 2,
        revision: 1,
        at,
      };
      return client.query(
        "UPDATE app_imports SET header=jsonb_set(header,'{committed}',$2::jsonb) WHERE id=$1",
        [preview.id, JSON.stringify(receipt)],
      );
    }
    for (const id of [
      "building-append",
      "building-match",
      "parcel-append",
      "parcel-match",
    ]) {
      it(`accepts the exact ${id} command, source replacement and retained attribution`, async () => {
        const preview = staged.find((p) => p.id === id)!;
        await asOwner(async (client) => {
          await save(client, applied(preview));
          expect((await commit(client, preview)).rowCount).toBe(1);
          const result = await client.query(
            "SELECT header->'committed' AS receipt FROM app_imports WHERE id=$1",
            [id],
          );
          expect(result.rows[0].receipt.version).toBe(2);
        });
      });
    }
    it("rejects marking an unrelated saved edit as the reviewed import", async () => {
      const preview = staged[0];
      await asOwner(async (client) => {
        await save(
          client,
          applied(preview, {
            type: "scenario.details",
            name: "Unrelated renamed scenario",
            description: "No uploaded features applied.",
          }),
        );
        await expect(commit(client, preview)).rejects.toMatchObject({
          code: "42501",
        });
      });
    });
    it("rejects fabricated history when the reviewed geometry is absent from the saved scenario", async () => {
      const preview = staged[0],
        project = applied(preview);
      project.scenarios[1].buildingEdits = {};
      project.history[0].after = structuredClone(project.scenarios[1]);
      await asOwner(async (client) => {
        await save(client, project);
        await expect(commit(client, preview)).rejects.toMatchObject({
          code: "42501",
        });
      });
    });
    for (const attack of ["feature", "source", "before", "undone"] as const) {
      it(`rejects substituted ${attack} evidence despite matching revision numbers`, async () => {
        const preview = staged[0],
          project = applied(preview),
          history = project.history[0];
        if (attack === "feature") {
          project.scenarios[1].buildingEdits["added-building"]!.jobs = 999;
          history.after = structuredClone(project.scenarios[1]);
        } else if (attack === "source") {
          project.scenarios[1].sources!.at(-1)!.license = "Invented permission";
          history.after = structuredClone(project.scenarios[1]);
        } else if (attack === "before")
          history.before.name = "Invented previous state";
        else project.undone.push(structuredClone(history));
        await asOwner(async (client) => {
          await save(client, project);
          await expect(commit(client, preview)).rejects.toMatchObject({
            code: "42501",
          });
        });
      });
    }
  },
);
