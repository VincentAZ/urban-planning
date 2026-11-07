import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  IdentityService,
  identityEmailSchema,
  identityPasswordSchema,
  identityTokenSchema,
  type IdentityContext,
} from "./identity-service.js";
import { IdentityInvitations } from "./identity-invitations.js";

export function registerIdentityRoutes(
  app: FastifyInstance,
  context: IdentityContext,
) {
  const service = new IdentityService(context),
    invitations = new IdentityInvitations(context);
  const tokenBody = z.object({ token: identityTokenSchema }).strict();
  const rate = { config: { rateLimit: { max: 15, timeWindow: "15 minutes" } } };
  app.get("/api/v1/auth/security", (request) => service.security(request));
  app.post(
    "/api/v1/auth/email-verification/request",
    rate,
    async (request, reply) => {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      return reply
        .code(202)
        .send(await service.requestChallenge(request, "verify-email"));
    },
  );
  app.post("/api/v1/auth/email-verification/confirm", rate, (request) =>
    service.verify(request, tokenBody.parse(request.body).token),
  );
  app.post(
    "/api/v1/auth/password-reset/request",
    rate,
    async (request, reply) => {
      const input = z
          .object({ email: identityEmailSchema })
          .strict()
          .parse(request.body),
        began = performance.now();
      const result = await service.requestChallenge(
        request,
        "password-reset",
        input.email,
      );
      // A shared minimum asynchronous response window removes the fast unknown-address exit.
      // Distributed throttling/production timing still require deployment validation.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 250 - (performance.now() - began))),
      );
      return reply.code(202).send(result);
    },
  );
  app.post(
    "/api/v1/auth/password-reset/confirm",
    rate,
    async (request, reply) => {
      const input = z
        .object({
          token: identityTokenSchema,
          password: identityPasswordSchema,
        })
        .strict()
        .parse(request.body);
      const result = await service.reset(input.token, input.password);
      reply.clearCookie("urban_session", { path: "/" });
      return result;
    },
  );
  app.post("/api/v1/auth/password/change", rate, async (request, reply) => {
    const input = z
      .object({
        currentPassword: z.string().min(1).max(256),
        password: identityPasswordSchema,
      })
      .strict()
      .parse(request.body);
    const result = await service.changePassword(
      request,
      input.currentPassword,
      input.password,
    );
    reply.clearCookie("urban_session", { path: "/" });
    return result;
  });
  const create = z
    .object({
      email: identityEmailSchema,
      role: z.enum(["owner", "editor", "commenter", "viewer"]),
      idempotencyKey: z.string().min(8).max(160),
      expectedAclVersion: z.number().int().nonnegative().optional(),
    })
    .strict();
  for (const kind of ["project", "workspace"] as const) {
    const prefix =
      kind === "project"
        ? "/api/v1/projects/:id/invitations"
        : "/api/v1/organization/invitations";
    const target = (params: unknown) =>
      kind === "project"
        ? {
            scope: kind,
            projectId: z
              .object({ id: z.string().min(1).max(240) })
              .passthrough()
              .parse(params).id,
          }
        : { scope: kind };
    app.get(prefix, (request) =>
      invitations.list(request, target(request.params)),
    );
    app.post(prefix, rate, async (request, reply) =>
      reply
        .code(201)
        .send(
          await invitations.create(
            request,
            target(request.params),
            create.parse(request.body),
          ),
        ),
    );
    for (const action of ["resend", "revoke"] as const)
      app.post(`${prefix}/:invitationId/${action}`, rate, (request) => {
        const input = z
          .object({ expectedVersion: z.number().int().positive() })
          .strict()
          .parse(request.body);
        const id = z
          .object({ invitationId: z.uuid() })
          .passthrough()
          .parse(request.params).invitationId;
        return invitations.update(
          request,
          target(request.params),
          id,
          input.expectedVersion,
          action,
        );
      });
  }
  app.post("/api/v1/invitations/preview", rate, (request) =>
    invitations.preview(request, tokenBody.parse(request.body).token),
  );
  app.post("/api/v1/invitations/accept", rate, (request) =>
    invitations.accept(
      request,
      z
        .object({
          token: identityTokenSchema,
          expectedVersion: z.number().int().positive(),
          expectedAclVersion: z.number().int().nonnegative().optional(),
        })
        .strict()
        .parse(request.body),
    ),
  );
}
