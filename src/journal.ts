import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import path from "node:path";

interface JournalEntry {
  path: string;
  existed: boolean;
  backup?: string;
}
interface JournalState {
  format: "mongify-journal-v1";
  state: "pending" | "committed";
  entries: JournalEntry[];
}

const transaction_context = new AsyncLocalStorage<JournalTransaction>();

export class JournalTransaction {
  private state: JournalState = {
    format: "mongify-journal-v1",
    state: "pending",
    entries: [],
  };
  private registered = new Set<string>();

  private constructor(
    private databasePath: string,
    private journalPath: string,
  ) {}

  public static async run<T>(
    databasePath: string,
    collectionName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (transaction_context.getStore()) return operation();
    const transaction = new JournalTransaction(
      databasePath,
      JournalTransaction.path(databasePath, collectionName),
    );
    await transaction._initialize();
    try {
      const result = await transaction_context.run(transaction, operation);
      await transaction._commit();
      return result;
    } catch (error) {
      await transaction._rollback();
      throw error;
    }
  }

  public static async beforeWrite(filePath: string): Promise<void> {
    await transaction_context.getStore()?._before_write(filePath);
  }

  public static async recover(
    databasePath: string,
    collectionName: string,
  ): Promise<void> {
    const journalPath = JournalTransaction.path(databasePath, collectionName);
    let state: JournalState;
    try {
      state = JSON.parse(
        await fs.readFile(path.join(journalPath, "journal.json"), "utf8"),
      );
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (state.format !== "mongify-journal-v1") {
      throw new Error("Invalid Mongify journal");
    }
    if (state.state === "pending") {
      await JournalTransaction.restore(databasePath, journalPath, state.entries);
    }
    await fs.remove(journalPath);
  }

  public static path(databasePath: string, collectionName: string): string {
    return path.join(
      databasePath,
      ".mongify-journal",
      Buffer.from(collectionName).toString("base64url"),
    );
  }

  private async _initialize(): Promise<void> {
    await fs.remove(this.journalPath);
    await fs.ensureDir(path.join(this.journalPath, "backups"));
    await this._persist();
  }

  private async _before_write(filePath: string): Promise<void> {
    const absolute = path.resolve(filePath);
    if (this.registered.has(absolute)) return;
    const relative = path.relative(this.databasePath, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Journal target is outside the database");
    }
    const existed = await fs.pathExists(absolute);
    const entry: JournalEntry = { path: relative, existed };
    if (existed) {
      const backup = `${randomUUID()}.backup`;
      await fs.copy(absolute, path.join(this.journalPath, "backups", backup));
      entry.backup = backup;
    }
    this.state.entries.push(entry);
    this.registered.add(absolute);
    await this._persist();
  }

  private async _commit(): Promise<void> {
    this.state.state = "committed";
    await this._persist();
    await fs.remove(this.journalPath);
  }

  private async _rollback(): Promise<void> {
    await JournalTransaction.restore(this.databasePath, this.journalPath, this.state.entries);
    await fs.remove(this.journalPath);
  }

  private async _persist(): Promise<void> {
    const target = path.join(this.journalPath, "journal.json");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.state), "utf8");
    await fs.rename(temporary, target);
  }

  private static async restore(
    databasePath: string,
    journalPath: string,
    entries: JournalEntry[],
  ): Promise<void> {
    for (const entry of [...entries].reverse()) {
      const target = path.join(databasePath, entry.path);
      if (entry.existed && entry.backup) {
        await fs.remove(target);
        await fs.ensureDir(path.dirname(target));
        await fs.copy(
          path.join(journalPath, "backups", entry.backup),
          target,
          { overwrite: true },
        );
      } else {
        await fs.remove(target);
      }
    }
  }
}
