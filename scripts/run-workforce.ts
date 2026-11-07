import { readFile, mkdir, stat, open, link, rm } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { workforceContentHash, type WorkforceCohortPack } from "@urban/core";
import { loadRoutingManifest, ValhallaRouter } from "../apps/api/src/routing";
import { verifyPreparedWorkforceBoundary } from "../apps/api/src/data/workforce-boundary";
import { runCapturedWorkforce } from "../apps/api/src/workforce-runner";

const [packFile, boundaryFile, lonText, latText, mode] = process.argv.slice(2);
if (
  !packFile ||
  !boundaryFile ||
  !lonText ||
  !latText ||
  !["car", "walk"].includes(mode)
)
  throw new Error(
    "Usage: tsx scripts/run-workforce.ts <cohort pack JSON> <Census boundary JSON> <longitude> <latitude> <car|walk>",
  );
async function readBounded(path: string, limit: number) {
  if ((await stat(path)).size > limit)
    throw new Error("Workforce evidence exceeds its local read limit.");
  return JSON.parse(await readFile(path, "utf8"));
}
const pack = (await readBounded(packFile, 250_000_000)) as WorkforceCohortPack;
const packHash = await workforceContentHash(pack);
if (basename(packFile) !== `${packHash}.json`)
  throw new Error("Cohort evidence differs from its captured content hash.");
const boundary = await verifyPreparedWorkforceBoundary(boundaryFile);
const manifest = await loadRoutingManifest(
  resolve(".local/routing/active/manifest.json"),
);
const router = new ValhallaRouter({
  baseUrl: "http://127.0.0.1:8002",
  manifest,
});
const controller = new AbortController();
const cancel = () =>
  controller.abort(new Error("Operator cancelled workforce processing."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const output = await runCapturedWorkforce({
    pack,
    boundary,
    router,
    request: {
      site: [Number(lonText), Number(latText)],
      mode: mode as "car" | "walk",
      direction: "inbound",
      thresholdsMinutes: [15, 30, 45],
    },
    signal: controller.signal,
    onProgress: (stage) => console.log(`${new Date().toISOString()} ${stage}`),
  });
  const hash = await workforceContentHash(output);
  const directory = resolve(".local/workforce/runs");
  await mkdir(directory, { recursive: true });
  const filename = resolve(directory, `${hash}.json`);
  const temporary = `${filename}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(output));
    await handle.sync();
    await handle.close();
    // A complete result is made visible only after routing, aggregation and contour validation.
    await link(temporary, filename);
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
  console.log(
    JSON.stringify({
      path: filename,
      hash,
      inputHash: output.run.inputHash,
      metrics: output.metrics,
      coverage: output.result.coverage,
      panels: output.result.panels.map((panel) => ({
        label: panel.label,
        universe: panel.universe,
        thresholds: panel.thresholds.map((row) => ({
          minutes: row.minutes,
          estimate: row.total.estimate,
          knownSubtotal: row.total.knownSubtotal,
          status: row.total.status,
          missingUnits: row.total.missingUnitGeoids.length,
          unresolvedAllocationUnits:
            row.total.unresolvedAllocationUnitGeoids.length,
        })),
      })),
    }),
  );
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
