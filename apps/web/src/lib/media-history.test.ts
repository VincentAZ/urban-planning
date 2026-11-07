import { expect, it } from "vitest";
import type { MediaJob } from "./media-api";
import { mergeMediaHistory } from "./media-history";
const job = (id: string, createdAt: string, version = 1) =>
  ({
    id,
    projectId: "p",
    scenarioId: "s",
    createdAt,
    version,
    status: "queued",
  }) as MediaJob;
it("retains every page beyond100 with deterministic ties and no duplicate job IDs", () => {
  const rows = Array.from({ length: 105 }, (_, i) =>
    job(`job-${String(i).padStart(3, "0")}`, "2026-11-06T00:00:00.000Z"),
  );
  const first = mergeMediaHistory([], rows.slice(5), "p", "s");
  const all = mergeMediaHistory(first, rows.slice(0, 6), "p", "s");
  expect(all).toHaveLength(105);
  expect(all[0].id).toBe("job-104");
  expect(all.at(-1)!.id).toBe("job-000");
});
it("does not downgrade the selected/live job when an older page overlaps it", () => {
  const selected = {
    ...job("same", "2026-11-06T00:00:00.000Z", 7),
    status: "completed" as const,
  };
  const merged = mergeMediaHistory(
    [selected],
    [
      job("same", selected.createdAt, 2),
      job("older", "2026-11-05T00:00:00.000Z"),
    ],
    "p",
    "s",
  );
  expect(merged.find((item) => item.id === selected.id)).toBe(selected);
  expect(merged[0].status).toBe("completed");
});
it("rejects cross-project or cross-scenario pages rather than exposing or silently mixing them", () => {
  expect(() =>
    mergeMediaHistory(
      [],
      [{ ...job("x", "now"), projectId: "another" }],
      "p",
      "s",
    ),
  ).toThrow("different project or scenario");
  expect(() =>
    mergeMediaHistory(
      [],
      [{ ...job("x", "now"), scenarioId: "another" }],
      "p",
      "s",
    ),
  ).toThrow("different project or scenario");
});
