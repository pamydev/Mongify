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
  // let index = await database.getCollection("users").createIndex("index");
  // console.log(index);
  let res = await database.getCollection("users").findOne({
    address: {
      city: "Anytown",
    },
  });
  // let res = await database.getCollection("users").insert({
  //   index: "test3",
  //   name: "Pamela Sedrez 3",
  //   date: new Date(),
  //   purchaseList: ["item1", "item2", "item3"],
  //   address: {
  //     street: "123 Main St",
  //     city: "Anytown",
  //     state: "CA",
  //     zip: "12345",
  //   },
  // });
  const elapsedMilliseconds = performance.now() - startedAt;
  console.log(
    res,
    typeof res.date,
    res.date.getTime(),
    formatDuration(elapsedMilliseconds),
  );
})();
