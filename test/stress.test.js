const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

const {
  createTestDatabase,
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
        insertMilliseconds: Math.round(insertedAt - startedAt),
        readMilliseconds: Math.round(finishedAt - insertedAt),
        totalMilliseconds: Math.round(finishedAt - startedAt),
      }),
    );

    assert.equal(documents.length, total);
    assert.equal(documents[0].index, 0);
    assert.equal(documents.at(-1).index, total - 1);
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
      `${queryCount} queries completed in ${Math.round(elapsed)} ms`,
    );
  });
});
