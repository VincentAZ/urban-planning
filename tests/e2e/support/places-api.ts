import type { BrowserContext, Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataState } from "../../../apps/api/src/store";
import { readPersistedState } from "../../../apps/api/src/file-store";

/** Real HTTP, auth, CSRF, durable queue, archives and persistence, with a synthetic preparation worker and lookup responses.
 * Production conversion is tested independently in the API suite and against archived real-source bundles.
 */
export async function createPlacesApi(browserOrigin: string) {
  const directory = await mkdtemp(join(tmpdir(), "urban-places-browser-"));
  let child: ChildProcess | undefined,
    origin = "";
  async function start() {
    const server = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./places-server.ts", import.meta.url)),
        directory,
        browserOrigin,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    child = server;
    let diagnostics = "";
    server.stderr?.on("data", (data) => {
      diagnostics = (diagnostics + data).slice(-5000);
    });
    origin = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Fixture API did not start: ${diagnostics}`)),
        30000,
      );
      server.once("message", (message) => {
        clearTimeout(timeout);
        const ready = message as { origin?: string };
        ready.origin
          ? resolve(ready.origin)
          : reject(new Error("Invalid fixture startup message"));
      });
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Fixture API exited ${code}: ${diagnostics}`));
      });
    });
  }
  async function stop() {
    const server = child;
    child = undefined;
    if (!server || server.exitCode !== null || server.signalCode !== null)
      return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      server.kill("SIGTERM");
    });
  }
  async function close() {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await start();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async connect(target: Page | BrowserContext) {
      await target.route("**/api/v1/**", async (route) => {
        const request = new URL(route.request().url());
        const response = await route.fetch({
          url: `${origin}${request.pathname}${request.search}`,
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      });
    },
    async restart() {
      await stop();
      await start();
    },
    async persistedState(): Promise<DataState> {
      return readPersistedState(join(directory, "state.json"));
    },
    async calls(): Promise<
      { kind: string; query?: string; position?: [number, number] }[]
    > {
      return (await fetch(`${origin}/__qa__/calls`)).json();
    },
    close,
  };
}
