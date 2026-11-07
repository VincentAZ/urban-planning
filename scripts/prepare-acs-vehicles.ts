import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  downloadVehicleCache,
  vehicleCacheSchema,
  vehicleAvailabilityFromCache,
  type VehicleCache,
} from "../apps/api/src/data/acs-vehicles";

const directory = resolve(".local/cache/acs-vehicles-2024");
const output = resolve("public/data/acs-vehicles-2024.json");
await mkdir(directory, { recursive: true });
const existing = (await readdir(directory)).filter((name) =>
  /^B25046-zcta-[a-f0-9]{64}\.json$/.test(name),
);
if (existing.length > 1)
  throw new Error(
    "Several immutable vehicle caches exist. Select the intended vintage/source explicitly before publishing a new supplement.",
  );
let cache: VehicleCache;
if (existing.length)
  cache = vehicleCacheSchema.parse(
    JSON.parse(await readFile(resolve(directory, existing[0]), "utf8")),
  );
else {
  cache = await downloadVehicleCache();
  await writeFile(
    resolve(directory, `B25046-zcta-${cache.sourceFile.sha256}.json`),
    JSON.stringify(cache),
    { flag: "wx" },
  );
}
// Parse every published row before exposing the supplement; missing table geographies remain absent.
for (const zip of Object.keys(cache.rows))
  vehicleAvailabilityFromCache(cache, zip);
await mkdir(resolve("public/data"), { recursive: true });
await writeFile(`${output}.tmp`, JSON.stringify(cache));
await rename(`${output}.tmp`, output);
process.stdout.write(
  `Prepared ${Object.keys(cache.rows).length} household-vehicle ZCTA rows from ${cache.sourceFile.bytes} official source bytes. Existing place bundles were not changed. ${output}\n`,
);
