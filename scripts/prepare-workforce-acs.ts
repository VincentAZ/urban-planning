import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readWorkforceAcsSummary,
  workforceSummaryUrl,
  WORKFORCE_ACS_MAX_FILE_BYTES,
  type WorkforceAcsTable,
} from "../apps/api/src/data/workforce-acs";

// Operator CLI, deliberately separate from visitor requests and provider credentials.
const state = process.argv[2] ?? "04";
if (!/^\d{2}$/.test(state))
  throw new Error(
    "Usage: tsx scripts/prepare-workforce-acs.ts [two-digit state FIPS]",
  );
const directory = resolve(".local/workforce/acs-2024");
await mkdir(directory, { recursive: true });
const maxDownloadBytes = 400_000_000;
let downloadedBytes = 0;
const lockPath = resolve(directory, ".prepare.lock");
const lock = await open(lockPath, "wx", 0o600).catch((error) => {
  if ((error as NodeJS.ErrnoException).code === "EEXIST")
    throw new Error(
      "Census preparation is already locked. If a prior operator process stopped, inspect its lock before removing it and retrying.",
    );
  throw error;
});
await lock.writeFile(
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
);
try {
  for (const table of ["B15003", "C24010"] as WorkforceAcsTable[]) {
    const file = resolve(directory, `${table}.dat`);
    const receiptPath = `${file}.receipt.json`;
    let receipt:
      | { url: string; sha256: string; bytes: number; retrievedAt: string }
      | undefined;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!receipt) {
      // Refuse to overwrite a raw file without its receipt: partial downloads use unique .part files.
      try {
        await open(file, "r").then((handle) => handle.close());
        throw new Error(
          `${table}: existing source has no receipt; inspect it before preparing again.`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const url = workforceSummaryUrl(table);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(300_000),
        redirect: "error",
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent":
            "UrbanPlanning/0.1 (bounded official Census source preparation)",
        },
      });
      if (!response.ok || !response.body)
        throw new Error(
          `${table}: Census download returned HTTP ${response.status}.`,
        );
      const expected = Number(response.headers.get("content-length"));
      const encoding = response.headers.get("content-encoding");
      if (
        (encoding && encoding !== "identity") ||
        expected > WORKFORCE_ACS_MAX_FILE_BYTES ||
        expected + downloadedBytes > maxDownloadBytes
      ) {
        await response.body.cancel();
        throw new Error(
          "Census download exceeds the byte budget or has an unexpected content encoding.",
        );
      }
      const temporary = `${file}.${process.pid}.part`;
      const handle = await open(temporary, "wx", 0o600);
      const reader = response.body.getReader();
      const retrievedAt = new Date().toISOString();
      const input = async function* () {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            downloadedBytes += chunk.value.byteLength;
            if (downloadedBytes > maxDownloadBytes)
              throw new Error("Census downloads exceed the 400 MB run budget.");
            await handle.writeFile(chunk.value);
            yield chunk.value;
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      };
      try {
        const subset = await readWorkforceAcsSummary(input(), table, state, {
          retrievedAt,
        });
        if (expected && subset.source.bytes !== expected)
          throw new Error("Incomplete Census source download.");
        await handle.sync();
        await handle.close();
        await rename(temporary, file);
        await writeFile(
          `${receiptPath}.tmp`,
          JSON.stringify(subset.source, null, 2),
        );
        await rename(`${receiptPath}.tmp`, receiptPath);
        receipt = subset.source;
        console.log(
          `${table}: downloaded ${subset.source.bytes} bytes; ${Object.keys(subset.rows).length} state block groups.`,
        );
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(temporary, { force: true });
        throw error;
      }
    }
    if (
      receipt.url !== workforceSummaryUrl(table) ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes > WORKFORCE_ACS_MAX_FILE_BYTES
    )
      throw new Error(`${table}: invalid source receipt.`);
    const subset = await readWorkforceAcsSummary(
      createReadStream(file),
      table,
      state,
      { retrievedAt: receipt.retrievedAt },
    );
    if (
      subset.source.sha256 !== receipt.sha256 ||
      subset.source.bytes !== receipt.bytes
    )
      throw new Error(
        `${table}: cached source bytes differ from the captured receipt.`,
      );
    const output = resolve(directory, `${table}-${state}.json`);
    await writeFile(`${output}.tmp`, JSON.stringify(subset));
    await rename(`${output}.tmp`, output);
    console.log(
      `${table}: verified ${Object.keys(subset.rows).length} native rows; SHA-256 ${subset.source.sha256}.`,
    );
  }
} finally {
  await lock.close();
  await rm(lockPath, { force: true });
}
