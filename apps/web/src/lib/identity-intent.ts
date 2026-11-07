import type { IdentityIntent } from "./identity-api";
export type IdentityLanding =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "intent"; intent: IdentityIntent };
const link =
  /^#identity=(verify-email|password-reset|invitation)&token=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43})$/;
/** No URL decoding or alternate parameter ordering is accepted for bearer links. */
export function parseIdentityFragment(fragment: string): IdentityLanding {
  if (!fragment) return { kind: "none" };
  const params = new URLSearchParams(fragment.slice(1));
  if (!params.has("identity") && !params.has("token")) return { kind: "none" };
  if (fragment.length > 512) return { kind: "invalid" };
  const match = fragment.match(link);
  return match
    ? {
        kind: "intent",
        intent: { kind: match[1] as IdentityIntent["kind"], token: match[2] },
      }
    : { kind: "invalid" };
}
export function consumeIdentityLanding(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "state" | "replaceState">,
): IdentityLanding {
  const parsed = parseIdentityFragment(location.hash);
  // Query-string credentials are never accepted; remove them if an invalid link used them.
  const query = new URLSearchParams(location.search);
  const queryIdentity = query.has("identity") || query.has("token");
  if (queryIdentity) {
    query.delete("identity");
    query.delete("token");
  }
  if (parsed.kind === "none" && !queryIdentity) return parsed;
  const search = queryIdentity
    ? query.size
      ? `?${query.toString()}`
      : ""
    : location.search;
  try {
    history.replaceState(history.state, "", `${location.pathname}${search}`);
  } catch {
    return { kind: "invalid" };
  }
  return queryIdentity ? { kind: "invalid" } : parsed;
}
/** Handle account links opened into an already mounted tab. No token request is made. */
export function watchIdentityLinks(
  target: Pick<
    Window,
    "location" | "history" | "addEventListener" | "removeEventListener"
  >,
  onLanding: (landing: Exclude<IdentityLanding, { kind: "none" }>) => void,
) {
  const receive = () => {
    const landing = consumeIdentityLanding(target.location, target.history);
    if (landing.kind !== "none") onLanding(landing);
  };
  target.addEventListener("hashchange", receive);
  return () => target.removeEventListener("hashchange", receive);
}
/** Capture once before rendering, but return the same value to StrictMode's duplicate initializer.
 * Forget the bootstrap copy after mount; the active React intent remains memory-only. */
export function createIdentityBootstrap(consume: () => IdentityLanding) {
  let captured = consume();
  return {
    read: () => captured,
    forget: () => {
      captured = { kind: "none" };
    },
  };
}
export const identityBootstrap = createIdentityBootstrap(() =>
  typeof window === "undefined"
    ? { kind: "none" }
    : consumeIdentityLanding(window.location, window.history),
);
