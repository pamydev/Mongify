# Mongify

Mongify is a small file-based database for Node.js and TypeScript. It stores
documents in JSON chunks and indexes them with paged B+ trees, making it useful
for local tools and applications that do not need a database server.

## Features

- Chunked JSON persistence
- Configurable chunk size
- Persistent paged B+ tree indexes
- Automatic unique `_id` index
- Automatic `_id` generation with time-ordered UUID v7 values
- Simple collection API
- TypeScript declarations
- No database server or external service required

## Installation

Install the package from npm:

```bash
npm install mongify
```

When using the repository directly, install dependencies and compile the project:

```bash
npm install
npm run start
```

## Quick start

```ts
import { Mongify } from "mongify";

const database = new Mongify({
  database_name: "my-app",
});

const users = await database.createCollection("users");

await users.insert({
  name: "Ada Lovelace",
  email: "ada@example.com",
  active: true,
});

const result = await users.find({ active: true });
console.log(result);
```

Every inserted document receives a unique `_id` automatically:

```json
{
  "_id": "generated-uuid",
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "active": true
}
```

## Choosing the storage path

By default, Mongify stores databases in the platform's application data directory:

- macOS: `$HOME/Library/Preferences/mongify/<database_name>`
- Windows: `%APPDATA%/mongify/<database_name>`
- Linux and other platforms: `$HOME/.local/share/mongify/<database_name>`

Provide `path` to choose a custom parent directory:

```ts
import { Mongify } from "mongify";

const database = new Mongify({
  database_name: "local-data",
  path: "./data",
});
```

Each collection keeps a small `<collection_name>.json` manifest in the database
directory. Documents are stored in numbered JSON chunks under Mongify's internal
`.mongify` directory.

## Collections

### Create and access a collection

```ts
const products = await database.createCollection("products");

// Access an existing collection without creating or resetting its file.
const existingProducts = database.getCollection("products");
```

`createCollection` initializes a missing collection and preserves an existing one.
Use `getCollection` when you only need a collection handle.

List or delete collections:

```ts
const names = await database.listCollections();
console.log(names); // ["products", "users"]

await database.deleteCollection("products");
```

## Insert documents

```ts
await users.insert({
  name: "Grace Hopper",
  role: "engineer",
});

await users.insertMany([
  { name: "Alan Turing", role: "researcher" },
  { name: "Katherine Johnson", role: "mathematician" },
]);
```

Both methods return `true` after the file is written.

## Read documents

Queries use exact equality against the first property in the query object:

```ts
const allUsers = await users.find();
const engineers = await users.find({ role: "engineer" });
const firstEngineer = await users.findOne({ role: "engineer" });

console.log(allUsers);
console.log(engineers);
console.log(firstEngineer);
```

Limit the number of results with `limit`:

```ts
const firstTwoUsers = await users.find({}, { limit: 2 });
const matchingUsers = await users.find({ active: true }, { limit: "10" });
```

`find` returns an array. `findOne` returns the first matching document, or an array when no document matches.

## Indexes

Every collection has a unique `_id` index automatically. Create indexes for fields
used frequently by exact-equality queries:

```ts
await users.createIndex("email", { unique: true });
await users.createIndex("active");

console.log(await users.listIndexes());

const user = await users.findOne({ email: "ada@example.com" });

await users.dropIndex("active");
```

An indexed query reads only the chunks referenced by the index. Queries without an
index scan the chunks in order. The `_id` index cannot be dropped, and inserts or
updates that violate a unique index are rejected.

Indexes are persisted as paged B+ trees. A lookup reads only the tree path needed
to reach the matching leaf instead of loading the complete index into memory.
Mongify keeps a bounded page cache, verifies the current chunk signatures, and
rebuilds a stale, missing, or corrupted index from the chunks.

## Update documents

```ts
await users.update(
  { email: "ada@example.com" },
  { active: false, role: "archived" },
);
```

The update merges the provided fields into every matching document. Enable `upsert` to insert a document when no match exists:

```ts
await users.update(
  { email: "new@example.com" },
  { name: "New User", active: true },
  { upsert: true },
);
```

## Delete documents

```ts
await users.delete({ active: false });
```

This removes every document whose selected field exactly matches the query value. The method returns `true` after the operation.

## API reference

```ts
interface MongifyOptions {
  database_name: string;
  path?: string;
}

interface CollectionOptions {
  limit?: string | number;
  skip?: string | number;
}

interface UpdateOptions {
  upsert?: boolean;
}

interface IndexOptions {
  unique?: boolean;
}

interface Collection {
  find(query?: Record<string, unknown>, options?: CollectionOptions): Promise<Record<string, unknown>[]>;
  findOne(query?: Record<string, unknown>): Promise<Record<string, unknown> | Record<string, unknown>[]>;
  insert(document: Record<string, unknown>): Promise<boolean>;
  insertMany(documents: Record<string, unknown>[]): Promise<boolean>;
  update(query: Record<string, unknown>, update: Record<string, unknown>, options?: UpdateOptions): Promise<boolean>;
  delete(query: Record<string, unknown>): Promise<boolean>;
  createIndex(field: string, options?: IndexOptions): Promise<boolean>;
  dropIndex(field: string): Promise<boolean>;
  listIndexes(): Promise<Array<{ field: string; unique: boolean }>>;
}
```

## Chunk size

The default maximum chunk size is 10 MiB. Change `CHUNK_SIZE_BYTES` in
`src/config.ts` when benchmarking different chunk sizes:

```ts
export const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
```

A document larger than the configured limit is stored alone in an oversized chunk.

## B+ tree page size

Index nodes contain at most 128 keys by default. Change `B_TREE_MAX_KEYS` in
`src/config.ts` to benchmark different page fanouts. `B_TREE_PAGE_CACHE_SIZE`
controls the maximum number of index pages retained in memory, while
`B_TREE_WRITE_CONCURRENCY` limits simultaneous page writes:

```ts
export const B_TREE_MAX_KEYS = 128;
export const B_TREE_PAGE_CACHE_SIZE = 256;
export const B_TREE_WRITE_CONCURRENCY = 32;
```

## Important limitations

- Mongify is intended for lightweight local workloads, not high-concurrency production databases.
- Queries support exact equality only; operators such as `$gt`, `$in`, and `$or` are not implemented.
- Only `limit` currently affects `find` results. The `skip` option is part of the type definition but is not applied by the current implementation.
- Deletes do not currently merge underfilled B+ tree pages; rebuilding an index compacts them.
- The in-process mutex coordinates instances in one Node.js process, not separate processes.
- This chunked and paged-index format intentionally does not support databases created by older Mongify versions.

## Development

```bash
npm run start       # Compile TypeScript into dist/
npm run build-types # Emit declaration files only
```

## License

ISC
