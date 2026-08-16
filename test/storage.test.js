const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const fsExtra = require("fs-extra");

const { CHUNK_SIZE_BYTES } = require("../dist/config.js");
const { BTreeIndex } = require("../dist/btree-index.js");
const {
  createTestDatabase,
  removeTestDatabase,
} = require("./support.js");

describe("Mongify chunk storage", () => {
  let context;

  beforeEach(async () => {
    context = await createTestDatabase("chunks");
  });

  afterEach(async () => {
    await removeTestDatabase(context);
  });

  test("splits a collection according to CHUNK_SIZE_BYTES", async () => {
    const collection = await context.database.createCollection("documents");
    await collection.insertMany(
      Array.from({ length: 24 }, (_, index) => ({
        index,
        payload: "x".repeat(1024 * 1024),
      })),
    );

    const manifestPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "chunks",
      "documents.json",
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const chunksPath = path.join(
      path.dirname(manifestPath),
      ".mongify",
      Buffer.from("documents").toString("base64url"),
      "generations",
      manifest.generation,
      "chunks",
    );
    const chunkNames = (await fs.readdir(chunksPath)).sort();
    const chunkSizes = await Promise.all(
      chunkNames.map(async (name) => (await fs.stat(path.join(chunksPath, name))).size),
    );

    assert.ok(chunkNames.length >= 3);
    assert.ok(chunkSizes.every((size) => size <= CHUNK_SIZE_BYTES));
    assert.equal((await collection.find()).length, 24);
  });

  test("an indexed findOne does not parse the referenced chunk", async () => {
    const collection = await context.database.createCollection("documents");
    await collection.createIndex("index", { unique: true });
    await collection.insertMany(
      Array.from({ length: 24 }, (_, index) => ({
        index,
        payload: "x".repeat(1024 * 1024),
      })),
    );

    const originalReadFile = fsExtra.readFile;
    const chunksRead = new Set();
    fsExtra.readFile = async (file, ...args) => {
      if (
        String(file).includes(`${path.sep}generations${path.sep}`) &&
        String(file).includes(`${path.sep}chunks${path.sep}`)
      ) {
        chunksRead.add(String(file));
      }
      return originalReadFile.call(fsExtra, file, ...args);
    };

    try {
      const document = await collection.findOne({ index: 23 });
      assert.equal(document.index, 23);
    } finally {
      fsExtra.readFile = originalReadFile;
    }

    assert.equal(chunksRead.size, 0, Array.from(chunksRead).join("\n"));
  });

  test("uses B+ tree leaf order for numeric, string and Date ranges", async () => {
    const collection = await context.database.createCollection("ranges");
    const baseDate = Date.UTC(2026, 0, 1);
    await collection.insertMany(
      Array.from({ length: 400 }, (_, offset) => {
        const score = 399 - offset;
        return {
          score,
          label: `item-${String(score).padStart(3, "0")}`,
          createdAt: new Date(baseDate + score * 1_000),
        };
      }),
    );
    await collection.createIndex("score");
    await collection.createIndex("label");
    await collection.createIndex("createdAt");

    const numeric = await collection.find({ score: { $gte: -5, $lt: 4 } });
    const strings = await collection.find({
      label: { $gte: "item-120", $lte: "item-123" },
    });
    const dates = await collection.find({
      createdAt: {
        $gt: new Date(baseDate + 200 * 1_000),
        $lte: new Date(baseDate + 203 * 1_000),
      },
    });

    assert.deepEqual(numeric.map(({ score }) => score), [0, 1, 2, 3]);
    assert.deepEqual(strings.map(({ label }) => label), [
      "item-120",
      "item-121",
      "item-122",
      "item-123",
    ]);
    assert.deepEqual(dates.map(({ score }) => score), [201, 202, 203]);

    await collection.update({ score: { $gte: 398 } }, { selected: true });
    assert.deepEqual(
      (await collection.find({ score: { $gte: 398 } })).map(
        ({ score, selected }) => [score, selected],
      ),
      [[398, true], [399, true]],
    );
    await collection.delete({ score: { $lt: 2 } });
    assert.deepEqual(
      (await collection.find({ score: { $lte: 2 } })).map(({ score }) => score),
      [2],
    );
  });

  test("an indexed range does not parse candidate chunks", async () => {
    const collection = await context.database.createCollection("range-chunks");
    await collection.insertMany(
      Array.from({ length: 24 }, (_, score) => ({
        score,
        payload: "x".repeat(1024 * 1024),
      })),
    );
    await collection.createIndex("score");

    const originalReadFile = fsExtra.readFile;
    const chunksRead = new Set();
    fsExtra.readFile = async (file, ...args) => {
      if (
        String(file).includes(`${path.sep}generations${path.sep}`) &&
        String(file).includes(`${path.sep}chunks${path.sep}`)
      ) {
        chunksRead.add(String(file));
      }
      return originalReadFile.call(fsExtra, file, ...args);
    };

    try {
      const documents = await collection.find({ score: { $gte: 22 } });
      assert.deepEqual(documents.map(({ score }) => score), [22, 23]);
    } finally {
      fsExtra.readFile = originalReadFile;
    }

    assert.equal(chunksRead.size, 0, Array.from(chunksRead).join("\n"));
  });

  test("refreshes direct offsets after updates and deletes shift documents", async () => {
    const collection = await context.database.createCollection("offsets");
    await collection.createIndex("score", { unique: true });
    await collection.insertMany([
      { score: 1, payload: "short" },
      { score: 2, payload: "second" },
      { score: 3, payload: "third" },
    ]);

    await collection.update({ score: 1 }, { payload: "x".repeat(100_000) });
    assert.equal((await collection.findOne({ score: 3 })).payload, "third");
    await collection.delete({ score: 1 });

    const originalReadFile = fsExtra.readFile;
    let parsedChunks = 0;
    fsExtra.readFile = async (file, ...args) => {
      if (
        String(file).includes(`${path.sep}generations${path.sep}`) &&
        String(file).includes(`${path.sep}chunks${path.sep}`)
      ) {
        parsedChunks += 1;
      }
      return originalReadFile.call(fsExtra, file, ...args);
    };
    try {
      assert.equal((await collection.findOne({ score: 3 })).payload, "third");
    } finally {
      fsExtra.readFile = originalReadFile;
    }
    assert.equal(parsedChunks, 0);
  });

  test("stores a multi-level index as paged B-tree nodes", async () => {
    const collection = await context.database.createCollection("documents");
    await collection.createIndex("index", { unique: true });
    await collection.insertMany(
      Array.from({ length: 2_000 }, (_, index) => ({ index, name: `doc-${index}` })),
    );

    const indexPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "chunks",
      ".mongify",
      Buffer.from("documents").toString("base64url"),
      "indexes",
      Buffer.from("index").toString("base64url"),
    );
    const metadata = JSON.parse(
      await fs.readFile(path.join(indexPath, "metadata.json"), "utf8"),
    );
    const pageNames = await fs.readdir(path.join(indexPath, "pages"));
    const root = JSON.parse(
      await fs.readFile(
        path.join(indexPath, "pages", `${String(metadata.root).padStart(8, "0")}.json`),
        "utf8",
      ),
    );

    assert.equal(metadata.format, "mongify-btree-v1");
    assert.ok(pageNames.length > 1);
    assert.equal(root.leaf, false);

    BTreeIndex.clearCache(indexPath);
    const pagesRead = new Set();
    const originalReadFile = fsExtra.readFile;
    fsExtra.readFile = async (file, ...args) => {
      if (String(file).startsWith(`${path.join(indexPath, "pages")}${path.sep}`)) {
        pagesRead.add(String(file));
      }
      return originalReadFile.call(fsExtra, file, ...args);
    };

    try {
      assert.equal((await collection.findOne({ index: 1_999 })).name, "doc-1999");
    } finally {
      fsExtra.readFile = originalReadFile;
    }

    assert.ok(pagesRead.size >= 2);
    assert.ok(pagesRead.size <= 4, Array.from(pagesRead).join("\n"));
  });

  test("rebuilds an index when a B-tree page is corrupted", async () => {
    const collection = await context.database.createCollection("documents");
    await collection.createIndex("index", { unique: true });
    await collection.insertMany(
      Array.from({ length: 500 }, (_, index) => ({ index, name: `doc-${index}` })),
    );

    const indexPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "chunks",
      ".mongify",
      Buffer.from("documents").toString("base64url"),
      "indexes",
      Buffer.from("index").toString("base64url"),
    );
    const metadata = JSON.parse(
      await fs.readFile(path.join(indexPath, "metadata.json"), "utf8"),
    );
    const rootPath = path.join(
      indexPath,
      "pages",
      `${String(metadata.root).padStart(8, "0")}.json`,
    );
    await fs.writeFile(rootPath, "{corrupted page", "utf8");
    BTreeIndex.clearCache(indexPath);

    assert.equal((await collection.findOne({ index: 499 })).name, "doc-499");
    assert.doesNotReject(async () => JSON.parse(await fs.readFile(rootPath, "utf8")));
  });

  test("increments one collection revision per data mutation", async () => {
    const collection = await context.database.createCollection("revisions");
    const manifestPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "chunks",
      "revisions.json",
    );
    const revision = async () =>
      JSON.parse(await fs.readFile(manifestPath, "utf8")).revision;

    assert.equal(await revision(), 0);
    await collection.insertMany([{ score: 1 }, { score: 2 }]);
    assert.equal(await revision(), 1);
    await collection.find();
    await collection.createIndex("score");
    assert.equal(await revision(), 1);
    await collection.update({ score: 1 }, { active: true });
    assert.equal(await revision(), 2);
    await collection.delete({ score: 2 });
    assert.equal(await revision(), 3);
  });

  test("opens a cold index without stat calls for every chunk", async () => {
    const collection = await context.database.createCollection("revision-index");
    await collection.createIndex("score", { unique: true });
    await collection.insertMany(
      Array.from({ length: 12 }, (_, score) => ({
        score,
        payload: "x".repeat(1024 * 1024),
      })),
    );
    const workerPath = path.join(__dirname, "fixtures", "indexed-read-worker.js");
    const worker = fork(
      workerPath,
      [context.temporaryDirectory, "chunks", "revision-index", "score", "11"],
      { silent: true },
    );
    const result = await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.on("message", (message) => {
        if (message?.error) reject(new Error(message.error));
        else resolve(message);
      });
      worker.once("exit", (code) => {
        if (code && code !== 0) reject(new Error(`worker exited with ${code}`));
      });
    });

    assert.equal(result.value, 11);
    assert.equal(result.chunkStats, 0);
  });
});
