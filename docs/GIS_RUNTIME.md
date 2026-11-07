# Offline GIS conversion runtime

The GIS worker converts uploaded GeoJSON, zipped ESRI Shapefiles, and selected DXF footprint entities. It also exports materialized scenario geometry as separate Shapefile layers. It uses no paid service, network geocoder, remote grid download, or client-provided executable. The application must explicitly enable it and declare existing fixed processing capacity; deployment hosting costs still belong in the operator budget. A zero incremental query charge is not a claim that hosting is free.

## Install the pinned image

The verified Linux amd64 image is the official OSGeo GDAL 3.13.3 release:

```sh
docker pull ghcr.io/osgeo/gdal@sha256:44fee7d4f9be0966851d7b14a0a387216897d8347f9e0ebc4e812f7217bc39d6
```

Runtime requests use `--pull=never`. Only this digest is accepted. Native inspection records GDAL, PROJ and image identities in source provenance. Operator installation is separate from visitor requests. See the [official GDAL release](https://github.com/OSGeo/gdal/releases/tag/v3.13.3).

The application service runs as a nonroot account with access to its private upload/archive directory and Docker CLI. Each conversion runs as that same numeric user inside a fresh container with no network, read-only root filesystem, all capabilities dropped, no new privileges, one CPU, 512 MiB memory and swap limit, 64 processes, 128 file descriptors, and a 30-second native execution deadline. Input files and the fixed worker script are read-only mounts; only that job's output directory is writable. The Docker socket is **not** mounted into the conversion container. The host service's ability to invoke Docker is privileged infrastructure access: deploy this worker on an appropriately isolated host, not with a broadly exposed Docker daemon.

Container creation precedes execution so aborting a started task can remove its exact container. Cancellation, timeout, process failure, invalid output and normal completion all remove the sandbox and temporary files. There is one converter operation per runtime instance; the durable queue additionally enforces one running GIS job globally.

## Explicit limits and rejection

- Uploaded source: 20 MiB; ZIP expansion and normalized/export artifacts: 100 MiB.
- ZIP: 100 members, no traversal, symlinks, encryption, duplicate case-insensitive paths or undeclared components. Shapefile `.shp`, `.shx` and `.dbf` must agree; missing CRS requires an explicit EPSG selection. Deleted DBF records are rejected instead of silently disappearing.
- Inspection: at most 100 layers, 100,000 source entities and 256 fields per layer, with a 1 MiB serialized inventory cap. Exceeding the cap rejects inspection explicitly rather than truncating entity disclosures.
- Accepted geometry: 5,000 features and 50,000 vertices total, with additional core geometry limits at mapping/commit. No truncation, automatic topology repair or unreported dropped entities.
- The durable service keeps bounded admission, attempts, private artifact bytes and per-account fair-use limits. It rechecks project access, saved version, baseline identity and scenario revision before applying a prepared layer.

The runtime does not accept arbitrary SQL, shell fragments, filesystem paths, URLs, PROJ pipelines or user executable code. The server supplies confined private input paths. A recipe chooses a listed layer, optional explicit entity handles, a known EPSG code or the file CRS, supported text encoding, units, and documented conversion options.

## Geometry, CRS and CAD placement

Polygon holes and MultiPolygon components remain intact. A `.prj` or explicit EPSG definition is transformed offline with traditional XY source axis order to longitude/latitude `OGC:CRS84`; PROJ network access is disabled, ballpark operations are disallowed, and only the best available operation is accepted. Missing required grids or untransformable coordinates fail explicitly. The source WKT, operation description, converter version, source hashes, normalized hash and recipe are retained. A null operation accuracy is unknown accuracy, not zero error.

DXF is an engineering drawing, not a geographic location. Units alone do not locate it. Select a projected EPSG CRS with matching units, or provide at least two drawing-to-geographic control points. The latter fits a two-dimensional similarity transform in a local azimuthal-equidistant frame. All controls, optional independent checkpoints, fitted coefficients, scale, residuals and acceptance tolerance are retained. Two controls can fit exactly without independently establishing accuracy; the preview warns about that limitation. No datum accuracy is invented from the fit residual.

Supported footprint candidates are closed polylines and polygonal HATCH output. Drawing entities are counted independently from GDAL output, including unsupported entities, so an unsupported XLINE, INSERT, text, point or other layer cannot silently vanish. The user must acknowledge every excluded entity. Selected invalid geometry fails; the worker does not close open paths or repair footprints. Z flattening requires an explicit choice. Curved boundaries are tessellated with the requested metre tolerance, converted using the actual control-fit scale where applicable; the approximation is recorded.

These files are planning inputs. A converted polygon is not certified legal parcel, survey or ownership evidence. Source rights require a user declaration; the converter cannot establish ownership or redistribution rights.

Primary format references: [GDAL Shapefile driver](https://gdal.org/en/stable/drivers/vector/shapefile.html), [GDAL DXF driver](https://gdal.org/en/stable/drivers/vector/dxf.html), [PROJ network configuration](https://proj.org/en/stable/usage/network.html).

## Shapefile export fidelity

The exporter writes separate building, road, parcel, block and activity-neighborhood geometry layers when present, with `.shp`, `.shx`, `.dbf`, `.prj` and UTF-8 `.cpg`. It exports the exact saved scenario and captured baseline identity supplied by the authorized caller. It does not include unapplied browser geometry.

DBF uses deterministic fields of at most ten characters. Nullable quantities have explicit `*_NULL` flags and `*_STAT` provenance status columns, so unknown values remain distinct from observed or entered zero. Long names/source identifiers use an explicit sidecar notice and `*_FULL` flag. The manifest documents the field dictionary and `GIS_ID` SHA-256 join key. Exact feature identifiers, complete nested programs, source/provenance, activity/retail/workforce metadata and original numeric values remain in JSON sidecars. Shapefile alone cannot represent all nested application data; the ZIP and sidecars form the complete exchange artifact.

A reimport of the Shapefile geometry does not silently claim that it has recovered the full application project. Use the complete project JSON export for full scenario/history restoration.

## Storage and authorization

Migrations 006 and 007 add private GIS jobs and the independently checked `worker.gis` capability. Runtime security version 7 is required. Ordinary database connections cannot start or complete jobs. Job visibility and cancellation require both the original creator and current project edit access, even for another owner in the same workspace. A GIS worker can inspect queue headers, necessary memberships and budget; it cannot write the budget or access workforce/preparation records.

Full project and baseline data are available to this worker only through guarded functions for a current, uncancelled, unexpired prepare job whose creator still has project edit access. Granting generic project payload access to the shared worker role would violate this boundary and is deliberately avoided. Prepared import geometry, source metadata and recipe bindings are immutable; only the initial commit receipt can be added. A completed prepare job and its exact staged preview must be stored atomically. Applying a preview uses the reviewed project/scenario version and records one reversible import command.

## Application configuration and review flow

The API starts with `GIS_ENABLED=false`. After installing the pinned image and completing operator database migrations, configure a private persistent `GIS_ARCHIVE_DIR`, a private temporary `GIS_WORK_DIR`, `GIS_ENABLED=true`, `GIS_CAPACITY_ENVIRONMENT=deployment`, and a meaningful `GIS_CAPACITY_STATEMENT`. Record or reserve the fixed hosting cost in the platform administrator budget and unpause processing. Isolated testing may explicitly declare `local-development`; that does not validate production cost or capacity. The existing $300/month ceiling remains administrator-adjustable, and every new processing attempt rechecks its pause and available headroom.

No upload starts from opening the workbench. A signed-in project editor chooses a file and explicitly inspects it. Inspection records the original bytes and source layers. The user then selects coordinate reference, optional DXF controls, field mappings, and private/public source permissions. Normalization and mapping produce an immutable, hash-bound preview tied to the exact saved project version, scenario revision and baseline. The map and complete feature/diagnostic tables show the pending changes. Apply creates one history entry; Undo restores the previous state. An unapplied preview expires after 24 hours and can be prepared again from the retained upload.

Append and match are explicit choices. Matching uses an existing internal ID or a source feature reference within one selected source namespace; missing, ambiguous or repeated matches block the complete batch. Matched updates preserve unrelated address, parcel-reference, zoning, height/FAR-limit, rent and assessed-value fields with their prior attribute source. The reviewed use and five quantity mappings replace their corresponding values; an unmapped quantity becomes Unknown. Existing typed programs and typologies are removed unless mapped, with per-feature warnings before Apply. Geometry overlaps are disclosed, not silently merged. Same-kind parcel/block overlap still fails core validation.

Height, floors, homes, jobs and parking supply accept actual null values with missing-field provenance. Supplied zero remains a known zero. Explicit constants are assumptions; source fields are supplied evidence; component-program totals are derived. Use requires an explicit reviewed choice or complete category mapping. Numeric strings use an explicit dot/comma decimal convention without guessed grouping separators. Heights convert from meters, international feet or US survey feet. Model 0.7 withholds dependent complete totals/deltas and exposes separately labeled known contributions only where mathematically valid. Projects containing these extensions use format 8, including historical states; older untouched source bytes are not backfilled.

## Queue and private archive operations

The durable queue admits at most ten pending GIS jobs globally, one pending job per account, thirty attempts per account per UTC day, three attempts per job, and one running job globally. Failures and active cancellations retain their consumed attempts. Jobs interrupted by worker loss become explicitly retryable after their lease expires; they are never silently replayed. New submissions and retries use stable idempotency keys. Retained job history is capped at 10,000 records pending operator archival.

Native conversion has a 30-second sandbox deadline. Geometry field mapping and clipping run in a separate terminable JavaScript worker with a 512 MiB heap and 15-second deadline; overlap review additionally permits at most two million bounding-box comparisons and 10,000 exact intersections. Complete job processing is bounded at 60 seconds. Exceeding a bound rejects the batch without partial scenario changes. Reducing file size or selecting fewer entities is an available free-user remedy.

The original uploads, frozen export inputs and generated ZIPs live in the private archive, keyed by tenant/project scope and SHA-256. Files are limited to 100 MiB (uploads to 20 MiB), and total retained bytes to 2 GiB. Reception allows two concurrent streams per API process with a 30-second deadline; final publication is serialized by a filesystem lock. Configure a persistent private volume and host-level quota rather than ephemeral storage or a public static directory. Multiple API instances must share the same archive and database; fair-use admission is global, while stream concurrency is per process.

Upload bytes remain temporary until metadata, budget and queue admission succeed. A filesystem publication lock spans finalization and database admission; rejected new files are rolled back, while already retained deduplicated bytes remain intact. An uncertain database acknowledgment is reconciled against job references and conservatively retains potentially committed evidence. Queue scans load lightweight headers; only the selected job loads its full recipe/inspection. No automatic deletion of retained source evidence is implemented. A process crash or uncertain acknowledgment can leave an unreferenced immutable file; an interrupted archive writer may leave `.upload`, `.pending`, or `.write-lock` entries. If the archive fills or a stale lock remains, stop all GIS writers, preserve a backup, reconcile files against retained `gisJobs` references and import/source history, and inspect the interrupted operation before removing only confirmed temporary/orphan entries. Never delete a content file referenced by a retained project/source or job. Then restart the worker. Database backups and private artifact backups must be coordinated; database-only restoration cannot recreate original uploaded bytes or export ZIPs. Missing/changed evidence fails a content check and is never silently regenerated as the original.

Original uploads, inspections, previews, job history and ZIP downloads remain restricted to their creator while that account retains project edit access. Shared planning geometry remains accessible under the normal project permissions. Completed downloads recheck access after archive I/O and verify byte count/hash. Public sharing blocks currently referenced sources lacking public redistribution permission, including declarations retained in history or commands. Omitting a current source or stripping its rights cannot remove an earlier restriction; full-project saves preserve prior declarations unless an explicit current attestation supersedes them. Permitted historical sources needed for current attribution are included in the public copy, while unused private source records are excluded. Private exports remain allowed under the recorded private-use declaration. These declarations record uploader authorization, not independent license verification.

## Verification

Run the native suite only after the pinned image is installed:

```sh
GIS_NATIVE_TESTS=1 ./node_modules/.bin/vitest run apps/api/src/gis.test.ts
```

The native suite exercises actual GDAL projected-CRS conversion, Polygon/MultiPolygon holes, Shapefile round-trip, null/zero flags and exact nested sidecars, unsafe ZIP rejection, ASCII and binary DXF, curve tessellation, independent control checkpoints, complete unsupported-entity accounting, private-path confinement and active cancellation with no surviving container. Restricted PostgreSQL tests live in `gis-security.test.ts`, `gis-commit-security.test.ts` and `gis-postgres.test.ts`; they use isolated schemas and actual separate LOGIN roles. They do not mutate the primary development store.
