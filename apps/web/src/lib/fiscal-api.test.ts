import { afterEach, expect, it, vi } from "vitest";
import { fiscalApi } from "./fiscal-api";
import { fiscalFixture } from "../../../../packages/models/src/fiscal-fixture";
afterEach(() => vi.unstubAllGlobals());
it("preserves library cursor, exact version and append CAS without issuing a mutation on read", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ profiles: [], nextCursor: null })),
    );
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  await fiscalApi.versions("profile/id", "opaque/+=", signal);
  await fiscalApi.read("profile/id", "version/id", signal);
  const { profile } = fiscalFixture();
  const body = {
    profile,
    profileId: "family",
    expectedLatestVersionId: "old-version",
    idempotencyKey: "retained-request-key",
  };
  await fiscalApi.save(body, signal);
  const url = new URL(String(fetcher.mock.calls[0][0]), "https://test");
  expect(url.pathname).toBe("/api/v1/fiscal-profiles/profile%2Fid/versions");
  expect(url.searchParams.get("cursor")).toBe("opaque/+=");
  expect(fetcher.mock.calls[1][0]).toBe(
    "/api/v1/fiscal-profiles/profile%2Fid/versions/version%2Fid",
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    credentials: "include",
    cache: "no-store",
    signal,
  });
  expect(fetcher.mock.calls[2][1]).toMatchObject({
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
});
