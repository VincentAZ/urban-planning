import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import {
  applyBuildingGeometry,
  canonicalJSON,
  parcelPreset,
  USER_PARCEL_SOURCE,
  type Place,
  type Position,
  type Road,
} from "@urban/core";
import { buildingPreset, createProject } from "@urban/models";
import {
  buildReportMapPairSvg,
  createReportMapProjection,
  projectReportPosition,
  renderReportMapPair,
  REPORT_MAP_LIMITS,
  type ReportMapInput,
} from "./report-maps.js";

const outer: Position[] = [
  [-112.08, 33.45],
  [-112.06, 33.45],
  [-112.06, 33.47],
  [-112.08, 33.47],
  [-112.08, 33.45],
];
const hole: Position[] = [
  [-112.077, 33.453],
  [-112.073, 33.453],
  [-112.073, 33.457],
  [-112.077, 33.457],
  [-112.077, 33.453],
];
const island: Position[] = [
  [-112.057, 33.461],
  [-112.053, 33.461],
  [-112.053, 33.465],
  [-112.057, 33.465],
  [-112.057, 33.461],
];
function fixture(): ReportMapInput {
  const road = (id: string, y: number): Road => ({
    id,
    name: id,
    coordinates: [
      [-112.069, y],
      [-112.062, y],
    ],
    lanes: 2,
    speedMph: 25,
    oneWay: false,
    kind: "residential",
    sourceId: "fixture",
  });
  const place: Place = {
    id: "report-fixture",
    name: "Exact multipart study",
    city: "Phoenix",
    state: "AZ",
    zip: "85004",
    center: [-112.068, 33.46],
    boundary: outer,
    studyArea: { type: "MultiPolygon", coordinates: [[outer, hole], [island]] },
    bounds: [-112.08, 33.45, -112.053, 33.47],
    buildings: [
      { ...buildingPreset("office", [-112.068, 33.46]), id: "modified" },
      { ...buildingPreset("multifamily", [-112.065, 33.46]), id: "removed" },
      { ...buildingPreset("park", [-112.063, 33.46]), id: "unchanged" },
    ],
    roads: [
      road("road-modified", 33.459),
      road("road-removed", 33.458),
      road("road-unchanged", 33.457),
    ],
    sources: [
      {
        id: "fixture",
        name: "Fixture geometry contributors",
        vintage: "2020 boundary / 2026 map",
        url: "https://example.com/source",
        license: "Test geometry",
        kind: "user-supplied",
      },
    ],
    loadedAt: "2026-11-05T00:00:00Z",
    extentLabel: "Exact fixture",
    coverage: [],
  };
  const project = createProject(place);
  const baselineScenario = project.scenarios.find((s) => s.id === "baseline")!;
  const proposalScenario = project.scenarios.find(
    (s) => s.id === project.activeScenarioId,
  )!;
  proposalScenario.revision = 3;
  proposalScenario.buildingEdits.modified = {
    ...place.buildings[0],
    units: 20,
  };
  proposalScenario.buildingEdits.removed = null;
  proposalScenario.buildingEdits.added = {
    ...buildingPreset("retail", [-112.061, 33.46]),
    id: "added",
  };
  proposalScenario.roadEdits["road-modified"] = {
    ...place.roads[0],
    bikeLane: true,
  };
  proposalScenario.roadEdits["road-removed"] = null;
  proposalScenario.roadEdits["road-added"] = road("road-added", 33.456);
  return { place, baselineScenario, proposalScenario };
}
const rgb = (svg: string, position: Position) => {
  const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  const offset =
    (Math.round(position[1]) * image.width + Math.round(position[0])) * 4;
  return [...image.pixels.subarray(offset, offset + 3)];
};

describe("saved-geometry report comparison", () => {
  it("uses one north-up local projection and padded extent for both panels", () => {
    const input = fixture();
    input.proposalScenario.buildingEdits = {};
    input.proposalScenario.roadEdits = {};
    const maps = buildReportMapPairSvg(input);
    const p = maps.metadata.projection;
    expect(p).toEqual(createReportMapProjection(input.place));
    expect(projectReportPosition(p.origin, p)).toEqual([
      p.viewport.left + p.viewport.width / 2,
      p.viewport.top + p.viewport.height / 2,
    ]);
    const south = projectReportPosition([-112.065, 33.45], p),
      north = projectReportPosition([-112.065, 33.47], p);
    expect(south[0]).toBe(north[0]);
    expect(north[1]).toBeLessThan(south[1]);
    expect(maps.metadata.extent[0]).toBeLessThan(input.place.bounds[0]);
    expect(maps.metadata.extent[2]).toBeGreaterThan(input.place.bounds[2]);
    expect(maps.metadata.studyAreaExtent).toEqual(input.place.bounds);
    expect(maps.baseline.svg.match(/clipPath[\s\S]*?<\/clipPath>/)?.[0]).toBe(
      maps.proposal.svg.match(/clipPath[\s\S]*?<\/clipPath>/)?.[0],
    );
  });
  it("focuses localized attribute edits with identical framing and an honest full-area overview", () => {
    const input = fixture();
    input.proposalScenario.roadEdits = {};
    input.proposalScenario.buildingEdits = {
      modified: { ...input.place.buildings[0], units: 50 },
    };
    const maps = buildReportMapPairSvg(input),
      p = maps.metadata.projection;
    expect(maps.metadata.focus.mode).toBe("changes");
    expect(maps.metadata.notes.join(" ")).toContain(
      "analysis still covers the whole study area",
    );
    expect(p.metersPerPixel).toBeLessThan(
      createReportMapProjection(input.place).metersPerPixel * 0.75,
    );
    expect(p.metersPerPixel * p.viewport.height).toBeGreaterThanOrEqual(400);
    for (const panel of [maps.baseline, maps.proposal]) {
      expect(panel.svg).toContain("Study overview");
      expect(panel.svg).toContain("Box = detail frame");
      expect(panel.svg).toContain('clip-path="url(#map-frame)"');
    }
    expect(
      maps.baseline.svg.match(
        /<clipPath id="map-frame">[\s\S]*?<\/clipPath>/,
      )?.[0],
    ).toBe(
      maps.proposal.svg.match(
        /<clipPath id="map-frame">[\s\S]*?<\/clipPath>/,
      )?.[0],
    );
    for (const position of input.place.buildings[0].footprint!) {
      const [x, y] = projectReportPosition(position, p);
      expect(x).toBeGreaterThan(p.viewport.left);
      expect(x).toBeLessThan(p.viewport.left + p.viewport.width);
      expect(y).toBeGreaterThan(p.viewport.top);
      expect(y).toBeLessThan(p.viewport.top + p.viewport.height);
    }
    expect(maps.metadata.studyAreaExtent).toEqual(input.place.bounds);
    // A valid path in the SVG is insufficient: nested native clipping previously
    // hid focused geometry. Verify the actual changed footprint raster pixels.
    expect(
      rgb(maps.proposal.svg, projectReportPosition([-112.068, 33.46], p)),
    ).toEqual([241, 212, 157]);
  });
  it("shows the whole study area for widespread edits and retains both old and new moved footprints in a focused frame", () => {
    const broad = fixture();
    broad.proposalScenario.buildingEdits = {
      west: { ...buildingPreset("office", [-112.079, 33.451]), id: "west" },
      east: { ...buildingPreset("office", [-112.054, 33.464]), id: "east" },
    };
    broad.proposalScenario.roadEdits = {};
    expect(buildReportMapPairSvg(broad).metadata.focus.mode).toBe("study-area");
    const moved = fixture();
    moved.proposalScenario.roadEdits = {};
    moved.proposalScenario.buildingEdits = {
      modified: {
        ...moved.place.buildings[0],
        geometry: undefined,
        footprint: buildingPreset("office", [-112.067, 33.46]).footprint!,
      },
    };
    const maps = buildReportMapPairSvg(moved),
      p = maps.metadata.projection;
    expect(maps.metadata.focus.mode).toBe("changes");
    for (const point of [
      ...moved.place.buildings[0].footprint!,
      ...moved.proposalScenario.buildingEdits.modified!.footprint!,
    ]) {
      const [x, y] = projectReportPosition(point, p);
      expect(x).toBeGreaterThan(p.viewport.left);
      expect(x).toBeLessThan(p.viewport.left + p.viewport.width);
      expect(y).toBeGreaterThan(p.viewport.top);
      expect(y).toBeLessThan(p.viewport.top + p.viewport.height);
    }
  });
  it("retains holes and detached components in the actual raster, without joining island gaps", () => {
    const input = fixture();
    input.proposalScenario.buildingEdits = {};
    input.proposalScenario.roadEdits = {};
    const maps = buildReportMapPairSvg(input);
    const p = maps.metadata.projection;
    for (const panel of [maps.baseline, maps.proposal]) {
      expect(
        rgb(panel.svg, projectReportPosition([-112.075, 33.455], p)),
      ).toEqual([232, 238, 234]);
      expect(
        rgb(panel.svg, projectReportPosition([-112.058, 33.463], p)),
      ).toEqual([232, 238, 234]);
      expect(
        rgb(panel.svg, projectReportPosition([-112.055, 33.463], p)),
      ).toEqual([245, 244, 235]);
      expect(
        rgb(panel.svg, projectReportPosition([-112.07, 33.466], p)),
      ).toEqual([245, 244, 235]);
    }
  });
  it("keeps a hole transparent where it intersects the focused frame", () => {
    const input = fixture();
    input.proposalScenario.roadEdits = {};
    input.proposalScenario.buildingEdits = {
      added: { ...buildingPreset("office", [-112.0724, 33.455]), id: "added" },
    };
    const maps = buildReportMapPairSvg(input);
    expect(maps.metadata.focus.mode).toBe("changes");
    expect(
      rgb(
        maps.proposal.svg,
        projectReportPosition([-112.075, 33.455], maps.metadata.projection),
      ),
    ).toEqual([232, 238, 234]);
    expect(
      rgb(
        maps.proposal.svg,
        projectReportPosition([-112.0724, 33.455], maps.metadata.projection),
      ),
    ).toEqual([175, 224, 209]);
  });
  it("records building and road additions, attribute modifications and removals with non-color encodings", () => {
    const maps = buildReportMapPairSvg(fixture());
    expect(maps.metadata.changes).toEqual({
      buildings: { added: 1, modified: 1, removed: 1 },
      roads: { added: 1, modified: 1, removed: 1 },
    });
    expect(maps.proposal.svg).toContain('fill="url(#removed-hatch)"');
    expect(maps.proposal.svg).toContain('stroke-dasharray="8 3"');
    expect(maps.proposal.svg).toContain('stroke-dasharray="3 5"');
    expect(maps.proposal.alt).toContain("reference-only");
    expect(maps.metadata.credits).toEqual(fixture().place.sources);
    expect(maps.proposal.svg).toContain("2020 boundary / 2026 map");
    expect(maps.proposal.svg).toContain("approx.");
  });
  it("keeps both old and reshaped road geometry in the shared comparison extent", () => {
    const input = fixture();
    input.place.buildings = [];
    input.proposalScenario.buildingEdits = {};
    input.proposalScenario.roadEdits = {
      "road-modified": {
        ...input.place.roads[0],
        coordinates: [
          [-112.069, 33.459],
          [-112.067, 33.461],
          [-112.062, 33.459],
        ],
      },
    };
    const captured = canonicalJSON(input);
    const maps = buildReportMapPairSvg(input);
    const projection = maps.metadata.projection;
    expect(maps.metadata.changes.roads).toEqual({
      added: 0,
      modified: 1,
      removed: 0,
    });
    for (const position of [
      ...input.place.roads[0].coordinates,
      ...input.proposalScenario.roadEdits["road-modified"]!.coordinates,
    ]) {
      const [x, y] = projectReportPosition(position, projection);
      expect(x).toBeGreaterThan(projection.viewport.left);
      expect(x).toBeLessThan(
        projection.viewport.left + projection.viewport.width,
      );
      expect(y).toBeGreaterThan(projection.viewport.top);
      expect(y).toBeLessThan(
        projection.viewport.top + projection.viewport.height,
      );
    }
    const tip = projectReportPosition([-112.067, 33.461], projection);
    expect(rgb(maps.baseline.svg, tip)).toEqual([245, 244, 235]);
    expect(rgb(maps.proposal.svg, tip)).not.toEqual([245, 244, 235]);
    expect(canonicalJSON(input)).toBe(captured);
  });
  it("renders parcel holes, detached parts and block boundaries without inventing a legal subdivision", async () => {
    const input = fixture();
    input.place.buildings = [];
    input.place.roads = [];
    input.proposalScenario.buildingEdits = {};
    input.proposalScenario.roadEdits = {};
    const geometry = {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [-112.069, 33.46],
            [-112.061, 33.46],
            [-112.061, 33.466],
            [-112.069, 33.466],
            [-112.069, 33.46],
          ] as Position[],
          [
            [-112.067, 33.462],
            [-112.065, 33.462],
            [-112.065, 33.464],
            [-112.067, 33.464],
            [-112.067, 33.462],
          ] as Position[],
        ],
        [island],
      ],
    };
    const parcel = parcelPreset(geometry, "Proposed lots"),
      block = parcelPreset(geometry, "Planning block", "block");
    input.proposalScenario.parcelEdits = {
      [parcel.id]: parcel,
      [block.id]: block,
    };
    input.proposalScenario.sources = [USER_PARCEL_SOURCE];
    const captured = canonicalJSON(input);
    const maps = buildReportMapPairSvg(input);
    expect(maps.metadata.changes).toMatchObject({
      parcels: { added: 1, modified: 0, removed: 0 },
      blocks: { added: 1, modified: 0, removed: 0 },
    });
    expect(maps.proposal.svg).toContain('data-boundary-kind="parcel"');
    expect(maps.proposal.svg).toContain('data-boundary-kind="block"');
    expect(maps.proposal.svg).toContain('stroke-dasharray="14 5 2 5"');
    expect(maps.proposal.alt).toContain(
      "not verified title or subdivision approval",
    );
    expect(maps.metadata.credits).toContainEqual(USER_PARCEL_SOURCE);
    const projection = maps.metadata.projection;
    expect(
      rgb(
        maps.proposal.svg,
        projectReportPosition([-112.066, 33.463], projection),
      ),
    ).toEqual([245, 244, 235]);
    expect(
      rgb(
        maps.proposal.svg,
        projectReportPosition([-112.058, 33.463], projection),
      ),
    ).toEqual([232, 238, 234]);
    expect(
      rgb(
        maps.proposal.svg,
        projectReportPosition([-112.068, 33.461], projection),
      ),
    ).not.toEqual([245, 244, 235]);
    const rendered = await renderReportMapPair(input);
    expect(rendered.metadata.inputHash).toBe(maps.metadata.inputHash);
    expect(rendered.proposal.png.subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect(canonicalJSON(input)).toBe(captured);
    const removed = fixture();
    removed.place.parcels = [parcel];
    removed.proposalScenario.parcelEdits = { [parcel.id]: null };
    const removal = buildReportMapPairSvg(removed);
    expect(removal.metadata.changes.parcels).toEqual({
      added: 0,
      modified: 0,
      removed: 1,
    });
    expect(removal.proposal.svg).toMatch(
      /data-boundary-kind="parcel"[^>]*fill="url\(#removed-hatch\)"/,
    );
  });
  it("renders one multipart building with a transparent courtyard, separate island and one change count", () => {
    const input = fixture();
    input.place.buildings = [];
    input.place.roads = [];
    input.proposalScenario.roadEdits = {};
    const building = applyBuildingGeometry(
      buildingPreset("office", [-112.066, 33.463]),
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-112.069, 33.46],
              [-112.061, 33.46],
              [-112.061, 33.466],
              [-112.069, 33.466],
              [-112.069, 33.46],
            ],
            [
              [-112.067, 33.462],
              [-112.065, 33.462],
              [-112.065, 33.464],
              [-112.067, 33.464],
              [-112.067, 33.462],
            ],
          ],
          [island],
        ],
      },
    );
    input.proposalScenario.buildingEdits = { [building.id]: building };
    const captured = canonicalJSON(input),
      maps = buildReportMapPairSvg(input),
      p = maps.metadata.projection;
    expect(maps.metadata.changes.buildings).toEqual({
      added: 1,
      modified: 0,
      removed: 0,
    });
    expect(maps.proposal.svg).toContain('fill-rule="evenodd"');
    expect(
      rgb(maps.proposal.svg, projectReportPosition([-112.066, 33.463], p)),
    ).toEqual([245, 244, 235]);
    expect(
      rgb(maps.proposal.svg, projectReportPosition([-112.068, 33.461], p)),
    ).not.toEqual([245, 244, 235]);
    expect(
      rgb(maps.proposal.svg, projectReportPosition([-112.055, 33.463], p)),
    ).not.toEqual([245, 244, 235]);
    expect(
      rgb(maps.proposal.svg, projectReportPosition([-112.058, 33.463], p)),
    ).toEqual([232, 238, 234]);
    expect(canonicalJSON(input)).toBe(captured);
  });
  it("produces deterministic real PNGs and hashes without mutating the captured baseline or scenarios", async () => {
    const input = fixture();
    const before = canonicalJSON(input);
    const a = await renderReportMapPair(input),
      b = await renderReportMapPair(input);
    expect(canonicalJSON(input)).toBe(before);
    for (const side of ["baseline", "proposal"] as const) {
      expect(a[side].png.subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
      expect(a[side].png.readUInt32BE(16)).toBe(1400);
      expect(a[side].png.readUInt32BE(20)).toBe(900);
      expect(a[side].png.equals(b[side].png)).toBe(true);
      expect(a[side].sha256).toBe(
        createHash("sha256").update(a[side].png).digest("hex"),
      );
    }
    expect(a.metadata.inputHash).toBe(b.metadata.inputHash);
    expect(a.metadata.baselineHash).toBe(
      createHash("sha256").update(canonicalJSON(input.place)).digest("hex"),
    );
    expect(a.baseline.sha256).not.toBe(a.proposal.sha256);
    expect(a.proposal.revision).toBe(3);
  });
  it("escapes untrusted labels and never introduces image, URL or local-file loading markup", () => {
    const input = fixture();
    input.place.name =
      '<image href="file:///etc/passwd"/><script>bad()</script>';
    input.proposalScenario.name = '<svg onload="bad()">';
    const maps = buildReportMapPairSvg(input);
    expect(maps.proposal.svg).not.toMatch(
      /<(?:image|script|foreignObject|a)\b/,
    );
    expect(maps.proposal.svg).not.toMatch(/<[^>]+\bhref=/);
    expect(maps.proposal.svg).toContain("&lt;image");
    expect(
      [...maps.proposal.svg.matchAll(/url\((.*?)\)/g)].every((match) =>
        match[1].startsWith("#"),
      ),
    ).toBe(true);
  });
  it("fits unusually wide names while retaining the complete citation and alt text", () => {
    const input = fixture();
    input.place.name = "W".repeat(200);
    input.place.sources[0].name = "W".repeat(240);
    const maps = buildReportMapPairSvg(input);
    expect(maps.proposal.alt).toContain(input.place.name);
    expect(maps.metadata.credits[0].name).toBe(input.place.sources[0].name);
    expect(maps.proposal.svg).toContain("…");
    expect(maps.proposal.svg).toContain(
      "Full source names, vintages, licenses and URLs accompany this image",
    );
    // No label can widen the image beyond its fixed printable page frame.
    expect(new Resvg(maps.proposal.svg).innerBBox()!.width).toBeLessThanOrEqual(
      REPORT_MAP_LIMITS.width,
    );
  });
  it("rejects non-baseline before scenarios, invalid coordinates, oversized input and unsupported extents explicitly", () => {
    const notBaseline = fixture();
    notBaseline.baselineScenario.buildingEdits.changed =
      notBaseline.place.buildings[0];
    expect(() => buildReportMapPairSvg(notBaseline)).toThrow(
      "immutable baseline",
    );
    const invalid = fixture();
    invalid.place.buildings[0].footprint![0] = [NaN, 33.46];
    expect(() => buildReportMapPairSvg(invalid)).toThrow("invalid coordinate");
    const huge = fixture();
    huge.place.buildings[0].footprint = Array.from(
      { length: REPORT_MAP_LIMITS.vertices + 1 },
      () => [-112.068, 33.46] as Position,
    );
    expect(() => buildReportMapPairSvg(huge)).toThrow("vertex limit");
    const wide = fixture();
    wide.place.studyArea = undefined;
    wide.place.boundary = [
      [-120, 30],
      [-100, 30],
      [-100, 40],
      [-120, 40],
      [-120, 30],
    ];
    expect(() => buildReportMapPairSvg(wide)).toThrow("200 km");
  });
  it("bounds concurrent pairs and releases capacity after cancellation or a rejected scene", async () => {
    const input = fixture();
    const controller = new AbortController();
    const running = renderReportMapPair(input),
      cancelled = renderReportMapPair(input, { signal: controller.signal }),
      queued = renderReportMapPair(input);
    const rejected = renderReportMapPair(input);
    await expect(rejected).rejects.toMatchObject({ code: "REPORT_MAP_BUSY" });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "REPORT_MAP_CANCELLED",
    });
    await Promise.all([running, queued]);
    const invalid = fixture();
    invalid.baselineScenario.id = "invalid";
    await expect(renderReportMapPair(invalid)).rejects.toMatchObject({
      code: "REPORT_BASELINE_INVALID",
    });
    await expect(renderReportMapPair(input)).resolves.toHaveProperty(
      "proposal.png",
    );
  });
  it("renders complete real Phoenix and Chicago saved source bundles within fixed output bounds", async () => {
    for (const filename of ["phoenix.json", "zcta-60601-2020.json"]) {
      const place = JSON.parse(
        await readFile(
          new URL(`../../../public/data/${filename}`, import.meta.url),
          "utf8",
        ),
      ) as Place;
      const project = createProject(place);
      const input = {
        place,
        baselineScenario: project.scenarios.find((s) => s.id === "baseline")!,
        proposalScenario: project.scenarios.find(
          (s) => s.id === project.activeScenarioId,
        )!,
      };
      const started = performance.now();
      const maps = await renderReportMapPair(input);
      const elapsed = performance.now() - started;
      expect(maps.metadata.changes).toEqual({
        buildings: { added: 0, modified: 0, removed: 0 },
        roads: { added: 0, modified: 0, removed: 0 },
      });
      expect(maps.baseline.png.length).toBeLessThan(5_000_000);
      expect(maps.proposal.png.length).toBeLessThan(5_000_000);
      expect(elapsed).toBeLessThan(15_000);
    }
  }, 30_000);
});
