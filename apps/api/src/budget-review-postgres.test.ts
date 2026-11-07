import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { budgetReviewBasisHash, budgetReviewCoverageHash } from "@urban/core";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { PostgresStore } from "./postgres-store.js";
import {
  budgetApiState,
  exerciseBudgetReviewApi,
} from "./budget-review-fixture.js";
import { reviewBudgetForFixture } from "./budget-test-fixture.js";
import { tokenHash } from "./security.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "manual budget review restricted PostgreSQL authority",
  () => {
    it("replays complete admin HTTP review and trusted reservation lifecycle with real roles", async () => {
      const f = budgetApiState(),
        fixture = await createPostgresSecurityFixture(url!, {
          state: f.state,
          platformAdminUserIds: ["budget-admin"],
        });
      try {
        const store = new PostgresStore(fixture.webURL, {
          mode: "runtime",
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
        });
        await store.initialize();
        await exerciseBudgetReviewApi(store, f.headers);
      } finally {
        await fixture.close();
      }
    }, 30000);
    it("pins hash projections, denies worker review tampering, and grants preparation read-only budget", async () => {
      const f = budgetApiState(),
        now = new Date(),
        period = now.toISOString().slice(0, 7),
        at = now.toISOString();
      const special =
        'Quoted " value\\ slash\nline\ttab emoji🚦 separator\u2028end';
      f.state.budget.adjustments.push(
        ...[500, -40].map((amountCents) => ({
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          period,
          amountCents,
          category: "variable" as const,
          reason: special,
          actorId: "admin",
          createdAt: at,
        })),
      );
      f.state.budget.reservations.push(
        {
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          provider: special,
          operation: "test",
          actorId: "worker",
          period: "2020-01",
          maximumCents: 50,
          status: "running",
          createdAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-01T00:05:00.000Z",
          startedAt: "2020-01-01T00:00:01.000Z",
        },
        {
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          provider: "test",
          operation: special,
          actorId: "worker",
          period,
          maximumCents: 30,
          status: "settled",
          createdAt: at,
          expiresAt: new Date(now.getTime() + 1000).toISOString(),
          startedAt: at,
          settledAt: at,
          settledPeriod: period,
          actualCents: 20,
        },
      );
      reviewBudgetForFixture(f.state.budget);
      const fixture = await createPostgresSecurityFixture(url!, {
        state: f.state,
        platformAdminUserIds: ["budget-admin"],
      });
      const worker = new pg.Pool({
          connectionString: fixture.workerURL,
          max: 1,
        }),
        web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
      try {
        const row = (
          await fixture.admin.query(
            "SELECT app_security_runtime_configuration() c, app_security_budget_basis($1::jsonb,$3::timestamptz) basis,app_security_budget_hash(app_security_budget_coverage($1::jsonb,$2)) coverage",
            [
              f.state.budget,
              new Date().toISOString().slice(0, 7),
              new Date().toISOString(),
            ],
          )
        ).rows[0];
        expect(row.c.securityVersion).toBe(21);
        const timezone = await fixture.admin.connect();
        try {
          await timezone.query("BEGIN");
          for (const zone of ["UTC", "America/New_York"]) {
            await timezone.query("SELECT set_config('TimeZone',$1,true)", [
              zone,
            ]);
            const dates = (
              await timezone.query(
                "SELECT app_security_budget_review_dates('2026-11-06T00:00:00Z','2026-11-01T00:00:00Z','2026-11-08T00:00:00Z') valid,app_security_budget_review_dates('2026-11-06T00:00:00Z','2026-11-01T00:00:00Z','2026-11-08T00:30:00Z') invalid",
              )
            ).rows[0];
            expect(dates).toEqual({ valid: true, invalid: false });
          }
        } finally {
          await timezone.query("ROLLBACK");
          timezone.release();
        }

        expect(row.basis).toBe(budgetReviewBasisHash(f.state.budget));
        expect(row.coverage).toBe(budgetReviewCoverageHash(f.state.budget));
        const c = await worker.connect();
        try {
          await c.query("BEGIN");
          await c.query(
            "SELECT set_config('urban.purpose','worker.prep',true)",
          );
          // Capability name follows the runtime store setting, never a request body.
          expect((await c.query("SELECT id FROM app_budget")).rowCount).toBe(1);
          expect(
            (await c.query("UPDATE app_budget SET header=header")).rowCount,
          ).toBe(0);
          await c.query("ROLLBACK");
          await c.query("BEGIN");
          await c.query(
            "SELECT set_config('urban.purpose','worker.budget',true)",
          );
          await expect(
            c.query(
              "UPDATE app_budget SET header=jsonb_set(header,'{costReviews,0,estimatedUnreportedCents}','99')",
            ),
          ).rejects.toThrow(/review|administrator/i);
          await c.query("ROLLBACK");
          for (const mutate of [
            (b: any) => b.audit.splice(0, 1),
            (b: any) => {
              b.audit[0].details = { forged: true };
            },
            (b: any) => {
              b.reservations.splice(0, 1);
            },
            (b: any) => {
              b.reservations[0].maximumCents = 1;
            },
            (b: any) => {
              b.reservations[1].actualCents = 0;
            },
            (b: any) => {
              b.reservations.push({
                ...b.reservations[0],
                id: randomUUID(),
                idempotencyKey: randomUUID(),
                maximumCents: -5,
                status: "reserved",
                period,
                createdAt: at,
                expiresAt: new Date(Date.now() + 10000).toISOString(),
              });
            },
          ]) {
            await c.query("BEGIN");
            await c.query(
              "SELECT set_config('urban.purpose','worker.budget',true)",
            );
            const altered = structuredClone(f.state.budget);
            mutate(altered);
            await expect(
              c.query("UPDATE app_budget SET header=$1", [altered]),
            ).rejects.toThrow(/immutable|reservation|Reservation|review|cost/i);
            await c.query("ROLLBACK");
          }
        } finally {
          c.release();
        }
        const c2 = await web.connect();
        try {
          await c2.query("BEGIN");
          await c2.query("SELECT set_config('urban.session_hash',$1,true)", [
            tokenHash(
              f.headers["ordinary-owner"].cookie.slice("urban_session=".length),
            ),
          ]);
          expect((await c2.query("SELECT id FROM app_budget")).rowCount).toBe(
            0,
          );
          await c2.query("ROLLBACK");
        } finally {
          c2.release();
        }
      } finally {
        await worker.end();
        await web.end();
        await fixture.close();
      }
    }, 30000);
  },
);
