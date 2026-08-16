const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  createTestDatabase,
  removeTestDatabase,
} = require("./support.js");

describe("Mongify safety regressions", () => {
  let context;

  beforeEach(async () => {
    context = await createTestDatabase("safety");
  });

  afterEach(async () => {
    await removeTestDatabase(context);
  });

  test("rejects collection names that escape the database directory", async () => {
    await assert.rejects(async () => {
      const collection = context.database.getCollection("../outside");
      await collection.insert({ unsafe: true });
    });

    const escapedPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "outside.json",
    );

    await assert.rejects(() => fs.access(escapedPath));
  });

  test("does not allow a caller to override generated ids", async () => {
    const collection = await context.database.createCollection("users");

    await collection.insert({ _id: "controlled", name: "Pamela" });
    await collection.insert({ _id: "controlled", name: "Alice" });

    const documents = await collection.find();
    const ids = documents.map(({ _id }) => _id);

    assert.equal(new Set(ids).size, 2);
    assert.ok(ids.every((id) => id !== "controlled"));
  });

  test("does not create a collection when deleting from a missing one", async () => {
    const missingCollection = context.database.getCollection("missing");

    await missingCollection.delete({ active: false });
    await new Promise((resolve) => setImmediate(resolve));

    const collections = await context.database.listCollections();

    assert.deepEqual(collections, []);
  });
});
