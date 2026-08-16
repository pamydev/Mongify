const fsExtra = require("fs-extra");
const path = require("node:path");
const { Mongify } = require("../../dist/mongify.js");

const [databaseRoot, databaseName, collectionName, field, value] =
  process.argv.slice(2);
let chunkStats = 0;
const originalStat = fsExtra.stat;
fsExtra.stat = async (target, ...args) => {
  if (
    String(target).includes(`${path.sep}generations${path.sep}`) &&
    String(target).includes(`${path.sep}chunks${path.sep}`)
  ) {
    chunkStats += 1;
  }
  return originalStat.call(fsExtra, target, ...args);
};

(async () => {
  const database = new Mongify({ database_name: databaseName, path: databaseRoot });
  const document = await database
    .getCollection(collectionName)
    .findOne({ [field]: Number(value) });
  process.send?.({ value: document?.[field], chunkStats });
  process.disconnect?.();
})().catch((error) => {
  process.send?.({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  process.disconnect?.();
});
