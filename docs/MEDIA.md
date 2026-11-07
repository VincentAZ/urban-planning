# High-resolution stills and tour video

The free app can export a private, saved scenario as a **1920 × 1080 or
3840 × 2160 PNG**, or a **1280 × 720 or 1920 × 1080 MP4 at 30 frames per
second**. These are the final composition dimensions, including the map,
caption and source strip. The existing quick PNG capture remains available to
guests. Server rendering requires a free account, project edit access and
explicit operator configuration; there is no paid tier or paid queue bypass.

## Planner workflow

1. For a movie, use **Present → Edit tour** to author the complete ordered
   sequence of saved cameras, callouts and optional narration transcripts.
2. Choose **Export → High-resolution still · PNG** or **Tour fly-through ·
   MP4**. **Save and load scene** binds the work to one saved project version,
   scenario revision, baseline and calculated result.
3. Select exact output dimensions and the visible layers. For video, choose
   each stop's hold and transition in frames. A long callout needs an explicitly
   authored short screen caption; its complete text remains in the transcript.
4. Preview the frozen composition, then render. The queue reports progress and
   supports cancellation. Completed exports can be reopened after a reload; **Load older exports** walks the full retained history for that scenario.
   A retry is explicit and consumes another permitted attempt.
5. Download the image/movie, complete transcript, WebVTT captions, manifest and
   frame receipts. File sizes and hashes are checked before browser download.

Changing the project after submission does not change an admitted export.
Submitting an old preview after another edit fails with a conflict and requires
loading the saved scene again. Current account and project access are checked
when reading jobs and files. Exports are private artifacts, not public scenario
publications.

## What the output represents

The private worker uses the same `CityMap` and composition as the preview,
including actual extruded building geometry. Supported views are vector 3D and
2D. Satellite/captured imagery is rejected explicitly because its capture and
redistribution rights have not been established. Illustrative moving agents are
off; media does not invent or imply calibrated traffic playback.

MP4 has **no audio**. Authored narration remains available in full as text.
Local-device presentation read-aloud is separate. A movie may contain all 24
saved stops, up to 30,000 frames (1,000 seconds), with one to 3,600 hold frames
per stop and zero to 300 transition frames. The last transition is zero. A
change between 2D and 3D uses an explicit cut rather than an interpolated view.
The 15-minute processing deadline can reject a complex valid timeline; these
maximums are validation bounds, not a throughput promise.

Screen captions are limited to 240 characters, with no silent truncation.
Complete callouts, authored narration, attached measures, source identities and
method disclosures accompany the output. Selected flood layers retain the
exact source pack and calculation reference. Source declarations must permit
private display and export. Structured source locators and import recipes containing credentials or private filesystem paths are rejected without rewriting their evidence; authored prose is not classified as a secret. Missing evidence and unavailable metrics retain
their status; the rendering does not turn an estimate into an observation.

## Reproducibility and frame verification

`media-export-1.0.0` retains a canonical scene and recipe. The camera method is
`mercator-smoothstep-1.0.0`: smoothstep interpolation of Mercator coordinates,
zoom and pitch, with the short longitude and bearing path. The host computes
the authoritative camera schedule once. Chromium independently checks that
schedule against its own method, then renders the exact supplied values. This
avoids tiny cross-engine transcendental-math differences without weakening
exact requested-camera checks.

Every genuine frame waits for current map layers, a fresh Deck draw, the
requested camera, exact dimensions and healthy graphics contexts. A second
assertion runs after the screenshot. Context loss, missing layers, changed
scene/recipe identity or incomplete rendering fails the job. Repeated static
hold frames explicitly reference the first genuine image of that same hold;
transitions render every frame. The receipt does not claim a new draw for reused
pixels.

`frames.json` accounts for every frame index, exact microsecond timestamp and
duration, requested/observed camera, scene/recipe hash, draw generation, output
size and captured PNG hash. `pixelHash` means the SHA-256 of the captured PNG
bytes **before** H.264 compression. MP4 is lossy; decoded video pixels cannot be
compared to that PNG hash. The retained first PNG/thumbnail must match its frame
receipt. FFprobe verifies H.264, dimensions, 30 fps, decoded frame count and
duration before acceptance.

The manifest identifies every output file, scene/recipe, source, renderer asset
inventory, bundled font hash, installed image/worker profile and host scheduler
code/Node/V8 platform identity. This supports provenance and replay; identical
pixels across different hardware are not promised. Bundled DejaVu fonts avoid
remote font dependencies, but complete multilingual glyph coverage and
screen-reader/council-projector acceptance remain unverified.

## Operator installation

Rendering is disabled by default. Build the private renderer and install a
local runtime image deliberately:

```sh
corepack pnpm build:media
docker build -t urban-planning-media:local-v1 scripts/media
docker image inspect --format '{{.Id}}' urban-planning-media:local-v1
```

The Dockerfile pins an official Playwright base manifest. FFmpeg is installed
during the explicit build, so rebuilds can produce different image IDs; the
installed immutable image ID is the execution identity. The application never
pulls an image automatically. Configure through the service's private operator
environment, using the actual image ID and absolute paths:

```dotenv
MEDIA_ENABLED=true
MEDIA_IMAGE_ID=sha256:REPLACE_WITH_INSTALLED_IMAGE_ID
MEDIA_RENDERER_DIRECTORY=/absolute/path/to/dist/media-render
MEDIA_WORK_ROOT=/absolute/private/path/media/work
MEDIA_ARCHIVE_DIRECTORY=/absolute/private/path/media/archive
MEDIA_CAPACITY_ENVIRONMENT=deployment
MEDIA_CAPACITY_STATEMENT=Describe the measured fixed hosting capacity and its recorded cost.
```

Use `local-development` only for a real local-development installation. A
deployment declaration requires fixed hosting costs recorded or reserved in
the budget. Fresh administrator-reviewed cost evidence and available headroom
are required at admission, retry and dispatch. No per-export external charge
does **not** mean hosting, storage, egress or operator effort is free. The
administrator-adjustable allowance starts at $300/month; media does not raise it.

Run the API as a nonroot service account with access to the local Docker daemon.
Only trusted server paths configure the worker. Neither uploaded scripts nor
browser-supplied images/commands are executed. The private build excludes public
data, environment loading, source maps and imagery credentials.

## Capacity, cancellation and retention

Media shares the durable native slot with GIS, traffic and regional routing.
Independent workers cannot each claim that slot. Current fair-use limits are
ten pending jobs globally, one pending job per account, three started attempts
per account per UTC day and three attempts per job. There is no paid bypass.

Each native container has no network, a read-only root filesystem, a nonroot
UID, no capabilities, two CPUs, 2 GiB memory, 256 processes and a bounded private
temporary filesystem. Execution has a 900-second deadline. Cancellation,
progress-write failure and deadline expiry terminate the named container;
capacity is released only after absence is confirmed. Uncertain termination
quarantines the slot for [operator recovery](NATIVE_CAPACITY.md).

The 192-MiB output-file maximum is enforced with Docker's `RLIMIT_FSIZE` in
addition to an earlier FFmpeg stop limit and complete-frame checks. FFmpeg's
own `-fs` can slightly exceed its requested size, so it is not the sole hard
bound. See the [Docker resource-limit reference](https://docs.docker.com/reference/cli/docker/container/run/)
and [FFmpeg output-size documentation](https://ffmpeg.org/ffmpeg.html).

Scene input is bounded at 32 MiB and 500,000 coordinates. Private scene
preparation runs in a bounded worker; the account-scoped preview cache lasts
five minutes with at most eight entries and 64 MiB total. A bundle is limited
to 256 MiB; the private archive is limited to 2 GiB. Exceeding a limit rejects
the complete operation. No geometry, frames, source text or narrative is
silently omitted. Archive deletion/retention administration and measured
production capacity remain operational work.

## Verification

Core tests cover complete 24-stop timelines, exact frame timing/cameras,
source bindings, full sidecars and genuine/reused-frame rules. Native tests compare height-only changes in pitched 3D against an unchanged 2D control and inspect decoded movie transitions, in addition to codec/timing checks. API/SQLite and
restricted PostgreSQL tests cover immutable input, job fencing, permissions,
fair use, budget gates, cancellation/retry, private artifacts and restart
recovery. Native and browser evidence is retained under `.local/qa/media/`.
The [implementation ledger](IMPLEMENTATION_STATUS.md) records final measured
results and remaining limitations; configured maximums alone do not establish
production performance or professional acceptance.
