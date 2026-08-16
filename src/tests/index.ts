import { Mongify } from "../mongify";
const database = new Mongify({ database_name: "test_database" });

const createCollections = async () => {
  await database.createCollection("users");
  await database.createCollection("users");
  await database.createCollection("reports");
};

createCollections();

database.getCollection("users").insert;
