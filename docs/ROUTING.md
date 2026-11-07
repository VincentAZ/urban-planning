# Captured regional routing

This foundation runs a real, self-hosted Valhalla graph for Arizona. It supports **inbound car and walking travel to a site** and independently hashed **outbound car and walking travel from an origin**, with separate 15/30/45-minute reverse and forward isochrones for visualization. It does not provide scheduled transit, observed peak congestion, or route changes caused by authored scenario streets. The small OSM preview stored in a planning place is not the routing graph.

There is no paid routing provider, external visitor request, or per-query service charge. Local CPU, memory, storage, and eventual hosting still have costs. Resource limits and the application budget ledger do not guarantee that an external hosting invoice stays below the owner's monthly ceiling.

## Prepare and run

Requirements: Linux amd64, Docker, Python 3, at least 22 GiB free disk, and permission to run Docker. Existing application/database containers are not changed. The official image is pinned to Valhalla 3.9.1 and the amd64 OCI manifest:

```text
ghcr.io/valhalla/valhalla@sha256:18cb42988e03c70dc4bc4ca095a259ec4db5e5df928be65956fc1c64c280b47a
```

Run from the repository root:

```sh
python3 scripts/prepare-routing.py --start
```

The operator CLI downloads only the hardcoded Geofabrik Arizona PBF and extract polygon. Each download has a byte cap and timeout. A previously captured file is reused only when its allowlisted URL, retrieval metadata, stored size, and SHA-256 match. Orphaned source files or receipts are preserved and rejected rather than silently replaced. It builds administrator boundaries and routing tiles in a network-disabled container; time zones, elevation, traffic, and transit are not downloaded. A successful graph gets a manifest and per-file hash inventory before the `active` symlink changes. Failed work stays separate from the active graph.

Build limits: 2 CPUs, 8 GiB RAM without extra swap, 256 processes, 30 minutes, and a 20 GiB aggregate routing-directory cap. Old captured graphs are not automatically deleted. If the archive fills, the operator must deliberately archive reviewed old artifacts. Downloads are capped at 512 MiB for the PBF and 1 MiB for the polygon. The container image is pulled by immutable digest. Docker build memory is sampled, so the manifest labels the recorded peak as a sampled maximum rather than an exact instantaneous maximum.

The runtime is named `urban-planning-routing`, publishes only `127.0.0.1:8002`, mounts the selected graph read-only, drops capabilities, disallows privilege escalation, has a read-only root filesystem, and limits RAM to 2 GiB and CPU to 2 cores. Logs rotate. `compose.routing.yaml` provides the corresponding dedicated service definition; the CLI works without the Compose plugin. The native runtime uses one service worker and forces `timedistancematrix` for both modes, allowing a single reverse search for a shared inbound destination or a forward search from one outbound origin. Its synchronized LRU tile cache has a hard 256 MiB limit, and retained search allocations are cleared between requests. These are individual resource controls, not a guarantee that every permitted input succeeds within 2 GiB. It has no configured remote tile, traffic, or transit sources.

```sh
curl http://127.0.0.1:8002/status
docker stop -t 5 urban-planning-routing
docker start urban-planning-routing
```

Preparation refuses to replace a graph while the dedicated service is running. Stop only this named service before deliberate graph refresh. Do not run broad Docker cleanup commands. An existing unrelated container or network with a reserved routing name is not adopted or removed.

## Captured artifact

The active manifest is `.local/routing/active/manifest.json`. It records the engine version and image digest; source URLs, timestamps, byte sizes, and SHA-256 hashes; configuration SHA-256; graph file count, byte size, and aggregate inventory hash; exact Geofabrik extract geometry; fixed costing profile; resource observations; limitations; and attribution. `graph-files.json` binds each `.gph`, `admins.sqlite`, and `tiles.tar` file by relative path, byte size, and SHA-256. The graph hash is SHA-256 over the compact JSON inventory with each object's keys sorted. The source PBF is retained.

`loadRoutingManifest(path)` validates the manifest and bounded configuration and streams every graph file through SHA-256. File sizes are checked before metadata allocation and during graph streaming. **Load once and cache the result**, not on every HTTP poll. The configured manifest must refer to the graph mounted by the dedicated service. Earlier unbounded configurations and their result artifacts remain archived; the current loader rejects using those configurations for new work. The adapter rejects external URLs, redirects, path-bearing base URLs, unknown modes, oversized work, and unexpected native response shapes.

## Adapter contract

```ts
import {
  loadRoutingManifest,
  ValhallaRouter,
} from "./apps/api/src/routing/index.js";

const manifest = await loadRoutingManifest(
  ".local/routing/active/manifest.json",
);
const router = new ValhallaRouter({
  baseUrl: "http://127.0.0.1:8002",
  manifest,
});
const matrix = await router.inboundMatrix({
  site: [-112.074, 33.4484],
  mode: "car", // or "walk"
  origins: [{ id: "origin-1", position: [-112.074, 33.46] }],
  signal,
});
const map = await router.inboundIsochrone({ site, mode: "car", signal });
```

Every input origin ID appears exactly once, in input order:

| Status              | Meaning                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reachable`         | Native routing returned finite seconds and distance. A route can exceed the displayed threshold.                                                                        |
| `unreachable`       | Native routing returned no connection within the configured bounded search. It does not prove absolute physical disconnection. This is distinct from a service failure. |
| `unsnappable`       | No usable edge was found within the maximum snap distance. This is unknown cohort coverage, not zero population.                                                        |
| `outside-coverage`  | The origin is outside the extract and is not otherwise excluded by the conservative time bound.                                                                         |
| `outside-threshold` | A mathematical lower bound exceeds 45 minutes. It does not assert that no road path exists. `lowerBoundSeconds` retains the proof value.                                |

HTTP failures, timeouts, invalid/partial matrices, altered/clamped request warnings, duplicate identities, and excessive snaps fail the run. They never become zero counts. The adapter accepts at most 200,000 total origins and at most 60,000 origins requiring native routing. It sends serial car chunks of 250 and walking chunks of 25, with a 30-second request deadline and a 10-minute total run deadline. Limits reject the complete job rather than silently sampling or truncating. The application must still provide durable job admission, project authorization, cancellation, and operator budget policy; this module is independent of that store.

Validate low-level results with the exported `routingMatrixInputHash(manifest, request)` and `routingIsochroneInputHash(manifest, request)`; both bind the exact site and mode. `routingProfileHash(manifest, mode)` binds the native configuration and actual request costing/matching/search options. Use the shared `workforceRoutingInputHash` for persisted cohort evidence. The low-level adapter's input hash separately binds its graph/configuration, site, mode, and ordered origin inputs. A complete saved run also needs the cohort-pack hash, cohort geographic-coverage proof, source universes, and all rows. A graph-coverage assertion alone does not prove that a population source covers the catchment.

The matrix's `search` record retains its algorithm, base expansion distance, terminal-edge padding policy, and every native batch's input range, routed count, maximum correlated-edge length, and actual expansion distance. Preserve this record with the result: it makes the threshold-completeness claim auditable instead of relying only on a configuration label.

## Coverage and travel-time meaning

The whole possible 45-minute catchment must lie inside the captured extract. The guard measures distance to every extract ring, including holes, reduces the spherical distance by 1%, and requires enough clearance for the maximum travel distance, both 250 m snaps, and an additional 1 km margin.

- Car costing explicitly caps edge speed at 140 km/h in the pinned native engine; it uses static speeds. The required clearance is 106.5 km, and its base search expansion distance is 105 km.
- Walking uses 5.1 km/h. Native grade adjustment can make some downhill travel faster, so the proof conservatively uses 10 km/h. Ferries are hard-excluded and ferry endpoint matching is filtered. Required clearance is 9 km, and its base search expansion distance is 7.5 km. A path taking at most 45 minutes at no more than 10 km/h cannot be longer.
- Both modes add the longest native correlated endpoint-edge length in each batch to the base expansion distance. The pinned native algorithm checks an entire edge before resolving a destination partway along that edge; padding prevents it from pruning a valid partial-edge destination. Walking's `max_distance` receives the same padded bound. The native verbose locate response supplies the exact edge length, the profile hash binds the policy, and the result retains every actual padding value. An endpoint edge above 50 km is rejected explicitly. The padding expands the search without changing the 15/30/45-minute count thresholds.
- A null connection means no connection found within this threshold-complete bounded search, not absolute physical disconnection. Bounded search, single-destination reverse routing, and cache controls contain memory without truncating the origin list.
- For an origin that is too far even at that maximum speed, the shared core helper computes `max(0, 0.99 × greatCircleMeters − 500) / maximumMetersPerSecond`. Only a value strictly greater than 2,700 seconds qualifies as `outside-threshold`.
- Native matching is requested within 249 m, reserving 1 m for coordinate serialization while enforcing the external 250 m limit. Matrix-returned correlated coordinates are checked. An actual origin snap is null if the native response does not supply it. The site's reported snap is its nearest eligible candidate, which can differ from a particular matrix pair's chosen candidate.
- Travel across the off-network snap gap is not added. Results are representative-point, modeled network travel times, not door-to-door observations.

Reverse isochrones send native `reverse: true`. Their interpolated polygons are display aids; population and job counts must use point-specific matrix times. Counts must never come from uniformly spreading block populations over those polygons without a separate stated allocation method. The adapter does not add jobs or population to its routing-only evidence.

## Verification

```sh
./node_modules/.bin/vitest run apps/api/src/routing/routing.test.ts
./node_modules/.bin/tsx apps/api/src/routing/smoke.ts
```

The explicit native smoke uses the prepared Arizona graph for two sites, car/walk matrices, genuine reverse contours, a direction-sensitive pair, and a lake point with no nearby usable road. Artifacts are written under `.local/qa/routing/native`; they are routing evidence rather than workforce estimates. The original 1,000-point synthetic car observation took 4.66 seconds. That early load test did not prove full-run memory stability and is retained only as a checkpoint. The 60,000 native-candidate cap remains subject to the ten-minute deadline; larger inputs fail rather than being silently split into unbounded jobs.

Initial unbounded pedestrian search and a later full car run using the native default cost matrix each exceeded the 2 GiB limit and stopped with no published totals. Their evidence remains under `.local/qa/workforce`. The final configuration uses the bounded reverse algorithm, hard cache limit, allocation clearing, and terminal-edge padding described above; the memory limit was not raised.

The final Phoenix car acceptance run completed in 192.05 seconds, including 187.18 seconds measured by the runner, and preserved 155,335 distinct cohort-origin rows. Of 57,323 candidates inside the conservative time bound, 686 were unsnappable and 56,637 were sent through 239 native matrix batches. Actual batch padding ranged from 234 to 8,003 m. Sampled native memory peaked at 278,839,296 bytes (about 266 MiB); the cgroup lifetime peak was 374,112,256 bytes, already present before this run. No OOM event occurred. The artifact is `.local/workforce/runs/8b11345cb320df032cabd57c41551bfef5ef823f13fb5354096b78f2ae2894d0.json`, with log and resource samples under `.local/qa/routing/car-retune/phoenix-car-padded-*`. Unresolved Census allocation and snapping still make the resulting cohort estimates partial. Successful routing does not erase those limitations.

The initial verified graph build took about 70.4 seconds with a maximum sampled memory usage of about 1.51 GB. Graph inventory size was 982,581,992 bytes including both loose tiles and the archive; captured PBF size was 304,770,813 bytes. These are observations on the current local machine, not hosted capacity promises.

## Outbound matrix and contour acceptance

`outboundMatrix({ site, destinations, mode })` places the selected origin in native `sources` and workplace points in `targets`. `outboundIsochrone({ site, mode })` requests forward contours. Both identities explicitly retain `direction: "outbound"`; the existing inbound hashes and defaults remain unchanged. Matrix index, echoed endpoint, snap, duplicate and missing-row validation apply independently in each direction. The forward search also needs terminal-edge padding before its whole-edge expansion cutoff; it retains the same bounded search and memory controls.

Run an explicit check into a **new** output directory:

```sh
corepack pnpm exec tsx apps/api/src/routing/outbound-smoke.ts .local/qa/routing/outbound-new
```

The retained check under `.local/qa/accessibility/native-direction-v1/` covers Phoenix and Tempe by car/walk, forward contours, a provably distant destination and a genuinely asymmetric route pair. On the captured graph, B→A takes 199 seconds and A→B takes 194 seconds; the outbound A→B result exactly matches the inbound-to-B result. Direction is not inferred from an isochrone shape.

The complete workplace run under `.local/qa/accessibility/full-source-v1/` then exercised project-owned queue, native execution, adoption, publication and exports using all 38,594 source rows. Car completed in 73.532 seconds and walking in 12.406 seconds on the existing local 2-CPU/2-GiB service. These are end-to-end local observations; no peak-memory measurement or hosted-capacity guarantee is claimed. All unresolved routes remain explicit in the [primary-job analysis](ACCESSIBILITY.md), even when source and graph coverage are complete.

## Sources and licenses

- [Official Valhalla 3.9.1 release](https://github.com/valhalla/valhalla/releases/tag/3.9.1), MIT license; [official Docker images](https://github.com/valhalla/valhalla/blob/3.9.1/docker/README.md).
- [Official matrix documentation](https://valhalla.github.io/valhalla/api/matrix/): origin/destination direction and lack of multimodal matrix support.
- [Official reverse-isochrone documentation](https://valhalla.github.io/valhalla/api/isochrone/).
- [Pinned auto costing implementation](https://github.com/valhalla/valhalla/blob/3.9.1/src/sif/autocost.cc) and [pedestrian costing implementation](https://github.com/valhalla/valhalla/blob/3.9.1/src/sif/pedestriancost.cc): elapsed-time speed bounds and ferry/grade behavior.
- [Pinned time-distance matrix implementation](https://github.com/valhalla/valhalla/blob/3.9.1/src/thor/timedistancematrix.cc): single-destination reverse search and whole-edge expansion checks; [native directed-edge serialization](https://github.com/valhalla/valhalla/blob/3.9.1/src/baldr/directededge.cc): exact correlated-edge length; [graph-reader implementation](https://github.com/valhalla/valhalla/blob/3.9.1/src/baldr/graphreader.cc): cache controls.
- [Geofabrik Arizona extract](https://download.geofabrik.de/north-america/us/arizona.html).
- © OpenStreetMap contributors, [ODbL and attribution requirements](https://www.openstreetmap.org/copyright). Preserve attribution in maps and reports and applicable database redistribution obligations. The engine's MIT license does not replace the source database license.

Scheduled transit requires a separate, validated GTFS-aware adapter and feed/calendar/license capture. It is deliberately unavailable here. No public demonstration routing server is used for visitor or batch workloads.
