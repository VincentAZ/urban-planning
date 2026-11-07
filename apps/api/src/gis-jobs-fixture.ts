/** Synthetic converter for orchestration tests; native GDAL has separate integration coverage. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJSON } from "@urban/core";
import type {
  GisInput,
  GisInspection,
  GisNormalized,
  GisRecipe,
  GisExportLayer,
} from "./gis-types.js";
const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
export class FixtureGisRuntime {
  calls = 0;
  gate?: Promise<void>;
  fail = false;
  async available() {
    return { available: true, image: "synthetic-test-only", reason: null };
  }
  private async wait(signal?: AbortSignal) {
    this.calls++;
    if (signal?.aborted) throw new Error("aborted");
    if (this.gate)
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        this.gate!.then(resolve, reject).finally(() =>
          signal?.removeEventListener("abort", abort),
        );
      });
    if (this.fail) throw new Error("synthetic runtime failure");
  }
  async inspect(input: GisInput): Promise<GisInspection> {
    await this.wait(input.signal);
    const bytes = await readFile(input.inputPath),
      collection = JSON.parse(bytes.toString());
    return {
      version: 1,
      format: input.format,
      input: { sha256: hash(bytes), bytes: bytes.length, members: [] },
      converter: {
        name: "Synthetic test converter",
        version: "1",
        projVersion: "test",
        imageDigest: "a".repeat(64),
      },
      layers: [
        {
          id: "fixture",
          name: "Synthetic footprints",
          featureCount: collection.features.length,
          geometryTypes: { Polygon: collection.features.length },
          entityTypes: {},
          fields: Object.entries(collection.features[0]?.properties ?? {}).map(
            ([name, value]) => ({
              name,
              type: typeof value,
              nullable: true,
              samples: [value as string | number | null],
            }),
          ),
          bounds: null,
          crs: { wkt: "EPSG:4326", authority: "EPSG:4326", unit: "degree" },
          supportedFootprints: collection.features.length,
          unsupportedEntities: 0,
          hasZ: false,
        },
      ],
      warnings: [],
    };
  }
  async normalize(
    input: GisInput & { recipe: GisRecipe },
  ): Promise<GisNormalized> {
    await this.wait(input.signal);
    const bytes = await readFile(input.inputPath),
      geojson = JSON.parse(bytes.toString());
    return {
      version: 1,
      geojson,
      provenance: {
        version: 1,
        format: input.format,
        upload: {
          name: input.filename ?? "fixture.geojson",
          sha256: hash(bytes),
          bytes: bytes.length,
          members: [],
        },
        selection: { layer: input.recipe.layerId },
        crs: { source: "EPSG:4326", axisOrder: "xy", target: "OGC:CRS84" },
        operation: { name: "Synthetic identity operation", accuracyMeters: 0 },
        converter: { name: "Synthetic test converter", version: "1" },
        normalizedSha256: hash(canonicalJSON(geojson)),
        recipe: {},
        exclusions: [],
      },
      diagnostics: {
        inputFeatures: geojson.features.length,
        selectedFeatures: geojson.features.length,
        outputFeatures: geojson.features.length,
        excludedFeatures: 0,
        vertices: 5 * geojson.features.length,
        warnings: [],
      },
    };
  }
  async exportShapefile(input: {
    layers: GisExportLayer[];
    manifest: Record<string, unknown>;
    signal?: AbortSignal;
  }) {
    await this.wait(input.signal);
    const zip = Buffer.from(
      canonicalJSON({
        layers: input.layers,
        manifest: input.manifest,
        synthetic: true,
      }),
    );
    return { zip, sha256: hash(zip), manifest: input.manifest };
  }
}
