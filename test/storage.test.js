const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
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

  test("an indexed findOne reads only the referenced chunk", async () => {
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

    assert.equal(chunksRead.size, 1, Array.from(chunksRead).join("\n"));
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
});
