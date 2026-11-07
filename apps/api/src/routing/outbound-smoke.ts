/** Explicit operator check against the retained native graph; no downloads or state migration. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRoutingManifest, routingHash } from "./manifest.js";
import { ValhallaRouter } from "./valhalla.js";
import type { RoutingPosition } from "./types.js";

async function main() {
  if (!process.argv[2])
    throw new Error("Supply a new evidence output directory.");
  const output = resolve(process.argv[2]);
  await mkdir(output, { recursive: false });
  const manifest = await loadRoutingManifest(
    resolve(".local/routing/active/manifest.json"),
  );
  const router = new ValhallaRouter({
    baseUrl: "http://127.0.0.1:8002",
    manifest,
  });
  const startedAt = new Date().toISOString();
  const runs = [];
  for (const [name, site] of [
    ["downtown", [-112.074, 33.4484]],
    ["tempe", [-111.94, 33.425]],
  ] as [string, RoutingPosition][]) {
    for (const mode of ["car", "walk"] as const) {
      const started = performance.now();
      const matrix = await router.outboundMatrix({
        site,
        mode,
        destinations: [
          { id: "north", position: [site[0], site[1] + 0.01] },
          { id: "east", position: [site[0] + 0.01, site[1]] },
          { id: "tucson", position: [-110.9747, 32.2226] },
        ],
      });
      assert.equal(matrix.direction, "outbound");
      assert.equal(matrix.rows.length, 3);
      assert.equal(matrix.rows[2].status, "outside-threshold");
      assert.ok(
        matrix.rows.slice(0, 2).some((row) => row.status === "reachable"),
      );
      const contour = await router.outboundIsochrone({ site, mode });
      assert.equal(contour.direction, "outbound");
      assert.deepEqual(
        [
          ...new Set(
            contour.geometry.features.map((f) => f.properties?.contour),
          ),
        ].sort((a, b) => a - b),
        [15, 30, 45],
      );
      const artifact = { matrix, contour };
      await writeFile(
        resolve(output, `${name}-${mode}.json`),
        JSON.stringify(artifact) + "\n",
        { flag: "wx" },
      );
      runs.push({
        name,
        mode,
        milliseconds: performance.now() - started,
        sha256: routingHash(artifact),
        rows: matrix.rows,
      });
      console.log(
        JSON.stringify({ name, mode, milliseconds: runs.at(-1)!.milliseconds }),
      );
    }
  }
  const a: RoutingPosition = [-112.074, 33.4484],
    b: RoutingPosition = [-112.074, 33.46];
  const toA = await router.inboundMatrix({
    site: a,
    mode: "car",
    origins: [{ id: "b", position: b }],
  });
  const fromA = await router.outboundMatrix({
    site: a,
    mode: "car",
    destinations: [{ id: "b", position: b }],
  });
  const intoB = await router.inboundMatrix({
    site: b,
    mode: "car",
    origins: [{ id: "a", position: a }],
  });
  assert.notEqual(
    toA.rows[0].seconds,
    fromA.rows[0].seconds,
    "Directional Phoenix pair must differ",
  );
  assert.equal(
    fromA.rows[0].seconds,
    intoB.rows[0].seconds,
    "One-to-one outward matches the same actual inbound route",
  );
  const evidence = {
    startedAt,
    completedAt: new Date().toISOString(),
    manifestId: manifest.id,
    graphHash: manifest.graph.sha256,
    engine: manifest.engine,
    runs,
    directionCheck: {
      bToA: toA.rows[0],
      aToB: fromA.rows[0],
      sameRoute: intoB.rows[0],
    },
  };
  await writeFile(
    resolve(output, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      runs: runs.length,
      directionCheck: evidence.directionCheck,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
