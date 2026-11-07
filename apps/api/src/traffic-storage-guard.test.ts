import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyCommand,
  projectWithTrafficVersion,
  type HistoryEntry,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import { trafficScenarioFixture } from "../../../tests/fixtures/traffic";
import { emptyState, FileStore, type DataState } from "./store";
async function fixture() {
  const f = await trafficScenarioFixture(),
    state = emptyState(),
    traffic = { ...structuredClone(f.traffic), origin: "imported" as const },
    after = applyCommand(f.scenario, { type: "scenario.traffic", traffic });
  const entry: HistoryEntry = {
    id: "fixture-entry",
    at: "2026-11-06T00:00:00Z",
    actor: "fixture",
    label: "Imported experiment",
    command: { type: "scenario.traffic", traffic: structuredClone(traffic) },
    before: structuredClone(f.scenario),
    after: structuredClone(after),
  };
  state.projects = [
    {
      project: projectWithTrafficVersion({
        ...f.project,
        scenarios: [f.project.scenarios[0], after],
        history: [entry],
        undone: [structuredClone(entry)],
      }),
      baseline: f.place,
      organizationId: "fixture-org",
      version: 1,
      createdBy: "fixture-owner",
      createdAt: "2026-11-06T00:00:00Z",
    },
  ];
  return { ...f, state, traffic };
}
describe("SQLite project-owned traffic authority admission", () => {
  it("accepts only the exact completed project artifact and keeps its authority immutable", async () => {
    const f = await fixture(),
      store = new FileStore();
    const traffic = {
      ...structuredClone(f.traffic),
      origin: "server-run" as const,
    };
    try {
      await store.transaction((s) => {
        s.projects = structuredClone(f.state.projects);
        // A compact storage fixture, never presented as native execution evidence.
        s.trafficJobs.push({
          id: traffic.receipt.jobId,
          projectId: f.project.id,
          organizationId: "fixture-org",
          status: "completed",
          result: {
            artifactId: traffic.receipt.captureId,
            captureHash: traffic.captureHash,
            archive: traffic.capture.privateArchive,
          },
        } as import("./traffic/jobs-types").TrafficJobRecord);
        s.trafficArtifacts.push({
          id: traffic.receipt.captureId,
          projectId: f.project.id,
          organizationId: "fixture-org",
          jobId: traffic.receipt.jobId,
          scenarioId: f.scenario.id,
          configurationId: "fixture-config",
          createdAt: "2026-11-06T00:00:00Z",
          traffic,
        });
      });
      await store.transaction((s) => {
        s.projects[0].version++;
        s.projects[0].project.scenarios[1].traffic = traffic;
      });
      expect(
        await store.read((s) => s.projects[0].project.scenarios[1].traffic),
      ).toEqual(traffic);
      await expect(
        store.transaction((s) => {
          s.projects[0].version++;
          s.projects[0].project.scenarios[1].traffic!.capture.notes.push(
            "forged",
          );
        }),
      ).rejects.toThrow("completed immutable authority");
      await expect(
        store.transaction((s) => {
          s.trafficArtifacts[0].traffic.capture.notes.push("replacement");
        }),
      ).rejects.toThrow("immutable");
      await expect(
        store.transaction((s) => {
          s.trafficJobs[0].status = "queued";
        }),
      ).rejects.toThrow("immutable");
      await expect(
        store.transaction((s) => {
          const clone = structuredClone(s.projects[0]);
          clone.project.id = "different-project";
          s.projects.push(clone);
        }),
      ).rejects.toThrow("completed immutable authority");
    } finally {
      await store.close();
    }
  });
  it("rejects direct full writes at every current/history/undo/command location and rolls back the complete transaction", async () => {
    const f = await fixture(),
      store = new FileStore();
    try {
      await store.transaction((s) => {
        s.projects = structuredClone(f.state.projects);
      });
      for (const location of [
        "current",
        "history-before",
        "history-after",
        "history-command",
        "undone-before",
        "undone-after",
        "undone-command",
      ]) {
        await expect(
          store.transaction(
            (s) => {
              const record = s.projects[0],
                p = record.project,
                forged = {
                  ...structuredClone(f.traffic),
                  origin: "server-run" as const,
                };
              record.version++;
              if (location === "current") p.scenarios[1].traffic = forged;
              else {
                const [collection, part] = location.split("-") as [
                  "history" | "undone",
                  "before" | "after" | "command",
                ];
                if (part === "command")
                  p[collection][0].command = {
                    type: "scenario.traffic",
                    traffic: forged,
                  };
                else p[collection][0][part].traffic = forged;
              }
            },
            { projects: { all: true } },
          ),
        ).rejects.toThrow(/Traffic server-run admission/);
        expect(await store.read((s) => s.projects)).toEqual(f.state.projects);
      }
      await expect(
        store.transaction(
          (s) => {
            s.published.push({
              id: "forged-publication",
              organizationId: "fixture-org",
              projectId: f.project.id,
              projectName: "Fixture",
              placeId: f.place.id,
              baseline: f.place,
              scenario: {
                ...f.state.projects[0].project.scenarios[1],
                traffic: { ...f.traffic, origin: "server-run" },
              },
              results: calculateImpact(f.place, f.scenario),
              createdAt: "2026-11-06T00:00:00Z",
              feedbackEnabled: false,
            });
          },
          { published: { append: true } },
        ),
      ).rejects.toThrow(/Traffic server-run admission/);
      expect(await store.read((s) => s.published)).toEqual([]);
      await store.transaction(
        (s) => {
          s.projects[0].version++;
          s.projects[0].project.name = "Allowed imported edit";
        },
        { projects: { all: true } },
      );
      expect(
        await store.read((s) => s.projects[0].project.scenarios[1].traffic),
      ).toEqual(f.traffic);
    } finally {
      await store.close();
    }
  });
  it("preserves operator legacy migration and read evidence without silently changing original bytes or granting new writes", async () => {
    const f = await fixture(),
      directory = await mkdtemp(join(tmpdir(), "traffic-legacy-")),
      path = join(directory, "state.json"),
      legacy: DataState = structuredClone(f.state);
    legacy.projects[0].project.scenarios[1].traffic = structuredClone(
      f.traffic,
    );
    legacy.projects[0].project.scenarios[1].traffic!.origin = "server-run";
    const raw = JSON.stringify(legacy);
    await writeFile(path, raw, { mode: 0o600 });
    const store = new FileStore(path);
    try {
      expect(
        await store.read(
          (s) => s.projects[0].project.scenarios[1].traffic!.origin,
        ),
      ).toBe("server-run");
      expect(await readFile(path, "utf8")).toBe(raw);
      await expect(
        store.transaction(
          (s) => {
            s.projects[0].version++;
          },
          { projects: { all: true } },
        ),
      ).rejects.toThrow(/Traffic server-run admission/);
      expect(await readFile(path, "utf8")).toBe(raw);
      expect(await store.read((s) => s.projects[0].version)).toBe(1);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
