# Urban Planning implementation plan

Decision baseline: 2026-11-05. This document records the agreed full product direction. It is a delivery plan, not a completion report; use the [requirement ledger](IMPLEMENTATION_STATUS.md) for current evidence and remaining work. The [PRD](<../Urban Planning — Product Requirements.md>) defines the complete feature scope.

## Product and access commitments

- Deliver the entire PRD at general launch, preserving its explicit later-phase/out-of-scope boundaries. Internal milestones provide usable checkpoints without replacing the national product with the current Phoenix example.
- Serve city planners and economic developers in one warm, professional workspace. Their starting views emphasize different outcomes, while both can access all capabilities.
- Keep the app 100% free: no subscriptions, paid data/feature gates, checkout, trial expiry, or paid priority. Anonymous visitors can explore and edit; free accounts enable saved work, uploads, collaboration, AI, and heavy server runs.
- Start with a **$300/month total operating ceiling**, adjustable by the platform administrator. This covers hosting, licensed data, runtime AI, and simulation/export processing; it is not an end-user charge or a claim of free vendor services.
- Use Phoenix metro for detailed reference projects and validation. National access must identify source coverage, inference, and unavailable evidence rather than promise identical certainty in every ZIP.
- Preserve options for future custom jurisdiction configurations, including places such as Chicago or Brooklyn. Future app pricing and custom-service charges are undecided. Multi-ZIP/full-city editing remains later-phase.

The UI centers on the real place, with contextual editing on the left, an explainable scorecard on the right, and scenario/compare/present/export actions above. Light ivory surfaces, teal controls, warm city lighting, readable numbers, and purposeful motion provide a professional experience with restrained fun. Every spatial interaction needs a keyboard/form/list equivalent where applicable; every analytical insight needs a table representation.

## Architecture and contracts

| Subsystem | Selected direction |
| --- | --- |
| Browser | React/TypeScript/Vite; accessible primitives; shared design tokens; remote-state caching |
| Geography | MapLibre/deck.gl WebGL2 rendering; real footprints; instanced activity; tiled level of detail; 3D, aerial, and 2D views |
| Interactive calculations | Shared versioned TypeScript modules in browser Web Workers and Node, with incremental invalidation |
| API | Fastify/TypeScript modular application; versioned REST/OpenAPI; server-enforced permissions |
| Persistence | PostgreSQL/PostGIS with normalized tenant/project/revision/source/result records; immutable object storage for source bundles and artifacts |
| Processing | Python/GDAL ingestion; SUMO detailed traffic; regional Valhalla routing; report/image/video workers |
| Production | US-region AWS ECS/RDS/S3/SQS; managed secrets, identity, monitoring, backup/recovery, and controlled rollout |

Keep source facts, assumptions, commands, results, and publication separate. A result bundle identifies its exact baseline/source manifest, scenario revision, assumption/profile versions, model versions, and deterministic seed. Published links and exports consume those frozen bundles. Dataset/model refreshes create new versions rather than changing old reports.

Distinguish the editable ZCTA, buffered traffic network/external trips, larger 45-minute accessibility region, and fiscal/economic jurisdictions. A ZIP is not a taxing authority or complete labor market. ZIPs without ZCTAs receive an explicit geographic explanation.

Model contracts declare dependencies, coefficient requirements, available outputs, methodology, units, uncertainty interpretation, source provenance, and missing-input behavior. Scalar arithmetic, client/server agreement, and typed interfaces are necessary but do not establish real-world model accuracy.

## Workstreams and dependencies

| Workstream | Required work | Dependencies / evidence |
| --- | --- | --- |
| Source foundation | National ZCTA/geometry/demographic/jobs/transit/hazard ingestion; immutable manifests; field-level precedence; prepared tiles; local overrides | Source coverage and reuse rights, valid schemas, tested clipping/CRS/topology, refresh/reproduction checks |
| Authoring and scenarios | Full building/parcel/block/network/transit tools; population-area controls; branching, unlimited retained history, restore, horizons | Shared commands, geographic validation, baseline/revision persistence, deterministic recalculation |
| Analytical models | All eight domains; local fiscal profiles; authorized trip coefficients; regional multipliers; retail gaps; workforce; environmental/safety models | Source-backed inputs, appropriate geography, method validation, revision-bound evidence, sensitivity handling |
| Simulation/routing | Shared demand inputs; live planning estimates; calibrated purpose-driven activity; regional access; optional detailed traffic | Graph versioning, external demand, counts/signal plans/GTFS, SUMO/Valhalla workers, diagnostics |
| Communication | Two-to-four synced comparisons, before/after reveal, staff reports, guided presentations, all import/export formats | Settled result bundles, rights-aware source exports, deterministic map capture, rendering QA |
| Collaboration/engagement | Roles, scoped comments, public snapshots, configurable pins/votes/surveys, records export | Verified identity where required, tenant isolation, publication controls, moderation/retention policy |
| AI | Evidence-bound explanations and narratives; structured proposed edits with explicit preview/apply | Runtime credentials/data controls, permitted retrieval, tool schemas, factual/permission/effect evaluations |
| Operations | Enterprise SSO, normalized storage, durable jobs, US deployment, private operating-budget dashboard, accessibility, observability, recovery | Infrastructure/identity accounts, administrator-controlled $300/month initial ceiling, secrets, security review, performance and failure testing |

Once shared contracts are stable, renderer/UI, data ingestion, analytical modules, and communication/collaboration can progress in parallel. Integrate them through the two complete journeys: a planner's development comparison/report and an economic developer's site/employer/incentive proposal.

Open data is the default foundation. Preferred enrichment adapters are Regrid for parcels/zoning, MapTiler for imagery, and a suitable licensed retail demand/sales provider such as Claritas. Regional RIMS II packs and authorized trip-rate integrations supply actual coefficients where appropriate. Provider selection does not establish contract availability, credential access, or permissions to redistribute raw data. Source onboarding must explicitly cover free public display, analysis, caching, published snapshots, exports, and historical retention.

## Four internal milestones and acceptance gates

| Milestone | Required result | Acceptance evidence |
| --- | --- | --- |
| **1. Foundation and first complete workflow** | Real Phoenix reference data, professional workspace, one reversible development workflow, sourced metrics, saved scenario, report | Edit → calculation → save/reopen → explanation → export works against the same frozen baseline; browser/API/model tests and rendered report review |
| **2. Complete planning/economic workbench** | All authoring groups, all model domains, five economic-development tools, detailed runs, complete comparison | Both primary user journeys finish end to end; every metric has a populated-input implementation, provenance, and tested missing/stale/failure behavior |
| **3. National data and communication** | National prepared geography, authoritative/premium adapters, all overlays/imports/exports, AI, collaboration, public engagement, public API | Representative national locations load with honest coverage; sources are licensed; shared snapshots/exports reproduce settled revisions; full format and permission checks |
| **4. Production validation and free launch** | Enterprise identity, accessibility, secure US hosting, performance, reliability, monitoring, professional validation | Original product gates below pass with authoritative evidence; recovery/load/security exercises complete; operator capacity and cost controls are configured |

General launch requires all four milestones and the full PRD acceptance scope. The current reference implementation does not yet meet that standard.

Traffic implementation proceeds through source completeness → regional route evidence → exact local entry positions/times → conserved fractional and integer demand → native execution → reviewed count fitting → independent validation. Unresolved geography, destinations, routes and source classes remain visible throughout; a successful subset run cannot become a whole-ZIP forecast. The current operator workflow and remaining workbench/coverage gates are recorded in [Census commute implementation](TRAFFIC_COMMUTE.md).

Prepared traffic networks require explicit selection. Saved configurations and retries retain their original graph, source recipe and complete coverage ledger; changing an operator default must not change an earlier experiment. Source-bound demand and clocks remain fixed until the user deliberately makes an authored copy. Present the source estimate, supported local demand and rounded simulation count separately, with downloadable accounting and the same limitations in saved and exported results.

Measurable gates:

- **Place readiness:** p95 usable baseline under 10 seconds on a documented broadband/device profile, measured across representative prepared national locations, including dense, rural, border, and geographically large areas.
- **Live estimates:** p95 incremental scorecard update under 3 seconds after a committed edit. Regional routing/detailed simulation expose pending states and do not silently present stale metrics as current.
- **Rendering:** target 60 fps with at least 5,000 visible agents on named integrated-GPU municipal hardware at a documented resolution/quality setting. Measure frame-time distributions; comparison viewports share a defined graphics budget.
- **Usability:** a trained planner builds and compares two scenarios within 30 minutes; an economic developer completes a sourced site/employer/incentive proposal. Public presentation is tested on a projector and smaller screens.
- **Credibility:** trips and fiscal outputs meet the PRD's ±20% comparison target on agreed consultant studies; independent domain review checks methods and limitations. This remains a validation gate, not a universal accuracy claim.
- **Communication:** PDF/Word and every specified export preserve scenario/source/model versions; all required formats open correctly; before/after images match the published revision; at least one report per pilot city is used in a real hearing.
- **Accessibility/security:** WCAG 2.2 AA non-3D interface audit, keyboard and screen-reader workflows, tenant and role isolation, public/private boundary checks, secure imports, source-rights enforcement, and AI permission/citation evaluation.
- **Operations:** backup restoration, job retry/cancellation, failed-provider recovery, rollback, secret handling, US residency, and cost/queue monitoring are demonstrated. SOC 2 work is an evidence program, not an unsupported certification claim.

## Sustainable operation without paid gates

Prepare reusable national data bundles and cache public baseline tiles; isolate tenant data and never reuse private uploads across organizations. Calculate only affected model dependencies, deduplicate identical runs, and retain reproducible artifacts to avoid unnecessary recomputation.

Use fair queues and bounded concurrency for AI, detailed traffic, ingestion, and video/report work. Requests expose progress, cancellation, retry timing, and temporary fair-use limits. All users receive the same access policy without a paid bypass or priority tier. A usage budget may constrain scheduling, but it must not be presented as a paid feature unlock.

Build a **private platform-administrator dashboard** with an initial $300/month ceiling and audited administrator-only adjustments. This authority is distinct from an ordinary organization's project-owner role. Show the configured ceiling, fixed commitments, reported spend, estimated unreported spend, in-flight reservations, projected month-end cost, safety margin, alerts, and remaining usable budget. Count fixed hosting/data commitments first; do not treat the entire ceiling as discretionary job capacity.

Before admitting costly work, atomically reserve its estimated cost against the remaining budget. Reconcile reservations when work finishes, fails, or is canceled, retaining incurred charges. Enforce provider/workload limits and pause new costly jobs before the safety margin is consumed. Already cached/basic exploration must remain available. A cap increase can allow queued work to resume under the same fair policy; lowering the cap does not erase commitments or already incurred charges. Keep paid service execution disabled until its credentials, cost model, budget allocation, and cap enforcement are configured.

Provider usage reports can lag and some costs vary after a request is admitted. The dashboard must disclose that its ceiling is an admission-control target, not an absolute billing guarantee. Reconcile provider billing, surface stale/missing cost feeds, and stop discretionary work when cost evidence is unreliable. Budget tests must cover concurrent admissions, delayed reporting, duplicate reconciliation, cancellation after partial charges, fixed costs exceeding remaining capacity, unauthorized cap changes, and audited administrator changes.

Track first edit, saved scenarios, completed comparisons, report use, repeat organizational activity, public feedback, provider costs, compute/storage costs, queue latency, and failure rates. No adoption forecast, customer price, or delivery date has been agreed; do not invent them. Determine service capacity from measured workloads within the administrator's configured ceiling before unrestricted public traffic.

Nationwide usage and commercial data coverage within $300/month have not been validated. Treat that amount as the initial operating constraint, not a capacity estimate. Compare actual fixed commitments and measured workloads against it before provisioning production services; a vendor selection in this plan is not authorization to exceed the ceiling.

## External prerequisites and completion rule

Still to establish: provider agreements/keys compatible with the operating ceiling; authorized coefficient packs; authoritative local datasets and consultant benchmarks; professional review partners; production cloud/identity/AI credentials; actual fixed/variable service costs and workload allocations; and real hearing validation. The initial total ceiling is $300/month and can be changed by the administrator. These are recorded dependencies, not reasons to stop independent implementation work.

Maintain the [status ledger](IMPLEMENTATION_STATUS.md) as work proceeds. Verify each requirement using current source, runtime behavior, tests, artifacts, provider state, and external acceptance evidence. Neither a passing build, an attractive reference map, an evidence-input interface, nor a list of unavailable metrics proves that the full product is complete.
