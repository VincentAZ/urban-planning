import { observeBudgetAlerts } from "./budget-alerts.js";
import { budgetRecordPage, budgetRecordQuery } from "./budget-records.js";
import { requestScope } from "./store-scope.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DataState, Store, authorize } from "./store.js";
import { ApiError } from "./errors.js";
import {
  adjustmentSchema,
  costReviewSchema,
  recordBudgetCostReview,
  budgetDashboard,
  expireReservations,
  policyUpdateSchema,
  recordBudgetAdjustment,
  updateBudgetPolicy,
} from "./budget.js";

export function platformAdminIds(
  configured = process.env.PLATFORM_ADMIN_USER_IDS ?? "",
): ReadonlySet<string> {
  return new Set(
    configured
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
export function registerBudgetRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    auth: (
      state: DataState,
      request: FastifyRequest,
    ) => ReturnType<typeof authorize>;
    adminIds: ReadonlySet<string>;
    now?: () => Date;
  },
) {
  const { store, auth, adminIds } = options;
  const clock = options.now ?? (() => new Date());
  const requireAdmin = (state: DataState, request: FastifyRequest) => {
    const identity = auth(state, request);
    if (!adminIds.has(identity.user.id))
      throw new ApiError(
        403,
        "PLATFORM_ADMIN_REQUIRED",
        "Only the platform administrator can view or change the operating budget.",
      );
    return identity;
  };
  const adminTransaction = async <T>(
    request: FastifyRequest,
    operation: (state: DataState) => T,
  ) => {
    // RLS deliberately hides the budget singleton from non-admins. Reject them
    // before hydration, then reauthorize inside the protected transaction.
    await store.read((state) => {
      requireAdmin(state, request);
    }, requestScope(request));
    return store.transaction(
      operation,
      requestScope(request, { budget: true }),
    );
  };
  app.get("/api/v1/admin/budget", async (request) =>
    adminTransaction(request, (state) => {
      const identity = requireAdmin(state, request);
      const now = clock();
      expireReservations(state.budget, now);
      observeBudgetAlerts(state.budget, identity.user.id, now);
      return budgetDashboard(state.budget, now);
    }),
  );
  app.patch("/api/v1/admin/budget", async (request) =>
    adminTransaction(request, (state) => {
      const identity = requireAdmin(state, request);
      const now = clock();
      expireReservations(state.budget, now);
      updateBudgetPolicy(
        state.budget,
        policyUpdateSchema.parse(request.body),
        identity.user.id,
        now,
      );
      observeBudgetAlerts(state.budget, identity.user.id, now);
      return budgetDashboard(state.budget, now);
    }),
  );
  app.post("/api/v1/admin/budget/adjustments", async (request) =>
    adminTransaction(request, (state) => {
      const identity = requireAdmin(state, request);
      const now = clock();
      expireReservations(state.budget, now);
      recordBudgetAdjustment(
        state.budget,
        adjustmentSchema.parse(request.body),
        identity.user.id,
        now,
      );
      observeBudgetAlerts(state.budget, identity.user.id, now);
      return budgetDashboard(state.budget, now);
    }),
  );
  app.get("/api/v1/admin/budget/records", async (request) =>
    adminTransaction(request, (state) => {
      requireAdmin(state, request);
      return budgetRecordPage(
        state.budget,
        budgetRecordQuery.parse(request.query),
      );
    }),
  );
  app.post("/api/v1/admin/budget/reviews", async (request) =>
    adminTransaction(request, (state) => {
      const identity = requireAdmin(state, request);
      const now = clock();
      expireReservations(state.budget, now);
      recordBudgetCostReview(
        state.budget,
        costReviewSchema.parse(request.body),
        identity.user.id,
        now,
      );
      observeBudgetAlerts(state.budget, identity.user.id, now);
      return budgetDashboard(state.budget, now);
    }),
  );
}
