const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const {
  createTestDatabase,
  formatDuration,
  removeTestDatabase,
} = require("./support.js");

describe("Mongify stress", () => {
  let context;

  beforeEach(async () => {
    context = await createTestDatabase("stress");
  });

  afterEach(async () => {
    await removeTestDatabase(context);
  });

  test("stores and reads 10,000 documents", async (testContext) => {
    const collection = await context.database.createCollection("documents");
    const total = 10_000;
    const startedAt = performance.now();

    await collection.insertMany(
      Array.from({ length: total }, (_, index) => ({
        index,
        group: index % 10,
        payload: `document-${index}-${"x".repeat(100)}`,
      })),
    );

    const insertedAt = performance.now();
    const documents = await collection.find();
    const finishedAt = performance.now();

    testContext.diagnostic(
      JSON.stringify({
        documents: total,
        insert: formatDuration(insertedAt - startedAt),
        read: formatDuration(finishedAt - insertedAt),
        total: formatDuration(finishedAt - startedAt),
      }),
    );

    assert.equal(documents.length, total);
    assert.equal(documents[0].index, 0);
    assert.equal(documents.at(-1).index, total - 1);
  });

  test("inserts 10,000 documents simultaneously using insert", async () => {
    const collection = await context.database.createCollection("documents");
    const total = 10_000;
    const startedAt = performance.now();

    await Promise.all(
      Array.from({ length: total }, (_, index) => collection.insert({ index })),
    );

    const elapsedMilliseconds = performance.now() - startedAt;
    const documents = await collection.find();

    console.log(
      `Inserted ${total.toLocaleString("en-US")} documents with simultaneous insert() calls in ${formatDuration(elapsedMilliseconds)}`,
    );

    assert.equal(documents.length, total);
    assert.equal(
      new Set(documents.map(({ index }) => index)).size,
      total,
      "simultaneous inserts lost or duplicated documents",
    );
  });

  test("repeatedly queries a collection with 5,000 documents", async (testContext) => {
    const collection = await context.database.createCollection("documents");
    const queryCount = 200;

    await collection.insertMany(
      Array.from({ length: 5_000 }, (_, index) => ({
        index,
        group: index % 20,
      })),
    );

    const startedAt = performance.now();

    for (let index = 0; index < queryCount; index += 1) {
      const documents = await collection.find({ group: index % 20 });
      assert.equal(documents.length, 250);
    }

    const elapsed = performance.now() - startedAt;

    testContext.diagnostic(
      `${queryCount} queries completed in ${formatDuration(elapsed)}`,
    );
  });

  const total = 120_000;
  const totalDummyFields = 50;
  test(`findOne searches a file with ${total.toLocaleString("en-US")} documents`, async () => {
    const collection = await context.database.createCollection("documents");

    const targetIndex = total - 1;

    const createDummyFields = (count) => {
      return Array.from({ length: count }, (_, index) => ({
        key: `dummyField${index}`,
        value: `dummyValue${index + "x".repeat(50)}`,
      }));
    };

    await collection.insertMany(
      Array.from({ length: total }, (_, index) => ({
        index,
        name: `document-${index}`,
        ...Object.fromEntries(
          createDummyFields(totalDummyFields).map(({ key, value }) => [
            key,
            value,
          ]),
        ),
      })),
    );

    const collectionPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "stress",
      "documents.json",
    );
    const { size } = await fs.stat(collectionPath);
    const startedAt = performance.now();
    const document = await collection.findOne({ index: targetIndex });
    const elapsedMilliseconds = performance.now() - startedAt;

    console.log(
      `findOne() found the last of ${total.toLocaleString("en-US")} documents in ${formatDuration(elapsedMilliseconds)} (JSON file: ${(size / 1024 / 1024).toFixed(2)} MB)`,
    );

    assert.equal(document.index, targetIndex);
    assert.equal(document.name, `document-${targetIndex}`);
  });
});
