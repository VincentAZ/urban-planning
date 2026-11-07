import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ACS_SUMMARY_BASE,
  ACS_SUMMARY_COLUMNS,
  ACS_SUMMARY_TABLES,
  summaryCommunityProfile,
  type AcsSummaryCache,
} from "../apps/api/src/data/acs-summary";

const cacheDirectory = resolve(".local/cache/acs-2024");
const output = resolve("public/data/acs-2024-zcta.json");
const downloadLimit = 250_000_000;
let downloadedBytes = 0;
interface TableSubset {
  table: string;
  url: string;
  sha256: string;
  retrievedAt: string;
  bytes: number;
  columns: string[];
  rows: Record<string, (string | null)[]>;
}
await mkdir(cacheDirectory, { recursive: true });
const subsets: TableSubset[] = [];
for (const [table, cells] of Object.entries(ACS_SUMMARY_TABLES)) {
  const columns = cells.flatMap((cell) => [
    `${table}_E${cell}`,
    `${table}_M${cell}`,
  ]);
  const filename = resolve(cacheDirectory, `${table}.json`);
  try {
    const cached = JSON.parse(await readFile(filename, "utf8")) as TableSubset;
    if (
      cached.table !== table ||
      cached.columns.join("|") !== columns.join("|") ||
      !/^[a-f0-9]{64}$/.test(cached.sha256)
    )
      throw new Error(
        `Invalid existing ${table} cache. Remove that cache explicitly before retrying.`,
      );
    subsets.push(cached);
    console.log(
      `${table}: reused ${Object.keys(cached.rows).length} ZCTA rows`,
    );
    continue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = `${ACS_SUMMARY_BASE}acsdt5y2024-${table.toLowerCase()}.dat`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body)
    throw new Error(
      `${table}: official download failed with HTTP ${response.status}`,
    );
  const expectedBytes = Number(response.headers.get("content-length"));
  if (expectedBytes > 0 && downloadedBytes + expectedBytes > downloadLimit) {
    await response.body.cancel();
    throw new Error(
      "Selected downloads would exceed the 250 MB preparation cap.",
    );
  }
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const subset: TableSubset = {
    table,
    url,
    sha256: "",
    retrievedAt: new Date().toISOString(),
    bytes: 0,
    columns,
    rows: {},
  };
  let remainder = "";
  let indices: number[] | undefined;
  let width = 0;
  const line = (text: string) => {
    text = text.replace(/\r$/, "");
    if (!text) return;
    if (!indices) {
      const header = text.replace(/^\uFEFF/, "").split("|");
      width = header.length;
      if (header[0] !== "GEO_ID")
        throw new Error(`${table}: unexpected header`);
      indices = columns.map((column) => {
        const index = header.indexOf(column);
        if (index < 0) throw new Error(`${table}: missing ${column}`);
        return index;
      });
      return;
    }
    if (!text.startsWith("860Z200US")) return;
    const fields = text.split("|");
    const zip = fields[0].slice(9);
    if (!/^\d{5}$/.test(zip) || fields.length !== width || subset.rows[zip])
      throw new Error(`${table}: invalid or duplicate ZCTA row`);
    subset.rows[zip] = indices.map((index) =>
      fields[index] === "" ? null : fields[index],
    );
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      downloadedBytes += chunk.value.byteLength;
      subset.bytes += chunk.value.byteLength;
      if (downloadedBytes > downloadLimit)
        throw new Error(
          "Official downloads exceeded the 250 MB preparation cap.",
        );
      hash.update(chunk.value);
      remainder += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = remainder.indexOf("\n")) >= 0) {
        line(remainder.slice(0, end));
        remainder = remainder.slice(end + 1);
      }
    }
    remainder += decoder.decode();
    if (remainder) line(remainder);
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  if (expectedBytes && expectedBytes !== subset.bytes)
    throw new Error(`${table}: incomplete download`);
  if (Object.keys(subset.rows).length < 30000)
    throw new Error(`${table}: missing national ZCTA coverage`);
  subset.sha256 = hash.digest("hex");
  await writeFile(`${filename}.tmp`, JSON.stringify(subset));
  await rename(`${filename}.tmp`, filename);
  subsets.push(subset);
  console.log(
    `${table}: ${subset.bytes} bytes, ${Object.keys(subset.rows).length} ZCTA rows`,
  );
}
const rows: AcsSummaryCache["rows"] = {};
for (const zip of Object.keys(subsets[0].rows).sort())
  rows[zip] = subsets.flatMap(
    (subset) => subset.rows[zip] ?? subset.columns.map(() => null),
  );
const cache: AcsSummaryCache = {
  schemaVersion: 1,
  vintage: 2024,
  retrievedAt: new Date().toISOString(),
  columns: ACS_SUMMARY_COLUMNS,
  sourceFiles: subsets.map(({ table, url, sha256, retrievedAt }) => ({
    table,
    url,
    sha256,
    retrievedAt,
  })),
  rows,
};
// Validate the requested live examples before publishing the reusable subset cache.
for (const zip of ["85004", "60601"]) {
  const profile = summaryCommunityProfile(cache, zip);
  console.log(
    JSON.stringify({
      zip,
      estimates: Object.fromEntries(
        Object.entries(profile.measures).map(([key, measure]) => [
          key,
          {
            estimate: measure.estimate.value,
            moe: measure.marginOfError.value,
            derived: !!measure.method,
          },
        ]),
      ),
    }),
  );
}
await mkdir(resolve("public/data"), { recursive: true });
await writeFile(`${output}.tmp`, JSON.stringify(cache));
await rename(`${output}.tmp`, output);
console.log(
  `Prepared ${Object.keys(rows).length} ZCTAs; ${downloadedBytes} downloaded bytes; ${output}`,
);
