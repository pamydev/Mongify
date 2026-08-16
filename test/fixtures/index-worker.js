const { performance } = require("node:perf_hooks");

const { Mongify } = require("../../dist/mongify.js");

const [databasePath, databaseName, collectionName, field, serializedValue] =
  process.argv.slice(2);

async function main() {
  const database = new Mongify({
    database_name: databaseName,
    path: databasePath,
  });
  const collection = database.getCollection(collectionName);

  global.gc?.();
  const memoryBefore = process.memoryUsage();
  const startedAt = performance.now();
  const document = await collection.findOne({
    [field]: JSON.parse(serializedValue),
  });
  const elapsedMilliseconds = performance.now() - startedAt;
  global.gc?.();
  const memoryAfter = process.memoryUsage();

  process.stdout.write(
    JSON.stringify({
      elapsedMilliseconds,
      found: document !== null,
      rssBefore: memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
