import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { FileStore } from "./store";
import { defaultBudgetState, budgetDashboard } from "./budget";
import {
  identityMailRunningHolds,
  reconcileIdentityMailInvoice,
  reconcileStoredIdentityMailInvoice,
} from "./identity-mail-reconciliation";
const now = new Date("2026-11-06T12:00:00Z");
function budget() {
  const state = defaultBudgetState();
  state.policy.paidOperationsPaused = false;
  state.reservations = ["a", "b"].map((id) => ({
    id,
    idempotencyKey: `identity-mail:outbox-${id}:1`,
    provider: "configured-smtp",
    operation: "identity-email",
    actorId: "identity-mail-worker",
    period: "2026-10",
    maximumCents: 3,
    status: "running" as const,
    createdAt: "2026-10-31T00:00:00Z",
    expiresAt: "2026-10-31T00:02:00Z",
    startedAt: "2026-10-31T00:00:01Z",
  }));
  return state;
}
describe("identity mail invoice accounting", () => {
  it("settles exact allocations once without double-counting invoice total and replays reordered entries", () => {
    const s = budget();
    const input = {
      reference: "invoice-1",
      totalCents: 3,
      entries: [
        { reservationId: "a", actualCents: 0 },
        { reservationId: "b", actualCents: 3 },
      ],
    };
    expect(reconcileIdentityMailInvoice(s, input, now).replayed).toBe(false);
    expect(budgetDashboard(s, now).totals.recordedSpendCents).toBe(3);
    expect(budgetDashboard(s, now).totals.reservedCents).toBe(0);
    const saved = structuredClone(s);
    expect(
      reconcileIdentityMailInvoice(
        s,
        { ...input, entries: [...input.entries].reverse() },
        now,
      ).replayed,
    ).toBe(true);
    expect(s).toEqual(saved);
    expect(identityMailRunningHolds(s)).toEqual([]);
  });
  it("records overruns as actual debt and pauses paid dispatch", () => {
    const s = budget();
    const result = reconcileIdentityMailInvoice(
      s,
      {
        reference: "overrun",
        totalCents: 40000,
        entries: [{ reservationId: "a", actualCents: 40000 }],
      },
      now,
    );
    expect(result.paidOperationsPaused).toBe(true);
    expect(s.policy.version).toBe(2);
    expect(budgetDashboard(s, now).totals.overLimitCents).toBe(10003);
    expect(identityMailRunningHolds(s)).toEqual([
      {
        reservationId: "b",
        maximumCents: 3,
        attemptKey: "identity-mail:outbox-b:1",
      },
    ]);
  });
  it.each([
    {
      reference: "bad",
      totalCents: 3,
      entries: [{ reservationId: "a", actualCents: 2 }],
    },
    {
      reference: "bad",
      totalCents: 2,
      entries: [
        { reservationId: "a", actualCents: 1 },
        { reservationId: "a", actualCents: 1 },
      ],
    },
    { reference: "bad", totalCents: 0, entries: [] },
    {
      reference: "bad",
      totalCents: 0,
      entries: [{ reservationId: "missing", actualCents: 0 }],
    },
  ])(
    "rejects malformed or unavailable allocations without partial settlement %#",
    (input) => {
      const s = budget(),
        saved = structuredClone(s);
      expect(() => reconcileIdentityMailInvoice(s, input, now)).toThrow();
      expect(s).toEqual(saved);
    },
  );
  it("rejects reused references, already settled allocations and non-mail holds", () => {
    const s = budget();
    reconcileIdentityMailInvoice(
      s,
      {
        reference: "one",
        totalCents: 1,
        entries: [{ reservationId: "a", actualCents: 1 }],
      },
      now,
    );
    const saved = structuredClone(s);
    for (const input of [
      {
        reference: "one",
        totalCents: 2,
        entries: [{ reservationId: "a", actualCents: 2 }],
      },
      {
        reference: "other",
        totalCents: 1,
        entries: [{ reservationId: "a", actualCents: 1 }],
      },
    ])
      expect(() => reconcileIdentityMailInvoice(s, input, now)).toThrow();
    expect(s).toEqual(saved);
    s.reservations[1].provider = "other";
    expect(() =>
      reconcileIdentityMailInvoice(
        s,
        {
          reference: "other",
          totalCents: 1,
          entries: [{ reservationId: "b", actualCents: 1 }],
        },
        now,
      ),
    ).toThrow();
  });
  it("persists invoice idempotency in one SQLite transaction", async () => {
    const store = new FileStore();
    try {
      await store.transaction((s) => {
        s.budget = budget();
      });
      const input = {
        reference: "durable",
        totalCents: 2,
        entries: [{ reservationId: "a", actualCents: 2 }],
      };
      await reconcileStoredIdentityMailInvoice(store, input);
      expect(
        (await reconcileStoredIdentityMailInvoice(store, input)).replayed,
      ).toBe(true);
      expect(
        (await store.read((s) => s.budget.audit)).filter(
          (a) => a.action === "identity-mail.invoice.reconciled",
        ),
      ).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
  it("requires an explicit CLI target, reconciles a disposable store, and redacts malformed invoice contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "identity-invoice-")),
      path = join(dir, "state.json"),
      invoice = join(dir, "invoice.json"),
      store = new FileStore(path);
    const run = promisify(execFile),
      cli = [
        "node_modules/tsx/dist/cli.mjs",
        "scripts/reconcile-identity-mail.ts",
      ];
    try {
      await store.transaction((s) => {
        s.budget = budget();
      });
      await store.close();
      const listing = await run(process.execPath, [
        ...cli,
        "--list",
        "--state",
        path,
      ]);
      expect(JSON.parse(listing.stdout)).toHaveLength(2);
      expect(listing.stdout).not.toContain("email");
      await writeFile(
        invoice,
        JSON.stringify({
          reference: "cli-fixture",
          totalCents: 1,
          entries: [{ reservationId: "a", actualCents: 1 }],
        }),
      );
      const result = await run(process.execPath, [
        ...cli,
        "--invoice",
        invoice,
        "--state",
        path,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        totalCents: 1,
        reservationCount: 1,
        replayed: false,
      });
      await writeFile(invoice, '{"private":"recipient@example.test", broken');
      const failure = await run(process.execPath, [
        ...cli,
        "--invoice",
        invoice,
        "--state",
        path,
      ]).catch((e) => e);
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain("connection details are not printed");
      expect(failure.stderr).not.toContain("recipient@example.test");
      const noTarget = await run(process.execPath, [...cli, "--list"]).catch(
        (e) => e,
      );
      expect(noTarget.code).toBe(1);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
