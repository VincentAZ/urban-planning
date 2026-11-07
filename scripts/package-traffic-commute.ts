import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { loadPreparedTrafficNetwork } from "../apps/api/src/traffic/runtime.js";
import { packageTrafficCommutePreset } from "../apps/api/src/traffic/commute-evidence.js";
import { trafficCommuteCorrespondenceInputSchema } from "../apps/api/src/traffic/commute-proof.js";

const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3)
  throw new Error("Usage: tsx scripts/package-traffic-commute.ts CONFIG.json");
if ((await stat(configPath)).size > 16 * 1024)
  throw new Error("The operator package configuration exceeds 16 KiB.");
const path = z.string().min(1).max(2000);
const config = z
  .object({
    presetId: z.string().min(1).max(160),
    networkDirectory: path,
    outputDirectory: path,
    sourcePackPath: path,
    priorPath: path,
    routesPath: path,
    compilationPath: path,
    reconciliationPath: path,
    regionalProofDirectory: path,
    correspondence: trafficCommuteCorrespondenceInputSchema.optional(),
  })
  .strict()
  .parse(JSON.parse(await readFile(configPath, "utf8")));
const base = dirname(resolve(configPath));
const input = {
  presetId: config.presetId,
  outputDirectory: resolve(base, config.outputDirectory),
  sourcePackPath: resolve(base, config.sourcePackPath),
  priorPath: resolve(base, config.priorPath),
  routesPath: resolve(base, config.routesPath),
  compilationPath: resolve(base, config.compilationPath),
  reconciliationPath: resolve(base, config.reconciliationPath),
  regionalProofDirectory: resolve(base, config.regionalProofDirectory),
  ...(config.correspondence ? { correspondence: config.correspondence } : {}),
};
const prepared = await loadPreparedTrafficNetwork(
  resolve(base, config.networkDirectory),
);
const receipt = await packageTrafficCommutePreset({
  ...input,
  network: prepared.network,
});
const receiptPath = resolve(
  input.outputDirectory,
  "commute-package-receipt.json",
);
// Package files are immutable; this reproducible receipt is outside their manifest.
const receiptBytes = JSON.stringify(receipt, null, 2) + "\n";
try {
  await writeFile(receiptPath, receiptBytes, { flag: "wx", mode: 0o600 });
} catch (error) {
  if (
    (error as NodeJS.ErrnoException).code !== "EEXIST" ||
    (await readFile(receiptPath, "utf8")) !== receiptBytes
  )
    throw error;
}
console.log(
  JSON.stringify({
    presetId: receipt.presetId,
    manifestHash: receipt.manifestHash,
    evidenceFile: receipt.evidenceFile,
    receiptPath,
  }),
);
