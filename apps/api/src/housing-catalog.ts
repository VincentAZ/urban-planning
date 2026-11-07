import {
  canonicalJSON,
  housingIncomeLimitPackHash,
  validateHousingIncomeLimitPack,
} from "@urban/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors";
import type { Store } from "./store";
import type {
  HousingCatalogChoice,
  HousingCatalogResponse,
  HousingSourceRecord,
} from "./housing-types";
import { loadPreparedHousingCatalog } from "./data/housing";

export const housingCatalogQuery = z
  .object({
    state: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
    county: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    q: z.string().trim().max(160).default(""),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(2048)
      .optional(),
  })
  .strict();
export interface HousingCatalogEntry extends HousingSourceRecord {}
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");
const choice = (entry: HousingCatalogEntry): HousingCatalogChoice => ({
  packHash: entry.id,
  area: entry.pack.area,
  fiscalYear: entry.pack.fiscalYear,
  effectiveDate: entry.pack.effectiveDate,
});
/** Only immutable, operator-prepared public HUD source packs are exposed here. */
export class HousingCatalog {
  private loading?: Promise<HousingCatalogEntry[]>;
  constructor(
    private readonly directory?: string,
    private readonly fixtures?: HousingCatalogEntry[],
  ) {}
  private async entries() {
    this.loading ??= (
      this.fixtures
        ? Promise.resolve(structuredClone(this.fixtures))
        : this.directory
          ? loadPreparedHousingCatalog(this.directory)
          : Promise.resolve([])
    )
      .then((entries) => {
        if (
          entries.length > 10000 ||
          Buffer.byteLength(canonicalJSON(entries)) > 64 * 1024 * 1024
        )
          throw new Error("Housing catalog exceeds its bounded capacity.");
        const ids = new Set<string>();
        for (const entry of entries) {
          validateHousingIncomeLimitPack(entry.pack);
          if (
            ids.has(entry.id) ||
            housingIncomeLimitPackHash(entry.pack) !== entry.id ||
            !/^[a-f0-9]{64}$/.test(entry.sourceManifestHash)
          )
            throw new Error("Housing catalog identity mismatch.");
          if (
            entry.pack.sources.some(
              (s) =>
                !s.rights ||
                !s.rights.privateUse ||
                !s.rights.cache ||
                !s.rights.analyze ||
                !s.rights.privateDisplay ||
                !s.rights.historicalRetention ||
                !s.rights.publicRedistribution ||
                !s.rights.export,
            )
          )
            throw new Error(
              "Public housing catalog cannot contain restricted sources.",
            );
          ids.add(entry.id);
        }
        return entries.sort((a, b) => a.id.localeCompare(b.id));
      })
      .catch((error) => {
        this.loading = undefined;
        throw error;
      });
    return this.loading;
  }
  async list(
    query: z.infer<typeof housingCatalogQuery>,
  ): Promise<HousingCatalogResponse> {
    const entries = await this.entries(),
      catalogHash = hash(entries.map((e) => [e.id, e.sourceManifestHash]));
    const filter = {
      state: query.state ?? null,
      county: query.county ?? null,
      q: query.q.toLowerCase(),
    };
    const queryHash = hash(filter);
    let after = "";
    if (query.cursor) {
      try {
        const token = z
          .object({
            version: z.literal(1),
            catalogHash: z.string(),
            queryHash: z.string(),
            after: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
          );
        if (token.catalogHash !== catalogHash || token.queryHash !== queryHash)
          throw new Error("stale");
        after = token.after;
      } catch {
        throw new ApiError(
          409,
          "HOUSING_CURSOR_INVALID",
          "The catalog or search changed. Restart this area search.",
        );
      }
    }
    const filtered = entries.filter(
      (e) =>
        (!filter.state ||
          e.pack.area.geographies.some((g) => g.stateFips === filter.state)) &&
        (!filter.county ||
          e.pack.area.geographies.some(
            (g) => g.countyFips === filter.county,
          )) &&
        (!filter.q ||
          [e.pack.area.name, ...e.pack.area.geographies.map((g) => g.name)]
            .join(" ")
            .toLowerCase()
            .includes(filter.q)),
    );
    if (after && !filtered.some((e) => e.id === after))
      throw new ApiError(
        409,
        "HOUSING_CURSOR_INVALID",
        "This area cursor does not belong to the current search.",
      );
    const candidates = filtered.filter((e) => e.id > after),
      page = candidates.slice(0, 50);
    return {
      version: 1,
      catalogHash,
      areas: page.map(choice),
      nextCursor:
        candidates.length > page.length
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                catalogHash,
                queryHash,
                after: page.at(-1)!.id,
              }),
            ).toString("base64url")
          : null,
    };
  }
  async get(id: string) {
    const entry = (await this.entries()).find((e) => e.id === id);
    if (!entry)
      throw new ApiError(
        404,
        "HOUSING_PACK_UNAVAILABLE",
        "This HUD income-limit pack is not configured. Previously retained evidence remains unchanged.",
      );
    return structuredClone(entry);
  }
  async all() {
    return structuredClone(await this.entries());
  }
}
/** Explicit operator step; API startup does not mutate the source registry. */
export async function installHousingCatalog(
  store: Store,
  catalog: HousingCatalog,
) {
  const entries = await catalog.all();
  return store.transaction(
    (state) => {
      let installed = 0;
      for (const entry of entries) {
        const existing = state.housingSources.find((s) => s.id === entry.id);
        if (existing) {
          if (
            canonicalJSON(existing.pack) !== canonicalJSON(entry.pack) ||
            existing.sourceManifestHash !== entry.sourceManifestHash
          )
            throw new Error("Immutable housing registry conflict.");
        } else {
          state.housingSources.push(entry);
          installed++;
        }
      }
      return { installed, configured: entries.length };
    },
    {
      housingSources: entries.length
        ? { where: [{ id: entries.map((e) => e.id) }] }
        : { append: true },
    },
  );
}
