import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileStore } from "./store.js";
import {
  acquireNativeCapacity,
  heartbeatNativeCapacity,
  quarantineNativeCapacity,
  recoverNativeCapacity,
  releaseNativeCapacity,
} from "./native-capacity.js";

describe("shared durable native capacity", () => {
  it("inspects through a read-only CLI and requires an explicit stopped-process attestation for recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-cli-")),
      filename = join(directory, "state.json");
    const store = new FileStore(filename);
    try {
      const lease = await store.transaction(
        (s) =>
          acquireNativeCapacity(s, {
            kind: "traffic",
            jobId: "cli-fixture",
            workerId: "worker",
            runMilliseconds: 60000,
          }),
        { nativeCapacity: true },
      );
      await store.transaction(
        (s) =>
          quarantineNativeCapacity(
            s,
            lease!.token,
            "Test process termination is uncertain.",
          ),
        { nativeCapacity: true },
      );
      const state = await store.read((s) => s.nativeCapacity, {
        nativeCapacity: true,
      });
      await store.close();
      const before = await readFile(`${filename}.sqlite`),
        run = promisify(execFile);
      const call = (args: string[]) =>
        run(
          process.execPath,
          ["--import", "tsx", "scripts/native-capacity.ts", ...args],
          {
            env: { ...process.env, DATABASE_MIGRATION_URL: "" },
            timeout: 10000,
            maxBuffer: 65536,
          },
        );
      const inspected = await call(["--inspect", "--database-file", filename]);
      expect(JSON.parse(inspected.stdout)).toEqual(state);
      expect(await readFile(`${filename}.sqlite`)).toEqual(before);
      const recovery = [
        "--recover",
        "--database-file",
        filename,
        "--token",
        lease!.token,
        "--revision",
        String(state.revision),
        "--operator",
        "fixture-operator",
        "--confirmation",
        "All isolated test containers and routing processes were confirmed stopped.",
      ];
      await expect(call(recovery)).rejects.toThrow();
      expect(await readFile(`${filename}.sqlite`)).toEqual(before);
      await call([...recovery, "--all-native-processing-confirmed-stopped"]);
      const result = JSON.parse(
        (await call(["--inspect", "--database-file", filename])).stdout,
      );
      expect(result.slot).toBeNull();
      expect(result.recoveryHistory).toHaveLength(1);
      expect(result.recoveryHistory[0].operator).toBe("fixture-operator");
      const recovered = await readFile(`${filename}.sqlite`);
      await expect(
        call([...recovery, "--all-native-processing-confirmed-stopped"]),
      ).rejects.toThrow();
      expect(await readFile(`${filename}.sqlite`)).toEqual(recovered);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quarantines a previously running native job when an older SQLite store gains the slot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-native-upgrade-")),
      filename = join(directory, "state.json");
    const before = new FileStore(filename);
    try {
      await before.transaction((s) => {
        s.gisJobs.push({
          id: "legacy-running",
          status: "running",
          workerId: "old-worker",
        } as import("./gis-jobs-types").GisJobRecord);
      });
      await before.close();
      const db = new DatabaseSync(`${filename}.sqlite`);
      db.prepare("DELETE FROM records WHERE collection='nativeCapacity'").run();
      db.close();
      const after = new FileStore(filename);
      try {
        expect(
          await after.read((s) => s.nativeCapacity.slot, {
            nativeCapacity: true,
          }),
        ).toMatchObject({
          kind: "gis",
          jobId: "legacy-running",
          status: "quarantined",
        });
      } finally {
        await after.close();
      }
    } finally {
      await before.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("admits only one service across independent durable connections and preserves quarantine across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-native-slot-"));
    const filename = join(directory, "state.json"),
      a = new FileStore(filename),
      b = new FileStore(filename);
    const now = Date.now();
    try {
      const leases = await Promise.all(
        [a, b].map((store, i) =>
          store.transaction(
            (s) =>
              acquireNativeCapacity(s, {
                kind: i ? "traffic" : "gis",
                jobId: `job-${i}`,
                workerId: `worker-${i}`,
                runMilliseconds: 60_000,
                now,
              }),
            { nativeCapacity: true },
          ),
        ),
      );
      expect(leases.filter(Boolean)).toHaveLength(1);
      const lease = leases.find(Boolean)!;
      const later = await b.transaction(
        (s) =>
          acquireNativeCapacity(s, {
            kind: "workforce",
            jobId: "third",
            workerId: "third",
            runMilliseconds: 660_000,
            now: now + 61_000,
          }),
        { nativeCapacity: true },
      );
      expect(later).toBeNull();
      await a.close();
      await b.close();
      const reopened = new FileStore(filename);
      try {
        const state = await reopened.read((s) => s.nativeCapacity, {
          nativeCapacity: true,
        });
        expect(state.slot).toMatchObject({
          token: lease.token,
          status: "quarantined",
        });
        await expect(
          reopened.transaction(
            (s) => heartbeatNativeCapacity(s, lease.token, now + 61_001),
            { nativeCapacity: true },
          ),
        ).rejects.toThrow("confirmed termination");
        await reopened.transaction(
          (s) =>
            recoverNativeCapacity(s, {
              token: lease.token,
              expectedRevision: state.revision,
              operator: "isolated-test",
              confirmation:
                "All isolated test native processes are confirmed stopped.",
              now: now + 62_000,
            }),
          { nativeCapacity: true },
        );
        const next = await reopened.transaction(
          (s) =>
            acquireNativeCapacity(s, {
              kind: "workforce",
              jobId: "third",
              workerId: "third",
              runMilliseconds: 660_000,
            }),
          { nativeCapacity: true },
        );
        expect(next?.token).not.toBe(lease.token);
        await expect(
          reopened.transaction(
            (s) =>
              releaseNativeCapacity(s, lease.token, { reason: "completed" }),
            { nativeCapacity: true },
          ),
        ).rejects.toThrow("no longer owns");
        expect(
          (
            await reopened.read((s) => s.nativeCapacity, {
              nativeCapacity: true,
            })
          ).recoveryHistory,
        ).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    } finally {
      await a.close();
      await b.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not extend hard deadlines with heartbeats and rolls back stale recovery", async () => {
    const store = new FileStore(),
      now = Date.now();
    try {
      const lease = await store.transaction(
        (s) =>
          acquireNativeCapacity(s, {
            kind: "traffic",
            jobId: "one",
            workerId: "worker",
            runMilliseconds: 180_000,
            now,
          }),
        { nativeCapacity: true },
      );
      await store.transaction(
        (s) => heartbeatNativeCapacity(s, lease!.token, now + 10_000),
        { nativeCapacity: true },
      );
      expect(
        (await store.read((s) => s.nativeCapacity, { nativeCapacity: true }))
          .slot?.hardDeadlineAt,
      ).toBe(lease!.hardDeadlineAt);
      await store.transaction(
        (s) =>
          quarantineNativeCapacity(
            s,
            lease!.token,
            "Native cancellation has not been confirmed.",
          ),
        { nativeCapacity: true },
      );
      await expect(
        store.transaction(
          (s) =>
            recoverNativeCapacity(s, {
              token: lease!.token,
              expectedRevision: 1,
              operator: "fixture",
              confirmation:
                "All native processing has been stopped and confirmed.",
            }),
          { nativeCapacity: true },
        ),
      ).rejects.toThrow("changed");
      expect(
        (await store.read((s) => s.nativeCapacity, { nativeCapacity: true }))
          .slot?.status,
      ).toBe("quarantined");
    } finally {
      await store.close();
    }
  });
});
