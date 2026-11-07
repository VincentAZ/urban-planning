# Captured FEMA flood maps and building exposure

The flood workbench attaches a retained effective FEMA National Flood Hazard Layer (NFHL) dataset to a scenario. It compares the complete baseline and proposal building footprints against the **same captured map**. Editing homes, moving or removing a building, or adding a proposal changes the exposure calculation; the map does not silently refresh.

This is a footprint screening tool. It does not estimate flood depth, probability, damage, insurance requirements or regulatory determinations. Property-specific letters of map amendment are not applied. FEMA mapping and source building/home inventories have their own coverage limits.

## User workflow

1. Open **Layers → Explore flood evidence**.
2. Inspect the prepared map's source, capture time, panel effective dates, revisions and study database date, then attach it.
3. Review baseline/proposal totals, known subtotals and buildings with unresolved quantities or coverage. Search/filter the complete paginated building ledger and select a building for editing.
4. Use ordinary edits, undo/redo, scenario copies and account saves. The selected source is retained with the project.
5. Download the complete building CSV or use the existing project/report exports. A published scenario includes only its selected frozen flood dataset.

Older evidence offers **Update calculation method** in an editable scenario. This retains the exact source map, explains that results may change and records a reversible edit. Undo restores the original reference, including an omitted legacy method field. Read-only/public views show their saved method. Comparing different methods discloses that a common flood baseline is unavailable.

Guest attachment and local editing are free and require no account. Saving to an account is free. Imported copies are explicitly labeled as evidence whose source claims have not been verified by the server. The feature does not start a paid service or live FEMA request from the browser.

## Source preparation and authority

The operator CLI captures five official service layers: availability (0), map revisions/LOMRs (1), FIRM panels (3), flood hazard zones (28), and seclusion boundaries (29), plus Study_Info (41). It requests the complete envelope inventory, every record with original attributes and WGS84 geometry, and repeated inventories/records/study data. Any observed change, omitted ID, truncation, invalid response or exceeded bound fails the preparation.

Sequential repeat checks establish observed capture consistency, not a transactional point-in-time guarantee from the NFHL service. Panel effective dates, LOMR dates, study index dates, database revision dates and retrieval times remain separate. Preliminary dates and source placeholders are not presented as effective dates.

Each new preparation directory retains original response bytes by SHA-256, a capture receipt, the normalized pack and its manifest. The loader replays normalization from those raw bytes and verifies the complete result. Clipping retains all intersecting polygon parts and holes without simplification or repair; it does not turn envelope-only matches into in-area features. Raw polygons remain archived even when their exact study-area intersection is empty.

Binary64 arithmetic can produce collapsed lines or minute residual triangles at a clipped boundary. Containment validation accepts a residual only if it collapses to fewer than three exact points, or every vertex's immediately adjacent representable coordinate cell intersects one common original boundary segment with parameter in `[0,1]`. Exact integer/rational arithmetic verifies that certificate. It is not a metre/area buffer and changes no source coordinate. Exposure calculations do **not** use this containment allowance to erase positive-area coverage gaps. See [model methodology](../packages/models/METHODOLOGY.md).

Current preparation bounds are 32 MiB per response, 128 MiB total raw responses, 5,000 raw features, 200,000 raw vertices and a ten-minute capture deadline. Normalization runs in a bounded worker. A normalized pack is limited to 8 MiB, 5,000 features and 50,000 vertices. A project/configured catalog can retain up to eight packs and 16 MiB. Exceeding a bound rejects the operation without dropping records.

The public catalog serves only explicitly configured, replay-verified preparations. Configuration directories are confined to the catalog root. Requests cannot supply arbitrary filesystem paths or external URLs. Source authority is installed by an explicit operator command into an immutable registry; normal API startup and web/auth/worker database roles cannot create or replace it. Runtime configuration can retire a source while previously retained project evidence remains available.

See [API setup and commands](../apps/api/README.md) for `prepare-flood.ts`, `install-flood-catalog.ts`, `FLOOD_CATALOG` and migrations 015–017. Migration 017 validates method references without rewriting older scenarios, histories or publications. Do not point QA commands at the retained development state or a production store.

## Calculation contract

New attachments select `flood-footprint-1.1.0`. An omitted method field means legacy `flood-footprint-1.0.0`; explicit 1.0 references also remain supported. Unsupported, null or malformed method values are rejected. Both methods screen positive-area intersection with classified Special Flood Hazard Area (SFHA) polygons. A building contributes all its known physical homes once, regardless of overlap fraction or overlapping hazard polygons. Boundary contact alone does not count. Scenario growth assumptions and horizon dates do not multiply these physical home counts.

Method 1.1 combines adjacent mapped zones before screening each building. Its classified coverage is `(union(classified zones) ∩ union(availability)) − union(undetermined zones)`. This avoids artificial gaps produced by repeatedly clipping individual adjacent zones. Real gaps remain unknown. Exact canonical-decimal shoelace positivity decides whether an overlay has area; diagnostic square metres do not decide a building's status. A conservative indexed shortcut proves strictly inside/outside relationships and falls back to the normal overlay for boundary, hole, island or mixed cases it cannot prove. No coordinate is snapped and no distance/area tolerance fills a gap. Method 1.0 retains its original operation order and numerical behavior for exact replay.

For a no-SFHA result, the whole footprint must have classified coverage inside the retained availability coverage, after removing undetermined classifications. Zone D, unmapped areas, gaps and inconsistent source classification remain unknown. Availability and panel polygons alone do not establish a hazard classification. Seclusion context is disclosed without erasing the retained effective hazard mapping.

| Situation | Home contribution |
| --- | --- |
| Positive-area SFHA intersection and known homes | All known homes once |
| Positive-area SFHA intersection and unknown homes | Unknown |
| Complete classified coverage without SFHA intersection | Zero, including when home quantity is unknown |
| Undetermined exposure with a nonzero or unknown home quantity | Unknown |
| Proven zero homes | Zero; map uncertainty remains visible in the building row |

A complete total is unavailable if a contributing quantity or exposure remains unresolved. The known subtotal is shown separately; it is never silently substituted for the total. Baseline/proposal deltas are unavailable when either complete total is unavailable. Invalid/missing source context cannot fall back to an old scalar metric.

The exact dataset hash, canonical contents and effective method bind model caches, reports and saved references. Unchanged footprint calculations are reused across quantity edits. Dataset contents are checked before cache reuse; a mutated object cannot keep an old trusted result. Prepared method-1.1 masks are limited to 100,000 vertices per mask, 500,000 vertices in total, 5,000 polygons per mask and 100 million estimated edge-pair operations. An exceeded bound or preparation failure makes the whole calculation unavailable; it never truncates source evidence.

## Responsive processing and limits

Browser attachment, flood-bearing snapshot restoration and import run complete source validation in cancellable workers. Impact calculations keep a warm worker per active consumer; comparisons process at most four scenarios. Each operation has a 90-second deadline. Navigation, closing a pending attachment, permission loss and superseding edits invalidate the pending result. CSV/HTML exports use the result for the exact current calculation inputs and remain unavailable while those inputs are updating. Browser workers have deadlines and bounded source inputs; they do not provide an operating-system memory ceiling.

The API shares one process-local worker slot across source normalization, topology admission, selected-flood model calculation, document/data export and GIS preparation. It permits two waiting tasks, a 30-second queue deadline and a 60-second execution deadline. Serialized input and output are each limited to 160 MiB; V8 old-generation heap is configured to 512 MiB. This is a heap setting, not a hard RSS limit. Capacity is released only after worker termination is confirmed; uncertain termination quarantines the slot. Native GIS execution retains its separate existing admission and process limits.

Heavy calculation occurs outside database transactions. Publication rechecks current owner authority, project version and scenario revision after calculation before saving its frozen result. Successful topology admission is cached only under the exact canonical dataset identity. This scheduling does not introduce a client-supplied validation bypass or change source bytes, geometry acceptance or the exposure method. Cross-process admission and measured production memory/throughput remain deployment work.

## Storage and outputs

Project schema 11 stores each pack once in `project.floodDatasets`. Scenarios and history contain a small versioned hash/origin reference. Atomic attachment retains the pack and the reversible command together. Earlier project formats and unrelated model/source identities remain compatible. Restore/copy into a new project marks copied evidence as imported.

New server-catalog references require exact configured and registered content, current project authority and the immutable baseline. Account saves, commands, adoption, undo history and SQL storage checks enforce those boundaries. Private evidence does not gain public rights because a caller supplies a hash or a trusted-looking label.

CSV and XLSX retain every baseline/proposal building row, null values, classifications, zone IDs and method identity. XLSX also retains complete selected source and result JSON in bounded cell chunks. GeoJSON retains original source attributes and all five geometry kinds. Complete project records retain the catalog/history needed for replay. Public snapshots expose only the selected pack, without private catalogs or archives.

PDF and Word include paired maps bound to the same source hash, complete source-zone inventory, exposure summary, effective/revision dates and method/coverage disclosures. Their building summary points to the complete CSV/XLSX ledger. The map shows unknown coverage separately from retained SFHA/floodway classifications. A document exceeding its explicit inventory/text limit fails rather than silently omitting evidence.

Shapefile output includes source geometry layers and exact GeoJSON/JSON sidecars; DBF columns are a compatibility projection. The existing native export cap of 5,000 features or 50,000 vertices still applies. The complete retained Phoenix planning baseline exceeds that cap and is rejected without omissions; complete CSV/XLSX/GeoJSON/records remain available. The complete Chicago test proposal exports successfully within the existing limits: 356 buildings, 2,425 roads and 11 retained source features. Native QA also exercises a complete synthetic project and the actual Phoenix flood source layers alone; those do not constitute a complete Phoenix Shapefile export.

## Local source observations and remaining work

The retained 85004 and 60601 preparations cover their exact Census 2020 ZCTA boundaries. These are two prepared areas, not national availability or custom city deployments. Their source packs and detailed evidence remain under `.local/flood/` and `.local/qa/flood/`, outside source control.

For the captured 85004 baseline, all 1,729 retained building footprints resolve without an SFHA intersection. This does not establish an absence of flood risk or validate the completeness of the building inventory. An explicitly authored 20-home test proposal intersects the retained SFHA and contributes 20; moving it to a classified non-SFHA footprint contributes zero; an unknown home quantity keeps the total unavailable.

Under method 1.1, the captured 60601 baseline retains 355 buildings and has a complete mapped-exposure total of 13 recorded homes. Adding the authored 20-home SFHA proposal produces 33; changing the selected exposed building to 23 homes produces 35; an intersecting building with unknown homes still withholds the full total. The method update changes 12 baseline classifications from undetermined to no SFHA intersection, including the formerly unresolved contributing buildings. Nine other rows have only diagnostic-area corrections. The original method-1.0 result remains unavailable with a known subtotal of 13, and all five retained legacy cases in each area replay exactly. No source pack or building inventory was changed.

Both final method-1.1 audits pass: **104,097 checks for 85004** and **21,644 for 60601**, including complete source identities/attributes, every normalized clip, duplicate-ID rejection and all five baseline/proposal case ledgers. Both audits disclose a self-intersection in a wider raw availability polygon outside the respective study boundary. Only independently valid, equivalent local clips are accepted; raw bytes are not repaired and global source validity is not claimed.

The earlier four Chicago clip discrepancies came from different coordinate interpretations: the installed JavaScript clipping dependency converts coordinates to canonical decimal values, while GEOS uses binary64 values. Exact fraction calculations prove the same original source/study edge crossings in both domains, each correctly rounded to its stored coordinate. One near-parallel crossing differs by 13 representable latitude steps; an adjacent-cell test alone cannot establish its equivalence. The new independent certificate verifies complete boundary graphs, ring cycles, components and hole parents, with a unique original segment pair for each crossing. It accepts exact original collinear subdivisions only after an on-edge/between-endpoints proof in both domains. It has no distance or area threshold and alters no coordinate. Canonical-source formatting/hash preconditions are checked before using the certificate. The original failed audit remains retained and is not relabeled as passing. See the [reproducible offline auditor and its limits](../scripts/qa/flood/README.md).

The current cold Node model observations are **240 ms for 85004** and **235 ms for 60601**, versus the earlier roughly 13-second and 1.55-second observations. Subsequent quantity/proposal cases measured about 22–23 ms and 5–11 ms respectively. A separate native comparison checked 2,214 strict-shortcut decisions, including holes, multipart shapes, concavity, tiny gaps and actual source/building pairs, with no disagreement. These are local observations, not a controlled benchmark or production capacity guarantee.

Real browser attachment observed about **2.1 seconds for Phoenix** and **1.1 seconds for Chicago** using the outer interaction timer. In-page measurements separate action-to-commit (1,341/663 ms) from commit-to-rendered result (365/352 ms). The two timing methods have different starting boundaries. Neither is p95 evidence. The plan's three-second gate applies to scorecard updates after a committed edit; usable baseline readiness has a separate ten-second gate. Representative hardware, concurrent load, full national baseline preparation and production memory/cost measurement remain outstanding. The API still creates a fresh worker per operation; the prior method-1.0 API timing receipt is historical evidence, not a new method-1.1 service benchmark.

Both preparations are installed only in a separate local QA catalog for these checks. The original catalog and main development state are unchanged. Verification does not imply a deployed city implementation or complete real-world building/mapping accuracy.

The app remains **100% free**, with its **administrator-adjustable $300/month operating allowance**. Cached public data avoids per-user FEMA calls. Hosting, egress and future regional preparation still need measured production budgets and provider-level controls. No paid provider or deployment is enabled by this milestone. Future Chicago/Brooklyn custom implementations can use the same source/preparation boundary without introducing billing now.
