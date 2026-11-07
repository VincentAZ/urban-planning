# Outbound primary-job accessibility

This workflow counts captured primary jobs reachable from an explicitly chosen origin in 15, 30 and 45 modeled minutes by car or on foot. It uses the regional Valhalla graph and a separate complete workplace destination inventory. Inbound workforce education/occupation remains a distinct workflow.

The source inventory is Arizona LODES 2023 `S000` / `JT01` WAC. `C000` counts primary jobs, `CE01`–`CE03` partition monthly earnings, and `CNS01`–`CNS20` partition industries. The two category families must each sum to total jobs and must never be added together. Exact original CSV fields, physical row numbers, source hashes, retrieval metadata and file release metadata are retained. No generic latest LODES minor version is inferred from a mutable documentation URL. These are workplace jobs, not vacancies, available workers or observed journeys.

All 38,594 retained Arizona workplace rows join exact Census 2020 `INTPTLON20`/`INTPTLAT20` block internal points. Their 2,935,350 jobs include 602 zero-job rows. Twenty-one blocks with 1,213 jobs had ambiguous allocation to a later block-group geography; their original 2020 points remain valid for this direct join. No population weights, ACS allocation, guessed workplace entrances, sampling margin of error or commute OD model enters this calculation.

## Operator configuration

Prepare and verify the source pack with `scripts/prepare-accessibility.ts` and `apps/api/src/data/accessibility.ts`. Configure the resulting `jobs-<sha256>.json`, independently verified Census state boundary, captured routing manifest and loopback-only Valhalla URL. Existing original source files and graph files remain immutable. See [regional routing](ROUTING.md) for graph preparation and native resource limits.

`ACCESSIBILITY_ENABLED` defaults to false. When enabled, configure `ACCESSIBILITY_PACK_PATH`, `ACCESSIBILITY_BOUNDARY_PATH`, `ACCESSIBILITY_MANIFEST_PATH`, optional `ACCESSIBILITY_ROUTER_URL` (default `http://127.0.0.1:8002`) and private persistent `ACCESSIBILITY_ARCHIVE_DIR`. `ACCESSIBILITY_CAPACITY_ENVIRONMENT=deployment` and `ACCESSIBILITY_CAPACITY_STATEMENT` explicitly describe existing fixed capacity. Actual hosting commitments must be recorded or reserved in the owner budget. This is not a claim that external hosting bills are metered or capped. Isolated tests may declare `local-development`, explicitly labeled not production cost validation. No paid provider is invoked.

The default queue admits at most ten queued/running jobs, one pending job per account, three starts per account per UTC day, and three attempts per job. Budget pause/headroom is checked before admission and dispatch. Accessibility, workforce, traffic and GIS compete for the same durable native slot. A lost heartbeat, expired hard deadline, or uncertain native cancellation quarantines capacity; an HTTP abort does not prove a native Valhalla request stopped. Recovery requires trusted operator confirmation through the existing native-capacity CLI. The job deadline is 660 seconds, including the bounded router run. Existing 2-CPU/2-GiB native settings are unchanged.

## Evidence and authorization

A job binds the saved project, scenario, baseline, exact origin, mode, outbound direction, thresholds, complete source pack, independent source boundary, graph and costing profile. The server verifies source and geographic coverage before any native request. Complete source coverage requires the potential 45-minute catchment to fit within the independently captured source region; an Arizona-only inventory never silently assumes zero jobs beyond the state boundary.

The matrix uses one origin and every positive-job destination. Every original source row appears in the retained ledger, including explicit zero jobs. A successful travel time resolves a destination. Missing, failed, unsnappable or null native connections remain unresolved; conservative great-circle lower bounds may exclude individual destinations independently at each time threshold. Partial results retain a known subtotal and unresolved jobs. Upper bounds exist only with complete source and graph coverage; they are accounting bounds, not confidence intervals. Polygon contours are illustrative and do not replace the matrix join.

Routes are under `/api/v1/projects/:projectId/accessibility`: `capabilities`, `jobs`, and `jobs/:jobId` with `cancel`, `retry`, `result`, `artifact`, `adopt`. Read routes require current project access. Mutations require a current editor/owner, CSRF/session checks, expected versions and immutable idempotency inputs. Requester access is rechecked before execution, during heartbeat and before completion. No source downloads, graph preparation or automatic runs are triggered by opening the workbench.

Raw routing evidence is canonical, hash-verified private JSON (64 MiB per artifact; 2 GiB archive). The database artifact retains a bounded compact mode capture and separate exact contour payload. Project history stores neither destination rows nor repeated contour geometry. Server-run claims must exactly equal their project-owned completed artifact, including historical and undone command references. Restore-copy converts all evidence to explicitly imported/unverified origin while preserving numerical values and source identities. An imported receipt never grants access to an original private job.

An unchanged server-owned capture may be reused by another scenario within the same project and immutable baseline. Its origin, query, source and producer job remain exact; cloning does not claim a new run or a scenario forecast. A different project must retain the capture explicitly as imported evidence. Adoption itself still targets the original queued scenario.

Adoption applies a single reversible selected-mode command with optimistic project/scenario version checks. Car and walk captures remain independent, including their origins and acquisition dates. Saved tables and public views remain available if a private raw archive later becomes unavailable; fresh download/adoption reports that failure. Public viewers receive frozen compact evidence and no private archive capability. All exact captures remain in complete JSON; CSV, GIS, workbook and document outputs disclose capture origin, method, coverage and nested source namespace.

Captured-network results do not incorporate authored planning roads, building jobs, horizon growth, observed congestion, parking or transit schedules. Saving an edited scenario cannot silently turn one static result into a modeled baseline/proposal improvement. Native full-state performance and visual acceptance evidence are recorded separately under `.local/qa/accessibility`; unit fixtures are synthetic and make no provider or production-capacity claim.

## Retained acceptance evidence — 2026-11-06

The source preparation independently reconciles all 38,594 rows and 2,935,350 primary jobs against the retained official WAC file and exact Census block points. In particular, 4,834 positive-job blocks have no residents and contain 1,191,179 jobs: filtering destinations by residential population would discard valid workplaces. Source review records 3,203,304 checks in `.local/qa/accessibility/source-preparation-review.json`.

An isolated real-API workflow enqueued and executed each complete source pack through the actual native graph, saved both captures, published a frozen snapshot and checked CSV, XLSX, JSON and GIS outputs. Its exact results are in `.local/qa/accessibility/full-source-v1/verification.json`:

| Mode | 15-minute known subtotal | 30-minute known subtotal | 45-minute known subtotal | End-to-end elapsed time |
| --- | ---: | ---: | ---: | ---: |
| Car | 754,328 | 1,898,521 | 2,134,960 | 73.532 seconds |
| Walk | 61,195 | 96,730 | 150,966 | 12.406 seconds |

Every total remains **partial**. At 45 minutes, car retains 32,424 unresolved jobs and an accounting upper bound of 2,167,384; walking retains 115,484 unresolved jobs and an upper bound of 266,450. These bounds apply to the captured complete region, not current vacancies or all possible real travel. An independent audit made 1,425,992 numeric, row-binding and hash checks across both runs and all 144 total/category/threshold result rows. The raw and compact artifacts reopen under the final project-owned authority rules, with all original QA files unchanged.

The full regression run passes 1,454 tests in 166 files, including actual restricted PostgreSQL and native GIS/SUMO tests. Three browser workflows use real isolated HTTP/storage with explicitly synthetic accessibility execution or imported evidence; they cover query retention through account creation, idempotent recovery, mode preservation, saves, reloads, downloads, public privacy and seven-digit desktop/mobile rendering. Actual native routing is proved by the separate full-source run above. Browser fixtures do not claim production throughput or empirical validation. Build/test logs, screenshots and report artifacts are retained under `.local/qa/accessibility`; the [status ledger](IMPLEMENTATION_STATUS.md) records visual-review coverage and remaining launch requirements.
