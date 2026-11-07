# Census commute demand: source preparation and bounded local assignment

This pipeline prepares a disclosed resident cohort, preserves unresolved demand, and compiles only verified local routes. Operator-prepared recipes can be exposed in the saved-project traffic workbench through an explicit network selection and immutable source binding. It is not a complete ZIP traffic forecast, a calibrated OD matrix, or a launch-complete capability. The evidence section below distinguishes operator simulations from workbench verification.

The app remains free. These tools use public downloads and the retained local routing/simulation engines; they do not enable a paid provider or change the administrator-adjustable $300/month operating ceiling. Public downloads do not require the pending Census API key.

## What is modeled

For each selected native ACS tract and departure bin:

```text
expected one-way drive-alone vehicles to an OD destination
  = ACS B08132 drive-alone/departure-bin estimate
  × LODES JT01 jobs in that home-block/work-block pair
  ÷ all LODES JT01 resident primary jobs in the home tract
```

The joint ACS cells `B08132_017` through `_030` already describe drive-alone commuters by departure time. Mode and departure are not multiplied as independent marginal distributions; no second work-from-home or occupancy factor is applied. Original estimates, 90% margins of error, raw missing-value statuses, and all 90 table cells remain retained. See the [official B08132 table](https://api.census.gov/data/2024/acs/acs5/groups/B08132.html).

This allocation assumes that LODES primary-job destinations represent the destination distribution of the ACS drive-alone cohort. The source universes and reference periods differ. LODES job relationships are partly synthetic; Census block internal points are proxies, not observed entrances. The method models one outbound vehicle leg. Escort return legs, carpool vehicles, school/shopping/freight trips, and background demand are not inferred from residual traffic counts. Native `passenger` is a simulation class, not a verified FHWA vehicle classification.

The captured source pack pins **2023 JT01 LODES** and **2020–2024 ACS five-year estimates**. It retains the current release metadata separately from each file's actual `createdate`, raw/compressed checksums, HTTP metadata, and retrieval time. The live `LODES8` directory is not a minor-version pin. [Census announced LODES 8.5 on November 5, 2026](https://www.census.gov/newsroom/press-releases/2026/onthemap-lehd-lodes.html); that does not change the explicitly selected 2023 source year.

## Completeness before routing

Arizona's OD main file contains Arizona-home → Arizona-work jobs. Arizona's auxiliary file contains out-of-state-home → Arizona-work jobs; it does **not** supply Arizona residents' out-of-state work destinations. The [official LODES documentation](https://lehd.ces.census.gov/doc/help/onthemap/LODESTechDoc.pdf) defines these file semantics.

The captured statewide reconciliation is exact: 2,965,943 RAC resident primary jobs = 2,887,300 main-file jobs + 78,643 unresolved outbound jobs. WAC workplace jobs (2,935,350) equal main plus 48,050 auxiliary jobs at every workplace block. Missing destinations retain their share of ACS demand instead of being redistributed over available destinations. Auxiliary inbound jobs need their own resident-state RAC, ACS and geography evidence before vehicle demand can be estimated.

ACS joins use the retained **TIGER2024 suffixed-block relationship**, not a tract prefix guessed from a 2020 block ID or the newer LODES crosswalk. Split-tract blocks remain unresolved. A selected tract with positive resident jobs on an ambiguous split cannot claim a complete denominator. The source preparer scans and reconciles the full state before retaining a bounded selected cohort.

## Operator workflow

Each command retains content-addressed artifacts and refuses to replace original sources. Paths below identify the retained Phoenix example; use explicit new output paths for new network preparations.

1. Prepare a complete resident-tract source cohort. Add `--download` only when the official files have not already been captured. Acquisition is bounded at 256 MiB; the current retained input set is 189,387,241 bytes.

   ```sh
   corepack pnpm exec tsx scripts/prepare-traffic-commute.ts \
     --blocks .local/workforce/prepared/blocks-04-f252aa5b625579b914e796d0c655158ca5dcc44b162ac7bae0fa954a32cb062d.json \
     --blocks-sha256 f252aa5b625579b914e796d0c655158ca5dcc44b162ac7bae0fa954a32cb062d \
     --tracts 04013113202
   ```

2. Write an explicit recipe with selected tract IDs, native departure-cell IDs, the fixed-offset analysis period, each home tract's IANA time zone/offset, `withinBin: "uniform"`, source IDs, and review notes. A complete example is retained at `.local/qa/traffic/commute/cohort-recipe.json`. Arizona is not assumed to have a single time-zone rule. Build the prior using the source pack path returned by step 1:

   ```sh
   corepack pnpm exec tsx scripts/prepare-commute-prior.ts \
     SOURCE_PACK.json RECIPE.json .local/traffic/commute-prepared
   ```

3. Prepare a separate regional route profile using `scripts/prepare-commute-routing.ts`. This verifies the retained Valhalla graph, enables route and exact `edge_walk` trace actions in a separately hashed configuration, and leaves the existing accessibility service untouched. Run that profile in a dedicated loopback-only service with the graph mounted read-only. The retained QA instance uses port 8004, 2 CPUs and 2 GiB; its exact command, image/config/graph hashes, and status are in `.local/qa/traffic/commute-routing/runtime-*.json`.

4. Prepare an explicit urban access baseline if the default SUMO service-road permissions are unsuitable:

   ```sh
   corepack pnpm exec tsx scripts/prepare-traffic-network.ts \
     .local/traffic/extracts/phoenix-85004-1km.osm.xml \
     .local/routing/sources/arizona-latest.osm.pbf.json \
     .local/traffic/networks/NEW_NETWORK_DIRECTORY \
     --infer-unrestricted-service-passenger
   ```

5. Capture every selected OD's regional route and local correspondence, then compile. `PRIOR_RECEIPT.json` is returned by step 2. The route tool retains successful and unsuccessful outcomes, raw response hashes, exact correspondence evidence, and all 805 example OD identities; no sample is substituted.

   ```sh
   corepack pnpm exec tsx scripts/prepare-commute-routes.ts \
     SOURCE_PACK.json PRIOR_RECEIPT.json REGIONAL_PROFILE_DIRECTORY \
     NATIVE_NETWORK_DIRECTORY ROUTE_OUTPUT_DIRECTORY

   corepack pnpm exec tsx scripts/compile-traffic-commute.ts \
     SOURCE_PACK.json PRIOR.json ROUTE_SET.json \
     NATIVE_NETWORK_DIRECTORY .local/traffic/commute-prepared
   ```

The compiler rederives the prior, checks all source/prior/network/route-set identities, and requires exactly one outcome per selected source OD. It adds regional prefix travel time and the home/local clock difference before intersecting the local departure window. Before-window, after-window, warmup, no-intersection and unresolved route quantities remain distinct. Conditional ACS sampling margins combine weights from each original cell before applying that cell's MOE; they do not quantify routing, synthetic-data, or allocation uncertainty.

Largest-remainder rounding applies once to admitted fractional mass. Stable source-ID ties can favor that ordering for sparse demand; this is one deterministic integer realization, not observed trips. Zero-vehicle contributions remain in the full ledger while only positive rows enter native demand. More than 30,000 vehicles fails admission without truncation or scaling. Narrow the explicitly reviewed cohort/window instead.

## Retaining a recipe in the workbench

Package the normalized source pack, prior, route set, compilation and statewide reconciliation with the retained regional proof directory:

```sh
corepack pnpm exec tsx scripts/package-traffic-commute.ts CONFIG.json
```

The configuration has `presetId`, `networkDirectory`, `outputDirectory`, `sourcePackPath`, `priorPath`, `routesPath`, `compilationPath`, `reconciliationPath`, and `regionalProofDirectory`. Paths resolve relative to the configuration file. The command verifies the native network, rederives the source compilation, checks exact route attachment evidence and retained raw-response hashes, and writes fixed immutable asset names plus a receipt. It performs no source acquisition, routing request or simulation.

Original-source junction preparations additionally declare `correspondence` with `profile: "original-osm-junction-v1"`, explicit `policyVersion: 2` or `3`, and `nativeXmlFile`, `sourceGeometryFile`, `projectionArtifactFile`, and `recipeFile`. These refer to exact hash-named files under `native/`, `sources/`, `projection-artifacts/`, and `recipes/` in the retained proof directory. The recipe generated by `trafficCommuteCorrespondenceRecipe(policyVersion)` pins the matcher, source-geometry, projection, regional normalization and replay implementation bytes. A different implementation is not an automatic upgrade of an existing preparation. Version 1 retains its original strict proof behavior.

For these newer bundles, the packager canonicalizes only normalized source-pack, prior, route-set and compilation JSON. Its receipt retains input and packaged raw hashes and byte counts; canonical model identities remain unchanged. Original inputs, source-bound reconciliation bytes and shared raw routing, projection, OSM and native XML files remain unchanged. Whitespace removal never removes a record or changes a quantity.

The private normalized download is bounded at 16 MiB. It includes every flow/bin ledger row and the complete declared source cohort and reconciliation. Large raw regional responses remain in the shared operator proof directory, identified by a complete hash inventory; they are not duplicated into every project history. An oversized bundle fails without dropping rows. The same normalized files enter each run's private archive before capture; the existing combined 256 MiB archive bound still applies.

Registry version 1 keeps its existing behavior. Version 2 allows multiple named preparations for the same exact study geometry, with one `defaultForStudy` entry. Each entry has a `label`; an optional `commutePresets` list supplies `{id, label, directory, manifestHash, regionalProofDirectory}`. All asset directories remain confined to the registry's parent. A selected preparation ID is explicit in new saves; existing configurations, retries and runs continue resolving their frozen preparation ID. Changing the default cannot silently replace a saved graph.

The workbench shows the source estimate, supported local demand and deterministic simulation count separately, with unresolved quantities and source assumptions beside them. Choosing **Use this commute recipe** fills the exact demand and clock but does not start a job. While attached, those values are fixed; counts, seed and supported network controls can still be reviewed independently. **Make an editable copy** removes source verification explicitly and labels subsequent demand as authored. The server rejects any demand, period, endpoint or graph mismatch while the source binding is attached.

Prepared evidence downloads require current project access before and after file verification. The browser checks exact expected size and SHA-256 before offering the file. Saved captures retain a compact recipe/coverage summary; the complete ledger stays in the private archive. Imported summaries and hashes alone never establish server authority. Saved, public and exported summaries continue to disclose the cohort's unresolved demand.

**Inspect trip accounting** explicitly loads the complete protected evidence into a cancellable browser worker. It checks the exact download and selected preparation identities, all source/route joins and accounting totals before displaying any table. The worker has a 30-second deadline and terminates after completion, failure or cancellation. This is a client consistency check against server-verified evidence, not a second scientific or geometric validation. Changing account, project, scenario, network or preparation cannot display a late response from the old scope.

The **Follow the trips** view separates complete preparation totals from the 50-record page. Search home/work block identifiers, filter outcomes, inspect exact source rows and clock shifts, and export all flow/bin or source-cell records regardless of filters. Mobile cards and desktop tables retain the same values. Missing values remain distinct from zero. Job denominators repeat across departure bins and must not be summed across them. The source-cell export also retains unresolved destination allocation, which is absent from known-destination flow rows. CSV exports include every retained record, full numeric precision, explicit missing-value statuses and source fingerprints; an export above 64 MiB fails explicitly without truncation. Import geographic identifiers as text in spreadsheets to preserve their leading zeros.

Fresh server loads serialize asset hashing, normalization and optional correspondence replay within each API process, with at most two waiting loads. The pure replay worker reconstructs normalized regional routes from the exact raw route/trace responses, restores retained projection geometry, binds original OSM geometry and rematches every accepted local path. It runs without routing, native simulation, PROJ or network calls. Dependency hashes are rechecked before a successful content-keyed replay can be reused. The worker has a 60-second execution deadline, a 30-second bounded wait and a 1 GiB V8 old-generation heap setting. That setting is **not a hard process RSS cap**. The compact private archive retains the full numeric source ledger, proof references and replay receipt; full geometric replay additionally requires the separately retained original shared operator files.

## Access and exact native attachments

SUMO's pinned default typemap permits delivery/pedestrian/bicycle traffic on `highway.service`, which is often incompatible with auto routes starting on alleys. The [SUMO importer documentation](https://sumo.dlr.de/docs/Networks/Import/OpenStreetMap.html) describes typemaps as inferred conversion settings. The optional operator policy is explicit and conservative: eligible service motor lanes may gain passenger access; restrictive/unknown access, conditional/directional/lane variants, special service purposes and incident barriers are withheld. Restrictive broader tags win over conflicting permissive tags. Specialized bicycle, pedestrian or bus lanes cannot gain passenger access merely because their source way is eligible.

The worker changes passenger permissions only, then invokes pinned netconvert to regenerate internal connections. It retains the source-policy ledger, original native graph, lane-level changes and final graph. The two-pass conversion also regenerates lane/junction geometry; the new final XML is the matching authority. The old network is never overwritten or silently treated as equivalent.

New v2 inventories retain joined original-way IDs from lane parameters and use six-decimal native output. Existing v1 inventory parsing and archived hashes remain unchanged. Regional/local matching requires directed source-way correspondence, permitted native lane movements and internal-via geometry. An unexplained interior detour, incompatible endpoint, ambiguous match or unsupported reentry remains unresolved. Graph dead ends are not automatically boundary injection ports.

Optional native attachments bind an exact departure lane/front position and arrival lane/position. Native route files, route repair and executed trip output preserve those coordinates. Proposals that remove or move an attachment fail instead of relocating it. Legacy whole-edge demand remains unchanged when attachments are absent. The workbench retains exact fractional interval values through unchanged edits and displays an attachment explanation when such demand is loaded.

## Evidence and remaining work

The selected tract `04013113202` has 851 resident primary jobs, 834 known Arizona destination jobs across 805 OD pairs, and 17 unresolved outbound jobs. Its selected 07:00–08:00 home-departure bins total 120 estimated drive-alone commuters. The prior preserves 117.6028202115 known-destination vehicles and 2.3971797885 unresolved vehicles. This complete source cohort was chosen by location, independently of traffic counts.

The original strict route preparation admits 39 of 805 OD paths. Its complete 1,610-row flow/bin ledger retains 111.9623971798 vehicles with unresolved routing and admits 5.6404230317 expected vehicles, rounded to six. **Most of the cohort remains unresolved in that original preparation.** Earlier more permissive route sets are retained as superseded evidence after independent review found that a short unmatched detour could be skipped; they must not be used as verified demand.

The actual paired native run completed all six requested vehicles on both sides, with zero unfinished/uninserted vehicles, discards, teleports, collisions or route errors. Its explicit QA control reduced one interior edge's speed from 13.4112 to 10.0584 m/s; this is a test, not a planning recommendation. The archived 23-file result is 202,283,809 bytes, SHA-256 `842889b07e764463e75f942d488fb38c8c0d4e0ed2bbc9ae2419260a37cd4508`. Native wall time was 33.826 seconds with measured peak memory 1,846,194,176 bytes under the unchanged 2 CPU/2 GiB bound. Mean simulated travel time happened to remain unchanged for this tiny subset; no network-wide benefit is inferred.

Independent audits checked 21,664 source/mass/rounding quantities and 7,178 accepted route/provenance bindings. The access-policy audit checked every external lane and internal movement, confirmed 8,417 passenger expansions and 1,352 denials without changes to other vehicle classes, and retained all 865 signal programs. It also recorded real two-pass lane-geometry regeneration (up to 8.76 m of length difference); matching and simulation use the final new baseline throughout.

Evidence is retained under `.local/qa/traffic/commute/`, `.local/qa/traffic/commute-routing/`, `.local/traffic/commute-sources/`, and `.local/traffic/networks/phoenix-85004-commute-access-v1/`. The original operator run establishes only the recorded admitted subset; it did not test project adoption. It does not establish full cohort/ZIP coverage, calibration, independent traffic validation, realistic non-commute traffic, field-verified access/timing or production capacity.

The first workbench verification used the same strict 39-route preparation. Its real browser flow selects the second prepared graph, retains the recipe, saves an explicitly detached authored copy, restores the recipe, runs the native pair, adopts the result and reopens it after API restart. Both runs complete all six vehicles without unfinished trips, discards, teleports, collisions or route errors. All 26 files in its 153,551,282-byte private archive were independently verified; the complete 1,610-row ledger and saved summary reproduce from that archive without operator preset files. The final functional browser evidence is `.local/qa/traffic/native-browser/run-7YjImu/`; the reviewed visual checkpoint is `run-yJeWmi/`. Archive and visual review are recorded in `.local/qa/traffic/commute-workbench/`. These were identical-baseline/proposal QA runs, not evidence of an intervention benefit. The mobile conservation table now fits both columns within the narrow viewport; screenshots show only the visible scrolled portion, not the full table simultaneously. That checkpoint’s 1,242-test suite additionally verifies authored quality on detached copies without changing their exact values or attachments.

A separate cached routing refinement proves short turning movements against exact original OSM way geometry and a shared simple junction node. It preserves all prior access, direction, topology, detour and quantization checks. Independent review accepts 112 of 805 routes (73 additional), with 689 unmatched, two unreachable and two unsnappable. The full ledger admits 16.2162162162 expected vehicles, rounded to 16, while retaining 101.3866039953 unresolved route vehicles and the original 2.3971797885 unresolved source/destination vehicles. It passed 29,824 binding checks and 22,985 independent fractional-accounting checks. The refined 16-vehicle candidate subsequently completed both native runs with clean diagnostics; the separate 23-file archive is 202,506,405 bytes. It preserves the original strict preparation and uses an explicitly versioned source-geometry proof profile. Its retained evidence is in `.local/qa/traffic/commute-routing-refinement/` and `.local/qa/traffic/commute-refinement/`.

A further policy-v3 correction handles an exact source-junction boundary where one source leg has zero length. It proves the shared original node, adjacent regional edge, source-way direction and complete positive leg; it does not widen geometric tolerances or permit skipped detours. It retains the prior 112 paths exactly and accepts 660 of 805 source OD pairs. The remaining outcomes are 141 unmatched, two unreachable and two unsnappable. Independent review passed 504,403 binding/raw-trace/source-geometry/compatibility checks and 32,933 fractional-accounting checks. The new verified route-set hash starts `8cca1c271f63`; it is distinct from the earlier superseded permissive 660-route candidate.

The complete 1,610-row policy-v3 ledger conserves the 120 source estimate as 2.3971797885 unresolved-source/destination vehicles, 22.8437132785 unresolved-route vehicles and 94.7591069330 admitted expected vehicles. It rounds once to 95 vehicles. Both native sides completed all 95 with zero unfinished/uninserted vehicles, discards, teleports, collisions or route errors. The operator test changed one interior edge’s speed from 15.6464 to 11.7348 m/s; mean travel time was 177.4421 versus 178.0632 seconds. This is a reproducibility test, not an intervention recommendation. Measured wall time was 31.417 seconds and peak memory 1,852,362,752 bytes under the existing 2 CPU/2 GiB native bound. Independent review verified all 23 archived files (202,991,073 bytes), the exact source demand and all 190 native arrival records. Evidence is under `.local/qa/traffic/commute-coverage-v3/`.

The expanded preparation now also passes the complete browser workflow: explicit selection, protected ledger inspection, keyboard focus and row details, pagination, outcome/search filters, full exports from an empty filtered view, source attachment, authored-copy save, recipe restoration, native paired run, adoption and API restart. Both sides complete all 95 vehicles with clean diagnostics. The original strict39 workflow also passes as a separate regression. Final expanded browser evidence is `.local/qa/traffic/native-browser/run-VoUQiX/`; its 26-file private archive is 154,621,264 bytes, SHA-256 `d91c6aa9df7d902939b263774ad7849f8eed7f346f604c1a29d8bac2e56ce3a4`. Independent archive review reconstructs the exact compact summary and full 1,610-row ledger without operator preset files. It does not re-run geometric verification without the shared original dependencies. The browser pair uses identical baseline/proposal controls and establishes reproducibility, not an intervention benefit.

Five desktop/mobile ledger screenshots were visually reviewed, with supplemental captures showing all mobile source/admitted/rounded totals and unresolved categories. The visual checkpoint is `run-WDGB3c/`, whose application source matches the final functional run; its test proxy deadline was subsequently corrected to accommodate cold retained-source verification. The source-cell table, expanded row details and pagination have functional checks but no separate complete visual acceptance claim. Evidence and limits are recorded in `.local/qa/traffic/commute-coverage-v3/visual-review.json`.

The final regression suite passes 1,287 tests in 146 files with live PostgreSQL and native GIS/SUMO enabled. TypeScript, the production build and formatting checks pass. The existing bundle-size advisory and production load/cost/field-validation gates remain open. See `.local/qa/traffic/commute-coverage-v3/verification.json` for the exact checkpoint scope.

Next gates include additional resident cohorts and external-state evidence, independent reviewed count/class coverage, separately supported non-commute purposes and actual demand fitting. User-visible forecasts must retain these missing-evidence distinctions.
