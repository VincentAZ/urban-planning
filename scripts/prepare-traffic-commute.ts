import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  COMMUTE_SOURCE_LIMITS,
  COMMUTE_SOURCE_URLS,
  verifyCommuteSource,
} from "../apps/api/src/data/traffic-commute-sources";
import { prepareTrafficCommuteSources } from "../apps/api/src/data/traffic-commute";

// Explicit operator preparation; no credentials, API state, routing service, or visitor request is used.
const args = process.argv.slice(2);
const allowed = [
  "--sources",
  "--output",
  "--blocks",
  "--blocks-sha256",
  "--tracts",
  "--download",
];
const values = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!allowed.includes(key) || values.has(key))
    throw new Error(`Unknown or repeated option ${key}.`);
  if (key === "--download") values.set(key, "true");
  else {
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}.`);
    values.set(key, value);
  }
}
if (
  !["--blocks", "--blocks-sha256", "--tracts"].every((key) => values.has(key))
)
  throw new Error(
    "Usage: tsx scripts/prepare-traffic-commute.ts --blocks <verified-workforce-blocks.json> --blocks-sha256 <sha256> --tracts <comma-separated-native-tracts> [--download] [--sources directory] [--output directory]",
  );
const sourceDirectory = resolve(
  values.get("--sources") ?? ".local/traffic/commute-sources",
);
const outputDirectory = resolve(
  values.get("--output") ?? ".local/traffic/commute-prepared",
);
await mkdir(sourceDirectory, { recursive: true });
const lockPath = resolve(sourceDirectory, ".prepare.lock");
const lock = await open(lockPath, "wx", 0o600).catch(() => {
  throw new Error(
    "Commute preparation is locked; inspect any interrupted operator process before recovery.",
  );
});
await lock.writeFile(
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
);
try {
  const inputs: [string, string][] = Object.entries(COMMUTE_SOURCE_URLS);
  for (const [name, url] of Object.entries(COMMUTE_SOURCE_URLS))
    if (name.endsWith(".csv.gz"))
      inputs.push([
        name.replace(/\.gz$/, ".sha256sum"),
        url.replace(/\.gz$/, ".sha256sum"),
      ]);
  let totalBytes = 0,
    downloadedBytes = 0;
  for (const [name, url] of inputs) {
    const destination = resolve(sourceDirectory, name);
    const exists = await access(destination).then(
      () => true,
      () => false,
    );
    if (!exists) {
      if (!values.has("--download"))
        throw new Error(
          `${name} is absent. Use --download for bounded official public acquisition.`,
        );
      // A receipt without its raw source is also an interrupted state, not permission to replace evidence.
      if (
        await access(`${destination}.receipt.json`).then(
          () => true,
          () => false,
        )
      )
        throw new Error("Orphan source receipt requires operator inspection.");
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(300_000),
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent":
            "UrbanPlanning bounded official Census source preparation",
        },
      });
      const lengthHeader = response.headers.get("content-length"),
        length = lengthHeader === null ? null : Number(lengthHeader);
      if (
        !response.ok ||
        !response.body ||
        (response.headers.get("content-encoding") &&
          response.headers.get("content-encoding") !== "identity") ||
        (length !== null &&
          (!Number.isSafeInteger(length) ||
            length < 1 ||
            totalBytes + length > COMMUTE_SOURCE_LIMITS.downloadBytes))
      ) {
        await response.body?.cancel();
        throw new Error(
          "Official commute source response is invalid or exceeds the256MiB acquisition budget.",
        );
      }
      const temporary = `${destination}.${randomUUID()}.part`,
        handle = await open(temporary, "wx", 0o600),
        hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          if (totalBytes + bytes > COMMUTE_SOURCE_LIMITS.downloadBytes)
            throw new Error("Commute source acquisition exceeds256MiB.");
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        if (!bytes || (length !== null && bytes !== length))
          throw new Error("Incomplete official source download.");
        await handle.sync();
        await handle.close();
        await link(temporary, destination);
        const receipt = await open(`${destination}.receipt.json`, "wx", 0o600);
        try {
          await receipt.writeFile(
            JSON.stringify(
              {
                url,
                bytes,
                sha256: hash.digest("hex"),
                retrievedAt: new Date().toISOString(),
                lastModified: response.headers.get("last-modified"),
                etag: response.headers.get("etag"),
              },
              null,
              2,
            ),
          );
          await receipt.sync();
        } finally {
          await receipt.close();
        }
        downloadedBytes += bytes;
      } finally {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true });
      }
    }
    const source = await verifyCommuteSource(sourceDirectory, name, url);
    totalBytes += source.receipt.bytes;
    if (totalBytes > COMMUTE_SOURCE_LIMITS.downloadBytes)
      throw new Error(
        "Retained commute sources exceed the declared256MiB pack budget.",
      );
  }
  const result = await prepareTrafficCommuteSources({
    sourceDirectory,
    outputDirectory,
    blocksFile: resolve(values.get("--blocks")!),
    blocksSha256: values.get("--blocks-sha256")!,
    residentTractGeoids: values.get("--tracts")!.split(","),
  });
  console.log(
    JSON.stringify(
      {
        artifact: result.artifact,
        reconciliation: result.reconciliation,
        sourceBytes: totalBytes,
        downloadedBytes,
        cohort: result.prepared.coverage,
        rows: {
          tracts: result.prepared.tracts.length,
          residences: result.prepared.residences.length,
          workplaces: result.prepared.workplaces.length,
          flows: result.prepared.flows.length,
          blocks: result.prepared.blocks.length,
        },
        statewide: result.prepared.reconciliation,
      },
      null,
      2,
    ),
  );
} finally {
  await lock.close();
  await rm(lockPath);
}
