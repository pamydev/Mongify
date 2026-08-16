import { Mongify } from "../mongify";
const database = new Mongify({ database_name: "database_v2" });

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError("Duration must be a non-negative finite number");
  }

  if (milliseconds >= 1_000) {
    return `${(milliseconds / 1_000).toFixed(1)}s`;
  }

  return `${Math.round(milliseconds)}ms`;
}

const createDummyFields = (count) => {
  return Array.from({ length: count }, (_, index) => ({
    key: `dummyField${index}`,
    value: `dummyValue${index + "x".repeat(50)}`,
  }));
};

const createDummyDocument = async (
  collection_name,
  total,
  totalDummyFields,
) => {
  const maxTotal = 100_000;
  const operations = Math.ceil(total / maxTotal);
  for (let i = 0; i < operations; i += 1) {
    const start = i * maxTotal;
    const end = Math.min(start + maxTotal, total);
    const collection = database.getCollection(collection_name);
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
};

(async () => {
  const startedAt = performance.now();
  console.log("starting...");
  let index = await database.getCollection("users").createIndex("index");
  console.log(index);
  let res = await database.getCollection("users").findOne({
    index: "test1",
  });
  // await database.getCollection("users").insert({
  //   index: "test1",
  //   name: "Pamela Sedrez",
  // });
  const elapsedMilliseconds = performance.now() - startedAt;
  console.log(res, formatDuration(elapsedMilliseconds));
})();
