import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  readdir,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWorkforceRegionBoundary,
  downloadWorkforceRegionBoundary,
  prepareWorkforceRegionBoundary,
  workforceBoundaryUrls,
  verifyPreparedWorkforceBoundary,
  WORKFORCE_BOUNDARY_LIMITS,
  type WorkforceBoundarySourceKind,
} from "./workforce-boundary";

const geometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [-113, 32],
        [-111, 32],
        [-111, 34],
        [-113, 34],
        [-113, 32],
      ],
      [
        [-112.8, 32.2],
        [-112.8, 32.4],
        [-112.6, 32.4],
        [-112.6, 32.2],
        [-112.8, 32.2],
      ],
    ],
    [
      [
        [-110, 35],
        [-109, 35],
        [-109, 36],
        [-110, 36],
        [-110, 35],
      ],
    ],
  ],
};
const bodies: Record<WorkforceBoundarySourceKind, unknown> = {
  "state-geometry": {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { STATE: "04", GEOID: "04", NAME: "Fixture state" },
        geometry,
      },
    ],
  },
  "county-inventory": {
    features: [
      { attributes: { STATE: "04", GEOID: "04021" } },
      { attributes: { STATE: "04", GEOID: "04013" } },
    ],
  },
  "county-count": { count: 2 },
  "state-metadata": {
    id: 80,
    name: "States",
    description: "States; January 1, 2024 vintage",
    geometryType: "esriGeometryPolygon",
  },
  "county-metadata": {
    id: 82,
    name: "Counties",
    description: "Counties; January 1, 2024 vintage",
    geometryType: "esriGeometryPolygon",
  },
};
function responses(patch: Partial<typeof bodies> = {}) {
  const urls = workforceBoundaryUrls("04");
  return Object.fromEntries(
    Object.entries({ ...bodies, ...patch }).map(([key, data]) => {
      const kind = key as WorkforceBoundarySourceKind;
      const body = Buffer.from(JSON.stringify(data));
      return [
        kind,
        {
          body,
          source: {
            kind,
            url: urls[kind],
            sha256: createHash("sha256").update(body).digest("hex"),
            bytes: body.length,
            retrievedAt: "2026-11-06T00:00:00.000Z",
          },
        },
      ];
    }),
  ) as Parameters<typeof prepareWorkforceRegionBoundary>[1];
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("exact same-vintage Census workforce region boundary", () => {
  it("preserves every polygon, hole and coordinate with independently counted county membership", () => {
    const result = prepareWorkforceRegionBoundary("04", responses());
    expect(result.geometry).toEqual(geometry);
    expect(result.countyGeoids).toEqual(["04013", "04021"]);
    expect(result.vintage).toBe(2024);
    expect(result.sources).toHaveLength(5);
    assertWorkforceRegionBoundary(result);
    const url = new URL(workforceBoundaryUrls("04")["state-geometry"]);
    expect(url.searchParams.get("outSR")).toBe("4326");
    for (const omitted of [
      "maxAllowableOffset",
      "geometryPrecision",
      "quantizationParameters",
      "resultOffset",
    ])
      expect(url.searchParams.has(omitted)).toBe(false);
  });
  it("rejects transfer-limit responses and county cardinality mismatches instead of publishing partial coverage", () => {
    expect(() =>
      prepareWorkforceRegionBoundary(
        "04",
        responses({
          "county-inventory": {
            ...(bodies["county-inventory"] as object),
            exceededTransferLimit: true,
          },
        }),
      ),
    ).toThrow("incomplete");
    expect(() =>
      prepareWorkforceRegionBoundary(
        "04",
        responses({ "county-count": { count: 3 } }),
      ),
    ).toThrow("independent count");
    expect(() =>
      prepareWorkforceRegionBoundary(
        "04",
        responses({ "county-count": { error: { message: "failed" } } }),
      ),
    ).toThrow("failed");
  });
  it("rejects incorrect state, vintage, coordinate system and duplicate counties", () => {
    expect(() =>
      prepareWorkforceRegionBoundary(
        "04",
        responses({
          "state-metadata": {
            ...(bodies["state-metadata"] as object),
            description: "January 1, 2023 vintage",
          },
        }),
      ),
    ).toThrow("vintage");
    expect(() =>
      prepareWorkforceRegionBoundary(
        "04",
        responses({
          "state-geometry": {
            ...(bodies["state-geometry"] as object),
            crs: { properties: { name: "EPSG:3857" } },
          },
        }),
      ),
    ).toThrow("WGS84");
    expect(() =>
      prepareWorkforceRegionBoundary(
        "04",
        responses({
          "county-inventory": {
            features: [
              { attributes: { STATE: "04", GEOID: "04013" } },
              { attributes: { STATE: "04", GEOID: "04013" } },
            ],
          },
        }),
      ),
    ).toThrow("unique");
    expect(() =>
      prepareWorkforceRegionBoundary(
        "04",
        responses({
          "state-geometry": { type: "FeatureCollection", features: [] },
        }),
      ),
    ).toThrow("exactly");
    expect(() => prepareWorkforceRegionBoundary("06", responses())).toThrow(
      "query identity",
    );
  });
  it("binds raw evidence bytes to source hashes and rejects malformed region geometry", () => {
    const changed = responses();
    changed["county-count"].source.sha256 = "f".repeat(64);
    expect(() => prepareWorkforceRegionBoundary("04", changed)).toThrow(
      "digest",
    );
    const result = prepareWorkforceRegionBoundary("04", responses());
    result.geometry.coordinates[0][0][0] = [-113, 31];
    expect(() => assertWorkforceRegionBoundary(result)).toThrow("closed");
  });
  it("retains source bytes and deterministically reuses the frozen artifact, refusing corruption", async () => {
    const path = await mkdtemp(join(tmpdir(), "workforce-boundary-"));
    directories.push(path);
    const urls = workforceBoundaryUrls("04");
    let calls = 0;
    const fetcher = (async (url: string) => {
      calls++;
      const kind = (Object.keys(urls) as WorkforceBoundarySourceKind[]).find(
        (key) => urls[key] === url,
      )!;
      return new Response(JSON.stringify(bodies[kind]));
    }) as typeof fetch;
    const first = await downloadWorkforceRegionBoundary("04", path, fetcher);
    expect(calls).toBe(5);
    expect(await downloadWorkforceRegionBoundary("04", path, fetcher)).toEqual(
      first,
    );
    expect(calls).toBe(5);
    expect(
      createHash("sha256")
        .update(await readFile(first.filename))
        .digest("hex"),
    ).toBe(first.sha256);
    const source = first.boundary.sources[0];
    await writeFile(join(path, "sources", `${source.sha256}.json`), "{}");
    await expect(
      downloadWorkforceRegionBoundary("04", path, fetcher),
    ).rejects.toThrow("integrity");
    expect(calls).toBe(5);
  });

  it("rejects rehashed derived-geometry tampering by replaying retained sources without fetching or writing", async () => {
    const path = await mkdtemp(join(tmpdir(), "workforce-boundary-proof-"));
    directories.push(path);
    await mkdir(join(path, "sources"));
    const raw = responses();
    const boundary = prepareWorkforceRegionBoundary("04", raw);
    for (const { body, source } of Object.values(raw))
      await writeFile(join(path, "sources", `${source.sha256}.json`), body);
    const serialize = (value: unknown) => Buffer.from(JSON.stringify(value));
    const filename = (bytes: Buffer) =>
      join(
        path,
        `boundary-04-${createHash("sha256").update(bytes).digest("hex")}.json`,
      );
    const original = serialize(boundary);
    const originalPath = filename(original);
    await writeFile(originalPath, original);
    expect(await verifyPreparedWorkforceBoundary(originalPath)).toEqual(
      boundary,
    );
    const changed = structuredClone(boundary);
    // Preserve ring closure, all metadata and claimed Census source hashes.
    if (changed.geometry.type !== "MultiPolygon")
      throw new Error("Fixture geometry changed.");
    changed.geometry.coordinates[0][0][1][0] = -110.5;
    const mutated = serialize(changed);
    const mutatedPath = filename(mutated);
    await writeFile(mutatedPath, mutated);
    const entries = await readdir(path);
    await expect(verifyPreparedWorkforceBoundary(mutatedPath)).rejects.toThrow(
      "differs from its retained official sources",
    );
    expect(await readdir(path)).toEqual(entries);
    expect(await readFile(originalPath)).toEqual(original);
    await writeFile(originalPath, mutated);
    await expect(verifyPreparedWorkforceBoundary(originalPath)).rejects.toThrow(
      "immutable filename",
    );
    await writeFile(originalPath, original);
    const sourcePath = join(
      path,
      "sources",
      `${boundary.sources[0].sha256}.json`,
    );
    await rm(sourcePath);
    await expect(
      verifyPreparedWorkforceBoundary(originalPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
    // A sparse oversized file is rejected before allocation or parsing.
    const excessive = await open(sourcePath, "wx");
    await excessive.truncate(WORKFORCE_BOUNDARY_LIMITS.sourceBytes + 1);
    await excessive.close();
    await expect(verifyPreparedWorkforceBoundary(originalPath)).rejects.toThrow(
      "file size",
    );
    await rm(sourcePath);
    const source = boundary.sources[0];
    await writeFile(sourcePath, Buffer.alloc(source.bytes, 32));
    await expect(verifyPreparedWorkforceBoundary(originalPath)).rejects.toThrow(
      "digest",
    );
  });
});
