import { buildApp } from "../../../apps/api/src/app.js";
import { FileStore } from "../../../apps/api/src/store.js";
import {
  budgetReviewBasisHash,
  createBudgetCostReview,
} from "../../../packages/core/src/budget-outlook.js";

// This process only binds loopback and receives a throwaway test store path.
// No changes are made to environment-configured platform administrators or local user state.
const [filename, browserOrigin, configuredIds, fixture] = process.argv.slice(2);
if (!filename || !browserOrigin || !configuredIds || !process.send)
  throw new Error("Use the isolated budget E2E harness to start this server.");
const store = new FileStore(filename);
// Explicit historical fixture only. All UI reads and subsequent mutations use the real API.
// Released synthetic jobs incur no charge; the older running job must remain held.
if (fixture === "history-fixture")
  await store.transaction((state) => {
    if (state.budget.reservations.length) return;
    const now = new Date();
    const prior = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12),
    );
    state.budget.policy.fixedCostReserveCents = 5000;
    state.budget.policy.paidOperationsPaused = false;
    state.budget.reservations.push({
      id: "synthetic-older-running-hold",
      idempotencyKey: "synthetic-older-running-hold",
      provider: "Synthetic test provider",
      operation: "Older unresolved operation",
      actorId: "synthetic-operator",
      period: prior.toISOString().slice(0, 7),
      maximumCents: 1200,
      status: "running",
      createdAt: new Date(+prior - 60000).toISOString(),
      startedAt: new Date(+prior - 59000).toISOString(),
      expiresAt: prior.toISOString(),
    });
    state.budget.costReviews = [
      createBudgetCostReview(
        state.budget,
        {
          idempotencyKey: "synthetic-prior-month-review",
          expectedBasisHash: budgetReviewBasisHash(state.budget, prior),
          coveredThrough: prior.toISOString(),
          expiresAt: new Date(+prior + 86400000).toISOString(),
          estimatedUnreportedCents: 900,
          futureVariable: { lowCents: 0, expectedCents: 0, highCents: 0 },
          scopeStatement:
            "Synthetic historical fixture; no real provider bill or payment.",
          replacesReviewId: null,
          includesPriorUnreported: true,
        },
        {
          id: "synthetic-prior-month-review",
          actorId: "synthetic-operator",
          now: prior,
        },
      ),
    ];
    for (let index = 0; index < 104; index++) {
      const at = new Date(+now - (105 - index) * 1000).toISOString();
      state.budget.reservations.push({
        id: `synthetic-released-${index}`,
        idempotencyKey: `synthetic-released-${index}`,
        provider: "Synthetic test provider",
        operation: `Released fixture ${index}`,
        actorId: "synthetic-operator",
        period: now.toISOString().slice(0, 7),
        maximumCents: 10,
        status: "released",
        createdAt: at,
        expiresAt: at,
        releasedAt: at,
        releaseReason: "Synthetic undispatched reservation; no charge.",
      });
    }
  });
const app = await buildApp({
  store,
  platformAdminUserIds: JSON.parse(configuredIds) as string[],
  origin: browserOrigin,
  production: false,
});
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
process.send({ origin });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("disconnect", () => void close());
