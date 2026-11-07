import { canonicalJSON } from "@urban/core";
import type { EntityName, StoreScope } from "./store-scope.js";
import type { StoreChanges } from "./storage-core.js";
import { budgetDashboard } from "./budget.js";

/** Development-store parity for identity mutations; production also enforces these transitions in SQL. */
export function assertIdentityStorageChanges(
  changes: StoreChanges,
  scope: StoreScope | undefined,
  read: (collection: EntityName) => any[],
) {
  if (!scope) return; // Explicit operator/migration/fixture operations remain trusted.
  const cache = new Map<EntityName, any[]>();
  const before = (name: EntityName) => {
    if (!cache.has(name)) cache.set(name, read(name));
    return cache.get(name)!;
  };
  const identity = (name: EntityName, r: any) =>
    name === "budget" ||
    name === "preparationControl" ||
    name === "nativeCapacity"
      ? name
      : (r.id ??
        r.hash ??
        r.project?.id ??
        JSON.stringify([r.userId, r.organizationId]));
  const after = (name: EntityName) => {
    const rows = new Map(before(name).map((r) => [identity(name, r), r]));
    for (const d of changes.deletes)
      if (d.collection === name) rows.delete(d.id);
    for (const r of changes.upserts)
      if (r.collection === name)
        rows.set(r.id, {
          ...(r.payload === undefined && name === "identityOutbox"
            ? { sealed: rows.get(r.id)?.sealed }
            : {}),
          ...r.header,
          ...(r.payload && typeof r.payload === "object" ? r.payload : {}),
        });
    return [...rows.values()];
  };
  const same = (a: unknown, b: unknown) =>
    canonicalJSON(a ?? null) === canonicalJSON(b ?? null);
  const without = (value: any, keys: string[]) =>
    Object.fromEntries(
      Object.entries(value ?? {}).filter(([k]) => !keys.includes(k)),
    );
  const fail = (message: string): never => {
    throw new Error(`Identity storage: ${message}`);
  };
  const now = Date.now(),
    security = scope.security,
    purpose = security ? `${security.mode}.${security.purpose}` : "web";
  const session = before("sessions").find(
    (s) => s.hash === scope.auth?.sessionHash && Date.parse(s.expiresAt) > now,
  );
  const user =
    session &&
    before("users").find(
      (u) =>
        u.id === session.userId &&
        (u.credentialVersion ?? 0) === (session.credentialVersion ?? 0),
    );
  const auth = security?.mode === "auth" ? security : undefined;
  const target =
    auth && "userId" in auth
      ? before("users").find(
          (u) => u.id === auth.userId && u.email === auth.email,
        )
      : undefined;
  const challenge =
    auth && "challengeId" in auth
      ? before("identityChallenges").find((c) => c.id === auth.challengeId)
      : undefined;
  const validChallenge =
    challenge &&
    auth &&
    "tokenHash" in auth &&
    challenge.tokenHash === auth.tokenHash &&
    !challenge.consumedAt &&
    !challenge.revokedAt &&
    Date.parse(challenge.expiresAt) > now &&
    target &&
    challenge.userId === target.id &&
    challenge.email === target.email &&
    challenge.credentialVersion === (target.credentialVersion ?? 0);
  const passwordChange =
    purpose === "auth.password-change" &&
    user?.id === target?.id &&
    auth &&
    "expectedPasswordHash" in auth &&
    target?.passwordHash === auth.expectedPasswordHash;
  const credentialChange = Boolean(
    (passwordChange ||
      (purpose === "auth.challenge-consume" &&
        validChallenge &&
        challenge.purpose === "password-reset")) &&
      target &&
      auth &&
      "credentialVersion" in auth &&
      auth.credentialVersion === (target.credentialVersion ?? 0),
  );
  const owner = (id: string | undefined, org: string, projectId?: string) => {
    const m = before("memberships").find(
      (m) => m.userId === id && m.organizationId === org,
    );
    if (!m) return false;
    const p = projectId
      ? before("projects").find(
          (p) => p.project.id === projectId && p.organizationId === org,
        )
      : undefined;
    if (projectId && !p) return false;
    return (
      (m.scope !== "project-only" && m.role === "owner") ||
      Boolean(
        p?.acl?.members.some((g: any) => g.userId === id && g.role === "owner"),
      )
    );
  };
  const invitation =
    auth && "invitationId" in auth
      ? before("identityInvitations").find((i) => i.id === auth.invitationId)
      : undefined;
  const accepted =
    invitation &&
    after("identityInvitations").find((i) => i.id === invitation.id);
  const validInvite = Boolean(
    purpose === "auth.invitation-accept" &&
      user?.emailVerifiedAt &&
      user.id === target?.id &&
      invitation?.email === user.email &&
      auth &&
      "tokenHash" in auth &&
      invitation.tokenHash === auth.tokenHash &&
      "invitationVersion" in auth &&
      invitation.version === auth.invitationVersion &&
      invitation.status === "pending" &&
      Date.parse(invitation.expiresAt) > now &&
      owner(
        invitation.createdBy,
        invitation.organizationId,
        invitation.projectId,
      ) &&
      before("users").find((u) => u.id === invitation.createdBy)
        ?.emailVerifiedAt &&
      accepted?.status === "accepted" &&
      accepted.acceptedBy === user.id,
  );
  for (const d of changes.deletes) {
    if (d.collection.startsWith("identity"))
      fail("identity history cannot be deleted");
    if (d.collection === "memberships") {
      const m = before("memberships").find(
        (m) => JSON.stringify([m.userId, m.organizationId]) === d.id,
      );
      if (
        m?.role === "owner" &&
        m.scope !== "project-only" &&
        !after("memberships").some(
          (n) =>
            n.organizationId === m.organizationId &&
            n.role === "owner" &&
            n.scope !== "project-only",
        )
      )
        fail("last workspace owner cannot be removed");
    }
  }
  for (const row of changes.upserts) {
    const old = before(row.collection).find(
        (r) => identity(row.collection, r) === row.id,
      ),
      next = after(row.collection).find(
        (r) => identity(row.collection, r) === row.id,
      );
    if (old && row.ordinal === 0)
      fail("a new record conflicts with an unselected existing record");
    if (row.collection === "users") {
      if (!old) {
        if (
          next.emailVerifiedAt !== undefined ||
          (next.credentialVersion ?? 0) !== 0
        )
          fail("new account cannot be preverified");
        continue;
      }
      if (same(old, next)) continue;
      if (
        !same(
          without(old, [
            "passwordHash",
            "credentialVersion",
            "emailVerifiedAt",
          ]),
          without(next, [
            "passwordHash",
            "credentialVersion",
            "emailVerifiedAt",
          ]),
        )
      )
        fail("account profile is immutable");
      if (next.passwordHash !== old.passwordHash) {
        if (
          !credentialChange ||
          next.id !== target?.id ||
          next.credentialVersion !== (old.credentialVersion ?? 0) + 1 ||
          !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(next.passwordHash ?? "")
        )
          fail(
            "password replacement requires current proof and next generation",
          );
        if (
          old.emailVerifiedAt !== undefined
            ? next.emailVerifiedAt !== old.emailVerifiedAt
            : next.emailVerifiedAt !== undefined &&
              challenge?.purpose !== "password-reset"
        )
          fail("password change cannot fabricate email verification");
        if (
          after("sessions").some((s) => s.userId === next.id) ||
          after("identityChallenges").some(
            (c) => c.userId === next.id && !c.consumedAt && !c.revokedAt,
          )
        )
          fail("credential change must revoke every session and challenge");
      } else if (
        !(
          purpose === "auth.challenge-consume" &&
          validChallenge &&
          challenge.purpose === "verify-email" &&
          user?.id === next.id &&
          after("identityChallenges").find((c) => c.id === challenge.id)
            ?.consumedAt === next.emailVerifiedAt &&
          same(next.credentialVersion, old.credentialVersion)
        )
      )
        fail("verification requires its consumed challenge");
    }
    if (row.collection === "sessions" && !old) {
      const u = after("users").find((u) => u.id === next.userId);
      if (
        !u ||
        (u.credentialVersion ?? 0) !== (next.credentialVersion ?? 0) ||
        (purpose === "auth.login" &&
          (!auth ||
            !("credentialVersion" in auth) ||
            (auth.credentialVersion ?? 0) !== (u.credentialVersion ?? 0)))
      ) {
        if (
          !(
            purpose === "auth.login" &&
            (u?.credentialVersion ?? 0) === 0 &&
            (next.credentialVersion ?? 0) === 0
          )
        )
          fail("stale session credential generation");
      }
    }
    if (row.collection === "identityChallenges") {
      if (!old) {
        if (
          purpose !== "auth.challenge-issue" ||
          !target ||
          next.userId !== target.id ||
          next.email !== target.email ||
          next.credentialVersion !== (target.credentialVersion ?? 0) ||
          !auth ||
          !("challengeId" in auth) ||
          next.id !== auth.challengeId ||
          next.consumedAt ||
          next.revokedAt ||
          (next.purpose === "verify-email" &&
            (user?.id !== target.id || target.emailVerifiedAt))
        )
          fail("challenge issuance is not authorized");
      } else {
        if (
          !same(
            without(old, ["consumedAt", "revokedAt"]),
            without(next, ["consumedAt", "revokedAt"]),
          ) ||
          old.consumedAt ||
          old.revokedAt
        )
          fail("challenge is immutable and single-use");
        if (next.consumedAt) {
          if (
            !validChallenge ||
            next.id !== challenge.id ||
            next.revokedAt ||
            (next.purpose === "verify-email" && user?.id !== next.userId)
          )
            fail("invalid challenge consumption");
          const u = after("users").find((u) => u.id === next.userId);
          if (
            !u?.emailVerifiedAt ||
            (next.purpose === "password-reset" &&
              u.credentialVersion !== next.credentialVersion + 1)
          )
            fail("consumed challenge requires account update");
        } else if (
          !next.revokedAt ||
          !(
            (purpose === "auth.challenge-issue" &&
              target?.id === next.userId) ||
            (credentialChange && target?.id === next.userId)
          )
        )
          fail("invalid challenge revocation");
      }
    }
    if (row.collection === "identityInvitations") {
      if (!old) {
        if (
          purpose !== "auth.invitation-manage" ||
          !user?.emailVerifiedAt ||
          next.createdBy !== user.id ||
          !owner(user.id, next.organizationId, next.projectId) ||
          next.status !== "pending" ||
          next.version !== 1
        )
          fail("invitation requires verified current owner");
      } else {
        if (
          !same(
            without(old, [
              "status",
              "version",
              "tokenHash",
              "expiresAt",
              "acceptedBy",
              "acceptedAt",
              "revokedBy",
              "revokedAt",
            ]),
            without(next, [
              "status",
              "version",
              "tokenHash",
              "expiresAt",
              "acceptedBy",
              "acceptedAt",
              "revokedBy",
              "revokedAt",
            ]),
          ) ||
          old.status !== "pending" ||
          next.version !== old.version + 1
        )
          fail("invitation is immutable or already terminal");
        if (next.status === "accepted") {
          if (
            !validInvite ||
            next.id !== invitation.id ||
            next.tokenHash !== old.tokenHash
          )
            fail("acceptance requires active proof and verified recipient");
          const m = after("memberships").find(
            (m) =>
              m.userId === user.id && m.organizationId === next.organizationId,
          );
          if (
            !m ||
            (next.scope === "workspace" &&
              (m.scope === "project-only" || m.role !== next.role)) ||
            (next.scope === "project" &&
              !after("projects")
                .find((p) => p.project.id === next.projectId)
                ?.acl?.members.some(
                  (g: any) => g.userId === user.id && g.role === next.role,
                ))
          )
            fail("acceptance requires exact scope grant");
        } else if (
          purpose !== "auth.invitation-manage" ||
          !user?.emailVerifiedAt ||
          !owner(user.id, next.organizationId, next.projectId) ||
          !["pending", "revoked"].includes(next.status)
        )
          fail("invitation manager authority lost");
      }
    }
    if (row.collection === "memberships") {
      if (
        old?.scope === "project-only" &&
        next.scope !== "project-only" &&
        !(
          validInvite &&
          invitation.scope === "workspace" &&
          invitation.organizationId === next.organizationId &&
          user?.id === next.userId
        )
      )
        fail("workspace expansion requires accepted workspace invitation");
      if (
        !old &&
        purpose !== "auth.register" &&
        !(
          validInvite &&
          next.userId === user?.id &&
          next.organizationId === invitation.organizationId
        )
      )
        fail("new membership requires accepted invitation");
      if (
        validInvite &&
        next.userId === user?.id &&
        invitation.scope === "project" &&
        (!old
          ? next.scope !== "project-only" || next.role !== "viewer"
          : !same(old, next))
      )
        fail("project invitation cannot expand workspace rights");
      if (
        old?.role === "owner" &&
        old.scope !== "project-only" &&
        !after("memberships").some(
          (m) =>
            m.organizationId === old.organizationId &&
            m.role === "owner" &&
            m.scope !== "project-only",
        )
      )
        fail("last workspace owner cannot be removed");
    }
    if (row.collection === "projects" && next.acl) {
      for (const g of next.acl.members) {
        const had = old?.acl?.members.some((m: any) => m.userId === g.userId);
        const legacy =
          old &&
          !old.acl &&
          before("memberships").some(
            (m) =>
              m.userId === g.userId &&
              m.organizationId === old.organizationId &&
              m.scope !== "project-only" &&
              m.role === g.role,
          );
        if (
          !had &&
          !legacy &&
          !(
            validInvite &&
            invitation.projectId === row.id &&
            g.userId === user?.id &&
            g.role === invitation.role
          ) &&
          !(!old && g.userId === user?.id && g.role === "owner")
        )
          fail("new project grant requires accepted invitation");
      }
    }
    if (row.collection === "identityOutbox") {
      if (!old) {
        if (
          !purpose.startsWith("auth.") ||
          ![
            "verify-email",
            "password-reset",
            "password-changed",
            "invitation",
          ].includes(next.kind) ||
          next.status !== "pending" ||
          next.attempts !== 0 ||
          !next.sealed ||
          JSON.stringify(next.sealed).length > 181000
        )
          fail("only sealed pending mail may be queued");
        if (next.kind === "password-changed" && !credentialChange)
          fail("notice requires credential change");
        if (next.challengeId) {
          const c = after("identityChallenges").find(
            (c) => c.id === next.challengeId,
          );
          if (
            !c ||
            c.userId !== target?.id ||
            c.purpose !== next.kind ||
            c.revokedAt ||
            c.consumedAt
          )
            fail("mail challenge is not current");
        }
        if (next.invitationId) {
          const i = after("identityInvitations").find(
            (i) => i.id === next.invitationId,
          );
          if (
            !i ||
            i.status !== "pending" ||
            i.version !== next.invitationVersion ||
            !user?.emailVerifiedAt ||
            !owner(user?.id, i.organizationId, i.projectId)
          )
            fail("mail invitation is not current");
        }
      } else {
        if (
          purpose !== "worker.identity-mail" ||
          !same(
            without(old, [
              "status",
              "attempts",
              "nextAttemptAt",
              "leaseToken",
              "leaseExpiresAt",
              "sentAt",
              "lastFailure",
              "costReservationId",
            ]),
            without(next, [
              "status",
              "attempts",
              "nextAttemptAt",
              "leaseToken",
              "leaseExpiresAt",
              "sentAt",
              "lastFailure",
              "costReservationId",
            ]),
          ) ||
          ["sent", "failed", "cancelled"].includes(old.status)
        )
          fail("sealed mail and terminal rows are immutable");
        if (next.status === "sending" && next.leaseToken !== old.leaseToken) {
          if (
            (old.status === "sending" &&
              Date.parse(old.leaseExpiresAt) > now) ||
            next.attempts !== old.attempts + 1 ||
            next.attempts > 3 ||
            !next.leaseToken ||
            Date.parse(next.leaseExpiresAt) <= now
          )
            fail("invalid mail claim");
        } else if (
          old.status === "sending" &&
          !(
            next.status === "cancelled" && Date.parse(old.leaseExpiresAt) <= now
          )
        ) {
          if (
            security?.mode !== "worker" ||
            security.outboxId !== row.id ||
            security.leaseToken !== old.leaseToken ||
            Date.parse(old.leaseExpiresAt) <= now ||
            next.attempts !== old.attempts
          )
            fail("mail acknowledgement requires its live lease");
        } else if (
          next.status !== "cancelled" ||
          next.attempts !== old.attempts
        )
          fail("unclaimed mail can only cancel");
      }
    }
    if (row.collection === "budget" && purpose === "worker.identity-mail") {
      if (
        !same(
          without(old, ["reservations", "audit"]),
          without(next, ["reservations", "audit"]),
        ) ||
        !old.reservations.every((r: any) =>
          next.reservations.some((n: any) => n.id === r.id),
        ) ||
        !same(next.audit.slice(0, old.audit.length), old.audit)
      )
        fail("mail cannot rewrite budget history/policy");
      let admitting = false;
      for (const r of next.reservations) {
        const prior = old.reservations.find((p: any) => p.id === r.id);
        if (same(r, prior)) continue;
        const m = (
          r.status === "released"
            ? before("identityOutbox")
            : after("identityOutbox")
        ).find((m) => m.costReservationId === r.id);
        if (
          r.provider !== "configured-smtp" ||
          r.operation !== "identity-email" ||
          r.actorId !== "identity-mail-worker" ||
          !m ||
          r.idempotencyKey !== `identity-mail:${m.id}:${m.attempts}`
        )
          fail("mail cost must bind its dispatch");
        if (
          prior &&
          (!same(
            without(prior, [
              "status",
              "startedAt",
              "releasedAt",
              "releaseReason",
            ]),
            without(r, ["status", "startedAt", "releasedAt", "releaseReason"]),
          ) ||
            prior.status !== "reserved" ||
            !["running", "released"].includes(r.status))
        )
          fail("mail cannot settle or rewrite costs");
        if (!prior && r.status !== "reserved")
          fail("new mail costs start reserved");
        admitting ||= r.status === "reserved" || r.status === "running";
      }
      if (
        admitting &&
        (next.policy.paidOperationsPaused ||
          budgetDashboard(next).totals.accountedCents >
            budgetDashboard(next).totals.operatingLimitCents)
      )
        fail("mail exceeds operating budget");
    }
  }
}
