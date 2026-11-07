# Housing affordability workbench

The workbench compares complete monthly housing costs with published HUD Section 8 income limits for an explicitly selected household size. It reports how many modeled homes can be evaluated, their affordability at each published income ceiling, and the homes still unassigned or unresolved. All housing features follow the free-access policy; this work adds no paid service or per-comparison API charge. The initial $300 monthly operating ceiling remains administrator-adjustable.

## Planner workflow

Open **Housing → Review housing affordability**, or open the workbench from a selected residential building. Search the HUD catalog, inspect the named area and its county/town components, and explicitly review applicability. Retaining an area does not automatically assign it to every building. ZIP codes, study centroids and bedroom counts do not establish HUD jurisdiction or household size.

Add separate baseline and proposal cost groups. Each group names a building, an optional development-program component, a mutually exclusive home count, rental/ownership tenure, household size, HUD pack and cost year. A building can contain several groups. Assignments cannot silently exceed the building or component's home count; whole-building and component assignments cannot be mixed within one building. Quantities left unassigned remain visible.

Rental costs include rent, utilities and mandatory fees. Ownership costs include the recurring loan payment, property tax, property/flood/mortgage insurance, utilities, association or condominium fees, ground rent and other mandatory fees. Each component is either a known separate amount, included in another known payment, explicitly not applicable, or unknown. For example, tax and insurance already included in escrow point to the loan payment and are counted once. Blank amounts are not zero. Included-cost chains and cycles are rejected.

Preview the comparison, review the geography, quantities, costs and source permissions, then Apply. This creates one reversible scenario command. Save persists the project through the normal workspace workflow. Changes to building quantities, program or geometry make an existing review stale; they do not block ordinary building edits. Review the changed assignments before reusing the classification.

## Interpreting the result

For complete monthly housing cost `C` in dollars, required gross annual household income is `12 × C / 0.30`. The comparison uses each selected household-size row's exact published extremely-low, very-low and low-income limits. Published HUD adjustments mean those values are not simple 30%, 50% and 80% multiples of area median income. Exact integer-cent comparisons avoid rounding at a threshold.

The three ceiling counts are cumulative and overlap. A separate exclusive-band table identifies the lowest ceiling that accommodates each complete cost. A home affordable at a category's upper income limit may remain unaffordable to a household below that limit. This is a planning cost comparison, not a finding of program eligibility, LIHTC/HOME rent compliance, observed housing cost burden, household demand, development feasibility or access to a down payment. Maintenance and transaction costs are not inferred.

Costs and income limits must share one declared year across the comparison. A scenario's forecast horizon does not automatically inflate either input or predict future HUD limits. Unknown costs, missing packs, unresolved assignment capacity and stale reviews produce explicit unavailable/incomplete results. Known subtotals describe evaluated homes; they are not complete totals or statistical estimates of missing homes.

## Official source preparation

The current adapter supports the **FY 2026 Section 8** workbook, effective **May 1, 2026**, plus the official area definitions, methodology and national tables PDF. It retains every published 1–8-person threshold, exact physical workbook rows, field descriptions, source URLs, byte counts, SHA-256 hashes and successful download receipts. The prepared catalog contains 4,764 county/town rows grouped into 2,635 HUD areas. New England town exceptions, Connecticut planning regions and territories retain their original identifiers; county FIPS is the complete five-digit code. The workbook's `99999` subdivision suffix denotes a county-wide row, not an actual town.

Official sources: [HUD income-limit publication](https://www.huduser.gov/portal/datasets/il.html), [FY 2026 workbook](https://www.huduser.gov/portal/datasets/il/il26/Section8-FY26.xlsx), [area definitions](https://www.huduser.gov/portal/datasets/il/il26/area-definitions-FY26.pdf), [methodology](https://www.huduser.gov/portal/datasets/il/il26/IncomeLimitsMethodology-FY26.pdf), and [published tables](https://www.huduser.gov/portal/datasets/il/il26/Section8-IncomeLimits-FY26.pdf).

The input directory must contain `Section8-FY26.xlsx`, `area-definitions-FY26.pdf`, `IncomeLimitsMethodology-FY26.pdf`, `Section8-IncomeLimits-FY26.pdf`, `receipts.json` and `pdf-navigation-receipts.json`. Each receipt file is a JSON array. Every original needs a successful receipt with `{ "url": "official URL", "downloaded": true, "sha256": "exact hash", "bytes": 123 }` matching its retained bytes. Failed or empty responses are not source evidence.

`prepare-housing.ts` validates a retained source directory and creates a new immutable catalog directory. The loader independently replays workbook → complete normalized table → every pack before exposing server-catalog authority. Empty HTTP responses, malformed ZIPs, formula cells, unsupported schemas, conflicting area rows and mismatched hashes are errors. A later fiscal-year adapter requires an explicit versioned update; refreshing the catalog never rewrites a retained study.

```sh
corepack pnpm exec tsx scripts/prepare-housing.ts \
  --source-dir /explicit/path/to/retained-official-downloads \
  --output-dir /explicit/new/catalog-directory \
  --declared-by "Operator source-rights reviewer"
```

Set `HOUSING_CATALOG` to the prepared directory for the API's read-only public catalog. Separately install the exact same catalog into the selected database's trusted source registry using `scripts/install-housing-catalog.ts`, an explicit target and `--operator-confirm`. Runtime startup does not provision the registry. The operator step uses either an explicit `--database-file` or the database owner/migration connection, never runtime credentials. Do not point verification at an existing user's store. Local verification uses isolated stores and unique PostgreSQL schemas; the main store has not been migrated or started for this feature.

The public catalog routes are `GET /api/v1/housing/catalog` and `GET /api/v1/housing/packs/:hash`. Searches support names plus optional state/county filters, with bounded pagination bound to the catalog and query. The authenticated `POST /api/v1/projects/:projectId/housing/adopt` route checks project and scenario revisions before atomic adoption. Ordinary project Save also validates all server-catalog claims against the configured and trusted registered source. A readable download receipt establishes retained acquisition evidence; it is not an independent cryptographic signature by HUD.

## Persistence, disclosure and exports

Housing uses project format 13, immutable project-owned income-limit packs, scenario controls and complete current/undo/history references. Existing projects without housing controls retain their prior interpretation. Imported/restored copies retain values and citations but lose server-catalog authority. The UI and reports distinguish imported evidence from operator-verified catalog evidence.

All external cost sources and income-limit sources require explicit processing, private display, historical retention, export and public-redistribution declarations for the applicable use. Private planning does not imply permission to publish. Housing source inventories remain separate from planning and fiscal citations even when their identifiers collide. Saved public views retain the selected packs and frozen results; later private changes do not rewrite them.

The dedicated CSV includes exact group inputs, component states, complete frozen rows, reconciliation, cumulative and exclusive counts, source packs and source receipts. Workbook exports include typed comparison, exclusive-band, coverage, group, component, household-limit and evidence sheets. PDF, Word and printable HTML include readable comparisons, costs and source appendices. GeoJSON retains the selected housing metadata; complete project/records exports retain historical evidence. Generic Shapefile output remains geometry-only. Export paths enforce source permissions and matching frozen input/result hashes; they do not silently recalculate an old publication.

Documents refuse an oversized housing appendix instead of silently dropping groups or evidence. Complete CSV, workbook and project records remain available subject to their source permissions. Browser previews run in a worker, preserve raw incomplete drafts, and reject results from a changed account, project or revision.
