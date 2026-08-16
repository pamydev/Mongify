const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
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

  const total = 50_000;
  const totalDummyFields = 10;
  test(`findOne searches chunks containing ${total.toLocaleString("en-US")} documents`, async () => {
    const collection = await context.database.createCollection("documents");

    const targetIndex = total - 1;

    const createDummyFields = (count) => {
      return Array.from({ length: count }, (_, index) => ({
        key: `dummyField${index}`,
        value: `dummyValue${index + "x".repeat(50)}`,
      }));
    };

    await collection.createIndex("index", { unique: true });
    const maxTotal = 100_000;
    const operations = Math.ceil(total / maxTotal);
    for (let i = 0; i < operations; i += 1) {
      const start = i * maxTotal;
      const end = Math.min(start + maxTotal, total);
      await collection.insertMany(
        Array.from({ length: end - start }, (_, index) => ({
          index: start + index,
          name: `document-${start + index}`,
          ...Object.fromEntries(
            createDummyFields(totalDummyFields).map(({ key, value }) => [
              key,
              value,
            ]),
          ),
        })),
      );
    }
    // await collection.insertMany(
    //   Array.from({ length: total }, (_, index) => ({
    //     index,
    //     name: `document-${index}`,
    //     ...Object.fromEntries(
    //       createDummyFields(totalDummyFields).map(({ key, value }) => [
    //         key,
    //         value,
    //       ]),
    //     ),
    //   })),
    // );

    const size = await context.database.helpers._total_chunk_size("documents");
    const startedAt = performance.now();
    const document = await collection.findOne({ index: targetIndex });
    const elapsedMilliseconds = performance.now() - startedAt;

    console.log(
      `findOne() found the last of ${total.toLocaleString("en-US")} documents in ${formatDuration(elapsedMilliseconds)} (chunks: ${(size / 1024 / 1024).toFixed(2)} MB)`,
    );

    assert.equal(document.index, targetIndex);
    assert.equal(document.name, `document-${targetIndex}`);
  });
});
