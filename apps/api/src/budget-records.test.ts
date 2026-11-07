import { describe, expect, it } from "vitest";
import { budgetRecordPage, budgetRecordQuery } from "./budget-records";
import { defaultBudgetState } from "./budget";

function fixture() {
  const state = defaultBudgetState();
  state.reservations = Array.from({ length: 123 }, (_, i) => ({
    id: `hold-${i}`,
    idempotencyKey: `hold-key-${i}`,
    provider: "fixture",
    operation: "fixture",
    actorId: "fixture-worker",
    period: i < 3 ? "2026-10" : "2026-11",
    maximumCents: 100,
    status: i === 0 ? ("running" as const) : ("settled" as const),
    createdAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:05:00.000Z",
    ...(i === 0
      ? { startedAt: "2026-10-31T23:59:59.000Z" }
      : { actualCents: 50, settledPeriod: "2026-11" }),
  }));
  return state;
}
describe("complete private budget record pagination", () => {
  it("retains every all-period row, including old running holds, exactly once across pages", () => {
    const state = fixture(),
      ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = budgetRecordPage(state, {
        collection: "reservations",
        cursor,
      });
      expect(page.total).toBe(123);
      expect(page.items.length).toBeLessThanOrEqual(50);
      ids.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(state.reservations.map((r) => r.id).reverse());
    expect(new Set(ids).size).toBe(123);
    expect(ids.at(-1)).toBe("hold-0");
  });
  it("rejects a cursor if any later settlement changes the viewed collection", () => {
    const state = fixture(),
      first = budgetRecordPage(state, { collection: "reservations" });
    state.reservations[0].status = "settled";
    expect(() =>
      budgetRecordPage(state, {
        collection: "reservations",
        cursor: first.nextCursor!,
      }),
    ).toThrow(expect.objectContaining({ code: "BUDGET_RECORDS_CHANGED" }));
    expect(
      budgetRecordPage(state, { collection: "reservations" }).snapshotHash,
    ).not.toBe(first.snapshotHash);
  });
  it("rejects malformed, cross-collection and out-of-range cursors without leaking a different collection", () => {
    const state = fixture(),
      first = budgetRecordPage(state, { collection: "reservations" });
    expect(() =>
      budgetRecordPage(state, {
        collection: "audit",
        cursor: first.nextCursor!,
      }),
    ).toThrow(expect.objectContaining({ code: "BUDGET_CURSOR_INVALID" }));
    expect(() =>
      budgetRecordPage(state, {
        collection: "reservations",
        cursor: "badcursor",
      }),
    ).toThrow(expect.objectContaining({ code: "BUDGET_CURSOR_INVALID" }));
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        collection: "reservations",
        hash: first.snapshotHash,
        offset: 150,
      }),
    ).toString("base64url");
    expect(() =>
      budgetRecordPage(state, { collection: "reservations", cursor }),
    ).toThrow(expect.objectContaining({ code: "BUDGET_CURSOR_INVALID" }));
    expect(
      budgetRecordQuery.safeParse({ collection: "reservations", limit: 10000 })
        .success,
    ).toBe(false);
  });
  it("returns isolated complete audit details and empty optional legacy review history", () => {
    const state = defaultBudgetState();
    state.audit.push({
      id: "audit-1",
      at: "2026-11-01T00:00:00Z",
      actorId: "admin",
      action: "policy.updated",
      details: {
        before: { monthlyLimitCents: 30000 },
        after: { monthlyLimitCents: 40000 },
      },
    });
    const page = budgetRecordPage(state, { collection: "audit" });
    expect(page.items).toEqual(state.audit);
    (page.items[0] as (typeof state.audit)[0]).details.before = null;
    expect(state.audit[0].details.before).toEqual({ monthlyLimitCents: 30000 });
    expect(
      budgetRecordPage(state, { collection: "costReviews" }),
    ).toMatchObject({ items: [], total: 0, offset: 0, nextCursor: null });
  });
});
