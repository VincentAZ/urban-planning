import { useId } from "react";
import type { IdentityDeliveryCapability } from "../../../../../apps/api/src/identity-types";
export function PasswordFields({
  password,
  confirmation,
  onPassword,
  onConfirmation,
  disabled,
}: {
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
  disabled: boolean;
}) {
  const hint = useId();
  return (
    <>
      <label className="field">
        <span>New password</span>
        <input
          aria-label="New password"
          aria-describedby={hint}
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          required
          value={password}
          disabled={disabled}
          onChange={(event) => onPassword(event.target.value)}
        />
        <small id={hint}>12–256 characters. Use a unique password.</small>
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          required
          value={confirmation}
          disabled={disabled}
          onChange={(event) => onConfirmation(event.target.value)}
        />
      </label>
    </>
  );
}
export function DeliveryNotice({
  delivery,
}: {
  delivery: IdentityDeliveryCapability;
}) {
  return (
    <p className="identity-notice">
      {!delivery.available
        ? "Email delivery is unavailable on this server. New links cannot be delivered right now. Existing private work and existing project access remain available."
        : delivery.mode === "local-test"
          ? "Local test delivery only. Links are retained by the test delivery service; no external email is sent."
          : "Email delivery is configured. A queued request is not a confirmation that a message has arrived."}
    </p>
  );
}
