import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./store";
import { housingApiFixture, exerciseHousingApi } from "./housing-test-fixture";
import { housingFixture } from "../../../packages/models/src/housing-fixture";
import { HousingCatalog, housingCatalogQuery } from "./housing-catalog";
import { housingIncomeLimitPackHash } from "@urban/core";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe("HUD housing catalog and saved workflow", () => {
  it("retains exact area evidence through authenticated adoption, metrics, publication and private exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "housing-api-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const f = await housingApiFixture(new FileStore(join(dir, "state.json")));
    cleanup.push(() => f.app.close());
    await exerciseHousingApi(f);
  });
  it("paginates all matching immutable areas and binds cursors to filters and catalog identity", async () => {
    const f = housingFixture();
    const entries = Array.from({ length: 107 }, (_, i) => {
      const pack = structuredClone(f.pack);
      pack.area.id = `SYNTHETIC-${i}`;
      pack.area.name = `Synthetic area ${i}`;
      return {
        id: housingIncomeLimitPackHash(pack),
        pack,
        registeredAt: f.source.rights!.declaredAt,
        sourceManifestHash: "a".repeat(64),
      };
    });
    const catalog = new HousingCatalog(undefined, entries),
      query = housingCatalogQuery.parse({ state: "04" }),
      first = await catalog.list(query),
      second = await catalog.list({ ...query, cursor: first.nextCursor! }),
      third = await catalog.list({ ...query, cursor: second.nextCursor! });
    expect([
      first.areas.length,
      second.areas.length,
      third.areas.length,
    ]).toEqual([50, 50, 7]);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.areas, ...second.areas, ...third.areas].map(
          (r) => r.packHash,
        ),
      ).size,
    ).toBe(107);
    await expect(
      catalog.list({ ...query, q: "changed", cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "HOUSING_CURSOR_INVALID" });
    await expect(
      new HousingCatalog(undefined, entries.slice(1)).list({
        ...query,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "HOUSING_CURSOR_INVALID" });
  });
});
