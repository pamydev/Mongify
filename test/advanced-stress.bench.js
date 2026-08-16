const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const {
  createTestDatabase,
  formatDuration,
  removeTestDatabase,
} = require("./support.js");

const TOTAL = Number(process.env.MONGIFY_ADVANCED_TOTAL || 1_120_000);
const DUMMY_FIELDS = Number(process.env.MONGIFY_ADVANCED_FIELDS || 100);
const INSERT_BATCH = Number(process.env.MONGIFY_ADVANCED_BATCH || 100_000);
const QUERY_COUNT = Number(process.env.MONGIFY_ADVANCED_QUERIES || 1_000);
const KEEP_DATABASE = process.env.MONGIFY_ADVANCED_KEEP === "1";

function percentile(sorted, percentage) {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentage / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function formatBytes(bytes) {
  const megabytes = bytes / 1024 / 1024;
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(2)} GB`
    : `${megabytes.toFixed(2)} MB`;
}

describe("Mongify advanced indexed stress", { concurrency: 1 }, () => {
  let context;
  let collection;
  let indexPath;
  let coldMetrics;
  let dummyFields;

  before(async () => {
    context = await createTestDatabase("advanced-stress");
    collection = await context.database.createCollection("documents");
    await collection.createIndex("index", { unique: true });

    dummyFields = Object.fromEntries(
      Array.from({ length: DUMMY_FIELDS }, (_, index) => [
        `dummyField${index}`,
        `dummyValue${index}-${"x".repeat(50)}`,
      ]),
    );

    const startedAt = performance.now();
    for (let start = 0; start < TOTAL; start += INSERT_BATCH) {
      const end = Math.min(start + INSERT_BATCH, TOTAL);
      await collection.insertMany(
        Array.from({ length: end - start }, (_, offset) => ({
          ...dummyFields,
          index: start + offset,
          name: `document-${start + offset}`,
        })),
      );
    }

    const manifestPath = path.join(
      context.temporaryDirectory,
      "Mongify",
      "advanced-stress",
      "documents.json",
    );
    indexPath = path.join(
      path.dirname(manifestPath),
      ".mongify",
      Buffer.from("documents").toString("base64url"),
      "indexes",
      Buffer.from("index").toString("base64url"),
    );
    const size = await context.database.helpers._total_chunk_size("documents");

    console.log(
      `Prepared ${TOTAL.toLocaleString("en-US")} documents in ${formatDuration(performance.now() - startedAt)} (${formatBytes(size)})`,
    );
  });

  after(async () => {
    if (KEEP_DATABASE) {
      console.log(`Advanced database kept at ${context.temporaryDirectory}`);
      return;
    }
    await removeTestDatabase(context);
  });

  function runColdQuery(targetIndex) {
    const workerPath = path.join(__dirname, "fixtures", "index-worker.js");
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        workerPath,
        context.temporaryDirectory,
        "advanced-stress",
        "documents",
        "index",
        JSON.stringify(targetIndex),
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return JSON.parse(result.stdout);
  }

  test("loads a persisted index in a fresh process", () => {
    coldMetrics = runColdQuery(TOTAL - 1);

    console.log(
      `Cold process findOne(): ${formatDuration(coldMetrics.elapsedMilliseconds)}`,
    );
    assert.equal(coldMetrics.found, true);
  });

  test("measures the memory used when loading the index", () => {
    assert.ok(coldMetrics);
    const rssDelta = coldMetrics.rssAfter - coldMetrics.rssBefore;
    const heapDelta = coldMetrics.heapUsedAfter - coldMetrics.heapUsedBefore;

    console.log(
      `Cold index memory: RSS ${formatBytes(rssDelta)}, heap ${formatBytes(heapDelta)}`,
    );
    assert.ok(coldMetrics.rssAfter > 0);
  });

  test("reports p50, p95 and p99 across random chunks", async () => {
    const durations = [];
    let state = 0x12345678;

    for (let query = 0; query < QUERY_COUNT; query += 1) {
      state = (1664525 * state + 1013904223) >>> 0;
      const targetIndex = state % TOTAL;
      const startedAt = performance.now();
      const document = await collection.findOne({ index: targetIndex });
      durations.push(performance.now() - startedAt);
      assert.equal(document.index, targetIndex);
    }

    durations.sort((left, right) => left - right);
    const metrics = {
      queries: QUERY_COUNT,
      average: durations.reduce((sum, value) => sum + value, 0) / durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      p99: percentile(durations, 99),
      maximum: durations.at(-1),
    };

    console.log(
      `Random findOne(): avg ${formatDuration(metrics.average)}, p50 ${formatDuration(metrics.p50)}, p95 ${formatDuration(metrics.p95)}, p99 ${formatDuration(metrics.p99)}, max ${formatDuration(metrics.maximum)}`,
    );
  });

  test("measures insert, indexed update and indexed delete", async () => {
    const insertedIndex = TOTAL;
    let startedAt = performance.now();
    await collection.insert({
      ...dummyFields,
      index: insertedIndex,
      name: `document-${insertedIndex}`,
    });
    const insertDuration = performance.now() - startedAt;

    const updatedIndex = Math.floor(TOTAL / 2);
    startedAt = performance.now();
    await collection.update(
      { index: updatedIndex },
      { benchmarkState: "updated" },
    );
    const updateDuration = performance.now() - startedAt;

    startedAt = performance.now();
    await collection.delete({ index: insertedIndex });
    const deleteDuration = performance.now() - startedAt;

    console.log(
      `Large collection mutations: insert ${formatDuration(insertDuration)}, update ${formatDuration(updateDuration)}, delete ${formatDuration(deleteDuration)}`,
    );
    assert.equal(
      (await collection.findOne({ index: updatedIndex })).benchmarkState,
      "updated",
    );
    assert.equal(await collection.findOne({ index: insertedIndex }), null);
  });

  test("rebuilds a missing persisted index", async () => {
    await fs.rm(indexPath, { recursive: true, force: true });
    const startedAt = performance.now();
    const metrics = runColdQuery(TOTAL - 1);
    const elapsed = performance.now() - startedAt;

    console.log(`Missing index rebuilt in ${formatDuration(elapsed)}`);
    assert.equal(metrics.found, true);
    await fs.access(indexPath);
  });

  test("rebuilds a corrupted persisted index", async () => {
    await fs.writeFile(
      path.join(indexPath, "metadata.json"),
      "{corrupted index",
      "utf8",
    );
    const startedAt = performance.now();
    const metrics = runColdQuery(TOTAL - 1);
    const elapsed = performance.now() - startedAt;

    console.log(`Corrupted index rebuilt in ${formatDuration(elapsed)}`);
    assert.equal(metrics.found, true);
    const rebuilt = JSON.parse(
      await fs.readFile(path.join(indexPath, "metadata.json"), "utf8"),
    );
    assert.equal(rebuilt.format, "mongify-btree-v1");
  });
});
