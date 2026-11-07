import { createHash, randomUUID } from "node:crypto";
import { canonicalJSON } from "@urban/core";
import { z } from "zod";
import type { BudgetState } from "../../../packages/core/src/budget.js";
import type { Store } from "./store.js";
import { ApiError } from "./errors.js";
import { budgetPeriod } from "./budget.js";

export const identityMailInvoiceSchema = z
  .object({
    reference: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine((s) => !/[\r\n\0]/.test(s)),
    totalCents: z.number().int().min(0).max(1_000_000_000_000),
    entries: z
      .array(
        z
          .object({
            reservationId: z.string().min(1).max(240),
            actualCents: z.number().int().min(0).max(100_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((invoice, ctx) => {
    if (
      new Set(invoice.entries.map((e) => e.reservationId)).size !==
      invoice.entries.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each reservation must appear once.",
      });
    if (
      invoice.entries.reduce((sum, e) => sum + e.actualCents, 0) !==
      invoice.totalCents
    )
      ctx.addIssue({
        code: "custom",
        message: "Invoice total must equal exact allocated cents.",
      });
  });
export type IdentityMailInvoice = z.infer<typeof identityMailInvoiceSchema>;
const isMail = (r: { provider: string; operation: string }) =>
  r.provider === "configured-smtp" && r.operation === "identity-email";
export function identityMailRunningHolds(budget: BudgetState) {
  return budget.reservations
    .filter((r) => isMail(r) && r.status === "running")
    .map((r) => ({
      reservationId: r.id,
      maximumCents: r.maximumCents,
      attemptKey: r.idempotencyKey,
    }));
}
/** Exactly one accounting entry per reservation; the invoice total is audit metadata, never a second spend adjustment. */
export function reconcileIdentityMailInvoice(
  budget: BudgetState,
  input: unknown,
  now = new Date(),
) {
  const parsed = identityMailInvoiceSchema.parse(input),
    invoice = {
      ...parsed,
      entries: [...parsed.entries].sort((a, b) =>
        a.reservationId.localeCompare(b.reservationId),
      ),
    };
  const invoiceHash = createHash("sha256")
    .update(canonicalJSON(invoice))
    .digest("hex");
  const prior = budget.audit.find(
    (a) =>
      a.action === "identity-mail.invoice.reconciled" &&
      a.details.reference === invoice.reference,
  );
  if (prior) {
    if (prior.details.invoiceHash !== invoiceHash)
      throw new ApiError(
        409,
        "IDENTITY_INVOICE_CONFLICT",
        "This invoice reference was already reconciled with different allocations.",
      );
    return {
      invoiceHash,
      totalCents: invoice.totalCents,
      reservationCount: invoice.entries.length,
      replayed: true,
      paidOperationsPaused: budget.policy.paidOperationsPaused,
    };
  }
  const reservations = invoice.entries.map((e) => {
    const r = budget.reservations.find((r) => r.id === e.reservationId);
    if (!r || !isMail(r) || r.status !== "running")
      throw new ApiError(
        409,
        "IDENTITY_INVOICE_RESERVATION",
        "Every invoice entry must reference an unreconciled running identity email hold.",
      );
    return { r, e };
  });
  const at = now.toISOString(),
    period = budgetPeriod(now),
    overrun = reservations.some(({ r, e }) => e.actualCents > r.maximumCents);
  for (const { r, e } of reservations) {
    r.status = "settled";
    r.actualCents = e.actualCents;
    r.settledAt = at;
    r.settledPeriod = period;
    budget.audit.push({
      id: randomUUID(),
      at,
      actorId: "identity-mail-reconciliation",
      action: "reservation.settled",
      details: {
        reservationId: r.id,
        actualCents: e.actualCents,
        maximumCents: r.maximumCents,
        period,
        overrun: e.actualCents > r.maximumCents,
        invoiceHash,
      },
    });
  }
  if (overrun && !budget.policy.paidOperationsPaused)
    budget.policy = {
      ...budget.policy,
      paidOperationsPaused: true,
      version: budget.policy.version + 1,
      updatedAt: at,
      updatedBy: "system",
    };
  budget.audit.push({
    id: randomUUID(),
    at,
    actorId: "identity-mail-reconciliation",
    action: "identity-mail.invoice.reconciled",
    details: {
      reference: invoice.reference,
      invoiceHash,
      totalCents: invoice.totalCents,
      reservationCount: invoice.entries.length,
      reservationIds: invoice.entries.map((e) => e.reservationId),
      period,
      overrun,
    },
  });
  return {
    invoiceHash,
    totalCents: invoice.totalCents,
    reservationCount: invoice.entries.length,
    replayed: false,
    paidOperationsPaused: budget.policy.paidOperationsPaused,
  };
}
export function reconcileStoredIdentityMailInvoice(
  store: Store,
  input: unknown,
) {
  const invoice = identityMailInvoiceSchema.parse(input);
  return store.transaction(
    (state) => reconcileIdentityMailInvoice(state.budget, invoice),
    { security: { mode: "worker", purpose: "budget" }, budget: true },
  );
}
