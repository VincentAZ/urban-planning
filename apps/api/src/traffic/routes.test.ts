import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Project } from "@urban/core";
import { trafficPlaceFixture } from "../../../../tests/fixtures/traffic";
import { buildApp } from "../app";
import { FileStore } from "../store";
import { TrafficJobService } from "./jobs";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "../identity-test-fixture.js";

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of clean.splice(0).reverse()) await fn();
});
async function account(app: FastifyInstance, name: string) {
  const reply = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name,
      email: `${name}@traffic-routes.example.test`,
      password: "isolated route fixture long password",
    },
  });
  expect(reply.statusCode, reply.body).toBe(201);
  return {
    id: reply.json().user.id as string,
    email: reply.json().user.email as string,
    organizationId: reply.json().organization.id as string,
    headers: {
      cookie: `${reply.cookies[0].name}=${reply.cookies[0].value}`,
      "x-csrf-token": reply.json().csrfToken as string,
    },
  };
}
function multipart(key: string, csv: string, extra = "") {
  const boundary = "traffic-route-boundary";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="idempotencyKey"\r\n\r\n${key}\r\n${extra}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="counts.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "traffic-routes-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, "state.json"));
  const service = new TrafficJobService(store, {
    enabled: false,
    archiveDirectory: join(dir, "archive"),
    automaticWorker: false,
  });
  const mail = new FixtureIdentityMail();
  const app = await buildApp({
    store,
    identityMail: mail,
    trafficService: service,
    nationalPreparationEnabled: false,
    catalog: {
      list: async () => [trafficPlaceFixture],
      get: async () => structuredClone(trafficPlaceFixture),
    },
  });
  clean.push(() => app.close());
  attachIdentityTestMail(app, mail);
  const owner = await account(app, "owner");
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { placeId: trafficPlaceFixture.id },
  });
  expect(created.statusCode, created.body).toBe(201);
  const saved = created.json<{ project: Project; version: number }>();
  const projectBase = `/api/v1/projects/${saved.project.id}`,
    base = `${projectBase}/traffic`;
  const upload = (key: string, csv = "station,vehicles\n0007,0\n") => {
    const form = multipart(key, csv);
    return app.inject({
      method: "POST",
      url: `${base}/uploads`,
      headers: { ...owner.headers, "content-type": form.contentType },
      payload: form.body,
    });
  };
  return { dir, store, service, app, owner, saved, projectBase, base, upload };
}
describe("traffic HTTP project and original-file boundaries", () => {
  it("keeps an unavailable prepared source explicit and private, with no automatic worker request", async () => {
    const s = await setup();
    const scenarioId = s.saved.project.activeScenarioId;
    expect(
      (
        await s.app.inject({
          url: `${s.base}/context?scenarioId=${scenarioId}`,
        })
      ).statusCode,
    ).toBe(401);
    const reply = await s.app.inject({
      url: `${s.base}/context?scenarioId=${scenarioId}`,
      headers: s.owner.headers,
    });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.headers["cache-control"]).toBe("private, no-store");
    expect(reply.json()).toMatchObject({
      configuration: null,
      initialRequest: null,
      network: null,
      capabilities: { enabled: false, configured: false, prepared: null },
    });
    expect(reply.json().capabilities.reason).toContain("disabled");
    expect(
      (
        await s.app.inject({
          url: `${s.base}/configurations?scenarioId=missing`,
          headers: s.owner.headers,
        })
      ).statusCode,
    ).toBe(404);
    const foreign = await account(s.app, "foreign");
    expect(
      (
        await s.app.inject({
          url: `${s.base}/context?scenarioId=${scenarioId}`,
          headers: foreign.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(await s.store.read((state) => state.trafficJobs.length)).toBe(0);
  });
  it("retains exact CSV bytes once, preserves leading-zero IDs, and refuses a conflicting retry or foreign download", async () => {
    const s = await setup(),
      csv = "station,vehicles\r\n0007,0\r\n00aB,12\r\n";
    const first = await s.upload("same-original-upload", csv);
    expect(first.statusCode, first.body).toBe(201);
    const value = first.json().upload;
    expect(value).toMatchObject({
      filename: "counts.csv",
      rows: 2,
      bytes: Buffer.byteLength(csv),
      sha256: createHash("sha256").update(csv).digest("hex"),
    });
    expect(Object.keys(value).sort()).toEqual([
      "bytes",
      "filename",
      "id",
      "rows",
      "sha256",
      "sourceId",
    ]);
    const retry = await s.upload("same-original-upload", csv);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json().upload).toEqual(value);
    const conflict = await s.upload(
      "same-original-upload",
      csv.replace("12", "13"),
    );
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(await s.store.read((state) => state.trafficUploads.length)).toBe(1);
    const downloaded = await s.app.inject({
      url: `${s.base}/uploads/${value.id}/file`,
      headers: s.owner.headers,
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.body).toBe(csv);
    expect(downloaded.headers["x-content-sha256"]).toBe(value.sha256);
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
    const foreign = await account(s.app, "foreign");
    const denied = await s.app.inject({
      url: `${s.base}/uploads/${value.id}/file`,
      headers: foreign.headers,
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain("0007");
  });
  it("rejects malformed, oversized and unauthenticated uploads before retaining an archive", async () => {
    const s = await setup();
    const form = multipart("unauthenticated-key", "a,b\n1,2\n");
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: `${s.base}/uploads`,
          headers: { "content-type": form.contentType },
          payload: form.body,
        })
      ).statusCode,
    ).toBe(401);
    const extra = multipart(
      "extra-field-request",
      "a,b\n1,2\n",
      '--traffic-route-boundary\r\nContent-Disposition: form-data; name="unreviewed"\r\n\r\nno\r\n',
    );
    const malformed = await s.app.inject({
      method: "POST",
      url: `${s.base}/uploads`,
      headers: { ...s.owner.headers, "content-type": extra.contentType },
      payload: extra.body,
    });
    expect(malformed.statusCode, malformed.body).toBeGreaterThanOrEqual(400);
    const oversized = await s.upload(
      "oversized-file-request",
      "x".repeat(5 * 1024 ** 2 + 1),
    );
    expect(oversized.statusCode, oversized.body).toBe(413);
    expect(await s.store.read((state) => state.trafficUploads.length)).toBe(0);
    expect(await readdir(join(s.dir, "archive")).catch(() => [])).toEqual([]);
  });
  it("allows a project viewer to read retained sources, denies their writes, and rechecks a revoked grant after archive I/O", async () => {
    const s = await setup(),
      viewer = await account(s.app, "viewer");
    await acceptIdentityTestInvitation(
      s.app,
      s.owner,
      viewer,
      "viewer",
      s.saved.project.id,
    );
    const switched = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/organization",
      headers: viewer.headers,
      payload: { organizationId: s.owner.organizationId },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const uploaded = await s.upload("retained-viewer-source");
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const file = `${s.base}/uploads/${uploaded.json().upload.id}/file`;
    expect(
      (await s.app.inject({ url: file, headers: viewer.headers })).statusCode,
    ).toBe(200);
    const form = multipart("viewer-write-attempt", "a,b\n1,2\n");
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: `${s.base}/uploads`,
          headers: { ...viewer.headers, "content-type": form.contentType },
          payload: form.body,
        })
      ).statusCode,
    ).toBe(403);
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const read = s.service.archive.read.bind(s.service.archive);
    vi.spyOn(s.service.archive, "read").mockImplementationOnce(
      async (...args) => {
        enter();
        await gate;
        return read(...args);
      },
    );
    const inFlight = s.app.inject({ url: file, headers: viewer.headers });
    // Fastify's injection promise is lazy until observed.
    const eventual = Promise.resolve(inFlight);
    await entered;
    const revoked = await s.app.inject({
      method: "DELETE",
      url: `${s.projectBase}/members/${viewer.id}`,
      headers: s.owner.headers,
      payload: { expectedAclVersion: 2 },
    });
    resume();
    expect(revoked.statusCode, revoked.body).toBe(200);
    const denied = await eventual;
    expect(denied.statusCode, denied.body).toBe(404);
    expect(denied.body).not.toContain("0007");
    expect(await s.store.read((state) => state.trafficUploads.length)).toBe(1);
  });
});
