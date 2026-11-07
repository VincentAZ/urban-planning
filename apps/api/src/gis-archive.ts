import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  lstat,
  readFile,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { ApiError } from "./errors.js";
import { GIS_LIMITS } from "./gis-types.js";

export const GIS_ARCHIVE_BYTES = 2 * 1024 ** 3;
export interface GisArchiveReference {
  sha256: string;
  bytes: number;
}
export interface GisArchivePublication {
  reference: GisArchiveReference;
  /** Retain on accepted admission, or when an uncertain database reply has a retained reference. */
  settle: (retain: boolean) => Promise<void>;
}
export interface StagedGisFile {
  reference: GisArchiveReference;
  finalize: () => Promise<GisArchivePublication>;
  discard: () => Promise<void>;
}
const unavailable = () =>
  new ApiError(
    503,
    "GIS_ARCHIVE_UNAVAILABLE",
    "The private GIS archive is missing, changed, or needs operator maintenance. No replacement evidence was invented.",
  );
export class GisArchive {
  readonly directory: string;
  private uploading = 0;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private key(organizationId: string, projectId: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw unavailable();
    const scope = createHash("sha256")
      .update(JSON.stringify([organizationId, projectId]))
      .digest("hex");
    return `${scope}-${hash}.bin`;
  }
  async assertCapacity() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let total = 0;
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (entry.name === ".write-lock" && entry.isDirectory()) continue;
      if (!entry.isFile()) throw unavailable();
      total += (await lstat(join(this.directory, entry.name))).size;
    }
    const fs = await statfs(this.directory);
    if (
      total + GIS_LIMITS.outputBytes > GIS_ARCHIVE_BYTES ||
      fs.bavail * fs.bsize < 2 * GIS_LIMITS.outputBytes
    )
      throw new ApiError(
        503,
        "GIS_ARCHIVE_FULL",
        "The private GIS archive is full. The operator must archive retained evidence or increase its capacity before accepting more files.",
      );
  }
  async receiveTemporary(
    organizationId: string,
    projectId: string,
    stream: Readable,
  ): Promise<StagedGisFile> {
    if (this.uploading >= 2)
      throw new ApiError(
        429,
        "GIS_UPLOAD_BUSY",
        "Two uploads are already being received. Try again shortly.",
      );
    this.uploading++;
    let temporary: string | undefined;
    const timeout = setTimeout(
      () =>
        stream.destroy(
          new ApiError(
            408,
            "GIS_UPLOAD_TIMEOUT",
            "The upload exceeded 30 seconds. Retry with a smaller file or a faster connection.",
          ),
        ),
      30000,
    );
    try {
      await this.assertCapacity();
      temporary = join(this.directory, `${randomUUID()}.upload`);
      const file = await open(temporary, "wx", 0o600),
        hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > GIS_LIMITS.inputBytes)
            throw new ApiError(
              413,
              "GIS_UPLOAD_TOO_LARGE",
              "Upload at most 20 MiB.",
            );
          hash.update(buffer);
          await file.writeFile(buffer);
        }
        if (!bytes)
          throw new ApiError(
            422,
            "GIS_UPLOAD_EMPTY",
            "The uploaded file is empty.",
          );
        if ((stream as Readable & { truncated?: boolean }).truncated)
          throw new ApiError(
            413,
            "GIS_UPLOAD_TOO_LARGE",
            "Upload at most 20 MiB.",
          );
        await file.sync();
      } finally {
        await file.close();
      }
      const sha256 = hash.digest("hex");
      const staged = this.staged(
        temporary,
        this.key(organizationId, projectId, sha256),
        { sha256, bytes },
      );
      temporary = undefined;
      return staged;
    } finally {
      clearTimeout(timeout);
      this.uploading--;
      if (temporary) await rm(temporary, { force: true });
    }
  }
  async stageBuffer(
    organizationId: string,
    projectId: string,
    raw: Buffer,
  ): Promise<StagedGisFile> {
    if (!raw.length || raw.length > GIS_LIMITS.outputBytes)
      throw new ApiError(
        413,
        "GIS_ARCHIVE_LIMIT",
        "The GIS artifact exceeds its 100 MiB archive limit.",
      );
    await this.assertCapacity();
    const sha256 = createHash("sha256").update(raw).digest("hex"),
      temporary = join(this.directory, `${randomUUID()}.pending`),
      file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(raw);
      await file.sync();
      await file.close();
      return this.staged(
        temporary,
        this.key(organizationId, projectId, sha256),
        { sha256, bytes: raw.length },
      );
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await file.close().catch(() => {});
    }
  }
  async put(organizationId: string, projectId: string, raw: Buffer) {
    const staged = await this.stageBuffer(organizationId, projectId, raw);
    try {
      const publication = await staged.finalize();
      await publication.settle(true);
      return publication.reference;
    } finally {
      await staged.discard();
    }
  }
  private staged(
    temporary: string,
    key: string,
    reference: GisArchiveReference,
  ): StagedGisFile {
    let finalized = false;
    return {
      reference,
      finalize: async () => {
        if (finalized) throw unavailable();
        finalized = true;
        return this.finish(temporary, key, reference);
      },
      discard: () => rm(temporary, { force: true }),
    };
  }
  private async finish(
    temporary: string,
    key: string,
    reference: GisArchiveReference,
  ): Promise<GisArchivePublication> {
    const lock = join(this.directory, ".write-lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new ApiError(
        503,
        "GIS_ARCHIVE_BUSY",
        "The archive writer is busy or was interrupted. Retry shortly; persistent locks require operator inspection.",
      );
    }
    let created = false;
    const destination = join(this.directory, key);
    const syncDirectory = async () => {
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    try {
      await this.assertCapacity();
      const incoming = await readFile(temporary);
      if (
        incoming.length !== reference.bytes ||
        createHash("sha256").update(incoming).digest("hex") !== reference.sha256
      )
        throw unavailable();
      try {
        const stat = await lstat(destination);
        if (!stat.isFile() || stat.size !== reference.bytes)
          throw unavailable();
        const existing = await readFile(destination);
        if (!existing.equals(incoming)) throw unavailable();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(temporary, destination);
        created = true;
      }
      await syncDirectory();
    } catch (error) {
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
            await rm(destination);
            await syncDirectory();
          }
        } finally {
          await rm(lock, { recursive: true });
        }
      },
    };
  }
  async read(
    organizationId: string,
    projectId: string,
    reference: { sha256: string; bytes: number },
  ) {
    const path = await this.path(organizationId, projectId, reference);
    const raw = await readFile(path);
    if (
      raw.length !== reference.bytes ||
      createHash("sha256").update(raw).digest("hex") !== reference.sha256
    )
      throw unavailable();
    return raw;
  }
  async path(
    organizationId: string,
    projectId: string,
    reference: { sha256: string; bytes: number },
  ) {
    if (
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 1 ||
      reference.bytes > GIS_LIMITS.outputBytes
    )
      throw unavailable();
    const path = join(
      this.directory,
      this.key(organizationId, projectId, reference.sha256),
    );
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== reference.bytes)
          throw unavailable();
        const raw = await file.readFile();
        if (createHash("sha256").update(raw).digest("hex") !== reference.sha256)
          throw unavailable();
      } finally {
        await file.close();
      }
    } catch {
      throw unavailable();
    }
    return path;
  }
}
