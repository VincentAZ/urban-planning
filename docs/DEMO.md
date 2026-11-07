# Recorded demo runbook (ZCTA 85004, Phoenix)

Everything below runs for real on this machine: real OSM/Census/HUD/FEMA data, real
model calculations, real SUMO, Valhalla, GDAL and Chromium/FFmpeg containers. Use 85004:
it is the only prepared area with every workbench's data.

## One-time and pre-recording setup

1. Stop the API if it is running (port 3001).
2. Run `corepack pnpm exec tsx scripts/demo-setup.ts`. This writes `.env`, backs up the dev
   store, installs the flood and housing catalogs and opens the budget gate for 7 days.
   **Re-run it within 7 days of recording** to renew the gate.
3. Make sure routing is up: `curl -s http://127.0.0.1:8002/status` (if not:
   `docker start urban-planning-routing`).
4. Start the app with `corepack pnpm dev` and open http://localhost:5173.
5. Create a free account and save the 85004 project before running any workbench.
   Workforce, accessibility, traffic, GIS and media refuse to run while edits are unsaved.
6. Native jobs share one slot: start the next only after the previous one finishes.

## Click-path

1. **Place.** Search `85004` and open the prepared area. Switch between 3D, 2D and
   satellite. Inspect a building and its sources.
2. **Edit.** In Build, place a preset (e.g. apartment) or draw a footprint, then Apply.
   Edit a street (lanes or speed). Show undo/redo, then Before/After.
3. **Scorecard.** Click a metric to show its formula, inputs and sources. Compare
   alternatives.
4. **Flood.** Attach the FEMA evidence and show the exposure of the proposal's buildings.
5. **Housing.** Scorecard domain → Housing → Review housing affordability (HUD FY2026
   limits).
6. **Economy.** Open the fiscal workbench and the retail gaps.
7. **Workforce and jobs access.** Run car/walk 15/30/45-minute reach (Valhalla).
8. **GIS import.** Import a GeoJSON, zipped shapefile or DXF footprint.
9. **Traffic.** Mobility → Open traffic workbench → review the inputs → **Run paired traffic
   analysis** (SUMO) → Results → **Save traffic capture to scenario**. Close the workbench.
   The map now plays the executed SUMO vehicles: the label says "N SUMO-simulated vehicles ·
   7:00–8:00". Use the 1–60× speed control and the Before/After reveal (baseline vs proposal
   run). Set the time control to **8:00 AM · Morning** first so the
   on-screen clock matches the simulated period, and zoom to street level to see the cars.
10. **Present.** Edit a tour, then present it.
11. **Outputs.** PDF/Word staff report, XLSX/CSV/GeoJSON, a 4K still and an MP4 fly-through.

## Wording for the voice-over

Accurate: "real data, real computation, documented assumptions", "microscopic traffic
simulation", "prepared areas".

Avoid: "calibrated", "forecast", "nationwide / any address in the US", "transit".

Known approximations:
- Building type defaults and starting coefficients are labeled illustrative.
- The traffic run is a 7–8 AM study-period simulation, not a calibrated forecast.
- SUMO lane centerlines can sit a few metres off the drawn street lines.
- The time-of-day control changes only the lighting.
