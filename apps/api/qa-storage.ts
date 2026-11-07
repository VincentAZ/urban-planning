/**
 * Repeat the aggregate-store workload on private copies of retained data.
 * Run: node --import tsx apps/api/qa-storage.ts --samples 20
 * Optional: --source .local/api-state.json
 * Measures local storage components, not HTTP/model validation or production throughput.
 * Emits scalar evidence only and deletes temporary copies containing private data.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Place } from "@urban/core";
import { FileStore, type StorageDiagnostics } from "./src/file-store.js";
import {
  authorize,
  emptyState,
  findProject,
  type DataState,
  type SessionRecord,
} from "./src/store.js";
import { findProjectHeader, projectAccess } from "./src/project-access.js";
import { publicationEngagement } from "./src/engagement.js";
import { collections, type StoreScope } from "./src/store-scope.js";
import { digest, stateFingerprint } from "./src/storage-core.js";

const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
}
const samples = Number(option("--samples", "20"));
if (!Number.isInteger(samples) || samples < 10 || samples > 20)
  throw new Error("Use 10–20 samples.");
const sourcePath = resolve(option("--source", ".local/api-state.json"));
const outputRoot = resolve(".local/qa/storage");
const phoenixPath = resolve("public/data/phoenix.json");
const startedAt = new Date().toISOString();
const resultPath = join(
  outputRoot,
  "benchmark-" + startedAt.replace(/[:.]/g, "-") + ".json",
);
let stage = "initialization";
let privateDirectory: string | undefined;
let indexed: FileStore | undefined;

async function fileSha(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1)!,
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    sampleMs: values,
  };
}
/** Matches the former warm-cache clone and atomic full-document write algorithm. */
class AggregateStore {
  constructor(
    private state: DataState,
    private filename: string,
  ) {}
  async read<T>(operation: (state: DataState) => T): Promise<T> {
    return structuredClone(operation(structuredClone(this.state)));
  }
  async transaction<T>(operation: (state: DataState) => T): Promise<T> {
    const next = structuredClone(this.state),
      result = operation(next);
    const temporary = this.filename + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, this.filename);
    this.state = next;
    return structuredClone(result);
  }
}
type Operation = {
  legacy: (state: DataState) => unknown;
  indexed: (state: DataState) => unknown;
  scope: StoreScope;
  write?: boolean;
};
type Evidence = {
  legacyAggregate: ReturnType<typeof distribution>;
  indexed: ReturnType<typeof distribution>;
  indexedDiagnostics: StorageDiagnostics;
  p50Ratio: number;
  p95Ratio: number;
  identicalLogicalResults: boolean;
};
const json = (value: unknown) =>
  JSON.stringify(value, null, 2) + String.fromCharCode(10);

async function main() {
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const sourceBytes = (await stat(sourcePath)).size,
    originalSha = await fileSha(sourcePath);
  const phoenixBytes = await readFile(phoenixPath),
    phoenix = JSON.parse(phoenixBytes.toString()) as Place;
  const phoenixHash = digest(phoenix);
  const implementationSha = createHash("sha256")
    .update(await readFile(resolve("apps/api/src/file-store.ts")))
    .update(await readFile(resolve("apps/api/src/storage-core.ts")))
    .update(await readFile(resolve("apps/api/src/store-scope.ts")))
    .digest("hex");
  privateDirectory = await mkdtemp(join(outputRoot, ".private-benchmark-"));
  const legacyPath = join(privateDirectory, "aggregate.json"),
    indexedPath = join(privateDirectory, "indexed.json");
  check(
    sourcePath !== legacyPath && sourcePath !== indexedPath,
    "Copies must be isolated from retained data.",
  );
  await copyFile(sourcePath, legacyPath);
  await copyFile(sourcePath, indexedPath);
  check(
    (await fileSha(indexedPath)) === originalSha,
    "The isolated source copy does not match.",
  );
  stage = "legacy-cold-load";
  const parseStart = performance.now();
  const initial = {
    ...emptyState(),
    ...JSON.parse(await readFile(legacyPath, "utf8")),
  } as DataState;
  const legacyColdLoadMs = performance.now() - parseStart;
  const originalFingerprint = stateFingerprint(initial);
  const originalCounts = Object.fromEntries(
    collections.map((name) => [name, initial[name].length]),
  );
  const baselineHashes = new Set(
    [...initial.projects, ...initial.published].map((record) =>
      digest(record.baseline),
    ),
  );
  const target = initial.projects.find(
    (record) =>
      digest(record.baseline) === phoenixHash &&
      initial.memberships.some(
        (member) =>
          member.organizationId === record.organizationId &&
          projectAccess(record, member.userId, member)?.canEdit,
      ),
  );
  check(
    target,
    "No editable project with the complete current Phoenix bundle exists in retained data.",
  );
  const membership = initial.memberships.find(
    (member) =>
      member.organizationId === target.organizationId &&
      projectAccess(target, member.userId, member)?.canEdit,
  )!;
  const targetPublication = initial.published.find(
    (snapshot) => !snapshot.revokedAt,
  );
  check(
    targetPublication,
    "No active publication exists for metadata comparison.",
  );
  const organizationProjectCount = initial.projects.filter(
    (record) => record.organizationId === target.organizationId,
  ).length;
  const session: SessionRecord = {
    hash: createHash("sha256").update(randomUUID()).digest("hex"),
    csrfToken: randomUUID(),
    userId: membership.userId,
    organizationId: membership.organizationId,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const legacy = new AggregateStore(initial, legacyPath);
  indexed = new FileStore(indexedPath);
  stage = "indexed-cold-migration";
  const migrationStart = performance.now();
  await indexed.read(() => true, {});
  const indexedColdMigrationMs = performance.now() - migrationStart;
  const migrationDiagnostics = indexed.diagnostics(true);
  stage = "migration-equivalence";
  const migratedFingerprint = await indexed.read((state) =>
    stateFingerprint(state),
  );
  check(
    migratedFingerprint === originalFingerprint,
    "Migration changed logical data.",
  );
  check(
    (await fileSha(indexedPath)) === originalSha,
    "Migration changed its preserved legacy copy.",
  );
  // A fresh session is created only in both isolated copies. Existing credentials are never used.
  await legacy.transaction((state) => {
    state.sessions.push(session);
  });
  await indexed.transaction(
    (state) => {
      state.sessions.push(session);
    },
    { sessions: { append: true } },
  );
  indexed.diagnostics(true);
  const authScope: StoreScope = { auth: { sessionHash: session.hash } };
  const headerScope: StoreScope = {
    ...authScope,
    projectHeaders: {
      where: [{ id: target.project.id, organizationId: target.organizationId }],
    },
  };
  const sessionOperation = (state: DataState) => {
    const identity = authorize(state, session.hash);
    return {
      user: {
        id: identity.user.id,
        name: identity.user.name,
        email: identity.user.email,
      },
      organization: identity.organization,
      role: identity.membership.role,
      csrfToken: identity.session.csrfToken,
    };
  };
  const listOperation = (state: DataState, headers: boolean) => {
    const identity = authorize(state, session.hash);
    return {
      projects: (headers ? state.projectHeaders : state.projects)
        .filter(
          (record) =>
            record.organizationId === identity.organization.id &&
            projectAccess(record, identity.user.id, identity.membership),
        )
        .map((record) => ({
          project: {
            id: record.project.id,
            name: record.project.name,
            placeId: record.project.placeId,
            updatedAt: record.project.updatedAt,
            scenarioCount: record.project.scenarios.length,
          },
          version: record.version,
          organizationId: record.organizationId,
          access: projectAccess(record, identity.user.id, identity.membership),
        })),
    };
  };
  const accessOperation = (state: DataState, headers: boolean) => {
    const identity = authorize(state, session.hash);
    const record = (headers ? findProjectHeader : findProject)(
      state,
      identity.organization.id,
      target.project.id,
      identity.user.id,
    );
    return {
      projectId: record.project.id,
      organizationId: record.organizationId,
      version: record.version,
      access: projectAccess(record, identity.user.id, identity.membership),
    };
  };
  const operations: Record<string, (iteration: number) => Operation> = {
    public_metadata: () => ({
      legacy: (state) =>
        publicationEngagement(
          state.published.find(
            (snapshot) => snapshot.id === targetPublication.id,
          )!,
        ),
      indexed: (state) =>
        publicationEngagement(
          state.publishedHeaders.find(
            (snapshot) => snapshot.id === targetPublication.id,
          )!,
        ),
      scope: { publishedHeaders: { where: [{ id: targetPublication.id }] } },
    }),
    authenticated_session: () => ({
      legacy: sessionOperation,
      indexed: sessionOperation,
      scope: authScope,
    }),
    project_list: () => ({
      legacy: (state) => listOperation(state, false),
      indexed: (state) => listOperation(state, true),
      scope: {
        ...authScope,
        projectHeaders: { where: [{ organizationId: target.organizationId }] },
      },
    }),
    project_access: () => ({
      legacy: (state) => accessOperation(state, false),
      indexed: (state) => accessOperation(state, true),
      scope: headerScope,
    }),
    project_save: (iteration) => {
      const auditId = randomUUID(),
        timestamp = new Date(Date.parse(startedAt) + iteration).toISOString();
      const save = (state: DataState) => {
        const identity = authorize(state, session.hash);
        const record = findProject(
          state,
          identity.organization.id,
          target.project.id,
          identity.user.id,
          ["owner", "editor"],
        );
        record.project.updatedAt = timestamp;
        record.version++;
        state.audit.push({
          id: auditId,
          organizationId: record.organizationId,
          projectId: record.project.id,
          actorId: identity.user.id,
          action: "benchmark.project.saved",
          at: timestamp,
          details: { version: record.version },
        });
        return {
          project: record.project,
          version: record.version,
          organizationId: record.organizationId,
          access: projectAccess(record, identity.user.id, identity.membership),
        };
      };
      return {
        legacy: save,
        indexed: save,
        write: true,
        scope: {
          ...authScope,
          projects: {
            where: [
              { id: target.project.id, organizationId: target.organizationId },
            ],
          },
          audit: { append: true },
        },
      };
    },
  };
  const evidence: Record<string, Evidence> = {};
  const output = {
    schemaVersion: 1,
    startedAt,
    sampleCount: samples,
    implementationSha256: implementationSha,
    method: {
      scope:
        "Local storage component timings; model validation, network and PDF generation excluded.",
      legacy:
        "Warm whole-state clone on reads; clone plus JSON stringify/write/atomic rename on writes, matching the previous adapter.",
      indexed:
        "Scoped SQLite operations with FULL synchronous commits and immutable project versions.",
      sampling:
        "One paired warm-up per operation; alternating measurement order; nearest-rank p50/p95; no forced garbage collection.",
      limitations:
        "Sequential single-process local benchmark under shared-machine load, not production throughput or hardware-representative capacity.",
      retention:
        "No credentials, identities or record text emitted. Private temporary copies are deleted.",
    },
    environment: {
      node: process.versions.node,
      availableParallelism: availableParallelism(),
      loadAverageBefore: loadavg(),
    },
    dataset: {
      originalBytes: sourceBytes,
      originalSha256: originalSha,
      originalCounts,
      uniqueBaselineCount: baselineHashes.size,
      originalStateFingerprint: originalFingerprint,
      phoenixFileBytes: phoenixBytes.length,
      phoenixFileSha256: createHash("sha256")
        .update(phoenixBytes)
        .digest("hex"),
      phoenixBaselineSha256: phoenixHash,
      phoenixBuildings: phoenix.buildings.length,
      phoenixRoads: phoenix.roads.length,
      targetBaselineMatchesCompletePhoenix: true,
      targetOrganizationProjectCount: organizationProjectCount,
    },
    cold: {
      legacyColdLoadMs,
      indexedColdMigrationMs,
      migrationDiagnostics,
      migrationEquivalent: true,
      migratedStateFingerprint: migratedFingerprint,
    },
    operations: evidence,
  };
  for (const [name, factory] of Object.entries(operations)) {
    stage = name;
    const warmup = factory(0);
    const runLegacy = (op: Operation) =>
      op.write ? legacy.transaction(op.legacy) : legacy.read(op.legacy);
    const runIndexed = (op: Operation) =>
      op.write
        ? indexed!.transaction(op.indexed, op.scope)
        : indexed!.read(op.indexed, op.scope);
    check(
      digest(await runLegacy(warmup)) === digest(await runIndexed(warmup)),
      "Warm-up logical results differ.",
    );
    indexed.diagnostics(true);
    const oldTimes: number[] = [],
      newTimes: number[] = [];
    for (let iteration = 1; iteration <= samples; iteration++) {
      const operation = factory(iteration);
      let oldResult: unknown, newResult: unknown;
      const oldRun = async () => {
        const start = performance.now();
        oldResult = await runLegacy(operation);
        oldTimes.push(performance.now() - start);
      };
      const newRun = async () => {
        const start = performance.now();
        newResult = await runIndexed(operation);
        newTimes.push(performance.now() - start);
      };
      if (iteration % 2) {
        await oldRun();
        await newRun();
      } else {
        await newRun();
        await oldRun();
      }
      check(
        digest(oldResult) === digest(newResult),
        "Measured logical results differ.",
      );
    }
    const oldSummary = distribution(oldTimes),
      newSummary = distribution(newTimes),
      diagnostics = indexed.diagnostics(true);
    if (name !== "project_save")
      check(
        diagnostics.baselineLoads === 0 &&
          diagnostics.baselineBytes === 0 &&
          diagnostics.payloadBytes === 0,
        "A metadata operation loaded geographic or scenario payloads.",
      );
    evidence[name] = {
      legacyAggregate: oldSummary,
      indexed: newSummary,
      indexedDiagnostics: diagnostics,
      p50Ratio: oldSummary.p50Ms / newSummary.p50Ms,
      p95Ratio: oldSummary.p95Ms / newSummary.p95Ms,
      identicalLogicalResults: true,
    };
    await writeFile(resultPath, json(output), { mode: 0o600 });
    console.log(
      JSON.stringify({
        stage: name,
        samples,
        oldP50Ms: oldSummary.p50Ms,
        newP50Ms: newSummary.p50Ms,
        oldP95Ms: oldSummary.p95Ms,
        newP95Ms: newSummary.p95Ms,
        baselineLoads: diagnostics.baselineLoads,
      }),
    );
  }
  stage = "final-equivalence";
  const oldFinal = await legacy.read((state) => stateFingerprint(state));
  const newFinal = await indexed.read((state) => stateFingerprint(state));
  check(
    oldFinal === newFinal,
    "Final logical states differ after identical saves.",
  );
  const finalOriginalSha = await fileSha(sourcePath);
  check(
    finalOriginalSha === originalSha,
    "Retained source changed during the benchmark.",
  );
  check(
    (await fileSha(phoenixPath)) ===
      createHash("sha256").update(phoenixBytes).digest("hex"),
    "Phoenix source changed during the benchmark.",
  );
  const completed = {
    ...output,
    completedAt: new Date().toISOString(),
    loadAverageAfter: loadavg(),
    finalVerification: {
      identicalLogicalStates: true,
      finalStateFingerprint: newFinal,
      retainedSourceUnchanged: true,
      finalRetainedSourceSha256: finalOriginalSha,
      isolatedLegacyCopyUnchanged: (await fileSha(indexedPath)) === originalSha,
      indexedDatabaseBytes: (await stat(indexed.databasePath)).size,
    },
  };
  await writeFile(resultPath, json(completed), { mode: 0o600 });
  await writeFile(join(outputRoot, "latest.json"), json(completed), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      completed: true,
      samples,
      sourceBytes,
      migrationEquivalent: true,
      finalStatesEquivalent: true,
      retainedSourceUnchanged: true,
      indexedColdMigrationMs,
    }),
  );
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      completed: false,
      stage,
      error: error instanceof Error ? error.message : "Benchmark failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await indexed?.close();
  if (privateDirectory)
    await rm(privateDirectory, { recursive: true, force: true });
}
