import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import path from "path";
import {
  BTreeIndex,
  type BTreeChunkSignature,
  type BTreeReference,
} from "./btree-index";
import { CHUNK_SIZE_BYTES } from "./config";
import type {
  CollectionIndex,
  IndexOptions,
  MongifyDocument,
  MongifyQuery,
} from "./types";

interface IndexDefinition {
  unique: boolean;
}

interface CollectionMetadata {
  format: "mongify-chunks-v1";
  generation: string;
  indexes: Record<string, IndexDefinition>;
}

type IndexReference = BTreeReference;
type ChunkSignature = BTreeChunkSignature;

interface CachedIndex {
  generation: string;
  tree: BTreeIndex;
}

interface StoredDocument {
  document: MongifyDocument;
  reference: IndexReference;
}

interface MatchedDocument extends StoredDocument {
  position: number;
}

interface MatchedChunk {
  name: string;
  documents: MongifyDocument[];
  matches: MatchedDocument[];
}

const index_cache = new Map<string, CachedIndex>();

export class Storage {
  constructor(private database_path: string) {}

  public async createCollection(collection_name: string): Promise<void> {
    const existing = await this._read_metadata(collection_name, false);
    if (existing) {
      return;
    }

    const metadata = this._new_metadata();
    await fs.ensureDir(this._chunks_path(collection_name, metadata.generation));
    await fs.ensureDir(this._indexes_path(collection_name));
    await this._write_metadata(collection_name, metadata);
    await BTreeIndex.build(
      this._index_path(collection_name, "_id"),
      {
        field: "_id",
        generation: metadata.generation,
        unique: true,
        chunks: [],
        entries: new Map(),
      },
    );
  }

  public async deleteCollection(collection_name: string): Promise<void> {
    await fs.unlink(this._manifest_path(collection_name));
    await fs.remove(this._collection_data_path(collection_name));
    this._clear_collection_cache(collection_name);
  }

  public async readAll(
    collection_name: string,
    create_new = false,
  ): Promise<MongifyDocument[]> {
    const metadata = await this._read_metadata(collection_name, create_new);
    if (!metadata) {
      return [];
    }

    const stored = await this._read_stored_documents(collection_name, metadata);
    return stored.map(({ document }) => document);
  }

  public async replaceAll(
    collection_name: string,
    documents: MongifyDocument[],
  ): Promise<void> {
    const current = await this._read_metadata(collection_name, true);
    const next: CollectionMetadata = {
      ...current!,
      generation: randomUUID(),
    };
    const next_generation_path = this._generation_path(
      collection_name,
      next.generation,
    );
    let committed = false;

    try {
      const stored = await this._write_generation(collection_name, next, documents);
      const indexes = await this._build_indexes(collection_name, next, stored);

      await this._write_metadata(collection_name, next);
      committed = true;
      this._clear_collection_cache(collection_name);

      for (const [field, tree] of indexes) {
        index_cache.set(this._cache_key(collection_name, field), {
          generation: next.generation,
          tree,
        });
      }

      if (current?.generation && current.generation !== next.generation) {
        await fs.remove(this._generation_path(collection_name, current.generation));
      }
    } catch (error) {
      if (!committed) {
        await fs.remove(next_generation_path);
      }
      throw error;
    }
  }

  public async append(
    collection_name: string,
    documents: MongifyDocument[],
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    const metadata = await this._read_metadata(collection_name, true);
    const indexes = new Map<string, BTreeIndex>();

    for (const [field] of Object.entries(metadata!.indexes)) {
      indexes.set(field, await this._load_index(collection_name, metadata!, field));
    }

    await this._validate_unique_values(metadata!, indexes, documents);
    const stored = await this._append_to_generation(
      collection_name,
      metadata!,
      documents,
    );

    const signatures = await this._chunk_signatures(collection_name, metadata!);
    for (const [field, tree] of indexes) {
      await tree.insertMany(this._tree_entries(field, stored), signatures);
      index_cache.set(this._cache_key(collection_name, field), {
        generation: metadata!.generation,
        tree,
      });
    }
  }

  public async find(
    collection_name: string,
    query?: MongifyQuery,
    limit?: number,
    first = false,
  ): Promise<MongifyDocument[]> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return [];
    }

    const query_keys = query ? Object.keys(query) : [];
    if (query_keys.length === 0) {
      return this._scan_chunks(collection_name, metadata, undefined, limit, first);
    }

    const field = query_keys[0];
    const value = query![field];

    if (metadata.indexes[field]) {
      return this._find_with_index(
        collection_name,
        metadata,
        field,
        value,
        limit,
        first,
      );
    }

    return this._scan_chunks(
      collection_name,
      metadata,
      { field, value },
      limit,
      first,
    );
  }

  public async update(
    collection_name: string,
    query: MongifyQuery,
    update: MongifyDocument,
    upsert = false,
  ): Promise<void> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      if (upsert) {
        const { _id: ignored_id, ...document } = { ...query, ...update };
        await this.append(collection_name, [{ ...document, _id: randomUUID() }]);
      }
      return;
    }

    const matched_chunks = await this._find_matching_chunks(
      collection_name,
      metadata,
      query,
    );
    const matches = Array.from(matched_chunks.values()).flatMap(
      ({ matches }) => matches,
    );

    if (matches.length === 0) {
      if (upsert) {
        const { _id: ignored_id, ...document } = { ...query, ...update };
        await this.append(collection_name, [{ ...document, _id: randomUUID() }]);
      }
      return;
    }

    const indexes = await this._load_all_indexes(collection_name, metadata);
    const replacements = matches.map((match) => ({
      document: { ...match.document, ...update },
      reference: match.reference,
    }));
    await this._validate_unique_replacements(indexes, matches, replacements);

    for (const chunk of matched_chunks.values()) {
      for (const match of chunk.matches) {
        chunk.documents[match.position] = { ...match.document, ...update };
      }
      await this._atomic_write(
        path.join(
          this._chunks_path(collection_name, metadata.generation),
          chunk.name,
        ),
        JSON.stringify(chunk.documents),
      );
    }

    await this._replace_index_entries(
      collection_name,
      metadata,
      indexes,
      matches,
      replacements,
    );
  }

  public async delete(
    collection_name: string,
    query: MongifyQuery,
  ): Promise<void> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return;
    }

    const matched_chunks = await this._find_matching_chunks(
      collection_name,
      metadata,
      query,
    );
    const matches = Array.from(matched_chunks.values()).flatMap(
      ({ matches }) => matches,
    );
    if (matches.length === 0) {
      return;
    }

    const indexes = await this._load_all_indexes(collection_name, metadata);
    for (const chunk of matched_chunks.values()) {
      const positions = new Set(chunk.matches.map(({ position }) => position));
      const remaining = chunk.documents.filter((_, index) => !positions.has(index));
      await this._atomic_write(
        path.join(
          this._chunks_path(collection_name, metadata.generation),
          chunk.name,
        ),
        JSON.stringify(remaining),
      );
    }

    await this._replace_index_entries(
      collection_name,
      metadata,
      indexes,
      matches,
      [],
    );
  }

  public async createIndex(
    collection_name: string,
    field: string,
    options?: IndexOptions,
  ): Promise<void> {
    this._validate_field(field);
    const metadata = await this._read_metadata(collection_name, true);
    const definition = { unique: options?.unique === true };
    const index = await this._build_index_from_chunks(
      collection_name,
      metadata!,
      field,
      definition.unique,
    );

    metadata!.indexes[field] = definition;
    await this._write_metadata(collection_name, metadata!);
    index_cache.set(this._cache_key(collection_name, field), {
      generation: metadata!.generation,
      tree: index,
    });
  }

  public async dropIndex(
    collection_name: string,
    field: string,
  ): Promise<void> {
    if (field === "_id") {
      throw new TypeError("The _id index cannot be dropped");
    }

    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata?.indexes[field]) {
      return;
    }

    delete metadata.indexes[field];
    await this._write_metadata(collection_name, metadata);
    await fs.remove(this._index_path(collection_name, field));
    BTreeIndex.clearCache(this._index_path(collection_name, field));
    index_cache.delete(this._cache_key(collection_name, field));
  }

  public async listIndexes(collection_name: string): Promise<CollectionIndex[]> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return [];
    }

    return Object.entries(metadata.indexes)
      .map(([field, definition]) => ({ field, unique: definition.unique }))
      .sort((left, right) => left.field.localeCompare(right.field));
  }

  public async totalChunkSize(collection_name: string): Promise<number> {
    const metadata = await this._read_metadata(collection_name, false);
    if (!metadata) {
      return 0;
    }

    const signatures = await this._chunk_signatures(collection_name, metadata);
    return signatures.reduce((total, chunk) => total + chunk.size, 0);
  }

  private _new_metadata(): CollectionMetadata {
    return {
      format: "mongify-chunks-v1",
      generation: randomUUID(),
      indexes: { _id: { unique: true } },
    };
  }

  private async _read_metadata(
    collection_name: string,
    create_new: boolean,
  ): Promise<CollectionMetadata | undefined> {
    const manifest_path = this._manifest_path(collection_name);
    let serialized: string;

    try {
      serialized = await fs.readFile(manifest_path, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      if (!create_new) {
        return undefined;
      }
      await this.createCollection(collection_name);
      return this._read_metadata(collection_name, false);
    }

    const metadata = JSON.parse(serialized);
    if (
      metadata?.format !== "mongify-chunks-v1" ||
      typeof metadata.generation !== "string" ||
      !metadata.indexes
    ) {
      throw new Error(`Unsupported collection format: ${collection_name}`);
    }

    return metadata;
  }

  private async _write_metadata(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<void> {
    await this._atomic_write(
      this._manifest_path(collection_name),
      JSON.stringify(metadata),
    );
  }

  private async _write_generation(
    collection_name: string,
    metadata: CollectionMetadata,
    documents: MongifyDocument[],
  ): Promise<StoredDocument[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    await fs.ensureDir(chunks_path);

    const stored: StoredDocument[] = [];
    let chunk: MongifyDocument[] = [];
    let chunk_bytes = 2;
    let chunk_number = 1;

    const flush = async () => {
      if (chunk.length === 0) {
        return;
      }
      const name = this._chunk_name(chunk_number);
      await this._atomic_write(path.join(chunks_path, name), JSON.stringify(chunk));
      chunk = [];
      chunk_bytes = 2;
      chunk_number += 1;
    };

    for (const document of documents) {
      const serialized = JSON.stringify(document);
      const document_bytes = Buffer.byteLength(serialized);
      const separator_bytes = chunk.length === 0 ? 0 : 1;

      if (
        chunk.length > 0 &&
        chunk_bytes + separator_bytes + document_bytes > CHUNK_SIZE_BYTES
      ) {
        await flush();
      }

      const chunk_name = this._chunk_name(chunk_number);
      chunk.push(document);
      chunk_bytes += (chunk.length === 1 ? 0 : 1) + document_bytes;
      stored.push({
        document,
        reference: { chunk: chunk_name, id: String(document._id) },
      });
    }

    await flush();
    return stored;
  }

  private async _append_to_generation(
    collection_name: string,
    metadata: CollectionMetadata,
    documents: MongifyDocument[],
  ): Promise<StoredDocument[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    await fs.ensureDir(chunks_path);
    const chunk_names = await this._list_chunks(collection_name, metadata);
    let chunk_number = chunk_names.length || 1;
    let chunk_name = this._chunk_name(chunk_number);
    let chunk: MongifyDocument[] = [];
    let chunk_bytes = 2;
    let dirty = false;

    if (chunk_names.length > 0) {
      chunk_name = chunk_names.at(-1)!;
      const serialized = await fs.readFile(path.join(chunks_path, chunk_name), "utf8");
      chunk = JSON.parse(serialized);
      chunk_bytes = Buffer.byteLength(serialized);
    }

    const stored: StoredDocument[] = [];
    const flush = async () => {
      if (!dirty) {
        return;
      }
      await this._atomic_write(
        path.join(chunks_path, chunk_name),
        JSON.stringify(chunk),
      );
      dirty = false;
    };

    for (const document of documents) {
      const serialized = JSON.stringify(document);
      const document_bytes = Buffer.byteLength(serialized);
      const separator_bytes = chunk.length === 0 ? 0 : 1;

      if (
        chunk.length > 0 &&
        chunk_bytes + separator_bytes + document_bytes > CHUNK_SIZE_BYTES
      ) {
        await flush();
        chunk_number += 1;
        chunk_name = this._chunk_name(chunk_number);
        chunk = [];
        chunk_bytes = 2;
      }

      chunk.push(document);
      chunk_bytes += (chunk.length === 1 ? 0 : 1) + document_bytes;
      dirty = true;
      stored.push({
        document,
        reference: { chunk: chunk_name, id: String(document._id) },
      });
    }

    await flush();
    return stored;
  }

  private async _find_with_index(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
    value: any,
    limit?: number,
    first = false,
  ): Promise<MongifyDocument[]> {
    const references = await this._index_references(
      collection_name,
      metadata,
      field,
      value,
    );
    const chunk_cache = new Map<string, MongifyDocument[]>();
    const response: MongifyDocument[] = [];

    for (const reference of references) {
      let chunk = chunk_cache.get(reference.chunk);
      if (!chunk) {
        chunk = await this._read_chunk(collection_name, metadata, reference.chunk);
        chunk_cache.set(reference.chunk, chunk);
      }

      const document = chunk.find(
        (candidate) =>
          candidate._id === reference.id && candidate[field] === value,
      );
      if (document) {
        response.push(document);
      }
      if (first || (limit !== undefined && response.length >= limit)) {
        break;
      }
    }

    return response;
  }

  private async _find_matching_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    query: MongifyQuery,
  ): Promise<Map<string, MatchedChunk>> {
    const field = Object.keys(query)[0];
    const value = query[field];
    const result = new Map<string, MatchedChunk>();

    if (metadata.indexes[field]) {
      const references = await this._index_references(
        collection_name,
        metadata,
        field,
        value,
      );
      const grouped = new Map<string, IndexReference[]>();
      for (const reference of references) {
        const group = grouped.get(reference.chunk) || [];
        group.push(reference);
        grouped.set(reference.chunk, group);
      }

      for (const [chunk_name, chunk_references] of grouped) {
        const documents = await this._read_chunk(
          collection_name,
          metadata,
          chunk_name,
        );
        const reference_ids = new Set(chunk_references.map(({ id }) => id));
        const matches: MatchedDocument[] = [];
        documents.forEach((document, position) => {
          if (
            reference_ids.has(String(document._id)) &&
            document[field] === value
          ) {
            matches.push({
              document,
              position,
              reference: { chunk: chunk_name, id: String(document._id) },
            });
          }
        });
        if (matches.length > 0) {
          result.set(chunk_name, { name: chunk_name, documents, matches });
        }
      }
      return result;
    }

    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const documents = await this._read_chunk(
        collection_name,
        metadata,
        chunk_name,
      );
      const matches: MatchedDocument[] = [];
      documents.forEach((document, position) => {
        if (document[field] === value) {
          matches.push({
            document,
            position,
            reference: { chunk: chunk_name, id: String(document._id) },
          });
        }
      });
      if (matches.length > 0) {
        result.set(chunk_name, { name: chunk_name, documents, matches });
      }
    }
    return result;
  }

  private async _scan_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    query?: { field: string; value: any },
    limit?: number,
    first = false,
  ): Promise<MongifyDocument[]> {
    const response: MongifyDocument[] = [];
    const chunk_names = await this._list_chunks(collection_name, metadata);

    for (const chunk_name of chunk_names) {
      const chunk = await this._read_chunk(collection_name, metadata, chunk_name);
      for (const document of chunk) {
        if (!query || document[query.field] === query.value) {
          response.push(document);
          if (first || (limit !== undefined && response.length >= limit)) {
            return response;
          }
        }
      }
    }

    return response;
  }

  private async _load_index(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
  ): Promise<BTreeIndex> {
    const cache_key = this._cache_key(collection_name, field);
    const cached = index_cache.get(cache_key);
    if (cached?.generation === metadata.generation) {
      return cached.tree;
    }

    try {
      const signatures = await this._chunk_signatures(collection_name, metadata);
      const tree = await BTreeIndex.open(this._index_path(collection_name, field), {
        field,
        generation: metadata.generation,
        unique: metadata.indexes[field].unique,
        chunks: signatures,
      });
      index_cache.set(cache_key, { generation: metadata.generation, tree });
      return tree;
    } catch {}

    const tree = await this._build_index_from_chunks(
      collection_name,
      metadata,
      field,
      metadata.indexes[field].unique,
    );
    index_cache.set(cache_key, { generation: metadata.generation, tree });
    return tree;
  }

  private async _index_references(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
    value: any,
  ): Promise<IndexReference[]> {
    try {
      const tree = await this._load_index(collection_name, metadata, field);
      return await tree.search(this._index_key(value));
    } catch {
      const directory = this._index_path(collection_name, field);
      index_cache.delete(this._cache_key(collection_name, field));
      BTreeIndex.clearCache(directory);
      const tree = await this._build_index_from_chunks(
        collection_name,
        metadata,
        field,
        metadata.indexes[field].unique,
      );
      index_cache.set(this._cache_key(collection_name, field), {
        generation: metadata.generation,
        tree,
      });
      return tree.search(this._index_key(value));
    }
  }

  private async _build_index_from_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
    field: string,
    unique: boolean,
  ): Promise<BTreeIndex> {
    const entries = new Map<string, IndexReference[]>();

    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const documents = await this._read_chunk(
        collection_name,
        metadata,
        chunk_name,
      );
      for (const document of documents) {
        if (!Object.prototype.hasOwnProperty.call(document, field)) {
          continue;
        }
        const key = this._index_key(document[field]);
        const references = entries.get(key) || [];
        references.push({ chunk: chunk_name, id: String(document._id) });
        if (unique && references.length > 1) {
          throw new Error(`Duplicate value for unique index: ${field}`);
        }
        entries.set(key, references);
      }
    }

    return BTreeIndex.build(this._index_path(collection_name, field), {
      field,
      generation: metadata.generation,
      unique,
      chunks: await this._chunk_signatures(collection_name, metadata),
      entries,
    });
  }

  private async _load_all_indexes(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<Map<string, BTreeIndex>> {
    const indexes = new Map<string, BTreeIndex>();
    for (const field of Object.keys(metadata.indexes)) {
      indexes.set(
        field,
        await this._load_index(collection_name, metadata, field),
      );
    }
    return indexes;
  }

  private _validate_unique_replacements(
    indexes: Map<string, BTreeIndex>,
    previous: StoredDocument[],
    replacements: StoredDocument[],
  ): Promise<void> {
    const affected = new Set(
      previous.map(({ reference }) => `${reference.chunk}\0${reference.id}`),
    );

    return (async () => {
      for (const [field, tree] of indexes) {
        if (!tree.unique) continue;
        const pending = new Set<string>();
        for (const replacement of replacements) {
          if (!Object.prototype.hasOwnProperty.call(replacement.document, field)) {
            continue;
          }
          const key = this._index_key(replacement.document[field]);
          const existing = await tree.search(key);
          const has_unaffected = existing.some(
            (reference) => !affected.has(`${reference.chunk}\0${reference.id}`),
          );
          if (has_unaffected || pending.has(key)) {
            throw new Error(`Duplicate value for unique index: ${field}`);
          }
          pending.add(key);
        }
      }
    })();
  }

  private async _replace_index_entries(
    collection_name: string,
    metadata: CollectionMetadata,
    indexes: Map<string, BTreeIndex>,
    previous: StoredDocument[],
    replacements: StoredDocument[],
  ): Promise<void> {
    const signatures = await this._chunk_signatures(collection_name, metadata);
    for (const [field, tree] of indexes) {
      await tree.replaceReferences(
        this._tree_entries(field, previous),
        this._tree_entries(field, replacements),
        signatures,
      );
      index_cache.set(this._cache_key(collection_name, field), {
        generation: metadata.generation,
        tree,
      });
    }
  }

  private async _build_indexes(
    collection_name: string,
    metadata: CollectionMetadata,
    stored: StoredDocument[],
  ): Promise<Map<string, BTreeIndex>> {
    const indexes = new Map<string, BTreeIndex>();
    const signatures = await this._chunk_signatures(collection_name, metadata);
    for (const [field, definition] of Object.entries(metadata.indexes)) {
      const entries = new Map<string, IndexReference[]>();
      for (const { key, reference } of this._tree_entries(field, stored)) {
        const references = entries.get(key) || [];
        references.push(reference);
        entries.set(key, references);
      }
      indexes.set(
        field,
        await BTreeIndex.build(this._index_path(collection_name, field), {
          field,
          generation: metadata.generation,
          unique: definition.unique,
          chunks: signatures,
          entries,
        }),
      );
    }
    return indexes;
  }

  private async _validate_unique_values(
    metadata: CollectionMetadata,
    indexes: Map<string, BTreeIndex>,
    documents: MongifyDocument[],
  ): Promise<void> {
    for (const [field, definition] of Object.entries(metadata.indexes)) {
      if (!definition.unique) {
        continue;
      }
      const tree = indexes.get(field)!;
      const pending = new Set<string>();
      for (const document of documents) {
        if (!Object.prototype.hasOwnProperty.call(document, field)) {
          continue;
        }
        const key = this._index_key(document[field]);
        if ((await tree.search(key)).length > 0 || pending.has(key)) {
          throw new Error(`Duplicate value for unique index: ${field}`);
        }
        pending.add(key);
      }
    }
  }

  private _tree_entries(
    field: string,
    stored: StoredDocument[],
  ): Array<{ key: string; reference: IndexReference }> {
    return stored
      .filter(({ document }) =>
        Object.prototype.hasOwnProperty.call(document, field),
      )
      .map(({ document, reference }) => ({
        key: this._index_key(document[field]),
        reference,
      }));
  }

  private async _read_stored_documents(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<StoredDocument[]> {
    const stored: StoredDocument[] = [];
    for (const chunk_name of await this._list_chunks(collection_name, metadata)) {
      const chunk = await this._read_chunk(collection_name, metadata, chunk_name);
      for (const document of chunk) {
        stored.push({
          document,
          reference: { chunk: chunk_name, id: String(document._id) },
        });
      }
    }
    return stored;
  }

  private async _read_chunk(
    collection_name: string,
    metadata: CollectionMetadata,
    chunk_name: string,
  ): Promise<MongifyDocument[]> {
    const serialized = await fs.readFile(
      path.join(this._chunks_path(collection_name, metadata.generation), chunk_name),
      "utf8",
    );
    const chunk = JSON.parse(serialized);
    if (!Array.isArray(chunk)) {
      throw new Error(`Invalid chunk format: ${chunk_name}`);
    }
    return chunk;
  }

  private async _list_chunks(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<string[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    await fs.ensureDir(chunks_path);
    return (await fs.readdir(chunks_path))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
  }

  private async _chunk_signatures(
    collection_name: string,
    metadata: CollectionMetadata,
  ): Promise<ChunkSignature[]> {
    const chunks_path = this._chunks_path(collection_name, metadata.generation);
    const signatures: ChunkSignature[] = [];
    for (const name of await this._list_chunks(collection_name, metadata)) {
      const stats = await fs.stat(path.join(chunks_path, name));
      signatures.push({
        name,
        size: stats.size,
        modified: Math.trunc(stats.mtimeMs),
      });
    }
    return signatures;
  }

  private async _atomic_write(file_path: string, data: string): Promise<void> {
    await fs.ensureDir(path.dirname(file_path));
    const temporary_path = path.join(
      path.dirname(file_path),
      `.${path.basename(file_path)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await fs.writeFile(temporary_path, data, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary_path, file_path);
    } catch (error) {
      await fs.unlink(temporary_path).catch(() => undefined);
      throw error;
    }
  }

  private _index_key(value: any): string {
    return `${typeof value}:${JSON.stringify(value)}`;
  }

  private _validate_field(field: unknown): asserts field is string {
    if (typeof field !== "string" || field.trim() === "" || field.includes("\0")) {
      throw new TypeError("Index field must be a non-empty string");
    }
  }

  private _chunk_name(number: number): string {
    return `${String(number).padStart(6, "0")}.json`;
  }

  private _manifest_path(collection_name: string): string {
    return path.join(this.database_path, `${collection_name}.json`);
  }

  private _collection_data_path(collection_name: string): string {
    return path.join(
      this.database_path,
      ".mongify",
      Buffer.from(collection_name).toString("base64url"),
    );
  }

  private _generation_path(collection_name: string, generation: string): string {
    return path.join(
      this._collection_data_path(collection_name),
      "generations",
      generation,
    );
  }

  private _chunks_path(collection_name: string, generation: string): string {
    return path.join(this._generation_path(collection_name, generation), "chunks");
  }

  private _indexes_path(collection_name: string): string {
    return path.join(this._collection_data_path(collection_name), "indexes");
  }

  private _index_path(collection_name: string, field: string): string {
    return path.join(
      this._indexes_path(collection_name),
      Buffer.from(field).toString("base64url"),
    );
  }

  private _cache_key(collection_name: string, field: string): string {
    return `${this._manifest_path(collection_name)}\0${field}`;
  }

  private _clear_collection_cache(collection_name: string): void {
    BTreeIndex.clearCache(this._indexes_path(collection_name));
    const prefix = `${this._manifest_path(collection_name)}\0`;
    for (const key of index_cache.keys()) {
      if (key.startsWith(prefix)) {
        index_cache.delete(key);
      }
    }
  }
}
