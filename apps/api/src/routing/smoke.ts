/** Explicit operator smoke against the prepared native service; never run by a visitor. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadRoutingManifest } from "./manifest.js";
import { ValhallaRouter } from "./valhalla.js";
import type { RoutingPosition } from "./types.js";

async function main() {
  const output = resolve(process.argv[2] ?? ".local/qa/routing/native");
  await mkdir(output, { recursive: true });
  const manifestPath = resolve(".local/routing/active/manifest.json");
  const manifest = await loadRoutingManifest(manifestPath);
  const router = new ValhallaRouter({
    baseUrl: "http://127.0.0.1:8002",
    manifest,
  });
  const sites: [string, RoutingPosition][] = [
    ["downtown", [-112.074, 33.4484]],
    ["tempe", [-111.94, 33.425]],
  ];
  const startedAt = new Date().toISOString();
  const results = [];
  for (const [name, site] of sites) {
    for (const mode of ["car", "walk"] as const) {
      const started = performance.now();
      const matrix = await router.inboundMatrix({
        site,
        mode,
        origins: [
          { id: "north", position: [site[0], site[1] + 0.01] },
          { id: "east", position: [site[0] + 0.01, site[1]] },
          { id: "tucson", position: [-110.9747, 32.2226] },
        ],
      });
      assert.equal(matrix.rows.length, 3);
      assert.equal(matrix.rows[2].status, "outside-threshold");
      assert.ok(matrix.rows.slice(0, 2).some((r) => r.status === "reachable"));
      const contours = await router.inboundIsochrone({ site, mode });
      assert.deepEqual(
        [
          ...new Set(
            contours.geometry.features.map((f) => f.properties?.contour),
          ),
        ].sort((a, b) => a - b),
        [15, 30, 45],
      );
      await writeFile(
        resolve(output, `${name}-${mode}.json`),
        JSON.stringify({ matrix, contours }, null, 2) + "\n",
      );
      results.push({
        site: name,
        mode,
        milliseconds: performance.now() - started,
        rows: matrix.rows,
        contourFeatures: contours.geometry.features.length,
      });
    }
  }
  const a: RoutingPosition = [-112.074, 33.4484],
    b: RoutingPosition = [-112.074, 33.46];
  const inbound = await router.inboundMatrix({
    site: a,
    mode: "car",
    origins: [{ id: "b", position: b }],
  });
  const outbound = await router.inboundMatrix({
    site: b,
    mode: "car",
    origins: [{ id: "a", position: a }],
  });
  assert.notEqual(
    inbound.rows[0].seconds,
    outbound.rows[0].seconds,
    "Directional native routes should differ for this verified Phoenix pair",
  );
  const unsnappable = await router.inboundMatrix({
    site: a,
    mode: "car",
    origins: [{ id: "saguaro-lake", position: [-111.527, 33.565] }],
  });
  const manifestBytes = await readFile(manifestPath);
  const proof = {
    startedAt,
    completedAt: new Date().toISOString(),
    manifestId: manifest.id,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    graphHash: manifest.graph.sha256,
    engine: manifest.engine,
    build: manifest.build,
    results,
    directionCheck: { bToA: inbound.rows[0], aToB: outbound.rows[0] },
    lakeCheck: unsnappable.rows[0],
    limitations: manifest.limitations,
  };
  await writeFile(
    resolve(output, "evidence.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      output,
      manifestId: manifest.id,
      runs: results.length,
      directionCheck: proof.directionCheck,
      lakeCheck: proof.lakeCheck,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
