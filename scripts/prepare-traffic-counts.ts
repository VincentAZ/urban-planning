import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  lstat,
  link,
  rm,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJSON } from "../packages/core/src/index";
import {
  fhwaCountPack,
  readFhwaStations,
  readFhwaVolumes,
  FHWA_TRAFFIC_INDEX,
} from "../apps/api/src/data/traffic-fhwa";
import type { TrafficFileReference } from "../packages/core/src/traffic";

// Operator-only preparation. Visitor requests never download national archives.
const { values } = parseArgs({
  options: {
    state: { type: "string" },
    "state-fips": { type: "string" },
    date: { type: "string" },
    stations: { type: "string" },
    timezone: { type: "string" },
    "utc-offset-minutes": { type: "string" },
    "clock-basis": { type: "string" },
    directory: { type: "string", default: ".local/traffic" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Prepare retained FHWA 2025 observations: --state AZ --state-fips 04 --date 2025-10-02 --stations 104009 --timezone America/Phoenix --utc-offset-minutes=-420 --clock-basis 'Reviewed source local-clock interpretation' [--directory .local/traffic]\n",
  );
  process.exit(0);
}
const state = values.state ?? "",
  stateFips = values["state-fips"] ?? "",
  date = values.date ?? "",
  stationIds = (values.stations ?? "").split(",").filter(Boolean),
  timeZone = values.timezone ?? "",
  utcOffsetMinutes = Number(values["utc-offset-minutes"]),
  timeInterpretationSource = values["clock-basis"] ?? "";
if (
  !/^[A-Z]{2}$/.test(state) ||
  !/^\d{2}$/.test(stateFips) ||
  !/^2025-\d{2}-\d{2}$/.test(date) ||
  !stationIds.length ||
  !timeZone ||
  !Number.isInteger(utcOffsetMinutes) ||
  !timeInterpretationSource.trim()
)
  throw new Error(
    "Supply an explicit 2025 date, state/FIPS, station IDs, IANA timezone, UTC offset and clock interpretation. See --help.",
  );
const month = Number(date.slice(5, 7));
if (
  month < 1 ||
  month > 12 ||
  new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
)
  throw new Error("Choose a valid 2025 calendar date.");
const monthName = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
][month - 1];
const directory = resolve(values.directory!),
  sourceDirectory = resolve(directory, "sources");
await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
const sourceFiles = await readdir(sourceDirectory);
let storedBytes = (
  await Promise.all(
    sourceFiles.map(async (name) => {
      const info = await lstat(resolve(sourceDirectory, name));
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(
          "Retained traffic sources contain an unexpected entry.",
        );
      return info;
    }),
  )
).reduce((n, s) => n + s.size, 0);
if (storedBytes > 2_000_000_000)
  throw new Error(
    "Retained traffic sources exceed 2 GB. Review/archive existing evidence before adding files.",
  );
const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
async function immutable(path: string, bytes: Buffer | string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.pending`,
    handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !Buffer.from(bytes).equals(await readFile(path))
      )
        throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Refusing a linked or non-file evidence destination.");
    }
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
async function capture(
  name: string,
  cap: number,
): Promise<TrafficFileReference & { path: string }> {
  const url = `${FHWA_TRAFFIC_INDEX}2025/${name}`,
    path = resolve(sourceDirectory, name),
    receiptPath = `${path}.json`;
  let exists = false;
  try {
    await stat(path);
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (exists) {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      receipt.url !== url ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes <= 0 ||
      receipt.bytes > cap ||
      receipt.bytes !== (await stat(path)).size ||
      receipt.sha256 !== (await hashFile(path)) ||
      !Number.isFinite(Date.parse(receipt.retrievedAt))
    )
      throw new Error(
        "Retained traffic source/receipt mismatch; original evidence was not replaced.",
      );
    return { ...receipt, sourceId: "pending", path };
  }
  try {
    await stat(receiptPath);
    throw new Error("Orphan traffic source receipt requires operator review.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(180000),
    headers: {
      "User-Agent": "UrbanPlanning/0.1 (bounded operator source preparation)",
    },
  });
  if (!response.ok || !response.body)
    throw new Error(`FHWA download returned HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) > cap) {
    await response.body.cancel();
    throw new Error("FHWA archive exceeds its byte cap.");
  }
  const temporary = `${path}.${randomUUID()}.pending`,
    handle = await open(temporary, "wx", 0o600),
    digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > cap || storedBytes + bytes > 2_000_000_000)
        throw new Error("FHWA archive exceeds its bounded retained size.");
      digest.update(chunk);
      await handle.writeFile(chunk);
    }
    if (!bytes) throw new Error("FHWA source was empty.");
    await handle.sync();
    await handle.close();
    const receipt = {
      url,
      retrievedAt: new Date().toISOString(),
      bytes,
      sha256: digest.digest("hex"),
    };
    await link(temporary, path);
    storedBytes += bytes;
    await immutable(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    return { ...receipt, sourceId: "pending", path };
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
async function member(
  source: Awaited<ReturnType<typeof capture>>,
  name: string,
) {
  const path = resolve(
    directory,
    "members",
    source.sha256,
    name.replaceAll("/", "_"),
  );
  const script = fileURLToPath(
    new URL("./traffic-counts-archive.py", import.meta.url),
  );
  const { stdout } = await promisify(execFile)(
    "python3",
    [script, "--archive", source.path, "--member", name, "--output", path],
    { timeout: 60000, maxBuffer: 16384 },
  );
  const metadata = JSON.parse(stdout);
  if (
    metadata.member !== name ||
    metadata.bytes !== (await stat(path)).size ||
    metadata.sha256 !== (await hashFile(path))
  )
    throw new Error(
      "Extracted source integrity did not match the archive receipt.",
    );
  const reference: TrafficFileReference = {
    sourceId: "pending",
    url: `${source.url}#member=${encodeURIComponent(name)}`,
    sha256: metadata.sha256,
    bytes: metadata.bytes,
    retrievedAt: source.retrievedAt,
  };
  await immutable(`${path}.json`, JSON.stringify(reference, null, 2) + "\n");
  return { reference, path };
}
const stationArchive = await capture("2025_station_data.zip", 16_000_000),
  volumeArchive = await capture(
    `${monthName.toLowerCase()}_2025_ccs_data.zip`,
    128_000_000,
  ),
  stationFile = await member(
    stationArchive,
    `Station/${state}_2025 (TMAS).STA`,
  ),
  volumeFile = await member(
    volumeArchive,
    `${state}_${monthName}_2025 (TMAS).VOL`,
  );
const stations = await readFhwaStations(createReadStream(stationFile.path), {
    stateFips,
    year: 2025,
    stationIds,
  }),
  volumes = await readFhwaVolumes(createReadStream(volumeFile.path), {
    stateFips,
    year: 2025,
    month,
    stationIds,
    dates: [date],
  });
if (
  stations.sha256 !== stationFile.reference.sha256 ||
  volumes.sha256 !== volumeFile.reference.sha256
)
  throw new Error("Source changed while parsing.");
const references = [stationArchive, volumeArchive].map(
  ({ path: _path, ...ref }) => ref,
);
const pack = fhwaCountPack(
  stations,
  volumes,
  {
    stateFips,
    year: 2025,
    month,
    date,
    stationIds,
    timeZone,
    utcOffsetMinutes,
    timeInterpretationSource,
  },
  [...references, stationFile.reference, volumeFile.reference],
);
const body = canonicalJSON(pack),
  sha = createHash("sha256").update(body).digest("hex"),
  output = resolve(directory, "counts", `${sha}.json`);
await immutable(output, body);
process.stdout.write(
  JSON.stringify(
    {
      path: output,
      sha256: sha,
      counts: pack.counts.length,
      available: pack.counts.filter((c) => c.status === "available").length,
      missing: pack.counts.filter((c) => c.status === "missing").length,
      excluded: pack.counts.filter((c) => c.status === "excluded").length,
      sourceDailyRows: volumes.sourceRows,
      date,
      stationIds,
      targetMapping: "unreviewed",
      note: "No source data, graph, saved scenario or model defaults were changed.",
    },
    null,
    2,
  ) + "\n",
);
