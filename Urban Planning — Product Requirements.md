# Urban Planning — Product Requirements

Nov 5, 2026 · @Vincent Serpico

## Decision update — Nov 5, 2026

The following decisions supersede earlier monetization assumptions while preserving the full product requirements below.

- **The app is 100% free.** Launch has no subscriptions, paid feature tiers, paid data-layer gates, checkout, expiring trial, or paid processing priority. Whether to charge for the app later is undecided.
- **Anonymous exploration and editing come first.** Free accounts enable saved projects, uploads, collaboration, AI, and server-side processing. Account requirements protect durable work and service capacity; they are not payment requirements.
- **Fair-use controls are permitted.** Transparent queues, temporary rate limits, abuse prevention, and operator-configured usage budgets keep the free service reliable. There is no paid bypass.
- **Initial operating budget: $300 per month, adjustable by the platform administrator.** This is the total service ceiling for hosting, licensed data, runtime AI, and simulation/export processing—not an end-user subscription. A private administration dashboard must account for fixed commitments, reported/estimated spend, in-flight reservations, and a safety margin before admitting costly work. Budget changes are administrator-only and audited. Pause costly work before the available budget is exhausted while retaining cached/basic exploration. Vendor reporting latency and variable charges prevent an absolute billing guarantee; surface that limitation clearly to the administrator.
- **Premium data may be purchased as an operating input where useful.** The operator must secure rights for the free public application, published snapshots, derived outputs, and exports. Users are not charged to unlock those layers. Open data and explicit missing-data states remain the baseline.
- **Both planners and economic developers are primary audiences.** Phoenix metro is the initial reference and validation market. General launch targets the entire PRD, with nationwide access and clear coverage limitations; internal delivery milestones do not reduce that launch scope.
- **Future custom implementations are optional and undecided.** Examples include Chicago or Brooklyn, using reusable jurisdiction configurations rather than unrelated code forks. No custom-service price, agreement, delivery date, or app-pricing model has been selected. Multi-ZIP/full-city capabilities remain later-phase as stated below.

The [implementation plan](docs/IMPLEMENTATION_PLAN.md) defines delivery workstreams and acceptance gates. The [status ledger](docs/IMPLEMENTATION_STATUS.md) records what is actually implemented; this requirements document is not a claim of current capability.

## 1. Vision and problem

Urban Planning is a browser-based digital twin of any US ZIP code that lets planners and economic developers change the built environment and immediately see the effect on traffic, people, jobs, tax base and quality of life.

**The problem.** Today a rezoning, a new distribution center or a road diet is evaluated with disconnected tools: GIS for parcels, a traffic consultant for trip generation, a spreadsheet for fiscal impact, and renderings for the public. Each takes weeks, costs five to six figures, and none lets a council member ask "what if we added 300 units instead of 200?" in the room.

**The product.** Type a ZIP code. Get a live, 3D, stylized model of the real place: real roads, real building footprints, real land uses, populated with simulated cars and people. Add, remove or change anything. Every edit recomputes a scorecard of planning and economic outcomes in seconds.

**Positioning.** Not a game, not a GIS replacement. A decision instrument: fast enough for a public meeting, rigorous enough that a staff planner will defend the numbers, and beautiful enough to win the room. The visual direction is a warm-lit, low-poly isometric city inside a professional, light planning studio. Purposeful city motion and before/after reveals provide a restrained touch of fun. The originally referenced image is not included in the repository.

**Primary organizations and users.** City and county planning departments, economic development organizations (EDOs), MPOs and COGs, chambers of commerce, site-selection consultants, commercial real estate developers, and planning/architecture firms. These organizations can use the free app; this audience definition does not imply a paid contract.

## 2. Users and jobs to be done

Four personas drive every requirement. If a feature does not serve one of them, cut it.

| Persona | Core job | What they must walk away with |
| --- | --- | --- |
| Staff planner | Test zoning, density and street changes before they go to commission | Defensible numbers: trips, parking demand, units, FAR, LOS, with assumptions shown |
| Economic developer | Pitch a site, model a business attraction or a corridor revitalization | Jobs, payroll, tax revenue, spending captured, workforce reachable within 30 minutes |
| Elected official / commissioner | Understand a proposal in five minutes and explain it to constituents | Before/after visuals and a one-page scorecard in plain language |
| Developer / site selector | Check feasibility and story of a project on a specific parcel | Parcel facts, allowable envelope, traffic and market context, a shareable scenario |

**Secondary:** residents at public meetings (view-only, comment), students and educators (sandbox mode).

## 3. Core capabilities

The loop is: **load a real place → see it alive → change it → see the consequences.** Everything below serves that loop.

### 3.1 Load any place

- Enter a ZIP code (also: address, city name, or click on a national map). The app frames the ZIP boundary and loads it within 10 seconds on a typical broadband connection.
- Render real geometry: street network with lane counts and direction, building footprints with heights, parcels, land use, water, parks, rail and transit stops.
- Every structure is classified (single-family, multifamily, retail, office, industrial, civic, school, healthcare, mixed-use, vacant) and inspectable: click it to see use, height, footprint, estimated units/jobs and data source.
- Two view modes, toggled instantly: **Stylized 3D** (the reference look: isometric, tilt-shift depth of field, time-of-day lighting) and **Satellite** (aerial imagery with extruded buildings), plus a flat **2D plan** view for precise editing.
- Data overlays toggle on top of any view: zoning, land use, parcel value, population density, income, employment density, transit coverage, flood zones, Opportunity Zones, TIF districts.

### 3.2 See it alive

- Cars, trucks, buses, bikes and pedestrians move on the real network, obeying lanes, signals and stop signs.
- Volumes are calibrated to reality, not random: seeded from published traffic counts and census commute data, shaped by time of day (AM peak, midday, PM peak, night).
- Agents have purpose: trips go from homes to jobs, shops, schools. Adding an office produces commuters; adding a grocery store pulls shoppers.
- Visible congestion: queues form at bottlenecks, roads color by level of service on demand, heatmaps for pedestrian activity.
- Time controls: play, pause, speed up (1x to 60x), jump to a time of day, and a day/night cycle.

### 3.3 Control the population

- Global sliders for number of people and vehicles, as absolute counts or as % of today's baseline.
- Growth presets: "+10 years at regional forecast", "+25% population", "post-plant-closure".
- Mode-share controls: shift % from driving to transit, bike, walk and see the network respond.
- Per-area overrides: paint a neighborhood and adjust its population or employment.

### 3.4 Change the built environment

- **Add** structures from a typed library (houses, townhomes, apartments, retail, office, industrial, warehouse/logistics, school, hospital, park, parking garage, mixed-use). Each type carries defaults for units, jobs, trips and parking, editable per instance.
- **Remove** any existing structure; the parcel becomes vacant land.
- **Modify**: change height, footprint, use and density; convert a use (office-to-residential, mall-to-mixed-use).
- **Draw** new parcels and blocks; subdivide or assemble lots.
- Zoning-aware: the app flags when an edit exceeds current zoning (height, FAR, setbacks, use) and shows what variance it would need. It never blocks the edit; it labels it.

### 3.5 Change the network

- Add/remove traffic signals, stop signs, roundabouts and crosswalks. Edit signal timing at a basic level (cycle length, green split).
- Add/remove/modify roads: lanes, direction, speed limit, one-way conversions, road diets, bike lanes, bus lanes, on-street parking.
- Add transit: a bus route or stop, a rail station; agents reroute and mode-shift accordingly.
- Close a street (event, construction) to stress-test the network.

### 3.6 Editing guarantees

- Unlimited undo/redo; every edit logged with who, what and when.
- Simulation re-equilibrates within seconds of an edit; the scorecard shows a "settling" state until it does.
- Edits are always reversible to the real-world baseline.

## 4. Impact engine and scorecard

This is the product. The 3D city makes the proposal understandable; the impact engine earns professional trust and repeat use. Every edit updates a live scorecard showing **baseline vs. scenario** with deltas, and every number exposes its formula, inputs and source on click.

### 4.1 Scorecard metrics

| Domain | Metrics (minimum set) |
| --- | --- |
| Mobility | Vehicle trips/day, VMT, intersection level of service (A–F), average commute time, peak-hour delay, transit ridership, parking demand vs. supply |
| Economy | Direct, indirect and induced jobs; payroll; business output; retail spending captured vs. leaked; new business formation potential |
| Fiscal | Property tax, sales tax and fee revenue; cost to serve (roads, utilities, police, fire, schools); net fiscal impact per acre and over 20 years |
| Housing | Units added/lost, mix by type, density, estimated affordability band, jobs-housing balance |
| Land and form | FAR, lot coverage, impervious surface, open space per resident, zoning conformance |
| Access and equity | Jobs reachable within 15/30/45 minutes by car, transit, walk; walk score proxy; effects on low-income and transit-dependent tracts |
| Environment | GHG from transportation, tree canopy, stormwater runoff, heat island proxy, flood exposure |
| Safety | Pedestrian/bike conflict points, high-injury corridor exposure, emergency response time coverage |

### 4.2 Modeling principles

- **Transparent over clever.** Use industry-standard, citable methods: ITE trip generation rates, IMPLAN/RIMS II-style multipliers, census LODES commute flows, standard fiscal impact methods (per-capita and case-study). Show the method name next to every number.
- **Every assumption is editable.** Tax rates, multipliers, trip rates, household size and cost-to-serve can be overridden per jurisdiction and saved as a local profile.
- **Ranges, not false precision.** Show low/expected/high bands where uncertainty is material.
- **Directional speed first, deep accuracy second.** Live estimates in seconds; an optional "high-fidelity run" for traffic microsimulation that may take minutes.

### 4.3 Economic development tools

- **Site readiness profile** for any parcel: size, zoning, utilities proxy, road and transit access, labor shed, nearby incentives (Opportunity Zone, TIF, enterprise zone).
- **Business attraction scenario:** drop in a specific employer type (e.g., 500-job manufacturer, 200k sq ft logistics center) and see jobs, wages, trips, housing demand and fiscal return.
- **Incentive calculator:** given an abatement or grant, show payback period and net present value to the jurisdiction.
- **Retail gap analysis:** what categories residents spend outside the area that could be captured locally.
- **Workforce shed:** population by education and occupation within commute range of a site.

## 5. Scenarios, collaboration and output

Planners do not make one change; they compare alternatives. The scenario system is first-class, not an afterthought.

### 5.1 Scenarios

- Every project starts from an untouched **Baseline** (the real world today). Users branch named scenarios from it or from each other ("Option A: 4-story mixed-use", "Option B: townhomes").
- **Side-by-side compare** of two to four scenarios: synced split-screen 3D views plus a comparison scorecard with winners highlighted per metric.
- **Before/after slider** on any view for public presentation.
- **Time horizon:** each scenario can be projected to 5, 10 and 20 years using growth assumptions.

### 5.2 Collaboration

- Projects are shared with roles: owner, editor, commenter, viewer.
- Saved projects, uploads, collaboration, AI, and heavy server processing use free accounts. Public scenario viewing and ordinary exploration do not require an account.
- Comments pin to a location, a building or a metric.
- **Public engagement mode:** a locked, simplified, read-only scenario link for residents, with optional feedback collection (pins, votes, short surveys) exportable as a report.
- Real-time co-editing is a later-phase goal, not MVP.

### 5.3 Output

- **One-click staff report**: scenario description, scorecard, before/after images, methodology and assumptions appendix. Exports to PDF and Word.
- **Presentation mode:** full-screen guided tour with camera fly-throughs and narrated callouts, built for a council chamber projector.
- Export video (fly-through), high-res stills, data tables (CSV/XLSX) and geometry (GeoJSON, shapefile).
- **Import:** user-uploaded parcels, zoning layers, site plans (GeoJSON, shapefile, DXF footprint) and local traffic counts override defaults.

### 5.4 AI assistant

- Natural-language edits: "Replace the strip mall on Main with 5-story mixed-use, 200 units, ground-floor retail."
- Natural-language questions: "Why did the PM peak delay at 7th and Oak get worse?" Answers cite the model's own numbers.
- Auto-drafted narrative for staff reports and public summaries, always editable and always marked as drafted.

## 6. Data, architecture and non-functional requirements

Use open, nationally available data for every US ZIP by default; let user organizations layer in their own authoritative local data. Licensed enrichment may be funded by the operator where useful and legally compatible with the free app. Data availability is disclosed rather than turned into a paid upgrade. The builder chooses specific vendors and libraries; these are starting points, not mandates.

### 6.1 Data layers

| Layer | Candidate default sources | Local override |
| --- | --- | --- |
| Streets, footprints, POIs | OpenStreetMap, Overture Maps, Microsoft/Google building footprints | City GIS |
| Aerial imagery and 3D tiles | Commercial satellite/aerial tile providers, photorealistic 3D tiles | Local orthoimagery |
| Parcels and zoning | Commercial parcel aggregators; municipal open data portals | County assessor, zoning GIS |
| Population, income, housing | US Census ACS, decennial census | Local forecasts |
| Jobs and commute flows | Census LEHD/LODES, BLS QCEW, County Business Patterns | EDO business database |
| Traffic | State DOT AADT counts, HPMS | Local counts, signal timing plans |
| Transit | GTFS feeds | Agency data |
| Hazards and designations | FEMA flood maps, Opportunity Zones, EPA EJScreen-type indices | Local districts (TIF, BIDs) |

- Every rendered fact carries provenance: source, vintage and confidence. Gaps are filled with inferred values that are visibly flagged as estimated.
- ZIP codes are postal routes, not areas: use Census ZCTAs for boundaries and load a buffer around them so edge traffic behaves correctly.
- Source onboarding records the rights to cache, analyze, display, publish, and export data in a free public application. A paid provider account alone does not establish all of those rights. Where evidence is absent, show an explicit limitation; never fabricate a value or imply that payment by the user would supply it.

### 6.2 Architecture direction

- Browser-first, no install. WebGL/WebGPU 3D rendering; must run on a standard municipal-issue laptop with integrated graphics.
- Simulation runs client-side for interactivity (agent-based, level-of-detail scaled), with server-side batch runs for high-fidelity scenarios.
- Pre-processed, cached tiles per ZCTA so popular areas load instantly; on-demand processing for the rest.
- Modular model engine: each impact model (traffic, fiscal, economic) is a swappable, versioned module with documented inputs and outputs, so methods can be upgraded or replaced by a user organization's preferred model.
- Public API for scenarios and metrics so organizations can integrate with their own GIS and permitting systems.
- Shared caches, reusable data bundles, incremental calculations, fair queues, deduplication, and observable usage budgets support the free service. Expensive operations expose queue/progress/cancel states and temporary limit explanations, with no paid priority or feature unlock.

### 6.3 Non-functional requirements

- **Performance:** first meaningful render under 10 s; 60 fps target with 5,000+ visible agents on mid-range hardware; scorecard update under 3 s after an edit.
- **Scale:** any single ZIP plus buffer; multi-ZIP and full-city projects in a later phase.
- **Accuracy disclosure:** a visible methodology page; every number traceable to its formula and source.
- **Security and compliance:** SSO (SAML/OIDC), role-based access, audit log, SOC 2 Type II path, data residency in the US. Organization-uploaded data is never used across tenants.
- **Accessibility:** WCAG 2.2 AA for all non-3D UI; every visual insight also available as a table.
- **Public records:** government users are subject to FOIA/public records laws; scenarios and comments must be exportable in full.

## 7. Phasing, success and risk

### 7.1 Roadmap

The four-phase delivery sequence and its acceptance gates are maintained in [the implementation plan](docs/IMPLEMENTATION_PLAN.md). These phases are internal milestones toward the full-scope general launch.

Phase 1 must deliver the full loop (load, see, change, measure) on a thin slice before anything is deepened. A beautiful city with no defensible numbers fails the professional user's core job. Completing this first milestone does not complete the national product.

### 7.2 Success metrics

| Metric | Target |
| --- | --- |
| Time from ZIP entry to usable model | Under 10 seconds |
| Time to build and compare two scenarios | Under 30 minutes for a trained planner |
| Scorecard numbers within accepted range of a consultant study on the same project | Within ±20% on trips and fiscal impact in pilot validation |
| Staff reports generated from the tool and used in a real hearing | At least one per pilot city |
| Free-service adoption and repeat use | Track first edit, saved project, comparison, report export, and repeat organizational use; numeric adoption targets remain to be set from evidence |
| Sustainable operation | Operate against an initial $300/month administrator-adjustable ceiling; measure committed/reported/estimated spend, reservations, forecast, queue latency, failures, and remaining budget |

### 7.3 Key risks

- **Credibility.** One wrong number in a public hearing kills adoption. Mitigation: transparent methods, ranges, validation against real studies, and clear "estimate" labels.
- **Data gaps.** Parcel, zoning and height data are inconsistent across the US. Mitigation: graceful inference, visible confidence levels, easy local import.
- **Performance.** Thousands of agents plus 3D on municipal laptops. Mitigation: level-of-detail simulation, statistical background traffic, server-side heavy runs.
- **Scope creep into GIS or traffic-engineering software.** Mitigation: stay a decision and communication tool; export to the specialist tools rather than replicate them.
- **Data licensing and operating costs.** Commercial data, AI, rendering, and detailed simulation can be expensive at national scale. Mitigation: open data baseline, legally suitable operator-funded enrichment, shared caching, incremental work, fair queues, and explicit usage budgets. Features and data layers are not sold as paid add-ons in the free app.

### 7.4 Out of scope for v1

- Engineering-grade design (CAD, utility sizing, stamped traffic studies).
- Permitting and entitlement workflow.
- Non-US geographies.
- Interior building design or architectural detail beyond massing and use.

### 7.5 Open questions

- Which Phoenix metro municipalities and professional partners will provide authoritative data, comparison studies, and real hearing validation?
- Which provider agreements allow licensed enrichment, coefficient use, public sharing, and exports for the free service within the current administrator-configured operating budget?
- What production credentials, regional infrastructure, specialist review, and identity-provider connections are available for the selected architecture?
- Later, should any app pricing or optional custom jurisdiction services be offered? This remains undecided and does not authorize adding paid gates now.
