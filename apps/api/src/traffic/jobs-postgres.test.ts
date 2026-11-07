import { enableReviewedBudgetForFixture } from "../budget-test-fixture.js";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import {
  countsFromCSV,
  parseTrafficCSV,
  trafficContentHash,
  trafficSignalProgramHash,
  type Project,
  type Source,
} from "@urban/core";
import { trafficPlaceFixture } from "../../../../tests/fixtures/traffic";
import {
  trafficNetworkFixture,
  trafficCountFixture,
  trafficDemandFixture,
  trafficFixturePeriod,
  trafficFixtureSource,
} from "../../../../packages/core/src/traffic-fixture";
import { createPostgresSecurityFixture } from "../postgres-security-fixture";
import { PostgresStore } from "../postgres-store";
import { emptyState, type DataState } from "../store";
import type { StoreScope } from "../store-scope";
import { buildApp } from "../app";
import { TrafficJobService } from "./jobs";
import { FixtureRuntime, syntheticSignalXml } from "./job-fixture";
import type { PreparedTrafficNetwork } from "./types";
import type {
  TrafficPreparedIdentity,
  TrafficUploadBinding,
} from "./jobs-types";
import type { TrafficExperimentRequest } from "./experiment";
import type { TrafficConfigurationSubmission } from "./source-review";
import { packagedCommuteFixture } from "./commute-evidence-fixture";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "../identity-test-fixture.js";

const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const declaration = (source: Source) => ({
  sourceId: source.id,
  name: source.name,
  url: source.url,
  vintage: source.vintage,
  license: source.license,
  privateUseConfirmed: true as const,
  publicRedistribution: false,
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "traffic saved-project lifecycle through restricted PostgreSQL HTTP roles",
  () => {
    it.each([
      { mapped: false, timing: false, commute: false },
      { mapped: true, timing: false, commute: false },
      { mapped: false, timing: true, commute: false },
      { mapped: false, timing: false, commute: true },
    ])(
      "retains exact private traffic workflow with correspondence=$mapped, timing=$timing and commute=$commute",
      async ({ mapped, timing, commute }) => {
        const state = emptyState();
        enableReviewedBudgetForFixture(state.budget);
        const fixture = await createPostgresSecurityFixture(
          process.env.TEST_DATABASE_URL!,
          { state },
        );
        const directory = await mkdtemp(join(tmpdir(), "traffic-http-pg-"));
        const openStore = () =>
          new PostgresStore(fixture.webURL, {
            mode: "runtime",
            authConnectionString: fixture.authURL,
            workerConnectionString: fixture.workerURL,
            poolMax: 2,
          });
        let store = openStore(),
          app: FastifyInstance | undefined;
        try {
          await store.initialize();
          const runtime = new FixtureRuntime(),
            bytes = timing
              ? syntheticSignalXml(trafficNetworkFixture().signals)
              : Buffer.from("<net>synthetic fixture</net>");
          const network: PreparedTrafficNetwork = {
            network: structuredClone(trafficNetworkFixture()),
            networkXml: bytes,
            files: { "network.net.xml": bytes },
            resources: {
              wallMilliseconds: 1,
              peakMemoryBytes: 1,
              cpuLimit: 1,
              memoryLimitBytes: 2 ** 30,
              outputBytes: bytes.length,
            },
          };
          network.network.manifest.networkFileSha256 = sha(bytes);
          network.network.manifest.sources[0].kind = "observed";
          const counts = structuredClone(trafficCountFixture());
          counts.sources[0].kind = "observed";
          for (const count of counts.counts) {
            count.target = null;
            delete count.mapping;
          }
          const demand = structuredClone(trafficDemandFixture());
          const authored: Source = {
            ...trafficFixtureSource,
            id: "authored-demand",
            kind: "user-supplied",
          };
          demand.sources = [authored];
          demand.rows.forEach((row) => (row.sourceIds = [authored.id]));
          demand.candidateRoutes.forEach(
            (row) => (row.sourceIds = [authored.id]),
          );
          const original: TrafficExperimentRequest = {
            version: 1,
            networkHash: sha(bytes),
            countPack: counts,
            demand,
            period: { ...trafficFixturePeriod },
            seed: 42,
            overlays: [],
            calibrationPlan: null,
            unsupportedChanges: [],
          };
          const commuteFixture = commute
            ? await packagedCommuteFixture(
                join(directory, "commute"),
                network.network,
              )
            : null;
          if (commuteFixture) {
            original.commute = commuteFixture.preset.summary.binding;
            original.demand = commuteFixture.preset.demand;
            original.period = commuteFixture.prior.recipe.period;
          }
          const identity: TrafficPreparedIdentity = {
            id: "synthetic-prepared",
            placeId: trafficPlaceFixture.id,
            studyAreaHash: "a".repeat(64),
            networkHash: sha(bytes),
            inventoryHash: await trafficContentHash(network.network),
            sourceEnvelope: [-113, 32, -111, 34],
            bufferMeters: 1000,
            methodVersion: "1.0.0",
            workerHash: sha(runtime.worker),
          };
          const options = {
            enabled: true,
            automaticWorker: false,
            archiveDirectory: join(directory, "archive"),
            runtime,
            catalog: {
              forPlace: async () => ({
                network,
                identity,
                pack: counts,
                entry: {
                  ...identity,
                  networkDirectory: "synthetic",
                  initialPeriod: original.period,
                },
              }),
              initialRequest: async () => structuredClone(original),
              commutePresets: async (_place: unknown, preparedId?: string) => {
                expect(preparedId).toBe(identity.id);
                return commuteFixture ? [await commuteFixture.load()] : [];
              },
            },
            capacity: {
              mode: "fixed-capacity" as const,
              environment: "local-development" as const,
              statement:
                "Existing isolated local test capacity, not production cost validation.",
            },
          };
          let service = new TrafficJobService(store, options);
          const appOptions = {
            identityMail: new FixtureIdentityMail(),
            nationalPreparationEnabled: false,
            catalog: {
              list: async () => [trafficPlaceFixture],
              get: async () => structuredClone(trafficPlaceFixture),
            },
          };
          app = await buildApp({
            ...appOptions,
            store,
            trafficService: service,
          });
          attachIdentityTestMail(app, appOptions.identityMail);
          async function register(name: string) {
            const response = await app!.inject({
              method: "POST",
              url: "/api/v1/auth/register",
              payload: {
                name,
                email: `${name}@traffic-pg.example.test`,
                password: "isolated PostgreSQL traffic lifecycle password",
              },
            });
            expect(response.statusCode, response.body).toBe(201);
            return {
              id: response.json().user.id,
              email: response.json().user.email,
              organizationId: response.json().organization.id,
              headers: {
                cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
                "x-csrf-token": response.json().csrfToken as string,
              },
            };
          }
          const owner = await register("owner"),
            outsider = await register("outsider"),
            viewer = await register("viewer");
          const created = await app.inject({
            method: "POST",
            url: "/api/v1/projects",
            headers: owner.headers,
            payload: { placeId: trafficPlaceFixture.id },
          });
          expect(created.statusCode, created.body).toBe(201);
          const saved = created.json<{ project: Project; version: number }>(),
            projectPath = `/api/v1/projects/${saved.project.id}`,
            base = `${projectPath}/traffic`,
            scenarioId = saved.project.activeScenarioId;
          let initialVersion = mapped ? 2 : 1,
            initialRevision = mapped ? 1 : 0;
          if (mapped) {
            const edited = await app.inject({
              method: "POST",
              url: `${projectPath}/scenarios/${scenarioId}/commands`,
              headers: owner.headers,
              payload: {
                expectedVersion: 1,
                expectedRevision: 0,
                command: {
                  type: "road.upsert",
                  road: {
                    ...trafficPlaceFixture.roads[0],
                    speedMph: 35,
                    lanes: 2,
                    signal: true,
                  },
                },
              },
            });
            expect(edited.statusCode, edited.body).toBe(200);
          }
          const csv = "station,count\r\n0007,0\r\n0008,\r\n",
            boundary = "traffic-pg-source-boundary";
          const form = `--${boundary}\r\nContent-Disposition: form-data; name="idempotencyKey"\r\n\r\nsource-upload-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="counts.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
          const uploadCall = () =>
            app!.inject({
              method: "POST",
              url: `${base}/uploads`,
              headers: {
                ...owner.headers,
                "content-type": `multipart/form-data; boundary=${boundary}`,
              },
              payload: form,
            });
          const uploaded = await uploadCall();
          expect(uploaded.statusCode, uploaded.body).toBe(201);
          const upload = uploaded.json().upload;
          expect(upload).toMatchObject({
            rows: 2,
            sha256: sha(Buffer.from(csv)),
            bytes: Buffer.byteLength(csv),
          });
          expect((await uploadCall()).json().upload.id).toBe(upload.id);
          const raw = await app.inject({
            url: `${base}/uploads/${upload.id}/file`,
            headers: owner.headers,
          });
          expect(raw.body).toBe(csv);
          const source: Source = {
            ...trafficFixtureSource,
            id: upload.sourceId,
            name: "Original private test CSV",
          };
          const binding: TrafficUploadBinding = {
            uploadId: upload.id,
            sourceId: source.id,
            mapping: { station: 0, value: 1 },
            useAnalysisPeriod: true,
            kind: "observed",
            batchId: "csv-pg-batch",
            period: { ...original.period },
          };
          const request = structuredClone(original);
          request.countPack.sources.push(source);
          request.countPack.counts.push(
            ...countsFromCSV(
              parseTrafficCSV(csv),
              binding.mapping,
              binding.period,
              source.id,
              true,
              "observed",
              binding.batchId,
            ),
          );
          if (timing) {
            const program = network.network.signals[0];
            request.signalTimings = [
              {
                signalId: program.id,
                programId: program.programId,
                baselineProgramHash: await trafficSignalProgramHash(program),
                phaseDurationsSeconds: [40, 30],
                offsetSeconds: 5,
                rationale:
                  "Synthetic HTTP persistence/authority test, not native or calibrated evidence.",
              },
            ];
          }
          const input: TrafficConfigurationSubmission = {
            scenarioId,
            expectedVersion: initialVersion,
            expectedRevision: initialRevision,
            expectedConfigurationId: null,
            idempotencyKey: "config-pg-1",
            request,
            sourceDeclarations: [
              ...(commute ? [] : [declaration(authored)]),
              declaration(source),
            ],
            uploadBindings: [binding],
            mappingReviews: [],
            scopeAcknowledged: true,
            ...(mapped
              ? {
                  planningRoadReviews: [
                    {
                      roadId: "planning-road",
                      properties: ["speed", "lanes"],
                      directions: [
                        { direction: "with-road", edgeIds: ["in"], lanes: 2 },
                      ],
                      extent: "full-road",
                      nativeExtensionAcknowledged: true,
                      rationale:
                        "Synthetic manually reviewed test correspondence.",
                    },
                  ],
                  planningSourceDeclarations: [
                    {
                      sourceId: trafficPlaceFixture.sources[0].id,
                      privateUseConfirmed: true,
                      publicRedistribution: false,
                    },
                  ],
                }
              : {}),
          };
          const configured = await app.inject({
            method: "POST",
            url: `${base}/configurations`,
            headers: owner.headers,
            payload: input,
          });
          expect(configured.statusCode, configured.body).toBe(201);
          const config = configured.json().configuration;
          if (commuteFixture) {
            expect(config.request.commute).toEqual(
              commuteFixture.preset.summary.binding,
            );
            const evidenceUrl = `${base}/commute/${commuteFixture.preset.id}/evidence?preparedId=${identity.id}`;
            const evidence = await app.inject({
              url: evidenceUrl,
              headers: owner.headers,
            });
            expect(evidence.statusCode, evidence.body).toBe(200);
            expect(evidence.headers["x-content-sha256"]).toBe(
              commuteFixture.preset.evidenceFile.sha256,
            );
            expect(evidence.headers["content-length"]).toBe(
              String(commuteFixture.preset.evidenceFile.bytes),
            );
            expect(sha(evidence.rawPayload)).toBe(
              commuteFixture.preset.evidenceFile.sha256,
            );
            expect(evidence.json().compilation.ledger).toEqual(
              commuteFixture.compilation.ledger,
            );
            expect(
              (
                await app.inject({
                  url: evidenceUrl,
                  headers: outsider.headers,
                })
              ).statusCode,
            ).toBe(404);
            expect((await app.inject({ url: evidenceUrl })).statusCode).toBe(
              401,
            );
          }
          expect(config.uploadIds).toEqual([upload.id]);
          if (timing)
            expect(config.request.signalTimings).toEqual(request.signalTimings);
          if (mapped) {
            expect(config.request.overlays).toEqual([
              { edgeId: "in", lanes: 2, speedMps: 35 * 0.44704 },
            ]);
            expect(config.request.planningRoads.reviews[0].reviewedBy).toBe(
              owner.id,
            );
            expect(config.request.planningRoads.exclusions).toContainEqual(
              expect.objectContaining({
                roadId: "planning-road",
                property: "signal",
                reason: "unsupported",
              }),
            );
          } else expect(config.request).not.toHaveProperty("planningRoads");
          expect(
            config.request.countPack.counts
              .slice(-2)
              .map((c: { value: number | null }) => c.value),
          ).toEqual([0, null]);
          expect(
            config.request.countPack.sources.find(
              (s: Source) => s.id === source.id,
            ).rights.declaredBy,
          ).toBe(owner.id);
          const configRetry = await app.inject({
            method: "POST",
            url: `${base}/configurations`,
            headers: owner.headers,
            payload: input,
          });
          expect(configRetry.statusCode, configRetry.body).toBe(201);
          expect(configRetry.json().configuration.id).toBe(config.id);
          const listing = await app.inject({
            url: `${base}/configurations?scenarioId=${scenarioId}`,
            headers: owner.headers,
          });
          expect(listing.json().configurations[0]).not.toHaveProperty(
            "request",
          );
          const start = {
            configurationId: config.id,
            expectedVersion: initialVersion,
            expectedRevision: initialRevision,
            idempotencyKey: "traffic-pg-run-1",
          };
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${base}/jobs`,
                headers: { cookie: owner.headers.cookie },
                payload: start,
              })
            ).statusCode,
          ).toBe(403);
          const queued = await app.inject({
            method: "POST",
            url: `${base}/jobs`,
            headers: owner.headers,
            payload: start,
          });
          expect(queued.statusCode, queued.body).toBe(201);
          const jobId = queued.json().job.id;
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${base}/jobs`,
                headers: owner.headers,
                payload: start,
              })
            ).json().job.id,
          ).toBe(jobId);
          expect(runtime.calls).toBe(0);
          const storageErrors: string[] = [];
          const observedRead = store.read.bind(store),
            observedTransaction = store.transaction.bind(store);
          store.read = async <T>(
            callback: (state: DataState) => T,
            scope?: StoreScope,
          ): Promise<T> => {
            try {
              return await observedRead(callback, scope);
            } catch (error) {
              storageErrors.push(String(error));
              throw error;
            }
          };
          store.transaction = async <T>(
            callback: (state: DataState) => T,
            scope?: StoreScope,
          ): Promise<T> => {
            try {
              return await observedTransaction(callback, scope);
            } catch (error) {
              storageErrors.push(String(error));
              throw error;
            }
          };
          await service.runOne();
          store.read = observedRead;
          store.transaction = observedTransaction;
          expect(storageErrors).toEqual([]);
          const status = await app.inject({
            url: `${base}/jobs/${jobId}`,
            headers: owner.headers,
          });
          expect(status.statusCode, status.body).toBe(200);
          expect(status.json().job.status, status.body).toBe("completed");
          expect(status.json().job.attempts).toHaveLength(1);
          expect(status.json().job).not.toHaveProperty("capacityToken");
          expect(runtime.calls).toBe(1);
          const result = await app.inject({
            url: `${base}/jobs/${jobId}/result`,
            headers: owner.headers,
          });
          expect(result.statusCode, result.body).toBe(200);
          expect(result.headers["cache-control"]).toBe("private, no-store");
          const traffic = result.json().traffic;
          if (commuteFixture)
            expect(traffic.capture.originalDemand.commute).toEqual(
              commuteFixture.preset.summary,
            );
          expect(traffic.origin).toBe("server-run");
          if (timing)
            expect(traffic.capture.proposal.signalTimings[0]).toMatchObject({
              control: request.signalTimings![0],
              proposal: { quality: "authored", offsetSeconds: 5 },
            });
          if (mapped)
            expect(
              traffic.capture.proposal.planningRoadMapping.correspondence,
            ).toEqual(config.request.planningRoads);
          else
            expect(
              traffic.capture.proposal.planningRoadMapping,
            ).not.toHaveProperty("correspondence");
          expect(traffic.receipt).toMatchObject({
            projectId: saved.project.id,
            jobId,
          });
          expect(result.json().experiment.requestHash).toBe(config.requestHash);
          for (const path of [
            `${base}/jobs/${jobId}/result`,
            `${base}/uploads/${upload.id}/file`,
            `${base}/configurations?scenarioId=${scenarioId}`,
          ]) {
            expect(
              (await app.inject({ url: path, headers: outsider.headers }))
                .statusCode,
            ).toBe(404);
          }
          await acceptIdentityTestInvitation(
            app,
            owner,
            viewer,
            "viewer",
            saved.project.id,
          );
          const switched = await app.inject({
            method: "POST",
            url: "/api/v1/auth/organization",
            headers: viewer.headers,
            payload: { organizationId: owner.organizationId },
          });
          expect(switched.statusCode, switched.body).toBe(200);
          expect(
            (
              await app.inject({
                url: `${base}/jobs/${jobId}/result`,
                headers: viewer.headers,
              })
            ).statusCode,
          ).toBe(200);
          if (mapped) {
            const updateCitation = async (source: Source) =>
              app!.inject({
                method: "POST",
                url: `${projectPath}/scenarios/${scenarioId}/commands`,
                headers: owner.headers,
                payload: {
                  expectedVersion: initialVersion,
                  expectedRevision: initialRevision,
                  command: {
                    type: "road.upsert",
                    road: {
                      ...trafficPlaceFixture.roads[0],
                      speedMph: 35,
                      lanes: 2,
                      signal: true,
                    },
                    source,
                  },
                },
              });
            const changed = await updateCitation({
              ...trafficPlaceFixture.sources[0],
              description: "Citation changed after the captured native work.",
            });
            expect(changed.statusCode, changed.body).toBe(200);
            initialVersion++;
            initialRevision++;
            const stale = await app.inject({
              method: "POST",
              url: `${base}/jobs/${jobId}/adopt`,
              headers: owner.headers,
              payload: {
                scenarioId,
                expectedVersion: initialVersion,
                expectedRevision: initialRevision,
              },
            });
            expect(stale.statusCode, stale.body).toBe(409);
            expect(stale.json().error.code).toBe("TRAFFIC_RESULT_STALE");
            const restored = await updateCitation(
              trafficPlaceFixture.sources[0],
            );
            expect(restored.statusCode, restored.body).toBe(200);
            initialVersion++;
            initialRevision++;
          }
          const adoption = {
            scenarioId,
            expectedVersion: initialVersion,
            expectedRevision: initialRevision,
          };
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${base}/jobs/${jobId}/adopt`,
                headers: viewer.headers,
                payload: adoption,
              })
            ).statusCode,
          ).toBe(403);
          const adopted = await app.inject({
            method: "POST",
            url: `${base}/jobs/${jobId}/adopt`,
            headers: owner.headers,
            payload: adoption,
          });
          expect(adopted.statusCode, adopted.body).toBe(200);
          const accepted = adopted.json();
          expect(accepted.version).toBe(initialVersion + 1);
          expect(accepted.project.schemaVersion).toBe(9);
          expect(
            accepted.project.scenarios.find(
              (s: { id: string }) => s.id === scenarioId,
            ).traffic,
          ).toEqual(traffic);
          expect(accepted.project.history.at(-1).command.traffic).toEqual(
            traffic,
          );
          const csvUrl = `${projectPath}/exports?format=traffic-csv&scenarioId=${scenarioId}&version=${initialVersion + 1}&revision=${initialRevision + 1}`;
          const trafficCsv = await app.inject({
            url: csvUrl,
            headers: viewer.headers,
          });
          expect(trafficCsv.statusCode, trafficCsv.body).toBe(200);
          expect(trafficCsv.headers["content-type"]).toContain("text/csv");
          expect(trafficCsv.headers["content-disposition"]).toContain(
            "-traffic.csv",
          );
          expect(trafficCsv.body).toContain(traffic.captureHash);
          expect(trafficCsv.body).toContain("meanTravelTimeSeconds");
          expect((await app.inject({ url: csvUrl })).statusCode).toBe(401);
          expect(
            (
              await app.inject({
                url: csvUrl.replace(
                  `version=${initialVersion + 1}`,
                  "version=1",
                ),
                headers: owner.headers,
              })
            ).statusCode,
          ).toBe(409);
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${base}/jobs/${jobId}/adopt`,
                headers: owner.headers,
                payload: adoption,
              })
            ).statusCode,
          ).toBe(409);
          const files = await app.inject({
            url: `${base}/jobs/${jobId}/files`,
            headers: owner.headers,
          });
          expect(files.statusCode, files.body).toBe(200);
          if (commuteFixture) {
            const fullLedger = await app.inject({
              url: `${base}/jobs/${jobId}/files/commute-compilation.json`,
              headers: owner.headers,
            });
            expect(fullLedger.statusCode, fullLedger.body).toBe(200);
            expect(fullLedger.json().ledger).toEqual(
              commuteFixture.compilation.ledger,
            );
          }
          const capturedFile = files
            .json()
            .files.find((f: { name: string }) => f.name === "experiment.json");
          const download = await app.inject({
            url: `${base}/jobs/${jobId}/files/experiment.json`,
            headers: owner.headers,
          });
          expect(download.statusCode, download.body).toBe(200);
          expect(sha(download.rawPayload)).toBe(capturedFile.sha256);
          const records = await fixture.operatorStore.read((s) => ({
            jobs: s.trafficJobs,
            configs: s.trafficConfigs,
            uploads: s.trafficUploads,
            artifacts: s.trafficArtifacts,
            capacity: s.nativeCapacity,
            audit: s.audit,
          }));
          expect(records.jobs).toHaveLength(1);
          expect(records.configs).toHaveLength(1);
          expect(records.uploads).toHaveLength(1);
          expect(records.artifacts).toHaveLength(1);
          expect(records.capacity.slot).toBeNull();
          expect(records.audit.map((a) => a.action)).toEqual(
            expect.arrayContaining([
              "traffic.uploaded",
              "traffic.configured",
              "traffic.submitted",
              "traffic.adopted",
            ]),
          );
          await app.close();
          app = undefined;
          store = openStore();
          await store.initialize();
          service = new TrafficJobService(store, options);
          app = await buildApp({
            ...appOptions,
            store,
            trafficService: service,
          });
          const reopened = await app.inject({
            url: projectPath,
            headers: owner.headers,
          });
          expect(reopened.statusCode, reopened.body).toBe(200);
          expect(reopened.json().project).toEqual(accepted.project);
          expect(
            (
              await app.inject({
                url: `${base}/jobs/${jobId}/result`,
                headers: owner.headers,
              })
            ).json().traffic,
          ).toEqual(traffic);
          const forged = structuredClone(traffic);
          forged.capture.notes.push("Altered caller evidence");
          forged.captureHash = await trafficContentHash(forged.capture);
          const denied = await app.inject({
            method: "POST",
            url: `${projectPath}/scenarios/${scenarioId}/commands`,
            headers: owner.headers,
            payload: {
              expectedVersion: initialVersion + 1,
              expectedRevision: initialRevision + 1,
              command: { type: "scenario.traffic", traffic: forged },
            },
          });
          expect(denied.statusCode, denied.body).toBe(422);
          expect(
            (
              await app.inject({ url: projectPath, headers: owner.headers })
            ).json().version,
          ).toBe(initialVersion + 1);
          // A captured result changes project revisions, not the immutable traffic input recipe.
          // Reuse is allowed only after validating the current version and unchanged road/baseline hashes.
          const rerun = await app.inject({
            method: "POST",
            url: `${base}/jobs`,
            headers: owner.headers,
            payload: {
              ...start,
              expectedVersion: initialVersion + 1,
              expectedRevision: initialRevision + 1,
              idempotencyKey: "traffic-pg-rerun",
            },
          });
          expect(rerun.statusCode, rerun.body).toBe(201);
          const rerunId = rerun.json().job.id;
          const cancelled = await app.inject({
            method: "POST",
            url: `${base}/jobs/${rerunId}/cancel`,
            headers: owner.headers,
            payload: { expectedJobVersion: 1 },
          });
          expect(cancelled.statusCode, cancelled.body).toBe(200);
          expect(cancelled.json().job).toMatchObject({
            status: "cancelled",
            attempt: 0,
            version: 2,
          });
          const retried = await app.inject({
            method: "POST",
            url: `${base}/jobs/${rerunId}/retry`,
            headers: owner.headers,
            payload: {
              expectedJobVersion: 2,
              idempotencyKey: "traffic-pg-retry",
            },
          });
          expect(retried.statusCode, retried.body).toBe(200);
          expect(retried.json().job).toMatchObject({
            status: "queued",
            attempt: 0,
            version: 3,
          });
          const recancelled = await app.inject({
            method: "POST",
            url: `${base}/jobs/${rerunId}/cancel`,
            headers: owner.headers,
            payload: { expectedJobVersion: 3 },
          });
          expect(recancelled.statusCode, recancelled.body).toBe(200);
          expect(runtime.calls).toBe(1);
          const revoked = await app.inject({
            method: "DELETE",
            url: `${projectPath}/members/${viewer.id}`,
            headers: owner.headers,
            payload: { expectedAclVersion: 2 },
          });
          expect(revoked.statusCode, revoked.body).toBe(200);
          expect(
            (
              await app.inject({
                url: `${base}/jobs/${jobId}/result`,
                headers: viewer.headers,
              })
            ).statusCode,
          ).toBe(404);
        } finally {
          if (app) await app.close();
          else await store.close();
          await fixture.close();
          await rm(directory, { recursive: true, force: true });
        }
      },
      60000,
    );
  },
);
