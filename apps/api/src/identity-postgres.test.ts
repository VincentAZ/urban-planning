import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { PostgresStore } from "./postgres-store.js";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
import { trafficPlaceFixture } from "../../../tests/fixtures/traffic.js";

const connection = process.env.TEST_DATABASE_URL;
const password = "isolated identity lifecycle password";
async function register(app: FastifyInstance, name: string) {
  const email = `${name}@example.test`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, name, password },
  });
  expect(response.statusCode, response.body).toBe(201);
  return {
    email,
    id: response.json().user.id as string,
    organizationId: response.json().organization.id as string,
    headers: {
      cookie: `urban_session=${response.cookies[0].value}`,
      "x-csrf-token": response.json().csrfToken as string,
    },
  };
}
describe.skipIf(!connection)(
  "identity HTTP lifecycle through restricted PostgreSQL roles",
  () => {
    it("verifies both parties, accepts an exact project grant, survives restart and consumes recovery with all-session revocation", async () => {
      const fixture = await createPostgresSecurityFixture(connection!);
      const mail = new FixtureIdentityMail();
      const runtime = () =>
        new PostgresStore(fixture.webURL, {
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
          poolMax: 1,
        });
      let app: FastifyInstance | undefined;
      const start = async () => {
        const store = runtime();
        await store.initialize();
        const instance = await buildApp({
          store,
          identityMail: mail,
          catalog: {
            list: async () => [trafficPlaceFixture],
            get: async () => structuredClone(trafficPlaceFixture),
          },
        });
        attachIdentityTestMail(instance, mail);
        return instance;
      };
      try {
        app = await start();
        const owner = await register(app, "identity-owner"),
          recipient = await register(app, "identity-recipient"),
          outsider = await register(app, "identity-outsider");
        const create = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: trafficPlaceFixture.id },
        });
        expect(create.statusCode, create.body).toBe(201);
        const projectId = create.json().project.id;
        await acceptIdentityTestInvitation(
          app,
          owner,
          recipient,
          "editor",
          projectId,
        );
        const evidence = await fixture.operatorStore.read((s) => ({
          invitations: s.identityInvitations,
          users: s.users,
          mail: s.identityOutbox,
        }));
        expect(evidence.invitations).toHaveLength(1);
        expect(evidence.invitations[0].status).toBe("accepted");
        expect(
          evidence.users.find((u) => u.id === recipient.id)?.emailVerifiedAt,
        ).toBeTruthy();
        expect(
          evidence.mail.every((m) => m.sealed.ciphertext && m.recipientKey),
        ).toBe(true);
        await app.close();
        app = await start();
        const switched = await app.inject({
          method: "POST",
          url: "/api/v1/auth/organization",
          headers: recipient.headers,
          payload: { organizationId: owner.organizationId },
        });
        expect(switched.statusCode, switched.body).toBe(200);
        expect(
          (
            await app.inject({
              url: `/api/v1/projects/${projectId}`,
              headers: recipient.headers,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              url: `/api/v1/projects/${projectId}`,
              headers: outsider.headers,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              url: "/api/v1/organization/members",
              headers: recipient.headers,
            })
          ).statusCode,
        ).toBe(403);
        const reset = await app.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset/request",
          payload: { email: recipient.email },
        });
        expect(reset.statusCode, reset.body).toBe(202);
        const token = mail.token("password-reset", recipient.email),
          replacement = "recovered restricted role password";
        const confirmation = await app.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset/confirm",
          payload: { token, password: replacement },
        });
        expect(confirmation.statusCode, confirmation.body).toBe(200);
        expect(
          (
            await app.inject({
              url: "/api/v1/auth/session",
              headers: recipient.headers,
            })
          ).json().user,
        ).toBeNull();
        const oldLogin = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: recipient.email, password },
        });
        expect(oldLogin.statusCode).toBe(401);
        const newLogin = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: recipient.email, password: replacement },
        });
        expect(newLogin.statusCode, newLogin.body).toBe(200);
        const replay = await app.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset/confirm",
          payload: { token, password },
        });
        expect(replay.statusCode).toBe(400);
        const state = await fixture.operatorStore.read((s) => ({
          user: s.users.find((u) => u.id === recipient.id),
          sessions: s.sessions.filter((row) => row.userId === recipient.id),
          invitation: s.identityInvitations[0],
        }));
        expect(state.user?.credentialVersion).toBe(1);
        expect(state.sessions).toHaveLength(1);
        expect(state.sessions[0].credentialVersion).toBe(1);
        expect(state.invitation.status).toBe("accepted");
      } finally {
        await app?.close();
        await fixture.close();
      }
    }, 30000);
  },
);
