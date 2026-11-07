import { ApiError } from "./errors.js";
const credentialKey =
  /^(?:password|passwd|secret|clientsecret|privatekey|authorization|proxyauthorization|cookie|setcookie|apikey|accesstoken|refreshtoken|idtoken|sessiontoken|securitytoken|token|signature|credential|credentials|xamzcredential|xamzsignature|xamzsecuritytoken|xgoogcredential|xgoogsignature|sig)$/;
const keyName = (key: string) => key.toLowerCase().replace(/[-_\s]/g, "");
const privatePath =
  /^(?:file:|[a-z]:[\\/]|\\\\|~[\\/]|\.?\.?[\\/]\.local(?:[\\/]|$)|\/(?:home|Users|root|tmp|var|private|proc|run|etc)(?:\/|$))/i;

/** Reject structured secrets/locators, never redact provenance or alter its hashes.
 * Runs inside the bounded preparation worker before model calculation. It does
 * not scan narrative prose or claim to classify arbitrary text as a secret. */
export function assertSourceMetadataPrivacy(
  input: unknown,
  label: "media" | "fiscal" = "media",
): void {
  const pending: { value: unknown; key: string; recipe: boolean }[] = [
    { value: input, key: "", recipe: false },
  ];
  const reject = () => {
    throw new ApiError(
      422,
      `${label.toUpperCase()}_METADATA_PRIVATE`,
      `Retained ${label} source metadata contains a credential-bearing URL, credential field or private filesystem locator. Supply a shareable source record before export; its original evidence is not rewritten.`,
    );
  };
  while (pending.length) {
    const { value, key, recipe } = pending.pop()!;
    const normalizedKey = keyName(key);
    if (
      recipe &&
      credentialKey.test(normalizedKey) &&
      value !== null &&
      value !== "" &&
      value !== undefined
    )
      reject();
    if (typeof value === "string") {
      const locator = /(?:url|uri|href|path|directory|workdir)$/.test(
        normalizedKey,
      );
      if ((locator || recipe) && privatePath.test(value.trim())) reject();
      if (
        recipe &&
        /(?:path|directory|workdir)$/.test(normalizedKey) &&
        /^(?:\/|\.\.?[\\/])/.test(value.trim())
      )
        reject();
      if (
        ((locator || recipe) && /^https?:/i.test(value.trim())) ||
        /(?:url|uri|href)$/.test(normalizedKey)
      ) {
        let url: URL;
        try {
          url = new URL(
            value.trim(),
            value.trim().startsWith("//") ? "https://media.invalid" : undefined,
          );
        } catch {
          if (/^https?:/i.test(value.trim())) reject();
          continue;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        if (
          url!.username ||
          url!.password ||
          [...url!.searchParams.keys()].some(
            (k) => credentialKey.test(keyName(k)) || keyName(k) === "key",
          )
        )
          reject();
        const fragment = new URLSearchParams(url!.hash.slice(1));
        if (
          [...fragment.keys()].some(
            (k) => credentialKey.test(keyName(k)) || keyName(k) === "key",
          )
        )
          reject();
      }
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, key, recipe });
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value))
        pending.push({
          value: child,
          key: childKey,
          recipe: recipe || childKey === "recipe",
        });
    }
  }
}
