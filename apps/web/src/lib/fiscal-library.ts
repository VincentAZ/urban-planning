import {
  fiscalProfileSchema,
  fiscalProfileHash,
  type FiscalProfile,
} from "@urban/core";
export interface LocalFiscalProfile {
  hash: string;
  savedAt: string;
  profile: FiscalProfile;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("urban-planning:fiscal-profiles:v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("profiles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Another tab is blocking the browser profile library."));
  });
}
export async function readLocalFiscalProfiles(
  scope: string,
): Promise<LocalFiscalProfile[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const values: LocalFiscalProfile[] = [],
      tx = db.transaction("profiles", "readonly");
    const request = tx
      .objectStore("profiles")
      .openCursor(IDBKeyRange.bound(`${scope}:`, `${scope}:\uffff`));
    let error: unknown;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      try {
        const value = cursor.value as LocalFiscalProfile;
        fiscalProfileSchema.parse(value.profile);
        if (fiscalProfileHash(value.profile) !== value.hash)
          throw new Error(
            "A retained browser profile failed its content check.",
          );
        values.push(value);
        cursor.continue();
      } catch (failure) {
        error = failure;
        tx.abort();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve(values.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(
        error ??
          tx.error ??
          new Error(
            "The browser profile library could not be read. Existing profiles are retained.",
          ),
      );
    };
  });
}
export async function saveLocalFiscalProfile(
  scope: string,
  profile: FiscalProfile,
): Promise<LocalFiscalProfile> {
  const parsed = fiscalProfileSchema.parse(profile),
    hash = fiscalProfileHash(parsed),
    db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("profiles", "readwrite"),
      store = tx.objectStore("profiles"),
      key = `${scope}:${hash}`;
    let result: LocalFiscalProfile;
    const read = store.get(key);
    read.onsuccess = () => {
      if (read.result) {
        result = read.result;
        return;
      }
      result = {
        hash,
        savedAt: new Date().toISOString(),
        profile: structuredClone(parsed),
      };
      store.add(result, key);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(
        tx.error ??
          new Error(
            "The profile could not be saved in this browser. Existing records were preserved.",
          ),
      );
    };
  });
}
