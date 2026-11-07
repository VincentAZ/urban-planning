/** Identity lifecycle contract; link tokens are accepted only in POST bodies. */
const json = (schema: unknown) => ({
  content: { "application/json": { schema } },
});
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string" };
const token = {
  type: "string",
  pattern: "^[0-9a-fA-F-]{36}\\.[A-Za-z0-9_-]{43}$",
  description:
    "One-use proof from the consumed URL fragment; never place it in a query string.",
};
const email = { type: "string", format: "email", maxLength: 254 };
const password = {
  type: "string",
  minLength: 12,
  maxLength: 256,
  writeOnly: true,
};
const version = { type: "integer", minimum: 1 };
const csrf = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  schema: text,
};
const session = [{ session: [] }];
const errors = {
  400: { description: "Invalid, expired, already used or mismatched proof" },
  401: { description: "Current account required" },
  403: { description: "Verification, role, CSRF or origin rejected" },
  404: { description: "Invitation unavailable to this verified account" },
  409: { description: "Credential, invitation or ACL version conflict" },
  429: { description: "Bounded fair-use or queue admission limit" },
  503: {
    description:
      "Delivery is disabled, unavailable or lacks configured capacity/budget",
  },
};
const success = {
  description: "Successful response",
  ...json({ type: "object" }),
};
function post(
  summary: string,
  properties: Record<string, unknown>,
  authenticated = true,
  status = 200,
  description?: string,
  required?: string[],
) {
  return {
    summary,
    ...(description ? { description } : {}),
    ...(authenticated ? { security: session, parameters: [csrf] } : {}),
    requestBody: { required: true, ...json(object(properties, required)) },
    responses: { [status]: success, ...errors },
  };
}
const invitationPaths = Object.fromEntries(
  ["/projects/{id}/invitations", "/organization/invitations"].flatMap(
    (prefix) => {
      const project = prefix.startsWith("/projects"),
        parameters = project
          ? [{ name: "id", in: "path", required: true, schema: text }]
          : [];
      const create = post(
        "Queue an invitation without granting access",
        {
          email,
          role: {
            type: "string",
            enum: project
              ? ["owner", "editor", "commenter", "viewer"]
              : ["editor", "commenter", "viewer"],
          },
          idempotencyKey: { type: "string", minLength: 8, maxLength: 160 },
          ...(project
            ? { expectedAclVersion: { type: "integer", minimum: 0 } }
            : {}),
        },
        true,
        201,
        "Requires a verified current owner. The same key and exact submission replays without another message. The verified recipient must explicitly accept; the sender's authority is checked again then.",
      );
      return [
        [
          prefix,
          {
            get: {
              summary:
                "List pending and retained invitations for the current owner",
              security: session,
              parameters,
              responses: { 200: success, ...errors },
            },
            post: { ...create, parameters: [...parameters, csrf] },
          },
        ],
        ...["resend", "revoke"].map((action) => [
          `${prefix}/{invitationId}/${action}`,
          {
            post: {
              ...post(
                action === "resend"
                  ? "Rotate and queue an invitation link"
                  : "Revoke an invitation",
                { expectedVersion: version },
                true,
                200,
                "Requires current verified owner authority. Resending invalidates the previous token. Revocation grants no access and consumes no new delivery.",
              ),
              parameters: [
                ...parameters,
                {
                  name: "invitationId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
                csrf,
              ],
            },
          },
        ]),
      ];
    },
  ),
);
export const identityOpenApiPaths = {
  "/auth/security": {
    get: {
      summary: "Read current email-verification state and delivery capability",
      security: session,
      responses: { 200: success, ...errors },
    },
  },
  "/auth/email-verification/request": {
    post: post(
      "Queue verification for the current account",
      {},
      true,
      202,
      "Private account work remains available before verification. Existing accounts are never automatically marked verified.",
    ),
  },
  "/auth/email-verification/confirm": {
    post: post("Consume verification for the same authenticated account", {
      token,
    }),
  },
  "/auth/password-reset/request": {
    post: post(
      "Request account recovery",
      { email },
      false,
      202,
      "Returns the same accepted response for known and unknown addresses and per-recipient admission refusal. Globally disabled delivery returns 503. The response does not assert delivery.",
    ),
  },
  "/auth/password-reset/confirm": {
    post: post(
      "Consume recovery and replace the password",
      { token, password },
      false,
      200,
      "Atomically advances credential generation, verifies the proven mailbox and invalidates every prior session and challenge. Does not sign in automatically. A security notification is best-effort and cannot block recovery.",
    ),
  },
  "/auth/password/change": {
    post: post(
      "Replace the current password using current-password proof",
      {
        currentPassword: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          writeOnly: true,
        },
        password,
      },
      true,
      200,
      "Requires current session, CSRF and password. Invalidates all sessions and challenges; does not verify an unverified email address.",
    ),
  },
  "/invitations/preview": {
    post: post(
      "Preview a link for its verified authenticated recipient",
      { token },
      true,
      200,
      "Does not reveal target titles or grant access to a different account. Current inviter authority and target availability are checked.",
    ),
  },
  "/invitations/accept": {
    post: post(
      "Explicitly accept an invitation and its exact access scope",
      {
        token,
        expectedVersion: version,
        expectedAclVersion: { type: "integer", minimum: 0 },
      },
      true,
      200,
      "Project acceptance requires expectedAclVersion. A project invitation creates project-only workspace membership when needed and does not grant sibling-project or workspace administration access. An already accepted link cannot resurrect removed access.",
      ["token", "expectedVersion"],
    ),
  },
  ...invitationPaths,
};
