import { Mongify } from "../mongify";
const database = new Mongify({ database_name: "test_database" });

const createCollections = async () => {
  await database.createCollection("users");
  await database.createCollection("sells");
  await database.createCollection("reports");
  const collections = await database.listCollections();
  console.log("Collections:", collections);
  console.log("Collections created successfully!");
};

const insertSells = async () => {
  const sellsCollection = database.getCollection("sells");
  sellsCollection.insertMany([
    { item: "Laptop", price: 1200, quantity: 5 },
    { item: "Phone", price: 800, quantity: 10 },
    { item: "Tablet", price: 600, quantity: 7 },
  ]);
  sellsCollection.insert({ item: "Monitor", price: 300, quantity: 15 });
  sellsCollection.insert({ item: "PC", price: 300, quantity: 15 });
  sellsCollection.insert({ item: "Keyboard", price: 300, quantity: 15 });
  sellsCollection.insert({ item: "Mouse", price: 300, quantity: 15 });
  console.log("Sells inserted successfully!");
};

const insertUsers = async () => {
  const usersCollection = database.getCollection("users");
  await usersCollection.insertMany([
    { name: "Alice", age: 30, email: "alice@example.com" },
    { name: "Bob", age: 25, email: "bob@example.com" },
    { name: "Charlie", age: 35, email: "charlie@example.com" },
  ]);
  console.log("Users inserted successfully!");
};

const findBob = async () => {
  const usersCollection = database.getCollection("users");
  const bob = await usersCollection.find({ name: "Bob" });
  console.log("Found Bob:", bob);
};

createCollections()
  .then(() => insertSells())
  .then(() => insertUsers())
  .then(() => findBob())
  .catch((error) => {
    console.error("Error:", error);
  });
