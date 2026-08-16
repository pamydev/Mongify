const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Mongify } = require("../dist/mongify.js");

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

  test("preserves Date values when storing and reading documents", async () => {
    const users = await database.createCollection("users");
    const date = new Date("2026-08-16T20:06:59.174Z");

    await users.insert({ name: "Pamela", date });

    const document = await users.findOne({ name: "Pamela" });
    assert.ok(document.date instanceof Date);
    assert.equal(document.date.getTime(), date.getTime());

    const manifestPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "test-database",
      "users.json",
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const chunkPath = path.join(
      path.dirname(manifestPath),
      ".mongify",
      Buffer.from("users").toString("base64url"),
      "generations",
      manifest.generation,
      "chunks",
      "000001.json",
    );
    const persisted = JSON.parse(await fs.readFile(chunkPath, "utf8"));

    assert.equal(persisted.format, "mongify-chunk-v1");
    assert.equal(persisted.documents[0].date, date.getTime());
    assert.deepEqual(persisted.dates, [[0, ["date"], date.getTime()]]);
  });

  test("preserves nested Date values and Date values inside arrays", async () => {
    const users = await database.createCollection("users");
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const loginAt = new Date("2026-08-16T21:00:00.000Z");

    await users.insert({
      name: "Pamela",
      profile: { createdAt },
      logins: [loginAt],
    });

    const document = await users.findOne({ name: "Pamela" });
    assert.ok(document.profile.createdAt instanceof Date);
    assert.ok(document.logins[0] instanceof Date);
    assert.equal(document.profile.createdAt.getTime(), createdAt.getTime());
    assert.equal(document.logins[0].getTime(), loginAt.getTime());
  });

  test("finds indexed Date values after reopening the database", async () => {
    const users = await database.createCollection("users");
    const date = new Date("2026-08-16T20:06:59.174Z");
    await users.createIndex("date", { unique: true });
    await users.insert({ name: "Pamela", date });

    const reopened = new Mongify({
      database_name: "test-database",
      path: context.temporaryDirectory,
    });
    const document = await reopened.getCollection("users").findOne({
      date: new Date(date.getTime()),
    });

    assert.equal(document.name, "Pamela");
    assert.ok(document.date instanceof Date);
    assert.equal(document.date.getTime(), date.getTime());
  });

  test("keeps Date indexes synchronized after updates and deletes", async () => {
    const users = await database.createCollection("users");
    const previous = new Date("2026-01-01T00:00:00.000Z");
    const replacement = new Date("2026-08-16T20:06:59.174Z");
    await users.createIndex("date", { unique: true });
    await users.insert({ name: "Pamela", date: previous });

    await users.update({ date: previous }, { date: replacement });

    assert.equal(await users.findOne({ date: previous }), null);
    const updated = await users.findOne({ date: replacement });
    assert.ok(updated.date instanceof Date);
    assert.equal(updated.date.getTime(), replacement.getTime());

    await users.delete({ date: replacement });
    assert.equal(await users.findOne({ date: replacement }), null);
  });

  test("rejects invalid Date values", async () => {
    const users = await database.createCollection("users");

    await assert.rejects(
      () => users.insert({ date: new Date("invalid") }),
      /Invalid Date values cannot be stored/,
    );
    assert.deepEqual(await users.find(), []);
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

    assert.equal((await users.find({}, { limit: "2" })).length, 2);
    assert.deepEqual(await users.find({}, { limit: 0 }), []);
    await assert.rejects(
      () => users.find({}, { limit: -1 }),
      /limit must be a non-negative integer/,
    );
  });

  test("applies projection to find results", async () => {
    const users = await database.createCollection("users");
    await users.insert({ name: "Pamela", email: "pamela@example.com", password: "secret" });

    const [user] = await users.find(
      { name: "Pamela" },
      { projection: { name: 1, _id: 0 } },
    );

    assert.deepEqual(user, { name: "Pamela" });
  });

  test("applies skip alone and together with limit and projection", async () => {
    const users = await database.createCollection("users");
    await users.insertMany([
      { order: 1, name: "A" },
      { order: 2, name: "B" },
      { order: 3, name: "C" },
      { order: 4, name: "D" },
    ]);

    assert.deepEqual(
      (await users.find({}, { skip: 2 })).map(({ order }) => order),
      [3, 4],
    );
    assert.deepEqual(
      await users.find({}, {
        skip: "1",
        limit: 2,
        projection: { order: 1, _id: 0 },
      }),
      [{ order: 2 }, { order: 3 }],
    );
    assert.deepEqual(await users.find({}, { skip: 10 }), []);
    await users.createIndex("group");
    await users.update({}, { group: "same" });
    assert.deepEqual(
      (
        await users.find(
          { group: "same" },
          { skip: 1, limit: 2, projection: { order: 1, _id: 0 } },
        )
      ).map(({ order }) => order),
      [2, 3],
    );
    await assert.rejects(
      () => users.find({}, { skip: -1 }),
      /skip must be a non-negative integer/,
    );
  });

  test("sorts by one or multiple fields before skip, limit and projection", async () => {
    const users = await database.createCollection("users");
    await users.insertMany([
      { name: "Pamela", team: "a", score: 10 },
      { name: "Alice", team: "b", score: 30 },
      { name: "Bob", team: "a", score: 20 },
      { name: "Carol", team: "b", score: 15 },
    ]);

    assert.deepEqual(
      (await users.find({}, { sort: { score: -1 } })).map(({ score }) => score),
      [30, 20, 15, 10],
    );
    assert.deepEqual(
      await users.find(
        {},
        {
          sort: { team: 1, score: -1 },
          skip: 1,
          limit: 2,
          projection: { name: 1, _id: 0 },
        },
      ),
      [{ name: "Pamela" }, { name: "Alice" }],
    );
  });

  test("sorts Date values and validates sort directions", async () => {
    const events = await database.createCollection("events");
    await events.insertMany([
      { name: "later", date: new Date("2026-08-03T00:00:00Z") },
      { name: "earlier", date: new Date("2026-08-01T00:00:00Z") },
      { name: "middle", date: new Date("2026-08-02T00:00:00Z") },
    ]);

    assert.deepEqual(
      (await events.find({}, { sort: { date: 1 } })).map(({ name }) => name),
      ["earlier", "middle", "later"],
    );
    await assert.rejects(
      () => events.find({}, { sort: { date: 0 } }),
      /must be 1 or -1/,
    );
  });

  test("findOne returns null when no document matches", async () => {
    const users = await database.createCollection("users");

    const result = await users.findOne({ name: "missing" });

    assert.equal(result, null);
  });

  test("findOne scans until a non-indexed document matches", async () => {
    const users = await database.createCollection("users");
    await users.insertMany([
      { name: "A" },
      { name: "B" },
      { name: "target" },
    ]);

    const result = await users.findOne({ name: "target" });

    assert.equal(result.name, "target");
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

  test("creates, lists and drops indexes", async () => {
    const users = await database.createCollection("users");

    assert.deepEqual(await users.listIndexes(), [
      { field: "_id", unique: true },
    ]);

    const created = await users.createIndex("email", { unique: true });

    assert.deepEqual(created, {
      acknowledge: true,
      indexesBefore: 1,
      indexesAfter: 2,
    });

    assert.deepEqual(await users.listIndexes(), [
      { field: "_id", unique: true },
      { field: "email", unique: true },
    ]);

    const existing = await users.createIndex("email", { unique: true });

    assert.deepEqual(existing, {
      acknowledge: false,
      indexesBefore: 2,
      indexesAfter: 2,
      error: "exists",
    });

    await users.dropIndex("email");

    assert.deepEqual(await users.listIndexes(), [
      { field: "_id", unique: true },
    ]);
  });

  test("rejects duplicate values in a unique index", async () => {
    const users = await database.createCollection("users");
    await users.createIndex("email", { unique: true });

    await assert.rejects(
      () =>
        users.insertMany([
          { email: "pamela@example.com" },
          { email: "pamela@example.com" },
        ]),
      /Duplicate value for unique index: email/,
    );

    assert.deepEqual(await users.find(), []);
  });

  test("creates and uses compound indexes", async () => {
    const users = await database.createCollection("users");
    const created = await users.createIndex(["tenant", "email"], {
      unique: true,
    });

    assert.deepEqual(created, {
      acknowledge: true,
      indexesBefore: 1,
      indexesAfter: 2,
    });
    assert.deepEqual(await users.createIndex(["tenant", "email"]), {
      acknowledge: false,
      indexesBefore: 2,
      indexesAfter: 2,
      error: "exists",
    });
    assert.deepEqual(await users.listIndexes(), [
      { field: "_id", unique: true },
      { field: ["tenant", "email"], unique: true },
    ]);

    await users.insertMany([
      { tenant: "cedros", email: "pamela@example.com", name: "Pamela" },
      { tenant: "other", email: "pamela@example.com", name: "Other Pamela" },
    ]);
    assert.equal(
      (await users.findOne({ tenant: "cedros", email: "pamela@example.com" }))
        .name,
      "Pamela",
    );
    await assert.rejects(
      () =>
        users.insert({ tenant: "cedros", email: "pamela@example.com" }),
      /Duplicate value for unique index: tenant, email/,
    );

    await users.update(
      { tenant: "cedros", email: "pamela@example.com" },
      { email: "new@example.com" },
    );
    assert.equal(
      await users.findOne({ tenant: "cedros", email: "pamela@example.com" }),
      null,
    );
    assert.equal(
      (await users.findOne({ tenant: "cedros", email: "new@example.com" }))
        .name,
      "Pamela",
    );

    await users.dropIndex(["tenant", "email"]);
    assert.deepEqual(await users.listIndexes(), [
      { field: "_id", unique: true },
    ]);
  });

  test("validates compound index field lists", async () => {
    const users = await database.createCollection("users");
    await assert.rejects(() => users.createIndex([]), /at least one field/);
    await assert.rejects(
      () => users.createIndex(["tenant", "tenant"]),
      /cannot repeat fields/,
    );
  });

  test("keeps indexes synchronized after updates and deletes", async () => {
    const users = await database.createCollection("users");
    await users.createIndex("email", { unique: true });
    await users.insertMany([
      { name: "Pamela", email: "old@example.com" },
      { name: "Alice", email: "alice@example.com" },
    ]);

    await users.update(
      { email: "old@example.com" },
      { email: "new@example.com" },
    );

    assert.equal(await users.findOne({ email: "old@example.com" }), null);
    assert.equal(
      (await users.findOne({ email: "new@example.com" })).name,
      "Pamela",
    );

    await users.delete({ email: "new@example.com" });

    assert.equal(await users.findOne({ email: "new@example.com" }), null);
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
