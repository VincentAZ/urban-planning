/** Trusted one-time source preparation; normal visitor requests use the authenticated durable queue. */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { CensusPlaces } from "./data/census-places.js";
import { PlaceCatalog } from "./places.js";
import { prepareZcta } from "./national-preparation.js";

if (existsSync(".env")) loadEnvFile(".env");
const [mode, ...zips] = process.argv.slice(2);
if (
  mode !== "--live" ||
  !zips.length ||
  zips.length > 3 ||
  zips.some((zip) => !/^\d{5}$/.test(zip))
)
  throw new Error(
    "Usage: corepack pnpm exec tsx apps/api/src/national-prepare-cli.ts --live 85004 [60601]. Maximum three explicit ZIP areas.",
  );
const catalog = new PlaceCatalog();
const census = new CensusPlaces();
for (const [index, zip] of zips.entries()) {
  if (index) await new Promise((resolve) => setTimeout(resolve, 60_000));
  try {
    const result = await prepareZcta(zip, {
      census,
      signal: AbortSignal.timeout(180_000),
      progress: async (stage, progress) => {
        process.stdout.write(JSON.stringify({ zip, stage, progress }) + "\n");
      },
    });
    const identity = await catalog.put(result.place, result.source);
    process.stdout.write(
      JSON.stringify({
        zip,
        status: "completed",
        placeId: result.place.id,
        identity,
        buildings: result.place.buildings.length,
        roads: result.place.roads.length,
        warnings: result.warnings,
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        zip,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        details: (error as { details?: unknown }).details,
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
