import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import {
  identityApi,
  identityError,
  InvitationAttempts,
  passwordIssue,
} from "./identity-api";
const token = "d7e9ffdd-25cf-4d26-9456-738c85fa091a.opaque-link-secret";
const fetchMock = vi.fn<typeof fetch>();
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe("identity requests", () => {
  it("keeps all link secrets in explicit POST bodies, never paths or headers", async () => {
    fetchMock.mockResolvedValue(response({ ok: true }));
    await identityApi.verifyEmail(token);
    fetchMock.mockResolvedValue(response({ ok: true, requireLogin: true }));
    await identityApi.resetPassword(token, "a sufficiently long new password");
    fetchMock.mockResolvedValue(response({ invitation: {} }));
    await identityApi.previewInvitation(token);
    fetchMock.mockResolvedValue(response({ accepted: true }));
    await identityApi.acceptInvitation(token, 4, 9);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [path, options] of fetchMock.mock.calls) {
      expect(String(path)).not.toContain(token);
      expect(String(path)).not.toContain("?");
      expect(options?.method).toBe("POST");
      expect(options?.credentials).toBe("include");
      expect(JSON.parse(options?.body as string).token).toBe(token);
      expect(
        JSON.stringify(Array.from(new Headers(options?.headers).entries())),
      ).not.toContain(token);
    }
    expect(JSON.parse(fetchMock.mock.calls[3][1]!.body as string)).toEqual({
      token,
      expectedVersion: 4,
      expectedAclVersion: 9,
    });
  });
  it("requires a separate normal login after reset and does not initiate it", async () => {
    fetchMock.mockResolvedValue(response({ ok: true, requireLogin: true }));
    await expect(
      identityApi.resetPassword(token, "a sufficiently long password"),
    ).resolves.toEqual({ ok: true, requireLogin: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/v1/auth/password-reset/confirm",
    );
  });
  it.each(["reset", "change"] as const)(
    "clears the cached CSRF credential after %s signs out all sessions",
    async (kind) => {
      fetchMock.mockResolvedValue(
        response({ user: { id: "u" }, csrfToken: "old-session-csrf" }),
      );
      await api("/auth/session");
      fetchMock.mockResolvedValue(response({ ok: true, requireLogin: true }));
      if (kind === "reset")
        await identityApi.resetPassword(token, "a sufficiently long password");
      else
        await identityApi.changePassword(
          "old sufficiently long password",
          "new sufficiently long password",
        );
      expect(
        new Headers(fetchMock.mock.calls[1][1]?.headers).get("X-CSRF-Token"),
      ).toBe("old-session-csrf");
      fetchMock.mockResolvedValue(response({ user: null }));
      await api("/auth/session");
      expect(
        new Headers(fetchMock.mock.calls[2][1]?.headers).has("X-CSRF-Token"),
      ).toBe(false);
    },
  );
  it("rejects an aborted deferred session body without overwriting a newer CSRF credential", async () => {
    let finishOldBody!: (value: unknown) => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const delayed = new Promise<unknown>((resolve) => {
      finishOldBody = resolve;
    });
    const oldResponse = response({});
    vi.spyOn(oldResponse, "json").mockImplementation(() => {
      bodyStarted();
      return delayed;
    });
    fetchMock.mockResolvedValueOnce(oldResponse);
    const controller = new AbortController();
    const oldOutcome = api("/auth/session", { signal: controller.signal }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await started;
    fetchMock.mockResolvedValueOnce(
      response({ user: { id: "new-account" }, csrfToken: "new-session-csrf" }),
    );
    await api("/auth/session");
    controller.abort();
    finishOldBody({
      user: { id: "old-account" },
      csrfToken: "old-session-csrf",
    });
    const outcome = await oldOutcome;
    fetchMock.mockResolvedValueOnce(response({ user: null }));
    await api("/auth/session");
    expect.soft(outcome.error).toMatchObject({ name: "AbortError" });
    expect.soft(outcome.value).toBeUndefined();
    expect(
      new Headers(fetchMock.mock.calls[2][1]?.headers).get("X-CSRF-Token"),
    ).toBe("new-session-csrf");
  });
  it("retains account-scoped reads as private no-store requests and forwards cancellation", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(
      response({ userId: "u", emailVerified: false }),
    );
    await identityApi.security(controller.signal);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      signal: controller.signal,
      credentials: "include",
    });
    fetchMock.mockResolvedValue(response({ invitations: [] }));
    await identityApi.invitations("project/one", controller.signal);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/v1/projects/project%2Fone/invitations",
    );
    expect(fetchMock.mock.calls[1][1]?.cache).toBe("no-store");
  });
  it("sends version-guarded explicit resend and revoke without silently retrying", async () => {
    fetchMock.mockResolvedValue(response({ invitations: [] }));
    await identityApi.resend("p", "invite/id", 5);
    await identityApi.revoke("p", "invite/id", 6);
    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        url,
        JSON.parse(init!.body as string),
      ]),
    ).toEqual([
      [
        "/api/v1/projects/p/invitations/invite%2Fid/resend",
        { expectedVersion: 5 },
      ],
      [
        "/api/v1/projects/p/invitations/invite%2Fid/revoke",
        { expectedVersion: 6 },
      ],
    ]);
    fetchMock.mockRejectedValue(new TypeError("connection lost"));
    await expect(identityApi.resend("p", "i", 6)).rejects.toThrow(
      "connection lost",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("preserves generic reset confirmation and explicit unavailable delivery errors", async () => {
    fetchMock.mockResolvedValue(
      response({ accepted: true, message: "Generic confirmation" }, 202),
    );
    await expect(
      identityApi.requestReset("unknown@example.org"),
    ).resolves.toMatchObject({ accepted: true });
    fetchMock.mockResolvedValue(
      response(
        {
          error: {
            code: "IDENTITY_DELIVERY_UNAVAILABLE",
            message: "Internal delivery configuration",
          },
        },
        503,
      ),
    );
    let failure: unknown;
    try {
      await identityApi.requestReset("another@example.org");
    } catch (error) {
      failure = error;
    }
    expect(identityError(failure)).toContain("Email delivery is unavailable");
    expect(identityError(failure)).not.toContain(
      "Internal delivery configuration",
    );
  });
});
describe("invitation retry identity", () => {
  it("retains the original body and ACL version after an uncertain response", () => {
    const attempts = new InvitationAttempts();
    const first = attempts.for("p", " recipient@example.org ", "editor", 4);
    expect(attempts.for("p", "recipient@example.org", "editor", 5)).toBe(first);
    expect(first.expectedAclVersion).toBe(4);
    attempts.clear();
    const next = attempts.for("p", "recipient@example.org", "editor", 5);
    expect(next.expectedAclVersion).toBe(5);
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  });
  it("does not share an attempt across project, recipient or role changes", () => {
    const attempts = new InvitationAttempts();
    const values = [
      attempts.for("p", "a@example.org", "viewer", 1),
      attempts.for("q", "a@example.org", "viewer", 1),
      attempts.for("q", "b@example.org", "viewer", 1),
      attempts.for("q", "b@example.org", "owner", 1),
    ];
    expect(new Set(values.map((value) => value.idempotencyKey)).size).toBe(4);
  });
});
describe("identity form and error boundaries", () => {
  it("does not trim passwords and requires exact confirmation within backend bounds", () => {
    expect(passwordIssue("short", "short")).toContain("12");
    expect(passwordIssue(" twelve letters ", "twelve letters")).toContain(
      "match",
    );
    expect(passwordIssue("x".repeat(256), "x".repeat(256))).toBeNull();
    expect(passwordIssue("x".repeat(257), "x".repeat(257))).toContain("256");
  });
  it("never renders raw token or credential failures, and explains wrong-account recovery safely", () => {
    for (const failure of [
      new Error(token),
      new ApiError(token, 500),
      new ApiError(token, 422),
      new ApiError(token, 404, "INVITATION_UNAVAILABLE"),
      new ApiError(token, 400, "IDENTITY_LINK_INVALID"),
    ]) {
      expect(identityError(failure)).not.toContain(token);
    }
    expect(
      identityError(new ApiError(token, 400, "IDENTITY_LINK_INVALID")),
    ).toContain("expired");
    expect(identityError(new ApiError(token, 403, "WRONG_ACCOUNT"))).toContain(
      "different email address",
    );
    expect(
      identityError(new ApiError(token, 403, "EMAIL_VERIFICATION_REQUIRED")),
    ).toContain("Verify the email");
  });
});
