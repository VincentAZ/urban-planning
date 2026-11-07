import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  copyFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { FileStore, emptyState, authorize } from "./store";
import {
  createDevelopmentBackup,
  verifyDevelopmentBackup,
} from "./storage-backup";
import { stateFingerprint } from "./storage-core";

const future = () => new Date(Date.now() + 3600000).toISOString();
async function seed(store: FileStore) {
  await store.transaction((s) => {
    s.users.push({
      id: "u",
      email: "u@example.test",
      name: "U",
      createdAt: new Date().toISOString(),
    });
    s.organizations.push({
      id: "o",
      name: "O",
      createdAt: new Date().toISOString(),
    });
    s.memberships.push({ userId: "u", organizationId: "o", role: "owner" });
    s.sessions.push({
      hash: "session",
      csrfToken: "csrf",
      userId: "u",
      organizationId: "o",
      expiresAt: future(),
    });
  });
}
describe("identity development storage parity", () => {
  it("refuses direct verification, new grants and stale session admission without changing state", async () => {
    const store = new FileStore();
    try {
      await seed(store);
      const before = stateFingerprint(await store.read((s) => s));
      await expect(
        store.transaction(
          (s) => {
            s.users[0].emailVerifiedAt = new Date().toISOString();
          },
          { auth: { sessionHash: "session" } },
        ),
      ).rejects.toThrow(/verification/i);
      await expect(
        store.transaction(
          (s) => {
            s.memberships.push({
              userId: "other",
              organizationId: "o",
              role: "viewer",
            });
          },
          {
            auth: { sessionHash: "session" },
            memberships: { where: [{ organizationId: "o" }] },
          },
        ),
      ).rejects.toThrow(/invitation/);
      expect(stateFingerprint(await store.read((s) => s))).toBe(before);
      await store.transaction((s) => {
        s.users[0].credentialVersion = 1;
      });
      await expect(
        store.read((s) => authorize(s, "session"), {
          auth: { sessionHash: "session" },
        }),
      ).rejects.toThrow(/session is no longer valid/);
      await expect(
        store.transaction(
          (s) => {
            s.sessions.push({
              hash: "stale",
              csrfToken: "csrf",
              userId: "u",
              organizationId: "o",
              expiresAt: future(),
            });
          },
          {
            security: {
              mode: "auth",
              purpose: "login",
              email: "u@example.test",
              userId: "u",
              sessionHash: "stale",
              credentialVersion: 0,
            },
            sessions: { append: true },
          },
        ),
      ).rejects.toThrow(/generation/);
    } finally {
      await store.close();
    }
  });
  it("keeps sealed payload out of headers and rejects unleased full reads and immutable header changes", async () => {
    const store = new FileStore();
    try {
      await seed(store);
      await store.transaction((s) => {
        s.identityOutbox.push({
          id: "mail",
          kind: "password-reset",
          userId: "u",
          challengeId: "c",
          recipientKey: "opaque",
          sealed: {
            version: 1,
            keyId: "fixture",
            iv: "opaque",
            tag: "opaque",
            ciphertext: "sealed only",
          },
          createdAt: new Date().toISOString(),
          expiresAt: future(),
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
        });
      });
      const headers = await store.read((s) => s.identityOutboxHeaders, {
        security: { mode: "worker", purpose: "identity-mail" },
        identityOutboxHeaders: { all: true },
      });
      expect(headers[0]).not.toHaveProperty("sealed");
      await expect(
        store.read((s) => s.identityOutbox, {
          security: {
            mode: "worker",
            purpose: "identity-mail",
            outboxId: "mail",
            leaseToken: "invented",
          },
          identityOutbox: { where: [{ id: "mail" }] },
        }),
      ).rejects.toThrow(/lease/);
      await expect(
        store.transaction(
          (s) => {
            s.identityOutboxHeaders[0].recipientKey = "changed";
          },
          {
            security: { mode: "worker", purpose: "identity-mail" },
            identityOutboxHeaders: { all: true },
          },
        ),
      ).rejects.toThrow(/Immutable/);
    } finally {
      await store.close();
    }
  });
  it("backs up and restores all new records without changing legacy bytes or fabricating verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "identity-backup-")),
      path = join(dir, "original.json"),
      backup = join(dir, "backup");
    const legacy = emptyState();
    legacy.users.push({
      id: "legacy",
      email: "legacy@example.test",
      name: "Legacy",
      createdAt: new Date().toISOString(),
    });
    const {
      identityChallenges: _c,
      identityInvitations: _i,
      identityOutbox: _o,
      identityOutboxHeaders: _h,
      ...old
    } = legacy;
    const bytes = JSON.stringify(old);
    await writeFile(path, bytes);
    const store = new FileStore(path);
    let restored: FileStore | undefined;
    try {
      await store.transaction((s) => {
        s.identityChallenges.push({
          id: "challenge",
          userId: "legacy",
          email: "legacy@example.test",
          purpose: "password-reset",
          credentialVersion: 0,
          tokenHash: "a".repeat(64),
          createdAt: new Date().toISOString(),
          expiresAt: future(),
          revokedAt: new Date().toISOString(),
        });
        s.identityInvitations.push({
          id: "invite",
          organizationId: "organization",
          scope: "workspace",
          email: "legacy@example.test",
          role: "viewer",
          createdBy: "creator",
          createdAt: new Date().toISOString(),
          expiresAt: future(),
          version: 1,
          tokenHash: "b".repeat(64),
          idempotencyKey: "fixture",
          submissionHash: "c".repeat(64),
          status: "pending",
        });
        s.identityOutbox.push({
          id: "mail",
          kind: "password-reset",
          userId: "legacy",
          challengeId: "challenge",
          recipientKey: "opaque",
          sealed: {
            version: 1,
            keyId: "fixture",
            iv: "opaque",
            tag: "opaque",
            ciphertext: "sealed",
          },
          createdAt: new Date().toISOString(),
          expiresAt: future(),
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
        });
      });
      const fingerprint = stateFingerprint(await store.read((s) => s));
      const digest = () =>
        readFile(`${path}.sqlite`).then((b) =>
          createHash("sha256").update(b).digest("hex"),
        );
      const sourceBefore = await digest();
      await createDevelopmentBackup({
        sourceStatePath: path,
        destinationDirectory: backup,
      });
      await verifyDevelopmentBackup(backup);
      expect(await digest()).toBe(sourceBefore);
      expect(await readFile(path, "utf8")).toBe(bytes);
      await mkdir(join(dir, "restore"));
      for (const name of ["state.json", "state.json.sqlite"])
        await copyFile(join(backup, name), join(dir, "restore", name));
      restored = new FileStore(join(dir, "restore", "state.json"));
      expect(stateFingerprint(await restored.read((s) => s))).toBe(fingerprint);
      expect((await restored.read((s) => s.users))[0]).not.toHaveProperty(
        "emailVerifiedAt",
      );
      expect((await restored.read((s) => s.users))[0]).not.toHaveProperty(
        "credentialVersion",
      );
    } finally {
      await restored?.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("requires a workspace invitation before promoting a project-only membership", async () => {
    const store = new FileStore();
    try {
      await seed(store);
      await store.transaction((s) => {
        s.memberships.push({
          userId: "recipient",
          organizationId: "o",
          role: "viewer",
          scope: "project-only",
        });
      });
      await expect(
        store.transaction(
          (s) => {
            delete s.memberships.find((m) => m.userId === "recipient")!.scope;
          },
          {
            auth: { sessionHash: "session" },
            memberships: { where: [{ organizationId: "o" }] },
          },
        ),
      ).rejects.toThrow(/workspace expansion/i);
      expect(
        (
          await store.read((s) =>
            s.memberships.find((m) => m.userId === "recipient"),
          )
        )?.scope,
      ).toBe("project-only");
    } finally {
      await store.close();
    }
  });
});
