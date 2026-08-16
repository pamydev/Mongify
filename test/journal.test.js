const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { JournalTransaction } = require("../dist/journal.js");

describe("Mongify collection journal", () => {
  let databasePath;

  beforeEach(async () => {
    databasePath = await fs.mkdtemp(path.join(os.tmpdir(), "mongify-journal-"));
  });

  afterEach(async () => {
    await fs.rm(databasePath, { recursive: true, force: true });
  });

  test("commits all writes and removes the completed journal", async () => {
    const target = path.join(databasePath, "users.json");
    await fs.writeFile(target, "before", "utf8");

    await JournalTransaction.run(databasePath, "users", async () => {
      await JournalTransaction.beforeWrite(target);
      await fs.writeFile(target, "after", "utf8");
    });

    assert.equal(await fs.readFile(target, "utf8"), "after");
    await assert.rejects(() => fs.access(JournalTransaction.path(databasePath, "users")));
  });

  test("rolls back existing and newly created files when an operation fails", async () => {
    const existing = path.join(databasePath, "users.json");
    const created = path.join(databasePath, ".mongify", "users", "chunk.json");
    await fs.writeFile(existing, "original", "utf8");

    await assert.rejects(
      () =>
        JournalTransaction.run(databasePath, "users", async () => {
          await JournalTransaction.beforeWrite(existing);
          await fs.writeFile(existing, "changed", "utf8");
          await JournalTransaction.beforeWrite(created);
          await fs.mkdir(path.dirname(created), { recursive: true });
          await fs.writeFile(created, "new", "utf8");
          throw new Error("simulated failure");
        }),
      /simulated failure/,
    );

    assert.equal(await fs.readFile(existing, "utf8"), "original");
    await assert.rejects(() => fs.access(created));
  });

  test("recovers a pending journal left by an interrupted process", async () => {
    const target = path.join(databasePath, "users.json");
    const journalPath = JournalTransaction.path(databasePath, "users");
    const backupName = "manifest.backup";
    await fs.mkdir(path.join(journalPath, "backups"), { recursive: true });
    await fs.writeFile(target, "partial write", "utf8");
    await fs.writeFile(
      path.join(journalPath, "backups", backupName),
      "consistent state",
      "utf8",
    );
    await fs.writeFile(
      path.join(journalPath, "journal.json"),
      JSON.stringify({
        format: "mongify-journal-v1",
        state: "pending",
        entries: [{ path: "users.json", existed: true, backup: backupName }],
      }),
      "utf8",
    );

    await JournalTransaction.recover(databasePath, "users");

    assert.equal(await fs.readFile(target, "utf8"), "consistent state");
    await assert.rejects(() => fs.access(journalPath));
  });

  test("restores a replaced index directory without keeping partial files", async () => {
    const indexPath = path.join(databasePath, ".mongify", "users", "index");
    await fs.mkdir(indexPath, { recursive: true });
    await fs.writeFile(path.join(indexPath, "original.json"), "original", "utf8");

    await assert.rejects(() =>
      JournalTransaction.run(databasePath, "users", async () => {
        await JournalTransaction.beforeWrite(indexPath);
        await fs.rm(indexPath, { recursive: true, force: true });
        await fs.mkdir(indexPath, { recursive: true });
        await fs.writeFile(path.join(indexPath, "partial.json"), "partial", "utf8");
        throw new Error("index replacement failed");
      }),
    );

    assert.equal(
      await fs.readFile(path.join(indexPath, "original.json"), "utf8"),
      "original",
    );
    await assert.rejects(() => fs.access(path.join(indexPath, "partial.json")));
  });
});
