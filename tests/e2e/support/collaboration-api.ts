import type { BrowserContext, Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import type { DataState } from "../../../apps/api/src/store";
import { readPersistedState } from "../../../apps/api/src/file-store";

/** Real HTTP sessions, CSRF, project ACLs, comments, exports and persistence.
 * The default source is synthetic; placeFile may supply an actual captured source bundle.
 * No authorization or application response is mocked.
 */
export async function createCollaborationApi(
  browserOrigin: string,
  options: {
    placeFile?: string;
    workforceFixture?: boolean;
    accessibilityFixture?: boolean;
    floodFixture?: boolean;
    floodPartialFixture?: boolean;
    gisNativeFixture?: boolean;
    gisFixture?: boolean;
    trafficNativeFixture?: boolean;
    trafficRegistryPath?: string;
    retainTrafficEvidence?: boolean;
    identityDisabled?: boolean;
    mediaNativeFixture?: boolean;
    mediaManualWorker?: boolean;
    retainMediaEvidence?: boolean;
  } = {},
) {
  if (options.gisNativeFixture && options.gisFixture)
    throw new Error(
      "Choose real native GIS or the explicitly synthetic converter, not both.",
    );
  if (options.trafficNativeFixture && process.env.RUN_TRAFFIC_JOB_QA !== "1")
    throw new Error(
      "Real native traffic browser QA requires explicit RUN_TRAFFIC_JOB_QA=1.",
    );
  if (options.mediaNativeFixture && process.env.RUN_MEDIA_JOB_QA !== "1")
    throw new Error(
      "Real native media browser QA requires explicit RUN_MEDIA_JOB_QA=1.",
    );
  const retained = options.retainTrafficEvidence || options.retainMediaEvidence;
  const evidenceRoot = options.retainMediaEvidence
    ? ".local/qa/media/browser"
    : ".local/qa/traffic/native-browser";
  if (retained) await mkdir(evidenceRoot, { recursive: true });
  const directory = await mkdtemp(
    retained
      ? join(evidenceRoot, "run-")
      : join(tmpdir(), "urban-collaboration-browser-"),
  );
  let child: ChildProcess | undefined,
    origin = "";
  const identityFixtureKey = randomBytes(32).toString("base64");
  let lostResponse: { path: string; method: string } | null = null;
  let heldResponse: {
    path: string;
    method: string;
    committed: () => void;
    released: Promise<void>;
    release: () => void;
  } | null = null;
  async function start() {
    const server = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./collaboration-server.ts", import.meta.url)),
        directory,
        browserOrigin,
        options.placeFile ?? "",
        ...(options.identityDisabled ? ["--identity-disabled"] : []),
        ...(options.workforceFixture ? ["--workforce-fixture"] : []),
        ...(options.accessibilityFixture ? ["--accessibility-fixture"] : []),
        ...(options.floodFixture || options.floodPartialFixture
          ? ["--flood-fixture"]
          : []),
        ...(options.floodPartialFixture ? ["--flood-partial"] : []),
        ...(options.gisNativeFixture ? ["--gis-native"] : []),
        ...(options.gisFixture ? ["--gis-fixture"] : []),
        ...(options.trafficNativeFixture ? ["--traffic-native"] : []),
        ...(options.mediaNativeFixture ? ["--media-native"] : []),
        ...(options.mediaManualWorker ? ["--media-manual-worker"] : []),
        ...(options.trafficRegistryPath
          ? [`--traffic-registry=${options.trafficRegistryPath}`]
          : []),
      ],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, URBAN_IDENTITY_FIXTURE_KEY: identityFixtureKey },
      },
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
      // Let the native adapter confirm its owned container/encoder stopped before
      // terminating the fixture process. Browser test/assertion deadlines are unchanged.
      const timeout = setTimeout(
        () => server.kill("SIGKILL"),
        options.mediaNativeFixture ? 20000 : 5000,
      );
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      server.kill("SIGTERM");
    });
  }
  async function close() {
    heldResponse?.release();
    await stop();
    if (!retained) await rm(directory, { recursive: true, force: true });
  }
  try {
    await start();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    evidenceDirectory: directory,
    /** TEST ONLY: retain metadata for 105 older jobs referencing one real immutable archive.
     * This private operator IPC does not represent additional native executions. */
    async seedMediaHistory(completedJobId: string): Promise<{
      projectId: string;
      scenarioId: string;
      appended: number;
    }> {
      if (!options.mediaNativeFixture || !child?.connected)
        throw new Error("This fixture has no isolated native media history.");
      const server = child,
        id = randomUUID();
      return new Promise((resolve, reject) => {
        const receive = (raw: unknown) => {
          const message = raw as {
            type?: string;
            id?: string;
            error?: string;
            result?: {
              projectId: string;
              scenarioId: string;
              appended: number;
            };
          };
          if (message.type !== "media-history-seeded" || message.id !== id)
            return;
          server.off("message", receive);
          server.off("exit", exited);
          if (message.error || !message.result)
            reject(
              new Error(
                message.error ?? "History fixture returned no receipt.",
              ),
            );
          else resolve(message.result);
        };
        const exited = () => {
          server.off("message", receive);
          reject(
            new Error(
              "Media fixture stopped before history preparation completed.",
            ),
          );
        };
        server.on("message", receive);
        server.once("exit", exited);
        server.send({ type: "media-seed-history", id, completedJobId });
      });
    },
    /** Advance the real isolated worker scheduler; never replace its executor, frames or stored job state. */
    async runMediaWorker(): Promise<void> {
      if (
        !options.mediaNativeFixture ||
        !options.mediaManualWorker ||
        !child?.connected
      )
        throw new Error(
          "This fixture has no manually scheduled native media worker.",
        );
      const server = child,
        id = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const receive = (raw: unknown) => {
          const message = raw as { type?: string; id?: string; error?: string };
          if (message.type !== "media-ran" || message.id !== id) return;
          server.off("message", receive);
          server.off("exit", exited);
          message.error ? reject(new Error(message.error)) : resolve();
        };
        const exited = () => {
          server.off("message", receive);
          reject(
            new Error("Media fixture stopped before its worker completed."),
          );
        };
        server.on("message", receive);
        server.once("exit", exited);
        server.send({ type: "media-run", id });
      });
    },
    async identityToken(
      kind: "verify-email" | "password-reset" | "invitation",
      email: string,
    ): Promise<string> {
      // Private mailbox polling, not a bypass of challenge generation, storage, dispatch or acceptance.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const server = child;
        if (!server?.connected)
          throw new Error("Isolated identity mailbox is unavailable.");
        const id = randomUUID();
        const token = await new Promise<string | undefined>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              server.off("message", receive);
              reject(new Error("Isolated mailbox timed out."));
            }, 2000);
            const receive = (raw: unknown) => {
              const message = raw as {
                type?: string;
                id?: string;
                token?: string;
              };
              if (message.type !== "identity-token" || message.id !== id)
                return;
              clearTimeout(timeout);
              server.off("message", receive);
              resolve(message.token);
            };
            server.on("message", receive);
            server.send({ type: "identity-token", id, kind, email });
          },
        );
        if (token) return token;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        "No matching email was delivered to the isolated test mailbox.",
      );
    },
    async connect(target: Page | BrowserContext) {
      const forward = async (route: import("@playwright/test").Route) => {
        const request = new URL(route.request().url());
        const forwardedOrigin = origin;
        const response = await route
          .fetch({
            url: `${forwardedOrigin}${request.pathname}${request.search}`,
            maxRedirects: 0,
            // Preserve real cold source verification through the test-only proxy.
            // Its bounded replay can exceed Playwright's ordinary 15 s action
            // timeout; this does not alter the application or mock the response.
            ...(options.trafficRegistryPath &&
            request.pathname.endsWith("/traffic/context")
              ? { timeout: 120000 }
              : {}),
          })
          .catch(async (error) => {
            // Background session refresh may overlap an intentional fixture shutdown/restart.
            // Abort the browser request as a real transport failure; never synthesize an API response.
            if (!child?.connected || forwardedOrigin !== origin) {
              await route.abort("failed").catch(() => {});
              return null;
            }
            throw error;
          });
        if (!response) return;
        if (
          lostResponse?.path === request.pathname &&
          lostResponse.method === route.request().method()
        ) {
          lostResponse = null;
          await route.abort("failed");
          return;
        }
        if (
          heldResponse?.path === request.pathname &&
          heldResponse.method === route.request().method()
        ) {
          const held = heldResponse;
          heldResponse = null;
          held.committed();
          await held.released;
        }
        await route.fulfill({ response });
      };
      await target.route("**/api/v1/**", forward);
      await target.route("**/data/phoenix.json", forward);
    },
    /** Test an uncertain delivery after the actual server committed; never mock its state or response. */
    loseNextResponse(path: string, method = "POST") {
      lostResponse = { path, method };
    },
    /** Hold delivery after a real commit to exercise stale-response races. */
    holdNextResponse(path: string, method = "POST") {
      let committed!: () => void, release!: () => void;
      const delivered = new Promise<void>((resolve) => {
        committed = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldResponse = { path, method, committed, released, release };
      return { committed: delivered, release };
    },
    async restart() {
      await stop();
      await start();
    },
    async persistedState(): Promise<DataState> {
      return readPersistedState(join(directory, "state.json"));
    },
    close,
  };
}
