const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const fsExtra = require("fs-extra");

const { CHUNK_SIZE_BYTES } = require("../dist/config.js");
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
});
