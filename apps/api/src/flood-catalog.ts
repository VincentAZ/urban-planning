import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  canonicalJSON,
  floodDatasetHash,
  floodDatasetSchema,
  type FloodDataset,
} from "@urban/core";
import { loadPreparedFloodDataset } from "./data/flood";
import { validateFloodDatasetsInWorker } from "./flood-normalization-worker";
import { ApiError } from "./errors";
import type { FloodCatalogChoice, FloodSourceRecord } from "./flood-types";
import type { Store } from "./store";
const schema = z
  .object({
    version: z.literal(1),
    datasets: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
            label: z.string().min(1).max(240),
            directory: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export interface FloodCatalogEntry extends FloodCatalogChoice {
  dataset: FloodDataset;
  sourceManifestHash: string;
}
export class FloodCatalog {
  private loading?: Promise<FloodCatalogEntry[]>;
  constructor(
    private readonly path?: string,
    private readonly fixtures?: FloodCatalogEntry[],
  ) {}
  async entries(): Promise<FloodCatalogEntry[]> {
    if (this.fixtures) return structuredClone(this.fixtures);
    if (!this.path) return [];
    this.loading ??= this.load().catch((e) => {
      this.loading = undefined;
      throw e;
    });
    return structuredClone(await this.loading);
  }
  private async load() {
    if ((await stat(this.path!)).size > 64 * 1024)
      throw new Error("Flood catalog configuration exceeds 64 KiB.");
    const bytes = await readFile(this.path!);
    if (bytes.length > 64 * 1024)
      throw new Error("Flood catalog configuration exceeds 64 KiB.");
    const config = schema.parse(JSON.parse(bytes.toString("utf8"))),
      root = await realpath(dirname(resolve(this.path!)));
    if (
      new Set(config.datasets.map((d) => d.id)).size !== config.datasets.length
    )
      throw new Error("Duplicate flood catalog ID.");
    const entries: FloodCatalogEntry[] = [];
    let total = 0;
    for (const row of config.datasets) {
      const directory = await realpath(resolve(root, row.directory));
      const rel = relative(root, directory);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error(
          "Flood preparation must be confined to the configured catalog directory.",
        );
      const result = await loadPreparedFloodDataset(directory);
      total += result.bytes;
      if (total > 16 * 1024 * 1024)
        throw new Error("Configured flood packs exceed 16 MiB.");
      if (
        result.dataset.sources.some(
          (s) =>
            s.rights &&
            (!s.rights.privateUse || !s.rights.publicRedistribution),
        )
      )
        throw new Error(
          "Public flood catalog cannot contain restricted sources.",
        );
      entries.push({
        id: row.id,
        label: row.label,
        ...result,
        studyAreaHash: result.dataset.studyAreaHash,
        capturedAt: result.dataset.capturedAt,
      });
    }
    if (new Set(entries.map((e) => e.datasetHash)).size !== entries.length)
      throw new Error("Duplicate flood catalog content hash.");
    return entries;
  }
  async list(studyAreaHash: string) {
    return (await this.entries())
      .filter((e) => e.studyAreaHash === studyAreaHash)
      .map(({ dataset: _d, sourceManifestHash: _m, ...choice }) => choice);
  }
  async get(hash: string) {
    const row = (await this.entries()).find((e) => e.datasetHash === hash);
    if (!row)
      throw new ApiError(
        404,
        "FLOOD_DATASET_UNAVAILABLE",
        "This prepared flood dataset is not configured. Previously saved captures remain unchanged.",
      );
    return row;
  }
}
/** Explicit operator installation only; ordinary API startup never mutates the registry. */
export async function installFloodCatalog(store: Store, catalog: FloodCatalog) {
  const rows = await catalog.entries();
  for (const row of rows) {
    floodDatasetSchema.parse(row.dataset);
    if (
      (await floodDatasetHash(row.dataset)) !== row.datasetHash ||
      row.studyAreaHash !== row.dataset.studyAreaHash
    )
      throw new Error("Invalid prepared flood hash.");
    if (
      row.dataset.sources.some(
        (s) =>
          s.rights && (!s.rights.privateUse || !s.rights.publicRedistribution),
      )
    )
      throw new Error(
        "Public flood registry cannot contain restricted sources.",
      );
  }
  await validateFloodDatasetsInWorker(rows.map((r) => r.dataset));
  return store.transaction(
    (state) => {
      let installed = 0;
      for (const row of rows) {
        const existing = state.floodSources.find(
          (s) => s.id === row.datasetHash,
        );
        if (existing) {
          if (
            canonicalJSON(existing.dataset) !== canonicalJSON(row.dataset) ||
            existing.sourceManifestHash !== row.sourceManifestHash
          )
            throw new Error("Immutable flood registry conflict.");
          continue;
        }
        const record: FloodSourceRecord = {
          id: row.datasetHash,
          studyAreaHash: row.studyAreaHash,
          dataset: row.dataset,
          registeredAt: new Date().toISOString(),
          sourceManifestHash: row.sourceManifestHash,
        };
        state.floodSources.push(record);
        installed++;
      }
      return { installed, configured: rows.length };
    },
    {
      floodSources: rows.length
        ? { where: [{ id: rows.map((r) => r.datasetHash) }] }
        : { append: true },
    },
  );
}
