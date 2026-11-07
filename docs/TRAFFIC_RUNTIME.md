# Native traffic runtime and saved-project workflow

This module prepares a separate directed SUMO network and runs paired, explicit
traffic experiments. It does not convert decorative browser agents, building trip
ends, household vehicle stock, or workforce accessibility into an observed OD
matrix. The complete ZIP plus an explicitly selected buffer remains the intended
network scope. A successful native run does not establish calibration, validation,
regional assignment coverage, sufficient spillback storage, or engineering LOS.

## Verified native tools

The installed official Linux image is pinned to:

```text
ghcr.io/eclipse-sumo/sumo@sha256:1691f722ac2e5a2619c683af457db88de4b68511092e9b6da0affb855d6365cb
```

Both `sumo --version` and `netconvert --version` returned **1.26.0**. Installation
evidence is under `.local/qa/traffic/sumo-*`. The official documentation reports
that some older release tags were republished in October 2026 because their
contents were broken or mixed versions. Use this verified digest, not a mutable
tag. The runtime never pulls an image automatically. SUMO is open source under
EPL-2.0 with GPL-2.0-or-later as the secondary option; retain its notices.

The operator extractor uses isolated **Python 3.12 + PyOsmium 4.3.0**. It needs no
network while reading the retained PBF. It verifies the original file SHA-256 and
refuses to overwrite an existing extract. The existing Arizona source and
Valhalla graph are never changed.

```sh
uv venv --python 3.12 .local/traffic/tools312
uv pip install --python .local/traffic/tools312/bin/python osmium==4.3.0
docker pull ghcr.io/eclipse-sumo/sumo@sha256:1691f722ac2e5a2619c683af457db88de4b68511092e9b6da0affb855d6365cb
```

## Preparing a full study and buffer

`scripts/prepare-traffic-network.py` accepts an operator-selected source PBF,
expected SHA-256, full source-envelope bounds, and a new output filename. The
envelope must contain the whole study plus the declared buffer. It selects
intersecting highway ways, including segments with neither endpoint inside the
envelope, then retains complete way geometry and complete turn-restriction
members. OSM node identities preserve grade-separated crossings. Source node,
way and restriction tags are retained; no arbitrary repair or line clipping is
performed. Unsupported nested restrictions or missing references fail explicitly.

The motor-traffic profile includes motorway/trunk/primary/secondary/tertiary roads,
their links, residential/unclassified/living-street/service roads and generic
road ways. Pedestrian-only and cycle-only networks are not part of this profile.
Permitted bicycles on included roads remain represented. Original PBF coverage
and omitted modes remain explicit; this is not a claim of a complete multimodal
network.

```sh
.local/traffic/tools312/bin/python scripts/prepare-traffic-network.py \
  --source .local/routing/sources/arizona-latest.osm.pbf \
  --sha256 5d95b1a91fb247e657f4ae38ed991c5fd92cd4cd8a5ccaa9b9ad8e2e253c0a7d \
  --bounds=-112.087,33.411,-112.053,33.490 \
  --output .local/traffic/extracts/phoenix-85004-1km.osm.xml

node_modules/.bin/tsx scripts/prepare-traffic-network.ts \
  .local/traffic/extracts/phoenix-85004-1km.osm.xml \
  .local/routing/sources/arizona-latest.osm.pbf.json \
  .local/traffic/networks/phoenix-85004-1km
```

The example outputs already exist locally; choose new filenames for a new
capture. The `netconvert` profile removes redundant geometry nodes while
preserving their shape and recording removed-node lineage. It does not join
unconnected geometrical crossings. Lane connections and signal programs are
generated/inferred, not verified signal plans. The inventory includes directed
edges, lanes, source-way references, junctions, explicit lane connections,
internal-lane references and signal state-index groups. Exact native XML retains
right-of-way matrices and other native details. Canonical graph XML removes only
volatile XML comments; the original native XML is retained as a gzip sidecar.
Movement IDs derive from the exact incoming/outgoing edge and lane tuple. They
do not depend on XML element order, so an overlay cannot silently reassign a
mapped detector to a different junction.

## Retaining observed counts

The FHWA importer retains original ZIP files and selected members with SHA-256 receipts before parsing. It never fetches source archives in a visitor request. No Census key is needed for these published downloads.

```sh
corepack pnpm exec tsx scripts/prepare-traffic-counts.ts \
  --state AZ --state-fips 04 --date 2025-10-02 \
  --stations 104009,0F0085,0F0133 --timezone America/Phoenix \
  --utc-offset-minutes=-420 \
  --clock-basis 'Explicit pilot interpretation: listed Maricopa County station coordinates use America/Phoenix local time; source archive has no timezone field.'
```

The selected date and stations produce 456 retained hourly observations. Original station IDs, direction/lane codes, restrictions, reported zeros, missing intervals and source row identities remain distinct. Subhourly source intervals remain subhourly. Counter-malfunction flags exclude an interval without deleting its reported value. The importer rejects overlapping aggregate/individual counts and incompatible clocks rather than inventing a distribution or DST interpretation. Detector targets and vehicle-class coverage require separate review. A geometric lane match alone does not make an observation eligible for calibration.

Sources: [FHWA published station and traffic data](https://www.fhwa.dot.gov/policyinformation/tables/tmasdata/), [FHWA traffic record formats](https://www.fhwa.dot.gov/policyinformation/tmguide/tmg_2022/traffic-data-formats.cfm). Published statistical availability is recorded without claiming an independent license certification. The 2025 observations and retained 2026 OSM snapshot have different vintages.


## Reviewing observations and defining a baseline count check

The workbench orders **Counts & demand** as period → observations → demand → baseline count check. The observed counts remain separate from entered one-way trips. Exact series share source IDs, station, raw direction/lane/class codes, supplied location, date and recorded clock. A selected-period filter changes the view only. Individual interval cards retain missing values, zeros and exclusion status.

A series mapping requires a reviewed example, explicit lane coverage, class-coverage acknowledgement and an exact affected-record preview. “All lanes” is a deliberate choice for one directed edge. Unknown classes can remain unknown; acknowledgement does not invent a class crosswalk or vehicle composition. Applying a series mapping copies the target, detector fraction, lane/class interpretation and a dedicated note, preserving each record’s source values, coordinates, clock, raw codes and other notes. Changes to the graph, records, series membership or a period-scoped selection invalidate the preview. The source point and graph provide a visual guide; the entered native detector fraction remains authoritative.

A baseline count-check plan records calibration/held-out/context roles, six study-specific acceptance criteria, their retained source citations and a rationale. No numerical threshold is supplied as an agency default. Roles apply to related station/direction/day records, with conservative grouping of combined/unknown directions and reviewed physical-target aliases. Pending browser reviews affect grouping without acquiring a server reviewer stamp or becoming eligible evidence. New saves reject unknown/duplicate selections, cross-role leakage, overlapping constraints and intervals outside the exact analysis clock/window. Existing archived evaluator semantics remain unchanged.

This is a comparison plan, not an automated demand fitter. Missing, factored, unmapped, stale or class-unknown observations stay explicit; an incomplete plan may be saved and run, but cannot yield a passing count check. Saved summaries bound selected observations by all retained records and evaluated observations by mapped records. User-declared holdouts are not proof of independence. Other days need separate runs; count fit alone cannot validate network-wide OD, purposes, travel times, queues or LOS. Configurations retain exact selections/criteria and server-stamped citation permissions through the existing private archive, adoption and publication paths.

The retained October 2025 Arizona archive contains volume records only. A source audit found only `0F0085` and `F0085n` with October volume evidence inside the actual prepared graph bounds; these different identities and sharply different reported totals must not be merged without a coverage review. Public classification metadata describes a much larger separate download, which has not been ingested. The metadata audit and exact original file hashes are retained at `.local/qa/traffic/count-review/source-audit.json`. A separate [operator Census commute pipeline](TRAFFIC_COMMUTE.md) now prepares source-derived priors and verified regional/local route subsets with explicit unresolved mass. Meaningful automatic fitting still needs much broader route coverage, reviewed vehicle classes, separately supported non-commute/background demand and independent validation evidence. Explicit prepared-network selection and retained source recipes are integrated into the saved workbench workflow; complete normalized ledgers remain in private run archives, with partial-coverage summaries on saved results.

## Native adapter

`apps/api/src/traffic/index.ts` exports:

- `TrafficRuntime({ workRoot, allowedInputRoot })`
- `prepareNetwork(input, signal?)` returning the complete inventory, native XML,
  evidence files and measured resources.
- `loadPreparedTrafficNetwork(operatorDirectory)` verifying inventory and native
  file identity before use.
- `runPair({ network, period, seed, vehicles, counts, overlays, demandHash,
countPackHash, signalTimings?, unsupportedChanges?, signal? })` returning a shared recipe,
  exact baseline/proposal results, graph inventories, evidence and resources.

The saved-project service implements project authorization, source review,
budget admission, durable leases and private artifact storage around this adapter.
The native runtime itself has no database credentials, Docker socket inside the
container, remote provider calls or paid service. It only accepts typed data and confined operator files, never user XML
configuration, arbitrary arguments, executable scripts or remote resource URLs.

The worker is copied into each private job directory before execution; its exact
hash is part of the run settings and its bytes are retained with the evidence.
Network topology is reparsed from the verified native XML and checked against
the supplied inventory. This prevents an altered JSON graph from being accepted
alongside an unchanged XML hash.

## Demand, changes and counts

All requested vehicles retain an explicit ID, original OD/route references,
class and intended departure. The same submitted demand and seed are used on
both sides. Speed and lane overlays retain candidate paths; they do not perform
a converged user-equilibrium reassignment. A closure causes
affected paths to be rerouted between the original endpoints; an inaccessible
origin/destination fails rather than dropping or moving trips. The actual
assigned path hash is separate from the original demand hash. Geometry,
direction and turn-control changes are currently rejected when declared. Existing
eligible static programs can be retimed through explicit `signalTimings` controls;
adding/removing signals or changing movement states remains unsupported. Declared
unsupported changes are not silently applied or ignored.

Counts require reviewed network bindings, exact local date/timezone/fixed offset,
interval, class coverage and lane/turn identity. An edge count also requires its
position fraction. Native E1 detectors count completed passages; exact interval
boundaries determine their aggregation period. Unresolved mapping/class coverage
produces `unavailable`, not zero. Pedestrian counts are retained as unavailable.
Lane-level turns that cannot be distinguished by the native detector are also
unavailable rather than merged silently. AADT stays a separate annual statistic.

Keep all original observations even when only an explicit time window is run.
Calibration and held-out validation are separate model-layer evaluations; the
runtime never declares a successful run calibrated. Count fitting does not
identify unique routes or OD demand.

## Diagnostics and bounds

The sandbox runs nonroot, offline, with a read-only root, dropped capabilities,
no new privileges, two CPUs, **2 GiB memory/swap**, 64 processes, restricted file
descriptors, bounded tmpfs and a **180-second wall deadline**. Cancellation kills
the whole named container and removes scratch data only after termination is
confirmed. One operation runs per adapter; the saved-project service also uses
the shared durable slot across worker processes and GIS/workforce/traffic
services. Uncertain termination quarantines that slot.

Admission limits are 30,000 directed edges, 50,000 lanes, 100,000 connections,
500,000 shape vertices, 30,000 requested vehicles, one million route segments,
1,000 count intervals, 250,000 native detector bins, and three simulated hours
including warm-up and drain. These are ceilings, not a guarantee that every
combination completes within the resource deadline. Source XML is bounded at
100 MiB, native graph XML at 64 MiB, declarative input at 64 MiB, and combined
native output at 256 MiB. The caller's complete archive cap still applies after
adding experiment files. Nothing is silently truncated.

Teleports and maximum departure delay are disabled. Results retain intended
departure, actual insertion/arrival, unfinished and uninserted vehicles,
collisions, discards, route failures, waiting and time loss. Vehicle conservation
must reconcile before a result is accepted. Warm-up vehicles remain in evidence;
summary comparisons use the declared measurement cohort. SUMO time loss is not
HCM control delay or level of service. Network-wide commute, transit ridership
and emissions are not inferred from this execution-only foundation.

## Historical native execution checkpoint

These retained measurements precede the saved-project workflow below. They prove
the recorded local executions, not a current deployment load test or calibration.

The retained 304,770,813-byte Arizona PBF produced a complete 85004 plus roughly
1 km rectangular buffer source extract: 6,453 highway ways and 164 restriction
relations, 6.67 MB XML, 70.04 seconds, and 1.12 GB peak RSS. The exact source
envelope is recorded, and complete crossing ways extend the final graph bounds.
No claim is made that this buffer is sufficient for spillback or regional demand.

The native graph has 9,303 junctions, 22,739 directed edges, 29,139 lanes, 49,769
connections and 865 generated signal programs. The final stable-movement capture
took 16.90 seconds and 1.084 GB peak memory. An initial broader source envelope exceeded the first
20,000-edge/128-MiB admission limits; rejection evidence is retained under
`.local/qa/traffic/phoenix-network.log`. The 30,000-edge ceiling was selected from
the measured full-ZIP inventory; source geometry was not dropped to fit it.

The actual-source paired pilot retains the 2025-10-02 FHWA observations and a
geometric review of station 0F0085 lane 1. Remaining lane/HOV correspondence and
vehicle-class coverage stay unresolved. Its 700 passenger vehicles are explicit
authored execution demand, not count-fitted traffic. Both sides retained all
700 vehicles, with 700 arrivals and no teleports, collisions or route errors.
The initial measured run took 37.85 seconds and 1.535 GB peak memory, with a
180.7-MB complete archive. It remains untouched at
`.local/qa/traffic/real-85004-pilot/` as historical execution evidence.

The stable-movement checkpoint uses movement IDs derived from their lane/edge tuple, with a
native regression proving that a surviving turn keeps its identity after an
upstream closure reorders the network. Its network is at
`.local/traffic/networks/phoenix-85004-1km-stable-turns/`; its paired evidence
is at `.local/qa/traffic/real-85004-pilot-stable-turns/`. That run took
**39.132 seconds**, peaked at **1,588,621,312 bytes**, and retained a complete
**183,612,029-byte** archive, within the declared 2-GiB worker and 256-MiB archive
bounds. All 700 vehicles arrived on both sides, including 100 warm-up vehicles;
the comparison uses the 600 intended measurement departures. Calibration remains
null and unresolved count predictions remain unavailable.

Exact identifiers:

- Original Arizona PBF SHA-256: `5d95b1a91fb247e657f4ae38ed991c5fd92cd4cd8a5ccaa9b9ad8e2e253c0a7d`.
- Full-ZIP source extract SHA-256: `2d5aae7b25a490cb87ab8c047dc874dcb0275f53e27c8c43388aacd89ab1c371`.
- Native graph XML SHA-256: `0b68dcbdb74f7bad7970c249df45a5043758858da8c33d1078ff37c020785eef`.
- Final pair recipe hash: `c8875cc438cd22439b640723381dd5abc2acb16980b5b1bbd4488bdd6d50e76f`.
- `inventory.json` in the final evidence directory records every file's bytes
  and SHA-256; `summary.json` records diagnostics, resources and count selection.

The geometric lane review is explicitly attributed to `codex-pilot-review`,
not to the agency or application owner. The 2025 observations and 2026 OSM
capture are not contemporaneous. Station 0F0133 lies outside this network and
is retained as unmapped; unresolved lane/class coverage is not inferred from
nearby roads. These are local execution proofs, not deployment cost validation.

## Operator opt-in and source registry

Traffic jobs are now connected to saved projects, but remain disabled by default.
Before enabling them, install the pinned native tools, apply the current storage
migrations and restricted-role setup in [STORAGE.md](STORAGE.md), and provide
private persistent archive storage. Set these variables in the API process's
operator environment; the application does not download graphs or counts for a
visitor:

```dotenv
TRAFFIC_ENABLED=true
TRAFFIC_NETWORK_REGISTRY=/absolute/path/to/private-traffic/registry.json
TRAFFIC_ARCHIVE_DIR=/absolute/path/to/private-persistent-traffic-archive
TRAFFIC_WORK_DIR=/absolute/path/to/private-temporary-traffic-work
TRAFFIC_CAPACITY_ENVIRONMENT=deployment
TRAFFIC_CAPACITY_STATEMENT=Describe the verified existing processing capacity and the hosting cost recorded or reserved in the operating budget.
```

`TRAFFIC_CAPACITY_ENVIRONMENT` accepts `deployment` or `local-development`.
The statement must describe the operator's actual fixed capacity; it is not a
provider quote or proof of zero hosting cost. A missing declaration, unavailable
pinned runtime, missing source registry or quarantined native slot prevents new
work. Registry entries and prepared source bundles are cached for the API
process lifetime: restart the API after an operator source change, then review a
new configuration. Existing captures remain immutable.

The registry is a strict versioned JSON document, bounded to 128 KiB and 100
entries with unique `placeId` values. This is the captured local 85004 example;
its hashes must not be reused for another study or regenerated graph:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "phoenix-85004-native-1km-stable-turns",
      "placeId": "zcta-85004-2020",
      "studyAreaHash": "c8336b77a937115b4dfbea12b5d9e231d540aee3efa5b68178583a49350b562f",
      "networkDirectory": "networks/phoenix-85004-1km-stable-turns",
      "networkHash": "0b68dcbdb74f7bad7970c249df45a5043758858da8c33d1078ff37c020785eef",
      "inventoryHash": "f0e6fcbed5289798db5caec3994762bce169af5e9f3e11e96b46be81bdcef978",
      "sourceEnvelope": [-112.087, 33.411, -112.053, 33.49],
      "bufferMeters": 1000,
      "countPackPath": "counts/59ec9b40e654b359b3018e54932d72dd88be88d2a49d29425b06c5c635ff6e69.json",
      "countPackHash": "59ec9b40e654b359b3018e54932d72dd88be88d2a49d29425b06c5c635ff6e69",
      "initialPeriod": {
        "date": "2025-10-02",
        "timeZone": "America/Phoenix",
        "utcOffsetMinutes": -420,
        "beginSeconds": 25200,
        "endSeconds": 28800,
        "warmupSeconds": 600,
        "cooldownSeconds": 600
      }
    }
  ]
}
```

`studyAreaHash` is `trafficContentHash(studyAreaGeometry(place))`: the SHA-256 of
canonical full Polygon/MultiPolygon geometry, including every part and hole.
Both that hash and `placeId` must match the saved immutable baseline. A matching
ZIP label or bounding box is insufficient. `networkHash` is the native XML
identity in the prepared manifest; `inventoryHash` is
`trafficContentHash(prepared.network)`. The loader checks the inventory against
native XML and the pinned engine/image. The source envelope must contain the
whole study. Its declared buffer is retained, not certified as sufficient for
regional assignment or spillback.

Network and count paths must resolve beneath the registry's directory. HTTP
requests cannot choose paths or URLs. `countPackPath` and `countPackHash` must
appear together or both be absent; the hash covers the canonical original count
pack, bounded to 8 MiB. No pack means explicitly missing observed evidence, not
zero traffic. Operator observations retain their original source files and
lineage. A configuration also captures the actual worker-code hash, so a changed
graph, inventory or worker cannot silently reuse an earlier reviewed identity.

## Saved-project review and API flow

Open a cloud-saved proposal with an authenticated free account and project
owner/editor access. Save current edits before configuring or adopting traffic.
The Traffic workbench loads the prepared network for that exact study. Baseline
scenarios remain read-only; project readers can inspect authorized retained
results. Anonymous exploration does not grant access to private traffic jobs.

An uploaded CSV is a private immutable original, at most 5 MiB and 10,000 data
rows per upload. The server retains its exact bytes and hash before a reviewed
column/clock mapping becomes part of a configuration. Original observed values,
reported zeros, missing intervals, restrictions and quality notes are preserved.
Factored observations require explicit adjustments and reasons. Changing the
analysis period does not reinterpret a previously captured upload clock.

Review source permissions, class coverage, directed edge/lane or turn mapping,
station position, explicit OD/candidate routes, native controls and the analysis
period. The server stamps the actual account and timestamp on source declarations
and count mappings. These are reviewed user attestations, not agency approval or
independent legal verification. A new mapped position requires a new review;
unresolved direction, class or target information stays unresolved. Each saved
configuration is append-only and binds its full request, original uploads,
source reviews, prepared network, planning baseline and effective planning-road
identity. Source changes require another configuration rather than rewriting
prior evidence.

All paths below are relative to
`/api/v1/projects/:projectId/traffic`. Mutations use the normal authenticated
session, trusted Origin and CSRF token. Reads are project-authorized and private,
with `Cache-Control: private, no-store`.

| Step                                | Endpoint                                                      | Required binding or result                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect availability                | `GET /capabilities?scenarioId=…`, `GET /context?scenarioId=…` | Runtime/capacity reason, prepared inventory and current configuration or initial request.                                                                                                                     |
| Retain an original CSV              | `POST /uploads`                                               | Multipart `file` plus stable `idempotencyKey`; returns original hash and upload ID.                                                                                                                           |
| Review and save configuration       | `POST /configurations`                                        | `scenarioId`, current `expectedVersion`/`expectedRevision`, `expectedConfigurationId` (null initially), stable key, request, source declarations, upload bindings, mapping reviews and scope acknowledgement. |
| List configuration history          | `GET /configurations?scenarioId=…`                            | Recent compact immutable configuration headers.                                                                                                                                                               |
| Queue an explicit experiment        | `POST /jobs`                                                  | `configurationId`, current `expectedVersion`/`expectedRevision`, `idempotencyKey`.                                                                                                                            |
| Poll without loading evidence files | `GET /jobs`, `GET /jobs/:jobId`                               | Compact status, progress and retained attempt diagnostics.                                                                                                                                                    |
| Cancel or explicitly retry          | `POST /jobs/:jobId/cancel`, `POST /jobs/:jobId/retry`         | Current `expectedJobVersion`; retry also requires an idempotency key.                                                                                                                                         |
| Inspect completed evidence          | `GET /jobs/:jobId/result`, `GET /jobs/:jobId/files`           | Exact captured result and private archive inventory.                                                                                                                                                          |
| Download retained originals         | `GET /jobs/:jobId/files/:name`, `GET /uploads/:uploadId/file` | Authorized, hash-verified bytes; native member names come from the inventory.                                                                                                                                 |
| Adopt into the proposal             | `POST /jobs/:jobId/adopt`                                     | `scenarioId` and current expected project/scenario versions; one reversible history command.                                                                                                                  |

Admission and adoption recheck the current project version, scenario revision,
permissions and source identities. Adoption requires the latest reviewed
configuration and a completed project-owned artifact matching the baseline and
planning roads. An unchanged configuration can be run again after adoption or
unrelated planning edits when its baseline and effective road identity still
match; callers must supply the new current versions. A road/control change
requires renewed configuration review. This binding does not itself establish
that planning-road edits were represented by native directed-edge controls.

## Capacity, budget and recovery

The application remains free to end users. Traffic uses declared existing fixed
capacity with zero incremental external-provider charge per admitted attempt.
The initial platform operating ceiling is **$300/month**, adjustable only by the
administrator. A paused budget or exhausted safe headroom blocks processing;
deployments must record or reserve fixed hosting cost first. Each attempt retains
the budget policy version, accounting period and capacity declaration used for
admission. These controls do not meter external hosting bills, eliminate fixed
costs or guarantee an absolute provider spending cap.

The service allows at most 10 pending traffic jobs globally, one pending job per
account, three starts per account per UTC day and three attempts per job. Failed
and cancelled starts still consume their recorded attempts. A durable attempt
has a 360-second wall bound; the native operation retains its separate
180-second bound. Configuration submissions are bounded to 8 MiB. At 10,000
retained jobs, further admission requires operator maintenance rather than
silently discarding history.

Traffic, GIS and workforce processing share one durable native slot across
processes. Waiting for an occupied slot does not consume a traffic attempt.
Permissions, budget and source identity are rechecked before execution, and
revocation or cancellation cannot publish a successful partial artifact. The
lease has a fixed deadline and random fencing token. Expired leases or uncertain
native termination quarantine capacity rather than transferring it to another
worker. See [NATIVE_CAPACITY.md](NATIVE_CAPACITY.md) for the operator-only recovery
procedure; there is no browser override or automatic retry after recovery.

Private archives retain at most 64 files and 256 MiB per bundle, with a 2-GiB
aggregate storage ceiling. Archive exhaustion fails explicitly and requires
operator maintenance. Preserve both database records and private archive files
in an operational backup; a compact saved summary cannot reconstruct native
files. These bounded local controls are not a production throughput or monthly
cost certification.

## Adoption, publication and reports

A saved traffic capture is bounded to 256 KiB and contains paired summaries,
diagnostics, calibration state, recipe/source hashes and a private archive
reference. It does not copy the graph, per-vehicle native files or original CSV
bytes into every undo/history snapshot. Adoption upgrades the project to format
9 without modifying the immutable baseline. Undo/redo and saved records retain
the exact captured numbers.

A client-supplied receipt or hash is not server authority. A `server-run` capture
must exactly match the completed job and immutable artifact owned by that
project, including through full saves and retained history/commands. Database
and application guards enforce that distinction. Restoring a project copy
preserves capture values and receipts as `imported` evidence, explicitly without
claiming this server executed it. Imported captures still require valid content
hashes and baseline binding.

Private results and original-file downloads require current project access and
verified archive bytes. Missing or changed files fail explicitly; the retained
summary remains available and is not recalculated. Public snapshots expose the
frozen summary and permitted attribution, not private job endpoints or archive
files. Publication rejects privately supplied traffic sources without explicit
public redistribution permission. Removing current declarations or history is
not a shortcut around previously retained private rights; traffic source
permissions remain separate from same-ID planning-source metadata. Source
permissions are attestations, not a license verification service.

PDF, Word and browser HTML reports show captured versus imported origin, planning
road staleness, paired measures, measurement-cohort coverage, diagnostics,
calibration and source/recipe identities. The **Traffic evidence · CSV** action
exports captured outcomes, completion, count-fit status and provenance. For a
clean cloud-saved scenario it uses
`GET /api/v1/projects/:projectId/exports?format=traffic-csv&scenarioId=…&version=…&revision=…`
with current access and saved-version checks; a local or dirty scenario uses the
local capture and computes its planning-road staleness. XLSX and GeoJSON retain
the captured traffic evidence, and full saved records preserve its history.
Exports project saved evidence; they do not rerun the simulation or fit new demand. Missing
predictions remain unavailable, true zero remains zero, and absent calibration
is **Not assessed**. Incomplete runs withhold full-run values and paired changes;
any completed-cohort subtotal is labeled as a potentially censored subset.
PDF/Word traffic appendices accept at most 120,000 UTF-8 bytes for the complete
serialized `scenario.traffic` envelope and 150 overlays; exceeding either returns `TRAFFIC_REPORT_TOO_LARGE` rather than truncating evidence.

The capture is an **explicit network experiment**. Matching planning-road hashes
means its context has not changed, not that every planning edit was simulated.
Building, activity, population, employment and horizon changes do not silently
alter its submitted demand. Calibration, held-out count validation, travel-time
and queue validation, adequate boundary demand, surveyed signal/control plans,
converged assignment, multimodal simulation and production operations remain
separate requirements. A successful paired run does not complete those parts of
the PRD or establish engineering LOS.

## Reviewed planning-road correspondence

A saved traffic configuration may now retain optional `request.planningRoads`
version 1. Its server-produced receipt binds the immutable planning baseline,
complete materialized road state, exact native network and inventory, reviewed
properties, directional edge chains, source citations and every excluded
property. Existing requests without this field retain their original shape and
hashes; captured baselines and old native archives are never rewritten.

`POST /api/v1/projects/:projectId/traffic/configurations` accepts optional
`planningRoadReviews` and separately scoped `planningSourceDeclarations`.
Review intents contain a planning road ID, supported changed properties
(`lanes`, `speed`, `closure`), ordered `with-road` / `against-road` native edge
chains, explicit directional lane targets where applicable, full or partial
extent, acknowledgement of whole-native-edge effects, deletion-as-closure when
needed, and a rationale. The server reads the authorized saved scenario and
records reviewer identity/time itself; client-stamped receipts are rejected.
The optimistic project version, scenario revision and latest configuration ID
are checked again after asynchronous validation before committing.

When `planningRoadReviews` is present, submitted `request.overlays` contains
**independent controls only**. The server derives reviewed controls and merges
disjoint properties. Two owners of the same edge/property are rejected, even
when their numbers agree. `[]` explicitly unlinks all generated controls and
retains an accurate exclusion ledger; it does not silently turn them into
independent controls. With the field absent, an existing receipt is reusable
only when its prior server metadata, current bindings and generated effective
controls remain exact. Unrelated saved revisions can reuse the configuration;
a changed baseline, planning road state or native graph requires review.

Planning lane totals are never automatically halved. Lane targets are explicit
per-direction totals, repeated on serial native edges. Mapped lane conversion
requires uniform reviewed motor-lane permissions; special-use or ambiguous lane
inventory is rejected. Speeds convert mph to m/s using exactly `0.44704`.
Only new closures are translated; a closure cannot simultaneously claim lane or
speed changes. New roads, changed geometry, one-way changes, signal timing,
bike/bus facilities and unsupported properties remain explicitly excluded.
A planning deletion can be reviewed as a traffic closure only, without claiming
physical demolition or reconstructed topology.

These are human-reviewed correspondences, not automatic source-way matches or
geometric proof. Controls apply to the **whole selected native edge**, which can
extend substantially beyond a planning centerline. For example, the retained
Papago review case compares an approximately 129 m planning segment with a
641.8 m native edge. Declaring a full-road review does not clip the native edge
or establish that every junction, turning movement or road property is modeled.

Planning citations remain in `planningRoads.sources`, separate from traffic
network/count/demand citations even when IDs collide. Original source metadata
is retained exactly. Every used planning citation, including citations on
excluded changes, needs a private-use/retention attestation; public sharing is a
separate boolean choice. The server stamps these in
`planningRoads.sourceDeclarations`. A prior attestation is reusable only for the
same exact original citation. Captures retain this namespace and its
permissions; publication cannot borrow permission from a same-ID traffic source
or erase a retained private declaration through history removal.

The complete request, derived controls and receipts are immutable and hashed.
Worker admission and capture reverify them against the frozen saved context.
The capture bridge also checks that the executed native proposal actually
applied closures, lane counts and speeds, with unchanged directed endpoints and
preserved lane access permissions. A run without native controls must retain
the exact baseline topology and graph hash. Adoption separately checks current
planning citations, so changing metadata under the same source ID cannot make
an older correspondence current.
New edge-control runs use `netconvert --precision 6`. Timing-only runs preserve
the captured graph's serialization precision and require exact unchanged geometry;
older retained archives keep their explicit precision and original bytes.
Changing the worker source changes its prepared identity, so old configurations
must not silently run against a different converter profile.

The browser binds each confirmation to the exact road, network and original
planning citations. Changed citations clear both private and public permission
choices; confirming private use again never restores an old public permission.
An explicit correspondence check computes the full graph identity before link
confirmation, keeping full-network hashing out of individual typing events.

Admission permits at most 500 road review intents and 500 planning permission
inputs. Correspondence plus effective controls and compact capture projection
must fit 96 KiB **before native work**; larger studies fail explicitly without
truncating citations or exclusions. The existing 8 MiB configuration, 256 KiB
saved-capture and 120,000-byte PDF/Word appendix limits still apply. The shared
native slot and fixed-capacity budget checks remain unchanged. Reports show
exact directional targets, partial coverage, excluded properties, separate
citations and attestations. CSV has dedicated planning correspondence/source
columns; XLSX, GIS and saved JSON retain the complete frozen evidence.

Primary native semantics: [SUMO plain XML edge/lane definitions](https://sumo.dlr.de/docs/Networks/PlainXML.html)
and [netconvert options](https://sumo.dlr.de/docs/netconvert.html). Native baseline
controls remain inferred unless separately surveyed; lane conversion does not
establish reviewed signal programs, converged traffic assignment or calibration.

## Existing native signal timing

An optional `request.signalTimings` selects an existing native controller and
program by their complete captured program hash. Each control records entered
phase durations, offset and rationale. Absence of this field preserves legacy
request serialization. Planning-road `signal` flags are not controller mappings.

Eligibility comes from the exact retained native XML, not the abbreviated graph
inventory: one program per controller, `type="static"`, sequential phases, and
no `next`, minimum/maximum durations, conditions or parameters. This one-second
execution profile permits editing only whole-second baseline programs; original
fractional or dynamic programs remain unchanged. Green-hold phases containing
only red/green states may change. All states, phase order and yellow/all-red or
other clearance durations are preserved. These restrictions do not certify
clearance safety or an agency-approved signal plan.

The converter receives an official plain XML `--tllogic-files` patch. Timing-only
conversion retains the captured graph serialization precision (two decimals for
the current Arizona graph); mixed edge/timing conversion uses six decimals. This
is separate from the unchanged six-decimal simulation-output setting. Raising
old projected geometry to six decimals reconstructs lane endpoints by millimeters,
so the timing-only path preserves precision and requires exact graph geometry. Native edge lane-count/closure controls touching a selected
signal's incoming or outgoing edges are rejected; speed controls can coexist.
The runtime checks the resulting program against its exact requested projection
and retains complete baseline/proposal `SaveTLSStates` output. Each simulated
second must identify the expected controller, program, phase and state at the
pinned engine's absolute-time, positive-offset-delay schedule. Missing samples,
stuck phases and wrong offsets fail closed. The original graph bytes remain
immutable.

Admission permits 16 edited controllers, at most 250,000 state samples per side,
and a combined 96 KiB allowance for control/correspondence/program evidence.
These caps preserve the existing 64-file/256 MiB private archive and 256 KiB
compact saved-capture bounds. Nothing is silently shortened. The existing
fixed-capacity budget, project permissions and shared native slot apply; no paid
provider is enabled. Saved and published evidence includes both actual programs,
while raw per-second states remain in the authorized immutable archive.

New requests carrying `signalTimings` retain `native-settings.json`, the exact
input to the recipe settings hash. Archive replay recomputes it from the retained
worker bytes, allocated vehicles, selected counts and declared controls. A
retained settings file is verified even if the optional request field is absent;
removing that field cannot bypass the check. Legacy archives without this file
retain their original verification path and bytes. The settings `precision`
value describes simulation output; native graph serialization precision is
recorded separately in the proposal conversion options.

Primary references: [SUMO plain XML program definitions](https://sumo.dlr.de/docs/Networks/PlainXML.html#traffic-light-program-definition),
[signal types and phase semantics](https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html),
[recorded TLS state output](https://sumo.dlr.de/docs/Simulation/Output/Traffic_Lights.html),
and the pinned [1.26.0 program initialization](https://github.com/eclipse-sumo/sumo/blob/v1_26_0/src/netload/NLJunctionControlBuilder.cpp)
and [event scheduling](https://github.com/eclipse-sumo/sumo/blob/v1_26_0/src/microsim/MSEventControl.cpp).
The bounded SAX parser rejects DTDs and unknown entities and never resolves
external XML resources ([saxes documentation](https://github.com/lddubeau/saxes)).

## Verification

Run the native regression suite explicitly:

```sh
RUN_NATIVE_TRAFFIC_TESTS=1 node_modules/.bin/vitest run apps/api/src/traffic/native.test.ts
```

The tests exercise real binaries, detector counts, graph/source identities,
grade separation, closure repair, speed changes, exact static timing and per-second
phase execution, unfinished demand, the complete experiment wrapper and cancellation.
Synthetic fixtures are labeled and are not
presented as real traffic observations.

Primary references: [official SUMO container documentation](https://sumo.dlr.de/docs/Developer/Docker.html),
[OSM conversion](https://sumo.dlr.de/docs/Networks/Import/OpenStreetMap.html),
[directed lanes and connections](https://sumo.dlr.de/docs/Networks/SUMO_Road_Networks.html),
[E1 detector semantics](https://sumo.dlr.de/docs/Simulation/Output/Induction_Loops_Detectors_%28E1%29.html),
[count-based demand limitations](https://sumo.dlr.de/docs/Demand/Routes_from_Observation_Points.html),
[trip outputs](https://sumo.dlr.de/docs/Simulation/Output/TripInfo.html),
[FHWA volume archives](https://www.fhwa.dot.gov/policyinformation/tables/tmasdata/),
and [PyOsmium](https://docs.osmcode.org/pyosmium/latest/).
