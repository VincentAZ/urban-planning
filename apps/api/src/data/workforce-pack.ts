import {
  assertWorkforceCohortPack,
  type WorkforceCohortPack,
  type Source,
} from "@urban/core";
import {
  workforceAcsCells,
  workforceSummaryUrl,
  type WorkforceAcsSubset,
} from "./workforce-acs";
import {
  censusBlockSourceUrl,
  type PreparedWorkforceBlocks,
} from "./workforce-blocks";

/** Join trusted raw-source preparation output before routing. The operator CLI
 * replays the block join and ACS parsing to verify every cited input byte. */
export function buildWorkforceCohortPack(input: {
  blocks: PreparedWorkforceBlocks;
  education: WorkforceAcsSubset;
  occupation: WorkforceAcsSubset;
  label: string;
}): WorkforceCohortPack {
  const { blocks, education, occupation } = input;
  if (
    blocks.schemaVersion !== 1 ||
    blocks.populationVintage !== 2020 ||
    blocks.targetGeographyVintage !== 2024 ||
    blocks.blockGeographyVintage !== 2020 ||
    blocks.sourceRelease !== "TIGER2024" ||
    blocks.geographyMatch.status !== "verified" ||
    blocks.geographyMatch.method !==
      "census-current-suffixed-block-relationship" ||
    blocks.geographyMatch.unmatchedBlocks !== 0 ||
    blocks.geographyMatch.missingCurrentBlockGroups !== 0 ||
    blocks.completeness.missingPopulationCounts !== 0 ||
    blocks.completeness.missingHousingCounts !== 0 ||
    blocks.geographyMatch.unchangedPolygonsAsserted !== false
  )
    throw new Error(
      "A complete, explicitly matched official block inventory is required.",
    );
  if (
    education.table !== "B15003" ||
    occupation.table !== "C24010" ||
    education.state !== blocks.stateFips ||
    occupation.state !== blocks.stateFips
  )
    throw new Error(
      "Both ACS tables must describe the same state as the retained blocks.",
    );
  if (
    blocks.sources.length !== 3 ||
    new Set(blocks.sources.map((source) => source.kind)).size !== 3 ||
    blocks.sources.some(
      (source) =>
        !["tabblock20", "tabblocksufx", "bg"].includes(source.kind) ||
        source.url !== censusBlockSourceUrl(blocks.stateFips, source.kind) ||
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !/^[a-f0-9]{64}$/.test(source.dbfSha256) ||
        !Number.isSafeInteger(source.bytes) ||
        source.bytes <= 0 ||
        !Number.isSafeInteger(source.records) ||
        source.records <= 0,
    )
  )
    throw new Error(
      "All three official block/relationship/geography sources must be retained.",
    );
  const counties = new Set(blocks.countyGeoids);
  if (
    !counties.size ||
    counties.size !== blocks.countyGeoids.length ||
    [...counties].some(
      (id) => !/^\d{5}$/.test(id) || !id.startsWith(blocks.stateFips),
    )
  )
    throw new Error("Unique complete counties are required.");
  const selectedIds = (subset: WorkforceAcsSubset) =>
    Object.keys(subset.rows)
      .filter((id) => counties.has(id.slice(0, 5)))
      .sort();
  const ids = selectedIds(education);
  if (!ids.length || ids.join("|") !== selectedIds(occupation).join("|"))
    throw new Error(
      "Education and occupation native-geography inventories differ; missing units were not discarded.",
    );
  const native = new Set(ids);
  if (ids.join("|") !== [...blocks.blockGroupGeoids].sort().join("|"))
    throw new Error(
      "The ACS and current Census block-group inventories do not match exactly.",
    );
  const groupPopulation = new Map<string, number>();
  const blockIds = new Set<string>();
  const ambiguousGroups = new Set<string>();
  const positiveAmbiguity = new Set<string>();
  for (const block of blocks.blocks) {
    if (
      blockIds.has(block.id) ||
      !native.has(block.unitGeoid) ||
      !counties.has(block.id.slice(0, 5)) ||
      block.id.slice(0, 5) !== block.unitGeoid.slice(0, 5) ||
      !Number.isSafeInteger(block.population2020) ||
      block.population2020 < 0
    )
      throw new Error(
        "An original block is duplicated, unmatched, outside the declared counties, or has an invalid population.",
      );
    blockIds.add(block.id);
    groupPopulation.set(
      block.unitGeoid,
      (groupPopulation.get(block.unitGeoid) ?? 0) + block.population2020,
    );
  }
  for (const block of blocks.unallocatedBlocks) {
    if (
      blockIds.has(block.id) ||
      !counties.has(block.id.slice(0, 5)) ||
      !Number.isSafeInteger(block.population2020) ||
      block.population2020 < 0 ||
      block.reason !== "split-current-geography" ||
      block.candidateUnitGeoids.length < 2 ||
      new Set(block.candidateUnitGeoids).size !==
        block.candidateUnitGeoids.length ||
      block.candidateUnitGeoids.some(
        (id) => !native.has(id) || id.slice(0, 5) !== block.id.slice(0, 5),
      )
    )
      throw new Error(
        "An unallocated original block has invalid or duplicated relationship evidence.",
      );
    blockIds.add(block.id);
    for (const id of block.candidateUnitGeoids) {
      ambiguousGroups.add(id);
      if (block.population2020 > 0) positiveAmbiguity.add(id);
    }
  }
  if (
    blocks.geographyMatch.ambiguouslySplitBlocks !==
    blocks.unallocatedBlocks.length
  )
    throw new Error(
      "The unresolved split count does not match the retained source records.",
    );
  if (
    blocks.geographyMatch.unresolvedPopulation2020 !==
    blocks.unallocatedBlocks.reduce(
      (sum, block) => sum + block.population2020,
      0,
    )
  )
    throw new Error(
      "The unresolved split population does not match the retained source records.",
    );
  if (ids.some((id) => !groupPopulation.has(id) && !ambiguousGroups.has(id)))
    throw new Error(
      "An ACS native unit has no complete block inventory; no prefix fallback or silent exclusion is allowed.",
    );
  if (
    blocks.completeness.counties.length !== counties.size ||
    new Set(blocks.completeness.counties.map((county) => county.geoid)).size !==
      counties.size
  )
    throw new Error(
      "County completeness records do not match the requested region.",
    );
  for (const county of blocks.completeness.counties) {
    const rows = blocks.blocks.filter((block) =>
      block.id.startsWith(county.geoid),
    );
    const unallocated = blocks.unallocatedBlocks.filter((block) =>
      block.id.startsWith(county.geoid),
    );
    const allRows = [...rows, ...unallocated];
    const groups = new Set([
      ...rows.map((block) => block.unitGeoid),
      ...unallocated.flatMap((block) => block.candidateUnitGeoids),
    ]);
    if (
      !counties.has(county.geoid) ||
      allRows.length !== county.blocks ||
      groups.size !== county.blockGroups ||
      groups.size !== ids.filter((id) => id.startsWith(county.geoid)).length ||
      allRows.reduce((sum, block) => sum + block.population2020, 0) !==
        county.population2020 ||
      allRows.filter((block) => block.population2020 === 0).length !==
        county.zeroPopulationBlocks
    )
      throw new Error(
        "Retained county counts do not match the complete source inventory.",
      );
  }
  const sourceId = (kind: string) =>
    `census-tiger2024-${kind}-${blocks.stateFips}`;
  const sources: Source[] = blocks.sources.map((source) => ({
    id: sourceId(source.kind),
    name: `U.S. Census Bureau · TIGER2024 ${source.kind}`,
    url: source.url,
    vintage:
      source.kind === "tabblock20"
        ? "2020 Census; TIGER2024 release"
        : "TIGER2024",
    license: "U.S. government public data; Census attribution retained",
    kind: "observed",
    description:
      source.kind === "tabblock20"
        ? "Original 2020 block population and internal points. Used only as a modeled within-block-group allocation; these are not observed education or occupation counts by block."
        : "Official geographic identifiers and current suffixed-block relationships; no assertion of identical polygons across vintages.",
  }));
  for (const subset of [education, occupation]) {
    if (
      subset.source.url !== workforceSummaryUrl(subset.table) ||
      !/^[a-f0-9]{64}$/.test(subset.source.sha256) ||
      !Number.isSafeInteger(subset.source.bytes) ||
      subset.source.bytes <= 0
    )
      throw new Error("ACS source provenance is incomplete or mismatched.");
    sources.push({
      id: `census-acs2024-${subset.table.toLowerCase()}`,
      name: `U.S. Census Bureau · 2020–2024 ACS ${subset.table}`,
      url: subset.source.url,
      vintage: "2020–2024",
      license: "U.S. government public data; Census attribution retained",
      kind: "published-estimate",
      description:
        subset.table === "B15003"
          ? "Educational attainment of residents aged 25 and over; separate from the employed-population universe."
          : "Occupations of civilian employed residents aged 16 and over; not vacant positions or available applicants.",
    });
  }
  const pack: WorkforceCohortPack = {
    version: 1,
    id: `acs2024-block2020-${blocks.countyGeoids.join("-")}`,
    acs: {
      dataset: "acs/acs5",
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      confidenceLevel: 90,
      boundaryVintage: "TIGER2024 current block groups",
    },
    region: {
      label: input.label,
      countyGeoids: [...blocks.countyGeoids].sort(),
      complete: true,
    },
    sources,
    files: [
      ...blocks.sources.map((source) => ({
        sourceId: sourceId(source.kind),
        url: source.url,
        sha256: source.sha256,
        retrievedAt: source.retrievedAt,
        bytes: source.bytes,
        table: `TIGER2024/${source.kind}`,
      })),
      ...[education, occupation].map((subset) => ({
        sourceId: `census-acs2024-${subset.table.toLowerCase()}`,
        ...subset.source,
        table: subset.table,
      })),
    ],
    allocation: {
      method: "2020-block-population",
      sourceId: sourceId("tabblock20"),
      vintage: 2020,
      geographyMatch: "verified",
      notes: [
        ...blocks.notes,
        "All native ACS block groups in the selected complete counties must occur in both tables and the official block relationship inventory. Mismatches reject preparation.",
        "Within each block group, the modeled share uses 2020 total-population weights. Neither adult education nor occupation is observed at these block points; 2020-to-2024 growth and intra-block-group differences are not measured by this allocation.",
        "A native unit with zero total allocation population remains unavailable, even if its ACS estimate is positive. No arbitrary equal-area or equal-point substitute is used.",
        "Original blocks split across current block groups are retained once with all candidate relationships. Any positive-population ambiguous block makes every affected native unit's allocation unavailable; its population is never split equally or omitted from a normalized denominator.",
        "ACS sampling margins exclude geographic allocation error, network error and data-vintage mismatch. The two panels have different populations and must not be added or interpreted as available applicants.",
      ],
    },
    units: ids.map((geoid) => ({
      geoid,
      name: `Census block group ${geoid}`,
      education: workforceAcsCells(education, geoid),
      occupation: workforceAcsCells(occupation, geoid),
      allocationStatus:
        !positiveAmbiguity.has(geoid) && (groupPopulation.get(geoid) ?? 0) > 0
          ? "complete"
          : "unavailable",
    })),
    origins: [...blocks.blocks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((block) => ({
        id: block.id,
        unitGeoid: block.unitGeoid,
        position: block.position,
        population2020: block.population2020,
        weight:
          !positiveAmbiguity.has(block.unitGeoid) &&
          groupPopulation.get(block.unitGeoid)! > 0
            ? block.population2020 / groupPopulation.get(block.unitGeoid)!
            : 0,
      })),
    unallocatedOrigins: [...blocks.unallocatedBlocks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((block) => ({
        id: block.id,
        position: block.position,
        population2020: block.population2020,
        candidateUnitGeoids: [...block.candidateUnitGeoids].sort(),
        reason: block.reason,
      })),
  };
  assertWorkforceCohortPack(pack);
  return pack;
}
