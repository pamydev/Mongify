import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import {
  COLLECTION_LOCK_RETRY_MS,
  COLLECTION_LOCK_STALE_MS,
  COLLECTION_LOCK_TIMEOUT_MS,
} from "./config";

interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

export class CollectionFileLock {
  private constructor(
    private lockPath: string,
    private token: string,
  ) {}

  public static async acquire(
    databasePath: string,
    collectionName: string,
  ): Promise<CollectionFileLock> {
    const locksPath = path.join(databasePath, ".mongify-locks");
    const lockPath = path.join(
      locksPath,
      `${Buffer.from(collectionName).toString("base64url")}.lock`,
    );
    const startedAt = Date.now();
    await fs.ensureDir(locksPath);

    while (true) {
      const token = randomUUID();
      try {
        await fs.mkdir(lockPath);
        try {
          const owner: LockOwner = {
            pid: process.pid,
            token,
            createdAt: Date.now(),
          };
          await fs.writeFile(
            path.join(lockPath, "owner.json"),
            JSON.stringify(owner),
            "utf8",
          );
        } catch (error) {
          await fs.remove(lockPath);
          throw error;
        }
        return new CollectionFileLock(lockPath, token);
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      }

      if (await CollectionFileLock._is_stale(lockPath)) {
        await fs.remove(lockPath);
        continue;
      }
      if (Date.now() - startedAt >= COLLECTION_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for collection lock: ${collectionName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, COLLECTION_LOCK_RETRY_MS));
    }
  }

  public async release(): Promise<void> {
    let owner: LockOwner;
    try {
      owner = JSON.parse(
        await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"),
      );
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (owner.token === this.token) {
      await fs.remove(this.lockPath);
    }
  }

  public static path(databasePath: string, collectionName: string): string {
    return path.join(
      databasePath,
      ".mongify-locks",
      `${Buffer.from(collectionName).toString("base64url")}.lock`,
    );
  }

  private static async _is_stale(lockPath: string): Promise<boolean> {
    try {
      const owner: LockOwner = JSON.parse(
        await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
      );
      return !CollectionFileLock._process_exists(owner.pid);
    } catch (error: any) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        try {
          const stats = await fs.stat(lockPath);
          return Date.now() - stats.mtimeMs >= COLLECTION_LOCK_STALE_MS;
        } catch (statError: any) {
          return statError?.code === "ENOENT";
        }
      }
      throw error;
    }
  }

  private static _process_exists(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code !== "ESRCH";
    }
  }
}
