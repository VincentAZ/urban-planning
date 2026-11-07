import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Place } from "@urban/core";
import { createProject } from "@urban/models";
import { emptyState, FileStore } from "./store.js";
import { stateFingerprint } from "./storage-core.js";
import {
  createDevelopmentBackup,
  verifyDevelopmentBackup,
} from "./storage-backup.js";

const paths: string[] = [],
  stores: FileStore[] = [];
const place: Place = {
  id: "backup-fixture",
  name: "Private retained place",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.46],
  bounds: [-112.08, 33.45, -112.06, 33.47],
  boundary: [
    [-112.08, 33.45],
    [-112.06, 33.45],
    [-112.06, 33.47],
    [-112.08, 33.47],
    [-112.08, 33.45],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Private backup fixture",
};
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function setup(legacy = true) {
  const directory = await mkdtemp(join(tmpdir(), "urban-backup-"));
  paths.push(directory);
  const source = join(directory, "source.json"),
    destination = join(directory, "backup");
  const state = emptyState();
  state.organizations.push({
    id: "org",
    name: "Private workspace title",
    createdAt: place.loadedAt,
  });
  for (const id of ["live", "retired"]) {
    const project = createProject(place);
    project.id = id;
    state.projects.push({
      organizationId: "org",
      project,
      version: 1,
      baseline: structuredClone(place),
      createdBy: "private-owner",
      createdAt: place.loadedAt,
    });
  }
  if (legacy) await writeFile(source, JSON.stringify(state), { mode: 0o600 });
  const store = new FileStore(source);
  stores.push(store);
  await store.read((data) => data.schemaVersion, {});
  if (!legacy)
    await store.transaction((data) => {
      data.organizations = state.organizations;
      data.projects = state.projects;
    });
  await store.transaction(
    (data) => {
      data.projects[0].version = 2;
      data.projects[0].project.name = "Current saved proposal";
    },
    { projects: { where: [{ id: "live" }] } },
  );
  const retired = state.projects[1];
  await store.transaction(
    (data) => {
      data.projects = [];
    },
    { projects: { where: [{ id: "retired" }] } },
  );
  return { directory, source, destination, store, retired };
}
function history(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT project_id,version,payload,baseline_hash FROM project_versions ORDER BY project_id,version",
      )
      .all();
  } finally {
    database.close();
  }
}

describe("complete development database backup and recovery", () => {
  it("restores current state, all saved versions, baseline identity, and deleted-ID protection without changing the source", async () => {
    const { directory, source, destination, store, retired } = await setup();
    const sourceBefore = {
      database: await digest(`${source}.sqlite`),
      legacy: await digest(source),
    };
    const current = stateFingerprint(await store.read((data) => data));
    const sourceHistory = history(`${source}.sqlite`);
    const manifest = await createDevelopmentBackup({
      sourceStatePath: source,
      destinationDirectory: destination,
    });
    expect(manifest.counts).toMatchObject({
      baselines: 1,
      projectVersions: 3,
      retiredProjectIds: 1,
    });
    expect(manifest.sourceBasename).toBe("source.json");
    expect(await verifyDevelopmentBackup(destination)).toEqual(manifest);
    expect(await readFile(join(destination, "state.json"))).toEqual(
      await readFile(source),
    );
    expect(history(join(destination, "state.json.sqlite"))).toEqual(
      sourceHistory,
    );
    for (const name of ["state.json", "state.json.sqlite", "manifest.json"])
      expect((await stat(join(destination, name))).mode & 0o777).toBe(0o600);
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    // Rehearse a real restoration in a third directory, preserving the backup unchanged.
    const restoreDirectory = join(directory, "restore");
    await mkdir(restoreDirectory, { mode: 0o700 });
    for (const name of ["state.json", "state.json.sqlite"])
      await copyFile(join(destination, name), join(restoreDirectory, name));
    const restored = new FileStore(join(restoreDirectory, "state.json"));
    stores.push(restored);
    expect(stateFingerprint(await restored.read((data) => data))).toBe(current);
    expect(history(join(restoreDirectory, "state.json.sqlite"))).toEqual(
      sourceHistory,
    );
    await expect(
      restored.transaction(
        (data) => {
          data.projects.push(structuredClone(retired));
        },
        { projects: { append: true } },
      ),
    ).rejects.toThrow(/retired|reuse/);
    const live = await restored.read((data) => data.projects[0], {
      projects: { where: [{ id: "live" }] },
    });
    expect(live.version).toBe(2);
    expect(live.project.name).toBe("Current saved proposal");
    expect(live.baseline).toEqual(place);
    expect(await digest(`${source}.sqlite`)).toBe(sourceBefore.database);
    expect(await digest(source)).toBe(sourceBefore.legacy);
    expect(await verifyDevelopmentBackup(destination)).toEqual(manifest);
  });
  it("preserves a null legacy marker for databases created without a legacy JSON file", async () => {
    const { source, destination, store } = await setup(false);
    const current = stateFingerprint(await store.read((data) => data));
    const manifest = await createDevelopmentBackup({
      sourceStatePath: source,
      destinationDirectory: destination,
    });
    expect(manifest.files["state.json"]).toBeNull();
    await expect(stat(join(destination, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const restored = new FileStore(join(destination, "state.json"));
    stores.push(restored);
    expect(stateFingerprint(await restored.read((data) => data))).toBe(current);
  });
  it("never overwrites an existing destination directory or creates an absent source database", async () => {
    const { source, destination, directory } = await setup();
    await mkdir(destination);
    await writeFile(
      join(destination, "keep.txt"),
      "Leave existing content intact",
    );
    await expect(
      createDevelopmentBackup({
        sourceStatePath: source,
        destinationDirectory: destination,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe(
      "Leave existing content intact",
    );
    const missing = join(directory, "missing.json");
    await expect(
      createDevelopmentBackup({
        sourceStatePath: missing,
        destinationDirectory: join(directory, "unused"),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${missing}.sqlite`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("refuses a mismatched preserved legacy file and removes only its new incomplete destination", async () => {
    const { source, destination } = await setup();
    await writeFile(source, '{"unexpected":true}');
    const before = await digest(`${source}.sqlite`);
    await expect(
      createDevelopmentBackup({
        sourceStatePath: source,
        destinationDirectory: destination,
      }),
    ).rejects.toThrow("does not match");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await digest(`${source}.sqlite`)).toBe(before);
    expect(await readFile(source, "utf8")).toBe('{"unexpected":true}');
  });
  it("detects changed backup files and scalar count tampering before restoration", async () => {
    const { source, destination } = await setup();
    const manifest = await createDevelopmentBackup({
      sourceStatePath: source,
      destinationDirectory: destination,
    });
    await writeFile(
      join(destination, "manifest.json"),
      JSON.stringify({
        ...manifest,
        counts: { ...manifest.counts, projectVersions: 0 },
      }),
    );
    await expect(verifyDevelopmentBackup(destination)).rejects.toThrow(
      "record-count",
    );
    await writeFile(
      join(destination, "manifest.json"),
      JSON.stringify(manifest),
    );
    await writeFile(join(destination, "state.json"), "{}");
    await expect(verifyDevelopmentBackup(destination)).rejects.toThrow(
      "checksum",
    );
  });
  it("runs the explicit-source CLI and verification without printing stored content", async () => {
    const { source, destination } = await setup();
    const execute = promisify(execFile),
      script = resolve("scripts/storage-backup.ts");
    const result = await execute(process.execPath, [
      "--import",
      "tsx",
      script,
      "--source",
      source,
      "--out",
      destination,
    ]);
    expect(result.stdout).toContain("Private backup created and verified");
    expect(result.stdout).not.toContain("Private workspace title");
    expect(result.stdout).not.toContain("private-owner");
    const verification = await execute(process.execPath, [
      "--import",
      "tsx",
      script,
      "--verify",
      destination,
    ]);
    expect(verification.stdout).toContain("Backup verified");
    expect(verification.stdout).toContain("3 saved versions");
  });
  it("does not disclose malformed stored metadata in a failed CLI backup", async () => {
    const { source, destination } = await setup();
    const database = new DatabaseSync(`${source}.sqlite`);
    try {
      database
        .prepare("UPDATE storage_meta SET value=? WHERE key='migration'")
        .run("PRIVATE_DATABASE_SECRET is invalid JSON");
    } finally {
      database.close();
    }
    const execute = promisify(execFile);
    await expect(
      execute(process.execPath, [
        "--import",
        "tsx",
        resolve("scripts/storage-backup.ts"),
        "--source",
        source,
        "--out",
        destination,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("storage migration marker is invalid"),
    });
    try {
      await createDevelopmentBackup({
        sourceStatePath: source,
        destinationDirectory: destination,
      });
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_DATABASE_SECRET");
    }
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
