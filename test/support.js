const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { Mongify } = require("../dist/mongify.js");

async function createTestDatabase(name = "test-database") {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "mongify-test-"),
  );

  return {
    database: new Mongify({
      database_name: name,
      path: temporaryDirectory,
    }),
    temporaryDirectory,
  };
}

async function removeTestDatabase(context) {
  if (!context?.temporaryDirectory) {
    return;
  }

  await fs.rm(context.temporaryDirectory, {
    recursive: true,
    force: true,
  });
}

module.exports = {
  createTestDatabase,
  removeTestDatabase,
};
