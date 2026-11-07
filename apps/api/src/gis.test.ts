import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { GisRuntime } from "./gis-runtime.js";
import { gisRecipeSchema, GIS_IMAGE } from "./gis-types.js";
import { canonicalJSON, sourceImportMetadataSchema } from "@urban/core";

const geometry: GeoJSON.MultiPolygon = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [-112.01, 33],
        [-112, 33],
        [-112, 33.01],
        [-112.01, 33.01],
        [-112.01, 33],
      ],
      [
        [-112.008, 33.002],
        [-112.008, 33.004],
        [-112.006, 33.004],
        [-112.006, 33.002],
        [-112.008, 33.002],
      ],
    ],
    [
      [
        [-111.998, 33],
        [-111.996, 33],
        [-111.996, 33.002],
        [-111.998, 33.002],
        [-111.998, 33],
      ],
    ],
  ],
};
const feature = {
  type: "Feature" as const,
  id: "footprint-a",
  geometry,
  properties: {
    name: "Courtyard & wing",
    sourceId: "survey-1",
    sourceFeatureId: "raw-a",
    height: null,
    floors: 0,
    units: null,
    jobs: 12,
    parkingSpaces: null,
    scenarioRevision: 4,
    program: { arbitraryNestedEvidence: [1, 2, "exact"] },
  },
};
const geojson = { type: "FeatureCollection" as const, features: [feature] };
const dxf = (bulge = 0) =>
  [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1024",
    "9",
    "$INSUNITS",
    "70",
    "6",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "ENTITIES",
    "0",
    "LWPOLYLINE",
    "5",
    "A1",
    "100",
    "AcDbEntity",
    "8",
    "Footprints",
    "100",
    "AcDbPolyline",
    "90",
    "4",
    "70",
    "1",
    "10",
    "0",
    "20",
    "0",
    "42",
    String(bulge),
    "10",
    "10",
    "20",
    "0",
    "10",
    "10",
    "20",
    "10",
    "10",
    "0",
    "20",
    "10",
    "0",
    "POINT",
    "5",
    "B1",
    "100",
    "AcDbEntity",
    "8",
    "Notes",
    "100",
    "AcDbPoint",
    "10",
    "5",
    "20",
    "5",
    "30",
    "0",
    "0",
    "ENDSEC",
    "0",
    "EOF",
    "",
  ].join("\n");

describe("GIS declarative interface", () => {
  it("rejects arbitrary pipelines, command fields and nonfinite controls", () => {
    expect(
      gisRecipeSchema.safeParse({
        layerId: "x",
        sourceCrs: { kind: "pipeline", value: "+proj=pipeline" },
      }).success,
    ).toBe(false);
    expect(
      gisRecipeSchema.safeParse({ layerId: "x", sql: "SELECT *" }).success,
    ).toBe(false);
    expect(
      gisRecipeSchema.safeParse({
        layerId: "x",
        dxf: {
          units: "meters",
          curveToleranceMeters: 0,
          localTransform: { controls: [] },
        },
      }).success,
    ).toBe(false);
    expect(
      () =>
        new GisRuntime({
          workRoot: "/tmp/gis",
          allowedInputRoot: "/tmp/gis",
          image: "arbitrary:latest",
        }),
    ).toThrow(/pinned/);
  });
});

describe.runIf(process.env.GIS_NATIVE_TESTS === "1")(
  "pinned offline native GIS",
  () => {
    let root: string, runtime: GisRuntime;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "urban-gis-test-"));
      await mkdir(join(root, "uploads"));
      runtime = new GisRuntime({
        workRoot: join(root, "work"),
        allowedInputRoot: join(root, "uploads"),
      });
    }, 10000);
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function input(name: string, value: string | Buffer) {
      const path = join(root, "uploads", name);
      await writeFile(path, value);
      return path;
    }
    it("runs the pinned engine offline and preserves full GeoJSON geometry and nested properties", async () => {
      expect((await runtime.available()).available).toBe(true);
      const inputPath = await input(
        "footprints.geojson",
        JSON.stringify(geojson),
      );
      const inspected = await runtime.inspect({ inputPath, format: "geojson" });
      expect(inspected.converter.version).toBe("3.13.3");
      expect(inspected.layers[0].supportedFootprints).toBe(1);
      const normalized = await runtime.normalize({
        inputPath,
        format: "geojson",
        filename: "footprints.geojson",
        recipe: { layerId: "geojson" },
      });
      expect(normalized.geojson.features[0].geometry).toEqual(geometry);
      expect(normalized.geojson.features[0].properties).toEqual(
        feature.properties,
      );
      expect(normalized.diagnostics).toMatchObject({
        inputFeatures: 1,
        outputFeatures: 1,
        excludedFeatures: 0,
        vertices: 15,
      });
      expect(normalized.provenance.normalizedSha256).toBe(
        createHash("sha256")
          .update(canonicalJSON(normalized.geojson))
          .digest("hex"),
      );
      expect(
        sourceImportMetadataSchema.safeParse(normalized.provenance).success,
      ).toBe(true);
    }, 30000);
    it("exports and round-trips multipart holes, unknown/null flags and exact nested JSON without omitting citations", async () => {
      const output = await runtime.exportShapefile({
        layers: [{ id: "buildings", geojson }],
        manifest: {
          projectVersion: 2,
          scenarioRevision: 4,
          source: { id: "survey-1" },
        },
      });
      const inputPath = await input("roundtrip.zip", output.zip);
      const inspection = await runtime.inspect({
        inputPath,
        format: "shapefile",
      });
      expect(inspection.layers).toHaveLength(1);
      expect(
        inspection.layers[0].fields.every((f) => f.name.length <= 10),
      ).toBe(true);
      const normalized = await runtime.normalize({
        inputPath,
        format: "shapefile",
        recipe: { layerId: "buildings.shp" },
      });
      const g = normalized.geojson.features[0].geometry;
      expect(g.type).toBe("MultiPolygon");
      expect(
        (g as GeoJSON.MultiPolygon).coordinates.map((p) => p.length),
      ).toEqual([2, 1]);
      expect(normalized.geojson.features[0].properties).toMatchObject({
        HGT_NULL: 1,
        HGT_STAT: "missing",
        FLR_NULL: 0,
        FLR_STAT: "legacy",
        FLOORS: 0,
        UNIT_NULL: 1,
        JOBS: 12,
        JOB_NULL: 0,
      });
      const extracted = JSON.parse(
        execFileSync(
          "python3",
          [
            "-c",
            "import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'exact':json.loads(z.read('buildings.exact.geojson')),'names':z.namelist(),'manifest':json.loads(z.read('manifest.json'))}))",
            inputPath,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(extracted.exact).toEqual(geojson);
      expect(extracted.names).toContain("buildings.prj");
      expect(extracted.names).toContain("buildings.cpg");
      expect(extracted.manifest.projectVersion).toBe(2);
    }, 30000);
    it("rejects traversal, symlinks and mismatched Shapefile components before any geometry conversion", async () => {
      for (const attack of ["traversal", "symlink", "components"]) {
        const target = join(root, "uploads", `${attack}.zip`);
        execFileSync("python3", [
          "-c",
          "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); a=sys.argv[2]; i=zipfile.ZipInfo('../escape.shp' if a=='traversal' else 'x.shp'); i.external_attr=(0o120777 if a=='symlink' else 0o100600)<<16; z.writestr(i,b'/etc/passwd' if a=='symlink' else b'bad'); z.close()",
          target,
          attack,
        ]);
        await expect(
          runtime.inspect({ inputPath: target, format: "shapefile" }),
        ).rejects.toMatchObject({
          code:
            attack === "components"
              ? "GIS_COMPONENT_MISSING"
              : "GIS_UNSAFE_ARCHIVE",
        });
      }
    }, 30000);
    it("requires explicit DXF placement and accounts for excluded entities", async () => {
      const inputPath = await input("plan.dxf", dxf());
      const inspected = await runtime.inspect({ inputPath, format: "dxf" });
      expect(inspected.layers.map((l) => l.id).sort()).toEqual([
        "Footprints",
        "Notes",
      ]);
      await expect(
        runtime.normalize({
          inputPath,
          format: "dxf",
          recipe: {
            layerId: "Footprints",
            dxf: { units: "meters", curveToleranceMeters: 0.1 },
            flattenZ: true,
            acknowledgeExcluded: true,
          },
        }),
      ).rejects.toMatchObject({ code: "GIS_CRS_REQUIRED" });
      const recipe = {
        layerId: "Footprints",
        flattenZ: true,
        acknowledgeExcluded: true,
        dxf: {
          units: "meters" as const,
          curveToleranceMeters: 0.1,
          localTransform: {
            controls: [
              {
                source: [0, 0] as [number, number],
                target: [-112, 33] as [number, number],
              },
              {
                source: [10, 0] as [number, number],
                target: [-111.999893, 33] as [number, number],
              },
            ],
            checkpoints: [],
            maximumResidualMeters: 1,
          },
        },
      };
      const normalized = await runtime.normalize({
        inputPath,
        format: "dxf",
        recipe,
      });
      expect(normalized.diagnostics).toMatchObject({
        inputFeatures: 2,
        outputFeatures: 1,
        excludedFeatures: 1,
      });
      expect(
        normalized.diagnostics.controlResidualsMeters!.every((v) => v < 1e-6),
      ).toBe(true);
      expect(normalized.geojson.features[0].id).toBe("A1");
      expect(normalized.provenance.recipe).toHaveProperty(
        "controlTransformResult",
      );
      expect(normalized.diagnostics.warnings.join(" ")).toContain(
        "no independent accuracy",
      );
      await expect(
        runtime.normalize({
          inputPath,
          format: "dxf",
          recipe: { ...recipe, acknowledgeExcluded: false },
        }),
      ).rejects.toMatchObject({ code: "GIS_EXCLUSIONS_REVIEW_REQUIRED" });
    }, 30000);
    it("rejects inconsistent independent control checkpoints", async () => {
      const inputPath = await input("checkpoint.dxf", dxf());
      await expect(
        runtime.normalize({
          inputPath,
          format: "dxf",
          recipe: {
            layerId: "Footprints",
            flattenZ: true,
            acknowledgeExcluded: true,
            dxf: {
              units: "meters",
              curveToleranceMeters: 0.1,
              localTransform: {
                controls: [
                  { source: [0, 0], target: [-112, 33] },
                  { source: [10, 0], target: [-111.999893, 33] },
                ],
                checkpoints: [{ source: [5, 0], target: [-111, 34] }],
                maximumResidualMeters: 1,
              },
            },
          },
        }),
      ).rejects.toMatchObject({ code: "GIS_CONTROL_RESIDUAL" });
    }, 30000);
    it("transforms an actual projected Shapefile and fails closed when its CRS is missing", async () => {
      const nativeOut = join(root, "uploads", "projected");
      await mkdir(nativeOut);
      const program =
        "from osgeo import gdal; import sys,zipfile,pathlib; gdal.UseExceptions(); gdal.FileFromMemBuffer('/vsimem/input.geojson',sys.stdin.buffer.read()); gdal.VectorTranslate('/out/projected.shp','/vsimem/input.geojson',format='ESRI Shapefile',dstSRS='EPSG:3857',selectFields=['name']); z=zipfile.ZipFile('/out/projected.zip','w'); [z.write(p,p.name) for p in pathlib.Path('/out').glob('projected.*') if p.suffix!='.zip']; z.close()";
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--pull=never",
          "--network=none",
          "--read-only",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          "--memory=512m",
          "--cpus=1",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--mount",
          `type=bind,src=${nativeOut},dst=/out`,
          "--entrypoint",
          "python3",
          GIS_IMAGE,
          "-c",
          program,
        ],
        { input: JSON.stringify(geojson), timeout: 30000 },
      );
      const inputPath = join(nativeOut, "projected.zip");
      const inspected = await runtime.inspect({
        inputPath,
        format: "shapefile",
      });
      expect(inspected.layers[0].crs?.authority).toBe("EPSG:3857");
      const normalized = await runtime.normalize({
        inputPath,
        format: "shapefile",
        recipe: { layerId: "projected.shp" },
      });
      expect(normalized.provenance.crs.source).toBe("EPSG:3857");
      const first = (
        normalized.geojson.features[0].geometry as GeoJSON.MultiPolygon
      ).coordinates[0][0][0];
      expect(first[0]).toBeCloseTo(-112.01, 8);
      expect(first[1]).toBeCloseTo(33, 8);
      const missing = join(nativeOut, "missing.zip");
      execFileSync("python3", [
        "-c",
        "import zipfile,sys; a=zipfile.ZipFile(sys.argv[1]); b=zipfile.ZipFile(sys.argv[2],'w'); [b.writestr(n,a.read(n)) for n in a.namelist() if not n.endswith('.prj')]; b.close()",
        inputPath,
        missing,
      ]);
      await expect(
        runtime.normalize({
          inputPath: missing,
          format: "shapefile",
          recipe: { layerId: "projected.shp" },
        }),
      ).rejects.toMatchObject({ code: "GIS_CRS_REQUIRED" });
      expect(
        (
          await runtime.normalize({
            inputPath: missing,
            format: "shapefile",
            recipe: {
              layerId: "projected.shp",
              sourceCrs: { kind: "epsg", code: 3857 },
            },
          })
        ).geojson.features,
      ).toHaveLength(1);
    }, 30000);
    it("retains curved DXF approximation and unsupported raw entities in the accounting", async () => {
      const source = dxf(0.2).replace(
        "0\nENDSEC\n0\nEOF",
        "0\nXLINE\n5\nC1\n100\nAcDbEntity\n8\nNotes\n100\nAcDbXline\n10\n0\n20\n0\n30\n0\n11\n1\n21\n0\n31\n0\n0\nENDSEC\n0\nEOF",
      );
      const inputPath = await input("curves.dxf", source);
      const inspected = await runtime.inspect({ inputPath, format: "dxf" });
      expect(inspected.layers.reduce((sum, l) => sum + l.featureCount, 0)).toBe(
        3,
      );
      expect(
        inspected.layers.find((l) => l.id === "Notes")!.entityTypes,
      ).toHaveProperty("XLINE", 1);
      const normalized = await runtime.normalize({
        inputPath,
        format: "dxf",
        recipe: {
          layerId: "Footprints",
          flattenZ: true,
          acknowledgeExcluded: true,
          dxf: {
            units: "meters",
            curveToleranceMeters: 0.1,
            localTransform: {
              controls: [
                { source: [0, 0], target: [-112, 33] },
                { source: [10, 0], target: [-111.999893, 33] },
              ],
            },
          },
        },
      });
      expect(normalized.diagnostics.vertices).toBeGreaterThan(5);
      expect(normalized.diagnostics.excludedFeatures).toBe(2);
      expect(normalized.diagnostics.warnings.join(" ")).toContain(
        "tessellated",
      );
    }, 30000);
    it("accounts for binary DXF entities using the same native footprint conversion", async () => {
      const lines = dxf().trimEnd().split("\n"),
        chunks = [Buffer.from("AutoCAD Binary DXF\r\n\x1a\x00", "binary")];
      for (let i = 0; i < lines.length; i += 2) {
        const code = Number(lines[i]);
        const group = Buffer.alloc(2);
        group.writeUInt16LE(code);
        chunks.push(group);
        if ([10, 20, 30, 42].includes(code)) {
          const data = Buffer.alloc(8);
          data.writeDoubleLE(Number(lines[i + 1]));
          chunks.push(data);
        } else if (code === 70) {
          const data = Buffer.alloc(2);
          data.writeInt16LE(Number(lines[i + 1]));
          chunks.push(data);
        } else if (code === 90) {
          const data = Buffer.alloc(4);
          data.writeInt32LE(Number(lines[i + 1]));
          chunks.push(data);
        } else chunks.push(Buffer.from(lines[i + 1] + "\0"));
      }
      const inputPath = await input("binary.dxf", Buffer.concat(chunks));
      const inspection = await runtime.inspect({ inputPath, format: "dxf" });
      expect(
        inspection.layers.reduce((sum, l) => sum + l.featureCount, 0),
      ).toBe(2);
      expect(
        inspection.layers.find((l) => l.id === "Footprints")!
          .supportedFootprints,
      ).toBe(1);
    }, 30000);
    it("rejects oversized inspection inventories without dropping layers or fields", async () => {
      const out = join(root, "uploads", "metadata-cap");
      await mkdir(out);
      const program = `from osgeo import ogr,osr,gdal
import pathlib,zipfile
gdal.UseExceptions()
srs=osr.SpatialReference();srs.ImportFromEPSG(4326)
ds=ogr.GetDriverByName('ESRI Shapefile').CreateDataSource('/out/layers')
for n in range(8):
 layer=ds.CreateLayer('layer'+str(n),srs,ogr.wkbPolygon)
 for f in range(256):
  field=ogr.FieldDefn('f'+str(f),ogr.OFTString);field.SetWidth(220);layer.CreateField(field)
 for row in range(3):
  feature=ogr.Feature(layer.GetLayerDefn())
  for f in range(256): feature.SetField(f,str(row)+'x'*199)
  feature.SetGeometry(ogr.CreateGeometryFromWkt('POLYGON((-112 33,-111.999 33,-111.999 33.001,-112 33.001,-112 33))'));layer.CreateFeature(feature)
ds=None
with zipfile.ZipFile('/out/source.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in pathlib.Path('/out/layers').iterdir(): z.write(p,p.name)
`;
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--network=none",
          "--read-only",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          "--memory=512m",
          "--cpus=1",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--mount",
          `type=bind,src=${out},dst=/out`,
          "--entrypoint",
          "python3",
          GIS_IMAGE,
          "-c",
          program,
        ],
        { timeout: 30000 },
      );
      await expect(
        runtime.inspect({
          inputPath: join(out, "source.zip"),
          format: "shapefile",
        }),
      ).rejects.toMatchObject({ code: "GIS_INSPECTION_LIMIT" });
    }, 30000);
    it("cancels a running native conversion and removes its whole sandbox", async () => {
      const many = {
        type: "FeatureCollection",
        features: Array.from({ length: 5000 }, (_, id) => ({
          ...feature,
          id,
          properties: { name: `Feature ${id}`, padding: "x".repeat(1000) },
        })),
      };
      const inputPath = await input(
        "active-abort.geojson",
        JSON.stringify(many),
      );
      const controller = new AbortController();
      const pending = runtime.normalize({
        inputPath,
        format: "geojson",
        recipe: { layerId: "geojson" },
        signal: controller.signal,
      });
      const observed = pending.then(
        () => ({ completed: true }),
        (error) => ({ error }),
      );
      let sawRunning = false;
      for (let i = 0; i < 80; i++) {
        const active = execFileSync(
          "docker",
          ["ps", "-q", "--filter", "label=urban-planning.service=gis"],
          { encoding: "utf8" },
        ).trim();
        if (active) {
          sawRunning = true;
          controller.abort();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(sawRunning).toBe(true);
      expect(await observed).toMatchObject({
        error: { code: "GIS_CANCELLED" },
      });
      expect(
        execFileSync(
          "docker",
          ["ps", "-aq", "--filter", "label=urban-planning.service=gis"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("");
    }, 30000);
    it("prevents host-path escape and kills cancellation without leaving containers or output", async () => {
      const outside = join(root, "outside.geojson");
      await writeFile(outside, JSON.stringify(geojson));
      await expect(
        runtime.inspect({ inputPath: outside, format: "geojson" }),
      ).rejects.toMatchObject({ code: "GIS_INPUT_PATH" });
      const inputPath = await input("abort.geojson", JSON.stringify(geojson));
      const controller = new AbortController();
      controller.abort();
      await expect(
        runtime.inspect({
          inputPath,
          format: "geojson",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "GIS_CANCELLED" });
      const running = execFileSync(
        "docker",
        ["ps", "-aq", "--filter", "label=urban-planning.service=gis"],
        { encoding: "utf8" },
      ).trim();
      expect(running).toBe("");
    }, 30000);
  },
);
