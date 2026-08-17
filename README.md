# Cedros Mongify

[![Tests](https://github.com/pamydev/Mongify/actions/workflows/tests.yml/badge.svg)](https://github.com/pamydev/Mongify/actions/workflows/tests.yml)
[![npm version](https://img.shields.io/npm/v/%40cedrosdev%2Fmongify.svg)](https://www.npmjs.com/package/@cedrosdev/mongify)
[![npm downloads](https://img.shields.io/npm/dm/%40cedrosdev%2Fmongify.svg)](https://www.npmjs.com/package/@cedrosdev/mongify)
[![license](https://img.shields.io/npm/l/%40cedrosdev%2Fmongify.svg)](https://www.npmjs.com/package/@cedrosdev/mongify)

Mongify is an embedded document database for Node.js and TypeScript. It stores
documents in size-limited JSON chunks, maintains persistent paged B+ tree
indexes, and works without a separate database server.

It is designed for local applications, desktop tools, prototypes, and other
single-machine workloads that benefit from a MongoDB-inspired API while keeping
their data in readable files.

## Highlights

- JSON documents split into configurable chunks
- Persistent paged B+ tree indexes
- Equality and range index lookups with direct document reads by byte offset
- Single-field, compound, and unique indexes
- Automatic unique `_id` index and UUID v7 generation
- Query operators, nested document queries, projection, pagination, and sorting
- JavaScript `Date` persistence, including nested dates and dates in arrays
- Generic TypeScript collections and generated declaration files
- Batched simultaneous `insert()` calls
- Per-collection coordination within one process and across Node.js processes
- Atomic file replacement, operation journals, rollback, and crash recovery
- Automatic rebuilding of missing, stale, or corrupted indexes

## Installation

```bash
npm install @cedrosdev/mongify
```

## Quick start

```ts
import { Mongify } from "@cedrosdev/mongify";

const database = new Mongify({
  database_name: "my-app",
});

const users = await database.createCollection("users");

await users.insert({
  name: "Pamela",
  email: "pamela@example.com",
  active: true,
  createdAt: new Date(),
});

const user = await users.findOne({ email: "pamela@example.com" });

console.log(user);
```

Mongify generates `_id`; callers cannot choose or replace it:

```ts
{
  _id: "019c...", // generated UUID v7
  name: "Pamela",
  email: "pamela@example.com",
  active: true,
  createdAt: new Date("2026-08-16T20:06:59.174Z")
}
```

## TypeScript models

Pass a model to `createCollection()` or `getCollection()` to type inserts,
queries, updates, sorting, projection, indexes, and returned documents:

```ts
import { Mongify, type StoredDocument } from "@cedrosdev/mongify";

interface User {
  name: string;
  email: string;
  age: number;
  active?: boolean;
  createdAt: Date;
  profile?: {
    location?: { country: string };
    interests?: string[];
    lastLogin?: Date;
  };
}

const database = new Mongify({ database_name: "typed-app" });
const users = await database.createCollection<User>("users");

await users.insert({
  name: "Pamela",
  email: "pamela@example.com",
  age: 37,
  createdAt: new Date(),
});

const adults: StoredDocument<User>[] = await users.find({
  age: { $gte: 18 },
});

const pamela = await users.findOne({ email: "pamela@example.com" });
if (pamela) {
  console.log(pamela._id, pamela.name);
}
```

`_id` is omitted from insert and update inputs and is added as a `string` to
returned documents. Generic types provide compile-time checks; Mongify does not
perform runtime schema validation.

## Database location

With no custom `path`, Mongify uses:

- macOS: `$HOME/Library/Mongify/<database_name>`
- Windows: `%APPDATA%/Mongify/<database_name>`
- Linux and other platforms: `$HOME/.local/share/Mongify/<database_name>`

`path` changes the parent directory. Mongify still appends
`Mongify/<database_name>`:

```ts
const database = new Mongify({
  database_name: "local-data",
  path: "./data",
});

// Stored under ./data/Mongify/local-data
```

Database and collection names must be non-empty and cannot contain `/`, `\`, a
null byte, `.` or `..` as a complete name.

## Collections

### Create or open a collection

```ts
const users = await database.createCollection("users");
```

`createCollection()` is idempotent. Calling it for an existing collection keeps
its documents and indexes.

Use `getCollection()` when only a collection handle is needed:

```ts
const users = database.getCollection("users");
```

Some write operations can create a missing collection. Use
`createCollection()` when you want explicit collection lifecycle management.

### List and delete collections

```ts
const collections = await database.listCollections();
console.log(collections); // sorted collection names

await database.deleteCollection("users");
```

Deleting a collection removes its manifest, chunks, indexes, and cached index
state. Deleting a collection that does not exist rejects with the filesystem
error.

## Insert documents

### `insert()`

```ts
await users.insert({
  name: "Grace Hopper",
  email: "grace@example.com",
  age: 85,
  createdAt: new Date("1906-12-09"),
});
```

The promise resolves to `true` after persistence completes. Simultaneous
`insert()` calls targeting the same collection are automatically grouped into a
single append operation:

```ts
await Promise.all(
  Array.from({ length: 10_000 }, (_, index) =>
    users.insert({
      name: `User ${index}`,
      email: `user-${index}@example.com`,
      age: 18,
      createdAt: new Date(),
    }),
  ),
);
```

### `insertMany()`

Use `insertMany()` when the documents are already available as an array:

```ts
await users.insertMany([
  {
    name: "Alan Turing",
    email: "alan@example.com",
    age: 41,
    createdAt: new Date("1912-06-23"),
  },
  {
    name: "Katherine Johnson",
    email: "katherine@example.com",
    age: 101,
    createdAt: new Date("1918-08-26"),
  },
]);
```

`insert()` and `insertMany()` always generate new `_id` values. A manually
provided `_id` is ignored at runtime and rejected by the TypeScript API.

## Find documents

### `find()` and `findOne()`

```ts
const allUsers = await users.find();
const activeUsers = await users.find({ active: true });
const pamela = await users.findOne({ email: "pamela@example.com" });
```

- `find()` returns an array and returns `[]` when nothing matches.
- `findOne()` returns the first matching document or `null`.
- An omitted query or `{}` matches every document.
- Multiple fields in the same query use logical AND.

### Query operators

| Operator   | Meaning                              |
| ---------- | ------------------------------------ |
| `$lt`      | Less than                            |
| `$lte`     | Less than or equal                   |
| `$gt`      | Greater than                         |
| `$gte`     | Greater than or equal                |
| `$in`      | Matches at least one supplied value  |
| `$nin`     | Does not match any supplied value    |
| `$and`     | Every nested query must match        |
| `$or`      | At least one nested query must match |
| `$not`     | Negates a query or field expression  |
| `$exists`  | Checks whether a field is present    |
| `$type`    | Checks the JavaScript value type     |
| `$regex`   | Tests strings with a pattern         |
| `$options` | Supplies flags for `$regex`          |

Examples:

```ts
const adults = await users.find({ age: { $gte: 18 } });

const selectedAges = await users.find({
  age: { $in: [18, 21, 30] },
});

const availableUsers = await users.find({
  $and: [
    { active: true },
    { $or: [{ age: { $lt: 25 } }, { age: { $gte: 60 } }] },
  ],
});

const names = await users.find({
  name: { $regex: "^pam", $options: "i" },
});

const withEmail = await users.find({
  email: { $exists: true, $type: "string" },
});
```

`$type` recognizes `undefined`, `null`, `date`, `array`, and JavaScript
`typeof` names such as `string`, `number`, `boolean`, and `object`.

When the stored field is an array, `$in`, `$nin`, and `$regex` test its values.

### Nested documents

Nested queries use nested objects:

```ts
await users.insert({
  name: "Pamela",
  email: "pamela@example.com",
  age: 37,
  createdAt: new Date(),
  profile: {
    location: { country: "Brazil" },
    interests: ["TypeScript", "RPG"],
  },
});

const brazilianUsers = await users.find({
  profile: {
    location: { country: "Brazil" },
  },
});
```

Dot notation such as `"profile.location.country"` is not currently supported.

### Pagination, projection, and sorting

```ts
const page = await users.find(
  { active: true },
  {
    sort: { age: -1, name: 1 },
    skip: 20,
    limit: 10,
    projection: { name: 1, email: 1, age: 1, _id: 0 },
  },
);
```

- `sort` uses `1` for ascending and `-1` for descending order.
- Multiple sort fields are applied in declaration order.
- `skip` and `limit` accept a non-negative integer or its string form.
- Sorting happens before `skip`, `limit`, and `projection`.
- Inclusion projection keeps `_id` unless `_id: 0` is specified.
- Projection cannot mix included and excluded regular fields.

## Date values

Mongify preserves valid JavaScript `Date` instances at any depth, including
inside objects and arrays:

```ts
const createdAt = new Date("2026-08-16T20:06:59.174Z");

await users.insert({
  name: "Pamela",
  email: "pamela@example.com",
  age: 37,
  createdAt,
  profile: {
    lastLogin: new Date(),
  },
});

const stored = await users.findOne({ createdAt });

console.log(stored?.createdAt instanceof Date); // true
console.log(stored?.createdAt.getTime() === createdAt.getTime()); // true
```

Dates are persisted as millisecond timestamps plus type metadata and restored
when read. Date equality, ranges, indexes, updates, deletes, and sorting use the
timestamp. Invalid dates are rejected.

## Indexes

Every collection starts with a unique `_id` index. It cannot be dropped.

### Single-field indexes

```ts
const result = await users.createIndex("email", { unique: true });

console.log(result);
// {
//   acknowledge: true,
//   indexesBefore: 1,
//   indexesAfter: 2
// }
```

Creating the same index again does not rebuild it:

```ts
const result = await users.createIndex("email");

console.log(result);
// {
//   acknowledge: false,
//   indexesBefore: 2,
//   indexesAfter: 2,
//   error: "exists"
// }
```

### Compound indexes

```ts
await users.createIndex(["tenant", "email"], { unique: true });

const user = await users.findOne({
  tenant: "cedros",
  email: "pamela@example.com",
});
```

Compound equality lookup requires values for every field in the index. Field
order identifies the index, so `["tenant", "email"]` and
`["email", "tenant"]` are different indexes.

Documents missing one of the indexed fields are not added to that index. A
unique index therefore permits multiple documents where the indexed value is
absent.

### Range indexes

A single-field index accelerates simple number, string, and `Date` ranges:

```ts
await users.createIndex("age");

const usersInRange = await users.find({
  age: { $gte: 18, $lt: 30 },
});
```

Indexed equality and range reads follow the B+ tree to the matching references
and read each document directly from its chunk by byte offset. The entire chunk
does not need to be parsed.

### List and drop indexes

```ts
console.log(await users.listIndexes());
// [
//   { field: "_id", unique: true },
//   { field: "email", unique: true },
//   { field: ["tenant", "email"], unique: true }
// ]

await users.dropIndex("email");
await users.dropIndex(["tenant", "email"]);
```

Dropping an index that does not exist resolves to `true`. Creating a unique
index fails if existing documents already contain duplicate indexed values.
Inserts and updates also reject unique-index violations.

### Index persistence and recovery

Indexes are stored as paged B+ trees. Mongify reads only the pages needed for a
lookup and keeps a bounded in-memory page cache. Collection revisions keep index
metadata synchronized without checking every chunk on each cold lookup.

If an index is missing, stale, or malformed, Mongify rebuilds it from the
collection chunks. Index definitions remain in the collection manifest.

## Update documents

```ts
await users.update({ email: "pamela@example.com" }, { active: false });
```

`update()` shallow-merges the update object into every matching document and
resolves to `true`. Existing fields not present in the update object are kept.
`_id` cannot be changed.

Use `upsert` to insert when no document matches:

```ts
await users.update(
  { email: "new@example.com" },
  {
    name: "New User",
    age: 18,
    active: true,
    createdAt: new Date(),
  },
  { upsert: true },
);
```

For upserts, use an equality-only query. Query operators are not converted into
field values when Mongify builds the inserted document.

## Delete documents

```ts
await users.delete({ active: false });
```

`delete()` removes every matching document, updates all indexes, and resolves to
`true`. Calling it through a handle for a missing collection is a no-op and does
not create that collection.

## Storage, durability, and concurrency

Each collection has a small JSON manifest. Its documents live in numbered JSON
chunks under the internal `.mongify` directory, while index nodes are stored in
separate paged files.

Writes use temporary files followed by atomic rename. A per-collection journal
records affected paths before mutation so a failed operation can roll back and
an interrupted operation can be recovered the next time that collection is
accessed.

Operations on the same collection are serialized by an in-process queue and an
on-disk collection lock. This prevents lost updates between multiple database
instances and multiple Node.js processes on the same machine. Different
collections can progress independently.

Concurrent `insert()` calls made during the same scheduling window are batched
before they enter the collection transaction, reducing repeated disk work.

## Configuration constants

The current defaults are defined in `src/config.ts`:

```ts
export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

export const B_TREE_MAX_KEYS = 128;
export const B_TREE_PAGE_CACHE_SIZE = 256;
export const B_TREE_WRITE_CONCURRENCY = 32;

export const COLLECTION_LOCK_RETRY_MS = 10;
export const COLLECTION_LOCK_TIMEOUT_MS = 30_000;
export const COLLECTION_LOCK_STALE_MS = 30_000;
```

- `CHUNK_SIZE_BYTES` controls the target maximum chunk size. A single document
  larger than the limit is stored alone in an oversized chunk.
- `B_TREE_MAX_KEYS` controls index page fanout and must be at least `3`.
- `B_TREE_PAGE_CACHE_SIZE` limits cached index pages and must be positive.
- `B_TREE_WRITE_CONCURRENCY` limits concurrent index page writes and must be
  positive.
- The lock constants control retry, timeout, and fallback stale-lock timing.

These are build-time constants rather than per-database runtime options. Change
them and rebuild Mongify when benchmarking alternate storage configurations.

## API reference

### Database

```ts
interface MongifyOptions {
  database_name: string;
  path?: string;
}

class Mongify {
  constructor(options: MongifyOptions);

  createCollection<T extends object = MongifyDocument>(
    name: string,
  ): Promise<Collection<T>>;

  getCollection<T extends object = MongifyDocument>(
    name: string,
  ): Collection<T>;

  listCollections(): Promise<string[]>;
  deleteCollection(name: string): Promise<boolean>;
}
```

### Collection

```ts
interface Collection<T extends object = MongifyDocument> {
  find(
    query?: MongifyQuery<StoredDocument<T>>,
    options?: CollectionOptions<StoredDocument<T>>,
  ): Promise<StoredDocument<T>[]>;

  findOne(
    query?: MongifyQuery<StoredDocument<T>>,
  ): Promise<StoredDocument<T> | null>;

  insert(document: InsertDocument<T>): Promise<boolean>;
  insertMany(documents: InsertDocument<T>[]): Promise<boolean>;

  update(
    query: MongifyQuery<StoredDocument<T>>,
    update: UpdateDocument<T>,
    options?: UpdateOptions,
  ): Promise<boolean>;

  delete(query: MongifyQuery<StoredDocument<T>>): Promise<boolean>;

  createIndex(
    field: IndexFields<StoredDocument<T>>,
    options?: IndexOptions,
  ): Promise<CreateIndexResult>;

  dropIndex(field: IndexFields<StoredDocument<T>>): Promise<boolean>;

  listIndexes(): Promise<CollectionIndex[]>;
}
```

### Supporting types

```ts
interface CollectionOptions<T extends object = MongifyDocument> {
  limit?: string | number;
  skip?: string | number;
  projection?: Partial<Record<Extract<keyof T, string>, 0 | 1 | boolean>>;
  sort?: Partial<Record<Extract<keyof T, string>, 1 | -1>>;
}

interface UpdateOptions {
  upsert?: boolean;
}

interface IndexOptions {
  unique?: boolean;
}

type IndexFields<T extends object = MongifyDocument> =
  | Extract<keyof T, string>
  | Array<Extract<keyof T, string>>;

interface CollectionIndex {
  field: string | string[];
  unique: boolean;
}

interface CreateIndexResult {
  acknowledge: boolean;
  indexesBefore: number;
  indexesAfter: number;
  error?: "exists";
}

type StoredDocument<T extends object> = Omit<T, "_id"> & {
  _id: string;
};
```

## Project scope

Mongify is designed as an embedded document database for Node.js applications,
desktop tools, local-first software, prototypes, and single-machine workloads.

Keep these characteristics in mind:

- Operations on the same collection are serialized to preserve consistency.
- Indexes optimize top-level equality and range queries.
- Sorting is currently performed in memory.
- Transactions are scoped to individual collection operations.
- Mongify supports JSON-compatible values plus native JavaScript Dates.
- The storage format may evolve while the project is still new.

For distributed databases, relational workloads, or remote multi-server access,
consider a client-server database or SQLite alongside Mongify.

## Development

```bash
npm ci
npm run build
npm run test:all
npm run test:types
```

Additional suites:

```bash
npm run test:concurrency
npm run test:safety
npm run test:stress
npm run test:advanced
```

Inspect the files that would be included in the npm package:

```bash
npm run publish:seeFiles
```

Only `dist` and npm package metadata are published.

## License

ISC
