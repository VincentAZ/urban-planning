import { describe, expect, it, vi } from "vitest";
import {
  consumeIdentityLanding,
  createIdentityBootstrap,
  parseIdentityFragment,
  watchIdentityLinks,
} from "./identity-intent";
const token = `d7e9ffdd-25cf-4d26-9456-738c85fa091a.${"A".repeat(43)}`;
describe("identity fragment bootstrap", () => {
  it.each(["verify-email", "password-reset", "invitation"] as const)(
    "accepts only the exact %s fragment and strips it before returning",
    (kind) => {
      const state = { navigation: 1 },
        replaceState = vi.fn();
      const landing = consumeIdentityLanding(
        {
          pathname: "/",
          search: "?view=map",
          hash: `#identity=${kind}&token=${token}`,
        },
        { state, replaceState },
      );
      expect(replaceState).toHaveBeenCalledExactlyOnceWith(
        state,
        "",
        "/?view=map",
      );
      expect(landing).toEqual({ kind: "intent", intent: { kind, token } });
      expect(JSON.stringify(replaceState.mock.calls)).not.toContain(token);
    },
  );
  it.each([
    `#token=${token}&identity=invitation`,
    `#identity=invitation&token=${token}&token=${token}`,
    `#identity=invitation&token=${token}&next=https://example.org`,
    `#identity=reset-password&token=${token}`,
    `#identity=invitation&token=${token.replace(".", "%2E")}`,
    `#identity=invitation&token=${token.slice(0, -1)}`,
    `#%69dentity=invitation&token=${token}`,
    "#identity=invitation",
    `#token=${token}`,
  ])(
    "rejects malformed/ambiguous link case %# without returning any secret",
    (hash) => {
      const replaceState = vi.fn();
      const result = consumeIdentityLanding(
        { pathname: "/", search: "", hash },
        { state: null, replaceState },
      );
      expect(result).toEqual({ kind: "invalid" });
      expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/");
    },
  );
  it("never accepts query tokens and removes those keys without discarding unrelated query state", () => {
    const replaceState = vi.fn();
    expect(
      consumeIdentityLanding(
        {
          pathname: "/",
          hash: "",
          search: `?view=map&token=${token}&identity=invitation`,
        },
        { state: null, replaceState },
      ),
    ).toEqual({ kind: "invalid" });
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      "",
      "/?view=map",
    );
  });
  it("leaves unrelated navigation anchors unchanged", () => {
    const replaceState = vi.fn();
    expect(parseIdentityFragment("#main-workspace")).toEqual({ kind: "none" });
    expect(
      consumeIdentityLanding(
        { pathname: "/", hash: "#main-workspace", search: "" },
        { state: null, replaceState },
      ),
    ).toEqual({ kind: "none" });
    expect(replaceState).not.toHaveBeenCalled();
  });
  it("does not expose a valid token if history replacement is unavailable", () => {
    expect(
      consumeIdentityLanding(
        {
          pathname: "/",
          search: "",
          hash: `#identity=invitation&token=${token}`,
        },
        {
          state: null,
          replaceState: () => {
            throw new Error("unavailable");
          },
        },
      ),
    ).toEqual({ kind: "invalid" });
  });
  it("consumes same-document account links immediately, supports repeated links, and cleans up its listener", () => {
    const events = new EventTarget();
    const location = { pathname: "/", search: "", hash: "" };
    const replaceState = vi.fn(() => {
      location.hash = "";
    });
    const received = vi.fn((landing: unknown) => {
      expect(location.hash).toBe("");
      return landing;
    });
    const stop = watchIdentityLinks(
      {
        location: location as Location,
        history: { state: null, replaceState } as unknown as History,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
      received,
    );
    for (const kind of ["invitation", "invitation", "verify-email"] as const) {
      location.hash = `#identity=${kind}&token=${token}`;
      events.dispatchEvent(new Event("hashchange"));
      expect(received).toHaveBeenLastCalledWith({
        kind: "intent",
        intent: { kind, token },
      });
    }
    expect(received).toHaveBeenCalledTimes(3);
    location.hash = "#unrelated";
    events.dispatchEvent(new Event("hashchange"));
    expect(received).toHaveBeenCalledTimes(3);
    stop();
    location.hash = `#identity=invitation&token=${token}`;
    events.dispatchEvent(new Event("hashchange"));
    expect(received).toHaveBeenCalledTimes(3);
    expect(replaceState).toHaveBeenCalledTimes(3);
  });
  it("captures once for StrictMode and forgets the bootstrap copy after mounting", () => {
    const consume = vi.fn(() => ({
      kind: "intent" as const,
      intent: { kind: "invitation" as const, token },
    }));
    const bootstrap = createIdentityBootstrap(consume);
    const first = bootstrap.read();
    expect(bootstrap.read()).toBe(first);
    expect(consume).toHaveBeenCalledTimes(1);
    bootstrap.forget();
    expect(bootstrap.read()).toEqual({ kind: "none" });
    expect(first).toEqual({
      kind: "intent",
      intent: { kind: "invitation", token },
    });
  });
});
