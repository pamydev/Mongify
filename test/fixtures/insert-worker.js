const { Mongify } = require("../../dist/mongify.js");

const [databaseRoot, databaseName, collectionName, source, totalText] =
  process.argv.slice(2);
const database = new Mongify({ database_name: databaseName, path: databaseRoot });
const collection = database.getCollection(collectionName);

process.send?.("ready");
process.on("message", async (message) => {
  if (message !== "start") return;
  try {
    await Promise.all(
      Array.from({ length: Number(totalText) }, (_, index) =>
        collection.insert({ source, index }),
      ),
    );
    process.send?.("done");
    process.disconnect?.();
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    process.disconnect?.();
  }
});
