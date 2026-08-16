const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const { Mongify } = require("../dist/mongify.js");
const { CollectionFileLock } = require("../dist/file-lock.js");
const {
  createTestDatabase,
  removeTestDatabase,
} = require("./support.js");

describe("Mongify concurrency", () => {
  let context;

  beforeEach(async () => {
    context = await createTestDatabase("concurrency");
  });

  afterEach(async () => {
    await removeTestDatabase(context);
  });

  test("does not lose parallel inserts from one instance", async () => {
    const collection = await context.database.createCollection("events");
    const total = 100;

    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        collection.insert({ index }),
      ),
    );

    const documents = await collection.find();

    assert.equal(documents.length, total);
    assert.equal(
      new Set(documents.map(({ index }) => index)).size,
      total,
      "parallel writes lost or duplicated documents",
    );
  });

  test("persists a simultaneous insert burst as one batch", async () => {
    const collection = await context.database.createCollection("events");
    const helpers = context.database.helpers;
    const originalWrite = helpers._append_documents.bind(helpers);
    let writes = 0;

    helpers._append_documents = async (...args) => {
      writes += 1;
      return originalWrite(...args);
    };

    try {
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          collection.insert({ index }),
        ),
      );
    } finally {
      helpers._append_documents = originalWrite;
    }

    assert.equal(writes, 1);
    assert.equal((await collection.find()).length, 100);
  });

  test("does not lose inserts made by two database instances", async () => {
    const firstDatabase = context.database;
    const secondDatabase = new Mongify({
      database_name: "concurrency",
      path: context.temporaryDirectory,
    });
    const firstCollection = await firstDatabase.createCollection("events");
    const secondCollection = secondDatabase.getCollection("events");
    const writesPerInstance = 50;

    await Promise.all([
      ...Array.from({ length: writesPerInstance }, (_, index) =>
        firstCollection.insert({ source: "first", index }),
      ),
      ...Array.from({ length: writesPerInstance }, (_, index) =>
        secondCollection.insert({ source: "second", index }),
      ),
    ]);

    const documents = await firstCollection.find();

    assert.equal(documents.length, writesPerInstance * 2);
    assert.equal(
      documents.filter(({ source }) => source === "first").length,
      writesPerInstance,
    );
    assert.equal(
      documents.filter(({ source }) => source === "second").length,
      writesPerInstance,
    );
  });

  test("does not lose inserts made by separate Node processes", async () => {
    const collection = await context.database.createCollection("events");
    const totalPerProcess = 250;
    const workerPath = path.join(__dirname, "fixtures", "insert-worker.js");
    const argumentsFor = (source) => [
      context.temporaryDirectory,
      "concurrency",
      "events",
      source,
      String(totalPerProcess),
    ];
    const workers = [
      fork(workerPath, argumentsFor("first"), { silent: true }),
      fork(workerPath, argumentsFor("second"), { silent: true }),
    ];

    await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            worker.once("error", reject);
            worker.once("message", (message) => {
              if (message === "ready") resolve();
              else reject(new Error(message.error));
            });
          }),
      ),
    );
    workers.forEach((worker) => worker.send("start"));
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            worker.on("message", (message) => {
              if (message === "done") resolve();
              else if (message?.error) reject(new Error(message.error));
            });
            worker.once("error", reject);
            worker.once("exit", (code) => {
              if (code && code !== 0) reject(new Error(`worker exited with ${code}`));
            });
          }),
      ),
    );

    const documents = await collection.find();
    assert.equal(documents.length, totalPerProcess * workers.length);
    assert.equal(
      new Set(documents.map(({ _id }) => _id)).size,
      totalPerProcess * workers.length,
    );
  });

  test("reclaims an orphaned collection lock", async () => {
    const databasePath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "concurrency",
    );
    const lockPath = CollectionFileLock.path(databasePath, "events");
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        token: "orphaned",
        createdAt: Date.now() - 60_000,
      }),
      "utf8",
    );

    const lock = await CollectionFileLock.acquire(databasePath, "events");
    await lock.release();

    await assert.rejects(() => fs.access(lockPath));
  });

  test("keeps the collection file as valid JSON during mixed activity", async () => {
    const collection = await context.database.createCollection("events");
    await collection.insertMany(
      Array.from({ length: 100 }, (_, index) => ({ index, state: "new" })),
    );

    await Promise.all([
      ...Array.from({ length: 50 }, (_, index) =>
        collection.insert({ index: 100 + index, state: "new" }),
      ),
      ...Array.from({ length: 50 }, (_, index) =>
        collection.find({ index }),
      ),
      collection.update({ state: "new" }, { inspected: true }),
    ]);

    const documents = await collection.find();

    assert.ok(Array.isArray(documents));
    assert.ok(documents.length >= 100);
  });
});
