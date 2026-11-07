# Captured workforce evidence and regional routing

The site workforce study now connects the browser workbench, project-scoped durable jobs, retained native routing evidence, saved scenario captures, public snapshots and report exports. Real regional car/walk computation is available when an operator configures verified sources and local routing capacity. Workforce captures use project format **7**; unchanged older projects keep their existing format. The impact model remains **0.6.0**, while this module has its own **workforce-1.0.2** method version.

The app remains free. These commands use public data and local computation; they do not configure paid services, deploy infrastructure, modify saved projects, or establish a production hosting price. Regional graph preparation is an operator task, never a visitor-triggered download/build. See [routing operations](ROUTING.md) for native engine/resource limits and [the full implementation ledger](IMPLEMENTATION_STATUS.md) for remaining scope.

## Evidence that is actually available

| Evidence | Retained source | Meaning |
| --- | --- | --- |
| Education | ACS 2020–2024 B15003, all 25 estimate/MOE cells per block group | Residents aged 25 and over, grouped into six attainment categories |
| Occupation | ACS 2020–2024 C24010, all 73 estimate/MOE cells per block group | Civilian employed residents aged 16 and over, grouped into five broad occupations |
| Allocation population and representative points | TIGER2024 TABBLOCK20 `POP20`, `INTPTLAT20`, `INTPTLON20` | Original 2020 total population and block internal points; not observed education/occupation at a residence |
| Geographic relationship | TIGER2024 TABBLOCKSUFX and BG | Original blocks' documented relationship to current block groups |
| Cohort coverage | Exact Census ACS2024 state geometry and complete county inventory | Whether the potentially reachable region is fully contained in the captured source region |
| Inbound travel | Pinned local Valhalla graph built from retained Arizona OSM PBF | Modeled travel from each supported origin toward a site, independent of the clipped ZIP display roads |

The native ACS universes are different. Neither panel counts available applicants or vacancies, and they cannot be added or cross-tabulated into an education-by-occupation match. LODES industry counts are not substituted for occupations. Source definitions are retained from the [ACS table-based summary files](https://www.census.gov/programs-surveys/acs/data/summary-file.2024.html), [B15003 variables](https://api.census.gov/data/2024/acs/acs5/groups/B15003.html), and [C24010 variables](https://api.census.gov/data/2024/acs/acs5/groups/C24010.html).

The initial actual Arizona evidence contains 4,773 block groups, exactly matching both ACS tables and the current TIGER inventory. Summed native totals reconcile to the official state rows: 5,088,675 adults aged 25+ and 3,415,601 civilian employed residents aged 16+. These are source-region totals, not commute-shed results.

All 155,444 original blocks are retained, including 47,506 zero-population blocks. Their total 2020 population is 7,151,502. Of these blocks, 109 map to more than one current block group; 47 have positive population, totaling 2,938 people. Those records are retained once with every candidate relationship. Positive ambiguity affects 59 current block groups. Including zero-population allocation units, 77 native groups have unavailable allocation; their ACS estimates remain preserved. No geographic split is allocated by invented equal or area shares. [Census TIGER2024 attribute definitions](https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2024/TGRSHP2024_TechDoc_F-S.pdf)

## Calculation and uncertainty

For each unambiguously supported native group, block weights are `2020 block population / complete supported group population`. A group's reachable share at 15, 30, or 45 minutes is the sum of weights whose inbound matrix times meet that threshold. Each native cohort estimate is multiplied by that share once, then summed across native groups. Unrounded weights and all raw Census values are retained.

A positive ambiguous block makes every affected group's allocation unavailable; regular block weights in those groups are zero **as an unavailable allocation marker**, never as a claim that the group has no residents. A zero-population split is retained without inventing allocation mass. Zero-population groups with positive ACS estimates also stay unresolved. Without separate native-group spatial exclusion evidence, a distant unresolved group cannot silently be removed merely because its representative point appears far away.

The model distinguishes observed numeric zero, missing/suppressed source values, unsnappable points, unavailable allocation, outside-coverage origins, null native connections, and origins proven outside the time threshold. Conservative distance exclusions retain a lower-bound proof that the core verifies against the actual origin, site, maximum speed and snapping allowance. Contour polygons are visualization aids; cohort membership uses individual travel times.

Full estimates require complete declared source data, complete potential cohort catchment coverage, complete potential graph coverage, and resolved contributing evidence. Otherwise the result retains a separately labeled known subtotal and the specific unresolved units. Known subtotals are conditional modeled estimates, not observed lower bounds on the number of applicants. Source-region completeness and network completeness are separate checks.

Approximate 90% sampling margins use `sqrt(sum(native reachable share² × sum(native source-cell MOE²)))`. Components are grouped at their native Census unit before weighting. Allocated blocks are not treated as independent survey observations. This approximation excludes covariance, geographic allocation error, network error and vintage mismatch; it is not a confidence bound on the whole planning model. [Census aggregation guidance](https://www.census.gov/content/dam/Census/library/publications/2020/acs/acs_general_handbook_2020_ch08.pdf)

Conditional known-subtotal margins include only known routed shares. Unresolved spatial weights have a separate uncertainty field; they are not mislabeled as missing Census margins. A zero published point estimate with a positive sampling margin does not become an exact full-cohort zero merely because its allocation is unavailable. Method 1.0.1 corrects this distinction. Method 1.0.2 counts partially reached native groups from exact positive-origin membership, so a floating-point sum one unit below 1 cannot mislabel a fully reached group. Point estimates and margins are unchanged by the diagnostic correction; previous verification artifacts remain retained.

## Using the workbench

Open **Economy → Readiness → Open workforce workbench**, or start from a selected parcel/building. Choose a site with the regional map, exact coordinates or a study feature; choose car or walking and inspect 15/30/45-minute results. Map controls also support keyboard operation. The selected feature supplies an approximate site point, not a verified entrance. Education and occupation remain separate panels, with explicit source universes, known subtotals, conditional margins and coverage details. Transit remains unavailable until a verified schedule-aware service exists.

Anyone can explore the workbench. Running requires a free account, an editable saved project with no unsaved changes, and an enabled operator configuration. Signing in and saving preserve the entered query. Work starts only on **Run workforce shed**; opening a view, editing coordinates or changing tabs does not submit a run. The global worker admits one active run; defaults allow ten pending jobs globally, one pending job per account and three starts per account per UTC day. Cancellation, bounded retries, interruption recovery and idempotent submissions retain their recorded attempts.

A completed run does not overwrite the scenario. **Save capture to scenario** checks project access, the saved version, scenario revision and exact query/result identities before creating one undoable edit. Changing the site or mode leaves older evidence visibly labeled until another run completes. Removing a capture is also undoable. Frozen public views and exports use saved evidence without starting routing or fetching private jobs.

The scenario stores a compact, hash-bound summary, capped at 256 KiB. The actual Arizona summaries are about 41 KiB; all 155,335 routing rows and full contours stay in the private immutable artifact archive. Authenticated members can download that archive with verified bytes. Archiving is bounded to 64 MiB per artifact and 2 GiB total, with free-space checks; operators must plan retention and backups. Current UI contours are fetched from the authorized saved run, while the scenario retains their identity rather than duplicating their geometry in every history entry.

Restoring a project file creates a copy whose workforce evidence is explicitly **imported and not verified by this server**, including historical commands. Values, sources and hashes remain intact. A copied receipt never grants access to the original project's private job. A newly configured run is required for a server-produced capture in the copy. Exported hashes identify bytes; they do not independently authenticate who produced them.

PDF/Word appendices, workforce CSV, XLSX sheets, printable HTML, project JSON and GeoJSON metadata retain the saved numerical evidence and limitations. Full estimates and full-cohort margins remain blank/unavailable where evidence is partial; separately labeled known subtotals and their conditional margins remain available. GIS metadata includes the compact capture; full regional contours are in the separate routing archive. Oversized PDF/Word appendices fail explicitly instead of silently dropping evidence.

## Enabling bounded local jobs

The worker is **disabled by default**, including development. See the [API configuration](../apps/api/README.md#project-owned-regional-workforce-jobs) and `.env.example` for source paths, archive location, routing URL and capacity declaration. Operator preparation is separate from user job submission; visitors cannot choose server files, change routing profiles or trigger graph builds.

The operating ceiling still starts at **$300/month**, adjustable by the platform administrator. Local development requires an explicit existing-capacity declaration. A deployed configuration requires a documented capacity statement and accounted fixed hosting capacity in the private budget. Admission respects budget pause/headroom; it does not expose the platform's private budget to ordinary users. Recorded zero incremental routing-provider fees mean this local worker has no per-call external routing charge, not that computation or hosting is free. Production infrastructure prices, resource limits and external billing feeds still require independent setup and validation.

## Reproducible operator workflow

Run from the repository root. All prepared data stays under ignored `.local/`; no Census key is required for these official downloads.

```bash
corepack pnpm exec tsx scripts/prepare-workforce-acs.ts 04
corepack pnpm exec tsx scripts/prepare-workforce-blocks.ts --state 04
corepack pnpm exec tsx scripts/prepare-workforce-boundary.ts --state 04
corepack pnpm exec tsx scripts/prepare-workforce-pack.ts <printed-block-artifact-path> Arizona
```

The ACS command downloads only two selected national tables, with a 300 MB per-file and 400 MB per-run limit. A single exclusive preparation lock protects shared raw files and receipts across state requests. Existing raw bytes are checked against their captured receipt; malformed values, duplicate rows, absent geography and unexpected headers fail explicitly. An interrupted preparation lock requires operator inspection before reuse.

Block preparation validates complete archive/DBF counts, original/current geographic identifiers, population values and source digests. The cohort-pack command replays the three retained raw Census sources and compares the prepared artifact before attaching their citations; a rehashed, edited intermediate file does not pass. Both ACS sources are reparsed from their verified original bytes. Derived artifacts publish from fsynced temporary files through atomic no-overwrite links.

Prepare/start the graph using [the routing instructions](ROUTING.md). Then run a captured study:

```bash
corepack pnpm exec tsx scripts/run-workforce.ts \
  <printed-cohort-pack-path> <printed-boundary-artifact-path> \
  -112.074 33.448 walk
```

Use `car` for the other currently implemented mode. The runner checks Census and graph boundaries independently, uses the captured static profile, verifies complete provider row identities and exact matrix/contour request hashes, and calculates from the frozen inputs. Cancellation or failed routing/aggregation/contour validation prevents publication of a completed artifact. The CLI writes a complete result under `.local/workforce/runs/` and prints its content hash and coverage summary.

The result includes the native source-pack identity, graph/configuration/profile identity, source boundary proof, actual direction/mode/site, every retained routable-origin status, separate cohort panels, uncertainty, and visualization contours. Before running, the CLI verifies the boundary's content-addressed filename and replays its retained raw Census responses without network access. Proposed street edits, future population growth, peak congestion and transit schedules are not part of this captured-network calculation. Transit requires a verified schedule-aware provider; the Valhalla matrix API does not provide a transit matrix. [Valhalla matrix documentation](https://valhalla.github.io/valhalla/api/matrix/)

## Verification and remaining work

Source and numerical checks cover native geography reconciliation, retained zeros/sentinels, ambiguous population conservation, separate universes, grouped MOEs, threshold monotonicity, source and request tampering, missing versus unresolved evidence, exact coverage proofs, source replay and immutable publication. Native routing checks and operational measurements are recorded separately from synthetic unit tests.

The initial full walking and car attempts each exceeded the native service memory limit and were rejected without publishing completed results. Their failure evidence remains retained. The final single-reverse-search configuration, bounded cache, proven path-distance limits and actual terminal-edge padding passed all four complete Phoenix/Tempe car/walk captures under the unchanged 2 CPU/2 GiB native service limit. Native cgroup lifetime peak after the final cases was 396,029,952 bytes with zero OOM events in that service instance. The separate Node driver reached 1,988,048 KiB RSS; production sizing must include both processes and the application/database. These local observations do not establish cloud capacity or cost.

| Final native capture | Runner time, including aggregation/contours | Regular origins retained |
| --- | --- | --- |
| Phoenix car | 187.18 seconds | 155,335 |
| Tempe car | 178.93 seconds | 155,335 |
| Phoenix walk | 16.45 seconds | 155,335 |
| Tempe walk | 14.97 seconds | 155,335 |

All four results remain explicitly partial where allocation or snapping is unresolved. Method 1.0.2 results were recalculated from the unchanged final captured route rows after the diagnostic-only correction; original captures and performance records are preserved. Independent native-cell recomputation, exact membership and routing/provenance checks are recorded under `.local/qa/workforce/`. The full regression suite and build are recorded separately from native-run evidence. These original operator checks establish source/routing behavior; the later application checks below provide separate workflow evidence.

The application integration was checked using both synthetic failure cases and a real retained native run. A browser-created free account saved a project, submitted a Phoenix walking study, completed native routing/aggregation, adopted the exact capture, downloaded the full 20.76 MB evidence file and reopened the saved scenario after a server restart. Its 155,335 origin rows and all 39 aggregate rows/coverage matched the prior independently verified Phoenix walking run. The isolated job took 21.42 seconds and used one attempt; this is a local observation, not a production service promise.

Browser regression checks cover account/query continuity, narrow-screen keyboard controls, an uncertain committed submission without duplicate jobs, copy/import origin labeling, subsequent cloud saves and frozen public inspection without private job requests. Core/API/database checks cover immutable evidence, optimistic adoption, cancellation/recovery, access revocation, scoped worker credentials, raw SQL tampering and report fidelity. Report render review and detailed verification evidence are under `.local/qa/workforce-integration/`; this directory is intentionally ignored.

Production capacity and cost enforcement, archive retention/recovery, source refresh operations, full transit, scenario graph patching, empirical calibration, professional field validation and nationwide coverage remain unfinished. No paid provider, deployment or customer charge was introduced.
