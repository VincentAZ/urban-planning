import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";
import { ApiError } from "./errors.js";
import {
  assertBudgetCostEvidence,
  budgetDashboard,
  budgetPeriod,
} from "./budget.js";
import { projectAccess } from "./project-access.js";
import { unavailableMail } from "./identity-service.js";
import type { DataState, Store } from "./store.js";
import type { StoreScope } from "./store-scope.js";
import type {
  IdentityMailInput,
  IdentityMailRuntime,
  IdentityOutboxRecord,
} from "./identity-types.js";

export const IDENTITY_MAIL_COST = {
  provider: "configured-smtp",
  operation: "identity-email",
  actorId: "identity-mail-worker",
} as const;
type Header = Omit<IdentityOutboxRecord, "sealed">;
export interface IdentityMailContent {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
export interface IdentityMailTransport {
  send(
    content: IdentityMailContent,
    id: string,
    signal: AbortSignal,
  ): Promise<void>;
  close?(): void;
}
export interface IdentityMailConfig {
  mode: "smtp" | "local-test";
  keyId: string;
  keys: Record<string, Buffer>;
  recipientHashKey: Buffer;
  maximumAttemptCents: number;
  queueLimit?: number;
  dailyLimit?: number;
  recipientDailyLimit?: number;
  recipientCooldownSeconds?: number;
  pollMilliseconds?: number;
}
export interface ManagedIdentityMail extends IdentityMailRuntime {
  runOnce(): Promise<boolean>;
  start(): void;
  close(): Promise<void>;
}
const mailContent = z
  .object({
    to: z.string().trim().toLowerCase().email().max(254),
    subject: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !/[\r\n\0]/.test(s)),
    text: z.string().min(1).max(65_536),
    html: z.string().max(65_536).optional(),
  })
  .strict();
const uuid = z.string().uuid();
const live = (r: Header) => r.status === "pending" || r.status === "sending";
const at = (s: string) => Date.parse(s);
function mailError(code: string, message: string, status = 503): never {
  throw new ApiError(status, code, message);
}
function envelope(record: Header, keyId: string) {
  return Buffer.from(
    JSON.stringify([
      1,
      keyId,
      record.id,
      record.kind,
      record.userId ?? null,
      record.organizationId ?? null,
      record.challengeId ?? null,
      record.invitationId ?? null,
      record.invitationVersion ?? null,
      record.recipientKey,
      record.createdAt,
      record.expiresAt,
    ]),
  );
}
function contentBytes(input: IdentityMailContent) {
  const parsed = mailContent.parse(input),
    bytes = Buffer.from(JSON.stringify(parsed));
  if (bytes.length > 131_072)
    throw new Error("Identity mail content exceeds the allowed size.");
  return { parsed, bytes };
}
/** Ciphertext is authenticated against immutable routing metadata; queued secrets never enter API responses. */
export function sealIdentityMail(
  header: Header,
  content: IdentityMailContent,
  config: IdentityMailConfig,
) {
  const { bytes } = contentBytes(content),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.keys[config.keyId], iv);
  cipher.setAAD(envelope(header, config.keyId));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    version: 1 as const,
    keyId: config.keyId,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
export function openIdentityMail(
  record: IdentityOutboxRecord,
  config: IdentityMailConfig,
): IdentityMailContent {
  const sealed = record.sealed,
    key = config.keys[sealed.keyId];
  if (sealed.version !== 1 || !key || sealed.ciphertext.length > 180_000)
    throw new Error("Identity mail cannot be opened.");
  const iv = Buffer.from(sealed.iv, "base64"),
    tag = Buffer.from(sealed.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Identity mail cannot be opened.");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(envelope(record, sealed.keyId));
  decipher.setAuthTag(tag);
  return contentBytes(
    JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ),
  ).parsed;
}
function checkBudget(state: DataState, cents: number, now: Date, ownHold = 0) {
  if (state.budget.policy.paidOperationsPaused)
    mailError(
      "IDENTITY_DELIVERY_PAUSED",
      "Email delivery is paused by the administrator. No email was queued.",
    );
  assertBudgetCostEvidence(state.budget, now);
  const { totals } = budgetDashboard(state.budget, now);
  if (
    totals.accountedCents > totals.operatingLimitCents ||
    totals.availableCents + ownHold < cents
  )
    mailError(
      "IDENTITY_DELIVERY_BUDGET",
      "Email delivery has reached its operating budget. Please try again later.",
      429,
    );
}
function headers(state: DataState): Header[] {
  return state.identityOutboxHeaders;
}
function costAudit(
  state: DataState,
  action: string,
  reservationId: string,
  now: Date,
  details: Record<string, unknown> = {},
) {
  state.budget.audit.push({
    id: randomUUID(),
    actorId: IDENTITY_MAIL_COST.actorId,
    action,
    at: now.toISOString(),
    details: { reservationId, ...details },
  });
}
function releaseBeforeDispatch(state: DataState, record: Header, now: Date) {
  const reservation = state.budget.reservations.find(
    (r) => r.id === record.costReservationId,
  );
  if (reservation?.status === "reserved") {
    reservation.status = "released";
    reservation.releasedAt = now.toISOString();
    reservation.releaseReason = "Identity email cancelled before dispatch.";
    costAudit(state, "reservation.released", reservation.id, now);
  }
  // A running reservation is deliberately retained even after a crash or failed SMTP response.
}
function stillCurrent(
  state: DataState,
  record: IdentityOutboxRecord,
  content: IdentityMailContent,
  now: Date,
) {
  if (at(record.expiresAt) <= now.getTime()) return false;
  if (record.kind === "invitation") {
    const invite = state.identityInvitations.find(
      (i) => i.id === record.invitationId,
    );
    if (
      !invite ||
      invite.status !== "pending" ||
      invite.version !== record.invitationVersion ||
      invite.email !== content.to ||
      at(invite.expiresAt) <= now.getTime()
    )
      return false;
    const inviter = state.users.find((u) => u.id === invite.createdBy);
    const membership = state.memberships.find(
      (m) =>
        m.userId === invite.createdBy &&
        m.organizationId === invite.organizationId,
    );
    if (!inviter?.emailVerifiedAt || !membership) return false;
    if (invite.scope === "workspace")
      return membership.scope !== "project-only" && membership.role === "owner";
    const project = state.projectHeaders.find(
      (p) =>
        p.project.id === invite.projectId &&
        p.organizationId === invite.organizationId,
    );
    return (
      !!project &&
      !!projectAccess(project, invite.createdBy, membership)?.canManageMembers
    );
  }
  const user = state.users.find((u) => u.id === record.userId);
  if (!user || user.email !== content.to) return false;
  if (record.kind === "password-changed") return true;
  const challenge = state.identityChallenges.find(
    (c) => c.id === record.challengeId,
  );
  return (
    !!challenge &&
    !challenge.consumedAt &&
    !challenge.revokedAt &&
    challenge.purpose === record.kind &&
    challenge.userId === user.id &&
    challenge.email === content.to &&
    challenge.credentialVersion === (user.credentialVersion ?? 0) &&
    at(challenge.expiresAt) > now.getTime() &&
    (record.kind !== "verify-email" || !user.emailVerifiedAt)
  );
}
function claimScope(): StoreScope {
  return {
    security: { mode: "worker", purpose: "identity-mail" },
    identityOutboxHeaders: { all: true },
    budget: true,
  };
}
function leasedScope(record: Header, full = false): StoreScope {
  return {
    security: {
      mode: "worker",
      purpose: "identity-mail",
      outboxId: record.id,
      leaseToken: record.leaseToken,
    },
    identityOutboxHeaders: { where: [{ id: record.id }] },
    ...(full
      ? {
          identityOutbox: { where: [{ id: record.id }] },
          identityChallenges: { where: [{ id: record.challengeId ?? "" }] },
          identityInvitations: { where: [{ id: record.invitationId ?? "" }] },
          users: {
            where: [
              { id: record.userId ?? "" },
              { id: { from: "identityInvitations", field: "createdBy" } },
            ],
          } as const,
          memberships: {
            where: [
              { userId: { from: "identityInvitations", field: "createdBy" } },
            ],
          } as const,
          projectHeaders: {
            where: [
              { id: { from: "identityInvitations", field: "projectId" } },
            ],
          } as const,
        }
      : {}),
    budget: true,
  };
}
export function createIdentityMailRuntime(options: {
  store: Store;
  config: IdentityMailConfig;
  transport: IdentityMailTransport;
  clock?: () => Date;
}): ManagedIdentityMail {
  const { store, config, transport } = options,
    clock = options.clock ?? (() => new Date());
  if (
    !/^[a-zA-Z0-9_-]{1,40}$/.test(config.keyId) ||
    config.keys[config.keyId]?.length !== 32 ||
    Object.values(config.keys).some((k) => k.length !== 32) ||
    config.recipientHashKey.length !== 32 ||
    !Number.isSafeInteger(config.maximumAttemptCents) ||
    config.maximumAttemptCents < 1 ||
    config.maximumAttemptCents > 100_000
  )
    throw new Error("Identity mail configuration is invalid.");
  const limits = {
    queue: config.queueLimit ?? 500,
    day: config.dailyLimit ?? 500,
    recipientDay: config.recipientDailyLimit ?? 10,
    cooldown: config.recipientCooldownSeconds ?? 60,
  };
  if (
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 0) ||
    limits.queue < 1 ||
    limits.day < 1 ||
    limits.recipientDay < 1
  )
    throw new Error("Identity mail limits are invalid.");
  let timer: ReturnType<typeof setTimeout> | undefined,
    busy: Promise<boolean> | undefined,
    stopped = false,
    active: AbortController | undefined;
  const runtime: ManagedIdentityMail = {
    capability: () => ({
      available: !stopped,
      mode: config.mode,
      message:
        config.mode === "local-test"
          ? "Local test delivery is enabled; no external email is sent."
          : "Email delivery is configured. Delivery is queued and may take a few minutes.",
    }),
    async prepare(input) {
      uuid.parse(input.id);
      for (const id of [
        input.userId,
        input.organizationId,
        input.challengeId,
        input.invitationId,
      ])
        if (id !== undefined) uuid.parse(id);
      if (
        stopped ||
        !Number.isFinite(at(input.expiresAt)) ||
        at(input.expiresAt) <= clock().getTime()
      )
        mailError(
          "IDENTITY_DELIVERY_UNAVAILABLE",
          "Email delivery is unavailable.",
        );
      const { parsed } = contentBytes({
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      });
      const now = clock().toISOString();
      const {
        to: _to,
        subject: _subject,
        text: _text,
        html: _html,
        ...metadata
      } = input;
      const header: Header = {
        ...metadata,
        recipientKey: createHmac("sha256", config.recipientHashKey)
          .update(parsed.to)
          .digest("hex"),
        createdAt: now,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      };
      return { ...header, sealed: sealIdentityMail(header, parsed, config) };
    },
    assertAdmission(state, record) {
      if (stopped)
        mailError(
          "IDENTITY_DELIVERY_UNAVAILABLE",
          "Email delivery is unavailable.",
        );
      const now = clock(),
        all = headers(state),
        recent = all.filter(
          (r) => at(r.createdAt) > now.getTime() - 86_400_000,
        );
      if (
        all.filter(live).length >= limits.queue ||
        recent.length >= limits.day
      )
        mailError(
          "IDENTITY_DELIVERY_LIMIT",
          "Email delivery is busy. Please try again later.",
          429,
        );
      const recipient = recent.filter(
        (r) => r.recipientKey === record.recipientKey,
      );
      if (
        recipient.length >= limits.recipientDay ||
        (record.kind !== "password-changed" &&
          recipient.some(
            (r) => at(r.createdAt) > now.getTime() - limits.cooldown * 1000,
          ))
      )
        mailError(
          "IDENTITY_DELIVERY_LIMIT",
          "Please wait before requesting another email.",
          429,
        );
      if (config.mode === "smtp")
        checkBudget(state, config.maximumAttemptCents, now);
    },
    runOnce() {
      if (stopped) return Promise.resolve(false);
      if (busy) return busy;
      busy = run().finally(() => {
        busy = undefined;
      });
      return busy;
    },
    start() {
      if (timer || stopped) return;
      const tick = async () => {
        timer = undefined;
        // Errors are intentionally opaque: provider replies can contain recipient addresses and links.
        try {
          await runtime.runOnce();
        } catch {
          /* persistent queue is retried on the next tick */
        }
        if (!stopped) {
          timer = setTimeout(tick, config.pollMilliseconds ?? 5000);
          timer.unref();
        }
      };
      timer = setTimeout(tick, 0);
      timer.unref();
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      active?.abort();
      transport.close?.();
      await busy?.catch(() => {});
    },
  };
  async function run(): Promise<boolean> {
    const claimed = await store.transaction((state) => {
      const now = clock(),
        all = headers(state);
      if (
        all.some(
          (r) =>
            r.status === "sending" &&
            at(r.leaseExpiresAt ?? "") > now.getTime(),
        )
      )
        return undefined;
      // Bounded cleanup does not reopen terminal rows or release uncertain dispatched cost.
      for (const r of all
        .filter(
          (r) =>
            live(r) && (at(r.expiresAt) <= now.getTime() || r.attempts >= 3),
        )
        .slice(0, 20)) {
        r.status = "cancelled";
        r.lastFailure =
          at(r.expiresAt) <= now.getTime() ? "expired" : "cancelled";
        releaseBeforeDispatch(state, r, now);
      }
      const next = all
        .filter(
          (r) =>
            live(r) &&
            at(r.expiresAt) > now.getTime() &&
            at(r.nextAttemptAt) <= now.getTime() &&
            r.attempts < 3,
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )[0];
      if (!next) return undefined;
      if (config.mode === "smtp") {
        try {
          checkBudget(state, config.maximumAttemptCents, now);
        } catch {
          return undefined;
        }
        if (
          state.budget.reservations.filter(
            (r) =>
              r.provider === IDENTITY_MAIL_COST.provider &&
              r.operation === IDENTITY_MAIL_COST.operation &&
              at(r.createdAt) > now.getTime() - 86_400_000,
          ).length >= limits.day
        )
          return undefined;
      }
      releaseBeforeDispatch(state, next, now);
      next.status = "sending";
      next.attempts++;
      next.leaseToken = randomUUID();
      next.leaseExpiresAt = new Date(now.getTime() + 120_000).toISOString();
      if (config.mode === "smtp") {
        const reservation = {
          ...IDENTITY_MAIL_COST,
          id: randomUUID(),
          idempotencyKey: `identity-mail:${next.id}:${next.attempts}`,
          period: budgetPeriod(now),
          maximumCents: config.maximumAttemptCents,
          status: "reserved" as const,
          createdAt: now.toISOString(),
          expiresAt: next.leaseExpiresAt,
        };
        state.budget.reservations.push(reservation);
        next.costReservationId = reservation.id;
        costAudit(state, "reservation.created", reservation.id, now, {
          maximumCents: reservation.maximumCents,
          provider: reservation.provider,
          operation: reservation.operation,
        });
      }
      return structuredClone(next);
    }, claimScope());
    if (!claimed) return false;
    const prepared = await store.transaction(
      (state) => {
        const now = clock(),
          record = state.identityOutbox.find((r) => r.id === claimed.id);
        const header =
          state.identityOutboxHeaders.find((r) => r.id === claimed.id) ??
          record;
        if (
          !record ||
          !header ||
          record.leaseToken !== claimed.leaseToken ||
          at(record.leaseExpiresAt ?? "") <= now.getTime()
        )
          return undefined;
        let content: IdentityMailContent;
        try {
          content = openIdentityMail(record, config);
        } catch {
          header.status = "failed";
          header.lastFailure = "permanent";
          releaseBeforeDispatch(state, header, now);
          return undefined;
        }
        if (!stillCurrent(state, record, content, now)) {
          header.status = "cancelled";
          header.lastFailure = "cancelled";
          releaseBeforeDispatch(state, header, now);
          return undefined;
        }
        if (config.mode === "smtp") {
          const reservation = state.budget.reservations.find(
            (r) => r.id === record.costReservationId,
          );
          if (
            !reservation ||
            reservation.status !== "reserved" ||
            at(reservation.expiresAt) <= now.getTime()
          )
            return undefined;
          try {
            checkBudget(
              state,
              reservation.maximumCents,
              now,
              reservation.maximumCents,
            );
          } catch {
            header.status = "pending";
            header.nextAttemptAt = new Date(
              now.getTime() + 60_000,
            ).toISOString();
            releaseBeforeDispatch(state, header, now);
            return undefined;
          }
          reservation.status = "running";
          reservation.startedAt = now.toISOString();
          costAudit(state, "reservation.started", reservation.id, now);
        }
        return content;
      },
      leasedScope(claimed, true),
    );
    // Keep the entire dispatch deadline within the lease even after a delayed database response.
    // A running hold remains conservative when dispatch becomes uncertain at this boundary.
    if (
      !prepared ||
      stopped ||
      clock().getTime() + 30_000 >= at(claimed.leaseExpiresAt!)
    )
      return true;
    active = new AbortController();
    let failure: "temporary" | "permanent" | undefined;
    const deadline = setTimeout(() => active?.abort(), 30_000);
    try {
      await transport.send(prepared, claimed.id, active.signal);
    } catch (error) {
      failure =
        error instanceof PermanentIdentityMailError ? "permanent" : "temporary";
    } finally {
      clearTimeout(deadline);
      active = undefined;
    }
    await store.transaction((state) => {
      const now = clock(),
        record = headers(state).find((r) => r.id === claimed.id);
      if (
        !record ||
        record.status !== "sending" ||
        record.leaseToken !== claimed.leaseToken ||
        at(record.leaseExpiresAt ?? "") <= now.getTime()
      )
        return;
      if (!failure) {
        record.status = "sent";
        record.sentAt = now.toISOString();
        delete record.lastFailure;
      } else {
        record.lastFailure = failure;
        record.status =
          failure === "permanent" || record.attempts >= 3
            ? "failed"
            : "pending";
        record.nextAttemptAt = new Date(
          now.getTime() + 60_000 * record.attempts,
        ).toISOString();
      }
      // SMTP acceptance is not invoice settlement. Running cost holds survive every result.
    }, leasedScope(claimed));
    return true;
  }
  return runtime;
}

export class PermanentIdentityMailError extends Error {
  constructor() {
    super("Identity mail was rejected.");
  }
}
function secretKey(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error("Identity email keys must be 32 bytes encoded as base64.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new Error("Identity email key encoding is invalid.");
  return key;
}
/** Only server-owned environment configuration can enable external delivery. Never returns secrets to clients. */
export function identityMailFromEnvironment(
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
): IdentityMailRuntime & { start?(): void; close?(): Promise<void> } {
  if (env.IDENTITY_EMAIL_ENABLED !== "true") return unavailableMail;
  const origin = new URL(env.APP_ORIGIN ?? "");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Identity email requires a canonical HTTPS APP_ORIGIN.");
  const host = env.IDENTITY_SMTP_HOST ?? "",
    port = Number(env.IDENTITY_SMTP_PORT ?? "587"),
    from = z.string().email().parse(env.IDENTITY_EMAIL_FROM);
  if (
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    ![465, 587].includes(port) ||
    !env.IDENTITY_SMTP_USER ||
    !env.IDENTITY_SMTP_PASSWORD
  )
    throw new Error("Identity SMTP configuration is incomplete.");
  const keyId = env.IDENTITY_EMAIL_KEY_ID ?? "primary",
    keys: Record<string, Buffer> = {
      [keyId]: secretKey(env.IDENTITY_EMAIL_KEY),
    };
  if (env.IDENTITY_EMAIL_PREVIOUS_KEYS) {
    let previous: Record<string, string>;
    try {
      previous = z
        .record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), z.string())
        .parse(JSON.parse(env.IDENTITY_EMAIL_PREVIOUS_KEYS));
    } catch {
      throw new Error("Identity email previous-key configuration is invalid.");
    }
    for (const [id, value] of Object.entries(previous)) {
      if (id === keyId)
        throw new Error("Identity email key identifiers must be unique.");
      keys[id] = secretKey(value);
    }
  }
  const transport = createSmtpIdentityTransport({
    host,
    port,
    from,
    origin: origin.origin,
    user: env.IDENTITY_SMTP_USER,
    password: env.IDENTITY_SMTP_PASSWORD,
  });
  return createIdentityMailRuntime({
    store,
    transport,
    config: {
      mode: "smtp",
      keyId,
      keys,
      recipientHashKey: secretKey(env.IDENTITY_EMAIL_RECIPIENT_KEY),
      maximumAttemptCents: Number(env.IDENTITY_EMAIL_MAX_ATTEMPT_CENTS),
      queueLimit: Number(env.IDENTITY_EMAIL_QUEUE_LIMIT ?? 500),
      dailyLimit: Number(env.IDENTITY_EMAIL_DAILY_LIMIT ?? 500),
      recipientDailyLimit: Number(
        env.IDENTITY_EMAIL_RECIPIENT_DAILY_LIMIT ?? 10,
      ),
      recipientCooldownSeconds: Number(
        env.IDENTITY_EMAIL_RECIPIENT_COOLDOWN_SECONDS ?? 60,
      ),
    },
  });
}

/** The adapter owns the actual socket so the worker deadline can stop in-flight SMTP work. */
export function createSmtpIdentityTransport(options: {
  host: string;
  port: number;
  from: string;
  origin: string;
  user: string;
  password: string;
  ca?: string;
}): IdentityMailTransport {
  let connection: SMTPConnection | undefined;
  return {
    async send(input, id, signal) {
      if (signal.aborted) throw new Error("Identity delivery cancelled.");
      const content = contentBytes(input).parsed;
      const message = await new MailComposer({
        ...content,
        from: options.from,
        messageId: `<identity.${uuid.parse(id)}@${new URL(options.origin).hostname}>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      })
        .compile()
        .build();
      if (signal.aborted) throw new Error("Identity delivery cancelled.");
      const current = new SMTPConnection({
        host: options.host,
        port: options.port,
        secure: options.port === 465,
        requireTLS: true,
        tls: {
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          servername: options.host,
          ...(options.ca ? { ca: options.ca } : {}),
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        dnsTimeout: 10000,
        logger: false,
        debug: false,
      });
      connection = current;
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", abort);
          current.close();
          if (connection === current) connection = undefined;
          if (!error) resolve();
          else if (
            error instanceof PermanentIdentityMailError ||
            (typeof error === "object" &&
              error !== null &&
              "responseCode" in error &&
              typeof error.responseCode === "number" &&
              error.responseCode >= 500)
          )
            reject(new PermanentIdentityMailError());
          else reject(new Error("Identity email delivery was not confirmed."));
        };
        const abort = () => finish(new Error("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        current.once("error", finish);
        current.once("end", () =>
          finish(new Error("Connection ended before delivery confirmation.")),
        );
        current.connect((error) => {
          if (finished) return;
          if (error) {
            finish(error);
            return;
          }
          current.login(
            { user: options.user, pass: options.password },
            (error) => {
              if (finished) return;
              if (error) {
                finish(error);
                return;
              }
              current.send(
                { from: options.from, to: [content.to] },
                message,
                (error, result) => {
                  if (error) finish(error);
                  else if (
                    result.rejected?.length ||
                    result.accepted?.length !== 1
                  )
                    finish(new PermanentIdentityMailError());
                  else finish();
                },
              );
            },
          );
        });
      });
    },
    close: () => connection?.close(),
  };
}
