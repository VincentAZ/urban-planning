import { validateWorkspaceSnapshot } from "./flood-validation";
import {
  canonicalJSON,
  type BaselineIdentity,
  type Place,
  type Project,
  type ProjectSnapshot,
} from "@urban/core";
import { readCloudProjectLink, type CloudProjectLink } from "./cloud-workspace";

export type WorkspaceSnapshot = ProjectSnapshot & {
  cloudLink?: CloudProjectLink;
};

export const workspaceDatabaseName = "urban-planning:workspace:v2";
interface Envelope {
  schemaVersion: 2;
  project: Project;
  baselineIdentity: BaselineIdentity;
  baselineLoadedAt?: string;
  cloudLink?: CloudProjectLink;
}
let pending: Promise<unknown> = Promise.resolve();
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(workspaceDatabaseName, 1);
    request.onupgradeneeded = () => {
      for (const name of ["snapshots", "drafts", "meta"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Another tab is preventing access to browser storage."));
  });
}
export interface BrowserDraftSummary {
  id: string;
  name: string;
  updatedAt: string;
  baselineLoadedAt?: string;
  cloudOrganizationId?: string;
}
async function readCapturedDraft(
  id?: string,
): Promise<WorkspaceSnapshot | null> {
  await pending;
  const db = await openDatabase();
  const value = await new Promise<{ envelope: Envelope; place: Place } | null>(
    (resolve, reject) => {
      const tx = db.transaction(["meta", "drafts", "snapshots"], "readonly");
      let result: { envelope: Envelope; place: Place } | null = null;
      const read = (key: string) => {
        const draft = tx.objectStore("drafts").get(key);
        draft.onsuccess = () => {
          const envelope = draft.result as Envelope | undefined;
          if (
            !envelope ||
            envelope.schemaVersion !== 2 ||
            !envelope.baselineIdentity?.sha256
          ) {
            tx.abort();
            return;
          }
          const baseline = tx
            .objectStore("snapshots")
            .get(envelope.baselineIdentity.sha256);
          baseline.onsuccess = () => {
            if (!baseline.result) {
              tx.abort();
              return;
            }
            result = { envelope, place: baseline.result.place };
          };
        };
      };
      if (id) read(id);
      else {
        const active = tx.objectStore("meta").get("active");
        active.onsuccess = () => {
          if (active.result) read(active.result);
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(
          new Error(
            "The saved draft or its captured baseline could not be read. Existing browser records have been preserved.",
          ),
        );
      };
    },
  );
  if (!value) return null;
  const snapshot = await validateWorkspaceSnapshot({
    project: value.envelope.project,
    place: value.place,
    baselineIdentity: value.envelope.baselineIdentity,
  });
  const cloudLink = readCloudProjectLink(
    value.envelope.cloudLink,
    snapshot.project.id,
  );
  return { ...snapshot, ...(cloudLink ? { cloudLink } : {}) };
}
export async function readWorkspace() {
  return readCapturedDraft();
}
export async function readWorkspaceDraft(
  id: string,
): Promise<WorkspaceSnapshot> {
  const draft = await readCapturedDraft(id);
  if (!draft) throw new Error("This browser draft could not be found.");
  return draft;
}
export async function listWorkspaceDrafts(): Promise<BrowserDraftSummary[]> {
  await pending;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readonly"),
      drafts: BrowserDraftSummary[] = [];
    const request = tx.objectStore("drafts").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const envelope = cursor.value as Envelope;
      if (envelope.schemaVersion === 2 && envelope.project?.id)
        drafts.push({
          id: envelope.project.id,
          name: envelope.project.name,
          updatedAt: envelope.project.updatedAt,
          baselineLoadedAt: envelope.baselineLoadedAt,
          cloudOrganizationId: envelope.cloudLink?.organizationId,
        });
      cursor.continue();
    };
    tx.oncomplete = () => {
      db.close();
      resolve(drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(
        new Error(
          "Browser draft history could not be read. Existing records are preserved.",
        ),
      );
    };
  });
}
export function writeWorkspace(snapshot: WorkspaceSnapshot): Promise<void> {
  return writeCapturedWorkspace(snapshot);
}
/** Replace only the anonymous draft that produced an authenticated first save. */
export function rekeyWorkspaceDraft(
  previousId: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  if (!previousId || previousId === snapshot.project.id || !snapshot.cloudLink)
    throw new Error("A first cloud save must connect a new project identity.");
  return writeCapturedWorkspace(snapshot, previousId);
}
function writeCapturedWorkspace(
  snapshot: WorkspaceSnapshot,
  previousId?: string,
): Promise<void> {
  // Capture the project before another synchronous edit can mutate caller state.
  const envelope: Envelope = {
    schemaVersion: 2,
    project: structuredClone(snapshot.project),
    baselineIdentity: { ...snapshot.baselineIdentity },
    baselineLoadedAt: snapshot.place.loadedAt,
    cloudLink: readCloudProjectLink(snapshot.cloudLink, snapshot.project.id),
  };
  const task = pending.then(async () => {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["snapshots", "drafts", "meta"], "readwrite");
      let failure: unknown;
      const snapshots = tx.objectStore("snapshots");
      // getKey avoids repeatedly cloning the large baseline on every edit.
      const exists = snapshots.getKey(envelope.baselineIdentity.sha256);
      exists.onsuccess = () => {
        const fail = (error: unknown) => {
          failure = error;
          tx.abort();
        };
        const commit = () => {
          try {
            if (exists.result === undefined)
              snapshots.add(
                { place: snapshot.place, identity: envelope.baselineIdentity },
                envelope.baselineIdentity.sha256,
              );
            tx.objectStore("drafts").put(envelope, envelope.project.id);
            if (previousId) tx.objectStore("drafts").delete(previousId);
            tx.objectStore("meta").put(envelope.project.id, "active");
          } catch (error) {
            fail(error);
          }
        };
        if (!previousId) {
          commit();
          return;
        }
        const drafts = tx.objectStore("drafts");
        const oldDraft = drafts.get(previousId);
        oldDraft.onsuccess = () => {
          try {
            const previous = oldDraft.result as Envelope | undefined;
            // Another tab may have changed the local draft while the request was in flight.
            // Keep that record instead of silently replacing its newer work.
            if (
              previous &&
              (previous.cloudLink ||
                previous.baselineIdentity.sha256 !==
                  envelope.baselineIdentity.sha256 ||
                canonicalJSON({
                  ...previous.project,
                  id: envelope.project.id,
                }) !== canonicalJSON(envelope.project))
            )
              throw new Error(
                "The browser draft changed in another tab. Its saved record has been preserved.",
              );
            const target = drafts.get(envelope.project.id);
            target.onsuccess = () => {
              if (target.result !== undefined) {
                fail(
                  new Error(
                    "The new cloud identity already has a browser draft. Existing records have been preserved.",
                  ),
                );
                return;
              }
              commit();
            };
          } catch (error) {
            fail(error);
          }
        };
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(
          failure ??
            tx.error ??
            new Error("Browser snapshot storage could not be committed."),
        );
      };
    });
  });
  pending = task.catch(() => {});
  return task;
}
export async function flushWorkspaceWrites() {
  await pending;
}
