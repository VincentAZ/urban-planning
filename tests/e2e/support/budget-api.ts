import type { BrowserContext, Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataState } from "../../../apps/api/src/store.js";
import { readPersistedState } from "../../../apps/api/src/file-store.js";

/** An actual HTTP API with its own temporary durable store; never uses .local or vendor services. */
export async function createBudgetApi(
  browserOrigin: string,
  options: { historyFixture?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "urban-budget-browser-"));
  const filename = join(directory, "state.json");
  const admin = {
    id: "",
    name: "Budget administrator",
    email: "budget-admin@urban-planning.test",
    password: "Isolated-budget-fixture-only-2026",
  };
  const owner = {
    id: "",
    name: "Ordinary project owner",
    email: "budget-owner@urban-planning.test",
    password: "Isolated-owner-fixture-only-2026",
  };
  let server: ChildProcess | undefined;
  let origin = "";
  let held: { captured: () => void; wait: Promise<void> } | null = null;

  async function start(platformAdminUserIds: string[]) {
    // Run the API in its normal tsx environment, outside Playwright's module transformer.
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./budget-server.ts", import.meta.url)),
        filename,
        browserOrigin,
        JSON.stringify(platformAdminUserIds),
        options.historyFixture ? "history-fixture" : "",
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    server = child;
    let diagnostics = "";
    child.stderr?.on("data", (data) => {
      diagnostics = `${diagnostics}${data}`.slice(-4000);
    });
    origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Isolated budget API did not start. ${diagnostics}`),
          ),
        30_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`Isolated budget API exited (${code}). ${diagnostics}`),
        );
      });
      child.once("message", (message) => {
        const ready = message as { origin?: string };
        clearTimeout(timer);
        if (ready.origin) resolve(ready.origin);
        else reject(new Error("Invalid isolated API startup message"));
      });
    });
  }
  async function stop() {
    const child = server;
    server = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
  async function close() {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }

  try {
    // Register normal free accounts through HTTP first. Only trusted server startup then
    // designates the test administrator; neither account registration nor project ownership can.
    await start([]);
    for (const account of [admin, owner]) {
      const response = await fetch(`${origin}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: browserOrigin },
        body: JSON.stringify({
          name: account.name,
          email: account.email,
          password: account.password,
        }),
      });
      if (response.status !== 201)
        throw new Error(
          `Fixture registration failed with HTTP ${response.status}`,
        );
      const identity = (await response.json()) as {
        user: { id: string };
        platformAdmin: boolean;
      };
      if (identity.platformAdmin)
        throw new Error(
          "Registration unexpectedly granted platform administration",
        );
      account.id = identity.user.id;
    }
    await stop();
    await start([admin.id]);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    admin,
    owner,
    // Route changes only the destination, not the response. Cookie/CSRF/Origin checks,
    // persistence, authorization, and calculations all execute in the real Fastify API.
    async connect(target: Page | BrowserContext) {
      await target.route("**/api/v1/**", async (route) => {
        const requested = new URL(route.request().url());
        const response = await route.fetch({
          url: `${origin}${requested.pathname}${requested.search}`,
          maxRedirects: 0,
        });
        const delay =
          requested.pathname === "/api/v1/admin/budget" &&
          route.request().method() === "GET"
            ? held
            : null;
        if (delay) {
          held = null;
          delay.captured();
          await delay.wait;
        }
        try {
          await route.fulfill({ response });
        } catch (error) {
          if (!delay)
            throw error; /* A deliberately held response may have been aborted on scope loss. */
        }
      });
    },
    holdNextBudgetRead() {
      let captured!: () => void;
      let release!: () => void;
      const received = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { captured, wait };
      return { received, release };
    },
    async restart(options: { platformAdmin?: boolean } = {}) {
      await stop();
      await start(options.platformAdmin === false ? [] : [admin.id]);
    },
    async persistedState(): Promise<DataState> {
      return readPersistedState(filename);
    },
    close,
  };
}
