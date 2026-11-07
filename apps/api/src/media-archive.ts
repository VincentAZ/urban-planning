import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  lstat,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJSON } from "@urban/core";
import { ApiError } from "./errors.js";

export const MEDIA_ARCHIVE_LIMITS = Object.freeze({
  bundleBytes: 256 * 1024 ** 2,
  totalBytes: 2 * 1024 ** 3,
  files: 64,
  manifestBytes: 32 * 1024,
});
export interface MediaArchiveReference {
  sha256: string;
  bytes: number;
  fileCount: number;
}
export interface MediaArchiveManifest {
  version: 1;
  scopeHash: string;
  files: { name: string; sha256: string; bytes: number }[];
}
export interface MediaArchivePublication {
  reference: MediaArchiveReference;
  /** Hold the writer lock until durable admission is known. An uncertain database reply must be checked before rollback. */
  settle: (retain: boolean) => Promise<void>;
}
type Scope = { organizationId: string; projectId: string };
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const filePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const invalid = () =>
  new ApiError(
    503,
    "MEDIA_ARCHIVE_UNAVAILABLE",
    "The retained media evidence is missing or changed. No replacement evidence was invented.",
  );
const full = () =>
  new ApiError(
    503,
    "MEDIA_ARCHIVE_FULL",
    "The private media archive needs operator maintenance before more evidence can be retained.",
  );
const scopeHash = ({ organizationId, projectId }: Scope) => {
  if (
    ![organizationId, projectId].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 240,
    )
  )
    throw invalid();
  return digest(canonicalJSON([organizationId, projectId]));
};
async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readBounded(path: string, bytes: number, maximum: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum)
    throw invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== bytes) throw invalid();
    const raw = await handle.readFile();
    if (raw.length !== bytes) throw invalid();
    return raw;
  } finally {
    await handle.close();
  }
}

/** Private project-scoped, immutable multi-file captures. HTTP callers never supply paths. */
export class MediaArchive {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private async inventory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw invalid();
    let total = 0;
    for (const folder of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (folder.name === ".write-lock" && folder.isDirectory()) continue;
      if (
        !folder.isDirectory() ||
        (!/^bundle-[a-f0-9]{64}$/.test(folder.name) &&
          !/^pending-[a-f0-9-]{36}$/.test(folder.name))
      )
        throw invalid();
      const path = join(this.directory, folder.name);
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (!file.isFile()) throw invalid();
        total += (await lstat(join(path, file.name))).size;
        if (total > MEDIA_ARCHIVE_LIMITS.totalBytes) throw full();
      }
    }
    return total;
  }
  async assertCapacity(additionalBytes = MEDIA_ARCHIVE_LIMITS.bundleBytes) {
    if (
      !Number.isSafeInteger(additionalBytes) ||
      additionalBytes < 0 ||
      additionalBytes > MEDIA_ARCHIVE_LIMITS.bundleBytes
    )
      throw full();
    const total = await this.inventory(),
      space = await statfs(this.directory);
    if (
      total + additionalBytes > MEDIA_ARCHIVE_LIMITS.totalBytes ||
      space.bavail * space.bsize <
        additionalBytes + MEDIA_ARCHIVE_LIMITS.bundleBytes
    )
      throw full();
  }

  async stage(
    scope: Scope,
    files: Record<string, Buffer>,
  ): Promise<MediaArchivePublication> {
    const owner = scopeHash(scope),
      entries = Object.entries(files).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
    if (
      !entries.length ||
      entries.length > MEDIA_ARCHIVE_LIMITS.files ||
      new Set(entries.map(([name]) => name.toLowerCase())).size !==
        entries.length
    )
      throw invalid();
    let bytes = 0;
    for (const [name, raw] of entries) {
      if (
        !filePattern.test(name) ||
        name.includes("..") ||
        !Buffer.isBuffer(raw)
      )
        throw invalid();
      bytes += raw.length;
      if (bytes > MEDIA_ARCHIVE_LIMITS.bundleBytes) throw full();
    }
    const manifest: MediaArchiveManifest = {
      version: 1,
      scopeHash: owner,
      files: entries.map(([name, raw]) => ({
        name,
        sha256: digest(raw),
        bytes: raw.length,
      })),
    };
    const manifestBytes = Buffer.from(canonicalJSON(manifest));
    bytes += manifestBytes.length;
    if (
      manifestBytes.length > MEDIA_ARCHIVE_LIMITS.manifestBytes ||
      bytes > MEDIA_ARCHIVE_LIMITS.bundleBytes
    )
      throw full();
    const reference = {
      sha256: digest(manifestBytes),
      bytes,
      fileCount: entries.length,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw invalid();
    const lock = join(this.directory, ".write-lock"),
      pending = join(this.directory, `pending-${randomUUID()}`),
      destination = join(this.directory, `bundle-${reference.sha256}`);
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new ApiError(
        503,
        "MEDIA_ARCHIVE_BUSY",
        "Media evidence is being saved or its writer was interrupted. Retry shortly; a persistent lock requires operator review.",
      );
    }
    let created = false;
    try {
      try {
        await lstat(destination);
        await this.verify(scope, reference);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.assertCapacity(bytes);
        await mkdir(pending, { mode: 0o700 });
        for (const [name, raw] of [
          ...entries,
          [".manifest.json", manifestBytes] as [string, Buffer],
        ]) {
          const file = await open(join(pending, name), "wx", 0o600);
          try {
            await file.writeFile(raw);
            await file.sync();
          } finally {
            await file.close();
          }
        }
        await syncDirectory(pending);
        for (const file of manifest.files) {
          if (
            digest(
              await readBounded(
                join(pending, file.name),
                file.bytes,
                MEDIA_ARCHIVE_LIMITS.bundleBytes,
              ),
            ) !== file.sha256
          )
            throw invalid();
        }
        await rename(pending, destination);
        created = true;
        await syncDirectory(this.directory);
      }
    } catch (error) {
      // Published evidence is kept if a directory-sync reply is uncertain; operator recovery can inspect it.
      await rm(pending, { recursive: true, force: true });
      await rm(lock, { recursive: true });
      throw error;
    }
    let settled = false;
    return {
      reference,
      settle: async (retain) => {
        if (settled) return;
        settled = true;
        try {
          if (!retain && created) {
            await rm(destination, { recursive: true });
            await syncDirectory(this.directory);
          }
        } finally {
          await rm(lock, { recursive: true });
        }
      },
    };
  }

  private async manifest(scope: Scope, reference: MediaArchiveReference) {
    const owner = scopeHash(scope);
    if (
      !hashPattern.test(reference.sha256) ||
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes <= 0 ||
      reference.bytes > MEDIA_ARCHIVE_LIMITS.bundleBytes ||
      !Number.isSafeInteger(reference.fileCount) ||
      reference.fileCount < 1 ||
      reference.fileCount > MEDIA_ARCHIVE_LIMITS.files
    )
      throw invalid();
    const path = join(this.directory, `bundle-${reference.sha256}`);
    if (!(await lstat(path)).isDirectory()) throw invalid();
    const size = (await lstat(join(path, ".manifest.json"))).size;
    const raw = await readBounded(
      join(path, ".manifest.json"),
      size,
      MEDIA_ARCHIVE_LIMITS.manifestBytes,
    );
    if (digest(raw) !== reference.sha256) throw invalid();
    const manifest = JSON.parse(raw.toString("utf8")) as MediaArchiveManifest;
    if (
      manifest.version !== 1 ||
      manifest.scopeHash !== owner ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== reference.fileCount ||
      new Set(manifest.files.map((file) => file.name.toLowerCase())).size !==
        reference.fileCount
    )
      throw invalid();
    for (const file of manifest.files) {
      if (
        !filePattern.test(file.name) ||
        file.name.includes("..") ||
        !hashPattern.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > MEDIA_ARCHIVE_LIMITS.bundleBytes
      )
        throw invalid();
    }
    if (
      raw.length + manifest.files.reduce((sum, file) => sum + file.bytes, 0) !==
        reference.bytes ||
      (await readdir(path)).length !== manifest.files.length + 1
    )
      throw invalid();
    return { path, manifest };
  }
  async verify(
    scope: Scope,
    reference: MediaArchiveReference,
  ): Promise<MediaArchiveManifest> {
    try {
      const { path, manifest } = await this.manifest(scope, reference);
      for (const file of manifest.files) {
        if (
          digest(
            await readBounded(
              join(path, file.name),
              file.bytes,
              MEDIA_ARCHIVE_LIMITS.bundleBytes,
            ),
          ) !== file.sha256
        )
          throw invalid();
      }
      return manifest;
    } catch {
      throw invalid();
    }
  }
  async read(
    scope: Scope,
    reference: MediaArchiveReference,
    name: string,
  ): Promise<Buffer> {
    try {
      const { path, manifest } = await this.manifest(scope, reference),
        file = manifest.files.find((file) => file.name === name);
      if (!file) throw invalid();
      const raw = await readBounded(
        join(path, file.name),
        file.bytes,
        MEDIA_ARCHIVE_LIMITS.bundleBytes,
      );
      if (digest(raw) !== file.sha256) throw invalid();
      return raw;
    } catch {
      throw invalid();
    }
  }
}
