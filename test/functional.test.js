const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  createTestDatabase,
  removeTestDatabase,
} = require("./support.js");

describe("Mongify functional API", () => {
  let context;
  let database;

  beforeEach(async () => {
    context = await createTestDatabase();
    database = context.database;
  });

  afterEach(async () => {
    await removeTestDatabase(context);
  });

  test("creates and lists collections", async () => {
    await database.createCollection("users");
    await database.createCollection("products");

    const collections = await database.listCollections();

    assert.deepEqual(collections.sort(), ["products", "users"]);
  });

  test("opening an existing collection preserves its documents", async () => {
    const users = await database.createCollection("users");
    await users.insert({ name: "Pamela" });

    const reopenedUsers = await database.createCollection("users");
    const documents = await reopenedUsers.find();

    assert.equal(documents.length, 1);
    assert.equal(documents[0].name, "Pamela");
  });

  test("inserts a document and generates an id", async () => {
    const users = await database.createCollection("users");

    await users.insert({ name: "Pamela", active: true });

    const document = await users.findOne({ name: "Pamela" });

    assert.equal(document.name, "Pamela");
    assert.equal(document.active, true);
    assert.equal(typeof document._id, "string");
    assert.ok(document._id.length > 0);
  });

  test("inserts multiple documents", async () => {
    const users = await database.createCollection("users");

    await users.insertMany([
      { name: "Pamela" },
      { name: "Alice" },
      { name: "Bob" },
    ]);

    const documents = await users.find();

    assert.equal(documents.length, 3);
    assert.equal(new Set(documents.map(({ _id }) => _id)).size, 3);
  });

  test("finds documents and applies a limit", async () => {
    const users = await database.createCollection("users");
    await users.insertMany([
      { name: "A", active: true },
      { name: "B", active: true },
      { name: "C", active: false },
    ]);

    const activeUsers = await users.find({ active: true }, { limit: 1 });

    assert.equal(activeUsers.length, 1);
    assert.equal(activeUsers[0].active, true);
  });

  test("findOne returns an empty array when no document matches", async () => {
    const users = await database.createCollection("users");

    const result = await users.findOne({ name: "missing" });

    assert.deepEqual(result, []);
  });

  test("updates every matching document", async () => {
    const users = await database.createCollection("users");
    await users.insertMany([
      { name: "A", group: "admin", active: true },
      { name: "B", group: "admin", active: true },
      { name: "C", group: "user", active: true },
    ]);

    await users.update({ group: "admin" }, { active: false });

    const admins = await users.find({ group: "admin" });
    const regularUsers = await users.find({ group: "user" });

    assert.equal(admins.length, 2);
    assert.ok(admins.every(({ active }) => active === false));
    assert.equal(regularUsers[0].active, true);
  });

  test("performs an upsert when no document matches", async () => {
    const users = await database.createCollection("users");

    await users.update(
      { email: "pamela@example.com" },
      { name: "Pamela", active: true },
      { upsert: true },
    );

    const documents = await users.find();

    assert.equal(documents.length, 1);
    assert.equal(documents[0].email, "pamela@example.com");
    assert.equal(documents[0].name, "Pamela");
    assert.equal(typeof documents[0]._id, "string");
  });

  test("deletes every matching document", async () => {
    const users = await database.createCollection("users");
    await users.insertMany([
      { name: "Pamela", active: true },
      { name: "Alice", active: false },
      { name: "Bob", active: false },
    ]);

    await users.delete({ active: false });

    const documents = await users.find();

    assert.deepEqual(documents.map(({ name }) => name), ["Pamela"]);
  });

  test("deletes a collection", async () => {
    await database.createCollection("users");
    await database.deleteCollection("users");

    const collections = await database.listCollections();

    assert.deepEqual(collections, []);
  });

  test("reports malformed JSON instead of silently replacing it", async () => {
    const users = await database.createCollection("users");
    const collectionPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "test-database",
      "users.json",
    );

    await fs.writeFile(collectionPath, "{malformed json", "utf8");

    await assert.rejects(() => users.find(), SyntaxError);
  });
});
