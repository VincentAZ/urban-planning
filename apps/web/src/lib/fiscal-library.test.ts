import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { fiscalFixture } from "../../../../packages/models/src/fiscal-fixture";
import {
  readLocalFiscalProfiles,
  saveLocalFiscalProfile,
} from "./fiscal-library";
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());
it("retains immutable exact profile versions and separates local account scopes", async () => {
  const { profile } = fiscalFixture();
  const first = await saveLocalFiscalProfile("user-a:org-a", profile);
  const replay = await saveLocalFiscalProfile("user-a:org-a", profile);
  expect(replay).toEqual(first);
  const updated = structuredClone(profile);
  updated.profileVersion = "2";
  updated.coefficients.discountRate = 0.05;
  await saveLocalFiscalProfile("user-a:org-a", updated);
  const records = await readLocalFiscalProfiles("user-a:org-a");
  expect(records).toHaveLength(2);
  expect(records.find((value) => value.hash === first.hash)?.profile).toEqual(
    profile,
  );
  expect(await readLocalFiscalProfiles("user-b:org-a")).toEqual([]);
  expect(await readLocalFiscalProfiles("guest:local")).toEqual([]);
  expect(await readLocalFiscalProfiles("user-a:org")).toEqual([]);
});
