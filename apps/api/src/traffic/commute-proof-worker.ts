import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ApiError } from "../errors.js";
import { commuteHash } from "./commute-routing-valhalla.js";
import type {
  TrafficCommuteReplayInput,
  TrafficCommuteReplayReceipt,
} from "./commute-proof.js";

export const TRAFFIC_COMMUTE_REPLAY_LIMITS = Object.freeze({
  milliseconds: 60000,
  waitingMilliseconds: 30000,
  maxWaiting: 2,
  oldGenerationMiB: 1024,
  cacheEntries: 8,
});
const completed = new Map<string, TrafficCommuteReplayReceipt>(),
  pending = new Map<string, Promise<TrafficCommuteReplayReceipt>>();
type Waiter = {
  start: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const waiting: Waiter[] = [];
let active = false;
const assetPending = new Map<string, Promise<unknown>>();
const assetWaiting: {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}[] = [];
let assetActive = false;
function assetPump() {
  if (assetActive) return;
  const next = assetWaiting.shift();
  if (!next) return;
  assetActive = true;
  clearTimeout(next.timer);
  next.start();
}
/** Bound the entire server-side fresh read/hash/normalization, not just the later geometry thread. */
export async function withTrafficCommuteProofAdmission<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const current = assetPending.get(key);
  if (current) return current as Promise<T>;
  if (
    assetActive &&
    assetWaiting.length >= TRAFFIC_COMMUTE_REPLAY_LIMITS.maxWaiting
  )
    throw new ApiError(
      503,
      "TRAFFIC_COMMUTE_PROOF_BUSY",
      "Prepared-source verification capacity is occupied.",
    );
  const promise = new Promise<T>((resolve, reject) => {
    const task = {
      timer: setTimeout(() => {
        const at = assetWaiting.indexOf(task);
        if (at >= 0) {
          assetWaiting.splice(at, 1);
          reject(
            new ApiError(
              503,
              "TRAFFIC_COMMUTE_PROOF_BUSY",
              "Prepared-source verification exceeded its bounded waiting time.",
            ),
          );
        }
      }, TRAFFIC_COMMUTE_REPLAY_LIMITS.waitingMilliseconds),
      start: () => {
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            assetActive = false;
            assetPump();
          });
      },
    };
    assetWaiting.push(task);
    assetPump();
  });
  assetPending.set(key, promise);
  try {
    return await promise;
  } finally {
    assetPending.delete(key);
  }
}
const failed = () =>
  new ApiError(
    503,
    "TRAFFIC_COMMUTE_PROOF_FAILED",
    "The exact retained correspondence could not be replayed within its bounded verification profile. No partial preset was accepted.",
  );
function pump() {
  if (active) return;
  const task = waiting.shift();
  if (!task) return;
  active = true;
  clearTimeout(task.timer);
  task.start();
}
/** Call only after fresh hash checks of every manifest dependency. Cache authority is content, never pathname/mtime. */
export async function verifyTrafficCommuteInWorker(
  input: TrafficCommuteReplayInput,
): Promise<TrafficCommuteReplayReceipt> {
  const key = commuteHash({
    files: input.files,
    network: input.network,
    routes: input.routes,
    correspondence: input.correspondence,
  });
  const cached = completed.get(key);
  if (cached) return structuredClone(cached);
  const current = pending.get(key);
  if (current) return structuredClone(await current);
  if (active && waiting.length >= TRAFFIC_COMMUTE_REPLAY_LIMITS.maxWaiting)
    throw new ApiError(
      503,
      "TRAFFIC_COMMUTE_PROOF_BUSY",
      "Prepared-source verification capacity is occupied. Retry after the current verification completes.",
    );
  const promise = new Promise<TrafficCommuteReplayReceipt>(
    (resolve, reject) => {
      const task: Waiter = {
        reject,
        timer: setTimeout(() => {
          const at = waiting.indexOf(task);
          if (at >= 0) {
            waiting.splice(at, 1);
            reject(
              new ApiError(
                503,
                "TRAFFIC_COMMUTE_PROOF_BUSY",
                "Prepared-source verification exceeded its bounded waiting time.",
              ),
            );
          }
        }, TRAFFIC_COMMUTE_REPLAY_LIMITS.waitingMilliseconds),
        start: () => {
          let worker: Worker;
          try {
            const loader = new URL(
              "./index.mjs",
              pathToFileURL(
                createRequire(import.meta.url).resolve("tsx/esm/api"),
              ),
            ).href;
            worker = new Worker(
              `const {parentPort,workerData}=require('node:worker_threads');import(workerData.loader).then(({tsImport})=>tsImport(workerData.module,workerData.parent)).then(({replayTrafficCommuteCorrespondence})=>replayTrafficCommuteCorrespondence(workerData.input)).then(result=>parentPort.postMessage({ok:true,result})).catch(()=>parentPort.postMessage({ok:false}));`,
              {
                eval: true,
                execArgv: [],
                resourceLimits: {
                  maxOldGenerationSizeMb: 1024,
                  maxYoungGenerationSizeMb: 32,
                  stackSizeMb: 8,
                },
                workerData: {
                  loader,
                  module: new URL("./commute-proof.ts", import.meta.url).href,
                  parent: import.meta.url,
                  input,
                },
              },
            );
          } catch {
            active = false;
            reject(failed());
            pump();
            return;
          }
          let settled = false;
          const timer = setTimeout(
            () => finish(),
            TRAFFIC_COMMUTE_REPLAY_LIMITS.milliseconds,
          );
          const finish = (result?: TrafficCommuteReplayReceipt) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate().then(
              () => {
                active = false;
                pump();
                if (result) resolve(result);
                else reject(failed());
              },
              () => {
                reject(
                  failed(),
                ); /* No new worker until process restart if termination is unconfirmed. */
              },
            );
          };
          worker.on("message", (m) => finish(m.ok ? m.result : undefined));
          worker.on("error", () => finish());
          worker.on("exit", () => {
            if (!settled) finish();
          });
        },
      };
      waiting.push(task);
      pump();
    },
  );
  pending.set(key, promise);
  try {
    const result = await promise;
    if (completed.size >= TRAFFIC_COMMUTE_REPLAY_LIMITS.cacheEntries)
      completed.delete(completed.keys().next().value!);
    completed.set(key, structuredClone(result));
    return result;
  } finally {
    pending.delete(key);
  }
}
