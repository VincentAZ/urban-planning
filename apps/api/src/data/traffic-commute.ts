import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  validateTrafficCommuteSourcePack,
  type Source,
  type TrafficCommuteSourcePack,
  type TrafficCommuteSourceFile,
  type TrafficCommuteJobRow,
  type TrafficCommuteFlow,
} from "@urban/core";
import type { PreparedWorkforceBlocks } from "./workforce-blocks";
import {
  COMMUTE_SOURCE_URLS,
  COMMUTE_ACS_UNIVERSE,
  COMMUTE_DEPARTURE_LABELS,
  commuteTractRelationships,
  openCommuteSource,
  readCommuteAcs,
  readCommuteTable,
  readLodesArea,
  readLodesOd,
  verifyCommuteSource,
  type CommuteParsedSource,
  type CommuteSourceReceipt,
} from "./traffic-commute-sources";

export const COMMUTE_PACK_LIMITS = {
  flows: 250_000,
  blocks: 50_000,
  tracts: 500,
  bytes: 192 * 1024 * 1024,
} as const;
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total))
      throw new Error("Commute source aggregate exceeds exact integer limits.");
  }
  return total;
};
export const LODES_CROSSWALK_COLUMNS = [
  "tabblk2020",
  "st",
  "stusps",
  "stname",
  "cty",
  "ctyname",
  "trct",
  "trctname",
  "bgrp",
  "bgrpname",
  "cbsa",
  "cbsaname",
  "zcta",
  "zctaname",
  "stplc",
  "stplcname",
  "ctycsub",
  "ctycsubname",
  "stcd119",
  "stcd119name",
  "stsldl",
  "stsldlname",
  "stsldu",
  "stslduname",
  "stschool",
  "stschoolname",
  "stsecon",
  "stseconname",
  "trib",
  "tribname",
  "tsub",
  "tsubname",
  "stanrc",
  "stanrcname",
  "mil",
  "milname",
  "stwib",
  "stwibname",
  "blklatdd",
  "blklondd",
  "createdate",
];
export const COMMUTE_SOURCES: Source[] = [
  {
    id: "commute-lodes-2023",
    name: "Census LODES2023 primary jobs (JT01), Arizona",
    url: "https://lehd.ces.census.gov/data/lodes/LODES8/az/",
    vintage: "2023; captured file and release metadata retained separately",
    license: "US Census public data",
    kind: "published-estimate",
    description:
      "Administrative primary-job location estimates; not observed daily vehicle trips. Missing workplace-state coverage remains a limitation.",
  },
  {
    id: "commute-acs-2024",
    name: "ACS2020–2024 B08132: transportation mode by work departure time",
    url: COMMUTE_SOURCE_URLS["B08132-2024-metadata.json"],
    vintage: "2020–2024 five-year estimates",
    license: "US Census public data",
    kind: "published-estimate",
    description:
      COMMUTE_ACS_UNIVERSE +
      "; native tract estimates and90% MOEs retained. Joint drive-alone bins already exclude working at home.",
  },
  {
    id: "commute-geography-2024",
    name: "Census TIGER2024 block-to-current-geography relationships",
    url: "https://www2.census.gov/geo/tiger/TIGER2024/",
    vintage: "2020 blocks related to2024 geography",
    license: "US Census public data",
    kind: "observed",
    description:
      "Official suffix-block relationships and Census internal points. Split-tract blocks remain unresolved; internal points are not observed entrances.",
  },
  {
    id: "commute-reconciliation",
    name: "Reproducible source completeness and job accounting",
    url: "",
    vintage: "Derived from exact retained input hashes",
    license: "Derived from US Census public data",
    kind: "inferred",
    description:
      "Full Arizona RAC, ODmain/aux and WAC reconciliation; no unresolved jobs are redistributed.",
  },
];

/** Immutable, content-addressed local derived evidence; never overwrites raw or prior prepared files. */
export async function writeCommuteArtifact(
  directory: string,
  prefix: string,
  value: unknown,
) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > COMMUTE_PACK_LIMITS.bytes)
    throw new Error(
      "Prepared commute artifact exceeds192MiB; choose a smaller complete home-tract cohort.",
    );
  const sha256 = digest(bytes);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${prefix}-${sha256}.json`),
    temporary = `${path}.${randomUUID()}.part`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        digest(await readFile(path)) !== sha256
      )
        throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
  return { path, sha256, bytes: bytes.length };
}

export async function prepareTrafficCommuteSources(options: {
  sourceDirectory: string;
  outputDirectory: string;
  blocksFile: string;
  blocksSha256: string;
  residentTractGeoids: string[];
}) {
  const tractIds = [...new Set(options.residentTractGeoids)].sort();
  if (
    !tractIds.length ||
    tractIds.length !== options.residentTractGeoids.length ||
    tractIds.length > COMMUTE_PACK_LIMITS.tracts ||
    tractIds.some((t) => !/^04\d{9}$/.test(t))
  )
    throw new Error(
      "Select1–500 unique complete Arizona home tracts explicitly.",
    );
  const selected = new Set(tractIds),
    files: TrafficCommuteSourceFile[] = [];
  const receipts = new Map<string, CommuteSourceReceipt>();
  const paths = new Map<string, string>();
  for (const [name, url] of Object.entries(COMMUTE_SOURCE_URLS)) {
    const verified = await verifyCommuteSource(
      options.sourceDirectory,
      name,
      url,
    );
    receipts.set(name, verified.receipt);
    paths.set(name, verified.path);
  }
  const blockInfo = await lstat(options.blocksFile);
  if (
    !blockInfo.isFile() ||
    blockInfo.size > COMMUTE_PACK_LIMITS.bytes ||
    !/^[a-f0-9]{64}$/.test(options.blocksSha256)
  )
    throw new Error("Invalid retained workforce block relationship artifact.");
  const blockBytes = await readFile(options.blocksFile);
  if (digest(blockBytes) !== options.blocksSha256)
    throw new Error("Block relationship hash mismatch.");
  const blocks = JSON.parse(
    blockBytes.toString("utf8"),
  ) as PreparedWorkforceBlocks;
  const relationship = commuteTractRelationships(blocks);
  const inCohort = (id: string) => {
    const resolved = relationship.resolved.get(id);
    return resolved
      ? selected.has(resolved.tract)
      : (relationship.ambiguous.get(id)?.tracts.some((t) => selected.has(t)) ??
          false);
  };
  const versionText = await readFile(paths.get("version.txt")!, "utf8");
  const formatVersion = versionText.match(
    /Release Format Version\s*([\d.]+)/,
  )?.[1];
  const dataVintage = versionText.match(/Data Vintage:\s*([\w_]+)/)?.[1];
  if (!formatVersion || !dataVintage)
    throw new Error(
      "LODES release metadata is missing; no minor version is inferred.",
    );
  const metadata = JSON.parse(
    await readFile(paths.get("B08132-2024-metadata.json")!, "utf8"),
  );
  const shells = await readFile(
    paths.get("ACS20245YR_Table_Shells.txt")!,
    "utf8",
  );
  for (let cell = 16; cell <= 30; cell++) {
    const id = `B08132_${String(cell).padStart(3, "0")}`;
    if (
      !metadata.variables?.[`${id}E`]?.label?.includes(
        "Car, truck, or van - drove alone:",
      ) ||
      (cell > 16 &&
        !metadata.variables[`${id}E`].label.endsWith(
          `!!${COMMUTE_DEPARTURE_LABELS[cell - 17]}`,
        )) ||
      !shells
        .split("\n")
        .some(
          (s) =>
            s.includes(`|${id}|`) && s.includes(`|${COMMUTE_ACS_UNIVERSE}|`),
        )
    )
      throw new Error(
        "Official ACS joint drive-alone labels/universe do not match the pinned contract.",
      );
  }
  const addFile = (
    name: keyof typeof COMMUTE_SOURCE_URLS,
    role: TrafficCommuteSourceFile["role"],
    sourceId: string,
    parsed?: CommuteParsedSource,
    createdates?: string[],
  ) => {
    const receipt = receipts.get(name)!;
    files.push({
      role,
      sourceId,
      ...receipt,
      ...(createdates?.length === 1 ? { createdate: createdates[0] } : {}),
      metadata: {
        ...(receipt.lastModified
          ? { httpLastModified: receipt.lastModified }
          : {}),
        ...(parsed
          ? {
              uncompressedSha256: parsed.sha256,
              uncompressedBytes: String(parsed.bytes),
              rows: String(parsed.rows),
            }
          : {}),
        ...(createdates ? { rowCreatedates: createdates.join(",") } : {}),
      },
    } as TrafficCommuteSourceFile);
    // Only documented fields enter the shared strict contract.
    const f = files[files.length - 1] as TrafficCommuteSourceFile &
      CommuteSourceReceipt;
    delete f.lastModified;
    delete f.etag;
    delete f.contentType;
  };
  const verifyChecksum = async (name: string, parsed: CommuteParsedSource) => {
    const checksumName = name.replace(/\.gz$/, ".sha256sum");
    const checksumUrl = COMMUTE_SOURCE_URLS[
      name as keyof typeof COMMUTE_SOURCE_URLS
    ].replace(/\.gz$/, ".sha256sum");
    const checksum = await verifyCommuteSource(
      options.sourceDirectory,
      checksumName,
      checksumUrl,
    );
    const text = (await readFile(checksum.path, "utf8")).trim();
    const match = text.match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/);
    if (
      !match ||
      match[1] !== parsed.sha256 ||
      match[2] !== name.replace(/\.gz$/, "")
    )
      throw new Error(
        "Official LODES checksum does not match the complete decompressed CSV.",
      );
    files.push({
      role: "reconciliation",
      sourceId: "commute-lodes-2023",
      url: checksum.receipt.url,
      sha256: checksum.receipt.sha256,
      bytes: checksum.receipt.bytes,
      retrievedAt: checksum.receipt.retrievedAt,
    });
  };
  const acs = await readCommuteAcs(
    openCommuteSource(paths.get("acsdt5y2024-b08132.dat")!),
    selected,
  );
  if (acs.source.sha256 !== receipts.get("acsdt5y2024-b08132.dat")!.sha256)
    throw new Error("ACS source changed during parsing.");
  if (tractIds.some((id) => !acs.tracts.has(id)))
    throw new Error("Selected native ACS tract is absent from the source.");
  const residences: TrafficCommuteJobRow[] = [],
    workplaces: TrafficCommuteJobRow[] = [],
    flows: TrafficCommuteFlow[] = [];
  const racName = "az_rac_S000_JT01_2023.csv.gz",
    mainName = "az_od_main_JT01_2023.csv.gz",
    auxName = "az_od_aux_JT01_2023.csv.gz",
    wacName = "az_wac_S000_JT01_2023.csv.gz";
  const rac = await readLodesArea(
    openCommuteSource(paths.get(racName)!, true),
    "rac",
    (raw, sourceRow) => {
      if (
        !relationship.resolved.has(raw.h_geocode) &&
        !relationship.ambiguous.has(raw.h_geocode)
      )
        throw new Error("RAC block absent from complete2024 relationship.");
      if (inCohort(raw.h_geocode))
        residences.push({
          blockGeoid: raw.h_geocode,
          jobs: Number(raw.C000),
          sourceFileSha256: receipts.get(racName)!.sha256,
          sourceRow,
          raw,
        });
    },
  );
  const cohortBlocks = new Set(residences.map((r) => r.blockGeoid));
  const main = await readLodesOd(
    openCommuteSource(paths.get(mainName)!, true),
    "main",
    (home, work, jobs, raw, sourceRow) => {
      if (!inCohort(home)) return;
      if (flows.length >= COMMUTE_PACK_LIMITS.flows)
        throw new Error(
          "Commute cohort exceeds250,000flows; select fewer complete home tracts.",
        );
      cohortBlocks.add(home);
      cohortBlocks.add(work);
      if (cohortBlocks.size > COMMUTE_PACK_LIMITS.blocks)
        throw new Error("Commute cohort exceeds50,000blocks.");
      flows.push({
        id: `main-${home}-${work}`,
        homeBlockGeoid: home,
        workBlockGeoid: work,
        part: "main",
        jobs,
        sourceFileSha256: receipts.get(mainName)!.sha256,
        sourceRow,
        raw,
      });
    },
  );
  const aux = await readLodesOd(
    openCommuteSource(paths.get(auxName)!, true),
    "aux",
  );
  const neededWorkplaces = new Set(flows.map((f) => f.workBlockGeoid));
  const wac = await readLodesArea(
    openCommuteSource(paths.get(wacName)!, true),
    "wac",
    (raw, sourceRow) => {
      if (neededWorkplaces.has(raw.w_geocode))
        workplaces.push({
          blockGeoid: raw.w_geocode,
          jobs: Number(raw.C000),
          sourceFileSha256: receipts.get(wacName)!.sha256,
          sourceRow,
          raw,
        });
    },
  );
  const releases = [rac, main, aux, wac].map((data) => data.createdates);
  if (
    releases.some((dates) => dates.length !== 1) ||
    new Set(releases.flat()).size !== 1
  )
    throw new Error(
      "LODES main, aux, RAC and WAC row vintages differ; prepare a consistent release.",
    );
  const xwalkIds = new Set<string>();
  const xwalk = await readCommuteTable(
    openCommuteSource(paths.get("az_xwalk.csv.gz")!, true),
    ",",
    LODES_CROSSWALK_COLUMNS,
    (row) => {
      if (!/^04\d{13}$/.test(row.tabblk2020) || xwalkIds.has(row.tabblk2020))
        throw new Error("Invalid LODES crosswalk block.");
      xwalkIds.add(row.tabblk2020);
    },
  );
  if (
    xwalkIds.size !==
      relationship.resolved.size + relationship.ambiguous.size ||
    [...xwalkIds].some(
      (id) => !relationship.resolved.has(id) && !relationship.ambiguous.has(id),
    )
  )
    throw new Error(
      "LODES and retained TIGER2024 original-block inventories differ.",
    );
  for (const [name, data] of [
    [racName, rac],
    [mainName, main],
    [auxName, aux],
    [wacName, wac],
  ] as const) {
    await verifyChecksum(name, data.source);
    addFile(
      name,
      name === racName
        ? "lodes-rac"
        : name === wacName
          ? "lodes-wac"
          : name === mainName
            ? "lodes-main"
            : "lodes-aux",
      "commute-lodes-2023",
      data.source,
      data.createdates,
    );
  }
  await verifyChecksum("az_xwalk.csv.gz", xwalk);
  addFile("az_xwalk.csv.gz", "lodes-crosswalk", "commute-lodes-2023", xwalk);
  addFile("version.txt", "reconciliation", "commute-lodes-2023");
  addFile("acsdt5y2024-b08132.dat", "acs", "commute-acs-2024", acs.source);
  addFile("B08132-2024-metadata.json", "acs", "commute-acs-2024");
  addFile("ACS20245YR_Table_Shells.txt", "acs", "commute-acs-2024");
  let negativeResidenceResidualBlocks = 0,
    workplaceMismatchBlocks = 0;
  const residuals = [...new Set([...rac.counts.keys(), ...main.homes.keys()])]
    .sort()
    .map((id) => {
      const residentJobs = rac.counts.get(id) ?? 0,
        mainJobs = main.homes.get(id) ?? 0;
      if (residentJobs < mainJobs) negativeResidenceResidualBlocks++;
      return {
        blockGeoid: id,
        residentJobs,
        knownArizonaDestinationJobs: mainJobs,
        unresolvedDestinationJobs: residentJobs - mainJobs,
      };
    });
  for (const id of new Set([
    ...wac.counts.keys(),
    ...main.workplaces.keys(),
    ...aux.workplaces.keys(),
  ]))
    if (
      (wac.counts.get(id) ?? 0) !==
      (main.workplaces.get(id) ?? 0) + (aux.workplaces.get(id) ?? 0)
    )
      workplaceMismatchBlocks++;
  if (negativeResidenceResidualBlocks || workplaceMismatchBlocks)
    throw new Error(
      "LODES RAC/OD/WAC reconciliation failed; no partial normalization is permitted.",
    );
  const totals = {
    residentJobs: sum(rac.counts.values()),
    mainJobs: sum(main.homes.values()),
    auxiliaryJobs: sum(aux.homes.values()),
    workplaceJobs: sum(wac.counts.values()),
    unresolvedOutboundJobs: sum(
      residuals.map((r) => r.unresolvedDestinationJobs),
    ),
    auxiliaryFlowCount: aux.source.rows,
    negativeResidenceResidualBlocks,
    workplaceMismatchBlocks,
  };
  const uncertainTracts = new Set(
    [...relationship.ambiguous]
      .filter(([id]) => (rac.counts.get(id) ?? 0) > 0)
      .flatMap(([, value]) => value.tracts),
  );
  const audit = await writeCommuteArtifact(
    options.outputDirectory,
    "commute-reconciliation",
    {
      version: 1,
      stateFips: "04",
      totals,
      sourceFiles: files,
      blockRelationshipSha256: options.blocksSha256,
      homeBlocks: residuals,
      auxiliaryOriginJobsByState: Object.fromEntries(
        [...aux.homes].reduce(
          (map, [id, n]) =>
            map.set(id.slice(0, 2), (map.get(id.slice(0, 2)) ?? 0) + n),
          new Map<string, number>(),
        ),
      ),
      unresolvedTractBlocks: [...relationship.ambiguous].map(([id, value]) => ({
        blockGeoid: id,
        candidateTractGeoids: value.tracts,
        residentJobs: rac.counts.get(id) ?? 0,
      })),
      selectedTractGeoids: tractIds,
      selectedTractsWithAmbiguousResidentJobs: tractIds.filter((t) =>
        uncertainTracts.has(t),
      ),
    },
  );
  const retrievedAt = receipts.get(mainName)!.retrievedAt;
  files.push({
    role: "reconciliation",
    sourceId: "commute-reconciliation",
    url: "",
    sha256: audit.sha256,
    bytes: audit.bytes,
    retrievedAt,
  });
  files.push({
    role: "geography",
    sourceId: "commute-geography-2024",
    url: "",
    sha256: options.blocksSha256,
    bytes: blockBytes.length,
    retrievedAt,
    metadata: {
      method: blocks.geographyMatch.method,
      targetGeographyVintage: "2024",
    },
  });
  for (const file of blocks.sources)
    files.push({
      role: file.kind === "tabblock20" ? "block-points" : "geography",
      sourceId: "commute-geography-2024",
      url: file.url,
      sha256: file.sha256,
      bytes: file.bytes,
      retrievedAt: file.retrievedAt,
      metadata: { dbfSha256: file.dbfSha256, archiveEntry: file.archiveEntry },
    });
  // Retain every ambiguous candidate residence, even if no OD row survives; zero is published evidence too.
  const pointHash = blocks.sources.find((s) => s.kind === "tabblock20")?.sha256;
  if (!pointHash) throw new Error("Original block point source is missing.");
  const prepared: TrafficCommuteSourcePack = {
    version: 1,
    id: `az-jt01-2023-acs2024-${digest(tractIds.join(",")).slice(0, 16)}`,
    lodes: {
      dataYear: 2023,
      jobType: "JT01",
      blockVintage: "2020",
      formatVersion,
      dataVintage,
    },
    acs: {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      table: "B08132",
      geography: "tract",
      boundaryVintage: "2024",
      confidenceLevel: 90,
    },
    coverage: {
      stateFips: "04",
      label: `${tractIds.length} explicit Arizona resident tracts; all covered Arizona destinations`,
      residentTractGeoids: tractIds,
      rac: "complete-for-declared-tracts",
      odMain: "complete-for-declared-tracts",
      notes: [
        "Original statewide files were fully scanned. No origins or destinations were selected by distance or ZIP intersection.",
        "Complete record coverage does not resolve split-tract geography; affected native ACS cells must remain unallocated.",
      ],
    },
    reconciliation: { evidenceFileSha256: audit.sha256, ...totals },
    sources: structuredClone(COMMUTE_SOURCES),
    files,
    blocks: [...cohortBlocks].sort().map((id) => {
      const r = relationship.resolved.get(id),
        a = relationship.ambiguous.get(id);
      if (!r && !a)
        throw new Error(
          "Referenced OD block lacks a retained official geographic relationship.",
        );
      return {
        geoid: id,
        position: (r ?? a)!.position,
        pointFileSha256: pointHash,
        tractJoin: r
          ? {
              status: "verified" as const,
              tractGeoid: r.tract,
              evidenceFileSha256: options.blocksSha256,
            }
          : {
              status: "unresolved" as const,
              candidateTractGeoids: a!.tracts,
              reason: "split-geography" as const,
              evidenceFileSha256: options.blocksSha256,
            },
      };
    }),
    residences,
    workplaces,
    flows,
    tracts: tractIds.map((id) => ({
      ...acs.tracts.get(id)!,
      name: `Census tract ${id}`,
      sourceFileSha256: receipts.get("acsdt5y2024-b08132.dat")!.sha256,
    })),
    notes: [
      "This is a modeled usual home-to-work drive-alone prior, not observed daily total traffic, a dated work attendance count, or a complete commute shed.",
      "ACS2020–2024 native joint mode/departure estimates are allocated using2023 LODES primary-job destinations under an explicit mode/destination independence assumption. No extra work-from-home or mode-share factor is applied.",
      "RAC minus Arizona main OD retains unresolved outbound destinations. Arizona aux describes out-of-state homes working in Arizona; those jobs remain external-origin inventory until matching resident denominators and ACS geography are supplied.",
      "The captured directory release and per-file creation dates differ. No LODES minor version is inferred from the observation year. Coverage excludes unavailable workplace-state data as documented by Census; no claim of complete national employment coverage.",
      "All Census source files are public; derived routing and within-bin departure choices remain model assumptions. Latest LODES crosswalk tracts are not substituted for2024 ACS relationships.",
    ],
  };
  validateTrafficCommuteSourcePack(prepared);
  const artifact = await writeCommuteArtifact(
    options.outputDirectory,
    "commute-pack",
    prepared,
  );
  return { prepared, artifact, reconciliation: audit };
}
